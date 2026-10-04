"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AutomationEventType } from "@/lib/automations-api";
import {
  type ConditionDraft,
  EVENT_TYPES,
  fieldsForEvent,
  OPERATORS,
  SELECT_CLASS,
} from "../automation-presets";

interface AdvancedRuleEditorProps {
  event: AutomationEventType | "";
  conditions: ConditionDraft[];
  onSelectEvent: (event: AutomationEventType | "") => void;
  onUpdateCondition: (index: number, patch: Partial<ConditionDraft>) => void;
  onRemoveCondition: (index: number) => void;
  onAddCondition: () => void;
  /** Placeholder for the condition value input; create hints the wire
   *  shapes, edit (editing an existing rule) stays hint-free. */
  valuePlaceholder?: string;
}

/**
 * The raw event/conditions editor behind the automation dialogs' Advanced
 * disclosure. Rendered as a fragment so each dialog keeps its own
 * surrounding layout; the disclosure toggle itself stays per-dialog
 * because edit seeds it from the current rule when opening.
 */
export function AdvancedRuleEditor({
  event,
  conditions,
  onSelectEvent,
  onUpdateCondition,
  onRemoveCondition,
  onAddCondition,
  valuePlaceholder,
}: AdvancedRuleEditorProps) {
  return (
    <>
      <select
        aria-label="Raw event type"
        className={SELECT_CLASS}
        value={event}
        onChange={(e) => onSelectEvent(e.target.value as AutomationEventType | "")}
      >
        <option value="">Choose an event…</option>
        {EVENT_TYPES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {event ? (
        <div className="flex flex-col gap-2">
          {conditions.map((condition, index) => (
            <div
              key={index}
              className="flex flex-col gap-1 sm:flex-row sm:items-center"
            >
              <select
                aria-label={`Condition ${index + 1} field`}
                className={`${SELECT_CLASS} sm:flex-1`}
                value={condition.field}
                onChange={(e) => onUpdateCondition(index, { field: e.target.value })}
              >
                {fieldsForEvent(event).map((field) => (
                  <option key={field} value={field}>
                    {field}
                  </option>
                ))}
              </select>
              <select
                aria-label={`Condition ${index + 1} operator`}
                className={SELECT_CLASS}
                value={condition.operator}
                onChange={(e) =>
                  onUpdateCondition(index, { operator: e.target.value })
                }
              >
                {OPERATORS.map((operator) => (
                  <option key={operator} value={operator}>
                    {operator}
                  </option>
                ))}
              </select>
              <Input
                aria-label={`Condition ${index + 1} value`}
                className="h-8 flex-1 text-xs"
                value={condition.value}
                onChange={(e) => onUpdateCondition(index, { value: e.target.value })}
                placeholder={valuePlaceholder}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => onRemoveCondition(index)}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 self-start"
            onClick={onAddCondition}
          >
            Add Condition
          </Button>
        </div>
      ) : null}
    </>
  );
}
