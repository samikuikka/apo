"use client";

import { ChevronUp, ChevronDown, Search, List } from "lucide-react";
import { cn } from "@/lib/utils";
import { type StringMode } from "./utils";
import { CopyAllButton, StringModeButton } from "./rows";

export function Toolbar({
  label,
  searchInput,
  searchQuery,
  onSearchChange,
  onSearchKeyDown,
  matchCount,
  safeMatchIdx,
  onNavigate,
  stringMode,
  onCycleStringMode,
  showLineNumbers,
  onToggleLineNumbers,
  data,
}: {
  label?: string;
  searchInput: string;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  onSearchKeyDown: (e: React.KeyboardEvent) => void;
  matchCount: number;
  safeMatchIdx: number;
  onNavigate: (dir: "prev" | "next") => void;
  stringMode: StringMode;
  onCycleStringMode: () => void;
  showLineNumbers: boolean;
  onToggleLineNumbers: () => void;
  data: unknown;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border/70 bg-muted/40 px-3 py-1.5 gap-2">
      {label ? (
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      ) : (
        <div className="flex-1" />
      )}
      <div className="flex items-center gap-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/60" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Filter…"
            aria-label="Filter JSON content"
            className="h-6 w-28 rounded-sm border border-border/60 bg-background pl-6 pr-2 text-[11px] outline-none placeholder:text-muted-foreground/50 focus:border-ring"
          />
        </div>

        {searchQuery && (
          <MatchNavigator
            matchCount={matchCount}
            safeMatchIdx={safeMatchIdx}
            onNavigate={onNavigate}
          />
        )}

        <StringModeButton mode={stringMode} onCycle={onCycleStringMode} />

        <button
          type="button"
          onClick={onToggleLineNumbers}
          className={cn(
            "rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] transition-colors inline-flex items-center gap-1",
            showLineNumbers
              ? "text-foreground bg-muted/50"
              : "text-muted-foreground hover:text-foreground",
          )}
          aria-label="Toggle line numbers"
        >
          <List className="h-3 w-3" />
        </button>

        <CopyAllButton data={data} />
      </div>
    </div>
  );
}

function MatchNavigator({
  matchCount,
  safeMatchIdx,
  onNavigate,
}: {
  matchCount: number;
  safeMatchIdx: number;
  onNavigate: (dir: "prev" | "next") => void;
}) {
  return (
    <>
      <span className="text-[10px] text-muted-foreground min-w-[3rem] text-center">
        {matchCount > 0 ? `${safeMatchIdx + 1}/${matchCount}` : "0"}
      </span>
      <button
        type="button"
        onClick={() => onNavigate("prev")}
        disabled={matchCount === 0}
        className="inline-flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 disabled:opacity-30 transition-colors"
        aria-label="Previous match"
      >
        <ChevronUp className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={() => onNavigate("next")}
        disabled={matchCount === 0}
        className="inline-flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 disabled:opacity-30 transition-colors"
        aria-label="Next match"
      >
        <ChevronDown className="h-3 w-3" />
      </button>
    </>
  );
}
