/**
 * canonical Task Revision manifest.
 *
 * Pure, dependency-free canonicalizer. Both this module and its Python twin
 * (`backend/apo/execution/task_revision_manifest.py`) MUST produce
 * byte-identical canonical JSON and digests for any given file tree — the
 * task-revision identity is content-addressed on both sides of the wire.
 *
 * Canonicalization rules:
 *   - `/` path separators (caller `\` normalized to `/`);
 *   - Unicode NFC normalization of the path;
 *   - bytewise lexical ordering of normalized UTF-8 paths (NOT UTF-16 —
 *     diverges for codepoints > U+007F);
 *   - exact file-byte SHA-256 (lowercase hex);
 *   - mode reduced to `regular` | `executable`;
 *   - ownership, timestamps, inode metadata, and absolute paths excluded.
 *
 * `contentSha256` is the SHA-256 of the compact canonical JSON built from
 * `schemaVersion` and the sorted `files` array. The `summary` block is NOT
 * part of source identity.
 */

import { createHash } from "node:crypto";

export type ModeClass = "regular" | "executable";

export interface ManifestFile {
  path: string;
  sizeBytes: number;
  sha256: string;
  modeClass: ModeClass;
}

export interface TaskRevisionManifestV1 {
  schemaVersion: 1;
  files: ManifestFile[];
  summary: {
    fileCount: number;
    uncompressedSizeBytes: number;
    excludedFileCount: number;
    excludedDirectoryCount: number;
  };
}

/** Caller-reported file, before canonicalization. `content` is the exact bytes. */
export interface ManifestFileInput {
  path: string;
  modeClass: ModeClass;
  content: Uint8Array;
}

/**
 * Normalize a caller-reported path to canonical POSIX + NFC form.
 * Validation (no leading slash, no `.`/`..` segments) is the filesystem
 * walker's responsibility; this function only makes representation canonical.
 */
export function normalizeManifestPath(path: string): string {
  return path.split("\\").join("/").normalize("NFC");
}

/** SHA-256 of exact bytes, lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Compare two UTF-8 strings by their raw byte ordering (not UTF-16 code units). */
function compareBytewiseUtf8(a: string, b: string): number {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  for (let i = 0; i < Math.min(ba.length, bb.length); i++) {
    if (ba[i]! !== bb[i]!) return ba[i]! < bb[i]! ? -1 : 1;
  }
  return ba.length - bb.length;
}

/**
 * Build the canonical V1 manifest from already-included files. Exclusion
 * counts default to zero; the filesystem walker supplies real counts when it
 * wraps this via `withExclusionCounts`.
 */
export function buildManifest(
  files: ManifestFileInput[],
  summary?: { excludedFileCount: number; excludedDirectoryCount: number },
): TaskRevisionManifestV1 {
  const entries = files.map((f) => {
    const path = normalizeManifestPath(f.path);
    return {
      path,
      sizeBytes: f.content.byteLength,
      sha256: sha256Hex(f.content),
      modeClass: f.modeClass,
    } satisfies ManifestFile;
  });

  entries.sort((a, b) => compareBytewiseUtf8(a.path, b.path));

  return {
    schemaVersion: 1,
    files: entries,
    summary: {
      fileCount: entries.length,
      uncompressedSizeBytes: entries.reduce((n, f) => n + f.sizeBytes, 0),
      excludedFileCount: summary?.excludedFileCount ?? 0,
      excludedDirectoryCount: summary?.excludedDirectoryCount ?? 0,
    },
  };
}

/**
 * Compact canonical JSON over `schemaVersion` + the sorted `files` array only.
 * Object keys are alphabetical at every level; no whitespace; non-ASCII
 * emitted as UTF-8 (matches Python `json.dumps(sort_keys=True,
 * ensure_ascii=False, separators=(",", ":"))`). The `summary` block is
 * intentionally excluded from source identity.
 */
export function canonicalManifestJson(manifest: TaskRevisionManifestV1): string {
  const filesPayload = manifest.files.map((f) => ({
    modeClass: f.modeClass,
    path: f.path,
    sha256: f.sha256,
    sizeBytes: f.sizeBytes,
  }));
  return JSON.stringify({ files: filesPayload, schemaVersion: manifest.schemaVersion });
}

/** SHA-256 (lowercase hex) of the canonical manifest JSON's UTF-8 bytes. */
export function contentSha256(manifest: TaskRevisionManifestV1): string {
  return sha256Hex(Buffer.from(canonicalManifestJson(manifest), "utf8"));
}
