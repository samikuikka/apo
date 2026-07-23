import { formatJson } from "../lib/format.ts";
import { parseArgs, getFlagValue, getBoolFlag } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import type { Config } from "../lib/config.ts";

/**
 * apo reprice — re-compute stored costs against current pricing.
 *
 * A history-rewriting operator action (SPEC-136 ticket 12). Kicks off a
 * backend reprice job over the admin endpoint, then polls until done — the
 * kick-off/poll pattern dodges the 15s HTTP timeout (mirrors task-run.ts).
 *
 * Usage:
 *   apo reprice [--project <id>] [--model-id <int>] [--since <datetime>]
 *               [--until <datetime>] [--dry-run] [--admin-key <key>]
 */

interface RepriceSummary {
  repriced: number;
  skipped_provided: number;
  skipped_no_usage: number;
  skipped_no_match: number;
  net_delta: number;
}

interface RepriceJobStatus {
  job_id: string;
  status: "running" | "done" | "error";
  summary: RepriceSummary | null;
  error: string | null;
}

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_MS = 10 * 60 * 1000; // 10 min ceiling

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const project = getFlagValue(flags, "project");
  const modelId = getFlagValue(flags, "model-id");
  const since = getFlagValue(flags, "since");
  const until = getFlagValue(flags, "until");
  const dryRun = getBoolFlag(flags, "dry-run");
  const adminKey =
    getFlagValue(flags, "admin-key") ?? process.env.APO_ADMIN_KEY ?? "";

  const body: Record<string, unknown> = { dry_run: dryRun };
  if (project) body.project = project;
  if (modelId) body.model_id = Number(modelId);
  if (since) body.since = since;
  if (until) body.until = until;

  const kickOff = await postReprice(config, "/v1/admin/reprice", body, adminKey);
  if (kickOff === null) return 2;

  if (config.json) {
    const final = await pollJob(config, kickOff.job_id, adminKey);
    if (final === null) return 2;
    console.log(formatJson(final));
    return 0;
  }

  if (dryRun) {
    process.stderr.write("Dry run — no costs will be overwritten.\n");
  }
  process.stderr.write(`Reprice job ${kickOff.job_id} started...\n`);

  const final = await pollJob(config, kickOff.job_id, adminKey);
  if (final === null || final.status === "error") {
    console.error(
      `Reprice failed: ${final?.error ?? "could not retrieve job status"}`,
    );
    return 2;
  }

  printSummary(final.summary);
  return 0;
}

function printSummary(summary: RepriceSummary | null): void {
  if (summary === null) {
    console.log("Reprice complete (no summary).");
    return;
  }
  const deltaUsd = summary.net_delta / 1_000_000;
  const deltaStr = deltaUsd >= 0 ? `+$${deltaUsd.toFixed(6)}` : `-$${Math.abs(deltaUsd).toFixed(6)}`;
  console.log(
    `Repriced ${summary.repriced} calls (${deltaStr} net delta).`,
  );
  console.log(
    `Skipped: ${summary.skipped_no_usage} (no usage map — pre-migration), ` +
      `${summary.skipped_provided} (provided cost), ${summary.skipped_no_match} (no matching model).`,
  );
}

async function pollJob(
  config: Config,
  jobId: string,
  adminKey: string,
): Promise<RepriceJobStatus | null> {
  const maxAttempts = Math.ceil(MAX_POLL_MS / POLL_INTERVAL_MS);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await getRepriceStatus(
      config,
      `/v1/admin/reprice/${jobId}`,
      adminKey,
    );
    if (status === null) return null;
    if (status.status === "done" || status.status === "error") {
      return status;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

async function postReprice(
  config: Config,
  path: string,
  body: unknown,
  adminKey: string,
): Promise<{ job_id: string } | null> {
  const url = new URL(path, config.backendUrl);
  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey ?? ""}`,
        "x-admin-key": adminKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`Backend error ${response.status}: ${text}`);
      return null;
    }
    return (await response.json()) as { job_id: string };
  } catch {
    console.error(`Cannot connect to backend at ${config.backendUrl}`);
    return null;
  }
}

async function getRepriceStatus(
  config: Config,
  path: string,
  adminKey: string,
): Promise<RepriceJobStatus | null> {
  const url = new URL(path, config.backendUrl);
  try {
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${config.apiKey ?? ""}`,
        "x-admin-key": adminKey,
      },
    });
    if (!response.ok) return null;
    return (await response.json()) as RepriceJobStatus;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
