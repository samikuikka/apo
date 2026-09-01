/**
 * Benchmarks for the Task Revision manifest canonicalizer.
 *
 * Every `apo` task upload hashes the whole task directory and canonicalizes
 * the manifest, and the result must stay byte-identical to the Python twin —
 * so this path is both hot (SHA-256 over every file byte) and contractual.
 */

import { bench, describe } from "vitest";

import {
  buildManifest,
  canonicalManifestJson,
  contentSha256,
  normalizeManifestPath,
  sha256Hex,
} from "../src/agent-task/task-revision-manifest.ts";
import { buildManifestFiles } from "./fixtures.ts";

const FILE_COUNT = 120;
const FILES = buildManifestFiles(FILE_COUNT);
const MANIFEST = buildManifest(FILES);
const WINDOWS_PATHS = FILES.map((f) => f.path.split("/").join("\\"));

describe("task-revision-manifest", () => {
  bench(`buildManifest over ${FILE_COUNT} files`, () => {
    buildManifest(FILES);
  });

  bench(`canonicalManifestJson over a ${FILE_COUNT}-file manifest`, () => {
    canonicalManifestJson(MANIFEST);
  });

  bench(`contentSha256 over a ${FILE_COUNT}-file manifest`, () => {
    contentSha256(MANIFEST);
  });

  bench(`sha256Hex over ${FILE_COUNT} file bodies`, () => {
    for (const file of FILES) {
      sha256Hex(file.content);
    }
  });

  bench(`normalizeManifestPath over ${FILE_COUNT} non-ASCII paths`, () => {
    for (const path of WINDOWS_PATHS) {
      normalizeManifestPath(path);
    }
  });
});
