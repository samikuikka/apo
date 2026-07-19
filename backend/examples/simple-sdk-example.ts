#!/usr/bin/env ts-node
/**
 * MINIMAL SDK EXAMPLE
 *
 * The simplest possible example of using the apo SDK: trace a single LLM call.
 *
 * To run:
 * 1. Start the backend: cd backend && uv run uvicorn apo.api:app --reload --port 8000
 * 2. npm install openai @apo/sdk
 * 3. npx ts-node simple-sdk-example.ts
 */

import OpenAI from "openai";
import { createClient } from "@apo/sdk";

const ENDPOINT = process.env.APO_BACKEND_URL ?? "http://localhost:8000";

const client = createClient({
  project: process.env.APO_PROJECT ?? "simple-example",
  endpoint: ENDPOINT,
  publicKey: process.env.APO_PUBLIC_KEY,
  secretKey: process.env.APO_SECRET_KEY,
});

const llm = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "sk-test-key" });

async function main() {
  console.log("Tracing a single LLM call...\n");

  const joke = await client.traceRun(
    { flow_name: "joke-flow" },
    async (trace) => {
      const result = await trace.step(
        { step_name: "create-joke" },
        async () => {
          const res = await llm.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are a helpful assistant." },
              { role: "user", content: "Tell me a joke about programming" },
            ],
          });
          return res.choices[0]?.message?.content ?? "";
        },
      );
      trace.endRoot();
      return result;
    },
  );

  console.log("Response:\n");
  console.log(joke);
  console.log("\nThis run was traced to apo. View it in the dashboard or:");
  console.log(`  curl ${ENDPOINT}/v1/runs`);
}

main().catch((error) => {
  console.error("Error:", error);
  console.error("\nMake sure the backend is running: uvicorn apo.api:app --reload --port 8000");
});
