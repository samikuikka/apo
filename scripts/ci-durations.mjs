#!/usr/bin/env node
// Wall-clock durations for GitHub Actions runs, straight from the API's own
// records. The one command to run when asking "why was this pipeline slow".
//
// Usage:
//   node scripts/ci-durations.mjs <run-id> [...]   full per-job/per-step report
//   node scripts/ci-durations.mjs --list [N]       one line per run, last N PR runs (default 10)
//
// Exits 1 when any reported job failed, so a wrapper script can gate on it.
// The mise shim prints a notice onto gh's stdout; parse from the first "{".

import { execFileSync } from "node:child_process";

const STEP_LIST_THRESHOLD_SECONDS = 5;

function ghJson(args) {
  const stdout = execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // `run view` emits one object, `run list` emits an array. The mise shim
  // prints a notice line first, so start at whichever JSON value comes first.
  const candidates = [stdout.indexOf("["), stdout.indexOf("{")].filter(
    (index) => index !== -1,
  );
  const start = Math.min(...candidates);
  if (start === -1) {
    throw new Error(`gh produced no JSON: ${stdout.slice(0, 200)}`);
  }
  return JSON.parse(stdout.slice(start));
}

function secondsBetween(fromIso, toIso) {
  const normalize = (iso) => iso.replace(/\.(\d{3})\d+/, ".$1");
  return Math.max(
    0,
    Math.round((Date.parse(normalize(toIso)) - Date.parse(normalize(fromIso))) / 1000),
  );
}

function formatDuration(seconds) {
  if (seconds < 90) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function reportRun(runId) {
  const run = ghJson([
    "run",
    "view",
    String(runId),
    "--json",
    "workflowName,displayTitle,conclusion,createdAt,updatedAt,jobs",
  ]);
  const total = secondsBetween(run.createdAt, run.updatedAt);
  let stepCount = 0;
  let failedJobs = 0;
  const jobLines = [];
  for (const job of run.jobs) {
    const jobSeconds = secondsBetween(job.startedAt, job.completedAt);
    if (job.conclusion !== "success" && job.conclusion !== "skipped") failedJobs += 1;
    jobLines.push(`  ${job.name}  ${formatDuration(jobSeconds)}  ${job.conclusion}`);
    const timed = job.steps
      .map((step) => ({
        name: step.name,
        seconds: secondsBetween(step.startedAt, step.completedAt),
        conclusion: step.conclusion,
      }))
      .filter((step) => step.seconds > 0);
    stepCount += timed.length;
    const listed = timed.filter((step) => step.seconds >= STEP_LIST_THRESHOLD_SECONDS);
    const omitted = timed.length - listed.length;
    jobLines.push(
      ...listed.map(
        (step) => `    ${formatDuration(step.seconds).padStart(7)}  ${step.name}`,
      ),
    );
    if (omitted > 0) jobLines.push(`    (omitted ${omitted} steps under ${STEP_LIST_THRESHOLD_SECONDS}s)`);
  }
  console.log(
    [
      `run ${runId}  ${run.workflowName}  "${run.displayTitle}"  ${run.conclusion}  total ${formatDuration(total)}`,
      ...jobLines,
      `summary: jobs=${run.jobs.length} timedSteps=${stepCount} failedJobs=${failedJobs}`,
    ].join("\n"),
  );
  return { failedJobs };
}

function listRuns(count) {
  const runs = ghJson([
    "run",
    "list",
    "-e",
    "pull_request",
    "--limit",
    String(count),
    "--json",
    "databaseId,workflowName,displayTitle,conclusion,createdAt,updatedAt",
  ]);
  for (const run of runs) {
    const total = secondsBetween(run.createdAt, run.updatedAt);
    console.log(
      `${run.databaseId}  ${formatDuration(total).padStart(7)}  ${run.conclusion.padEnd(10)}  ${run.workflowName}  "${run.displayTitle}"`,
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--list") {
    listRuns(Number(args[1]) || 10);
    return 0;
  }
  const ids = args.filter((arg) => /^\d+$/.test(arg));
  if (ids.length === 0) {
    console.error("usage: ci-durations.mjs <run-id>... | --list [N]");
    return 2;
  }
  let failed = 0;
  for (const id of ids) failed += reportRun(id).failedJobs;
  return failed > 0 ? 1 : 0;
}

process.exit(main());
