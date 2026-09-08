/**
 * Out-of-band result-evidence staging (issue #251).
 *
 * A document-heavy run can hold legitimate transcript / deliverable /
 * check evidence larger than the server's result envelope. When the
 * server advertises evidence support, the over-limit fields are uploaded
 * as attempt-scoped parts (identity-encoded JSON whose exact bytes the
 * server verifies by size + SHA-256) and the final result body carries
 * only their ids in ``evidence_refs``.
 *
 * Parts are uploaded while the attempt heartbeat is still live — callers
 * run this between task completion and the terminal /result POST, the
 * same window artifact uploads already use.
 */

import { createHash } from "node:crypto";

import { prepareResultSubmission } from "./result-submission.ts";

/** Advertised by caller-create and v2 claims; null on servers without it. */
export interface ResultEvidenceSupport {
  maxItemBytes: number;
  maxTotalBytes: number;
}

export type ResultEvidenceSlot = "transcript" | "checks" | "deliverable";

export interface ResultEvidenceUploadContext {
  backendUrl: string;
  attemptId: string;
  /** The Attempt JWT — never the Project API key. */
  authToken: string;
  /** Which protocol path the intent endpoint lives on. */
  protocolVersion: 1 | 2;
}

export interface ExternalizeOptions {
  ctx: ResultEvidenceUploadContext;
  support: ResultEvidenceSupport;
  /** The measured, over-limit result body. */
  body: Record<string, unknown>;
  limitBytes: number;
  /** Injectable fetch (tests pass a stub); defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ExternalizeResult {
  /** The shrunken body — same fields, externalized ones nulled/removed. */
  body: Record<string, unknown>;
  refs: string[];
}

/** Nothing could bring the body under the limit, even out of band. */
export class ResultEvidenceTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultEvidenceTooLargeError";
  }
}

function parseAdvertisedInt(name: string, raw: unknown): number {
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `server advertised an invalid ${name} (${JSON.stringify(raw)})`,
    );
  }
  return value;
}

/**
 * Parse the evidence-support advertisement. Absent or false → null (an
 * older server; the caller keeps the inline-only contract). Support with
 * malformed limits is a protocol error — never silently "unlimited".
 */
export function parseResultEvidenceSupport(raw: {
  result_evidence_supported?: unknown;
  result_evidence_max_item_bytes?: unknown;
  result_evidence_max_total_bytes?: unknown;
}): ResultEvidenceSupport | null {
  const supported = raw.result_evidence_supported;
  if (supported === undefined || supported === null || supported === false) {
    return null;
  }
  if (supported !== true) {
    throw new Error(
      `server advertised an invalid result_evidence_supported (${JSON.stringify(supported)})`,
    );
  }
  return {
    maxItemBytes: parseAdvertisedInt(
      "result_evidence_max_item_bytes",
      raw.result_evidence_max_item_bytes,
    ),
    maxTotalBytes: parseAdvertisedInt(
      "result_evidence_max_total_bytes",
      raw.result_evidence_max_total_bytes,
    ),
  };
}

/** PUT bound scales with size: a stalled peer must not wedge the upload. */
function evidencePutTimeoutMs(sizeBytes: number): number {
  return 60_000 + Math.ceil(sizeBytes / (256 * 1024)) * 1_000;
}

/**
 * Upload one evidence part: intent (idempotent on identical metadata) then
 * a raw-bytes PUT the server verifies by size and digest. Returns the part
 * id to reference from ``evidence_refs``.
 */
export async function uploadResultEvidencePart(
  ctx: ResultEvidenceUploadContext,
  slot: ResultEvidenceSlot,
  deliverableName: string | null,
  data: Buffer,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const base = ctx.backendUrl.replace(/\/$/, "");
  const intentUrl =
    ctx.protocolVersion === 2
      ? `${base}/v1/executor-protocol/v2/attempts/${ctx.attemptId}/result-evidence`
      : `${base}/v1/executor-protocol/v1/attempts/${ctx.attemptId}/result-evidence`;
  const payload: Record<string, unknown> = {
    slot,
    size_bytes: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  if (deliverableName !== null) payload.deliverable_name = deliverableName;

  const intentResp = await fetchImpl(intentUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.authToken}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!intentResp.ok) {
    throw new Error(
      `evidence intent for ${slot}${deliverableName ? `/${deliverableName}` : ""} failed: ` +
        `${intentResp.status} ${await safeDetail(intentResp)}`,
    );
  }
  const intent = (await intentResp.json()) as { id: string; upload_url: string };

  const putUrl = intent.upload_url.startsWith("http")
    ? intent.upload_url
    : `${base}${intent.upload_url}`;
  const putResp = await fetchImpl(putUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(data.byteLength),
      Authorization: `Bearer ${ctx.authToken}`,
    },
    body: new Uint8Array(data),
    signal: AbortSignal.timeout(evidencePutTimeoutMs(data.byteLength)),
  });
  if (!putResp.ok) {
    throw new Error(
      `evidence upload of ${data.byteLength} bytes failed: ` +
        `${putResp.status} ${await safeDetail(putResp)}`,
    );
  }
  return intent.id;
}

