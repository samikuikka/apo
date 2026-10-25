# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

"""Check Report normalization tests.

Verifies the per-field hygiene boundary at both legacy top-level and current
nested SDK shapes: oversized ``received`` and judge segments become markers
with preview/size/hash, reasoning is preserved, and the function is immutable
and idempotent.
"""

import copy
import hashlib
from datetime import datetime, timezone

import pytest
from sqlmodel import Session

from apo.models.db import AgentTaskBatchRunDB, AgentTaskCheckReportDB, AgentTaskRunDB
from apo.services.check_report_storage import (
    JUDGE_SEGMENT_LIMIT,
    RECEIVED_VALUE_LIMIT,
    load_check_report,
    normalize_check_report,
)

_LARGE_RECEIVED = {"data": "x" * (RECEIVED_VALUE_LIMIT + 100)}
_LARGE_TEXT = "y" * (JUDGE_SEGMENT_LIMIT + 500)


# ---------------------------------------------------------------------------
# Nested field normalization (spec test 3)
# ---------------------------------------------------------------------------


def test_nested_assertion_received_is_truncated() -> None:
    checks: list[dict[str, object]] = [
        {
            "name": "check-1",
            "assertions": [
                {"name": "a1", "received": _LARGE_RECEIVED, "reasoning": "keep me"},
            ],
        }
    ]
    result = normalize_check_report(checks)
    marker = result[0]["assertions"][0]["received"]  # pyright: ignore[reportIndexIssue]
    assert isinstance(marker, dict)
    assert marker["kind"] == "truncated"
    assert marker["size_bytes"] > RECEIVED_VALUE_LIMIT
    assert "sha256" in marker
    assert result[0]["assertions"][0]["reasoning"] == "keep me"  # pyright: ignore[reportIndexIssue]


def test_check_level_judge_prompt_and_response_truncated() -> None:
    checks: list[dict[str, object]] = [
        {
            "name": "check-1",
            "judge": {
                "prompt": {"system": _LARGE_TEXT, "user": _LARGE_TEXT},
                "response": _LARGE_TEXT,
            },
        }
    ]
    result = normalize_check_report(checks)
    judge = result[0]["judge"]
    assert isinstance(judge, dict)
    for field in ("system", "user"):
        marker = judge["prompt"][field]
        assert isinstance(marker, dict)
        assert marker["kind"] == "truncated"
    resp_marker = judge["response"]
    assert isinstance(resp_marker, dict)
    assert resp_marker["kind"] == "truncated"


def test_assertion_level_judge_truncated() -> None:
    checks: list[dict[str, object]] = [
        {
            "name": "check-1",
            "assertions": [
                {
                    "name": "a1",
                    "judge": {
                        "prompt": {"system": _LARGE_TEXT, "user": "small"},
                        "response": _LARGE_TEXT,
                    },
                }
            ],
        }
    ]
    result = normalize_check_report(checks)
    assertion = result[0]["assertions"][0]  # pyright: ignore[reportIndexIssue]
    judge = assertion["judge"]
    assert isinstance(judge["prompt"]["system"], dict)
    assert judge["prompt"]["system"]["kind"] == "truncated"
    assert judge["prompt"]["user"] == "small"
    assert isinstance(judge["response"], dict)
    assert judge["response"]["kind"] == "truncated"


def test_legacy_top_level_received_truncated() -> None:
    checks = [{"name": "c1", "received": _LARGE_RECEIVED}]
    result = normalize_check_report(checks)  # pyright: ignore[reportArgumentType]
    assert isinstance(result[0]["received"], dict)
    assert result[0]["received"]["kind"] == "truncated"


def test_legacy_judge_prompt_response_truncated() -> None:
    checks: list[dict[str, object]] = [
        {
            "name": "c1",
            "judge_prompt": _LARGE_TEXT,
            "judge_response": _LARGE_TEXT,
        }
    ]
    result = normalize_check_report(checks)
    assert isinstance(result[0]["judge_prompt"], dict)
    assert result[0]["judge_prompt"]["kind"] == "truncated"
    assert isinstance(result[0]["judge_response"], dict)
    assert result[0]["judge_response"]["kind"] == "truncated"


