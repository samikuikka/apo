/**
 * Where a task must run (SPEC-136 implicit local execution).
 *
 * - `"local"`: needs dev-machine resources (cloud creds, VPC tunnel, personal
 *   stage). Record on the backend if reachable, execute locally — exactly
 *   today's `--local` semantics.
 * - `"backend"`: safe to run inside the backend container. The implicit
 *   default for every task; the field just makes it explicit.
 * - `"auto"`: no preference — use the project default or the reachability
 *   heuristic. Omitting `execution` is equivalent to `"auto"`.
 */
export type TaskExecutionPreference = "local" | "backend" | "auto";

export type TaskDefinition<
  TAdapterName extends string = string,
  TDeliverable extends string = string,
> = {
  id: string;
  adapter: TAdapterName;
  description?: string;
  deliverables: TDeliverable[];
  maxTurns?: number;
  metadata?: Record<string, unknown>;
  checks?: string | false;
  /**
   * Where this task must run. Optional — omitting it is equivalent to
   * `"auto"` and preserves backward compatibility. See
   * {@link TaskExecutionPreference}.
   */
  execution?: TaskExecutionPreference;
};

export type TaskConfig<TDeliverable extends string = string> = Omit<
  TaskDefinition<string, TDeliverable>,
  "adapter"
>;

export type FileEntry = {
  relativePath: string;
  absolutePath: string;
};
