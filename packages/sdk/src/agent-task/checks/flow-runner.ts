/**
 * Check runner — builds a {@link TestContext} (`t`) per registered check from
 * a {@link TraceProjectionSnapshot}, runs it, and aggregates every recorded
 * assertion into one evaluation result per check.
 */

import { TraceView } from "../trace-projection/view.ts";
import type { TraceProjectionSnapshot } from "../trace-projection/types.ts";
import type { CheckLocation, EvaluationItemResult } from "../run/types.ts";
import { createTraceTestContext, type TestContext, type JudgeConfig } from "./t.ts";
import { Recorder, type LocateFn } from "./recorder.ts";
import { parseCheckLocation } from "./location.ts";
import { copyFileSync, existsSync, unlinkSync } from "fs";
import { basename } from "path";
import { pathToFileURL } from "url";

/**
 * The check context — deliberately framework-agnostic. `deliverables` is the
 * output; `files`/`task` are optional and untyped here so the core never
 * depends on any agent-framework's types. apo passes its own typed values;
 * other frameworks pass whatever they have (or omit).
 *
 * A task-scoped ``test`` gets typed deliverables from the adapter automatically:
 *
 * ```ts
 * const { test } = task("review", {
 *   adapter: reviewAdapter,
 *   deliverables: ["result"],
 * });
 * test("id", (t, { deliverables }) => {
 *   deliverables.result  // typed as ReviewResult
 * });
 * ```
 *
 * The generic overload of {@link defineCheck} remains available for
 * framework-agnostic checks that have no task scope.
 */
export type CheckContext<TDeliverables = Record<string, unknown>> = {
  deliverables: TDeliverables;
  files?: unknown;
  task?: unknown;
};

export function filePaths(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return (files as Array<{ relativePath: string }>).map((f) => f.relativePath);
}

export type CheckFn<TDeliverables = Record<string, unknown>> = (
  t: TestContext,
  ctx: CheckContext<TDeliverables>,
) => Promise<void> | void;

export type TestRegistration<TDeliverables = Record<string, unknown>> = (
  id: string,
  fn: CheckFn<TDeliverables>,
) => void;

/**
 * A registered `describe()` group — single-level, organizational only. See
 * {@link describe}.
 */
export type CheckGroup = {
  /** Stable, unique group id (kebab-case). Grouping key + React key. */
  id: string;
  /** Human-readable label shown in the dashboard. Defaults to the id. */
  name: string;
};

/** Signature of the `describe` registration primitive. */
export type DescribeRegistration = {
  (id: string, fn: () => void): void;
  (id: string, name: string, fn: () => void): void;
};

type RegisteredCheck = { id: string; fn: CheckFn; group_id?: string; group_name?: string };

const REGISTRY_KEY = Symbol.for("@apo-ai/sdk/agent-task/check-registry");
const registryStore = globalThis as typeof globalThis & {
  [key: symbol]: unknown;
};
const registry = (registryStore[REGISTRY_KEY] ??= []) as RegisteredCheck[];

// ── describe() group registry ────────────────────────────────────────────
// Same Symbol.for globalThis pattern as the check registry so registrations
// survive module re-imports. `currentGroupId` is the slot describe() pushes
// while its callback runs; defineCheck reads it to stamp member checks.
const GROUP_REGISTRY_KEY = Symbol.for("@apo-ai/sdk/agent-task/group-registry");
const groupRegistry = (registryStore[GROUP_REGISTRY_KEY] ??= []) as CheckGroup[];
let currentGroupId: string | null = null;
let currentGroupName: string | null = null;

/** Register a check. The `fn` receives the assertion surface `t` and the output.
 *
 * Framework-agnostic callers can pass a deliverables type explicitly:
 * ```ts
 * type Deliverables = { result: ReviewResult; stats: Stats };
 * defineCheck<Deliverables>("id", (t, { deliverables }) => { ... });
 * ```
 */
export function defineCheck<TDeliverables>(
  id: string,
  fn: CheckFn<TDeliverables>,
): void;
export function defineCheck(id: string, fn: CheckFn): void;
export function defineCheck(id: string, fn: CheckFn): void {
  if (registry.some((c) => c.id === id)) {
    throw new Error(`Duplicate check id '${id}'`);
  }
  registry.push({
    id,
    fn,
    ...(currentGroupId ? { group_id: currentGroupId } : {}),
    ...(currentGroupName ? { group_name: currentGroupName } : {}),
  });
}

