# Project Beliefs

This file captures the current product beliefs behind the agent-testing direction of this project.

It exists so future work stays aligned with the actual point of view of the product, not just the current implementation details.

## What This Product Is

This project is an opinionated testing and engineering system for agent harnesses.

Its job is to give every agent task an **executable definition of done**. A team states the behavior it expects, apo runs the real system, and a completed evaluation produces a machine-actionable control signal: pass or fail, backed by the test breakdown, trace, and deliverables. Runtime and infrastructure failures are surfaced separately as errors.

That makes apo useful in both a normal engineering workflow and an agent-driven one. A human, CI system, or coding agent can use the result to decide what to change and when to run again. apo does not edit the implementation or autonomously start another Task Run to improve a failed verdict; it grounds each verdict in inspectable evidence.

The emphasis is on:

- testing real implementations
- evaluating real outcomes
- making pass/fail decisions explicit
- making failures debuggable through traces
- letting teams choose how often different subsets should run

## The Category

The agent tooling landscape has two established starting objects, and both categories are full:

- **Testing/eval frameworks** start from a *test case plus evaluator*: did this execution satisfy my assertion or metric?
- **Observability/eval platforms** start from an *execution record*: trace production traffic, score it, mine datasets, monitor.

apo starts from a third object: the **capability specification** — "this harness must be capable of doing X, under these conditions, while satisfying these constraints, and leaving behind this result." apo's job is to make that statement executable and to support the loop that engineers the harness until it holds.

Those other products can contain tests. apo treats the specification as the product: traces explain failures, judges verify subjective requirements, datasets provide scenarios, CI prevents regressions — but every primitive is organized around the specification, not around an execution or a score.

This is a deliberate boundary, not a limitation to grow out of. apo is not trying to be another eval framework or a production observability platform; the acceptance-test layer for agent systems is the ground to own. What that framework enables is **harness engineering**: expert knowledge encoded as executable specifications, with humans or coding agents changing the harness until the specifications pass.

## Core Beliefs

### 1. Test the real implementation

The product should run the real agent or system behavior, not a simplified proxy.

We care about how the actual implementation behaves in realistic execution, not just how a prompt snippet scores in isolation.

### 2. Evaluate deliverables and outcomes

The main thing to judge is whether the run produced the right deliverables or outcomes.

The product should not be centered only on final chat text. For many agent systems, the important result is an artifact, file, state change, report, action, or other collected deliverable.

### 3. Tests are the unit of evaluation

A task says what "good" means through multiple explicit **tests**.

A test is one assertion about the run. The code registers each one with `test(...)`, and a task usually needs several rather than one vague judgment or one brittle exact-match assertion.

`test` is the canonical product term. There is no longer a separate `criteria` or `checks` category — those were an artifact of treating judges and code assertions as different things (see belief 4).

### 4. Tests can be deterministic or judged, and live in the same place

Some outcomes can be checked with fast, deterministic code (did the agent call the right tool? does the deliverable match a schema? did any action fail?). Others involve taste, judgment, or qualitative assessment that only an LLM can evaluate well (does this output actually meet what a user would expect?).

Both are necessary:

- deterministic tests alone are too narrow — they miss whether the result is genuinely good
- judged tests alone are too soft — they miss concrete, checkable facts

So a task uses **both**, and they are **the same kind of thing**: a judged assertion is written inside a `test(...)` next to code assertions, not as a separate "LLM judge" concept or first-class category. A test may be non-deterministic; that is fine. What matters is that fast cheap tests catch basic failures while real LLM judges catch whether the product actually works for users — and a task should have both, in one place.

### 5. Per-run verdicts are binary; comparison needs graded signal

At the level of a completed evaluation, the verdict is a clear decision: **pass** or **fail**. If any test fails, the run fails. The question is whether it met the standard, not what score it got. A Task Run that cannot complete evaluation has an error status rather than a false verdict.

But binary verdicts do not survive aggregation. A run that failed 1 of 15 tests and a run that failed 14 of 15 are both "fail," yet they are not equally bad. When comparing runs — across versions, changes, or time — collapsing both to the same binary loses the signal needed to tell whether a change improved things.

So the product holds both:

- per-run: a binary decision (pass / fail)
- across runs: the graded signal of how many tests passed, because two failures are not equal and the trajectory matters

Example:

- a single run: `Failed`, with supporting detail `14/15 tests passed`
- comparing that run to a later one at `9/15`: the verdict is still "fail" for both, but the graded signal shows the system regressed

The graded signal exists to compare runs and detect improvement or regression — not to turn the per-run outcome into fuzzy scoring.

### 6. Not all tests should run all the time

Teams should test often, but they should not need to run every test on every cadence.

Different subsets have different operational value and different cost.

### 7. Schedules express operational importance

Test importance should not be hardcoded into the task itself.

Instead:

- tasks define what to validate
- schedules define how often to validate it
- teams decide which subsets matter enough to run more frequently

This means schedules are not just cron-like automation. They are part of the team's validation policy.

### 8. Failing runs must be traceable

Every failing run should be debuggable through traces.

The trace is a core product surface, not optional observability garnish.

## Product Language

Preferred terms:

- `Task`: one reusable validation case
- `Task Run`: one execution of one task
- `Batch Run`: one execution container that may produce one or more task runs
- `Test`: one assertion within a task; may be deterministic code or an LLM-backed judgment
- `Trace`: the debugging surface for runtime behavior

`Criteria` and `Checks` are retired as separate canonical terms. They were an artifact of treating judges and code assertions as different things; under belief 4 they are the same thing — tests. Existing code and UI may still say "checks," but the source-of-truth term is `test`.

## What Is Not a Product Belief

These may be good current choices, but they are not the core philosophy of the product:

- exact folder structure
- exact file names
- current page ownership
- whether single-task runs are implemented through one-task batch runs
- current UI layout details

Those can evolve without changing what the product fundamentally believes.

## Practical Implications

When making product or UI decisions, prefer solutions that reinforce these ideas:

1. Run a real task.
2. Judge real deliverables.
3. Show a binary verdict for every completed evaluation and an explicit error when evaluation cannot complete.
4. Explain failure through tests (which passed, which failed).
5. Preserve graded signal across runs for comparison.
6. Let teams choose cadence through schedules.
7. Make traces the path for debugging.
8. Return evidence that a human or coding agent can act on without inventing a second evaluation layer.
9. Keep the repair loop outside apo: one completed evaluation produces one verdict; the caller decides what changes and whether to start another Task Run.

## Current Status

These beliefs reflect the current agent-testing product direction and are more important than older optimizer-era framing when the two are in tension.
