---
title: Overview
description: What apo is, in a minute.
---

**apo** is a testing framework for agents. You write a test, apo runs your real agent against it, and the run comes back pass or fail: the same loop as Jest or pytest, extended for the fact that an agent's output usually isn't exact-match.

## It runs in your system

apo doesn't host a copy of your agent. It doesn't score a prompt in a sandbox. It runs against the agent you actually ship (the same code path, the same tools, the same model), driven through an [adapter](/concepts/adapters/) you write. The adapter is the only place real code runs during a task: it loads the inputs, invokes your agent, and collects the structured deliverable the tests assert on.

You don't change your agent to fit apo. The adapter is a shim that calls your existing code (your chat function, your tool definitions, your model client) as-is. apo adapts to your system; your system doesn't adapt to apo.

This is the part that's yours to build, because it has to be. No framework can ship a generic adapter that meaningfully tests *your* agent against *your* application. apo gives you the lifecycle, the tracing, and the test runner; you give it the seam.

## It judges what the agent produced

Most agent eval tools grade the conversation. apo judges the **deliverable**: the file written, the state changed, the structured output the agent was asked to produce. A polite, fluent, wrong response fails. A terse one that produced the right artifact passes.

The deliverable is declared up front, collected by the adapter after the run, and schema-validated before the tests see it. You're asserting on what the agent *did*, not on whether the chat *sounded right*.

## How to use these docs

- **[Why apo](/why-apo/)**: the core of the product. The beliefs the whole framework is built on, and the trade-offs behind each one. **Read this next.**
- **[Quickstart](/quickstart/)**: clone to first result. Skip here if you want to be running a task in five minutes.
- **[Mental model](/concepts/mental-model/)**: the layers a run moves through (task, run, batch, trace) and the one rule that ties them together.
- **[Adapters](/concepts/adapters/)**: the bridge to your real application, and the part you write. This is the load-bearing concept.
- **[Tests](/concepts/tests/)**: the assertion vocabulary, every `t.*` method and what it does.
- **[Tasks](/concepts/tasks/)**: the `.eval.ts` file convention.
- **[Traces](/concepts/traces/)**: the debugging surface.
- **[Schedules](/concepts/schedules/)**: how often each subset runs.
- **[Self-Hosting](/self-hosting/topology/)**: running apo on your own box.

Read **[Why apo](/why-apo/)** next. It's the core of the product, not background reading. If you'd rather try first and read after, [Quickstart](/quickstart/) gets you to a passing run.
