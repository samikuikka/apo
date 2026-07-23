# pyright: reportCallInDefaultInitializer=false, reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""SPEC-136 ticket 10: nested-document models API + match endpoint.

Replaces the flat ModelDefinitionDB CRUD with the normalized
``(model, tier, usage_key)`` document shape. Writes reject ``__global__``
(409) — the bundled JSON is the sole source of truth for globals; per-project
overrides come via this API. The match endpoint resolves model+usage -> tier
+ per-key breakdown, reusing the same compute pipeline as ingestion.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, col, select

from ..db import get_session
from ..models.pricing import (
    MatchResponse,
    ModelDocument,
    ModelDocumentCreate,
    ModelRowDB,
    PriceDB,
    PriceMap,
    PricingTierDB,
    TierCondition,
    TierDocument,
)
from ..services.pricing.compute import compute_cost
from ..services.pricing.validation import (
    TierValidationError,
    validate_era_no_overlap,
    validate_model_document,
)

router = APIRouter()

GLOBAL_PROJECT = "__global__"
_GLOBAL_WRITE_DETAIL = (
    "Globals are managed by the bundled JSON; create a per-project override."
)


# ============================================================================
# Helpers
# ============================================================================


def _build_document(session: Session, model: ModelRowDB) -> ModelDocument:
    """Assemble a nested ModelDocument from a model row + its tiers/prices."""
    assert model.id is not None  # loaded from DB
    tiers = list(
        session.exec(
            select(PricingTierDB)
            .where(PricingTierDB.model_id == model.id)
            .order_by(col(PricingTierDB.priority).asc())
        ).all()
    )
    tier_docs: list[TierDocument] = []
    for tier in tiers:
        prices_map = {
            p.usage_key: p.price_per_1m
            for p in session.exec(select(PriceDB).where(PriceDB.tier_id == tier.id)).all()
        }
        # Convert stored micro-USD-per-1M back to USD-per-1M for the wire shape.
        prices = PriceMap(
            **{k: v / 1_000_000 for k, v in prices_map.items()}
        )
        conditions = _parse_conditions(tier.conditions_json)
        tier_docs.append(
            TierDocument(
                name=tier.name,
                is_default=tier.is_default,
                priority=tier.priority,
                conditions=conditions,
                prices=prices,
            )
        )
    return ModelDocument(
        id=model.id,
        project=model.project,
        match_pattern=model.match_pattern,
        provider=model.provider,
        display_name=model.display_name,
        start_date=model.start_date,
        end_date=model.end_date,
        updated_at=model.updated_at,
        pricing_tiers=tier_docs,
    )


def _parse_conditions(conditions_json: str) -> list[TierCondition]:
    if not conditions_json:
        return []
    try:
        raw = json.loads(conditions_json)
    except json.JSONDecodeError:
        return []
    if not isinstance(raw, list):
        return []
    out: list[TierCondition] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        try:
            from ..models.usage_keys import UsageKey

            keys = [UsageKey(k) for k in entry.get("keys", []) if isinstance(k, str)]
            out.append(
                TierCondition(
                    keys=keys,
                    operator=str(entry.get("operator", "")),
                    threshold=int(entry.get("threshold", 0)),
                )
            )
        except (ValueError, TypeError):
            continue
    return out


def _upsert_model_graph(
    session: Session,
    doc: ModelDocumentCreate,
    *,
    model_id: int | None = None,
) -> ModelRowDB:
    """Insert or replace a model's full tier/price graph in one transaction.

    When ``model_id`` is given (PUT), the existing graph is deleted first.
    """
    if model_id is not None:
        _delete_model_graph(session, model_id)

    model = ModelRowDB(
        project=doc.project,
        match_pattern=doc.match_pattern,
        provider=doc.provider,
        display_name=doc.display_name,
        start_date=doc.start_date,
        end_date=doc.end_date,
        updated_at=doc.updated_at,
    )
    session.add(model)
    session.flush()
    assert model.id is not None

    for tier_doc in doc.pricing_tiers:
        tier = PricingTierDB(
            model_id=model.id,
            name=tier_doc.name,
            is_default=tier_doc.is_default,
            priority=tier_doc.priority,
            conditions_json=_conditions_json(tier_doc.conditions),
        )
        session.add(tier)
        session.flush()
        assert tier.id is not None
        for usage_key, usd_per_1m in tier_doc.prices.to_dict().items():
            session.add(
                PriceDB(
                    model_id=model.id,
                    tier_id=tier.id,
                    usage_key=usage_key,
                    price_per_1m=round(usd_per_1m * 1_000_000),
                )
            )
    return model


def _delete_model_graph(session: Session, model_id: int) -> None:
    tiers = list(session.exec(select(PricingTierDB).where(PricingTierDB.model_id == model_id)).all())
    for tier in tiers:
        for p in session.exec(select(PriceDB).where(PriceDB.tier_id == tier.id)).all():
            session.delete(p)
        session.delete(tier)
    model = session.get(ModelRowDB, model_id)
    if model is not None:
        session.delete(model)


def _conditions_json(conditions: list[TierCondition]) -> str:
    return json.dumps(
        [
            {"keys": [k.value for k in c.keys], "operator": c.operator, "threshold": c.threshold}
            for c in conditions
        ]
    )


