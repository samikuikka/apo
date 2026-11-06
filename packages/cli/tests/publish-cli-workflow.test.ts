import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "publish-cli.yml");

function readWorkflow(): string {
  if (!existsSync(WORKFLOW_PATH)) {
    throw new Error(`publish-cli.yml missing at ${WORKFLOW_PATH}`);
  }
  return readFileSync(WORKFLOW_PATH, "utf8");
}

describe(".github/workflows/publish-cli.yml contract", () => {
  const yaml = readWorkflow();

  it("triggers only on cli-v* tags", () => {
    expect(yaml).toMatch(/on:\s*\n\s*push:\s*\n\s*tags:/);
    expect(yaml).toMatch(/["']cli-v\*["']/);
  });

  it("declares id-token: write for OIDC", () => {
    expect(yaml).toMatch(/id-token:\s*write/);
  });

  it("uses the protected npm-cli-release environment", () => {
    expect(yaml).toMatch(/environment:\s*npm-cli-release/);
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

  it("compares the tag version against packages/cli/package.json", () => {
    expect(yaml).toMatch(/cli-v.*package\.json/i);
  });

  it("runs CLI tests, typecheck, and package:check before publishing", () => {
    expect(yaml).toMatch(/pnpm --filter @apo-ai\/cli test/);
    expect(yaml).toMatch(/pnpm --filter @apo-ai\/cli typecheck/);
    expect(yaml).toMatch(/pnpm --filter @apo-ai\/cli package:check/);
  });
  it("publishes a tarball resolved from disk via pnpm pack", () => {
    expect(yaml).toMatch(/pnpm.*pack/);
    expect(yaml).toMatch(/--pack-destination/);
    expect(yaml).toMatch(/realpath.*\.tgz/);
    expect(yaml).toMatch(/npm publish[^\n]*TARBALL/);
  });

  it("publishes with public access and provenance", () => {
    expect(yaml).toMatch(/--access public/);
    expect(yaml).toMatch(/--provenance/);
  });

  it("never references an npm token secret", () => {
    expect(yaml).not.toMatch(/secrets\.NPM_TOKEN/);
    expect(yaml).not.toMatch(/secrets\.NODE_AUTH_TOKEN/);
    expect(yaml).not.toMatch(/NODE_AUTH_TOKEN:\s*\$\{/);
    expect(yaml).not.toMatch(/\$\{\{\s*secrets\.[A-Z_0-9]*TOKEN\s*\}\}/i);
  });
});
