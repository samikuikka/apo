"""Seed realistic agent task batch runs with varied outcomes.

Creates multiple batch runs across different scenarios:
- All pass
- Mixed pass/fail
- Some errors
- Large batch with mixed results
- Single task runs

Run from project root:  python -m seeds.seed_agent_task_runs
"""

import sys
import os
import uuid
import random
from datetime import datetime, timedelta, timezone
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sqlmodel import Session
from apo.db import engine
from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB

PROJECT = "agent-task-demo"
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TASK_ROOT = os.path.join(
    _REPO_ROOT, "apps", "example-service", "e2e", "agent-task-demo", "tasks"
)

TASKS = [
    {"id": "bug-triage", "path": f"{TASK_ROOT}/real-agent/engineering/bug-triage", "adapter": "realAgentAdapter"},
    {"id": "code-review", "path": f"{TASK_ROOT}/real-agent/engineering/code-review", "adapter": "realAgentAdapter"},
    {"id": "api-testing", "path": f"{TASK_ROOT}/real-agent/engineering/api-testing", "adapter": "realAgentAdapter"},
    {"id": "config-generator", "path": f"{TASK_ROOT}/real-agent/engineering/config-generator", "adapter": "realAgentAdapter"},
    {"id": "migration-planner", "path": f"{TASK_ROOT}/real-agent/engineering/migration-planner", "adapter": "realAgentAdapter"},
    {"id": "document-qa", "path": f"{TASK_ROOT}/real-agent/documents/document-qa", "adapter": "realAgentAdapter"},
    {"id": "data-extraction", "path": f"{TASK_ROOT}/real-agent/documents/data-extraction", "adapter": "realAgentAdapter"},
    {"id": "log-analyzer", "path": f"{TASK_ROOT}/real-agent/operations/log-analyzer", "adapter": "realAgentAdapter"},
    {"id": "research-synthesis", "path": f"{TASK_ROOT}/real-agent/research/research-synthesis", "adapter": "realAgentAdapter"},
    {"id": "security-audit", "path": f"{TASK_ROOT}/real-agent/security/security-audit", "adapter": "realAgentAdapter"},
]

CHECKS_TEMPLATES = {
    "bug-triage": ["severity-is-valid", "has-reproduction-steps"],
    "code-review": ["issues-non-empty", "suggestions-are-code-level"],
    "api-testing": ["test-cases-non-empty", "covers-error-cases"],
    "config-generator": ["config-is-valid-json", "has-required-fields"],
    "migration-planner": ["steps-are-ordered", "has-rollback-plan"],
    "document-qa": ["answer-is-non-empty", "answer-references-document"],
    "data-extraction": ["data-is-valid-json", "required-fields-present"],
    "log-analyzer": ["patterns-non-empty", "timestamps-parsed"],
    "research-synthesis": ["findings-non-empty", "sources-are-urls"],
    "security-audit": ["vulns-non-empty", "cve-references-valid"],
}

PASS_REASONS = [
    "The output accurately addresses all requirements specified in the instruction.",
    "All expected elements are present and well-structured.",
    "The response demonstrates thorough analysis and correct reasoning.",
    "Output meets quality standards with comprehensive coverage.",
]

FAIL_REASONS = [
    "The output misses several key requirements from the instruction.",
    "Response contains factual inaccuracies that undermine the result.",
    "The analysis is superficial and lacks depth required by the criteria.",
    "Output structure does not match the expected format.",
    "Critical edge cases were not addressed.",
    "The response contains hallucinated information not present in the source.",
]

ERROR_MESSAGES = [
    "Subprocess timed out after 120 seconds",
    "Adapter returned non-JSON response: Unexpected token < at position 0",
    "LLM API rate limit exceeded: 429 Too Many Requests",
    "Task execution failed: Cannot read properties of undefined (reading 'output')",
    "Connection refused: Failed to connect to adapter endpoint",
]


def uid() -> str:
    return uuid.uuid4().hex[:16]


def random_reason(pool: list[str]) -> str:
    return random.choice(pool)


def make_checks(task_id: str, pass_all: bool) -> list[dict[str, Any]]:
    check_ids = CHECKS_TEMPLATES.get(task_id, CHECKS_TEMPLATES["bug-triage"])
    result = []
    for cid in check_ids:
        passed = pass_all if pass_all else random.random() > 0.3
        result.append({
            "id": cid,
            "pass": passed,
            "reasoning": random_reason(PASS_REASONS if passed else FAIL_REASONS),
        })
    return result


