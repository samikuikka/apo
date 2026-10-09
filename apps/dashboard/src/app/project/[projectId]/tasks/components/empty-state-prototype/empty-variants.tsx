// PROTOTYPE (round 2) — the reactive onboarding for the Tasks page.
// Round 1 picked "reactive checklist" (variant A); this round explores three
// implementations of it. Throwaway; no tests; delete when one wins.

"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api-client";
import { buildCliLoginCommand, EXAMPLE_URL, HOSTED_DOCS_URL } from "@/lib/first-run";
import { CopyCommand } from "../CopyCommand";
import { PassBar } from "../PassBar";

// --- the live signal model --------------------------------------------------

/** Everything the checklist derives from — all genuinely detectable. */
export interface LiveSignals {
  hasTraces: boolean;
  traceService: string | null;
  traceTotal: number;
  /** Any scope="full" API key exists (what `apo login` mints). */
  cliConnected: boolean;
  publishedTasks: number;
  recordedRuns: number;
}

export const VIRGIN_SIGNALS: LiveSignals = {
  hasTraces: false,
  traceService: null,
  traceTotal: 0,
  cliConnected: false,
  publishedTasks: 0,
  recordedRuns: 0,
};

/** Fixture points along the arc, so the whole journey is previewable. */
export const FIXTURE_SIGNALS: Record<"virgin" | "published" | "done", LiveSignals> = {
  virgin: VIRGIN_SIGNALS,
  published: {
    hasTraces: false,
    traceService: null,
    traceTotal: 0,
    cliConnected: true,
    publishedTasks: 6,
    recordedRuns: 0,
  },
  done: {
    hasTraces: false,
    traceService: null,
    traceTotal: 0,
    cliConnected: true,
    publishedTasks: 6,
    recordedRuns: 1,
  },
};

export type StepState = "done" | "active" | "pending";

export interface JourneyStep {
  key: string;
  title: string;
  state: StepState;
  /** Mono fact shown on a completed step (real numbers). */
  doneDetail: string | null;
  /** One-line hint shown while pending (never the full instructions). */
  pendingHint: string;
}

/** The respan-inspired shape: tight core loop + conditional pre-step. */
export function buildJourney(
  signals: LiveSignals,
  scene: { projectId: string; publicUrl: string | null },
): JourneyStep[] {
  void scene; // commands are built by StepHow from the variant props
  const steps: JourneyStep[] = [];
  if (signals.hasTraces) {
    steps.push({
      key: "traces",
      title: "Signal Is Flowing",
      state: "done",
      doneDetail:
        signals.traceService
          ? `${signals.traceService} · ${signals.traceTotal} traces`
          : `${signals.traceTotal} traces`,
      pendingHint: "",
    });
  }
  const core: JourneyStep[] = [
    {
      key: "cli",
      title: "Connect The CLI",
      state: signals.cliConnected ? "done" : "pending",
      doneDetail: "project key minted",
      pendingHint: "One install + one login; the key never leaves your machine.",
    },
    {
      key: "publish",
      title: "Publish A Task Suite",
      state: signals.publishedTasks > 0 ? "done" : "pending",
      doneDetail: `${signals.publishedTasks} tasks published`,
      pendingHint: "Turn “what my agent must do” into checks — metadata only.",
    },
    {
      key: "run",
      title: "Record A Run",
      state: signals.recordedRuns > 0 ? "done" : "pending",
      doneDetail: `${signals.recordedRuns} runs recorded`,
      pendingHint: "The agent runs locally; apo records verdict, checks, traces.",
    },
    {
      key: "verdict",
      title: "Open The Verdict",
      state: signals.recordedRuns > 0 ? "done" : "pending",
      doneDetail: null,
      pendingHint: "PASS or FAIL, the evidence is inspectable on the Runs page.",
    },
  ];
  // Exactly one active step: the first incomplete one.
  const firstPending = core.find((s) => s.state === "pending");
  if (firstPending) firstPending.state = "active";
  return [...steps, ...core];
}

