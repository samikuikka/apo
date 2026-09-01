# Demo fixture capture

The shipped demo dataset (`apo/data/demo-workspace-v1.json`) comes from real
executions, captured on demand — never at visitor install time.

## The loop

```bash
cd backend

# 1. Open a capture window (provisions the scratch `demo-capture` project
#    with a task source rooted at the bundled demo tree).
uv run python -m apo.dev_demo_capture start

# 2. While the window is open, do the things you want in the demo — through
#    the normal UI or CLI, against the demo-capture project:
#    run tasks (both model configs for the comparison story), rejudge,
#    correct results. Nothing is captured outside the window.

# 3. Close the window: export the delta and merge it into the fixture.
uv run python -m apo.dev_demo_capture finish \
  --pin <captured-failed-run-id>=demo-run-001 \
  --pin <captured-batch-a>=demo-batch-001 --pin <captured-batch-b>=demo-batch-002

# 4. Verify the merged fixture against the surface checklist.
uv run python -m apo.dev_demo_capture verify

# 5. Boot the backend once — the loader reconciles the demo project to the
#    new fixture (digest-gated full reload) — and click through the demo.
```

`--pin` keeps the guide rail's anchor ids (`demo-run-001`, `demo-batch-001`,
`demo-batch-002`) pointing at the right entities across recaptures. Ids are
otherwise kept verbatim.

`abort` discards an open window without touching the fixture.

## Judge keys

Task runs need an agent model and judge model (OpenRouter/OpenAI-compatible
`OPENROUTER_API_KEY`). The `judge-flip-probe` task needs no agent LLM (stub
adapter) — only judge calls — making it the cheap anchor for the rejudge
story.

## When to re-capture (S4)

Manual; no release is ever blocked on it. A **full** recapture is worth it
when: the fixture schema bumps, the demo task tree changed materially, a
demo surface changed enough that captured evidence misrepresents the UI, or
a captured model became unavailable/mispriced. Incremental sessions cover
everything else. The first full capture follows the dataset narrative
(N1–N5): ~60–70% pass, ~25% informative failures, 1–2 errors, two model
configs, 8–10 batches across ~3–4 weeks of frozen timestamps
(~$10–20 at flash-tier models).

## Notes

- The fixture ships **gzipped** (`demo-workspace-v1.json.gz`, ~0.7 MB for
  ~9 MB of captured traces with full message logs). The loader reads plain
  JSON too — for hand curation: `zcat file.gz > work.json`, edit,
  `gzip -9 work.json`.
- Capture in a **scratch database** (`DATABASE_URL=sqlite:////tmp/...`):
  deliverable and run ids are globally primary-keyed, so loading the demo
  fixture into the same DB that still holds the capture project's rows
  collides. The tooling boot-checks against a fresh DB — mirror that.
- The watermark lives at `backend/data/demo-capture-session.json`
  (gitignored). Rows are exported by `created_at > watermark`.
- Traces are assembled from the durable OTLP inbox
  (`OtlpIngestBatchDB.payload`, kept verbatim): one trace flushes across
  MULTIPLE inbox batches, so the exporter merges every matching payload and
  filters at span level by trace id.
- User ids are rewritten to the inert `demo-user` on export; the demo user
  has no usable credential.
- Corrections replay through the real correction service on load, so
  verdict scalars and `corrected_tests` re-derive exactly as live.
