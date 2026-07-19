"""Trace Projection response models (SPEC-130 Track A).

Immutable transport/read models for the Trace Projection snapshot shared by the
dashboard and agent-task assertions. These are pure pydantic ``BaseModel``
types — never SQLModel table classes — so consumers never receive or depend on
ORM rows. Canonical OpenTelemetry spans remain the source of truth; this
projection is a derived read model, not a domain entity.

The models serialize to the same lower-camel-case JSON contract as the
TypeScript SDK (``packages/sdk/src/agent-task/trace-projection/types.ts``).
Serialize with ``by_alias=True`` at the API boundary.
"""

from __future__ import annotations

from enum import StrEnum
from typing import ClassVar, Literal

from pydantic import BaseModel, ConfigDict


def to_camel(value: str) -> str:
    """Convert ``snake_case`` to ``lowerCamelCase`` for the JSON contract."""
    head, *tail = value.split("_")
    return head + "".join(part.title() for part in tail)


class EvidenceAvailability(StrEnum):
    """Whether a category of evidence is present in the projection."""

    AVAILABLE = "available"
    PARTIAL = "partial"
    UNAVAILABLE = "unavailable"


class ObservationStatus(StrEnum):
    """Lifecycle status of an observation. ``unset`` = the source had none."""

    UNSET = "unset"
    OK = "ok"
    ERROR = "error"


class TraceProjectionMessage(BaseModel):
    """One chat message reconstructed from a generation observation."""

    role: Literal["system", "user", "assistant", "tool"]
    content: str


class TraceProjectionObservation(BaseModel):
    """A derived interpretation of one Span.

    Unknown span kinds survive as ``SPAN``; hierarchy is preserved via
    ``parent_span_id``. Missing evidence is honest: absent optionals stay
    ``None`` rather than becoming empty/zero/success.
    """

    model_config: ClassVar[ConfigDict] = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    span_id: str
    parent_span_id: str | None = None
    type: Literal[
        "SPAN",
        "GENERATION",
        "TOOL",
        "AGENT",
        "SKILL",
        "CHAIN",
        "RETRIEVER",
        "EMBEDDING",
        "GUARDRAIL",
    ]
    name: str
    started_at: str | None = None
    ended_at: str | None = None
    duration_ms: float | None = None
    status: ObservationStatus = ObservationStatus.UNSET
    error_message: str | None = None
    input: object | None = None
    output: object | None = None
    model: str | None = None
    tool_name: str | None = None
    tool_parameters: object | None = None
    tool_result: object | None = None
    messages: tuple[TraceProjectionMessage, ...] = ()
    metadata: dict[str, object] | None = None


class TraceProjectionCapabilities(BaseModel):
    """Per-category evidence availability. Declared honestly per snapshot."""

    messages: EvidenceAvailability
    tools: EvidenceAvailability
    errors: EvidenceAvailability
    timing: EvidenceAvailability
    skills: EvidenceAvailability
    subagents: EvidenceAvailability


class TraceProjectionTrace(BaseModel):
    """Trace-level facts. All timing is optional; absence is honest."""

    model_config: ClassVar[ConfigDict] = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    trace_id: str
    task_run_id: str | None = None
    name: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    duration_ms: float | None = None
    complete: bool


class TraceProjectionSnapshot(BaseModel):
    """The immutable read snapshot.

    Identical JSON shape across canonical, local, and legacy-flow sources —
    only ``source`` and ``capabilities`` differ.
    """

    model_config: ClassVar[ConfigDict] = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    schema_version: Literal[1] = 1
    projection_version: int
    source: Literal["canonical", "local", "legacy-flow"]
    trace: TraceProjectionTrace
    capabilities: TraceProjectionCapabilities
    observations: tuple[TraceProjectionObservation, ...]
