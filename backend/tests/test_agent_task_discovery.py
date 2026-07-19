import os
import tempfile

from apo.services.agent_task_discovery import discover_agent_tasks


def test_discovery_uses_parent_folder_for_grouping():
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = os.path.join(tmp, "adapter-a", "tasks", "meeting-summary")
        os.makedirs(task_dir, exist_ok=True)
        with open(os.path.join(task_dir, "meeting-summary.eval.ts"), "w") as f:
            _ = f.write('import { task } from "@apo/sdk/agent-task";\ntask("meeting-summary", { adapter: "a" });\n')

        tasks = discover_agent_tasks(tmp)

        assert len(tasks) == 1
        # The id is the task name scoped by its folder path relative to the
        # root, so two folders can each define a task of the same name
        # without colliding (see ``_parse_task_file``).
        assert tasks[0].id == os.path.join("adapter-a", "tasks", "meeting-summary")
        assert tasks[0].folder_path == os.path.join("adapter-a", "tasks")


def test_discovery_reads_single_file_task_metadata_and_checks():
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = os.path.join(tmp, "tasks", "code-review")
        os.makedirs(task_dir, exist_ok=True)
        with open(os.path.join(task_dir, "code-review.eval.ts"), "w") as task_file:
            _ = task_file.write(
                """
import { task, test } from "@apo/sdk/agent-task";
import { realAgentAdapter } from "./adapter";

task("code-review", {
  adapter: realAgentAdapter,
  deliverables: ["result"],
});

const check = test<{ result: string }>;
check("has-result", (t, { deliverables }) => {
  t.assert(Boolean(deliverables.result));
});
"""
            )

        tasks = discover_agent_tasks(tmp)

        assert len(tasks) == 1
        # Folder-scoped id: task name prefixed by the folder path relative to
        # the root (here, the ``tasks`` dir).
        assert tasks[0].id == os.path.join("tasks", "code-review")
        assert tasks[0].adapter_name == "realAgentAdapter"
        assert tasks[0].has_checks is True
