---
title: CLI overview
description: "The apo command surface — install, authenticate, run tasks, and read results."
---

The `apo` CLI is the primary interface to the platform. It runs tasks, reads verdicts, inspects traces, manages projects, and drives the [engineering loop](/guides/loop-engineering/) — including the case where a coding agent closes the loop on its own.

## Get started

```bash
# Authenticate (email + password, picks a project)
apo login

# List discovered tasks
apo task list

# Run one
apo task run extract-parties
```

## Run and inspect

The core loop: run a task, read its verdict, open its trace when something fails.

| Command | Purpose |
|---|---|
| [`apo run`](/cli/run/) | Run evals interactively — pick tasks, pick a model, confirm, run. The human-facing runner. |
| [`apo task run`](/cli/task-run/) | Run a task. The load-bearing command. |
| [`apo task list`](/cli/task-list/) | List runnable tasks from your task root (`--catalog` for the published inventory). |
| [`apo task show`](/cli/task-show/) | Show a task's details. |
| [`apo runs list`](/cli/runs-list/) | List past runs. Filter by task, status, limit. |
| [`apo runs show`](/cli/runs-show/) | Show a run's verdict, checks, and failures. |
| [`apo runs deliverable`](/cli/runs-deliverable/) | Read a run's deliverables (manifest, or one deliverable's full content). |
| [`apo runs rejudge`](/cli/runs-rejudge/) | Re-judge a completed run against its stored deliverables — swap the judge, sample for stability, without re-running the agent. |
| [`apo runs judgments`](/cli/runs-judgments/) | List a run's verdict history — the original plus every re-judge. |
| [`apo runs delete`](/cli/runs-delete/) | Permanently delete garbage runs (harness failures, wrong environment). `--yes` required; admin only. |
| [`apo runs export`](/cli/runs-export/) | Dump a run as a self-contained JSON bundle — the backup before evidence expires or a run is deleted. |
| [`apo traces list`](/cli/traces-list/) | List recent traces. |
| [`apo traces show`](/cli/traces-show/) | Show a trace's call tree, timing, tokens, cost. |
| [`apo traces import langfuse`](/cli/traces-import-langfuse/) | Import one Langfuse-captured trace into apo. |

## Batch runs

Run many tasks at once and watch the aggregate result.

| Command | Purpose |
|---|---|
| [`apo batch show`](/cli/batch/) | Show batch details. `--watch` auto-refreshes. |
| [`apo batch list`](/cli/batch/) | List batch runs. |
| [`apo batch delete`](/cli/batch/) | Permanently delete a poisoned batch and every task run it owns. `--yes` required; admin only. |

## Projects and task sources

Manage which project you're operating against and where its tasks come from.

| Command | Purpose |
|---|---|
| [`apo project list`](/cli/project/) | List projects you can access. |
| [`apo project use`](/cli/project/) | Switch the active project. |
| [`apo project`](/cli/project/) | Create, list, and select projects. |

## Authentication

| Command | Purpose |
|---|---|
| [`apo login`](/cli/auth/) | Log in — sets the backend, project, and task root every command uses. Remembered per backend; switch with `apo login --backend <url>`. |
| [`apo logout`](/cli/auth/) | Clear saved credentials. |
| [`apo status`](/cli/status/) | Print the effective configuration: login, backend, project, task root. |

## Operator

`apo reprice` is an operator-only command that recomputes the cost of stored calls against current pricing tiers. It uses a kick-off + poll pattern (the backend CLI times out at 15s) and requires an admin key. Run `apo reprice --help` for the full flag set (`--project`, `--model-id`, `--since`, `--until`, `--dry-run`, `--admin-key`). See [Self-Hosting → Configuration](/self-hosting/configuration/) for the pricing model.

## Global options

These apply to every command:

| Option | Env var | Purpose |
|---|---|---|
| `--dir <path>` | `APO_TASK_ROOT` | Task root directory (default `./e2e`; after `apo login`, the task root stored in credentials). Run [`apo status`](/cli/status/) to see the effective value. |
| `--backend <url>` | `APO_BACKEND_URL` | Backend URL. |
| `--project <id>` | `APO_PROJECT_ID` | Project id. |
| `--actor <name>` | `APO_ACTOR` | Actor name for runs. |
| `--api-key <key>` | `APO_API_KEY` | API key for auth. |
| `--json` | — | Machine-readable output. |
| `--help` / `-h` | — | Show help. |
| `--version` / `-v` | — | Print the CLI version. |

Precedence: flag > env > stored credentials (`~/.apo/credentials`). See [Configuration reference](/reference/configuration/) for the full env-var catalog.
