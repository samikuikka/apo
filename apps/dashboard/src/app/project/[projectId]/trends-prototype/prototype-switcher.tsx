// PROTOTYPE · floating variant switcher for the run-trends prototype.
// Throwaway; deliberately NOT styled like the app so it reads as scaffolding.

"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PROTOTYPE_VARIANTS } from "./trends-data";

export default function PrototypeSwitcher({
  current,
  dataMode,
}: {
  current: string;
  dataMode: "real" | "demo";
}) {
  const router = useRouter();

  const cycle = useCallback(
    (dir: 1 | -1) => {
      const index = PROTOTYPE_VARIANTS.findIndex((v) => v.key === current);
      const next =
        PROTOTYPE_VARIANTS[
          (index + dir + PROTOTYPE_VARIANTS.length) % PROTOTYPE_VARIANTS.length
        ];
      const url = new URL(window.location.href);
      // Namespaced param: the monitors prototype owns ?monitor=.
      url.searchParams.set("trend", next.key);
      router.replace(`${url.pathname}${url.search}`);
    },
    [current, router],
  );

  const flipData = useCallback(() => {
    const url = new URL(window.location.href);
    if (dataMode === "demo") url.searchParams.delete("data");
    else url.searchParams.set("data", "demo");
    router.replace(`${url.pathname}${url.search}`);
  }, [dataMode, router]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "ArrowLeft") cycle(-1);
      else if (event.key === "ArrowRight") cycle(1);
      else return;
      // Other prototype switchers also listen for arrows · claim them on
      // this page so only one switcher flips.
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycle]);

  if (process.env.NODE_ENV === "production") return null;

  const entry =
    PROTOTYPE_VARIANTS.find((v) => v.key === current) ?? PROTOTYPE_VARIANTS[0];

  return (
    <div className="fixed right-3 bottom-10 z-50 flex items-center gap-3 border border-border bg-card px-3 py-2 shadow-lg">
      <Button
        type="button"
        variant="ghost"
        className="h-7 px-2 text-xs text-muted-foreground"
        aria-label={`Switch to ${dataMode === "demo" ? "real" : "demo"} data`}
        onClick={flipData}
      >
        Data: {dataMode === "demo" ? "Demo" : "Real"}
      </Button>
      <div className="h-5 w-px bg-border" aria-hidden />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Previous variant"
        onClick={() => cycle(-1)}
      >
        <ChevronLeft className="size-4" aria-hidden />
      </Button>
      <p className="min-w-44 text-center text-xs text-muted-foreground">
        <span className="font-mono text-foreground">{entry.key}</span>
        {" · "}
        {entry.name}
        <span className="ml-2 text-[10px] text-muted-foreground/60">
          ←/→ to flip
        </span>
      </p>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Next variant"
        onClick={() => cycle(1)}
      >
        <ChevronRight className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
