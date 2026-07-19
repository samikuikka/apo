"use client";

import { AnimatedSignalSphere } from "@/components/brand/AnimatedSignalSphere";
import { DemoWorkspaceChoice } from "@/components/demo-workspace-choice";

export function DashboardEmptyState() {
  return (
    <main className="min-h-screen bg-background px-6 py-10">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-5xl flex-col items-center justify-center gap-10">
        <div className="relative flex flex-col items-center gap-5 text-center">
          <div className="pointer-events-none absolute inset-x-0 top-1/2 -z-10 h-64 -translate-y-1/2 rounded-full bg-[radial-gradient(circle_at_center,rgba(74,222,128,0.18),transparent_68%)] blur-3xl" />
          <AnimatedSignalSphere
            size={280}
            preset="sequence"
            className="drop-shadow-[0_0_42px_rgba(74,222,128,0.12)]"
          />
        </div>

        <div className="w-full max-w-[520px]">
          <DemoWorkspaceChoice />
        </div>
      </div>
    </main>
  );
}