export const AGENT_PROMPT =
  "Set up apo capability testing in this repository: install the @apo-ai/cli, run `apo login` against my project (ask me for credentials when you need them), review the docs, define one small task suite (task + tests) for the agent work this repo already does, then publish it with `apo task publish` and record one run with `apo task run`.";

/** The self-contained version: a 24h key means the agent never needs
 *  the user's password — install → define → publish → run → report. */
export function buildKeyedAgentPrompt(
  backendUrl: string,
  projectId: string,
  secretKey: string,
  expiresIso: string,
): string {
  const expiry = expiresIso.slice(0, 16).replace("T", " ");
  return `Set up apo capability testing in this repository, end to end.

Auth is pre-provisioned — run every apo command with these exports:
  export APO_BACKEND_URL=${backendUrl}
  export APO_API_KEY=${secretKey}   # expires ${expiry} UTC

1. Install the CLI: npm install -g @apo-ai/cli
2. Read the task spec docs: ${HOSTED_DOCS_URL}
3. Define ONE small task suite for real agent work this repo already
   does. A task is code you own: the work, plus checks that prove it.
4. Publish it: apo task publish --dir <task-root>
5. Record one run: apo task run <task-id> --dir <task-root>. Use the
   repo's existing model-provider env vars — PASS or FAIL both count.
6. Report back: the task id, the verdict, and anything ambiguous you
   had to decide.`;
}

/**
 * respan steal, apo-sized: agent-first onboarding. The dashboard cannot
 * install anything on the user's machine — but their coding agent can, and
 * for this audience it usually should. Mints a real 24h scope="full" key via
 * POST /v1/api-keys (exists today) and embeds it in a copyable prompt; the
 * CLI already authenticates from APO_API_KEY, so the prompt is self-contained.
 */
export function AgentSetupRow({
  projectId,
  publicUrl,
}: {
  projectId: string;
  publicUrl: string | null;
}) {
  const [phase, setPhase] = useState<"idle" | "minting" | "ready">("idle");
  const [secret, setSecret] = useState<string | null>(null);
  const [expires, setExpires] = useState<string | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const mint = async () => {
    setPhase("minting");
    setMintError(null);
    try {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const res = await apiClient<{ secret_key: string | null; key: string | null }>(
        "/v1/api-keys",
        {
          method: "POST",
          body: {
            name: "agent-setup",
            project: projectId,
            scope: "full",
            expires_at: expiresAt,
          },
        },
      );
      const value = res.secret_key ?? res.key;
      if (!value) throw new Error("The backend returned no secret for this key.");
      setSecret(value);
      setExpires(expiresAt);
      setPhase("ready");
    } catch (e: unknown) {
      setMintError(e instanceof Error ? e.message : "Key generation failed.");
      setPhase("idle");
    }
  };

  const prompt =
    secret && publicUrl
      ? buildKeyedAgentPrompt(publicUrl, projectId, secret, expires ?? "")
      : AGENT_PROMPT;

  const copyPrompt = () => {
    if (!navigator.clipboard?.writeText) return;
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <details className="border-t border-border/60 pt-3">
      <summary className="cursor-pointer select-none text-xs text-muted-foreground">
        Rather hand the whole setup to your coding agent?
      </summary>
      <div className="mt-3 space-y-3 text-xs text-muted-foreground">
        <p className="text-[13px]">
          One prompt covers every step — install, define your first suite,
          publish, record a run. Generate a 24-hour key so the agent
          authenticates without your password.
        </p>
        {phase !== "ready" &&
          (publicUrl ? (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void mint()}
                disabled={phase === "minting"}
              >
                {phase === "minting" ? "Generating…" : "Generate Setup Key"}
              </Button>
              {mintError && <p className="mt-2 text-destructive">{mintError}</p>}
            </div>
          ) : (
            <p className="text-muted-foreground/60">
              This installation has no public URL — use the keyless prompt
              below; the agent will ask you to run{" "}
              <code className="font-mono">apo login</code> once.
            </p>
          ))}
        {phase === "ready" && (
          <p className="text-success">
            Key minted — expires {expires?.slice(0, 16).replace("T", " ")} UTC.
            Revoke anytime from Project Settings → API Keys.
          </p>
        )}
        <div className="relative border border-border bg-muted/40">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="absolute top-2 right-2 h-auto px-2 py-1 text-[10px]"
            onClick={copyPrompt}
            aria-label={copied ? "Agent prompt copied" : "Copy agent prompt"}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          <pre className="overflow-x-auto px-3 py-2.5 pr-20 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/90">
            {prompt}
          </pre>
        </div>
        {!secret && (
          <p className="text-muted-foreground/60">
            Keyless version — paste it anyway; the agent will ask you to run{" "}
            <code className="font-mono">apo login</code> when it needs auth.
          </p>
        )}
      </div>
    </details>
  );
}

