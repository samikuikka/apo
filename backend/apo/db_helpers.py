from datetime import datetime, timezone
from typing import TypeVar, cast

from sqlalchemy.sql.elements import ColumnElement

_TColumn = TypeVar("_TColumn")


def _as_column(value: object) -> ColumnElement[_TColumn]:
    return cast(ColumnElement[_TColumn], value)


def _ensure_utc_datetime(dt: datetime) -> datetime:
    """Normalize datetimes loaded from the database into timezone-aware UTC values."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)
