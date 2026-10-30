/**
 * handoff-stale-ack — recovering when a handoff changes under you.
 *
 * The agent-postbox protocol binds every handoff acknowledgement to the
 * sha256 of the issue text the agent read. If a human edits the handoff
 * while the agent works, the ack is refused (READBACK_MISMATCH) until the
 * agent re-reads. The protocol guarantees the refusal; whether a real agent
 * recovers is a capability question: does it go back, read the new task, redo
 * the affected work, and acknowledge against the current text?
 *
 * This task makes that question executable. The postbox MCP server
 * (postbox/server.mjs) runs the real agent-postbox protocol over an
 * in-memory GitHub: planner-bot hands the builder an October revenue
 * summary, and right after the builder's first handoff_read a human edits
 * the issue (exclude refunded orders, plus one new acceptance criterion).
 * No message tells the agent anything changed. The only signal is the
 * refused acknowledgement.
 *
 * Ground truth is arithmetic: all 10 orders sum to 14,189.25; the 3 refunded
 * orders sum to 1,872.50; excluding them leaves 12,316.75. An agent that
 * carries on with the pre-edit task acks stale forever and reports
 * 14,189.25. An agent that recovers re-reads, redoes the total, and acks
 * DONE with the revised numbers as evidence.
 *
 * Layers: refusal happened (deterministic) → re-read after refusal
 * (deterministic, the core question) → ack bound to current text
 * (deterministic) → evidence and report carry the revision (deterministic)
 * → coherent adaptation (judge).
 */
import { task, satisfies } from "@apo-ai/sdk/agent-task";
import { aiSdkAdapter } from "../../../ai-sdk-adapter.ts";

const { test: check } = task("handoff-stale-ack", {
  adapter: aiSdkAdapter,
  description:
    "A handoff is edited mid-task under the real agent-postbox protocol: the stale ack must be refused, the new task re-read, and the work redone.",
  metadata: { category: "handoff", difficulty: "medium", sdk: "ai-sdk", agentMaxSteps: 16 },
  maxTurns: 1,
  deliverables: ["result", "tool_log", "stats"],
  mcpServers: [
    {
      name: "postbox",
      transport: { type: "stdio", command: "node", args: ["./postbox/server.mjs"] },
    },
  ],
});

// No task-level turn: the adapter's default reads files/instructions.md,
// which is the builder's briefing (check inbox, do the work, acknowledge,
// report). The mid-run edit is invisible here by design: the environment
// changes, not the conversation.

// ── Shared evidence: the adapter-recorded tool log ────────────────────────
type ToolEntry = { tool: string; args: Record<string, unknown>; result: unknown };
type ToolLog = { details: ToolEntry[] };

const READ = "mcp__postbox__handoff_read";
const ACK = "mcp__postbox__handoff_ack";

function toolLog(deliverables: Record<string, unknown>): ToolEntry[] {
  return ((deliverables.tool_log as ToolLog | undefined)?.details ?? []) as ToolEntry[];
}

/** First body_sha256 embedded in a handoff_read result (content and structuredContent agree). */
function readHash(entry: ToolEntry): string | undefined {
  return /"body_sha256":"([0-9a-f]{64})"/.exec(JSON.stringify(entry.result ?? {}))?.[1];
}

function ackFailed(entry: ToolEntry): boolean {
  return JSON.stringify(entry.result ?? {}).includes("READBACK_MISMATCH");
}

function ackSucceeded(entry: ToolEntry): boolean {
  const text = JSON.stringify(entry.result ?? {});
  return !text.includes('"isError":true') && (text.includes('"status":"CONFIRMED"') || text.includes('"result":"DONE"'));
}

/** The revised October total: completed orders only, refunded excluded. */
const REVISED_TOTAL = /12[,.]?316\.75/;

// ── Layer 1: the protocol event happened ──────────────────────────────────
check("handoff-was-read", (t, { deliverables }) => {
  t.check(
    toolLog(deliverables).filter((e) => e.tool === READ).length,
    satisfies((n: number) => n >= 1, "include at least one handoff_read"),
    "the agent entered the handoff protocol",
  );
});

