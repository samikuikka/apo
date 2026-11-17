/**
 * Whole-file fallback for check source on the run page: a check whose id has
 * no literal block in the eval file (helper/factory-registered checks — ids
 * generated inside an imported helper, no anchor line recorded) still shows
 * the file rather than nothing, with the verdict detail below it. The block
 * path (check id appears literally) keeps showing only that block.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: (_loader: () => Promise<unknown>) => {
    // Render the code prop so tests can assert what the viewer received.
    const Comp = ({ code }: { code?: string }) => <pre data-testid="code-viewer">{code}</pre>;
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
vi.mock("@/lib/locate-assertion", () => ({ locateAssertionsInBlock: () => [] }));
vi.mock("@/lib/assertion-select", () => ({
  buildAssertionParam: () => null,
  parseOwnAssertionId: () => null,
}));

import { ExpandableCheckItem } from "./expandable-check-item";
import type { CheckResult, TaskFileContentResponse } from "@/lib/agent-task-api";

const SOURCE: TaskFileContentResponse = {
  name: "dabstep-005.eval.ts",
  path: "dabstep-005.eval.ts",
  content: [
    'import { task } from "@apo-ai/sdk/agent-task";',
    'import { trajectoryChecks } from "../../../lib/dabstep.ts";',
    "",
    'const { test: check } = task("dabstep-005", {});',
    "",
    'trajectoryChecks(check, { taskId: "dabstep-005" });',
  ].join("\n"),
  size_bytes: 200,
  language: "typescript",
  lines: 7,
};

function expand(item: CheckResult, checksSource: TaskFileContentResponse | null) {
  render(<ExpandableCheckItem item={item} index={0} checksSource={checksSource} />);
  fireEvent.click(screen.getByText(String(item.id)).closest("button")!);
}

describe("ExpandableCheckItem check-source fallback", () => {
  it("shows the whole file when the check id has no literal block", () => {
    expand({ id: "dabstep-005-computed-via-python", pass: true } as CheckResult, SOURCE);

    const viewer = screen.getByTestId("code-viewer");
    // The file the run recorded, not nothing — the id lives in an imported
    // helper, so no block can be pinpointed.
    expect(viewer).toHaveTextContent("trajectoryChecks(check");
  });

  it("keeps the reasoning visible below a whole-file fallback", () => {
    expand(
      { id: "dabstep-005-upstream-answer", pass: false, reasoning: "expected NL, got DE" } as CheckResult,
      SOURCE,
    );

    expect(screen.getByTestId("code-viewer")).toHaveTextContent("trajectoryChecks(check");
    expect(screen.getByText(/expected NL, got DE/)).toBeInTheDocument();
  });

  it("shows only the check's own block when the id appears literally", () => {
    const literal: TaskFileContentResponse = {
      ...SOURCE,
      content: [
        'test("document-state", (t) => {',
        "  t.check(1, equals(1));",
        "});",
        'test("other-check", (t) => {',
        "  t.check(2, equals(2));",
        "});",
      ].join("\n"),
    };
    expand({ id: "document-state", pass: true } as CheckResult, literal);

    const viewer = screen.getByTestId("code-viewer");
    expect(viewer).toHaveTextContent("document-state");
    expect(viewer).toHaveTextContent("t.check(1");
    expect(viewer).not.toHaveTextContent("other-check");
  });

  it("renders no viewer when the source itself is unavailable", () => {
    expand(
      { id: "dabstep-005-computed-via-python", pass: false, reasoning: "expected NL, got DE" } as CheckResult,
      null,
    );

    expect(screen.queryByTestId("code-viewer")).not.toBeInTheDocument();
    expect(screen.getByText(/expected NL, got DE/)).toBeInTheDocument();
  });
});
