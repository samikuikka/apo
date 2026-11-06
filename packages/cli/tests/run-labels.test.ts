import { describe, expect, it } from "vitest";
import { labelsFromFlags, parseLabelRef } from "../src/lib/run-labels.ts";

describe("parseLabelRef", () => {
  it("accepts key:id", () => {
    expect(parseLabelRef("customer:acme")).toEqual({ key: "customer", id: "acme" });
  });

  it("keeps further colons in the id (id is everything after the first colon)", () => {
    expect(parseLabelRef("customer:urn:c:1")).toEqual({ key: "customer", id: "urn:c:1" });
  });

  it("rejects a missing colon", () => {
    expect(() => parseLabelRef("nocolon")).toThrow(
      "--label must be <key>:<id> with a key of letters, digits, '_' or '-' (got 'nocolon')",
    );
  });

  it("rejects an empty id", () => {
    expect(() => parseLabelRef("customer:")).toThrow("--label must be <key>:<id>");
    expect(() => parseLabelRef("customer:   ")).toThrow("--label must be <key>:<id>");
  });

  it("rejects a key with a space", () => {
    expect(() => parseLabelRef("bad key:x")).toThrow("--label must be <key>:<id>");
  });

  it("rejects a key longer than 64 chars", () => {
    expect(() => parseLabelRef(`${"k".repeat(65)}:x`)).toThrow("--label must be <key>:<id>");
  });
});

describe("labelsFromFlags", () => {
  it("maps each key:id to a label with the name defaulting to the id", () => {
    expect(labelsFromFlags(["customer:acme", "area:billing"])).toEqual({
      customer: { id: "acme", name: "acme" },
      area: { id: "billing", name: "billing" },
    });
  });

  it("rejects the same key given twice", () => {
    expect(() => labelsFromFlags(["customer:acme", "customer:globex"])).toThrow(
      "--label customer given more than once; a run carries one value per key",
    );
  });
});
