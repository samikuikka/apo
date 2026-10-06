/**
 * capability-sim — the scripted fixture behind the landing-page prototype.
 *
 * One task ("process-refund-request") flows through apo's whole loop:
 * the spec, a run of the real harness, the test verdict with judge
 * evidence, the trace, and two evidence-grounded harness fixes that take
 * the graded signal 3/5 → 4/5 → 5/5.
 *
 * Everything here is pure data + derivation. The hook (use-capability-sim)
 * drives it on a clock; panels render it. Product vocabulary follows
 * PROJECT-BELIEFS.md: binary per-run verdict, graded signal across runs,
 * deterministic tests and judged tests as the same kind of thing.
 */

export type TestKind = "code" | "judged";

export type TestId =
	| "refund-issued-once"
	| "refund-within-policy"
	| "reply-is-well-formed"
	| "reply-addresses-the-complaint"
	| "reply-tone-takes-ownership";

export interface TestDef {
	readonly id: TestId;
	readonly kind: TestKind;
	readonly label: string;
	/** Assertion summary shown under a settled test row. */
	readonly assertionSummary: readonly string[];
}

export const TESTS: readonly TestDef[] = [
	{
		id: "refund-issued-once",
		kind: "code",
		label: "refund-issued-once",
		assertionSummary: ['calledTool issue_refund { order: "ord-8841" } ×1', "noFailedActions"],
	},
	{
		id: "refund-within-policy",
		kind: "code",
		label: "refund-within-policy",
		assertionSummary: ["check refund.amount ≤ order.total ($84.00)", "order inside 30-day window (6 days)"],
	},
	{
		id: "reply-is-well-formed",
		kind: "code",
		label: "reply-is-well-formed",
		assertionSummary: ["check reply ~ replySchema", "greeting · order ref · amount · timeline"],
	},
	{
		id: "reply-addresses-the-complaint",
		kind: "judged",
		label: "reply-addresses-the-complaint",
		assertionSummary: [],
	},
	{
		id: "reply-tone-takes-ownership",
		kind: "judged",
		label: "reply-tone-takes-ownership",
		assertionSummary: [],
	},
];

/** Harness fixes the Loop panel can apply, in loop order. */
export type FixId = "email-body" | "tone-guide";

export interface FixDef {
	readonly id: FixId;
	readonly requires?: FixId;
	readonly title: string;
	/** The concrete change, file-level, like a commit subject. */
	readonly change: string;
	/** Judge quote that motivates the fix — the "from evidence" half. */
	readonly evidence: string;
	readonly rationale: string;
}

export const FIXES: readonly FixDef[] = [
	{
		id: "email-body",
		title: "Feed the agent the full email",
		change: "supportInboxAdapter.ts — pass the message body, not just the subject line",
		evidence:
			"“The reply confirms a refund was issued but never acknowledges the damaged grinder, the safety concern, or the chargeback worry. It is a form letter.”",
		rationale:
			"The agent never saw the complaint — the adapter dropped the body. This is a wiring problem, not a prompt problem, and no prompt can fix it.",
	},
	{
		id: "tone-guide",
		requires: "email-body",
		title: "Add a tone guide to the system prompt",
		change: "system prompt — own the shipping failure, drop “per policy”, sign off like a person",
		evidence:
			"“Ownership is still missing: ‘per policy … has been authorized’ reads procedural. No apology, no warmth.”",
		rationale:
			"Now the agent knows the facts but still writes like a printer. Tell it what taking ownership sounds like.",
	},
];

export type VersionId = 1 | 2 | 3;

export const VERSION_LABELS: Readonly<Record<VersionId, string>> = {
	1: "as shipped",
	2: "+ full email in context",
	3: "+ tone guide",
};

/** A span in the run script. Times are ms from run start. */
export interface SpanScript {
	readonly id: string;
	readonly depth: 0 | 1;
	readonly kind: "generation" | "tool";
	readonly name: string;
	readonly model?: string;
	readonly tokens?: number;
	readonly input?: string;
	readonly output?: string;
	readonly startAt: number;
	readonly durMs: number;
}

export interface RunScript {
	readonly version: VersionId;
	readonly runId: string;
	readonly traceId: string;
	readonly totalMs: number;
	readonly spans: readonly SpanScript[];
	/** The reply deliverable, line by line (the thing the judges grade). */
	readonly reply: readonly string[];
	readonly refundReceipt: string;
	readonly meta: { readonly duration: string; readonly tokens: string; readonly cost: string };
}

const AGENT_MODEL = "deepseek/deepseek-v4.1-flash";
const JUDGE_MODEL = "deepseek/deepseek-v4.1-flash";

