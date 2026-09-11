import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AssertionDrawer } from "./assertion-drawer";

it("renders an includes assertion's stored received preview", () => {
  render(<AssertionDrawer onClose={vi.fn()} assertion={{
    id: "check", pass: false, reasoning: "missing expected text", evaluator_type: "code",
    expected: "includes invoice", received: {
      kind: "truncated", preview: "Contract text", size_bytes: 5000, sha256: "abc",
    },
  }} />);
  expect(screen.getByText("Contract text… [truncated]")).toBeInTheDocument();
  expect(screen.queryByText("[object Object]")).not.toBeInTheDocument();
});
