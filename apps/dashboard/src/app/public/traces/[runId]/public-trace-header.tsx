"use client";

import { BrandMark } from "@/components/brand/brand-mark";
import { Globe } from "lucide-react";

/**
 * Minimal top bar for the public (unauthenticated) trace view.
 *
 * The main app shell (TopNav) assumes a session and would redirect logged-out
 * viewers to /login, so the public page renders its own slim header instead.
 * Deliberately shows only the brand mark + a "Public trace" indicator — the
 * trace name itself is already shown by the workspace's detail header, so
 * repeating it here would double it up.
 */
export function PublicTraceHeader() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 bg-background px-4">
      <BrandMark size={26} />
      <span
        className="inline-flex items-center gap-1 border border-border/70 bg-muted/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        title="This trace is publicly viewable. Anyone with the link can see it."
      >
        <Globe className="h-3 w-3" />
        Public trace
      </span>
    </header>
  );
}
