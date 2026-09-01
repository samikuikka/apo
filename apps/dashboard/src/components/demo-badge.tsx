"use client";

/** Persistent demo badge: "Demo · read-only", always visible. */
export function DemoBadge() {
  return (
    <span
      data-testid="demo-badge"
      className="inline-flex h-5 items-center gap-1.5 border border-border bg-muted px-2 text-[11px] font-medium text-muted-foreground"
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full bg-warning"
      />
      Demo · read-only
    </span>
  );
}
