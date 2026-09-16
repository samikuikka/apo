"""Issue #159: judgment routes for re-judged Task Runs.

A completed Run's verdict is welded to the judge that ran it. These routes
serve what replay needs (the pinned definition source) and record what
replay produces (new judgments). The heavy lifting — importing and executing
the eval source — happens in the CLI, never here: the backend stores Task
Definition source as private data and never executes it.

Rules enforced here rather than documented:
- Whole runs only. The create body takes one full ``checks`` list; partial
  re-judging is not expressible (re-judging only failed criteria ratchets a
  ~16%-unstable verdict toward PASS).
- Judgments land next to the original — the run's own verdict columns and
  check report are never touched.
"""

# pyright: reportCallInDefaultInitializer=false

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlmodel import Session

from ..db import get_session
from ..models.db import AgentTaskRunDB, TaskDefinitionRevisionDB
from ..models.schemas import (
    AgentTaskJudgmentSummary,
    CreateAgentTaskJudgmentRequest,
)
from ..services.agent_task_run_access import require_task_run_access
from ..services.check_report_storage import load_check_report
from ..services.check_report_storage import normalize_check_report
from ..services.judgments import (
    MAX_JUDGMENT_SAMPLES,
    build_judgment_summary,
    create_judgment,
    list_judgment_rows,
    list_judgments,
    synthesize_original_judgment,
)
from ..services.task_definition_revisions import get_definition_for_run

router = APIRouter(prefix="/v1", tags=["agent-tasks"])

_TERMINAL_VERDICT_STATUSES = ("passed", "failed")


@router.get("/agent-task-runs/{task_run_id}/judgments")
async def list_run_judgments(
    task_run_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """List a Run's judgments: the original first, rejudges newest first.

    Summaries only — full check evidence lives on the single-judgment
    endpoint. Authorization mirrors the Run detail route (opaque 404 for
    non-members).
    """
    task_run = _load_task_run(session, task_run_id)
    _ = require_task_run_access(request, session, task_run, write=False)
    return {
        "task_run_id": task_run.id,
        "judgments": [j.model_dump(mode="json") for j in list_judgments(session, task_run)],
    }


@router.get("/agent-task-runs/{task_run_id}/judgments/{judgment_id}")
async def get_run_judgment(
    task_run_id: str,
    judgment_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> AgentTaskJudgmentSummary:
    """Read one judgment with its full check evidence.

    ``judgment_id`` equal to the Run id addresses the synthesized
    ``original`` judgment (checks come from the run's check report).
    """
    task_run = _load_task_run(session, task_run_id)
    _ = require_task_run_access(request, session, task_run, write=False)

    if judgment_id == task_run.id:
        original = synthesize_original_judgment(session, task_run)
        original.checks = load_check_report(session, task_run.id) or []
        return original

    for row in list_judgment_rows(session, task_run.id):
        if row.id == judgment_id:
            return build_judgment_summary(
                row,
                canonical_revision_id=task_run.task_definition_revision_id,
                include_evidence=True,
            )
    raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Judgment not found")


_AGENT_SESSION_OUTCOMES = ("verdict", "budget_exhausted", "error")


def _validate_agent_sessions(checks: list[dict[str, object]]) -> None:
    """Enforce the agentic-session contract on submitted check reports.

    A ``judge.session`` may only ride an ``evaluator_type: "agent"`` check or
    assertion, must declare a known outcome, and a ``"verdict"`` outcome must
    carry an actual verdict (pass + reasoning). Violations are 422s — a
    malformed transcript must never be stored as if it were a judgment.
    """
    for check in checks:
        _validate_one_judge(check.get("judge"), check.get("evaluator_type"))
        assertions = check.get("assertions")
        if not isinstance(assertions, list):
            continue
        for assertion in assertions:
            if not isinstance(assertion, dict):
                continue
            _validate_one_judge(assertion.get("judge"), assertion.get("evaluator_type"), assertion)


def _validate_one_judge(
    judge: object, evaluator_type: object, assertion: dict[str, object] | None = None
) -> None:
    if not isinstance(judge, dict) or "session" not in judge:
        return
    session = judge["session"]
    if evaluator_type != "agent":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "kind": "agent_session_misfiled",
                "msg": "judge.session requires evaluator_type 'agent'",
            },
        )
    if not isinstance(session, dict) or session.get("outcome") not in _AGENT_SESSION_OUTCOMES:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "kind": "agent_session_missing_outcome",
                "msg": f"judge.session outcome must be one of {_AGENT_SESSION_OUTCOMES}",
            },
        )
    if session["outcome"] == "verdict" and assertion is not None:
        reasoning = assertion.get("reasoning")
        has_verdict = (
            isinstance(assertion.get("pass"), bool)
            and isinstance(reasoning, str)
            and reasoning.strip() != ""
        )
        if not has_verdict:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail={
                    "kind": "agent_session_verdict_missing",
                    "msg": "outcome 'verdict' requires pass and non-empty reasoning",
                },
            )


