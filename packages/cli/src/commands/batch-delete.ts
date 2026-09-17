/**
 * `apo batch delete <batch-id> --yes` — permanently delete a batch run.
 *
 * For batches whose results are garbage end to end (infrastructure failure,
 * wrong environment): removes the batch, every task run it owns (checks,
 * judgments, corrections, deliverables, attempts, traces), and its task
 * revision bundles. Destructive and irreversible: `--yes` is required.
 * Never prompts — safe for agents and CI.
 */

import { parseArgs, requirePositional } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatJson } from "../lib/format.ts";
import { apiDelete } from "../lib/api.ts";
import { resolveBatchId } from "../lib/batch-resolve.ts";
import { reportCommandError } from "../lib/command-error.ts";

type DeletionCounts = {
  ok: true;
  deleted_runs: number;
  deleted_traces: number;
  deleted_calls: number;
  deleted_batches: number;
};

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const json = flags.json === true;
  const confirmed = flags.yes === true;

  let input: string;
  try {
    input = requirePositional(positional, 0, "batch-id");
  } catch {
    console.error("Missing required argument: <batch-id>");
    console.error(dim("Usage: apo batch delete <batch-id> --yes"));
    return 2;
  }

  let batchId: string;
  try {
    batchId = await resolveBatchId(config.backendUrl, input, config);
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  if (!confirmed) {
    console.log(`${bold(batchId)} ${dim("would be deleted with all its task runs")}`);
    console.error(dim("Pass --yes to permanently delete — this cannot be undone."));
    return 2;
  }

  let counts: DeletionCounts;
  try {
    counts = await apiDelete<DeletionCounts>(
      config.backendUrl,
      `/v1/agent-task-batch-runs/${encodeURIComponent(batchId)}`,
      config,
    );
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  if (json) {
    console.log(formatJson({ batch_id: batchId, ...counts }));
    return 0;
  }

  console.log(
    `${bold(batchId)} deleted  ${dim(
      `(${counts.deleted_runs} run${counts.deleted_runs === 1 ? "" : "s"}, ` +
        `${counts.deleted_traces} trace${counts.deleted_traces === 1 ? "" : "s"})`,
    )}`,
  );
  return 0;
}
