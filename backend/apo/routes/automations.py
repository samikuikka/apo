"""Automation CRUD routes: create, list, get, patch, delete, rotate-secret, test, executions."""

# pyright: reportAny=false, reportArgumentType=false, reportCallInDefaultInitializer=false, reportImplicitStringConcatenation=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedImport=false

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from typing import cast

from sqlalchemy import delete as sa_delete
from sqlmodel import Session, col, select

from ..db_helpers import as_column

from ..auth.deps import get_user_id, require_api_key_scope
from ..db import get_session
from ..models.db import AutomationDB, AutomationExecutionDB
from ..services.automations import (
    ACTION_GITHUB_ISSUE,
    ACTION_SLACK,
    ACTION_WEBHOOK,
    MAX_AUTOMATIONS_PER_PROJECT,
    AutomationRequestError,
    AutomationSecretsUnavailable,
    deliver_test_event,
    encrypt_github_token,
    encrypt_webhook_secret,
    validate_action_config,
    validate_conditions,
    validate_event_type,
)
from ..services.automation_window_evaluator import (
    TRIGGER_EVENT,
    TRIGGER_WINDOW,
    WINDOW_EVENT_TYPE,
    compute_window_metric,
    deliver_window_test_event,
    threshold_breached,
    validate_window_conditions,
    validate_window_config,
)
from ..services.demo_workspace import require_project_not_demo
from ..services.project_memberships import (
    enforce_project_role_from_request,
    require_project_role_strict,
)
from ..services.webhook_delivery import generate_secret

router = APIRouter(prefix="/v1/automations", tags=["automations"])


class AutomationCreate(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=100)
    description: str | None = None
    # Required for event automations; window automations derive it.
    event_type: str | None = None
    # "event" (default, matches a single run event) or "window" (evaluator
    # computes an aggregate over a time window and fires on a threshold).
    trigger_kind: str = TRIGGER_EVENT
    conditions: list[dict[str, object]] = Field(default_factory=list)
    # Window-trigger knobs (required together when trigger_kind="window").
    window_metric: str | None = None
    window_operator: str | None = None
    window_threshold: float | None = None
    evaluation_window: str | None = None
    action_type: str
    action_config: dict[str, object]
    github_token: str | None = None
    # Slack actions carry the incoming-webhook URL in action_config.url;
    # it is validated there, stored encrypted, and only a masked tail is
    # ever returned in action_config.


class AutomationUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
    event_type: str | None = None
    trigger_kind: str | None = None
    conditions: list[dict[str, object]] | None = None
    window_metric: str | None = None
    window_operator: str | None = None
    window_threshold: float | None = None
    evaluation_window: str | None = None
    action_type: str | None = None
    action_config: dict[str, object] | None = None
    enabled: bool | None = None
    github_token: str | None = None


class AutomationResponse(BaseModel):
    id: str
    project_id: str
    name: str
    description: str | None
    event_type: str
    trigger_kind: str
    conditions: list[dict[str, object]]
    window_metric: str | None
    window_operator: str | None
    window_threshold: float | None
    evaluation_window: str | None
    was_breached: bool
    last_evaluated_at: datetime | None
    last_evaluated_value: float | None
    action_type: str
    action_config: dict[str, object]
    enabled: bool
    consecutive_failures: int
    last_delivery_at: datetime | None
    last_delivery_status: str | None
    created_at: datetime
    updated_at: datetime


class AutomationCreateResponse(AutomationResponse):
    # Present only for webhook actions: the one-time display of the signing
    # secret, mirrored from the create/rotate response only.
    secret: str | None = None


class AutomationSecretResponse(BaseModel):
    id: str
    secret: str


class AutomationTestResponse(BaseModel):
    success: bool
    error: str | None = None


class AutomationExecutionResponse(BaseModel):
    id: str
    event_type: str
    status: str
    input: dict[str, object]
    output: dict[str, object] | None
    error: str | None
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime


class AutomationExecutionPage(BaseModel):
    executions: list[AutomationExecutionResponse]


def _to_response(automation: AutomationDB) -> AutomationResponse:
    return AutomationResponse(
        id=automation.id,
        project_id=automation.project_id,
        name=automation.name,
        description=automation.description,
        event_type=automation.event_type,
        trigger_kind=automation.trigger_kind,
        conditions=automation.conditions or [],
        window_metric=automation.window_metric,
        window_operator=automation.window_operator,
        window_threshold=automation.window_threshold,
        evaluation_window=automation.evaluation_window,
        was_breached=automation.was_breached,
        last_evaluated_at=automation.last_evaluated_at,
        last_evaluated_value=automation.last_evaluated_value,
        action_type=automation.action_type,
        action_config=automation.action_config or {},
        enabled=automation.enabled,
        consecutive_failures=automation.consecutive_failures,
        last_delivery_at=automation.last_delivery_at,
        last_delivery_status=automation.last_delivery_status,
        created_at=automation.created_at,
        updated_at=automation.updated_at,
    )


