# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

"""v2 enrollment binds the Executor to the member who issued the redeemed token.

Every member's Connected Executor enrolls into the one shared source-owned
Pool, and claims match ``target_user_id`` against ``enrolled_by_user_id``. If
enrollment read the owner from any used token in the Pool, a second member's
Executor would be bound to the first member: it would claim their dashboard
runs against the wrong checkout, and the second member's runs would never be
claimed.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import Response
from sqlmodel import Session

from apo.models.db import ExecutorDB, ProjectDB, ProjectMembershipDB, UserDB
from apo.models.execution import ExecutorCapabilities
from apo.routes.executor_protocol_v2 import EnrollV2Request, enroll_v2
from apo.services.source_owned_executor import bootstrap_connected_executor


def _member(s: Session, email: str) -> str:
    user = UserDB(email=email, name=email, password_hash="x", is_active=True)
    s.add(user)
    s.commit()
    s.refresh(user)
    if s.get(ProjectDB, "p1") is None:
        s.add(ProjectDB(id="p1", name="P", created_by=user.id))
        s.commit()
    now = datetime.now(timezone.utc)
    s.add(ProjectMembershipDB(
        project_id="p1", user_id=user.id, role="member", created_at=now, updated_at=now,
    ))
    s.commit()
    return user.id


def _enroll(session: Session, token: str, name: str) -> str:
    result = enroll_v2(
        EnrollV2Request(
            token=token,
            name=name,
            capabilities=ExecutorCapabilities(
                protocol_version=2,
                executor_version="0.0.0-test",
                driver_kinds=["source-owned-ts"],
                os="linux",
                architecture="x64",
                runtimes={"node": "22"},
                max_concurrency=1,
            ),
        ),
        Response(),
        session,
    )
    return result.executor_id


def test_each_member_executor_is_bound_to_that_member(session: Session):
    alice = _member(session, "alice@t.com")
    bob = _member(session, "bob@t.com")
    alice_token = bootstrap_connected_executor(
        session, project_id="p1", user_id=alice, name="alice-laptop"
    ).enrollment_token
    bob_token = bootstrap_connected_executor(
        session, project_id="p1", user_id=bob, name="bob-laptop"
    ).enrollment_token

    alice_executor = _enroll(session, alice_token, "alice-laptop")
    bob_executor = _enroll(session, bob_token, "bob-laptop")

    alice_executor_row = session.get(ExecutorDB, alice_executor)
    bob_executor_row = session.get(ExecutorDB, bob_executor)
    assert alice_executor_row is not None
    assert bob_executor_row is not None
    assert alice_executor_row.enrolled_by_user_id == alice
    assert bob_executor_row.enrolled_by_user_id == bob

