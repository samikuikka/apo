import type {
  AgentTaskBatchRunConfigurationSummary,
  AgentTaskRunConfiguration,
} from "./agent-task-api";

/**
 * Drop the provider/org prefix from a model id for compact display.
 * `openai/gpt-5.1` → `gpt-5.1`, `anthropic/claude-opus-4.1` → `claude-opus-4.1`.
 * The provider isn't interesting at a glance and long qualified names overflow
 * the Execution column. The full name stays available via the tooltip/title and
 * remains the value stored, filtered, and compared on.
 */
export function shortModel(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function hasEffort(config: AgentTaskRunConfiguration): boolean {
  return Boolean(config.effort && config.effort !== "");
}

/**
 * render a Task Run's adapter-reported configuration as a compact string:
 * `model · effort` when the adapter reported an effort, the bare model when
 * it did not (most models have no reasoning-effort control, so a dangling
 * `· —` read as missing data rather than as "no effort configured"). A run
 * that reported no configuration at all renders as a lone `—`. Monochrome
 * data — never a colored badge (see docs/design.md).
 */
export function formatRunExecution(
  config: AgentTaskRunConfiguration | null,
): string {
  if (!config) return "\u2014";
  return hasEffort(config)
    ? `${shortModel(config.model)} · ${config.effort}`
    : shortModel(config.model);
}

/**
 * The full, provider-qualified form — used for tooltips so the exact identity
 * is one hover away even though the visible cell is shortened.
 */
export function formatRunExecutionFull(
  config: AgentTaskRunConfiguration | null,
): string {
  if (!config) return "\u2014";
  return hasEffort(config)
    ? `${config.model} · ${config.effort}`
    : config.model;
}

/**
 * render a Batch Run's derived configuration summary.
 *
 * - uniform → the single `model · effort` pair;
 * - mixed   → `Mixed · N configs`;
 * - partial → `Partial · X/Y reported`;
 * - unknown → `—`.
 *
 * Never substitutes the most common child model as though the batch were
 * uniform — a mixed/partial batch is labeled honestly.
 */
export function formatBatchExecution(
  summary: AgentTaskBatchRunConfigurationSummary,
): string {
  switch (summary.state) {
    case "uniform": {
      const pair = summary.configurations[0];
      return pair ? formatRunConfigurationPair(pair) : "\u2014";
    }
    case "mixed":
      return `Mixed · ${summary.configurations.length} config${summary.configurations.length === 1 ? "" : "s"}`;
    case "partial":
      return `Partial · ${summary.reported_task_runs}/${summary.total_task_runs} reported`;
    case "unknown":
    default:
      return "\u2014";
  }
}

function formatRunConfigurationPair(
  pair: AgentTaskRunConfiguration,
): string {
  return hasEffort(pair)
    ? `${shortModel(pair.model)} · ${pair.effort}`
    : shortModel(pair.model);
}
