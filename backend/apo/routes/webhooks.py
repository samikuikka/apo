"""Webhook CRUD routes: create, list, get, update, delete, rotate-secret, test."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..models.db import WebhookDB
from ..services.demo_workspace import require_project_not_demo
from ..services.project_memberships import enforce_project_role_from_request
from ..services.webhook_delivery import generate_secret, deliver_webhook
from ..services.run_events import ALL_EVENT_TYPES, RunEvent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/webhooks", tags=["webhooks"])


class WebhookCreate(BaseModel):
    project: str
    url: str
    description: str | None = None
    events: list[str] | None = None


class WebhookUpdate(BaseModel):
    url: str | None = None
    description: str | None = None
    events: list[str] | None = None
    enabled: bool | None = None


class WebhookResponse(BaseModel):
    id: int
    project: str
    url: str
    description: str | None
    events: list[str]
    enabled: bool
    last_delivery_at: datetime | None
    last_delivery_status: str | None
    consecutive_failures: int
    created_at: datetime
    updated_at: datetime


class WebhookSecretResponse(BaseModel):
    id: int
    secret: str


class WebhookTestResponse(BaseModel):
    success: bool
    status_code: int | None = None
    error: str | None = None


def _to_response(wh: WebhookDB) -> WebhookResponse:
    assert wh.id is not None
    return WebhookResponse(
        id=wh.id,
        project=wh.project,
        url=wh.url,
        description=wh.description,
        events=wh.events or [],
        enabled=wh.enabled,
        last_delivery_at=wh.last_delivery_at,
        last_delivery_status=wh.last_delivery_status,
        consecutive_failures=wh.consecutive_failures,
        created_at=wh.created_at,
        updated_at=wh.updated_at,
    )


@router.post("", response_model=WebhookSecretResponse, status_code=201)
def create_webhook(
    body: WebhookCreate,
    request: Request,
    session: Session = Depends(get_session),
):
    require_project_not_demo(body.project)
    # SPEC-122: webhook management requires project admin role.
    _ = enforce_project_role_from_request(
        request, session, body.project, minimum_role="admin"
    )
    if body.events:
        invalid = set(body.events) - set(ALL_EVENT_TYPES)
        if invalid:
            valid_list = ", ".join(ALL_EVENT_TYPES)
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid event types: {', '.join(sorted(invalid))}. "
                    f"Valid: {valid_list}"
                ),
            )

    secret = generate_secret()
    wh = WebhookDB(
        project=body.project,
        url=body.url,
        description=body.description,
        events=body.events or [],
        secret=secret,
    )
    session.add(wh)
    session.commit()
    session.refresh(wh)
    assert wh.id is not None
    return WebhookSecretResponse(id=wh.id, secret=secret)


@router.get("", response_model=list[WebhookResponse])
def list_webhooks(
    project: str,
    request: Request,
    session: Session = Depends(get_session),
):
    # SPEC-122: webhook inventory is admin-scoped ("webhooks are managed
    # by project admins/owners"). Members must not enumerate webhook
    # configurations for a project.
    _ = enforce_project_role_from_request(
        request, session, project, minimum_role="admin"
    )
    statement = select(WebhookDB).where(WebhookDB.project == project)
    webhooks = session.exec(statement).all()
    return [_to_response(wh) for wh in webhooks]


@router.get("/{webhook_id}", response_model=WebhookResponse)
def get_webhook(
    webhook_id: int,
    request: Request,
    session: Session = Depends(get_session),
):
    wh = session.get(WebhookDB, webhook_id)
    if wh is None:
        raise HTTPException(status_code=404, detail="Webhook not found")
    # SPEC-122: even single-webhook reads require admin role on the
    # webhook's project. Without this, any authenticated user who knows
    # a webhook id could inspect configuration for any project.
    _ = enforce_project_role_from_request(
        request, session, wh.project, minimum_role="admin"
    )
    return _to_response(wh)


@router.patch("/{webhook_id}", response_model=WebhookResponse)
def update_webhook(
    webhook_id: int,
    body: WebhookUpdate,
    request: Request,
    session: Session = Depends(get_session),
):
    wh = session.get(WebhookDB, webhook_id)
    if wh is None:
        raise HTTPException(status_code=404, detail="Webhook not found")

    require_project_not_demo(wh.project)
    # SPEC-122: webhook management requires project admin role.
    _ = enforce_project_role_from_request(
        request, session, wh.project, minimum_role="admin"
    )

    if body.url is not None:
        wh.url = body.url
    if body.description is not None:
        wh.description = body.description
    if body.events is not None:
        if body.events:
            invalid = set(body.events) - set(ALL_EVENT_TYPES)
            if invalid:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Invalid event types: "
                        f"{', '.join(sorted(invalid))}"
                    ),
                )
        wh.events = body.events
    if body.enabled is not None:
        wh.enabled = body.enabled

    wh.updated_at = datetime.now(timezone.utc)
    session.add(wh)
    session.commit()
    session.refresh(wh)
    return _to_response(wh)


@router.delete("/{webhook_id}", status_code=204)
def delete_webhook(
    webhook_id: int,
    request: Request,
    session: Session = Depends(get_session),
):
    wh = session.get(WebhookDB, webhook_id)
    if wh is None:
        raise HTTPException(status_code=404, detail="Webhook not found")
    require_project_not_demo(wh.project)
    # SPEC-122: webhook management requires project admin role.
    _ = enforce_project_role_from_request(
        request, session, wh.project, minimum_role="admin"
    )
    session.delete(wh)
    session.commit()


@router.post("/{webhook_id}/rotate-secret", response_model=WebhookSecretResponse)
def rotate_secret(
    webhook_id: int,
    request: Request,
    session: Session = Depends(get_session),
):
    wh = session.get(WebhookDB, webhook_id)
    if wh is None:
        raise HTTPException(status_code=404, detail="Webhook not found")

    require_project_not_demo(wh.project)
    # SPEC-122: webhook management requires project admin role.
    _ = enforce_project_role_from_request(
        request, session, wh.project, minimum_role="admin"
    )

    wh.secret = generate_secret()
    wh.updated_at = datetime.now(timezone.utc)
    session.add(wh)
    session.commit()
    session.refresh(wh)
    assert wh.id is not None
    return WebhookSecretResponse(id=wh.id, secret=wh.secret)


@router.post("/{webhook_id}/test", response_model=WebhookTestResponse)
async def test_webhook(
    webhook_id: int,
    request: Request,
    session: Session = Depends(get_session),
):
    import httpx

    wh = session.get(WebhookDB, webhook_id)
    if wh is None:
        raise HTTPException(status_code=404, detail="Webhook not found")

    require_project_not_demo(wh.project)
    # SPEC-122: webhook management requires project admin role.
    _ = enforce_project_role_from_request(
        request, session, wh.project, minimum_role="admin"
    )

    test_event = RunEvent(
        event_type="test",
        project=wh.project,
        data={"message": "Test webhook delivery"},
    )
    event_data = {
        "event_type": test_event.event_type,
        "project": test_event.project,
        "data": test_event.data,
        "timestamp": test_event.timestamp.isoformat(),
    }

    try:
        success = await deliver_webhook(wh, event_data)
        return WebhookTestResponse(success=success)
    except httpx.HTTPError as exc:
        return WebhookTestResponse(success=False, error=str(exc))
