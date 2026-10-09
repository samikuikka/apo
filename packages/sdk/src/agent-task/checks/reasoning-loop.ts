/**
 * Degenerate-repetition guard for a streamed judge reply. A reasoning model
 * that cannot decide can fall into a loop in its hidden reasoning — argue
 * back and forth, then emit "Hmm. Hmm. Hmm. …" until the output cap — and
 * the reply ends with no verdict. Every judge bound is time-based, and a
 * looping stream keeps producing tokens, so none of them notice it until the
 * whole runaway budget is spent.
 *
 * The guard folds the streamed text to lowercase letters and digits (no
 * whitespace or punctuation, a run of one character capped at 3) and trips on
 * either rule:
 *
 * - Repeated unit: the folded tail is one unit of up to
 *   {@link MAX_UNIT_CHARS} chars repeated at least {@link MIN_UNIT_COPIES}
 *   times and covering at least {@link MIN_REPEAT_CHARS} folded chars.
 * - Low diversity (reasoning only): distinct {@link GRAM}-grams over the last
 *   {@link DIVERSITY_WINDOW} folded chars, divided by the gram count, falls
 *   below {@link MIN_DIVERSITY}.
 * - Recycled (reasoning only): of the {@link RECYCLE_GRAM}-grams in the last
 *   {@link RECYCLE_WINDOW} folded chars, at least {@link MAX_RECYCLED} had
 *   already appeared earlier in the stream. This is the indecision cycle —
 *   "FAIL. Final. Hmm, but let me reconsider…" — replaying whole paragraphs
 *   of its own earlier reasoning verbatim, with a period far past the
 *   repeated-unit rule's reach.
 *
 * Table rows and very long lines are left out of both reasoning windows:
 * tables and quoted JSON repeat by nature.
 *
 * Thresholds are generous on purpose — a false kill throws away a healthy
 * verdict, a missed loop only costs time. Measured on recorded DeepSeek V4.1
 * Flash judge reasoning: a draw that recovered and gave a verdict reached 138
 * consecutive folded "hmm"s; the draw that never recovered reached 711. The
 * repeated-unit rule needs 334 for a three-char unit. On the same judge
 * criterion, every draw that ran into the 65,536-token output cap without a
 * verdict replayed its earlier reasoning until 100% of a 5,000-char window was
 * recycled; draws that reached a verdict, long ones included, peaked at 53%.
 */

const MAX_UNIT_CHARS = 64;
const MIN_UNIT_COPIES = 100;
const MIN_REPEAT_CHARS = 1_000;
const MAX_CHAR_RUN = 3;

const GRAM = 24;
const DIVERSITY_WINDOW = 3_000;
const MIN_DIVERSITY = 0.1;
/** Folded chars between diversity measurements. */
const DIVERSITY_STRIDE = 256;
const MAX_DIVERSITY_LINE_CHARS = 2_000;

const RECYCLE_GRAM = 32;
const RECYCLE_WINDOW = 5_000;
const MAX_RECYCLED = 0.95;

export type ReasoningLoopTrip = {
  rule: "repeated-unit" | "low-diversity" | "recycled";
  /** Raw chars of this channel streamed when the guard tripped. */
  atChar: number;
  /** The repeated folded unit (repeated-unit rule). */
  unit?: string;
  /** How many times `unit` repeats at the tail (repeated-unit rule). */
  copies?: number;
  /** Distinct / total grams in the window (low-diversity rule). */
  diversity?: number;
  /** Share of the window's grams seen earlier in the stream (recycled rule). */
  recycled?: number;
};

const isFoldable = (ch: string): boolean => /[\p{L}\p{N}]/u.test(ch);

/** Lowercase letters + digits, a run of one character capped at 3. */
export function foldForRepetition(text: string): string {
  let out = "";
  let last = "";
  let run = 0;
  for (const raw of text) {
    if (!isFoldable(raw)) continue;
    const ch = raw.toLowerCase();
    run = ch === last ? run + 1 : 1;
    last = ch;
    if (run <= MAX_CHAR_RUN) out += ch;
  }
  return out;
}

/** A markdown table row: `| a | b |`, or a line of several `|` cells. */
function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("|")) return true;
  return (trimmed.match(/\|/g)?.length ?? 0) >= 3;
}

export function diversity(folded: string): number {
  const total = folded.length - GRAM + 1;
  if (total <= 0) return 1;
  const grams = new Set<string>();
  for (let i = 0; i < total; i++) grams.add(folded.slice(i, i + GRAM));
  return grams.size / total;
}

/**
 * Watches one channel of a stream (reasoning, or visible content). Feed it
 * each delta; it returns the trip the first time the stream degenerates, and
 * the same trip on every later push.
 */
export class RepetitionGuard {
  private readonly checkDiversity: boolean;
  private rawChars = 0;
  private trip: ReasoningLoopTrip | undefined;

