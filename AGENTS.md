# Working on this OmniRoute fork

This is `Raudbjorn/OmniRoute`, a personal integration and experimentation fork.
The working integration branch is `compression-core`. The aim is to try changes
from upstream and other forks while preserving this fork's behavior and cleanup.
Prefer small, understandable changes and reuse the existing implementation.

This file is the root guide. Read a nested `AGENTS.md` when changing its directory.
Files named `.old.AGENTS.md`, `.old.CLAUDE.md`, and `.old.GEMINI.md` are historical
references, not active instructions. Do not restore upstream release procedures,
maintainer-specific filesystem paths, or mandatory approval rituals from them.

## Fork decisions to preserve

Reviewed against the checkout on 2026-09-08. Verify the current code and Git diff
before using this list; update it when an intentional fork decision changes.

| Area                        | Preserve when importing changes                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository identity         | `origin` is `https://github.com/Raudbjorn/OmniRoute`. `origin/dev` belongs to this fork; it is not an upstream tracking ref.                                                                                                                                                                                                         |
| Host platforms              | Windows and macOS host support is removed. Root npm metadata excludes `win32` and `darwin`; Electron packages Linux. Retain existing Linux, Android/Termux, and applicable FreeBSD behavior without claiming every feature supports every host.                                                                                      |
| Platform removal boundaries | Do not restore Windows/macOS installers, process helpers, paths, tray/autostart code, certificate commands, or release targets. Keep upstream protocol identities/user agents, remote-client platform handling, foreign-binary detection, path redaction, and browser keyboard compatibility where they still serve supported hosts. |
| Rust compression            | `compression-core/` is an independent Rust workspace. Tokenizer and golden fixtures exist; the FFI crate is a placeholder. Production compression remains in TypeScript. Do not silently replace it with Rust or couple the Rust algorithms to OmniRoute/Node internals.                                                             |
| Repository cleanup          | Workflow and changelog removals are committed; further docs-mirror, translation-pipeline, coverage, and release-tooling removals are in progress. Treat relevant deletions as intentional, inspect their history, and adapt incoming changes instead of resurrecting removed infrastructure.                                         |
| Localization                | Removing `docs/i18n/` and its generation pipeline does not remove dashboard or CLI localization. Keep `config/i18n.json`, `src/i18n/`, and `bin/cli/locales/` behavior unless the task explicitly changes it.                                                                                                                        |
| Prior merge repairs         | Preserve malformed combo JSON handling in `src/lib/db/repositories/sqliteComboRepository.ts` and the `toFts5MatchQuery` export in `src/lib/memory/retrieval.ts`. Do not resurrect tests for removed `getKnownContextOverflow` APIs. Inspect commit `c9333a8b9` for the reasons.                                                      |
| Publishing                  | A successful local build is not permission to publish. Some retained metadata still references other owners: Electron's publish target is upstream and the Rust workspace repository is the source fork. Review actual destinations when publication is requested; do not blanket-rewrite attribution links.                         |

## Provider cooldown profiles

The opt-in global Provider Cooldown (`PROVIDER_COOLDOWN_ENABLED`, default off)
uses the `providerFailureThreshold`, `providerFailureWindowMs`, and
`providerCooldownMs` fields in `PROVIDER_PROFILES` for provider-level entries in
`open-sse/services/providerCooldownTracker.ts`. These are separate from the live
provider circuit breaker's thresholds. Preserve connection-level exponential
backoff and success resets. See [Resilience Guide](./docs/architecture/RESILIENCE_GUIDE.md).

## Repository map

```text
src/
  app/api/                 HTTP entry points and validation
  sse/                     app-side chat routing and dispatch
  lib/db/                  SQLite domains, adapters, migrations (nested guide)
  lib/                     provider integrations, runtime services, policy
open-sse/
  handlers/                request execution and streaming
  executors/               provider transports
  translator/              request/response format conversion
  services/                routing and compression (nested guide)
compression-core/          standalone Rust workspace and tokenizer golden tests
bin/cli/                   CLI lifecycle, process supervision, tray
scripts/build/             standalone/native dependency assembly
scripts/check/             focused repository checks
electron/                  Linux desktop wrapper and packaging
tests/unit/                mostly Node test runner; includes nested directories
```

