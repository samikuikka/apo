"""Dev-only demo capture sessions.

Capture is a switch, not a constant:

    python -m apo.dev_demo_capture start      # watermark a scratch project
    ...run tasks / rejudges / corrections normally (UI or CLI)...
    python -m apo.dev_demo_capture finish     # export delta, merge fixture

``start`` provisions the scratch capture project (fixed id ``demo-capture``)
with a filesystem task source rooted at the bundled demo tree. ``finish``
exports everything created after the watermark, merges it into
``apo/data/demo-workspace-v1.json`` (verbatim ids dedupe naturally; use
``--pin FROM=TO`` to keep guide-rail anchor ids stable across recaptures),
and removes the watermark. ``verify`` loads the shipped fixture into a
scratch database and asserts the surface checklist.

Re-capture policy (S4): manual. Full recapture is worth it when the fixture
schema bumps, the demo task tree changed materially, captured evidence
misrepresents the UI, or a captured model became unavailable/mispriced.
Incremental sessions cover everything else. No release is ever blocked on a
recapture.
"""

# pyright: reportAny=false

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast

from sqlmodel import Session, col, select

from .db import engine
from .models.db import (
    AgentTaskBatchRunDB,
    AgentTaskDeliverableDB,
    AgentTaskJudgmentDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    AgentTaskScheduleOccurrenceDB,
    AgentTaskTestResultCorrectionDB,
    OtlpSpanDB,
    ProjectDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    TaskDefinitionRevisionDB,
    TaskViewComparisonDB,
    TaskViewDB,
)
from .services.demo_fixture import DEFAULTS_PATH
from .services.otlp_receiver import attrs_dict_to_otlp, span_row_to_otlp_json
from .services.paths import demo_task_root
from .services.project_task_inventory import seed_demo_inventory

CAPTURE_PROJECT_ID = "demo-capture"
DEMO_USER_ID = "demo-user"
WATERMARK_PATH = Path(__file__).resolve().parents[1] / "data" / "demo-capture-session.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="apo.dev_demo_capture", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("start", help="Begin a capture session (watermark the scratch project)")
    finish = sub.add_parser("finish", help="Export the delta and merge it into the fixture")
    finish.add_argument("--pin", action="append", default=[], metavar="FROM=TO",
                        help="Rename an entity id in the exported delta (repeatable); "
                             "keeps guide-rail anchors like demo-run-001 stable")
    finish.add_argument("--out", type=Path, default=None, help="Fixture path (default: shipped)")
    sub.add_parser("verify", help="Load the shipped fixture into a scratch DB and check it")
    sub.add_parser("abort", help="Discard the capture session watermark")

    args = parser.parse_args(argv)
    if args.command == "start":
        return cmd_start()
    if args.command == "finish":
        return cmd_finish([p.split("=", 1) for p in args.pin], args.out or DEFAULTS_PATH)
    if args.command == "verify":
        return cmd_verify(args.out if hasattr(args, "out") else DEFAULTS_PATH)
    if args.command == "abort":
        return cmd_abort()
    return 2


def cmd_start() -> int:
    if WATERMARK_PATH.exists():
        print(f"capture session already open ({WATERMARK_PATH.read_text().strip()})")
        return 1
    with Session(engine) as session:
        project = session.get(ProjectDB, CAPTURE_PROJECT_ID)
        if project is None:
            project = ProjectDB(id=CAPTURE_PROJECT_ID, name="Demo capture")
            session.add(project)
            session.commit()
        source = session.exec(
            select(ProjectTaskSourceDB).where(
                ProjectTaskSourceDB.project == CAPTURE_PROJECT_ID
            )
        ).first()
        if source is None:
            source = ProjectTaskSourceDB(
                project=CAPTURE_PROJECT_ID,
                source_type="filesystem",
                display_name="Demo capture",
                filesystem_path=demo_task_root(),
                status="ready",
            )
            session.add(source)
            session.commit()
            session.refresh(source)
            inventory = seed_demo_inventory(session, source)
            print(f"capture project ready: {len(inventory)} tasks discovered")
        else:
            print("capture project already provisioned")
    now = datetime.now(timezone.utc).isoformat()
    WATERMARK_PATH.parent.mkdir(parents=True, exist_ok=True)
    WATERMARK_PATH.write_text(json.dumps({"started_at": now, "project": CAPTURE_PROJECT_ID}))
    print(f"capture window open since {now}")
    print("Run tasks / rejudges / corrections in the capture project, then `finish`.")
    return 0


