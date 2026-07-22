"""Project task source sync service (SPEC-119).

Turns a configured task source into actual task inventory by:

- cloning/fetching a Git repository into a managed cache directory,
  checking out the configured ref, and resolving the exact commit SHA;
- scanning a filesystem path directly (self-host/dev mode);
- seeding demo inventory from the bundled example-service workspace.

The service is explicit (no implicit sync on page load) and observable
(status transitions are persisted on the task source row). Output is a
fresh snapshot of :class:`ProjectTaskInventoryDB` rows that fully
replace the previous inventory for the project.

Storage layout:

- ``TASK_SOURCE_CACHE_DIR`` env var selects the cache root (server-owned
  writable directory, *never* ``apps/example-service``).
- Defaults to ``<backend>/../.cache/task-sources`` so local dev works
  without configuration.
- Each Git source gets a stable subdirectory keyed by a hash of its
  repository URL, so re-syncs fetch instead of re-cloning.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tarfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from sqlmodel import Session

from ..models.db import ProjectTaskSourceDB
from .agent_task_discovery import DiscoveredAgentTask, discover_agent_tasks
from .paths import demo_task_root
from .project_task_inventory import replace_inventory
from .project_task_sources import mark_error, mark_ready, mark_syncing

# ---------------------------------------------------------------------------
# Cache directory
# ---------------------------------------------------------------------------

_DEFAULT_CACHE_DIR = (
    Path(__file__).resolve().parents[3] / ".cache" / "task-sources"
)
_LOCK_WAIT_SECONDS = float(os.environ.get("TASK_SOURCE_LOCK_WAIT_SECONDS", "5"))


def _cache_root() -> Path:
    """Return the writable cache root, honouring ``TASK_SOURCE_CACHE_DIR``."""
    override = os.environ.get("TASK_SOURCE_CACHE_DIR")
    if override:
        path = Path(override).expanduser()
    else:
        path = _DEFAULT_CACHE_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def _repo_cache_root() -> Path:
    path = _cache_root() / "repos"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _snapshot_root() -> Path:
    path = _cache_root() / "snapshots"
    path.mkdir(parents=True, exist_ok=True)
    return path


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SyncResult:
    """Outcome of a sync operation."""

    source: ProjectTaskSourceDB
    discovered_count: int
    resolved_commit_sha: str | None


def sync_task_source(session: Session, source: ProjectTaskSourceDB) -> SyncResult:
    """Sync a single task source into inventory.

    Updates ``source.status`` (and ``last_error`` on failure) in-place.
    On success, inventory rows are replaced atomically.

    Raises ``SyncError`` only for unexpected internal failures; expected
    user-facing failures (bad URL, missing subpath) are caught and
    surfaced via ``source.status="error"`` + ``source.last_error``.
    """
    if source.source_type == "demo":
        return _sync_demo_source(session, source)
    if source.source_type == "filesystem":
        return _sync_filesystem_source(session, source)
    if source.source_type == "git":
        return _sync_git_source(session, source)
    message = (
        f"Unknown source type: {source.source_type!r}. "
        "Expected one of: git, filesystem, demo."
    )
    mark_error(session, source, message)
    raise SyncError(message)


def refresh_filesystem_source(session: Session, source: ProjectTaskSourceDB) -> None:
    """Lazily re-sync a *filesystem* task source so tasks added or edited on
    disk are visible without a manual ``project source sync`` (issue #17).

    Filesystem discovery is a cheap, server-local directory walk (no clone, no
    network), so refreshing on read is the natural local-dev loop. Git/demo
    sources are left untouched — re-syncing those is expensive (clone/fetch).

    Best-effort: any failure is swallowed so a list/run never hard-fails
    because the path is momentarily unavailable; the inventory simply stays
    as it was.
    """
    if source.source_type != "filesystem":
        return
    if source.status == "syncing":
        return
    path = (source.filesystem_path or "").strip()
    if not path or not os.path.isdir(path):
        return
    try:
        _ = sync_task_source(session, source)
    except Exception:
        # Best-effort refresh — never break a list/run because a refresh failed.
        pass


class SyncError(Exception):
    """Raised when a sync operation cannot complete for internal reasons."""


def resolve_task_source_root(
    session: Session,
    source: ProjectTaskSourceDB,
    *,
    resolved_commit_sha: str | None = None,
) -> Path:
    """Materialize and return the concrete source root for task access.

    This is the runtime counterpart to sync. It is used by batch
    execution and project-scoped file browsing so those code paths read
    from the same configured source model as inventory.
    """
    if source.source_type == "demo":
        return Path(demo_task_root())

    if source.source_type == "filesystem":
        path = Path((source.filesystem_path or "").strip()).expanduser()
        if not path.is_dir():
            raise SyncError(f"Filesystem path does not exist on server: {path}")
        return path

    if source.source_type == "git":
        repo_url = (source.repository_url or "").strip()
        git_ref = (source.git_ref or "").strip() or "main"
        if not repo_url:
            raise SyncError("Git source is missing repository_url.")

        clone_url = _maybe_inject_github_token(session, repo_url, source)
        repo_dir = _ensure_git_repo_cache(
            repo_url,
            clone_url=clone_url,
            git_ref=git_ref,
            subpath=source.subpath,
        )
        commit_sha = resolved_commit_sha or _resolve_ref_commit(repo_dir, git_ref)
        snapshot_dir = _ensure_git_snapshot(repo_dir, repo_url, commit_sha)
        return _apply_source_subpath(snapshot_dir, source.subpath, repo_url, git_ref)

    raise SyncError(
        f"Unknown source type: {source.source_type!r}. "
        + "Expected one of: git, filesystem, demo."
    )


def resolve_inventory_task_dir(
    session: Session,
    source: ProjectTaskSourceDB,
    task_path: str,
    *,
    resolved_commit_sha: str | None = None,
) -> Path:
    """Resolve one inventory `task_path` into a concrete filesystem path."""
    source_root = resolve_task_source_root(
        session,
        source,
        resolved_commit_sha=resolved_commit_sha,
    )
    resolved = (source_root / task_path).resolve()
    source_root_resolved = source_root.resolve()
    if not str(resolved).startswith(str(source_root_resolved)):
        raise SyncError("Resolved task path escaped its source root.")
    if not resolved.is_dir():
        raise SyncError(f"Task directory not found in source: {task_path}")
    return resolved


# ---------------------------------------------------------------------------
# Demo source
# ---------------------------------------------------------------------------


def _sync_demo_source(session: Session, source: ProjectTaskSourceDB) -> SyncResult:
    """Demo sources discover from the bundled example-service workspace.

    This is the only path that still touches the legacy
    ``apps/example-service`` tree. It exists so the seeded demo project
    advertises real task inventory without needing a Git remote.
    """
    mark_syncing(session, source)
    discovered = _discover_demo_tasks()
    _ = replace_inventory(
        session,
        project_id=source.project,
        source=source,
        discovered=discovered,
        resolved_commit_sha=None,
    )
    mark_ready(session, source, resolved_commit_sha=None)
    return SyncResult(
        source=source,
        discovered_count=len(discovered),
        resolved_commit_sha=None,
    )


def _discover_demo_tasks() -> list[DiscoveredAgentTask]:
    """Run discovery against the bundled demo workspace."""
    return discover_agent_tasks(demo_task_root())


# ---------------------------------------------------------------------------
# Filesystem source
# ---------------------------------------------------------------------------


def _sync_filesystem_source(
    session: Session, source: ProjectTaskSourceDB
) -> SyncResult:
    """Filesystem sources scan a server-side path directly."""
    path = (source.filesystem_path or "").strip()
    if not path:
        message = "Filesystem source is missing filesystem_path."
        mark_error(session, source, message)
        return SyncResult(source=source, discovered_count=0, resolved_commit_sha=None)

    if not os.path.isdir(path):
        message = f"Filesystem path does not exist on server: {path}"
        mark_error(session, source, message)
        return SyncResult(source=source, discovered_count=0, resolved_commit_sha=None)

    mark_syncing(session, source)
    discovered = discover_agent_tasks(path)
    _ = replace_inventory(
        session,
        project_id=source.project,
        source=source,
        discovered=discovered,
        resolved_commit_sha=None,
    )
    mark_ready(session, source, resolved_commit_sha=None)
    return SyncResult(
        source=source,
        discovered_count=len(discovered),
        resolved_commit_sha=None,
    )


# ---------------------------------------------------------------------------
# Git source
# ---------------------------------------------------------------------------


def _sync_git_source(session: Session, source: ProjectTaskSourceDB) -> SyncResult:
    """Git sources clone/fetch into a cache dir, then discover.

    Sync skips the snapshot step entirely — it just checks out the ref
    in the cache clone and walks the subpath directly. The snapshot
    machinery exists for runtime execution (batch runs), not for the
    discovery scan.
    """
    repo_url = (source.repository_url or "").strip()
    git_ref = (source.git_ref or "").strip() or "main"
    subpath = (source.subpath or "").strip() or None

    if not repo_url:
        message = "Git source is missing repository_url."
        mark_error(session, source, message)
        return SyncResult(source=source, discovered_count=0, resolved_commit_sha=None)

    mark_syncing(session, source)

    # SPEC-121: if the project has a GitHub OAuth connection, resolve
    # its access token and rewrite the clone URL so private repos work
    # without per-user PATs.
    clone_url = _maybe_inject_github_token(session, repo_url, source)

    try:
        repo_dir = _ensure_git_repo_cache(
            repo_url,
            clone_url=clone_url,
            git_ref=git_ref,
            subpath=subpath,
        )
        commit_sha = _resolve_ref_commit(repo_dir, git_ref)
        # Check out the resolved commit so the working tree matches.
        _ = _run_git(repo_dir, "checkout", "--quiet", commit_sha)
        _ = _run_git(repo_dir, "reset", "--quiet", "--hard", commit_sha)
    except GitError as exc:
        mark_error(session, source, str(exc))
        return SyncResult(source=source, discovered_count=0, resolved_commit_sha=None)

    try:
        scan_root = _apply_source_subpath(repo_dir, subpath, repo_url, git_ref)
    except SyncError as exc:
        mark_error(session, source, str(exc))
        return SyncResult(
            source=source,
            discovered_count=0,
            resolved_commit_sha=commit_sha,
        )

    discovered = discover_agent_tasks(str(scan_root))
    # Rewrite task_path/folder_path so they are relative to the project
    # subpath (not absolute filesystem paths leaking the cache layout).
    normalized = [
        _rewrite_paths(task, scan_root=str(scan_root)) for task in discovered
    ]
    _ = replace_inventory(
        session,
        project_id=source.project,
        source=source,
        discovered=normalized,
        resolved_commit_sha=commit_sha,
    )
    mark_ready(session, source, resolved_commit_sha=commit_sha)
    return SyncResult(
        source=source,
        discovered_count=len(normalized),
        resolved_commit_sha=commit_sha,
    )


def _maybe_inject_github_token(
    session: Session, repo_url: str, source: ProjectTaskSourceDB
) -> str:
    """Return a clone URL with the project's GitHub token embedded, if any.

    GitHub's HTTPS clone URLs accept ``https://x-access-token:<token>@``
    as user-info. We only rewrite URLs pointing at github.com and only
    when a valid encrypted connection exists for this project. Otherwise
    the original URL is returned unchanged so anonymous clone / other
    git hosts work as before.
    """
    try:
        from urllib.parse import urlparse, urlunparse

        parsed = urlparse(repo_url)
    except ValueError:
        return repo_url
    if parsed.hostname != "github.com" or not parsed.scheme.startswith("http"):
        return repo_url

    from .github_oauth import load_github_config, resolve_access_token

    config = load_github_config()
    if config is None:
        return repo_url

    token = resolve_access_token(session, source.project, config)
    if not token:
        return repo_url

    try:
        new_netloc = f"x-access-token:{token}@github.com"
        return urlunparse(parsed._replace(netloc=new_netloc))
    except Exception:  # noqa: BLE001 — token injection is best-effort
        return repo_url


def _apply_source_subpath(
    checkout_dir: Path,
    subpath: str | None,
    repo_url: str,
    git_ref: str,
) -> Path:
    """Return the effective scan root after applying optional subpath."""
    if not subpath:
        return checkout_dir
    candidate = checkout_dir / subpath
    if not candidate.is_dir():
        raise SyncError(
            f"Subpath '{subpath}' does not exist in repository "
            + f"{repo_url} (ref {git_ref})."
        )
    return candidate


def _rewrite_paths(task: DiscoveredAgentTask, *, scan_root: str) -> DiscoveredAgentTask:
    """Make discovered paths stable across hosts.

    Discovery returns ``task_path`` as an absolute filesystem path
    (because it walks the tree) but ``folder_path`` as a path already
    relative to ``scan_root``. We rewrite ``task_path`` to also be
    relative, and re-derive ``folder_path`` from the new task path so
    the two stay consistent.

    Earlier versions re-relativized ``folder_path`` against
    ``scan_root`` via ``os.path.relpath``, which produced garbage
    ``../../../`` paths because Python's ``relpath`` interprets a
    relative ``path`` argument as relative to the current working
    directory — not relative to ``start``.
    """
    rel_task_path = _relative_to(task.task_path, scan_root)
    # Derive folder from the rewritten task path so they stay in sync
    # (avoids double-relativizing the already-relative folder_path).
    rel_folder = os.path.dirname(rel_task_path) if rel_task_path else ""
    return DiscoveredAgentTask(
        id=task.id,
        task_path=rel_task_path,
        folder_path=rel_folder,
        display_name=task.display_name,
        adapter_name=task.adapter_name,
        has_checks=task.has_checks,
        has_user_simulator=task.has_user_simulator,
        tags=task.tags,
    )


def _relative_to(path: str, root: str) -> str:
    """Return ``path`` relative to ``root``; falls back to the basename.

    Only safe to call when ``path`` is an absolute filesystem path
    (i.e. produced by the discovery walker). For already-relative
    paths the caller should not call this — Python's ``relpath``
    interprets relative inputs against ``os.getcwd()``, not ``root``.
    """
    if not path:
        return path
    if not os.path.isabs(path):
        # Already relative — pass through untouched.
        return path.replace(os.sep, "/")
    try:
        rel = os.path.relpath(path, root)
    except ValueError:
        return os.path.basename(path) or path
    if rel == ".":
        return ""
    return rel.replace(os.sep, "/")


# ---------------------------------------------------------------------------
# Git operations (subprocess)
# ---------------------------------------------------------------------------


class GitError(Exception):
    """Raised when a git subprocess operation fails."""


def _repo_cache_key(repo_url: str) -> str:
    """Stable directory name for a repository URL.

    Hashing avoids filesystem-illegal characters and keeps the cache
    path short. The first 8 chars of the URL are appended to make the
    directory identifiable when debugging locally.
    """
    digest = hashlib.sha256(repo_url.encode("utf-8")).hexdigest()[:16]
    safe_prefix = "".join(c if c.isalnum() else "-" for c in repo_url[:32]).strip("-")
    return f"{safe_prefix}-{digest}"


def _ensure_git_repo_cache(
    repo_url: str,
    *,
    clone_url: str | None = None,
    git_ref: str = "main",
    subpath: str | None = None,
) -> Path:
    """Ensure a local cache repo exists, freshly fetched, and sparse-checked-out.

    When ``subpath`` is provided, uses **sparse checkout + partial clone**
    so that:

    - Clone downloads only the tree metadata (``--filter=blob:none``),
      not file contents — blobs for the subpath are fetched on demand.
    - The working tree contains ONLY files under ``subpath``.
    - Subsequent syncs only fetch/stage files in the sparse cone.

    This means a 40 MB repo with a 100 KB task subpath downloads
    ~100 KB instead of 40 MB on first sync.

    Falls back to a regular shallow clone if the server doesn't support
    partial clones (``--filter``). Sparse checkout is still applied so
    the working tree stays minimal.

    When ``subpath`` is None or empty, a full shallow clone is used.
    """
    cache_dir = _repo_cache_root() / _repo_cache_key(repo_url)
    effective_clone_url = clone_url or repo_url

    with _advisory_lock(cache_dir.with_suffix(".lock")):
        if cache_dir.exists():
            # Existing clone: shallow-fetch latest on the ref, then
            # reconfigure sparse checkout in case the subpath changed.
            _ = _run_git(
                cache_dir,
                "fetch",
                "--quiet",
                "--depth=1",
                "origin",
                git_ref,
            )
            _configure_sparse_checkout(cache_dir, subpath)
            return cache_dir

        cache_dir.parent.mkdir(parents=True, exist_ok=True)
        try:
            if subpath:
                _sparse_clone(
                    cache_dir.parent,
                    cache_dir,
                    effective_clone_url,
                    git_ref,
                    subpath,
                )
            else:
                _ = _run_git(
                    cache_dir.parent,
                    "clone",
                    "--quiet",
                    "--depth=1",
                    "--single-branch",
                    "--branch",
                    git_ref,
                    effective_clone_url,
                    str(cache_dir),
                )
        except GitError:
            if cache_dir.exists():
                shutil.rmtree(cache_dir, ignore_errors=True)
            raise
    return cache_dir


def _sparse_clone(
    parent: Path,
    dest: Path,
    url: str,
    git_ref: str,
    subpath: str,
) -> None:
    """Clone with partial clone + sparse checkout, with fallback.

    First tries ``--filter=blob:none --sparse`` (best case: only
    downloads blobs for the sparse paths). If the server doesn't
    support partial clones, falls back to a regular ``--depth=1``
    clone and applies sparse checkout on top.
    """
    try:
        _ = _run_git(
            parent,
            "clone",
            "--quiet",
            "--depth=1",
            "--single-branch",
            "--branch",
            git_ref,
            "--no-checkout",
            "--filter=blob:none",
            "--sparse",
            url,
            str(dest),
        )
    except GitError:
        # Server doesn't support --filter (e.g. plain git daemon).
        # Fall back to a normal shallow clone — we still benefit from
        # sparse checkout limiting the working tree.
        _ = _run_git(
            parent,
            "clone",
            "--quiet",
            "--depth=1",
            "--single-branch",
            "--branch",
            git_ref,
            "--no-checkout",
            url,
            str(dest),
        )

    _configure_sparse_checkout(dest, subpath)
    _ = _run_git(dest, "checkout", "--quiet", git_ref)


def _configure_sparse_checkout(repo_dir: Path, subpath: str | None) -> None:
    """Tell git to only materialize files under ``subpath``.

    When ``subpath`` is None/empty, disables sparse mode entirely so
    the full working tree is available (for repos scanned at root).
    Uses cone mode (``--cone``) for better performance with directory
    prefixes.
    """
    if subpath:
        # cone mode is faster for directory-level patterns
        _ = _run_git(
            repo_dir,
            "sparse-checkout",
            "set",
            "--cone",
            subpath,
        )
    else:
        # No subpath → disable sparse so the full tree is visible
        _ = _run_git(repo_dir, "sparse-checkout", "disable")


def _resolve_ref_commit(repo_dir: Path, git_ref: str) -> str:
    """Resolve a ref or commit-ish to an exact commit SHA."""
    candidates = [
        f"{git_ref}^{{commit}}",
        f"origin/{git_ref}^{{commit}}",
        f"refs/remotes/origin/{git_ref}^{{commit}}",
        f"refs/tags/{git_ref}^{{commit}}",
    ]
    for candidate in candidates:
        try:
            return _run_git(repo_dir, "rev-parse", "--verify", candidate).strip()
        except GitError:
            continue
    raise GitError(f"Could not resolve git ref '{git_ref}' to a commit.")


def _ensure_git_snapshot(repo_dir: Path, repo_url: str, commit_sha: str) -> Path:
    """Export an immutable snapshot for one commit and return its root."""
    snapshot_dir = _snapshot_root() / _repo_cache_key(repo_url) / commit_sha
    ready_marker = snapshot_dir / ".snapshot-ready"
    if ready_marker.exists():
        return snapshot_dir

    with _advisory_lock(snapshot_dir.with_suffix(".lock")):
        if ready_marker.exists():
            return snapshot_dir

        snapshot_dir.parent.mkdir(parents=True, exist_ok=True)
        temp_dir = snapshot_dir.parent / f"{commit_sha}.tmp-{uuid.uuid4().hex[:8]}"
        archive_path = snapshot_dir.parent / f"{commit_sha}.tar"

        if temp_dir.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)
        temp_dir.mkdir(parents=True, exist_ok=True)

        try:
            _ = _run_git(
                repo_dir,
                "archive",
                "--format=tar",
                "-o",
                str(archive_path),
                commit_sha,
            )
            with tarfile.open(archive_path) as archive:
                archive.extractall(temp_dir)
            ready_marker_temp = temp_dir / ".snapshot-ready"
            _ = ready_marker_temp.write_text(commit_sha, encoding="utf-8")
            if snapshot_dir.exists():
                shutil.rmtree(snapshot_dir, ignore_errors=True)
            _ = temp_dir.rename(snapshot_dir)
        except Exception as exc:
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise GitError(
                f"Failed to materialize snapshot for commit {commit_sha}: {exc}"
            ) from exc
        finally:
            if archive_path.exists():
                archive_path.unlink(missing_ok=True)

    return snapshot_dir


class _AdvisoryLock:
    """File-based advisory lock using ``fcntl.flock``.

    Unlike directory-based locks, flock is automatically released when
    the process exits (even on crash/kill), so stale locks are
    impossible. Falls back to no-op on platforms without ``fcntl``.
    """

    def __init__(self, lock_path: Path):
        self.lock_path: Path = lock_path
        self._fd: int | None = None

    def __enter__(self) -> "_AdvisoryLock":
        try:
            import fcntl

            self.lock_path.parent.mkdir(parents=True, exist_ok=True)
            self._fd = os.open(
                str(self.lock_path),
                os.O_CREAT | os.O_WRONLY,
                0o644,
            )
            # Block until we get the lock. flock is process-level and
            # auto-released on exit — no stale locks possible.
            deadline = time.monotonic() + _LOCK_WAIT_SECONDS
            while True:
                try:
                    fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return self
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        os.close(self._fd)
                        self._fd = None
                        raise GitError(
                            f"Timed out waiting for lock: {self.lock_path}"
                        )
                    time.sleep(0.1)
        except ImportError:
            # Windows — no fcntl. Just proceed without locking (alpha).
            return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        if self._fd is not None:
            try:
                import fcntl

                fcntl.flock(self._fd, fcntl.LOCK_UN)
            except ImportError:
                pass
            os.close(self._fd)
            self._fd = None


def _advisory_lock(lock_path: Path) -> _AdvisoryLock:
    return _AdvisoryLock(lock_path)


_CREDENTIALED_URL_PATTERN = re.compile(
    r"(?P<scheme>[a-zA-Z][a-zA-Z0-9+.-]*)://"
    + r"(?P<creds>[^/@:]+:[^/@]+)@"
    + r"(?P<rest>[^\s'\"]+)"
)


def _redact_git_credentials(text: str) -> str:
    """Strip embedded user-info from URLs in git error text.

    Git echoes the attempted URL into stderr on failure. When the URL
    was rewritten by ``_maybe_inject_github_token`` (or supplied by an
    operator with embedded credentials), that URL carries a live token
    — e.g. ``https://x-access-token:ghp_...@github.com/...``. This
    helper replaces the ``user:password@`` segment with
    ``[redacted]@`` so the surrounding context stays useful for
    debugging without leaking the secret.

    Only URL user-info is touched; anonymous URLs and plain text pass
    through unchanged. SSH URLs (``git@github.com:...``) carry no
    password in the URL itself and are likewise left alone.
    """
    return _CREDENTIALED_URL_PATTERN.sub(
        lambda m: f"{m['scheme']}://[redacted]@{m['rest']}", text
    )


def _run_git(cwd: Path, *args: str) -> str:
    """Run a git subprocess, capturing output. Raises ``GitError`` on failure.

    All error paths redact embedded URL credentials before constructing
    the ``GitError`` message, so tokens never reach ``source.last_error``
    or the UI (SPEC-132 Behavior 6).
    """
    safe_args = [_redact_git_credentials(a) for a in args]
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            check=True,
            capture_output=True,
            text=True,
            timeout=int(os.environ.get("TASK_SOURCE_GIT_TIMEOUT_SECONDS", "60")),
        )
    except FileNotFoundError as exc:
        raise GitError("git executable not found on backend host.") from exc
    except subprocess.TimeoutExpired as exc:
        raise GitError(
            f"git {' '.join(safe_args)} timed out after {exc.timeout}s."
        ) from exc
    except subprocess.CalledProcessError as exc:
        stderr_raw: object = exc.stderr  # pyright: ignore[reportAny]
        stderr = _redact_git_credentials(
            str(stderr_raw).strip() if stderr_raw else ""
        )
        raise GitError(
            f"git {' '.join(safe_args)} failed with exit code {exc.returncode}: {stderr}"
        ) from exc
    return result.stdout


__all__ = [
    "GitError",
    "SyncError",
    "SyncResult",
    "resolve_inventory_task_dir",
    "resolve_task_source_root",
    "sync_task_source",
]
