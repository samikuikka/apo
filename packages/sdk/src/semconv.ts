/**
 * apo semantic conventions: the stable attribute layer on top of OTLP.
 *
 * The backend projector reads `apo.task.run.id` from the root span of a
 * task-run trace and atomically claims `AgentTaskRunDB.trace_run_id`,
 * enforcing the one-trace-per-task-run invariant. Without these attributes
 * the claim path never fires for agent-task runs.
 *
 * @module
 */

export const APO_TASK_ID = "apo.task.id" as const;
export const APO_TASK_RUN_ID = "apo.task.run.id" as const;
