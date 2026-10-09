// PROTOTYPE — story walkthrough of the whole onboarding, start → finish.
// The real A1 components driven by scripted signals; a simulated agent
// terminal shows what happens off-page. Click through or press play.
// Throwaway; delete with the rest of empty-state-prototype/.

"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  VIRGIN_SIGNALS,
  VariantA1Timeline,
  type LiveSignals,
} from "./empty-variants";

interface Beat {
  caption: string;
  actor: "YOU" | "AGENT" | "PAGE";
  signals: LiveSignals;
}

const FIXTURE_PROJECT = "acme-eval";
const STORY_URL = "https://apo.example.com";

const mk = (over: Partial<LiveSignals>): LiveSignals => ({ ...VIRGIN_SIGNALS, ...over });
const CLI = mk({ cliConnected: true });
const PUBLISHED = mk({ cliConnected: true, publishedTasks: 1 });
const DONE = mk({ cliConnected: true, publishedTasks: 1, recordedRuns: 1 });

function makeBeats(): Beat[] {
  return [
    {
      caption:
        "A brand-new project. The Tasks page has exactly one job — hand the work to your coding agent.",
      actor: "PAGE",
      signals: VIRGIN_SIGNALS,
    },
    {
      caption: "You click Copy Prompt and paste one message into the agent. That's the whole human part.",
      actor: "YOU",
      signals: VIRGIN_SIGNALS,
    },
    {
      caption: "The agent connects the CLI. You type your password once — that's it.",
      actor: "AGENT",
      signals: CLI,
    },
    {
      caption:
        "The agent writes a small task suite for real work your repo already does, and publishes it. The page notices: the list takes over, the guide shrinks to a banner.",
      actor: "AGENT",
      signals: PUBLISHED,
    },
    {
      caption:
        "The agent runs the task — your real agent, on your machine, with your model keys. First verdict lands, the guide retires itself, and the page is yours.",
      actor: "AGENT",
      signals: DONE,
    },
  ];
}

/** The page side of the story: ONE stable surface. The checklist keeps its
 *  shape from first beat to last — glyphs flip green in place (CSS color
 *  transition, no remount), the task list fades in beneath it after
 *  publish, the success moment appears inside the final step. */
function StoryPage({ signals }: { signals: LiveSignals }) {
  const [barWidth, setBarWidth] = useState(0);
  const journeyDone = signals.recordedRuns > 0;
  const showList = signals.publishedTasks > 0;

  useEffect(() => {
    setBarWidth(0);
    if (!journeyDone) return;
    const t = setTimeout(() => setBarWidth(100), 350);
    return () => clearTimeout(t);
  }, [journeyDone]);

  return (
    <div className="bg-background pb-8">
      <VariantA1Timeline
        projectId={FIXTURE_PROJECT}
        publicUrl={STORY_URL}
        signals={signals}
        density="page"
        publishedTaskNames={[]}
      />
      {showList && (
        <div key="list" className="story-in px-6 pt-2">
          <div className="mx-auto max-w-2xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
              <p className="font-mono text-xs text-foreground/80">hello-capability</p>
              <div className="flex items-center gap-2">
                <div className="h-1 w-12 bg-border">
                  <div
                    className="story-bar h-full bg-success"
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
                <span className="w-9 text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                  {journeyDone ? `${barWidth}%` : "—"}
                </span>
              </div>
            </div>
            <p className="px-4 py-2.5 text-xs text-muted-foreground">
              Deliver a greeting that proves the harness executed.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export function StoryWalkthrough(_props: {
  projectId: string;
  publicUrl: string | null;
  signals: LiveSignals;
  density?: "page" | "banner";
  publishedTaskNames: string[];
}) {
  const beats = useMemo(() => makeBeats(), []);
  const [beat, setBeat] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    if (beat >= beats.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setBeat((b) => b + 1), 4200);
    return () => clearTimeout(t);
  }, [playing, beat, beats.length]);

  const current = beats[beat];

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          @keyframes story-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
          @keyframes story-pop { 0% { transform: scale(0.4); opacity: 0; } 60% { transform: scale(1.15); } 100% { transform: scale(1); opacity: 1; } }
          .story-in { animation: story-in 0.25s ease-out both; }
          .story-pop { animation: story-pop 0.5s cubic-bezier(0.2, 0.8, 0.3, 1.2) both; }
          .story-bar { transition: width 0.7s cubic-bezier(0.2, 0.8, 0.2, 1); }
        }
      `}</style>

      <header className="space-y-3">
        <h1 className="text-[18px] font-semibold tracking-tight">
          The whole onboarding, start → finish
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
            {playing ? "Pause" : "Play"}
          </Button>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Previous beat"
              disabled={beat === 0}
              onClick={() => { setPlaying(false); setBeat((b) => Math.max(0, b - 1)); }}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Next beat"
              disabled={beat === beats.length - 1}
              onClick={() => { setPlaying(false); setBeat((b) => Math.min(beats.length - 1, b + 1)); }}
            >
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </div>
          <div className="flex items-center gap-1" role="tablist" aria-label="Story beats">
            {beats.map((b, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === beat}
                aria-label={`Beat ${i + 1}: ${b.caption.slice(0, 40)}…`}
                onClick={() => { setPlaying(false); setBeat(i); }}
                className={`size-2.5 border ${
                  i === beat
                    ? "border-foreground bg-foreground"
                    : i < beat
                      ? "border-success/60 bg-success/30"
                      : "border-border"
                }`}
              />
            ))}
          </div>
        </div>
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <span
            className={`border px-1.5 py-0.5 text-[10px] tracking-wide ${
              current.actor === "YOU"
                ? "border-warning/60 text-warning"
                : current.actor === "AGENT"
                  ? "border-border text-foreground"
                  : "border-border text-muted-foreground"
            }`}
          >
            {current.actor}
          </span>
          {current.caption}
        </p>
      </header>

      <div className="mt-6 border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="size-2 rounded-full border border-border" aria-hidden />
          <span className="size-2 rounded-full border border-border" aria-hidden />
          <p className="ml-2 truncate font-mono text-[10px] text-muted-foreground">
            apo.example.com/project/{FIXTURE_PROJECT}/tasks
          </p>
        </div>
        <StoryPage signals={current.signals} />
      </div>
    </div>
  );
}