export function resetFlowChecks(): void {
  registry.length = 0;
  groupRegistry.length = 0;
  currentGroupId = null;
  currentGroupName = null;
}

/**
 * Register a single-level group of checks. Runs `fn` synchronously;
 * any `test()`/`defineCheck()` call inside it is stamped with the group's id
 * and display name, so the dashboard can nest those checks under a collapsible
 * header with a roll-up verdict.
 *
 * Groups are **organizational only** — they do not change execution order,
 * concurrency, or the task verdict. Nesting is prohibited: calling `describe`
 * inside a `describe` callback throws. Use sibling groups under one task
 * instead.
 *
 * The `id` is stable (survives display-name edits); `name` is the human label
 * shown in the dashboard and defaults to `id` when omitted.
 *
 * ```ts
 * const { test, describe } = task("bind", { adapter, deliverables });
 * describe("rules", "Rules — each comment becomes a rule", () => {
 *   RULE_GOLD.forEach((g) => test(`R-${g.id} — …`, async (t, { deliverables }) => { … }));
 * });
 * ```
 */
export function describe(id: string, fn: () => void): void;
export function describe(id: string, name: string, fn: () => void): void;
export function describe(
  id: string,
  nameOrFn: string | (() => void),
  fn?: () => void,
): void {
  const name = typeof nameOrFn === "string" ? nameOrFn : id;
  const body = typeof nameOrFn === "string" ? fn! : nameOrFn;
  if (currentGroupId !== null) {
    throw new Error(
      `describe("${id}") cannot nest inside describe("${currentGroupId}"); groups are single-level only.`,
    );
  }
  if (groupRegistry.some((g) => g.id === id)) {
    throw new Error(`Duplicate describe id '${id}'`);
  }
  groupRegistry.push({ id, name });
  currentGroupId = id;
  currentGroupName = name;
  try {
    body();
  } finally {
    currentGroupId = null;
    currentGroupName = null;
  }
}

/**
 * Projection-first check runner. Runs registered checks
 * against a {@link TraceView} built from a {@link TraceProjectionSnapshot}.
 *
 * Trace-dependent assertions that need unavailable evidence (e.g. timing,
 * errors) record ``outcome="unsupported"`` (pass=false) instead of vacuously
 * passing. Value assertions (``t.check``) and LLM assertions (``t.judge``)
 * are unaffected by capabilities.
 */
export async function runTraceChecks(args: {
  snapshot: TraceProjectionSnapshot;
  deliverables: Record<string, unknown>;
  files?: unknown;
  task?: unknown;
  judgeConfig?: JudgeConfig;
  moduleUrl?: string;
  displayFile?: string;
}): Promise<EvaluationItemResult[]> {
  const view = new TraceView(args.snapshot);

  const locate: LocateFn | undefined =
    args.moduleUrl && args.displayFile
      ? (stack) => parseCheckLocation(stack, args.moduleUrl!, args.displayFile!)
      : undefined;

  // Task frame for judge briefings (#161): the id/description every
  // `t.judge` call in this run can be briefed with.
  const taskMeta = readTaskMeta(args.task);

  const results = await Promise.all(
    registry.map(async (check) => {
      const rec = new Recorder(locate);
      const reads = trackDeliverableReads(args.deliverables);
      const t = createTraceTestContext(view, rec, args.judgeConfig, {
        taskId: taskMeta.id ?? "",
        ...(taskMeta.description !== undefined ? { taskDescription: taskMeta.description } : {}),
        checkName: check.id,
        readDeliverableNames: reads.names,
      });
      let thrownLocation: CheckLocation | undefined;
      try {
        await check.fn(t, {
          deliverables: reads.proxied,
          files: args.files,
          task: args.task,
        });
      } catch (error) {
        thrownLocation = locate
          ? locate(error instanceof Error ? error.stack ?? "" : "")
          : undefined;
        rec.record("check-error", false, error instanceof Error ? error.message : String(error), {
          location: thrownLocation,
        });
      }

      const failed = rec.all.filter((r) => !r.pass);
      const pass = failed.length === 0;
      const reasoning =
        failed.length > 0
          ? failed.map((r) => r.reasoning || r.id).join("; ")
          : rec.all.length > 0
            ? "passed"
            : "no assertions recorded";
      const location = failed.find((r) => r.location)?.location;
      const judge = rec.all.find((r) => r.judge)?.judge;

      return {
        id: check.id,
        pass,
        reasoning,
        evaluator_type: "code" as const,
        ...(judge ? { judge } : {}),
        ...(location ? { location } : {}),
        ...(args.displayFile ? { source_file: args.displayFile } : {}),
        ...(rec.all.length > 0
          ? { assertions: rec.all.map((a) => ({ ...a })) }
          : {}),
        ...(check.group_id ? { group_id: check.group_id } : {}),
        ...(check.group_name ? { group_name: check.group_name } : {}),
        // stamp the snapshot source so consumers can tell projection-first
        // results (canonical) from locally recorded snapshots.
        ...(args.snapshot.source !== "canonical"
          ? { source: args.snapshot.source }
          : {}),
      };
    }),
  );

  return results;
}

