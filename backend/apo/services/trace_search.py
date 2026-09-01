"""Trace search — span-derived predicates over the run list.

The canonical span store (``otlp_spans``, the single span home)
is queried through correlated ``EXISTS`` subqueries so a run matches when
ANY of its spans matches (and, for negated ops, when NONE does).

Two comparison domains, deliberately:

- **Text ops** compare ``CAST(json_extract(attributes, path) AS TEXT)``
  against the bound value (Postgres: ``attributes->>key``) — canonical
  text renderings, pinned by tests.
- **Numeric ops** (``gt/gte/lt/lte``) compare ``CAST(... AS REAL)`` —
  text-domain ordering is numerically wrong (``'99' >= '1000'`` is TRUE
  lexicographically), so a non-numeric bound is a 400 at parse time.

Injection safety is structural: operators and field kinds come from fixed
maps, attribute keys must match a grammar that admits no quote/escape/paren
characters, and VALUES are always bound parameters. ``LIKE`` always carries
an explicit ``ESCAPE`` character — SQLite has none by default.
"""

# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import TypedDict
from datetime import datetime
from typing import Any, cast as tcast

from sqlalchemy import Float, Text, and_, exists, func, not_, or_, select
from sqlalchemy import cast as sql_cast
from sqlalchemy.orm import aliased
from sqlmodel import col

from ..db import is_sqlite
from ..models.db import OtlpSpanDB, RunDB

# Attribute keys are grammar-checked, then embedded into the JSON path —
# this class of key cannot break out of '$."…"' (SQLite) or '…' (Postgres).
# Embedding (rather than binding the path) is what keeps the door open for
# SQLite expression indexes on hot keys, the named scale-up trigger.
_ATTRIBUTE_KEY_RE = re.compile(r"^[A-Za-z0-9_.\-/:]{1,256}$")

MAX_PREDICATES = 16
MAX_IN_ITEMS = 16
MAX_TEXT_LENGTH = 256
MAX_SPAN_TEXT_BYTES = 512

_TEXT_OPS = frozenset(
    {"eq", "neq", "in", "not_in", "contains", "not_contains", "starts_with", "ends_with"}
)
_NUMERIC_OPS = frozenset({"gt", "gte", "lt", "lte"})
_EXIST_OPS = frozenset({"exists", "not_exists"})
ALL_OPS = _TEXT_OPS | _NUMERIC_OPS | _EXIST_OPS

# LIKE needs an explicit escape character to make %/_ literal-capable.
_ESCAPE_CHAR = "\\"

_FIELDS_WITHOUT_ATTRIBUTES = frozenset({"span_name", "service"})


class SpanFilterError(ValueError):
    """Malformed span filter — maps to HTTP 400 with the predicate index."""


@dataclass(frozen=True)
class SpanPredicate:
    """One span-level predicate: field, op, bound value(s)."""

    field: str  # "attribute:<key>" | "span_name" | "service"
    op: str
    value: Any = None  # str | list[str] (in) | float (numeric) | None (exists)


def _fail(index: int, message: str) -> SpanFilterError:
    return SpanFilterError(f"span_filter[{index}]: {message}")


def parse_span_filter(raw: str | None) -> list[SpanPredicate]:
    """Parse the ``span_filter`` JSON array into validated predicates.

    Raises :class:`SpanFilterError` (→ 400) on malformed JSON, unknown
    fields/ops, grammar-violating keys, wrong value types, non-numeric
    bounds on numeric ops, and the documented limits.
    """
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SpanFilterError(f"span_filter is not valid JSON: {exc}") from exc
    if not isinstance(parsed, list):
        raise SpanFilterError("span_filter must be a JSON array")
    if len(parsed) > MAX_PREDICATES:
        raise SpanFilterError(f"span_filter accepts at most {MAX_PREDICATES} predicates")

    predicates: list[SpanPredicate] = []
    for index, item in enumerate(parsed):
        if not isinstance(item, dict):
            raise _fail(index, "each predicate must be an object")
        field = item.get("field")
        op = item.get("op")
        value = item.get("value")
        if not isinstance(field, str) or not field:
            raise _fail(index, "field must be a non-empty string")
        if op not in ALL_OPS:
            raise _fail(index, f"unknown op {op!r}")

        if field.startswith("attribute:"):
            key = field[len("attribute:") :]
            if not _ATTRIBUTE_KEY_RE.fullmatch(key):
                raise _fail(index, f"invalid attribute key {key!r}")
        elif field in _FIELDS_WITHOUT_ATTRIBUTES:
            key = None
            if op in _NUMERIC_OPS:
                raise _fail(index, f"op {op!r} requires an attribute: field")
        else:
            raise _fail(index, f"unknown field {field!r}")

        bound: Any = None
        if op in _TEXT_OPS:
            if op in ("in", "not_in"):
                if not isinstance(value, list) or not all(
                    isinstance(v, str) for v in value
                ):
                    raise _fail(index, f"{op} requires a list of strings")
                if not 1 <= len(value) <= MAX_IN_ITEMS:
                    raise _fail(index, f"{op} accepts 1..{MAX_IN_ITEMS} values")
                if any(len(v) > MAX_TEXT_LENGTH for v in value):
                    raise _fail(index, f"{op} values must be ≤{MAX_TEXT_LENGTH} chars")
                bound = list(value)
            else:
                if not isinstance(value, str) or value == "":
                    raise _fail(index, f"{op} requires a non-empty string value")
                if len(value) > MAX_TEXT_LENGTH:
                    raise _fail(index, f"value must be ≤{MAX_TEXT_LENGTH} chars")
                bound = value
        elif op in _NUMERIC_OPS:
            try:
                if isinstance(value, bool) or not isinstance(value, (int, float, str)):
                    raise SpanFilterError("not numeric")
                bound = float(value)
            except (SpanFilterError, ValueError) as exc:
                raise _fail(index, f"{op} requires a numeric value") from exc
        # exists / not_exists carry no value.

        predicates.append(SpanPredicate(field=field, op=op, value=bound))
    return predicates


