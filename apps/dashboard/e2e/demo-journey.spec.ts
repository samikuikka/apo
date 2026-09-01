import { expect, test } from "@playwright/test";

/**
 * Anonymous demo journey — the golden path.
 *
 * No sign-in anywhere: the whole point is that a credential-less visitor
 * can see apo in action on the fixture-fed demo project. If this test
 * passes, the anonymous credential, the viewer role, the fixture loader,
 * and the demo UX all work end-to-end on a real stack.
 *
 * Requires a stack with the demo fixture loaded (any default stack after
 * the loader runs at startup, no flags, no keys).
 */
test.describe("Demo journey @agent", () => {
  test("landing → demo tasks → failed run evidence → trace, never signed in", async ({
    page,
    context,
  }) => {
    // The landing sells the demo with fixture numbers before any CTA.
    await page.goto("/");
    await expect(page.getByText("See apo in action.")).toBeVisible();
    await expect(page.getByText("RUNS CAPTURED")).toBeVisible();
    await page.getByRole("link", { name: "Explore the demo" }).click();

    // Demo tasks page: populated catalog, badge, guide rail, no session.
    await expect(page).toHaveURL(/\/project\/demo\/tasks/);
    await expect(page.getByTestId("demo-badge")).toBeVisible();
    await expect(page.getByTestId("start-here-rail")).toBeVisible();
    await expect(page.getByText("Captured example data")).toBeVisible();

    // Nothing to click that can't work: no Run affordance for read-only.
    await expect(page.getByRole("button", { name: /Run selected/ })).toHaveCount(0);

    // The hero surface: the failed document-qa run's check evidence.
    await page.goto("/project/demo/runs/task/demo-run-001");
    await expect(page.getByText(/document-qa/i)).toBeVisible();
    await expect(page.getByText(/cites-invoice-date/i).first()).toBeVisible();

    // The trace workspace renders the replayed OTLP projection.
    await page.goto("/project/demo/traces");
    await expect(page.locator("main")).toBeVisible();

    // The entire journey happened without a session cookie.
    const cookies = await context.cookies();
    expect(
      cookies.filter((c) => c.name.includes("session-token")),
    ).toHaveLength(0);
  });

  test("anonymous mutations are closed at the API, not just hidden", async ({
    request,
  }) => {
    const response = await request.post("/backend-proxy/v1/agent-task-batch-runs", {
      data: { project: "demo", selection_type: "all" },
    });
    expect(response.status()).toBe(401);
  });

  test("/demo alias lands on the demo tasks page", async ({ page }) => {
    await page.goto("/demo");
    await expect(page).toHaveURL(/\/project\/demo\/tasks/);
  });
});
