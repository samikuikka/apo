# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""Judge-span deep links on check reports (issue #288).

``annotate_judge_span_ids`` stamps ``judge.span_id`` onto a run's checks so
the UI can link a check straight into the judge's span in the trace view.
New runs carry the exact id from emission; older runs get an unambiguous
step-name join against their own trace.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from apo.models.db import AgentTaskRunDB, LoggedCallDB, ProjectDB
from apo.services.judge_span_links import annotate_judge_span_ids

if TYPE_CHECKING:
    from collections.abc import Iterator


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


def _make_project(session: Session) -> None:
    session.add(ProjectDB(id="p1", name="p1"))


def _make_run(session: Session, run_id: str, trace_run_id: str | None) -> AgentTaskRunDB:
    run = AgentTaskRunDB(
        id=run_id,
        batch_run_id="batch-1",
        task_id="task-1",
        task_path="tasks/demo",
        status="completed",
        started_at=datetime(2026, 9, 28, tzinfo=timezone.utc),
        trace_run_id=trace_run_id,
    )
    session.add(run)
    session.commit()
    return run


def _make_span(
    session: Session, run_id: str, span_id: str, step_name: str
) -> None:
    session.add(
        LoggedCallDB(
            id=span_id,
            run_id=run_id,
            project="p1",
            task_id="task-1",
            model="m",
            created_at=datetime(2026, 9, 28, tzinfo=timezone.utc),
            step_name=step_name,
            observation_type="GENERATION",
        )
    )
    session.commit()


def _checks(*judge_ids: str) -> list[dict[str, object]]:
    return [
        {
            "id": judge_id,
            "pass": False,
            "reasoning": "failed",
            "judge": {"model": "m"},
            "assertions": [
                {"id": judge_id, "pass": False, "judge": {"model": "m"}}
            ],
        }
        for judge_id in judge_ids
    ]


def test_unique_step_name_joins_for_runs_without_emission_id(session: Session) -> None:
    _make_project(session)
    run = _make_run(session, "run-1", "trace-1")
    _make_span(session, "trace-1", "span-agent", "t.agent:figures-supported")
    _make_span(session, "trace-1", "span-judge", "judge:summary-reads-well")
    checks = {
        "run-1": _checks("figures-supported", "summary-reads-well"),
    }

    annotate_judge_span_ids(session, [run], checks)

    agent_judge = checks["run-1"][0]["judge"]
    assert isinstance(agent_judge, dict)
    assert agent_judge["span_id"] == "span-agent"
    judge_judge = checks["run-1"][1]["judge"]
    assert isinstance(judge_judge, dict)
    assert judge_judge["span_id"] == "span-judge"
    # The same stamp lands on the assertion-level metadata the drawer renders.
    assertion = checks["run-1"][0]["assertions"]
    assert isinstance(assertion, list)
    assertion_judge = assertion[0]["judge"] if isinstance(assertion[0], dict) else None
    if isinstance(assertion_judge, dict):
        assert assertion_judge["span_id"] == "span-agent"


def test_ambiguous_name_stays_unlinked(session: Session) -> None:
    # Two unlabeled criteria in one run both emit `judge:judge` — guessing
    # which span belongs to which check would land the link on the wrong
    # judgment, so neither gets a link.
    _make_project(session)
    run = _make_run(session, "run-1", "trace-1")
    _make_span(session, "trace-1", "span-a", "judge:judge")
    _make_span(session, "trace-1", "span-b", "judge:judge")
    checks = {"run-1": _checks("judge")}

    annotate_judge_span_ids(session, [run], checks)

    judge = checks["run-1"][0]["judge"]
    assert isinstance(judge, dict)
    assert "span_id" not in judge


def test_emission_span_id_kept_and_stale_id_dropped(session: Session) -> None:
    _make_project(session)
    run = _make_run(session, "run-1", "trace-1")
    _make_span(session, "trace-1", "span-real", "t.agent:agentic-consistency")
    checks = {
        "run-1": [
            {
                "id": "agentic-consistency",
                "pass": True,
                "reasoning": "",
                "judge": {"model": "m", "span_id": "span-real"},
            },
            {
                "id": "other-check",
                "pass": True,
                "reasoning": "",
                # Emission-time id whose trace no longer has the span
                # (e.g. persistence failed after the check was recorded).
                "judge": {"model": "m", "span_id": "span-vanished"},
            },
        ],
    }

    annotate_judge_span_ids(session, [run], checks)

    kept = checks["run-1"][0]["judge"]
    assert isinstance(kept, dict)
    assert kept["span_id"] == "span-real"
    dropped = checks["run-1"][1]["judge"]
    assert isinstance(dropped, dict)
    assert "span_id" not in dropped


def test_run_without_trace_is_untouched(session: Session) -> None:
    _make_project(session)
    run = _make_run(session, "run-1", None)
    checks = {"run-1": _checks("some-check")}

    annotate_judge_span_ids(session, [run], checks)

    judge = checks["run-1"][0]["judge"]
    assert isinstance(judge, dict)
    assert "span_id" not in judge
