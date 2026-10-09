"use client";

import { useEffect, useState } from "react";
import type { CheckResult, TaskFileContentResponse } from "@/lib/agent-task-api";
import { usePersistentStringSet } from "@/hooks/use-persistent-string-set";
import { useUrlParam } from "@/hooks/use-url-state";
import { parseCheckIdFromAssertionParam } from "@/lib/assertion-select";
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
  taskId,
  projectId,
  traceRunId,
}: {
  checks: CheckResult[];
  checksSource?: TaskFileContentResponse | null;
  /** Whether test-result corrections are allowed on this run. */
  correctable?: boolean;
  taskRunId?: string;
  /** Groups are remembered per task (not per run): group ids are stable across runs of the same task. */
  taskId?: string | null;
  /** For the judge-span deep link (issue #288) and the storage-key namespace. */
  projectId?: string | null;
  traceRunId?: string | null;
}) {
  // Which describe() groups are open is durable view state, stored as an
  // OPEN set keyed by task: group ids come from the task's checks file, so
  // the choices carry to the next run of the same task, and anything the
  // user never opens — including newly added tests — arrives collapsed.
  // The roll-up headers keep a fully collapsed panel scannable.
  const storageKey = taskId
    ? `apo:open-check-groups:${projectId ?? "no-project"}:${taskId}`
    : null;
  const { values: openGroups, toggle: toggleGroup } =
    usePersistentStringSet(storageKey);

  const segments = groupChecksByDescribe(checks);
  // Assign each check a global display index (the "Check N" fallback label).
  const indexByGroupId = new Map<string, number>();
  // Which group (if any) contains each check id — used to resolve a
  // deep-linked assertion to its group.
  const groupByCheckId = new Map<string, string>();
  let counter = 0;
  for (const segment of segments) {
    const items = segment.kind === "check" ? [segment.check] : segment.checks;
    for (const item of items) {
      indexByGroupId.set(item.id, counter++);
      if (segment.kind === "group") {
        groupByCheckId.set(item.id, segment.groupId);
      }
    }
  }

  // A shared ?assertion= link targets one check. If it sits inside a group,
  // that group opens for this view even when it isn't in the stored set —
  // the URL is the ephemeral bit, so a deep link never writes to storage.
  const [assertionParam] = useUrlParam("assertion");
  const forcedOpenGroupId =
    groupByCheckId.get(parseCheckIdFromAssertionParam(assertionParam) ?? "") ??
    null;

  // A link-opened group stays open for the rest of the visit — closing the
  // assertion drawer must not yank shut what the reader was reading — until
  // the user collapses it; a dismissal beats the link that opened. Reset
  // when the task changes: group ids from another task's checks file mean
  // nothing here.
  const [linkOpened, setLinkOpened] = useState<Set<string>>(() => new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setLinkOpened(new Set());
    setDismissed(new Set());
  }, [taskId]);
  useEffect(() => {
    if (!forcedOpenGroupId) return;
    // A fresh link into a dismissed group re-opens it: the reader asked for
    // content inside it.
    setLinkOpened((prev) => new Set(prev).add(forcedOpenGroupId));
    setDismissed((prev) => {
      if (!prev.has(forcedOpenGroupId)) return prev;
      const next = new Set(prev);
      next.delete(forcedOpenGroupId);
      return next;
    });
  }, [forcedOpenGroupId]);

  const isLinkOpen = (groupId: string) =>
    (groupId === forcedOpenGroupId || linkOpened.has(groupId)) && !dismissed.has(groupId);

  const handleToggleGroup = (groupId: string) => {
    const openViaLink = isLinkOpen(groupId);
    if (openViaLink && !openGroups.has(groupId)) {
      // Collapsing a group the link opened is a view action for this visit
      // only: the link wrote nothing to storage on the way in, so it must
      // not delete anything on the way out.
      setDismissed((prev) => new Set(prev).add(groupId));
      return;
    }
    if (openViaLink) {
      // Stored-open AND link-open: the collapse must beat the link too.
      setDismissed((prev) => new Set(prev).add(groupId));
    } else {
      setDismissed((prev) => {
        if (!prev.has(groupId)) return prev;
        const next = new Set(prev);
        next.delete(groupId);
        return next;
      });
    }
    toggleGroup(groupId);
  };

  return (
    <>
      {segments.map((segment) => {
        if (segment.kind === "check") {
          const idx = indexByGroupId.get(segment.check.id) ?? 0;
          return (
            <ExpandableCheckItem
              key={`ch-${segment.check.id}`}
              item={segment.check}
              index={idx}
              checksSource={checksSource}
              correctable={correctable}
              taskRunId={taskRunId}
              projectId={projectId}
              traceRunId={traceRunId}
            />
          );
        }
        const { passed, total } = groupVerdict(segment.checks);
        const cost = groupCost(segment.checks);
        const splitCount = segment.checks.filter(
          (c) => secondJudgeFacts(c).kind === "split",
        ).length;
        const isOpen = openGroups.has(segment.groupId) || isLinkOpen(segment.groupId);
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
              onToggle={() => handleToggleGroup(segment.groupId)}
              splitCount={splitCount}
            />
            {isOpen && (
              <div className="ml-4 border-l border-border/50">
                {segment.checks.map((item) => (
                  <ExpandableCheckItem
                    key={`ch-${item.id}`}
                    item={item}
                    index={indexByGroupId.get(item.id) ?? 0}
                    checksSource={checksSource}
                    correctable={correctable}
                    taskRunId={taskRunId}
                    projectId={projectId}
                    traceRunId={traceRunId}
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
