/**
 * Scene tests: test-result correction UI.
 *
 * 1. A corrected check renders the Corrected badge and the amendment
 *    pointer (full reason on hover); original evidence stays intact. The
 *    actor/reason/time detail lives in the run notices strip (see
 *    run-notices.test.tsx).
 * 2. The dialog sends the exact request, toasts, closes, refreshes.
 * 3. Restore sends clear.
 * 4. Invalid reason disables Save; request failure preserves input + toasts.
 * 5. Non-correctable runs render no correction action.
 * 6. The collapsed-row pencil opens the dialog without expanding.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: (_loader: () => Promise<unknown>) => {
    const Comp = () => null;
    Comp.displayName = "DynamicComponent";
    return Comp;
  },
}));

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

const { toastMocks, correctTestResultMock } = vi.hoisted(() => ({
  toastMocks: { success: vi.fn(), error: vi.fn() },
  correctTestResultMock: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: toastMocks,
}));

vi.mock("@/lib/agent-task-api", () => ({
  correctTestResult: (...args: unknown[]) => correctTestResultMock(...args),
}));
vi.mock("@/lib/check-diagnostics", () => ({ buildCheckDiagnostics: () => [] }));
vi.mock("@/lib/check-source-candidates", () => ({ checkAnchorLine: () => null }));
vi.mock("@/lib/extract-check-block", () => ({ extractCheckBlock: () => null }));
vi.mock("@/lib/locate-assertion", () => ({ locateAssertionsInBlock: () => [] }));
vi.mock("@/lib/assertion-select", () => ({
  buildAssertionParam: () => null,
  parseOwnAssertionId: () => null,
}));

import { TestResultCorrectionDialog } from "./test-result-correction-dialog";
import { ExpandableCheckItem } from "./expandable-check-item";
import type { CheckResult } from "@/lib/agent-task-api";

function correctedCheck(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    id: "report-is-complete",
    pass: true,
    reasoning: "judge missed the table",
    recorded_pass: false,
    correction: {
      id: "cor_1",
      action: "set_pass",
      pass_result: true,
      reason: "Retention is present in the KPI table",
      corrected_by_user_id: "u1",
      corrected_by_label: "u1@test.com",
      corrected_via: "api_key",
      created_at: "2026-08-25T12:00:00Z",
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ExpandableCheckItem corrections", () => {
  function expand() {
    const check = correctedCheck();
    render(<ExpandableCheckItem item={check} index={0} correctable taskRunId="run_1" />);
    fireEvent.click(screen.getByRole("button", { name: /report-is-complete/i }));
    return check;
  }

  it("renders the Corrected badge and the amendment pointer with the reason on hover", () => {
    expand();
    expect(screen.getAllByText("Corrected").length).toBeGreaterThanOrEqual(1);
    const pointer = screen.getByTitle(/Retention is present in the KPI table/);
    expect(pointer.textContent).toMatch(/Amended\s+FAIL → PASS/);
    expect(screen.getByText("judge missed the table")).toBeInTheDocument();
  });

  it("shows Change Correction on a corrected test (row pencil + expanded panel)", () => {
    expand();
    expect(screen.getAllByRole("button", { name: /change correction/i }).length).toBe(2);
  });

  it("shows Correct Result on an uncorrected correctable test (row pencil + expanded panel)", () => {
    render(
      <ExpandableCheckItem
        item={{ id: "plain", pass: false, reasoning: "nope" }}
        index={0}
        correctable
        taskRunId="run_1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /plain/i }));
    expect(screen.getAllByRole("button", { name: /correct result/i }).length).toBe(2);
  });

  it("opens the dialog from the collapsed row pencil without expanding", () => {
    render(
      <ExpandableCheckItem
        item={{ id: "plain", pass: false, reasoning: "nope" }}
        index={0}
        correctable
        taskRunId="run_1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /correct result/i }));
    // Cancel only exists inside the correction dialog.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("renders no correction action when not correctable", () => {
    render(
      <ExpandableCheckItem item={{ id: "plain", pass: false, reasoning: "nope" }} index={0} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /plain/i }));
    expect(screen.queryByRole("button", { name: /correct result|change correction/i })).not.toBeInTheDocument();
  });
});

describe("TestResultCorrectionDialog", () => {
  it("sends set_pass with the exact body, toasts, closes, refreshes", async () => {
    correctTestResultMock.mockResolvedValueOnce({ corrected_tests: 1 });
    render(
      <TestResultCorrectionDialog
        open
        onOpenChange={() => {}}
        taskRunId="run_1"
        check={{ id: "t1", pass: false, reasoning: "" }}
      />,
    );

    // recorded FAIL → default choice PASS
    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: "Retention is present in the KPI table" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

    await waitFor(() => expect(correctTestResultMock).toHaveBeenCalledTimes(1));
    expect(correctTestResultMock).toHaveBeenCalledWith("run_1", {
      test_id: "t1",
      action: "set_pass",
      reason: "Retention is present in the KPI table",
    });
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("Test result corrected"));
    expect(refreshMock).toHaveBeenCalled();
  });

  it("sends set_fail when FAIL is chosen", async () => {
    correctTestResultMock.mockResolvedValueOnce({});
    render(
      <TestResultCorrectionDialog
        open
        onOpenChange={() => {}}
        taskRunId="run_1"
        check={{ id: "t1", pass: true, reasoning: "" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "FAIL" }));
    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: "The trace contains a failed payment call" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

    await waitFor(() =>
      expect(correctTestResultMock).toHaveBeenCalledWith("run_1", {
        test_id: "t1",
        action: "set_fail",
        reason: "The trace contains a failed payment call",
      }),
    );
  });

  it("restore path sends clear without a reason", async () => {
    correctTestResultMock.mockResolvedValueOnce({});
    render(
      <TestResultCorrectionDialog
        open
        onOpenChange={() => {}}
        taskRunId="run_1"
        check={correctedCheck()}
      />,
    );
    // recorded FAIL; choosing FAIL back = restore recorded
    fireEvent.click(screen.getByRole("button", { name: "FAIL", hidden: false }).closest("button") ?? screen.getAllByRole("button", { name: "FAIL" })[0]!);
    // reason textarea hidden in restore mode
    expect(screen.queryByLabelText(/reason/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /restore recorded result/i }));

    await waitFor(() =>
      expect(correctTestResultMock).toHaveBeenCalledWith("run_1", {
        test_id: "report-is-complete",
        action: "clear",
      }),
    );
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("Recorded result restored"));
  });

  it("disables Save until the reason is valid", () => {
    render(
      <TestResultCorrectionDialog
        open
        onOpenChange={() => {}}
        taskRunId="run_1"
        check={{ id: "t1", pass: false, reasoning: "" }}
      />,
    );
    const save = screen.getByRole("button", { name: "Save correction" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "ab" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "valid reason" } });
    expect(save.disabled).toBe(false);
  });

  it("keeps input and toasts an error message on request failure", async () => {
    correctTestResultMock.mockRejectedValueOnce(
      new Error("Backend error 409: run_not_correctable"),
    );
    render(
      <TestResultCorrectionDialog
        open
        onOpenChange={() => {}}
        taskRunId="run_1"
        check={{ id: "t1", pass: false, reasoning: "" }}
      />,
    );
    const reason = screen.getByLabelText(/reason/i) as HTMLTextAreaElement;
    fireEvent.change(reason, { target: { value: "a good reason" } });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalled());
    expect(reason.value).toBe("a good reason");
    expect(screen.getByRole("button", { name: "Save correction" })).toBeInTheDocument();
  });
});
