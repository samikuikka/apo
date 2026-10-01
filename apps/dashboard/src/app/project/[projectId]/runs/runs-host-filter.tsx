"use client";

import { ListFilter } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ProviderFacetOption } from "@/lib/agent-task-api";

/**
 * A URL-backed multi-select facet for filtering runs by serving host
 * (issue #307). Lives on the Hosts column header next to its sibling model
 * filter — the host is that column's data. Options come from the listing's
 * provider facet (route-wins labels, so every option is visible in the
 * column); selection is a comma-separated `?provider=a,b`, shareable like
 * `?model=`. A selected value missing from the facet stays listed so a
 * shared/cohort link can never apply an invisible, unclearable filter.
 */
export function RunsHostFilter({
  options,
  selected,
  onToggle,
  onClear,
}: {
  options: ProviderFacetOption[];
  selected: Set<string>;
  onToggle: (host: string) => void;
  onClear: () => void;
}) {
  const selectedCount = selected.size;
  // Keep values the URL selects even when the current page's facet lost
  // them (filtering shrinks the facet) — same contract as the effort
  // options on the model filter.
  const listed = new Map(options.map((o) => [o.label, o.count]));
  for (const host of selected) {
    if (!listed.has(host)) listed.set(host, 0);
  }
  const entries = [...listed.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const disabled = entries.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Filter by serving host"
          className={cn(
            "inline-grid h-5 w-5 place-items-center rounded-sm align-middle transition-colors",
            disabled
              ? "cursor-not-allowed text-muted-foreground/30"
              : selectedCount > 0
                ? "bg-foreground text-background"
                : "text-muted-foreground/60 hover:bg-muted hover:text-foreground",
          )}
        >
          <ListFilter className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[16rem]">
        <DropdownMenuLabel className="flex items-center justify-between text-[11px] uppercase tracking-wide text-muted-foreground">
          <span>{selectedCount > 0 ? `Hosts — ${selectedCount} selected` : "Hosts"}</span>
          {selectedCount > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="text-[11px] normal-case text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Clear
            </button>
          )}
        </DropdownMenuLabel>
        {entries.map(([label, count]) => (
          <DropdownMenuCheckboxItem
            key={label}
            checked={selected.has(label)}
            onCheckedChange={() => onToggle(label)}
            onSelect={(e) => e.preventDefault()}
            className="font-mono text-[12px]"
          >
            <span className="truncate">{label}</span>
            <span className="ml-auto pl-3 font-mono text-[10px] tabular-nums text-muted-foreground/60">
              {count}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
