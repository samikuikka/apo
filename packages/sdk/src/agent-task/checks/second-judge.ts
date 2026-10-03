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
 * (`APO_SECOND_JUDGE_MODEL`), runs on a decisions endpoint (not
 * chat/completions — decision models reject it), and any failure is
 * recorded as `error` on the evidence instead of affecting the check.
 *
 * Providers: every decisions endpoint speaks its own request/response
 * dialect, selected via `APO_SECOND_JUDGE_PROVIDER` (or auto-detected from
 * the base URL). Adding a provider means adding one object to `PROVIDERS`
 * — nothing else in this file or the caller changes.
 */

import type { SecondJudgeEvidence } from "../run/types.ts";

/**
 * Decision calls are sub-second; this ceiling only guards against a hung
 * connection delaying check submission after the primary judge resolved.
 */
const SECOND_JUDGE_TIMEOUT_MS = 30_000;

/** A provider-shaped pass/fail decision, or the reason it couldn't be read. */
type ParsedDecision = {
  choice?: "pass" | "fail";
  passProbability?: number;
  confidence?: number;
  inputTokens?: number;
  costUsd?: number;
  error?: string;
};

/** How to talk to one decisions endpoint dialect. */
type SecondJudgeProvider = {
  /** Decisions URL derived from the (chat-style) base URL. */
  decisionsURL: (chatBaseURL: string) => string;
  /** Serialized request body grading `state` for a pass/fail verdict. */
  requestBody: (model: string, state: string) => string;
  /** Map a provider response onto evidence fields. */
  parseResponse: (body: unknown) => ParsedDecision;
  /** API root to suggest when the endpoint answers HTML or non-JSON. */
  readonly apiRootExample: string;
  /**
   * Set when the seat exists but the dialect is not implemented (endpoint
   * gated or schema unpublished): selecting it fails into clear `error`
   * evidence instead of sending a guessed request to someone's billing.
   */
  readonly reserved?: string;
};

const OPENROUTER_RESERVED_HINT =
  "Point APO_SECOND_JUDGE_BASE_URL at an OpenRouter-style decisions API " +
  "(e.g. https://openrouter.ai/api/v1) or set APO_SECOND_JUDGE_PROVIDER=openrouter";

/**
 * OpenRouter's dialect: decision models live at `<origin>/api/alpha/decisions`
 * while the chat base is `<origin>/api/v1` — strip only the trailing `/v1` and
 * append the decisions path (verified live: without the `/api` segment the
 * origin serves the marketing site as HTML, not the API).
 */
const openRouterProvider: SecondJudgeProvider = {
  decisionsURL(chatBaseURL: string): string {
    const base = chatBaseURL.replace(/\/v1\/?$/, "");
    return `${base}/alpha/decisions`;
  },

  requestBody(model: string, state: string): string {
    return JSON.stringify({
      model,
      state,
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
    });
  },

  parseResponse(body: unknown): ParsedDecision {
    const data = body as {
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
      return { error: "Second judge returned no verdict choice" };
    }
    return {
      choice: verdict.choice,
      passProbability: verdict.probabilities?.pass,
      confidence: verdict.confidence,
      inputTokens: data.usage?.input_tokens,
      costUsd: data.usage?.cost,
    };
  },

  apiRootExample: "https://openrouter.ai/api/v1",
};

/**
 * OpenAI's Decisions endpoint (announced 2026-09-29) is limited-preview with
 * no published request/response schema, so this seat is reserved rather than
 * guessed: selecting it explains the situation instead of firing a fabricated
 * shape at the endpoint. It turns into a real provider by filling in the
 * three members next to the reserved marker once the dialect is documented.
 */
const openAIProvider: SecondJudgeProvider = {
  decisionsURL: (chatBaseURL: string) =>
    `${chatBaseURL.replace(/\/v1\/?$/, "")}/decisions`,
  requestBody: () => {
    throw new Error("unreachable — reserved guard returns before the call");
  },
  parseResponse: () => ({ error: "unreachable — reserved guard returns before the call" }),
  apiRootExample: "https://api.openai.com/v1",
  reserved:
    "The OpenAI Decisions API provider is not implemented yet: the endpoint " +
    "is limited-preview and its schema is unpublished. " +
    OPENROUTER_RESERVED_HINT +
    ".",
};

