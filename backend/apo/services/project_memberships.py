"""Project membership service.

Centralizes all project-scoped authorization checks. Routes and other
services must use these helpers instead of checking ``UserDB.is_admin``
or ``ProjectDB.created_by`` directly.

The demo project (``id="demo"``) is intentionally world-readable and
has no membership rows; this service treats it as a read-only special
case and never grants management permissions on it.
"""

# pyright: reportAny=false

from __future__ import annotations

from datetime import datetime, timezone
from typing import Final, Literal

from fastapi import HTTPException
from sqlmodel import Session, select

from ..models.db import AgentTaskScheduleDB, ProjectDB, ProjectMembershipDB, UserDB
from ..models.schemas import (
    ProjectMemberSummary,
    ProjectPermissionSummary,
)

DEMO_PROJECT_ID: Final[str] = "demo"

ProjectRole = Literal["viewer", "member", "admin", "owner"]

_ROLE_RANK: Final[dict[str, int]] = {"viewer": 0, "member": 1, "admin": 2, "owner": 3}

_VALID_ROLES: Final[frozenset[str]] = frozenset(_ROLE_RANK.keys())


# ---------------------------------------------------------------------------
# Loading helpers
# ---------------------------------------------------------------------------


def get_project_membership(
    session: Session, project_id: str, user_id: str
) -> ProjectMembershipDB | None:
    """Return the membership row, or ``None`` if the user is not a member."""
    statement = select(ProjectMembershipDB).where(
        ProjectMembershipDB.project_id == project_id,
        ProjectMembershipDB.user_id == user_id,
    )
    return session.exec(statement).first()


def list_memberships_for_project(
    session: Session, project_id: str
) -> list[ProjectMembershipDB]:
    """Return every membership row for ``project_id``."""
    statement = select(ProjectMembershipDB).where(
        ProjectMembershipDB.project_id == project_id
    )
    return list(session.exec(statement).all())


def list_projects_for_user(session: Session, user_id: str) -> list[str]:
    """Return project IDs the user has any membership in."""
    statement = select(ProjectMembershipDB.project_id).where(
        ProjectMembershipDB.user_id == user_id
    )
    return [row for row in session.exec(statement).all()]


def list_projects_with_minimum_role(
    session: Session, user_id: str, *, minimum_role: str
) -> list[str]:
    """Return project IDs where the user's role meets ``minimum_role``.

    Used to scope read queries (e.g. API key listing) so ordinary
    members do not see resources managed at a higher role.
    """
    rank = _ROLE_RANK.get(minimum_role, 0)
    statement = select(ProjectMembershipDB).where(
        ProjectMembershipDB.user_id == user_id
    )
    rows = session.exec(statement).all()
    result: list[str] = []
    for row in rows:
        if _ROLE_RANK.get(row.role, 0) >= rank:
            result.append(row.project_id)
    return result


def count_owners(session: Session, project_id: str) -> int:
    """Return the number of owners on the project (used for last-owner guard)."""
    statement = select(ProjectMembershipDB).where(
        ProjectMembershipDB.project_id == project_id,
        ProjectMembershipDB.role == "owner",
    )
    return len(list(session.exec(statement).all()))


# ---------------------------------------------------------------------------
# Authorization primitives
# ---------------------------------------------------------------------------


def _role_at_least(actual: str, minimum: str) -> bool:
    return _ROLE_RANK.get(actual, 0) >= _ROLE_RANK.get(minimum, 0)


def require_project_member(
    session: Session, project_id: str, user_id: str
) -> ProjectMembershipDB:
    """Return the membership row or raise 403.

    The demo project is world-readable, so a synthetic read-only
    ``member`` row is returned for any authenticated user.
    """
    if project_id == DEMO_PROJECT_ID:
        return _synthetic_demo_membership(user_id)
    membership = get_project_membership(session, project_id, user_id)
    if membership is None:
        raise HTTPException(
            status_code=403, detail="You are not a member of this project"
        )
    return membership


