"use client";

const DURATION_PRESETS = [
  { label: "Any", min: undefined, max: undefined },
  { label: "< 1s", min: undefined, max: 1000 },
  { label: "1s - 10s", min: 1000, max: 10000 },
  { label: "10s - 60s", min: 10000, max: 60000 },
  { label: "> 60s", min: 60000, max: undefined },
];

/**
 * TraceFilterControls - Advanced filtering UI for the shared trace explorer.
 *
 * Provides controls for:
 * - Time range presets (1h, 24h, 7d, 30d, all)
 * - Environment selection
 * - Tag multi-select
 * - Session ID search
 * - Duration range slider
 */

import { useState, useEffect, useEffectEvent } from "react";
import { X, Search, ChevronUpIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  TraceFilters,
  FilterActions,
  TimePreset,
  hasActiveFilters,
} from "@/hooks/use-filters";
import {
  TraceProjectSelect,
  TraceTaskSelect,
  TraceModelMultiSelect,
  TraceMetricFilter,
} from "./trace-select-filters";

export interface FilterOptions {
  projects?: string[];
  tasks?: string[];
  models?: string[];
  metrics?: string[];
}

export type TraceFilterOptions = FilterOptions;

interface FilterControlsProps {
  filters: TraceFilters;
  actions: FilterActions;
  availableEnvironments?: string[];
  availableTags?: string[];
  filterOptions?: FilterOptions;
}

/**
 * Time preset options with labels.
 */
