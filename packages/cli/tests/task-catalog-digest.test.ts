import { describe, expect, it } from "vitest";
import { computeCatalogDigest } from "../src/lib/task-catalog-digest.ts";
import type { PublishedTask } from "../src/lib/task-catalog.ts";

/*
 * The TypeScript and Python catalog digest functions MUST agree
 * byte-for-byte. This regression test pins the TS output to the value produced
 * by apo.services.task_catalog.compute_catalog_digest for the same input, so a
 * drift (e.g. missing recursive key sort, locale-aware task ordering, or
 * ASCII-escaped serialization) fails the suite. The literals were produced by
 * the Python side; the mixed-case, non-ASCII, and astral-plane fixtures pin
 * the canonical form — code-point task order and raw characters — which
 * localeCompare and JS-default sorting previously broke (a spurious
 * catalog_mismatch for the identical catalog).
 */

const tasks: PublishedTask[] = [
  {
    task_id: "connect-fixture",
    display_name: "connect-fixture",
    task_path: "connect-fixture",
    folder_path: "",
    adapter_name: "x",
    has_checks: true,
    tags: [],
  },
];

const mixedCase: PublishedTask[] = [
  // Code point orders "Support/..." (S = 0x53) before "admin/..." (a = 0x61);
  // locale collation orders them the other way around.
  {
    task_id: "admin/report",
    display_name: "Report a problem",
    task_path: "admin/report",
    folder_path: "admin",
    adapter_name: "x",
    has_checks: true,
    tags: [],
  },
  {
    task_id: "Support/refund",
    display_name: "Issue a refund",
    task_path: "Support/refund",
    folder_path: "Support",
    adapter_name: "x",
    has_checks: true,
    tags: [],
  },
];

const nonAscii: PublishedTask[] = [
  {
    task_id: "équipe/check",
    display_name: "Résumé review",
    task_path: "équipe/check",
    folder_path: "",
    adapter_name: "x",
    has_checks: true,
    tags: ["wiedza", "tägi"],
  },
];

const astral: PublishedTask[] = [
  {
    task_id: "🚀/deploy",
    display_name: "Ship it",
    task_path: "🚀/deploy",
    folder_path: "🚀",
    adapter_name: "x",
    has_checks: false,
    tags: ["🎨"],
  },
  {
    task_id: "Zebra/plain",
    display_name: "Last in code-point order",
    task_path: "Zebra/plain",
    folder_path: "Zebra",
    adapter_name: "x",
    has_checks: false,
    tags: [],
  },
];

describe("cross-language catalog digest", () => {
  it("matches the Python compute_catalog_digest for a single task", () => {
    expect(computeCatalogDigest(tasks)).toBe(
      "sha256:bd8001ea07d09cae7acddc06ecf372f4309c95880fcc1ed91532b7475f3a7e14",
    );
  });

  it("orders mixed-case ids by code point, not locale", () => {
    expect(computeCatalogDigest(mixedCase)).toBe(
      "sha256:1a1bbd7eeb04e947bc2e01e13844866682d0f11bbdbc1ae92423b163a5a02df6",
    );
  });

  it("hashes non-ASCII text raw, matching Python's ensure_ascii=False", () => {
    expect(computeCatalogDigest(nonAscii)).toBe(
      "sha256:37e88cfb9d40ca3c679924403237221e3e4139a9530131836b4cc72f2d716031",
    );
  });

  it("sorts an astral-plane id by its UTF-8 bytes like Python sorts code points", () => {
    expect(computeCatalogDigest(astral)).toBe(
      "sha256:0f4ecb913df95f992005f16a81c0814ff085e812fc7a9557d038c9b101935dee",
    );
  });

  it("sorts tasks and tags so ordering does not change the digest", () => {
    const reversed: PublishedTask[] = [...tasks].reverse();
    expect(computeCatalogDigest(reversed)).toBe(computeCatalogDigest(tasks));
    expect(computeCatalogDigest([...mixedCase].reverse())).toBe(
      computeCatalogDigest(mixedCase),
    );
    expect(computeCatalogDigest([...astral].reverse())).toBe(computeCatalogDigest(astral));
  });

  it("produces a stable, sorted-key payload (keys inside each task are alphabetical)", () => {
    // Sanity: a task with non-alphabetical insertion order still digests to the
    // same value as the alphabetically-keyed Python output.
    const shuffled = computeCatalogDigest([
      {
        adapter_name: "x",
        tags: [],
        has_checks: true,
        task_path: "connect-fixture",
        display_name: "connect-fixture",
        folder_path: "",
        task_id: "connect-fixture",
      },
    ]);
    expect(shuffled).toBe(computeCatalogDigest(tasks));
  });
});
