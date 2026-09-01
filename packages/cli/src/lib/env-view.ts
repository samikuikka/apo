/**
 * Read-only view of the environment a task run will see: which `.env`
 * files the loader chain finds and which apo-relevant variables resolve
 * from where. Mirrors `task-run.ts`'s loadEnvFiles semantics (first file
 * wins, process.env always wins) without mutating anything — and without
 * ever returning a value, only names, set/missing, and source. Provider
 * keys never leave the executor machine; this view keeps it that way.
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

export type EnvVarState = {
  name: string;
  set: boolean;
  /** "process env" or the .env file path that supplies it. */
  source: string | null;
};

export type EnvView = {
  /** The .env chain for this task dir, in resolution order. */
  files: { path: string; exists: boolean }[];
  /** The vars the apo runtime and CLI actually read, with state. */
  known: (EnvVarState & { meaning: string })[];
  /** Everything else the chain provides — names only, never values. */
  others: string[];
};

/** The env vars the apo runtime/CLI reads (task-runtime.ts + config.ts). */
export const KNOWN_VARS: { name: string; meaning: string }[] = [
  { name: "OPENROUTER_MODEL", meaning: "model id via OpenRouter (takes precedence)" },
  { name: "OPENAI_MODEL", meaning: "model id via OpenAI-compatible API" },
  { name: "OPENROUTER_API_KEY", meaning: "OpenRouter auth" },
  { name: "OPENAI_API_KEY", meaning: "OpenAI(-compatible) auth" },
  { name: "OPENROUTER_BASE_URL", meaning: "OpenRouter base URL override" },
  { name: "OPENAI_BASE_URL", meaning: "OpenAI-compatible base URL override" },
  { name: "AGENT_TASK_JUDGE_MODEL", meaning: "default judge model for `runs rejudge`" },
  { name: "AGENT_TASK_ENVIRONMENT", meaning: "environment label recorded on runs" },
  { name: "APO_TASK_ROOT", meaning: "CLI: where tasks live" },
  { name: "APO_BACKEND_URL", meaning: "CLI: apo backend URL" },
];

/** The candidate chain loadEnvFiles reads, in order. Exported for tests. */
export function envFileCandidates(taskDir: string): string[] {
  return [
    resolve(taskDir, ".env"),
    resolve(taskDir, "../../.env"),
    resolve(process.cwd(), "backend/.env"),
    resolve(process.cwd(), "apps/example-service/.env"),
    resolve(process.cwd(), ".env"),
  ];
}

export function resolveEnvView(
  taskDir: string,
  processEnv: Record<string, string | undefined>,
): EnvView {
  const candidates = envFileCandidates(taskDir);
  const found = new Map<string, string>(); // key -> source file (first wins)
  const files = candidates.map((path) => ({ path, exists: existsSync(path) }));
  for (const { path, exists } of files) {
    if (!exists) continue;
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        if (!found.has(key)) found.set(key, path);
      }
    } catch {
      // unreadable file — same tolerance as the real loader
    }
  }

  const stateFor = (name: string): EnvVarState => {
    if (processEnv[name] !== undefined) return { name, set: true, source: "process env" };
    const from = found.get(name);
    return from !== undefined ? { name, set: true, source: from } : { name, set: false, source: null };
  };

  const knownNames = new Set(KNOWN_VARS.map((v) => v.name));
  const others = [...found.keys()].filter((k) => !knownNames.has(k) && processEnv[k] === undefined);

  return {
    files,
    known: KNOWN_VARS.map((v) => ({ ...stateFor(v.name), meaning: v.meaning })),
    others,
  };
}

/** A provider key is present somewhere the runtime would find it. */
export function hasProviderKey(view: EnvView): boolean {
  return view.known.some((v) => v.name.endsWith("_API_KEY") && v.set);
}

/**
 * Which model a run would use right now: the id chosen in this session,
 * or the env var that supplies one (name only — the value is never read
 * here). `null` when nothing resolves.
 */
export function effectiveModelSource(
  view: EnvView,
  chosenModel: string | undefined,
): { from: "chosen" | "env"; model?: string; varName?: string } | null {
  if (chosenModel) return { from: "chosen", model: chosenModel };
  const or = view.known.find((v) => v.name === "OPENROUTER_MODEL");
  const oa = view.known.find((v) => v.name === "OPENAI_MODEL");
  if (or?.set) return { from: "env", varName: "OPENROUTER_MODEL" };
  if (oa?.set) return { from: "env", varName: "OPENAI_MODEL" };
  return null;
}
