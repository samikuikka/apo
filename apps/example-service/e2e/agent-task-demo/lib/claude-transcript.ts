/**
 * Locate a Claude Code session transcript on disk.
 *
 * Claude Code persists one JSONL per session under
 * ``~/.claude/projects/<project-dir>/<session-id>.jsonl``. The project
 * directory name is a slug of the session's cwd — with a random suffix in
 * newer versions — so resolve by scanning the project directories for the
 * session-id file name instead of reconstructing the slug.
 *
 * The file may appear a moment after the SDK's result message (the harness
 * flushes it as it closes the session), so poll briefly before giving up.
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export async function findClaudeCodeTranscript(
  sessionId: string,
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  if (sessionId === "") return null;
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  do {
    const found = scanForSession(sessionId);
    if (found !== null) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return null;
}

function scanForSession(sessionId: string): string | null {
  const projectsDir = join(homedir(), ".claude", "projects");
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = join(projectsDir, entry, `${sessionId}.jsonl`);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here — try the next project directory
    }
  }
  return null;
}
