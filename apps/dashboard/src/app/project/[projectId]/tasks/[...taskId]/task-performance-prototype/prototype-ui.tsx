"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MatrixVariant } from "./variant-matrix";
import { PulseVariant } from "./variant-pulse";
import { TimelineVariant } from "./variant-timeline";
import { PROTOTYPE_RUNS, PUBLISHED_DEFINITION } from "./data";

type VariantKey = "pulse" | "timeline" | "matrix";

const VARIANTS: Array<{ key: VariantKey; name: string }> = [
  { key: "pulse", name: "Current Pulse" },
  { key: "timeline", name: "Revision Timeline" },
  { key: "matrix", name: "Comparison Matrix" },
];

interface TaskPerformancePrototypeProps {
  initialVariant: string;
}

// PROTOTYPE — three fixture-backed Task performance concepts, switchable via
// ?variant= on the existing Task detail route. Do not ship this component.
export function TaskPerformancePrototype({ initialVariant }: TaskPerformancePrototypeProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [variant, setVariant] = useState<VariantKey>(() => normalizeVariant(initialVariant));
  const [historyScope, setHistoryScope] = useState<"baseline" | "all">("all");

  const visibleRuns = historyScope === "all"
    ? PROTOTYPE_RUNS
    : PROTOTYPE_RUNS.filter((run) => run.baseline);

  const selectVariant = (next: VariantKey) => {
    setVariant(next);
    const query = new URLSearchParams(window.location.search);
    query.set("variant", next);
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  };

  const cycleVariant = (direction: -1 | 1) => {
    const currentIndex = VARIANTS.findIndex((candidate) => candidate.key === variant);
    const nextIndex = (currentIndex + direction + VARIANTS.length) % VARIANTS.length;
    selectVariant(VARIANTS[nextIndex].key);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (
        target.matches("input, textarea, [contenteditable='true']")
      )) return;
      if (event.key === "ArrowLeft") cycleVariant(-1);
      if (event.key === "ArrowRight") cycleVariant(1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <div className="relative min-h-[720px] pb-20">
      <div className="flex flex-wrap items-center gap-3 border-b border-warning/30 bg-warning/5 px-6 py-2.5">
        <FlaskConical className="h-3.5 w-3.5 text-warning" />
        <span className="text-xs font-semibold text-warning">Throwaway prototype</span>
        <span className="text-xs text-muted-foreground">
          Fixture data · published definition {PUBLISHED_DEFINITION.label} ({PUBLISHED_DEFINITION.digest})
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant={historyScope === "baseline" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setHistoryScope("baseline")}
          >
            Current Baseline
          </Button>
          <Button
            type="button"
            variant={historyScope === "all" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setHistoryScope("all")}
          >
            Full History + Working
          </Button>
        </div>
      </div>

      {variant === "pulse" && <PulseVariant runs={visibleRuns} />}
      {variant === "timeline" && <TimelineVariant runs={visibleRuns} />}
      {variant === "matrix" && <MatrixVariant runs={visibleRuns} />}

      {process.env.NODE_ENV !== "production" && (
        <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center border border-foreground/20 bg-foreground px-1.5 py-1 text-background shadow-xl">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-background hover:bg-background/15 hover:text-background"
            aria-label="Previous prototype variant"
            onClick={() => cycleVariant(-1)}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <div className="min-w-44 px-3 text-center text-xs font-semibold">
            {variant.toUpperCase()} — {VARIANTS.find((item) => item.key === variant)?.name}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-background hover:bg-background/15 hover:text-background"
            aria-label="Next prototype variant"
            onClick={() => cycleVariant(1)}
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
          <Badge className="ml-1 h-6 border-background/20 bg-background/10 text-[10px] text-background">
            ← →
          </Badge>
        </div>
      )}
    </div>
  );
}

function normalizeVariant(value: string): VariantKey {
  return VARIANTS.some((variant) => variant.key === value)
    ? value as VariantKey
    : "pulse";
}
