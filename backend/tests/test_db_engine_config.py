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