const TIME_PRESETS: { value: TimePreset; label: string }[] = [
  { value: "1h", label: "Last 1 hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
];

/**
 * Format duration for display.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Tag input component for multi-select tags.
 */
function TagInput({
  tags,
  availableTags,
  onAddTag,
  onRemoveTag,
  hideLabel = false,
}: {
  tags: string[];
  availableTags?: string[];
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  hideLabel?: boolean;
}) {
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);

  const tagSet = new Set(tags);
  // Filter available tags that aren't already selected
  const suggestions = availableTags
    ? availableTags.filter((tag) => !tagSet.has(tag))
    : [];

  const handleAdd = (tag: string) => {
    const trimmed = tag.trim();
    if (trimmed && !tagSet.has(trimmed)) {
      onAddTag(trimmed);
      setInput("");
      setShowSuggestions(false);
    }
  };

  return (
    <div className={hideLabel ? "" : "space-y-2"}>
      {!hideLabel && (
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          Tags
        </Label>
      )}
      <div className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1">
            {tag}
            <button type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => onRemoveTag(tag)}
              className="ml-1 hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>

      <div className="relative">
        <Input
          placeholder="Add tags..."
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) {
              e.preventDefault();
              handleAdd(input.trim());
            }
          }}
        />

        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover p-1 shadow-md">
            {suggestions.slice(0, 10).map((suggestion) => (
              <button type="button"
                key={suggestion}
                onClick={() => handleAdd(suggestion)}
                className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Duration range slider component.
 */
function DurationRange({
  min,
  max,
  onChange,
  hideLabel = false,
}: {
  min: number | undefined;
  max: number | undefined;
  onChange: (min?: number, max?: number) => void;
  hideLabel?: boolean;
}) {
  const activePreset = DURATION_PRESETS.find(
    (p) => p.min === min && p.max === max
  );

  return (
    <div className={hideLabel ? "" : "space-y-2"}>
      {!hideLabel && (
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          Duration
        </Label>
      )}
      <div className="flex flex-wrap gap-2">
        {DURATION_PRESETS.map((preset) => (
          <Badge
            key={preset.label}
            variant={
              activePreset?.label === preset.label ? "default" : "outline"
            }
            className="cursor-pointer"
            onClick={() => onChange(preset.min, preset.max)}
          >
            {preset.label}
          </Badge>
        ))}
      </div>

      {(min !== undefined || max !== undefined) && (
        <div className="text-sm text-muted-foreground">
          {min !== undefined && max !== undefined
            ? `${formatDuration(min)} - ${formatDuration(max)}`
            : min !== undefined
            ? `> ${formatDuration(min)}`
            : max !== undefined
            ? `< ${formatDuration(max)}`
            : "Any"}
        </div>
      )}
    </div>
  );
}

function FilterSection({ id, label, expanded, onToggle, children }: {
  id: string;
  label: string;
  expanded: string[];
  onToggle: (value: string) => void;
  children: React.ReactNode;
}) {
  const isOpen = expanded.includes(id);
  return (
    <div className="border-b">
      <button type="button"
        onClick={() => onToggle(id)}
        className="w-full flex items-center justify-between py-2 text-xs font-medium hover:underline"
      >
        <span>{label}</span>
        {isOpen ? <ChevronUpIcon className="h-4 w-4" /> : <ChevronDownIcon className="h-4 w-4" />}
      </button>
      {isOpen && <div className="pb-3">{children}</div>}
    </div>
  );
}

// Debounced search input for filter sidebar
function SearchFilter({
  value,
  onChange,
}: {
  value?: string;
  onChange: (value: string | undefined) => void;
}) {
  const [input, setInput] = useState(value || "");

  // `onChange` (parent's setSearch) changes identity on every parent render.
  // Wrap it in an effect event so the debounce timer only depends on `input`
  // and isn't reset each time the parent redraws.
  const onChangeEvent = useEffectEvent(onChange);

  useEffect(() => {
    const id = setTimeout(() => {
      onChangeEvent(input.trim() || undefined);
    }, 300);
    return () => clearTimeout(id);
  }, [input]);

  return (
    <div className="space-y-2">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
        Search
      </Label>
      <div className="relative">
        <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Run ID or external ID..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="pl-8"
        />
      </div>
    </div>
  );
}

export function TraceFilterControls({
  filters,
  actions,
  availableEnvironments = ["default", "dev", "staging", "production"],
  availableTags,
  filterOptions,
}: FilterControlsProps) {
  // Track which accordion sections are expanded
  const [expanded, setExpanded] = useState<string[]>(["time", "environment"]);

  const toggleExpanded = (value: string) => {
    setExpanded((prev) =>
      prev.includes(value)
        ? prev.filter((v) => v !== value)
        : [...prev, value]
    );
  };

  return (
    <div className="space-y-3">
      <SearchFilter value={filters.search} onChange={actions.setSearch} />

      <div className="space-y-1">
        <FilterSection id="time" label="Time Range" expanded={expanded} onToggle={toggleExpanded}>
          <Select
            value={filters.timePreset}
            onValueChange={(value) =>
              actions.setTimePreset(value as TimePreset)
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_PRESETS.map((preset) => (
                <SelectItem key={preset.value} value={preset.value}>
                  {preset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterSection>

        <FilterSection id="environment" label="Environment" expanded={expanded} onToggle={toggleExpanded}>
          <Select
            value={filters.environment || "all"}
            onValueChange={(value) =>
              actions.setEnvironment(value === "all" ? undefined : value)
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All environments</SelectItem>
              {availableEnvironments.map((env) => (
                <SelectItem key={env} value={env}>
                  {env}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterSection>

        <FilterSection id="project" label="Project" expanded={expanded} onToggle={toggleExpanded}>
          <TraceProjectSelect
            value={filters.project}
            onChange={actions.setProject}
            hideLabel={true}
            options={filterOptions?.projects}
          />
        </FilterSection>

        <FilterSection id="task" label="Task ID" expanded={expanded} onToggle={toggleExpanded}>
          <TraceTaskSelect
            value={filters.task_id}
            onChange={actions.setTaskId}
            hideLabel={true}
            options={filterOptions?.tasks}
          />
        </FilterSection>

        <FilterSection id="models" label="Models" expanded={expanded} onToggle={toggleExpanded}>
          <TraceModelMultiSelect
            models={filters.models}
            onAddModel={(model) => actions.setModels([...filters.models, model])}
            onRemoveModel={(model) => actions.setModels(filters.models.filter((m) => m !== model))}
            hideLabel={true}
            options={filterOptions?.models}
          />
        </FilterSection>

        <FilterSection id="metrics" label="Metrics" expanded={expanded} onToggle={toggleExpanded}>
          <TraceMetricFilter
            metricName={filters.metric_name}
            minScore={filters.min_score}
            maxScore={filters.max_score}
            onMetricChange={(name) =>
              actions.setMetricFilter(name || undefined, filters.min_score, filters.max_score)
            }
            onScoreRangeChange={(min, max) =>
              actions.setMetricFilter(filters.metric_name, min, max)
            }
            hideLabel={true}
            options={filterOptions?.metrics}
          />
        </FilterSection>

        <FilterSection id="tags" label="Tags" expanded={expanded} onToggle={toggleExpanded}>
          <TagInput
            tags={filters.tags}
            availableTags={availableTags}
            onAddTag={(tag) =>
              actions.setTags([...filters.tags, tag])
            }
            onRemoveTag={(tag) =>
              actions.setTags(filters.tags.filter((t) => t !== tag))
            }
            hideLabel={true}
          />
        </FilterSection>

        <FilterSection id="session" label="Session ID" expanded={expanded} onToggle={toggleExpanded}>
          <Input
            placeholder="Search by session ID..."
            value={filters.session_id || ""}
            onChange={(e) =>
              actions.setSessionId(e.target.value || undefined)
            }
          />
        </FilterSection>

        <FilterSection id="duration" label="Duration" expanded={expanded} onToggle={toggleExpanded}>
          <DurationRange
            min={filters.min_duration_ms}
            max={filters.max_duration_ms}
            onChange={actions.setDurationRange}
            hideLabel={true}
          />
        </FilterSection>
      </div>

      {/* Clear filters button */}
      {hasActiveFilters(filters) && (
        <Button type="button"
          variant="outline"
          size="sm"
          onClick={actions.clearAllFilters}
          className="w-full gap-1"
        >
          <X className="h-4 w-4" />
          Clear all filters
        </Button>
      )}
    </div>
  );
}
