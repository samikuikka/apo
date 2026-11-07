/**
 * Turn on Node's on-disk compile cache before any other module compiles.
 *
 * The CLI runs straight from TypeScript sources via --experimental-strip-types,
 * so every invocation recompiled its module graph before doing any work:
 * ~70ms of process floor on a command that prints and exits, more on
 * import-heavy commands. The compile cache persists compiled modules keyed
 * by file URL plus content, so the second run of a command skips that work.
 * Editing a file or switching checkouts just misses the cache and
 * recompiles; stale entries are never loaded.
 *
 * Best-effort by design. On Node < 22.13 (engines allows >= 20) or with an
 * unwritable cache dir, the call is skipped and every run pays the uncached
 * cost again.
 */

import * as nodeModule from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const moduleWithCompileCache = nodeModule as unknown as {
  enableCompileCache?: (cacheDir: string) => { status: string; message?: string };
};

if (!process.env.NODE_COMPILE_CACHE && moduleWithCompileCache.enableCompileCache) {
  // Node already honors NODE_COMPILE_CACHE at startup; an explicit dir here
  // would fight the operator's choice, so leave it alone when set. The
  // versioned subdir exists because the cache is not portable across Node
  // versions.
  try {
    moduleWithCompileCache.enableCompileCache(
      join(homedir(), ".cache", "apo-cli", "compile-cache", process.versions.node),
    );
  } catch {
    // A failed cache enablement must never break the command itself.
  }
}
