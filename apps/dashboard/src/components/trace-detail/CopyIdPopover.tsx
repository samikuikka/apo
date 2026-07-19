"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Check, Clipboard } from "lucide-react";

interface IdEntry {
  label: string;
  value: string;
}

interface CopyIdPopoverProps {
  ids: IdEntry[];
  children: React.ReactNode;
}

function truncateId(id: string, maxLen = 16) {
  return id.length > maxLen ? `${id.slice(0, maxLen)}...` : id;
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

export function CopyIdPopover({ ids, children }: CopyIdPopoverProps) {
  const [open, setOpen] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  useEffect(() => {
    return () => {
      for (const t of timersRef.current.values()) clearTimeout(t);
    };
  }, []);

  const handleCopy = useCallback((value: string, index: number) => {
    copyToClipboard(value);
    setCopiedIndex(index);
    const existing = timersRef.current.get(index);
    if (existing) clearTimeout(existing);
    timersRef.current.set(index, setTimeout(() => setCopiedIndex(null), 2000));
  }, []);

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex cursor-pointer items-center gap-1"
        aria-expanded={open}
        aria-haspopup="true"
      >
        {children}
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-1 min-w-[280px] rounded-md border border-border bg-popover p-1 shadow-md"
          role="menu"
        >
          {ids.map((entry, i) => (
            <div
              key={entry.label}
              className="flex items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-xs hover:bg-muted/50"
              role="menuitem"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[10px] text-muted-foreground">{entry.label}</div>
                <div className="truncate font-mono text-foreground" title={entry.value}>
                  {truncateId(entry.value)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleCopy(entry.value, i)}
                className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`Copy ${entry.label}`}
              >
                {copiedIndex === i ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Clipboard className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
