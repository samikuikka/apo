"use client";

import { useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";

interface ThinkingBlockProps {
  thinking: string;
}

export function ThinkingBlock({ thinking }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(thinking.length < 10000);
  const preview = thinking.slice(0, 100);

  return (
    <div className="mt-2 border border-violet-500/20 bg-violet-500/5">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-label="Toggle thinking content"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-violet-500/70" />
        ) : (
          <ChevronRight className="h-3 w-3 text-violet-500/70" />
        )}
        <Brain className="h-3.5 w-3.5 text-violet-500/70" />
        {/* Thinking-block tint: violet has no design token; hue is load-bearing
            for "model reasoning" so raw values kept (dark value as base). */}
        <span className="text-[11px] font-medium text-violet-400">
          Thinking
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-violet-500/20 px-3 py-2">
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-[11px] font-mono leading-relaxed text-violet-300">
            {thinking}
          </pre>
        </div>
      ) : (
        <div className="px-3 pb-1.5 pt-0.5">
          <p className="text-[11px] text-violet-400/70">
            {preview}
            {thinking.length > 100 ? "..." : ""}
          </p>
        </div>
      )}
    </div>
  );
}
