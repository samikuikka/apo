# pyright: reportAny=false, reportCallIssue=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUntypedFunctionDecorator=false, reportUnusedCallResult=false

"""Golden payloads for ``GET /v1/runs/facets``.

The expected values in ``fixtures/run_facets_golden.json`` were captured
from the implementation that materialized run-id lists in Python, before the
facets moved to SQL aggregates over a filtered-runs subquery. They pin the
response for one fixed two-project fixture across filter combinations, so a
change to how the facets are computed cannot change what the sidebar shows.

The golden fixture deliberately has no trace id shared between projects:
the old implementation counted another project's copy of a shared id, which
is the bug the scoped implementation fixes. That case has its own tests in
``test_read_path_project_scope.py``.
"""

import json
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models import LoggedCallDB, RunDB, RunMetricDB
from apo.models.db import ProjectDB, ProjectMembershipDB, UserDB

GOLDEN_PATH = Path(__file__).parent / "fixtures" / "run_facets_golden.json"
BASE = datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
MEMBER_ID = "facet-member"

# (id, project, environment, user_id, session_id, tags, primary_model,
#  call_count, hours before BASE)
_RUNS: list[tuple[str, str, str, str | None, str | None, list[str], str | None, int, int]] = [
    ("a1", "alpha", "prod", "u1", "s1", ["a", "b"], "gpt-4o", 3, 1),
    ("a2", "alpha", "prod", "u1", "s1", ["a"], "gpt-4o", 2, 2),
    ("a3", "alpha", "prod", "u1", "s1", ["a", "c"], "claude", 2, 3),
    ("a4", "alpha", "prod", "u1", "s2", [], "claude", 1, 4),
    ("a5", "alpha", "prod", "u2", "s2", ["a"], None, 2, 5),
    ("a6", "alpha", "dev", "u2", "s3", ["b"], "gpt-4o-mini", 1, 30),
    ("a7", "alpha", "dev", None, None, ["a", "b", "c"], None, 0, 50),
    ("a8", "alpha", "staging", "", None, [], "gemini", 2, 80),
    ("b1", "beta", "prod", "u1", "sB", ["a", "z"], "claude", 2, 1),
    ("b2", "beta", "dev", "u9", None, [], None, 1, 2),
    ("b3", "beta", "dev", "u9", None, ["z"], "gemini", 0, 3),
]

# (run_id, model, provider, route, level). Empty strings and nulls exercise
# the host label's "route wins, blank means unknown" rule.
_CALLS: list[tuple[str, str, str | None, str | None, str]] = [
    ("a1", "gpt-4o", "openai", None, "DEFAULT"),
    ("a1", "gpt-4o", "openai", None, "ERROR"),
    ("a1", "claude", "anthropic", "priority", "DEFAULT"),
    ("a2", "gpt-4o", "openai", None, "WARNING"),
    ("a2", "claude", "anthropic", None, "DEFAULT"),
    ("a3", "claude", "anthropic", None, "DEFAULT"),
    ("a3", "claude", "anthropic", "priority", "DEFAULT"),
    ("a4", "claude", "anthropic", None, "ERROR"),
    ("a5", "gpt-4o", "", "", "DEFAULT"),
    ("a5", "gemini", None, "fireworks", "WARNING"),
    ("a6", "gpt-4o-mini", "openai", None, "DEFAULT"),
    ("a8", "gemini", "fireworks", None, "WARNING"),
    ("a8", "gemini", None, None, "ERROR"),
    ("b1", "claude", "groq", None, "DEFAULT"),
    ("b1", "claude", "groq", None, "ERROR"),
    ("b2", "gemini", None, "fireworks", "DEFAULT"),
]

# (run_id, metric_name)
_METRICS: list[tuple[str, str]] = [
    ("a1", "accuracy"),
    ("a2", "accuracy"),
    ("a3", "accuracy"),
    ("a1", "latency"),
    ("a5", "latency"),
    ("a8", "toxicity"),
    ("b1", "accuracy"),
]

_WINDOW = {
    "created_after": (BASE - timedelta(hours=6)).isoformat(),
    "created_before": (BASE - timedelta(minutes=30)).isoformat(),
}