def make_transcript(task_id: str, passed: bool) -> dict[str, Any]:
    user_msgs = [
        "Please analyze the following input and provide your assessment.",
        "Can you elaborate on the second point?",
        "What about edge cases?",
    ]
    agent_msgs = [
        "I've analyzed the input. Here are my findings:\n\n1. The primary issue relates to configuration validation.\n2. Secondary concerns involve error handling in the main loop.\n3. Performance implications are minimal but worth noting.",
        "To elaborate: the second point involves the error handler not catching TypeError exceptions. This means certain failure modes will propagate up and cause silent failures.",
        "Good question about edge cases. The main concerns are:\n- Empty input arrays\n- Unicode characters in identifiers\n- Concurrent access without locks",
    ]
    if not passed:
        agent_msgs[-1] = "I'm not sure about the edge cases. The input doesn't provide enough context to determine the full scope of potential issues."
    return {
        "messages": [
            {"role": "user", "content": user_msgs[0]},
            {"role": "assistant", "content": agent_msgs[0]},
            {"role": "user", "content": user_msgs[1]},
            {"role": "assistant", "content": agent_msgs[1]},
        ],
        "turn_count": 2,
        "total_tokens": random.randint(800, 4500),
    }


def make_deliverables(task_id: str, passed: bool) -> dict[str, Any]:
    if "bug-triage" in task_id:
        return {
            "severity": "HIGH" if passed else "LOW",
            "reproduction": ["Step 1: Send request with empty body", "Step 2: Observe 500 error in logs"],
            "root_cause": "Missing null check in request handler" if passed else "Unknown",
        }
    if "code-review" in task_id:
        return {
            "issues": [
                {"line": 42, "severity": "warning", "message": "Unused variable 'result'"},
                {"line": 87, "severity": "error", "message": "SQL injection vulnerability"},
            ] if passed else [],
            "suggestions": ["Remove unused variable", "Use parameterized queries"] if passed else ["Looks fine"],
        }
    return {
        "output": "Analysis complete." if passed else "Incomplete analysis.",
        "confidence": round(random.uniform(0.7, 0.95) if passed else random.uniform(0.2, 0.5), 2),
    }


