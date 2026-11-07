# pyright: reportAny=false, reportAttributeAccessIssue=false, reportCallIssue=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUntypedFunctionDecorator=false, reportUnusedCallResult=false

"""Export byte budgets: loader validation and the budgeted renderers."""

from __future__ import annotations

import asyncio
import json

import pytest

from apo.services.export_budget import (
    ExportBudgetExceeded,
    ExportByteLimitError,
    ExportByteLimits,
    load_export_byte_limits,
    render_json_array,
    render_json_object,
    render_json_object_async,
)


class TestLoadExportByteLimits:
    def test_defaults_when_unset(self, monkeypatch: pytest.MonkeyPatch):
        for name in ("APO_RUN_EXPORT_MAX_BYTES", "APO_BULK_EXPORT_MAX_BYTES"):
            monkeypatch.delenv(name, raising=False)
        limits = load_export_byte_limits()
        assert limits.run_export_max_bytes == 268_435_456
        assert limits.bulk_export_max_bytes == 134_217_728

    def test_env_overrides(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("APO_RUN_EXPORT_MAX_BYTES", "1024")
        monkeypatch.setenv("APO_BULK_EXPORT_MAX_BYTES", "2048")
        assert load_export_byte_limits() == ExportByteLimits(1024, 2048)

    @pytest.mark.parametrize("raw", ["", "0", "-5", "abc", "1.5"])
    def test_invalid_values_fail_naming_the_variable(
        self, monkeypatch: pytest.MonkeyPatch, raw: str
    ):
        monkeypatch.setenv("APO_BULK_EXPORT_MAX_BYTES", raw)
        with pytest.raises(ExportByteLimitError, match="APO_BULK_EXPORT_MAX_BYTES"):
            load_export_byte_limits()


class TestRenderers:
    def test_object_render_parses_to_expected_document(self):
        body = render_json_object(
            [("b", 2), ("a", {"x": "unlocked"})], limit=10_000, guidance="g"
        )
        assert json.loads(body) == {"b": 2, "a": {"x": "unlocked"}}

    def test_object_render_fails_partway_past_budget(self):
        sections = iter([("small", 1), ("big", "x" * 100)])
        with pytest.raises(ExportBudgetExceeded) as exc:
            render_json_object(sections, limit=20, guidance="trim it")
        assert exc.value.limit == 20
        assert "trim it" in str(exc.value)

    def test_object_async_render(self):
        async def sections():
            yield "k", [1, 2]

        body = asyncio.run(
            render_json_object_async(sections(), limit=1_000, guidance="g")
        )
        assert json.loads(body) == {"k": [1, 2]}

    def test_array_render_matches_bulk_format(self):
        body = render_json_array([{"id": 1}, {"id": 2}], limit=1_000, guidance="g")
        assert body == '[{"id": 1},\n{"id": 2}]'

    def test_array_render_fails_past_budget(self):
        with pytest.raises(ExportBudgetExceeded) as exc:
            render_json_array([{"v": "x" * 100}], limit=10, guidance="g")
        assert exc.value.limit == 10
