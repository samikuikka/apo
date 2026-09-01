/**
 * Minimal keyboard primitives for interactive commands (`apo run`):
 * raw-mode key reading and a collapsible tree picker. Rendering is plain
 * ANSI via format.ts — no TUI framework, no new dependencies. Screens that
 * need scroll viewports or resize handling should graduate to Ink rather
 * than growing this file.
 */
import { emitKeypressEvents } from "node:readline";
import { stdin } from "node:process";
import { bold, cyan, dim, green, yellow } from "./format.ts";

export type Key = { name: string; ctrl: boolean; sequence?: string };

let keypressReady = false;

function ensureRawMode(): void {
  if (keypressReady) return;
  emitKeypressEvents(stdin);
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  keypressReady = true;
}

export function shutdownInput(): void {
  if (stdin.isTTY) stdin.setRawMode(false);
  stdin.pause();
  keypressReady = false;
}

/** One keystroke; Ctrl-C exits 130 like every terminal app. */
export function waitKey(): Promise<Key> {
  return new Promise((resolve) => {
    const onKey = (_ch: string, key: Key) => {
      if (key?.ctrl && key.name === "c") {
        shutdownInput();
        process.exit(130);
      }
      stdin.removeListener("keypress", onKey);
      resolve(key ?? { name: _ch, ctrl: false });
    };
    stdin.on("keypress", onKey);
  });
}

/** Line input for free-text entry (custom model ids): drops to cooked mode
 *  so the terminal handles echo and editing, then restores raw mode. */
export function askText(title: string, fallback: string): Promise<string> {
  if (!stdin.isTTY) return Promise.resolve(fallback);
  stdin.setRawMode(false);
  stdin.resume();
  process.stdout.write(`${title} ${dim(`[${fallback}]`)}: `);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      const line = chunk.toString("utf8").replace(/\r?\n$/, "");
      stdin.removeListener("data", onData);
      stdin.setRawMode(true);
      process.stdout.write("\n");
      resolve(line.trim() || fallback);
    };
    stdin.once("data", onData);
  });
}

export type TreeNode<T> = {
  name: string;
  /** Stable identity for expansion/checkbox state (folder path or task id). */
  key: string;
  /** Folder rows carry children + a subtree count; leaves carry a value. */
  children?: TreeNode<T>[];
  value?: T;
  hint?: string;
  count?: number;
};

export type PickResult<T> =
  | { kind: "pick"; value: T }
  | { kind: "back" };

export type PickTreeOptions = {
  /** Single-select: no checkboxes, Enter on a leaf picks it. */
  single?: boolean;
  /** Type-to-filter: printable keys edit a query; matching leaves flatten
   *  across folders. While filtering only arrows navigate (the fzf
   *  convention — letters type). Esc clears the query, then backs. */
  filter?: boolean;
  /** What the idle filter line says — state a once-per-screen convention
   *  here (e.g. a unit legend) instead of repeating it on every row. */
  filterIdle?: string;
};

type VisibleRow<T> = { node: TreeNode<T>; depth: number; isFolder: boolean; parent: TreeNode<T> | null };

/**
 * Collapsible tree picker. Multi-select by default: space toggles a
 * checkbox (folders select their whole subtree, `[~]` when partial),
 * Enter confirms — the checked leaves in tree order, or the cursor leaf /
 * folder subtree when nothing is checked. Enter always advances: on a
 * closed folder it opens; closing is ←/h only. `expanded` and `checked`
 * are the caller's sets, so state persists across re-entries.
 */
