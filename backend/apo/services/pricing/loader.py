# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""SPEC-136 ticket 07: JSON-defaults loader.

The bundled JSON (``apo/data/default-model-prices.json``) is the SOLE source
of truth for ``__global__`` models. ``load_default_prices`` reconciles the DB
toward the JSON on every startup: globals absent from the file are deleted,
edited globals reverted, new ones inserted. Per-project rows are never
touched. Idempotent via per-model ``updated_at`` exact-equality vs the DB row
(so a no-op restart writes nothing). A malformed bundled file fails hard.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlmodel import Session, select

from ...models.pricing import (
    ModelDocumentCreate,
    ModelRowDB,
    PriceDB,
    PriceMap,
    PricingTierDB,
    TierCondition,
    TierDocument,
)
from ...models.usage_keys import UsageKey
from .validation import TierValidationError, validate_model_document

logger = logging.getLogger(__name__)

DEFAULTS_PATH = Path(__file__).resolve().parents[2] / "data" / "default-model-prices.json"
GLOBAL_PROJECT = "__global__"


def load_default_prices(session: Session, *, path: Path | None = None) -> int:
    """Reconcile ``__global__`` model rows toward the bundled JSON.

    Returns the number of models inserted/replaced (0 on a no-op reload).
    Per-project rows are never modified. Raises on a malformed JSON file
    (fail-hard) or an invalid entry.
    """
    source = path or DEFAULTS_PATH
    raw = _read_and_parse(source)
    docs = _parse_entries(raw)

    existing = {m.match_pattern: m for m in _global_models(session)}
    seen_patterns: set[str] = set()
    written = 0

    for doc in docs:
        seen_patterns.add(doc.match_pattern)
        existing_row = existing.get(doc.match_pattern)
        if existing_row is not None and existing_row.updated_at == doc.updated_at:
            # No-op: same updated_at -> skip the write (idempotency gate).
            continue
        _upsert_global(session, doc)
        written += 1

    # Delete globals absent from the file.
    for pattern, row in existing.items():
        if pattern not in seen_patterns and row.id is not None:
            _delete_model_cascade(session, row.id)

    session.commit()
    return written


def _read_and_parse(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text()
    except OSError as exc:
        # A missing bundled file is a packaging bug -> fail hard.
        raise RuntimeError(f"cannot read bundled defaults at {path}: {exc}") from exc
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"malformed bundled defaults JSON at {path}: {exc}") from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("models"), list):
        raise RuntimeError(f"bundled defaults JSON at {path} missing top-level 'models' array")
    return raw


def _parse_entries(raw: dict[str, Any]) -> list[ModelDocumentCreate]:
    docs: list[ModelDocumentCreate] = []
    for entry in raw["models"]:
        if not isinstance(entry, dict):
            raise RuntimeError(f"bundled defaults entry is not an object: {entry!r}")
        doc = _entry_to_doc(entry)
        try:
            validate_model_document(doc)
        except TierValidationError as exc:
            raise RuntimeError(f"invalid bundled defaults entry {doc.match_pattern!r}: {exc}") from exc
        docs.append(doc)
    return docs


def _entry_to_doc(entry: dict[str, Any]) -> ModelDocumentCreate:
    tiers: list[TierDocument] = []
    for raw_tier in entry.get("pricing_tiers", []):
        prices = PriceMap(**_coerce_prices(raw_tier.get("prices", {})))
        conditions = [TierCondition(**c) for c in raw_tier.get("conditions", [])]
        tiers.append(
            TierDocument(
                name=str(raw_tier.get("name", "default")),
                is_default=bool(raw_tier.get("is_default", False)),
                priority=int(raw_tier.get("priority", 0)),
                conditions=conditions,
                prices=prices,
            )
        )
    return ModelDocumentCreate(
        project=GLOBAL_PROJECT,
        match_pattern=str(entry["match_pattern"]),
        provider=str(entry.get("provider", "generic")),
        display_name=str(entry.get("display_name", "")),
        start_date=_parse_dt(entry.get("start_date")),
        end_date=_parse_dt(entry.get("end_date")),
        updated_at=str(entry.get("updated_at", "")),
        pricing_tiers=tiers,
    )


def _coerce_prices(prices_raw: dict[str, Any]) -> dict[str, float]:
    """Keep only canonical usage keys; coerce to float."""
    valid = {k.value for k in UsageKey}
    return {k: float(v) for k, v in prices_raw.items() if k in valid and v is not None}


def _parse_dt(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _global_models(session: Session) -> list[ModelRowDB]:
    return list(
        session.exec(select(ModelRowDB).where(ModelRowDB.project == GLOBAL_PROJECT)).all()
    )


def _upsert_global(session: Session, doc: ModelDocumentCreate) -> None:
    """Insert or replace the full tier/price graph for one __global__ model."""
    existing = session.exec(
        select(ModelRowDB).where(
            ModelRowDB.project == GLOBAL_PROJECT, ModelRowDB.match_pattern == doc.match_pattern
        )
    ).first()
    if existing is not None and existing.id is not None:
        _delete_model_cascade(session, existing.id)

    model = ModelRowDB(
        project=GLOBAL_PROJECT,
        match_pattern=doc.match_pattern,
        provider=doc.provider,
        display_name=doc.display_name,
        start_date=doc.start_date,
        end_date=doc.end_date,
        updated_at=doc.updated_at,
    )
    session.add(model)
    session.flush()  # populate model.id
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
        session.flush()  # populate tier.id
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


def _delete_model_cascade(session: Session, model_id: int) -> None:
    """Delete a model and its tiers/prices (relies on FK ON DELETE CASCADE where
    supported; explicit delete for SQLite which ignores the clause)."""
    tiers = list(session.exec(select(PricingTierDB).where(PricingTierDB.model_id == model_id)).all())
    for tier in tiers:
        prices = session.exec(select(PriceDB).where(PriceDB.tier_id == tier.id)).all()
        for p in prices:
            session.delete(p)
        session.delete(tier)
    model = session.get(ModelRowDB, model_id)
    if model is not None:
        session.delete(model)


def _conditions_json(conditions: list[TierCondition]) -> str:
    import json

    return json.dumps(
        [
            {"keys": [k.value for k in c.keys], "operator": c.operator, "threshold": c.threshold}
            for c in conditions
        ]
    )


__all__ = ["DEFAULTS_PATH", "load_default_prices"]
