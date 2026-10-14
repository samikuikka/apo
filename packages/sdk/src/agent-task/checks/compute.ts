/**
 * The judge's compute tool: an arithmetic expression in, an exact value out.
 *
 * This is an expression evaluator, not a code-execution sandbox — the
 * distinction is the security model. The grammar below has numbers, four
 * arithmetic operations, remainder, exponentiation, parentheses, a fixed
 * allowlist of math functions, and two constants. A model cannot express
 * anything else: no strings, no variables, no property access, no loops, no
 * function definitions. There is no I/O to forbid and nothing to time out —
 * evaluation is a single linear pass whose only recursion is bounded by the
 * expression-length cap, with parenthesization nesting tracked explicitly.
 *
 * Failures are honest return values (an `{ error }` with the allowlist, the
 * cap, or the offending operation in the message) so the judge can rephrase,
 * never exceptions past the tool boundary.
 */

// ── Public surface ─────────────────────────────────────────────────────────

/** A successful evaluation: the raw IEEE-754 double and a display form. */
export type ComputeSuccess = { value: number; text: string };

/** Every way an expression fails to evaluate. Never thrown. */
export type ComputeResult = ComputeSuccess | { error: string };

/** Input-length cap; re-checked here although the tool schema also enforces it. */
export const COMPUTE_MAX_EXPR = 512;

/** Maximum parenthesization / function-argument nesting depth. */
export const COMPUTE_MAX_DEPTH = 64;

/**
 * Evaluate one arithmetic expression. Pure: no I/O, no ambient state, never
 * throws. `text` normalizes the double to at most 12 significant digits so a
 * judge comparing against human-stated figures ("3.5%") is not eyeballing
 * IEEE remainder digits (`3.4013605442176873` → `"3.40136054422"`,
 * `0.30000000000000004` → `"0.3"`); `value` keeps the exact double.
 */
export function evaluateComputeExpression(expression: string): ComputeResult {
  if (typeof expression !== "string" || expression.length === 0) {
    return { error: "empty expression" };
  }
  if (expression.length > COMPUTE_MAX_EXPR) {
    return { error: `expression too long (max ${COMPUTE_MAX_EXPR} chars)` };
  }
  try {
    const tokens = tokenize(expression);
    const parser = new Parser(tokens);
    const value = parser.parseExpression(0);
    parser.expectEnd();
    // The walk already rejects non-finite intermediates; this guards the
    // single top-level result for the same guarantee.
    if (!Number.isFinite(value)) {
      return { error: "result is not finite" };
    }
    return { value, text: Number(value.toPrecision(12)).toString() };
  } catch (error) {
    return { error: error instanceof ComputeError ? error.message : String(error) };
  }
}

// ── Tokenizer ──────────────────────────────────────────────────────────────

type Token =
  | { kind: "number"; value: number; pos: number }
  | { kind: "ident"; name: string; pos: number }
  | { kind: "op"; op: string; pos: number };

class ComputeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputeError";
  }
}

function fail(message: string, pos?: number): never {
  throw new ComputeError(pos === undefined ? message : `${message} at position ${pos + 1}`);
}

const OPERATOR_CHARS = new Set(["+", "-", "*", "/", "%", "^", "(", ")", ","]);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i]!;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(input[i + 1] ?? ""))) {
      const start = i;
      while (i < input.length && /[0-9]/.test(input[i]!)) i += 1;
      if (input[i] === ".") {
        i += 1;
        if (!/[0-9]/.test(input[i] ?? "")) fail(`malformed number '${input.slice(start, i)}…'`, start);
        while (i < input.length && /[0-9]/.test(input[i]!)) i += 1;
      }
      if (input[i] === "e" || input[i] === "E") {
        let j = i + 1;
        if (input[j] === "+" || input[j] === "-") j += 1;
        if (!/[0-9]/.test(input[j] ?? "")) fail(`malformed number '${input.slice(start, i + 1)}…'`, start);
        i = j;
        while (i < input.length && /[0-9]/.test(input[i]!)) i += 1;
      }
      const text = input.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) fail(`number '${text}' is not representable`, start);
      tokens.push({ kind: "number", value, pos: start });
      continue;
    }
    if (/[a-z]/.test(char)) {
      // Function names include digits (log10): letters first, then letters or
      // digits — never digits first, which the number branch above owns.
      const start = i;
      while (i < input.length && /[a-z0-9]/.test(input[i]!)) i += 1;
      tokens.push({ kind: "ident", name: input.slice(start, i), pos: start });
      continue;
    }
    if (OPERATOR_CHARS.has(char)) {
      tokens.push({ kind: "op", op: char, pos: i });
      i += 1;
      continue;
    }
    fail(`unexpected character '${char}'`, i);
  }
  return tokens;
}

