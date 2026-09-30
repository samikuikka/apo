/**
 * Second grader: a typed-decision model (System One / Jev) that grades the
 * same deliverable + instruction as the primary LLM judge, in parallel.
 *
 * Why a second grader at all: the primary judge's verdict is the product,
 * but its trustworthiness is invisible. A non-generative decision model
 * cannot fabricate quoted evidence the way text judges measurably do, and
 * its calibrated confidence acts as a difficulty meter — so agreement +
 * confidence turn every check into self-describing evidence (auto-verified /
 * borderline / disputed) at ~1/100th of a cent per call.
 *
 * The second opinion NEVER changes the verdict. It is opt-in
 * (`APO_SECOND_JUDGE_MODEL`), runs on OpenRouter's decisions endpoint (not
 * chat/completions — decision models reject it), and any failure is
 * recorded as `error` (transport/HTTP/parse) or `skipped` (input the
 * model cannot read) on the evidence instead of affecting the check.
 */

import type { SecondJudgeEvidence } from "../run/types.ts";

/**
 * Decision calls are sub-second; this ceiling only guards against a hung
 * connection delaying check submission after the primary judge resolved.
 */
const SECOND_JUDGE_TIMEOUT_MS = 30_000;

/**
 * Resolve the opt-in second-grader model from the environment.
 * Unset, empty, or "none"/"off" disables the feature entirely.
 */
export function resolveSecondJudgeModel(): string | undefined {
  const value = process.env.APO_SECOND_JUDGE_MODEL?.trim();
  if (!value || value.toLowerCase() === "none" || value.toLowerCase() === "off") {
    return undefined;
  }
  return value;
}

/**
 * The second judge talks to an OpenRouter-style decisions endpoint, which the
 * primary judge's host often is not: a proxied primary (LiteLLM, a gateway, a
 * direct provider) neither serves `/alpha/decisions` nor accepts an OpenRouter
 * key. These overrides let the second opinion reach OpenRouter regardless of
 * where the primary judge is routed; unset, they fall back to the primary's
 * connection so the simple setup stays one set of variables.
 */
export function resolveSecondJudgeBaseURL(primaryBaseURL: string): string {
  return process.env.APO_SECOND_JUDGE_BASE_URL?.trim() || primaryBaseURL;
}

export function resolveSecondJudgeAPIKey(primaryAPIKey?: string): string | undefined {
  return process.env.APO_SECOND_JUDGE_API_KEY?.trim() || primaryAPIKey;
}

/**
 * OpenRouter serves decision models at `<origin>/api/alpha/decisions` while
 * the chat base is `<origin>/api/v1` — strip only the trailing `/v1` and
 * append the decisions path (verified live: without the `/api` segment the
 * origin serves the marketing site as HTML, not the API). Non-OpenRouter
 * bases simply get the path appended; if that endpoint doesn't exist there,
 * the call fails into `error` evidence, which is the honest outcome.
 */
export function decisionsEndpoint(chatBaseURL: string): string {
  const base = chatBaseURL.replace(/\/v1\/?$/, "");
  return `${base}/alpha/decisions`;
}

/**
 * OpenRouter's decisions endpoint reports an input that exceeds the
 * model's context limit as `error_type: "max_tokens_exceeded"` (wrapped
 * in an HTTP 400); OpenAI-style providers say `context_length_exceeded`.
 * Both mean the same thing here: the second judge could not read the
 * state — a different fact from a transport failure.
 */
const INPUT_TOO_LARGE_MARKERS = [
  "max_tokens_exceeded",
  "context_length_exceeded",
  "maximum context length",
] as const;

function isInputTooLargeRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 413) return false;
  return INPUT_TOO_LARGE_MARKERS.some((marker) => body.includes(marker));
}

/**
 * Rough token estimate (chars/4) for the skip message only. The provider
 * already told us the input doesn't fit — this number explains the
 * magnitude, it decides nothing.
 */
function estimateTokens(text: string): number {
  return Math.round(text.length / 4 / 1000) * 1000;
}

