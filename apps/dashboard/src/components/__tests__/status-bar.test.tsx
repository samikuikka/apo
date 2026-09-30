/**
 * The bottom status bar is the one place a self-hoster can always find the
 * docs, the repository, and the version the dashboard they are looking at
 * was built from — these pin those three facts.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { StatusBar } from "../status-bar";
import pkg from "../../../package.json";

describe("StatusBar", () => {
  it("links the docs site and the repository", () => {
    render(<StatusBar />);
    expect(
      screen.getByRole("link", { name: "Docs" }).getAttribute("href"),
    ).toBe("https://docs.test-apo.online");
    expect(
      screen.getByRole("link", { name: "GitHub" }).getAttribute("href"),
    ).toBe("https://github.com/samikuikka/apo");
  });

  it("shows the version the dashboard was built from", () => {
    render(<StatusBar />);
    expect(screen.getByText(`apo v${pkg.version}`)).toBeTruthy();
  });
});
