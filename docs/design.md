# Design System

> The single source of truth for how this dashboard looks and reads. Every
> agent and human touching UI should follow it. Adapted from Vercel Geist's
> discipline, tuned to our dark, monochrome, developer-dense identity.

## Identity

Dark, monochrome, content-forward. This is a **developer observability tool**,
not a marketing site. The UI should get out of the way of the data: dense
tables, long traces, lots of IDs and numbers. Aesthetics serve legibility.

Five principles, in priority order:

1. **Monochrome-first.** Gray scale carries 95% of hierarchy. Color is reserved
   for state and the single most important action on a view — never decoration.
2. **Content forward.** Whitespace and type do the framing; chrome (borders,
   backgrounds, shadows) stays minimal.
3. **Sharp.** Corners are square (`--radius: 0`). Do **not** introduce
   `rounded-md`, `rounded-lg`, etc. One radius family (square) across the app.
4. **Dense.** Default to compact controls (`h-8`, `text-xs`) and tight spacing.
5. **Color = state.** A colored element means something (error, success, a type,
   a status). If it doesn't signal state, it should be gray.

## Theme

Dark only. `color-scheme: dark` on `:root`, `dark` class hardcoded on `<html>`.
No light theme. Do **not** write `dark:` variants — the base targets dark;
existing `dark:` prefixes are legacy, removed on touch.

## Color

OKLCH tokens referenced via Tailwind theme utilities (`bg-background`,
`text-muted-foreground`, `text-destructive`, …) — never raw hex or named
Tailwind colors (`text-red-400`, `bg-green-500/10`).

| Token | Value | Use |
|---|---|---|
| `--background` | `oklch(0 0 0)` | Page background |
| `--foreground` | `oklch(1 0 0)` | Primary text |
| `--card` | `oklch(0.18 0 0)` | Cards/panels |
| `--popover` | `oklch(0.18 0 0)` | Menus, popovers |
| `--muted` | `oklch(0.2 0 0)` | Muted fills |
| `--muted-foreground` | `oklch(0.6 0 0)` | Secondary text |
| `--secondary` | `oklch(0.2 0 0)` | Secondary fills |
| `--accent` | `oklch(0.25 0 0)` | Hover/active fills |
| `--border` | `oklch(0.28 0 0)` | Visible borders |
| `--input` | `oklch(0.2 0 0)` | Input backgrounds |
| `--ring` | `oklch(0.4 0 0)` | Focus ring (gray) |
| `--destructive` | `oklch(0.5 0.22 25)` | Errors, destructive actions |
| `--success` | `oklch(0.65 0.15 155)` | Pass / success |
| `--warning` | `oklch(0.7 0.14 70)` | Warnings |
| `--primary` | white on black | The single primary action per view |

**Accent discipline.** Small palette (red/green/amber) plus trace type-color
tokens (`--type-generation/tool/agent/embedding/retriever`), all low-chroma.
Don't introduce new accent hues ad-hoc — add a token here first.

**Alpha over solid.** Use `/opacity` modifiers (`bg-foreground/10`,
`border-border/50`) for tints, not new solid colors.

**Allowed exception — chat-role tints.** `ChatMessagePreview` uses per-role
hues (system/user/assistant) to distinguish speakers — load-bearing for
readability, so permitted. Map to tokens where one exists (tool → `--warning`);
keep others muted. Don't propagate this pattern elsewhere.

**Allowed exception — code syntax highlighting.** `syntax-highlight.tsx` and
`expandable-json/utils.tsx` colorize code tokens (keywords, strings, numbers,
etc.). Syntax highlighting inherently needs a small varied palette; these raw
hues are permitted within those two modules. Don't propagate ad-hoc syntax
colors elsewhere.

## Typography

Set sizes via these utilities, not arbitrary pixels.

| Role | Class | Size | Weight |
|---|---|---|---|
| Page H1 | `text-[18px] font-semibold tracking-tight` | 18px | 600 |
| Section heading | `text-sm font-semibold` | 14px | 600 |
| Body | `text-[13px]` | 13px | 400 |
| Secondary/meta | `text-xs text-muted-foreground` | 12px | 400 |
| Tiny/tag | `text-[10px]` / `text-[11px]` | 10–11px | 500 |
| Data/IDs/numbers | `font-mono` + `tabular-nums` | — | — |

