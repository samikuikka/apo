"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { type EffortFacetOption, type RunLabelFacets } from "@/lib/agent-task-api";
import {
  parseSearchTokens,
  suggestTokens,
  type SearchSuggestion,
  type SearchToken,
} from "@/lib/search-tokens";
import { FilterBar } from "@/components/filter-bar";
import { BATCH_RUN_STATUS_FILTERS } from "@/lib/filter-status";

import { type ModelOption } from "../runs-model-filter";

interface RunsToolbarProps {
  /** Current `?q` value — the search box follows it (see sync note below). */
  urlQ: string;
  selectedStatuses: Set<string>;
  onStatusChange: (next: Set<string>) => void;
  urlSince: string | null;
  selectedModels: Set<string>;
  selectedEfforts: Set<string>;
  modelOptions: ModelOption[];
  effortOptions: EffortFacetOption[];
  /** The scope rail's toggle (Filters button and chips), inside the filter row. */
  scopeSlot?: ReactNode;
  /** Same-request serving filters (Host/Route/Tier), inside the filter row. */
  servingSlot?: ReactNode;
  totalCount: number;
  /** Any filter dimension in play — typed here or carried in from Tasks. */
  hasActiveFilters: boolean;
  updateUrl: (updates: Record<string, string | string[] | null>) => void;
  onClearFilters: () => void;
  /** Retire a model from the palette, or bring it back. */
  onSetArchived: (model: string, archived: boolean) => void;
  /** Label facets, for search-box token recognition and autocomplete. */
  labelFacets: RunLabelFacets | null;
  /** Called when the search text contained structured filter tokens. */
  onTokensParsed: (tokens: SearchToken[], text: string) => void;
}

/**
 * Runs page header: breadcrumb plus the shared filter bar. Filter state lives
 * in the URL and is owned by the parent; only the debounced search input is
 * local to this component.
 */
export function RunsToolbar({
  urlQ,
  selectedStatuses,
  onStatusChange,
  urlSince,
  selectedModels,
  selectedEfforts,
  modelOptions,
  effortOptions,
  totalCount,
  hasActiveFilters,
  updateUrl,
  onClearFilters,
  onSetArchived,
  scopeSlot,
  servingSlot,
  labelFacets,
  onTokensParsed,
}: RunsToolbarProps) {
  const [searchInput, setSearchInput] = useState(urlQ);
  // Follow ?q changes that did not come from our own typing (initial load,
  // back/forward) by adjusting during render with a prev-value comparison —
  // no effect-time syncing, so no frame ever shows a stale query.
  const [prevUrlQ, setPrevUrlQ] = useState(urlQ);
  if (urlQ !== prevUrlQ) {
    setPrevUrlQ(urlQ);
    setSearchInput(urlQ);
  }
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value);
      setSuggestions(suggestTokens(value, labelFacets));
      setShowSuggestions(suggestions.length > 0);
      clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => {
        const parsed = parseSearchTokens(value, labelFacets);
        if (parsed.tokens.length > 0) {
          // Tokens become filters; only the remaining text stays as ?q=.
          onTokensParsed(parsed.tokens, parsed.text);
          setSearchInput(parsed.text);
        } else {
          updateUrl({ q: value || null, page: null });
        }
      }, 350);
    },
    [updateUrl, labelFacets, onTokensParsed],
  );
  const applySuggestion = useCallback(
    (suggestion: SearchSuggestion) => {
      const words = searchInput.split(/\s+/).filter(Boolean);
      words.pop(); // replace the partial word with the completed token
      const completed = [...words, suggestion.insert].join(" ");
      setShowSuggestions(false);
      handleSearchChange(completed);
    },
    [searchInput, handleSearchChange],
  );

  const selectedEffort = selectedEfforts.size === 1 ? Array.from(selectedEfforts)[0] ?? null : null;

  return (
    <div className="shrink-0 border-b border-border bg-background">
      <div className="flex flex-col gap-3 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <span>Agent Testing</span>
          <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
          <span className="text-foreground">Runs</span>
        </div>
      </div>

      <div className="border-t border-border px-6 py-2.5">
        <FilterBar
          statusOptions={BATCH_RUN_STATUS_FILTERS}
          status={selectedStatuses}
          onStatusChange={onStatusChange}
          modelOptions={modelOptions}
          selectedModels={selectedModels}
          onSelectModel={(model) => updateUrl({ model, effort: null, page: null })}
          onSetArchived={onSetArchived}
          effortOptions={effortOptions.map((e) => ({
            value: e.effort,
            label: e.count > 0 ? `${e.effort} (${e.count})` : e.effort,
          }))}
          effort={selectedEffort}
          onEffortChange={(effort) => updateUrl({ effort, page: null })}
          filterSlot={
            <>
              {scopeSlot}
              {servingSlot}
            </>
          }
          since={urlSince}
          onSinceChange={(since) => updateUrl({ since, page: null })}
          query={searchInput}
          onQueryChange={handleSearchChange}
          searchPlaceholder="Search or type a filter: customer:acme, cost>0.50, env:prod..."
          searchTestId="runs-search-input"
          searchSuggestions={showSuggestions ? suggestions : undefined}
          onSuggestionClick={(insert) => applySuggestion({ insert, label: insert })}
          onClearAll={onClearFilters}
          trailing={
            <>
              {/* Filters can arrive with the navigation (a cohort carried over from
                  Tasks), so the way back to the full list has to be one click. */}
              {hasActiveFilters && (
                <button
                  type="button"
                  data-testid="runs-clear-filters"
                  onClick={onClearFilters}
                  className="underline-offset-2 hover:text-foreground/70 hover:underline"
                >
                  Clear Filters
                </button>
              )}
              <span>
                <span className="font-medium text-foreground">{totalCount}</span> runs
              </span>
            </>
          }
        />
      </div>
    </div>
  );
}
