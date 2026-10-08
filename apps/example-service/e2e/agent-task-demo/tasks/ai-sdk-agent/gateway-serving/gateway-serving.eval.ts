import { z } from "zod";
import { task, defineAdapter, createApoOpenAI } from "@apo-ai/sdk/agent-task";

// Gateway-serving proof task: a raw OpenAI-compatible agent (no Vercel AI
// SDK) wrapped with createApoOpenAI, pointed at a gateway that reports WHO
// served each call — OpenRouter's routing metadata or LiteLLM's deployment
// headers. The run's spans must carry the gateway's report
// (gen_ai.provider.name / apo.llm.route) instead of a baseURL guess.
//
// The serving-report parsing is unit-covered in
// packages/sdk/tests/integrations/gateway-serving.test.ts; the "responded"
// check below expects the scripted "Gateway-served…" reply such a mock
// gateway produces, not a live endpoint's prose.

const MODEL = process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4.1-flash";
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

const EMPTY_STATE = { reply: "" };

const gatewayAdapter = defineAdapter({
  name: "gateway-raw-openai",
  deliverables: {
    result: z.string().describe("The agent's reply through the reporting gateway."),
  },
  turn: async () => "Summarize the invoice in one sentence.",

  async initialize() {
    return { ...EMPTY_STATE };
  },

  async collectDeliverables(ctx) {
    return {
      result: ((ctx.state ?? EMPTY_STATE) as { reply?: string }).reply ?? "",
    };
  },

  async startSession(ctx) {
    // The state object initialize() returned — same reference the runner
    // hands back to collectDeliverables, so the reply written here is the
    // reply collected there (the ai-sdk-adapter pattern).
    const state = (ctx.state ?? EMPTY_STATE) as { reply?: string };

    // A minimal structural OpenAI-compatible client — the wrapper is
    // client-agnostic by design and reads withRawResponse when present.
    const post = async (params: Record<string, unknown>) =>
      fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? "none"}`,
        },
        body: JSON.stringify(params),
      });
    const client = {
      baseURL: BASE_URL,
      chat: {
        completions: {
          async create(params: Record<string, unknown>) {
            const res = await post(params);
            return await res.json();
          },
          withRawResponse: {
            async create(params: Record<string, unknown>) {
              const res = await post(params);
              const json = await res.json();
              return {
                headers: res.headers,
                async parse() {
                  return json;
                },
              };
            },
          },
        },
      },
    };

    return {
      runConfiguration: { model: MODEL },
      async sendUserTurn(turn: unknown, turnCtx) {
        const wrapped = createApoOpenAI(client, {
          trace: turnCtx.trace,
          parentSpanId: turnCtx.parentSpanId,
        });
        const response = (await wrapped.chat.completions.create({
          model: MODEL,
          messages: [{ role: "user", content: String(turn) }],
        })) as { choices?: Array<{ message?: { content?: string } }> };
        const reply = response.choices?.[0]?.message?.content ?? "";
        state.reply = reply;
        return { response: reply };
      },
    };
  },
});

const { test } = task("gateway-serving", {
  adapter: gatewayAdapter,
  description:
    "Raw OpenAI-compatible agent behind a reporting gateway — spans carry the gateway's own serving report.",
  metadata: { category: "serving-integrity", difficulty: "easy", sdk: "raw-openai" },
  maxTurns: 1,
  deliverables: ["result"],
});

test("responded", (t) => {
  t.messageIncludes("Gateway-served");
});
