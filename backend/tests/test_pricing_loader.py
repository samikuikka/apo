# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownLambdaType=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false

"""JSON-defaults loader."""

from __future__ import annotations

import json
from collections.abc import Generator
from datetime import datetime, timezone
from pathlib import Path
from typing import ClassVar

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from apo.models.pricing import ModelRowDB, PriceDB, PricingTierDB
from apo.models.usage_keys import UsageKey
from apo.services.pricing.compute import compute_cost
from apo.services.pricing.loader import DEFAULTS_PATH, load_default_prices

NOW = datetime(2026, 7, 22, tzinfo=timezone.utc)


@pytest.fixture
def session() -> Generator[Session, None, None]:
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
    def test_bundled_file_loads_clean(self, session: Session) -> None:
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


class TestBundledCurrentModels:
    """Issue #76: bundled defaults must price current-generation models that
    were arriving with ``cost_provenance='unpriced'``. Each must resolve to a
    non-zero cost on typical per-dimension usage."""

    def test_prices_current_anthropic_models(self, session: Session) -> None:
        load_default_prices(session)
        usage = {"input": 1_000_000, "cache_read": 1_000_000, "output": 1_000_000}
        for name in ("claude-opus-5", "claude-opus-4-6"):
            cost = compute_cost(session, name, usage, "__global__", NOW)
            assert cost is not None, f"{name} should be priced, not unpriced"
            assert cost.total > 0, f"{name} should produce a non-zero cost"

    def test_opus_46_and_5_use_reduced_rates_not_45_rates(self, session: Session) -> None:
        """Issue #102: Opus 4.6+ cut per-dimension pricing 3x vs Opus 4.5
        ($5/$25 per MTok, not $15/$75). The bundled entries had inherited the
        4.5 rates, inflating every Opus 4.6/5 run's cost by exactly 3x."""
        load_default_prices(session)
        usage = {"input": 1_000_000, "output": 1_000_000}
        for name in ("claude-opus-5", "claude-opus-5-2025", "claude-opus-4-6", "claude-opus-4-6-20260701"):
            cost = compute_cost(session, name, usage, "__global__", NOW)
            assert cost is not None, f"{name} should be priced"
            # Correct Opus 4.6/5 rates: input $5 + output $25 per MTok →
            # 5_000_000 + 25_000_000 = 30_000_000 micro-USD for 1M+1M tokens.
            # The bug priced them at 90_000_000 (3x too high).
            assert cost.total == 30_000_000, (
                f"{name} should total 30M micro-USD at the reduced Opus 4.6/5 "
                f"rates, got {cost.total} (3x inflation if 90M)"
            )
            assert cost.breakdown["input"] == 5_000_000
            assert cost.breakdown["output"] == 25_000_000

    def test_opus_45_rates_are_unchanged(self, session: Session) -> None:
        """Issue #102: only the 4.6/5 entries were wrong; Opus 4.5 really was
        $15/$75 and must stay that way."""
        load_default_prices(session)
        cost = compute_cost(
            session,
            "claude-opus-4-5",
            {"input": 1_000_000, "output": 1_000_000},
            "__global__",
            NOW,
        )
        assert cost is not None
        assert cost.breakdown["input"] == 15_000_000
        assert cost.breakdown["output"] == 75_000_000

    def test_prices_current_gemini_models_bare_and_prefixed(self, session: Session) -> None:
        load_default_prices(session)
        usage = {"input": 1_000_000, "output": 1_000_000}
        # The bare names AND the OpenRouter-prefixed (google/...) forms must
        # both resolve (issue #57 follow-up: prefix is stripped at compute time).
        for name in (
            "gemini-3.1-flash-lite-preview",
            "google/gemini-3.1-flash-lite-preview",
            "gemini-3.6-flash",
            "google/gemini-3.6-flash",
        ):
            cost = compute_cost(session, name, usage, "__global__", NOW)
            assert cost is not None, f"{name} should be priced, not unpriced"
            assert cost.total > 0, f"{name} should produce a non-zero cost"

    def test_prices_evaluation_models_issue_94(self, session: Session) -> None:
        """Issue #94: deepseek-v4-flash-0731, glm-5.2, kimi-k3 were arriving
        ``cost_provenance='unpriced'``, silently zeroing their run totals."""
        load_default_prices(session)
        usage = {"input": 1_000_000, "output": 1_000_000}
        for name in ("deepseek-v4-flash-0731", "glm-5.2", "kimi-k3"):
            cost = compute_cost(session, name, usage, "__global__", NOW)
            assert cost is not None, f"{name} should be priced, not unpriced"
            assert cost.total > 0, f"{name} should produce a non-zero cost"

    def test_deepseek_flash_anchored_to_exact_revision(self, session: Session) -> None:
        """Issue #94: ``deepseek-v4-flash-0731`` is a dated revision. Its rates
        must NOT silently inherit to a later revision (e.g. ``-0901``)."""
        load_default_prices(session)
        usage = {"input": 1_000_000, "output": 1_000_000}
        assert compute_cost(session, "deepseek-v4-flash-0731", usage, "__global__", NOW) is not None
        assert compute_cost(session, "deepseek-v4-flash-0901", usage, "__global__", NOW) is None


