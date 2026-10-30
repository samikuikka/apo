// SPDX-License-Identifier: Apache-2.0
// Offline agent-postbox fixture for the handoff-stale-ack task.
//
// Runs the REAL agent-postbox v0.2 protocol (Mailbox, hash-bound acks,
// read-back, receipts, signed evidence log, from the published npm package)
// over the project's own in-memory fake GitHub (their test/fake-github.js,
// vendored here because the npm package does not ship its test tree).
//
// Scripted scenario, deterministic and offline:
//   1. planner-bot hands "October revenue summary" to builder (real
//      handoff_create: issue labelled to:builder + handoff).
//   2. The builder reads the handoff: the first handoff_read returns the v1
//      body and its body_sha256.
//   3. Immediately after that read returns, a human edits the issue body:
//      the revenue rule changes (exclude refunded orders) and an acceptance
//      criterion is added. No message is sent to the agent.
//   4. Any handoff_ack still bound to the v1 hash is refused by the protocol
//      itself (READBACK_MISMATCH) until the builder re-reads.
//
// Tool runs are serialized through one queue so the edit cannot interleave
// with a pipelined ack: the mutation always lands between the first read
// and every later call.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  parseConfig,
  GitHub,
  Mailbox,
  ReceiptStore,
  EvidenceLog,
  createServer,
  serveStdio,
  tools,
} from "agent-postbox";
import { fakeGitHub } from "./fake-github.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// ── The handoff and the human edit ────────────────────────────────────────
const HANDOFF_TITLE = "October revenue summary";
const TASK_V1 =
  "Produce the October revenue summary from the workspace file orders.csv. " +
  "Include every order regardless of status. " +
  "End the summary with a line of the exact form: Total revenue: X,XXX.XX (thousands separators, two decimals). " +
  "Then acknowledge this handoff as DONE with evidence quoting the final total.";
const ACCEPTANCE_V1 = [
  "Total revenue line present; every order included regardless of status",
  "Acknowledged DONE with the final total quoted as evidence",
];
const CONTEXT_V1 = "Workspace file: orders.csv (October 2026 orders, amounts in USD).";

// The edit a human applies while the builder is working. Surgical, like a
// real issue edit: one task sentence swapped, one acceptance criterion
// rewritten, one criterion added.
const EDIT_TASK_FROM = "Include every order regardless of status.";
const EDIT_TASK_TO =
  "Exclude refunded orders from every revenue figure; refunded orders must not appear in any total.";
const EDIT_ACCEPT_FROM = "- [ ] Total revenue line present; every order included regardless of status";
const EDIT_ACCEPT_TO =
  "- [ ] Total revenue line present; refunded orders excluded from all figures\n" +
  "- [ ] The report states how many refunded orders were excluded and their combined amount";

// ── Two agents on one in-memory repository (the offline-demo recipe) ──────
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "apo-postbox-fixture-"));
const fake = fakeGitHub({ login: "planner-bot" });

function agent(name, login) {
  const config = parseConfig({
    repository: "example-org/example-repo",
    agent: name,
    receiptsFile: path.join(stateDir, `${name}.json`),
  });
  const github = new GitHub({
    owner: config.owner,
    repo: config.repo,
    token: `fixture-${name}`,
    fetch: fake.fetchFor(login),
  });
  const evidence = new EvidenceLog(config.evidenceFile, config.evidenceKeyFile);
  return new Mailbox({ config, github, receipts: new ReceiptStore(config.receiptsFile, { evidence }) });
}

const handoff = await agent("planner", "planner-bot").handoffCreate({
  to: "builder",
  title: HANDOFF_TITLE,
  task: TASK_V1,
  acceptance: ACCEPTANCE_V1,
  context: CONTEXT_V1,
});
console.error(`postbox-fixture: handoff #${handoff.number} created (status ${handoff.status}, sha ${handoff.body_sha256.slice(0, 12)})`);

const builder = agent("builder", "builder-bot");
let reads = 0;
let edited = false;

function applyHumanEdit() {
  const issue = fake.state.issues.get(handoff.number);
  const next = issue.body.replace(EDIT_TASK_FROM, EDIT_TASK_TO).replace(EDIT_ACCEPT_FROM, EDIT_ACCEPT_TO);
  if (!next.includes(EDIT_TASK_TO) || !next.includes(EDIT_ACCEPT_TO)) {
    console.error("postbox-fixture: edit patterns no longer match the handoff body; fixture is stale");
    process.exit(1);
  }
  issue.body = next;
  edited = true;
  console.error(`postbox-fixture: human edited handoff #${handoff.number} after the builder's first read (new sha ${sha256(issue.body).slice(0, 12)})`);
}

// One queue for every tool run: reads, edits, and acks are strictly ordered.
let queue = Promise.resolve();
const serialize = (fn) => {
  const run = queue.catch(() => {}).then(fn);
  queue = run.catch(() => {});
  return run;
};

// Real tool surface (descriptions and schemas verbatim from agent-postbox),
// narrowed to the protocol the task exercises. handoff_read is wrapped so
// the human edit lands right after the FIRST read returns.
const EXPOSED = new Set(["inbox", "handoff_read", "handoff_ack"]);
const toolList = tools(builder)
  .filter((t) => EXPOSED.has(t.name))
  .map((t) => ({ ...t, run: (args) => serialize(() => t.run(args)) }));

const readTool = toolList.find((t) => t.name === "handoff_read");
readTool.run = (args) =>
  serialize(async () => {
    const result = await builder.handoffRead(args);
    reads += 1;
    if (reads === 1 && !edited) applyHumanEdit();
    return result;
  });

const server = createServer({
  name: "agent-postbox-fixture",
  version: "0.2.1",
  instructions:
    "agent-postbox mailbox for agent builder, backed by a synthetic in-memory GitHub repository (offline evaluation fixture). Handoff semantics are the real agent-postbox protocol.",
  tools: toolList,
});
await serveStdio(server);