def create_batch_run(
    session: Session,
    task_indices: list[int],
    outcomes: list[str],
    created_offset_hours: float,
    duration_minutes: int,
    selection_type: str = "tasks",
    trigger_source: str = "manual",
    environment: str = "production",
) -> str:
    batch_id = uid()
    created_at = datetime.now(timezone.utc) - timedelta(hours=created_offset_hours)
    started_at = created_at + timedelta(seconds=random.randint(5, 30))
    completed_at = started_at + timedelta(minutes=duration_minutes)

    task_paths = [TASKS[i]["id"] for i in task_indices]

    passed_count = sum(1 for o in outcomes if o == "passed")
    failed_count = sum(1 for o in outcomes if o == "failed")
    errored_count = sum(1 for o in outcomes if o == "error")

    batch = AgentTaskBatchRunDB(
        id=batch_id,
        project=PROJECT,
        selection_type=selection_type,
        selection_query={"task_paths": task_paths},
        task_root=TASK_ROOT,
        environment=environment,
        run_metadata={
            "trigger": {
                "source": trigger_source,
                "actor": "dev-user",
                "hostname": "localhost",
            }
        },
        status="completed",
        total_tasks=len(outcomes),
        passed_tasks=passed_count,
        failed_tasks=failed_count,
        errored_tasks=errored_count,
        created_at=created_at,
        started_at=started_at,
        completed_at=completed_at,
    )
    session.add(batch)

    for i, task_idx in enumerate(task_indices):
        task = TASKS[task_idx]
        outcome = outcomes[i]
        task_started = started_at + timedelta(minutes=i * (duration_minutes // max(len(task_indices), 1)))
        task_duration = random.randint(30, 180)

        if outcome == "error":
            run = AgentTaskRunDB(
                id=uid(),
                batch_run_id=batch_id,
                task_id=task["id"],
                task_path=task["path"],
                adapter_name=task["adapter"],
                status="error",
                pass_result=False,
                started_at=task_started,
                completed_at=task_started + timedelta(seconds=task_duration),
                error_message=random.choice(ERROR_MESSAGES),
                total_cost=round(random.uniform(0.001, 0.02), 4),
                total_tokens=random.randint(100, 500),
            )
        else:
            passed = outcome == "passed"
            checks = make_checks(task["id"], passed)
            cost = round(random.uniform(0.01, 0.15), 4)
            tokens = random.randint(1500, 12000)

            run = AgentTaskRunDB(
                id=uid(),
                batch_run_id=batch_id,
                task_id=task["id"],
                task_path=task["path"],
                adapter_name=task["adapter"],
                status="passed" if passed else "failed",
                pass_result=passed,
                started_at=task_started,
                completed_at=task_started + timedelta(seconds=task_duration),
                checks_json=checks,
                transcript_json=make_transcript(task["id"], passed),
                deliverables_json=make_deliverables(task["id"], passed),
                total_cost=cost,
                total_tokens=tokens,
            )
        session.add(run)

    return batch_id


def seed_agent_task_runs():
    random.seed(42)

    with Session(engine) as session:
        existing = session.exec(
            select(AgentTaskBatchRunDB).where(
                AgentTaskBatchRunDB.project == PROJECT
            )
        ).all()
        if existing:
            print(f"Found {len(existing)} existing batch runs for '{PROJECT}', skipping seed.")
            print("To re-seed, delete existing runs first or change the project name.")
            return

        batch_ids = []

        # Batch 1: Full engineering suite - all pass (6 hours ago)
        bid = create_batch_run(
            session,
            task_indices=[0, 1, 2, 3, 4],
            outcomes=["passed", "passed", "passed", "passed", "passed"],
            created_offset_hours=6,
            duration_minutes=12,
            selection_type="folder",
            trigger_source="schedule",
            environment="production",
        )
        batch_ids.append(bid)
        print(f"[1] All-pass engineering suite: {bid}")

        # Batch 2: Document tasks - mixed (4 hours ago)
        bid = create_batch_run(
            session,
            task_indices=[5, 6],
            outcomes=["passed", "failed"],
            created_offset_hours=4,
            duration_minutes=8,
            trigger_source="manual",
            environment="production",
        )
        batch_ids.append(bid)
        print(f"[2] Mixed document tasks: {bid}")

        # Batch 3: Large batch - mixed results (3 hours ago)
        bid = create_batch_run(
            session,
            task_indices=[0, 1, 2, 3, 5, 7, 8, 9],
            outcomes=["passed", "failed", "passed", "passed", "passed", "error", "passed", "failed"],
            created_offset_hours=3,
            duration_minutes=25,
            selection_type="all",
            trigger_source="schedule",
            environment="staging",
        )
        batch_ids.append(bid)
        print(f"[3] Large mixed batch (8 tasks, 2 fail, 1 error): {bid}")

        # Batch 4: Single task - pass (2 hours ago)
        bid = create_batch_run(
            session,
            task_indices=[0],
            outcomes=["passed"],
            created_offset_hours=2,
            duration_minutes=2,
            selection_type="folder",
            trigger_source="manual",
            environment="development",
        )
        batch_ids.append(bid)
        print(f"[4] Single task pass: {bid}")

        # Batch 5: Security + operations - mostly fail (90 min ago)
        bid = create_batch_run(
            session,
            task_indices=[7, 9],
            outcomes=["failed", "failed"],
            created_offset_hours=1.5,
            duration_minutes=6,
            trigger_source="manual",
            environment="production",
        )
        batch_ids.append(bid)
        print(f"[5] All-fail security+ops: {bid}")

        # Batch 6: Engineering - multiple errors (1 hour ago)
        bid = create_batch_run(
            session,
            task_indices=[1, 2, 3, 4],
            outcomes=["error", "passed", "error", "passed"],
            created_offset_hours=1,
            duration_minutes=10,
            selection_type="folder",
            trigger_source="schedule",
            environment="production",
        )
        batch_ids.append(bid)
        print(f"[6] Mixed with errors (engineering): {bid}")

        # Batch 7: Full suite mostly pass (30 min ago)
        bid = create_batch_run(
            session,
            task_indices=[0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
            outcomes=["passed", "passed", "passed", "failed", "passed", "passed", "passed", "passed", "passed", "passed"],
            created_offset_hours=0.5,
            duration_minutes=35,
            selection_type="all",
            trigger_source="schedule",
            environment="production",
        )
        batch_ids.append(bid)
        print(f"[7] Full suite (10 tasks, 1 fail): {bid}")

        # Batch 8: Quick re-test - all pass (10 min ago)
        bid = create_batch_run(
            session,
            task_indices=[2, 4],
            outcomes=["passed", "passed"],
            created_offset_hours=0.17,
            duration_minutes=4,
            selection_type="tasks",
            trigger_source="manual",
            environment="development",
        )
        batch_ids.append(bid)
        print(f"[8] Quick re-test (2 tasks, all pass): {bid}")

        session.commit()
        # 8 batches with 5+2+8+1+2+4+10+2 = 34 task runs
        print(f"\nSeeded {len(batch_ids)} batch runs with {5+2+8+1+2+4+10+2} total task runs.")


if __name__ == "__main__":
    from sqlmodel import select

    seed_agent_task_runs()