/**
 * Loads a user's `checks.ts` (which registers checks via `test(...)`),
 * then runs them against the projection snapshot + deliverables. Mirrors the
 * legacy loader: copy to a temp module path, import, delete.
 */
export async function loadAndRunFlowChecks(
  checksPath: string | null,
  args: {
    snapshot: TraceProjectionSnapshot;
    deliverables: Record<string, unknown>;
    files?: unknown;
    task?: unknown;
    judgeConfig?: JudgeConfig;
  },
  brokenDeliverables: Record<string, string> = {},
): Promise<EvaluationItemResult[]> {
  if (!checksPath) return [];

  resetFlowChecks();
  const moduleUrl = await loadChecksModule(checksPath);
  if (moduleUrl === null || registry.length === 0) return [];

  return runTraceChecks({
    snapshot: args.snapshot,
    deliverables: proxyBrokenDeliverables(args.deliverables, brokenDeliverables),
    files: args.files,
    task: args.task,
    judgeConfig: args.judgeConfig,
    moduleUrl,
    displayFile: basename(checksPath),
  });
}

export async function loadChecksModule(checksPath: string): Promise<string | null> {
  const tempModulePath = `${checksPath}.${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.ts`;
  try {
    copyFileSync(checksPath, tempModulePath);
    const moduleUrl = pathToFileURL(tempModulePath).href;
    // eslint-disable-next-line react-doctor/no-dynamic-import-path -- runtime loading of user task checks
    await import(moduleUrl);
    // If the module didn't register any checks, signal that to the caller.
    if (registry.length === 0) return null;
    return moduleUrl;
  } finally {
    if (existsSync(tempModulePath)) unlinkSync(tempModulePath);
  }
}

export function proxyBrokenDeliverables(
  deliverables: Record<string, unknown>,
  brokenDeliverables: Record<string, string>,
): Record<string, unknown> {
  if (Object.keys(brokenDeliverables).length === 0) return deliverables;
  return new Proxy(deliverables, {
    get(target, property, receiver) {
      if (typeof property === "string" && property in brokenDeliverables) {
        throw new Error(brokenDeliverables[property]);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/**
 * Read the judge-briefing fields off the (deliberately untyped) task object:
 * `id` and `description` per the TaskDefinition. Values arrive defensively
 * narrowed because this module never imports task types.
 */
function readTaskMeta(task: unknown): { id?: string; description?: string } {
  if (!task || typeof task !== "object") return {};
  const record = task as { id?: unknown; description?: unknown };
  return {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
  };
}

/**
 * Wrap a check's deliverables so reads are recorded in order. `t.judge`
 * reports the keys read so far as `deliverableNames` in its context — the
 * judge's briefing can then say whether it is reading the memo or the
 * redline, which positional values alone never revealed (#161).
 */
function trackDeliverableReads(deliverables: Record<string, unknown>): {
  proxied: Record<string, unknown>;
  names: () => string[];
} {
  const read = new Set<string>();
  const proxied = new Proxy(deliverables, {
    get(target, property, receiver) {
      if (
        typeof property === "string" &&
        Object.prototype.hasOwnProperty.call(target, property)
      ) {
        read.add(property);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { proxied, names: () => [...read] };
}
