"""Projection I/O — the single source of truth for call input/output values.

Stage 2 of storage single-homing: the canonical span store is the one home
of span data, and the product projection (``logged_calls``) is a derived
view. This module owns the three pieces that make that safe:

- **Write/read modes** (``APO_PROJECTION_WRITE_MODE`` = fat | dual | slim,
  ``APO_LIST_READ`` = legacy | previews). fat is today's behavior; dual
  writes fat columns AND run-level previews; slim stops writing the fat
  I/O columns entirely. Every flip is an env var, so each step is
  independently revertible without a deploy.
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
LIST_READ_ENV = "APO_LIST_READ"

# The run-list preview length — matches the truncation the list API has
# always applied at read time; previews freeze it at write time instead.
PREVIEW_MAX_CHARS = 200


def projection_write_mode() -> str:
    """``fat`` (default) | ``dual`` | ``slim`` — read fresh so operators can
    flip modes without a restart."""
    value = os.environ.get(WRITE_MODE_ENV, "fat").strip().lower()
    if value in ("fat", "dual", "slim"):
        return value
    if value:
        logger.warning(
            "invalid %s=%r — falling back to fat (expected fat|dual|slim)",
            WRITE_MODE_ENV,
            value,
        )
    return "fat"


def list_read_mode() -> str:
    """``legacy`` (default) | ``previews`` — the list API's preview source.

    Only flip to ``previews`` after the backfill verified parity for
    existing runs; a NULL preview falls back to the legacy truncation
    path per run, so the flip can never blank a list."""
    value = os.environ.get(LIST_READ_ENV, "legacy").strip().lower()
    return "previews" if value == "previews" else "legacy"


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


# Preview-source precedence tiers (issue #192):
#   2 — root call carrying a payload: the trace's own summary of itself,
#       one turn in / one answer out, free of the system scaffolding and
#       accumulated history that make a generation's whole-prompt input
#       unsuitable for a one-line row;
#   1 — a GENERATION call (the previous top tier);
#   0 — anything else.
ROOT_PAYLOAD_TIER = 2
GENERATION_TIER = 1
OTHER_TIER = 0


def preview_tier(call: LoggedCallDB, has_payload: bool) -> int:
    """Classify a call's preview precedence tier."""
    if has_payload and call.parent_call_id is None:
        return ROOT_PAYLOAD_TIER
    if call.observation_type == "GENERATION":
        return GENERATION_TIER
    return OTHER_TIER


def maybe_update_run_preview(
    session: Session, run: RunDB, call: LoggedCallDB, io: ResolvedCallIO
) -> None:
    """Maintain ``runs.input_preview/output_preview`` — dual/slim modes only.

    Replicates the list API's read-time rule (root call with a payload, else
    first GENERATION call, else the first call of any kind, by creation
    order) with a deterministic ``(created_at, row_id)`` tie-break:

    - a higher tier beats a lower tier regardless of arrival order
      (root-with-payload > GENERATION > other);
    - within the same tier, the earlier ``(created_at, row_id)`` wins;
    - re-projecting the SAME source call refreshes its values (otherwise
      previews go stale on re-ingest/reproject);
    - a dangling ``preview_call_row_id`` (purged/deleted source) is treated
      as unknown — the next projecting call overwrites freely.

    The stored previews double as the source's payload evidence: fat columns
    are not written in slim mode, but a root only reached the source slot by
    carrying a payload, and that payload is what the preview strings hold.

    Previews are never cleared when a source dies; they live and die with
    the projection row (lifecycle unchanged).
    """
    if call.row_id is None:
        session.flush()

    source: LoggedCallDB | None = None
    if run.preview_call_row_id is not None:
        source = session.get(LoggedCallDB, run.preview_call_row_id)

    call_tier = preview_tier(
        call, has_preview_payload(io.input, io.output)
    )
    if source is None:
        replace = True
    elif call.row_id == run.preview_call_row_id:
        replace = True
    else:
        source_tier = preview_tier(
            source,
            has_preview_payload(run.input_preview, run.output_preview),
        )
        if call_tier != source_tier:
            # Higher tier wins regardless of arrival order; a lower tier
            # never displaces it.
            replace = call_tier > source_tier
        else:
            # Same tier: earlier wins. SQLite hands back naive datetimes
            # while a just-created in-session row is tz-aware — normalize
            # before comparing or the tuple compare raises.
            replace = (_created_at_key(call.created_at), call.row_id) < (
                _created_at_key(source.created_at),
                source.row_id,
            )

    if replace:
        run.input_preview = truncate_preview(io.input)
        run.output_preview = truncate_preview(io.output)
        run.preview_call_row_id = call.row_id
        session.add(run)
