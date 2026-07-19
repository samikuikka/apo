"""Shared readiness models (SPEC-124 / SPEC-125).

Lives outside ``runtime_config`` so individual readiness contributors
(e.g. SPEC-125's task-runtime probe) can return ``ReadinessCheckResult``
without importing the full runtime-config service. This avoids an
import cycle between the two modules.
"""

from __future__ import annotations

from pydantic import BaseModel


class ReadinessCheckResult(BaseModel):
    name: str
    ok: bool
    detail: str | None = None


class ReadinessReport(BaseModel):
    ok: bool
    checks: dict[str, ReadinessCheckResult]
