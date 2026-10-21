import { buildCliLoginCommand, HOSTED_DOCS_URL } from "@/lib/first-run";

/**
 * The onboarding journey's complete signal set. Every field is derived by
 * the backend from real rows (`onboarding-status`) — nothing about progress
 * is ever stored client-side, so the panel cannot drift from the project's
 * actual state.
 */
export interface OnboardingSignals {
  projectId: string;
  /** Validated public origin; "" when the installation misconfigured it. */
  publicUrl: string;
  hasTraces: boolean;
  traceService: string | null;
  traceCount: number;
  cliConnected: boolean;
  publishedTasks: number;
  recordedRuns: number;
}

export type OnboardingStepState = "done" | "active" | "pending";

export interface OnboardingStep {
  key: "traces" | "cli" | "publish" | "run";
  title: string;
  state: OnboardingStepState;
  /** Mono fact shown on a completed step (real numbers only). */
  doneDetail: string | null;
  /** One-line hint while incomplete. */
  hint: string;
}

/**
 * The journey as a pure function of the signals: an optional traces
 * pre-step that appears only when traces actually flow (never a step whose
 * signal cannot be detected), then the three-step core loop. Exactly one
 * active step: the first incomplete one.
 */
export function buildOnboardingSteps(signals: OnboardingSignals): OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  if (signals.hasTraces) {
    steps.push({
      key: "traces",
      title: "Signal Is Flowing",
      state: "done",
      doneDetail: signals.traceService
        ? `${signals.traceService} · ${signals.traceCount} traces`
        : `${signals.traceCount} traces`,
      hint: "",
    });
  }
  const core: OnboardingStep[] = [
    {
      key: "cli",
      title: "Connect The CLI",
      state: signals.cliConnected ? "done" : "pending",
      doneDetail: "project key minted",
      hint: "One install + one login; the key never leaves your machine.",
    },
    {
      key: "publish",
      title: "Publish A Task Suite",
      state: signals.publishedTasks > 0 ? "done" : "pending",
      doneDetail: `${signals.publishedTasks} tasks published`,
      hint: "Turn what your agent must do into checks — metadata only.",
    },
    {
      key: "run",
      title: "Record A Run",
      state: signals.recordedRuns > 0 ? "done" : "pending",
      doneDetail: `${signals.recordedRuns} runs recorded`,
      hint: "The agent runs locally; apo records the verdict and evidence.",
    },
  ];
  const firstIncomplete = core.find((s) => s.state === "pending");
  if (firstIncomplete) firstIncomplete.state = "active";
  return [...steps, ...core];
}

/** The agent-readable setup skill the docs serve; the handoff prompt points
 *  here instead of inlining the whole method. */
const START_MD_URL = new URL("/start.md", HOSTED_DOCS_URL).href;

/**
 * The docs-page copy-prompt pattern, project-aware: the prompt embeds what
 * the generic docs prompt cannot know — this user's server and project —
 * and delegates the method to start.md. Auth is the CLI's interactive
 * login; the agent asks the human for credentials exactly once.
 */
export function buildAgentHandoffPrompt(signals: OnboardingSignals): string {
  return `Set up apo capability testing in this repository, end to end.

My apo server: ${signals.publicUrl}
My project:    ${signals.projectId}
Full guide:    ${START_MD_URL} — follow it.

Auth: run \`${buildCliLoginCommand(signals.publicUrl, signals.projectId)}\`,
then ask me for my email and password when prompted — once.

Deliverable: one published task suite + one recorded run.
Report back: the task id, the verdict, and anything ambiguous you had to decide.`;
}
