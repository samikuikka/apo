const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";

// Matches ANSI SGR escape sequences (e.g. "\x1b[32m"). The control character
// here is intentional — stripping it is the whole point.
// oxlint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

export function green(text: string): string {
  return `${GREEN}${text}${RESET}`;
}

export function red(text: string): string {
  return `${RED}${text}${RESET}`;
}

export function yellow(text: string): string {
  return `${YELLOW}${text}${RESET}`;
}

export function bold(text: string): string {
  return `${BOLD}${text}${RESET}`;
}

export function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

export function cyan(text: string): string {
  return `${CYAN}${text}${RESET}`;
}

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

export function formatTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) => {
    const maxRowWidth = rows.reduce(
      (max, row) => Math.max(max, visibleLength(row[i] ?? "")),
      0,
    );
    return Math.max(h.length, maxRowWidth);
  });

  const headerLine = headers
    .map((h, i) => bold(h.padEnd(colWidths[i])))
    .join("  ");
  const separator = colWidths.map((w) => DIM_STRING.repeat(w)).join("  ");
  const dataLines = rows.map((row) =>
    row
      .map((cell, i) => {
        const pad = colWidths[i] - visibleLength(cell);
        return cell + " ".repeat(pad > 0 ? pad : 0);
      })
      .join("  "),
  );

  return [headerLine, separator, ...dataLines].join("\n");
}

export function passFail(passed: boolean): string {
  return passed ? green("PASS") : red("FAIL");
}

/**
 * A run-level verdict: PASS / FAIL, or a yellow NO VERDICT when the judge
 * never answered for every non-passing check (issue #323) — a judge outage
 * is not the agent failing.
 */
export function runVerdict(passed: boolean, noVerdict: boolean): string {
  return noVerdict ? yellow("NO VERDICT") : passFail(passed);
}

export type TriggerParts = {
  source: string | null;
  actor: string | null;
  hostname: string | null;
  entrypoint: string | null;
  repository?: string | null;
  branch?: string | null;
  commit_sha?: string | null;
  pr_number?: string | null;
};

export function formatTrigger(parts: TriggerParts): string {
  const { source, actor, hostname, entrypoint } = parts;

  const identity: string[] = [];
  if (source) identity.push(source);
  // Labelled: the actor is free text the caller chose, unlike the verified
  // "Requested by" line, so it must not read like one.
  if (actor && actor !== hostname) {
    identity.push(`actor: ${actor}`);
  }
  if (hostname) identity.push(hostname);

  const identityStr = identity.length > 0 ? identity.join(" · ") : null;
  const location = entrypoint ?? null;

  let result = location ?? "";
  if (identityStr) {
    result = location ? `${identityStr} · ${location}` : identityStr;
  }

  const repo = parts.repository;
  if (parts.source === "ci" && repo && result) {
    let repoStr = `${repo}`;
    if (parts.pr_number) repoStr += `#${parts.pr_number}`;
    if (parts.commit_sha) repoStr += ` @ ${parts.commit_sha.slice(0, 7)}`;
    result += ` · ${repoStr}`;
  }

  return result || "-";
}

const DIM_STRING = "\u2500";

// Whole escape sequences first, so stored ANSI leaves no "[31m" residue:
// CSI (ESC [ or C1 0x9B, parameters, one final byte) and OSC (ESC ] or C1
// 0x9D, up to BEL, ST or ESC \). An unterminated OSC keeps its text: only the
// introducer goes, and mojibake can produce a lone 0x9D inside real prose.
const TERMINAL_SEQUENCE =
  /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u009C|\u001B\\)/g;
// Then any lone control: C0 except tab and newline, DEL, and C1. A
// server-provided string can't move the cursor, retitle the terminal, or
// print a disguised hyperlink.
const TERMINAL_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Strip terminal control sequences and characters from a server-provided string. */
export function terminalSafe(text: string): string {
  return text.replace(TERMINAL_SEQUENCE, "").replace(TERMINAL_CONTROL, "");
}

/** `terminalSafe` over every string in a fetched payload, keys included, for human output. */
export function terminalSafeDeep<T>(value: T): T {
  if (typeof value === "string") return terminalSafe(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => terminalSafeDeep(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        terminalSafe(key),
        terminalSafeDeep(item),
      ]),
    ) as T;
  }
  return value;
}

/** Options matching Date#toLocaleString's defaults, so output is byte-identical. */
const timestampFormatterOptions: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
};

// Built on first use, not at module load: constructing an Intl formatter is
// the first ICU touch in the process (~25ms of locale-data init), which
// every command would otherwise pay even when it never prints a timestamp.
let timestampFormatter: Intl.DateTimeFormat | null = null;

/** "-" for a missing timestamp: `new Date(null)` would print the 1970 epoch.
 * Formats through one shared formatter: constructing an Intl.DateTimeFormat
 * per call cost ~0.2ms each and dominated list rendering (137 rows was
 * ~27ms of pure formatter construction). */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    // Intl#format throws on an invalid date where toLocaleString printed
    // "Invalid Date"; keep the printed form so unparseable input reads the
    // same as before.
    return String(date);
  }
  timestampFormatter ??= new Intl.DateTimeFormat(undefined, timestampFormatterOptions);
  return timestampFormatter.format(date);
}

/**
 * Format a cost value as USD. Costs are stored as micro-USD integers
 *, so divide by 1e6 before formatting.
 */
export function formatCost(value: number | null): string {
  if (value == null) return "-";
  return formatUsd(value / 1_000_000);
}

/** Format a USD-denominated float (NOT micro-USD) as a dollar string. */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

export function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return "-";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 0) return "-";
  return formatMs(ms);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m${String(secs).padStart(2, "0")}s`;
}
