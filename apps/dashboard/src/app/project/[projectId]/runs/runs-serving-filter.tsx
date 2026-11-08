"use client";

import { useCallback, useRef, useState } from "react";

import { Input } from "@/components/ui/input";

/**
 * Same-request serving-dimension filters (issue #307): Host, Route, and
 * served Tier, each a comma-separated multi-value text input synced to the
 * URL (`?host=`, `?route=`, `?tier=`) exactly like the search box — the
 * values the backend ORs within a dimension and ANDs across dimensions on
 * one request. The provider dimension keeps its facet dropdown on the Hosts
 * column; these three have no facet source, so free text is the honest
 * control. URL state is owned by the parent; only the debounced inputs are
 * local.
 */
export function RunsServingFilter({
  host,
  route,
  tier,
  onChange,
}: {
  /** Current comma-joined `?host=` value ("" = unset). */
  host: string;
  /** Current comma-joined `?route=` value ("" = unset). */
  route: string;
  /** Current comma-joined `?tier=` value ("" = unset). */
  tier: string;
  /** Commits one dimension's next comma-joined value; null clears it. */
  onChange: (updates: { host?: string | null; route?: string | null; tier?: string | null }) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      <ServingInput
        label="Host"
        placeholder="baseten"
        value={host}
        onCommit={(next) => onChange({ host: next })}
      />
      <ServingInput
        label="Route"
        placeholder="nitro"
        value={route}
        onCommit={(next) => onChange({ route: next })}
      />
      <ServingInput
        label="Tier"
        placeholder="priority"
        value={tier}
        onCommit={(next) => onChange({ tier: next })}
      />
    </div>
  );
}

function ServingInput({
  label,
  placeholder,
  value,
  onCommit,
}: {
  label: string;
  placeholder: string;
  value: string;
  onCommit: (next: string | null) => void;
}) {
  const [text, setText] = useState(value);
  // Follow ?param changes that did not come from our own typing (initial
  // load, back/forward, Clear Filters) with a prev-value compare in render.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setText(value);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handleChange = useCallback(
    (next: string) => {
      setText(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        onCommit(next.trim() ? next.trim() : null);
      }, 350);
    },
    [onCommit],
  );
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-foreground/50">{label}</span>
      <Input
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        aria-label={`${label} serving filter`}
        data-testid={`serving-filter-${label.toLowerCase()}`}
        className="h-7 w-[110px] border-border bg-muted/40 font-mono text-[12px] placeholder:font-sans placeholder:text-muted-foreground/50 focus-visible:border-border"
      />
    </label>
  );
}
