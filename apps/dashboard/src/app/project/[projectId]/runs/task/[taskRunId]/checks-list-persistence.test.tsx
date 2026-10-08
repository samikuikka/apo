/**
 * Scene tests: persisted open/closed state of describe() groups.
 *
 * 1. Groups default to collapsed; opening one persists it under the
 *    task-scoped localStorage key, collapsing removes it again.
 * 2. A stored open set reopens those groups on mount (memory survives
 *    reloads and carries across runs of the same task).
 * 3. Groups absent from the stored set stay collapsed — new tests arrive
 *    quiet instead of auto-opening.
 * 4. A shared ?assertion= deep link opens the group containing the target
 *    check without writing anything to storage (the URL is the ephemeral
 *    bit).
 * 5. Without a task id there is nothing durable to key on — toggling stays
 *    in-memory and no key is written.
 */

import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// This vitest jsdom exposes an inert localStorage (no methods at all), so
// the persistence tests run against an in-memory Storage instead.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number) {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

beforeAll(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});
afterAll(() => vi.unstubAllGlobals());

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: (_loader: () => Promise<unknown>) => {
    const Comp = () => null;
    Comp.displayName = "DynamicComponent";
    return Comp;
  },
}));

const urlState = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => urlState.params,
  usePathname: () => "/",
}));

vi.mock("@/lib/agent-task-api", () => ({
  correctTestResult: vi.fn(),
}));
vi.mock("@/lib/check-diagnostics", () => ({ buildCheckDiagnostics: () => [] }));
vi.mock("@/lib/extract-check-block", () => ({ resolveCheckBlock: () => null }));
vi.mock("@/lib/locate-assertion", () => ({ locateAssertionsInBlock: () => [] }));

import { ChecksList } from "./checks-list";
import type { CheckResult } from "@/lib/agent-task-api";

const STORAGE_KEY = "apo:open-check-groups:proj-1:task-1";

function check(id: string, overrides: Partial<CheckResult> = {}): CheckResult {
  return { id, pass: true, reasoning: "", ...overrides };
}

const checks: CheckResult[] = [
  check("standalone", { pass: false }),
  check("alpha-1", { group_id: "group-alpha", group_name: "Alpha suite" }),
  check("alpha-2", { group_id: "group-alpha", group_name: "Alpha suite", pass: false }),
  check("beta-1", { group_id: "group-beta", group_name: "Beta suite" }),
];

function renderList() {
  return render(
    <ChecksList checks={checks} taskId="task-1" projectId="proj-1" />,
  );
}

beforeEach(() => {
  localStorage.clear();
  urlState.params = new URLSearchParams();
});

describe("ChecksList group persistence", () => {
  it("collapses groups by default and persists toggles under the task-scoped key", () => {
    renderList();

    // Bare checks render as before; group members start hidden.
    expect(screen.getByText("standalone")).toBeInTheDocument();
    expect(screen.queryByText("alpha-1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand Alpha suite" }));
    expect(screen.getByText("alpha-1")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(["group-alpha"]);

    // Collapsing again empties the set, and an empty set drops the key
    // entirely (no orphan "apo:" keys from mere visits).
    fireEvent.click(screen.getByRole("button", { name: "Collapse Alpha suite" }));
    expect(screen.queryByText("alpha-1")).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("reopens groups found in the stored set on mount", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["group-alpha"]));
    renderList();
    expect(screen.getByText("alpha-1")).toBeInTheDocument();
  });

  it("keeps groups absent from the stored set collapsed (new tests arrive quiet)", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["group-alpha"]));
    renderList();
    expect(screen.getByText("alpha-1")).toBeInTheDocument();
    expect(screen.queryByText("beta-1")).not.toBeInTheDocument();
  });

  it("opens the group containing a deep-linked assertion without persisting it", () => {
    urlState.params = new URLSearchParams("assertion=beta-1::judge");
    renderList();

    // group-beta was never stored, yet the deep link reveals its member.
    expect(screen.getByText("beta-1")).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("stays in-memory when no task id is available (no key written)", () => {
    render(<ChecksList checks={checks} projectId="proj-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Alpha suite" }));
    expect(screen.getByText("alpha-1")).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
  });
});
