"""Deterministic Execution Bundle create / verify / extract.

An Execution Bundle is a deterministic ``tar.gz``:

    manifest.json            # full TaskRevisionManifestV1 (schemaVersion+files+summary)
    workspace/<source files> # regular/executable only

Determinism: gzip mtime zero; fixed tar
uid/gid/user/group/mtime; deterministic mode from ``modeClass``; entries sorted
by path. ``content_sha256`` (over schemaVersion + sorted files) is recomputed
on verify and must match.

Safety: reject absolute paths, ``..``
components, duplicate normalized paths, entries outside ``workspace/``, link /
device entries, size/count/digest mismatches, and any resolved destination
outside the fresh workspace. Bounded: never load a whole Bundle into memory.

This module is PURE: it takes bytes/paths in and produces bundles/verified
views out. Filesystem walking lives in the service layer.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import tarfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

from apo.execution.task_revision_manifest import (
    ManifestFile,
    ManifestFileInput,
    ManifestSummary,
    ModeClass,
    TaskRevisionManifestV1,
    build_manifest,
    content_sha256,
    normalize_manifest_path,
    sha256_hex,
)

_MANIFEST_NAME = "manifest.json"
_WORKSPACE_PREFIX = "workspace/"


@dataclass(frozen=True)
class BundleLimits:
    """Exceeded limits raise :class:`BundleError` and leave no bundle."""

    max_file_count: int = 50_000
    max_total_uncompressed_bytes: int = 256 * 1024 * 1024
    max_file_bytes: int = 64 * 1024 * 1024
    max_compressed_bytes: int = 128 * 1024 * 1024
    max_path_segment_bytes: int = 256
    max_path_bytes: int = 4_096
    # The manifest summary is metadata only (path + size + sha per file). 4 KiB
    # rejected ordinary task trees (~40 files); bound it at 256 KiB so real
    # trees pass while still preventing unbounded transport. Capped by
    # max_file_count above.
    max_manifest_summary_bytes: int = 256 * 1024


DEFAULT_BUNDLE_LIMITS = BundleLimits()


BundleErrorKind = Literal["limit", "structure", "digest", "escape"]


class BundleError(Exception):
    """Typed bundle failure (limit / structure / digest / escape)."""

    def __init__(self, kind: BundleErrorKind, message: str) -> None:
        super().__init__(f"[{kind}] {message}")
        self.kind: BundleErrorKind = kind


@dataclass(frozen=True)
class BundleEntry:
    """One source file to pack: a normalized POSIX path, mode, and exact bytes."""

    path: str
    mode_class: ModeClass
    content: bytes


@dataclass(frozen=True)
class VerifiedBundle:
    """A bundle that passed structural, limit, and digest verification."""

    manifest: TaskRevisionManifestV1
    content_sha256: str
    bundle_size_bytes: int
    bundle_sha256: str
    bundle_path: Path


def _mode_for(mode_class: ModeClass) -> int:
    return 0o755 if mode_class == "executable" else 0o644


def _validate_entry_path(path: str, limits: BundleLimits) -> str:
    """Normalize + validate a caller/in-archive path. Returns the POSIX+NFC form."""
    normalized = normalize_manifest_path(path)
    if not normalized or normalized.startswith("/"):
        raise BundleError("structure", f"path is absolute or empty: {path!r}")
    segments = normalized.split("/")
    for seg in segments:
        if seg in ("", ".", ".."):
            raise BundleError("structure", f"path contains invalid segment: {path!r}")
        if len(seg.encode("utf-8")) > limits.max_path_segment_bytes:
            raise BundleError("limit", f"path segment exceeds {limits.max_path_segment_bytes} bytes")
    if len(normalized.encode("utf-8")) > limits.max_path_bytes:
        raise BundleError("limit", f"path exceeds {limits.max_path_bytes} bytes")
    return normalized


def manifest_to_json(manifest: TaskRevisionManifestV1) -> str:
    """Deterministic full-manifest serialization (sorted keys, compact, ascii-false)."""
    payload = {
        "schemaVersion": manifest.schema_version,
        "files": [
            {
                "modeClass": f.mode_class,
                "path": f.path,
                "sha256": f.sha256,
                "sizeBytes": f.size_bytes,
            }
            for f in manifest.files
        ],
        "summary": {
            "fileCount": manifest.summary.file_count,
            "uncompressedSizeBytes": manifest.summary.uncompressed_size_bytes,
            "excludedFileCount": manifest.summary.excluded_file_count,
            "excludedDirectoryCount": manifest.summary.excluded_directory_count,
        },
    }
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def manifest_from_json(text: str) -> TaskRevisionManifestV1:
    """Parse a manifest serialized by :func:`manifest_to_json`."""
    obj = cast(dict[str, object], json.loads(text))
    raw_sv = obj.get("schemaVersion")
    if not isinstance(raw_sv, int) or raw_sv != 1:
        raise BundleError("structure", f"unsupported schemaVersion: {raw_sv!r}")
    raw_files = obj.get("files")
    if not isinstance(raw_files, list):
        raise BundleError("structure", "files must be a list")
    files: list[ManifestFile] = []
    for raw in cast(list[object], raw_files):
        f = cast(dict[str, object], raw)
        mode = str(f.get("modeClass"))
        if mode not in ("regular", "executable"):
            raise BundleError("structure", f"bad modeClass: {mode!r}")
        files.append(
            ManifestFile(
                path=str(f.get("path")),
                size_bytes=_as_int(f.get("sizeBytes")),
                sha256=str(f.get("sha256")),
                mode_class=mode,
            )
        )
    summary_obj = cast(dict[str, object], obj.get("summary"))
    summary = ManifestSummary(
        file_count=_as_int(summary_obj.get("fileCount")),
        uncompressed_size_bytes=_as_int(summary_obj.get("uncompressedSizeBytes")),
        excluded_file_count=_as_int(summary_obj.get("excludedFileCount")),
        excluded_directory_count=_as_int(summary_obj.get("excludedDirectoryCount")),
    )
    return TaskRevisionManifestV1(
        schema_version=raw_sv, files=files, summary=summary
    )


def _as_int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise BundleError("structure", f"expected int, got {type(value).__name__}")
    return value


def _check_pre_write_limits(entries: Sequence[BundleEntry], limits: BundleLimits) -> None:
    if len(entries) > limits.max_file_count:
        raise BundleError("limit", f"too many files: {len(entries)} > {limits.max_file_count}")
    total = 0
    seen: set[str] = set()
    for e in entries:
        normalized = _validate_entry_path(e.path, limits)
        if normalized in seen:
            raise BundleError("structure", f"duplicate path after normalization: {e.path!r}")
        seen.add(normalized)
        if len(e.content) > limits.max_file_bytes:
            raise BundleError("limit", f"file {normalized!r} exceeds {limits.max_file_bytes} bytes")
        total += len(e.content)
        if total > limits.max_total_uncompressed_bytes:
            raise BundleError("limit", "total uncompressed size exceeds limit")
    return None


def write_bundle(
    entries: Sequence[BundleEntry],
    destination: Path,
    *,
    limits: BundleLimits = DEFAULT_BUNDLE_LIMITS,
) -> tuple[int, str]:
    """Write a deterministic ``tar.gz`` bundle to ``destination``.

    Returns ``(compressed_size, sha256)`` of the written bytes. Validates limits
    up front (file count, sizes, paths) and the compressed-size cap after
    writing. Leaves no partial file on failure.
    """
    _check_pre_write_limits(entries, limits)

    # Normalize + sort entries so the archive is order-independent.
    normalized = sorted(
        (
            BundleEntry(
                path=_validate_entry_path(e.path, limits),
                mode_class=e.mode_class,
                content=e.content,
            )
            for e in entries
        ),
        key=lambda e: e.path.encode("utf-8"),
    )
    manifest = build_manifest(
        [
            ManifestFileInput(
                path=e.path, mode_class=e.mode_class, content=e.content
            )
            for e in normalized
        ]
    )
    summary_json = manifest_to_json(manifest)
    if len(summary_json.encode("utf-8")) > limits.max_manifest_summary_bytes:
        raise BundleError("limit", "manifest summary exceeds 4 KiB")

    tmp_path = destination.with_suffix(destination.suffix + ".tmp")
    digest = hashlib.sha256()
    size = 0
    try:
        with open(tmp_path, "wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
                with tarfile.open(fileobj=gz, mode="w") as tar:
                    _add_manifest_entry(tar, summary_json.encode("utf-8"))
                    for e in normalized:
                        _add_workspace_entry(tar, e)
            # finalize gzip/raw, then hash from disk
        data_size = tmp_path.stat().st_size
        if data_size > limits.max_compressed_bytes:
            raise BundleError("limit", f"compressed bundle exceeds {limits.max_compressed_bytes} bytes")
        with open(tmp_path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
                size += len(chunk)
        _ = tmp_path.replace(destination)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise
    return size, digest.hexdigest()


def _add_manifest_entry(tar: tarfile.TarFile, payload: bytes) -> None:
    info = tarfile.TarInfo(name=_MANIFEST_NAME)
    info.size = len(payload)
    info.mtime = 0
    info.mode = 0o644
    info.type = tarfile.REGTYPE
    _fix_metadata(info)
    tar.addfile(info, io.BytesIO(payload))


def _add_workspace_entry(tar: tarfile.TarFile, entry: BundleEntry) -> None:
    info = tarfile.TarInfo(name=_WORKSPACE_PREFIX + entry.path)
    info.size = len(entry.content)
    info.mtime = 0
    info.mode = _mode_for(entry.mode_class)
    info.type = tarfile.REGTYPE
    _fix_metadata(info)
    tar.addfile(info, io.BytesIO(entry.content))


def _fix_metadata(info: tarfile.TarInfo) -> None:
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0


def _open_members(bundle_path: Path) -> list[tarfile.TarInfo]:
    with gzip.open(bundle_path, "rb") as gz:
        with tarfile.open(fileobj=gz, mode="r|") as tar:
            return list(tar.getmembers())


def verify_bundle_file(
    bundle_path: Path,
    *,
    expected_bundle_sha256: str,
    limits: BundleLimits = DEFAULT_BUNDLE_LIMITS,
) -> VerifiedBundle:
    """Verify compressed digest, archive structure, manifest, and limits.

    Streams the archive twice — once for the bundle digest, once to read members
    and recompute file digests — never holding the whole bundle in memory.
    """
    actual_bundle_sha = _hash_file(bundle_path)
    if actual_bundle_sha != expected_bundle_sha256:
        raise BundleError("digest", "bundle sha256 mismatch")

    size = bundle_path.stat().st_size
    if size > limits.max_compressed_bytes:
        raise BundleError("limit", f"compressed bundle exceeds {limits.max_compressed_bytes} bytes")

    members = _open_members(bundle_path)
    if not members or members[0].name != _MANIFEST_NAME:
        raise BundleError("structure", "manifest.json must be the first archive entry")

    manifest_member: tarfile.TarInfo | None = None
    file_members: list[tarfile.TarInfo] = []
    seen_paths: set[str] = set()
    for m in members:
        _assert_safe_member(m)
        if m.name == _MANIFEST_NAME:
            manifest_member = m
            continue
        if not m.name.startswith(_WORKSPACE_PREFIX):
            raise BundleError("structure", f"entry outside workspace/: {m.name!r}")
        rel = m.name[len(_WORKSPACE_PREFIX):]
        normalized = _validate_entry_path(rel, limits)
        if normalized in seen_paths:
            raise BundleError("structure", f"duplicate path after normalization: {rel!r}")
        seen_paths.add(normalized)
        file_members.append(m)

    if manifest_member is None:
        raise BundleError("structure", "manifest.json missing")

    manifest = _read_manifest(bundle_path, manifest_member)
    _check_manifest_consistency(manifest, file_members, limits)
    _verify_file_digests(bundle_path, manifest, file_members)

    return VerifiedBundle(
        manifest=manifest,
        content_sha256=content_sha256(manifest),
        bundle_size_bytes=size,
        bundle_sha256=actual_bundle_sha,
        bundle_path=bundle_path,
    )


def _assert_safe_member(m: tarfile.TarInfo) -> None:
    if m.isdev():
        raise BundleError("structure", f"device entry forbidden: {m.name!r}")
    if m.issym() or m.islnk():
        raise BundleError("structure", f"link entry forbidden: {m.name!r}")
    if m.name.startswith("/") or ".." in m.name.split("/"):
        raise BundleError("structure", f"unsafe path: {m.name!r}")
    if not m.isfile():
        raise BundleError("structure", f"non-regular entry forbidden: {m.name!r}")


def _read_manifest(bundle_path: Path, member: tarfile.TarInfo) -> TaskRevisionManifestV1:
    with gzip.open(bundle_path, "rb") as gz:
        with tarfile.open(fileobj=gz, mode="r|") as tar:
            for m in tar:
                if m.name == member.name:
                    payload = tar.extractfile(m)
                    if payload is None:
                        raise BundleError("structure", "manifest entry has no data")
                    return manifest_from_json(payload.read().decode("utf-8"))
    raise BundleError("structure", "manifest.json not readable")


def _check_manifest_consistency(
    manifest: TaskRevisionManifestV1,
    file_members: list[tarfile.TarInfo],
    limits: BundleLimits,
) -> None:
    if len(manifest.files) > limits.max_file_count:
        raise BundleError("limit", "manifest declares too many files")
    if manifest.summary.uncompressed_size_bytes > limits.max_total_uncompressed_bytes:
        raise BundleError("limit", "manifest total size exceeds limit")
    if len(manifest.files) != len(file_members):
        raise BundleError("structure", "manifest file count does not match archive")
    manifest_summary_json = manifest_to_json(manifest)
    if len(manifest_summary_json.encode("utf-8")) > limits.max_manifest_summary_bytes:
        raise BundleError("limit", "manifest summary exceeds 4 KiB")
    # mode/digest/size consistency is checked against actual bytes below.
    for mf, tm in zip(
        manifest.files,
        sorted(file_members, key=lambda t: t.name[len(_WORKSPACE_PREFIX):].encode("utf-8")),
        strict=True,
    ):
        rel = tm.name[len(_WORKSPACE_PREFIX):]
        if rel != mf.path:
            raise BundleError("structure", f"path mismatch: archive {rel!r} vs manifest {mf.path!r}")
        if tm.mode != _mode_for(mf.mode_class):
            raise BundleError("structure", f"mode mismatch for {rel!r}")


def _verify_file_digests(
    bundle_path: Path,
    manifest: TaskRevisionManifestV1,
    file_members: list[tarfile.TarInfo],
) -> None:
    by_path = {tm.name[len(_WORKSPACE_PREFIX):]: tm for tm in file_members}
    with gzip.open(bundle_path, "rb") as gz:
        with tarfile.open(fileobj=gz, mode="r|") as tar:
            for m in tar:
                if not m.name.startswith(_WORKSPACE_PREFIX):
                    continue
                rel = m.name[len(_WORKSPACE_PREFIX):]
                mf = next((f for f in manifest.files if f.path == rel), None)
                if mf is None:
                    raise BundleError("structure", f"archive file not in manifest: {rel!r}")
                data = tar.extractfile(m)
                if data is None:
                    raise BundleError("structure", f"file entry has no data: {rel!r}")
                read = data.read
                digest = hashlib.sha256()
                size = 0
                for chunk in iter(lambda: read(1024 * 1024), b""):
                    digest.update(chunk)
                    size += len(chunk)
                if size != mf.size_bytes:
                    raise BundleError("digest", f"size mismatch for {rel!r}")
                if digest.hexdigest() != mf.sha256:
                    raise BundleError("digest", f"content sha256 mismatch for {rel!r}")
    # sanity: every manifest file was seen
    if len(by_path) != len(manifest.files):
        raise BundleError("structure", "manifest/archive file set mismatch")


def extract_verified_bundle(verified: VerifiedBundle, destination: Path) -> None:
    """Extract only ``workspace/*`` regular files into a fresh ``destination``.

    The destination must not exist or be empty. Each path is re-validated and
    resolved within the destination; any escape is rejected before writing.
    """
    if destination.exists() and any(destination.iterdir()):
        raise BundleError("structure", f"destination is not empty: {destination!r}")
    destination.mkdir(parents=True, exist_ok=True)

    with gzip.open(verified.bundle_path, "rb") as gz:
        with tarfile.open(fileobj=gz, mode="r|") as tar:
            for m in tar:
                if not m.name.startswith(_WORKSPACE_PREFIX):
                    continue
                rel = m.name[len(_WORKSPACE_PREFIX):]
                rel = normalize_manifest_path(rel)
                if rel.startswith("/") or ".." in rel.split("/"):
                    raise BundleError("escape", f"unsafe extraction path: {m.name!r}")
                target = (destination / rel).resolve()
                dest_root = destination.resolve()
                if target != dest_root and dest_root not in target.parents:
                    raise BundleError("escape", f"extraction escapes destination: {m.name!r}")
                data = tar.extractfile(m)
                if data is None:
                    raise BundleError("structure", f"file entry has no data: {m.name!r}")
                target.parent.mkdir(parents=True, exist_ok=True)
                _ = target.write_bytes(data.read())
                target.chmod(_mode_for(next(
                    f.mode_class for f in verified.manifest.files if f.path == rel
                )))


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


__all__ = [
    "DEFAULT_BUNDLE_LIMITS",
    "BundleEntry",
    "BundleError",
    "BundleErrorKind",
    "BundleLimits",
    "VerifiedBundle",
    "extract_verified_bundle",
    "manifest_from_json",
    "manifest_to_json",
    "sha256_hex",
    "verify_bundle_file",
    "write_bundle",
]
