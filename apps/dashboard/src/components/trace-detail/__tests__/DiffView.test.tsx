import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DiffView } from "../DiffView";

describe("DiffView", () => {
  it("shows diff mode by default with removed and added lines", () => {
    render(<DiffView original="hello world" corrected="hello earth" />);

    expect(screen.getByText("Diff")).toBeInTheDocument();
    expect(screen.getByText("Original")).toBeInTheDocument();
    expect(screen.getByText("Corrected")).toBeInTheDocument();
  });

  it("shows original text when Original tab is clicked", async () => {
    const user = userEvent.setup();
    render(<DiffView original="hello world" corrected="hello earth" />);

    await user.click(screen.getByText("Original"));
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });

  it("shows corrected text when Corrected tab is clicked", async () => {
    const user = userEvent.setup();
    render(<DiffView original="hello world" corrected="hello earth" />);

    await user.click(screen.getByText("Corrected"));
    expect(screen.getByText("hello earth")).toBeInTheDocument();
  });

  it("returns to diff mode after clicking Diff tab", async () => {
    const user = userEvent.setup();
    render(<DiffView original="foo" corrected="bar" />);

    await user.click(screen.getByText("Original"));
    await user.click(screen.getByText("Diff"));

    expect(screen.getByText("Diff")).toBeInTheDocument();
  });

  it("displays equal lines without color coding", () => {
    render(<DiffView original={"same line\nchanged"} corrected={"same line\nmodified"} />);
    const diffContent = document.querySelectorAll(".text-xs.font-mono > div");
    expect(diffContent[0].className).toContain("text-foreground");
    expect(diffContent[0].className).not.toContain("bg-red");
    expect(diffContent[0].className).not.toContain("bg-green");
  });
});