const ORDER_JSON = `{
  "order": "ord-8841",
  "item": "Baratza Encore grinder",
  "total": 84.0,
  "placed": "2026-09-27",
  "status": "delivered"
}`;

const POLICY_JSON = `{
  "reason": "damaged_in_shipping",
  "window_days": 30,
  "days_since_delivery": 6,
  "refund": "full",
  "return_required": false
}`;

const REFUND_JSON = `{
  "refund": "ref_9xk2m4",
  "order": "ord-8841",
  "amount": 84.0,
  "eta": "5-7 business days"
}`;

const REPLY_V1 = [
	"Hello,",
	"",
	"Your refund for order ord-8841 has been processed. $84.00 will be",
	"returned to your original payment method within 5-7 business days.",
	"",
	"Customer Support",
];

const REPLY_V2 = [
	"Hello Dana,",
	"",
	"This message confirms your refund request for order ord-8841 has been",
	"reviewed. Per policy for items damaged in shipping, a refund of $84.00",
	"has been authorized to your original payment method. Processing time is",
	"5-7 business days. A chargeback is unnecessary. Do not use the damaged unit.",
	"",
	"Customer Support",
];

const REPLY_V3 = [
	"Hi Dana,",
	"",
	"I'm so sorry your Encore arrived with a cracked base — that's not the",
	"unboxing your dad should get for his birthday, and I understand the",
	"worry about those metal shavings. Please don't use it; unplug it and set",
	"it aside, and there's no need to ship anything back.",
	"",
	"I've issued a full refund of $84.00 to your original payment method",
	"(ref_9xk2m4). You'll see it within 5-7 business days, so there's no",
	"reason to dispute the charge.",
	"",
	"If anything else arrives less than perfect, you know where to find me.",
	"",
	"— Priya, Support",
];

const REASONING_V1 =
	"Subject line says damaged item on ord-8841. A refund is the safe path: look up the order, confirm the policy window, issue the refund, confirm to the customer.";

const REASONING_V2 =
	"The customer reports a cracked base and metal shavings, worries the unit is unsafe, and is considering a chargeback. Verify the order, confirm damage-in-shipping policy, refund in full, and address the safety and chargeback points explicitly.";

const REASONING_MID =
	"Order ord-8841: $84.00, delivered 6 days ago — inside the 30-day damage window. Full refund eligible, no return required. Issue $84.00.";

function buildSpans(version: VersionId): SpanScript[] {
	const reply = version === 1 ? REPLY_V1 : version === 2 ? REPLY_V2 : REPLY_V3;
	const firstReasoning = version === 1 ? REASONING_V1 : REASONING_V2;
	const g1Tokens = version === 1 ? 212 : 268;
	const g1Dur = version === 1 ? 1800 : 2100;
	const g3Tokens = version === 1 ? 148 : version === 2 ? 204 : 262;
	const g3Dur = version === 1 ? 1900 : 2200;

	return [
		{
			id: "span-1",
			depth: 1,
			kind: "generation",
			name: "reason about the request",
			model: AGENT_MODEL,
			tokens: g1Tokens,
			output: firstReasoning,
			startAt: 200,
			durMs: g1Dur,
		},
		{
			id: "span-2",
			depth: 1,
			kind: "tool",
			name: "get_order",
			input: '{ order: "ord-8841" }',
			output: ORDER_JSON,
			startAt: 2100,
			durMs: 170,
		},
		{
			id: "span-3",
			depth: 1,
			kind: "tool",
			name: "check_policy",
			input: '{ order: "ord-8841", reason: "damaged_in_shipping" }',
			output: POLICY_JSON,
			startAt: 2350,
			durMs: 150,
		},
		{
			id: "span-4",
			depth: 1,
			kind: "generation",
			name: "decide the refund",
			model: AGENT_MODEL,
			tokens: 96,
			output: REASONING_MID,
			startAt: 2600,
			durMs: 1400,
		},
		{
			id: "span-5",
			depth: 1,
			kind: "tool",
			name: "issue_refund",
			input: '{ order: "ord-8841", amount: 84.0 }',
			output: REFUND_JSON,
			startAt: 4100,
			durMs: 410,
		},
		{
			id: "span-6",
			depth: 1,
			kind: "generation",
			name: "write the reply",
			model: AGENT_MODEL,
			tokens: g3Tokens,
			output: reply.join("\n"),
			startAt: 4700,
			durMs: g3Dur,
		},
	];
}

