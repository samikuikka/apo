# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownLambdaType=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false

"""SPEC-136 ticket 07: JSON-defaults loader."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from apo.models.pricing import ModelRowDB, PriceDB, PricingTierDB
from apo.models.usage_keys import UsageKey
from apo.services.pricing.loader import DEFAULTS_PATH, load_default_prices

NOW = datetime(2026, 7, 22, tzinfo=timezone.utc)


@pytest.fixture
def session(tmp_path: Path) -> Session:
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    sess = Session(eng)
    yield sess
    sess.close()


def _write_defaults(tmp_path: Path, models: list[dict[str, object]]) -> Path:
    path = tmp_path / "defaults.json"
    path.write_text(json.dumps({"models": models}))
    return path


class TestLoadDefaults:
    def test_seeds_global_rows(self, session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        path = _write_defaults(
            tmp_path,
            [
                {
                    "match_pattern": "(?i)^gpt-4o$",
                    "provider": "openai",
                    "display_name": "GPT-4o",
                    "updated_at": "2026-07-22T00:00:00Z",
                    "pricing_tiers": [
                        {
                            "name": "default",
                            "is_default": True,
                            "priority": 0,
                            "conditions": [],
                            "prices": {"input": 2.50, "output": 10.00},
                        }
                    ],
                }
            ],
        )
        monkeypatch.setattr("apo.services.pricing.loader.DEFAULTS_PATH", path)
        n = load_default_prices(session)
        assert n >= 1
        models = list(session.exec(select(ModelRowDB).where(ModelRowDB.project == "__global__")).all())
        assert len(models) == 1
        assert models[0].match_pattern == "(?i)^gpt-4o$"
        # Prices converted USD-per-1M -> micro-USD-per-1M int.
        prices = list(session.exec(select(PriceDB)).all())
        assert any(p.usage_key == "input" and p.price_per_1m == 2_500_000 for p in prices)
        assert any(p.usage_key == "output" and p.price_per_1m == 10_000_000 for p in prices)

    def test_idempotent_reload_no_writes(self, session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        path = _write_defaults(
            tmp_path,
            [
                {
                    "match_pattern": "(?i)^gpt-4o$",
                    "provider": "openai",
                    "updated_at": "2026-07-22T00:00:00Z",
                    "pricing_tiers": [
                        {"name": "default", "is_default": True, "conditions": [], "prices": {"input": 2.50}}
                    ],
                }
            ],
        )
        monkeypatch.setattr("apo.services.pricing.loader.DEFAULTS_PATH", path)
        load_default_prices(session)
        # Second load: same updated_at -> no writes (count 0 upserts).
        n = load_default_prices(session)
        assert n == 0

    def test_globals_absent_from_file_deleted(self, session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        # Seed with two globals.
        path = _write_defaults(
            tmp_path,
            [
                {
                    "match_pattern": "(?i)^a$",
                    "provider": "openai",
                    "updated_at": "2026-07-22T00:00:00Z",
                    "pricing_tiers": [{"name": "default", "is_default": True, "conditions": [], "prices": {"input": 1.0}}],
                },
                {
                    "match_pattern": "(?i)^b$",
                    "provider": "openai",
                    "updated_at": "2026-07-22T00:00:00Z",
                    "pricing_tiers": [{"name": "default", "is_default": True, "conditions": [], "prices": {"input": 1.0}}],
                },
            ],
        )
        monkeypatch.setattr("apo.services.pricing.loader.DEFAULTS_PATH", path)
        load_default_prices(session)
        assert len(list(session.exec(select(ModelRowDB)).all())) == 2

        # Now drop 'b' from the file; reload must delete it.
        path2 = _write_defaults(
            tmp_path,
            [
                {
                    "match_pattern": "(?i)^a$",
                    "provider": "openai",
                    "updated_at": "2026-07-22T00:00:00Z",
                    "pricing_tiers": [{"name": "default", "is_default": True, "conditions": [], "prices": {"input": 1.0}}],
                }
            ],
        )
        monkeypatch.setattr("apo.services.pricing.loader.DEFAULTS_PATH", path2)
        load_default_prices(session)
        patterns = sorted(m.match_pattern for m in session.exec(select(ModelRowDB)).all())
        assert patterns == ["(?i)^a$"]

    def test_per_project_rows_untouched(self, session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        # A per-project override exists; the loader (scoped to __global__) must not touch it.
        session.add(
            ModelRowDB(
                project="my-proj",
                match_pattern="(?i)^gpt-4o$",
                provider="openai",
                start_date=None,
            )
        )
        session.commit()
        path = _write_defaults(
            tmp_path,
            [
                {
                    "match_pattern": "(?i)^gpt-4o$",
                    "provider": "openai",
                    "updated_at": "2026-07-22T00:00:00Z",
                    "pricing_tiers": [{"name": "default", "is_default": True, "conditions": [], "prices": {"input": 2.50}}],
                }
            ],
        )
        monkeypatch.setattr("apo.services.pricing.loader.DEFAULTS_PATH", path)
        load_default_prices(session)
        proj_rows = list(
            session.exec(select(ModelRowDB).where(ModelRowDB.project == "my-proj")).all()
        )
        assert len(proj_rows) == 1

    def test_malformed_json_raises(self, session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        path = tmp_path / "bad.json"
        path.write_text("{ not valid json")
        monkeypatch.setattr("apo.services.pricing.loader.DEFAULTS_PATH", path)
        with pytest.raises(RuntimeError, match="malformed"):
            load_default_prices(session)

    def test_updated_at_bump_forces_rewrite(self, session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """A changed updated_at (even with same prices) forces an upsert."""
        path = _write_defaults(
            tmp_path,
            [
                {
                    "match_pattern": "(?i)^gpt-4o$",
                    "provider": "openai",
                    "updated_at": "2026-07-22T00:00:00Z",
                    "pricing_tiers": [{"name": "default", "is_default": True, "conditions": [], "prices": {"input": 2.50}}],
                }
            ],
        )
        monkeypatch.setattr("apo.services.pricing.loader.DEFAULTS_PATH", path)
        load_default_prices(session)

        path2 = _write_defaults(
            tmp_path,
            [
                {
                    "match_pattern": "(?i)^gpt-4o$",
                    "provider": "openai",
                    "updated_at": "2026-07-23T00:00:00Z",  # bumped
                    "pricing_tiers": [{"name": "default", "is_default": True, "conditions": [], "prices": {"input": 5.00}}],
                }
            ],
        )
        monkeypatch.setattr("apo.services.pricing.loader.DEFAULTS_PATH", path2)
        n = load_default_prices(session)
        assert n == 1  # one upsert
        prices = list(session.exec(select(PriceDB).where(PriceDB.usage_key == "input")).all())
        assert any(p.price_per_1m == 5_000_000 for p in prices)


class TestBundledFile:
    def test_bundled_file_loads_clean(self, session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
        """The shipped bundled JSON must load without error and seed globals."""
        n = load_default_prices(session)
        assert n > 0
        models = list(session.exec(select(ModelRowDB).where(ModelRowDB.project == "__global__")).all())
        # Golden shapes present.
        patterns = {m.match_pattern for m in models}
        assert any("gemini-2" in p and "pro" in p for p in patterns)  # large-context tiered
        assert any("claude" in p and "5" in p for p in patterns)  # cache-tiered
        # At least one model has 2 tiers (the large-context gemini).
        two_tier = [
            m
            for m in models
            if len(list(session.exec(select(PricingTierDB).where(PricingTierDB.model_id == m.id)).all())) >= 2
        ]
        assert len(two_tier) >= 1

    def test_bundled_gemini_large_context_prices_correct(self, session: Session) -> None:
        load_default_prices(session)
        gemini = list(
            session.exec(
                select(ModelRowDB).where(ModelRowDB.match_pattern == "(?i)^gemini-2\\.5-pro$")
            ).all()
        )
        assert len(gemini) == 1
        tiers = list(
            session.exec(select(PricingTierDB).where(PricingTierDB.model_id == gemini[0].id)).all()
        )
        assert len(tiers) == 2
        large = next(t for t in tiers if t.name == "large-context")
        large_prices = {
            p.usage_key: p.price_per_1m
            for p in session.exec(select(PriceDB).where(PriceDB.tier_id == large.id)).all()
        }
        assert large_prices["input"] == 2_500_000  # $2.50/MTok -> 2_500_000 micro


class TestMultipleErasPerPattern:
    def test_two_eras_for_same_pattern_coexist(self, session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """Regression (audit P2 #7): two time-windowed eras sharing a
        match_pattern must both load (not collapse to one)."""
        path = _write_defaults(
            tmp_path,
            [
                {
                    "match_pattern": "(?i)^model-x$",
                    "provider": "openai",
                    "start_date": "2026-01-01T00:00:00Z",
                    "end_date": "2026-06-01T00:00:00Z",
                    "updated_at": "2026-01-01T00:00:00Z",
                    "pricing_tiers": [
                        {"name": "default", "is_default": True, "conditions": [], "prices": {"input": 1.0, "output": 2.0}}
                    ],
                },
                {
                    "match_pattern": "(?i)^model-x$",
                    "provider": "openai",
                    "start_date": "2026-06-01T00:00:00Z",
                    "end_date": None,
                    "updated_at": "2026-06-01T00:00:00Z",
                    "pricing_tiers": [
                        {"name": "default", "is_default": True, "conditions": [], "prices": {"input": 3.0, "output": 6.0}}
                    ],
                },
            ],
        )
        monkeypatch.setattr("apo.services.pricing.loader.DEFAULTS_PATH", path)
        load_default_prices(session)
        rows = list(
            session.exec(select(ModelRowDB).where(ModelRowDB.match_pattern == "(?i)^model-x$")).all()
        )
        assert len(rows) == 2  # both eras coexist
        starts = sorted(r.start_date.isoformat() for r in rows if r.start_date)
        assert starts == ["2026-01-01T00:00:00", "2026-06-01T00:00:00"]
