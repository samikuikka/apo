// The apo authoring skill, installed by `apo init` to ~/.agents/skills/apo/
// and ~/.claude/skills/apo/. One source of truth for what the spawned agent
// is told; the kickoff prompt in commands/init.ts points here.
//
// The same content is committed at skills/apo/SKILL.md in the repository so
// `npx skills add samikuikka/apo --skill apo` can serve it; a drift test
// (tests/skill-content-drift.test.ts) keeps the two byte-identical — edit
// both or neither.
//
// Keep code samples compiling against @apo-ai/sdk's current API — the
// canonical reference is apps/example-service/e2e/agent-task-demo/ in the
// apo repository. Deep documentation lives at https://docs.test-apo.online;
// the skill teaches the loop, not every option.

export const SKILL_MD = `---
name: apo
description: Author and run Apo tasks — executable capability specs for AI agents. Use when writing an apo adapter or task (*.eval.ts), defining checks or input files, publishing a task catalog, or running agent tasks and reading PASS/FAIL verdicts with apo task run / apo runs show. Covers the define, execute, verify, improve loop.
---

# Apo — write tasks for your agent

Apo turns "what my agent must be capable of" into an executable spec. A **task** is a \`.eval.ts\` file: fixtures go in, the real agent runs through an **adapter**, and **checks** assert the outcome. The result is a **verdict** — PASS/FAIL with per-check evidence. Read it like test output, fix the agent, rerun.

Vocabulary: a **task** is the spec of correct behavior; a **run** is one execution; the **verdict** is its PASS/FAIL plus the check breakdown; the **trace** is the tool/generation calls the agent made; **deliverables** are the structured outputs the adapter collected.

## The four pieces

| Piece | What it is |
|---|---|
| Real agent | Your code — the LLM call or agent function that already exists in this repo |
| Adapter | Thin bridge (\`defineAdapter\`) that drives the agent turn by turn |
| Task | \`<task-id>/<task-id>.eval.ts\` — adapter + checks + options |
| Inputs | \`<task-id>/files/\` — fixtures the task loads (\`files.read\`) |

## Adapter — the minimal bridge

\`\`\`ts
// e2e/my-adapter.ts
import { defineAdapter, registerApoTracing } from "@apo-ai/sdk/agent-task";
import { z } from "zod";
import { runMyAgent } from "../src/agent"; // your real agent

await registerApoTracing(); // routes the agent's gen_ai.* spans into the run trace

export const myAdapter = defineAdapter({
  name: "my-agent",
  deliverables: { summary: z.string() },
  // What to hand the agent each turn; return null to end the conversation.
  turn: async ({ files, transcript }) =>
    transcript.length > 0 ? null : await files.read("instructions.md"),
  async initialize() {
    return {}; // per-run state, threaded into every later context
  },
  async startSession(ctx) {
    return {
      // report the model your agent actually resolved — apo never picks it
      runConfiguration: { model: process.env.MY_AGENT_MODEL ?? "gpt-4o-mini" },
      async sendUserTurn(turn) {
        const response = await runMyAgent(String(turn));
        return { response };
      },
    };
  },
  async collectDeliverables() {
    return { summary: "what the agent produced" };
  },
});
\`\`\`

The adapter owns nothing about prompts, tools, or models — that all lives in the agent. It hands each turn over and records what comes back. Required: \`name\`, \`deliverables\`, \`startSession\`, \`collectDeliverables\`; \`turn\`/\`initialize\`/\`cleanup\` are optional.

## Task — the spec of correct behavior

\`\`\`ts
// e2e/my-task/my-task.eval.ts
import { task, includes, filePaths } from "@apo-ai/sdk/agent-task";
import { myAdapter } from "../my-adapter";

const { test } = task("my-task", {
  adapter: myAdapter,
  description: "What correct behavior looks like, one sentence.",
  deliverables: ["summary"],
  maxTurns: 2,
});

test("used-the-input-file", (t, { files }) => {
  t.check(filePaths(files), includes("input.txt"));
});

test("called-read-file", (t) => {
  t.calledTool("read_file", { input: { path: "input.txt" } });
});
\`\`\`

Checks read the run's evidence: \`t.calledTool(name, match?)\` and \`t.noFailedActions()\` assert against the trace; \`t.check(actual, expected)\` compares values (deliverables, files); \`t.judge(...)\` asks a judge model for outcomes no assertion can pin. Put fixtures in \`my-task/files/\` next to the eval file.

## Publish and run

\`\`\`bash
npm install @apo-ai/sdk        # if the repo doesn't have it yet
apo task publish --dir e2e     # register the catalog (IDs, names, definitions)
apo task run my-task           # run the real agent, record verdict + trace
apo runs show <run-id>         # failed check reasoning + trace + deliverables
\`\`\`

## The rule: never weaken the task to make a run pass

The task defines correct behavior; a failing run means the **agent** (or its adapter) is wrong. Editing the task to match what the agent happens to do deletes the test instead of fixing the bug. The loop: run, read the failed check's reasoning in \`apo runs show\`, inspect the trace for what the agent actually did, fix the agent, rerun. Stop on PASS.

## Notes: what the project already knows

\`apo runs show\` prints the **notes** the project has written about the task: notes on the folder and the task above the checks, and a test's notes under that test when it fails. They record what earlier investigations established, such as a criterion that was audited and found sound, a judge that misreads one kind of answer, or the score range a model normally lands in. Read them before diagnosing a failure. A note marked \`different task revision\` was written against a different version of the eval file, so check that it still holds before relying on it.

When you establish something the next person would otherwise have to re-derive, write it down:

\`\`\`bash
apo notes add my-task --test "used-the-input-file" "Audited 2026-10-12: the fixture has no input.txt for locale=fr, so this fails on every fr run; fixed in the adapter, see run_8f2c…"
apo notes add --folder e2e/billing "All billing tasks share the sandbox Stripe key; a 401 in the trace means it expired, not an agent bug."
apo notes list my-task
\`\`\`

A good note states a fact, its evidence (run ids, judgment ids, the document or line that settles it) and a date. "The judge fails C-3 under reasoning that concludes PASS in 2 of 5 draws (rejudge jdg_41…, 2026-10-12)" helps the next reader. "Model X is bad at this task" does not: it is a verdict, it ages badly, and it gives the reader nothing to check. Notes never change a result; use \`apo runs correct\` for that. When a note stops being true, \`apo notes archive <note-id>\`.

## Reference

- Define a task (full API): https://docs.test-apo.online/guides/define-a-task/
- Canonical end-to-end example: \`apps/example-service/e2e/agent-task-demo/START-HERE.md\` in the apo repository
- All docs: https://docs.test-apo.online
`;
