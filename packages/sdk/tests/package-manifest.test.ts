import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(__dirname, "..");
const REPO_ROOT = join(PKG_DIR, "..", "..");

type ExportConditions = Record<string, string>;

interface PackageExports {
  [key: string]: ExportConditions;
}

interface SdkPackageJson {
  name: string;
  version: string;
  description: string;
  type: string;
  license: string;
  files: string[];
  engines?: { node?: string };
  repository?: { type?: string; url?: string; directory?: string };
  homepage?: string;
  bugs?: { url?: string };
  exports?: PackageExports;
  publishConfig?: {
    access?: string;
    registry?: string;
    exports?: PackageExports;
  };
}

function readSdkManifest(): SdkPackageJson {
  return JSON.parse(
    readFileSync(join(PKG_DIR, "package.json"), "utf8"),
  ) as SdkPackageJson;
}

const FIVE_PUBLIC_EXPORTS = [
  "./otel",
  "./agent-task",
  "./agent-task/integrations/ai-sdk",
  "./agent-task/integrations/openai",
  "./agent-task/integrations/anthropic",
] as const;

describe("@apo-ai/sdk package manifest", () => {
  describe("public metadata", () => {
    const pkg = readSdkManifest();

    it("is named @apo-ai/sdk", () => {
      expect(pkg.name).toBe("@apo-ai/sdk");
    });

    it("declares a non-empty description", () => {
      expect(typeof pkg.description).toBe("string");
      expect(pkg.description.length).toBeGreaterThan(10);
    });

    it("is ESM-only (type: module)", () => {
      expect(pkg.type).toBe("module");
    });

    it("ships dist, LICENSE, and README only", () => {
      expect(pkg.files).toEqual(expect.arrayContaining(["dist", "LICENSE", "README.md"]));
    });

    it("requires Node >=20", () => {
      expect(pkg.engines?.node).toMatch(/>=\s*20/);
    });

    it("is MIT licensed", () => {
      expect(pkg.license).toBe("MIT");
    });

    it("declares the git repository with a packages/sdk directory", () => {
      expect(pkg.repository?.type).toBe("git");
      expect(pkg.repository?.url).toContain("github.com");
      expect(pkg.repository?.directory).toBe("packages/sdk");
    });

    it("declares homepage and bugs urls", () => {
      // Homepage moved to the docs site (feat(docs) discovery); bugs stay on
      // GitHub. Both must be absolute https URLs.
      expect(pkg.homepage).toMatch(/^https:\/\//);
      expect(pkg.bugs?.url).toContain("github.com");
    });
  });

  describe("publishConfig", () => {
    const pkg = readSdkManifest();

    it("is present", () => {
      expect(pkg.publishConfig).toBeDefined();
    });

    it("is scoped public on the public npm registry", () => {
      expect(pkg.publishConfig?.access).toBe("public");
      expect(pkg.publishConfig?.registry).toBe("https://registry.npmjs.org/");
    });

    it("declares exactly the five public export keys", () => {
      const keys = Object.keys(pkg.publishConfig?.exports ?? {}).sort();
      expect(keys).toEqual([...FIVE_PUBLIC_EXPORTS].sort());
    });

    it("never exposes a development condition in the packed manifest", () => {
      for (const [name, conditions] of Object.entries(pkg.publishConfig?.exports ?? {})) {
        for (const cond of Object.keys(conditions)) {
          expect(cond).not.toBe("development");
          void name;
        }
      }
    });

    it("places types as the first condition in every published export", () => {
      for (const [name, conditions] of Object.entries(pkg.publishConfig?.exports ?? {})) {
        const condKeys = Object.keys(conditions);
        expect(condKeys[0]).toBe("types");
        void name;
      }
    });

    it("points every published target under ./dist/", () => {
      for (const conditions of Object.values(pkg.publishConfig?.exports ?? {})) {
        for (const target of Object.values(conditions)) {
          expect(target.startsWith("./dist/")).toBe(true);
          expect(target.includes("/src/")).toBe(false);
        }
      }
    });
  });

  describe("source vs published export parity", () => {
    const pkg = readSdkManifest();

    it("exposes the same five export keys from source and from publishConfig", () => {
      const srcKeys = Object.keys(pkg.exports ?? {}).sort();
      const pubKeys = Object.keys(pkg.publishConfig?.exports ?? {}).sort();
      expect(srcKeys).toEqual([...FIVE_PUBLIC_EXPORTS].sort());
      expect(pubKeys).toEqual([...FIVE_PUBLIC_EXPORTS].sort());
    });

    it("keeps the development condition only in the source manifest", () => {
      for (const conditions of Object.values(pkg.exports ?? {})) {
        expect(Object.keys(conditions)).toContain("development");
      }
      for (const conditions of Object.values(pkg.publishConfig?.exports ?? {})) {
        expect(Object.keys(conditions)).not.toContain("development");
      }
    });

    it("points the published import/default at the same dist file the source declares", () => {
      for (const key of FIVE_PUBLIC_EXPORTS) {
        const src = pkg.exports?.[key];
        const pub = pkg.publishConfig?.exports?.[key];
        if (!src || !pub) continue;
        // Source 'default' and published 'import'/'default' must all hit dist.
        expect(src.default?.startsWith("./dist/")).toBe(true);
        expect(pub.import?.startsWith("./dist/")).toBe(true);
        expect(pub.default?.startsWith("./dist/")).toBe(true);
        expect(pub.import).toBe(src.default);
      }
    });
  });

  describe("LICENSE inclusion", () => {
    it("ships a package-local LICENSE that matches the repo root LICENSE", () => {
      const root = readFileSync(join(REPO_ROOT, "LICENSE"), "utf8");
      const local = readFileSync(join(PKG_DIR, "LICENSE"), "utf8");
      expect(local.trim()).toBe(root.trim());
    });
  });
});