def require_project_role(
    session: Session,
    project_id: str,
    user_id: str,
    *,
    minimum_role: str,
) -> ProjectMembershipDB:
    """Return the membership if it meets ``minimum_role``; otherwise raise 403.

    The demo project never grants management roles: only the synthetic
    ``member`` row is returned, which is enough for read endpoints that
    use ``minimum_role="member"``.
    """
    membership = require_project_member(session, project_id, user_id)
    if not _role_at_least(membership.role, minimum_role):
        raise HTTPException(
            status_code=403,
            detail=f"Project role required: {minimum_role}",
        )
    return membership


def _synthetic_demo_membership(user_id: str) -> ProjectMembershipDB:
    """Construct an in-memory viewer membership for the world-readable demo project."""
    now = datetime.now(timezone.utc)
    return ProjectMembershipDB(
        id=f"demo-{user_id}",
        project_id=DEMO_PROJECT_ID,
        user_id=user_id,
        role="viewer",
        created_at=now,
        updated_at=now,
    )


def _legacy_owner_membership(
    project_id: str, user_id: str
) -> ProjectMembershipDB:
    """Synthetic owner membership for legacy/ad-hoc projects without a ProjectDB row.

    Transition: existing tests and SDK ingestion flows may reference
    project names that have no ``ProjectDB`` row (and therefore no memberships).
    Rather than break those flows, treat the acting user as an implicit owner
    of any non-existent project. Once a project is created through the proper
    API, real membership rows take over and this fallback stops applying.
    """
    now = datetime.now(timezone.utc)
    return ProjectMembershipDB(
        id=f"legacy-{project_id}-{user_id}",
        project_id=project_id,
        user_id=user_id,
        role="owner",
        created_at=now,
        updated_at=now,
    )


def require_project_role_strict(
    session: Session,
    project_id: str,
    user_id: str,
    *,
    minimum_role: str,
) -> ProjectMembershipDB:
    """Strict variant for **mint** paths: demands a real project + membership.

    Unlike :func:`require_project_role_or_legacy`, this never falls back
    to the synthetic legacy owner. If ``project_id`` does not resolve to
    a ``ProjectDB`` row, it raises 404 instead. This is the helper to
    use when creating *new* resources scoped to a project (e.g. minting
    an API key) — it prevents the quirk where any authenticated user
    could mint a key against an arbitrary nonexistent project id.

    See `apo issue #11 <https://github.com/samikuikka/apo/issues/11>`_.
    """
    from ..models.db import ProjectDB

    if project_id == DEMO_PROJECT_ID:
        # Demo is a real project row; normal membership rules apply.
        return require_project_role(
            session, project_id, user_id, minimum_role=minimum_role
        )

    project = session.get(ProjectDB, project_id)
    if project is None:
        raise HTTPException(
            status_code=404,
            detail="Project not found",
        )
    return require_project_role(
        session, project_id, user_id, minimum_role=minimum_role
    )


def enforce_project_role_from_request(
    request: object,
    session: Session,
    project_id: str,
    *,
    minimum_role: ProjectRole,
) -> ProjectMembershipDB:
    """Compatibility wrapper: delegate to the canonical policy.

    Existing ``enforce_*_from_request`` helpers remain
    as thin wrappers over :func:`authorize_project_request` so routes that
    already call them pick up Credential Authority semantics without a
    per-call rewrite.
    """
    return authorize_project_request(
        request, session, project_id, minimum_role=minimum_role
    )


def enforce_project_read_from_request(
    request: object,
    session: Session,
    project_id: str,
) -> ProjectMembershipDB:
    """Compatibility wrapper: canonical policy at viewer role (the read floor)."""
    return authorize_project_request(request, session, project_id, minimum_role="viewer")


def list_readable_projects_from_request(
    request: object,
    session: Session,
) -> list[str] | None:
    """Compatibility wrapper: delegate to the canonical readable-Project policy."""
    return readable_project_ids_for_request(request, session)


