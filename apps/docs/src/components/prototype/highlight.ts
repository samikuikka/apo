/**
 * highlight — a deliberately tiny tokenizer for the prototype's code
 * viewers (.eval.ts and JSON payloads). Syntax colorization is a
 * documented exception to the monochrome rule (docs/design.md); keep the
 * palette to the five token classes here and nowhere else.
 */

export interface Tok {
	readonly text: string;
	readonly cls?: "kw" | "str" | "cmt" | "api" | "num";
}

const TOKEN_RE =
	/(\/\/.*$)|("(?:[^"\\]|\\.)*")|\b(import|from|const|async|await|return|if|null|true|false)\b|(\bt\.\w+)|(\b\d+(?:\.\d+)?\b)/g;

export function tokenizeLine(line: string): Tok[] {
	const tokens: Tok[] = [];
	let last = 0;
	for (const match of line.matchAll(TOKEN_RE)) {
		const index = match.index ?? 0;
		if (index > last) tokens.push({ text: line.slice(last, index) });
		const [full, cmt, str, kw, api, num] = match;
		if (cmt !== undefined) tokens.push({ text: full, cls: "cmt" });
		else if (str !== undefined) tokens.push({ text: full, cls: "str" });
		else if (kw !== undefined) tokens.push({ text: full, cls: "kw" });
		else if (api !== undefined) tokens.push({ text: full, cls: "api" });
		else if (num !== undefined) tokens.push({ text: full, cls: "num" });
		last = index + full.length;
	}
	if (last < line.length) tokens.push({ text: line.slice(last) });
	return tokens;
}
