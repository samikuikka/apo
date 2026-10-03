/**
 * LLM-as-judge call. Used by `t.judge(values, instruction)` to evaluate
 * deliverables against a natural-language rubric. Calls an OpenAI-compatible
 * endpoint (OpenRouter, OpenAI, etc.) via fetch and parses the verdict.
 */

import type { JudgeMetadata } from "../run/types.ts";
import { callSecondJudge, resolveSecondJudgeAPIKey, resolveSecondJudgeBaseURL, resolveSecondJudgeModel } from "./second-judge.ts";

export type JudgeCallResult = {
  pass: boolean;
  reasoning: string;
  judge: JudgeMetadata;
  /**
   * Set when no verdict arrived (empty or truncated response). `pass` is then
   * false only because a pass can't be confirmed — the caller records it as
   * `outcome: "error"`, not as the judge's FAIL.
   */
  unavailable?: true;
};

/**
 * The judge could not be reached or returned an HTTP error — no verdict
 * exists. Thrown after the one retry is spent; `t.judge` records it as
 * `outcome: "error"`.
 */
export class JudgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeUnavailableError";
  }
}

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
 * Bounds on one judge call. Same-prefix judge calls are serialized (below),
 * so a stalled call delays every criterion sharing the cached prefix; both
 * bounds end it with an error rather than a silent wait.
 *
 * - Total: one deadline for the whole call, retry included. Generous,
 *   because a reasoning judge on a long checklist criterion measured
 *   87–100 s end to end, and some samples run past 180 s.
 * - Idle: once content has started streaming, no `data:` chunk for this long
 *   means the stream has stalled. It is not armed before the first chunk: a
 *   model that reasons without streaming its thinking sends only keepalive
 *   comments until it answers, and that silence is the think, not a stall.
 */
const JUDGE_TIMEOUT_MS = 300_000;
const JUDGE_IDLE_TIMEOUT_MS = 90_000;

/**
 * One retry for a transport failure (network error, 429, 5xx, a stream error,
 * a stalled stream, or a reply with no complete content). These are the
 * provider's or the gateway's, not the judge's: a single cut connection
 * should not become a FAIL verdict. A 429's `Retry-After` is honoured up to
 * the cap.
 */
const JUDGE_RETRY_DELAY_MS = 1_000;
const JUDGE_RETRY_AFTER_CAP_MS = 20_000;
/**
 * Below this much remaining budget a retry is unlikely to finish (a
 * reasoning judge measured 34–100 s end to end), so none is made.
 */
const JUDGE_MIN_RETRY_BUDGET_MS = 60_000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayMs(retryAfter: string | null): number {
  if (!retryAfter) return JUDGE_RETRY_DELAY_MS;
  const seconds = Number(retryAfter);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(retryAfter) - Date.now();
  if (!Number.isFinite(ms)) return JUDGE_RETRY_DELAY_MS;
  return Math.min(Math.max(ms, JUDGE_RETRY_DELAY_MS), JUDGE_RETRY_AFTER_CAP_MS);
}

type JudgeCompletion = {
  text: string;
  usage: JudgeUsage | undefined;
  finishReason: string | undefined;
};