def cmd_abort() -> int:
    if WATERMARK_PATH.exists():
        WATERMARK_PATH.unlink()
        print("capture session discarded")
        return 0
    print("no capture session open")
    return 1


def cmd_finish(pins: list[list[str]], out_path: Path) -> int:
    if not WATERMARK_PATH.exists():
        print("no capture session open — run `start` first")
        return 1
    watermark = json.loads(WATERMARK_PATH.read_text())
    started_at = datetime.fromisoformat(watermark["started_at"])
    pin_map = {frm: to for frm, to in pins}

    with Session(engine) as session:
        delta = export_delta(session, started_at)
    if not delta.get("batches"):
        print("nothing captured in the window (no batches) — fixture unchanged")
        WATERMARK_PATH.unlink()
        return 0
    apply_pins(delta, pin_map)
    merge_into_fixture(delta, out_path)
    WATERMARK_PATH.unlink()
    print(f"merged {len(delta['batches'])} batch(es) into {out_path}; session closed")
    print("Run `verify` next; reload happens on next backend boot.")
    return 0


# ---------------------------------------------------------------------------
# Export (capture project → fixture-format delta)
# ---------------------------------------------------------------------------


def export_delta(session: Session, started_at: datetime) -> dict[str, Any]:
    batches = session.exec(
        select(AgentTaskBatchRunDB).where(
            AgentTaskBatchRunDB.project == CAPTURE_PROJECT_ID,
            col(AgentTaskBatchRunDB.created_at) > started_at,
        )
    ).all()
    delta: dict[str, Any] = {
        "schema_version": 1,
        "catalog": {"tasks": export_catalog(session)},
        "batches": [export_batch(session, b) for b in batches],
        "schedules": export_schedules(session, started_at),
        "views": export_views(session),
    }
    users = capture_users(session)
    if users:
        delta["demo_user"] = {
            "id": DEMO_USER_ID,
            "email": "demo@apo.invalid",
            "name": "Apo Demo",
        }
    return delta


def capture_users(session: Session) -> list[str]:
    return sorted(
        {
            row
            for row in session.exec(
                select(AgentTaskBatchRunDB.requested_by_user_id).where(
                    AgentTaskBatchRunDB.project == CAPTURE_PROJECT_ID
                )
            ).all()
            if row
        }
    )


def export_catalog(session: Session) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    rows = session.exec(
        select(ProjectTaskInventoryDB).where(
            ProjectTaskInventoryDB.project == CAPTURE_PROJECT_ID
        )
    ).all()
    for row in rows:
        task: dict[str, Any] = {
            "task_id": row.task_id,
            "display_name": row.display_name,
            "adapter_name": row.adapter_name or "real-agent",
            "folder_path": row.folder_path or "",
            "has_checks": bool(row.has_checks),
            "tags": row.tags_json or [],
        }
        if row.task_definition_revision_id:
            revision = session.get(TaskDefinitionRevisionDB, row.task_definition_revision_id)
            if revision is not None:
                task["definition"] = {"files": revision.source_files_json or []}
        tasks.append(task)
    return tasks


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat()


def export_batch(session: Session, batch: AgentTaskBatchRunDB) -> dict[str, Any]:
    runs = session.exec(
        select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch.id)
    ).all()

    spec: dict[str, Any] = {
        "id": batch.id,
        "selection_type": batch.selection_type,
        "selection_query": batch.selection_query,
        "task_root": batch.task_root,
        "environment": batch.environment,
        "requested_by_user_id": DEMO_USER_ID if batch.requested_by_user_id else None,
        "run_metadata": batch.run_metadata or {},
        "status": batch.status,
        "created_at": _iso(batch.created_at),
        "started_at": _iso(batch.started_at),
        "completed_at": _iso(batch.completed_at),
        "runs": [export_run(session, run) for run in runs],
    }
    return spec


def canonical_task_id(task_id: str) -> str:
    """The CLI records ids with a ``tasks/`` prefix the backend inventory
    does not use — normalize so runs match catalog rows."""
    return task_id.removeprefix("tasks/")


