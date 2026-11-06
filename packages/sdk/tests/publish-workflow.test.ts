import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "publish-sdk.yml");

function readWorkflow(): string {
  if (!existsSync(WORKFLOW_PATH)) {
    throw new Error(`publish-sdk.yml missing at ${WORKFLOW_PATH}`);
  }
  return readFileSync(WORKFLOW_PATH, "utf8");
}

describe(".github/workflows/publish-sdk.yml contract", () => {
  const yaml = readWorkflow();

  it("triggers only on sdk-v* tags", () => {
    expect(yaml).toMatch(/on:\s*\n\s*push:\s*\n\s*tags:/);
    expect(yaml).toMatch(/["']sdk-v\*["']/);
    // No branch/pr trigger that would publish unintentionally.
    expect(yaml).not.toMatch(/branches:\s*\n\s*-\s*main/);
  });

  it("declares id-token: write for OIDC", () => {
    expect(yaml).toMatch(/id-token:\s*write/);
  });

  it("uses the protected npm-sdk-release environment", () => {
    expect(yaml).toMatch(/environment:\s*npm-sdk-release/);
  });

  it("runs on a GitHub-hosted Ubuntu runner", () => {
    expect(yaml).toMatch(/runs-on:\s*ubuntu-latest/);
  });

  it("uses pnpm 12.16.1 and Node 24", () => {
    expect(yaml).toMatch(/version:\s*12\.16\.1/);
    expect(yaml).toMatch(/node-version:\s*24/);
  });

  it("installs with a frozen lockfile", () => {
    expect(yaml).toMatch(/pnpm install --frozen-lockfile/);
  });

  it("compares the tag version against packages/sdk/package.json", () => {
    expect(yaml).toMatch(/sdk-v.*package\.json/i);
  });

  it("runs SDK tests, typecheck, and package:check before publishing", () => {
    expect(yaml).toMatch(/pnpm --filter @apo-ai\/sdk test/);
    expect(yaml).toMatch(/pnpm --filter @apo-ai\/sdk typecheck/);
    expect(yaml).toMatch(/pnpm --filter @apo-ai\/sdk package:check/);
  });

    it("publishes a tarball produced by pnpm pack", () => {
      expect(yaml).toMatch(/pnpm pack/);
      // The tarball must be resolved from the pack destination directory
      // (reading from disk), NOT captured from pnpm's stdout — pnpm emits
      // ANSI color codes that $GITHUB_ENV rejects.
      expect(yaml).toMatch(/--pack-destination/);
      expect(yaml).toMatch(/realpath.*\.tgz|ls.*release.*\.tgz/);
      // The publish step must consume that resolved tarball variable.
      expect(yaml).toMatch(/npm publish[^\n]*TARBALL/);
    });

  it("publishes with public access and provenance", () => {
    expect(yaml).toMatch(/--access public/);
    expect(yaml).toMatch(/--provenance/);
  });

    it("never references an npm token secret", () => {
      // Look for actual usage, not the literal token name in comments.
      // The workflow must not consume a stored npm credential.
      expect(yaml).not.toMatch(/secrets\.NPM_TOKEN/);
      expect(yaml).not.toMatch(/secrets\.NODE_AUTH_TOKEN/);
      expect(yaml).not.toMatch(/env:\s*\n\s*NPM_TOKEN:/);
      expect(yaml).not.toMatch(/NODE_AUTH_TOKEN:\s*\$\{/);
      expect(yaml).not.toMatch(/\$\{\{\s*secrets\.[A-Z_0-9]*TOKEN\s*\}\}/i);
    });
});