const RUN_META: Readonly<Record<VersionId, RunScript["meta"]>> = {
	1: { duration: "7.3s", tokens: "1,842", cost: "$0.0417" },
	2: { duration: "8.1s", tokens: "1,976", cost: "$0.0458" },
	3: { duration: "8.4s", tokens: "2,061", cost: "$0.0479" },
};

const RUN_IDS: Readonly<Record<VersionId, { runId: string; traceId: string }>> = {
	1: { runId: "run_6b41c8e9a2f4", traceId: "f1a3e9c0d5e6" },
	2: { runId: "run_9d77b2c4e8f1", traceId: "7c21ab9f4e5d" },
	3: { runId: "run_44be1d7fa3c9", traceId: "a5f0c8d2b7e4" },
};

export function buildRunScript(version: VersionId): RunScript {
	const spans = buildSpans(version);
	const ids = RUN_IDS[version];
	const last = spans[spans.length - 1]!;
	return {
		version,
		runId: ids.runId,
		traceId: ids.traceId,
		totalMs: last.startAt + last.durMs + 600,
		spans,
		reply: version === 1 ? REPLY_V1 : version === 2 ? REPLY_V2 : REPLY_V3,
		refundReceipt: REFUND_JSON,
		meta: RUN_META[version],
	};
}

/** Judge evidence for one judged test under one harness version. */
export interface JudgeScript {
	readonly model: string;
	readonly rubric: string;
	/** Reasoning excerpts, streamed while judging. */
	readonly reasoning: readonly string[];
	/** The verdict card quote (what the judge concluded). */
	readonly quote: string;
	/** Second-judge corroboration mark, tests.mdx vocabulary. */
	readonly secondJudge?: { readonly mark: string; readonly note: string };
}

export interface TestOutcomeScript {
	readonly verdict: "pass" | "fail";
	readonly judge?: JudgeScript;
}

const RUBRIC_COMPLAINT =
	"PASS when the reply acknowledges the damage and answers the chargeback concern.";

const RUBRIC_TONE =
	"PASS when the tone takes ownership of the failure — never asks the customer to prove fault.";

const OUTCOMES: Readonly<Record<VersionId, Readonly<Record<TestId, TestOutcomeScript>>>> = {
	1: {
		"refund-issued-once": { verdict: "pass" },
		"refund-within-policy": { verdict: "pass" },
		"reply-is-well-formed": { verdict: "pass" },
		"reply-addresses-the-complaint": {
			verdict: "fail",
			judge: {
				model: JUDGE_MODEL,
				rubric: RUBRIC_COMPLAINT,
				reasoning: ["Scanning the reply for the reported damage…", "It names the order and the amount — no damage, no safety worry, no chargeback answer."],
				quote:
					"The reply confirms a refund was issued but never acknowledges the damaged grinder, the safety concern, or the chargeback worry. It is a form letter.",
			},
		},
		"reply-tone-takes-ownership": {
			verdict: "fail",
			judge: {
				model: JUDGE_MODEL,
				rubric: RUBRIC_TONE,
				reasoning: ["Reading the reply as the customer would…", "“Your refund … has been processed” is a notice, not an answer to a person."],
				quote:
					"The tone is transactional. No ownership of the shipping failure, no apology, no warmth toward a gift missed.",
				secondJudge: {
					mark: "✓✗ 0.99",
					note: "Verdicts differ — second judge contradicts at 0.99 confidence. A judged test this borderline deserves a sharper rubric.",
				},
			},
		},
	},
	2: {
		"refund-issued-once": { verdict: "pass" },
		"refund-within-policy": { verdict: "pass" },
		"reply-is-well-formed": { verdict: "pass" },
		"reply-addresses-the-complaint": {
			verdict: "pass",
			judge: {
				model: JUDGE_MODEL,
				rubric: RUBRIC_COMPLAINT,
				reasoning: ["Scanning the reply for the reported damage…", "It warns against use, confirms the refund, removes the chargeback worry."],
				quote:
					"The reply names the damage, warns against using the unit, and answers the chargeback concern directly. PASS.",
			},
		},
		"reply-tone-takes-ownership": {
			verdict: "fail",
			judge: {
				model: JUDGE_MODEL,
				rubric: RUBRIC_TONE,
				reasoning: ["Reading the reply as the customer would…", "The facts are all there, but the voice is procedural: “per policy …”."],
				quote:
					"Ownership is still missing: “per policy … has been authorized” reads procedural. No apology, no sign-off like a person.",
			},
		},
	},
	3: {
		"refund-issued-once": { verdict: "pass" },
		"refund-within-policy": { verdict: "pass" },
		"reply-is-well-formed": { verdict: "pass" },
		"reply-addresses-the-complaint": {
			verdict: "pass",
			judge: {
				model: JUDGE_MODEL,
				rubric: RUBRIC_COMPLAINT,
				reasoning: ["Scanning the reply for the reported damage…", "Cracked base, shavings, the birthday, the chargeback — all answered."],
				quote:
					"The reply addresses the damage and the safety worry by name and closes the loop on the chargeback. PASS.",
			},
		},
		"reply-tone-takes-ownership": {
			verdict: "pass",
			judge: {
				model: JUDGE_MODEL,
				rubric: RUBRIC_TONE,
				reasoning: ["Reading the reply as the customer would…", "“Not the unboxing your dad should get” — that is ownership."],
				quote:
					"The tone owns the failure, is warm without being performative, and never asks the customer to prove fault. PASS.",
			},
		},
	},
};

