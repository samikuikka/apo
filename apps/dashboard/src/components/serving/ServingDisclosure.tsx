"use client";

import { useState } from "react";
import { ServingSummary } from "./ServingSummary";
import {
  servingCompactLabel,
  type ServingSummary as ServingSummaryData,
} from "@/lib/serving-types";

/**
 * Serving detail is forensic: the checks come first, not this table.
 */
export function ServingDisclosure({ summary }: { summary: ServingSummaryData }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border border-border bg-card/60">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        Observed serving
        <span className="font-mono tabular-nums">
          {summary.calls} calls · {servingCompactLabel(summary)}
        </span>
        {summary.errored_calls > 0 && (
          <span className="font-mono tabular-nums text-destructive">
            {summary.errored_calls} errored
          </span>
        )}
        <span className="ml-auto opacity-60">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="border-t border-border/60 p-4">
          <ServingSummary summary={summary} />
        </div>
      )}
    </section>
  );
}
