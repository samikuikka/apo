/**
 * Self-serve door on /join, through the real page module and the real API
 * helpers: only the network (fetch) and the Next.js runtime are stubbed.
 * With self_serve mode a visitor with no token gets the request form and
 * the generic "check your inbox" answer; with invite_only the form never
 * renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const searchParams = { token: null as string | null };
const push = vi.fn();

vi.mock("next-auth/react", () => ({
  signIn: vi.fn().mockResolvedValue({ ok: true }),
  useSession: vi.fn().mockReturnValue({
    data: undefined,
    status: "unauthenticated",
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => ({
    get: (key: string) => (key === "token" ? searchParams.token : null),
  }),
}));

import { signIn, useSession } from "next-auth/react";
import { maskEmail } from "@/lib/hosted-access-api";
import JoinPage from "../page";

const GENERIC_MESSAGE =
  "If the address is eligible, an invitation is on its way.";

type Route = (init: RequestInit | undefined) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

function serve(routes: Record<string, Route>) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const route = routes[url.pathname];
    if (!route) throw new Error(`unexpected request to ${url.pathname}`);
    return route(init);
  });
}

function requestsTo(pathname: string) {
  return fetchMock.mock.calls.filter(
    ([input]) => new URL(String(input), "http://localhost").pathname === pathname,
  );
}

const MODE = "/backend-proxy/auth/hosted-access/mode";
const REQUEST = "/backend-proxy/auth/hosted-access/request";
const PREVIEW = "/backend-proxy/auth/hosted-access/preview";
const ACCEPT = "/backend-proxy/auth/hosted-access/accept/create-account";

beforeEach(() => {
  searchParams.token = null;
  push.mockClear();
  fetchMock.mockReset();
  vi.mocked(signIn).mockClear();
  vi.mocked(useSession).mockReturnValue({
    data: null,
    status: "unauthenticated",
    update: vi.fn(),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/join with self_serve mode", () => {
  it("shows the request form and answers with the generic inbox state", async () => {
    serve({
      [MODE]: () => json(200, { mode: "self_serve" }),
      [REQUEST]: () => json(202, { message: GENERIC_MESSAGE }),
    });

    render(<JoinPage />);
    const user = userEvent.setup();

    const emailField = await screen.findByLabelText("Email");
    await user.type(emailField, "stranger@example.com");
    await user.click(screen.getByRole("button", { name: /request invitation/i }));

    expect(
      await screen.findByRole("heading", { name: /check your inbox/i }),
    ).toBeDefined();
    expect(screen.getByText(GENERIC_MESSAGE)).toBeDefined();
    expect(screen.queryByLabelText("Email")).toBeNull();

    const [[, init]] = requestsTo(REQUEST);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      email: "stranger@example.com",
    });
  });

  it("shows the server's reason and keeps the form when the request is refused", async () => {
    serve({
      [MODE]: () => json(200, { mode: "self_serve" }),
      [REQUEST]: () =>
        json(429, { detail: "Too many requests. Please try again later." }),
    });

    render(<JoinPage />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Email"), "again@example.com");
    await user.click(screen.getByRole("button", { name: /request invitation/i }));

    expect(
      await screen.findByText("Too many requests. Please try again later."),
    ).toBeDefined();
    expect(screen.getByLabelText("Email")).toBeDefined();
    expect(screen.queryByRole("heading", { name: /check your inbox/i })).toBeNull();
  });

  it("offers a new request on a dead link instead of pointing at an administrator", async () => {
    searchParams.token = "tok-old";
    serve({
      [MODE]: () => json(200, { mode: "self_serve" }),
      [PREVIEW]: () =>
        json(200, {
          valid: false,
          reason: "expired",
          email: null,
          requires_login: false,
          requires_account_creation: false,
        }),
    });

    render(<JoinPage />);

    const link = await screen.findByRole("link", {
      name: /request a new invitation/i,
    });
    expect(link.getAttribute("href")).toBe("/join");
    expect(screen.queryByText(/administrator/i)).toBeNull();
  });

  it("sends a new self-serve account to verify its email instead of signing in", async () => {
    searchParams.token = "tok-123";
    serve({
      [MODE]: () => json(200, { mode: "self_serve" }),
      [PREVIEW]: () =>
        json(200, {
          valid: true,
          reason: null,
          email: "s***r@example.com",
          requires_login: false,
          requires_account_creation: true,
        }),
      [ACCEPT]: () =>
        json(200, {
          status: "accepted",
          project_id: "proj-1",
          email: "stranger@example.com",
          email_verification_required: true,
        }),
    });

    render(<JoinPage />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Name"), "Stranger");
    expect(screen.getByDisplayValue("s***r@example.com")).toBeDefined();
    await user.type(screen.getByLabelText("Password"), "hunter2hunter2");
    await user.type(screen.getByLabelText("Confirm password"), "hunter2hunter2");
    await user.type(screen.getByLabelText("Project name"), "Fresh Start");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        "/verify-email?email=stranger%40example.com",
      );
    });
    expect(signIn).not.toHaveBeenCalled();
  });
});

describe("/join with invite_only mode", () => {
  it("does not render the request form", async () => {
    serve({ [MODE]: () => json(200, { mode: "invite_only" }) });

    render(<JoinPage />);

    expect(
      await screen.findByRole("heading", {
        name: /no invitation token provided/i,
      }),
    ).toBeDefined();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByRole("button", { name: /request invitation/i })).toBeNull();
    expect(requestsTo(REQUEST)).toHaveLength(0);
  });

  it("stays invite-only when the mode cannot be read", async () => {
    serve({ [MODE]: () => json(500, { detail: "boom" }) });

    render(<JoinPage />);

    expect(
      await screen.findByRole("heading", {
        name: /no invitation token provided/i,
      }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: /request invitation/i })).toBeNull();
  });
});

describe("/join existing-account email match", () => {
  const preview = {
    valid: true,
    reason: null,
    email: "k***n@example.com",
    requires_login: true,
    requires_account_creation: false,
  };

  function signedInAs(email: string) {
    vi.mocked(useSession).mockReturnValue({
      data: { user: { email }, expires: "2099-01-01" },
      status: "authenticated",
      update: vi.fn(),
    } as unknown as ReturnType<typeof useSession>);
  }

  it("accepts for a session email that matches the masked invitation", async () => {
    searchParams.token = "tok-123";
    signedInAs("Known@Example.com");
    serve({
      [MODE]: () => json(200, { mode: "invite_only" }),
      [PREVIEW]: () => json(200, preview),
    });

    render(<JoinPage />);

    expect(
      await screen.findByRole("button", { name: /accept and create project/i }),
    ).toBeDefined();
  });

  it("refuses a session email that does not match", async () => {
    searchParams.token = "tok-123";
    signedInAs("someone@else.com");
    serve({
      [MODE]: () => json(200, { mode: "invite_only" }),
      [PREVIEW]: () => json(200, preview),
    });

    render(<JoinPage />);

    expect(await screen.findByText(/k\*\*\*n@example\.com/)).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /accept and create project/i }),
    ).toBeNull();
  });
});

describe("maskEmail", () => {
  // The same vectors as the backend's mask_email test: the two must agree
  // or a signed-in invitee is told the invitation is for someone else.
  it.each([
    ["john@example.com", "j***n@example.com"],
    ["stranger@example.com", "s***r@example.com"],
    ["abc@example.com", "a***c@example.com"],
    ["ab@example.com", "a***@example.com"],
    ["a@example.com", "a***@example.com"],
    [" John@Example.com ", "j***n@example.com"],
  ])("masks %s", (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });
});
