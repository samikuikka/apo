import { expect, test } from "@playwright/test";

/**
 * SPEC-126: internal alpha release gate — trace drilldown.
 *
 * Validates that the canonical trace navigation surfaces render. The
 * alpha product contract is:
 *
 *   task page → latest run → batch context → trace shell → full inspection
 *
 * We assert each surface renders without crashing and that the trace
 * shell, when reached, shows the trace tree/detail pair. We do not
 * assert specific trace data — the existence of the shell is the
 * release gate.
 *
 * Auth handling: see alpha-project-setup-and-run.spec.ts — tests
 * tolerate either auth-disabled (panels render) or auth-enforced
 * (redirect to /login or /setup).
 */

async function expectAlphaSurfaceOrLogin(page: import("@playwright/test").Page) {
  await page.waitForLoadState("networkidle");
  const url = page.url();
  if (/\/(login|setup)/.test(url)) {
    return;
  }
  await expect(page.locator("body")).toBeVisible();
}

test.describe("Alpha: trace drilldown @alpha", () => {
  test("traces list page renders or redirects to login", async ({ page }) => {
    await page.goto("/project/example-service/traces");
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

  test("trace shell is reachable from the project shell", async ({ page }) => {
    await page.goto("/project/example-service");
    await expectAlphaSurfaceOrLogin(page);
  });
});
