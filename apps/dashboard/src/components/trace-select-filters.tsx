"use client";

/**
 * TraceSelectFilters - Select dropdowns for project, flow, task, and model filtering.
 *
 * Provides select components that fetch their options from the backend API.
 */

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { getBrowserBackendBaseUrl } from "@/lib/config";
import { backendFetch } from "@/lib/backend-fetch";

const API_BASE = getBrowserBackendBaseUrl();

interface SelectFilterProps {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  label: string;
  placeholder: string;
  endpoint: string;
  project?: string;
  hideLabel?: boolean;
  options?: string[];
}

/**
 * Generic select filter component that fetches options from an endpoint.
 */
function SelectFilter({
  value,
  onChange,
  label,
  placeholder,
  endpoint,
  project,
  hideLabel = false,
  options: serverOptions,
}: SelectFilterProps) {
  const [fetchedOptions, setFetchedOptions] = useState<string[]>(serverOptions ?? []);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const fetchOptions = async () => {
      setLoading(true);
      try {
        const url = project
          ? `${API_BASE}${endpoint}?project=${encodeURIComponent(project)}`
          : `${API_BASE}${endpoint}`;
        const response = await backendFetch(url, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (response.ok) {
          const data = await response.json();
          setFetchedOptions(data);
        } else {
          await response.text();
        }
      } catch {
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    fetchOptions();
    return () => { controller.abort(); };
  }, [endpoint, project]);

  const options = fetchedOptions;

  return (
    <div className={hideLabel ? "" : "space-y-2"}>
      {!hideLabel && (
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </Label>
      )}
      <Select
        value={value || "all"}
        onValueChange={(val) => onChange(val === "all" ? undefined : val)}
        disabled={loading}
      >
        <SelectTrigger>
          <SelectValue placeholder={loading ? "Loading..." : placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All {label.toLowerCase()}s</SelectItem>
          {options.length === 0 && (
            <SelectItem value="_empty" disabled>
              No {label.toLowerCase()}s found
            </SelectItem>
          )}
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Project select dropdown.
 */
export function TraceProjectSelect({
  value,
  onChange,
  hideLabel = false,
  options,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  hideLabel?: boolean;
  options?: string[];
}) {
  return (
    <SelectFilter
      value={value}
      onChange={onChange}
      label="Project"
      placeholder="Select project"
      endpoint="/v1/runs/distinct-projects"
      hideLabel={hideLabel}
      options={options}
    />
  );
}

/**
 * Task ID select dropdown.
 */
export function TraceTaskSelect({
  value,
  onChange,
  hideLabel = false,
  options,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  hideLabel?: boolean;
  options?: string[];
}) {
  return (
    <SelectFilter
      value={value}
      onChange={onChange}
      label="Task ID"
      placeholder="Select task"
      endpoint="/v1/runs/distinct-tasks"
      hideLabel={hideLabel}
      options={options}
    />
  );
}

/**
 * Model multi-select component (TASK-015: Phase 2).
 * Similar to TagInput but fetches available models from the backend.
 */
interface ModelMultiSelectProps {
  models: string[];
  availableModels?: string[];
  onAddModel: (model: string) => void;
  onRemoveModel: (model: string) => void;
  hideLabel?: boolean;
  options?: string[];
}

export function TraceModelMultiSelect({
  models,
  availableModels: _availableModels,
  onAddModel,
  onRemoveModel,
  hideLabel = false,
  options: serverOptions,
}: ModelMultiSelectProps) {
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);

  const [fetchedOptions, setFetchedOptions] = useState<string[]>(serverOptions ?? []);

  useEffect(() => {
    const controller = new AbortController();
    const fetchModels = async () => {
      try {
        const response = await backendFetch(`${API_BASE}/v1/runs/distinct-models`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (response.ok) {
          const data = await response.json();
          setFetchedOptions(data);
        }
      } catch {
      }
    };
    fetchModels();
    return () => { controller.abort(); };
  }, []);

  const options = fetchedOptions;

  const modelSet = new Set(models);
  // Filter available models that aren't already selected
  const suggestions = options.filter((model) => !modelSet.has(model));

  const handleAdd = (model: string) => {
    const trimmed = model.trim();
    if (trimmed && !modelSet.has(trimmed)) {
      onAddModel(trimmed);
      setInput("");
      setShowSuggestions(false);
    }
  };

  return (
    <div className={hideLabel ? "" : "space-y-2"}>
      {!hideLabel && (
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          Models
        </Label>
      )}
      <div className="flex flex-wrap gap-2">
        {models.map((model) => (
          <Badge key={model} variant="secondary" className="gap-1">
            {model}
            <button type="button"
              aria-label={`Remove model ${model}`}
              onClick={() => onRemoveModel(model)}
              className="ml-1 hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>

      <div className="relative">
        <Input
          placeholder="Add models..."
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
 * Metric filter component (TASK-015: Phase 3).
 * Filters by metric name and score range.
 */
interface MetricFilterProps {
  metricName: string | undefined;
  minScore: number | undefined;
  maxScore: number | undefined;
  onMetricChange: (name: string) => void;
  onScoreRangeChange: (min?: number, max?: number) => void;
  hideLabel?: boolean;
  options?: string[];
}

export function TraceMetricFilter({
  metricName,
  minScore,
  maxScore,
  onMetricChange,
  onScoreRangeChange,
  hideLabel = false,
  options: serverOptions,
}: MetricFilterProps) {
  const [fetchedOptions, setFetchedOptions] = useState<string[]>(serverOptions ?? []);

  useEffect(() => {
    const controller = new AbortController();
    const fetchMetrics = async () => {
      try {
        const response = await backendFetch(`${API_BASE}/v1/runs/distinct-metrics`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (response.ok) {
          const data = await response.json();
          setFetchedOptions(data);
        }
      } catch {
      }
    };
    fetchMetrics();
    return () => { controller.abort(); };
  }, []);

  const options = fetchedOptions;

  return (
    <div className={hideLabel ? "" : "space-y-2"}>
      {!hideLabel && (
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          Metrics
        </Label>
      )}

      {/* Metric name dropdown */}
      <Select
        value={metricName || "all"}
        onValueChange={(val) => onMetricChange(val === "all" ? "" : val)}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select metric" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All metrics</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Score range inputs */}
      {metricName && (
        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              type="number"
              placeholder="Min score"
              value={minScore ?? ""}
              onChange={(e) =>
                onScoreRangeChange(
                  e.target.value ? Number(e.target.value) : undefined,
                  maxScore
                )
              }
              step="0.01"
            />
          </div>
          <div className="flex-1">
            <Input
              type="number"
              placeholder="Max score"
              value={maxScore ?? ""}
              onChange={(e) =>
                onScoreRangeChange(
                  minScore,
                  e.target.value ? Number(e.target.value) : undefined
                )
              }
              step="0.01"
            />
          </div>
        </div>
      )}

      {/* Display current range */}
      {metricName && (minScore !== undefined || maxScore !== undefined) && (
        <div className="text-xs text-muted-foreground">
          {minScore !== undefined && maxScore !== undefined
            ? `${minScore} - ${maxScore}`
            : minScore !== undefined
            ? `≥ ${minScore}`
            : maxScore !== undefined
            ? `≤ ${maxScore}`
            : ""}
        </div>
      )}
    </div>
  );
}
