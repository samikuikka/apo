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
 * recorded as `error` on the evidence instead of affecting the check.
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
 * Ask the decision model for a pass/fail verdict on the same state the
 * primary judge saw (briefing + values + instruction). Never throws —
 * every failure mode becomes `error` on the returned evidence so a broken
 * second opinion cannot break the check it accompanies.
 */
export async function callSecondJudge(args: {
  state: string;
  model: string;
  baseURL: string;
  apiKey?: string;
}): Promise<SecondJudgeEvidence> {
  const startedAt = Date.now();
  const evidence: SecondJudgeEvidence = { model: args.model };
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
      evidence.error = `Second judge API ${response.status}: ${body.slice(0, 200)}`;
      return evidence;
    }

    const data = (await response.json()) as {
      answers?: {
        verdict?: {
          choice?: string;
          probabilities?: Record<string, number>;
          confidence?: number;
        };
      };
      usage?: { input_tokens?: number; cost?: number };
    };

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
