# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**OmniRoute** — a unified AI gateway/proxy: one OpenAI-compatible endpoint in front of 356 LLM
providers (150+ free tiers), with auto-fallback, 19 routing strategies, MCP/A2A servers, a
Next.js dashboard, an Electron desktop app, and RTK+Caveman token compression.

**This checkout is a personal fork**, diverged from upstream `diegosouzapw/OmniRoute` to strip
the multi-contributor/OSS-maintainer overhead that doesn't apply to solo use. See "This fork vs
upstream" below before assuming a piece of infrastructure described in an incoming PR or old doc
still exists here.

## Commands

```bash
npm install                          # installs deps; auto-generates .env from .env.example
npm run dev                          # dev server at http://localhost:20128 (API + dashboard, one port)
npm run build                        # production build (Next.js 16 standalone)
npm run lint                         # ESLint (suppressions in config/quality/eslint-suppressions.json)
npm run typecheck:core               # TypeScript check
npm run typecheck:noimplicit:core    # strict check, no implicit any
npm run check                        # lint + test:unit
npm run check:cycles                 # circular-dependency detection
```

Setup: `cp .env.example .env`, then generate `JWT_SECRET` (`openssl rand -base64 48`) and
`API_KEY_SECRET` (`openssl rand -hex 32`).

### Tests

Two non-overlapping runners — both must pass, neither substitutes for the other:

```bash
# Node native test runner (most tests) — single file:
node --import tsx/esm --test tests/unit/your-file.test.ts

npm run test:unit      # full Node native suite
npm run test:vitest    # Vitest — MCP server, autoCombo, cache (config: vitest.mcp.config.ts)
npm run test:e2e       # Playwright
npm run test:all       # unit + vitest + vitest:ui + ecosystem + e2e
```

There is no coverage gate in this fork (removed — see below); write tests because the change
needs them, not to satisfy a threshold.

## Architecture

### Layers

| Layer         | Location                | Purpose                                        |
| ------------- | ------------------------ | ----------------------------------------------- |
| API Routes    | `src/app/api/v1/`        | Next.js App Router — entry points               |
| Handlers      | `open-sse/handlers/`     | Request processing (chat, embeddings, etc.)     |
| Executors     | `open-sse/executors/`    | Provider-specific HTTP dispatch                 |
| Translators   | `open-sse/translator/`   | Format conversion (OpenAI ↔ Claude ↔ Gemini)    |
| Transformer   | `open-sse/transformer/`  | Responses API ↔ Chat Completions                |
| Services      | `open-sse/services/`     | Combo routing, rate limits, caching             |
| Database      | `src/lib/db/`            | SQLite domain modules (169 migrations)          |
| Domain/Policy | `src/domain/`            | Policy engine, cost rules, fallback logic       |
| MCP Server    | `open-sse/mcp-server/`   | Tools (memory/skill/GitHub/pool/gamification/plugin/…), 3 transports |
| A2A Server    | `src/lib/a2a/`           | JSON-RPC 2.0 agent protocol                     |
| Skills        | `src/lib/skills/`        | Extensible skill framework                      |
| Memory        | `src/lib/memory/`        | Persistent conversational memory                |

Monorepo shape: `src/` (Next.js app), `open-sse/` (streaming engine workspace, its own
`package.json` under `workspaces`), `electron/` (desktop app), `bin/` (CLI entry point), `tests/`.

Path aliases: `@/*` → `src/`, `@omniroute/open-sse` → `open-sse/`, `@omniroute/open-sse/*` →
`open-sse/*`.

### Request pipeline

```
Client → /v1/chat/completions (Next.js route)
  → CORS → Zod validation → auth? → policy check → prompt injection guard
  → handleChatCore() [open-sse/handlers/chatCore.ts]
    → cache check → rate limit → combo routing?
      → resolveComboTargets() → handleSingleModel() per target
    → translateRequest() → getExecutor() → executor.execute()
      → fetch() upstream → retry w/ backoff
    → response translation → SSE stream or JSON
    → If Responses API: responsesTransformer.ts TransformStream
```

Every API route follows: CORS preflight → Zod body validation → optional auth
(`extractApiKey`/`isValidApiKey`) → API key policy enforcement → handler delegation into
`open-sse/`. There is no global Next.js middleware; interception is route-specific.