# name -> query params. "unpinned" sends no project: in the open dev mode the
# plain test client runs in, that aggregates over every project.
GOLDEN_REQUESTS: dict[str, dict[str, str]] = {
    "alpha": {"project": "alpha"},
    "alpha_status_error": {"project": "alpha", "status": "error"},
    # Two matching runs in different environments: an equal-count tie.
    "alpha_status_success": {"project": "alpha", "status": "success"},
    "alpha_status_warning_success": {"project": "alpha", "status": "warning,success"},
    "alpha_models_claude": {"project": "alpha", "models": "claude"},
    "alpha_models_and_status": {
        "project": "alpha",
        "models": "gpt-4o,gemini",
        "status": "error,warning",
    },
    "alpha_environment_prod": {"project": "alpha", "environment": "prod"},
    "alpha_tags_a": {"project": "alpha", "tags": "a"},
    "alpha_user_u1": {"project": "alpha", "user_id": "u1"},
    "alpha_sessions": {"project": "alpha", "session_id": "s1,s2"},
    "alpha_metric_accuracy": {"project": "alpha", "metric_name": "accuracy"},
    "alpha_created_window": {"project": "alpha", **_WINDOW},
    "alpha_dev_success": {"project": "alpha", "environment": "dev", "status": "success"},
    "alpha_no_match": {"project": "alpha", "environment": "nonexistent"},
    "beta": {"project": "beta"},
    "unpinned": {},
    "unpinned_status_error": {"status": "error"},
}


def seed_golden_fixture(session: Session) -> None:
    """Two projects with no shared trace id; every timestamp is fixed."""
    for run_id, project, env, user, sess, tags, model, call_count, hours in _RUNS:
        session.add(
            RunDB(
                id=run_id,
                project=project,
                task_id="t",
                environment=env,
                user_id=user,
                session_id=sess,
                tags=tags,
                primary_model=model,
                call_count=call_count,
                created_at=BASE - timedelta(hours=hours),
            )
        )
    for index, (run_id, model, provider, route, level) in enumerate(_CALLS):
        session.add(
            LoggedCallDB(
                id=f"{run_id}-c{index}",
                project="alpha" if run_id.startswith("a") else "beta",
                task_id="t",
                run_id=run_id,
                model=model,
                provider=provider,
                route=route,
                level=level,
                created_at=BASE + timedelta(seconds=index),
                input={},
                messages=[],
                output={},
            )
        )
    for run_id, name in _METRICS:
        session.add(
            RunMetricDB(
                run_id=run_id,
                project="alpha" if run_id.startswith("a") else "beta",
                metric_name=name,
                metric_type="quality",
                data_type="NUMERIC",
                score=0.5,
                created_at=BASE,
            )
        )
    session.commit()


def seed_alpha_member(session: Session) -> None:
    """A user whose only membership is project alpha."""
    session.add(
        UserDB(id=MEMBER_ID, email="facet-member@t.co", name=MEMBER_ID, password_hash="x")
    )
    session.commit()
    for project in ("alpha", "beta"):
        session.add(ProjectDB(id=project, name=project, created_by=MEMBER_ID))
    session.commit()
    session.add(ProjectMembershipDB(project_id="alpha", user_id=MEMBER_ID, role="owner"))
    session.commit()


def _golden() -> dict[str, Any]:
    return json.loads(GOLDEN_PATH.read_text())


@pytest.mark.parametrize("name", sorted(GOLDEN_REQUESTS))
def test_facets_match_golden(name: str, client: TestClient, session: Session) -> None:
    seed_golden_fixture(session)

    response = client.get("/v1/runs/facets", params=GOLDEN_REQUESTS[name])

    assert response.status_code == 200
    assert response.json() == _golden()[name]


def test_member_without_a_pinned_project_sees_only_their_projects(
    make_authed_client: Callable[..., TestClient], session: Session
) -> None:
    # No ?project=: the aggregate is restricted to the caller's memberships,
    # so a member of alpha alone gets exactly the alpha payload.
    seed_golden_fixture(session)
    seed_alpha_member(session)
    member = make_authed_client(MEMBER_ID, session, is_admin=False)

    response = member.get("/v1/runs/facets")

    assert response.status_code == 200
    assert response.json() == _golden()["alpha"]


def test_golden_fixture_distinguishes_the_two_projects() -> None:
    # Guards the fixture itself: if alpha and beta ever produced the same
    # payload, the scoping assertions above would pass vacuously.
    golden = _golden()
    assert golden["alpha"] != golden["beta"]
    assert golden["alpha"] != golden["unpinned"]
