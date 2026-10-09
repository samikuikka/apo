// PROTOTYPE (round 7) — mount + floating switcher for the reactive
// onboarding. Throwaway; the bar is deliberately NOT styled like the app so
// it reads as scaffolding. /project/<id>/tasks?empty=A1|A2|A3
// &scene=real|virgin|published|done
//
// No polling: onboarding state changes a handful of times in a project's
// entire life, and it changes while the user is watching their AGENT, not
// this page. The page is correct on every arrival — fetched on mount and
// again when the tab regains focus. Live run updates belong to the Runs
// pages, which already have the SSE stream (useRunEvents).

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api-client";

import {
  FIXTURE_SIGNALS,
  VIRGIN_SIGNALS,
  VariantA1Timeline,
  VariantA2Compact,
  VariantA3Split,
  type LiveSignals,
} from "./empty-variants";
import { StoryWalkthrough } from "./story-walkthrough";

const PROTOTYPE_VARIANTS = [
  { key: "S", name: "Story — start to finish", Component: StoryWalkthrough },
  { key: "A1", name: "Copy prompt + state timeline", Component: VariantA1Timeline },
  { key: "A2", name: "Compact progress", Component: VariantA2Compact },
  { key: "A3", name: "Journey + destination", Component: VariantA3Split },
] as const;

type SceneKey = "real" | "virgin" | "published" | "done";

interface OnboardingTransport {
  published_task_count: number;
  recorded_run_count: number;
  public_url: string | null;
  has_traces?: boolean;
  has_cli_key?: boolean;
  trace_count?: number;
  latest_trace_service?: string | null;
}

/**
 * One read of every signal the checklist derives from — one request when
 * the backend carries the extended projection; a fallback fan-out only
 * against older backends that lack has_cli_key (admin-only key list, so
 * members on old backends simply see the step as pending).
 */
async function fetchSignals(projectId: string): Promise<LiveSignals & { publicUrl: string | null }> {
  const onboarding = await apiClient<OnboardingTransport>(
    `/v1/projects/${projectId}/onboarding-status`,
    { cache: "no-store" },
  );
  let cliConnected = onboarding.has_cli_key;
  if (cliConnected === undefined) {
    const keys = await apiClient<{ scope: string }[]>("/v1/api-keys", {
      cache: "no-store",
      query: { project: projectId },
    }).catch(() => [] as { scope: string }[]);
    cliConnected = keys.some((k) => k.scope === "full");
  }
  return {
    hasTraces: onboarding.has_traces ?? false,
    traceService: onboarding.latest_trace_service ?? null,
    traceTotal: onboarding.trace_count ?? 0,
    cliConnected,
    publishedTasks: onboarding.published_task_count,
    recordedRuns: onboarding.recorded_run_count,
    publicUrl: onboarding.public_url,
  };
}

export function EmptyStatePrototype({
  variantKey,
  sceneKey,
  projectId,
  density = "page",
}: {
  variantKey: string | null;
  sceneKey: string | null;
  projectId: string;
  /** "page" owns the empty page; "banner" sits above a real task list and
   *  renders nothing once the journey is complete. */
  density?: "page" | "banner";
}) {
  const router = useRouter();
  const scene: SceneKey =
    sceneKey === "virgin" || sceneKey === "published" || sceneKey === "done"
      ? sceneKey
      : "real";
  const live = scene === "real";

  const [signals, setSignals] = useState<LiveSignals>(VIRGIN_SIGNALS);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [taskNames, setTaskNames] = useState<string[]>([]);

  // Correct on arrival: read once on mount, and again whenever the tab
  // regains focus — the user comes back to this page when their agent
  // reports done, and the state must be right at that moment.
  const readSignals = useCallback(() => {
    fetchSignals(projectId)
      .then((next) => {
        setPublicUrl(next.publicUrl);
        setSignals({
          hasTraces: next.hasTraces,
          traceService: next.traceService,
          traceTotal: next.traceTotal,
          cliConnected: next.cliConnected,
          publishedTasks: next.publishedTasks,
          recordedRuns: next.recordedRuns,
        });
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    if (!live) {
      const fixture = FIXTURE_SIGNALS[scene as keyof typeof FIXTURE_SIGNALS];
      setSignals(fixture);
      setPublicUrl("https://apo.example.com");
      return;
    }
    readSignals();
    // A page the user may leave open in a background tab while their agent
    // works: refetch on focus instead of holding any stream or timer.
    const onVisible = () => {
      if (document.visibilityState === "visible") readSignals();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [live, scene, projectId, readSignals]);

  // Real published task rows for A3's destination panel.
  useEffect(() => {
    if (!live || signals.publishedTasks === 0) return;
    const controller = new AbortController();
    apiClient<{ task_path: string }[]>(`/v1/projects/${projectId}/agent-tasks`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((rows) => setTaskNames(rows.map((r) => r.task_path)))
      .catch(() => {});
    return () => controller.abort();
  }, [live, projectId, signals.publishedTasks]);

  const entry =
    PROTOTYPE_VARIANTS.find((v) => v.key === variantKey) ?? PROTOTYPE_VARIANTS[0];
  const Variant = entry.Component;

  const replaceParam = useCallback(
    (key: string, value: string) => {
      const url = new URL(window.location.href);
      url.searchParams.set(key, value);
      router.replace(`${url.pathname}${url.search}`);
    },
    [router],
  );

  const cycle = useCallback(
    (dir: 1 | -1) => {
      const index = PROTOTYPE_VARIANTS.findIndex((v) => v.key === entry.key);
      const next =
        PROTOTYPE_VARIANTS[(index + dir + PROTOTYPE_VARIANTS.length) % PROTOTYPE_VARIANTS.length];
      replaceParam("empty", next.key);
    },
    [entry.key, replaceParam],
  );

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
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycle]);

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div className="flex flex-col">
      <Variant
        projectId={projectId}
        publicUrl={publicUrl}
        signals={signals}
        density={density}
        publishedTaskNames={taskNames}
      />

      <div className="fixed right-3 bottom-10 z-50 space-y-2 border border-border bg-card px-3 py-2 shadow-lg">
        <div className="flex items-center gap-3">
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
            {" — "}
            {entry.name}
            <span className="ml-2 text-[10px] text-muted-foreground/60">←/→ to flip</span>
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
        <div className="flex justify-center gap-1 border-t border-border/60 pt-2">
          {(["real", "virgin", "published", "done"] as const).map((key) => (
            <Button
              key={key}
              type="button"
              variant={scene === key ? "default" : "ghost"}
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => replaceParam("scene", key)}
            >
              {key}
              {key === "real" ? "" : "*"}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
