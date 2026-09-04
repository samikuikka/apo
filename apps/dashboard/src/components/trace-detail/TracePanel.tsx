"use client";

import { useEffect, useRef, useCallback, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useSelection } from "./contexts/SelectionContext";
import type { TraceDetail } from "./contexts";
import { getTraceDetail } from "@/lib/traces-api";
import { Card, CardContent } from "@/components/ui/card";
import { TraceWorkspace } from "./TraceWorkspace";
import TraceSkeleton from "./TraceSkeleton";

export function TracePanel() {
  const { selectedRunId, projectId, clearSelection } = useSelection();
  const [run, setRun] = useState<TraceDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(1100);
  const abortRef = useRef<AbortController | null>(null);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const panelElementRef = useRef<HTMLDivElement | null>(null);

  const clampPanelWidth = useCallback((width: number) => {
    if (typeof window === "undefined") {
      return Math.min(1600, Math.max(520, width));
    }

    const viewportWidth = window.innerWidth;
    const minWidth = viewportWidth < 768 ? viewportWidth : 520;
    const maxWidth = viewportWidth < 768
      ? viewportWidth
      : Math.min(1600, Math.max(700, viewportWidth - 240));
    return Math.min(maxWidth, Math.max(minWidth, width));
  }, []);

  const fetchRun = useCallback(async (runId: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);
    document.body.style.overflow = "hidden";

    try {
      // Slim fetch: the panel renders call metadata first — the selected
      // call's payload loads on demand (see useCallPayload).
      const data = await getTraceDetail(runId, projectId ?? undefined, undefined, {
        slim: true,
      });
      // A newer fetch may have aborted this controller while we awaited.
      // Guard the update (rather than early-returning) so the finally block
      // below still runs the same cleanup on every path.
      if (!controller.signal.aborted) {
        setRun(data);
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Failed to fetch trace details");
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!selectedRunId) {
      setRun(null);
      setError(null);
      document.body.style.overflow = "";
      return;
    }

    fetchRun(selectedRunId);

    return () => {
      abortRef.current?.abort();
      document.body.style.overflow = "";
    };
  }, [selectedRunId, fetchRun]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [clearSelection]);

  const refreshRun = useCallback(() => {
    if (selectedRunId) fetchRun(selectedRunId);
  }, [selectedRunId, fetchRun]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleResize = () => {
      setPanelWidth((current) => clampPanelWidth(current));
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [clampPanelWidth]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) return;
      const deltaX = dragState.startX - event.clientX;
      const nextWidth = clampPanelWidth(dragState.startWidth + deltaX);
      setPanelWidth(nextWidth);
    };

    const handlePointerUp = () => {
      dragStateRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [clampPanelWidth]);

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    dragStateRef.current = {
      startX: event.clientX,
      startWidth: panelWidth,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [panelWidth]);

  if (!selectedRunId) {
    return null;
  }

  return (
    <div
      ref={panelElementRef}
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-none flex-col border-l bg-background shadow-2xl"
      style={{ width: `${panelWidth}px`, maxWidth: "100vw" }}
    >
      <hr
        className="absolute inset-y-0 left-0 hidden w-2 -translate-x-1/2 cursor-col-resize border-0 p-0 md:block"
        onPointerDown={startResize}
        aria-label="Resize trace panel"
        aria-orientation="vertical"
      />
      {isLoading ? <TraceSkeleton /> : null}

      {error ? (
        <div className="flex flex-1 items-center justify-center">
          <Card className="border-destructive/60 bg-destructive/10">
            <CardContent className="py-10 text-center text-sm text-destructive">
              <p className="mb-2 font-medium">Error loading trace</p>
              <p>{error}</p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {run && !isLoading && !error ? (
        <div className="min-h-0 min-w-0 flex-1">
          <TraceWorkspace
            run={run}
            mode="panel"
            onClose={clearSelection}
            refreshRun={refreshRun}
            className="h-full min-w-0"
          />
        </div>
      ) : null}
    </div>
  );
}
