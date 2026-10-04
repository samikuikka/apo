/**
 * Cascade judge mode: the opt-in cost tier for `t.judge`.
 *
 * With `judge: { mode: "cascade" }` the second judge (a typed-decision
 * model) answers FIRST, and a confident verdict stands without calling the
 * primary LLM judge at all. Everything else — low confidence, transport
 * error, an input the model cannot read, a projected `secondJudgeValue`
 * view — falls through to the primary judge exactly as in dual mode, so the
 * mode can only fail open.
 *
 * Why 0.95 and not lower: the threshold is only honest at the band it was
 * measured on. The second-judge shadow study (project/jev-second-judge)
 * measured 99.5% agreement between this confident band (72% of prod checks)
 * and the flash primary — lower bands drop off fast (94.5% at 0.6–0.95,
 * 71.3% below 0.6), and paper-scale evidence (arXiv:2609.26550) says
 * workload-specific thresholds are exactly the part that doesn't transfer.
 * One fixed, conservative number; no tuning surface.
 */

import type { JudgeConfig } from "./t.ts";
import type { JudgeCallContext, JudgePromptParts } from "./judge.ts";
import { buildJudgePromptParts } from "./judge.ts";
import type { JudgeMetadata, SecondJudgeEvidence } from "../run/types.ts";
import { callSecondJudge, resolveSecondJudgeAPIKey, resolveSecondJudgeBaseURL, resolveSecondJudgeModel } from "./second-judge.ts";

/**
 * A confident second-judge verdict stands in cascade mode at this native
 * confidence or above. See the module comment for why this is fixed.
 */
export const CASCADE_CONFIDENCE_THRESHOLD = 0.95;

/**
 * Cascade mode is active only when explicitly configured AND a second judge
 * is reachable (`APO_SECOND_JUDGE_MODEL` set to a model). Anything else is
 * dual mode / no second judge — the primary judges alone.
 */
export function isCascadeActive(effective: JudgeConfig | undefined): boolean {
  return effective?.mode === "cascade" && resolveSecondJudgeModel() !== undefined;
}

/**
 * The result of a cascade preflight: either the mode is off, or the second
 * judge ran and its evidence (verdict or failure) is in. `parts` carries the
 * exact prompt frame the state was built from, so a decided verdict can be
 * recorded with honest provenance.
 */
export type CascadePreflight =
  | { kind: "off" }
  | { kind: "ran"; evidence: SecondJudgeEvidence; parts: JudgePromptParts };

/**
 * Ask the second judge first. Serial by design: a confident answer here is
 * the entire saving (one sub-second decision call, zero primary tokens), so
 * the primary call is not dispatched until the gate has said "not confident".
 */
export async function cascadePreflight(args: {
  values: unknown[];
  instruction: string;
  effective: JudgeConfig;
  context?: JudgeCallContext;
  secondJudgeValue?: unknown[];
}): Promise<CascadePreflight> {
  const model = resolveSecondJudgeModel();
  if (model === undefined) return { kind: "off" };

  const parts = buildJudgePromptParts({
    values: args.values,
    instruction: args.instruction,
    ...(args.effective.prompt ? { prompt: args.effective.prompt } : {}),
    ...(args.context ? { context: args.context } : {}),
    ...(args.secondJudgeValue !== undefined ? { secondJudgeValue: args.secondJudgeValue } : {}),
  });

  const evidence = await callSecondJudge({
    state: parts.secondJudgeState,
    model,
    baseURL: resolveSecondJudgeBaseURL(
      args.effective.baseURL ?? process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    ),
    apiKey: resolveSecondJudgeAPIKey(
      args.effective.apiKey ?? process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY,
    ),
    ...(parts.secondJudgeProjected ? { projected: true } : {}),
  });
  return { kind: "ran", evidence, parts };
}

/**
 * Does this evidence decide the check? Requires a real verdict at or above
 * the confidence threshold, with no failure and no projection — a
 * `secondJudgeValue` view is a partial reading of the deliverable and must
 * never carry verdict authority.
 */
export function cascadeDecides(evidence: SecondJudgeEvidence | undefined): boolean {
  return (
    evidence !== undefined &&
    (evidence.choice === "pass" || evidence.choice === "fail") &&
    typeof evidence.confidence === "number" &&
    evidence.confidence >= CASCADE_CONFIDENCE_THRESHOLD &&
    evidence.error === undefined &&
    evidence.skipped === undefined &&
    evidence.projected !== true
  );
}

/**
 * Assemble the recorded verdict for a cascade-decided check. Decision models
 * return numbers, not prose — the reasoning says exactly what decided the
 * check and that the primary judge was not called, so a reader of the check
 * report can always tell a cascade verdict from a primary one.
 */
export function cascadeVerdict(
  evidence: SecondJudgeEvidence,
  parts: JudgePromptParts,
): { pass: boolean; reasoning: string; judge: JudgeMetadata } {
  const pass = evidence.choice === "pass";
  return {
    pass,
    reasoning:
      `Verdict by second judge (cascade): ${evidence.choice}` +
      ` · confidence ${evidence.confidence}` +
      (evidence.passProbability !== undefined ? ` · p(pass) ${evidence.passProbability}` : "") +
      `. Primary judge not called.`,
    judge: {
      model: evidence.model,
      prompt: { system: parts.systemPromptText, user: parts.instructionText },
      response: JSON.stringify({
        choice: evidence.choice,
        probabilities: { pass: evidence.passProbability },
        confidence: evidence.confidence,
      }),
      ...(evidence.inputTokens !== undefined
        ? { tokens: { input: evidence.inputTokens, output: 0 } }
        : {}),
      ...(evidence.latencyMs !== undefined ? { latency_ms: evidence.latencyMs } : {}),
      ...(evidence.costUsd !== undefined ? { cost: evidence.costUsd } : {}),
      secondJudge: evidence,
      verdict_by: "second-judge",
    },
  };
}
