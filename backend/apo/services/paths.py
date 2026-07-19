"""Leaf path constants for the demo task seed.

Lives in its own module — not in ``demo_workspace`` — so that
``project_task_inventory`` and ``project_task_source_sync`` can resolve the
demo root without importing the high-level demo orchestration module. That
orchestration module imports the agent-task runner and scheduler, so pulling
it in for a path constant would close an import cycle across the services
package.

Two symbols with distinct semantics (preserved from their previous homes):

- ``DEMO_TASK_ROOT`` — the source-tree-relative default (no env lookup).
- ``demo_task_root()`` — the resolved root, honouring the ``DEMO_TASK_ROOT``
  env override that container images set (they bundle the demo task tree at
  a path that doesn't match the ``__file__``-relative layout).
"""

import os

# Source-tree default: <repo>/apps/example-service/e2e/agent-task-demo/tasks.
# The discovery root is the directory that *directly* contains the per-agent
# task folders (openai-agent/, real-agent/, ...). Pointing it one level higher
# leaks the ``tasks/`` segment into every discovered task id, which breaks
# dashboard routing. Computed relative to this file (apo/services/paths.py).
DEMO_TASK_ROOT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))),
    "apps",
    "example-service",
    "e2e",
    "agent-task-demo",
    "tasks",
)


def demo_task_root() -> str:
    """Resolved demo seed root, honouring the ``DEMO_TASK_ROOT`` env override."""
    override = os.environ.get("DEMO_TASK_ROOT")
    return override if override else DEMO_TASK_ROOT