type StreamChunk = {
  choices?: Array<{
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: JudgeUsage | null;
  error?: { message?: string } | string;
};

/**
 * Read a chat-completion response. The request asks for a stream so a
 * reasoning model's long silence before its first content token carries
 * the gateway's SSE keepalives instead of looking idle (a non-streaming
 * request is a silent connection for the whole think, and an idle-timeout
 * proxy cuts it: a 60 s idle cut returned 504 on judge calls that reason
 * for 60–90 s). Providers that ignore `stream` reply with plain JSON, which
 * is read as before. `onData` fires on every SSE data event.
 */
async function readCompletion(
  response: Response,
  onData: () => void,
): Promise<JudgeCompletion> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>;
      usage?: JudgeUsage;
    };
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      usage: data.usage,
      finishReason: data.choices?.[0]?.finish_reason ?? undefined,
    };
  }

  let text = "";
  let usage: JudgeUsage | undefined;
  let finishReason: string | undefined;

  // SSE event assembly: `data:` lines accumulate until a blank line
  // dispatches the event; comment lines (": ping", ": OPENROUTER
  // PROCESSING") are keepalives and carry nothing.
  let eventType = "message";
  let dataLines: string[] = [];
  // `[DONE]` ends the completion even if the server keeps the socket open.
  let finished = false;
  const dispatch = (): void => {
    const payload = dataLines.join("\n").trim();
    const type = eventType;
    eventType = "message";
    dataLines = [];
    if (payload === "[DONE]") finished = true;
    if (!payload || finished) return;
    onData();
    let chunk: StreamChunk | undefined;
    try {
      chunk = JSON.parse(payload) as StreamChunk;
    } catch {
      chunk = undefined;
    }
    if (type === "error" || chunk?.error) {
      const error = chunk?.error;
      const message =
        typeof error === "string" ? error : (error?.message ?? (chunk ? undefined : payload));
      throw new JudgeUnavailableError(`Judge stream error: ${message ?? "unknown"}`);
    }
    if (!chunk) return;
    const choice = chunk.choices?.[0];
    text += choice?.delta?.content ?? "";
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  };
  const handleLine = (line: string): void => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") eventType = value;
  };

  const reader = response.body?.getReader();
  if (!reader) return { text, usage, finishReason };
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Hold a trailing CR: it may be the first half of a CRLF split across reads.
    const lines = buffer.split(/\r\n|\r(?!$)|\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      handleLine(line);
      if (finished) return { text, usage, finishReason };
    }
  }
  buffer += decoder.decode();
  for (const line of buffer.split(/\r\n|\r|\n/)) if (line) handleLine(line);
  dispatch();
  return { text, usage, finishReason };
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
  /** Custom briefing builder; the response contract stays SDK-owned. */
  prompt?: JudgePromptBuilder;
  /** What is being graded — threaded to the builder. */
  context?: JudgeCallContext;
  /**
   * A smaller view for the second judge, when the primary value does not
   * fit its context (issue #311): the primary judge still grades `values`
   * in full; the second judge grades this projection instead. Absent, the
   * second judge sees exactly what the primary sees.
   */
  secondJudgeValue?: unknown[];
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

  // Second grader (opt-in): dispatch alongside the primary call so its
  // sub-second latency adds nothing to the check. The state is exactly what
  // the primary judge sees — unless the call projected a `secondJudgeValue`
  // because the full value exceeds the second judge's context; then the
  // second judge grades the projection and the evidence says so. It can
  // never change the verdict — the evidence is attached and the check
  // moves on regardless of its outcome.
  const secondJudgeModel = resolveSecondJudgeModel();
  const secondJudgeProjected = args.secondJudgeValue !== undefined;
  const secondJudgeValues = args.secondJudgeValue ?? args.values;
  const secondJudgeDeliverableText = `Values to evaluate:\n${formatJudgeValues(secondJudgeValues)}`;
  const secondJudgePromise = secondJudgeModel
    ? callSecondJudge({
        state: `${briefingText}\n\n${secondJudgeDeliverableText}\n\n${instructionText}`,
        model: secondJudgeModel,
        baseURL: resolveSecondJudgeBaseURL(baseURL),
        apiKey: resolveSecondJudgeAPIKey(apiKey),
        ...(secondJudgeProjected ? { projected: true } : {}),
      })
    : undefined;

  // The cached prefix is model + briefing + system blocks; the varying
  // instruction lives in the user message, so it's excluded from the key.
  // The briefing must be part of the key: once prompts vary per task, two
  // different briefings grading one deliverable would otherwise collide (#161).
  const cacheKey = `${args.model}\u0000${briefingText}\u0000${deliverableText}`;

  const requestBody = (stream: boolean): string =>
    JSON.stringify({
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
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    });

  type AttemptResult =
    | { kind: "completion"; completion: JudgeCompletion }
    | {
        kind: "unavailable";
        error: JudgeUnavailableError;
        retryable: boolean;
        retryDelayMs?: number;
        /** The endpoint rejected the streaming fields; retry without them. */
        streamRejected?: boolean;
      };

  // One attempt, bounded by the call's shared deadline and, once content is
  // flowing, by the idle bound.
  const attempt = async (stream: boolean, deadline: number): Promise<AttemptResult> => {
    const controller = new AbortController();
    const expire = (reason: string, name: string) => () =>
      controller.abort(new DOMException(reason, name));
    const total = setTimeout(
      expire(`no complete response within ${JUDGE_TIMEOUT_MS / 1000}s`, "TimeoutError"),
      Math.max(deadline - Date.now(), 0),
    );
    const stalled = expire(`no data for ${JUDGE_IDLE_TIMEOUT_MS / 1000}s`, "IdleTimeoutError");
    let idle: ReturnType<typeof setTimeout> | undefined;
    const onData = (): void => {
      clearTimeout(idle);
      idle = setTimeout(stalled, JUDGE_IDLE_TIMEOUT_MS);
    };

    try {
      let response: Response;
      try {
        response = await fetch(`${baseURL}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: requestBody(stream),
        });
      } catch (error) {
        return transportFailure("Judge request failed", controller.signal.reason ?? error);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          kind: "unavailable",
          error: new JudgeUnavailableError(`Judge API ${response.status}: ${body.slice(0, 200)}`),
          retryable: isRetryableStatus(response.status),
          ...(isRetryableStatus(response.status)
            ? { retryDelayMs: retryDelayMs(response.headers.get("retry-after")) }
            : {}),
          // Name the field, not the word: gateways echo request params in
          // unrelated 400 bodies.
          ...(stream && response.status === 400 && /stream_options|["'`]stream["'`]/.test(body)
            ? { streamRejected: true }
            : {}),
        };
      }

      try {
        return { kind: "completion", completion: await readCompletion(response, onData) };
      } catch (error) {
        return transportFailure("Judge response failed", controller.signal.reason ?? error);
      }
    } finally {
      clearTimeout(total);
      clearTimeout(idle);
      // Release the connection on every exit, including a thrown error chunk
      // whose stream the server has not closed. A no-op once the body is read.
      controller.abort();
    }
  };

  // No verdict came back: an empty reply, a provider that reports zero output
  // tokens (a stream cut mid-generation can return a stub like "[" with
  // completion_tokens: 0), or a reply stopped early (length, content filter,
  // provider error) whose JSON didn't complete. (Only guard on tokens when
  // the provider actually reported usage; absent usage means "unknown", not
  // "zero".) A stopped-early reply that still parses is a verdict and is kept.
  const isTruncated = ({ text, usage, finishReason }: JudgeCompletion): boolean => {
    if (!text.trim()) return true;
    if (usage !== undefined && usage.completion_tokens === 0) return true;
    if (finishReason !== "length" && finishReason !== "content_filter" && finishReason !== "error") {
      return false;
    }
    try {
      JSON.parse(text);
      return false;
    } catch {
      return true;
    }
  };

  return runWithSharedPrefix(cacheKey, async () => {
    const startedAt = Date.now();
    const deadline = startedAt + JUDGE_TIMEOUT_MS;

    let stream = true;
    let result = await attempt(stream, deadline);
    const truncated = result.kind === "completion" && isTruncated(result.completion);
    const streamRejected = result.kind === "unavailable" && result.streamRejected === true;
    const retryable = result.kind === "unavailable" && result.retryable;
    if (truncated || streamRejected || retryable) {
      const delay =
        result.kind === "unavailable" && result.retryDelayMs !== undefined
          ? result.retryDelayMs
          : streamRejected
            ? 0
            : JUDGE_RETRY_DELAY_MS;
      if (deadline - Date.now() - delay >= JUDGE_MIN_RETRY_BUDGET_MS) {
        if (streamRejected) stream = false;
        await new Promise((resolve) => setTimeout(resolve, delay));
        const first = result;
        result = await attempt(stream, deadline);
        // Keep the original cause visible when the retry fails too.
        if (result.kind === "unavailable" && first.kind === "unavailable") {
          result = {
            ...result,
            error: new JudgeUnavailableError(
              `${first.error.message} (retry: ${result.error.message})`,
            ),
          };
        }
      }
    }
    if (result.kind === "unavailable") throw result.error;

    const { text, usage } = result.completion;
    const judge: JudgeMetadata = {
      model: args.model,
      contract: judgeContractInUse(),
      prompt: { system: systemPromptText, user: instructionText },
      response: text,
      tokens: parseJudgeUsage(usage),
      latency_ms: Date.now() - startedAt,
      secondJudge: await secondJudgePromise,
    };

    if (isTruncated(result.completion)) {
      return {
        pass: false,
        reasoning:
          "Judge returned an empty or truncated response — likely a transient " +
          "provider failure. The verdict is unknown, so this check is recorded " +
          "as a judge error, not a verdict.",
        judge,
        unavailable: true,
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
      judge,
    };
  });
}

/**
 * A fetch or body-read failure. Hitting the call's deadline already spent the
 * whole budget, so that alone is not retried. A stalled stream (idle bound)
 * is transient, like a cut connection, and gets the retry.
 */
function transportFailure(
  prefix: string,
  error: unknown,
): { kind: "unavailable"; error: JudgeUnavailableError; retryable: boolean } {
  if (error instanceof JudgeUnavailableError) {
    return { kind: "unavailable", error, retryable: true };
  }
  const timedOut = error instanceof Error && error.name === "TimeoutError";
  return {
    kind: "unavailable",
    error: new JudgeUnavailableError(
      `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
    ),
    retryable: !timedOut,
  };
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
