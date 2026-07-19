# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""Fixture corpus loader and contract validation for OTLP tracing (SPEC-129).

Each fixture under ``tests/fixtures/otel/`` is a JSON file with:
  - ``description``: human-readable explanation
  - ``source``: the instrumentation framework (generic, openai, vercel, ...)
  - ``input``: the raw OTLP/JSON ``resourceSpans`` payload
  - ``expected``: the expected normalized Trace Projection after canonicalization

This test module validates that:
  1. Every fixture file is valid JSON with the required fields.
  2. The input payload is a valid OTLP/JSON structure.
  3. The expected projection is internally consistent (trace IDs match, span
     IDs are unique, parent references resolve).

These fixtures are the contract that gates Tracks 1-6 of SPEC-129. Every
normalizer, projector, and receiver must produce results matching these
expected projections.
"""

import json
from pathlib import Path

import pytest

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "otel"

# ── fixture discovery ────────────────────────────────────────────────────


def _load_fixture(name: str) -> dict[str, object]:
    """Load a fixture by filename (without extension)."""
    path = FIXTURE_DIR / f"{name}.json"
    return json.loads(path.read_text())


def _all_fixtures() -> list[tuple[str, dict[str, object]]]:
    """Load all .json fixtures in the directory."""
    fixtures = []
    for path in sorted(FIXTURE_DIR.glob("*.json")):
        fixtures.append((path.stem, json.loads(path.read_text())))
    return fixtures


# ── contract validation tests ────────────────────────────────────────────


class TestFixtureStructure:
    """Every fixture must have the required top-level fields."""

    @pytest.fixture
    def all_fixtures(self) -> list[tuple[str, dict[str, object]]]:
        return _all_fixtures()

    def test_at_least_one_fixture_exists(self, all_fixtures):
        assert len(all_fixtures) >= 5, "Expected at least 5 OTLP fixtures"

    @pytest.mark.parametrize(
        "name,fixture",
        [(f[0], f[1]) for f in _all_fixtures()],
        ids=[f[0] for f in _all_fixtures()],
    )
    def test_fixture_has_required_fields(self, name: str, fixture: dict[str, object]):
        for field in ("description", "source", "input", "expected"):
            assert field in fixture, f"{name}: missing required field '{field}'"

    @pytest.mark.parametrize(
        "name,fixture",
        [(f[0], f[1]) for f in _all_fixtures()],
        ids=[f[0] for f in _all_fixtures()],
    )
    def test_input_has_resource_spans(self, name: str, fixture: dict[str, object]):
        input_data = fixture["input"]
        assert isinstance(input_data, dict)
        resource_spans = input_data.get("resourceSpans")
        assert isinstance(resource_spans, list)
        assert len(resource_spans) > 0

    @pytest.mark.parametrize(
        "name,fixture",
        [(f[0], f[1]) for f in _all_fixtures()],
        ids=[f[0] for f in _all_fixtures()],
    )
    def test_expected_has_trace_id_and_spans(self, name: str, fixture: dict[str, object]):
        expected = fixture["expected"]
        assert isinstance(expected, dict)
        assert "trace_id" in expected
        assert isinstance(expected.get("spans"), list)
        assert len(expected["spans"]) > 0


class TestFixtureConsistency:
    """The input and expected projections must be internally consistent."""

    @pytest.mark.parametrize(
        "name,fixture",
        [(f[0], f[1]) for f in _all_fixtures()],
        ids=[f[0] for f in _all_fixtures()],
    )
    def test_trace_ids_match(self, name: str, fixture: dict[str, object]):
        """All spans in the input must share the same trace_id as the expected."""
        expected_trace_id = fixture["expected"]["trace_id"]

        input_data = fixture["input"]
        for rs in input_data["resourceSpans"]:
            for ss in rs.get("scopeSpans", []):
                for span in ss.get("spans", []):
                    assert span["traceId"] == expected_trace_id, (
                        f"{name}: input traceId {span['traceId']} != expected {expected_trace_id}"
                    )

    @pytest.mark.parametrize(
        "name,fixture",
        [(f[0], f[1]) for f in _all_fixtures()],
        ids=[f[0] for f in _all_fixtures()],
    )
    def test_span_ids_unique(self, name: str, fixture: dict[str, object]):
        """Span IDs within a trace must be unique."""
        span_ids = [s["span_id"] for s in fixture["expected"]["spans"]]
        assert len(span_ids) == len(set(span_ids)), f"{name}: duplicate span_ids in expected"

    @pytest.mark.parametrize(
        "name,fixture",
        [(f[0], f[1]) for f in _all_fixtures()],
        ids=[f[0] for f in _all_fixtures()],
    )
    def test_parent_references_resolve(self, name: str, fixture: dict[str, object]):
        """Every parent_span_id in the expected projection must reference another span."""
        span_ids = {s["span_id"] for s in fixture["expected"]["spans"]}
        for span in fixture["expected"]["spans"]:
            parent = span.get("parent_span_id")
            if parent is not None:
                assert parent in span_ids, (
                    f"{name}: span {span['span_id']} has parent {parent} "
                    f"which is not in the trace"
                )

    @pytest.mark.parametrize(
        "name,fixture",
        [(f[0], f[1]) for f in _all_fixtures()],
        ids=[f[0] for f in _all_fixtures()],
    )
    def test_exactly_one_root(self, name: str, fixture: dict[str, object]):
        """Each trace should have exactly one root span (no parent)."""
        roots = [s for s in fixture["expected"]["spans"] if s.get("is_root")]
        assert len(roots) == 1, f"{name}: expected 1 root span, found {len(roots)}"


class TestSpecificFixtures:
    """Verify specific fixtures cover the required scenarios from SPEC-129."""

    def test_generic_fixture_exists(self):
        f = _load_fixture("generic-root-child")
        assert f["source"] == "generic"

    def test_openai_fixture_exists(self):
        f = _load_fixture("openai-instrumentation")
        assert f["source"] == "openai-instrumentation-v2"
        # Verify content capture attributes are present in the input
        spans = f["input"]["resourceSpans"][0]["scopeSpans"][0]["spans"]
        attrs = {a["key"] for a in spans[0]["attributes"]}
        assert "gen_ai.input.messages" in attrs
        assert "gen_ai.output.messages" in attrs

    def test_vercel_fixture_exists(self):
        f = _load_fixture("vercel-ai-sdk")
        assert f["source"] == "vercel-ai-sdk"

    def test_child_before_root_fixture_exists(self):
        f = _load_fixture("edge-child-before-root")
        assert f.get("edge_case") == "child-before-root"
        # The child must come first in the input
        all_spans = []
        for rs in f["input"]["resourceSpans"]:
            for ss in rs.get("scopeSpans", []):
                all_spans.extend(ss["spans"])
        assert all_spans[0].get("parentSpanId") is not None

    def test_error_status_fixture_exists(self):
        f = _load_fixture("edge-error-status")
        assert f.get("edge_case") == "error-status"
        spans = f["input"]["resourceSpans"][0]["scopeSpans"][0]["spans"]
        assert spans[0]["status"]["code"] == 2  # ERROR

    def test_duplicate_idempotent_fixture_exists(self):
        f = _load_fixture("edge-duplicate-idempotent")
        assert f.get("edge_case") == "duplicate-idempotent"
        assert f["expected"].get("idempotent") is True