class TestCurrentClaudeGeneration:
    """The Claude models callers actually send had no matching entry, so every
    call on them resolved ``unpriced`` and contributed $0. The two Claude tiers
    a fan-out spends most of its tokens on (Haiku 4.5, Sonnet 4.6) were the
    worst case: a run's cheap workers were free while its expensive main agent
    was billed, which biases any cost comparison between the two shapes."""

    EXPECTED_RATES: ClassVar[dict[str, tuple[float, float]]] = {
        # name sent on the wire -> (input, output) USD per MTok
        "claude-haiku-4-5-20251001": (1.0, 5.0),
        "claude-haiku-4-5": (1.0, 5.0),
        "claude-sonnet-4-6": (3.0, 15.0),
        "claude-sonnet-5": (2.0, 10.0),
        "claude-opus-4-7": (5.0, 25.0),
    }

    def test_prices_every_current_claude_model(self, session: Session) -> None:
        load_default_prices(session)
        for name, (inp, out) in self.EXPECTED_RATES.items():
            cost = compute_cost(
                session, name, {"input": 1_000_000, "output": 1_000_000}, "__global__", NOW
            )
            assert cost is not None, f"{name} should be priced, not unpriced"
            assert cost.breakdown["input"] == int(inp * 1_000_000), name
            assert cost.breakdown["output"] == int(out * 1_000_000), name

    def test_dated_ids_match_their_alias_entry(self, session: Session) -> None:
        """The canonical ids for these models carry a date suffix, but their
        patterns were anchored (``^claude-opus-4-5$``) and matched only the bare
        alias — so the dated form every caller sends went unpriced."""
        load_default_prices(session)
        usage = {"input": 1_000_000, "output": 1_000_000}
        for name in ("claude-opus-4-5-20251101", "claude-sonnet-4-5-20250929"):
            assert compute_cost(session, name, usage, "__global__", NOW) is not None, name

    def test_claude_cache_dimensions_are_priced(self, session: Session) -> None:
        """A long agent run's tokens are mostly cache reads and writes, so an
        entry that prices only input/output under-reports it by an order of
        magnitude. Anthropic's cache rates are fixed multiples of input:
        0.1x read, 1.25x 5-minute write, 2x 1-hour write."""
        load_default_prices(session)
        for name, (inp, _out) in self.EXPECTED_RATES.items():
            cost = compute_cost(
                session,
                name,
                {"cache_read": 1_000_000, "cache_write_5m": 1_000_000, "cache_write_1h": 1_000_000},
                "__global__",
                NOW,
            )
            assert cost is not None, name
            assert cost.breakdown["cache_read"] == int(inp * 0.1 * 1_000_000), name
            assert cost.breakdown["cache_write_5m"] == int(inp * 1.25 * 1_000_000), name
            assert cost.breakdown["cache_write_1h"] == int(inp * 2 * 1_000_000), name

    def test_sonnet_5_uses_standard_rates_after_introductory_period(self, session: Session) -> None:
        load_default_prices(session)
        cost = compute_cost(
            session,
            "claude-sonnet-5",
            {"input": 1_000_000, "output": 1_000_000},
            "__global__",
            datetime(2026, 9, 1, tzinfo=timezone.utc),
        )
        assert cost is not None
        assert cost.breakdown["input"] == 3_000_000
        assert cost.breakdown["output"] == 15_000_000

    def test_haiku_45_does_not_inherit_35_haiku_rates(self, session: Session) -> None:
        """``claude-3-5-haiku`` is a different, cheaper model ($0.80/$4). The
        two entries must not shadow each other in either direction."""
        load_default_prices(session)
        usage = {"input": 1_000_000, "output": 1_000_000}
        old = compute_cost(session, "claude-3-5-haiku-20241022", usage, "__global__", NOW)
        new = compute_cost(session, "claude-haiku-4-5-20251001", usage, "__global__", NOW)
        assert old is not None and new is not None
        assert old.breakdown["input"] == 800_000
        assert new.breakdown["input"] == 1_000_000


