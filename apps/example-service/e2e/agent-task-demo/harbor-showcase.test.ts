/**
 * Showcase report — runs the full apo pipeline against the three Harbor
 * verdict fixtures and prints a human-readable summary of exactly what apo
 * recorded. This is the "what does apo actually do for me" view.
 *
 * Run:  pnpm --filter @apo/example-service exec vitest run harbor-showcase
 */
import { describe, it } from "vitest";
import { join } from "node:path";
import { runTaskDir } from "@apo/sdk/agent-task";

const DEMO_ROOT = import.meta.dirname;
const TASK_DIR = join(
  DEMO_ROOT,
  "tasks/harbor/terminal-bench/count-dataset-tokens",
);
const FIXTURE = (n: string) => join(DEMO_ROOT, "fixtures/harbor", n, "result.json");

const line = "─".repeat(72);
type Row = { scenario: string; fixture: string; reward: unknown; outcome: string };

describe("apo × Terminal-Bench showcase", () => {
  it("prints the verdict report across pass / fail / malformed trials", async () => {
    const rows: Row[] = [];

    for (const scenario of ["pass", "fail", "malformed"]) {
      process.env.APO_HARBOR_FIXTURE = FIXTURE(scenario);
      let outcome: string;
      let reward: unknown;
      let checks: { id: string; pass: boolean; reasoning?: string }[] = [];
      let deliverables: Record<string, unknown> = {};

      try {
        const summary = await runTaskDir(TASK_DIR);
        outcome = summary.pass ? "APO PASS" : "APO TEST FAILURE";
        checks = summary.checks as typeof checks;
        deliverables = summary.deliverables ?? {};
        reward = (deliverables.official_verdict as { reward?: number })?.reward;
      } catch (err) {
        outcome = "APO EXECUTION ERROR";
        reward = "—";
        checks = [{ id: "(collectDeliverables threw)", pass: false, reasoning: (err as Error).message }];
      }

      rows.push({ scenario, fixture: scenario, reward, outcome });

      console.log(`\n${line}`);
      console.log(`  scenario: ${scenario.padEnd(10)}   verdict: ${outcome}`);
      console.log(`  official reward: ${reward}`);
      console.log(line);
      for (const c of checks) {
        const mark = c.pass ? "✓" : "✗";
        console.log(`  ${mark} ${c.id}`);
        if (c.reasoning && !c.pass) console.log(`      → ${c.reasoning}`);
      }
      const trial = deliverables.harbor_trial as
        | {
            agent?: string;
            model?: string;
            trajectory_event_count?: number;
            n_input_tokens?: number;
            n_output_tokens?: number;
            cost_usd?: number | null;
            status?: string;
          }
        | undefined;
      if (trial) {
        const tokens =
          trial.n_input_tokens != null
            ? `${trial.n_input_tokens} in / ${trial.n_output_tokens ?? 0} out`
            : "n/a";
        console.log(
          `  agent: ${trial.agent ?? "?"}   model: ${trial.model ?? "?"}   tokens: ${tokens}`,
        );
        console.log(
          `  trajectory events: ${trial.trajectory_event_count ?? 0}   (diagnostic only — never gating)`,
        );
      }
    }

    console.log(`\n${"═".repeat(72)}`);
    console.log("  three-way verdict summary");
    console.log("═".repeat(72));
    for (const r of rows) {
      console.log(
        `  ${r.scenario.padEnd(10)} reward=${String(r.reward).padEnd(6)} → ${r.outcome}`,
      );
    }
    console.log(
      `\n  reward 1 → pass · reward 0 → test failure · missing → execution error`,
    );
    console.log(`  (apo never coerces a missing reward into a silent fail)\n`);
  });
});
