// The apo authoring skill, installed by `apo init` to ~/.agents/skills/apo/
// and ~/.claude/skills/apo/. One source of truth for what the spawned agent
// is told; the kickoff prompt in commands/init.ts points here.
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

## Reference

- Define a task (full API): https://docs.test-apo.online/guides/define-a-task/
- Canonical end-to-end example: \`apps/example-service/e2e/agent-task-demo/START-HERE.md\` in the apo repository
- All docs: https://docs.test-apo.online
`;
