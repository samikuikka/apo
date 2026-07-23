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
  if (actor && actor !== hostname) {
    identity.push(actor);
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

export function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Format a cost value as USD. Costs are stored as micro-USD integers
 * (SPEC-136: USD * 1e6), so divide by 1e6 before formatting.
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
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m${String(secs).padStart(2, "0")}s`;
}