# ---------------------------------------------------------------------------
# Canonical Project authorization policy
# ---------------------------------------------------------------------------

_RELEASE_PROFILES: Final[frozenset[str]] = frozenset({"local", "server"})


def _is_release_profile() -> bool:
    """True when the deployment profile enforces fail-closed authorization.

    Reads ``APO_DEPLOYMENT_PROFILE`` fresh each call so tests can flip it via
    ``monkeypatch.setenv``. Unknown values fall back to ``development`` (the
    safe direction — never silently escalate to release-grade fail-closed
    behavior the env did not earn).
    """
    import os

    return os.environ.get("APO_DEPLOYMENT_PROFILE", "").strip().lower() in _RELEASE_PROFILES


def _request_user_id(request: object) -> str | None:
    """Extract the authenticated user id from request state, if any."""
    state = getattr(request, "state", None)
    user_id = getattr(state, "user_id", None) if state else None
    return str(user_id) if user_id else None


def _request_auth_method(request: object) -> str | None:
    state = getattr(request, "state", None)
    return getattr(state, "auth_method", None) if state else None


def _request_credential_project(request: object) -> str | None:
    state = getattr(request, "state", None)
    project = getattr(state, "project", None) if state else None
    return str(project) if project else None


def authorize_project_request(
    request: object,
    session: Session,
    project_id: str,
    *,
    minimum_role: ProjectRole = "member",
) -> ProjectMembershipDB:
    """Intersect request Credential Authority with current Project role.

    Authorization policy.
    Every Project-owned route goes through this (or a resource-derived
    authorizer that calls it).

    Credential kinds:

    - **session**: require a current membership at ``minimum_role``.
    - **API key**: require ``request.state.project == project_id`` AND the
      key creator's current membership at ``minimum_role``. Membership is
      rechecked every request so removing the creator from the Project
      stops the key immediately.
    - **capability tokens** (Attempt / Executor / service): rejected here;
      they go through their own resource-specific authorizer.

    Project existence:

    - In a release profile (``local`` / ``server``), a nonexistent Project
      returns 404 — no synthetic owner fallback.
    - In development, the legacy owner fallback fires for nonexistent
      project strings (preserves local SDK/ingestion workflow).
    - Open-dev mode (``AUTH_SECRET`` unset) preserves the permissive local
      workflow; a release profile with missing identity returns 401.
    """
    if project_id == DEMO_PROJECT_ID:
        return _authorize_demo_project(request)

    auth_method = _request_auth_method(request)

    # API keys: enforce exact project binding first, then recheck membership.
    if auth_method == "api_key":
        return _authorize_api_key_request(
            request, session, project_id, minimum_role=minimum_role
        )

    # Session / unauthenticated request.
    user_id = _request_user_id(request)

    if not user_id:
        # No credential. The legacy/open-dev owner fallback is
        # allowed only in the explicit development profile. A release profile
        # requires real authority — missing identity is 401.
        if not _is_release_profile():
            return _legacy_owner_membership(project_id, "dev")
        raise HTTPException(status_code=401, detail="Authentication required")

    # Does the project exist?
    if session.get(ProjectDB, project_id) is None:
        if _is_release_profile():
            raise HTTPException(status_code=404, detail="Project not found")
        # Development: legacy owner fallback for ad-hoc project names.
        return _legacy_owner_membership(project_id, user_id)

    membership = get_project_membership(session, project_id, user_id)
    if membership is None:
        raise HTTPException(
            status_code=403, detail="You are not a member of this project"
        )
    if not _role_at_least(membership.role, minimum_role):
        raise HTTPException(
            status_code=403, detail=f"Project role required: {minimum_role}"
        )
    return membership


