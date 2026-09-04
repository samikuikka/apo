"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

/**
 * "Start here" guide rail for the demo tasks page: five
 * steps pointing at the dataset's narrative anchors across both halves of
 * the fixture — the DABstep benchmark runs and the longer real-agent runs.
 * The run/batch ids are the fixture's stable identity contract — capture
 * must keep them so the rail keeps pointing at real evidence.
 */
export function StartHereRail({ capturedOn }: { capturedOn: string }) {
  const [open, setOpen] = useState(true);

  return (
    <aside
      data-testid="start-here-rail"
      className="hidden w-64 shrink-0 border-l border-border xl:block"
    >
      <div className="sticky top-0 p-5">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full items-center justify-between text-sm font-semibold"
        >
          Start here
          <ChevronRight
            className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
          />
        </button>

        {open ? (
          <ol className="mt-3 space-y-4">
            <RailStep
              n={1}
              title="Open the failed run"
              href="/project/demo/runs/task/demo-run-001"
              hint="The agent answered 'yes' — the benchmark's ground truth is 'Not Applicable'."
            />
            <RailStep
              n={2}
              title="Read the judge"
              href="/project/demo/runs/task/demo-run-001"
              hint="Judged three times for stability — the Checks tab shows every pass and fail."
            />
            <RailStep
              n={3}
              title="Walk the trace"
              href="/project/demo/runs/task/demo-run-001"
              hint="The Transcript tab holds the agent conversation behind the verdict."
            />
            <RailStep
              n={4}
              title="Compare models"
              href="/project/demo/runs/compare?a=demo-batch-001&b=demo-batch-002"
              hint="GLM vs DeepSeek on the same benchmark task — where they disagree is the story."
            />
            <RailStep
              n={5}
              title="See a human override"
              href="/project/demo/runs/task/demo-run-corrected"
              hint="The judge failed this code review; a reviewer set it back to pass — then browse the real-agent tasks."
            />
          </ol>
        ) : null}

        <p className="mt-5 border-t border-border pt-3 text-[11px] text-muted-foreground">
          Captured example data · {capturedOn}
        </p>
      </div>
    </aside>
  );
}

function RailStep({
  n,
  title,
  hint,
  href,
}: {
  n: number;
  title: string;
  hint: string;
  href: string;
}) {
  return (
    <li>
      <Link href={href} className="group flex gap-3">
        <span className="flex size-5 shrink-0 items-center justify-center border border-border text-[11px] text-muted-foreground group-hover:text-foreground">
          {n}
        </span>
        <span>
          <span className="block text-[13px] font-medium group-hover:underline">
            {title}
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
            {hint}
          </span>
        </span>
      </Link>
    </li>
  );
}
