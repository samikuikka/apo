"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Cpu,
  ExternalLink,
  FileText,
  MessageSquare,
  Timer,
  Coins,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useUrlParam } from "@/hooks/use-url-state";
import { TraceHomeLink } from "@/components/trace-detail";
import { ConversationTranscript } from "@/components/agent-task-execution/conversation-transcript";
import { ShikiCodeBlock } from "@/components/shiki-code-block";
import { ExpandableJson } from "@/components/ExpandableJson";
import { Markdown } from "@/components/trace-detail/Markdown";
import type { ChatMessage } from "@/lib/conversation-from-trace";
import { readTaskFile, type TaskFileContentResponse } from "@/lib/agent-task-api";
import { extractJudgeReasoning } from "@/lib/judge-reasoning";
import type { CheckAssertionResult, CheckResult, JudgeMetadata } from "@/lib/agent-task-api";
import { buildCheckDiagnostics } from "@/lib/check-diagnostics";
import { extractCheckBlock } from "@/lib/extract-check-block";
import { locateAssertionsInBlock } from "@/lib/locate-assertion";
import { formatTokenBreakdown } from "@/lib/format";
import { buildAssertionParam, parseOwnAssertionId } from "@/lib/assertion-select";

// CodeMirror is heavy — load it only when a code check is expanded.
const CodeViewer = dynamic(
  () => import("@/components/CodeViewer").then((m) => m.CodeViewer),
  { ssr: false, loading: () => null },
);

type Tab = "checks" | "transcript" | "deliverables";

// ── Helpers ──────────────────────────────────────────────────────────────

function formatLatency(ms?: number): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(tokens?: { input: number; output: number }): string | null {
  if (!tokens) return null;
  return formatTokenBreakdown(tokens.input, tokens.output);
}

// ── Layout primitives ────────────────────────────────────────────────────

function Panel({
  title,
  children,
  className,
  padded = true,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={cn("overflow-hidden border border-border bg-card/60", className)}>
      {title && (
        <header className="flex items-center justify-between gap-2 border-b border-border bg-background/40 px-4 py-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h3>
        </header>
      )}
      <div className={padded ? "p-4" : undefined}>{children}</div>
    </section>
  );
}


//─ Judge details (LLM evaluator metadata)──────────────────────────────

function JudgeStrip({ judge }: { judge: JudgeMetadata }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const [showResponse, setShowResponse] = useState(false);

  // The judge LLM responds with a JSON object {pass, reasoning}. Parse it so
  // we can render with ExpandableJson's tree view instead of a wall of text.
  let parsedResponse: unknown = null;
  let responseIsJson = false;
  if (judge.response) {
    try {
      parsedResponse = JSON.parse(judge.response);
      responseIsJson = true;
    } catch {
      const match = judge.response.match(/(\{|\[)[\s\S]*(\}|\])/);
      if (match) {
        try {
          parsedResponse = JSON.parse(match[0]);
          responseIsJson = true;
        } catch {
          // not valid JSON — fall through to text rendering
        }
      }
    }
  }

  const hasPrompt = Boolean(judge.prompt?.system || judge.prompt?.user);
  const hasResponse = Boolean(judge.response);
  const formattedTokens = judge.tokens ? formatTokens(judge.tokens) : null;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {judge.model && (
          <span className="inline-flex items-center gap-1.5">
            <Cpu className="h-3 w-3" />
            <span className="font-mono">{judge.model}</span>
          </span>
        )}
        {judge.latency_ms != null && (
          <span className="inline-flex items-center gap-1.5">
            <Timer className="h-3 w-3" />
            <span>{formatLatency(judge.latency_ms)}</span>
          </span>
        )}
        {formattedTokens && (
          <span className="inline-flex items-center gap-1.5">
            <Coins className="h-3 w-3" />
            <span>{formattedTokens}</span>
          </span>
        )}
        {judge.temperature != null && (
          <span>temp <span className="text-foreground">{judge.temperature}</span></span>
        )}
      </div>

      {(hasPrompt || hasResponse) && (
        <div className="flex items-center gap-2">
          {hasPrompt && (
            <button
              type="button"
              onClick={() => setShowPrompt(!showPrompt)}
              className="inline-flex items-center gap-1 border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {showPrompt ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Judge prompt
            </button>
          )}
          {hasResponse && (
            <button
              type="button"
              onClick={() => setShowResponse(!showResponse)}
              className="inline-flex items-center gap-1 border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {showResponse ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Raw response
            </button>
          )}
        </div>
      )}

      {showPrompt && hasPrompt && (
        <div className="space-y-2 border border-border bg-background/40 p-2">
          {judge.prompt?.system && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                System
              </p>
              <Markdown className="text-[12px]">{judge.prompt.system}</Markdown>
            </div>
          )}
          {judge.prompt?.user && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                User
              </p>
              <Markdown className="text-[12px]">{judge.prompt.user}</Markdown>
            </div>
          )}
        </div>
      )}

      {showResponse && hasResponse && (
        responseIsJson && parsedResponse !== null ? (
          <ExpandableJson
            data={parsedResponse}
            className="!rounded-none !border-0 !shadow-none"
          />
        ) : (
          <Markdown className="border border-border bg-background/40 p-2 text-[12px]">
            {judge.response ?? ""}
          </Markdown>
        )
      )}
    </div>
  );
}

