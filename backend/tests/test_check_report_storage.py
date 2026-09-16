# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""Check Report storage boundary.

The full check evidence lives off the hot ``agent_task_runs`` row in
``agent_task_check_reports``; the run row carries only the scalar verdict
(``total_checks`` / ``passed_checks`` / ``failed_checks``). Per-field hygiene
(``received``, judge segments) is retained; the 1 MiB total cap and the
per-string caps on reasoning/instruction/expected are gone — for a judged run
the reasoning *is* the result, and the row is no longer on the hot path.
"""

from __future__ import annotations

import hashlib
import json

import pytest
from datetime import datetime, timezone
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from apo.models.db import AgentTaskCheckReportDB, AgentTaskRunDB
from apo.models.schemas import TruncatedCheckValue
from apo.services.check_report_storage import (
    JUDGE_SEGMENT_LIMIT,
    RECEIVED_VALUE_LIMIT,
    load_check_report,
    load_check_reports,
    normalize_check_report,
    persist_check_report,
)


@pytest.fixture
def session() -> Session:  # pyright: ignore[reportInvalidTypeForm]
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def _make_run(session: Session, run_id: str = "run-1") -> AgentTaskRunDB:
    run = AgentTaskRunDB(
        id=run_id,
        batch_run_id="batch-1",
        task_id="t1",
        task_path="/t",
        status="running",
    )
    session.add(run)
    session.commit()
    return run


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class TestPersistCheckReport:
    def test_writes_scalar_verdict_and_report_row(self, session: Session):
        run = _make_run(session)
        checks = [
            {"id": "a", "pass": True},
            {"id": "b", "pass": False},
            {"id": "c", "pass": True},
        ]

        persist_check_report(session, run, checks)
        session.commit()
        session.refresh(run)

        assert run.total_checks == 3
        assert run.passed_checks == 2
        assert run.failed_checks == 1

        report = session.get(AgentTaskCheckReportDB, run.id)
        assert report is not None
        assert report.value_json == checks

    def test_load_returns_report_body(self, session: Session):
        run = _make_run(session)
        checks = [{"id": "a", "pass": True, "reasoning": "because"}]

        persist_check_report(session, run, checks)
        session.commit()

        assert load_check_report(session, run.id) == checks

    def test_load_returns_none_for_missing_run(self, session: Session):
        assert load_check_report(session, "nope") is None

    def test_reasoning_is_not_capped(self, session: Session):
        run = _make_run(session)
        big = "r" * (1024 * 200)  # 200 KiB — well past the retired 32 KiB cap

        persist_check_report(session, run, [{"id": "a", "pass": True, "reasoning": big}])
        session.commit()

        body = load_check_report(session, run.id)
        assert body is not None
        assert body[0]["reasoning"] == big  # full reasoning retained

    def test_no_total_cap_many_checks_persist_whole(self, session: Session):
        run = _make_run(session)
        # 80 checks x ~64 KiB reasoning ~= 5 MiB — blows the retired 1 MiB cap.
        checks = [
            {"id": f"c-{i}", "pass": i % 2 == 0, "reasoning": "x" * (64 * 1024)}
            for i in range(80)
        ]

        persist_check_report(session, run, checks)
        session.commit()
        session.refresh(run)

        assert run.total_checks == 80
        assert run.passed_checks == 40
        body = load_check_report(session, run.id)
        assert body is not None
        assert len(body) == 80
        assert all(entry["reasoning"] == "x" * (64 * 1024) for entry in body)

    def test_pathological_received_becomes_marker(self, session: Session):
        run = _make_run(session)
        big = "y" * (RECEIVED_VALUE_LIMIT + 1000)
        encoded = json.dumps(big).encode("utf-8")

        persist_check_report(session, run, [{"id": "a", "pass": True, "received": big}])
        session.commit()

        body = load_check_report(session, run.id)
        assert body is not None
        received = body[0]["received"]
        assert isinstance(received, dict)
        assert received["kind"] == "truncated"
        assert received["size_bytes"] == len(encoded)
        assert received["sha256"] == _sha(encoded)

    def test_judge_segments_are_truncated(self, session: Session):
        run = _make_run(session)
        prompt = "p" * (JUDGE_SEGMENT_LIMIT + 500)
        response = "r" * (JUDGE_SEGMENT_LIMIT + 500)

        persist_check_report(
            session,
            run,
            [{"id": "a", "pass": True, "judge_prompt": prompt, "judge_response": response}],
        )
        session.commit()

        body = load_check_report(session, run.id)
        assert body is not None
        serialized = json.dumps(body)
        assert "p" * 1024 not in serialized
        assert "r" * 1024 not in serialized

    def test_group_identity_survives(self, session: Session):
        run = _make_run(session)
        checks = [
            {"id": "R-1", "pass": True, "group_id": "rules", "group_name": "Rules"},
            {"id": "R-2", "pass": False, "group_id": "rules", "group_name": "Rules"},
        ]

        persist_check_report(session, run, checks)
        session.commit()

        body = load_check_report(session, run.id)
        assert body is not None
        for entry in body:
            assert entry["group_id"] == "rules"
            assert entry["group_name"] == "Rules"

    def test_empty_and_none_checks_are_safe(self, session: Session):
        run = _make_run(session)
        persist_check_report(session, run, [])
        session.commit()
        session.refresh(run)
        assert run.total_checks == 0
        assert run.passed_checks == 0

        run2 = _make_run(session, "run-2")
        persist_check_report(session, run2, None)
        session.commit()
        session.refresh(run2)
        assert run2.total_checks == 0

    def test_non_dict_entries_are_dropped(self, session: Session):
        run = _make_run(session)
        persist_check_report(
            session,
            run,
            [{"id": "good", "pass": True}, "not a dict", None],  # type: ignore[list-item]
        )
        session.commit()
        session.refresh(run)

        assert run.total_checks == 1
        body = load_check_report(session, run.id)
        assert body == [{"id": "good", "pass": True}]

    def test_truncated_marker_matches_schema(self, session: Session):
        run = _make_run(session)
        big = "z" * (RECEIVED_VALUE_LIMIT + 10)

        persist_check_report(session, run, [{"id": "a", "pass": True, "received": big}])
        session.commit()

        body = load_check_report(session, run.id)
        assert body is not None
        parsed = TruncatedCheckValue.model_validate(body[0]["received"])
        assert parsed.kind == "truncated"

    def test_re_persist_upserts_the_report_row(self, session: Session):
        run = _make_run(session)
        persist_check_report(session, run, [{"id": "a", "pass": True}])
        session.commit()

        # Re-finalize (idempotent external re-report after a transient failure).
        persist_check_report(
            session, run, [{"id": "a", "pass": False}, {"id": "b", "pass": True}]
        )
        session.commit()
        session.refresh(run)

        assert run.total_checks == 2
        assert run.passed_checks == 1
        body = load_check_report(session, run.id)
        assert body == [{"id": "a", "pass": False}, {"id": "b", "pass": True}]


# ---------------------------------------------------------------------------
# Nested Check Report normalization
# ---------------------------------------------------------------------------


def _big(text_limit: int, extra: int = 500) -> str:
    return "x" * (text_limit + extra)


class TestNestedReportNormalization:
    """The SDK's actual report shape nests received and judge values below
    assertions and a check-level judge object. The normalizer must reach them."""

    def test_assertion_received_is_truncated(self):
        big = _big(RECEIVED_VALUE_LIMIT)
        encoded = json.dumps(big).encode("utf-8")
        checks = [
            {
                "id": "c1",
                "pass": True,
                "assertions": [
                    {"id": "a1", "pass": True, "received": big},
                ],
            }
        ]
        result = normalize_check_report(checks)
        received = result[0]["assertions"][0]["received"]  # type: ignore[index]  # pyright: ignore[reportIndexIssue]
        assert isinstance(received, dict)
        assert received["kind"] == "truncated"
        assert received["sha256"] == _sha(encoded)

    def test_check_level_judge_nested_paths_are_truncated(self):
        checks = [
            {
                "id": "c1",
                "pass": True,
                "judge": {
                    "prompt": {
                        "system": _big(JUDGE_SEGMENT_LIMIT),
                        "user": _big(JUDGE_SEGMENT_LIMIT),
                    },
                    "response": _big(JUDGE_SEGMENT_LIMIT),
                },
            }
        ]
        result = normalize_check_report(checks)
        judge = result[0]["judge"]  # type: ignore[index]
        assert judge["prompt"]["system"]["kind"] == "truncated"  # type: ignore[index]  # pyright: ignore[reportIndexIssue]
        assert judge["prompt"]["user"]["kind"] == "truncated"  # type: ignore[index]  # pyright: ignore[reportIndexIssue]
        assert judge["response"]["kind"] == "truncated"  # type: ignore[index]  # pyright: ignore[reportIndexIssue]

    def test_assertion_level_judge_nested_paths_are_truncated(self):
        checks = [
            {
                "id": "c1",
                "pass": True,
                "assertions": [
                    {
                        "id": "a1",
                        "pass": True,
                        "judge": {
                            "prompt": {
                                "system": _big(JUDGE_SEGMENT_LIMIT),
                                "user": _big(JUDGE_SEGMENT_LIMIT),
                            },
                            "response": _big(JUDGE_SEGMENT_LIMIT),
                        },
                    }
                ],
            }
        ]
        result = normalize_check_report(checks)
        assertion = result[0]["assertions"][0]  # type: ignore[index]  # pyright: ignore[reportIndexIssue]
        assert assertion["judge"]["prompt"]["system"]["kind"] == "truncated"  # type: ignore[index]
        assert assertion["judge"]["response"]["kind"] == "truncated"  # type: ignore[index]

    def test_reasoning_remains_untruncated(self):
        big = _big(JUDGE_SEGMENT_LIMIT * 4)  # much larger than any limit
        checks = [
            {"id": "c1", "pass": True, "reasoning": big},
            {
                "id": "c2",
                "pass": True,
                "assertions": [
                    {"id": "a1", "pass": True, "reasoning": big},
                ],
            },
        ]
        result = normalize_check_report(checks)
        assert result[0]["reasoning"] == big  # type: ignore[index]
        assert result[1]["assertions"][0]["reasoning"] == big  # type: ignore[index]  # pyright: ignore[reportIndexIssue]

    def test_small_values_preserve_type(self):
        checks = [
            {
                "id": "c1",
                "pass": True,
                "received": {"count": 42},
                "judge": {
                    "prompt": {"system": "short", "user": "also short"},
                    "response": "fine",
                },
                "assertions": [
                    {"id": "a1", "pass": True, "received": [1, 2, 3]},
                ],
            }
        ]
        result = normalize_check_report(checks)
        assert result[0]["received"] == {"count": 42}  # type: ignore[index]
        assert result[0]["judge"]["prompt"]["system"] == "short"  # type: ignore[index]  # pyright: ignore[reportIndexIssue]
        assert result[0]["assertions"][0]["received"] == [1, 2, 3]  # type: ignore[index]  # pyright: ignore[reportIndexIssue]

    def test_unknown_fields_preserved(self):
        checks = [
            {"id": "c1", "pass": True, "custom_field": "value", "nested": {"a": 1}},
        ]
        result = normalize_check_report(checks)
        assert result[0]["custom_field"] == "value"  # type: ignore[index]
        assert result[0]["nested"] == {"a": 1}  # type: ignore[index]

    def test_does_not_mutate_caller_input(self):
        big = _big(RECEIVED_VALUE_LIMIT)
        checks = [
            {
                "id": "c1",
                "pass": True,
                "received": big,
                "assertions": [{"id": "a1", "pass": True, "received": big}],
            }
        ]
        import copy

        original = copy.deepcopy(checks)
        _ = normalize_check_report(checks)
        assert checks == original  # caller's input untouched

    def test_idempotent(self):
        big = _big(JUDGE_SEGMENT_LIMIT)
        checks = [
            {
                "id": "c1",
                "pass": True,
                "judge": {"prompt": {"system": big}, "response": big},
                "assertions": [
                    {"id": "a1", "pass": True, "received": _big(RECEIVED_VALUE_LIMIT)},
                ],
            }
        ]
        first = normalize_check_report(checks)
        second = normalize_check_report(first)
        assert first == second

    def test_existing_marker_left_unchanged(self):
        marker = {
            "kind": "truncated",
            "preview": "...",
            "size_bytes": 99999,
            "sha256": "abc" * 21,
        }
        checks = [{"id": "c1", "pass": True, "received": marker}]
        result = normalize_check_report(checks)
        assert result[0]["received"] == marker  # type: ignore[index]


class TestHistoricalReadNormalization:
    """Oversized historical rows must be safe to transport without a DB rewrite."""

    def test_load_single_normalizes_oversized_nested_fields(self, session: Session):
        run = _make_run(session)
        big = _big(JUDGE_SEGMENT_LIMIT)
        # Insert directly, bypassing the write normalizer (simulates a
        # pre-normalization historical row).
        oversized = [
            {
                "id": "c1",
                "pass": True,
                "judge": {"prompt": {"system": big}, "response": big},
                "assertions": [
                    {"id": "a1", "pass": True, "received": _big(RECEIVED_VALUE_LIMIT)},
                ],
            }
        ]
        session.add(
            AgentTaskCheckReportDB(
                run_id=run.id,
                value_json=oversized,
                created_at=datetime.now(timezone.utc),
            )
        )
        session.commit()

        body = load_check_report(session, run.id)
        assert body is not None
        serialized = json.dumps(body)
        # The oversized values must not appear in the loaded output.
        assert big not in serialized

    def test_load_bulk_normalizes_oversized_nested_fields(self, session: Session):
        run = _make_run(session)
        big = _big(JUDGE_SEGMENT_LIMIT)
        oversized = [
            {
                "id": "c1",
                "pass": True,
                "judge": {"prompt": {"system": big}, "response": big},
            }
        ]
        session.add(
            AgentTaskCheckReportDB(
                run_id=run.id,
                value_json=oversized,
                created_at=datetime.now(timezone.utc),
            )
        )
        session.commit()

        reports = load_check_reports(session, [run])
        body = reports[run.id]
        assert body is not None
        serialized = json.dumps(body)
        assert big not in serialized

    def test_stored_row_remains_unchanged_after_read(self, session: Session):
        run = _make_run(session)
        big = _big(JUDGE_SEGMENT_LIMIT)
        oversized = [
            {"id": "c1", "pass": True, "judge": {"response": big}},
        ]
        session.add(
            AgentTaskCheckReportDB(
                run_id=run.id,
                value_json=oversized,
                created_at=datetime.now(timezone.utc),
            )
        )
        session.commit()

        _ = load_check_report(session, run.id)

        row = session.get(AgentTaskCheckReportDB, run.id)
        assert row is not None
        assert row.value_json[0]["judge"]["response"] == big  # unchanged on disk  # pyright: ignore[reportOptionalSubscript, reportIndexIssue]


def _session_step(index: int, result: str = "x") -> dict[str, object]:
    return {
        "index": index,
        "tool_calls": [{
            "name": "read_deliverable",
            "input": '{"name":"log"}',
            "result": result,
            "result_sha256": "a" * 64,
            "result_bytes": len(result),
        }],
        "text": "step text",
        "tokens": {"input": 10, "output": 5},
    }


def _agent_judge(steps: list[dict[str, object]], outcome: str = "verdict") -> dict[str, object]:
    return {
        "model": "z-ai/glm-5.3-flash",
        "temperature": 0,
        "session": {
            "tools": ["read_deliverable", "finish_verdict"],
            "briefing": {"system": "b" * 100, "rubric": "r" * 100},
            "steps": steps,
            "outcome": outcome,
            "evidence": [
                {"step": 0, "tool": "read_deliverable", "result_sha256": "f" * 64, "result_bytes": 9}
            ],
            "usage": {"steps": len(steps), "input_tokens": 100, "output_tokens": 50},
        },
    }


class TestAgentSessionNormalization:
    def test_tool_result_truncated_identity_kept(self) -> None:
        big = "y" * 10_000
        checks = [{"id": "c", "pass": True, "reasoning": "ok",
                   "evaluator_type": "agent",
                   "judge": _agent_judge([_session_step(0, big)])}]
        cleaned = normalize_check_report(checks)
        call = cleaned[0]["judge"]["session"]["steps"][0]["tool_calls"][0]
        assert isinstance(call["result"], dict) and call["result"]["kind"] == "truncated"
        assert call["result_sha256"] == "a" * 64
        assert call["result_bytes"] == 10_000

    def test_steps_head_and_tail_preserved_beyond_cap(self) -> None:
        steps = [_session_step(i) for i in range(80)]
        cleaned = normalize_check_report(
            [{"id": "c", "pass": True, "reasoning": "ok",
              "evaluator_type": "agent", "judge": _agent_judge(steps)}]
        )
        kept = cleaned[0]["judge"]["session"]["steps"]
        # 56 head + 1 marker + 8 tail = 65 entries
        assert len(kept) == 65
        assert kept[56]["text"] and "truncated" in str(kept[56]["text"])
        assert kept[0]["index"] == 0
        assert kept[-1]["index"] == 79

    def test_identity_fields_never_truncated(self) -> None:
        huge_sha = "e" * 5000
        judge = _agent_judge([_session_step(0)])
        judge["session"]["evidence"] = [
            {"step": i, "tool": "t", "result_sha256": huge_sha, "result_bytes": 9}
            for i in range(20)
        ]
        cleaned = normalize_check_report(
            [{"id": "c", "pass": True, "reasoning": "ok",
              "evaluator_type": "agent", "judge": judge}]
        )
        ev = cleaned[0]["judge"]["session"]["evidence"]
        assert len(ev) == 20
        assert ev[0]["result_sha256"] == huge_sha

    def test_total_session_capped(self) -> None:
        # Just under the 4 KiB field cap so results survive truncation and
        # the 96 KiB session budget forces the shrink path to actually run
        # (5 KiB results would all become markers and never reach it).
        big = "z" * 4_000
        steps = [_session_step(i, big) for i in range(300)]
        cleaned = normalize_check_report(
            [{"id": "c", "pass": True, "reasoning": "ok",
              "evaluator_type": "agent", "judge": _agent_judge(steps)}]
        )
        session_json = __import__("json").dumps(cleaned[0]["judge"]["session"])
        assert len(session_json.encode("utf-8")) <= 96 * 1024


    def test_dict_valued_tool_result_capped(self) -> None:
        big_obj = {"blob": "y" * 300_000}
        step = _session_step(0)
        step["tool_calls"][0]["result"] = big_obj  # type: ignore[index]
        cleaned = normalize_check_report(
            [{"id": "c", "pass": True, "reasoning": "ok",
              "evaluator_type": "agent", "judge": _agent_judge([step])}]
        )
        call = cleaned[0]["judge"]["session"]["steps"][0]["tool_calls"][0]
        assert isinstance(call["result"], dict) and call["result"]["kind"] == "truncated"
