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
import { matches, task, test, turn } from "@apo/sdk/agent-task";
import { legalDocumentAdapter } from "./adapter";
import { partiesSchema } from "./schemas";

// Register the task: name, adapter (yours, see Adapters), and the
// deliverables the adapter will collect for the tests to assert on.
task("extract-parties", {
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

The task name is the folder name. Discovery scans for `.eval.ts` files: drop the folder into your task source and it's registered. No manifest.

## Next

- [Adapters](/concepts/adapters/): what the `adapter` option actually is, and why you write it.
- [Tests](/concepts/tests/): the assertion vocabulary (`t.calledTool`, `t.check`, `t.judge`, matchers).
- [Define a Task](/guides/define-a-task/): the step-by-step recipe.
