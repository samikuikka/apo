import { stdin, stdout } from "node:process";

export interface PickerOption<T> {
  label: string;
  value: T;
  hint?: string;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/**
 * Interactive arrow-key picker. Renders `options` and lets the user move with
 * ↑/↓ (or j/k), confirm with Enter. Returns the chosen value, or the default
 * when stdin is not a TTY (agents / piped input) so commands stay scriptable.
 */
export async function pickOption<T>(
  title: string,
  options: PickerOption<T>[],
  defaultIndex = 0,
): Promise<T | null> {
  if (options.length === 0) return null;
  let index = clamp(defaultIndex, 0, options.length - 1);

  if (!stdin.isTTY) {
    return options[index].value;
  }

  return new Promise<T>((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write("\x1b[?25l"); // hide cursor
    stdout.write(`${title}\n`);

    let renderedOnce = false;

    const render = () => {
      if (renderedOnce) {
        stdout.write(`\x1b[${options.length}A`); // move up to first option
      }
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const selected = i === index;
        const marker = selected ? "\u276f" : " ";
        const label = selected ? opt.label : `\x1b[2m${opt.label}\x1b[0m`;
        const hint = opt.hint ? `  \x1b[2m${opt.hint}\x1b[0m` : "";
        stdout.write(`\x1b[2K\r${marker} ${label}${hint}\n`);
      }
      renderedOnce = true;
    };

    const cleanup = (value: T) => {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      stdout.write("\x1b[?25h"); // show cursor
      resolve(value);
    };

    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      let i = 0;
      while (i < s.length) {
        const code = s.charCodeAt(i);
        if (code === 0x1b) {
          const seq = s.slice(i, i + 3);
          if (seq === "\x1b[A") {
            index = clamp(index - 1, 0, options.length - 1);
            render();
          } else if (seq === "\x1b[B") {
            index = clamp(index + 1, 0, options.length - 1);
            render();
          }
          i += 3;
          continue;
        }
        if (code === 0x0d || code === 0x0a) {
          cleanup(options[index].value);
          return;
        }
        if (code === 0x03) {
          process.exit(130);
        }
        const ch = s[i];
        if (ch === "k") {
          index = clamp(index - 1, 0, options.length - 1);
          render();
        } else if (ch === "j") {
          index = clamp(index + 1, 0, options.length - 1);
          render();
        } else if (ch >= "1" && ch <= "9") {
          const n = Number(ch) - 1;
          if (n < options.length) {
            index = n;
            render();
          }
        }
        i += 1;
      }
    };

    render();
    stdin.on("data", onData);
  });
}
