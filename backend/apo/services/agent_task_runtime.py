"""Agent task runtime packaging service (SPEC-125).

Resolves the deployable agent-task runtime that the backend shells out
to when executing agent tasks. The runtime is an ESM bundle produced by
``packages/sdk/scripts/build-agent-task-runtime.mjs`` and copied into
``/app/agent-task-runtime`` in the container image.

In container mode, the runner path is ``$AGENT_TASK_RUNTIME_DIR/runner.mjs``
(default ``/app/agent-task-runtime/runner.mjs``). In local dev, the
runtime falls back to the repo's ``tsx`` binary plus the live TypeScript
entrypoint so contributors do not need to rebuild the bundle on every
change.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel

from .readiness import ReadinessCheckResult


class AgentTaskRuntimeStatus(BaseModel):
    """Operator-visible status of the packaged agent-task runtime."""

    available: bool
    node_version: str | None = None
    runner_path: str | None = None
    error: str | None = None


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_RUNTIME_DIR = Path("/app/agent-task-runtime")
DEV_REPO_ROOT = Path(__file__).resolve().parents[3]
DEV_RUNNER_ENTRY = (
    DEV_REPO_ROOT / "packages" / "sdk" / "src" / "agent-task" / "runner-entry.ts"
)
DEV_TSX_BIN = DEV_REPO_ROOT / "node_modules" / ".bin" / "tsx"


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


@dataclass
class _ResolvedRuntime:
    """Where and how to invoke the agent-task runtime."""

    available: bool
    node_path: str | None
    runner_argv: list[str]
    runner_path: str | None
    error: str | None


def _resolve_node_binary() -> str | None:
    """Return the path to ``node`` if available, else ``None``."""
    return shutil.which("node")


def _resolve_dev_tsx() -> str | None:
    """Return the path to ``tsx`` if the dev binary is present, else ``None``."""
    if DEV_TSX_BIN.exists():
        return str(DEV_TSX_BIN)
    return shutil.which("tsx")


def resolve_task_runtime() -> _ResolvedRuntime:
    """Resolve the runtime to use for executing agent tasks.

    Order of preference:

    1. Packaged bundle at ``$AGENT_TASK_RUNTIME_DIR/runner.mjs``
       (container / self-hosted alpha).
    2. Dev fallback using ``tsx`` against the live TypeScript entrypoint
       (local development).
    3. Unavailable.
    """
    node_bin = _resolve_node_binary()

    runtime_dir_env = os.environ.get("AGENT_TASK_RUNTIME_DIR")
    runtime_dir = (
        Path(runtime_dir_env) if runtime_dir_env else DEFAULT_RUNTIME_DIR
    )
    packaged_runner = runtime_dir / "runner.mjs"
    if node_bin and packaged_runner.exists():
        # --experimental-strip-types lets node load the .ts task files
        # that real task sources ship (the bundled runner.mjs is ESM but
        # the task definitions it dynamic-imports are TypeScript).
        return _ResolvedRuntime(
            available=True,
            node_path=node_bin,
            runner_argv=[
                node_bin,
                "--experimental-strip-types",
                str(packaged_runner),
            ],
            runner_path=str(packaged_runner),
            error=None,
        )

    tsx_bin = _resolve_dev_tsx()
    if tsx_bin and DEV_RUNNER_ENTRY.exists():
        return _ResolvedRuntime(
            available=True,
            node_path=tsx_bin,
            runner_argv=[tsx_bin, str(DEV_RUNNER_ENTRY)],
            runner_path=str(DEV_RUNNER_ENTRY),
            error=None,
        )

    if node_bin is None:
        return _ResolvedRuntime(
            available=False,
            node_path=None,
            runner_argv=[],
            runner_path=None,
            error=(
                "Agent task runtime is not installed in this deployment "
                "(node not found)"
            ),
        )

    return _ResolvedRuntime(
        available=False,
        node_path=node_bin,
        runner_argv=[],
        runner_path=None,
        error=(
            "Agent task runtime is not installed in this deployment "
            "(missing runner.mjs)"
        ),
    )


def _detect_node_version(node_bin: str) -> str | None:
    """Best-effort read of the ``node --version`` output."""
    try:
        completed = subprocess.run(
            [node_bin, "--version"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout.strip() or None


def get_task_runtime_status() -> AgentTaskRuntimeStatus:
    """Public status used by ``/v1/system/task-runtime``."""
    resolved = resolve_task_runtime()
    node_version = (
        _detect_node_version(resolved.node_path)
        if resolved.node_path
        else None
    )
    return AgentTaskRuntimeStatus(
        available=resolved.available,
        node_version=node_version,
        runner_path=resolved.runner_path,
        error=resolved.error,
    )


def probe_task_runtime() -> ReadinessCheckResult:
    """Readiness check used by SPEC-124's ``/health/ready``."""
    resolved = resolve_task_runtime()
    if resolved.available:
        return ReadinessCheckResult(
            name="task_runtime",
            ok=True,
            detail=resolved.runner_path,
        )
    return ReadinessCheckResult(
        name="task_runtime",
        ok=False,
        detail=resolved.error or "agent-task runtime unavailable",
    )