  // Repeated-unit state: the folded tail, and for each period p the number
  // of consecutive folded chars equal to the char p before them.
  private tail = "";
  private lastChar = "";
  private charRun = 0;
  private readonly periodRuns = Array.from({ length: MAX_UNIT_CHARS + 1 }, () => 0);

  // Low-diversity state: the current raw line, and the folded window built
  // from finished lines that are not tables.
  private line = "";
  private window = "";
  private sinceMeasured = 0;

  // Recycled state: every gram of the filtered folded stream so far, and for
  // the window's grams whether each had been seen when it arrived.
  private readonly seenGrams = new Set<string>();
  private gramTail = "";
  private readonly windowFlags: boolean[] = [];
  private flagHead = 0;
  private recycledInWindow = 0;

  constructor(opts: { diversity: boolean }) {
    this.checkDiversity = opts.diversity;
  }

  get tripped(): ReasoningLoopTrip | undefined {
    return this.trip;
  }

  push(delta: string): ReasoningLoopTrip | undefined {
    if (this.trip || !delta) return this.trip;
    for (const raw of delta) {
      this.rawChars++;
      if (this.checkDiversity) this.pushLineChar(raw);
      if (isFoldable(raw)) this.pushFolded(raw.toLowerCase());
      if (this.trip) break;
    }
    return this.trip;
  }

  private pushFolded(ch: string): void {
    this.charRun = ch === this.lastChar ? this.charRun + 1 : 1;
    this.lastChar = ch;
    if (this.charRun > MAX_CHAR_RUN) return;

    this.tail += ch;
    const n = this.tail.length - 1;
    for (let p = 1; p <= MAX_UNIT_CHARS; p++) {
      this.periodRuns[p] = n >= p && this.tail[n - p] === ch ? this.periodRuns[p]! + 1 : 0;
      const span = this.periodRuns[p]! + p;
      if (span >= MIN_REPEAT_CHARS && span / p >= MIN_UNIT_COPIES) {
        this.trip = {
          rule: "repeated-unit",
          atChar: this.rawChars,
          unit: this.tail.slice(-p),
          copies: Math.floor(span / p),
        };
        return;
      }
    }
    if (this.tail.length > MAX_UNIT_CHARS * 2) this.tail = this.tail.slice(-MAX_UNIT_CHARS);
  }

  private pushLineChar(raw: string): void {
    if (raw !== "\n") {
      // A line past the cap is dropped from the window anyway; stop holding it.
      if (this.line.length <= MAX_DIVERSITY_LINE_CHARS) this.line += raw;
      return;
    }
    const line = this.line;
    this.line = "";
    if (line.length > MAX_DIVERSITY_LINE_CHARS || isTableLine(line)) return;
    const folded = foldForRepetition(line);
    if (!folded) return;
    this.pushRecycled(folded);
    this.window = (this.window + folded).slice(-DIVERSITY_WINDOW);
    this.sinceMeasured += folded.length;
    if (this.window.length < DIVERSITY_WINDOW || this.sinceMeasured < DIVERSITY_STRIDE) return;
    this.sinceMeasured = 0;
    const ratio = diversity(this.window);
    if (ratio < MIN_DIVERSITY) {
      this.trip = { rule: "low-diversity", atChar: this.rawChars, diversity: ratio };
      return;
    }
    const windowGrams = this.windowFlags.length - this.flagHead;
    if (windowGrams < RECYCLE_WINDOW) return;
    const recycled = this.recycledInWindow / windowGrams;
    if (recycled >= MAX_RECYCLED) {
      this.trip = { rule: "recycled", atChar: this.rawChars, recycled };
    }
  }

  private pushRecycled(folded: string): void {
    for (const ch of folded) {
      this.gramTail = (this.gramTail + ch).slice(-RECYCLE_GRAM);
      if (this.gramTail.length < RECYCLE_GRAM) continue;
      const seen = this.seenGrams.has(this.gramTail);
      if (!seen) this.seenGrams.add(this.gramTail);
      this.windowFlags.push(seen);
      if (seen) this.recycledInWindow++;
      if (this.windowFlags.length - this.flagHead > RECYCLE_WINDOW) {
        if (this.windowFlags[this.flagHead++]) this.recycledInWindow--;
      }
    }
    // Compact the consumed head now and then.
    if (this.flagHead > RECYCLE_WINDOW * 4) {
      this.windowFlags.splice(0, this.flagHead);
      this.flagHead = 0;
    }
  }
}

/** One line naming a trip, for the judge error reason. */
export function describeTrip(trip: ReasoningLoopTrip): string {
  switch (trip.rule) {
    case "repeated-unit":
      return `"${trip.unit}" repeated ${trip.copies}× at char ${trip.atChar}`;
    case "low-diversity":
      return `distinct-${GRAM}-gram ratio ${trip.diversity!.toFixed(3)} at char ${trip.atChar}`;
    case "recycled":
      return `${Math.round(trip.recycled! * 100)}% of the last ${RECYCLE_WINDOW} chars replay earlier reasoning, at char ${trip.atChar}`;
  }
}
