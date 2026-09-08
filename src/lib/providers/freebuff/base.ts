/**
 * Freebuff (Codebuff) provider base constants and configuration.
 *
 * The provider targets https://www.codebuff.com for both the paid tier and
 * the free tier. The free waiting room + quotas are enforced server-side.
 *
 * @module lib/providers/freebuff/base
 */

import { homedir } from "node:os";

/** Codebuff (paid) base URL. */
export const FREEBUFF_CODEBUFF_BASE_URL = "https://www.codebuff.com";

/** Freebuff (free) base URL. The free-tier API is served from the Codebuff
 *  domain; freebuff.com is the marketing site and does not expose the API. */
export const FREEBUFF_FREEBUFF_BASE_URL = "https://www.codebuff.com";

/** Env var to switch between free and paid tier (default: free). */
export const FREEBUFF_TIER_ENV = "FREEBUFF_TIER";

/** Env var to opt-in to the provider (default: off). */
export const FREEBUFF_ENABLED_ENV = "FREEBUFF_ENABLED";

/** Env var for the credentials.json path used by the paste fallback. */
export const FREEBUFF_CREDENTIALS_PATH_ENV = "FREEBUFF_CREDENTIALS_PATH";

/** Default credentials.json path (the manicode config dir). */
export const FREEBUFF_DEFAULT_CREDENTIALS_PATH =
  "~/.config/manicode/credentials.json";

/** Anthropic-compatible endpoint is not exposed separately by Codebuff.
 *  The chat-completions endpoint handles both OpenAI and Anthropic-shaped
 *  requests, so this path is kept as an alias for backwards compatibility. */
export const FREEBUFF_ANTHROPIC_PATH = "/api/v1/chat/completions";

/** OpenAI-compatible chat-completions path exposed by Codebuff/Freebuff. */
export const FREEBUFF_OPENAI_PATH = "/api/v1/chat/completions";

/**
 * `agent-runs` handshake path. The chat-completions endpoint rejects
 * every request whose `runId` has not been previously registered via
 * `POST /api/v1/agent-runs {action:"START"}` (returns HTTP 400 with
 * `No runId found in request body` or `runId Not Found: <uuid>`).
 *
 * Source: `~/.config/manicode/freebuff-model-tests/phase4-deliverables/
 * 00-PROTOCOL-SPEC.md` §3.4 / `chat-v4.py` capture (2026-07-03).
 */
export const FREEBUFF_AGENT_RUNS_PATH = "/api/v1/agent-runs";

/** Default API base URL for Freebuff/Codebuff requests. Overridable via
 *  the `FREEBUFF_API_BASE` env var. */
export const FREEBUFF_DEFAULT_API_BASE = "https://www.codebuff.com";

/** Default path to the credentials.json that holds the Freebuff authToken. */
export const FREEBUFF_DEFAULT_CREDENTIALS_PATH_VALUE =
  "~/.config/manicode/credentials.json";

/**
 * Resolve the API base URL based on FREEBUFF_TIER env var.
 *
 *   "free" (default)  → https://www.codebuff.com
 *   "codebuff"        → https://www.codebuff.com
 */
export function resolveFreebuffBaseUrl(): string {
  const tier = process.env[FREEBUFF_TIER_ENV];
  if (tier === "codebuff" || tier === "paid") return FREEBUFF_CODEBUFF_BASE_URL;
  return FREEBUFF_FREEBUFF_BASE_URL;
}

/**
 * Returns whether the Freebuff (Codebuff) provider is enabled.
 *
 * Provider is ON by default — no opt-in required. Set
 * `FREEBUFF_ENABLED=0` (or `=false`) to explicitly disable it
 * (e.g. on hosts where Codebuff's ToS is not acceptable).
 */
export function isFreebuffEnabled(): boolean {
  const v = process.env[FREEBUFF_ENABLED_ENV];
  if (v === undefined || v === "") return true;
  return v !== "0" && v.toLowerCase() !== "false";
}

/**
 * Resolve the credentials.json path. Supports `~` expansion (basic,
 * only for the literal "~/" or "~" prefix).
 */
export function resolveFreebuffCredentialsPath(): string {
  const raw =
    process.env[FREEBUFF_CREDENTIALS_PATH_ENV] ??
    FREEBUFF_DEFAULT_CREDENTIALS_PATH_VALUE;
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) {
    return homedir() + raw.slice(1);
  }
  return raw;
}
