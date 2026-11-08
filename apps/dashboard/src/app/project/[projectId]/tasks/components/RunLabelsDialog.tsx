"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchRunLabelFacets, type RunLabelFacets, type RunLabels } from "@/lib/agent-task-api";

const LABEL_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LABELS = 32;
const MAX_VALUE_LENGTH = 256;

/**
 * The step between selecting tasks and starting the batch: optional run
 * labels. A label is a free key and value (the value becomes both the id the
 * filters match and its display name, same as the CLI's --label key:id), with
 * suggestions from the values the project's runs already carry so the common
 * case is a click and a typo cannot fork a dimension. The shape and limits
 * mirror the backend's run_metadata.labels validation exactly; anything the
 * dialog lets through with a label the backend would 422.
 */
export function RunLabelsDialog({
  open,
  onOpenChange,
  projectId,
  selectedCount,
  running,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  selectedCount: number;
  running: boolean;
  onStart: (labels: RunLabels) => void;
}) {
  const [labels, setLabels] = useState<RunLabels>({});
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [facets, setFacets] = useState<RunLabelFacets | null>(null);

  // Suggestions come from the same facet summary the Runs filter rail reads;
  // failing to load them only removes the shortcuts, never blocks the run.
  // The fetch helper takes no signal, so a close is tracked with a flag.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFacets(null);
    fetchRunLabelFacets(projectId)
      .then((loaded) => {
        if (!cancelled) setFacets(loaded);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const suggestions = useMemo(() => {
    const trimmed = key.trim();
    if (!facets || !trimmed) return [];
    return facets.labels.find((facet) => facet.key === trimmed)?.values ?? [];
  }, [facets, key]);

  const addLabel = () => {
    const trimmedKey = key.trim();
    const trimmedValue = value.trim();
    if (!trimmedKey && !trimmedValue) {
      setError("Fill in a key and a value, e.g. team and platforms.");
      return;
    }
    if (!LABEL_KEY_RE.test(trimmedKey)) {
      setError("Keys use letters, digits, _ and - (up to 64 characters).");
      return;
    }
    if (labels[trimmedKey]) {
      setError(`"${trimmedKey}" already has a value; remove it first to change it.`);
      return;
    }
    if (Object.keys(labels).length >= MAX_LABELS) {
      setError(`A run carries at most ${MAX_LABELS} labels.`);
      return;
    }
    if (!trimmedValue) {
      setError("Fill in a value for the label.");
      return;
    }
    if (trimmedValue.length > MAX_VALUE_LENGTH) {
      setError(`Values are at most ${MAX_VALUE_LENGTH} characters.`);
      return;
    }
    setLabels((prev) => ({ ...prev, [trimmedKey]: { id: trimmedValue, name: trimmedValue } }));
    setKey("");
    setValue("");
    setError(null);
  };

  const start = () => {
    if (!running) onStart(labels);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Start Run</DialogTitle>
          <DialogDescription>
            {selectedCount} task{selectedCount === 1 ? "" : "s"} selected. Labels are optional;
            they make these runs filterable, e.g. team platforms.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {Object.keys(labels).length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {Object.entries(labels).map(([labelKey, label]) => (
                <span
                  key={labelKey}
                  className="inline-flex h-6 items-center gap-1.5 border border-border bg-muted/40 pl-2 text-[11px]"
                >
                  <span className="text-muted-foreground">{labelKey}</span>
                  <span>{label.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${labelKey} ${label.name}`}
                    onClick={() =>
                      setLabels((prev) => {
                        const next = { ...prev };
                        delete next[labelKey];
                        return next;
                      })
                    }
                    className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex items-start gap-2">
            <Input
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="key"
              aria-label="Label key"
              className="h-8 w-32 font-mono text-xs"
            />
            <Input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addLabel();
                }
              }}
              placeholder="value"
              aria-label="Label value"
              className="h-8 flex-1 text-xs"
            />
            <Button type="button" variant="outline" size="sm" className="h-8" onClick={addLabel}>
              Add Label
            </Button>
          </div>

          {suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">Used for {key.trim()}:</span>
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  onClick={() => {
                    setKey(key.trim());
                    setValue(suggestion.name);
                    setError(null);
                  }}
                  className="border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted/60"
                >
                  {suggestion.name}
                </button>
              ))}
            </div>
          )}

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={running}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={start} disabled={running}>
            {running
              ? "Starting…"
              : `Run ${selectedCount} task${selectedCount === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
