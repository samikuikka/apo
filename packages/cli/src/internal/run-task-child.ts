/**
 * Child entrypoint for source-owned Task execution.
 *
 * Spawned one-per-Attempt by the Connected Executor parent (connect.ts). It
 * imports ``runTaskDir`` from the SDK and runs the Task in this isolated
 * child process so Task stdout/stderr cannot corrupt the parent's claim loop
 * or the result message. The structured summary is written to a dedicated IPC
 * file descriptor (fd 3) as a single JSON line; stdout/stderr pass through
 * unchanged for human-readable logs.
 *
 * The task directory travels via the ``APO_CHILD_TASK_DIR`` env var — never
 * from the Control Plane. Task-scoped Apo values (trace endpoint, project,
 * run id, Attempt JWT) are injected by the parent; this process must not see
 * the User API key or Executor Credential.
 */

import { runTaskDir, persistFileArtifacts, isFileArtifact } from "@apo-ai/sdk/agent-task";
import { writeSync } from "node:fs";

const taskDir = process.env.APO_CHILD_TASK_DIR;
const resultFd = Number(process.env.APO_CHILD_RESULT_FD ?? "3");

interface ChildSuccess {
  ok: true;
  summary: Record<string, unknown>;
}
interface ChildFailure {
  ok: false;
  error: string;
}

let resultWritten = false;

function writeResult(payload: ChildSuccess | ChildFailure): void {
  if (resultWritten) return;
  resultWritten = true;
  try {
    const line = JSON.stringify(payload) + "\n";
    writeSync(resultFd, line);
  } catch {
    // best-effort — the dedicated fd is the contract
  }
}

// Graceful termination: the parent cancels/times out via SIGTERM → 5s grace →
// SIGKILL, and a terminal Ctrl+C reaches this process group directly. Without
// a handler the process dies mid-run with the root span unfinished — the
// backend then holds every step span but not the one that links the trace to
// the run row. Handle the signal by ending the active root span as cancelled,
// flushing it (bounded below the parent's grace period), reporting an honest
// cancelled result, and exiting.
let cancelTrace: ((reason?: string) => Promise<void>) | undefined;
let terminating = false;

function handleTerminationSignal(signal: "SIGINT" | "SIGTERM"): void {
  if (terminating) return;
  terminating = true;
  const exitCode = signal === "SIGINT" ? 130 : 143;
  const bail = setTimeout(() => {
    writeResult({ ok: false, error: "task_cancelled" });
    process.exit(exitCode);
  }, 4_000);
  const flush = cancelTrace ? cancelTrace("cancelled") : Promise.resolve();
  void flush
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(bail);
      writeResult({ ok: false, error: "task_cancelled" });
      process.exit(exitCode);
    });
}

process.on("SIGINT", () => handleTerminationSignal("SIGINT"));
process.on("SIGTERM", () => handleTerminationSignal("SIGTERM"));

async function main(): Promise<number> {
  if (!taskDir) {
    writeResult({ ok: false, error: "APO_CHILD_TASK_DIR not set" });
    return 1;
  }
  try {
    const summary = await runTaskDir(taskDir, {
      registerCancel: (cancel) => {
        cancelTrace = cancel;
      },
    });

    // Upload file artifacts after checks, before fd-3 result.
    const deliverables = (summary as { deliverables?: Record<string, unknown> }).deliverables;
    if (deliverables && Object.values(deliverables).some(isFileArtifact)) {
      try {
        const backendUrl = process.env.APO_BACKEND_URL;
        const taskRunId = process.env.AGENT_TASK_RUN_ID;
        const authToken = process.env.APO_AUTH_TOKEN;
        const prepared = await persistFileArtifacts(deliverables, {
          taskRunId: taskRunId ?? "",
          authToken: authToken ?? "",
          baseUrl: backendUrl ?? "",
          fetch,
        });
        (summary as { deliverables: Record<string, unknown> }).deliverables =
          prepared.jsonDeliverables;
      } catch (artifactErr) {
        // Any error from the persist phase is classified as artifact_persistence
        // so the parent maps it to failure_kind="driver", not task_runtime.
        const msg = (artifactErr as Error).message || String(artifactErr);
        writeResult({ ok: false, error: `artifact_persistence: ${msg}` });
        return 1;
      }
    }

    writeResult({
      ok: true,
      summary: summary as unknown as Record<string, unknown>,
    });
    return 0;
  } catch (err) {
    writeResult({ ok: false, error: (err as Error).message || String(err) });
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    writeResult({ ok: false, error: (err as Error).message || String(err) });
    process.exit(1);
  });
