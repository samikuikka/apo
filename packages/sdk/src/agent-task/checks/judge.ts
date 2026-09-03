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

/**
 * What a judge call is grading — everything the SDK knows that a bare
 * (deliverable, instruction) pair withholds (#161). Threaded automatically
 * from the task definition and the check registry; consumed by
 * {@link JudgePromptBuilder}.
 */
export type JudgeContext = {
  /** The task being graded (`TaskDefinition.id`). */
  taskId: string;
  /** `TaskDefinition.description`, when the task sets one. */
  taskDescription?: string;
  /** The name of the check invoking the judge (the `test(...)` id). */
  checkName: string;
  /** The rubric instruction for this call. */
  instruction: string;
  /** Deliverable keys the check read before judging, in read order. */
  deliverableNames?: string[];
};

/**
 * Builds the judge *briefing* — not the whole prompt. The SDK appends its
 * own response contract to whatever `system` comes back and keeps
 * `response_format`, so a builder cannot break verdict parsing. Keep the
 * returned `system` constant per task (vary only `user`) to preserve the
 * cached prompt prefix across a task's criteria.
 */
export type JudgePromptBuilder = (ctx: JudgeContext) => {
  system?: string;
  user?: string;
};

const VERDICT_FIRST_CONTRACT =
  'Respond with ONLY a JSON object: {"pass": true/false, "reasoning": "your reasoning"}';

const REASONING_FIRST_CONTRACT =
  'Respond with ONLY a JSON object: {"reasoning": "your reasoning", "pass": true/false}';

/**
 * Whether judge prompts should elicit the legacy verdict-first contract
 * (`{"pass": ..., "reasoning": ...}`). Reasoning-first is the default since
 * the #163 measurement: verdict-first makes the model commit to `pass` and
 * then justify a decision already made — on a degenerate deliverable it
 * false-passed 3/3 with the one-word reasoning "passed", while
 * reasoning-first reasoned to the correct FAIL, and every sound deliverable
 * scored identically in both arms. `APO_JUDGE_VERDICT_FIRST` exists to
 * elicit the legacy arm for A/B measurement — not as a task knob.
 * Process-wide by design: a per-task knob here is a way for a task to be
 * wrong.
 */
export function isJudgeVerdictFirstOverrideEnabled(): boolean {
  const value = process.env.APO_JUDGE_VERDICT_FIRST?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function judgeResponseContract(): string {
  return isJudgeVerdictFirstOverrideEnabled()
    ? VERDICT_FIRST_CONTRACT
    : REASONING_FIRST_CONTRACT;
}

/** Which contract a judgment was elicited with — groups A/B comparisons (#163). */
export type JudgeContract = "verdict-first" | "reasoning-first";

function judgeContractInUse(): JudgeContract {
  return isJudgeVerdictFirstOverrideEnabled() ? "verdict-first" : "reasoning-first";
}

function judgeSystemPrompt(): string {
  return (
    "You are an evaluation judge. Evaluate the given value(s) against the " +
    `instruction. ${judgeResponseContract()}`
  );
}

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
 * Bound on one judge request. Generous — LLM completions on large
 * deliverables are slow — but finite, because same-prefix judge calls are
 * serialized (below): one stalled provider request would otherwise delay
 * every criterion sharing the cached prefix, ~300s each on undici's
 * default, with no error to see.
 */
const JUDGE_TIMEOUT_MS = 120_000;

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
  /** Custom briefing builder; the response contract stays SDK-owned. */
  prompt?: JudgePromptBuilder;
  /** What is being graded — threaded to the builder. */
  context?: JudgeCallContext;
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

  // Briefing: today's fixed one-liner, or a caller's builder. The SDK always
  // appends its own response contract (#161): a builder that elicited
  // `{"verdict": "pass"}` instead would make every criterion silently FAIL,
  // so the contract is never the caller's to write.
  const { briefingText, instructionText } = assembleBriefing(args);

  const systemPromptText = `${briefingText}\n\n${deliverableText}`;

  // The cached prefix is model + briefing + system blocks; the varying
  // instruction lives in the user message, so it's excluded from the key.
  // The briefing must be part of the key: once prompts vary per task, two
  // different briefings grading one deliverable would otherwise collide (#161).
  const cacheKey = `${args.model}\u0000${briefingText}\u0000${deliverableText}`;

  return runWithSharedPrefix(cacheKey, async () => {
    const startedAt = Date.now();

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
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
              { type: "text", text: briefingText },
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
          contract: judgeContractInUse(),
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
        contract: judgeContractInUse(),
        prompt: { system: systemPromptText, user: instructionText },
        response: text,
        tokens: parseJudgeUsage(data.usage),
        latency_ms: Date.now() - startedAt,
      },
    };
  });
}

/**
 * The scope parts a caller knows before the instruction — `instruction` is
 * merged in here, so callers never duplicate it.
 */
export type JudgeCallContext = Omit<JudgeContext, "instruction">;

/**
 * Resolve the briefing + user text for one judge call. With no builder (or a
 * builder that returns nothing) this is today's prompt byte-for-byte, so no
 * existing score moves until a caller opts in (#161 compatibility).
 */
function assembleBriefing(args: {
  instruction: string;
  prompt?: JudgePromptBuilder;
  context?: JudgeCallContext;
}): { briefingText: string; instructionText: string } {
  if (!args.prompt) {
    return {
      briefingText: judgeSystemPrompt(),
      instructionText: `Instruction:\n${args.instruction}`,
    };
  }

  const ctx: JudgeContext = {
    taskId: args.context?.taskId ?? "",
    checkName: args.context?.checkName ?? "",
    ...(args.context?.taskDescription !== undefined
      ? { taskDescription: args.context.taskDescription }
      : {}),
    ...(args.context?.deliverableNames !== undefined &&
      args.context.deliverableNames.length > 0
      ? { deliverableNames: args.context.deliverableNames }
      : {}),
    instruction: args.instruction,
  };
  const built = args.prompt(ctx);

  const system = built.system?.trim();
  const user = built.user?.trim();
  return {
    // The SDK appends its own response contract to any custom briefing.
    briefingText: system
      ? `${system}\n\n${judgeResponseContract()}`
      : judgeSystemPrompt(),
    instructionText: user ?? `Instruction:\n${args.instruction}`,
  };
}