def export_run(session: Session, run: AgentTaskRunDB) -> dict[str, Any]:
    from .services.check_report_storage import load_check_report

    spec: dict[str, Any] = {
        "id": run.id,
        "task_id": canonical_task_id(run.task_id),
        "sequence_index": run.sequence_index,
        "adapter_name": run.adapter_name,
        "status": run.status,
        "pass_result": run.pass_result,
        "started_at": _iso(run.started_at),
        "completed_at": _iso(run.completed_at),
        "configured_model": run.configured_model,
        "configured_effort": run.configured_effort,
        "transcript_json": run.transcript_json,
        "total_cost": run.total_cost,
        "total_tokens": run.total_tokens,
        "check_report": load_check_report(session, run.id) or None,
        "deliverables": export_deliverables(session, run.id),
        "judgments": export_judgments(session, run.id),
        "corrections": export_corrections(session, run.id),
    }
    if run.trace_run_id:
        payload = find_otel_payload(session, run.trace_run_id)
        if payload is not None:
            spec["otel_trace"] = payload
        else:
            print(f"warning: no raw OTLP payload found for trace {run.trace_run_id}")
    return spec


def export_deliverables(session: Session, run_id: str) -> list[dict[str, Any]]:
    rows = session.exec(
        select(AgentTaskDeliverableDB).where(
            AgentTaskDeliverableDB.task_run_id == run_id
        )
    ).all()
    out: list[dict[str, Any]] = []
    for row in rows:
        if row.kind != "json" or row.inline_value_json is None:
            print(f"warning: skipping non-inline deliverable {row.id}")
            continue
        out.append(
            {
                "id": row.id,
                "name": row.name,
                "value": row.inline_value_json.get("value"),
                "created_at": _iso(row.created_at),
            }
        )
    return out


def export_judgments(session: Session, run_id: str) -> list[dict[str, Any]]:
    rows = session.exec(
        select(AgentTaskJudgmentDB).where(AgentTaskJudgmentDB.task_run_id == run_id)
    ).all()
    return [
        {
            "id": j.id,
            "trigger": j.trigger,
            "label": j.label,
            "judge_model": j.judge_model,
            "samples": j.samples,
            "pass_result": j.pass_result,
            "total_checks": j.total_checks,
            "passed_checks": j.passed_checks,
            "failed_checks": j.failed_checks,
            "checks_json": j.checks_json,
            "stability_json": j.stability_json,
            "created_at": _iso(j.created_at),
        }
        for j in rows
    ]


def export_corrections(session: Session, run_id: str) -> list[dict[str, Any]]:
    rows = session.exec(
        select(AgentTaskTestResultCorrectionDB).where(
            AgentTaskTestResultCorrectionDB.task_run_id == run_id
        )
    ).all()
    return [
        {
            "test_id": c.test_id,
            "action": c.action,
            "reason": c.reason,
            "created_at": _iso(c.created_at),
        }
        for c in rows
    ]


def find_otel_payload(session: Session, trace_run_id: str) -> dict[str, Any] | None:
    """Assemble a run's full OTLP trace from the canonical span store.

    Ingest payloads are blanked once a batch projects (the span store is
    the source of truth), and capture runs after completion — so the wire
    form is REBUILT from the typed canonical columns via
    ``span_row_to_otlp_json``. Spans are grouped by their stored
    resource/scope so the replayed payload projects identically.
    """
    rows = session.exec(
        select(OtlpSpanDB)
        .where(
            OtlpSpanDB.project_id == CAPTURE_PROJECT_ID,
            OtlpSpanDB.trace_id == trace_run_id,
        )
        .order_by(col(OtlpSpanDB.id))
    ).all()
    if not rows:
        return None

    # Group spans by (resource, scope) — the resourceSpans/scopeSpans shape
    # the receiver flattens them into on ingest.
    from dataclasses import dataclass, field

    @dataclass
    class _SpanGroup:
        resource: dict[str, object]
        resource_attrs: dict[str, object]
        scope: dict[str, object]
        spans: list[dict[str, object]] = field(default_factory=list)

    groups: dict[tuple[str, str], _SpanGroup] = {}
    for row in rows:
        resource: dict[str, object] = dict(row.resource or {})
        raw_attrs = resource.pop("attributes", None)
        resource_attrs: dict[str, object] = (
            cast("dict[str, object]", raw_attrs)
            if isinstance(raw_attrs, dict)
            else {}
        )
        scope = dict(row.instrumentation_scope or {})
        key = (json.dumps(resource, sort_keys=True), json.dumps(scope, sort_keys=True))
        group = groups.setdefault(
            key, _SpanGroup(resource=resource, resource_attrs=resource_attrs, scope=scope)
        )
        group.spans.append(span_row_to_otlp_json(row))

    resource_spans: list[dict[str, object]] = []
    for group in groups.values():
        resource_block = {**group.resource, "attributes": attrs_dict_to_otlp(group.resource_attrs)}
        resource_spans.append(
            {
                "resource": resource_block,
                "scopeSpans": [{"scope": group.scope, "spans": group.spans}],
            }
        )
    return {"resourceSpans": resource_spans}


