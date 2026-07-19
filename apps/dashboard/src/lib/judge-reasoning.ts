/**
 * Pull the human-readable "why" out of a judge's raw LLM response.
 *
 * The judge metadata stores the raw model output in ``response`` (a JSON
 * string). The shape varies — a single ``{pass, reasoning}`` object, or an
 * array of per-value verdicts ``[{pass, reasoning}, …]`` — and some runs end
 * up with an empty ``assertion.reasoning`` even when the raw response carries
 * the explanation. This reliably extracts the reasoning text from any of those
 * shapes so the dashboard can show it as a verdict comment.
 */
export function extractJudgeReasoning(judge: { response?: string }): string | undefined {
  const raw = judge?.response;
  if (!raw) return undefined;

  const parsed = parseJsonLoose(raw);
  if (parsed === undefined) return undefined;

  const reasons: string[] = [];
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) collect(item);
      return;
    }
    if (v && typeof v === "object" && "reasoning" in v) {
      const r = (v as { reasoning?: unknown }).reasoning;
      if (typeof r === "string" && r.trim().length > 0) reasons.push(r.trim());
    }
  };
  collect(parsed);
  return reasons.length > 0 ? reasons.join("\n\n") : undefined;
}

/** Parse a JSON string, tolerating surrounding prose / code fences. */
function parseJsonLoose(raw: string): unknown | undefined {
  const direct = tryParse(raw);
  if (direct !== undefined) return direct;
  // Pull the first balanced [...] or {...} block out of surrounding text.
  const m = raw.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (m) return tryParse(m[1]);
  return undefined;
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
