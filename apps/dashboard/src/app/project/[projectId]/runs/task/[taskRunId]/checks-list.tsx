"use client";

import { useState } from "react";
import type { CheckResult, TaskFileContentResponse } from "@/lib/agent-task-api";
import { CheckGroupHeader } from "./check-group-header";
import { ExpandableCheckItem } from "./expandable-check-item";
import { groupChecksByDescribe, groupVerdict, groupCost } from "./group-by-describe";
import { secondJudgeFacts } from "@/lib/second-judge";

// Renders the checks panel, nesting checks declared inside a `describe()`
// under a collapsible {@link CheckGroupHeader} with a roll-up verdict. Bare
// checks render at the top level as before. Backward compatible: a run whose
// checks carry no `group_id` produces one "check" segment per check, so the
// layout is identical to the old flat list.
export function ChecksList({
  checks,
  checksSource,
  correctable = false,
  taskRunId,
}: {
  checks: CheckResult[];
  checksSource?: TaskFileContentResponse | null;
  /** Whether test-result corrections are allowed on this run. */
  correctable?: boolean;
  taskRunId?: string;
}) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  // Groups start expanded (option b from the design discussion); the set
  // tracks which the user has collapsed.
  const toggleGroup = (groupId: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });

  const segments = groupChecksByDescribe(checks);
  // Assign each check a global display index (the "Check N" fallback label).
  const indexByGroupId = new Map<string, number>();
  let counter = 0;
  for (const segment of segments) {
    const items = segment.kind === "check" ? [segment.check] : segment.checks;
    for (const item of items) {
      indexByGroupId.set(item.id, counter++);
    }
  }

  return (
    <>
      {segments.map((segment) => {
        if (segment.kind === "check") {
          const idx = indexByGroupId.get(segment.check.id) ?? 0;
          return (
            <ExpandableCheckItem
              key={`ch-${String(segment.check.id ?? idx)}`}
              item={segment.check}
              index={idx}
              checksSource={checksSource}
              correctable={correctable}
              taskRunId={taskRunId}
            />
          );
        }
        const { passed, total } = groupVerdict(segment.checks);
        const cost = groupCost(segment.checks);
        const splitCount = segment.checks.filter(
          (c) => secondJudgeFacts(c).kind === "split",
        ).length;
        const isOpen = !collapsedGroups.has(segment.groupId);
        return (
          <div
            key={`grp-${segment.groupId}`}
            className="border-b border-border last:border-b-0"
          >
            <CheckGroupHeader
              groupName={segment.groupName}
              passed={passed}
              total={total}
              cost={cost}
              open={isOpen}
              onToggle={() => toggleGroup(segment.groupId)}
              splitCount={splitCount}
            />
            {isOpen && (
              <div className="ml-4 border-l border-border/50">
                {segment.checks.map((item) => (
                  <ExpandableCheckItem
                    key={`ch-${String(item.id ?? indexByGroupId.get(item.id))}`}
                    item={item}
                    index={indexByGroupId.get(item.id) ?? 0}
                    checksSource={checksSource}
                    correctable={correctable}
                    taskRunId={taskRunId}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
