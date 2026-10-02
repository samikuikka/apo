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