// ── Parser (precedence climbing, evaluated inline) ─────────────────────────

const ADDITIVE_BP = 1;
const MULTIPLICATIVE_BP = 2;
// Unary +/- sits between multiplication and exponentiation so that -3^2
// negates the power (−9) while 2^-3 still parses the exponent (0.125).
const UNARY_BP = 3;
const POWER_BP = 4;

function assertFinite(operation: string, value: number): number {
  if (!Number.isFinite(value)) {
    fail(`${operation} produced a non-finite value`);
  }
  return value;
}

function divide(a: number, b: number): number {
  if (b === 0) fail("division by zero");
  return assertFinite("/", a / b);
}

function remainder(a: number, b: number): number {
  if (b === 0) fail("division by zero");
  return assertFinite("%", a % b);
}

const BINARY_OPS: Record<string, { bp: number; rightAssoc?: boolean; apply: (a: number, b: number) => number }> = {
  "+": { bp: ADDITIVE_BP, apply: (a, b) => assertFinite("+", a + b) },
  "-": { bp: ADDITIVE_BP, apply: (a, b) => assertFinite("-", a - b) },
  "*": { bp: MULTIPLICATIVE_BP, apply: (a, b) => assertFinite("*", a * b) },
  "/": { bp: MULTIPLICATIVE_BP, apply: divide },
  "%": { bp: MULTIPLICATIVE_BP, apply: remainder },
  "^": { bp: POWER_BP, rightAssoc: true, apply: (a, b) => assertFinite("^", Math.pow(a, b)) },
};

type ComputeFunction = { minArgs: number; maxArgs: number; apply: (args: number[]) => number };

const FUNCTION_NAMES = "abs, ceil, floor, round, sqrt, cbrt, exp, ln, log10, min, max, pow";
const CONSTANT_NAMES = "pi, e";

const FUNCTIONS: Record<string, ComputeFunction> = {
  abs: { minArgs: 1, maxArgs: 1, apply: ([x]) => assertFinite("abs", Math.abs(x!)) },
  ceil: { minArgs: 1, maxArgs: 1, apply: ([x]) => assertFinite("ceil", Math.ceil(x!)) },
  floor: { minArgs: 1, maxArgs: 1, apply: ([x]) => assertFinite("floor", Math.floor(x!)) },
  round: {
    minArgs: 1,
    maxArgs: 2,
    apply: (args) => {
      const [x, dp = 0] = args as [number, number?];
      if (!Number.isInteger(dp) || dp < 0 || dp > 12) {
        fail("round's decimal places must be an integer from 0 to 12");
      }
      return assertFinite("round", Math.round(x! * 10 ** dp!) / 10 ** dp!);
    },
  },
  sqrt: { minArgs: 1, maxArgs: 1, apply: ([x]) => assertFinite("sqrt", Math.sqrt(x!)) },
  cbrt: { minArgs: 1, maxArgs: 1, apply: ([x]) => assertFinite("cbrt", Math.cbrt(x!)) },
  exp: { minArgs: 1, maxArgs: 1, apply: ([x]) => assertFinite("exp", Math.exp(x!)) },
  ln: { minArgs: 1, maxArgs: 1, apply: ([x]) => assertFinite("ln", Math.log(x!)) },
  log10: { minArgs: 1, maxArgs: 1, apply: ([x]) => assertFinite("log10", Math.log10(x!)) },
  min: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER, apply: (args) => assertFinite("min", Math.min(...args)) },
  max: { minArgs: 1, maxArgs: Number.MAX_SAFE_INTEGER, apply: (args) => assertFinite("max", Math.max(...args)) },
  pow: {
    minArgs: 2,
    maxArgs: 2,
    apply: ([a, b]) => assertFinite("pow", Math.pow(a!, b!)),
  },
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

