"""Projection I/O — the single source of truth for call input/output values.

Stage 2 of storage single-homing: the canonical span store is the one home
of span data, and the product projection (``logged_calls``) is a derived
view. This module owns the three pieces that make that safe:

- **Write mode** (``APO_PROJECTION_WRITE_MODE`` = fat | dual | slim). ``slim``
  is the default: canonical spans own full call I/O and every projection writes
  the small run-level previews used by trace lists. ``fat`` and ``dual`` remain
  temporary rollback modes for installations completing the preview backfill.
- **One resolver** (``resolve_call_io``) computing the I/O a call's fat
  columns would hold, straight from the canonical span. The projector
  WRITES through it and the read paths RESOLVE through it, so write/read
  parity holds by construction — there is no second implementation to
  drift.
- **In-memory hydration** (``hydrate_calls_from_spans``) for slim-mode
  reads: span-backed calls get their I/O populated via
  ``set_committed_value`` (no dirty state, nothing persisted), while
  span-less legacy rows keep serving their stored columns — the fallback.
"""

# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedParameter=false

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm.attributes import set_committed_value
from sqlmodel import Session, col, select

from ..models.db import LoggedCallDB, OtlpSpanDB, RunDB
from .otel_normalization import NormalizedSpan, normalize_span

logger = logging.getLogger(__name__)

WRITE_MODE_ENV = "APO_PROJECTION_WRITE_MODE"

# The run-list preview length — matches the truncation the list API has
# always applied at read time; previews freeze it at write time instead.
PREVIEW_MAX_CHARS = 200


def projection_write_mode() -> str:
    """``slim`` (default) | ``dual`` | ``fat`` — read fresh so operators can
    flip modes without a restart."""
    value = os.environ.get(WRITE_MODE_ENV, "slim").strip().lower()
    if value in ("fat", "dual", "slim"):
        return value
    if value:
        logger.warning(
            "invalid %s=%r — falling back to slim (expected fat|dual|slim)",
            WRITE_MODE_ENV,
            value,
        )
    return "slim"


def truncate_preview(value: object) -> str | None:
    """Render a preview string exactly as the list API always has."""
    if value is None:
        return None
    text = json.dumps(value, default=str) if not isinstance(value, str) else value
    if len(text) > PREVIEW_MAX_CHARS:
        return text[:PREVIEW_MAX_CHARS] + "..."
    return text


@dataclass(frozen=True)
class ResolvedCallIO:
    """The I/O the fat columns hold for a call, computed from its span."""

    input: Any
    output: Any
    messages: list[dict[str, Any]]
    tool_parameters: dict[str, Any] | None
    tool_result: Any | None


def extract_generation_messages(normalized: NormalizedSpan) -> list[dict[str, Any]]:
    """Messages from normalized input/output — GENERATION calls only.

    SPAN/AGENT lifecycle calls carry adapter metadata and TOOL calls carry
    parameters/results; fabricating messages for those would clutter the
    trace with misleading turns.
    """
    if normalized.observation_type != "GENERATION":
        return []
    msgs: list[dict[str, Any]] = []
    if normalized.input and isinstance(normalized.input.get("messages"), list):
        msgs.extend(normalized.input["messages"])
    if normalized.output and isinstance(normalized.output.get("messages"), list):
        msgs.extend(normalized.output["messages"])
    return msgs


def resolve_call_io(span: OtlpSpanDB) -> ResolvedCallIO:
    """Compute a call's I/O from its canonical span (create-path semantics).

    Identical to what ``TraceProjector._upsert_call`` writes on creation:
    normalized I/O first, then the free-form ``input``/``output`` attribute
    fallbacks (legacy adapters, Trace Source Connectors using
    ``apo.observation.*``). Always fresh from the span — never preserves a
    stale earlier revision, which is what makes the projection a pure
    derived view.
    """
    normalized = normalize_span(span)
    attrs = span.attributes or {}

    raw_input = attrs.get("input")
    raw_output = attrs.get("output")
    if raw_input is None:
        raw_input = attrs.get("apo.observation.input")
    if raw_output is None:
        raw_output = attrs.get("apo.observation.output")

    return ResolvedCallIO(
        input=normalized.input or raw_input or {},
        output=normalized.output or raw_output or {},
        messages=extract_generation_messages(normalized),
        tool_parameters=normalized.tool_parameters,
        tool_result=normalized.tool_result,
    )


def hydrate_calls_from_spans(
    session: Session, calls: list[LoggedCallDB]
) -> int:
    """Slim-mode read path: populate call I/O from canonical spans, in memory.

    Span-backed calls are overwritten unconditionally with freshly resolved
    values via ``set_committed_value`` — nothing is marked dirty, nothing is
    persisted, and no lazy-load fires. Calls WITHOUT a canonical span (dev
    seeding, legacy direct writes) keep their stored column values: the
    permanent fallback. No-op outside slim mode. Returns span-backed count.
    """
    if projection_write_mode() != "slim" or not calls:
        return 0
    calls_by_id = {c.id: c for c in calls if c.id}
    if not calls_by_id:
        return 0
    spans = session.exec(
        select(OtlpSpanDB).where(col(OtlpSpanDB.span_id).in_(list(calls_by_id)))
    ).all()
    resolved = 0
    for span in spans:
        call = calls_by_id.get(span.span_id)
        # OTel span ids are unique per project only — match both.
        if call is None or call.project != span.project_id:
            continue
        io = resolve_call_io(span)
        set_committed_value(call, "input", io.input)
        set_committed_value(call, "output", io.output)
        set_committed_value(call, "messages", io.messages)
        if io.tool_parameters is not None:
            set_committed_value(call, "tool_parameters", io.tool_parameters)
        if io.tool_result is not None:
            set_committed_value(call, "tool_result", io.tool_result)
        resolved += 1
    return resolved