def _authorize_demo_project(request: object) -> ProjectMembershipDB:
    """The demo project is world-readable: synthetic ``viewer`` row.

    Anonymous demo visitors (the middleware-minted GET-only credential)
    read as viewer in every profile. Authenticated users also
    get viewer — the demo never grants management or mutation rights.
    """
    if _request_auth_method(request) == "anonymous":
        return _synthetic_demo_membership("anonymous")
    user_id = _request_user_id(request)
    if not user_id:
        if not _is_release_profile():
            return _synthetic_demo_membership("dev")
        raise HTTPException(status_code=401, detail="Authentication required")
    return _synthetic_demo_membership(user_id)


def _authorize_api_key_request(
    request: object,
    session: Session,
    project_id: str,
    *,
    minimum_role: ProjectRole,
) -> ProjectMembershipDB:
    """API-key path: project binding + creator membership recheck.

    The key is a Project credential, not a portable representation of its
    creator. Even if Alice is admin of both A and B, her A-bound key can
    only authorize A, and stops working the moment her A membership is
    removed.
    """
    credential_project = _request_credential_project(request)
    if credential_project != project_id:
        raise HTTPException(
            status_code=403, detail="API key is not bound to this project"
        )

    # The project must exist for an API key to authorize against it.
    if session.get(ProjectDB, project_id) is None:
        if _is_release_profile():
            raise HTTPException(status_code=404, detail="Project not found")
        # Development: nonexistent project — API keys are real credentials
        # minted through strict paths, so the legacy fallback does NOT fire
        # for them. Deny instead.
        raise HTTPException(status_code=404, detail="Project not found")

    user_id = _request_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    membership = get_project_membership(session, project_id, user_id)
    if membership is None:
        raise HTTPException(
            status_code=403, detail="You are not a member of this project"
        )
    if not _role_at_least(membership.role, minimum_role):
        raise HTTPException(
            status_code=403, detail=f"Project role required: {minimum_role}"
        )
    return membership


def readable_project_ids_for_request(
    request: object,
    session: Session,
) -> list[str] | None:
    """Return the exact readable Project IDs for this request's credential.

    T derivation:

    - **session**: all current memberships;
    - **API key**: exactly its bound Project, IF the creator still has
      membership there (rechecked every request);
    - **unauthenticated in open-dev**: ``None`` means "no Project scope"
      — preserves the legacy local-development behavior where every
      readable Project is visible. In a release profile, unauthenticated
      requests raise 401 before reaching this point.

    An empty list means "authenticated but has no readable Projects" —
    callers apply ``WHERE project IN ([])`` and return an empty result,
    not the entire database.
    """
    auth_method = _request_auth_method(request)

    # Anonymous demo visitors read exactly the demo project.
    # This branch must precede the no-identity handling below: the anonymous
    # credential carries no user_id by design.
    if auth_method == "anonymous":
        return [DEMO_PROJECT_ID]

    if auth_method == "api_key":
        credential_project = _request_credential_project(request)
        if not credential_project:
            return []
        user_id = _request_user_id(request)
        if not user_id:
            return []
        # Recheck creator membership before trusting the binding.
        if (
            session.get(ProjectDB, credential_project) is not None
            and get_project_membership(session, credential_project, user_id) is not None
        ):
            return [credential_project]
        return []

    user_id = _request_user_id(request)
    if not user_id:
        if not _is_release_profile():
            return None
        raise HTTPException(status_code=401, detail="Authentication required")

    return list_projects_for_user(session, user_id)


# ---------------------------------------------------------------------------
# Permission derivation
# ---------------------------------------------------------------------------