const PROVIDERS: Record<string, SecondJudgeProvider> = {
  openrouter: openRouterProvider,
  openai: openAIProvider,
};

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
 * The second judge talks to a decisions endpoint, which the primary judge's
 * host often is not: a proxied primary (LiteLLM, a gateway, a direct
 * provider) neither serves a decisions API nor accepts an OpenRouter key.
 * These overrides let the second opinion reach a decisions endpoint
 * regardless of where the primary judge is routed; unset, they fall back to
 * the primary's connection so the simple setup stays one set of variables.
 */
export function resolveSecondJudgeBaseURL(primaryBaseURL: string): string {
  return process.env.APO_SECOND_JUDGE_BASE_URL?.trim() || primaryBaseURL;
}

export function resolveSecondJudgeAPIKey(primaryAPIKey?: string): string | undefined {
  return process.env.APO_SECOND_JUDGE_API_KEY?.trim() || primaryAPIKey;
}

/**
 * Pick the provider dialect: `APO_SECOND_JUDGE_PROVIDER` wins when set;
 * otherwise an OpenAI host selects the (reserved) OpenAI dialect and every
 * other base keeps the OpenRouter dialect that shipped first. Throws only
 * inside callSecondJudge's try, so an unknown value becomes `error`
 * evidence, never a failed check.
 */
export function resolveSecondJudgeProvider(baseURL: string): SecondJudgeProvider {
  const explicit = process.env.APO_SECOND_JUDGE_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    const provider = PROVIDERS[explicit];
    if (!provider) {
      throw new Error(
        `Unknown APO_SECOND_JUDGE_PROVIDER "${explicit}" — known: ${Object.keys(PROVIDERS).join(", ")}`,
      );
    }
    return provider;
  }
  return /(^|\.)api\.openai\.com$/.test(new URL(baseURL).hostname)
    ? openAIProvider
    : openRouterProvider;
}

/** OpenRouter URL derivation, exported for tests and diagnostics. */
export function decisionsEndpoint(chatBaseURL: string): string {
  return openRouterProvider.decisionsURL(chatBaseURL);
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
    const provider = resolveSecondJudgeProvider(args.baseURL);
    if (provider.reserved) {
      evidence.error = provider.reserved;
      return evidence;
    }

    const response = await fetch(provider.decisionsURL(args.baseURL), {
      method: "POST",
      signal: AbortSignal.timeout(SECOND_JUDGE_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        ...(args.apiKey ? { Authorization: `Bearer ${args.apiKey}` } : {}),
      },
      body: provider.requestBody(args.model, args.state),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      evidence.error = `Second judge API ${response.status}: ${body.slice(0, 200)}`;
      return evidence;
    }

    // An HTML answer means the endpoint is a website, not a decisions API —
    // the base URL is missing its API root (e.g. openrouter.ai instead of
    // openrouter.ai/api/v1). Say that instead of a JSON-parser stack trace.
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      evidence.error =
        "Second judge endpoint returned HTML, not the decisions API — " +
        "APO_SECOND_JUDGE_BASE_URL likely points at the site root. " +
        `Use the API root, e.g. ${provider.apiRootExample}`;
      return evidence;
    }

    let data: unknown;
    try {
      data = JSON.parse(await response.text());
    } catch {
      evidence.error =
        "Second judge endpoint returned a non-JSON body — check " +
        "APO_SECOND_JUDGE_BASE_URL points at the decisions API root " +
        `(e.g. ${provider.apiRootExample})`;
      return evidence;
    }

    const decision = provider.parseResponse(data);
    if (decision.error) {
      evidence.error = decision.error;
      return evidence;
    }
    evidence.choice = decision.choice;
    evidence.passProbability = decision.passProbability;
    evidence.confidence = decision.confidence;
    evidence.inputTokens = decision.inputTokens;
    evidence.costUsd = decision.costUsd;
  } catch (err) {
    evidence.error = `Second judge failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
  }
  evidence.latencyMs = Date.now() - startedAt;
  return evidence;
}
