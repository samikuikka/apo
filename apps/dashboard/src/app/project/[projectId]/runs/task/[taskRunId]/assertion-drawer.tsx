"use client";

import { X } from "lucide-react";
import { ExpandableJson } from "@/components/ExpandableJson";
import { Markdown } from "@/components/trace-detail/Markdown";
import type { CheckAssertionResult } from "@/lib/agent-task-api";
import { extractJudgeReasoning } from "@/lib/judge-reasoning";
import { formatAssertionValue } from "@/lib/format-assertion-value";
import { cn } from "@/lib/utils";
import { JudgeStrip } from "./judge-strip";

// AssertionDrawer — full-height right drawer shown when a diagnostic marker
// is clicked in the code viewer. Header stays pinned; body scrolls as one so
// the scrollbar appears only when content truly exceeds the viewport.
export function AssertionDrawer({ assertion, onClose }: { assertion: CheckAssertionResult; onClose: () => void }) {
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
                  {formatAssertionValue(assertion.received)}
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
