import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool, type ModelMessage } from "ai";
import { readFileSync } from "fs";
import { z } from "zod";

/**
 * The example agent — the single home for the agent's logic.
 *
 * Adapters and the HTTP route both call `handleChat`. The agent owns its
 * model selection, its tools, its system prompt, and the multi-step loop.
 * Callers pass messages + files (and optional overrides) and get back the
 * response plus a structured record of every tool call.
 *
 * Tracing: `experimental_telemetry` is ON by default, so the Vercel AI SDK
 * emits standard `gen_ai.*` OTel spans that apo consumes. A caller that has
 * registered `registerApoTracing()` in the same process will have those spans
 * routed to the active run automatically.
 */

function getClient() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  return createOpenAI({
    apiKey,
    baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  });
}

function getModel() {
  return process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash-lite";
}

const SYSTEM_PROMPT =
  "You are a careful analysis agent with access to tools. " +
  "Always use list_files first, then use read_file with the exact file paths shown. " +
  "Never answer from assumptions or memory. " +
  "For factual answers, only state values you directly verified from tool output. " +
  "If evidence is missing or ambiguous, explicitly say that instead of guessing. " +
  "After using tools, provide a clear text summary with bullet points listing key findings grounded in the file contents you inspected.";

/** Try reading a file from the task directory (files/ subdir or root). */
function readFileFromDir(dir: string | undefined, path: string): string | undefined {
  if (!dir) return undefined;
  try {
    return readFileSync(`${dir}/files/${path}`, "utf-8");
  } catch {
    try {
      return readFileSync(`${dir}/${path}`, "utf-8");
    } catch {
      return undefined;
    }
  }
}

/**
 * Build the Vercel AI SDK tools record. Pure functions — no side effects on
 * state. The caller observes tool calls via the ChatResponse.tool_calls field.
 * `taskDir` enables a filesystem fallback for read_file (task files that
 * weren't preloaded into `files`); omit it for the in-memory-only HTTP route.
 */
function buildTools(
  files: Record<string, string>,
  taskDir?: string,
) {
  return {
    list_files: tool({
      description: "List all available files in the task.",
      inputSchema: z.object({}),
      execute: async () => ({ files: Object.keys(files) }),
    }),

    read_file: tool({
      description: "Read a file by its exact path.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }: { path: string }) => {
        const content = files[path] ?? readFileFromDir(taskDir, path) ?? "File not found";
        return { path, content };
      },
    }),

    search_content: tool({
      description: "Search all files for a text pattern.",
      inputSchema: z.object({ pattern: z.string() }),
      execute: async ({ pattern }: { pattern: string }) => {
        const regex = new RegExp(pattern, "gi");
        const matches: Array<{ file: string; line: number; text: string }> = [];
        for (const [fp, content] of Object.entries(files)) {
          content.split("\n").forEach((line, i) => {
            regex.lastIndex = 0;
            if (regex.test(line)) matches.push({ file: fp, line: i + 1, text: line.trim() });
          });
        }
        return { matches, total: matches.length };
      },
    }),

    extract_entities: tool({
      description: "Extract named entities from text (dates, emails, amounts, URLs, names).",
      inputSchema: z.object({
        text: z.string(),
        entity_types: z.array(z.string()).optional(),
      }),
      execute: async ({ text, entity_types }: { text: string; entity_types?: string[] }) => {
        const types = entity_types ?? ["dates", "amounts", "names", "emails"];
        const patterns: Record<string, RegExp> = {
          dates: /\b\d{4}[-/]\d{2}[-/]\d{2}\b|\b\w+ \d{1,2},? \d{4}\b/gi,
          emails: /\b[\w.-]+@[\w.-]+\.\w+\b/gi,
          amounts: /\$[\d,.]+|\b\d+(?:\.\d{2})?\s*(?:USD|EUR|dollars?|euros?)\b/gi,
          urls: /https?:\/\/\S+/gi,
          names: /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g,
        };
        const entities: Record<string, string[]> = {};
        for (const t of types) {
          const p = patterns[t];
          entities[t] = p ? (text.match(p) ?? []) : [];
        }
        return { entities };
      },
    }),

    check_rules: tool({
      description: "Check text against validation rules. Returns pass/fail for each rule.",
      inputSchema: z.object({
        text: z.string(),
        rules: z.array(z.string()),
      }),
      execute: async ({ text, rules }: { text: string; rules: string[] }) => {
        const results = rules.map((rule: string) => ({
          rule,
          mentioned: text.toLowerCase().includes(rule.toLowerCase().split(/\s+/)[0]!),
        }));
        return { results };
      },
    }),

    compute: tool({
      description: "Evaluate a mathematical expression (e.g. '150 * 0.21', 'sum of [3,5,7]').",
      inputSchema: z.object({ expression: z.string() }),
      execute: async ({ expression }: { expression: string }) => {
        const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, "");
        let resultValue: number | string;
        try {
          resultValue = Number(Function(`"use strict"; return (${sanitized})`)());
        } catch {
          resultValue = "error: could not evaluate";
        }
        return { expression, result: resultValue };
      },
    }),
  };
}

