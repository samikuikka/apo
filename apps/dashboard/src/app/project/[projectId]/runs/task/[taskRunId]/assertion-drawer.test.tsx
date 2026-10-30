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

it("renders an embedding assertion's strip with model, score, and settings signature", () => {
  render(<AssertionDrawer onClose={vi.fn()} assertion={{
    id: "semantic", pass: true,
    reasoning: "semantic similarity 0.8123 ≥ 0.7000 [test/embed:1536d:cosine:apo-v1]",
    evaluator_type: "embedding",
    expected: "cosine ≥ 0.7000 (test/embed:1536d)",
    received: 0.8123,
    embedding: {
      model: "test/embed", dimensions: 1536, similarity: 0.8123, threshold: 0.7,
      metric: "cosine", settings_hash: "test/embed:1536d:cosine:apo-v1",
      value_preview: "The refund policy allows returns within 30 days.",
      reference_preview: "Refunds are possible for 30 days after purchase.",
    },
  }} />);
  // The strip shows what graded and under which pinned settings.
  expect(screen.getByText("test/embed:1536d")).toBeInTheDocument();
  expect(screen.getByText("test/embed:1536d:cosine:apo-v1")).toBeInTheDocument();
  // The score shows twice by design: the Received value and the strip bar.
  expect(screen.getAllByText("0.8123")).toHaveLength(2);
  expect(screen.getByText("Value")).toBeInTheDocument();
  expect(screen.getByText("Reference")).toBeInTheDocument();
  expect(screen.getByText(/refund policy allows returns/u)).toBeInTheDocument();
});

it("renders a marginal flag when the score sits within 0.02 of the threshold", () => {
  render(<AssertionDrawer onClose={vi.fn()} assertion={{
    id: "semantic", pass: true,
    reasoning: "semantic similarity 0.7071 ≥ 0.7000 [test/embed:2d:cosine:apo-v1]. Verdict is marginal: within 0.02 of the threshold, it will flip on model drift",
    evaluator_type: "embedding",
    expected: "cosine ≥ 0.7000 (test/embed:2d)",
    received: 0.7071,
    embedding: {
      model: "test/embed", dimensions: 2, similarity: 0.7071, threshold: 0.7,
      metric: "cosine", settings_hash: "test/embed:2d:cosine:apo-v1",
    },
  }} />);
  expect(screen.getByText("marginal")).toBeInTheDocument();
});
