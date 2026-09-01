"use client";

import { TraceHomeLink } from "@/components/trace-detail";
import { cn } from "@/lib/utils";

export type TaskRunTabId = "checks" | "transcript" | "deliverables";

export interface TaskRunTab {
  id: TaskRunTabId | "trace";
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  count?: number;
}

/**
 * The run-detail tab bar: checks / transcript / deliverables, plus the
 * trace-home link when the run has an attached trace.
 */
export function TaskRunTabStrip({
  tabs,
  activeTab,
  onSelectTab,
  traceRunId,
}: {
  tabs: TaskRunTab[];
  activeTab: TaskRunTabId;
  onSelectTab: (tab: TaskRunTabId) => void;
  traceRunId: string | null;
}) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto overflow-y-hidden border-t border-border px-4">
      {tabs.map((tabItem) => {
        // Destructured so the literal-union narrowing survives into the
        // onClick closure (property narrowing does not).
        const { id } = tabItem;
        if (id === "trace") {
          return (
            <TraceHomeLink
              key={id}
              traceId={traceRunId!}
              label={tabItem.label}
              appearance="tab"
            />
          );
        }

        const isActive = activeTab === id;
        return (
          <button
            type="button"
            key={id}
            onClick={() => onSelectTab(id)}
            className={cn(
              "relative inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-[13px] font-medium transition-colors",
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
            {isActive && <span className="absolute inset-x-2 bottom-0 h-px bg-foreground" />}
          </button>
        );
      })}
    </div>
  );
}
