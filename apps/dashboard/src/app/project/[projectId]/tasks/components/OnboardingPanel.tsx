"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildCliLoginCommand, EXAMPLE_URL, HOSTED_DOCS_URL } from "@/lib/first-run";
import { CopyCommand } from "./CopyCommand";
import {
  buildAgentHandoffPrompt,
  buildOnboardingSteps,
  type OnboardingSignals,
  type OnboardingStep,
} from "./onboarding-steps";

/**
 * The agent-first first-run surface for a Project with no recorded runs
 * yet. One primary action — copy the handoff prompt for the user's coding
 * agent (the docs' copy-prompt pattern, but project-aware) — above a
 * checklist derived entirely from real backend signals. The user watches
 * their agent work in the terminal and returns here; the panel re-reads
 * state on tab focus (router.refresh refetches the server projection —
 * no polling, no stream) and disappears for good once a run is recorded.
 */
export function OnboardingPanel({ signals }: { signals: OnboardingSignals }) {
  const router = useRouter();
  const steps = buildOnboardingSteps(signals);
  const prompt = signals.publicUrl ? buildAgentHandoffPrompt(signals) : null;

  // Correct on arrival: the user pastes the prompt, watches the agent in
  // the terminal, and comes back — refetch exactly then, never on a timer.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [router]);

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <header className="space-y-2">
        <h1 className="text-[18px] font-semibold tracking-tight">
          Get to your first verdict
        </h1>
        <p className="text-[13px] text-muted-foreground">
          Let your coding agent do the setup — come back when it&apos;s done.
        </p>
      </header>

      <section className="mt-6 border border-border bg-card p-4">
        {prompt ? (
          <CopyPromptButton text={prompt} />
        ) : (
          <p className="text-xs text-muted-foreground">
            This installation has no public URL configured, so we can&apos;t
            build an exact handoff — follow the{" "}
            <a
              href={HOSTED_DOCS_SETUP_URL}
              className="text-foreground underline underline-offset-2"
            >
              setup guide
            </a>{" "}
            instead.
          </p>
        )}
      </section>

      <ol className="mt-8 space-y-0">
        {steps.map((step) => (
          <li key={step.key} className="relative flex gap-3 pb-8 last:pb-0">
            {step.state !== "done" && (
              <span
                className="absolute top-5 left-2.5 h-full w-px bg-border"
                aria-hidden
              />
            )}
            <StepGlyph state={step.state} />
            <div className="min-w-0 flex-1 space-y-2">
              <h2
                className={`text-sm font-semibold ${
                  step.state === "pending" ? "text-muted-foreground/70" : ""
                }`}
              >
                {step.title}
              </h2>
              {step.state === "done" && step.doneDetail ? (
                <p className="font-mono text-xs text-muted-foreground">
                  {step.doneDetail}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{step.hint}</p>
              )}
            </div>
          </li>
        ))}
      </ol>

      {steps.some((s) => s.state !== "done") && (
        <details className="mt-2 border-t border-border/60 pt-3">
          <summary className="cursor-pointer select-none text-xs text-muted-foreground">
            Prefer doing it yourself?
          </summary>
          <div className="mt-3 space-y-5">
            {steps
              .filter((s) => s.key !== "traces" && s.state !== "done")
              .map((step) => (
                <div key={step.key} className="space-y-2">
                  <p className="text-xs font-medium text-foreground">{step.title}</p>
                  <StepCommands step={step} signals={signals} />
                </div>
              ))}
          </div>
        </details>
      )}
    </div>
  );
}

function StepGlyph({ state }: { state: OnboardingStep["state"] }) {
  return (
    <span
      className={`flex size-5 shrink-0 items-center justify-center border transition-colors duration-300 ${
        state === "done"
          ? "border-success/50 bg-success/10"
          : state === "active"
            ? "border-foreground"
            : "border-dashed border-border"
      }`}
    >
      {state === "done" ? (
        <Check className="size-3.5 text-success" aria-hidden />
      ) : state === "active" ? (
        <span className="size-1.5 rounded-full bg-foreground" />
      ) : null}
    </span>
  );
}

const HOSTED_DOCS_SETUP_URL = new URL("/quickstart/", HOSTED_DOCS_URL).href;

function StepCommands({
  step,
  signals,
}: {
  step: OnboardingStep;
  signals: OnboardingSignals;
}) {
  if (step.key === "cli") {
    return (
      <div className="space-y-2">
        <CopyCommand command="npm install -g @apo-ai/cli" label="Install CLI" />
        {/* A misconfigured installation has no honest login command to
            show — never interpolate an empty origin into one. */}
        {signals.publicUrl && (
          <>
            <div className="h-1" />
            <CopyCommand
              command={buildCliLoginCommand(signals.publicUrl, signals.projectId)}
              label="Login"
            />
          </>
        )}
      </div>
    );
  }
  if (step.key === "publish") {
    return (
      <div className="space-y-2">
        <CopyCommand command="apo task publish --dir <task-root>" label="Publish" />
        <p className="text-xs text-muted-foreground">
          No suite of your own yet?{" "}
          <a
            href={EXAMPLE_URL}
            className="text-foreground underline underline-offset-2"
          >
            Use the maintained example
          </a>{" "}
          or{" "}
          <a href="/project/demo/tasks" className="text-foreground underline underline-offset-2">
            browse the demo project
          </a>
          .
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <CopyCommand command="apo task run <task-id> --dir <task-root>" label="Run" />
      <p className="text-xs text-muted-foreground">
        PASS and FAIL are both useful outcomes — both record evidence.
      </p>
    </div>
  );
}

/**
 * The docs hero's copy-prompt interaction: a compact button; the prompt
 * shows only as a hover/focus tooltip below it (the text is agent-speak —
 * humans get the collapsed manual commands instead); clicking copies and
 * morphs to the confirmation.
 */
function CopyPromptButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = () => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      setFailed(true);
      return;
    }
    clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setFailed(false);
        setTimeout(() => setCopied(false), 3000);
      })
      .catch(() => setFailed(true));
  };

  return (
    <span className="group relative inline-block">
      <Button type="button" onClick={copy}>
        {copied
          ? "Copied — Paste Into Your Coding Agent"
          : "Copy Prompt For Your Agent"}
      </Button>
      <span
        className="pointer-events-none absolute top-full left-0 z-20 mt-2 hidden w-max max-w-lg border border-border bg-popover p-3 text-left shadow-lg group-focus-within:block group-hover:block"
        role="tooltip"
      >
        <p className="mb-1.5 text-[10px] text-muted-foreground">
          The prompt your agent receives:
        </p>
        <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/90">
          {text}
        </pre>
      </span>
      {failed && (
        <p className="mt-1 text-xs text-muted-foreground">
          Copy failed — select the prompt from the preview and copy it
          manually.
        </p>
      )}
    </span>
  );
}
