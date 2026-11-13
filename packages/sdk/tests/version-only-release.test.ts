import { describe, expect, it } from "vitest";
import { isVersionOnlyManifestChange } from "../../../scripts/is-version-only-npm-release.mjs";

const manifest = {
  name: "@apo-ai/sdk",
  version: "0.9.2",
  dependencies: { zod: "^3.22.0" },
};

describe("version-only npm release detection", () => {
  it("accepts a semver-only manifest bump", () => {
    const after = { ...manifest, version: "0.9.3" };
    expect(isVersionOnlyManifestChange(JSON.stringify(manifest), JSON.stringify(after))).toBe(true);
    expect(
      isVersionOnlyManifestChange(
        JSON.stringify(manifest),
        JSON.stringify({ ...manifest, version: "1.0.0-rc.1+build.2" }),
      ),
    ).toBe(true);
  });

  it("rejects dependency changes hidden beside a version bump", () => {
    const after = {
      ...manifest,
      version: "0.9.3",
      dependencies: { zod: "^4.0.0" },
    };
    expect(isVersionOnlyManifestChange(JSON.stringify(manifest), JSON.stringify(after))).toBe(false);
  });

  it("rejects unchanged, malformed, and invalid-version manifests", () => {
    expect(isVersionOnlyManifestChange(JSON.stringify(manifest), JSON.stringify(manifest))).toBe(false);
    expect(isVersionOnlyManifestChange("not json", JSON.stringify(manifest))).toBe(false);
    expect(
      isVersionOnlyManifestChange(
        JSON.stringify(manifest),
        JSON.stringify({ ...manifest, version: "next" }),
      ),
    ).toBe(false);
  });
});

describe("npm version-regression guard", () => {
  it("flags a manifest lower than the published version and allows everything else", async () => {
    const { publishedVersionIsHigher } = await import(
      "../../../scripts/npm-version-guard.mjs"
    );
    expect(publishedVersionIsHigher("0.17.1", "0.18.1")).toBe(true);
    expect(publishedVersionIsHigher("0.18.2", "0.18.1")).toBe(false);
    expect(publishedVersionIsHigher("0.18.1", "0.18.1")).toBe(false);
    expect(publishedVersionIsHigher("1.0.0-rc.1", "1.0.0")).toBe(true);
    expect(publishedVersionIsHigher("0.18.1", "1.0.0-rc.1")).toBe(true);
    expect(publishedVersionIsHigher("not-semver", "0.18.1")).toBe(false);
  });

  it("compares prereleases of the same release tuple per semver", async () => {
    const { publishedVersionIsHigher } = await import(
      "../../../scripts/npm-version-guard.mjs"
    );
    expect(publishedVersionIsHigher("1.0.0-rc.1", "1.0.0-rc.2")).toBe(true);
    expect(publishedVersionIsHigher("1.0.0-rc.2", "1.0.0-rc.1")).toBe(false);
    expect(publishedVersionIsHigher("1.0.0-rc.2", "1.0.0-rc.2")).toBe(false);
    expect(publishedVersionIsHigher("1.0.0-rc", "1.0.0-rc.1")).toBe(true);
    expect(publishedVersionIsHigher("1.0.0-beta.2", "1.0.0-rc.1")).toBe(true);
  });
});
