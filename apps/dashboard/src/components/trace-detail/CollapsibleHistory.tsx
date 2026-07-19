"use client";

import { useState } from "react";
import type { ReactNode } from "react";

interface CollapsibleHistoryProps {
  totalMessages: number;
  visibleStart: ReactNode[];
  hiddenMiddle: ReactNode[];
  visibleEnd: ReactNode[];
}

export function CollapsibleHistory({
  totalMessages,
  visibleStart,
  hiddenMiddle,
  visibleEnd,
}: CollapsibleHistoryProps) {
  const [expanded, setExpanded] = useState(false);

  if (totalMessages <= 6) {
    return (
      <>
        {visibleStart}
        {hiddenMiddle}
        {visibleEnd}
      </>
    );
  }

  const hiddenCount = hiddenMiddle.length;

  return (
    <>
      {visibleStart}
      {!expanded && hiddenCount > 0 && (
        <div className="flex items-center justify-center py-1">
          <button
            type="button"
            className="rounded-md border border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            onClick={() => setExpanded(true)}
            aria-label={`Show ${hiddenCount} more messages`}
          >
            Show {hiddenCount} more message{hiddenCount !== 1 ? "s" : ""}...
          </button>
        </div>
      )}
      {expanded && hiddenMiddle}
      {visibleEnd}
    </>
  );
}
