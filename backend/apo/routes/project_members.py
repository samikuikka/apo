"""Project members API (SPEC-122).

Endpoints live under ``/v1/projects/{project_id}/members`` and are
gated by project role checks rather than ``UserDB.is_admin``. Admins
and owners can list, add, update, and remove members; ordinary members
receive ``403`` on every mutating endpoint.

SPEC-127 adds the sibling ``/v1/projects/{project_id}/invitations``
surface so admins/owners can invite users who do not yet have an
account. Invitations are project-scoped and never consult
``UserDB.is_admin``.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session

from ..auth.deps import DEMO_PROJECT_ID
from ..db import get_session
from ..models.db import ProjectDB
from ..models.schemas import (
    AddProjectMemberRequest,
    CreateProjectInvitationRequest,
    CreateProjectInvitationResponse,
    ProjectInvitationSummary,
    ProjectMemberSummary,
    UpdateProjectMemberRequest,
)
from ..services.project_invitations import (
    create_or_refresh_invitation,
    list_pending_invitations,
    resend_invitation,
    revoke_invitation,
)
from ..services.project_memberships import (
    add_member,
    remove_member,
    require_project_role,
    serialize_members,
    update_member_role,
)

router = APIRouter(prefix="/v1/projects", tags=["project-members"])


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if user_id:
        return str(user_id)
    raise HTTPException(status_code=401, detail="Authentication required")


def _ensure_project_exists(session: Session, project_id: str) -> ProjectDB:
    """Return the project or raise 404. Demo project is rejected."""
    if project_id == DEMO_PROJECT_ID:
        raise HTTPException(
            status_code=403,
            detail="Demo project does not have member management",
        )
    project = session.get(ProjectDB, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get(
    "/{project_id}/members",
    response_model=list[ProjectMemberSummary],
)
async def list_project_members(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> list[ProjectMemberSummary]:
    """List all members of a project. Requires admin/owner role."""
    user_id = _get_user_id(request)
    _ensure_project_exists(session, project_id)
    actor = require_project_role(
        session, project_id, user_id, minimum_role="admin"
    )
    _ = actor
    return serialize_members(session, project_id)


@router.post(
    "/{project_id}/members",
    response_model=ProjectMemberSummary,
    status_code=201,
)
async def add_project_member(
    project_id: str,
    body: AddProjectMemberRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> ProjectMemberSummary:
    """Add a member by email. Requires admin/owner role.

    Only owners can add a new owner directly; admins are limited to the
    ``member`` and ``admin`` roles.
    """
    user_id = _get_user_id(request)
    _ensure_project_exists(session, project_id)
    actor = require_project_role(
        session, project_id, user_id, minimum_role="admin"
    )
    return add_member(
        session,
        project_id=project_id,
        email=body.email.strip(),
        role=body.role,
        actor_role=actor.role,
    )


@router.patch(
    "/{project_id}/members/{user_id}",
    response_model=ProjectMemberSummary,
)
async def update_project_member(
    project_id: str,
    user_id: str,
    body: UpdateProjectMemberRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> ProjectMemberSummary:
    """Update a member's role. Requires admin/owner role.

    Promotions to ``owner`` are owner-only. Last-owner protection is
    enforced by the service layer.
    """
    actor_id = _get_user_id(request)
    _ensure_project_exists(session, project_id)
    actor = require_project_role(
        session, project_id, actor_id, minimum_role="admin"
    )
    if body.role is None:
        raise HTTPException(status_code=422, detail="role is required")
    return update_member_role(
        session,
        project_id=project_id,
        user_id=user_id,
        new_role=body.role,
        actor_id=actor_id,
        actor_role=actor.role,
    )


@router.delete("/{project_id}/members/{user_id}")
async def remove_project_member(
    project_id: str,
    user_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, bool]:
    """Remove a member from the project. Requires admin/owner role.

    Last-owner protection prevents orphaning a project.
    """
    actor_id = _get_user_id(request)
    _ensure_project_exists(session, project_id)
    actor = require_project_role(
        session, project_id, actor_id, minimum_role="admin"
    )
    remove_member(
        session,
        project_id=project_id,
        user_id=user_id,
        actor_id=actor_id,
        actor_role=actor.role,
    )
    _ = actor
    return {"ok": True}


# ---------------------------------------------------------------------------
# Project invitations (SPEC-127)
# ---------------------------------------------------------------------------


@router.get(
    "/{project_id}/invitations",
    response_model=list[ProjectInvitationSummary],
)
async def list_project_invitations(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> list[ProjectInvitationSummary]:
    """List active pending invitations. Requires admin/owner role."""
    user_id = _get_user_id(request)
    _ensure_project_exists(session, project_id)
    actor = require_project_role(
        session, project_id, user_id, minimum_role="admin"
    )
    _ = actor
    return list_pending_invitations(session, project_id=project_id)


@router.post(
    "/{project_id}/invitations",
    response_model=CreateProjectInvitationResponse,
    status_code=201,
)
async def create_project_invitation(
    project_id: str,
    body: CreateProjectInvitationRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> CreateProjectInvitationResponse:
    """Create (or refresh) an invitation. Requires admin/owner role.

    Owners can invite any role; admins are limited to ``member`` and
    ``admin``. Email delivery is best-effort: when SMTP is unavailable
    the response still succeeds and returns a copyable ``invite_url``.
    """
    user_id = _get_user_id(request)
    _ensure_project_exists(session, project_id)
    actor = require_project_role(
        session, project_id, user_id, minimum_role="admin"
    )
    return await create_or_refresh_invitation(
        session,
        project_id=project_id,
        body=body,
        invited_by_user_id=user_id,
        invited_by_role=actor.role,
    )


@router.post(
    "/{project_id}/invitations/{invitation_id}/resend",
    response_model=CreateProjectInvitationResponse,
)
async def resend_project_invitation(
    project_id: str,
    invitation_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> CreateProjectInvitationResponse:
    """Rotate token + extend expiry on an existing invitation."""
    user_id = _get_user_id(request)
    _ensure_project_exists(session, project_id)
    actor = require_project_role(
        session, project_id, user_id, minimum_role="admin"
    )
    _ = actor
    return await resend_invitation(
        session, project_id=project_id, invitation_id=invitation_id
    )


@router.delete("/{project_id}/invitations/{invitation_id}")
async def revoke_project_invitation(
    project_id: str,
    invitation_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, bool]:
    """Revoke a pending invitation. Soft-delete only; never hard-delete.

    Owner-role invitations may only be revoked by owners.
    """
    user_id = _get_user_id(request)
    _ensure_project_exists(session, project_id)
    actor = require_project_role(
        session, project_id, user_id, minimum_role="admin"
    )
    revoke_invitation(
        session,
        project_id=project_id,
        invitation_id=invitation_id,
        actor_role=actor.role,
    )
    return {"ok": True}
