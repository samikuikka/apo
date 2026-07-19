"""
Agent task discovery service.

Discovers agent task folders from the filesystem. A task is any folder
containing a ``*.eval.ts`` file (e.g. ``code-review.eval.ts``).
"""

import os
import re
from dataclasses import dataclass
from pathlib import Path

# The discovery root is the directory that *directly* contains the per-agent
# task folders. Pointing it one level higher leaks the ``tasks/`` segment into
# every discovered task id, which breaks dashboard routing. Keep this in sync
# with ``paths.DEMO_TASK_ROOT``.
DEFAULT_TASK_ROOT = str(
    Path(__file__).resolve().parents[3]
    / "apps"
    / "example-service"
    / "e2e"
    / "agent-task-demo"
    / "tasks"
)


@dataclass
class DiscoveredAgentTask:
    id: str
    task_path: str
    folder_path: str
    display_name: str
    adapter_name: str
    has_checks: bool
    has_user_simulator: bool
    tags: list[str]


def discover_agent_tasks(
    task_root: str | None = None, grep: str | None = None
) -> list[DiscoveredAgentTask]:
    """
    Discover agent tasks under a root directory.

    Scans recursively for folders containing ``*.eval.ts`` files and parses
    their metadata.
    """
    resolved_root = task_root or DEFAULT_TASK_ROOT

    if not os.path.isdir(resolved_root):
        return []

    tasks: list[DiscoveredAgentTask] = []
    _walk_for_tasks(resolved_root, resolved_root, tasks, grep)
    return tasks


def discover_agent_task_by_id(
    task_root: str | None, task_id: str
) -> DiscoveredAgentTask | None:
    """Find a single task by its ID."""
    tasks = discover_agent_tasks(task_root)
    for task in tasks:
        if task.id == task_id:
            return task
    return None


@dataclass
class ResolvedTask:
    task_id: str
    task_path: str


def resolve_task_paths(
    task_root: str | None,
    selection_type: str,
    task_paths: list[str] | None = None,
    grep: str | None = None,
) -> list[ResolvedTask]:
    """
    Resolve a selection into concrete tasks with their IDs and paths.

    Returns resolved tasks that exist and contain a ``*.eval.ts`` file.
    """
    all_tasks = discover_agent_tasks(task_root, grep)

    if selection_type == "all":
        return [ResolvedTask(task_id=t.id, task_path=t.task_path) for t in all_tasks]

    if selection_type in ("task", "tasks"):
        if not task_paths:
            return []
        return _resolve_by_ids(all_tasks, task_paths)

    if selection_type == "folder":
        if not task_paths:
            return []
        return _resolve_by_folder(all_tasks, task_paths)

    return []


def _resolve_by_ids(
    all_tasks: list[DiscoveredAgentTask], task_paths: list[str]
) -> list[ResolvedTask]:
    seen: set[str] = set()
    result: list[ResolvedTask] = []
    for t in all_tasks:
        if (
            t.task_path in task_paths or t.id in task_paths
        ) and t.task_path not in seen:
            seen.add(t.task_path)
            result.append(ResolvedTask(task_id=t.id, task_path=t.task_path))
    return result


def _resolve_by_folder(
    all_tasks: list[DiscoveredAgentTask], task_paths: list[str]
) -> list[ResolvedTask]:
    seen: set[str] = set()
    result: list[ResolvedTask] = []
    for t in all_tasks:
        for folder in task_paths:
            if (
                t.folder_path.startswith(folder) or t.task_path.startswith(folder)
            ) and t.task_path not in seen:
                seen.add(t.task_path)
                result.append(ResolvedTask(task_id=t.id, task_path=t.task_path))
    return result


