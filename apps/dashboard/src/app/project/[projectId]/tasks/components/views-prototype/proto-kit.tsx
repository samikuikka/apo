"use client";

// PROTOTYPE (throwaway) — small shared UI pieces for the views-prototype
// variants: a filter chip, a popover menu, and the floating variant switcher.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { setSearchParamShallow } from "@/lib/shallow-search-params";

export function Chip({
  label,
  onRemove,
  tone = "default",
}: {
  label: string;
  onRemove?: () => void;
  tone?: "default" | "active";
}) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1 border px-2 text-xs",
        tone === "active" ? "border-foreground/40 bg-foreground/[0.08]" : "border-border bg-card",
      )}
    >
      <span className="text-muted-foreground">{label}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label} filter`}
          onClick={onRemove}
          className="text-muted-foreground/60 hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

/** Minimal popover menu: trigger button + absolutely positioned panel. */
export function Menu({
  button,
  children,
  align = "left",
  panelClassName = "w-64",
  buttonClassName,
  ariaLabel,
}: {
  button: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  panelClassName?: string;
  buttonClassName?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 border border-border bg-card px-2.5 text-xs text-foreground/80 hover:border-foreground/30 hover:text-foreground",
          open && "border-foreground/40 text-foreground",
          buttonClassName,
        )}
      >
        {button}
      </button>
      {open && (
        <div
          className={cn(
            "absolute top-[calc(100%+4px)] z-50 border border-border bg-popover p-1.5",
            align === "right" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuRow({
  children,
  onClick,
  active,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-foreground/80 hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground/60">
      {children}
    </div>
  );
}

export interface VariantEntry {
  key: string;
  label: string;
}

/** The floating bottom bar that flips prototype variants (←/→). */
export function ProtoSwitcher({
  variants,
  current,
  paramKey = "vproto",
}: {
  variants: VariantEntry[];
  current: string;
  paramKey?: string;
}) {
  const router = useRouter();
  const index = Math.max(
    0,
    variants.findIndex((v) => v.key === current),
  );
  const currentEntry = variants[index]!;

  const cycle = (dir: 1 | -1) => {
    const next = variants[(index + dir + variants.length) % variants.length]!;
    setSearchParamShallow(paramKey, next.key);
    router.refresh();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      )
        return;
      if (e.key === "ArrowLeft") cycle(-1);
      if (e.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cycle identity is stable per render set
  }, [index, variants]);

  return (
    <div
      className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-1 rounded-full border border-foreground/30 bg-card px-1.5 py-1 shadow-lg"
      aria-label="Prototype variant switcher"
    >
      <span className="pl-2 pr-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
        proto
      </span>
      <button
        type="button"
        aria-label="Previous variant"
        onClick={() => cycle(-1)}
        className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="min-w-[180px] px-1 text-center text-xs font-medium text-foreground">
        {currentEntry.label}
      </span>
      <button
        type="button"
        aria-label="Next variant"
        onClick={() => cycle(1)}
        className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
