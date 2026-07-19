/**
 * Parses a failure's stack trace into a {@link CheckLocation} anchored inside
 * the user's task/check module.
 *
 * Task modules and legacy checks modules load from verbatim temporary copies,
 * so frame line/column values map 1:1 to the original source. The display
 * ``file`` is the original filename, allowing the dashboard to fetch it.
 */

import type { CheckLocation } from "../run/types.ts";

const FRAME_TAIL = /:(\d+):(\d+)\)?\s*$/;

export function parseCheckLocation(
  stack: string | undefined,
  moduleUrl: string,
  displayFile: string,
): CheckLocation | undefined {
  if (!stack || !moduleUrl) return undefined;
  // Match either the full module URL (native Node stacks) or its de-schemed
  // path (source-mapped / transformed stacks, e.g. under test runners), so
  // the locator is robust to how the frame URL is rendered.
  const needle = moduleUrl.replace(/^file:\/\//, "");
  for (const line of stack.split("\n")) {
    if (!line.includes(moduleUrl) && !line.includes(needle)) continue;
    const m = line.match(FRAME_TAIL);
    if (m) {
      return { file: displayFile, line: Number(m[1]), column: Number(m[2]) };
    }
  }
  return undefined;
}