export type ChatRequest = {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  files?: Record<string, string>;
  /** Override the default system prompt. */
  system?: string;
  /** Override the default step limit (default 8). */
  maxSteps?: number;
  /** Enable OTel span emission (default true). */
  telemetry?: boolean;
  /** Task directory — enables a filesystem fallback for read_file. */
  taskDir?: string;
};

export type ChatResponse = {
  response: string;
  tool_calls: Array<{ tool: string; args: Record<string, unknown>; result: unknown }>;
  usage: { input_tokens: number; output_tokens: number } | null;
};

/**
 * Run the agent for one turn. Handles the multi-step tool-calling loop and a
 * final synthesis turn when the model ends on a tool call (so callers always
 * get a real text answer, never empty narration).
 */
export async function handleChat(request: ChatRequest): Promise<ChatResponse> {
  const client = getClient();
  const model = getModel();
  const files = request.files ?? {};
  const tools = buildTools(files, request.taskDir);
  const telemetryEnabled = request.telemetry ?? true;

  const messages: ModelMessage[] = request.messages.map((m) => ({
    role: m.role,
    content: m.content,
  })) as ModelMessage[];

  const result = await generateText({
    model: client.chat(model),
    system: request.system ?? SYSTEM_PROMPT,
    messages,
    tools,
    stopWhen: stepCountIs(request.maxSteps ?? 8),
    experimental_telemetry: { isEnabled: telemetryEnabled },
  });

  // Recover text when the model ends on a tool call or hits the step limit —
  // do NOT fall back to intermediate step text (that's chain-of-thought
  // narration, not a final answer). Instead, do one synthesis turn.
  let responseText = result.text;
  if (!responseText) {
    const synthesis = await generateText({
      model: client.chat(model),
      system: request.system ?? SYSTEM_PROMPT,
      messages: [
        ...messages,
        ...(result.response.messages as ModelMessage[]),
        {
          role: "user",
          content:
            "You have finished using tools. Now produce your final answer. " +
            "Do not call any more tools — synthesize everything you found into a clear, complete response.",
        } satisfies ModelMessage,
      ],
      experimental_telemetry: { isEnabled: telemetryEnabled },
    });
    responseText = synthesis.text;
  }

  // Set the AI SDK's response.text span attribute so the trace shows the
  // agent's actual response as the generation's output.
  if (telemetryEnabled && responseText) {
    try {
      // @ts-expect-error — @opentelemetry/api is a transitive dep of `ai`
      const { trace } = await import("@opentelemetry/api");
      const activeSpan = trace.getActiveSpan();
      if (activeSpan) activeSpan.setAttribute("ai.response.text", responseText);
    } catch {
      // opentelemetry/api not available — tracing is optional
    }
  }

  return {
    response: responseText,
    tool_calls: result.steps.flatMap((step) =>
      step.toolCalls.map((tc, i) => {
        const input = "input" in tc ? (tc as { input: Record<string, unknown> }).input : {};
        const toolResult = step.toolResults[i];
        const output =
          toolResult && "output" in toolResult
            ? (toolResult as { output: unknown }).output
            : toolResult;
        return { tool: tc.toolName, args: input as Record<string, unknown>, result: output };
      }),
    ),
    usage: result.usage
      ? { input_tokens: result.usage.inputTokens ?? 0, output_tokens: result.usage.outputTokens ?? 0 }
      : null,
  };
}
