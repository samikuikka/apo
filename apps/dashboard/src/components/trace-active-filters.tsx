"use client";

/**
 * TraceActiveFilters - Display active trace filters as removable chips.
 *
 * Shows a summary of all active filters with ability to remove individual filters.
 */

import {
  X,
  Clock,
  Hash,
  Tag,
  Timer,
  Search as SearchIcon,
  FolderOpen,
  ListTodo,
  Cpu,
  BarChart,
  User,
  AlertCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TraceFilters, TimePreset } from "@/hooks/use-filters";

interface ActiveFiltersProps {
  filters: TraceFilters;
  onRemoveFilter: (key: keyof TraceFilters, value?: any) => void;
  onClearAll: () => void;
}

/**
 * Format time preset for display.
 */
function formatTimePreset(preset: TimePreset): string {
  const labels: Record<TimePreset, string> = {
    "1h": "Last 1 hour",
    "24h": "Last 24 hours",
    "7d": "Last 7 days",
    "30d": "Last 30 days",
    all: "All time",
    custom: "Custom range",
  };
  return labels[preset];
}

/**
 * Format duration for display.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Filter chip component.
 */
function FilterChip({
  icon,
  label,
  onRemove,
}: {
  icon: React.ReactNode;
  label: string;
  onRemove: () => void;
}) {
  return (
    <Badge variant="secondary" className="gap-1 pr-1">
      {icon}
      <span>{label}</span>
      <button type="button"
        aria-label={`Remove ${label} filter`}
        onClick={onRemove}
        className="ml-1 rounded-sm hover:bg-destructive/20 hover:text-destructive transition-colors"
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  );
}

/**
 * Active filters display component.
 */
export function TraceActiveFilters({
  filters,
  onRemoveFilter,
  onClearAll,
}: ActiveFiltersProps) {
  const chips: React.ReactNode[] = [];

  // Time preset
  if (filters.timePreset !== "all") {
    chips.push(
      <FilterChip
        key="time"
        icon={<Clock className="h-3 w-3" />}
        label={formatTimePreset(filters.timePreset)}
        onRemove={() => onRemoveFilter("timePreset")}
      />
    );
  }

  // Environment (comma-separated)
  if (filters.environment) {
    filters.environment.split(",").filter(Boolean).forEach((env) => {
      chips.push(
        <FilterChip
          key={`env-${env}`}
          icon={<Hash className="h-3 w-3" />}
          label={`env: ${env}`}
          onRemove={() => onRemoveFilter("environment", env)}
        />
      );
    });
  }

  // Project
  if (filters.project) {
    chips.push(
      <FilterChip
        key="project"
        icon={<FolderOpen className="h-3 w-3" />}
        label={`project: ${filters.project}`}
        onRemove={() => onRemoveFilter("project")}
      />
    );
  }

  // Status (comma-separated)
  if (filters.status) {
    filters.status.split(",").filter(Boolean).forEach((st) => {
      chips.push(
        <FilterChip
          key={`status-${st}`}
          icon={<AlertCircle className="h-3 w-3" />}
          label={st}
          onRemove={() => onRemoveFilter("status", st)}
        />
      );
    });
  }

  // Task ID
  if (filters.task_id) {
    chips.push(
      <FilterChip
        key="task_id"
        icon={<ListTodo className="h-3 w-3" />}
        label={`task: ${filters.task_id}`}
        onRemove={() => onRemoveFilter("task_id")}
      />
    );
  }

  // Tags
  filters.tags.forEach((tag) => {
    chips.push(
      <FilterChip
        key={`tag-${tag}`}
        icon={<Tag className="h-3 w-3" />}
        label={tag}
        onRemove={() =>
          onRemoveFilter(
            "tags",
            filters.tags.filter((t) => t !== tag)
          )
        }
      />
    );
  });

  // Models (TASK-015: Phase 2)
  filters.models.forEach((model) => {
    chips.push(
      <FilterChip
        key={`model-${model}`}
        icon={<Cpu className="h-3 w-3" />}
        label={model}
        onRemove={() =>
          onRemoveFilter(
            "models",
            filters.models.filter((m) => m !== model)
          )
        }
      />
    );
  });

  // Metrics (TASK-015: Phase 3)
  if (filters.metric_name) {
    const label =
      filters.min_score !== undefined || filters.max_score !== undefined
        ? `${filters.metric_name}: ${
            filters.min_score !== undefined && filters.max_score !== undefined
              ? `${filters.min_score}-${filters.max_score}`
              : filters.min_score !== undefined
              ? `≥${filters.min_score}`
              : `≤${filters.max_score}`
          }`
        : filters.metric_name;

    chips.push(
      <FilterChip
        key="metric"
        icon={<BarChart className="h-3 w-3" />}
        label={label}
        onRemove={() => onRemoveFilter("metric_name")}
      />
    );
  }

  // Session ID (comma-separated)
  if (filters.session_id) {
    filters.session_id.split(",").filter(Boolean).forEach((sid) => {
      chips.push(
        <FilterChip
          key={`session-${sid}`}
          icon={<Hash className="h-3 w-3" />}
          label={`session: ${sid.length > 12 ? sid.slice(0, 12) + "..." : sid}`}
          onRemove={() => onRemoveFilter("session_id", sid)}
        />
      );
    });
  }

  // User ID (comma-separated)
  if (filters.user_id) {
    filters.user_id.split(",").filter(Boolean).forEach((uid) => {
      chips.push(
        <FilterChip
          key={`user-${uid}`}
          icon={<User className="h-3 w-3" />}
          label={`user: ${uid.length > 16 ? uid.slice(0, 16) + "..." : uid}`}
          onRemove={() => onRemoveFilter("user_id", uid)}
        />
      );
    });
  }

  // Duration range
  if (filters.min_duration_ms !== undefined || filters.max_duration_ms !== undefined) {
    let label = "";
    if (filters.min_duration_ms && filters.max_duration_ms) {
      label = `${formatDuration(filters.min_duration_ms)} - ${formatDuration(filters.max_duration_ms)}`;
    } else if (filters.min_duration_ms) {
      label = `> ${formatDuration(filters.min_duration_ms)}`;
    } else if (filters.max_duration_ms) {
      label = `< ${formatDuration(filters.max_duration_ms)}`;
    }

    chips.push(
      <FilterChip
        key="duration"
        icon={<Timer className="h-3 w-3" />}
        label={label}
        onRemove={() => onRemoveFilter("min_duration_ms")}
      />
    );
  }

  // Search
  if (filters.search) {
    chips.push(
      <FilterChip
        key="search"
        icon={<SearchIcon className="h-3 w-3" />}
        label={`"${filters.search}"`}
        onRemove={() => onRemoveFilter("search")}
      />
    );
  }

  // No active filters
  if (chips.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-sm text-muted-foreground">Active filters:</span>
      {chips}
      <Button type="button"
        variant="ghost"
        size="sm"
        onClick={onClearAll}
        className="h-7 text-xs"
      >
        Clear all
      </Button>
    </div>
  );
}
