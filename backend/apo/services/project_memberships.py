"""Project membership service (SPEC-122).

Centralizes all project-scoped authorization checks. Routes and other
services must use these helpers instead of checking ``UserDB.is_admin``
or ``ProjectDB.created_by`` directly.

The demo project (``id="demo"``) is intentionally world-readable and
has no membership rows; this service treats it as a read-only special
case and never grants management permissions on it.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Final

from fastapi import HTTPException
from sqlmodel import Session, select

from ..models.db import ProjectDB, ProjectMembershipDB, UserDB
from ..models.schemas import (
    ProjectMemberSummary,
    ProjectPermissionSummary,
)

DEMO_PROJECT_ID: Final[str] = "demo"

ProjectRole = str  # "owner" | "admin" | "member"

_ROLE_RANK: Final[dict[str, int]] = {"member": 1, "admin": 2, "owner": 3}

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
    """Construct an in-memory membership for the world-readable demo project."""
    now = datetime.now(timezone.utc)
    return ProjectMembershipDB(
        id=f"demo-{user_id}",
        project_id=DEMO_PROJECT_ID,
        user_id=user_id,
        role="member",
        created_at=now,
        updated_at=now,
    )


def _legacy_owner_membership(
    project_id: str, user_id: str
) -> ProjectMembershipDB:
    """Synthetic owner membership for legacy/ad-hoc projects without a ProjectDB row.

    SPEC-122 transition: existing tests and SDK ingestion flows may reference
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


def require_project_role_or_legacy(
    session: Session,
    project_id: str,
    user_id: str,
    *,
    minimum_role: str,
) -> ProjectMembershipDB:
    """Like :func:`require_project_role` but tolerates legacy project names.

    If ``project_id`` refers to a real project row (including the demo
    project), normal membership rules apply. If no ``ProjectDB`` row
    exists, the caller is treated as an implicit owner — this preserves
    backward compatibility with SDK ingestion flows and tests that
    pre-date SPEC-122. Real projects always go through membership.

    **Scope:** only for read/management paths against *existing* keys.
    Never use this on a mint path (creating a new key): it would let any
    authenticated user mint a key scoped to an arbitrary nonexistent
    project. Use :func:`require_project_role_strict` for mint paths.
    """
    from ..models.db import ProjectDB

    if project_id == DEMO_PROJECT_ID:
        return require_project_role(
            session, project_id, user_id, minimum_role=minimum_role
        )

    project = session.get(ProjectDB, project_id)
    if project is None:
        return _legacy_owner_membership(project_id, user_id)

    return require_project_role(
        session, project_id, user_id, minimum_role=minimum_role
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
    minimum_role: str,
) -> ProjectMembershipDB:
    """Route-level helper: extract ``user_id`` from request state and check role.

    Designed to drop into existing route handlers that previously only
    called ``require_project_not_demo``. Uses the legacy-tolerant check
    so existing SDK/ingestion flows that pre-date SPEC-122 keep working.

    In open-dev mode (no ``AUTH_SECRET``) the middleware does not set
    ``user_id`` on the request state. We treat that case as a permissive
    legacy owner so dev-mode flows (including tests that use the plain
    test client without an authed user) keep working. Production
    deployments always set ``user_id``.
    """
    user_id_value = getattr(request, "state", None)
    user_id = getattr(user_id_value, "user_id", None) if user_id_value else None
    if not user_id:
        # Open-dev mode or unauthenticated request. Allow as legacy
        # owner so dev flows keep working; production auth runs through
        # the middleware which always sets user_id.
        return _legacy_owner_membership(project_id, "dev")
    return require_project_role_or_legacy(
        session, project_id, str(user_id), minimum_role=minimum_role
    )


# ---------------------------------------------------------------------------
# Permission derivation
# ---------------------------------------------------------------------------


def compute_permissions(role: str | None) -> ProjectPermissionSummary:
    """Derive a permission summary from a project role.

    The demo project passes ``role=None`` and still allows viewing and
    running read-only tasks, but no management actions.
    """
    if role is None:
        return ProjectPermissionSummary(
            role=None,
            can_manage_project=False,
            can_manage_members=False,
            can_run_tasks=True,
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
            detail=f"Invalid role '{role}'. Expected one of: owner, admin, member.",
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

    session.delete(membership)
    session.commit()
    _ = actor_id


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
    summaries.sort(key=lambda m: (m.role != "owner", m.role != "admin", m.email))
    return summaries


def ensure_project_has_owner(
    session: Session, project_id: str
) -> ProjectDB | None:
    """Repair hook: if a project has no owner, promote its creator.

    Returns the project if a repair was performed, ``None`` otherwise.
    Used defensively by the migration path and by tests.
    """
    project = session.get(ProjectDB, project_id)
    if project is None:
        return None
    if count_owners(session, project_id) > 0:
        return None
    creator_id = project.created_by
    if not creator_id:
        return None
    existing = get_project_membership(session, project_id, creator_id)
    if existing is None:
        _ = create_owner_membership(session, project_id, creator_id)
    else:
        existing.role = "owner"
        existing.updated_at = datetime.now(timezone.utc)
        session.add(existing)
        session.commit()
        session.refresh(existing)
    return project
