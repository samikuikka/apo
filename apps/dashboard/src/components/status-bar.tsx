import { BookOpen, Github } from "lucide-react";
// Baked in at build time so the standalone image reports the version it was
// built from without a backend round-trip; dashboard and backend release
// together and carry the same version.
import pkg from "../../package.json";

const DOCS_URL = "https://docs.test-apo.online";
const GITHUB_URL = "https://github.com/samikuikka/apo";

/**
 * Thin status bar pinned under the whole shell — docs and repository links
 * on the left, the shipped version on the right. The shell subtracts
 * `--status-bar-h` (globals.css) from its column heights so the bar never
 * covers page content.
 */
export function StatusBar() {
  return (
    <footer className="fixed inset-x-0 bottom-0 z-30 flex h-[var(--status-bar-h)] items-center justify-between border-t border-border/60 bg-background px-3">
      <nav aria-label="Resources" className="flex items-center gap-3">
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <BookOpen className="size-3" aria-hidden />
          Docs
        </a>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <Github className="size-3" aria-hidden />
          GitHub
        </a>
      </nav>
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
        apo v{pkg.version}
      </span>
    </footer>
  );
}
