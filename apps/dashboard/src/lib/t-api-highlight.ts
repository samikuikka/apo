/**
 * Pure helper for the ``t.<method>`` CodeMirror colorization.
 *
 * Extracted from ``CodeViewer.tsx`` so the matching logic is unit-testable
 * without mounting a full CodeMirror editor (which jsdom only simulates).
 *
 * NOTE on the method list: this is a *copy* of the SDK's
 * ``TEST_METHOD_NAMES`` (``packages/sdk/src/agent-task/checks/t.ts``), not an
 * import — ``@apo/sdk/agent-task`` is a server-runtime entry (runTask,
 * callJudge, adapters, …) that must never enter the browser bundle. Keeping
 * the two lists in sync is enforced by the test in
 * ``__tests__/t-api-highlight.test.ts``, which compares against the canonical
 * SDK export so drift fails CI rather than silently leaving a method unstyled
 * (the original bug).
 */
import { TEST_METHOD_NAMES } from "./t-api-methods";

const SORTED_BY_LEN_DESC = [...TEST_METHOD_NAMES].sort((a, b) => b.length - a.length);

/**
 * Regex matching a whole ``t.<method>`` token for any method on
 * {@link TestContext}. Alternation is ordered longest-first so that e.g.
 * ``t.maxToolCalls`` matches before ``t.max`` would (defensive; the ``\b``
 * anchors make prefix overlap impossible, but it keeps the pattern tidy).
 *
 * The ``g`` flag is required for iterative ``exec`` use in the CodeMirror
 * decoration builder; callers must reset ``lastIndex`` between documents.
 */
export const tApiRegex = new RegExp(`\\bt\\.(${SORTED_BY_LEN_DESC.join("|")})\\b`, "g");

/**
 * Returns the spans (``[from, to)`` offsets) of every ``t.<method>`` token in
 * ``source`` that should receive the ``cm-apo-t-api`` highlight. Pure and
 * side-effect-free — the unit test's entry point.
 */
export function findTApiSpans(source: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  tApiRegex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tApiRegex.exec(source)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}