// ── Main expandable check item ───────────────────────────────────────────

// AssertionDrawer — full-height right drawer shown when a diagnostic marker
// is clicked in the code viewer. Header stays pinned; body scrolls as one so
// the scrollbar appears only when content truly exceeds the viewport.
function AssertionDrawer({ assertion, onClose }: { assertion: CheckAssertionResult; onClose: () => void }) {
  const judge = assertion.judge;
  const isJudge = Boolean(judge) || assertion.evaluator_type === "llm";
  const reasoning = assertion.reasoning?.trim() || (judge ? extractJudgeReasoning(judge) : undefined);

  return (
    <>
      {/* Header: assertion id + verdict + close. In normal flow (not absolute)
          so it never needs a hardcoded height. */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]",
            assertion.pass ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
          )}
        >
          {assertion.pass ? "✓" : "✗"}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">{assertion.id}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {/* Scroll region. We anchor it to the drawer with relative+absolute
         instead of relying on min-h-0/flex-1 alone: that combo can fail to
         scroll when the drawer's height isn't truly viewport-fixed (e.g. a
         transformed ancestor turns position:fixed relative to that ancestor).
         The absolute region takes its size from the bounded `flex-1` wrapper,
         so overflow scrolling engages reliably even for tall judge prompts. */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 space-y-3 overflow-y-auto px-4 py-3">
          {isJudge ? (
            // Judges read like a grade report, in the order a person reads a
            // grade: the bar (criterion), the verdict's explanation (reasoning),
            // then the work that was graded (submission). `received` holds the
            // raw value passed to t.judge — always a slice of the deliverables.
            <>
              {assertion.expected !== undefined && (
                <LabeledValue label="Criterion">{assertion.expected}</LabeledValue>
              )}
              {reasoning && reasoning !== "passed" && (
                <div className="space-y-0.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Reasoning</p>
                  <p className="text-[13px] leading-relaxed text-foreground">{reasoning}</p>
                </div>
              )}
              {assertion.received !== undefined && (
                <JudgeValue value={assertion.received} />
              )}
            </>
          ) : (
            // Code assertions: reasoning first, then expected/received values.
              // Both pass and fail show values — passes use a muted tone so
              // the green check + actual value (e.g. "received: 6" for
              // maxToolCalls) is visible without competing with failures.
            <>
              {reasoning && reasoning !== "passed" && (
                <p className="text-[13px] leading-relaxed text-foreground">{reasoning}</p>
              )}
              {assertion.expected !== undefined && (
                <LabeledValue label="Expected">{assertion.expected}</LabeledValue>
              )}
              {assertion.received !== undefined && (
                <LabeledValue label="Received" tone={assertion.pass ? undefined : "destructive"}>
                  {typeof assertion.received === "string"
                    ? assertion.received
                    : String(assertion.received)}
                </LabeledValue>
              )}
            </>
          )}

          {/* Judge metadata + collapsible prompt/response. Reuses the shared
             JudgeStrip so there's one judge-detail surface, not two. */}
          {judge && <JudgeStrip judge={judge} />}

          {!reasoning && !judge && !isJudge && (
            <p className="text-[12px] text-muted-foreground">No additional details</p>
          )}
        </div>
      </div>
    </>
  );
}

