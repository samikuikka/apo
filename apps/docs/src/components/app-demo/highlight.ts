/**
 * highlight — tokenizer for the prototype's code viewers, matching the
 * real dashboard CodeViewer's GitHub-dark palette exactly
 * (components/CodeViewer.tsx githubDarkHighlight + cm-apo-t-api).
 * PROTOTYPE — throwaway copy of the colors, not the engine.
 */

export interface Tok {
	readonly text: string;
	readonly cls?: "kw" | "str" | "cmt" | "api" | "num" | "fn";
}

/** The SDK's TEST_METHOD_NAMES (dashboard lib/t-api-methods.ts), for the
 * orange t.<method> colorization — same list, same longest-first order. */
const T_METHODS = [
	"calledTool",
	"notCalledTool",
	"toolOrder",
	"usedNoTools",
	"maxToolCalls",
	"noFailedActions",
	"loadedSkill",
	"calledSubagent",
	"messageIncludes",
	"maxTurns",
	"maxDurationMs",
	"maxTokens",
	"minTokens",
	"steerDelivered",
	"afterSteer",
	"assert",
	"check",
	"judge",
	"agent",
].toSorted((a, b) => b.length - a.length);

const TOKEN_RE = new RegExp(
	`(\\/\\/.*$)` + // 1 comment
		`|("(?:[^"\\\\]|\\\\.)*")` + // 2 string
		`|\\bt\\.(${T_METHODS.join("|")})\\b` + // 3 t.<method>
		`|\\b(import|from|const|let|var|async|await|return|if|else|null|true|false|export|new|type)\\b` + // 4 keyword
		`|(\\b\\d+(?:\\.\\d+)?\\b)` + // 5 number
		`|([A-Za-z_$][\\w$]*)(?=\\s*\\()`, // 6 identifier before ( → function call
	"g",
);

export function tokenizeLine(line: string): Tok[] {
	const tokens: Tok[] = [];
	let last = 0;
	for (const match of line.matchAll(TOKEN_RE)) {
		const index = match.index ?? 0;
		if (index > last) tokens.push({ text: line.slice(last, index) });
		const [full, cmt, str, api, kw, num, fn] = match;
		if (cmt !== undefined) tokens.push({ text: full, cls: "cmt" });
		else if (str !== undefined) tokens.push({ text: full, cls: "str" });
		else if (api !== undefined) tokens.push({ text: full, cls: "api" });
		else if (kw !== undefined) tokens.push({ text: full, cls: "kw" });
		else if (num !== undefined) tokens.push({ text: full, cls: "num" });
		else if (fn !== undefined) tokens.push({ text: full, cls: "fn" });
		last = index + full.length;
	}
	if (last < line.length) tokens.push({ text: line.slice(last) });
	return tokens;
}

/** True when a line carries an assertion — the real viewer marks those
 * with a (green, faded) lint-gutter dot. */
export function isAssertionLine(line: string): boolean {
	return /\bt\./.test(line);
}