// --- shared fragments -------------------------------------------------------

function Glyph({ state }: { state: StepState }) {
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

/** The commands + links for whichever step is active (progressive disclosure:
 *  pending steps never show their how — only the active one does). */
function StepHow({ stepKey, projectId, publicUrl }: { stepKey: string; projectId: string; publicUrl: string | null }) {
  const login = publicUrl
    ? buildCliLoginCommand(publicUrl, projectId)
    : "apo login --backend <your-apo-url> --project <project-id>";
  if (stepKey === "cli") {
    return (
      <div className="space-y-2">
        <CopyCommand command="npm install -g @apo-ai/cli" label="Install CLI" />
        <div className="h-1" />
        <CopyCommand command={login} label="Login" />
        <p className="text-xs text-muted-foreground">
          Creates a Project-scoped key on your machine — it is never shown in
          the browser.
        </p>
      </div>
    );
  }
  if (stepKey === "publish") {
    return (
      <div className="space-y-2">
        <CopyCommand command="apo task publish --dir <task-root>" label="Publish" />
        <p className="text-xs text-muted-foreground">
          No suite of your own yet?{" "}
          <a href={EXAMPLE_URL} className="text-foreground underline underline-offset-2">
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
  if (stepKey === "run") {
    return (
      <div className="space-y-2">
        <CopyCommand command="apo task run <task-id> --dir <task-root>" label="Run" />
        <p className="text-xs text-muted-foreground">
          PASS and FAIL are both useful outcomes — both record evidence.
        </p>
      </div>
    );
  }
  if (stepKey === "verdict") {
    return (
      <Button type="button" asChild>
        <a href="../runs">Open The Runs Page</a>
      </Button>
    );
  }
  return null;
}

/** The completion moment: first run recorded. Shown by all variants. */
function SuccessMoment({ compact }: { compact?: boolean }) {
  return (
    <div className={`space-y-2 ${compact ? "" : "py-4"}`}>
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Check className="size-4 text-success" aria-hidden />
        Your first verdict is in
      </h2>
      <p className="text-xs text-muted-foreground">
        Verdict, checks, traces and deliverables are inspectable on the Runs
        page. This guide won&apos;t show again.
      </p>
      <Button type="button" asChild>
        <a href="../runs">Open The Run</a>
      </Button>
    </div>
  );
}

/** respan steal: agent-first onboarding — a copyable prompt for coding agents. */

/** The agent-readable setup skill the docs already serve — the handoff
 *  prompt points here instead of inlining the whole method. */
const START_MD_URL = new URL("/start.md", HOSTED_DOCS_URL).href;

/**
 * The docs-page pattern, project-aware: one button, one prompt, the agent
 * handles it. The prompt embeds what the docs' generic prompt can't know —
 * this user's server and project — and points at the docs' agent guide
 * (start.md) for the method. Auth in v1 is the CLI's existing interactive
 * login: the agent runs it, the human types credentials once. Later
 * refinements (NOTES.md): key-in-prompt → one-time link → browser approval.
 */
export function buildAgentPrompt(backendUrl: string, projectId: string): string {
  return `Set up apo capability testing in this repository, end to end.

My apo server: ${backendUrl}
My project:    ${projectId}
Full guide:    ${START_MD_URL} — follow it.

Auth: run \`apo login --backend ${backendUrl} --project ${projectId}\`,
then ask me for my email and password when prompted — once.

Deliverable: one published task suite + one recorded run.
Report back: the task id, the verdict, and anything ambiguous you had to decide.`;
}

/**
 * The docs hero's CopyPromptButton, in React: compact button; the prompt
 * shows only as a hover/focus preview below it (never always-visible — the
 * text is agent-speak; humans get the manual commands instead); click
 * copies and morphs to the confirmation.
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
        {copied ? "Copied — Paste Into Your Coding Agent" : "Copy Prompt For Your Agent"}
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
          Copy failed — reload the page and try again.
        </p>
      )}
    </span>
  );
}

export interface VariantProps {
  projectId: string;
  publicUrl: string | null;
  signals: LiveSignals;
  /** "banner": the journey as a strip above a real task list; renders
   *  nothing when complete. "page": the full empty-state surface. */
  density?: "page" | "banner";
  /** Real task rows for variant A3's destination panel (fetched by mount). */
  publishedTaskNames: string[];
}

const coreDone = (signals: LiveSignals) => signals.recordedRuns > 0;

// --- A1 — agent-first: the handoff + where you stand --------------------------

/**
 * Agent-first onboarding: the PRIMARY action is the handoff prompt (the
 * coding agent does the work; the docs' start.md carries the method). The
 * timeline below shows where the project stands — read fresh whenever the
 * page is opened or refocused, never polled. Manual commands stay
 * collapsed under "or do it yourself".
 */
export function VariantA1Timeline({
  projectId,
  publicUrl,
  signals,
  density = "page",
}: VariantProps) {
  const journey = buildJourney(signals, { projectId, publicUrl });
  const coreSteps = journey.filter((s) => s.key !== "traces");
  const stepNumber = (key: string) =>
    coreSteps.findIndex((s) => s.key === key) + 1;

  const prompt = publicUrl ? buildAgentPrompt(publicUrl, projectId) : null;

  // ONE stable surface for the whole journey: the checklist keeps its shape
  // from virgin to done — steps flip green in place, the task list grows
  // beneath it, and only completion transforms it (success moment; the real
  // page then drops it at the next visit via the gate). Continuity beats
  // real estate: a mid-journey layout swap (panel→banner) made progress
  // illegible. density="banner" (mounted above a real task list) renders
  // the same full checklist and returns nothing only when complete.
  if (density === "banner" && coreDone(signals)) return null;

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

      {/* THE HANDOFF — the docs-page pattern: compact button, hover preview */}
      <section className="mt-6 border border-border bg-card p-4">
        {prompt ? (
          <CopyPromptButton text={prompt} />
        ) : (
          <p className="text-xs text-muted-foreground">
            No public URL configured — follow the{" "}
            <a href={START_MD_URL} className="text-foreground underline underline-offset-2">
              setup guide
            </a>{" "}
            instead.
          </p>
        )}
      </section>

      {/* THE TIMELINE — where the project stands */}
      <ol className="mt-8 space-y-0">
        {journey.map((step) => (
          <li key={step.key} className="relative flex gap-3 pb-8 last:pb-0">
            {step.state !== "done" && (
              <span className="absolute top-5 left-2.5 h-full w-px bg-border" aria-hidden />
            )}
            <Glyph state={step.state} />
            <div className="min-w-0 flex-1 space-y-2">
              <h2
                className={`text-sm font-semibold ${
                  step.state === "pending" ? "text-muted-foreground/70" : ""
                }`}
              >
                {step.key !== "traces" && (
                  <span className="mr-2 font-mono text-[11px] text-muted-foreground/60">
                    {stepNumber(step.key)}.
                  </span>
                )}
                {step.title}
              </h2>
              {step.state === "done" && step.doneDetail ? (
                <p className="font-mono text-xs text-muted-foreground">{step.doneDetail}</p>
              ) : null}
              {step.state === "pending" && step.pendingHint ? (
                <p className="text-xs text-muted-foreground/60">{step.pendingHint}</p>
              ) : null}
              {step.state === "active" && (
                <p className="text-xs text-muted-foreground">
                  {step.pendingHint}
                </p>
              )}
              {step.key === "verdict" && step.state === "done" && <SuccessMoment />}
            </div>
          </li>
        ))}
      </ol>

      {/* MANUAL — the "or do it yourself" path, collapsed. Every remaining
          step's commands (a human works the whole list, not one step); the
          row disappears entirely once the journey is complete. */}
      {journey.some((s) => s.state !== "done") && (
        <details className="mt-2 border-t border-border/60 pt-3">
          <summary className="cursor-pointer select-none text-xs text-muted-foreground">
            Prefer doing it yourself?
          </summary>
          <div className="mt-3 space-y-5">
            {journey
              .filter((s) => s.key !== "traces" && s.state !== "done")
              .map((step) => (
                <div key={step.key} className="space-y-2">
                  <p className="text-xs font-medium text-foreground">{step.title}</p>
                  <StepHow stepKey={step.key} projectId={projectId} publicUrl={publicUrl} />
                </div>
              ))}
          </div>
        </details>
      )}
    </div>
  );
}

// --- A2 — compact horizontal progress card ----------------------------------

/**
 * The checklist as page furniture: a slim card — done chips, the active
 * step's single command inline, pending chips muted. For when the empty page
 * should stay quiet and the guide stays out of the way.
 */
export function VariantA2Compact({
  projectId,
  publicUrl,
  signals,
}: VariantProps) {
  const journey = buildJourney(signals, { projectId, publicUrl });
  const activeStep = journey.find((s) => s.state === "active") ?? null;

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="border border-border bg-card">
        <div className="flex flex-wrap items-center gap-x-1 gap-y-2 border-b border-border px-4 py-3">
          <p className="mr-3 text-xs font-semibold">First verdict setup</p>
          {journey.map((step, i) => (
            <span key={step.key} className="flex items-center gap-1">
              {i > 0 && <span className="mx-1 text-muted-foreground/40">·</span>}
              <span
                className={`flex items-center gap-1.5 text-xs ${
                  step.state === "done"
                    ? "text-muted-foreground"
                    : step.state === "active"
                      ? "text-foreground"
                      : "text-muted-foreground/50"
                }`}
              >
                <span
                  className={`flex size-3.5 items-center justify-center border ${
                    step.state === "done"
                      ? "border-success/50 bg-success/10"
                      : step.state === "active"
                        ? "border-foreground"
                        : "border-dashed border-border"
                  }`}
                >
                  {step.state === "done" && (
                    <Check className="size-2.5 text-success" aria-hidden />
                  )}
                </span>
                {step.title}
              </span>
            </span>
          ))}
        </div>
        {coreDone(signals) ? (
          <div className="px-4 py-3">
            <SuccessMoment compact />
          </div>
        ) : activeStep ? (
          <div className="space-y-2 px-4 py-3">
            <p className="text-xs text-muted-foreground">{activeStep.pendingHint}</p>
            <StepHow stepKey={activeStep.key} projectId={projectId} publicUrl={publicUrl} />
          </div>
        ) : null}
      </div>
      <div className="mt-4">
        <AgentSetupRow projectId={projectId} publicUrl={publicUrl} />
      </div>
    </div>
  );
}

