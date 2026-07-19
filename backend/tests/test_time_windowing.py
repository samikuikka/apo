# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false

"""SPEC-136 ticket 04: time-windowed era selection."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine

from apo.models.pricing import ModelRowDB
from apo.services.pricing.resolution import resolve_model_era


@pytest.fixture
def session() -> Session:
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    sess = Session(eng)
    yield sess
    sess.close()


def _dt(iso: str) -> datetime:
    """Parse ISO datetime; SQLite stores datetimes naive, so compare naive."""
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return dt.replace(tzinfo=None)


def _dt_query(iso: str) -> datetime:
    """Parse ISO datetime for the at_time QUERY argument (kept tz-aware)."""
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def _make_two_eras(session: Session) -> None:
    """A model with two eras [2026-01-01, 2026-03-01) and [2026-03-01, NULL)."""
    session.add(
        ModelRowDB(
            project="__global__",
            match_pattern=r"(?i)^claude-3$",
            provider="anthropic",
            start_date=_dt("2026-01-01T00:00:00Z"),
            end_date=_dt("2026-03-01T00:00:00Z"),
        )
    )
    session.add(
        ModelRowDB(
            project="__global__",
            match_pattern=r"(?i)^claude-3$",
            provider="anthropic",
            start_date=_dt("2026-03-01T00:00:00Z"),
            end_date=None,
        )
    )
    session.commit()


class TestEraSelection:
    def test_first_era_for_feb(self, session: Session) -> None:
        _make_two_eras(session)
        era = resolve_model_era(session, "claude-3", "__global__", _dt_query("2026-02-15T00:00:00Z"))
        assert era is not None
        assert era.start_date == _dt("2026-01-01T00:00:00Z")

    def test_second_era_for_apr(self, session: Session) -> None:
        _make_two_eras(session)
        era = resolve_model_era(session, "claude-3", "__global__", _dt_query("2026-04-01T00:00:00Z"))
        assert era is not None
        assert era.start_date == _dt("2026-03-01T00:00:00Z")

    def test_boundary_start_is_inclusive(self, session: Session) -> None:
        _make_two_eras(session)
        era = resolve_model_era(session, "claude-3", "__global__", _dt_query("2026-03-01T00:00:00Z"))
        assert era is not None
        assert era.start_date == _dt("2026-03-01T00:00:00Z")  # half-open [start, end)

    def test_boundary_end_is_exclusive(self, session: Session) -> None:
        _make_two_eras(session)
        # Exactly at the first era's end -> belongs to the second era.
        era = resolve_model_era(session, "claude-3", "__global__", _dt_query("2026-03-01T00:00:00Z"))
        assert era is not None
        assert era.start_date == _dt("2026-03-01T00:00:00Z")

    def test_no_era_for_date_outside_all_windows(self, session: Session) -> None:
        # Two finite-ish eras but check a date before the first era starts.
        session.add(
            ModelRowDB(
                project="__global__",
                match_pattern=r"(?i)^claude-3$",
                provider="anthropic",
                start_date=_dt("2026-06-01T00:00:00Z"),
                end_date=_dt("2026-07-01T00:00:00Z"),
            )
        )
        session.commit()
        era = resolve_model_era(session, "claude-3", "__global__", _dt_query("2026-01-01T00:00:00Z"))
        assert era is None

    def test_legacy_seed_null_start_matches_any_time(self, session: Session) -> None:
        """start_date IS NULL marks legacy seed rows; matches any at_time."""
        session.add(
            ModelRowDB(
                project="__global__",
                match_pattern=r"(?i)^gpt-4o$",
                provider="openai",
                start_date=None,
                end_date=None,
            )
        )
        session.commit()
        past = resolve_model_era(session, "gpt-4o", "__global__", _dt_query("2020-01-01T00:00:00Z"))
        future = resolve_model_era(session, "gpt-4o", "__global__", _dt_query("2030-01-01T00:00:00Z"))
        assert past is not None
        assert future is not None

    def test_late_arriving_span_prices_at_its_era(self, session: Session) -> None:
        """A span that arrived today but started in Feb prices at Feb's era."""
        _make_two_eras(session)
        era = resolve_model_era(session, "claude-3", "__global__", _dt_query("2026-02-15T00:00:00Z"))
        assert era is not None
        assert era.start_date == _dt("2026-01-01T00:00:00Z")

    def test_project_overrides_shadow_global(self, session: Session) -> None:
        session.add(
            ModelRowDB(
                project="__global__",
                match_pattern=r"(?i)^gpt-4o$",
                provider="openai",
                start_date=None,
            )
        )
        session.add(
            ModelRowDB(
                project="my-proj",
                match_pattern=r"(?i)^gpt-4o$",
                provider="openai",
                start_date=None,
                display_name="project override",
            )
        )
        session.commit()
        era = resolve_model_era(session, "gpt-4o", "my-proj", _dt_query("2026-02-15T00:00:00Z"))
        assert era is not None
        assert era.display_name == "project override"

    def test_no_match_returns_none(self, session: Session) -> None:
        era = resolve_model_era(session, "nonexistent", "__global__", _dt_query("2026-02-15T00:00:00Z"))
        assert era is None

    def test_anchored_fullmatch_case_insensitive(self, session: Session) -> None:
        session.add(
            ModelRowDB(
                project="__global__",
                match_pattern=r"^gpt-4o$",
                provider="openai",
                start_date=None,
            )
        )
        session.commit()
        # gpt-4o matches; gpt-4o-mini must NOT (anchored fullmatch).
        assert resolve_model_era(session, "gpt-4o", "__global__", _dt_query("2026-02-15T00:00:00Z")) is not None
        assert resolve_model_era(session, "GPT-4O", "__global__", _dt_query("2026-02-15T00:00:00Z")) is not None
        assert (
            resolve_model_era(session, "gpt-4o-mini", "__global__", _dt_query("2026-02-15T00:00:00Z"))
            is None
        )