/**
 * Shrink an over-limit result body below ``limitBytes`` by moving its
 * large fields out of band, largest-impact-first: transcript, then JSON
 * deliverables by serialized size, then checks — stopping as soon as the
 * body fits so small runs keep their inline shape.
 *
 * Throws {@link ResultEvidenceTooLargeError} when even a fully
 * externalized body cannot fit (or a single part exceeds the advertised
 * per-item cap) — the caller falls back to the bounded rejection path.
 */
export async function externalizeResultEvidence(
  opts: ExternalizeOptions,
): Promise<ExternalizeResult> {
  const { ctx, support, limitBytes, fetchImpl } = opts;
  const body = { ...opts.body };
  const deliverables = { ...(body.deliverables as Record<string, unknown> | null ?? {}) };
  const refs: string[] = [];
  let externalizedBytes = 0;

  type Candidate = {
    kind: "transcript" | "checks" | "deliverable";
    name?: string;
    value: unknown;
  };
  const deliverableEntries = Object.entries(deliverables).sort(
    (a, b) => serializedBytes(b[1]) - serializedBytes(a[1]),
  );
  const candidates: Candidate[] = [];
  if (body.transcript !== null && body.transcript !== undefined) {
    candidates.push({ kind: "transcript", value: body.transcript });
  }
  for (const [name, value] of deliverableEntries) {
    candidates.push({ kind: "deliverable", name, value });
  }
  if (body.checks !== null && body.checks !== undefined) {
    candidates.push({ kind: "checks", value: body.checks });
  }

  const overLimit = (): boolean =>
    prepareResultSubmission({ ...body, deliverables }, limitBytes).overLimit;

  const skipped: string[] = [];
  for (const candidate of candidates) {
    if (!overLimit()) break;

    const data = Buffer.from(JSON.stringify(candidate.value) ?? "null", "utf8");
    if (data.byteLength > support.maxItemBytes) {
      skipped.push(`${candidate.kind}${candidate.name ? `/${candidate.name}` : ""}`);
      continue;
    }
    if (externalizedBytes + data.byteLength > support.maxTotalBytes) {
      throw new ResultEvidenceTooLargeError(
        `result_too_large_after_evidence: evidence parts would exceed the advertised ` +
          `total limit (${support.maxTotalBytes} bytes); total_bytes=${
            prepareResultSubmission({ ...body, deliverables }, limitBytes).size.totalBytes
          } limit_bytes=${limitBytes}`,
      );
    }

    const slot: ResultEvidenceSlot =
      candidate.kind === "deliverable" ? "deliverable" : candidate.kind;
    const id = await uploadResultEvidencePart(
      ctx,
      slot,
      candidate.name ?? null,
      data,
      fetchImpl,
    );
    refs.push(id);
    externalizedBytes += data.byteLength;

    if (candidate.kind === "transcript") body.transcript = null;
    else if (candidate.kind === "checks") body.checks = null;
    else delete deliverables[candidate.name!];
  }

  if (overLimit()) {
    const detail = skipped.length ? ` skipped_over_item_cap=${skipped.join(",")}` : "";
    throw new ResultEvidenceTooLargeError(
      `result_too_large_after_evidence: total_bytes=${
        prepareResultSubmission({ ...body, deliverables }, limitBytes).size.totalBytes
      } limit_bytes=${limitBytes}${detail}`,
    );
  }

  body.deliverables = deliverables;
  body.evidence_refs = refs;
  return { body, refs };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

async function safeDetail(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return "";
  }
}
