/**
 * SPEC-132 Behavior 3 regression guard: client bundles must never embed
 * the Docker-internal backend URL or localhost:8000.
 *
 * `NEXT_PUBLIC_*` env vars are inlined into client chunks at build time.
 * If `NEXT_PUBLIC_APO_BACKEND_URL=http://localhost:8000` is set during
 * the build, a remote user's browser resolves fetches to its own
 * machine. This test scans the production build output to catch that.
 *
 * Runs only when `.next/static/chunks` exists (after `next build`).
 * In CI the build runs before tests, so the chunks are present.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const chunksDir = join(process.cwd(), ".next", "static", "chunks");

const skip = !existsSync(chunksDir);

describe.skipIf(skip)("client bundle URL safety (SPEC-132)", () => {
  function readAllChunks(): string {
    const files = readdirSync(chunksDir).filter((f) => f.endsWith(".js"));
    return files
      .map((f) => {
        try {
          return readFileSync(join(chunksDir, f), "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");
  }

  it("no client chunk contains localhost:8000", () => {
    const bundle = readAllChunks();
    // localhost:8000 must never appear — a remote browser can't reach it.
    expect(bundle).not.toContain("localhost:8000");
  });

  it("no client chunk contains the Docker-internal backend:8000", () => {
    const bundle = readAllChunks();
    expect(bundle).not.toContain("backend:8000");
  });
});
