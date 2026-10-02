import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..");
const HELPER_PATH = join(REPO_ROOT, "scripts", "publish-npm-package");

describe("scripts/publish-npm-package contract", () => {
  const helper = existsSync(HELPER_PATH) ? readFileSync(HELPER_PATH, "utf8") : "";

  it("exists and supports both npm release streams", () => {
    expect(helper).not.toBe("");
    expect(helper).toContain('PACKAGE="@apo-ai/sdk"');
    expect(helper).toContain('PACKAGE="@apo-ai/cli"');
  });

  it("requires a merged, green PR whose head and merge trees match", () => {
    expect(helper).toContain('PR_STATE" = "MERGED"');
    expect(helper).toContain('workflowName == "CI"');
    expect(helper).toContain('head_tree" = "$merge_tree');
  });

  it("approves only the environment discovered from the current run", () => {
    expect(helper).toContain("pending_deployments");
    expect(helper).toContain('environment.name == \\"$ENVIRONMENT\\"');
    expect(helper).toContain('environment_ids[]=$environment_id');
  });

  it("waits for the immutable npm version after the publisher succeeds", () => {
    expect(helper).toContain('gh run watch "$RUN_ID" --exit-status');
    expect(helper).toContain('npm view "$PACKAGE@$VERSION" version');
  });
});
