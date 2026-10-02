# Releasing `@apo-ai/cli`

Published npm versions and release tags are immutable. Never move a tag or
unpublish a version for reuse; issue a corrected patch instead.

1. If the CLI dependency on `@apo-ai/sdk` changes, verify that exact SDK
   version is already available from npm.
2. Bump `packages/cli/package.json` and run:

   ```bash
   pnpm --filter @apo-ai/cli test:unit
   pnpm --filter @apo-ai/cli typecheck
   pnpm --filter @apo-ai/cli package:check
   ```

3. Merge the release PR to `main` with all PR checks green. A PR that changes
   only this manifest's `version` skips the unrelated Python/Postgres backend
   suite; any dependency, lockfile, code, or additional file change runs it.
4. Publish the exact tree that passed PR CI:

   ```bash
   scripts/publish-npm-package cli <version> <merged-pr-number-or-url>
   ```

The helper proves that the merged commit and green PR head have identical Git
trees before creating `cli-v<version>`. It discovers and approves the current
`npm-cli-release` deployment, watches the OIDC publisher, and waits until npm
serves the immutable version. When tree equality succeeds, do not wait for the
duplicate full-repository `main` CI run: the publisher reruns the CLI unit,
typecheck, and clean-consumer package gates on the tagged commit. A tree
mismatch stops the helper and requires the normal `main` CI path.
