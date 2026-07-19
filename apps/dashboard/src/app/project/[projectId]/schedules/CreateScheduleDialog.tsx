"use client";

import { useReducer, useState } from "react";
import { useBrowserTimezone } from "@/hooks/use-client-now";
import {
  CheckCircle2,
  Clock,
  Loader2,
} from "lucide-react";
import {
  createAgentTaskSchedule,
  type AgentTaskScheduleSummary,
  type AgentTaskSummary,
} from "@/lib/agent-task-api";
import { useProjectId } from "@/lib/project-router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScheduleBuilder, type ScheduleBuilderValue } from "@/components/schedule/ScheduleBuilder";
import { TaskFolderSelect } from "@/components/task-folder-select";

interface CreateScheduleDialogProps {
  tasks: AgentTaskSummary[];
  initialTaskIds: string[];
  taskRoot: string | null;
  onClose: () => void;
  onCreated: (schedule: AgentTaskScheduleSummary) => void;
}

export default function CreateScheduleDialog({
  tasks,
  initialTaskIds,
  taskRoot,
  onClose,
  onCreated,
}: CreateScheduleDialogProps) {
  const projectId = useProjectId();
  const [name, setName] = useState(initialTaskIds.length === 1 ? `${initialTaskIds[0]} daily` : "");
  const [scheduleValue, setScheduleValue] = useState<ScheduleBuilderValue>({
    cadence_type: "daily",
    timezone: "UTC",
    hour: 9,
    minute: 0,
    day_of_week: null,
    day_of_month: null,
    min_interval_days: 1,
    max_interval_days: 30,
  });
  const browserTz = useBrowserTimezone();
  const [appliedTz, setAppliedTz] = useState<string | null>(null);
  if (browserTz && browserTz !== appliedTz) {
    setAppliedTz(browserTz);
    setScheduleValue((v) => ({ ...v, timezone: browserTz }));
  }
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialTaskIds));
  const [submitState, dispatchSubmit] = useReducer(
    (s: { submitting: boolean; error: string | null }, a:
      | { type: "START" }
      | { type: "SUCCESS" }
      | { type: "ERROR"; error: string }
    ) => {
      switch (a.type) {
        case "START": return { submitting: true, error: null };
        case "SUCCESS": return { submitting: false, error: null };
        case "ERROR": return { submitting: false, error: a.error };
      }
    },
    { submitting: false, error: null },
  );
  const [step, setStep] = useState<"schedule" | "tasks">("schedule");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selected.size === 0) {
      dispatchSubmit({ type: "ERROR", error: "Select at least one task" });
      return;
    }
    if (!name.trim()) {
      dispatchSubmit({ type: "ERROR", error: "Schedule name is required" });
      return;
    }

    dispatchSubmit({ type: "START" });
    try {
      const selectedPaths = tasks.flatMap((t) =>
        selected.has(t.id) ? [t.task_path] : [],
      );
      const created = await createAgentTaskSchedule({
        project: projectId,
        name: name.trim(),
        selection_type: selectedPaths.length === 1 ? "task" : "tasks",
        task_paths: selectedPaths,
        task_root: taskRoot,
        cadence_type: scheduleValue.cadence_type,
        timezone: scheduleValue.timezone,
        hour: scheduleValue.hour,
        minute: scheduleValue.minute,
        day_of_week: scheduleValue.day_of_week,
        day_of_month: scheduleValue.day_of_month,
        min_interval_days: scheduleValue.min_interval_days,
        max_interval_days: scheduleValue.max_interval_days,
        enabled: true,
      });
      onCreated(created);
    } catch (e: unknown) {
      dispatchSubmit({ type: "ERROR", error: e instanceof Error ? e.message : "Failed to create schedule" });
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle>New Schedule</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Configure when your agent tasks run automatically
          </p>
        </DialogHeader>

        <form onSubmit={handleCreate} className="flex flex-col flex-1 overflow-hidden">
          <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
            <div>
              <label htmlFor="schedule-name" className="block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wider">
                Schedule Name
              </label>
              <Input
                id="schedule-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. nightly-regression"
                className="font-mono"
              />
            </div>

            <div className="flex gap-1 rounded-lg border border-border/60 bg-muted/30 p-1">
              <button
                type="button"
                onClick={() => setStep("schedule")}
                className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  step === "schedule" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Clock size={13} className="inline mr-1.5 -mt-0.5" />
                Schedule
              </button>
              <button
                type="button"
                onClick={() => setStep("tasks")}
                className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  step === "tasks" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <CheckCircle2 size={13} className="inline mr-1.5 -mt-0.5" />
                Tasks
                {selected.size > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-primary/10 text-primary font-mono">
                    {selected.size}
                  </span>
                )}
              </button>
            </div>

            {step === "schedule" && (
              <ScheduleBuilder value={scheduleValue} onChange={setScheduleValue} />
            )}

            {step === "tasks" && (
              <div>
                <div className="mb-2">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Select Tasks
                  </span>
                </div>
                <TaskFolderSelect
                  tasks={tasks}
                  selected={selected}
                  onSelectedChange={setSelected}
                  className="max-h-[360px] overflow-y-auto pr-1"
                />
              </div>
            )}
          </div>

          <div className="border-t border-border/60 px-6 py-4 flex items-center justify-between gap-3">
            {submitState.error ? (
              <p className="text-xs text-destructive">{submitState.error}</p>
            ) : selected.size > 0 ? (
              <p className="text-xs text-muted-foreground">
                {selected.size} task{selected.size !== 1 ? "s" : ""} selected
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              {step === "schedule" ? (
                <Button type="button" size="sm" onClick={() => setStep("tasks")}>
                  Next: Select Tasks
                </Button>
              ) : (
                <Button type="submit" size="sm" disabled={submitState.submitting || selected.size === 0}>
                  {submitState.submitting ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2 size={13} className="animate-spin" />
                      Creating...
                    </span>
                  ) : (
                    "Create Schedule"
                  )}
                </Button>
              )}
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