/**
 * Ask the decision model for a pass/fail verdict on the same state the
 * primary judge saw (briefing + values + instruction). Never throws —
 * every failure mode becomes `error` (or `skipped`, for an input the
 * model cannot read) on the returned evidence so a broken second
 * opinion cannot break the check it accompanies.
 *
 * Oversize inputs are classified from the provider's own rejection
 * rather than estimated before the call: the second judge can be any
 * OpenRouter model, the SDK holds no per-model limit catalog to
 * pre-flight against, and a rejected request is turned away before
 * inference (unbilled) — detection stays exact where an estimate
 * would drift.
 */
export async function callSecondJudge(args: {
  state: string;
  model: string;
  baseURL: string;
  apiKey?: string;
  /** Set when the state was built from a `secondJudgeValue` projection. */
  projected?: boolean;
}): Promise<SecondJudgeEvidence> {
  const startedAt = Date.now();
  const evidence: SecondJudgeEvidence = {
    model: args.model,
    ...(args.projected ? { projected: true } : {}),
  };
  try {
    const response = await fetch(decisionsEndpoint(args.baseURL), {
      method: "POST",
      signal: AbortSignal.timeout(SECOND_JUDGE_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        ...(args.apiKey ? { Authorization: `Bearer ${args.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: args.model,
        state: args.state,
        questions: {
          verdict: {
            type: "choice",
            instructions:
              "You are an evaluation judge. Apply the PASS/FAIL criteria " +
              "given for the check to the agent's work product. Does it " +
              "satisfy the check?",
            criteria: {
              pass: "The work product satisfies the check's PASS criteria",
              fail:
                "The work product satisfies the FAIL criteria, or does not " +
                "satisfy PASS",
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // An input the second judge cannot read is a skip, not a transport
      // error: distinct state, distinct rendering, never "failed to
      // arrive" (issue #311). The estimate is chars/4 — close enough to
      // say "~97k tokens", honest enough to keep the "~".
      if (isInputTooLargeRejection(response.status, body)) {
        evidence.skipped =
          `input ~${estimateTokens(args.state).toLocaleString("en-US")} tokens ` +
          `exceeds ${args.model}'s context limit — project a smaller view ` +
          `with t.judge(value, instruction, { secondJudgeValue })`;
        return evidence;
      }
      evidence.error = `Second judge API ${response.status}: ${body.slice(0, 200)}`;
      return evidence;
    }

    // An HTML answer means the endpoint is a website, not the decisions API —
    // the base URL is missing its API root (e.g. openrouter.ai instead of
    // openrouter.ai/api/v1). Say that instead of a JSON-parser stack trace.
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      evidence.error =
        "Second judge endpoint returned HTML, not the decisions API — " +
        "APO_SECOND_JUDGE_BASE_URL likely points at the site root. " +
        "Use the API root, e.g. https://openrouter.ai/api/v1";
      return evidence;
    }

    let data: {
      answers?: {
        verdict?: {
          choice?: string;
          probabilities?: Record<string, number>;
          confidence?: number;
        };
      };
      usage?: { input_tokens?: number; cost?: number };
    };
    try {
      data = JSON.parse(await response.text());
    } catch {
      evidence.error =
        "Second judge endpoint returned a non-JSON body — check " +
        "APO_SECOND_JUDGE_BASE_URL points at the decisions API root " +
        "(e.g. https://openrouter.ai/api/v1)";
      return evidence;
    }

    const verdict = data.answers?.verdict;
    if (verdict?.choice !== "pass" && verdict?.choice !== "fail") {
      evidence.error = "Second judge returned no verdict choice";
      return evidence;
    }

    evidence.choice = verdict.choice;
    evidence.passProbability = verdict.probabilities?.pass;
    evidence.confidence = verdict.confidence;
    evidence.inputTokens = data.usage?.input_tokens;
    evidence.costUsd = data.usage?.cost;
  } catch (err) {
    evidence.error = `Second judge failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
  }
  evidence.latencyMs = Date.now() - startedAt;
  return evidence;
}
