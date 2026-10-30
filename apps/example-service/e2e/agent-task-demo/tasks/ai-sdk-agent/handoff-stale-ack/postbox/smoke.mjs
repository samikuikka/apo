// SPDX-License-Identifier: Apache-2.0
// Offline smoke test for server.mjs — exercises the whole scripted scenario
// over raw stdio JSON-RPC with zero model calls:
//   inbox → handoff_read (v1) → [human edit fires] → stale handoff_ack
//   (READBACK_MISMATCH) → handoff_read (v2) → handoff_ack (CONFIRMED).
// Run: node postbox/smoke.mjs
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["postbox/server.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function call(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

function expect(name, cond, detail) {
  if (!cond) {
    console.error(`SMOKE FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  console.log(`ok — ${name}`);
}

try {
  const init = await call("initialize", { protocolVersion: "2025-06-18" });
  expect("initialize", init.result?.serverInfo?.name === "agent-postbox-fixture");

  const list = await call("tools/list", {});
  const names = list.result.tools.map((t) => t.name).sort();
  expect(
    "tool surface is inbox + handoff_read + handoff_ack",
    JSON.stringify(names) === JSON.stringify(["handoff_ack", "handoff_read", "inbox"]),
    names.join(","),
  );

  const inbox = await call("tools/call", { name: "inbox", arguments: {} });
  const number = JSON.parse(inbox.result.content[0].text).items?.[0]?.number;
  expect("inbox lists the handoff", number !== undefined, inbox.result.content[0].text.slice(0, 200));

  const read1 = await call("tools/call", { name: "handoff_read", arguments: { number } });
  const r1 = JSON.parse(read1.result.content[0].text);
  expect("first read returns v1 body (include every order)", r1.body.includes("Include every order regardless of status"));
  const v1Hash = r1.body_sha256;
  expect("v1 hash present", /^[0-9a-f]{64}$/.test(v1Hash));

  // The human edit fired between read1 and this ack (server-side).
  const staleAck = await call("tools/call", {
    name: "handoff_ack",
    arguments: { number, read_sha256: v1Hash, result: "DONE", evidence: ["smoke"] },
  });
  const s1 = JSON.parse(staleAck.result.content[0].text);
  expect("stale ack refused with READBACK_MISMATCH", staleAck.result.isError === true && s1.error === "READBACK_MISMATCH", JSON.stringify(s1));

  const read2 = await call("tools/call", { name: "handoff_read", arguments: { number } });
  const r2 = JSON.parse(read2.result.content[0].text);
  expect("second read returns v2 body (exclude refunded)", r2.body.includes("Exclude refunded orders from every revenue figure"));
  expect("v2 hash differs from v1", r2.body_sha256 !== v1Hash);

  const ack2 = await call("tools/call", {
    name: "handoff_ack",
    arguments: { number, read_sha256: r2.body_sha256, result: "DONE", evidence: ["smoke", "Total revenue: 12,316.75"] },
  });
  const s2 = JSON.parse(ack2.result.content[0].text);
  expect("fresh ack confirmed", ack2.result.isError !== true && (s2.status === "CONFIRMED" || s2.result === "DONE"), JSON.stringify(s2));

  console.log("SMOKE PASS — fixture scenario works end to end");
} finally {
  child.kill();
}
