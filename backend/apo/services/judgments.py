"""Issue #159: judgment records for re-judged Task Runs.

A judgment is the outcome of replaying a completed Run's Phase-2 checks
against its stored Deliverables. Only ``rejudge`` judgments are stored; the
original verdict keeps living on the run row + check report and is
synthesized as the trigger=``original`` judgment on read, so nothing that
reads runs today changes meaning and the original is never overwritten.
"""

# pyright: reportAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

from sqlmodel import Session, col, select

from apo.models.db import AgentTaskJudgmentDB, AgentTaskRunDB
from apo.models.schemas import AgentTaskJudgmentSummary
from apo.services.check_report_storage import load_check_report, normalize_check_report

MAX_JUDGMENT_SAMPLES = 50


def create_judgment(
    session: Session,
    *,
    task_run: AgentTaskRunDB,
    project: str,
    label: str | None,
    judge_model: str | None,
    judge_base_url: str | None,
    task_definition_revision_id: str | None,
    samples: int,
    checks: list[dict[str, object]],
    stability: list[dict[str, object]] | None,
) -> AgentTaskJudgmentDB:
    """Stage a rejudge judgment row; the caller commits.

    Counts and ``pass_result`` are derived from ``checks`` server-side —
    client-reported aggregates are never trusted.
    """
    passed = sum(1 for check in checks if check.get("pass") is True)
    judgment = AgentTaskJudgmentDB(
        task_run_id=task_run.id,
        project=project,
        trigger="rejudge",
        label=label,
        judge_model=judge_model,
        judge_base_url=judge_base_url,
        task_definition_revision_id=task_definition_revision_id,
        samples=samples,
        pass_result=passed == len(checks) and len(checks) > 0,
        total_checks=len(checks),
        passed_checks=passed,
        failed_checks=len(checks) - passed,
        checks_json=normalize_check_report(checks),
        stability_json=stability,
    )
    session.add(judgment)
    session.flush()
    return judgment


def count_judgments(session: Session, task_run_id: str) -> int:
    """Number of recorded rejudge judgments for a Run (original excluded)."""
    rows = session.exec(
        select(AgentTaskJudgmentDB.id).where(col(AgentTaskJudgmentDB.task_run_id) == task_run_id)
    ).all()
    return len(rows)


def list_judgment_rows(session: Session, task_run_id: str) -> list[AgentTaskJudgmentDB]:
    """Stored rejudge judgments, newest first."""
    return list(
        session.exec(
            select(AgentTaskJudgmentDB)
            .where(col(AgentTaskJudgmentDB.task_run_id) == task_run_id)
            .order_by(col(AgentTaskJudgmentDB.created_at).desc())
        ).all()
    )


def build_judgment_summary(
    judgment: AgentTaskJudgmentDB,
    *,
    canonical_revision_id: str | None,
    include_evidence: bool = False,
) -> AgentTaskJudgmentSummary:
    """Serialize a stored judgment row.

    ``canonical_revision_id`` is the Run's pinned revision — the summary
    reports whether the judgment was scored under it, so a judgment made
    against an explicitly different rubric cannot be misread as "the same
    eval, better judge".
    """
    return AgentTaskJudgmentSummary(
        id=judgment.id,
        task_run_id=judgment.task_run_id,
        trigger=judgment.trigger,
        label=judgment.label,
        judge_model=judgment.judge_model,
        judge_base_url=judgment.judge_base_url,
        task_definition_revision_id=judgment.task_definition_revision_id,
        definition_revision_matches_run=(
            judgment.task_definition_revision_id == canonical_revision_id
        ),
        samples=judgment.samples,
        pass_result=judgment.pass_result,
        total_checks=judgment.total_checks,
        passed_checks=judgment.passed_checks,
        failed_checks=judgment.failed_checks,
        created_at=judgment.created_at,
        checks=judgment.checks_json if include_evidence else None,
        stability=judgment.stability_json if include_evidence else None,
    )


def synthesize_original_judgment(
    session: Session,
    task_run: AgentTaskRunDB,
) -> AgentTaskJudgmentSummary:
    """Project the Run's own verdict as the trigger=``original`` judgment.

    The original judgment_id is the Run id: stable, unique, and honest about
    there being no separate stored row. The judge model is recovered
    best-effort from the stored check evidence's judge metadata.
    """
    checks = load_check_report(session, task_run.id) or []
    # The original judgment is recorded machine evidence — counts
    # and verdict derive from the RAW report, never from the run's effective
    # scalars (which a later human correction may have flipped).
    recorded_pass = sum(1 for c in checks if c.get("pass") is True)
    recorded_fail = len(checks) - recorded_pass
    return AgentTaskJudgmentSummary(
        id=task_run.id,
        task_run_id=task_run.id,
        trigger="original",
        judge_model=_recover_judge_model(checks),
        task_definition_revision_id=task_run.task_definition_revision_id,
        definition_revision_matches_run=True,
        samples=1,
        pass_result=recorded_pass == len(checks) and len(checks) > 0,
        total_checks=len(checks),
        passed_checks=recorded_pass,
        failed_checks=recorded_fail,
        created_at=task_run.completed_at or task_run.started_at,
    )


def list_judgments(session: Session, task_run: AgentTaskRunDB) -> list[AgentTaskJudgmentSummary]:
    """Original judgment first, then stored rejudgments newest first."""
    judgments = [synthesize_original_judgment(session, task_run)]
    canonical = task_run.task_definition_revision_id
    for row in list_judgment_rows(session, task_run.id):
        judgments.append(
            build_judgment_summary(row, canonical_revision_id=canonical)
        )
    return judgments


def _recover_judge_model(checks: list[dict[str, object]]) -> str | None:
    """Best-effort judge model from stored check evidence.

    The original run's judge config was never recorded at run level — only
    per-check judge metadata was persisted, so recover the first known model.
    """
    for check in checks:
        judge = check.get("judge")
        if isinstance(judge, dict):
            model = judge.get("model")
            if isinstance(model, str) and model:
                return model
        assertions = check.get("assertions")
        if isinstance(assertions, list):
            for assertion in assertions:
                if not isinstance(assertion, dict):
                    continue
                judge = assertion.get("judge")
                if isinstance(judge, dict):
                    model = judge.get("model")
                    if isinstance(model, str) and model:
                        return model
    return None


__all__ = [
    "MAX_JUDGMENT_SAMPLES",
    "build_judgment_summary",
    "count_judgments",
    "create_judgment",
    "list_judgment_rows",
    "list_judgments",
    "synthesize_original_judgment",
]
