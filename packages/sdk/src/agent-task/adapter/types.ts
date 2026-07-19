import type { FileEntry, TaskDefinition } from "../task/types.ts";
import type { AgentTaskTraceContext } from "../tracing.ts";
import type { TurnFn } from "../turn.ts";

export type ValidatableSchemaLike = {
  safeParse: (data: unknown) => {
    success: boolean;
    error?: { message: string };
  };
};

export type DeliverableDefinition =
  | ValidatableSchemaLike
  | {
      schema?: ValidatableSchemaLike;
    }
  | null;

export type CollectedDeliverables = Record<string, unknown>;

export type AgentTurnResult = {
  response: unknown;
};

export type AdapterRuntimeState = Record<string, unknown>;

export type InitializeContext = {
  task: TaskDefinition;
  taskDir: string;
  files: FileEntry[];
  trace: AgentTaskTraceContext;
};

export type StartSessionContext = {
  task: TaskDefinition;
  taskDir: string;
  files: FileEntry[];
  state?: AdapterRuntimeState;
  trace: AgentTaskTraceContext;
};

export type CollectDeliverablesContext = {
  task: TaskDefinition;
  taskDir: string;
  files: FileEntry[];
  state?: AdapterRuntimeState;
  session: AdapterSession;
  trace: AgentTaskTraceContext;
};

export type CleanupContext = {
  task: TaskDefinition;
  taskDir: string;
  files: FileEntry[];
  state?: AdapterRuntimeState;
  session?: AdapterSession;
  trace: AgentTaskTraceContext;
};

export type AdapterSession = {
  sendUserTurn: (
    turn: unknown,
    context: {
      trace: AgentTaskTraceContext;
      turnNumber: number;
      parentSpanId?: string;
    },
  ) => Promise<AgentTurnResult>;
  close?: () => Promise<void>;
};

export type AdapterDefinition = {
  name: string;
  deliverables: Record<string, DeliverableDefinition>;
  turn?: TurnFn;
  initialize?: (ctx: InitializeContext) => Promise<AdapterRuntimeState | void>;
  startSession: (ctx: StartSessionContext) => Promise<AdapterSession>;
  collectDeliverables: (
    ctx: CollectDeliverablesContext,
  ) => Promise<CollectedDeliverables>;
  cleanup?: (ctx: CleanupContext) => Promise<void>;
};

export type TypedAdapterDefinition<
  TName extends string,
  TDeliverables extends Record<string, DeliverableDefinition>,
> = Omit<AdapterDefinition, "name" | "deliverables"> & {
  name: TName;
  deliverables: TDeliverables;
};
