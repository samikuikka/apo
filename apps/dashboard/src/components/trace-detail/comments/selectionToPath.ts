/**
 * Converts a DOM Selection within a JSON viewer into a JSON-path + char-range
 * anchor that can be persisted and re-highlighted on reload.
 *
 * Relies on two data attributes that the JSON viewer emits on each value row:
 *   - data-json-path      e.g. "$.output.choices[0].message.content"
 *   - data-json-key-value  marks the element wrapping a single row's value text
 *
 * Ported from Langfuse's selectionToPath, adapted to this viewer.
 */

export type JsonDataField = "input" | "output" | "metadata";

export interface SelectionPathResult {
  dataField: JsonDataField;
  /** Parallel to rangeStart/rangeEnd — one JSON path per spanned row. */
  path: string[];
  rangeStart: number[];
  rangeEnd: number[];
  selectedText: string;
}

export function selectionToPath(
  selection: Selection,
  container: HTMLElement,
  dataField: JsonDataField,
): SelectionPathResult | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  const selectedText = range.toString();
  if (!selectedText.trim()) return null;
  if (!container.contains(range.commonAncestorContainer)) return null;

  const startPath = findJsonPath(range.startContainer);
  const startKeyValue = findKeyValueElement(range.startContainer);
  const endPath = findJsonPath(range.endContainer);
  const endKeyValue = findKeyValueElement(range.endContainer);

  if (!startPath || !startKeyValue || !endPath || !endKeyValue) return null;

  // Single-row selection (the common case).
  if (startKeyValue === endKeyValue) {
    let startOffset = calculateOffset(
      range.startContainer,
      range.startOffset,
      startKeyValue,
    );
    let endOffset = calculateOffset(
      range.endContainer,
      range.endOffset,
      startKeyValue,
    );
    if (startOffset > endOffset) [startOffset, endOffset] = [endOffset, startOffset];

    return {
      dataField,
      path: [startPath],
      rangeStart: [startOffset],
      rangeEnd: [endOffset],
      selectedText,
    };
  }

  // Multi-row selection: spans several key-value elements.
  const rows = collectRowsBetween(startKeyValue, endKeyValue, container);
  if (rows.length === 0) return null;

  const isBackwards = rows[0] !== startKeyValue;
  const [firstContainer, firstOffset] = isBackwards
    ? [range.endContainer, range.endOffset]
    : [range.startContainer, range.startOffset];
  const [lastContainer, lastOffset] = isBackwards
    ? [range.startContainer, range.startOffset]
    : [range.endContainer, range.endOffset];

  const paths: string[] = [];
  const rangeStarts: number[] = [];
  const rangeEnds: number[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rowPath = row.dataset.jsonPath;
    if (!rowPath) continue;

    if (i === 0) {
      paths.push(rowPath);
      rangeStarts.push(calculateOffset(firstContainer, firstOffset, row));
      rangeEnds.push(getRowTextLength(row));
    } else if (i === rows.length - 1) {
      paths.push(rowPath);
      rangeStarts.push(0);
      rangeEnds.push(calculateOffset(lastContainer, lastOffset, row));
    } else {
      paths.push(rowPath);
      rangeStarts.push(0);
      rangeEnds.push(getRowTextLength(row));
    }
  }

  if (paths.length === 0) return null;

  return {
    dataField,
    path: paths,
    rangeStart: rangeStarts,
    rangeEnd: rangeEnds,
    selectedText,
  };
}

function findJsonPath(node: Node): string | null {
  let current: Node | null = node;
  while (current && current !== document.body) {
    if (current instanceof HTMLElement && current.dataset.jsonPath) {
      return current.dataset.jsonPath;
    }
    current = current.parentNode;
  }
  return null;
}

function findKeyValueElement(node: Node): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== document.body) {
    if (current instanceof HTMLElement && current.dataset.jsonKeyValue) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

/** Character offset of (container, offset) within the key-value element. */
function calculateOffset(
  container: Node,
  offset: number,
  keyValueElement: HTMLElement,
): number {
  const walker = document.createTreeWalker(
    keyValueElement,
    NodeFilter.SHOW_TEXT,
    null,
  );
  let charCount = 0;
  let node = walker.nextNode();
  while (node) {
    if (node === container) return charCount + offset;
    charCount += node.textContent?.length || 0;
    node = walker.nextNode();
  }
  return charCount + offset;
}

function getRowTextLength(keyValueElement: HTMLElement): number {
  let length = 0;
  const walker = document.createTreeWalker(
    keyValueElement,
    NodeFilter.SHOW_TEXT,
    null,
  );
  let node = walker.nextNode();
  while (node) {
    length += node.textContent?.length || 0;
    node = walker.nextNode();
  }
  return length;
}

function collectRowsBetween(
  startRow: HTMLElement,
  endRow: HTMLElement,
  container: HTMLElement,
): HTMLElement[] {
  const allRows = Array.from(
    container.querySelectorAll<HTMLElement>("[data-json-key-value]"),
  );
  const startIdx = allRows.indexOf(startRow);
  const endIdx = allRows.indexOf(endRow);
  if (startIdx === -1 || endIdx === -1) return [];
  const [minIdx, maxIdx] =
    startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
  return allRows.slice(minIdx, maxIdx + 1);
}
