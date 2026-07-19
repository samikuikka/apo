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
 * Use the generic overload of {@link defineCheck} (a.k.a. ``test``) to get
 * typed deliverables in the callback:
 *
 * ```ts
 * type Deliverables = { result: ReviewResult; stats: Stats };
 * const check = test<Deliverables>;
 * check("id", (t, { deliverables }) => {
 *   deliverables.result  // typed as ReviewResult
 * });
 * ```
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

type CheckFn<TDeliverables = Record<string, unknown>> = (
  t: TestContext,
  ctx: CheckContext<TDeliverables>,
) => Promise<void> | void;

type RegisteredCheck = { id: string; fn: CheckFn };

const REGISTRY_KEY = Symbol.for("@apo/sdk/agent-task/check-registry");
const registryStore = globalThis as typeof globalThis & {
  [key: symbol]: unknown;
};
const registry = (registryStore[REGISTRY_KEY] ??= []) as RegisteredCheck[];

/** Register a check. The `fn` receives the assertion surface `t` and the output.
 *
 * Pass a deliverables type to get end-to-end type safety:
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
  registry.push({ id, fn });
}

export function resetFlowChecks(): void {
  registry.length = 0;
}

/**
 * Projection-first check runner (SPEC-130 Track C). Runs registered checks
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

  const results = await Promise.all(
    registry.map(async (check) => {
      const rec = new Recorder(locate);
      const t = createTraceTestContext(view, rec, args.judgeConfig);
      let thrownLocation: CheckLocation | undefined;
      try {
        await check.fn(t, {
          deliverables: args.deliverables,
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
        // SPEC-130 Track D: stamp the snapshot source so consumers can detect
        // the deprecated legacy-flow compatibility path (source="legacy-flow").
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