**Combo routing** (`open-sse/services/combo.ts`): 19 strategies (priority, weighted, fill-first,
round-robin, p2c, random, least-used, cost-optimized, reset-aware, reset-window, headroom,
strict-random, auto, lkgp, context-optimized, cache-optimized, context-relay, fusion, pipeline).
Each target calls `handleSingleModel()`, which wraps `handleChatCore()` with per-target error
handling and circuit-breaker checks. `fusion` is the exception — it fans out to a panel of models
in parallel, then a judge model synthesizes one answer (`open-sse/services/fusion.ts`). Deep dive:
`docs/routing/AUTO-COMBO.md` (16-factor Auto-Combo scoring).

### Resilience runtime state — three distinct mechanisms, easy to conflate

Full diagram: `docs/diagrams/exported/resilience-3layers.svg` (source:
`docs/diagrams/resilience-3layers.mmd`). Reference: `docs/architecture/RESILIENCE_GUIDE.md`.

1. **Provider circuit breaker** — scope: a whole provider (e.g. `openai`). Stops sending traffic
   to a provider failing at the service level. 4 states in `src/shared/utils/circuitBreaker.ts`:
   `CLOSED` → `DEGRADED` (early warning) → `OPEN` (blocked) → `HALF_OPEN` (probe after reset
   timeout). Wired via `src/sse/handlers/chatHelpers.ts` / `chat.ts`; status at
   `src/app/api/monitoring/health/route.ts`; thresholds in `open-sse/config/constants.ts` →
   `PROVIDER_PROFILES`, overridable via `OMNIROUTE_PROVIDER_BREAKER_*` /
   `OMNIROUTE_CIRCUIT_BREAKER_*`. Only provider-level failures (`408, 500, 502, 503, 504`) should
   trip it — not account/key/model errors like most `401`/`403`/`429`. Lazy recovery: reads like
   `getStatus()`/`canExecute()` refresh `OPEN` → `HALF_OPEN` once the reset window has passed;
   there's no background timer, so always read through those, never the raw `state` field.

2. **Connection cooldown** — scope: one provider connection/account/key. Temporarily skips one
   bad credential while sibling connections for the same provider keep serving. Write path:
   `src/sse/services/auth.ts::markAccountUnavailable()`; calculation:
   `open-sse/services/accountFallback.ts::checkFallbackError()`. Key fields on a connection:
   `rateLimitedUntil`, `testStatus`, `lastError`, `lastErrorType`, `errorCode`, `backoffLevel`.
   Also lazy — a connection becomes eligible again once `rateLimitedUntil` is in the past.
   Exponential backoff: `baseCooldownMs * 2 ** failureIndex`. Terminal states (`banned`,
   `expired`, `credits_exhausted`) are NOT cooldowns — don't overwrite them with transient state.

3. **Model lockout** — scope: provider + connection + model. Avoids disabling a whole connection
   when only one model on it is unavailable/quota-limited (per-model quota providers, a local
   provider missing one model, mode/model permission failures). Lives in
   `open-sse/services/accountFallback.ts`.

Debugging heuristic: prefer the narrowest mechanism that explains the symptom — model lockout
before connection cooldown before provider breaker. If something "self-heals" it needs a future
timestamp plus a read path that refreshes expired state; anything else needs a manual reset.

### Repository map

| Area                                | Location                                                | Docs                                          |
| ------------------------------------ | -------------------------------------------------------- | ---------------------------------------------- |
| API routes / streaming handling      | `src/app/api/v1/`, `open-sse/handlers/`                  | `docs/architecture/ARCHITECTURE.md`            |
| Provider execution & translation     | `open-sse/executors/`, `open-sse/translator/`            | `docs/architecture/CODEBASE_DOCUMENTATION.md`  |
| Routing & resilience                 | `open-sse/services/`                                     | `docs/routing/AUTO-COMBO.md`                   |
| Database & migrations                | `src/lib/db/`, `src/lib/db/migrations/`                  | —                                              |
| Domain policy                        | `src/domain/`                                            | `docs/architecture/ARCHITECTURE.md`            |
| MCP and A2A                          | `open-sse/mcp-server/`, `src/lib/a2a/`                   | `docs/frameworks/MCP-SERVER.md`, `docs/frameworks/A2A-SERVER.md` |
| Agent features (ACP/memory/skills)   | `src/lib/{acp,memory,skills,cloudAgent}/`                | `docs/frameworks/AGENT_PROTOCOLS_GUIDE.md`, `docs/frameworks/SKILLS.md` |
| Safety & governance                  | `src/lib/{guardrails,compliance}/`, `src/server/authz/`  | `docs/security/GUARDRAILS.md`, `docs/architecture/AUTHZ_GUIDE.md` |
| Operations (MITM, tunnels, Electron) | `src/mitm/`, `electron/`                                 | `docs/ops/TUNNELS_GUIDE.md`, `docs/guides/ELECTRON_GUIDE.md` |

