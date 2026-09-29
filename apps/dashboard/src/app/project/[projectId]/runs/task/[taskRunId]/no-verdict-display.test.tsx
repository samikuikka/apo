/**
 * Issue #323: judge-errored checks render distinctly on the run page —
 * a warning badge + "No verdict" chip instead of a red ✗/FAIL treatment,
 * and an "Unsupported" chip for trace-evidence failures (fail-closed).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: (_loader: () => Promise<unknown>) => {
    const Comp = () => null;
    Comp.displayName = "DynamicComponent";
    return Comp;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

vi.mock("@/lib/agent-task-api", () => ({}));
vi.mock("@/lib/check-diagnostics", () => ({ buildCheckDiagnostics: () => [] }));
vi.mock("@/lib/extract-check-block", () => ({
  resolveCheckBlock: () => null,
  extractCheckBlock: () => null,
}));
vi.mock("@/lib/locate-assertion", () => ({ locateAssertionsInBlock: () => [] }));
vi.mock("@/lib/assertion-select", () => ({
  buildAssertionParam: () => null,
  parseOwnAssertionId: () => null,
}));

import { ExpandableCheckItem } from "./expandable-check-item";
import type { CheckResult } from "@/lib/agent-task-api";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ExpandableCheckItem judge-error display", () => {
  it("marks a no-verdict check with the warning badge and chip", () => {
    const check: CheckResult = {
      id: "quality",
      pass: false,
      outcome: "error",
      reasoning: "judge failed: gateway timeout",
    };
    render(<ExpandableCheckItem item={check} index={0} />);

    expect(screen.getByText("!")).toBeInTheDocument();
    expect(screen.getByText("No verdict")).toBeInTheDocument();
    // The transport error stays visible on the collapsed row.
    expect(screen.getByText(/judge failed: gateway timeout/)).toBeInTheDocument();
  });

  it("keeps a genuine failure without a chip", () => {
    const check: CheckResult = {
      id: "quality",
      pass: false,
      reasoning: "the memo is missing the budget table",
    };
    render(<ExpandableCheckItem item={check} index={0} />);

    expect(screen.getByText("✗")).toBeInTheDocument();
    expect(screen.queryByText("No verdict")).not.toBeInTheDocument();
  });

  it("marks unsupported checks with their own chip, not the error one", () => {
    const check: CheckResult = {
      id: "duration",
      pass: false,
      outcome: "unsupported",
      reasoning: "duration-check evidence is unavailable",
    };
    render(<ExpandableCheckItem item={check} index={0} />);

    expect(screen.getByText("Unsupported")).toBeInTheDocument();
    expect(screen.queryByText("No verdict")).not.toBeInTheDocument();
  });
});
