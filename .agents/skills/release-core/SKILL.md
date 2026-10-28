---
name: release-core
description: Prepare or refresh an Elabora core release PR with Sampo, synchronized package versions, changelogs and release validation. Use for core releases; the desktop product release is prepared in its app checkout.
---

Read [the release workflow](../../../docs/releases.md). Inspect the worktree, branch, remote, pending changesets and existing tags before choosing a version. Resolve routine release choices from the requested scope and observed changes; ask only when release intent or a breaking-change decision is missing.

Prepare on a `release/core-<version>` branch. Use an isolated checkout when other work is present; never reset another session's files. Run `pnpm run release:prepare`, check the generated output and complete the documented validation. A course schema version does not follow the package release train automatically.

Commit and open or refresh one release PR. Use a body file for `gh pr create`/`edit`. Include resulting behavior, validation and any unresolved configuration. Preparing ends with a reviewable PR; merge or direct publication requires release authorization. After an authorized merge, follow the release workflow until it succeeds or exposes an actionable failure. Do not claim a release was published from a successful build alone.

On retry, keep the version and source revision stable. Never move an existing release tag or run `sampo publish` to work around a GitHub Release failure: npm publication is not enabled. Read failed logs, fix the cause and rerun the failed job.
