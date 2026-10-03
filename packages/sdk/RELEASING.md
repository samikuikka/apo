# Releasing `@apo-ai/sdk`

This is the maintainer runbook for publishing `@apo-ai/sdk` to npm. There are
two release paths:

- **One-time bootstrap** — the very first publication, done manually from a
  trusted maintainer workstation.
- **Later releases** — every subsequent version, published through GitHub
  Actions via npm trusted publishing (OIDC). No `NPM_TOKEN` secret.

Published npm versions are immutable. **Never unpublish and reuse a
version** — publish a corrected patch version instead.

## Prerequisites (external to this repository)

Code cannot establish these. The maintainer must verify them before the
first release:

- Owns or has publishing membership in the npm `apo-ai` organization.
- Has npm two-factor authentication enabled.
- `npm whoami` returns the publishing account.

If any of these fail, stop and pick a fallback scope/name with the
maintainer. Do not silently rename the package or bulk-rewrite imports.

## One-time bootstrap

> **Status: DONE on 2026-08-03.** `@apo-ai/sdk@0.2.0` was published manually
> and `@apo-ai/sdk@0.2.1` followed via the OIDC workflow. The steps below
> are kept as the historical record and the recipe if the package ever
> needs to be bootstrapped again (e.g. a new scope).

The first `@apo-ai/sdk` publication cannot use trusted publishing yet — the
trusted publisher configuration on npm is created *after* the package
exists. Do this once manually:

1. **Verify identity and availability.**

   ```bash
   npm whoami                       # must be the publishing account
   npm view @apo-ai/sdk                # must 404 — confirm nobody squatted it
   ```

   If `npm view` returns an existing package owned by somebody else, this
   is a hard stop.

2. **From an up-to-date clean `main`, run the package gate.**

   ```bash
   git fetch && git checkout main && git pull
   pnpm install --frozen-lockfile
   pnpm --filter @apo-ai/sdk test
   pnpm --filter @apo-ai/sdk typecheck
   pnpm --filter @apo-ai/sdk package:check
   ```

   `package:check` packs the exact tarball npm would receive, installs it
   into a clean directory, imports every entry point, compiles a TypeScript
   consumer, and runs `publint`. Every step must pass.

3. **Create and inspect the release tarball.**

   ```bash
   cd packages/sdk
   pnpm pack --pack-destination ../../release
   tar -tzf release/apo-ai-sdk-0.2.0.tgz | less
   ```

   Confirm: only `dist/`, `LICENSE`, `README.md`, `package.json`. No `src/`,
   no test fixtures, no `.env`.

4. **Publish the tarball as public.**

   If the publishing account has TOTP 2FA configured, the CLI prompts for
   the code:

   ```bash
   npm publish --access public release/apo-ai-sdk-0.2.0.tgz
   # complete the npm 2FA prompt
   ```

   If the account does not have TOTP 2FA (e.g. npm's current enrollment
   only offers WebAuthn/passkey, which may not work on Linux desktops),
   use a short-lived granular access token instead. Create one at
   `npmjs.com/settings/<user>/tokens/granular-access-tokens/new` scoped
   to `@apo-ai` with Read+Write, 7-day expiry, then:

   ```bash
   npm publish --access public release/apo-ai-sdk-0.2.0.tgz \
     --//registry.npmjs.org/:_authToken=npm_xxxxxxxxx
   ```

   Delete the token on the tokens page immediately after. This is the
   path that was used for the initial `0.2.0` bootstrap.

5. **Smoke-test the registry copy.**

   In a brand-new empty directory:

   ```bash
   pnpm add @apo-ai/sdk@0.2.0
   node -e "import('@apo-ai/sdk').then(m => console.log(Object.keys(m)))"
   ```

   This must resolve from the registry, not from any local cache or workspace
   link.

6. **Configure trusted publishing for later releases.**

   In the npm package settings for `@apo-ai/sdk`:

   - Repository: `samikuikka/apo`
   - Workflow: `publish-sdk.yml`
   - Environment: `npm-sdk-release`

   After this is set, manual publication is no longer required.

## Later releases

Every version after the bootstrap goes through GitHub Actions via OIDC. The
maintainer never types npm credentials:

1. **Bump the version** in `packages/sdk/package.json` following semver.

   ```json
   { "version": "0.3.0" }
   ```

2. **Update user-facing docs and release notes** for any SDK-visible change
   (new entry points, new exports, changed signatures, dependency bumps).

3. **Merge to `main` with green CI.** CI runs the package gate on every PR —
   the same gate the release workflow runs.

4. **Create and push the release tag.** The tag must be exactly
   `sdk-v<package-version>`:

   ```bash
   git tag sdk-v0.3.0
   git push origin sdk-v0.3.0
   ```

   The workflow refuses to publish if the tag and `package.json` version
   disagree.

5. **Approve the protected environment deployment.** GitHub pauses the run
   at the `npm-sdk-release` environment; approve it in the Actions UI.

6. **Verify the result.**

   - The job summary links to `https://www.npmjs.com/package/@apo-ai/sdk/v/<version>`.
   - The npm page shows a provenance badge (signed by GitHub OIDC).
   - `npm view @apo-ai/sdk@<version>` returns the new version.

## What the workflow enforces

`.github/workflows/publish-sdk.yml` is the only path that publishes. It:

- Triggers only on `sdk-v*` tags (not branch pushes, PRs, or `v*` Docker tags).
- Requires `id-token: write` for the OIDC exchange.
- Uses the protected `npm-sdk-release` GitHub environment.
- Refuses to publish if `sdk-v<version>` ≠ `packages/sdk/package.json` version.
- Runs `test`, `typecheck`, and `package:check` before publishing.
- Packs the tarball with `pnpm pack` (applies `publishConfig` rewrite).
- Publishes that exact `.tgz` with `--access public --provenance`.
- Contains no `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret anywhere.

The contract is enforced by `packages/sdk/tests/publish-workflow.test.ts`.
