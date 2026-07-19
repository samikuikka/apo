"""Runtime configuration service (SPEC-124, extended by SPEC-132).

Surfaces the deployment-shaped runtime configuration of the backend so
operators can see what topology their instance is actually running in.
The values are derived from environment variables and well-known
process state — they are *not* user-editable. v1 supports exactly one
topology: ``single-node``, exposed under two release profiles
(``local`` and ``server``) plus the existing ``development`` mode.

This module also provides the readiness checks used by the
``/health/ready`` endpoint: database reachability, task-source cache
writability, auth-secret presence in non-dev mode, and task-runtime
availability.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import DATABASE_URL, engine
from ..models.db import UserDB
from .readiness import ReadinessCheckResult, ReadinessReport

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SUPPORTED_TOPOLOGY = "single-node"
DEFAULT_TASK_EXECUTION_MODE = "local_subprocess"

# SPEC-132 Behavior 7: bounded batch concurrency. Default 1, min 1, max 8.
DEFAULT_MAX_CONCURRENT_BATCHES = 1
MIN_CONCURRENT_BATCHES = 1
MAX_CONCURRENT_BATCHES_LIMIT = 8

_KNOWN_INSECURE_AUTH_SECRETS = {
    "",
    "change-me-in-production",
    "change-me",
    "dev-secret",
    "secret",
}

_VALID_PROFILES = {"development", "local", "server"}


# ---------------------------------------------------------------------------
# Public models
# ---------------------------------------------------------------------------


class DatabaseDescriptor(BaseModel):
    """Sanitized database descriptor for the operator-facing API.

    Never includes credentials. Operators can see enough to identify the
    database (engine, host, name, recommended-ness for shared use) but
    the raw DSN with its embedded password stays server-side.
    """

    engine: str
    host: str | None = None
    name: str | None = None
    credentials_configured: bool = False
    shared_use_recommended: bool = False


DeploymentProfile = Literal["development", "local", "server"]


class RuntimeConfig(BaseModel):
    """Operator-visible runtime topology descriptor."""

    backend_url: str
    frontend_url: str
    public_url: str
    database: DatabaseDescriptor
    task_source_cache_dir: str
    task_execution_mode: str
    scheduler_enabled: bool
    deployment_profile: DeploymentProfile
    supported_topology: Literal["single-node"]
    max_concurrent_batches: int
    trusted_task_sources_only: Literal[True]


# ---------------------------------------------------------------------------
# Internal config derivation
# ---------------------------------------------------------------------------


@dataclass
class _DerivedConfig:
    backend_url: str
    frontend_url: str
    public_url: str
    database_url: str
    task_source_cache_dir: str
    task_execution_mode: str
    scheduler_enabled: bool
    dev_mode: bool
    deployment_profile: DeploymentProfile
    max_concurrent_batches: int
    extra: dict[str, object] = field(default_factory=dict)


def _is_dev_mode() -> bool:
    """Return True when auth is bypassed (no AUTH_SECRET)."""
    return (_current_auth_secret() or "") == ""


def _current_auth_secret() -> str:
    """Read AUTH_SECRET fresh each call so tests/env changes are honored."""
    return os.environ.get("AUTH_SECRET", "")


def _backend_url() -> str:
    return (
        os.environ.get("APO_BACKEND_URL")
        or os.environ.get("BACKEND_URL")
        or "http://127.0.0.1:8000"
    )


def _frontend_url() -> str:
    return os.environ.get("FRONTEND_URL", "http://localhost:3000")


def task_source_cache_dir() -> str:
    """Public accessor for the task-source cache dir (shared across services)."""
    override = os.environ.get("TASK_SOURCE_CACHE_DIR")
    if override:
        return str(Path(override).expanduser())
    return str(Path(__file__).resolve().parents[3] / ".cache" / "task-sources")


def _scheduler_enabled() -> bool:
    raw = os.environ.get("SCHEDULER_ENABLED", "true").strip().lower()
    return raw in ("1", "true", "yes", "on")


def _deployment_profile() -> DeploymentProfile:
    """Read ``APO_DEPLOYMENT_PROFILE``, falling back to ``development``.

    Unknown values fall back to ``development`` so a typo never silently
    escalates privileges (e.g. a mispelled ``server`` must NOT inherit
    server-grade fail-closed behavior it didn't earn).
    """
    raw = os.environ.get("APO_DEPLOYMENT_PROFILE", "").strip().lower()
    if raw in ("development", "local", "server"):
        return raw  # type: ignore[returnValue]
    return "development"


def _public_url(frontend_url: str) -> str:
    """The one browser-facing origin. Falls back to the frontend URL."""
    return os.environ.get("APO_PUBLIC_URL", "").strip() or frontend_url


def _max_concurrent_batches() -> int:
    """Parse ``AGENT_TASK_MAX_CONCURRENT_BATCHES`` and clamp to [1, 8].

    Invalid (non-numeric) input falls back to the default rather than
    raising, so a bad env var never prevents startup.
    """
    raw = os.environ.get("AGENT_TASK_MAX_CONCURRENT_BATCHES", "").strip()
    if not raw:
        return DEFAULT_MAX_CONCURRENT_BATCHES
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_MAX_CONCURRENT_BATCHES
    return max(
        MIN_CONCURRENT_BATCHES,
        min(MAX_CONCURRENT_BATCHES_LIMIT, value),
    )


def _describe_database(database_url: str) -> DatabaseDescriptor:
    """Build a sanitized descriptor from a raw DSN.

    Refuses to leak credentials. If we cannot parse the DSN safely we
    fall back to engine-only info so the descriptor is always safe to
    expose to the browser.
    """
    url = database_url or ""
    if url.startswith("postgresql://") or url.startswith("postgres://"):
        try:
            from urllib.parse import urlparse

            parsed = urlparse(url)
            return DatabaseDescriptor(
                engine="postgres",
                host=parsed.hostname or None,
                name=(parsed.path or "").lstrip("/") or None,
                credentials_configured=bool(parsed.username and parsed.password),
                shared_use_recommended=True,
            )
        except ValueError:
            return DatabaseDescriptor(
                engine="postgres",
                credentials_configured=":" in url,
                shared_use_recommended=True,
            )
    if url.startswith("sqlite://"):
        path = url[len("sqlite://"):]
        # Strip leading slashes for display only — no credentials to leak.
        return DatabaseDescriptor(
            engine="sqlite",
            host=None,
            name=path or None,
            credentials_configured=False,
            shared_use_recommended=False,
        )
    return DatabaseDescriptor(
        engine="unknown",
        credentials_configured=False,
        shared_use_recommended=False,
    )


def derive_runtime_config() -> _DerivedConfig:
    """Build the runtime descriptor from current process env + state."""
    frontend_url = _frontend_url()
    return _DerivedConfig(
        backend_url=_backend_url(),
        frontend_url=frontend_url,
        public_url=_public_url(frontend_url),
        database_url=DATABASE_URL,
        task_source_cache_dir=task_source_cache_dir(),
        task_execution_mode=DEFAULT_TASK_EXECUTION_MODE,
        scheduler_enabled=_scheduler_enabled(),
        dev_mode=_is_dev_mode(),
        deployment_profile=_deployment_profile(),
        max_concurrent_batches=_max_concurrent_batches(),
    )


def get_runtime_config() -> RuntimeConfig:
    """Public view of runtime config for the API surface."""
    cfg = derive_runtime_config()
    return RuntimeConfig(
        backend_url=cfg.backend_url,
        frontend_url=cfg.frontend_url,
        public_url=cfg.public_url,
        database=_describe_database(cfg.database_url),
        task_source_cache_dir=cfg.task_source_cache_dir,
        task_execution_mode=cfg.task_execution_mode,
        scheduler_enabled=cfg.scheduler_enabled,
        deployment_profile=cfg.deployment_profile,
        supported_topology=SUPPORTED_TOPOLOGY,
        max_concurrent_batches=cfg.max_concurrent_batches,
        trusted_task_sources_only=True,
    )


# ---------------------------------------------------------------------------
# Readiness checks
# ---------------------------------------------------------------------------


def _check_database() -> ReadinessCheckResult:
    try:
        with Session(engine) as session:
            _ = session.exec(select(UserDB).limit(1)).first()
        return ReadinessCheckResult(name="database", ok=True)
    except Exception as error:  # noqa: BLE001
        return ReadinessCheckResult(
            name="database",
            ok=False,
            detail=f"database unreachable: {error}",
        )


def _check_task_source_cache(path: str) -> ReadinessCheckResult:
    cache_path = Path(path)
    try:
        _ = cache_path.mkdir(parents=True, exist_ok=True)
        probe = cache_path / ".readiness-probe"
        with tempfile.NamedTemporaryFile(
            mode="w",
            dir=str(cache_path),
            prefix=".readiness-",
            suffix=".tmp",
            delete=False,
        ) as handle:
            _ = handle.write("ok")
            probe_path = Path(handle.name)
        try:
            probe_path.unlink()
        except OSError:
            pass
        # Clean up any leftover probe file from a previous failed run.
        if probe.exists():
            try:
                probe.unlink()
            except OSError:
                pass
        return ReadinessCheckResult(name="task_source_cache", ok=True)
    except Exception as error:  # noqa: BLE001
        return ReadinessCheckResult(
            name="task_source_cache",
            ok=False,
            detail=f"task-source cache dir not writable: {error}",
        )


def _check_auth_secret(dev_mode: bool) -> ReadinessCheckResult:
    if dev_mode:
        return ReadinessCheckResult(
            name="auth_secret",
            ok=True,
            detail="dev mode (AUTH_SECRET unset); auth bypassed",
        )
    secret = (_current_auth_secret() or "").strip()
    if not secret:
        return ReadinessCheckResult(
            name="auth_secret",
            ok=False,
            detail="AUTH_SECRET is required in non-dev mode",
        )
    if secret in _KNOWN_INSECURE_AUTH_SECRETS:
        return ReadinessCheckResult(
            name="auth_secret",
            ok=False,
            detail="AUTH_SECRET is set to a known insecure placeholder",
        )
    if len(secret) < 16:
        return ReadinessCheckResult(
            name="auth_secret",
            ok=False,
            detail="AUTH_SECRET is too short (need at least 16 chars)",
        )
    return ReadinessCheckResult(name="auth_secret", ok=True)


def _check_task_runtime() -> ReadinessCheckResult:
    """Check whether the agent-task subprocess runtime is usable.

    Delegates to the SPEC-125 runtime resolver. Resolution order:

    1. Packaged bundle at ``$AGENT_TASK_RUNTIME_DIR/runner.mjs``
       (container / self-hosted alpha).
    2. Dev fallback using the repo's ``tsx`` binary against the live
       TypeScript entrypoint (local development).
    3. Unavailable.
    """
    from .agent_task_runtime import probe_task_runtime

    return probe_task_runtime()


def run_readiness_checks() -> ReadinessReport:
    """Run every operator-relevant readiness check and aggregate results."""
    cfg = derive_runtime_config()

    checks = [
        _check_database(),
        _check_task_source_cache(cfg.task_source_cache_dir),
        _check_auth_secret(cfg.dev_mode),
    ]
    # Task runtime only matters when scheduler / execution is expected.
    if cfg.scheduler_enabled:
        checks.append(_check_task_runtime())

    by_name = {check.name: check for check in checks}
    overall_ok = all(check.ok for check in checks)
    return ReadinessReport(ok=overall_ok, checks=by_name)
