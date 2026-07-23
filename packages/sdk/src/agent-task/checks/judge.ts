/**
 * LLM-as-judge call. Used by `t.judge(values, instruction)` to evaluate
 * deliverables against a natural-language rubric. Calls an OpenAI-compatible
 * endpoint (OpenRouter, OpenAI, etc.) via fetch and parses the verdict.
 */

import type { JudgeMetadata } from "../run/types.ts";

export type JudgeCallResult = {
  pass: boolean;
  reasoning: string;
  judge: JudgeMetadata;
};

const JUDGE_SYSTEM_PROMPT =
  "You are an evaluation judge. Evaluate the given value(s) against the " +
  'instruction. Respond with ONLY a JSON object: {"pass": true/false, "reasoning": "your reasoning"}';

function formatValue(value: unknown, depth = 0): string {
  const indent = "  ".repeat(depth);
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => `${indent}${formatValue(item, depth + 1)}`)
      .join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, val]) => {
        if (val && typeof val === "object") {
          return `${indent}${key}:\n${formatValue(val, depth + 1)}`;
        }
        return `${indent}${key}: ${formatValue(val, depth + 1)}`;
      })
      .join("\n");
  }
  return String(value);
}

function formatJudgeValues(values: unknown[]): string {
  if (values.length === 1) return formatValue(values[0]);
  return values
    .map((v, i) => `--- Value ${i + 1} ---\n${formatValue(v)}`)
    .join("\n\n");
}

/**
 * Tolerantly parse the judge model's response into `{pass, reasoning}`.
 *
 * Despite `response_format: json_object`, models sometimes wrap output in
 * markdown code fences (```` ```json … ``` ````) or add surrounding prose.
 * Falling back to a raw `"invalid JSON"` string on the first parse failure
 * buries the verdict and reasoning the user actually needs. Instead: try the
 * raw text, strip fences, then extract the first balanced `{...}` block.
 */

// Provider token usage for a judge call. Cached-prefix accounting arrives in
// two shapes depending on the route: direct Anthropic exposes
// cache_creation_input_tokens / cache_read_input_tokens, while OpenRouter
// (and OpenAI) normalize them into prompt_tokens_details.cache_write_tokens /
// prompt_tokens_details.cached_tokens. Their presence proves the cached
// deliverable prefix was written once and read on subsequent criteria (#21).
type JudgeUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
};

type JudgeTokens = {
  input: number;
  output: number;
  cache_creation?: number;
  cache_read?: number;
};

function parseJudgeUsage(usage: JudgeUsage | undefined): JudgeTokens | undefined {
  if (!usage) return undefined;
  const cacheCreation =
    usage.cache_creation_input_tokens ?? usage.prompt_tokens_details?.cache_write_tokens;
  const cacheRead =
    usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  const tokens: JudgeTokens = {
    input: usage.prompt_tokens ?? 0,
    output: usage.completion_tokens ?? 0,
  };
  if (typeof cacheCreation === "number") tokens.cache_creation = cacheCreation;
  if (typeof cacheRead === "number") tokens.cache_read = cacheRead;
  return tokens;
}

function parseJudgeJson(raw: string): { pass?: boolean; reasoning?: string } {
  // 1. Direct parse (the common, well-behaved case).
  try {
    return JSON.parse(raw);
  } catch {
    // fall through to tolerant strategies
  }
  // 2. Strip a single markdown code fence: ```json\n{...}\n``` -> {...}.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }
  // 3. Pull the first balanced {...} block out of surrounding prose.
  const block = raw.match(/\{[\s\S]*\}/);
  if (block) {
    try {
      return JSON.parse(block[0]);
    } catch {
      // fall through
    }
  }
  // 4. Unparseable. The verdict is genuinely unknown, so we treat it as a
  // failure (can't confirm pass) and explain what happened in plain language.
  // Dumping the raw response as "reasoning" is unhelpful — it's usually a
  // truncated or malformed blob the model emitted, and presenting it as an
  // explanation misleads. The raw response stays available on the judge
  // metadata for anyone who needs to debug the model output itself.
  return {
    pass: false,
    reasoning:
      "Judge response could not be parsed as JSON — the verdict is unknown, " +
      "so this check is treated as a failure. The model's raw response is " +
      "available in the judge metadata.",
  };
}