export async function pickTree<T>(
  title: string,
  roots: TreeNode<T>[],
  expanded: Set<string>,
  checked: Set<string>,
  opts: PickTreeOptions = {},
): Promise<PickResult<T[]>> {
  if (!stdin.isTTY) {
    const first = flattenAll(roots).find((r) => !r.isFolder);
    return first?.node.value !== undefined
      ? { kind: "pick", value: [first.node.value] }
      : { kind: "back" };
  }
  ensureRawMode();

  let query = "";
  const filterRows = (): VisibleRow<T>[] => {
    const needle = query.toLowerCase();
    const out: VisibleRow<T>[] = [];
    const walk = (nodes: TreeNode<T>[], parent: TreeNode<T> | null) => {
      for (const n of nodes) {
        if (n.children !== undefined) {
          walk(n.children, n);
        } else if (`${n.name} ${n.hint ?? ""}`.toLowerCase().includes(needle)) {
          out.push({ node: n, depth: 0, isFolder: false, parent });
        }
      }
    };
    walk(roots, null);
    return out;
  };
  const flatten = (): VisibleRow<T>[] => {
    const rows: VisibleRow<T>[] = [];
    const walk = (nodes: TreeNode<T>[], depth: number, parent: TreeNode<T> | null) => {
      for (const n of nodes) {
        rows.push({ node: n, depth, isFolder: n.children !== undefined, parent });
        if (n.children && expanded.has(n.key)) walk(n.children, depth + 1, n);
      }
    };
    walk(roots, 0, null);
    return rows;
  };
  const rowsNow = (): VisibleRow<T>[] => (query !== "" ? filterRows() : flatten());
  // `checked` holds node keys; leaves are keyed by their task/model id, so
  // folders and leaves share one namespace without the picker knowing T.
  const subtreeKeys = (node: TreeNode<T>): string[] =>
    node.value !== undefined ? [node.key] : (node.children ?? []).flatMap(subtreeKeys);
  const subtreeValues = (node: TreeNode<T>): T[] =>
    node.value !== undefined ? [node.value] : (node.children ?? []).flatMap(subtreeValues);
  const box = (node: TreeNode<T>): string => {
    const keys = subtreeKeys(node);
    const n = keys.filter((k) => checked.has(k)).length;
    return n === 0 ? " " : n === keys.length ? "x" : "~";
  };

  return new Promise<PickResult<T[]>>((resolve) => {
    let cursor = 0;
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write("\x1b[?25l");
    process.stdout.write(`${title}\n`);

    let renderedLines = 0;
    let rendered = false;
    // Color encodes state (the ls/lazygit convention): folders cyan like
    // directories, checkboxes green/yellow/dim for all/partial/none,
    // secondary info dim, cursor row bold. Hints share one vertical rail:
    // names are padded to the longest in view so the column never drifts.
    const render = () => {
      const rows = rowsNow();
      cursor = Math.min(Math.max(cursor, 0), Math.max(rows.length - 1, 0));
      const prevLines = renderedLines;
      if (rendered) process.stdout.write(`\x1b[${prevLines}A`);
      renderedLines = 0;
      if (opts.filter) {
        process.stdout.write(`\x1b[2K\r${dim("filter:")} ${query}${query === "" ? dim(opts.filterIdle ?? " type to narrow") : "\u258f"}\n`);
        renderedLines++;
      }
      if (rows.length === 0) {
        process.stdout.write(`\x1b[2K\r${dim("no matches")}\n`);
        renderedLines++;
      }
      const nameCol = rows.reduce((max, r) => Math.max(max, r.depth * 2 + r.node.name.length), 0);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const selected = i === cursor;
        const marker = selected ? bold("\u276f") : " ";
        const indent = "  ".repeat(r.depth);
        const b = box(r.node);
        const checkbox = opts.single
          ? ""
          : b === "x"
            ? `${green(`[${b}]`)} `
            : b === "~"
              ? `${yellow(`[${b}]`)} `
              : `${dim(`[${b}]`)} `;
        const pad = " ".repeat(Math.max(0, nameCol - r.depth * 2 - r.node.name.length));
        let line: string;
        if (r.isFolder) {
          const arrow = expanded.has(r.node.key) ? "\u25be" : "\u25b8";
          const name = selected ? bold(cyan(`${arrow} ${r.node.name}`)) : cyan(`${arrow} ${r.node.name}`);
          line = `${marker} ${indent}${checkbox}${name}${pad}  ${dim(String(r.node.count ?? ""))}`;
        } else {
          const name = selected ? bold(r.node.name) : r.node.name;
          line = r.node.hint
            ? `${marker} ${indent}${checkbox}${name}${pad}  ${dim(r.node.hint)}`
            : `${marker} ${indent}${checkbox}${name}`;
        }
        process.stdout.write(`\x1b[2K\r${line}\n`);
        renderedLines++;
      }
      // A collapse shrinks the tree: erase the rows the previous, taller
      // render left below the new last row, or closed children stay painted.
      const leftover = prevLines - renderedLines;
      if (rendered && leftover > 0) {
        for (let i = 0; i < leftover; i++) process.stdout.write("\x1b[2K\x1b[1B");
        process.stdout.write(`\x1b[${leftover}A`);
      }
      rendered = true;
    };

    const finish = (result: PickResult<T[]>) => {
      stdin.removeListener("keypress", onKey);
      process.stdout.write("\x1b[?25h");
      resolve(result);
    };

    const confirm = (row: VisibleRow<T>) => {
      if (checked.size > 0) {
        const picked: T[] = [];
        const walk = (nodes: TreeNode<T>[]) => {
          for (const n of nodes) {
            if (n.value !== undefined) {
              if (checked.has(n.key)) picked.push(n.value);
            } else {
              walk(n.children ?? []);
            }
          }
        };
        walk(roots);
        if (picked.length > 0) {
          finish({ kind: "pick", value: picked });
          return;
        }
      }
      if (row.node.value !== undefined) {
        finish({ kind: "pick", value: [row.node.value] });
      } else {
        finish({ kind: "pick", value: subtreeValues(row.node) });
      }
    };

    const onKey = (_ch: string, key: Key) => {
      if (key?.ctrl && key.name === "c") {
        shutdownInput();
        process.exit(130);
      }
      if (opts.filter && key && !key.ctrl) {
        const ch = key.sequence && key.sequence.length === 1 ? key.sequence : "";
        if (/^[a-zA-Z0-9.\-+*_$]/.test(ch)) {
          query += ch;
          cursor = 0;
          render();
          return;
        }
        if (key.name === "backspace") {
          query = query.slice(0, -1);
          cursor = 0;
          render();
          return;
        }
      }
      const rows = rowsNow();
      const row = rows[cursor];
      switch (key?.name) {
        case "up":
          cursor = Math.max(0, cursor - 1);
          render();
          return;
        case "down":
          cursor = Math.min(rows.length - 1, cursor + 1);
          render();
          return;
        case "k":
          if (!opts.filter) {
            cursor = Math.max(0, cursor - 1);
            render();
          }
          return;
        case "j":
          if (!opts.filter) {
            cursor = Math.min(rows.length - 1, cursor + 1);
            render();
          }
          return;
        case "right":
        case "l":
          if (query === "" && row?.isFolder) {
            if (!expanded.has(row.node.key)) expanded.add(row.node.key);
            else cursor = Math.min(cursor + 1, rows.length - 1);
            render();
          }
          return;
        case "left":
        case "h": {
          if (query !== "" || !row) return;
          if (row.isFolder && expanded.has(row.node.key)) {
            expanded.delete(row.node.key);
          } else {
            let parent = row.parent;
            while (parent && !expanded.has(parent.key)) parent = findParent(roots, parent.key);
            if (parent) {
              expanded.delete(parent.key);
              cursor = Math.max(0, flatten().findIndex((r) => r.node.key === parent!.key));
            }
          }
          render();
          return;
        }
        case "space": {
          if (opts.single || !row) return;
          const keys = subtreeKeys(row.node);
          const all = keys.length > 0 && keys.every((k) => checked.has(k));
          for (const k of keys) {
            if (all) checked.delete(k);
            else checked.add(k);
          }
          render();
          return;
        }
        case "return":
        case "enter": {
          if (!row) return;
          if (row.isFolder && !expanded.has(row.node.key)) {
            expanded.add(row.node.key);
            render();
            return;
          }
          if (opts.single) {
            if (row.node.value !== undefined) {
              finish({ kind: "pick", value: [row.node.value] });
            } else {
              const firstLeaf = subtreeValues(row.node)[0];
              if (firstLeaf !== undefined) finish({ kind: "pick", value: [firstLeaf] });
            }
          } else {
            confirm(row);
          }
          return;
        }
        case "escape":
          if (query !== "") {
            query = "";
            cursor = 0;
            render();
            return;
          }
          finish({ kind: "back" });
          return;
        case "b":
          if (!opts.filter) finish({ kind: "back" });
          return;
      }
    };

    render();
    stdin.on("keypress", onKey);
  });
}

function flattenAll<T>(roots: TreeNode<T>[]): VisibleRow<T>[] {
  const rows: VisibleRow<T>[] = [];
  const walk = (nodes: TreeNode<T>[], depth: number, parent: TreeNode<T> | null) => {
    for (const n of nodes) {
      rows.push({ node: n, depth, isFolder: n.children !== undefined, parent });
      if (n.children) walk(n.children, depth + 1, n);
    }
  };
  walk(roots, 0, null);
  return rows;
}

/** Walk to a node's parent by key (flatten() only tracks one level). A null
 *  return covers both "not found" and "matched at root" — roots have no
 *  parent either way, so callers treat it as "stop walking". */
function findParent<T>(nodes: TreeNode<T>[], key: string, parent: TreeNode<T> | null = null): TreeNode<T> | null {
  for (const n of nodes) {
    if (n.key === key) return parent;
    if (n.children) {
      const found = findParent(n.children, key, n);
      if (found) return found;
    }
  }
  return null;
}
