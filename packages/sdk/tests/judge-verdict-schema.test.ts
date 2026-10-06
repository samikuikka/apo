/**
 * The judge's verdict is bound by the decoder, and a reply without one is never
 * a FAIL.
 *
 * Measured on a production battery (4,309 judged checks on deepseek-v4.1-flash
 * via Fireworks): under `json_object`, 25 replies were `{"reasoning": "..."}` with
 * no `pass` key, and the old `parsed.pass === true` recorded each as FAIL even
 * though 19 of their reasonings concluded the criterion was satisfied. No reply
 * carried an explicit verdict that contradicted its reasoning.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { callJudge } from "../src/agent-task/checks/judge.ts";

const judgeArgs = {
  values: ["the deliverable"],
  instruction: "Is it good?",
  model: "test/judge",
  baseURL: "https://judge.test/v1",
  apiKey: "secret",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubReplies(...replies: Array<string | Response>): vi.Mock {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const reply = replies[Math.min(call++, replies.length - 1)]!;
    return typeof reply === "string"
      ? Response.json({ choices: [{ message: { content: reply } }] })
      : reply;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestFormat(fetchMock: vi.Mock, call = 0): Record<string, unknown> {
  const body = JSON.parse(fetchMock.mock.calls[call]?.[1]?.body as string) as {
    response_format: Record<string, unknown>;
  };
  return body.response_format;
}

describe("judge verdict schema", () => {
  it("binds reasoning and pass with a strict schema, reasoning first", async () => {
    const fetchMock = stubReplies('{"reasoning": "ok", "pass": true}');
    await callJudge(judgeArgs);
    const format = requestFormat(fetchMock) as {
      type: string;
      json_schema: { strict: boolean; schema: { properties: object; required: string[] } };
    };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.strict).toBe(true);
    expect(Object.keys(format.json_schema.schema.properties)).toEqual(["reasoning", "pass"]);
    expect(format.json_schema.schema.required).toEqual(["reasoning", "pass"]);
  });

  it("keeps the verdict-first key order under APO_JUDGE_VERDICT_FIRST", async () => {
    vi.stubEnv("APO_JUDGE_VERDICT_FIRST", "1");
    const fetchMock = stubReplies('{"pass": true, "reasoning": "ok"}');
    await callJudge(judgeArgs);
    const format = requestFormat(fetchMock) as {
      json_schema: { schema: { properties: object } };
    };
    expect(Object.keys(format.json_schema.schema.properties)).toEqual(["pass", "reasoning"]);
  });

  it("redraws a reply that carries no verdict and keeps the second draw's verdict", async () => {
    const fetchMock = stubReplies(
      '{"reasoning": "The memo states it. This satisfies the criterion."}',
      '{"reasoning": "The memo states it.", "pass": true}',
    );
    const result = await callJudge(judgeArgs);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.pass).toBe(true);
    expect(result.unavailable).toBeUndefined();
    expect(result.reasoning).toBe("The memo states it.");
  });

  it("records a judge error, not a FAIL, when no draw carries a verdict", async () => {
    const fetchMock = stubReplies('{"reasoning": "satisfied"}');
    const result = await callJudge(judgeArgs);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.unavailable).toBe(true);
    expect(result.reasoning).toContain("no verdict");
    expect(result.judge.response).toBe('{"reasoning": "satisfied"}');
  });

  it("does not read a non-boolean pass as a verdict", async () => {
    stubReplies('{"reasoning": "fine", "pass": "true"}');
    const result = await callJudge(judgeArgs);
    expect(result.unavailable).toBe(true);
  });

  it("keeps an explicit false as a FAIL verdict", async () => {
    const fetchMock = stubReplies('{"reasoning": "missing the date", "pass": false}');
    const result = await callJudge(judgeArgs);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.pass).toBe(false);
    expect(result.unavailable).toBeUndefined();
  });

  it("falls back to json_object when the endpoint rejects json_schema", async () => {
    const fetchMock = stubReplies(
      new Response('{"error": "response_format json_schema is not supported"}', { status: 400 }),
      '{"reasoning": "ok", "pass": true}',
    );
    const result = await callJudge(judgeArgs);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestFormat(fetchMock, 0)).toMatchObject({ type: "json_schema" });
    expect(requestFormat(fetchMock, 1)).toEqual({ type: "json_object" });
    expect(result.pass).toBe(true);
  });

  it("asks the judge to quote with single quotes", async () => {
    const fetchMock = stubReplies('{"reasoning": "ok", "pass": true}');
    await callJudge(judgeArgs);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      messages: Array<{ content: Array<{ text: string }> | string }>;
    };
    const system = body.messages[0]!.content as Array<{ text: string }>;
    expect(system[0]!.text).toContain("quote the output with single quotes");
  });
});
