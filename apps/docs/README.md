# apo docs

Documentation site for [apo](../..), built with [Astro Starlight](https://starlight.astro.build/).

## Status

Live at **[docs.test-apo.online](https://docs.test-apo.online/)**. Themed to
apo's dark/monochrome/sharp-cornered identity (see
[`docs/design.md`](../../docs/design.md)). Includes a custom landing page,
section-based header navigation, agent-readable `.md` routes, an
[llms.txt](src/pages/llms.txt.ts) agent index, `robots.txt`, JSON-LD
structured data, and a publication verifier that catches broken links and
stale references.

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
├── overview.md           ← what apo is
├── quickstart.md         ← clone → first verdict
├── why-apo.md            ← positioning FAQ
├── alpha-policy.mdx
├── hosted-alpha.mdx
├── concepts/             ← how each noun works (incl. the mental-model vocabulary)
├── guides/               ← task-focused recipes
├── cli/                  ← CLI command pages
├── reference/            ← assertion + integration reference
├── ecosystem/            ← integrations
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

3. Add the slug to the matching section list in `src/pages/llms.txt.ts` so
   agents discover the page (unlisted pages fall into llms.txt's "More"
   section, but the curated order matches the sidebar).

4. Run `pnpm --filter docs dev` — the page appears at `/<group>/<slug>/`.

## Content sources

The docs are adapted from the repo's existing documentation:

- `../../README.md` → Overview, Quickstart, Model
- `../../docs/architecture.md` → Concepts, Model
- `../../docs/self-hosted-alpha.md` → Self-Hosting guides