def export_schedules(session: Session, started_at: datetime) -> list[dict[str, Any]]:
    schedules = session.exec(
        select(AgentTaskScheduleDB).where(
            AgentTaskScheduleDB.project == CAPTURE_PROJECT_ID
        )
    ).all()
    out: list[dict[str, Any]] = []
    for s in schedules:
        occurrences = session.exec(
            select(AgentTaskScheduleOccurrenceDB).where(
                AgentTaskScheduleOccurrenceDB.schedule_id == s.id,
                col(AgentTaskScheduleOccurrenceDB.created_at) > started_at,
            )
        ).all()
        out.append(
            {
                "id": s.id,
                "name": s.name,
                "selection_type": s.selection_type,
                "environment": s.environment,
                "cadence_type": s.cadence_type,
                "timezone": s.timezone,
                "hour": s.hour,
                "minute": s.minute,
                "day_of_week": s.day_of_week,
                "day_of_month": s.day_of_month,
                "last_triggered_at": _iso(s.last_triggered_at),
                "last_batch_run_id": s.last_batch_run_id,
                "created_at": _iso(s.created_at),
                "occurrences": [
                    {
                        "id": o.id,
                        "kind": o.kind,
                        "scheduled_for": _iso(o.scheduled_for),
                        "status": o.status,
                        "batch_run_id": o.batch_run_id,
                        "missed_reason": o.missed_reason,
                        "resolved_at": _iso(o.resolved_at),
                    }
                    for o in occurrences
                ],
                "adaptive_states": [],
            }
        )
    return out


def export_views(session: Session) -> dict[str, Any]:
    views = session.exec(
        select(TaskViewDB).where(TaskViewDB.project_id == CAPTURE_PROJECT_ID)
    ).all()
    comparisons = session.exec(
        select(TaskViewComparisonDB).where(
            TaskViewComparisonDB.project_id == CAPTURE_PROJECT_ID
        )
    ).all()
    return {
        "task_views": [
            {
                "id": v.id,
                "label": v.label,
                "model": v.model,
                "effort": v.effort,
                "since": v.since,
                "created_at": _iso(v.created_at),
            }
            for v in views
        ],
        "comparisons": [
            {
                "id": c.id,
                "view_a_config": c.view_a_config,
                "view_b_config": c.view_b_config,
                "task_ids": c.task_ids,
                "resolved": c.resolved,
                "coverage": c.coverage,
                "created_by": DEMO_USER_ID if c.created_by else None,
                "created_at": _iso(c.created_at),
            }
            for c in comparisons
        ],
    }


def apply_pins(delta: dict[str, Any], pin_map: dict[str, str]) -> None:
    """Rename pinned ids across the delta — a pin is a RENAME, not a copy.

    Deep-rewrite every string equal to a pin source (so nested references
    like occurrence.batch_run_id and comparison resolved cells follow), then
    DROP the original-id entities: keeping both would duplicate evidence
    rows under unique constraints (deliverable ids) at load time.
    """

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            return {k: walk(v) for k, v in node.items()}
        if isinstance(node, list):
            return [walk(v) for v in node]
        if isinstance(node, str):
            return pin_map.get(node, node)
        return node

    replaced = walk(delta)
    delta.update(replaced)

    sources = set(pin_map)
    delta["batches"] = [
        {**b, "runs": [r for r in b.get("runs", []) if r["id"] not in sources]}
        for b in delta.get("batches", [])
        if b["id"] not in sources
    ]
    delta["schedules"] = [
        s for s in delta.get("schedules", []) if s["id"] not in sources
    ]
    views = delta.get("views", {})
    views["task_views"] = [
        v for v in views.get("task_views", []) if v["id"] not in sources
    ]
    views["comparisons"] = [
        c for c in views.get("comparisons", []) if c["id"] not in sources
    ]


# ---------------------------------------------------------------------------
# Merge (delta → fixture file)
# ---------------------------------------------------------------------------