class TestCacheWriteIsPricedForEveryProvider:
    """Callers report usage in Anthropic buckets regardless of provider (the
    Anthropic wire format is what an OpenAI- or Gemini-backed proxy normalizes
    to), so ``input_cache_creation`` lands on ``cache_write_5m`` for every
    model. Non-Anthropic entries priced only input/cache_read/output, so those
    tokens were billed at zero — and because the model itself matched, nothing
    was marked ``unpriced`` and the run looked confidently priced while being
    an order of magnitude under."""

    def test_cache_write_priced_wherever_cache_read_is(self, session: Session) -> None:
        load_default_prices(session)
        raw = json.loads(DEFAULTS_PATH.read_text())
        missing: list[str] = []
        for model in raw["models"]:
            for tier in model["pricing_tiers"]:
                prices = tier["prices"]
                if "cache_read" in prices and "cache_write_5m" not in prices:
                    missing.append(f"{model['match_pattern']} ({tier['name']})")
        message = "these entries price cache reads but not cache writes, so "
        message += "cache-creation tokens silently cost $0: " + ", ".join(missing)
        assert not missing, message

    def test_cache_write_uses_provider_rate(self, session: Session) -> None:
        """Most providers bill cache creation as ordinary input, while GPT-5.6
        applies its documented 1.25x write premium."""
        load_default_prices(session)
        for name in ("gemini-3.6-flash", "glm-5.2"):
            write_only = compute_cost(
                session, name, {"cache_write_5m": 1_000_000}, "__global__", NOW
            )
            input_only = compute_cost(session, name, {"input": 1_000_000}, "__global__", NOW)
            assert write_only is not None and input_only is not None, name
            assert write_only.total > 0, f"{name} cache writes must not be free"
            assert write_only.total == input_only.total, name

        for name in ("gpt-5.6-luna", "gpt-5.6-terra"):
            write_only = compute_cost(
                session, name, {"cache_write_5m": 1_000_000}, "__global__", NOW
            )
            input_only = compute_cost(session, name, {"input": 1_000_000}, "__global__", NOW)
            assert write_only is not None and input_only is not None, name
            assert write_only.total == int(input_only.total * 1.25), name

    def test_cache_heavy_worker_costs_more_than_output_alone(self, session: Session) -> None:
        """The shape this bug hid: a fan-out worker whose usage is almost
        entirely cache writes. Before the fix its cost was the output line
        only."""
        load_default_prices(session)
        cost = compute_cost(
            session,
            "gpt-5.6-luna",
            {"input": 3, "output": 149, "cache_write_5m": 12_495},
            "__global__",
            NOW,
        )
        assert cost is not None
        assert cost.breakdown.get("cache_write_5m", 0) > 0, (
            "cache-write tokens dominate this call; pricing them at zero is the bug"
        )
        assert cost.total > cost.breakdown["output"]


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
