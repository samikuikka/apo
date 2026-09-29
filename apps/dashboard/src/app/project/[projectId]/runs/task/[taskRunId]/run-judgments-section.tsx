/**
 * Issue #159: judgments recorded on a completed Task Run.
 *
 * Server-rendered summary strip on the run detail page — the original
 * verdict above stays canonical; this surfaces that the run was re-judged
 * (different judge model, fixed check code, stability sampling) and how
 * each judgment scored. Deep inspection (full check evidence per judgment)
 * lives in the CLI: `apo runs judgments <run-id> <judgment-id>`.
 */

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AgentTaskJudgmentSummary } from "@/lib/agent-task-api";

interface RunJudgmentsSectionProps {
  taskRunId: string;
  judgments: AgentTaskJudgmentSummary[];
}

export function RunJudgmentsSection({ taskRunId, judgments }: RunJudgmentsSectionProps) {
  const rejudges = judgments.filter((j) => j.trigger === "rejudge");

  return (
    <section
      aria-label="Judgments"
      className="mx-6 mt-4 border border-border bg-card px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium">
          Re-judged {rejudges.length} {rejudges.length === 1 ? "time" : "times"}
          <span className="ml-2 font-normal text-muted-foreground">
            verdicts replayed against this run&rsquo;s stored deliverables
          </span>
        </h2>
        <code className="font-mono text-[11px] text-muted-foreground">
          apo runs judgments {taskRunId}
        </code>
      </div>

      <table className="mt-2 w-full text-left text-[12px]">
        <thead>
          <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="py-1.5 pr-3 font-medium">Judgment</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Trigger</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Judge</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Checks</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          {judgments.map((judgment) => (
            <tr key={judgment.id} className="border-b border-border/50 last:border-0">
              <td className="py-1.5 pr-3">
                <span className="font-mono">{judgment.id.slice(0, 14)}</span>
                {judgment.label && (
                  <span className="ml-2 text-muted-foreground">{judgment.label}</span>
                )}
              </td>
              <td className="py-1.5 pr-3">
                <Badge
                  variant={judgment.trigger === "original" ? "outline" : "secondary"}
                  className="h-5 text-xs"
                >
                  {judgment.trigger === "original" ? "Original" : "Re-judge"}
                </Badge>
              </td>
              <td className="py-1.5 pr-3 font-mono text-[11px]">
                {judgment.judge_model ?? "—"}
                {judgment.samples > 1 && (
                  <span className="ml-1.5 text-muted-foreground">×{judgment.samples}</span>
                )}
                {judgment.definition_revision_matches_run === false && (
                  <span className="ml-1.5 text-warning" title="Scored against a different definition revision than the run's pinned one">
                    other revision
                  </span>
                )}
              </td>
              <td className="py-1.5 pr-3 font-mono tabular-nums">
                <span className={cn(judgment.passed_checks === judgment.total_checks && judgment.total_checks > 0 ? "text-success" : "text-destructive")}>
                  {judgment.passed_checks}/{judgment.total_checks}
                </span>
                {(judgment.errored_checks ?? 0) > 0 && (
                  <span
                    className="ml-1 text-warning"
                    title="Checks that produced no verdict (judge error) — unknown, not failed"
                  >
                    ·{judgment.errored_checks}!
                  </span>
                )}
              </td>
              <td className="py-1.5 pr-3 text-muted-foreground">
                {judgment.created_at ? new Date(judgment.created_at).toLocaleString() : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
