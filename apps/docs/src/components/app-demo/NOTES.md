# Landing-page prototype — VERDICT

**Question:** should apo's first page present the product as the complete
application window (ported shell + pages, scripted live loop) instead of
marketing fragments, respan-style?

**Verdict (2026-10-19): YES — absorbed into the real landing page.**

The owner picked the full-app-window presentation: ported dashboard shell
and pages, product-scale rendering (1600px design viewport, zoomed to the
column; native scale under 900px), three tour surfaces (Specify / Run /
Verify) mapping to the real nav (Tasks / Runs / Traces), the loop living
in Task Run History's "Run again" (apo never edits the harness — it grades
every revision), and a file browser on the task page instead of a second
checks list.

**What shipped:** the prototype was folded into `src/pages/index.astro`
as the "The application, running." section; code lives in
`src/components/app-demo/`. Superseded landing sections (loop video,
RunDetailMock static mock, LandingFeatures) were removed. The throwaway
`/prototype/landing` route was deleted.

**Decisions worth keeping:**
- Port real components (tokens, class names, icon paths) rather than
  imitating — verified by computed-style audits against the live app.
- One deterministic fixture (`capability-sim.ts`) drives every panel;
  wall-clock-accumulated sim time with a Web Worker ticker so occluded
  webviews don't stall the demo.
- Honesty: every surface is something the product shows; the loop is the
  product's own action (run again), not an invented "engineer" page.
