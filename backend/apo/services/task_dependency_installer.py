"""Task dependency installation service (SPEC-125 hardening).

Real task sources — synced Git repos or filesystem paths beyond the
in-repo example-service — almost always need their own dependencies
installed before ``runner.mjs`` can load their task modules. Without a
deterministic install step, self-hosted task execution fails on every
real user repo with cryptic module-resolution errors.

Policy
------

* **When:** lazily before each task run, but only when the lockfile hash
  has changed since the last successful install for that workspace.
* **What:** Node (npm/pnpm/yarn) and Python (uv/poetry/pip). Future
  ecosystems must be added here explicitly — silent skipping is not an
  option.
* **Cache:** per-workspace install marker keyed by the content hash of
  every detected lockfile. Lives under ``TASK_INSTALL_CACHE_DIR``
  (defaults to ``<task_source_cache>/installs``).
* **Timeouts / limits:** ``TASK_INSTALL_TIMEOUT_SECONDS`` (default 180)
  and ``TASK_INSTALL_DISABLE`` (escape hatch).
* **Failure:** raise a single :class:`TaskDependencyInstallError` with
  the operator-readable command + captured stderr. Never crash the
  backend process; the batch runner maps this onto a normal ``error``
  task run.
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .runtime_config import task_source_cache_dir

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants + env-tunable policy
# ---------------------------------------------------------------------------


DEFAULT_INSTALL_TIMEOUT_SECONDS = 180

_NODE_LOCKFILES = ("package-lock.json", "pnpm-lock.yaml", "yarn.lock")
_PYTHON_LOCKFILES = ("uv.lock", "poetry.lock", "requirements.txt")


class TaskDependencyInstallError(RuntimeError):
    """Raised when a task workspace's dependency install fails.

    The message is safe to surface to operators — it includes the
    command, working directory, and a trimmed stderr/stdout excerpt.
    """


@dataclass
class _InstallPlan:
    """A single install command to run for a workspace."""

    ecosystem: str
    command: list[str]
    lockfile: str


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def is_install_disabled() -> bool:
    """Operator escape hatch. Disables all install attempts when true."""
    return os.environ.get("TASK_INSTALL_DISABLE", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def install_task_dependencies(workspace_dir: Path) -> None:
    """Install dependencies for a task workspace, cached by lockfile hash.

    Raises :class:`TaskDependencyInstallError` if any install fails, so
    callers can map the failure to an operator-readable task-run error
    rather than a platform crash.
    """
    if is_install_disabled():
        logger.info(
            "Task dependency install skipped (TASK_INSTALL_DISABLE=1) for workspace %s",
            workspace_dir,
        )
        return

    if _is_backend_root(workspace_dir):
        # The workspace detector can walk past the task source tree and
        # land on the backend's own root (which has its own pyproject.toml
        # / package.json). Installing there would mutate the backend's
        # runtime, so we skip. Real task sources must have their lockfile
        # within their own tree.
        logger.info(
            "Task dependency install skipped for %s — detected workspace is "
            "the backend root, not a task workspace",
            workspace_dir,
        )
        return

    plans = _detect_install_plans(workspace_dir)
    if not plans:
        # No lockfile → nothing to install. This is fine for the bundled
        # example-service tasks (which rely on the SDK resolved via the
        # monorepo workspace) but would be a smell in a real Git source.
        return

    cache_root = _install_cache_root()
    marker = cache_root / _workspace_cache_key(workspace_dir, plans) / ".installed"

    if marker.exists():
        logger.info(
            "Task dependencies already installed for %s (cache hit at %s)",
            workspace_dir,
            marker.parent,
        )
        return

    marker.parent.mkdir(parents=True, exist_ok=True)

    for plan in plans:
        _run_install_plan(plan, workspace_dir)

    # Touch the marker last so a partial install never looks complete.
    _ = marker.write_text("ok\n", encoding="utf-8")
    logger.info(
        "Task dependencies installed for %s (marker at %s)",
        workspace_dir,
        marker,
    )


def _is_backend_root(workspace_dir: Path) -> bool:
    """True when the detected workspace is the backend's own install root.

    The workspace detector can walk past a task source tree that has no
    package marker of its own and land on /app (the backend's WORKDIR).
    That root contains the backend's pyproject.toml / package.json and
    must never be the target of a task-workspace install.
    """
    candidate = workspace_dir.resolve()
    backend_root = Path(__file__).resolve().parents[2]
    try:
        candidate.relative_to(backend_root)
    except ValueError:
        return False
    # Only treat it as the backend root if it contains the apo package.
    return (backend_root / "apo" / "api.py").exists()


# ---------------------------------------------------------------------------
# Internal: plan detection
# ---------------------------------------------------------------------------


def _detect_install_plans(workspace_dir: Path) -> list[_InstallPlan]:
    """Return one install plan per detected ecosystem, in a stable order.

    Node plans precede Python plans because Node dependencies are more
    common in this codebase and faster to install when cached.
    """
    plans: list[_InstallPlan] = []
    plans.extend(_detect_node_plan(workspace_dir))
    plans.extend(_detect_python_plan(workspace_dir))
    return plans


def _detect_node_plan(workspace_dir: Path) -> list[_InstallPlan]:
    for lockfile in _NODE_LOCKFILES:
        if (workspace_dir / lockfile).exists():
            manager = _node_manager_for_lockfile(lockfile)
            return [
                _InstallPlan(
                    ecosystem="node",
                    command=_node_install_command(manager),
                    lockfile=lockfile,
                )
            ]
    return []


def _node_manager_for_lockfile(lockfile: str) -> str:
    if lockfile == "pnpm-lock.yaml":
        return "pnpm"
    if lockfile == "yarn.lock":
        return "yarn"
    return "npm"


def _node_install_command(manager: str) -> list[str]:
    # ``--no-audit --no-fund`` keep npm quiet; ``--frozen-lockfile``
    # (pnpm) / ``--immutable`` (yarn) fail loudly on lockfile drift.
    if manager == "pnpm":
        return ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"]
    if manager == "yarn":
        return ["yarn", "install", "--immutable", "--immutable-cache"]
    return ["npm", "ci", "--no-audit", "--no-fund", "--prefer-offline"]


def _detect_python_plan(workspace_dir: Path) -> list[_InstallPlan]:
    if (workspace_dir / "pyproject.toml").exists():
        for lockfile in ("uv.lock", "poetry.lock"):
            if (workspace_dir / lockfile).exists():
                if lockfile == "uv.lock":
                    return [
                        _InstallPlan(
                            ecosystem="python",
                            command=["uv", "sync", "--frozen"],
                            lockfile=lockfile,
                        )
                    ]
                return [
                    _InstallPlan(
                        ecosystem="python",
                        command=["poetry", "install", "--no-root"],
                        lockfile=lockfile,
                    )
                ]
    if (workspace_dir / "requirements.txt").exists():
        return [
            _InstallPlan(
                ecosystem="python",
                command=[
                    "pip",
                    "install",
                    "--no-input",
                    "--disable-pip-version-check",
                    "-r",
                    "requirements.txt",
                ],
                lockfile="requirements.txt",
            )
        ]
    return []


# ---------------------------------------------------------------------------
# Internal: install execution
# ---------------------------------------------------------------------------


def _run_install_plan(plan: _InstallPlan, workspace_dir: Path) -> None:
    timeout = _install_timeout_seconds()
    manager = plan.command[0]
    if shutil.which(manager) is None:
        raise TaskDependencyInstallError(
            f"Task dependency install failed: '{manager}' is not installed in this deployment but the workspace requires it (lockfile: {plan.lockfile}, workspace: {workspace_dir})."
        )
    logger.info(
        "Running %s dependency install in %s: %s",
        plan.ecosystem,
        workspace_dir,
        " ".join(plan.command),
    )
    try:
        completed = subprocess.run(
            plan.command,
            cwd=str(workspace_dir),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise TaskDependencyInstallError(
            f"Task dependency install timed out after {timeout}s (command: {' '.join(plan.command)}, workspace: {workspace_dir})."
        ) from error

    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip()
        stdout = (completed.stdout or "").strip()
        excerpt = (stderr or stdout)[-800:]
        raise TaskDependencyInstallError(
            f"Task dependency install failed (command: {' '.join(plan.command)}, workspace: {workspace_dir}, exit code: {completed.returncode}). Output:\n{excerpt}"
        )


def _install_timeout_seconds() -> int:
    raw = os.environ.get("TASK_INSTALL_TIMEOUT_SECONDS", "")
    try:
        return max(30, int(raw))
    except ValueError:
        return DEFAULT_INSTALL_TIMEOUT_SECONDS


def _install_cache_root() -> Path:
    override = os.environ.get("TASK_INSTALL_CACHE_DIR")
    if override:
        path = Path(override).expanduser()
    else:
        path = Path(task_source_cache_dir()) / "installs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _workspace_cache_key(workspace_dir: Path, plans: list[_InstallPlan]) -> str:
    """Stable key combining workspace path + every lockfile's content hash."""
    hasher = hashlib.sha256()
    hasher.update(str(workspace_dir.resolve()).encode("utf-8"))
    for plan in plans:
        lockfile_path = workspace_dir / plan.lockfile
        try:
            hasher.update(plan.lockfile.encode("utf-8"))
            hasher.update(b"\0")
            hasher.update(lockfile_path.read_bytes())
            hasher.update(b"\0")
        except OSError:
            # If we cannot read the lockfile, fall back to mtime so a
            # later successful read still triggers a fresh install.
            try:
                mtime = int(lockfile_path.stat().st_mtime)
            except OSError:
                mtime = 0
            hasher.update(str(mtime).encode("utf-8"))
            hasher.update(b"\0")
    return hasher.hexdigest()[:24]
