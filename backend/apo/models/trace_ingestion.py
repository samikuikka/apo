"""Authenticated ingestion context for the OTLP trace path (SPEC-131 Milestone 3).

A typed context carried from the auth middleware through the receiver and
projector so that Task Run claims are subject- and project-bound rather than
trusted from telemetry attributes.

Rules (SPEC-131 §Authenticated ingestion context):

- ``project_id`` always comes from verified request state, never telemetry.
- A service token may submit a root ``apo.task.run.id`` only when it exactly
  matches ``service_task_run_id``.
- An API key may ingest ordinary telemetry but may not claim a Task Run.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

_ALLOWED_AUTH_METHODS = {"api_key", "service_token", "cookie", "open_dev"}


class TraceIngestionContext(BaseModel):
    """The authenticated context bound to one OTLP ingest request.

    ``project_id`` is always auth-derived. ``service_task_run_id`` is set only
    for service-token auth and is the subject the claim must match.
    """

    model_config = ConfigDict(frozen=True)

    project_id: str
    auth_method: Literal["api_key", "service_token", "cookie", "open_dev"]
    service_task_run_id: str | None = None

    @property
    def may_claim_task_run(self) -> bool:
        """Only a service token may attempt a Task Run claim."""
        return self.auth_method == "service_token" and self.service_task_run_id is not None

    @classmethod
    def for_request_state(
        cls,
        *,
        project_id: str,
        auth_method: object,
        service_task_run_id: object,
    ) -> TraceIngestionContext:
        """Build a context from loosely-typed ``request.state`` values.

        Narrows the auth method to the allowed literal set, coercing anything
        unexpected to ``open_dev`` (least privilege: no Task Run claim).
        """
        if auth_method == "api_key":
            method: Literal["api_key", "service_token", "cookie", "open_dev"] = "api_key"
        elif auth_method == "service_token":
            method = "service_token"
        elif auth_method == "cookie":
            method = "cookie"
        else:
            method = "open_dev"
        task_run_id = service_task_run_id if isinstance(service_task_run_id, str) else None
        return cls(
            project_id=project_id,
            auth_method=method,
            service_task_run_id=task_run_id,
        )
