# pyright: reportMissingParameterType=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownParameterType=false

import pytest
from sqlalchemy.pool import NullPool

from apo import db


def test_sqlite_uses_short_lived_connections_without_a_queue_pool(monkeypatch) -> None:
    monkeypatch.setattr(db, "DATABASE_URL", "sqlite:///test.db")

    kwargs = db._get_engine_kwargs()

    assert kwargs["poolclass"] is NullPool
    assert kwargs["connect_args"] == {"check_same_thread": False}


def test_postgres_keeps_explicit_bounded_pool(monkeypatch) -> None:
    monkeypatch.setattr(db, "DATABASE_URL", "postgresql://localhost/apo")

    kwargs = db._get_engine_kwargs()

    assert kwargs["pool_size"] == 10
    assert kwargs["max_overflow"] == 20
    assert "poolclass" not in kwargs


def test_cache_size_env_fails_closed_on_invalid_values(monkeypatch) -> None:
    # A present-but-empty value is a misconfiguration, not the default:
    # every other limit tunable raises, and a silent 64 MiB fallback would
    # hide the operator error until the container's memory does not.
    monkeypatch.setenv("APO_SQLITE_CACHE_KIB", "")
    with pytest.raises(ValueError, match="APO_SQLITE_CACHE_KIB"):
        db.sqlite_cache_size_kib()

    monkeypatch.setenv("APO_SQLITE_CACHE_KIB", "0")
    with pytest.raises(ValueError, match="positive integer"):
        db.sqlite_cache_size_kib()

    monkeypatch.setenv("APO_SQLITE_CACHE_KIB", "2048")
    assert db.sqlite_cache_size_kib() == 2048
