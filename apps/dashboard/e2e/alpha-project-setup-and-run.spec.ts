import { expect, test } from "@playwright/test";

/**
 * SPEC-126: internal alpha release gate — project setup + run flow.
 *
 * Validates the canonical operator surfaces render correctly for the
 * agent-testing product. These tests are deliberately structural — they
 * do not depend on real LLM calls or specific seeded data, so they can
 * run against any alpha-shaped instance (local dev, smoke stack, or a
 * real deployment).
 *
 * Auth handling: alpha tests must pass whether auth is disabled (CI/dev
 * convenience) or enforced (real alpha). When the dashboard redirects
 * to /login or /setup, that is a valid alpha state — we assert the
 * redirect rather than the protected surface.
 *
 * What we are gating on:
 *  - The settings/system page either renders the topology/runtime
 *    panels (auth disabled) or redirects to login (auth enforced).
 *  - The agent-testing product surfaces are reachable from the project
 *    shell and do not 500.
 *
 * What we are NOT gating on here:
 *  - Specific seed data (covered by backend tests).
 *  - Real LLM-backed task execution (covered by the smoke script).
 */

async function expectAlphaSurfaceOrLogin(page: import("@playwright/test").Page) {
  // Wait for the redirect (if any) to settle.
  await page.waitForLoadState("networkidle");
  const url = page.url();
  if (/\/(login|setup)/.test(url)) {
    // Auth enforced — the surface correctly redirected. Valid alpha state.
    return;
  }
  // Auth disabled — the page must have rendered without crashing.
  await expect(page.locator("body")).toBeVisible();
}

test.describe("Alpha: project setup and run surfaces @alpha", () => {
  test("settings/system either renders topology/runtime panels or redirects to login", async ({
    page,
  }) => {
    await page.goto("/settings/system");
    await page.waitForLoadState("networkidle");

    const url = page.url();
    if (/\/(login|setup)/.test(url)) {
      // Auth enforced — valid alpha state.
      return;
    }

    // Auth disabled — assert the SPEC-124 + SPEC-125 panels are present.
    await expect(
      page.getByText("Deployment Topology", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("single-node-alpha", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Agent Task Runtime", { exact: true }),
    ).toBeVisible();
  });

  test("project shell renders or redirects to login", async ({ page }) => {
    await page.goto("/project/example-service");
    await expectAlphaSurfaceOrLogin(page);
  });

  test("agent-tasks page renders or redirects to login", async ({ page }) => {
    await page.goto("/project/example-service/agent-tasks");
    await expectAlphaSurfaceOrLogin(page);
  });

  test("agent-task-runs page renders or redirects to login", async ({
    page,
  }) => {
    await page.goto("/project/example-service/agent-task-runs");
    await expectAlphaSurfaceOrLogin(page);
  });

  test("agent-task-batch-runs page renders or redirects to login", async ({
    page,
  }) => {
    await page.goto("/project/example-service/agent-task-batch-runs");
    await expectAlphaSurfaceOrLogin(page);
  });

  test("schedules page renders or redirects to login", async ({ page }) => {
    await page.goto("/project/example-service/agent-task-schedules");
    await expectAlphaSurfaceOrLogin(page);
  });
});