def test_small_values_preserved_without_type_change() -> None:
    checks: list[dict[str, object]] = [
        {
            "name": "c1",
            "received": {"small": "data"},
            "judge": {
                "prompt": {"system": "ok", "user": "ok"},
                "response": "ok",
            },
        }
    ]
    result = normalize_check_report(checks)
    assert result[0]["received"] == {"small": "data"}
    assert result[0]["judge"]["prompt"]["system"] == "ok"  # pyright: ignore[reportIndexIssue]
    assert result[0]["judge"]["response"] == "ok"  # pyright: ignore[reportIndexIssue]


def test_reasoning_and_instruction_preserved() -> None:
    big_reasoning = "r" * (JUDGE_SEGMENT_LIMIT * 2)
    big_instruction = "i" * (JUDGE_SEGMENT_LIMIT * 2)
    checks: list[dict[str, object]] = [
        {
            "name": "c1",
            "reasoning": big_reasoning,
            "instruction": big_instruction,
            "expected": "e" * (JUDGE_SEGMENT_LIMIT * 2),
        }
    ]
    result = normalize_check_report(checks)
    assert result[0]["reasoning"] == big_reasoning
    assert result[0]["instruction"] == big_instruction
    assert result[0]["expected"] == "e" * (JUDGE_SEGMENT_LIMIT * 2)


# ---------------------------------------------------------------------------
# Immutability and idempotency (spec test 4)
# ---------------------------------------------------------------------------


def test_normalize_does_not_mutate_input() -> None:
    original = [
        {
            "name": "c1",
            "assertions": [{"name": "a1", "received": _LARGE_RECEIVED}],
        }
    ]
    snapshot = copy.deepcopy(original)
    _ = normalize_check_report(original)  # pyright: ignore[reportArgumentType]
    assert original == snapshot


def test_normalize_is_idempotent() -> None:
    checks: list[dict[str, object]] = [
        {
            "name": "c1",
            "received": _LARGE_RECEIVED,
            "judge": {"prompt": {"system": _LARGE_TEXT}, "response": _LARGE_TEXT},
        }
    ]
    once = normalize_check_report(checks)
    twice = normalize_check_report(once)
    assert once == twice


def test_existing_marker_left_unchanged() -> None:
    marker = {
        "kind": "truncated",
        "preview": "abc",
        "size_bytes": 999,
        "sha256": hashlib.sha256(b"abc").hexdigest(),
    }
    checks = [{"name": "c1", "received": marker}]
    result = normalize_check_report(checks)  # pyright: ignore[reportArgumentType]
    assert result[0]["received"] == marker


# ---------------------------------------------------------------------------
# Historical read safety (spec test 5)
# ---------------------------------------------------------------------------


def test_load_check_report_normalizes_historical_oversized_row(
    session: Session,
) -> None:
    """An oversized row inserted directly (bypassing write normalization) is
    bounded on read by ``load_check_report``."""
    run_id = "r-historical-oversized"
    session.add(AgentTaskBatchRunDB(
        id="b-historical",
        project="p",
        selection_type="catalog",
        status="completed",
        total_tasks=1,
        created_at=datetime.now(timezone.utc),
        execution_target_json={},
    ))
    session.add(AgentTaskRunDB(
        id=run_id,
        batch_run_id="b-historical",
        task_id="t1",
        task_path="/t1",
        adapter_name="test",
        status="success",
    ))
    session.flush()
    oversized = [
        {
            "name": "c1",
            "received": _LARGE_RECEIVED,
            "judge": {"prompt": {"system": _LARGE_TEXT}, "response": _LARGE_TEXT},
        }
    ]
    session.add(AgentTaskCheckReportDB(
        run_id=run_id,
        value_json=oversized,  # pyright: ignore[reportArgumentType]
        created_at=datetime.now(timezone.utc),
    ))
    session.commit()

    loaded = load_check_report(session, run_id)
    assert loaded is not None
    assert isinstance(loaded[0]["received"], dict)
    assert loaded[0]["received"]["kind"] == "truncated"

    # The stored row remains unchanged — normalization is transport-only.
    row = session.get(AgentTaskCheckReportDB, run_id)
    assert row is not None
    assert row.value_json[0]["received"] == _LARGE_RECEIVED  # pyright: ignore[reportOptionalSubscript]


def test_unknown_fields_preserved() -> None:
    """Fields the normalizer does not know about pass through untouched."""
    checks: list[dict[str, object]] = [
        {"id": "c1", "pass": True, "custom_field": "value", "nested": {"a": 1}},
    ]
    result = normalize_check_report(checks)
    assert result[0]["custom_field"] == "value"
    assert result[0]["nested"] == {"a": 1}


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main(["-v", __file__]))
