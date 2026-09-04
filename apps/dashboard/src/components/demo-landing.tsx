import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { AnimatedSignalSphere } from "@/components/brand/AnimatedSignalSphere";

/**
 * Minimal landing for anonymous visitors: the normal app chrome (TopNav
 * with the brand mark and Sign in) is already global — this fills the
 * body with the animated brand sphere and one way into the demo.
 */
export function DemoLanding() {
  return (
    <main className="flex min-h-[calc(100svh-3rem)] items-center justify-center px-6">
      <div className="mx-auto flex max-w-md flex-col items-center text-center">
        <AnimatedSignalSphere size={96} />
        <h1 className="mt-6 text-[22px] font-semibold tracking-tight">
          See apo in action.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A real workspace of captured agent runs — every failure with its
          evidence, every verdict with its judge.
        </p>
        <Link
          href="/project/demo/tasks"
          data-testid="open-demo"
          className="mt-6 inline-flex h-9 items-center gap-2 bg-foreground px-4 text-[13px] font-medium text-background hover:bg-foreground/90"
        >
          Open the demo workspace
          <ArrowRight className="size-4" />
        </Link>
        <p className="mt-3 text-xs text-muted-foreground">
          No account needed. Read-only.
        </p>
      </div>
    </main>
  );
}