def _escape_like(value: str) -> str:
    """Escape LIKE wildcards so user text matches literally."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _attribute_text(span_alias: Any, key: str) -> Any:
    """The attribute value as text, dialect-exact (SQLite vs Postgres)."""
    if is_sqlite():
        return sql_cast(
            func.json_extract(span_alias.attributes, f'$."{key}"'), Text
        )
    return span_alias.attributes.op("->>")(key)


def _attribute_number(span_alias: Any, key: str) -> Any:
    """The attribute value as a number (ordering ops only)."""
    if is_sqlite():
        return sql_cast(func.json_extract(span_alias.attributes, f'$."{key}"'), Float)
    return sql_cast(span_alias.attributes.op("->>")(key), Float)


def _field_text(span_alias: Any, predicate: SpanPredicate) -> Any:
    if predicate.field == "span_name":
        return sql_cast(span_alias.span_name, Text)
    if predicate.field == "service":
        return sql_cast(span_alias.service_name, Text)
    key = predicate.field[len("attribute:") :]
    return _attribute_text(span_alias, key)


# Negated ops mean "NO span in the trace matches the POSITIVE form" — the
# positive condition goes inside the EXISTS, and the EXISTS itself is
# negated. Building the negative condition inline AND negating the EXISTS
# would double-negate into "every span differs" semantics.
_POSITIVE_FORM = {
    "neq": "eq",
    "not_in": "in",
    "not_contains": "contains",
    "not_exists": "exists",
}


def _predicate_condition(span_alias: Any, predicate: SpanPredicate) -> Any:
    """One span-row condition for a predicate (the EXISTS body's AND term).

    Always the POSITIVE form — negation happens at the EXISTS level.
    """
    op = _POSITIVE_FORM.get(predicate.op, predicate.op)
    if op in _EXIST_OPS:
        if predicate.field in _FIELDS_WITHOUT_ATTRIBUTES:
            column = (
                span_alias.span_name
                if predicate.field == "span_name"
                else span_alias.service_name
            )
            present = column.is_not(None) & (column != "")
        else:
            key = predicate.field[len("attribute:") :]
            if is_sqlite():
                json_type = func.json_type(
                    span_alias.attributes, f'$."{key}"'
                )
                # json_type yields 'null' for an explicit JSON null — key
                # presence must mean a real value.
                present = (json_type != "null") & json_type.is_not(None)
            else:
                # json '->' returns SQL NULL both for a missing key and for
                # an explicit JSON null on the Postgres json type.
                present = span_alias.attributes.op("->")(key).is_not(None)
        return present if op == "exists" else ~present

    text = _field_text(span_alias, predicate)
    if op == "eq":
        return text == predicate.value
    if op == "neq":
        return text != predicate.value
    if op in ("in", "not_in"):
        values: list[str] = predicate.value
        return text.in_(values) if op == "in" else ~text.in_(values)
    if op in ("contains", "not_contains"):
        pattern = f"%{_escape_like(str(predicate.value))}%"
        matched = text.like(pattern, escape=_ESCAPE_CHAR)
        return matched if op == "contains" else ~matched
    if op == "starts_with":
        return text.like(f"{_escape_like(str(predicate.value))}%", escape=_ESCAPE_CHAR)
    if op == "ends_with":
        return text.like(f"%{_escape_like(str(predicate.value))}", escape=_ESCAPE_CHAR)

    # Numeric ordering — REAL domain. Numeric ops always carry a parsed
    # float value (parse_span_filter rejects non-numeric bounds).
    key = predicate.field[len("attribute:") :]
    number = _attribute_number(span_alias, key)
    bound = float(tcast("float", predicate.value))
    if op == "gt":
        return number > bound
    if op == "gte":
        return number >= bound
    if op == "lt":
        return number < bound
    return number <= bound


def _span_exists(predicate: SpanPredicate, *, negated: bool) -> Any:
    """Correlated EXISTS against a trace's spans (NOT EXISTS when negated)."""
    sp = aliased(OtlpSpanDB)
    condition = and_(
        col(sp.project_id) == col(RunDB.project),
        col(sp.trace_id) == col(RunDB.id),
        _predicate_condition(sp, predicate),  # pyright: ignore[reportArgumentType]
    )
    return not_(exists().where(condition)) if negated else exists().where(condition)


_NEGATED_OPS = {"neq", "not_in", "not_contains", "not_exists"}


def apply_trace_search(
    statement: Any,
    *,
    service: str | None = None,
    operation: str | None = None,
    span_text: str | None = None,
    predicates: list[SpanPredicate] | None = None,
) -> Any:
    """Narrow a run-list select to traces whose spans match the search.

    Simple params (``service`` / ``operation``) compile to exact-match
    predicates; ``span_text`` ORs a span-name LIKE with an
    attributes-JSON-text LIKE (case-folded, escaped). Each structured
    predicate becomes one correlated EXISTS — negated ops use NOT EXISTS,
    meaning NO span in the trace matches.
    """
    conditions: list[Any] = []

    if service:
        conditions.append(
            _span_exists(SpanPredicate(field="service", op="eq", value=service), negated=False)
        )
    if operation:
        conditions.append(
            _span_exists(
                SpanPredicate(field="span_name", op="eq", value=operation), negated=False
            )
        )
    if span_text:
        if len(span_text.encode("utf-8")) > MAX_SPAN_TEXT_BYTES:
            raise SpanFilterError(
                f"span_text must be ≤{MAX_SPAN_TEXT_BYTES} bytes"
            )
        sp = aliased(OtlpSpanDB)
        pattern = f"%{_escape_like(span_text)}%"
        lowered = span_text.lower()
        lowered_pattern = f"%{_escape_like(lowered)}%"
        text_match = or_(
            func.lower(sp.span_name).like(lowered_pattern, escape=_ESCAPE_CHAR),
            sql_cast(sp.attributes, Text).like(pattern, escape=_ESCAPE_CHAR),
        )
        conditions.append(
            exists().where(
                and_(
                    col(sp.project_id) == col(RunDB.project),
                    col(sp.trace_id) == col(RunDB.id),
                    text_match,  # pyright: ignore[reportArgumentType]
                )
            )
        )

    for predicate in predicates or []:
        conditions.append(
            _span_exists(predicate, negated=predicate.op in _NEGATED_OPS)
        )

    for condition in conditions:
        statement = statement.where(condition)
    return statement


# ---------------------------------------------------------------------------
# Facets (span-derived dropdown values)
# ---------------------------------------------------------------------------


class SpanFieldBucket(TypedDict):
    """One facet bucket — typed so route handlers construct cleanly."""

    value: str
    count: int


def span_field_facets(
    session: Any,
    *,
    project: str,
    created_after: datetime | None = None,
    created_before: datetime | None = None,
    span_text: str | None = None,
    limit: int = 50,
) -> dict[str, list[SpanFieldBucket]]:
    """Top service/operation buckets, counted per distinct trace.

    A full project scan within the window (``start_time`` carries no
    index) — the documented cost. ``span_text`` narrows facet counts the
    same way it narrows the run list. NULL/empty buckets are suppressed;
    counts are per distinct trace so list totals and facet numbers tell
    the same story.
    """

    def _buckets(column_of: Any, extra_conditions_of: Any) -> list[SpanFieldBucket]:
        # One aliased entity feeds select, where, and group-by alike —
        # mixing the unaliased class column with the alias silently
        # unconstrains the buckets.
        sp = aliased(OtlpSpanDB)
        column = column_of(sp)
        conditions: list[Any] = [
            col(sp.project_id) == project,
            *extra_conditions_of(sp),
        ]
        if created_after is not None:
            conditions.append(col(sp.start_time) >= created_after)
        if created_before is not None:
            conditions.append(col(sp.start_time) <= created_before)
        if span_text:
            lowered = f"%{_escape_like(span_text.lower())}%"
            conditions.append(
                or_(
                    func.lower(sp.span_name).like(lowered, escape=_ESCAPE_CHAR),
                    sql_cast(sp.attributes, Text).like(
                        f"%{_escape_like(span_text)}%", escape=_ESCAPE_CHAR
                    ),
                )
            )
        stmt = (
            select(
                column,
                func.count(func.distinct(sp.trace_id)),
            )
            .filter(*conditions)
            .group_by(column)
            .order_by(func.count(func.distinct(sp.trace_id)).desc(), column)
            .limit(limit)
        )
        return [
            {"value": str(row[0]), "count": int(row[1])}
            for row in session.exec(stmt).all()
        ]

    services = _buckets(
        lambda sp: sp.service_name,
        lambda sp: [sp.service_name.is_not(None), sp.service_name != ""],
    )
    operations = _buckets(lambda sp: sp.span_name, lambda sp: [])
    return {"services": services, "operations": operations}
