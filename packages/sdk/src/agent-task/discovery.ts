import { existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

export function discoverAgentTaskDirs(rootDir: string): string[] {
  const absoluteRoot = resolve(rootDir);

  if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
    throw new Error(`Task directory not found: ${absoluteRoot}`);
  }

  const discovered: string[] = [];
  walkForTaskDirs(absoluteRoot, discovered);
  return discovered.sort();
}

function walkForTaskDirs(currentDir: string, discovered: string[]): void {
  if (readdirSync(currentDir).some((f) => f.endsWith(".eval.ts"))) {
    discovered.push(currentDir);
    return;
  }

  for (const entry of readdirSync(currentDir)) {
    const absolutePath = join(currentDir, entry);
    if (!statSync(absolutePath).isDirectory()) {
      continue;
    }

    walkForTaskDirs(absolutePath, discovered);
  }
}