def _created_at_key(value: datetime | None) -> datetime:
    """Comparable UTC sort key — naive datetimes are UTC from the store."""
    if value is None:
        return datetime.min.replace(tzinfo=timezone.utc)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def has_preview_payload(*values: object) -> bool:
    """True when any value carries real content.

    ``None``, empty dicts/lists, and blank or container-only strings
    (``"{}"``, ``"[]"``) are not payloads — a root span whose I/O rendered to
    ``"{}"`` must not win the preview on the strength of that alone. Works
    for resolved I/O values (dict/list/str) and for stored preview strings.
    """
    for value in values:
        if value is None:
            continue
        if isinstance(value, str):
            stripped = value.strip()
            if stripped and stripped not in ("{}", "[]", '""'):
                return True
        elif isinstance(value, (dict, list)) and value:
            return True
    return False


# Preview-source precedence tiers (issue #192), decided PER SLOT (issue
# #203): a call contests the input slot only when its own input carries a
# payload, and the output slot only when its own output does.
#   2 — root call: the trace's own summary of itself, one turn in / one
#       answer out, free of the system scaffolding and accumulated history
#       that make a generation's whole-prompt input unsuitable for a
#       one-line row;
#   1 — a GENERATION call (the previous top tier);
#   0 — anything else.
ROOT_PAYLOAD_TIER = 2
GENERATION_TIER = 1
OTHER_TIER = 0


def preview_tier(call: LoggedCallDB, has_payload: bool) -> int:
    """Classify a call's preview precedence tier for ONE slot.

    ``has_payload`` is that slot's own payload evidence — scoring the input
    slot passes ``has_preview_payload(io.input)`` and the output slot
    ``has_preview_payload(io.output)``, so a one-sided root tops the tier
    for the side it fills and falls through on the other.
    """
    if has_payload and call.parent_call_id is None:
        return ROOT_PAYLOAD_TIER
    if call.observation_type == "GENERATION":
        return GENERATION_TIER
    return OTHER_TIER


def maybe_update_run_preview(
    session: Session, run: RunDB, call: LoggedCallDB, io: ResolvedCallIO
) -> None:
    """Maintain ``runs.input_preview/output_preview`` — dual/slim modes only.

    Replicates the list API's read-time rule per slot (root call with a
    payload on that side, else first GENERATION call with one, else the
    first call of any kind, by creation order) with a deterministic
    ``(created_at, row_id)`` tie-break:

    - each slot is decided independently: a call contests the input slot
      only when its own input carries a payload (same for output), so a
      one-sided root takes only the slot it can fill and the other falls
      through to the next tier (issue #203);
    - a higher tier beats a lower tier regardless of arrival order
      (root-with-payload > GENERATION > other);
    - within the same tier, the earlier ``(created_at, row_id)`` wins;
    - re-projecting a slot's own source call refreshes that slot (otherwise
      previews go stale on re-ingest/reproject) without touching the other
      slot, whose source is tracked separately;
    - a dangling per-slot source (purged/deleted source) is treated as
      unknown — the next projecting call overwrites freely. A slot that
      carries a payload but lost its pointer to the v40 drop is a real
      unknown incumbent: only a root payload may take it, so late
      low-tier spans never downgrade pre-migration previews.

    The stored previews double as the source's payload evidence: fat columns
    are not written in slim mode, but a call only reached a slot by carrying
    a payload on that side, and that payload is what the preview string
    holds.

    Previews are never cleared when a source dies or stops carrying a
    payload; they live and die with the projection row (lifecycle
    unchanged).
    """
    if call.row_id is None:
        session.flush()

    if has_preview_payload(io.input) and _slot_should_replace(
        session, call, source_row_id=run.input_preview_call_row_id,
        slot_preview=run.input_preview,
    ):
        run.input_preview = truncate_preview(io.input)
        run.input_preview_call_row_id = call.row_id
    if has_preview_payload(io.output) and _slot_should_replace(
        session, call, source_row_id=run.output_preview_call_row_id,
        slot_preview=run.output_preview,
    ):
        run.output_preview = truncate_preview(io.output)
        run.output_preview_call_row_id = call.row_id
    session.add(run)


def _slot_should_replace(
    session: Session,
    call: LoggedCallDB,
    *,
    source_row_id: int | None,
    slot_preview: str | None,
) -> bool:
    """Whether ``call`` — already known to carry a payload for this slot —
    takes the slot from its incumbent."""
    if source_row_id is None:
        if not has_preview_payload(slot_preview):
            return True
        # Pre-v40 paired-era row: the slot holds a payload but v40 dropped
        # its source pointer, so the incumbent is real yet unknown. Only a
        # root payload may take it — the paired writer rooted previews the
        # same way, so tier 2 restores its pick while any lower tier could
        # only downgrade what the old pointer used to protect.
        return preview_tier(call, has_payload=True) == ROOT_PAYLOAD_TIER
    if call.row_id == source_row_id:
        return True
    source = session.get(LoggedCallDB, source_row_id)
    if source is None:
        # Dangling source (purged/deleted): unknown incumbent.
        return True
    call_tier = preview_tier(call, has_payload=True)
    source_tier = preview_tier(source, has_preview_payload(slot_preview))
    if call_tier != source_tier:
        # Higher tier wins regardless of arrival order; a lower tier
        # never displaces it.
        return call_tier > source_tier
    # Same tier: earlier wins. SQLite hands back naive datetimes while a
    # just-created in-session row is tz-aware — normalize before comparing
    # or the tuple compare raises.
    return (_created_at_key(call.created_at), call.row_id) < (
        _created_at_key(source.created_at),
        source.row_id,
    )