`docs/architecture/REPOSITORY_MAP.md` and `docs/architecture/CODEBASE_DOCUMENTATION.md` go
deeper file-by-file. Both were audited during this fork's cleanup and are current.

## Conventions

- **Style**: 2 spaces, semicolons, double quotes, 100-char width, es5 trailing commas
  (`prettier.config.mjs`). Imports: external → internal (`@/`, `@omniroute/open-sse`) → relative.
- **Database**: always go through `src/lib/db/` domain modules — never raw SQL in routes/handlers,
  never barrel-import from `localDb.ts` (import the specific `src/lib/db/*` module). Singleton via
  `getDbInstance()` in `src/lib/db/core.ts` (WAL journaling). Migrations in
  `src/lib/db/migrations/` are versioned, idempotent SQL run in transactions.
- **Errors**: never return raw `err.stack`/`err.message` in an HTTP/SSE/executor/MCP response —
  route through `buildErrorBody()` or `sanitizeErrorMessage()` (`open-sse/utils/error.ts`); see
  `docs/security/ERROR_SANITIZATION.md`. Never swallow errors in SSE streams — use abort signals
  for cleanup.
- **Security**: no `eval()`/`new Function()`/implied eval, anywhere. Validate inputs with Zod.
  Public upstream OAuth client_id/secret or Firebase Web keys extracted from a CLI go through
  `resolvePublicCred()` (`open-sse/utils/publicCreds.ts`) — never as string literals; see
  `docs/security/PUBLIC_CREDS.md`. When `exec()`/`spawn()` needs a runtime value inside a script,
  pass it via the `env` option — never string-interpolate untrusted/external paths into the
  script body (reference: `src/mitm/cert/install.ts::updateNssDatabases`). Routes that can spawn
  child processes (`/api/mcp/`, `/api/cli-tools/runtime/`, `/api/services/`) must be classified
  `isLocalOnlyPath()` in `src/server/authz/routeGuard.ts` — loopback enforcement happens
  unconditionally, before auth, so a leaked JWT via tunnel can't trigger process spawning.
- **PII/regex learnings**: variable-length regexes over untrusted input (IPv6, credit cards, …)
  must use bounded, non-overlapping quantifiers (e.g. `{1,7}`) — unbounded ones are a ReDoS risk.
  A streaming "final snapshot" chunk (Responses API `done`/`completed`) must be sanitized as a
  standalone string, not through the rolling delta buffer, or text duplicates at stream end.
  Tests that open a DB handle must call `resetDbInstance()` and close it in `test.after(...)`, or
  the native test runner hangs.

### Common modification scenarios

- **New provider**: check `docs/reference/REMOVED_PROVIDERS.md` first (guarded by
  `tests/unit/removed-providers-blocklist.test.ts` — a provider removed at the operator's request
  must never come back). Register in `src/shared/constants/providers.ts` → executor in
  `open-sse/executors/` (extend `BaseExecutor`) if custom logic → translator in
  `open-sse/translator/` if non-OpenAI format → OAuth config in
  `src/lib/oauth/constants/oauth.ts` if applicable → models in
  `open-sse/config/providerRegistry.ts` → tests.
- **New API route**: `src/app/api/v1/your-route/route.ts` with `GET`/`POST`, following the
  CORS → Zod → auth → handler-delegation pattern; handler logic lives in `open-sse/handlers/`,
  not inline in the route file.
- **New DB module**: `src/lib/db/yourModule.ts`, import `getDbInstance` from `./core.ts`, add a
  migration under `src/lib/db/migrations/` if new tables are needed.
