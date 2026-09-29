import type {
  AdapterDefinition,
  CollectedDeliverables,
  DeliverableDefinition,
  TypedAdapterDefinition,
} from "../adapter/types.ts";
import {
  defineCheck,
  describe,
  type DescribeRegistration,
  type TestRegistration,
} from "../checks/flow-runner.ts";
import type { TaskConfig, TaskDefinition } from "./types.ts";

const TASK_ADAPTER_SYMBOL = Symbol.for("agent-task.adapter-definition");

// ── Task registry (same Symbol.for pattern as the check registry) ─────────
const TASK_REGISTRY_KEY = Symbol.for("@apo-ai/sdk/agent-task/task-registry");
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

export type TaskScope<TDeliverables> = {
  test: TestRegistration<TDeliverables>;
  /**
   * Register a single-level group of checks. See
   * {@link describe} in `checks/flow-runner.ts`. Returned from `task()` so the
   * `test` inside the callback stays task-scoped (typed deliverables).
   */
  describe: DescribeRegistration;
};

/**
 * Register a task + its checks in ONE file. The `name` is the task id;
 * `config` includes the adapter, deliverables, and other metadata. Checks
 * are registered through the returned, adapter-typed `test` function.
 *
 * ```ts
 * const { test } = task("code-review", {
 *   adapter: realAgentAdapter,
 *   deliverables: ["result", "tool_log", "stats"],
 *   maxTurns: 2,
 * });
 *
 * test("reviewed-methodically", (t, { deliverables }) => {
 *   t.check(deliverables.result, includes("finding"));
 * });
 * ```
 */
export function task<
  const TTaskId extends string,
  const TAdapterName extends string,
  const TDeliverableDefs extends Record<string, DeliverableDefinition>,
  TCollected extends CollectedDeliverables,
  const TSelected extends readonly (
    DeliverableKey<TCollected> & keyof TDeliverableDefs
  )[],
>(
  name: TTaskId,
  config: Omit<
    TaskConfig<TSelected[number] & string>,
    "id" | "checks" | "deliverables"
  > & {
    adapter: TypedAdapterDefinition<
      TAdapterName,
      TDeliverableDefs,
      TCollected
    >;
    deliverables: TSelected;
  },
): TaskScope<SelectedDeliverables<TCollected, TSelected>> {
  const adapter = config.adapter;
  const {
    adapter: _adapter,
    deliverables,
    ...rest
  } = config;
  const definedTask = {
    ...rest,
    id: name,
    adapter: adapter.name,
    deliverables: [...deliverables],
  } satisfies TaskDefinition;

  attachAdapter(definedTask, adapter);

  taskRegistry.push(definedTask);
  return {
    test: defineCheck as TestRegistration<
      SelectedDeliverables<TCollected, TSelected>
    >,
    describe: describe as DescribeRegistration,
  };
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

type DeliverableKey<TCollected> = TCollected extends unknown
  ? keyof TCollected & string
  : never;

type DeliverableValue<
  TCollected,
  TKey extends PropertyKey,
> = TCollected extends unknown
  ? TKey extends keyof TCollected
    ? TCollected[TKey]
    : never
  : never;

type SelectedDeliverables<
  TCollected,
  TSelected extends readonly PropertyKey[],
> = {
  [TKey in TSelected[number]]-?: Exclude<
    DeliverableValue<TCollected, TKey>,
    null | undefined
  >;
};
