import { parseArgs, requirePositional } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import {
  DEFAULT_MAX_OBSERVATIONS,
  DEFAULT_LANGFUSE_POLL_TIMING,
  fetchLangfuseTrace,
  LangfuseEmptyTraceError,
  type LangfuseConnectorConfig,
  type LangfusePollTiming,
  type LangfuseTraceGraph,
  pollLangfuseTrace,
  resolveConnectorConfig,
} from "../lib/trace-sources/langfuse-client.ts";
import { convertLangfuseTraceToOtlp } from "../lib/trace-sources/langfuse-otlp.ts";
import {
  ApoAuthError,
  ApoVisibilityTimeoutError,
  pollTraceVisibility,
  submitOtlpChunk,
  type ApoOtlpImportResponse,
} from "../lib/otlp-import.ts";

type LangfuseImportResult = {
  source: "langfuse";
  sourceHost: string;
  sourceTraceId: string;
  traceId: string;
  observationsFetched: number;
  spansSubmitted: number;
  spansAccepted: number;
  spansRejected: number;
  otlpBatchIds: string[];
  projected: boolean;
};

const VISIBILITY_DEADLINE_MS = 15_000;
const VISIBILITY_INTERVAL_MS = 250;

const EXIT_FAILURE = 2;
const EXIT_RETRYABLE = 75;

export interface LangfuseRunDeps {
  pollTiming?: LangfusePollTiming;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type WaitResolution =
  | { kind: "none" }
  | { kind: "ok"; seconds: number }
  | { kind: "error"; message: string };

export async function run(argv: string[], deps: LangfuseRunDeps = {}): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  let sourceTraceId: string;
  try {
    sourceTraceId = requirePositional(positional, 0, "trace-id");
  } catch (error) {
    console.error((error as Error).message);
    return EXIT_FAILURE;
  }

  const wait = resolveWaitFlag(flags["wait"]);
  if (wait.kind === "error") {
    console.error(wait.message);
    return EXIT_FAILURE;
  }

  const connector = (() => {
    try {
      const hostFlag = typeof flags["langfuse-host"] === "string" ? flags["langfuse-host"] : undefined;
      const maxFlag = typeof flags["max-observations"] === "string" ? flags["max-observations"] : undefined;
      return resolveConnectorConfig({ hostFlag, maxObservationsFlag: maxFlag });
    } catch (error) {
      console.error((error as Error).message);
      return null;
    }
  })();
  if (connector === null) return EXIT_FAILURE;

  let graph: LangfuseTraceGraph;
  try {
    graph = await fetchSourceTrace(sourceTraceId, connector, wait, deps);
  } catch (error) {
    if (error instanceof LangfuseEmptyTraceError) {
      console.error(formatEmptyTraceError(error, wait, connector.host));
      return EXIT_RETRYABLE;
    }
    console.error(formatConnectorError(error, connector.host, sourceTraceId));
    return EXIT_FAILURE;
  }

  let converted;
  try {
    converted = convertLangfuseTraceToOtlp(graph);
  } catch (error) {
    console.error(`Failed to convert Langfuse trace ${sourceTraceId}: ${(error as Error).message}`);
    return EXIT_FAILURE;
  }

  const apoConfig = {
    backendUrl: config.backendUrl,
    apiKey: config.apiKey,
    projectId: config.projectId,
  };

  const batchIds: string[] = [];
  let accepted = 0;
  let rejected = 0;

  for (const chunk of converted.otlpRequests) {
    let response: ApoOtlpImportResponse;
    try {
      response = await submitOtlpChunk(config.backendUrl, chunk, apoConfig);
    } catch (error) {
      if (error instanceof ApoAuthError) {
        console.error(error.message);
      } else {
        console.error(
          `OTLP write failed for Langfuse trace ${sourceTraceId} (apo trace ${converted.traceId}): ${(error as Error).message}`,
        );
      }
      reportPartialFailure(converted.traceId, batchIds, accepted, rejected);
      return EXIT_FAILURE;
    }
    accepted += response.acceptedSpans;
    rejected += response.rejectedSpans;
    if (response.batchId) batchIds.push(response.batchId);
    if (response.rejectedSpans > 0) {
      console.error(
        `apo rejected ${response.rejectedSpans} span(s) from batch ${response.batchId}` +
          (response.errorMessage ? `: ${response.errorMessage}` : "") +
          `. Already-accepted batches remain durable; re-running is safe.`,
      );
      reportPartialFailure(converted.traceId, batchIds, accepted, rejected);
      return EXIT_FAILURE;
    }
  }