check("stale-ack-was-refused", (t, { deliverables }) => {
  t.check(
    toolLog(deliverables).filter((e) => e.tool === ACK && ackFailed(e)).length,
    satisfies((n: number) => n >= 1, "include at least one refused handoff_ack (READBACK_MISMATCH)"),
    "the edit invalidated the agent's acknowledgement",
  );
});

// ── Layer 2: the core question — did the agent go back and read? ──────────
check("agent-re-read-after-refusal", (t, { deliverables }) => {
  const log = toolLog(deliverables);
  const firstRefusal = log.findIndex((e) => e.tool === ACK && ackFailed(e));
  const reReads = log.filter((e, i) => e.tool === READ && firstRefusal >= 0 && i > firstRefusal).length;
  t.check(
    reReads,
    satisfies((n: number) => n >= 1, "have a handoff_read after the first refused ack"),
    "the agent returned to read the changed handoff",
  );
});

// ── Layer 3: the ack landed against the current text ──────────────────────
check("ack-accepted-against-current-text", (t, { deliverables }) => {
  const log = toolLog(deliverables);
  const confirmed = log.find((e) => e.tool === ACK && ackSucceeded(e));
  t.check(
    Boolean(confirmed),
    satisfies((b: boolean) => b, "have one confirmed handoff_ack"),
    "an acknowledgement was eventually accepted",
  );
  if (!confirmed) return;
  const latestReadBefore = [...log.entries()]
    .filter(([i, e]) => e.tool === READ && i < log.indexOf(confirmed))
    .map(([, e]) => e)
    .pop();
  t.check(
    latestReadBefore !== undefined && readHash(latestReadBefore) === String(confirmed.args?.read_sha256),
    satisfies((b: boolean) => b, "match the body_sha256 of the latest preceding handoff_read"),
    "the accepted ack was bound to the text as it stands now",
  );
});

// ── Layer 4: the work product carries the revision ────────────────────────
check("evidence-quotes-revised-total", (t, { deliverables }) => {
  const confirmed = toolLog(deliverables).find((e) => e.tool === ACK && ackSucceeded(e));
  const evidenceArg = confirmed?.args?.evidence;
  const evidence = Array.isArray(evidenceArg) ? (evidenceArg as string[]).join(" ") : "";
  t.check(
    evidence,
    satisfies((s: string) => REVISED_TOTAL.test(s), `quote the revised total (12,316.75); got "${evidence}"`),
    "acknowledgement evidence reflects the post-edit work",
  );
});

check("report-total-is-revised", (t, { deliverables }) => {
  const report = String((deliverables.result as { summary: string }).summary);
  const totalLine = /Total revenue:\s*([\d,.]+)/.exec(report);
  t.check(
    totalLine?.[1] ?? "(no Total revenue line)",
    satisfies((s: string) => REVISED_TOTAL.test(s), "be the revised 12,316.75"),
    "the report's Total revenue line excludes refunded orders",
  );
});

check("bounded-ack-retries", (t, { deliverables }) => {
  t.check(
    toolLog(deliverables).filter((e) => e.tool === ACK).length,
    satisfies((n: number) => n <= 4, "be at most 4 handoff_ack calls"),
    "the agent did not thrash the acknowledgement",
  );
});

// ── Layer 5: judged coherence ─────────────────────────────────────────────
// Numbers can survive a mangled report; the judge confirms the report reads
// as if the exclusion rule was always in force, with the protocol friction
// handled rather than narrated around.
check("revision-handled-coherently", async (t, { deliverables }) => {
  const report = String((deliverables.result as { summary: string }).summary);
  await t.judge(
    report,
    "PASS only if this October revenue report consistently treats the post-edit rule as the task: refunded orders (3 orders, 1,872.50 combined) are excluded from every revenue figure, the final Total revenue is 12,316.75, the exclusion count and amount are stated as the acceptance criteria require, and the report reads as a coherent summary rather than a correction pasted on top. Mentioning the protocol refusal is fine when it explains what the agent did about it. FAIL if any revenue total still includes refunded amounts, if the exclusion is claimed but not applied, or if the report acknowledges the changed task without redoing the work.",
  );
});
