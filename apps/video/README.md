# apo video studio

Remotion project for apo's marketing and educational videos — the concept
series for X/YouTube, styled to the dashboard identity in
[`docs/design.md`](../../docs/design.md): dark, monochrome, sharp corners,
Noto Sans + JetBrains Mono, color only for state.

## Commands

```bash
pnpm --filter video studio          # Remotion Studio on :3220 (3000 is the dashboard)
pnpm --filter video compositions    # list registered compositions
pnpm --filter video render:loop     # out/the-loop.mp4 (1920×1080, 30fps, 50s)
pnpm --filter video render:deliverable # out/deliverable-not-chat.mp4 (46s)

# Stills (thumbnails, X image posts — image posts beat video links)
pnpm --filter video exec remotion still src/index.ts TheLoop out/thumb.png --frame=1430
```

All Remotion packages must share one exact version — bump them together
(e.g. `pnpm --filter video add remotion@X @remotion/cli@X @remotion/google-fonts@X`).

Remotion is free for individuals and companies ≤3 people; a paid license is
needed above that. Revisit if a company forms around apo.

## Compositions

### TheLoop — the thesis video (50s)

The loop is the red thread: one walk around the ring, node by node. The ring
lives on the left for the whole video (`SpineRing`); its token travels to the
phase's node when the phase starts and dwells there while the scene plays.
Lap one fails at the verdict; lap two — same tests, changed implementation —
passes and exits.

| Beat | Frames | What happens |
|---|---|---|
| Title | 0–140 | big signal sphere + apo lockup, "The Loop" |
| The map | 140–230 | ring assembles: 01 Run agent → 02 Verdict → 03 Evidence → 04 Improve, directed arrows forming the ring |
| 01 Run agent | 230–420 | `apo task run` types itself, spinner — your real agent runs |
| 02 Verdict | 420–600 | test breakdown resolves, 0/2 FAIL stamps; verdict node turns red |
| 03 Evidence | 600–790 | the trace tree: the answer claim no source supports, in red |
| 04 Improve | 790–960 | the implementation diff (`-` old, `+` read the source first) |
| Lap 2 · run | 960–1090 | token crosses the top — run 2/2, same tests, faster |
| 02 Verdict | 1090–1230 | 2/2 PASS, verdict node green, output card lights: "Improved agent" |
| Close | 1230–1500 | the loop formula + wordmark |

Scene windows use `AppFrame variant="window"` — the product's browser bar +
breadcrumb without the sidebar. The full `AppFrame` (top nav + sidebar) is
ready for videos that stage whole dashboard pages.

### DeliverableNotChat — the contrarian one (46s)

Most eval tools grade the conversation. apo judges what the agent produced.

| Beat | Frames | What happens |
|---|---|---|
| Title | 0–120 | "Judge the deliverable, not the chat." · apo — 02 |
| Chat graded | 120–480 | fluent chat gets a PASS from a chat grader; parties.json opens with 3 of 5 parties missing → FAIL. "Polite. Fluent. Wrong." |
| Deliverable graded | 480–840 | terse "done" chat, complete deliverable, tests tick green on the artifact |
| Side by side | 840–1080 | same run: the chat passes, the deliverable fails |
| Code | 1080–1320 | `t.check(deliverables.parties, matches(...))` + `t.judge(...)` — both are just tests |
| Close | 1320–1380 | wordmark + tagline |

## Series roadmap

1. **The Loop** ✅ — the thesis, everything links back to this
2. **Judge the deliverable, not the chat** ✅ — most shareable; lead with it
3. Binary verdicts, graded trajectories — the `14/15 → 9/15` regression story
4. Loop engineering — terminal screencast: `apo task run` → `runs show` → `traces show` → fix → pass
5. One file, three concerns — the `.eval.ts` convention
6. Run the real thing + failures need traces — the adapter and the trace tree

Ship 1 + 2 first; if they don't move, rethink before investing in 3–6.

## Conventions

- **No fabricated data.** Replace placeholder runs/parties with real ids from
  apo's own eval history before publishing.
- **Beats are `<Sequence>` + `<Beat>`** — every beat fades in/out over 8
  frames; sequences must tile the composition exactly (durations sum to the
  composition length).
- **Color = state only.** Green passes, red fails, amber errors. Everything
  else is the gray scale from `src/theme.ts`.
- **Captions carry the argument** — the videos ship without voiceover; every
  beat's claim is one sentence in a `Caption`, key words in `Em`.
- **Square/vertical cuts**: register a second `<Composition>` with
  1080×1080/1080×1920 and adjust `stagePadding` per aspect — the components
  take widths as props.
