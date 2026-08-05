"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModeVariant } from "./variant-modes";
import { RowsVariant } from "./variant-rows";
import { LensVariant } from "./variant-lens";
import { CohortVariant } from "./variant-cohort";
import { ScheduleVariant } from "./variant-schedule";
import { FiltersVariant } from "./variant-filters";
import { ColumnsVariant } from "./variant-columns";
import { TASK_OVERVIEW_FIXTURE } from "./data";
import { PROJECT_SCOPE_V2, TASKS_V2 } from "./data-v2";

type VariantKey = "modes" | "rows" | "lens" | "cohort" | "schedule" | "filters" | "columns";

const VARIANTS: Array<{ key: VariantKey; name: string }> = [
  { key: "modes", name: "Page Modes (v1)" },
  { key: "rows", name: "Evidence Rows (v1)" },
  { key: "lens", name: "Analysis Lens (v1)" },
  { key: "cohort", name: "Published Cohort (v2)" },
  { key: "schedule", name: "Schedule-Anchored (v2)" },
  { key: "filters", name: "Filter Chips (v2)" },
  { key: "columns", name: "Column Filters (v2)" },
];

export function TasksOverviewPrototype({ initialVariant }: { initialVariant: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [variant, setVariant] = useState<VariantKey>(() => normalizeVariant(initialVariant));

  const selectVariant = (next: VariantKey) => {
    setVariant(next);
    const query = new URLSearchParams(window.location.search);
    query.set("variant", next);
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  };

  const cycleVariant = (direction: -1 | 1) => {
    const index = VARIANTS.findIndex((item) => item.key === variant);
    selectVariant(VARIANTS[(index + direction + VARIANTS.length) % VARIANTS.length].key);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.matches("input, textarea, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") cycleVariant(-1);
      if (event.key === "ArrowRight") cycleVariant(1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <div className="min-h-[760px] pb-20">
      <div className="flex items-center gap-3 border-y border-warning/30 bg-warning/5 px-6 py-2.5">
        <FlaskConical className="h-3.5 w-3.5 text-warning" />
        <span className="text-xs font-semibold text-warning">Throwaway Tasks prototype</span>
        <span className="text-xs text-muted-foreground">Fixture includes stale tests, model experiments, revision changes, errors, and uneven samples</span>
      </div>

      {variant === "modes" && <ModeVariant tasks={TASK_OVERVIEW_FIXTURE} />}
      {variant === "rows" && <RowsVariant tasks={TASK_OVERVIEW_FIXTURE} />}
      {variant === "lens" && <LensVariant tasks={TASK_OVERVIEW_FIXTURE} />}
      {variant === "cohort" && <CohortVariant tasks={TASKS_V2} scope={PROJECT_SCOPE_V2} />}
      {variant === "schedule" && <ScheduleVariant tasks={TASKS_V2} />}
      {variant === "filters" && <FiltersVariant tasks={TASKS_V2} />}
      {variant === "columns" && <ColumnsVariant tasks={TASKS_V2} />}

      {process.env.NODE_ENV !== "production" && (
        <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center border border-foreground/20 bg-foreground px-1.5 py-1 text-background shadow-xl">
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-background hover:bg-background/15 hover:text-background" aria-label="Previous prototype variant" onClick={() => cycleVariant(-1)}>
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <div className="min-w-44 px-3 text-center text-xs font-semibold">{variant.toUpperCase()} — {VARIANTS.find((item) => item.key === variant)?.name}</div>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-background hover:bg-background/15 hover:text-background" aria-label="Next prototype variant" onClick={() => cycleVariant(1)}>
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
          <span className="ml-1 border border-background/20 bg-background/10 px-1.5 py-1 text-[10px]">← →</span>
        </div>
      )}
    </div>
  );
}

function normalizeVariant(value: string): VariantKey {
  return VARIANTS.some((item) => item.key === value) ? value as VariantKey : "modes";
}