def compute_permissions(role: str | None) -> ProjectPermissionSummary:
    """Derive a permission summary from a project role.

    ``viewer`` is the read-only role: no mutations, no
    management, no per-user writes. The demo project hands every visitor
    (including anonymous) a viewer membership, so the old ``role=None``
    ``can_run_tasks=True`` fiction is gone — the None branch remains only
    as the unknown-role fallback.
    """
    if role == "viewer":
        return ProjectPermissionSummary(
            role="viewer",
            can_manage_project=False,
            can_manage_members=False,
            can_run_tasks=False,
            can_edit_scores=False,
        )
    if role is None:
        return ProjectPermissionSummary(
            role=None,
            can_manage_project=False,
            can_manage_members=False,
            can_run_tasks=False,
            can_edit_scores=False,
        )
    if role == "member":
        return ProjectPermissionSummary(
            role="member",
            can_manage_project=False,
            can_manage_members=False,
            can_run_tasks=True,
            can_edit_scores=True,
        )
    if role == "admin":
        return ProjectPermissionSummary(
            role="admin",
            can_manage_project=True,
            can_manage_members=True,
            can_run_tasks=True,
            can_edit_scores=True,
        )
    if role == "owner":
        return ProjectPermissionSummary(
            role="owner",
            can_manage_project=True,
            can_manage_members=True,
            can_run_tasks=True,
            can_edit_scores=True,
        )
    # Unknown role -> treat as no permissions
    return ProjectPermissionSummary(
        role=None,
        can_manage_project=False,
        can_manage_members=False,
        can_run_tasks=False,
        can_edit_scores=False,
    )


# ---------------------------------------------------------------------------
# Mutation helpers
# ---------------------------------------------------------------------------


def _validate_role(role: str) -> None:
    if role not in _VALID_ROLES:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid role '{role}'. Expected one of: owner, admin, member, viewer.",
        )


def _reject_grant_above_actor_rank(role: str, actor_role: str) -> None:
    """Grant-rank rule: an actor may grant at most their own rank.

    Admins can grant admin/member/viewer; only owners grant owner. The
    owner-specific checks at call sites keep their clearer messages and
    run first; this is the general floor beneath them.
    """
    if _ROLE_RANK.get(role, 0) > _ROLE_RANK.get(actor_role, 0):
        raise HTTPException(
            status_code=403,
            detail="Cannot grant a role above your own",
        )


def create_owner_membership(
    session: Session, project_id: str, user_id: str
) -> ProjectMembershipDB:
    """Create the initial ``owner`` membership for a freshly created project.

    Called from ``create_project`` so every non-demo project has at
    least one owner from the moment it exists.
    """
    now = datetime.now(timezone.utc)
    membership = ProjectMembershipDB(
        project_id=project_id,
        user_id=user_id,
        role="owner",
        created_at=now,
        updated_at=now,
    )
    session.add(membership)
    session.commit()
    session.refresh(membership)
    return membership


def add_member(
    session: Session,
    project_id: str,
    email: str,
    role: str,
    *,
    actor_role: str,
) -> ProjectMemberSummary:
    """Add a user to a project by email.

    ``actor_role`` is the role of the user performing the action; used to
    prevent members from promoting themselves via this path.
    """
    _validate_role(role)
    if role == "owner" and actor_role != "owner":
        raise HTTPException(
            status_code=403,
            detail="Only owners can add new owners to a project",
        )
    _reject_grant_above_actor_rank(role, actor_role)

    user = session.exec(select(UserDB).where(UserDB.email == email)).first()
    if user is None:
        raise HTTPException(
            status_code=404,
            detail=(
                "No user found with that email. Ask them to create an "
                "account first, then add them as a member."
            ),
        )

    existing = get_project_membership(session, project_id, user.id)
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail="User is already a member of this project",
        )

    now = datetime.now(timezone.utc)
    membership = ProjectMembershipDB(
        project_id=project_id,
        user_id=user.id,
        role=role,
        created_at=now,
        updated_at=now,
    )
    session.add(membership)
    session.commit()
    session.refresh(membership)
    return to_member_summary(membership, user)


