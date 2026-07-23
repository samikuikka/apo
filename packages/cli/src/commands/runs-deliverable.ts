/**
 * `apo runs deliverable <run-id> [name]` — read a run's deliverables without
 * re-rendering the whole run (issue #22). With no name it prints a small
 * manifest (name + type + size); with a name it prints that deliverable's full
 * content. `runs show` keeps large per-check values as manifest-only and points
 * here for the actual content.
 */
import { parseArgs, getFlagValue } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatJson } from "../lib/format.ts";
import { apiGet } from "../lib/api.ts";
import { resolveRunId } from "../lib/runs-resolve.ts";

type RunDetail = {
  id: string;
  deliverables_json: Record<string, unknown> | null;
};

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const taskFilter = getFlagValue(flags, "task");

  const input = positional[0];
  if (!input) {
    console.error("Missing required argument: <run-id>");
    console.error(dim("Usage: apo runs deliverable <run-id> [name]"));
    return 2;
  }
  const name = positional[1];

  let runId: string;
  try {
    runId = await resolveRunId(config.backendUrl, input, config, taskFilter);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "NO_RUNS") {
      const scope = taskFilter ? ` for task "${taskFilter}"` : "";
      console.error(`No runs found${scope}.`);
      return 2;
    }
    console.error(`Cannot connect to backend at ${config.backendUrl}`);
    console.error(dim(message));
    return 2;
  }

  let detail: RunDetail;
  try {
    detail = await apiGet<RunDetail>(
      config.backendUrl,
      `/v1/agent-task-runs/${runId}`,
      undefined,
      config,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) {
      console.error(`Run not found: ${runId}`);
    } else if (
      message.startsWith("Backend error") ||
      message.includes("timed out") ||
      message.includes("Cannot connect")
    ) {
      console.error(message);
    } else {
      console.error(`Cannot connect to backend at ${config.backendUrl}`);
      console.error(dim(message));
    }
    return 2;
  }

  const deliverables = detail.deliverables_json ?? {};
  const keys = Object.keys(deliverables);

  if (keys.length === 0) {
    console.error(`Run ${runId} has no deliverables.`);
    return 0;
  }

  if (name && !(name in deliverables)) {
    console.error(
      `Deliverable "${name}" not found on run ${runId}. Available: ${keys.join(", ")}`,
    );
    return 2;
  }

  if (config.json) {
    if (name) {
      console.log(formatJson(deliverables[name]));
    } else {
      const manifest: Record<string, unknown> = {};
      for (const k of keys) manifest[k] = describeValue(deliverables[k]);
      console.log(formatJson(manifest));
    }
    return 0;
  }

  if (name) {
    printDeliverable(name, deliverables[name]);
  } else {
    printManifest(runId, deliverables);
  }
  return 0;
}

function printManifest(runId: string, deliverables: Record<string, unknown>): void {
  console.log(bold(`Deliverables for run ${runId}:`));
  const nameWidth = Math.max(...Object.keys(deliverables).map((k) => k.length), 4);
  for (const [key, value] of Object.entries(deliverables)) {
    const d = describeValue(value);
    const size =
      d.keys != null
        ? `${d.keys} keys`
        : d.items != null
          ? `${d.items} items`
          : `${(d.chars ?? 0).toLocaleString()} chars`;
    console.log(`  ${key.padEnd(nameWidth)}  ${d.type.padEnd(6)}  ${size}`);
  }
  console.log(dim(`\nRead one: apo runs deliverable <run-id> <name>`));
}

function printDeliverable(name: string, value: unknown): void {
  if (typeof value === "string") {
    console.log(value);
    return;
  }
  console.log(formatJson(value));
}

function describeValue(value: unknown): {
  type: string;
  chars?: number;
  keys?: number;
  items?: number;
} {
  if (typeof value === "string") return { type: "string", chars: value.length };
  if (Array.isArray(value)) return { type: "array", items: value.length };
  if (value && typeof value === "object") {
    return { type: "object", keys: Object.keys(value).length };
  }
  return { type: typeof value };
}
