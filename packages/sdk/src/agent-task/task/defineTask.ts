import type { TypedAdapterDefinition } from "../adapter/types.ts";
import type { DeliverableDefinition } from "../adapter/types.ts";
import type { AdapterDefinition } from "../adapter/types.ts";
import type { TaskConfig, TaskDefinition } from "./types.ts";

const TASK_ADAPTER_SYMBOL = Symbol.for("agent-task.adapter-definition");

// ── Task registry (same Symbol.for pattern as the check registry) ─────────
const TASK_REGISTRY_KEY = Symbol.for("@apo/sdk/agent-task/task-registry");
const taskRegistryStore = globalThis as typeof globalThis & {
  [key: symbol]: unknown;
};
const taskRegistry = (taskRegistryStore[TASK_REGISTRY_KEY] ??= []) as TaskDefinition[];

export function resetTaskRegistry(): void {
  taskRegistry.length = 0;
}

export function getRegisteredTask(): TaskDefinition | undefined {
  return taskRegistry[0];
}

// ── Backward compat ────────────────────────────────────────────────────────
export type DefinedTask<
  TName extends string,
  TDeliverableDefs extends Record<string, DeliverableDefinition>,
> = TaskDefinition<TName, keyof TDeliverableDefs & string> & {
  readonly [TASK_ADAPTER_SYMBOL]: TypedAdapterDefinition<
    TName,
    TDeliverableDefs
  >;
};

/** Legacy two-file task definition. New tasks should use {@link task}. */
export function defineTask<
  const TName extends string,
  const TDeliverableDefs extends Record<string, DeliverableDefinition>,
>(
  adapter: TypedAdapterDefinition<TName, TDeliverableDefs>,
  config: TaskConfig<keyof TDeliverableDefs & string>,
): DefinedTask<TName, TDeliverableDefs> {
  const definedTask = {
    ...config,
    adapter: adapter.name,
  } as DefinedTask<TName, TDeliverableDefs>;

  attachAdapter(definedTask, adapter);
  return definedTask;
}

/**
 * Register a task + its checks in ONE file. The `name` is the task id;
 * `config` includes the adapter, deliverables, and other metadata. Checks
 * are registered via top-level `check("id", fn)` calls in the same file
 * (side-effect registration, like Jest's `test()`).
 *
 * ```ts
 * task("code-review", {
 *   adapter: realAgentAdapter,
 *   deliverables: ["result", "tool_log", "stats"],
 *   maxTurns: 2,
 * });
 *
 * // A task that needs dev-machine resources (cloud creds, VPC, stage) can
 * // declare execution: "local" so `apo task run` runs it on the caller's
 * // machine while still recording a backend run row (SPEC-136).
 * task("bind-e2e", {
 *   adapter: bindAdapter,
 *   deliverables: ["summary"],
 *   execution: "local",
 * });
 *
 * check("reviewed-methodically", (t) => { ... });
 * ```
 */
export function task<
  const TName extends string,
  const TDeliverableDefs extends Record<string, DeliverableDefinition>,
>(
  name: TName,
  config: Omit<TaskConfig<keyof TDeliverableDefs & string>, "id" | "checks"> & {
    adapter: TypedAdapterDefinition<TName, TDeliverableDefs>;
  },
): void {
  const adapter = config.adapter;
  const { adapter: _adapter, ...rest } = config;
  const definedTask = {
    ...rest,
    id: name,
    adapter: adapter.name,
  } as TaskDefinition;

  attachAdapter(definedTask, adapter);

  taskRegistry.push(definedTask);
}

export function getTaskAdapterDefinition(
  task: object,
): AdapterDefinition | null {
  return (task as { [TASK_ADAPTER_SYMBOL]?: AdapterDefinition })[
    TASK_ADAPTER_SYMBOL
  ] ?? null;
}

function attachAdapter(taskDefinition: object, adapter: AdapterDefinition): void {
  Object.defineProperty(taskDefinition, TASK_ADAPTER_SYMBOL, {
    value: adapter,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}