def update_member_role(
    session: Session,
    project_id: str,
    user_id: str,
    new_role: str,
    *,
    actor_id: str,
    actor_role: str,
) -> ProjectMemberSummary:
    """Change the role of an existing member.

    Enforces:
    - the new role is valid;
    - non-owners cannot promote anyone to ``owner``;
    - admins cannot demote owners;
    - the project always retains at least one owner.
    """
    _validate_role(new_role)

    membership = get_project_membership(session, project_id, user_id)
    if membership is None:
        raise HTTPException(status_code=404, detail="Membership not found")

    user = session.get(UserDB, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    # Promotion to owner is owner-only.
    if new_role == "owner" and actor_role != "owner":
        raise HTTPException(
            status_code=403,
            detail="Only owners can promote members to owner",
        )
    _reject_grant_above_actor_rank(new_role, actor_role)

    # Only owners can demote another owner (other than themselves, which
    # is allowed under last-owner protection below).
    if membership.role == "owner" and actor_role != "owner":
        raise HTTPException(
            status_code=403,
            detail="Only owners can change another owner's role",
        )

    # Last-owner protection: if we're demoting/removing the only owner,
    # the project would be orphaned.
    if (
        membership.role == "owner"
        and new_role != "owner"
        and count_owners(session, project_id) <= 1
    ):
        raise HTTPException(
            status_code=400,
            detail="Cannot demote the last owner of a project",
        )

    membership.role = new_role
    membership.updated_at = datetime.now(timezone.utc)
    session.add(membership)
    session.commit()
    session.refresh(membership)
    _ = actor_id  # reserved for future audit hooks
    return to_member_summary(membership, user)


def remove_member(
    session: Session,
    project_id: str,
    user_id: str,
    *,
    actor_id: str,
    actor_role: str,
) -> None:
    """Remove a member from a project, enforcing last-owner protection."""
    membership = get_project_membership(session, project_id, user_id)
    if membership is None:
        raise HTTPException(status_code=404, detail="Membership not found")

    if membership.role == "owner" and actor_role != "owner":
        raise HTTPException(
            status_code=403,
            detail="Only owners can remove another owner",
        )

    if membership.role == "owner" and count_owners(session, project_id) <= 1:
        raise HTTPException(
            status_code=400,
            detail="Cannot remove the last owner of a project",
        )

    # a User leaving the Project can no longer run their schedules'
    # source-owned work, so pause theirs rather than silently retargeting it.
    _pause_source_owned_schedules_for_user(session, project_id=project_id, user_id=user_id)

    session.delete(membership)
    session.commit()
    _ = actor_id


def _pause_source_owned_schedules_for_user(
    session: Session, *, project_id: str, user_id: str
) -> None:
    """Hard-pause source-owned schedules whose owner left the Project."""
    schedules = session.exec(
        select(AgentTaskScheduleDB).where(
            AgentTaskScheduleDB.project == project_id,
            AgentTaskScheduleDB.execution_kind == "source_owned",
            AgentTaskScheduleDB.execution_owner_user_id == user_id,
        )
    ).all()
    if not schedules:
        return
    for schedule in schedules:
        schedule.enabled = False
        schedule.disabled_reason = "execution_owner_unavailable"
        schedule.next_run_at = None
        session.add(schedule)
    session.flush()


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def to_member_summary(
    membership: ProjectMembershipDB, user: UserDB
) -> ProjectMemberSummary:
    """Convert a membership row + its user into the API schema."""
    return ProjectMemberSummary(
        user_id=user.id,
        email=user.email,
        name=user.name,
        role=membership.role,
        is_active=user.is_active,
        joined_at=membership.created_at,
    )


def serialize_members(
    session: Session, project_id: str
) -> list[ProjectMemberSummary]:
    """Return all members of a project as API summaries."""
    rows = list_memberships_for_project(session, project_id)
    summaries: list[ProjectMemberSummary] = []
    for membership in rows:
        user = session.get(UserDB, membership.user_id)
        if user is None:
            continue
        summaries.append(to_member_summary(membership, user))
    summaries.sort(key=lambda m: (m.role != "owner", m.role != "admin", m.role == "viewer", m.email))
    return summaries
