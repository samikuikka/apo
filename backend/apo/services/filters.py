import re
from datetime import datetime
from typing import Any

from sqlalchemy import text as sql_text
from sqlmodel import or_

from ..db import _is_sqlite


_TAG_PATTERN = re.compile(r'^[a-zA-Z0-9_\-:\s\.]+$')


def sanitize_tags(tags: list[str]) -> list[str]:
    return [t for t in tags if _TAG_PATTERN.match(t)]


def _tag_in_array_sql(column_name: str, tag: str) -> str:
    """Exact-match SQL predicate: is ``tag`` an element of the JSON array column?

    Dialect-aware:
    - SQLite: ``json_each`` — scans the array and compares each element.
    - Postgres: the jsonb ``?`` operator — true when the string is a
      top-level array element (or object key).

    This replaces the old ``CAST(col AS TEXT) LIKE '%"tag"%'`` form, which
    matched substrings: a search for tag ``"api"`` falsely matched
    ``"api-testing"`` and could match unrelated quoted strings elsewhere in
    the row. Exact element match has no such false positives, and the
    Postgres form is GIN-indexable.

    ``tag`` is safe to interpolate because ``sanitize_tags`` restricts it to
    ``[A-Za-z0-9_\\-:.\\s]+`` (no quotes, semicolons, or backslashes).
    """
    if _is_sqlite():
        return (
            f"EXISTS (SELECT 1 FROM json_each({column_name}) "
            f"WHERE value = '{tag}')"
        )
    return f"{column_name}::jsonb ? '{tag}'"


def _build_tag_conditions(tags: list[str], column_name: str) -> list[Any]:
    safe = sanitize_tags(tags)
    return [
        sql_text(_tag_in_array_sql(column_name, tag))
        for tag in safe
    ]


def apply_tag_filters(
    statement: Any,
    tags: str,
    column_name: str = "tags",
) -> Any:
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    conditions = _build_tag_conditions(tag_list, column_name)
    if conditions:
        statement = statement.where(or_(*conditions))
    return statement


def apply_tag_any_filter(
    statement: Any,
    tags: list[str],
    column_name: str = "tags",
) -> Any:
    conditions = _build_tag_conditions(tags, column_name)
    if conditions:
        statement = statement.where(or_(*conditions))
    return statement


def apply_tag_all_filter(
    statement: Any,
    tags: list[str],
    column_name: str = "tags",
) -> Any:
    safe = sanitize_tags(tags)
    for tag in safe:
        statement = statement.where(
            sql_text(_tag_in_array_sql(column_name, tag))
        )
    return statement


def apply_date_range(
    statement: Any,
    column: Any,
    after: str | datetime | None = None,
    before: str | datetime | None = None,
) -> Any:
    after_dt = _parse_datetime(after)
    before_dt = _parse_datetime(before)
    if after_dt is not None:
        statement = statement.where(column >= after_dt)
    if before_dt is not None:
        statement = statement.where(column <= before_dt)
    return statement


def _parse_datetime(value: str | datetime | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def apply_model_filter(
    statement: Any,
    models: str,
    model_col: Any,
) -> Any:
    model_list = [m.strip() for m in models.split(",") if m.strip()]
    if model_list:
        statement = statement.where(model_col.in_(model_list))
    return statement


def apply_numeric_range(
    statement: Any,
    column: Any,
    min_val: float | None = None,
    max_val: float | None = None,
) -> Any:
    if min_val is not None:
        statement = statement.where(column >= min_val)
    if max_val is not None:
        statement = statement.where(column <= max_val)
    return statement
