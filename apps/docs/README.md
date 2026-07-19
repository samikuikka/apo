# apo docs

Documentation site for [apo](../..), built with [Astro Starlight](https://starlight.astro.build/).

## Status

**Proof of concept** — docs-only, default Starlight look. The goal of this
stage is to validate **content and structure** so users get readable
documentation instead of raw code or markdown files in the repo.

Theming to the apo dark/monochrome/sharp-cornered identity (see
[`docs/design.md`](../../docs/design.md)) is the next step.

## Run it

```bash
# from the monorepo root
pnpm install
pnpm --filter docs dev
# → http://localhost:4321
```

Build a production bundle:

```bash
pnpm --filter docs build     # outputs to ./dist/
pnpm --filter docs preview   # preview the build locally
```

## Structure

```
src/content/docs/
├── index.md              ← splash landing page (/)
├── overview.md           ← what apo is
├── quickstart.md         ← clone → first verdict
├── model.md              ← core vocabulary
├── concepts/             ← how each noun works
├── guides/               ← task-focused recipes
└── self-hosting/         ← operator guides
```

Starlight looks for `.md` / `.mdx` files in `src/content/docs/`. Each file is
exposed as a route based on its file name. The sidebar is configured in
`astro.config.mjs`.

## Adding a page

1. Create `src/content/docs/<group>/<slug>.md` with frontmatter:

   ```markdown
   ---
   title: Page Title
   description: One-line summary.
   ---
   ```

2. Add an entry to the relevant `sidebar` group in `astro.config.mjs`:

   ```js
   { label: 'Page Title', slug: '<group>/<slug>' },
   ```

3. Run `pnpm --filter docs dev` — the page appears at `/<group>/<slug>/`.

## Content sources

The docs are adapted from the repo's existing documentation:

- `../../README.md` → Overview, Quickstart, Model
- `../../docs/architecture.md` → Concepts, Model
- `../../docs/self-hosted-alpha.md` → Self-Hosting guides
