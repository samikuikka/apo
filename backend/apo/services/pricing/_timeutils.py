"""Naive-wall-time normalization shared by the pricing services.

Era datetimes live in naive DATETIME columns: SQLite drops tzinfo at the
bind boundary (keeping wall time) and every read-back is naive. Any
datetime that gets keyed by, compared against, or written into those
columns must be normalized to naive wall time first, or the in-memory and
stored sides silently disagree.
"""

from __future__ import annotations

from datetime import datetime


def naive(dt: datetime) -> datetime:
    """Strip tzinfo, keeping wall time.

    Wall time is what the naive columns already store; converting to UTC
    instead would shift non-UTC timestamps and churn every existing era key.
    """
    return dt.replace(tzinfo=None) if dt.tzinfo is not None else dt


__all__ = ["naive"]
