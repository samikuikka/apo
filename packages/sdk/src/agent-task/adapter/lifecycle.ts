import type {
  AdapterDefinition,
  AdapterRuntimeState,
  AdapterSession,
  CollectedDeliverables,
} from "./types.ts";
import type { FileEntry, TaskDefinition } from "../task/types.ts";
import type { AgentTaskTraceContext } from "../tracing.ts";
import { createNoopAgentTaskTraceContext } from "../tracing.ts";

export type AdapterLifecycleContext = {
  task: TaskDefinition;
  taskDir: string;
  files: FileEntry[];
  trace?: AgentTaskTraceContext;
};

export type DriveTurnsFn = (
  session: AdapterSession,
  context: AdapterLifecycleContext,
) => Promise<void>;

export type AdapterLifecycleResult = {
  deliverables: CollectedDeliverables;
  session: AdapterSession;
  state?: AdapterRuntimeState;
};

export async function runAdapterLifecycle(
  adapter: AdapterDefinition,
  context: AdapterLifecycleContext,
  driveTurns: DriveTurnsFn,
): Promise<AdapterLifecycleResult> {
  const state = await initializeAdapter(adapter, context);
  const trace = context.trace ?? createNoopAgentTaskTraceContext();
  const session = await adapter.startSession({ ...context, state, trace });

  try {
    await driveTurns(session, { ...context, trace });
  } catch (error) {
    await cleanupAdapter(adapter, { ...context, trace }, state, session);
    throw error;
  }

  const deliverables = await adapter.collectDeliverables({
    ...context,
    state,
    session,
    trace,
  });

  await cleanupAdapter(adapter, { ...context, trace }, state, session);

  return { deliverables, session, state };
}

async function initializeAdapter(
  adapter: AdapterDefinition,
  context: AdapterLifecycleContext,
): Promise<AdapterRuntimeState | undefined> {
  if (!adapter.initialize) {
    return undefined;
  }

  const result = await adapter.initialize({
    task: context.task,
    taskDir: context.taskDir,
    files: context.files,
    trace: context.trace ?? createNoopAgentTaskTraceContext(),
  });

  return result ?? undefined;
}

async function cleanupAdapter(
  adapter: AdapterDefinition,
  context: AdapterLifecycleContext,
  state: AdapterRuntimeState | undefined,
  session?: AdapterSession,
): Promise<void> {
  if (adapter.cleanup) {
    try {
      await adapter.cleanup({
        task: context.task,
        taskDir: context.taskDir,
        files: context.files,
        state,
        session,
        trace: context.trace ?? createNoopAgentTaskTraceContext(),
      });
    } catch (error) {
      console.error(
        "[AdapterRuntime] Cleanup failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (session?.close) {
    try {
      await session.close();
    } catch {
      // ignore close errors
    }
  }
}
