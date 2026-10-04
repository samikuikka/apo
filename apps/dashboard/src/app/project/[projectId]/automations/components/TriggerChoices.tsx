"use client";

import { Input } from "@/components/ui/input";
import {
  type TriggerId,
  TRIGGER_CHOICES,
} from "../automation-presets";

interface TriggerChoicesProps {
  trigger: TriggerId;
  taskFilter: string;
  useAdvanced: boolean;
  onSelectTrigger: (trigger: TriggerId) => void;
  onTaskFilterChange: (value: string) => void;
}

/**
 * The plain-language trigger presets and the task-id filter for the "task"
 * preset — the shared "When exactly?" block of the automation dialogs.
 * Rendered as a fragment so each dialog keeps its own surrounding layout.
 */
export function TriggerChoices({
  trigger,
  taskFilter,
  useAdvanced,
  onSelectTrigger,
  onTaskFilterChange,
}: TriggerChoicesProps) {
  return (
    <>
      {TRIGGER_CHOICES.map((choice) => {
        const selected = trigger === choice.id && !useAdvanced;
        return (
          <button
            key={choice.id}
            type="button"
            aria-pressed={selected}
            className={`border p-3 text-left text-sm transition-colors ${
              selected
                ? "border-foreground bg-muted/30"
                : "border-border bg-background hover:border-foreground/40"
            }`}
            onClick={() => onSelectTrigger(choice.id)}
          >
            <span>
              {choice.label}
              <span className="block text-xs text-muted-foreground">
                {choice.hint}
              </span>
            </span>
            {selected ? (
              <span aria-hidden className="float-right">
                ●
              </span>
            ) : null}
          </button>
        );
      })}

      {trigger === "task" && !useAdvanced ? (
        <label className="mt-1 flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Task id</span>
          <Input
            aria-label="Task id to watch"
            className="h-8 text-xs"
            value={taskFilter}
            onChange={(e) => onTaskFilterChange(e.target.value)}
            placeholder="data-extraction"
          />
        </label>
      ) : null}
    </>
  );
}
