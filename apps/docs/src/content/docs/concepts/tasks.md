---
title: Tasks
description: "A task is one folder with one .eval.ts file: definition, input, and tests."
---

**A task is a folder.** One `<task-id>.eval.ts` file, an optional `files/` directory, nothing else:

```text
my-task/
  my-task.eval.ts   # definition + input + all tests
  files/            # optional: files available to the task, auto-discovered
```

## The file

The `.eval.ts` file holds the definition, the input handling, and every test. One module, three calls:

```typescript
import { matches, task, turn } from "@apo-ai/sdk/agent-task";
import { legalDocumentAdapter } from "./adapter";
import { partiesSchema } from "./schemas";

// Register the task: name, adapter (yours, see Adapters), and the
// deliverables the adapter will collect for the tests to assert on.
const { test } = task("extract-parties", {
  adapter: legalDocumentAdapter,
  deliverables: ["parties", "amounts", "dates"],
});

// Feed the agent its input on the first turn, then stop.
// Returning null ends the turn loop. Without it, the task would keep
// re-sending the same input until maxTurns cuts it off.
turn(async ({ files, transcript }) => {
  if (transcript.length > 0) return null;
  return await files.read("contract.pdf");
});

// Mid-run steering: a correction injected while the agent is still working,
// at a boundary the task names. See "Steer a running agent" (linked below).

// Deterministic: did the agent open the contract, with nothing errored?
test("used-source-document", (t) => {
  t.calledTool("read_file", { input: { path: "contract.pdf" } });
  t.noFailedActions();
});

// Judged: schema-check the deliverable, then let an LLM judge quality.
test("parties-are-complete", async (t, { deliverables }) => {
  t.check(deliverables.parties, matches(partiesSchema));
  await t.judge(
    deliverables.parties,
    "PASS when every named party is captured without false positives.",
  );
});
```

The `test` function comes from the task because its types do too. The adapter defines every deliverable it can collect; the task selects the subset it requires; each test sees only that subset.

The task name is the folder name. Discovery scans for `.eval.ts` files: drop the folder into your task source and it's registered. No manifest.

## Who added a task

[`apo task publish`](/cli/task-publish/) also records where each task came from. A task's card shows its `description` and an **Added … by …** line — the author and date of the first commit that added the `.eval.ts` when you publish from a git repo, otherwise the first user who published the task. The task's page spells both out (*Written by … (sha) · First published … by …*). It's best-effort context from git for whoever reads the suite — nothing to configure.

## Removing a task

A task leaves the suite the same way it arrived: through your repo. Delete the task folder and run [`apo task publish`](/cli/task-publish/) — nothing else.

Removal is **not** destructive:

- **Every run, check, judgment, and trace is kept.** Runs reference tasks by id, not by a live row, so history survives the delete.
- **The server records the removal.** The publish that carried the deletion writes a tombstone — last-known name and folder, the removal date, and the commit you published from — and reports what left, how many runs it retains, and whether any schedule selected it.
- **The task stays findable.** In the dashboard's Tasks page, open **Status → Archived** to see removed tasks with their folders and run history. Searching a removed task's name points you there. Its detail page shows the removal date and its runs instead of erroring.

Restoring is just git: revert the deletion (or re-add the folder), publish again. The task is back in the suite with its old runs attached — the server never owned the lifecycle, it only watched.

Renaming or moving a task (its id is the folder-scoped name) looks to the server like a removal plus an addition. When both definitions have identical content, `apo task publish` reports it as a probable move so you know the history split is intentional.

## Next

- [Adapters](/concepts/adapters/): what the `adapter` option actually is, and why you write it.
- [Tests](/concepts/tests/): the assertion vocabulary (`t.calledTool`, `t.check`, `t.judge`, matchers).
- [Define a Task](/guides/define-a-task/): the step-by-step recipe.
- [Steer a running agent](/guides/steer-a-running-agent/): script a mid-run correction and assert the harness handled it.