/**
 * Per-prefix serialization. Checks run concurrently (flow-runner uses
 * Promise.all), so without coordination N criteria judging the same
 * deliverable would all dispatch against a cold cache and mostly miss. This
 * chains calls that share a cached prefix: the first warms the provider's
 * prompt cache and the rest dispatch only after it resolves (and hit it).
 * Calls with different prefixes are independent and stay concurrent.
 */
const prefixQueues = new Map<string, Promise<unknown>>();

function runWithSharedPrefix<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = prefixQueues.get(key) ?? Promise.resolve();
  // Run `task` once the previous same-prefix call settles, regardless of
  // whether it succeeded — a failed warmer must not block its siblings.
  const next = prev.then(task, task);
  // Keep the chain alive through errors so one rejection can't poison the queue.
  prefixQueues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export async function callJudge(args: {
  values: unknown[];
  instruction: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
}): Promise<JudgeCallResult> {
  const baseURL = args.baseURL ?? process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  const apiKey = args.apiKey ?? process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;

  // Structure the request so the (often huge) deliverable is a cacheable
  // prefix and only the small per-criterion instruction varies. Many criteria
  // judge the same deliverable; without a cache breakpoint the deliverable is
  // re-billed in full on every call. cache_control is an Anthropic/Gemini
  // extension that OpenRouter passes through, and is ignored harmlessly by
  // providers without prompt caching. See issue #21.
  const deliverableText = `Values to evaluate:\n${formatJudgeValues(args.values)}`;
  const instructionText = `Instruction:\n${args.instruction}`;
  const systemPromptText = `${JUDGE_SYSTEM_PROMPT}\n\n${deliverableText}`;

  // The cached prefix is model + system blocks; the varying instruction lives
  // in the user message, so it's excluded from the key.
  const cacheKey = `${args.model}\u0000${deliverableText}`;

  return runWithSharedPrefix(cacheKey, async () => {
    const startedAt = Date.now();

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          {
            role: "system",
            content: [
              { type: "text", text: JUDGE_SYSTEM_PROMPT },
              {
                type: "text",
                text: deliverableText,
                cache_control: { type: "ephemeral" },
              },
            ],
          },
          { role: "user", content: instructionText },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Judge API ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: JudgeUsage;
    };

    const text = data.choices?.[0]?.message?.content ?? "";
    const outputTokens = data.usage?.completion_tokens;

    // Guard: a response that is empty, OR that the provider reports as having
    // generated zero output tokens, is a transient/provider failure — not a
    // model verdict. This happens when a provider cuts a stream mid-generation
    // and returns a stub like "[" with completion_tokens: 0. Treat it as a
    // failure with a clear explanation rather than feeding garbage to the
    // parser. (Only guard on tokens when the provider actually reported usage;
    // absent usage means "unknown", not "zero".)
    const isEmpty = !text.trim();
    const reportedZeroTokens = data.usage !== undefined && outputTokens === 0;
    if (isEmpty || reportedZeroTokens) {
      return {
        pass: false,
        reasoning:
          "Judge returned an empty or truncated response — likely a transient " +
          "provider failure. The verdict is unknown, so this check is treated " +
          "as a failure.",
        judge: {
          model: args.model,
          prompt: { system: systemPromptText, user: instructionText },
          response: text,
        tokens: parseJudgeUsage(data.usage),
        latency_ms: Date.now() - startedAt,
      },
    };
  }

  // Models routinely wrap their JSON in markdown fences (```json … ```) or
    // add prose around it despite the json_object response_format. Parse
    // tolerantly so the verdict + reasoning aren't lost to a parse error:
    // try the raw text, then strip fences, then extract the first {...}.
    const parsed = parseJudgeJson(text);

    return {
      pass: parsed.pass === true,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      judge: {
        model: args.model,
        prompt: { system: systemPromptText, user: instructionText },
        response: text,
        tokens: parseJudgeUsage(data.usage),
        latency_ms: Date.now() - startedAt,
      },
    };
  });
}
