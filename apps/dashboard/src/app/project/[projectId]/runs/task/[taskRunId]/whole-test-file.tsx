"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type {
  CheckResult,
  TaskDefinitionRevisionSummary,
  TaskFileContentResponse,
} from "@/lib/agent-task-api";
import { CodeViewer } from "@/components/CodeViewer";
import { useUrlParam } from "@/hooks/use-url-state";
import { buildAssertionParam } from "@/lib/assertion-select";
import { cn } from "@/lib/utils";
import {
  buildFileDiagnostics,
  buildTestFileModel,
  type TestFileModel,
  type TestFileRegion,
} from "@/lib/test-file-regions";
import { useWholeFileSource } from "./use-whole-file-source";

/** Where a marked line's click-through lands: the check (and when recorded,
 *  the assertion) whose detail the checks list opens. */
interface DiagnosticTarget {
  checkId: string;
  assertionId?: string;
}

export function WholeTestFile({
  checks,
  checksSource,
  taskDefinition,
  taskRunId,
  taskId,
  projectId,
  commitSha,
  sourceType,
  children,
}: {
  checks: CheckResult[];
  /** The stock useCheckSource result for the same run (authoritative when present). */
  checksSource: TaskFileContentResponse | null;
  taskDefinition?: TaskDefinitionRevisionSummary | null;
  taskRunId?: string | null;
  taskId: string;
  projectId?: string | null;
  commitSha?: string | null;
  sourceType?: string | null;
  children: ReactNode;
}) {
  // Open/closed is ephemeral view state: bulk expand state stays out of the URL.
  const [open, setOpen] = useState(false);
  const { source, pending } = useWholeFileSource({
    open,
    checksSource,
    checks,
    taskDefinition,
    taskRunId,
    taskId,
    projectId,
    commitSha,
    sourceType,
  });
  const [, setAssertionParam] = useUrlParam("assertion");

  const model = useMemo(
    () => (source ? buildTestFileModel(source, checks) : null),
    [source, checks],
  );
  const diagnostics = useMemo(
    () => (model ? buildFileDiagnostics(model) : []),
    [model],
  );
  const targets = useMemo(
    () => (model ? buildLineTargets(model) : new Map<number, DiagnosticTarget>()),
    [model],
  );
  const passed = checks.filter((c) => c.pass === true).length;

  return (
    <div className="space-y-3">
      <div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="inline-flex h-7 items-center gap-1.5 border border-border bg-card/60 px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <ChevronRight
            className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
          />
          {open ? "Hide Whole Test File" : "Show Whole Test File"}
        </button>
      </div>
      {open ? (
        pending ? (
          <p className="border border-border bg-card/60 p-4 text-sm text-muted-foreground">
            Loading test file…
          </p>
        ) : source ? (
          <div className="border border-border bg-card/60 p-3">
            <p className="mb-2 font-mono text-xs text-muted-foreground">
              {source.path} · {source.lines} lines · {passed}/{checks.length} passed
            </p>
            <CodeViewer
              code={source.content}
              language={source.language}
              fullHeight
              diagnostics={diagnostics}
              onDiagnosticClick={(line) => {
                const target = targets.get(line);
                if (!target) return;
                const param = buildAssertionParam(target.checkId, target.assertionId);
                if (param !== null) setAssertionParam(param);
                setOpen(false);
              }}
            />
          </div>
        ) : (
          <p className="border border-border bg-card/60 p-4 text-sm text-muted-foreground">
            Test file source unavailable for this run.
          </p>
        )
      ) : (
        children
      )}
    </div>
  );
}

/** Map each marked line to the check detail it should open: opener lines go to
 *  the region's most interesting check (a failure, else the first recorded),
 *  failing-assertion lines to that exact assertion. First writer wins, so an
 *  opener that shares its line with an assertion keeps the region target. */
function buildLineTargets(model: TestFileModel): Map<number, DiagnosticTarget> {
  const targets = new Map<number, DiagnosticTarget>();
  const walk = (regions: TestFileRegion[]) => {
    for (const region of regions) {
      if (region.kind === "test" && region.checks.length > 0) {
        const focus = region.checks.find((c) => c.pass !== true) ?? region.checks[0];
        const assertion =
          focus.assertions?.find((a) => a.pass === false) ?? focus.assertions?.[0];
        targets.set(region.startLine, { checkId: focus.id, assertionId: assertion?.id });
        for (const check of region.checks) {
          if (check.pass === true) continue;
          for (const assertion of check.assertions ?? []) {
            const line = assertion.location?.line;
            if (
              assertion.pass === false &&
              line &&
              line >= region.startLine &&
              line <= region.endLine &&
              !targets.has(line)
            ) {
              targets.set(line, { checkId: check.id, assertionId: assertion.id });
            }
          }
        }
      }
      walk(region.children);
    }
  };
  walk(model.regions);
  return targets;
}