// ── Judge submission ─────────────────────────────────────────────────────

// Renders the value passed to `t.judge(...)` — i.e. the agent's work that was
// graded — under a "Submission" label. It's always a slice of the deliverables
// (e.g. `result.findings`), so the viewer is chosen by shape:
//   - string            → Markdown (judge values are often long-form prose)
//   - string[]          → bulleted list (the common case; `[0]`/`[1]` JSON
//                         keys add no meaning, so render each item as prose)
//   - object / object[] → ExpandableJson tree (genuine structure to navigate)
//   - primitive         → plain mono text
function JudgeValue({ value }: { value: unknown }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Submission</p>
      <JudgeValueContent value={value} />
    </div>
  );
}

function JudgeValueContent({ value }: { value: unknown }) {
  // String array → readable bullets. This is the most common judge input shape
  // (e.g. `result.findings`), and indexed JSON keys ([0], [1]…) convey nothing.
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    if (value.length === 0) {
      return <p className="text-[12px] text-muted-foreground">(empty)</p>;
    }
    return (
      <ul className="space-y-1">
        {value.map((item, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <li key={i} className="flex gap-1.5 text-[12px] leading-relaxed text-foreground">
            <span className="mt-[0.45em] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" />
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "string") {
    return <Markdown className="text-[12px] leading-relaxed text-foreground">{value}</Markdown>;
  }
  if (typeof value === "object" && value !== null) {
    return <ExpandableJson data={value} className="!rounded-none !border !border-border !shadow-none" />;
  }
  return (
    <p className="break-words font-mono text-[12px] text-foreground">{String(value)}</p>
  );
}

// ── Labeled value row ────────────────────────────────────────────────────

// Renders a small label above its value (stacked, not side-by-side) so the
// full drawer width is available for the content. Used for both the code-style
// Expected/Received diff and the judge Criterion field.
function LabeledValue({
  label,
  children,
  tone,
}: {
  label: string;
  children: React.ReactNode;
  tone?: "destructive";
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("break-words font-mono text-[12px]", tone === "destructive" ? "text-destructive" : "text-foreground")}>
        {children}
      </p>
    </div>
  );
}

function ExpandableCheckItem({
  item,
  index,
  checksSource,
}: {
  item: CheckResult;
  index: number;
  checksSource?: TaskFileContentResponse | null;
}) {
  const passed = item.pass === true;
  const id = String(item.id ?? `Check ${index + 1}`);
  // Which checks are expanded is bulk, ephemeral state — keep it local rather
  // than bloating the URL. (The focused assertion drawer is the URL-synced bit.)
  const [expanded, setExpanded] = useState(false);
  const reasoning = typeof item.reasoning === "string" ? item.reasoning : "";
  const judgeAssertion = item.assertions?.find((a) => a.judge);
  const judgeMeta = judgeAssertion?.judge ?? item.judge;

  const checkBlock =
    checksSource
      ? extractCheckBlock(checksSource.content, {
          id: item.id,
          anchorLine: item.location?.line,
        })
      : null;
  const diagnostics = checkBlock
    ? buildCheckDiagnostics(item, checkBlock.startLine, checkBlock.endLine, checkBlock.code)
    : [];

  // Show all assertions — both passing and failing — so users can see the
  // actual values (e.g. "received: 6 tool calls" when the limit was 40).
  const visibleAssertions = item.assertions ?? [];

  const lineToAssertion = (() => {
    if (!checkBlock) return new Map<number, CheckAssertionResult>();
    const locatedLines = locateAssertionsInBlock(
      checkBlock.code,
      visibleAssertions.map((a) => ({ id: a.id })),
    );
    const map = new Map<number, CheckAssertionResult>();
    visibleAssertions.forEach((a, i) => {
      let line = locatedLines[i];
      if (line === undefined && a.location?.line) {
        line = a.location.line - checkBlock.startLine + 1;
      }
      if (line !== undefined && line >= 1) {
        map.set(line, a);
      }
    });
    return map;
  })();

  // Which line's assertion drawer is open, if any. The selection is encoded in
  // the URL as ?assertion=<checkId>::<assertionId> — namespaced by check id so
  // that opening a drawer in one check never bleeds into another. (Assertion
  // ids alone aren't unique across checks: every `t.judge` call defaults to
  // id "judge", so a bare ?assertion=judge would match every judge check.)
  const [assertionParam, setAssertionParam] = useUrlParam("assertion");

  // Does the URL point at an assertion in THIS check? Only the check whose id
  // matches the param's namespace prefix opens its drawer.
  const ownAssertionId = parseOwnAssertionId(assertionParam, id);

  // A shared link points at a specific assertion. If it lives in this check,
  // auto-expand the row so the drawer is visible without an extra click.
  // Done during render (prev-prop comparison) to avoid a stale-state flash.
  const [prevOwnAssertionId, setPrevOwnAssertionId] = useState(ownAssertionId);
  if (ownAssertionId !== prevOwnAssertionId) {
    setPrevOwnAssertionId(ownAssertionId);
    if (ownAssertionId && item.assertions?.some((a) => a.id === ownAssertionId)) {
      setExpanded(true);
    }
  }

  const selectedLine = (() => {
    if (!ownAssertionId || !checkBlock) return null;
    for (const [line, assertion] of lineToAssertion) {
      if (assertion.id === ownAssertionId) return line;
    }
    return null;
  })();
  const selectedAssertion = selectedLine !== null ? lineToAssertion.get(selectedLine) : undefined;
  const setSelectedLine = (line: number | null) => {
    const a = line !== null ? lineToAssertion.get(line) : undefined;
    setAssertionParam(buildAssertionParam(id, a?.id));
  };

  // Escape closes the drawer, matching the TracePanel pattern.
  useEffect(() => {
    if (!selectedAssertion) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAssertionParam(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedAssertion, setAssertionParam]);

  return (
    <div
      className={cn(
        "border-b border-border last:border-b-0 transition-colors",
        expanded ? "bg-card/30" : "hover:bg-card/20",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]",
            passed ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
          )}
        >
          {passed ? "✓" : "✗"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "font-mono text-[13px]",
                passed ? "text-foreground" : "text-destructive",
                expanded && "font-medium",
              )}
            >
              {id}
            </span>
            {!passed && !expanded && reasoning && (
              <span className="truncate text-[11px] text-muted-foreground">
                {reasoning.split("\n")[0]}
              </span>
            )}
          </div>
        </div>
        <span
          className="shrink-0 text-muted-foreground/60 transition-transform"
          style={{ transform: expanded ? "rotate(90deg)" : "none" }}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 pb-4 pt-3">
          <div className="max-w-[860px] space-y-3">
            {checkBlock ? (
              <>
                <div className="overflow-hidden border border-border">
                  <CodeViewer
                    code={checkBlock.code}
                    language={checksSource?.language ?? "typescript"}
                    diagnostics={diagnostics}
                    onDiagnosticClick={(line) => {
                      setSelectedLine(selectedLine === line ? null : line);
                    }}
                  />
                  {selectedAssertion && (
                    <>
                      <button
                        type="button"
                        className="fixed inset-0 z-40 cursor-default"
                        aria-label="Close assertion drawer"
                        onClick={() => setSelectedLine(null)}
                      />
                      <div className="fixed inset-y-0 right-0 top-12 z-50 flex w-[480px] max-w-[90vw] flex-col border-l border-border bg-card shadow-2xl">
                        <AssertionDrawer assertion={selectedAssertion} onClose={() => setSelectedLine(null)} />
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                {reasoning && (
                  <p
                    className={cn(
                      "whitespace-pre-wrap text-[13px] leading-relaxed",
                      passed ? "text-foreground" : "text-destructive",
                    )}
                  >
                    {reasoning}
                  </p>
                )}
                {judgeMeta && <JudgeStrip judge={judgeMeta} />}
                {!reasoning && !judgeMeta && (
                  <p className="text-[12px] text-muted-foreground">No additional details</p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Deliverables tab ─────────────────────────────────────────────────────

function DeliverablesView({ deliverables }: { deliverables: Record<string, unknown> }) {
  const entries = Object.entries(deliverables);
  if (entries.length === 0) {
    return <p className="py-4 text-center text-sm text-muted-foreground">No deliverables</p>;
  }
  return (
    <div className="divide-y divide-border overflow-hidden border border-border">
      {entries.map(([key, value]) => (
        <DeliverableFile key={key} name={key} value={value} />
      ))}
    </div>
  );
}

function DeliverableFile({ name, value }: { name: string; value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const isObject = typeof value === "object" && value !== null;
  const isString = typeof value === "string";
  const code = isObject
    ? JSON.stringify(value, null, 2)
    : isString
      ? value
      : String(value ?? "");
  const lines = code.split("\n").length;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/20"
      >
        <span className="text-muted-foreground/60">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-sm text-foreground">{name}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/50">
          {isObject ? `${Object.keys(value).length} keys` : `${lines} line${lines !== 1 ? "s" : ""}`}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/50 bg-background/50">
          {isObject ? (
            <ExpandableJson data={value} className="!rounded-none !border-0 !shadow-none" />
          ) : (
            <ShikiCodeBlock code={code} language="text" className="!rounded-none !border-0" />
          )}
        </div>
      )}
    </div>
  );
}

// ── Main body ────────────────────────────────────────────────────────────

export function TaskRunDetailBody({
  checks,
  conversation,
  deliverables,
  traceRunId,
  projectId,
  commitSha,
  taskId,
}: {
  checks: CheckResult[];
  conversation: ChatMessage[];
  deliverables: Record<string, unknown> | null;
  traceRunId: string | null;
  projectId?: string | null;
  commitSha?: string | null;
  taskId: string;
}) {
  // Active tab lives in the URL (?tab=) so a shared link lands the reader on
  // the same view (checks / transcript / deliverables).
  const [tabParam, setTabParam] = useUrlParam("tab");
  const tab: Tab = tabParam === "transcript" || tabParam === "deliverables" ? tabParam : "checks";

  const recordedSourceFile = checks.find((check) => check.source_file)?.source_file;
  const checkIds = checks.map((check) => check.id).join("\u0000");
  const [sourceState, setSourceState] = useState<{
    data: TaskFileContentResponse | null;
    error: string | null;
  }>({ data: null, error: null });

  const loadCheckSource = useCallback(
    async (
      candidates: string[],
      signal: AbortSignal,
    ): Promise<TaskFileContentResponse> => {
      let lastError: unknown;
      for (const candidate of candidates) {
        try {
          const source = await readTaskFile(
            taskId,
            candidate,
            undefined,
            projectId,
            commitSha ?? undefined,
            signal,
          );
          const containsKnownCheck = checks.some((check) =>
            extractCheckBlock(source.content, { id: check.id }) !== null
          );
          if (containsKnownCheck || candidates.length === 1) {
            return source;
          }
        } catch (error) {
          if (signal.aborted) throw error;
          lastError = error;
        }
      }
      if (lastError instanceof Error) throw lastError;
      throw new Error("Could not load check source — no .eval.ts, task.ts, or checks.ts found");
    },
    [taskId, projectId, commitSha, checks],
  );

  useEffect(() => {
    if (checks.length === 0 || !projectId) return;
    const controller = new AbortController();
    const candidates = recordedSourceFile
      ? [recordedSourceFile, `${taskId}.eval.ts`]
      : [`${taskId}.eval.ts`, "task.ts", "checks.ts"];

    setSourceState({ data: null, error: null });
    void loadCheckSource(candidates, controller.signal)
      .then((data: TaskFileContentResponse) => setSourceState({ data, error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSourceState({
          data: null,
          error: error instanceof Error
            ? error.message
            : "Check source could not be loaded",
        });
      });

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    checkIds,
    checks.length,
    commitSha,
    projectId,
    recordedSourceFile,
    taskId,
  ]);

  const checksSource = sourceState.data;

  const checksPassed = checks.filter((check) => check.pass === true).length;
  const failedCount = checks.length - checksPassed;

  const tabs: Array<{
    id: Tab | "trace";
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    count?: number;
  }> = [
    { id: "checks", label: "Checks", icon: Code2, count: checks.length },
    { id: "transcript", label: "Conversation History", icon: MessageSquare },
    { id: "deliverables", label: "Deliverables", icon: FileText },
  ];

  if (traceRunId) {
    tabs.push({ id: "trace", label: "Trace home", icon: ExternalLink });
  }

  return (
    <>
      <div className="flex items-center gap-1 border-t border-border px-4">
        {tabs.map((tabItem) => {
          const isTrace = tabItem.id === "trace";
          const isActive = !isTrace && tab === tabItem.id;

          if (isTrace) {
            return (
              <TraceHomeLink
                key={tabItem.id}
                traceId={traceRunId!}
                label={tabItem.label}
                appearance="tab"
              />
            );
          }

          return (
            <button
              type="button"
              key={tabItem.id}
              onClick={() => setTabParam(tabItem.id as Tab)}
              className={cn(
                "relative inline-flex h-9 items-center gap-1.5 px-3 text-[13px] font-medium transition-colors",
                isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <tabItem.icon className="h-3.5 w-3.5" />
              {tabItem.label}
              {typeof tabItem.count === "number" && (
                <span
                  className={cn(
                    "px-1 font-mono text-[10px] tabular-nums",
                    isActive ? "bg-foreground/10 text-foreground" : "bg-card text-muted-foreground",
                  )}
                >
                  {tabItem.count}
                </span>
              )}
              {isActive && <span className="absolute inset-x-2 -bottom-px h-px bg-foreground" />}
            </button>
          );
        })}
      </div>

      <div className="space-y-4 px-6 py-5">
        {tab === "checks" && (
          <>
            {checks.length > 0 && (
              <div className="flex items-center justify-between text-[12px]">
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground">
                    <span className="font-medium text-foreground">{checksPassed}</span>/{checks.length} passed
                  </span>
                  {failedCount > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
                      {failedCount} failed
                    </span>
                  )}
                </div>
                <span className="text-muted-foreground/60">Click to expand</span>
              </div>
            )}

            {checksSource && (
              <p className="text-[11px] text-muted-foreground/70">
                Expand a code check to see its source with the failing line marked.
              </p>
            )}
            {sourceState.error && (
              <p className="border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                Check source unavailable: {sourceState.error}
              </p>
            )}

            {checks.length > 0 && (
              <Panel padded={false}>
                {checks.map((item, index) => (
                  <ExpandableCheckItem
                    key={`ch-${String(item.id ?? index)}`}
                    item={item}
                    index={index}
                    checksSource={checksSource}
                  />
                ))}
              </Panel>
            )}

            {checks.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">No checks recorded</p>
            )}
          </>
        )}

        {tab === "transcript" && (
          <ConversationTranscript
            conversation={conversation}
            traceRunId={traceRunId}
          />
        )}

        {tab === "deliverables" && (
          deliverables ? (
            <DeliverablesView deliverables={deliverables} />
          ) : (
            <p className="py-4 text-center text-sm text-muted-foreground">No deliverables recorded</p>
          )
        )}
      </div>
    </>
  );
}