def _walk_for_tasks(
    current_dir: str,
    root_dir: str,
    accumulator: list[DiscoveredAgentTask],
    grep: str | None,
) -> None:
    """Recursively walk directories looking for .eval.ts files."""
    eval_file = _find_eval_file(current_dir)
    if eval_file:
        task = _parse_task_file(eval_file, current_dir, root_dir)
        if task is not None:
            if (
                grep is None
                or grep.lower() in task.display_name.lower()
                or grep.lower() in task.id.lower()
            ):
                accumulator.append(task)

    for entry in sorted(os.listdir(current_dir)):
        child = os.path.join(current_dir, entry)
        if (
            os.path.isdir(child)
            and not entry.startswith(".")
            and entry != "node_modules"
        ):
            _walk_for_tasks(child, root_dir, accumulator, grep)


def _parse_task_file(
    task_file_path: str, task_dir: str, root_dir: str
) -> DiscoveredAgentTask | None:
    """Parse a ``*.eval.ts`` file to extract metadata."""
    try:
        with open(task_file_path) as f:
            content = f.read()
    except OSError:
        return None

    task_id = _extract_task_id(content)
    if not task_id:
        return None

    adapter = _extract_adapter(content) or "unknown"

    relative_task_path = os.path.relpath(task_dir, root_dir)
    folder_path = os.path.dirname(relative_task_path)
    if folder_path == ".":
        folder_path = ""

    has_checks = _detect_checks(content, task_dir)
    has_user_simulator = os.path.isfile(os.path.join(task_dir, "user-simulator.ts"))
    tags: list[str] = []
    display_name = task_id

    # The task name alone is not unique: two folders may both define
    # ``task("data-extraction")``. The id is therefore the name scoped by
    # its folder path relative to the task root, so each task gets a
    # stable, globally unique id. ``display_name`` keeps the bare name for
    # friendly UI labels.
    discovered_id = f"{folder_path}/{task_id}" if folder_path else task_id

    return DiscoveredAgentTask(
        id=discovered_id,
        task_path=task_dir,
        folder_path=folder_path,
        display_name=display_name,
        adapter_name=adapter,
        has_checks=has_checks,
        has_user_simulator=has_user_simulator,
        tags=tags,
    )


def _extract_task_id(content: str) -> str | None:
    """Extract the task id from the ``*.eval.ts`` source text."""
    # New API: task("name", ...)
    match = re.search(r'\btask\(\s*["\']([^"\']+)["\']', content)
    if match:
        return match.group(1)
    # Legacy: id: "name" inside defineTask config
    return _extract_string_field(content, "id")


def _extract_adapter(content: str) -> str | None:
    """Extract the adapter identifier from the ``*.eval.ts`` source text."""
    # New API: adapter: someAdapter (identifier inside task() config)
    match = re.search(r"\badapter\s*:\s*(\w+)", content)
    if match:
        return match.group(1)
    # Legacy: defineTask(someAdapter, ...)
    match = re.search(r"defineTask\(\s*(\w+)", content)
    if match:
        return match.group(1)
    # Legacy: adapter: "name" (string literal)
    return _extract_string_field(content, "adapter")


def _detect_checks(content: str, task_dir: str) -> bool:
    """Detect whether the task has checks."""
    # New: checks are inline in the .eval.ts file (check( / test( calls)
    if re.search(r"\bcheck\s*\(|\btest\s*\(", content):
        return True
    # Legacy: separate checks.ts file
    return os.path.isfile(os.path.join(task_dir, "checks.ts"))


def _find_eval_file(task_dir: str) -> str | None:
    """Find the first .eval.ts file in a task directory."""
    try:
        for f in os.listdir(task_dir):
            if f.endswith(".eval.ts"):
                return os.path.join(task_dir, f)
    except OSError:
        pass
    return None


def _extract_string_field(content: str, field_name: str) -> str | None:
    """Extract a string field value from JS/TS source text."""
    pattern = rf'{field_name}\s*:\s*"([^"]*)"'
    match = re.search(pattern, content)
    if match:
        return match.group(1)

    pattern = rf"{field_name}\s*:\s*'([^']*)'"
    match = re.search(pattern, content)
    if match:
        return match.group(1)

    return None
