"use client"

import { ReactNode } from "react"
import { AnimatedSignalSphere } from "@/components/brand/AnimatedSignalSphere"

type AuthShellProps = {
  children: ReactNode
  footer?: ReactNode
}

export default function AuthShell({
  children,
  footer,
}: AuthShellProps) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(74,222,128,0.08),transparent_42%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-24 mx-auto h-96 max-w-5xl rounded-full bg-[radial-gradient(circle_at_center,rgba(74,222,128,0.12),transparent_68%)] blur-3xl" />

      <div className="relative mx-auto grid min-h-screen w-full max-w-7xl grid-cols-1 lg:grid-cols-[1.05fr_0.95fr]">
        <aside className="flex flex-col items-center justify-center px-6 py-14 text-center lg:px-10 lg:py-16">
          <div className="flex w-full max-w-2xl flex-col items-center">
            <AnimatedSignalSphere
              size={320}
              preset="orbit"
              className="drop-shadow-[0_0_56px_rgba(74,222,128,0.12)]"
            />
          </div>
        </aside>

        <main className="flex items-center justify-center px-5 py-10 sm:px-8 lg:px-10">
          <div
            className="w-full max-w-[440px] border border-white/20 bg-card px-8 py-9 shadow-2xl sm:px-9"
            style={{ backgroundColor: "oklch(0.26 0 0)" }}
          >
            {children}

            {footer ? (
              <div className="mt-6 flex items-center justify-between text-xs text-muted-foreground">
                {footer}
              </div>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  )
}
