import { useMemo, useState } from "react";
import {
  deleteAgentTaskSchedule,
  getAgentTaskSchedule,
  triggerSchedule,
  type AgentTaskScheduleSummary,
  updateAgentTaskSchedule,
} from "@/lib/agent-task-api";

export type Filter = "all" | "enabled" | "disabled";

export function useScheduleActions(initialSchedules: AgentTaskScheduleSummary[], serverError: string | null) {
  const [schedules, setSchedules] = useState(initialSchedules);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [localError, setLocalError] = useState<string | null | undefined>(undefined);
  const actionError = localError === undefined ? serverError : localError;

  const filtered = useMemo(() => {
    return schedules.filter((s) => {
      if (filter === "enabled" && !s.enabled) return false;
      if (filter === "disabled" && s.enabled) return false;
      if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [schedules, filter, search]);

  const stats = useMemo(() => ({
    total: schedules.length,
    enabled: schedules.filter((s) => s.enabled).length,
    disabled: schedules.filter((s) => !s.enabled).length,
  }), [schedules]);

  const handleToggleEnabled = async (schedule: AgentTaskScheduleSummary) => {
    try {
      const updated = await updateAgentTaskSchedule(schedule.id, { enabled: !schedule.enabled });
      setSchedules((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (e: unknown) {
      setLocalError(e instanceof Error ? e.message : "Failed to toggle schedule");
    }
  };

  const handleDelete = async (scheduleId: string) => {
    try {
      await deleteAgentTaskSchedule(scheduleId);
      setSchedules((prev) => prev.filter((item) => item.id !== scheduleId));
    } catch (e: unknown) {
      setLocalError(e instanceof Error ? e.message : "Failed to delete schedule");
    }
  };

  const handleTrigger = async (schedule: AgentTaskScheduleSummary) => {
    try {
      const result = await triggerSchedule(schedule.id);
      setSchedules((prev) => prev.map((item) => (item.id === result.schedule.id ? result.schedule : item)));
    } catch (e: unknown) {
      setLocalError(e instanceof Error ? e.message : "Failed to trigger schedule");
    }
  };

  const addSchedule = (newSchedule: AgentTaskScheduleSummary) => {
    setSchedules((prev) => [newSchedule, ...prev]);
  };

  const refreshSchedule = async (scheduleId: string) => {
    try {
      const updated = await getAgentTaskSchedule(scheduleId);
      setSchedules((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch {
      // stale state is non-fatal; the next manual action will resync
    }
  };

  return {
    schedules,
    filtered,
    stats,
    filter,
    setFilter,
    search,
    setSearch,
    actionError,
    clearError: () => setLocalError(null),
    handleToggleEnabled,
    handleDelete,
    handleTrigger,
    addSchedule,
    refreshSchedule,
  };
}