## Importing someone else's changes

1. Inspect `git status --short`, `git branch -vv`, `git worktree list`, and
   `git remote -v`. Identify any merge/rebase/cherry-pick already in progress.
   Finish the requested operation in its existing worktree; do not start a second
   operation or switch the shared checkout's branch underneath another session.
2. Use the user's named base. Otherwise use the current committed fork integration
   tip for an experiment. Fetch explicitly; do not use a blind `git pull` (this
   checkout currently configures pulls to rebase). Record the base and candidate
   SHAs, repository, and branch/PR in the result or commit message.
3. Review the candidate's diff, dependency changes, tests, and prerequisites before
   running its scripts. A single fix usually fits `git cherry-pick -x`; use a merge
   for an explicitly requested branch integration or a dependent feature series.
   Do not cherry-pick a merge commit without first understanding its parents.
4. Create a separate branch and worktree for a new experiment. A worktree starts
   from committed files: it does not include the shared checkout's pending cleanup.
   State that limitation when it affects the test result. Never silently stash,
   stage, commit, reset, or clean another task's changes to make the base look clean.
5. Install dependencies independently with `npm ci` in the experiment when needed.
   Do not share mutable `node_modules` through hard links or symlinks with another
   worktree, especially when evaluating dependency/build changes.

Example template; replace `OWNER`, `BRANCH`, and `CHANGE` with the requested source:

```bash
git fetch https://github.com/OWNER/OmniRoute.git BRANCH
candidate_sha=$(git rev-parse FETCH_HEAD)
git worktree add -b test/CHANGE ../omniroute-test-CHANGE compression-core
git -C ../omniroute-test-CHANGE merge --no-ff --no-commit "$candidate_sha"
```

Fetches overwrite `FETCH_HEAD`, so pin the candidate SHA before fetching anything
else. The sibling worktree keeps experimental files outside the app's build tree.
Testing a candidate does not authorize merging it into the integration branch.
When commit/push is requested, complete it without redundant confirmation and push
only the intended branch to the fork; never force-push shared history by default.

## Resolving conflicts

Read the base, fork change, and incoming change before editing. Use explicit refs
and file history; do not choose an entire side just because it compiles.

```bash
git diff --name-only --diff-filter=U
git ls-files -u
git show :1:path/to/file   # merge base, when present
git show :2:path/to/file   # ours
git show :3:path/to/file   # theirs
```

During a normal merge, ours is the checked-out branch and theirs is the incoming
branch. During a rebase, ours is the rebased-onto history and theirs is the commit
being replayed. Never assume the labels mean "my fork" and "upstream" in every
operation. Modify/delete conflicts may not have all three stages.

| Conflict                                   | Resolution rule                                                                                                                                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Removed file modified upstream             | Inspect why the fork deleted it. Keep intentional deletion with `git rm -- path`; port any still-relevant fix into the surviving implementation.                                                                                                           |
| Windows/macOS code mixed with a useful fix | Port the platform-independent fix into the remaining host path and retain its regression coverage. Do not revive removed platform suites or helpers.                                                                                                       |
| Router, OAuth, translator, streaming       | Trace callers, public types/exports, and terminal/error paths. Preserve tool-call pairing, cancellation/cleanup, auth and credential handling. Test both streaming and nonstreaming when affected.                                                         |
| Database migrations                        | Read `src/lib/db/AGENTS.md` and migration-runner semantics. Preserve applied migration identity/history; handle collisions with a new compatible migration and update affected references. Verify against a disposable database, never the user's live DB. |
| `package.json` / lockfiles                 | Resolve intended dependency versions and scripts first. Retain OS restrictions and workspace definitions. Regenerate the affected npm lockfile using the repo's Node/npm settings; do not concatenate lockfile sides or update unrelated dependencies.     |
| Generated files or golden fixtures         | Resolve source inputs first and regenerate with the existing tool. Review fixture deltas; never overwrite expected output solely to make a failing implementation pass.                                                                                    |
| Tests calling removed APIs                 | Check the current implementation and history. Port assertions to the replacement behavior or remove obsolete coverage; do not restore dead APIs or weaken valid assertions just to obtain green output.                                                    |

