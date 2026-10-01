/**
 * `apo traces import <path…>` — turn a harness session transcript (Claude
 * Code / Codex session JSONL) into an apo run.
 *
 * The reverse direction of adapter capture: instead of a Task Run replaying
 * its own session, this takes a session you already have on disk — e.g. a
 * production failure from your own Claude Code/Codex usage — and lands it in
 * the project as a full-fidelity trace (typed observations, tokens, cost,
 * tool calls) via the same OTLP path the runners use. From the runs list it
 * is one step away from becoming a task seed.
 *
 * Auth: the CLI's stored `--api-key` (Bearer) or the runner credential env
 * (APO_PUBLIC_KEY/APO_SECRET_KEY → Basic, APO_AUTH_TOKEN → Bearer).
 */
import { readFileSync } from "node:fs";

import { getFlagValues, parseArgs, getFlagValue } from "../lib/args.ts";
import { resolveConfig, type Config } from "../lib/config.ts";
import { dim, formatJson } from "../lib/format.ts";
import { apiGet } from "../lib/api.ts";
import {
  buildApoAuthHeaders,
  detectTranscriptSource,
  exportOtlpTraces,
  parseClaudeCodeTranscript,
  parseCodexTranscript,
  transcriptSessionToOtlp,
  type ParsedTranscriptSession,
  type TranscriptSource,
} from "@apo-ai/sdk/agent-task";

export async function run(argv: string[]): Promise<number> {
  const { flags, multiFlags, positional } = parseArgs(argv);
  const config = resolveConfig(flags);

  const files = positional.filter((value) => value.length > 0);
  if (files.length === 0) {
    console.error("Usage: apo traces import <transcript.jsonl…> [--source auto|claude-code|codex]");
    return 1;
  }

  const rawSource = getFlagValue(flags, "source") ?? "auto";
  if (rawSource !== "auto" && rawSource !== "claude-code" && rawSource !== "codex") {
    console.error(`invalid --source ${rawSource} (expected auto, claude-code, or codex)`);
    return 1;
  }
  const sourceFlag: "auto" | TranscriptSource = rawSource;

  const headers = resolveAuthHeaders(config);
  if (headers === undefined) {
    console.error(
      "No credentials: log in (apo login), pass --api-key, or set APO_PUBLIC_KEY/APO_SECRET_KEY or APO_AUTH_TOKEN.",
    );
    return 1;
  }

  const nameOverride = getFlagValue(flags, "name");
  const tagFlags = getFlagValues(multiFlags, "tag");

  const imported: ImportedTrace[] = [];
  let failures = 0;

  for (const file of files) {
    try {
      const result = await importOne(file, {
        sourceFlag,
        nameOverride,
        tags: tagFlags,
        config,
        headers,
      });
      imported.push(result);
      if (config.json) continue;
      printSummary(result);
    } catch (error) {
      failures += 1;
      console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (config.json) {
    console.log(formatJson(imported));
  } else if (imported.length > 0) {
    console.log("");
    console.log(dim(`Imported ${imported.length} trace(s)`));
  }

  return failures > 0 ? 1 : 0;
}

type ImportedTrace = {
  file: string;
  source: TranscriptSource;
  traceId: string;
  turns: number;
  spans: number;
  model: string | null;
  warnings: string[];
  /** Relative dashboard path (/project/<id>/traces/<traceId>) once the run row is readable. */
  dashboardPath: string | null;
};

async function importOne(
  file: string,
  options: {
    sourceFlag: "auto" | TranscriptSource;
    nameOverride: string | undefined;
    tags: string[];
    config: Config;
    headers: Record<string, string>;
  },
): Promise<ImportedTrace> {
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch (error) {
    throw new Error(`cannot read transcript (${error instanceof Error ? error.message : String(error)})`);
  }

  const source =
    options.sourceFlag === "auto" ? detectTranscriptSource(content) : options.sourceFlag;
  if (source === undefined) {
    throw new Error(
      "could not detect the transcript format — pass --source claude-code or --source codex",
    );
  }

  const session = parseSession(source, content);
  if (session.turns.length === 0) {
    throw new Error("no completed turns found in the transcript");
  }

  const payload = transcriptSessionToOtlp(session, {
    ...(options.nameOverride !== undefined ? { flowName: options.nameOverride } : {}),
    tags: options.tags.length > 0 ? options.tags : undefined,
  });
  await exportOtlpTraces(payload, {
    endpoint: options.config.backendUrl,
    headers: options.headers,
  });

  const traceId = payload.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.traceId ?? "";
  const { model, dashboardPath } = await verifyRun(traceId, options.config);

  return {
    file,
    source,
    traceId,
    turns: session.turns.length,
    spans: payload.resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0,
    model,
    warnings: session.warnings,
    dashboardPath,
  };
}

function parseSession(source: TranscriptSource, content: string): ParsedTranscriptSession {
  return source === "claude-code"
    ? parseClaudeCodeTranscript(content)
    : parseCodexTranscript(content);
}

function resolveAuthHeaders(config: Config): Record<string, string> | undefined {
  if (config.apiKey !== undefined && config.apiKey !== "") {
    return { Authorization: `Bearer ${config.apiKey}` };
  }
  return buildApoAuthHeaders();
}

/**
 * The OTLP route creates the run row at first-seen traceId, but projection
 * (call_count, model) is async — poll briefly so the summary shows what the
 * dashboard will. Absence is not an error: the trace is ingested either way.
 */
async function verifyRun(
  traceId: string,
  config: Config,
): Promise<{ model: string | null; dashboardPath: string | null }> {
  if (traceId === "") return { model: null, dashboardPath: null };
  // The run-detail route scopes by project (same as `traces list`) and nests
  // the run row under `run`.
  const params: Record<string, string> = {};
  if (config.projectId) params.project = config.projectId;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await apiGet<{ run: RunDetail }>(
        config.backendUrl,
        `/v1/runs/${traceId}`,
        params,
        config,
      );
      const run = response.run;
      if (run.call_count === 0 || run.call_count === undefined) {
        if (attempt < 7) {
          await sleep(500);
          continue;
        }
      }
      const project = typeof run.project === "string" ? run.project : config.projectId;
      return {
        model: run.primary_model ?? null,
        dashboardPath: project !== undefined ? `/project/${project}/traces/${traceId}` : null,
      };
    } catch {
      if (attempt < 7) await sleep(500);
    }
  }
  return { model: null, dashboardPath: null };
}

type RunDetail = {
  id: string;
  project?: string | null;
  flow_name?: string | null;
  primary_model?: string | null;
  call_count?: number;
};

function printSummary(result: ImportedTrace): void {
  console.log(`Imported ${result.file} (${result.source})`);
  console.log(`  Trace    ${result.traceId}`);
  console.log(
    `  Turns    ${result.turns}   Spans ${result.spans}   Model ${result.model ?? "unknown"}`,
  );
  if (result.warnings.length > 0) {
    console.log(`  Warnings ${result.warnings.length} (${result.warnings[0]})`);
  }
  if (result.dashboardPath !== null) {
    console.log(`  Open     ${result.dashboardPath}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
