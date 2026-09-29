"use client";

export function HeaderPill({
  children,
  mono = false,
  title,
}: {
  children: React.ReactNode;
  mono?: boolean;
  /** Native tooltip text (e.g. what a host pill means). */
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center border border-border/70 bg-muted/10 px-1.5 py-0.5 text-xs text-muted-foreground ${mono ? "font-mono" : ""}`}
    >
      {children}
    </span>
  );
}
