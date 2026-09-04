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
POST_GPT56_PROMO = datetime(2026, 8, 24, tzinfo=timezone.utc)


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

    def test_no_premium_providers_price_writes_as_input(self, session: Session) -> None:
        load_default_prices(session)
        # glm-5.2 exemplifies the no-write-premium convention: writes bill as input.
        write_only = compute_cost(
            session, "glm-5.2", {"cache_write_5m": 1_000_000}, "__global__", NOW
        )
        input_only = compute_cost(session, "glm-5.2", {"input": 1_000_000}, "__global__", NOW)
        assert write_only is not None and input_only is not None
        assert write_only.total > 0, "glm-5.2 cache writes must not be free"
        assert write_only.total == input_only.total

        # gemini-3.6-flash instead carries OpenRouter's explicit write rate
        # (issue #146 follow-up correction): $0.0416667/MTok — cheaper than
        # input, not equal to it. Assert both sides so a stale row on either
        # dimension cannot pass accidentally.
        gemini_write = compute_cost(
            session, "gemini-3.6-flash", {"cache_write_5m": 1_000_000}, "__global__", NOW
        )
        assert gemini_write is not None
        assert gemini_write.total == 41_667  # round(0.0416667 * 1e6) micro-USD

    def test_gemini_36_flash_and_31_lite_use_published_rates(self, session: Session) -> None:
        """Issue #76 priced both by assumption ('mirrors the 2.5 rates'); the
        2026-08-14 audit found the 3.x family far above that. Pin the published
        rates so a regression to the assumed rates fails loudly."""
        load_default_prices(session)
        expected = {
            "gemini-3.6-flash": {"input": 750_000, "output": 3_750_000},
            "gemini-3.1-flash-lite": {"input": 250_000, "output": 1_500_000},
        }
        for name, dims in expected.items():
            for usage_key, expected_cost in dims.items():
                cost = compute_cost(
                    session, name, {usage_key: 1_000_000}, "__global__", NOW
                )
                assert cost is not None, name
                assert cost.total == expected_cost, f"{name} {usage_key}"

    def test_gemini_3x_flash_family_shares_one_flat_rate(self, session: Session) -> None:
        """Google prices the whole 3.x Flash family at ONE standard rate, with no
        long-context tier (tiering is a Pro feature). 3.7 drifted to the flex tier
        and metered 2x low until 2026-09-04; pinning the family together is what
        makes that kind of per-version drift fail loudly instead of silently
        halving or doubling a run's cost."""
        load_default_prices(session)
        family = ("gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash")
        expected = {
            "input": 750_000,
            "output": 3_750_000,
            "cache_read": 75_000,
            "cache_write_5m": 41_667,
        }
        for name in family:
            for usage_key, expected_cost in expected.items():
                cost = compute_cost(
                    session, name, {usage_key: 1_000_000}, "__global__", NOW
                )
                assert cost is not None, f"{name} should be priced, not unpriced"
                assert cost.total == expected_cost, f"{name} {usage_key}"

        # No long-context tier: a 1M-token prompt costs exactly 1M x the flat input
        # rate, with no doubling at any threshold.
        for name in family:
            big = compute_cost(session, name, {"input": 1_000_000}, "__global__", NOW)
            assert big is not None and big.total == 750_000, f"{name} must not tier"

    def test_gemini_38_flash_priced_bare_and_prefixed(self, session: Session) -> None:
        """Gemini 3.8 Flash (released 2026-09-02) must not arrive unpriced, and
        must not be swallowed by the 3.6 or 3.7 patterns. Rates are Google's
        Standard tier, which is 2x what the 3.7 row carries, so an accidental
        inherit from that neighbour fails here rather than silently halving
        every 3.8 run's cost."""
        load_default_prices(session)
        for name in ("gemini-3.8-flash", "google/gemini-3.8-flash"):
            for usage_key, expected_cost in (
                ("input", 750_000),
                ("output", 3_750_000),
                ("cache_read", 75_000),
                ("cache_write_5m", 41_667),
            ):
                cost = compute_cost(
                    session, name, {usage_key: 1_000_000}, "__global__", NOW
                )
                assert cost is not None, f"{name} should be priced, not unpriced"
                assert cost.total == expected_cost, f"{name} {usage_key}"

    def test_gpt56_uses_openrouter_prompt_and_write_rates(self, session: Session) -> None:
        """OpenRouter lists cache writes at 1.25x ordinary input for GPT-5.6.

        Cold-call costs independently verify the write side, but cannot measure
        ordinary input because nearly the entire prompt is a cache write.
        Assert both published rates so a stale input row cannot make an
        equality-based test pass accidentally.

        Rates re-measured 2026-08-24: the 2026-08-10 figures were an OpenRouter
        50% promotion; current list is 2x (terra $2.00 input / $2.50 write,
        luna $0.20 / $0.25), confirmed by a cold call metering $2.5001/1M writes.
        """
        load_default_prices(session)
        expected_rate_micro_usd = {
            "gpt-5.6-luna": {"input": 200_000, "cache_write_5m": 250_000},
            "gpt-5.6-terra": {"input": 2_000_000, "cache_write_5m": 2_500_000},
        }
        for name, expected in expected_rate_micro_usd.items():
            for usage_key, expected_rate in expected.items():
                cost = compute_cost(
                    session,
                    name,
                    {usage_key: 100_000},
                    "__global__",
                    POST_GPT56_PROMO,
                )
                assert cost is not None, name
                assert cost.total == expected_rate // 10, f"{name} {usage_key}"

    def test_gpt56_uses_published_large_context_rates(self, session: Session) -> None:
        """OpenRouter applies its override starting at 272k prompt tokens."""
        load_default_prices(session)
        expected_breakdowns = {
            "gpt-5.6-luna": {
                "input": 108_800,
                "cache_read": 40_000,
                "cache_write_5m": 500_000,
                "output": 1_800_000,
            },
            "gpt-5.6-terra": {
                "input": 1_088_000,
                "cache_read": 400_000,
                "cache_write_5m": 5_000_000,
                "output": 18_000_000,
            },
        }
        for name, expected_breakdown in expected_breakdowns.items():
            below_threshold = compute_cost(
                session,
                name,
                {"input": 271_999},
                "__global__",
                POST_GPT56_PROMO,
            )
            at_threshold = compute_cost(
                session,
                name,
                {"input": 272_000},
                "__global__",
                POST_GPT56_PROMO,
            )
            priced_dimensions = compute_cost(
                session,
                name,
                {
                    "input": 272_000,
                    "cache_read": 1_000_000,
                    "cache_write_5m": 1_000_000,
                    "output": 1_000_000,
                },
                "__global__",
                POST_GPT56_PROMO,
            )

            assert below_threshold is not None
            assert below_threshold.tier_name == "default"
            assert at_threshold is not None
            assert at_threshold.tier_name == "large-context"
            assert priced_dimensions is not None
            assert priced_dimensions.tier_name == "large-context"
            assert priced_dimensions.breakdown == expected_breakdown

    def test_gpt56_preserves_promotional_pricing_era(self, session: Session) -> None:
        """Repricing keeps calls before the corroborated cutoff at promo rates."""
        load_default_prices(session)
        promo_time = datetime(2026, 8, 17, 23, 59, 59, tzinfo=timezone.utc)
        expected_input_costs = {
            "gpt-5.6-luna": (10_000, 20_000),
            "gpt-5.6-terra": (100_000, 200_000),
        }

        for name, (promo_cost, current_cost) in expected_input_costs.items():
            before_cutoff = compute_cost(
                session, name, {"input": 100_000}, "__global__", promo_time
            )
            at_cutoff = compute_cost(
                session,
                name,
                {"input": 100_000},
                "__global__",
                datetime(2026, 8, 18, tzinfo=timezone.utc),
            )

            assert before_cutoff is not None
            assert before_cutoff.total == promo_cost
            assert at_cutoff is not None
            assert at_cutoff.total == current_cost

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
            POST_GPT56_PROMO,
        )
        assert cost is not None
        assert cost.breakdown.get("cache_write_5m", 0) > 0, (
            "cache-write tokens dominate this call; pricing them at zero is the bug"
        )
        assert cost.total > cost.breakdown["output"]


