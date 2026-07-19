import type { TaskFiles } from "./task/TaskFiles.ts";

export type TurnRecord = {
  turnNumber: number;
  input: unknown;
  output: unknown;
};

export type TurnContext = {
  files: TaskFiles;
  transcript: TurnRecord[];
};

export type TurnFn<TUserTurn = unknown> = (
  ctx: TurnContext,
) => Promise<TUserTurn | null> | TUserTurn | null;

const TURN_KEY = Symbol.for("@apo/sdk/agent-task/task-turn");

export function turn<TUserTurn>(fn: TurnFn<TUserTurn>): void {
  (globalThis as Record<symbol, unknown>)[TURN_KEY] = fn;
}

export function getTaskTurn(): TurnFn | undefined {
  return (globalThis as Record<symbol, unknown>)[TURN_KEY] as TurnFn | undefined;
}

export function resetTaskTurn(): void {
  delete (globalThis as Record<symbol, unknown>)[TURN_KEY];
}

export function resolveTurn(
  adapterTurn: TurnFn | undefined,
  taskTurn: TurnFn | undefined,
): TurnFn {
  const resolved = taskTurn ?? adapterTurn;
  if (!resolved) {
    throw new Error(
      "No turn behavior defined. Add a turn() call to your task file or a turn field to your adapter.",
    );
  }
  return resolved;
}
