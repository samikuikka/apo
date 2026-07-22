/**
 * Resolve which task source file to load for the "check source" viewer, and
 * whether a loaded candidate should be shown.
 *
 * Both the per-run detail view and the compare view fetch a task's check
 * source (its `*.eval.ts`) so each check can display its own code. Two bugs
 * lived in the inline candidate/acceptance logic this replaces (see issue
 * #16):
 *
 * 1. The recorded `source_file` was discarded when `extractCheckBlock` could
 *    not pinpoint a check's block — which happens for helper/factory-registered
 *    checks (no literal `test("id")` opener). A correct, fetchable file was
 *    thrown away in favor of a 404'ing fallback.
 * 2. The fallback was built as ``${taskId}.eval.ts``. For folder-scoped ids
 *    (e.g. ``chat/cost-inquiry``) this resolves to a nested, non-existent
 *    path; the eval actually lives at ``<folder>/<basename>.eval.ts``.
 */

/**
 * The last path segment of a task id — the folder name apo's discovery
 * convention names the eval file after. ``"cost-inquiry"`` from
 * ``"chat/cost-inquiry"``, ``"code-review"`` from ``"code-review"``.
 */
export function taskBasename(taskId: string): string {
  const trimmed = taskId.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed;
}

/**
 * Ordered file paths to try when loading a task's check source. The recorded
 * `source_file` (the authoritative filename the run recorded) is always first;
 * the derived ``<basename>.eval.ts`` follows for the folder-convention layout.
 * Never uses ``${taskId}.eval.ts``, which is wrong for folder-scoped ids.
 */
export function buildSourceCandidates(
  recordedSourceFile: string | undefined,
  taskId: string,
): string[] {
  const evalCandidate = `${taskBasename(taskId)}.eval.ts`;
  const candidates = recordedSourceFile
    ? [recordedSourceFile, evalCandidate]
    : [evalCandidate, "task.ts", "checks.ts"];
  return dedupe(candidates);
}

export interface AcceptSourceInput {
  /** The candidate path currently being considered. */
  candidate: string;
  /** The authoritative `source_file` recorded on the check result, if any. */
  recordedSourceFile: string | undefined;
  /** Whether a recognizable check block was found in the loaded source. */
  containsKnownCheck: boolean;
  /** Whether `candidate` is the final entry (no more to try). */
  isLastCandidate: boolean;
}

/**
 * Decide whether a successfully-loaded candidate should be shown. The recorded
 * `source_file` is trusted even when its check block can't be pinpointed
 * (helper/factory-registered checks have no literal ``test("id")`` opener) —
 * we degrade to showing the whole file instead of 404ing. Non-recorded
 * fallbacks still need a recognizable check block, unless they're the last
 * resort.
 */
export function shouldAcceptSource(input: AcceptSourceInput): boolean {
  if (input.containsKnownCheck) return true;
  if (input.recordedSourceFile && input.candidate === input.recordedSourceFile) {
    return true;
  }
  return input.isLastCandidate;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