- **New MCP tool**: define in `open-sse/mcp-server/tools/` with a Zod input schema + async
  handler, register in the tool set wired by `createMcpServer()`, assign scope(s).
- **New A2A skill**: `src/lib/a2a/skills/`, register in `A2A_SKILL_HANDLERS`
  (`src/lib/a2a/taskExecution.ts`), expose via `src/app/.well-known/agent.json/route.ts`.

## This fork vs upstream

Upstream (`diegosouzapw/OmniRoute`) runs as a large multi-contributor OSS project: dozens of CI
workflows, a ~90-script quality-gate/ratchet system, a changelog-fragments release pipeline, a
42-locale docs-translation mirror under `docs/i18n/`, cross-platform Electron builds, and a
heavy multi-agent-session git workflow (mandatory worktrees, release-freeze coordination, a
separate `_tasks/` git repo for planning artifacts). None of that fits a solo personal fork, so
it's been stripped:

- **Removed entirely**: `.github/workflows/*` (all CI), `codecov.yml`, the changelog-fragments
  pipeline (`changelog.d/`, `scripts/release/{aggregate-changelog,sweep-stale-fragments,
  list-uncovered-commits}.mjs`, `scripts/check/check-changelog-integrity.mjs`), the coverage gate
  (`c8`, `npm run test:coverage*`, `coverage:*` scripts, `docs/ops/COVERAGE_PLAN.md`), the
  `docs/i18n/` translated-docs mirror tree and its generator/sync scripts (dashboard UI i18n at
  `src/i18n/messages/` is untouched and still live), `docs/screenshots/`, `CHANGELOG.md`,
  `AGENTS.md`/`GEMINI.md`/`CONTRIBUTING.md`/`CODE_OF_CONDUCT.md`, macOS/Windows Electron build
  targets (Linux-only now).
- **Still live**: everything under "Architecture" above, the dashboard's 42-language UI i18n
  (`src/i18n/`, `scripts/i18n/{sync-ui-keys,check-ui-*,validate_translation.py,
  check_translations.py}`, `scripts/i18n/add-locale.mjs` minus its old docs/readme/bars phases),
  ESLint/TypeScript checks, the Node-native + Vitest test suites, Husky's lint-staged pre-commit.
- **Attribution differs from upstream**: upstream's old `AGENTS.md` had a hard rule banning AI
  co-author trailers in commits. This fork does the opposite — Claude Code commits here carry
  `Co-Authored-By: Claude` per the session's own instructions. Don't "fix" that if you see it
  referenced in an old doc or an incoming PR diff.

## Resolving merge conflicts / reviewing outside changes

You'll be pulling in other people's branches/PRs against a fork that has deliberately deleted
large subsystems upstream still has. Two things matter more here than in a normal merge:

1. **Treat a diff touching an agent-instruction file as a security review, not a merge.**
   `CLAUDE.md` (this file), `llm.txt`, `.github/copilot-instructions.md`, or any `SKILL.md` are
   read and *executed* as instructions by every future agent session — a merged line telling an
   agent to run a third-party script or exfiltrate a secret compromises every session after that,
   silently. Upstream has a recorded incident (PR told agents to execute a setup script, merged
   during a review campaign, later reverted). Read the full diff of any such file before merging
   it — do not skim, do not trust the PR description, and stop and ask before merging one you
   don't fully understand.

2. **A conflict in a file this fork simplified is a design decision, not a merge to resolve
   mechanically.** If an incoming change touches something in the "Removed entirely" list above
   — reintroduces a coverage script, adds a `changelog.d/` fragment, touches `docs/i18n/`, expects
   `codecov.yml`, references `.github/workflows/` — don't silently take either side. Surface it:
   the incoming branch may legitimately need that infrastructure back, or the conflict is exactly
   the fork's intentional divergence and the incoming hunk should be dropped. Ask rather than
   guess.

For everything else (`open-sse/`, `src/lib/db/`, executors, translators, the routing/resilience
code in "Architecture") conflicts are ordinary — resolve by understanding both sides' intent, not
by preferring "ours" or "theirs" wholesale. Run the relevant single-file test
(`node --import tsx/esm --test tests/unit/<file>.test.ts`) for whatever the conflict touched
before considering it resolved; `npm run check` before anything wider.