# ============================================================================
# Routes
# ============================================================================


@router.get("/api/v1/models", response_model=list[ModelDocument])
async def list_models(
    project: str = Query(default=GLOBAL_PROJECT),
    effective: bool = Query(default=False),
    session: Session = Depends(get_session),
) -> list[ModelDocument]:
    """List models for a project. With ``effective=true``, merge globals + project
    overrides (project rows shadow globals per match_pattern)."""
    if effective and project != GLOBAL_PROJECT:
        rows = list(
            session.exec(
                select(ModelRowDB).where(col(ModelRowDB.project).in_([project, GLOBAL_PROJECT]))
            ).all()
        )
        project_patterns = {r.match_pattern for r in rows if r.project == project}
        visible = [r for r in rows if r.project == project or r.match_pattern not in project_patterns]
        return [_build_document(session, r) for r in visible]

    rows = list(session.exec(select(ModelRowDB).where(ModelRowDB.project == project)).all())
    return [_build_document(session, r) for r in rows]


# /match MUST be declared BEFORE /{model_id}: FastAPI resolves routes in
# declaration order, and a literal "match" segment would otherwise hit the
# {model_id}: int route and fail validation (422) instead of falling through.
# See AGENTS.md "Catch-All Routes Are Terminal".
@router.get("/api/v1/models/match", response_model=MatchResponse)
async def match_model_route(
    model: str = Query(...),
    usage: str = Query(
        default="{}",
        description='JSON object: canonical usage_key -> token count, e.g. {"input":1000,"output":500}',
    ),
    start_time: datetime = Query(default_factory=lambda: datetime.now(timezone.utc)),
    project: str = Query(default=GLOBAL_PROJECT),
    session: Session = Depends(get_session),
) -> MatchResponse:
    """Resolve model+usage -> matched tier + per-key breakdown.

    Same compute pipeline as ingestion (compute_cost). Era selected by
    ``start_time``. ``usage`` is a JSON-encoded canonical-key -> token-count map
    (dict query params are not supported by FastAPI, so the map is passed as a
    JSON string).
    """
    try:
        usage_map_raw = json.loads(usage) if usage else {}
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"invalid usage JSON: {exc}") from exc
    usage_map = {k: int(v) for k, v in usage_map_raw.items()} if isinstance(usage_map_raw, dict) else {}

    result = compute_cost(session, model, usage_map, project, start_time)
    if result is None:
        return MatchResponse(matched=False)
    return MatchResponse(
        matched=True,
        model_id=result.model_id,
        provider=None,
        matched_tier_id=result.tier_id,
        matched_tier_name=result.tier_name,
        cost_breakdown=result.breakdown or None,
        total_cost=result.total,
    )


@router.get("/api/v1/models/{model_id}", response_model=ModelDocument)
async def get_model(
    model_id: int,
    session: Session = Depends(get_session),
) -> ModelDocument:
    model = session.get(ModelRowDB, model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="model not found")
    return _build_document(session, model)


@router.post("/api/v1/models", response_model=ModelDocument, status_code=201)
async def create_model(
    request: ModelDocumentCreate,
    session: Session = Depends(get_session),
) -> ModelDocument:
    """Create a per-project model with its full tier/price graph (nested).

    Rejects ``project='__global__'`` (409) — the bundled JSON is the sole source
    of truth for globals.
    """
    if request.project == GLOBAL_PROJECT:
        raise HTTPException(status_code=409, detail=_GLOBAL_WRITE_DETAIL)
    try:
        validate_model_document(request)
        validate_era_no_overlap(
            session,
            project=request.project,
            match_pattern=request.match_pattern,
            start_date=request.start_date,
            end_date=request.end_date,
        )
    except TierValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    model = _upsert_model_graph(session, request)
    session.commit()
    session.refresh(model)
    return _build_document(session, model)


@router.put("/api/v1/models/{model_id}", response_model=ModelDocument)
async def replace_model(
    model_id: int,
    request: ModelDocumentCreate,
    session: Session = Depends(get_session),
) -> ModelDocument:
    """Replace a model's whole tier/price graph (delete-old, insert-new)."""
    existing = session.get(ModelRowDB, model_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="model not found")
    if existing.project == GLOBAL_PROJECT or request.project == GLOBAL_PROJECT:
        raise HTTPException(status_code=409, detail=_GLOBAL_WRITE_DETAIL)
    try:
        validate_model_document(request)
        validate_era_no_overlap(
            session,
            project=request.project,
            match_pattern=request.match_pattern,
            start_date=request.start_date,
            end_date=request.end_date,
            exclude_model_id=model_id,
        )
    except TierValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    model = _upsert_model_graph(session, request, model_id=model_id)
    session.commit()
    session.refresh(model)
    return _build_document(session, model)


@router.delete("/api/v1/models/{model_id}", status_code=204)
async def delete_model(
    model_id: int,
    session: Session = Depends(get_session),
) -> None:
    model = session.get(ModelRowDB, model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="model not found")
    if model.project == GLOBAL_PROJECT:
        raise HTTPException(status_code=409, detail=_GLOBAL_WRITE_DETAIL)
    _delete_model_graph(session, model_id)
    session.commit()
