import { describe, expect, it } from "vitest";
import {
  findByPrefix,
  uniquePrefixLengths,
  highlightId,
  highlightIds,
} from "../src/lib/prefix.ts";
import { resolveProject } from "../src/lib/projects.ts";
import { stripAnsi } from "../src/lib/format.ts";

describe("uniquePrefixLengths", () => {
  it("returns the minimal distinguishing prefix per id", () => {
    // cfa9... vs 874a... vs demo -> first char already differs for demo, but
    // the two hex ids need to diverge at position 0 too (c vs 8).
    const lens = uniquePrefixLengths(["cfa9319e3a8f", "874a6f17da94", "demo"]);
    expect(lens).toEqual([1, 1, 1]);
  });

  it("extends the prefix when ids share a stem", () => {
    // abc123 / abc456 share "abc"; def789 diverges immediately.
    const lens = uniquePrefixLengths(["abc123", "abc456", "def789"]);
    expect(lens).toEqual([4, 4, 1]);
  });

  it("handles two ids that share a long stem", () => {
    const lens = uniquePrefixLengths(["deadbeef01", "deadbeef99"]);
    expect(lens).toEqual([9, 9]);
  });

  it("floors a lone item to 1 highlighted char", () => {
    expect(uniquePrefixLengths(["only"])).toEqual([1]);
  });

  it("preserves input order in the output", () => {
    const lens = uniquePrefixLengths(["def789", "abc123", "abc456"]);
    expect(lens).toEqual([1, 4, 4]);
  });

  it("returns [] for empty input", () => {
    expect(uniquePrefixLengths([])).toEqual([]);
  });
});

describe("highlightId", () => {
  it("colors the unique portion cyan and dims the rest", () => {
    const out = highlightId("cfa9319e3a8f", 4);
    // cyan wrap around the first 4 chars, dim wrap around the remainder.
    expect(out).toContain("\x1b[36mcfa9\x1b[0m");
    expect(out).toContain("\x1b[2m319e3a8f\x1b[0m");
    expect(stripAnsi(out)).toBe("cfa9319e3a8f");
  });

  it("colors the whole id when unique length meets/exceeds its length", () => {
    expect(highlightId("demo", 4)).toBe("\x1b[36mdemo\x1b[0m");
    expect(highlightId("demo", 9)).toBe("\x1b[36mdemo\x1b[0m");
  });

  it("returns the id unchanged for zero length", () => {
    expect(highlightId("cfa9", 0)).toBe("cfa9");
  });
});

describe("highlightIds", () => {
  it("highlights a whole set by minimal unique prefix", () => {
    const labels = highlightIds(["abc123", "abc456", "def789"]);
    expect(labels.map(stripAnsi)).toEqual(["abc123", "abc456", "def789"]);
    expect(labels[0]).toContain("\x1b[36mabc1\x1b[0m");
    expect(labels[2]).toContain("\x1b[36md\x1b[0m");
  });
});

describe("findByPrefix", () => {
  const items = [
    { id: "cfa9319e3a8f", name: "main" },
    { id: "874a6f17da94", name: "example" },
    { id: "cfa9abcdef0", name: "other-c" },
  ];

  it("returns unique when exactly one id starts with the prefix", () => {
    expect(findByPrefix(items, "874", (i) => i.id)).toEqual({
      status: "unique",
      item: items[1],
    });
  });

  it("returns ambiguous when several ids share the prefix", () => {
    const r = findByPrefix(items, "cfa9", (i) => i.id);
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") {
      expect(r.items).toHaveLength(2);
    }
  });

  it("returns none when nothing matches", () => {
    expect(findByPrefix(items, "zzz", (i) => i.id).status).toBe("none");
  });
});

describe("resolveProject", () => {
  const projects = [
    { id: "cfa9319e3a8f", name: "main" },
    { id: "874a6f17da94", name: "example-service" },
  ];

  it("matches an exact id", () => {
    expect(resolveProject(projects, "cfa9319e3a8f")).toEqual({
      status: "unique",
      item: projects[0],
    });
  });

  it("matches an exact name", () => {
    expect(resolveProject(projects, "main")).toEqual({
      status: "unique",
      item: projects[0],
    });
  });

  it("matches a unique id prefix", () => {
    expect(resolveProject(projects, "cfa9").status).toBe("unique");
    expect(resolveProject(projects, "874").status).toBe("unique");
  });

  it("is none for an unknown prefix/name", () => {
    expect(resolveProject(projects, "nope").status).toBe("none");
  });
});