class TestCurrentGenerationPricing:
    """2026-08-30 refresh: the generation callers actually route to had no
    entries, so GLM 5.3 / 5.3 Flash, the current DeepSeek flash builds, Grok
    4.5, and the Gemini 3.5 flash family all resolved ``unpriced`` and showed
    $0 in every cost column. Rates verified 2026-08-30 against OpenRouter's
    ``/api/v1/models`` listing (per-token x 1e6); pinned here so a regression
    to stale or assumed rates fails loudly."""

    # wire name -> USD per 1M tokens per dimension
    RATES: ClassVar[dict[str, dict[str, float]]] = {
        "glm-5.3": {"input": 1.4, "cache_read": 0.26, "cache_write_5m": 1.4, "output": 4.4},
        "glm-5.3-flash": {
            "input": 0.075,
            "cache_read": 0.015,
            "cache_write_5m": 0.075,
            "output": 0.25,
        },
        "deepseek-v4-flash-latest": {
            "input": 0.03,
            "cache_read": 0.01,
            "cache_write_5m": 0.03,
            "output": 0.16,
        },
        "deepseek-v4-flash-vision-exp": {
            "input": 0.22,
            "cache_read": 0.007,
            "cache_write_5m": 0.22,
            "output": 0.66,
        },
        "grok-4.5": {"input": 2.0, "cache_read": 0.3, "cache_write_5m": 2.0, "output": 6.0},
        "gemini-3.5-flash": {
            "input": 1.5,
            "cache_read": 0.15,
            "cache_write_5m": 0.0833333,
            "output": 9.0,
        },
        "gemini-3.5-flash-lite": {
            "input": 0.3,
            "cache_read": 0.03,
            "cache_write_5m": 0.0833333,
            "output": 2.5,
        },
    }

    # OpenRouter-prefixed id -> bare id it must resolve against (the ~ marks
    # OpenRouter floor pricing; the marker rides the provider slug, which
    # compute_cost strips before matching).
    ROUTER_IDS: ClassVar[dict[str, str]] = {
        "z-ai/glm-5.3": "glm-5.3",
        "z-ai/glm-5.3-flash": "glm-5.3-flash",
        "~deepseek/deepseek-v4-flash-latest": "deepseek-v4-flash-latest",
        "deepseek/deepseek-v4-flash-vision-exp": "deepseek-v4-flash-vision-exp",
        "x-ai/grok-4.5": "grok-4.5",
        "google/gemini-3.5-flash": "gemini-3.5-flash",
        "google/gemini-3.5-flash-lite": "gemini-3.5-flash-lite",
    }

    def test_prices_every_current_generation_model(self, session: Session) -> None:
        load_default_prices(session)
        for name, dims in self.RATES.items():
            for usage_key, usd_per_1m in dims.items():
                cost = compute_cost(
                    session, name, {usage_key: 1_000_000}, "__global__", NOW
                )
                assert cost is not None, f"{name} should be priced, not unpriced"
                assert cost.total == round(usd_per_1m * 1_000_000), (
                    f"{name} {usage_key}: expected ${usd_per_1m}/MTok, "
                    f"got {cost.total} micro-USD"
                )

    def test_router_prefixed_ids_price_identically_to_bare_ids(self, session: Session) -> None:
        load_default_prices(session)
        usage = {"input": 1_000_000, "cache_read": 1_000_000, "output": 1_000_000}
        for routed, bare in self.ROUTER_IDS.items():
            routed_cost = compute_cost(session, routed, usage, "__global__", NOW)
            bare_cost = compute_cost(session, bare, usage, "__global__", NOW)
            assert routed_cost is not None, f"{routed} should resolve via slug stripping"
            assert bare_cost is not None, bare
            assert routed_cost.total == bare_cost.total, (
                f"{routed} must bill identically to {bare}"
            )

    def test_glm_53_flash_does_not_inherit_flagship_rates(self, session: Session) -> None:
        """glm-5.3-flash is ~19x cheaper than glm-5.3; the two anchored entries
        must not shadow each other in either direction."""
        load_default_prices(session)
        usage = {"input": 1_000_000, "output": 1_000_000}
        flagship = compute_cost(session, "glm-5.3", usage, "__global__", NOW)
        flash = compute_cost(session, "glm-5.3-flash", usage, "__global__", NOW)
        assert flagship is not None and flash is not None
        assert flagship.total == 5_800_000  # $1.40 + $4.40
        assert flash.total == 325_000  # $0.075 + $0.25

    def test_gemini_35_flash_entry_does_not_swallow_flash_lite(self, session: Session) -> None:
        """gemini-3.5-flash costs 5x gemini-3.5-flash-lite on input; a greedy
        ``flash.*`` pattern would silently bill every lite call at flash rates."""
        load_default_prices(session)
        usage = {"input": 1_000_000, "output": 1_000_000}
        flash = compute_cost(session, "gemini-3.5-flash", usage, "__global__", NOW)
        lite = compute_cost(session, "gemini-3.5-flash-lite", usage, "__global__", NOW)
        assert flash is not None and lite is not None
        assert flash.total == 10_500_000  # $1.50 + $9.00
        assert lite.total == 2_800_000  # $0.30 + $2.50