// --- A3 — journey left, destination right -----------------------------------

/** Shortened real spec from the maintained example (data-extraction task). */
const SPEC_TEASER = `import { task } from "@apo-ai/sdk/agent-task";

const { test } = task("data-extraction", {
  description: "Extract structured data from an invoice.",
  maxTurns: 2,
  deliverables: ["result", "tool_log"],
});

test("called-list-files", (t) => {
  t.calledTool("list_files");
  t.noFailedActions();
});`;

function DestinationPanel({
  signals,
  publishedTaskNames,
}: Pick<VariantProps, "signals" | "publishedTaskNames">) {
  if (signals.recordedRuns > 0) {
    return (
      <div className="border border-border bg-card p-4">
        <p className="text-[10px] tracking-wide text-muted-foreground">
          YOUR LATEST VERDICT
        </p>
        <div className="mt-3 flex items-center justify-between border border-border/60 px-3 py-2">
          <p className="truncate font-mono text-xs text-foreground/80">
            {publishedTaskNames[0] ?? "support/ticket-triage"}
          </p>
          <PassBar value={1} />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Checks, traces and deliverables open from the run row.
        </p>
      </div>
    );
  }
  if (signals.publishedTasks > 0) {
    const names = publishedTaskNames.length
      ? publishedTaskNames
      : ["tasks/… (publish to see rows)"];
    return (
      <div className="border border-border bg-card p-4">
        <p className="text-[10px] tracking-wide text-muted-foreground">
          THIS PAGE, FILLING · {signals.publishedTasks} TASKS
        </p>
        <div className="mt-3 space-y-0">
          {names.slice(0, 4).map((name) => (
            <div
              key={name}
              className="flex items-center justify-between border-t border-border/40 py-2 first:border-t-0"
            >
              <p className="truncate font-mono text-xs text-foreground/80">{name}</p>
              <span className="font-mono text-[12px] text-muted-foreground/60">—</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Pass-rate bars appear after the first run.
        </p>
      </div>
    );
  }
  return (
    <div className="border border-border bg-card">
      <p className="border-b border-border px-4 py-2 text-[10px] tracking-wide text-muted-foreground">
        WHAT YOU&apos;LL WRITE — A REAL TASK FROM THE EXAMPLE SUITE
      </p>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {SPEC_TEASER}
      </pre>
      <p className="border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
        A task is code you already own: the work, plus the checks that prove it.{" "}
        <a href={HOSTED_DOCS_URL} className="text-foreground underline underline-offset-2">
          Spec format
        </a>
      </p>
    </div>
  );
}

/**
 * Split: the live timeline (tight) on the left, the destination on the
 * right — the right panel advances with the journey (spec teaser → task rows
 * → verdict), so every completed step visibly changes the page.
 */
export function VariantA3Split({
  projectId,
  publicUrl,
  signals,
  publishedTaskNames,
}: VariantProps) {
  const journey = buildJourney(signals, { projectId, publicUrl });

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <header className="space-y-1">
        <h1 className="text-[18px] font-semibold tracking-tight">
          Get to your first verdict
        </h1>
        <p className="text-[13px] text-muted-foreground">
          Four steps from empty project to recorded, inspectable evidence.
        </p>
      </header>
      <div className="mt-8 flex flex-col gap-10 lg:flex-row">
        <ol className="min-w-0 flex-1 space-y-0">
          {journey.map((step) => (
            <li key={step.key} className="relative flex gap-3 pb-7 last:pb-0">
              {step.state !== "done" && (
                <span className="absolute top-5 left-2.5 h-full w-px bg-border" aria-hidden />
              )}
              <Glyph state={step.state} />
              <div className="min-w-0 flex-1 space-y-2">
                <h2
                  className={`text-sm font-semibold ${
                    step.state === "pending" ? "text-muted-foreground/70" : ""
                  }`}
                >
                  {step.title}
                </h2>
                {step.state === "done" && step.doneDetail ? (
                  <p className="font-mono text-xs text-muted-foreground">{step.doneDetail}</p>
                ) : null}
                {step.state === "pending" && step.pendingHint ? (
                  <p className="text-xs text-muted-foreground/60">{step.pendingHint}</p>
                ) : null}
                {step.state === "active" && (
                  <div className="space-y-3">
                    <StepHow stepKey={step.key} projectId={projectId} publicUrl={publicUrl} />
                  </div>
                )}
                {step.key === "verdict" && step.state === "done" && <SuccessMoment />}
              </div>
            </li>
          ))}
        </ol>
        <div className="w-full lg:w-96">
          <DestinationPanel signals={signals} publishedTaskNames={publishedTaskNames} />
          <div className="mt-4">
            <AgentSetupRow projectId={projectId} publicUrl={publicUrl} />
          </div>
        </div>
      </div>
    </div>
  );
}
