/**
 * RAG adapter: a handbook chatbot that searches a document store through a
 * tool, then answers from the passages it found.
 *
 * The one apo-specific line is the `ctx.trace.traceRetriever` wrap around the
 * search. It records the query the model chose and the passages that came
 * back, which is the evidence `t.retrieved`, `t.not.retrieved` and
 * `t.grounded` assert on. Everything else is ordinary application code.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { defineAdapter, registerApoTracing } from "@apo-ai/sdk/agent-task";
import { loadHandbook, searchHandbook, type HandbookDocument } from "./agent/handbook-search.ts";

await registerApoTracing();

const TENANT = "northwind";

const SYSTEM_PROMPT = [
  "You answer employee questions for Northwind using only the employee handbook.",
  "Always call search_handbook first. You may search again with different keywords.",
  "Answer only with facts stated in the passages you retrieved, and cite passage ids in brackets.",
  "If the handbook does not cover something, say so.",
].join(" ");

type RagState = { corpus: HandbookDocument[]; answer: string };

export const ragAdapter = defineAdapter({
  name: "rag-handbook",
  deliverables: { answer: null },

  turn: async ({ files, transcript }) => (transcript.length > 0 ? null : files.read("question.md")),

  async initialize(ctx) {
    return { corpus: loadHandbook(ctx.files), answer: "" } satisfies RagState;
  },

  async startSession(ctx) {
    const state = ctx.state as RagState;
    const model = process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4.1-flash";
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
    const client = createOpenAI({
      apiKey,
      baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    });
    // HANDBOOK_TENANT_FILTER=off simulates the regression this task guards
    // against: a search that forgets to scope to the caller's tenant.
    const tenant = process.env.HANDBOOK_TENANT_FILTER === "off" ? undefined : TENANT;

    const searchTool = tool({
      description: "Search the employee handbook. Returns the most relevant passages with their ids.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }: { query: string }) =>
        ctx.trace.traceRetriever(query, async () => ({
          documents: searchHandbook(state.corpus, query, { tenant }),
        })),
    });

    return {
      runConfiguration: { model },
      async sendUserTurn(turn: unknown) {
        const result = await generateText({
          model: client.chat(model),
          system: SYSTEM_PROMPT,
          prompt: String(turn),
          tools: { search_handbook: searchTool },
          stopWhen: stepCountIs(4),
          experimental_telemetry: {
            isEnabled: true,
            metadata: { "apo.llm.api_provider": "openrouter" },
          },
        });
        state.answer = result.text;
        return { response: result.text };
      },
    };
  },

  async collectDeliverables(ctx) {
    return { answer: (ctx.state as RagState).answer };
  },
});