class TestDatedEntryRateRefresh:
    """2026-08-30 re-verification: OpenRouter's live listing moved off the
    rates pinned at entry time for the dated DeepSeek builds and discounted
    glm-5.2 after the 5.3 launch (exactly 0.85x the 5.3 rates). Stale rows
    would mis-bill every routed call on those models."""

    REFRESHED: ClassVar[dict[str, dict[str, float]]] = {
        "deepseek-v4-flash-0731": {"input": 0.065, "cache_read": 0.016, "output": 0.18},
        "deepseek-v4-pro-0813": {"input": 0.66, "cache_read": 0.022, "output": 1.98},
        "glm-5.2": {"input": 1.19, "cache_read": 0.221, "output": 3.74},
    }

    def test_refreshed_rates_match_live_listing(self, session: Session) -> None:
        load_default_prices(session)
        for name, dims in self.REFRESHED.items():
            for usage_key, usd_per_1m in dims.items():
                cost = compute_cost(
                    session, name, {usage_key: 1_000_000}, "__global__", NOW
                )
                assert cost is not None, name
                assert cost.total == round(usd_per_1m * 1_000_000), (
                    f"{name} {usage_key}: expected ${usd_per_1m}/MTok "
                    f"(2026-08-30 listing), got {cost.total} micro-USD"
                )

    def test_glm_52_discount_does_not_leak_into_glm_53(self, session: Session) -> None:
        """glm-5.2 was discounted to 0.85x when 5.3 launched; 5.3 must keep
        the full $1.40/$4.40 list rates, not inherit its sibling's discount."""
        load_default_prices(session)
        usage = {"input": 1_000_000, "output": 1_000_000}
        cost = compute_cost(session, "glm-5.3", usage, "__global__", NOW)
        assert cost is not None
        assert cost.breakdown["input"] == 1_400_000
        assert cost.breakdown["output"] == 4_400_000


class TestMultipleErasPerPattern:
    def test_two_eras_for_same_pattern_coexist(self, session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """Regression: two time-windowed eras sharing a
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