After resolving a hunk, search every caller/import of the changed symbol with
`rg`. Include sibling routes, UI types, scripts, packaging, and tests. A merge can
be textually clean while restoring deleted behavior or losing a necessary export.
Keep auth, input validation, credential encryption, path/error redaction, and safe
argument-array process spawning intact. Never expose secrets in logs or diffs.

## Validation

Use Node 24 (`.nvmrc` / `.node-version`) and npm with the checked-in `.npmrc`.
Read the current `package.json` for available scripts; old guides mention removed
coverage/release commands. Do not recreate deleted tools merely to run old gates.

Start with the relevant regression test and affected callers. For Node tests,
load both the runtime polyfills and test database isolation:

```bash
DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 \
  --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts \
  --test --test-concurrency=4 tests/unit/CHANGED.test.ts
```

Unset any inherited `DATA_DIR` pointing to real data first: the isolation setup
preserves an explicitly supplied value. Keep provider credentials and real host
configuration out of routine tests. Run live/provider, DNS, certificate, and
process-management integration tests only against a deliberate isolated target.

| Changed surface              | Additional check when relevant                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript app/core          | `npm run typecheck:core` is a selected-file check, not whole-repo proof. Use `npm run check:dashboard-typecheck` or `npm run check:open-sse-typecheck` for those surfaces and inspect their scope. |
| Broad JS/TS integration      | `npm run test:unit:ci` (bounded concurrency, includes serial suites); `npm run lint` for lint-sensitive changes.                                                                                   |
| Vitest-owned tests           | `npm run test:vitest` or `npm run test:vitest:ui`, according to the test's configuration.                                                                                                          |
| Build/runtime/package wiring | `npm run build`; use `npm run build:cli` or `npm run electron:build:linux` when their artifacts change.                                                                                            |
| Rust workspace               | `cargo test --locked --manifest-path compression-core/Cargo.toml`.                                                                                                                                 |
| Rust/JS tokenizer parity     | `node --import tsx/esm compression-core/scripts/verify-golden.ts`; this regenerates fixtures, so inspect their diff. `--skip-generate` checks only the existing fixture baseline.                  |

Baseline warning, observed 2026-09-08: whole-tree TypeScript checking hit a syntax
error in `tests/unit/chatcore-execution-credentials.test.ts`; broader tests also
hit removed release-file references, cancelled repair tests, host-dependent CLI
detection, and Kiro test heap exhaustion. These are investigation leads, not
permanent skip rules. Reproduce failures on the chosen base before calling them
inherited. Report exact commands, failures, omissions, and whether artifacts or
live behavior were actually tested; a focused pass does not establish a green
full suite. Do not delete tests or expand suppressions to hide new failures.

## Finishing the work

- Ensure `git diff --name-only --diff-filter=U` and `git ls-files -u` are empty.
- Run `git diff --check` and review the complete result against the pinned base,
  including files Git merged automatically and intentionally retained deletions.
- Stage explicit paths or hunks. Use neither `git add -A` nor whole-tree staging.
  Keep unrelated working/staged edits out; use a separate worktree if necessary.
- Complete the active merge/cherry-pick/rebase only after the relevant checks.
  Include source provenance and important conflict decisions in the commit.
- Summarize what was imported, fork behavior preserved, validation and remaining
  failures, and the branch/commit produced. Keep an experiment reversible; do not
  remove another session's worktree or branch.
- Update this guide only for durable fork decisions, not every experiment result.