- Sans: Noto Sans. Mono: `--font-mono`. `tabular-nums` on number columns.
- ≤2 font weights per view (400 + 600). `text-[12px]`→`text-xs`,
  `text-[20px]`/`text-xl`/`text-2xl` H1→`text-[18px]` (legacy).

## Spacing & layout

4px base. Rhythm: 8px inside a group, 16px between groups, 24–32px between
sections. Page `px-6`; card `p-4`/`p-6`; `max-w-3xl` forms, `max-w-6xl`–`7xl`
tables. Work on mobile + desktop (`flex-col … sm:flex-row`).

## Shapes

**Square corners everywhere.** `--radius: 0`. No `rounded-md/lg/xl/2xl/sm`.
Only `rounded-full` (pills/avatars/circular) is allowed. One radius family
per view.

## Elevation

Tonal surfaces (`card` vs `background`) + borders first; shadows rare. Prefer
`border border-border` over `shadow-*`.

## Motion

Motion has three sanctioned purposes. All motion honors `prefers-reduced-motion`.

**State motion** — to clarify change in the UI itself (hover, open, dismiss).
~150ms state, 200ms popover, 300ms overlay. The default; what most motion is.

**Illustrative motion** — to make an abstract concept legible. Concept demos
in the docs (e.g. the graded-runs regression on *Why apo*, the trace-tree
build on *Traces*). Multi-second, plays on scroll-into-view, loops or
replays. The test for whether a demo belongs here: *if removing the motion
removes understanding, it belongs.* If it would just be nicer to look at,
it doesn't. Each freezes to a representative static frame under reduced-motion.

**Brand motion** — the signal sphere (hero on the splash, cover on *Why apo*).
The one exemption from "never decoration": the brand mark animating is
identity, not feedback. Confined to those two pages; falls back to the static
SVG under reduced-motion. Don't extend this exemption to other surfaces.

## Components

shadcn/ui primitives in `components/ui/` — use them, don't hand-roll.

- **Button** `h-8 text-xs gap-1.5`; variants default (primary, one per
  view)/outline/secondary/ghost/destructive; always `type="button"`.
- **Input** `h-8 text-xs` square `bg-input/30`.
- **Badge** `h-5 text-xs` square; secondary/destructive.
- **Card** `bg-card` square `border`. **Table** dense, mono numbers.

Primary action = `variant="default"` (solid); others outline/ghost. Never two
solid primaries per view.

## Voice & content

- Title Case labels/buttons/titles/tabs; sentence case body/toasts.
- Actions = verb+noun (`Delete key`) — never `Confirm`/`OK`/bare verb.
- Errors = what happened + what to do.
- Toasts name the thing changed, no trailing period, never "successfully":
  `Key deleted`.
- Empty states point to the first action.
- In-progress = present participle + `…`. Numerals, curly quotes, `…` not `...`.
- No verbose page subtitles restating the nav label.

## Focus & accessibility

Focus ring on every interactive `:focus-visible` (never remove without
replacement). Icon-only buttons **must** have `aria-label`. Semantic HTML.
Keyboard support for click handlers. Body ≥12px. WCAG AA (4.5:1).

## Do / Don't

- Do rank with gray scale (foreground/muted-foreground/muted-foreground/60).
- Do reserve accent color for state + the one primary action.
- Do use type tokens, not hand-set sizes.
- Do use color tokens (`text-destructive`/`success`/`warning`), not raw hues.
- Don't add rounded corners. Square is the identity.
- Don't write `dark:` variants — dark-only.
- Don't add accent hues without a token (chat-role tints = documented exception).
- Don't mix >2 weights or >1 radius family per view.
- Don't write marketing subtitles that restate the nav.
- Don't swap `muted-*` for `card-*`.

## Decision log

- **Sharp corners, kept** (rejected Geist 6/12/16px — suits a dense data tool).
- **Minimal accents, kept** (rejected Geist 7-hue palette — noise in data UI;
  chat-role tints = allowed exception).
- **Dark only** (no light theme; `dark:` variants legacy, removed on touch).
- **Noto Sans, not Geist Sans** (separate, larger decision).
