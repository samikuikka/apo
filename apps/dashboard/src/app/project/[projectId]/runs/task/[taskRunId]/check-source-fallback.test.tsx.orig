/**
 * Source display for check expands whose block can't be pinpointed: ids
 * generated inside an imported helper (helper/factory-registered checks, no
 * anchor line recorded) never appear literally in the eval file. Such a check
 * shows an explanation with the stored file behind a disclosure — never the
 * file presented as the check's code. The literal-block path still shows only
 * that block.
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

describe("ExpandableCheckItem unpinpointable source", () => {
  it("shows the explanation, not the file, when the id has no literal block", () => {
    expand({ id: "dabstep-005-computed-via-python", pass: true } as CheckResult, SOURCE);

    expect(screen.getByText(/Check code is not in the stored source/)).toBeInTheDocument();
    expect(screen.queryByTestId("code-viewer")).not.toBeInTheDocument();
  });

  it("reveals the stored file only when the disclosure is opened", () => {
    expand({ id: "dabstep-005-computed-via-python", pass: true } as CheckResult, SOURCE);

    fireEvent.click(screen.getByRole("button", { name: /Check code is not in the stored source/ }));
    const viewer = screen.getByTestId("code-viewer");
    expect(viewer).toHaveTextContent("trajectoryChecks(check");
  });

  it("keeps the reasoning visible without opening the disclosure", () => {
    expand(
      { id: "dabstep-005-upstream-answer", pass: false, reasoning: "expected NL, got DE" } as CheckResult,
      SOURCE,
    );

    expect(screen.getByText(/expected NL, got DE/)).toBeInTheDocument();
    expect(screen.queryByTestId("code-viewer")).not.toBeInTheDocument();
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
    expect(screen.queryByText(/Check code is not in the stored source/)).not.toBeInTheDocument();
  });

  it("renders no explanation when the source itself is unavailable", () => {
    expand(
      { id: "dabstep-005-computed-via-python", pass: false, reasoning: "expected NL, got DE" } as CheckResult,
      null,
    );

    expect(screen.queryByTestId("code-viewer")).not.toBeInTheDocument();
    expect(screen.queryByText(/Check code is not in the stored source/)).not.toBeInTheDocument();
    expect(screen.getByText(/expected NL, got DE/)).toBeInTheDocument();
  });
});
