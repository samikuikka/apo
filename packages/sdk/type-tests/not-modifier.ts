import type { TestContext } from "../src/agent-task/public.ts";

declare const t: TestContext;

t.not.retrieved("acme-payroll", { topK: 5, query: "payroll" });
t.not.retrieved({ contentIncludes: "salary" });
t.not.calledTool("delete_user");
t.not.messageIncludes(/password/i);

// @ts-expect-error Judged checks carry their own polarity through `expect: "fail"`.
void t.not.judge;
// @ts-expect-error Embedding similarity is a judged check, not negatable.
void t.not.semantic;
// @ts-expect-error The agentic judge is not negatable.
void t.not.agent;
// @ts-expect-error Budgets state their own opposite.
void t.not.maxRetrievals;
// @ts-expect-error A string matcher is an id; topK must be a number.
t.retrieved("handbook", { topK: "5" });