def _get_automation_or_404(automation_id: str, session: Session) -> AutomationDB:
    automation = session.get(AutomationDB, automation_id)
    if automation is None:
        raise HTTPException(status_code=404, detail="Automation not found")
    return automation


def _map_automation_error(
    exc: AutomationRequestError | AutomationSecretsUnavailable,
) -> HTTPException:
    if isinstance(exc, AutomationRequestError):
        return HTTPException(status_code=exc.status_code, detail=exc.message)
    return HTTPException(status_code=503, detail=str(exc))


@router.post("", response_model=AutomationCreateResponse, status_code=201)
def create_automation(
    body: AutomationCreate,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """Create an automation. Project admin only; demo excluded.

    Webhook actions get a server-generated signing secret, shown once in this
    response. github_issue actions require a GitHub token, encrypted at rest.
    """
    require_project_not_demo(body.project_id)
    # Strict variant: a nonexistent project id must be a 404, not a mint.
    _ = require_project_role_strict(
        session,
        body.project_id,
        get_user_id(request),
        minimum_role="admin",
    )
    try:
        if body.trigger_kind == TRIGGER_WINDOW:
            validate_window_config(
                metric=body.window_metric,
                operator=body.window_operator,
                threshold=body.window_threshold,
                window=body.evaluation_window,
            )
            validate_window_conditions(body.conditions)
            event_type = WINDOW_EVENT_TYPE
        elif body.trigger_kind == TRIGGER_EVENT:
            if not body.event_type:
                raise AutomationRequestError("event_type is required for event automations")
            validate_event_type(body.event_type)
            validate_conditions(body.event_type, body.conditions)
            event_type = body.event_type
        else:
            raise AutomationRequestError(
                f"trigger_kind must be {TRIGGER_EVENT!r} or {TRIGGER_WINDOW!r}"
            )
        action_config = validate_action_config(body.action_type, body.action_config)
    except (AutomationRequestError, AutomationSecretsUnavailable) as exc:
        raise _map_automation_error(exc) from exc

    existing = session.exec(
        select(AutomationDB).where(
            col(AutomationDB.project_id) == body.project_id
        )
    ).all()
    if len(existing) >= MAX_AUTOMATIONS_PER_PROJECT:
        raise HTTPException(
            status_code=400,
            detail=f"Project already has the maximum of "
            f"{MAX_AUTOMATIONS_PER_PROJECT} automations",
        )

    secret_plaintext: str | None = None
    secret_stored: str | None = None
    github_token_encrypted: str | None = None
    slack_url_encrypted: str | None = None
    if body.action_type == ACTION_SLACK:
        raw_url = body.action_config.get("url")
        if isinstance(raw_url, str) and raw_url:
            try:
                slack_url_encrypted = encrypt_webhook_secret(raw_url)
            except AutomationSecretsUnavailable as exc:
                raise _map_automation_error(exc) from exc
    if body.action_type == ACTION_WEBHOOK:
        # Plaintext is echoed exactly once; only the encrypted form is stored.
        secret_plaintext = generate_secret()
        try:
            secret_stored = encrypt_webhook_secret(secret_plaintext)
        except AutomationSecretsUnavailable as exc:
            raise _map_automation_error(exc) from exc
    elif body.action_type == ACTION_GITHUB_ISSUE:
        if not body.github_token:
            raise HTTPException(
                status_code=400,
                detail="github_token is required for github_issue automations",
            )
        try:
            github_token_encrypted = encrypt_github_token(body.github_token)
        except AutomationSecretsUnavailable as exc:
            raise _map_automation_error(exc) from exc

    automation = AutomationDB(
        project_id=body.project_id,
        name=body.name,
        description=body.description,
        event_type=event_type,
        trigger_kind=body.trigger_kind,
        conditions=body.conditions,
        window_metric=body.window_metric,
        window_operator=body.window_operator,
        window_threshold=body.window_threshold,
        evaluation_window=body.evaluation_window,
        action_type=body.action_type,
        action_config=action_config,
        secret=secret_stored,
        github_token_encrypted=github_token_encrypted,
        slack_webhook_url_encrypted=slack_url_encrypted,
    )
    session.add(automation)
    session.commit()
    session.refresh(automation)
    response = AutomationCreateResponse(**_to_response(automation).model_dump())
    response.secret = secret_plaintext
    return response


@router.get("", response_model=list[AutomationResponse])
def list_automations(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """List a project's automations (never any secrets). Viewer-readable."""
    _ = enforce_project_role_from_request(
        request, session, project_id, minimum_role="viewer"
    )
    automations = session.exec(
        select(AutomationDB)
        .where(col(AutomationDB.project_id) == project_id)
        .order_by(as_column(cast(object, AutomationDB.created_at)).desc())
    ).all()
    return [_to_response(a) for a in automations]


@router.get("/{automation_id}", response_model=AutomationResponse)
def get_automation(
    automation_id: str,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """Return one automation's configuration (never its secrets)."""
    automation = _get_automation_or_404(automation_id, session)
    _ = enforce_project_role_from_request(
        request, session, automation.project_id, minimum_role="viewer"
    )
    return _to_response(automation)


@router.patch("/{automation_id}", response_model=AutomationResponse)
def update_automation(
    automation_id: str,
    body: AutomationUpdate,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """Patch an automation. Project admin only; demo excluded.

    action_type is immutable — delete and recreate to switch actions.
    Re-enabling (enabled=true) resets the failure counter.
    """
    automation = _get_automation_or_404(automation_id, session)
    require_project_not_demo(automation.project_id)
    _ = enforce_project_role_from_request(
        request, session, automation.project_id, minimum_role="admin"
    )

    if body.action_type is not None and body.action_type != automation.action_type:
        raise HTTPException(
            status_code=400,
            detail="action_type is immutable; create a new automation instead",
        )

    event_type = body.event_type or automation.event_type
    conditions = body.conditions
    if conditions is None:
        conditions = automation.conditions or []
    trigger_kind = body.trigger_kind or automation.trigger_kind
    if trigger_kind not in (TRIGGER_EVENT, TRIGGER_WINDOW):
        raise HTTPException(
            status_code=400,
            detail=f"trigger_kind must be {TRIGGER_EVENT!r} or {TRIGGER_WINDOW!r}",
        )
    # Editing a window trigger validates the merged knobs, not just the
    # patched ones — a PATCH that only changes the metric still needs the
    # stored operator/threshold/window to form a valid configuration.
    window_metric = body.window_metric
    if window_metric is None:
        window_metric = automation.window_metric
    window_operator = body.window_operator
    if window_operator is None:
        window_operator = automation.window_operator
    window_threshold = body.window_threshold
    if window_threshold is None:
        window_threshold = automation.window_threshold
    evaluation_window = body.evaluation_window
    if evaluation_window is None:
        evaluation_window = automation.evaluation_window
    try:
        if trigger_kind == TRIGGER_WINDOW:
            validate_window_config(
                metric=window_metric,
                operator=window_operator,
                threshold=window_threshold,
                window=evaluation_window,
            )
            validate_window_conditions(conditions)
            event_type = WINDOW_EVENT_TYPE
        elif body.event_type is not None:
            validate_event_type(event_type)
            validate_conditions(event_type, conditions)
        # Merge over the stored config: a partial PATCH (e.g. dashboard edit
        # sending only owner/repo) must not silently erase labels, title, or
        # body templates the rule was created with.
        merged_config = (
            {
                **(automation.action_config or {}),
                **(body.action_config or {}),
            }
            if body.action_config is not None
            else automation.action_config
        )
        if (
            automation.action_type == ACTION_SLACK
            and body.action_config is not None
            and not isinstance(body.action_config.get("url"), str)
        ):
            # Slack keep-existing: no url key means keep the stored URL and
            # its masked display — validating the merged config would demand
            # a plaintext URL the client was never shown.
            action_config = automation.action_config
        else:
            action_config = validate_action_config(
                automation.action_type, merged_config
            )
    except (AutomationRequestError, AutomationSecretsUnavailable) as exc:
        raise _map_automation_error(exc) from exc

    if body.name is not None:
        automation.name = body.name
    if body.description is not None:
        automation.description = body.description
    automation.trigger_kind = trigger_kind
    automation.event_type = event_type
    if body.conditions is not None:
        automation.conditions = conditions
    if trigger_kind == TRIGGER_WINDOW:
        automation.window_metric = window_metric
        automation.window_operator = window_operator
        automation.window_threshold = window_threshold
        automation.evaluation_window = evaluation_window
        # A changed trigger definition re-arms the rising edge.
        automation.was_breached = False
    if body.action_config is not None:
        automation.action_config = action_config
    if body.enabled is not None:
        automation.enabled = body.enabled
        if body.enabled:
            # Re-enabling is a human "I fixed it" signal: start the
            # auto-disable counter fresh instead of staying poisoned at the
            # threshold.
            automation.consecutive_failures = 0
    if body.github_token is not None and body.github_token != "":
        try:
            automation.github_token_encrypted = encrypt_github_token(
                body.github_token
            )
        except AutomationSecretsUnavailable as exc:
            raise _map_automation_error(exc) from exc
    if body.action_config is not None and automation.action_type == ACTION_SLACK:
        raw_url = body.action_config.get("url")
        if isinstance(raw_url, str) and raw_url:
            try:
                automation.slack_webhook_url_encrypted = encrypt_webhook_secret(
                    raw_url
                )
            except AutomationSecretsUnavailable as exc:
                raise _map_automation_error(exc) from exc

    session.add(automation)
    session.commit()
    session.refresh(automation)
    return _to_response(automation)


@router.delete("/{automation_id}", status_code=204)
def delete_automation(
    automation_id: str,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """Delete an automation and its execution log. Project admin only."""
    automation = _get_automation_or_404(automation_id, session)
    require_project_not_demo(automation.project_id)
    _ = enforce_project_role_from_request(
        request, session, automation.project_id, minimum_role="admin"
    )
    # Executions must be gone before the automation row: the FK is enforced
    # immediately, and SQLAlchemy's unit of work does not order bulk deletes
    # ahead of the parent delete in one flush.
    session.exec(
        sa_delete(AutomationExecutionDB).where(
            col(AutomationExecutionDB.automation_id) == automation_id
        )
    )
    session.commit()
    session.delete(automation)
    session.commit()


@router.post("/{automation_id}/rotate-secret", response_model=AutomationSecretResponse)
def rotate_secret(
    automation_id: str,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """Replace the webhook action's signing secret; shown once."""
    automation = _get_automation_or_404(automation_id, session)
    require_project_not_demo(automation.project_id)
    _ = enforce_project_role_from_request(
        request, session, automation.project_id, minimum_role="admin"
    )
    if automation.action_type != ACTION_WEBHOOK:
        raise HTTPException(
            status_code=400,
            detail="Only webhook automations have a signing secret to rotate",
        )
    # Store encrypted; the plaintext secret is returned exactly once.
    plaintext = generate_secret()
    automation.secret = encrypt_webhook_secret(plaintext)
    session.add(automation)
    session.commit()
    return AutomationSecretResponse(id=automation.id, secret=plaintext)


@router.post("/{automation_id}/test", response_model=AutomationTestResponse)
async def test_automation(
    automation_id: str,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """Deliver a synthetic event through the automation and report the result.

    Awaits delivery inline so the response reflects the real outcome. On
    github_issue automations this creates a real issue in the configured repo.
    Test deliveries never count toward the failure counter.
    """
    automation = _get_automation_or_404(automation_id, session)
    require_project_not_demo(automation.project_id)
    _ = enforce_project_role_from_request(
        request, session, automation.project_id, minimum_role="admin"
    )
    if automation.trigger_kind == TRIGGER_WINDOW:
        success, error = await deliver_window_test_event(automation, session)
        return AutomationTestResponse(success=success, error=error)
    success, error = await deliver_test_event(automation, session)
    return AutomationTestResponse(success=success, error=error)


@router.get("/{automation_id}/evaluation")
def get_evaluation(
    automation_id: str,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """Compute a window automation's metric right now (editor live readout)."""
    automation = _get_automation_or_404(automation_id, session)
    _ = enforce_project_role_from_request(
        request, session, automation.project_id, minimum_role="viewer"
    )
    if automation.trigger_kind != TRIGGER_WINDOW:
        raise HTTPException(
            status_code=400, detail="Only window automations are evaluated"
        )
    value = compute_window_metric(
        session,
        automation.project_id,
        automation.window_metric or "",
        automation.evaluation_window or "24h",
        automation.conditions or [],
    )
    return {
        "metric": automation.window_metric,
        "window": automation.evaluation_window,
        "value": value,
        "threshold": automation.window_threshold,
        "operator": automation.window_operator,
        "breached": threshold_breached(
            automation.window_operator or "lt",
            value,
            automation.window_threshold or 0.0,
        ),
    }


@router.get("/{automation_id}/executions", response_model=AutomationExecutionPage)
def list_executions(
    automation_id: str,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
    limit: int = 50,
):
    """List an automation's execution log, newest first (capped at 100)."""
    automation = _get_automation_or_404(automation_id, session)
    _ = enforce_project_role_from_request(
        request, session, automation.project_id, minimum_role="viewer"
    )
    if limit < 1 or limit > 100:
        raise HTTPException(
            status_code=400, detail="limit must be between 1 and 100"
        )
    executions = session.exec(
        select(AutomationExecutionDB)
        .where(col(AutomationExecutionDB.automation_id) == automation_id)
        .order_by(
            as_column(cast(object, AutomationExecutionDB.created_at)).desc(),
            as_column(cast(object, AutomationExecutionDB.id)).desc(),
        )
        .limit(limit)
    ).all()
    return AutomationExecutionPage(
        executions=[
            AutomationExecutionResponse(
                id=e.id,
                event_type=e.event_type,
                status=e.status,
                input=e.input or {},
                output=e.output,
                error=e.error,
                started_at=e.started_at,
                finished_at=e.finished_at,
                created_at=e.created_at,
            )
            for e in executions
        ]
    )
