# Tasks Overview Exploration Handoff

## Where to work

- Workspace: `task-performance-prototype`
- Path: `/home/sami/coding/apo/.worktrees/task-performance-prototype`
- Bookmark: `agent/task-performance-prototype`
- Open it from the main apo checkout with:

  ```bash
  scripts/agent open task-performance-prototype
  ```

This is a throwaway, fixture-backed exploration. Do not merge its UI into
`main` or turn it into production code. A chosen direction must become a new
implementation spec.

## Run the prototypes

From this workspace, start only the dashboard on an isolated port:

```bash
pnpm --filter dashboard exec next dev --port 3100
```

Open the main Tasks-page variants:

- `http://localhost:3100/public/tasks-overview-prototype?variant=modes`
- `http://localhost:3100/public/tasks-overview-prototype?variant=rows`
- `http://localhost:3100/public/tasks-overview-prototype?variant=lens`

The earlier individual-Task exploration is also available:

- `http://localhost:3100/public/task-performance-prototype?variant=pulse`
- `http://localhost:3100/public/task-performance-prototype?variant=timeline`
- `http://localhost:3100/public/task-performance-prototype?variant=matrix`

Use the left and right arrow keys to cycle variants. All data is local fixture
data; no backend or repository access is needed.

## Product problem

The production Tasks page currently presents an all-history pass rate as if it
were one coherent measurement. That history can mix:

- different Task Definition revisions;
- different source/execution revisions;
- different models and effort settings;
- deliberate experiments and normal validation runs;
- errors and incomplete samples.

The resulting percentage can be mathematically correct but product-wise
misleading. Users need a trustworthy view of current health while retaining
access to history and controlled comparisons.

## What the prototype answered

The leading page structure is `modes`:

1. **Overview** shows the current trustworthy state of every Task.
2. **Trends** shows history with visible definition, execution, and model
   boundaries instead of one blended rate.
3. **Breakdown** compares one axis while holding the other dimensions fixed.

`rows` proves that putting baseline, history, and model evidence into every row
becomes too dense. `lens` is useful for analysis but makes the default page less
obvious. Keep these as comparison material, not rejected doctrine.

The individual-Task prototypes establish a compatible drill-down vocabulary:
current pulse, revision timeline, and comparison matrix. The immediate work is
still the main Tasks page, not polishing that drill-down.

## The unresolved question

The fixture currently hardcodes a single project-wide scope:

```text
current published Task Definitions
+ execution/source revision b772ef1
+ Opus 4, high effort
```

That is an assumption, not a decision. It may be wrong because Tasks in one
Project can legitimately use different models or configurations.

Explore what “current trustworthy state” actually means. In particular:

- Is there an explicit pinned Project baseline, a per-Task baseline, or no
  stored baseline at all?
- Which dimensions define a comparable cohort? Start from Task ID, Task
  Definition revision, execution/source revision, model, and effort, but verify
  against the real data model.
- What is selected automatically and what must a user choose?
- What does Overview show before enough comparable runs exist?
- Where do manual experiments, unpublished definitions, scheduled runs, and
  failures appear?
- Can a scheduled run define current evidence without silently making “latest
  run” the baseline?

Avoid treating the newest run as trustworthy merely because it is newest.
Avoid per-user catalogs: ownership can be a filter over shared, immutable run
history rather than a separate source of truth.

## Suggested exploration sequence

1. Read this file, `NOTES.md`, and the fixture/model in `data.ts`.
2. Inspect the real run, revision, schedule, and model fields in the current
   backend and dashboard contracts.
3. Write two or three concrete baseline/cohort state models, including empty
   and mixed-model Projects.
4. Change the fixture and `modes` prototype enough to make those models
   tangible. Prefer new `?variant=` values if alternatives need side-by-side
   comparison.
5. Record what each prototype proves or disproves in `NOTES.md`.
6. Stop once the state model and page behavior are clear. Propose a spec or a
   small wayfinder; do not productionize the prototype.

## Guardrails

- Keep the work fixture-backed and read-only.
- Do not add mutations, migrations, or production API contracts here.
- Do not spend time on exhaustive tests or visual polish.
- Do not rebase onto current `main` unless inspecting newer contracts requires
  it; the prototype is intentionally isolated.
- Use `jj`, not Git, for all version-control operations.

## Ready-to-send prompt

> Work in the existing `task-performance-prototype` jj workspace. Read
> `apps/dashboard/src/app/project/[projectId]/tasks/tasks-overview-prototype/HANDOFF.md`
> and `NOTES.md`. This is a throwaway prototype, not production code. Explore
> the unresolved baseline/comparable-cohort state model first, especially
> mixed-model Projects and empty states. Inspect the real current data model,
> then adjust fixture-backed variants so we can judge the behavior visually.
> Record conclusions and remaining product decisions in `NOTES.md`. Do not
> merge the prototype into main; finish with a recommendation for the real spec
> or wayfinder.