@router.post(
    "/agent-task-runs/{task_run_id}/judgments",
    response_model=AgentTaskJudgmentSummary,
    status_code=status.HTTP_201_CREATED,
)
async def record_run_judgment(
    task_run_id: str,
    body: CreateAgentTaskJudgmentRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> AgentTaskJudgmentSummary:
    """Record a rejudge judgment for a completed Run.

    The CLI replays Phase 2 against the Run's stored Deliverables and
    submits the outcome here. Verdict counts are derived from ``checks``
    server-side; ``trigger`` is forced to ``rejudge``. Writes require
    project-member authority and are refused on the demo project.
    """
    task_run = _load_task_run(session, task_run_id)
    project = require_task_run_access(request, session, task_run, write=True)

    if task_run.status not in _TERMINAL_VERDICT_STATUSES:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "kind": "run_not_complete",
                "msg": (
                    f"Only completed runs with a verdict can be re-judged; "
                    f"run status is '{task_run.status}'"
                ),
            },
        )
    if not body.checks:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "kind": "empty_checks",
                "msg": "A judgment must record the full check set; got an empty list",
            },
        )
    _validate_agent_sessions(body.checks)
    # POSTed transcripts are untrusted input: the same caps that guard the
    # run's own check report guard every recorded judgment (write+read).
    normalized_checks = normalize_check_report(body.checks)
    if not 1 <= body.samples <= MAX_JUDGMENT_SAMPLES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "kind": "invalid_samples",
                "msg": f"samples must be between 1 and {MAX_JUDGMENT_SAMPLES}",
            },
        )

    revision_id = body.task_definition_revision_id or task_run.task_definition_revision_id
    if revision_id is not None and revision_id != task_run.task_definition_revision_id:
        # Explicitly scoring against a different rubric: allowed, but the
        # revision must exist and belong to this Run's project + task so the
        # judgment's provenance stamp is real.
        revision = session.get(TaskDefinitionRevisionDB, revision_id)
        if revision is None or revision.project != project or revision.task_id != task_run.task_id:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                detail={"kind": "definition_source_not_found"},
            )

    judgment = create_judgment(
        session,
        task_run=task_run,
        project=project,
        label=body.label,
        judge_model=body.judge_model,
        judge_base_url=body.judge_base_url,
        task_definition_revision_id=revision_id,
        samples=body.samples,
        checks=normalized_checks,
        stability=body.stability,
    )
    session.commit()
    session.refresh(judgment)
    return build_judgment_summary(
        judgment,
        canonical_revision_id=task_run.task_definition_revision_id,
        include_evidence=True,
    )


@router.get("/agent-task-runs/{task_run_id}/definition-source")
async def get_run_definition_source(
    task_run_id: str,
    request: Request,
    revision: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Serve the eval source a replay must score against.

    Defaults to the Run's pinned Task Definition Revision. An explicit
    ``?revision=`` is allowed for scoring old Deliverables against a new
    rubric — the resulting judgment is stamped with that revision id so it
    can never be misread as "the same eval, better judge". The revision must
    belong to the same project and task; mismatches are opaque 404s.

    Private Project source data: project members only, and it is still
    never executed by the backend — the CLI materializes and imports it.
    """
    task_run = _load_task_run(session, task_run_id)
    project = require_task_run_access(request, session, task_run, write=False)

    if revision is not None and revision != task_run.task_definition_revision_id:
        rev_row = session.get(TaskDefinitionRevisionDB, revision)
        if rev_row is None or rev_row.project != project or rev_row.task_id != task_run.task_id:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                detail={"kind": "definition_source_not_found"},
            )
    else:
        rev_row = get_definition_for_run(session, task_run_id)
        if rev_row is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                detail={"kind": "definition_source_not_found"},
            )

    files: list[dict[str, object]] = []
    for file in rev_row.source_files_json or []:
        content = str(file.get("content", ""))
        files.append(
            {
                "path": str(file.get("path", "")),
                "content": content,
                "size_bytes": len(content.encode("utf-8")),
            }
        )
    return {
        "task_definition_revision_id": rev_row.id,
        "task_id": rev_row.task_id,
        "files": files,
    }


def _load_task_run(session: Session, task_run_id: str) -> AgentTaskRunDB:
    task_run = session.get(AgentTaskRunDB, task_run_id)
    if task_run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Task run not found")
    return task_run


__all__ = ["router"]
