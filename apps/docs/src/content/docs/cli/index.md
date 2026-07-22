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
| [`apo task run`](/cli/task-run/) | Run a task. The load-bearing command. |
| [`apo task list`](/cli/task-list/) | List discovered tasks. |
| [`apo task show`](/cli/task-show/) | Show a task's details. |
| [`apo runs list`](/cli/runs-list/) | List past runs. Filter by task, status, limit. |
| [`apo runs show`](/cli/runs-show/) | Show a run's verdict, checks, and failures. |
| [`apo traces list`](/cli/traces-list/) | List recent traces. |
| [`apo traces show`](/cli/traces-show/) | Show a trace's call tree, timing, tokens, cost. |
| [`apo traces import langfuse`](/cli/traces-import-langfuse/) | Import one Langfuse-captured trace into apo. |

## Batch runs

Run many tasks at once and watch the aggregate result.

| Command | Purpose |
|---|---|
| [`apo batch create`](/cli/batch/) | Create a batch run across multiple tasks. |
| [`apo batch show`](/cli/batch/) | Show batch details. `--watch` auto-refreshes. |
| [`apo batch list`](/cli/batch/) | List batch runs. |

## Projects and task sources

Manage which project you're operating against and where its tasks come from.

| Command | Purpose |
|---|---|
| [`apo project list`](/cli/project/) | List projects you can access. |
| [`apo project use`](/cli/project/) | Switch the active project. |
| [`apo project init-tasks`](/cli/project/) | Configure a GitHub-backed task source in one step. |
| [`apo project source`](/cli/project/) | Show, set, or sync the task source. |
| [`apo project sync-tasks`](/cli/project/) | Sync the task inventory and report the count. |

## Authentication

| Command | Purpose |
|---|---|
| [`apo login`](/cli/auth/) | Authenticate and save a project-scoped API key. |
| [`apo logout`](/cli/auth/) | Clear saved credentials. |

## Global options

These apply to every command:

| Option | Env var | Purpose |
|---|---|---|
| `--dir <path>` | `APO_TASK_ROOT` | Task root directory (default `./e2e`). |
| `--backend <url>` | `APO_BACKEND_URL` | Backend URL. |
| `--project <id>` | `APO_PROJECT_ID` | Project id. |
| `--actor <name>` | `APO_ACTOR` | Actor name for runs. |
| `--api-key <key>` | `APO_API_KEY` | API key for auth. |
| `--json` | — | Machine-readable output. |
| `--help` / `-h` | — | Show help. |
| `--version` / `-v` | — | Print the CLI version. |

Precedence: flag > env > stored credentials (`~/.apo/credentials`). See [Configuration reference](/reference/configuration/) for the full env-var catalog.