def merge_into_fixture(delta: dict[str, Any], out_path: Path) -> None:
    fixture: dict[str, Any]
    if out_path.exists():
        from .services.demo_fixture import _read_fixture_bytes

        fixture = json.loads(_read_fixture_bytes(out_path))
    else:
        fixture = {"schema_version": 1}
    fixture["schema_version"] = 1
    fixture["generated_at"] = datetime.now(timezone.utc).isoformat()
    if delta.get("demo_user"):
        fixture["demo_user"] = delta["demo_user"]

    catalog = fixture.setdefault("catalog", {"tasks": []})
    by_task = {t["task_id"]: t for t in catalog.setdefault("tasks", [])}
    for task in delta.get("catalog", {}).get("tasks", []):
        by_task[task["task_id"]] = task
    catalog["tasks"] = list(by_task.values())

    batches = fixture.setdefault("batches", [])
    by_id = {b["id"]: b for b in batches}
    for batch in delta.get("batches", []):
        by_id[batch["id"]] = batch
    fixture["batches"] = list(by_id.values())

    schedules = fixture.setdefault("schedules", [])
    by_sid = {s["id"]: s for s in schedules}
    for s in delta.get("schedules", []):
        by_sid[s["id"]] = s
    fixture["schedules"] = list(by_sid.values())

    views = fixture.setdefault("views", {"task_views": [], "comparisons": []})
    views.setdefault("task_views", [])
    views.setdefault("comparisons", [])
    tv = {v["id"]: v for v in views["task_views"]}
    for v in delta.get("views", {}).get("task_views", []):
        tv[v["id"]] = v
    views["task_views"] = list(tv.values())
    cv = {c["id"]: c for c in views["comparisons"]}
    for c in delta.get("views", {}).get("comparisons", []):
        cv[c["id"]] = c
    views["comparisons"] = list(cv.values())

    rendered = json.dumps(fixture, indent=2, ensure_ascii=False).encode() + b"\n"
    if out_path.suffix == ".gz":
        import gzip

        out_path.write_bytes(gzip.compress(rendered, compresslevel=9))
    else:
        out_path.write_bytes(rendered)


# ---------------------------------------------------------------------------
# Verify (surface checklist against a scratch DB)
# ---------------------------------------------------------------------------


def cmd_verify(fixture_path: Path) -> int:
    import tempfile

    from sqlalchemy import create_engine as sa_create_engine
    from sqlmodel import SQLModel
    from sqlmodel import Session as SQLSession

    from .services.demo_fixture import load_demo_fixture
    from .services.demo_workspace import DEMO_PROJECT_ID, ensure_demo_project_exists

    with tempfile.TemporaryDirectory() as tmp:
        db_url = f"sqlite:///{tmp}/verify.db"
        verify_engine = sa_create_engine(db_url)
        SQLModel.metadata.create_all(verify_engine)
        with SQLSession(verify_engine) as session:
            session.add(ProjectDB(id=DEMO_PROJECT_ID, name="Demo workspace"))
            session.commit()
            loaded = load_demo_fixture(session, path=fixture_path)
            if not loaded:
                print("fixture did not load (disabled or digest match on empty)")
                return 1
            failures = run_checklist(session)
    if failures:
        print("VERIFY FAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("verify: all surface checks passed")
    return 0


def run_checklist(session: Any) -> list[str]:
    """The N4 structural checklist; returns a list of failure strings."""
    failures: list[str] = []
    batches = session.exec(
        select(AgentTaskBatchRunDB).where(AgentTaskBatchRunDB.project == "demo")
    ).all()
    runs = session.exec(
        select(AgentTaskRunDB).where(
            col(AgentTaskRunDB.batch_run_id).in_([b.id for b in batches])
        )
    ).all()
    if not batches:
        failures.append("no batches loaded")
        return failures
    if not any(r.status == "failed" for r in runs):
        failures.append("no failed run (the narrative needs informative failures)")
    if not any(r.status == "error" for r in runs) and len(runs) < 20:
        failures.append("no execution-error run and dataset is small (expected 1-2 errors in the full capture)")
    models = {r.configured_model for r in runs if r.configured_model}
    if len(models) < 2:
        failures.append(f"comparison needs >=2 models, found {sorted(models)}")
    if not any(r.trace_run_id for r in runs):
        failures.append("no run has a replayed trace")
    judgments = session.exec(select(AgentTaskJudgmentDB)).all()
    if not any(j.samples and j.samples > 1 for j in judgments):
        failures.append("no multi-sample judgment (rejudge stability story)")
    deliverables = session.exec(select(AgentTaskDeliverableDB)).all()
    if not deliverables:
        failures.append("no deliverables")
    schedules = session.exec(
        select(AgentTaskScheduleDB).where(AgentTaskScheduleDB.project == "demo")
    ).all()
    occurrences = session.exec(select(AgentTaskScheduleOccurrenceDB)).all()
    if not schedules or not occurrences:
        failures.append("no schedule history")
    return failures


if __name__ == "__main__":
    sys.exit(main())
