import { readFile } from "fs/promises";
import type { FileEntry } from "./types.ts";

export class TaskFiles {
  private entries: FileEntry[];

  constructor(entries: FileEntry[]) {
    this.entries = entries;
  }

  async read(relativePath: string): Promise<string> {
    const entry = this.find(relativePath);
    if (!entry) {
      throw new Error(`File not found: ${relativePath}`);
    }
    return readFile(entry.absolutePath, "utf-8");
  }

  async readBuffer(relativePath: string): Promise<Buffer> {
    const entry = this.find(relativePath);
    if (!entry) {
      throw new Error(`File not found: ${relativePath}`);
    }
    return readFile(entry.absolutePath);
  }

  find(relativePath: string): FileEntry | undefined {
    return this.entries.find((entry) => entry.relativePath === relativePath);
  }

  list(): FileEntry[] {
    return [...this.entries];
  }

  has(relativePath: string): boolean {
    return this.entries.some((entry) => entry.relativePath === relativePath);
  }
}
