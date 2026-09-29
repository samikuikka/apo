import type { JudgeConfig } from "../checks/t.ts";
import type { JudgeToolsConfig, McpServerConfig } from "../checks/mcp-tools.ts";

export type TaskDefinition<
  TAdapterName extends string = string,
  TDeliverable extends string = string,
> = {
  id: string;
  adapter: TAdapterName;
  description?: string;
  deliverables: TDeliverable[];
  maxTurns?: number;
  metadata?: Record<string, unknown>;
  checks?: string | false;
  /**
   * Task-level judge layer (#161): overrides the run-level `runTask({ judge })`
   * config and is itself overridden per `t.judge` call. Lets a task grade
   * differently from its suite — a stronger model, or a custom briefing via
   * `prompt` that tells the judge what it is grading.
   */
  judge?: Partial<JudgeConfig>;
  /**
   * Task-level judge-tools layer: MCP evidence servers for `t.agent` sessions
   * in this task. Overrides `runTask({ judgeTools })`, is overridden per
   * `t.agent(..., { tools: { mcp } })` call. Arrays replace, never concat.
   */
  judgeTools?: JudgeToolsConfig;
  /**
   * MCP servers declared for the AGENT UNDER TEST (the adapter plane — a
   * separate declaration from `judgeTools`). Adapters that honor it resolve
   * relative `command`/`args` paths against the task directory and expose
   * the tools as `mcp__<server>__<tool>`; trace assertions can match those
   * stable names. Declaring the harness's tool surface here keeps the task
   * portable across harnesses.
   */
  mcpServers?: McpServerConfig[];
};

export type TaskConfig<TDeliverable extends string = string> = Omit<
  TaskDefinition<string, TDeliverable>,
  "adapter"
>;

export type FileEntry = {
  relativePath: string;
  absolutePath: string;
};
