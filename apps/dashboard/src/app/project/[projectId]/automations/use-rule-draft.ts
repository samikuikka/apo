"use client";

import { useCallback, useMemo, useState } from "react";
import type { AutomationEventType } from "@/lib/automations-api";
import {
  type ConditionDraft,
  type TriggerId,
  fieldsForEvent,
  triggerToRule,
} from "./automation-presets";

/** One editable trigger draft: the preset pick, its task filter, and the
 *  advanced raw event/conditions that override the preset when used. */
export interface RuleDraft {
  trigger: TriggerId;
  taskFilter: string;
  advancedOpen: boolean;
  advancedEvent: AutomationEventType | "";
  advancedConditions: ConditionDraft[];
}

const EMPTY_DRAFT: RuleDraft = {
  trigger: "scheduled",
  taskFilter: "",
  advancedOpen: false,
  advancedEvent: "",
  advancedConditions: [],
};

/**
 * The trigger half of the automation dialogs, shared by create and edit so
 * the two wizards can never fork their rule vocabulary. Seeded once per
 * mount from `initial` (edit passes the parsed rule; create starts blank).
 */
export function useRuleDraft(initial: Partial<RuleDraft> = {}) {
  const [draft, setDraft] = useState<RuleDraft>({ ...EMPTY_DRAFT, ...initial });

  /** Picking a preset always closes the advanced disclosure. */
  const selectTrigger = useCallback((trigger: TriggerId) => {
    setDraft((prev) => ({ ...prev, trigger, advancedOpen: false }));
  }, []);

  const setTaskFilter = useCallback((taskFilter: string) => {
    setDraft((prev) => ({ ...prev, taskFilter }));
  }, []);

  /** For edit's seeding when opening Advanced: backfill the raw editor from
   *  the current selection so disclosure never silently broadens the rule. */
  const patchDraft = useCallback((patch: Partial<RuleDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  }, []);

  /** Changing the raw event restarts the condition list — fields differ
   *  per event, so stale rows would be meaningless. */
  const selectAdvancedEvent = useCallback(
    (event: AutomationEventType | "") => {
      setDraft((prev) => ({ ...prev, advancedEvent: event, advancedConditions: [] }));
    },
    [],
  );

  const updateCondition = useCallback(
    (index: number, patch: Partial<ConditionDraft>) => {
      setDraft((prev) => ({
        ...prev,
        advancedConditions: prev.advancedConditions.map((condition, i) =>
          i === index ? { ...condition, ...patch } : condition,
        ),
      }));
    },
    [],
  );

  const removeCondition = useCallback((index: number) => {
    setDraft((prev) => ({
      ...prev,
      advancedConditions: prev.advancedConditions.filter((_, i) => i !== index),
    }));
  }, []);

  const addCondition = useCallback(() => {
    setDraft((prev) => {
      if (prev.advancedEvent === "") return prev;
      return {
        ...prev,
        advancedConditions: [
          ...prev.advancedConditions,
          { field: fieldsForEvent(prev.advancedEvent)[0], operator: "eq", value: "" },
        ],
      };
    });
  }, []);

  const resetDraft = useCallback(() => setDraft(EMPTY_DRAFT), []);

  const rule = useMemo(
    () => triggerToRule(draft.trigger, draft.taskFilter),
    [draft.trigger, draft.taskFilter],
  );

  return {
    ...draft,
    selectTrigger,
    setTaskFilter,
    patchDraft,
    selectAdvancedEvent,
    updateCondition,
    removeCondition,
    addCondition,
    resetDraft,
    rule,
  };
}