class Parser {
  private next = 0;
  private depth = 0;
  private readonly tokens: Token[];

  // Explicit assignment, not a parameter property: the SDK must stay runnable
  // under `node --experimental-strip-types` (erasable syntax only), which is
  // how the CLI and every spawned scene test load it.
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parseExpression(minBp: number): number {
    let left = this.parsePrefix();
    for (;;) {
      const token = this.tokens[this.next];
      if (!token || token.kind !== "op") break;
      const op = BINARY_OPS[token.op];
      if (!op || op.bp < minBp) break;
      this.next += 1;
      // Left-associative chains fold left by demanding strictly higher
      // precedence on the right; ^ is right-associative and demands equal.
      const rightMinBp = op.rightAssoc ? op.bp : op.bp + 1;
      left = op.apply(left, this.parseExpression(rightMinBp));
    }
    return left;
  }

  private parsePrefix(): number {
    const token = this.tokens[this.next];
    if (token?.kind === "op" && (token.op === "+" || token.op === "-")) {
      this.next += 1;
      const operand = this.parseExpression(UNARY_BP);
      return token.op === "-" ? -operand : operand;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.tokens[this.next];
    if (!token) fail("unexpected end of expression");
    if (token.kind === "number") {
      this.next += 1;
      return token.value;
    }
    if (token.kind === "ident") {
      this.next += 1;
      if (this.consumeOp("(")) return this.parseCall(token.name, token.pos);
      if (token.name in CONSTANTS) return CONSTANTS[token.name]!;
      fail(
        `unknown identifier '${token.name}' — constants: ${CONSTANT_NAMES}; functions: ${FUNCTION_NAMES}`,
        token.pos,
      );
    }
    if (token.kind === "op" && token.op === "(") {
      this.next += 1;
      const value = this.nested(() => this.parseExpression(0));
      this.expectOp(")");
      return value;
    }
    fail(`unexpected '${describe(token)}'`, token.pos);
  }

  private parseCall(name: string, namePos: number): number {
    const fn = FUNCTIONS[name];
    if (!fn) {
      fail(`unknown function '${name}' — allowed: ${FUNCTION_NAMES}`, namePos);
    }
    const args = this.nested(() => this.parseArguments());
    if (args.length < fn.minArgs || args.length > fn.maxArgs) {
      const arity = fn.minArgs === fn.maxArgs ? String(fn.minArgs) : `${fn.minArgs}–${fn.maxArgs}`;
      fail(`${name} expects ${arity} argument(s), got ${args.length}`);
    }
    return fn.apply(args);
  }

  private parseArguments(): number[] {
    if (this.consumeOp(")")) return [];
    const args: number[] = [this.parseExpression(0)];
    while (this.consumeOp(",")) {
      args.push(this.parseExpression(0));
    }
    this.expectOp(")");
    return args;
  }

  // Parentheses and function arguments are the only unbounded nesting; the
  // depth counter rejects past the cap before the recursion can grow. Every
  // other descent (operators, unary chains, right-associative powers) is
  // bounded by the 512-char input cap alone.
  private nested<T>(body: () => T): T {
    this.depth += 1;
    if (this.depth > COMPUTE_MAX_DEPTH) {
      fail(`expression nests too deeply (max ${COMPUTE_MAX_DEPTH})`);
    }
    try {
      return body();
    } finally {
      this.depth -= 1;
    }
  }

  private consumeOp(op: string): boolean {
    const token = this.tokens[this.next];
    if (token?.kind === "op" && token.op === op) {
      this.next += 1;
      return true;
    }
    return false;
  }

  private expectOp(op: string): void {
    if (!this.consumeOp(op)) {
      const token = this.tokens[this.next];
      fail(`expected '${op}' but found ${token ? `'${describe(token)}'` : "end of expression"}`, token?.pos);
    }
  }

  expectEnd(): void {
    const token = this.tokens[this.next];
    if (token) fail(`unexpected '${describe(token)}' after the expression`, token.pos);
  }
}

function describe(token: Token): string {
  if (token.kind === "number") return String(token.value);
  if (token.kind === "ident") return token.name;
  return token.op;
}