  let projected = false;
  try {
    await pollTraceVisibility(config.backendUrl, converted.traceId, apoConfig, {
      totalDeadlineMs: VISIBILITY_DEADLINE_MS,
      intervalMs: VISIBILITY_INTERVAL_MS,
    });
    projected = true;
  } catch (error) {
    if (error instanceof ApoVisibilityTimeoutError) {
      console.error(
        formatVisibilityTimeout(error, batchIds, sourceTraceId),
      );
    } else {
      console.error(
        `Could not confirm trace visibility for source trace ${sourceTraceId} (apo trace ${converted.traceId}): ${(error as Error).message}`,
      );
    }
    reportPartialFailure(converted.traceId, batchIds, accepted, rejected);
    return EXIT_FAILURE;
  }

  const result: LangfuseImportResult = {
    source: "langfuse",
    sourceHost: connector.host,
    sourceTraceId,
    traceId: converted.traceId,
    observationsFetched: graph.observations.length,
    spansSubmitted: converted.spanCount,
    spansAccepted: accepted,
    spansRejected: rejected,
    otlpBatchIds: batchIds,
    projected,
  };

  if (config.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanResult(result);
  }
  return 0;
}

function printHumanResult(result: LangfuseImportResult): void {
  console.log(`Imported Langfuse trace ${result.sourceTraceId}`);
  console.log(`  Apo trace:     ${result.traceId}`);
  console.log(`  Observations:  ${result.observationsFetched}`);
  console.log(`  OTLP batches:  ${result.otlpBatchIds.length}`);
  console.log(`  Source:        ${result.sourceHost}`);
  console.log(`  Inspect:       apo traces show ${result.traceId}`);
}

function reportPartialFailure(
  mappedTraceId: string,
  batchIds: string[],
  accepted: number,
  rejected: number,
): void {
  if (batchIds.length === 0 && accepted === 0 && rejected === 0) return;
  console.error(
    `Partial state — apo trace ${mappedTraceId}: accepted=${accepted} rejected=${rejected} batches=[${batchIds.join(", ")}]`,
  );
}

function formatConnectorError(
  error: unknown,
  host: string,
  sourceTraceId: string,
): string {
  const message = (error as Error).message;
  // Connector errors already mention sourceTraceId and host. Never echo keys.
  if (message.includes(sourceTraceId)) return message;
  return `Langfuse read failed for source trace ${sourceTraceId} at ${host}: ${message}`;
}

function formatVisibilityTimeout(
  error: ApoVisibilityTimeoutError,
  batchIds: string[],
  sourceTraceId: string,
): string {
  const batches = batchIds.length > 0 ? ` batch ids=[${batchIds.join(", ")}]` : "";
  return `Source trace ${sourceTraceId} → ${error.message}${batches}`;
}

function fetchSourceTrace(
  sourceTraceId: string,
  connector: LangfuseConnectorConfig,
  wait: WaitResolution,
  deps: LangfuseRunDeps,
): Promise<LangfuseTraceGraph> {
  if (wait.kind !== "ok" || wait.seconds <= 0) {
    return fetchLangfuseTrace(sourceTraceId, connector);
  }
  const timing = deps.pollTiming ?? DEFAULT_LANGFUSE_POLL_TIMING;
  return pollLangfuseTrace(sourceTraceId, connector, {
    totalDeadlineMs: wait.seconds * 1000,
    initialIntervalMs: timing.initialIntervalMs,
    maxIntervalMs: timing.maxIntervalMs,
    backoffFactor: timing.backoffFactor,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
}

function resolveWaitFlag(raw: string | boolean | undefined): WaitResolution {
  if (raw === undefined) return { kind: "none" };
  if (raw === true) {
    return {
      kind: "error",
      message: "--wait requires a number of seconds (e.g. --wait 60)",
    };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return {
      kind: "error",
      message: `--wait must be a non-negative integer number of seconds; got ${raw}`,
    };
  }
  return { kind: "ok", seconds: n };
}

function formatEmptyTraceError(
  error: LangfuseEmptyTraceError,
  wait: WaitResolution,
  host: string,
): string {
  if (wait.kind === "ok" && wait.seconds > 0) {
    return `${error.message} (source ${host}). Exit code 75: retryable.`;
  }
  return (
    `${error.message} (source ${host}). The trace may not be ingested yet —` +
    ` Langfuse Cloud typically lags ~30-90s after a run ends.` +
    ` Re-run, or pass --wait <seconds> to poll the source.` +
    ` Exit code 75: retryable.`
  );
}

export { DEFAULT_MAX_OBSERVATIONS };