export function outcomeFor(version: VersionId, testId: TestId): TestOutcomeScript {
	return OUTCOMES[version][testId];
}

/** Graded signal for a completed run: raw counts over the suite as it ran. */
export function gradedSignal(version: VersionId): { passed: number; total: number } {
	let passed = 0;
	for (const test of TESTS) {
		if (OUTCOMES[version][test.id].verdict === "pass") passed += 1;
	}
	return { passed, total: TESTS.length };
}

/** Live verdict over the enabled subset — the suite is the standard. */
export function verdictFor(version: VersionId, enabled: Readonly<Record<TestId, boolean>>): {
	passed: number;
	total: number;
	verdict: "pass" | "fail";
} {
	let passed = 0;
	let total = 0;
	for (const test of TESTS) {
		if (!enabled[test.id]) continue;
		total += 1;
		if (OUTCOMES[version][test.id].verdict === "pass") passed += 1;
	}
	return { passed, total, verdict: total > 0 && passed === total ? "pass" : "fail" };
}

export function versionForFixes(applied: readonly FixId[]): VersionId {
	if (applied.includes("tone-guide")) return 3;
	if (applied.includes("email-body")) return 2;
	return 1;
}

/**
 * The .eval.ts fixture as displayed by the Spec panel. Test blocks render
 * from TESTS order; the head is fixed prose. Kept as data so the panel can
 * interleave toggles with code lines.
 */
export const SPEC_HEAD_LINES = [
	"import { matches, task, turn } from \"@apo-ai/sdk/agent-task\";",
	"",
	"const { test } = task(\"process-refund-request\", {",
	"  adapter: supportInboxAdapter,",
	"  deliverables: [\"reply\", \"refund\"],",
	"});",
	"",
	"turn(async ({ files, transcript }) =>",
	"  transcript.length > 0 ? null : await files.read(\"inbound-8841.eml\"),",
	");",
];

export function specBlockLines(test: TestDef): string[] {
	switch (test.id) {
		case "refund-issued-once":
			return [
				"test(\"refund-issued-once\", (t) => {",
				"  t.calledTool(\"issue_refund\", { input: { order: \"ord-8841\" } });",
				"  t.noFailedActions();",
				"});",
			];
		case "refund-within-policy":
			return [
				"test(\"refund-within-policy\", (t, { deliverables }) => {",
				"  t.check(deliverables.refund.amount, matches({ atMost: 84.0 }));",
				"});",
			];
		case "reply-is-well-formed":
			return [
				"test(\"reply-is-well-formed\", (t, { deliverables }) => {",
				"  t.check(deliverables.reply, matches(replySchema));",
				"});",
			];
		case "reply-addresses-the-complaint":
			return [
				"test(\"reply-addresses-the-complaint\", async (t, { deliverables }) => {",
				"  await t.judge(deliverables.reply,",
				"    \"PASS when the reply acknowledges the damage and the chargeback concern.\");",
				"});",
			];
		case "reply-tone-takes-ownership":
			return [
				"test(\"reply-tone-takes-ownership\", async (t, { deliverables }) => {",
				"  await t.judge(deliverables.reply,",
				"    \"PASS when the tone takes ownership of the failure.\");",
				"});",
			];
	}
}

/** The customer email the agent reads — shown in the Run panel's input. */
export const INBOUND_EMAIL = [
	"From: Dana Whitfield <dana@example.com>",
	"Subject: Order arrived damaged — ord-8841",
	"",
	"Hi — my Baratza Encore grinder arrived Tuesday with a cracked base",
	"and metal shavings loose in the housing. I'm worried about plugging",
	"it in at all. It was a gift for my father's birthday on the 12th and",
	"I'd rather not have to dispute the charge to make it right.",
	"",
	"— Dana",
];
