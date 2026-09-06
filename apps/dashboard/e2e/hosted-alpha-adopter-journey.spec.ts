import { expect, request, test } from "@playwright/test";

/**
 * Hosted-alpha adopter journey — the automated layer of the
 * first-adopter rehearsal.
 *
 * Runs against a dedicated production-shaped local stack (Caddy ingress,
 * application auth enabled, DEV_SIGNIN_ENABLED=false, admin bootstrapped via
 * INIT_USER_*). Setup may provision the admin session and issue one
 * invitation — the invitee's product journey begins at the delivered
 * invitation link, from a fresh browser context with no shared state.
 *
 * Prepare the stack first (see docs/workflows/hosted-alpha-first-adopter-rehearsal.md),
 * then run via `pnpm test:hosted-alpha-journey` with
 * HOSTED_ALPHA_JOURNEY_BASE_URL pointing at the stack's public origin.
 * Each run invites a unique invitee; the admin is bootstrapped once via
 * INIT_USER_* when the stack is created.
 */

const BASE_URL =
  process.env.HOSTED_ALPHA_JOURNEY_BASE_URL ?? "http://localhost:8080";
const ADMIN_EMAIL =
  process.env.HOSTED_ALPHA_JOURNEY_ADMIN_EMAIL ??
  "rehearsal-admin@hosted-alpha.test";
const ADMIN_PASSWORD =
  process.env.HOSTED_ALPHA_JOURNEY_ADMIN_PASSWORD ?? "RehearsalAdmin123";
const INVITEE_EMAIL =
  process.env.HOSTED_ALPHA_JOURNEY_INVITEE_EMAIL ??
  // Unique per run: re-inviting an already-accepted email takes the
  // existing-account join branch, which this scene does not exercise. A
  // single prepared stack can serve many runs.
  `founder-invitee-${Date.now().toString(36)}@hosted-alpha.test`;
const INVITEE_PASSWORD =
  process.env.HOSTED_ALPHA_JOURNEY_INVITEE_PASSWORD ?? "InviteePass123";
const CANONICAL_DOCS_URL = "https://docs.test-apo.online/hosted-alpha/";
const MAINTAINED_EXAMPLE_URL =
  "https://github.com/samikuikka/apo/tree/main/apps/example-service/e2e/agent-task-demo";

/** Sign in through the real NextAuth credentials flow (browser-session cookie). */
async function signInViaCredentials(
  ctx: Awaited<ReturnType<typeof request.newContext>>,
  email: string,
  password: string,
) {
  const csrf = await ctx.get("/api/auth/csrf");
  expect(csrf.ok(), "NextAuth csrf endpoint reachable").toBeTruthy();
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const callback = await ctx.post("/api/auth/callback/credentials", {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    data: new URLSearchParams({
      csrfToken,
      email,
      password,
      callbackUrl: `${BASE_URL}/`,
      json: "true",
    }).toString(),
  });
  expect(
    callback.ok(),
    `credentials sign-in succeeded for ${email} — is the stack fresh and INIT_USER_* set?`,
  ).toBeTruthy();
}

test.describe("Hosted alpha adopter journey @hosted-alpha", () => {
  test.describe.configure({ mode: "serial" });

  let adminContext: Awaited<ReturnType<typeof request.newContext>>;
  let inviteUrl: string;

  test.beforeAll(async () => {
    adminContext = await request.newContext({ baseURL: BASE_URL });

    // [operator] Provision the admin session and issue one invitation. The
    // invitee journey below starts at the delivered link — no shared cookies.
    await signInViaCredentials(adminContext, ADMIN_EMAIL, ADMIN_PASSWORD);
    const session = (await (
      await adminContext.get("/api/auth/session")
    ).json()) as { user?: { email?: string } };
    expect(session.user?.email, "admin session established").toBe(
      ADMIN_EMAIL,
    );

    const invitation = await adminContext.post(
      "/v1/admin/hosted-access-invitations",
      { data: { email: INVITEE_EMAIL } },
    );
    expect(
      invitation.status(),
      "invitation issued through the admin API",
    ).toBe(201);
    const body = (await invitation.json()) as { invite_url?: string };
    expect(body.invite_url, "one-time invite_url delivered").toBeTruthy();
    inviteUrl = body.invite_url!;
  });

  test.afterAll(async () => {
    await adminContext?.dispose();
  });

  test("invitation link → join preview → account + private Project → first-run panel", async ({
    browser,
  }) => {
    // [invitee] A brand-new browser context: no session, no shared state.
    const invitee = await browser.newContext();
    const page = await invitee.newPage();

    await page.goto(inviteUrl);
    await expect(page.getByText("Create your apo Project")).toBeVisible();

    await page.locator("#name").fill("First Adopter");
    await page.locator("#password").fill(INVITEE_PASSWORD);
    await page.locator("#confirmPassword").fill(INVITEE_PASSWORD);
    await page.locator("#projectName").fill("Rehearsal Project");

    await page.getByRole("button", { name: "Create account and Project" }).click();

    // Authenticated redirect to the new Project's task list.
    await expect(page).toHaveURL(/\/project\/([^/]+)\/tasks$/);
    const projectId = new URL(page.url()).pathname.split("/")[2];

    // The first-run panel carries everything an adopter needs.
    await expect(
      page.getByRole("heading", { name: "Get your first recorded run" }),
    ).toBeVisible();

    // Exact public CLI install and login commands, copyable by label.
    await expect(
      page.locator('code[aria-label="Install CLI command"]'),
    ).toHaveText("npm install -g @apo-ai/cli");
    await expect(
      page.locator('code[aria-label="Login command"]'),
    ).toHaveText(`apo login --backend ${BASE_URL} --project ${projectId}`);

    // Canonical absolute docs link + maintained example path.
    await expect(
      page.getByRole("link", { name: /Use APO in my own agent repository/ }),
    ).toHaveAttribute("href", CANONICAL_DOCS_URL);
    await expect(
      page.getByRole("link", { name: /Try the maintained example/ }),
    ).toHaveAttribute("href", MAINTAINED_EXAMPLE_URL);

    // Publish/run commands and the evidence expectation stay visible.
    await expect(
      page.locator('code[aria-label="Publish command"]'),
    ).toBeVisible();
    await expect(
      page.locator('code[aria-label="Run command"]'),
    ).toBeVisible();
    await expect(page.getByText(/PASS and FAIL are both useful/)).toBeVisible();

    await invitee.close();

    // [operator] The issuer must not have gained access to the invitee's
    // Project: canonical authorization answers 403/404, never 200.
    const issuerView = await adminContext.get(
      `/v1/projects/${projectId}`,
    );
    expect([403, 404]).toContain(issuerView.status());
  });

  test("replaying the consumed invitation cannot create another Project", async ({
    browser,
  }) => {
    // [invitee] The one-use link is dead after acceptance.
    const replay = await browser.newContext();
    const page = await replay.newPage();
    await page.goto(inviteUrl);
    await expect(
      page.getByText("This invitation has already been used"),
    ).toBeVisible();
    await replay.close();
  });
});
