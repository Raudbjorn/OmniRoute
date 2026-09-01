import { z } from "zod";
import { generatePKCE } from "../utils/pkce";
import { freebuffUuidSchema } from "@/shared/schemas/providers/freebuff";
import { resolveFreebuffBaseUrl } from "@/lib/providers/freebuff/base";
import { generateFreebuffFingerprint } from "../freebuff/fingerprint";
import { resolvePublicCred } from "@omniroute/open-sse/utils/publicCreds.ts";

export const FREEBUFF_OAUTH_CONFIG = {
  id: "freebuff",
  alias: "fb",
  name: "Freebuff (Codebuff Free Tier)",
  authorizeUrl: "https://www.codebuff.com/api/auth/cli/code",
  tokenUrl: "https://www.codebuff.com/api/auth/cli/status",
  logoutUrl: "https://www.codebuff.com/api/auth/cli/logout",
  meUrl: "https://www.codebuff.com/api/v1/me",
  sessionUrl: "https://www.codebuff.com/api/v1/freebuff/session",
  streakUrl: "https://www.codebuff.com/api/v1/freebuff/streak",
  clientId: resolvePublicCred("freebuff_id", "FREEBUFF_OAUTH_CLIENT_ID"),
  pollIntervalMs: 2000,
  pollTimeoutMs: 300000,
} as const;

/**
 * Returns the OAuth authorize endpoint for the current tier.
 * Honors `FREEBUFF_TIER` (defaults to `free` → freebuff.com).
 */
function resolveAuthorizeUrl(): string {
  const base = resolveFreebuffBaseUrl().replace(/\/$/, "");
  return `${base}/api/auth/cli/code`;
}

/**
 * Returns the OAuth token/status endpoint for the current tier.
 */
function resolveTokenUrl(): string {
  const base = resolveFreebuffBaseUrl().replace(/\/$/, "");
  return `${base}/api/auth/cli/status`;
}

export const freebuffTokenSchema = z.object({
  authToken: freebuffUuidSchema,
  userId: freebuffUuidSchema.optional(),
  email: z.string().email().optional(),
  /**
   * Optional fingerprint triple carried over from the legacy Freebuff CLI
   * `credentials.json` paste path. The PKCE device-code poll does not
   * expose these — when present they are propagated into the connection's
   * `providerSpecificData` so the chat dispatcher can stamp the
   * `x-codebuff-fingerprint[-hash]` headers the upstream requires.
   */
  fingerprintId: z
    .string()
    .regex(
      /^enhanced-[A-Za-z0-9_-]{43}$/,
      "fingerprintId must match /^enhanced-[A-Za-z0-9_-]{43}$/",
    )
    .optional(),
  fingerprintHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/, "fingerprintHash must be a 64-char hex sha256")
    .optional(),
});
export type FreebuffToken = z.infer<typeof freebuffTokenSchema>;

export const freebuffPollStatusSchema = z.enum([
  "pending",
  "success",
  "expired",
  "error",
]);
export type FreebuffPollStatus = z.infer<typeof freebuffPollStatusSchema>;

export const freebuffPollResponseSchema = z.object({
  status: freebuffPollStatusSchema,
  authToken: freebuffUuidSchema.optional(),
  userId: freebuffUuidSchema.optional(),
  email: z.string().email().optional(),
  error: z.string().optional(),
  /**
   * Structured upstream-error code. Set when `status === "error"` and we can
   * classify the failure (e.g. `fingerprint_mismatch` when the upstream
   * returned HTTP 401, which means the OmniRoute server's hardware
   * fingerprint does not match the user's local Codebuff CLI fingerprint).
   * The OAuthModal uses this to recommend the paste-credentials.json path
   * instead of asking the user to retry the browser PKCE flow.
   */
  errorCode: z.enum(["fingerprint_mismatch", "generic"]).optional(),
  message: z.string().optional(),
});
export type FreebuffPollResponse = z.infer<typeof freebuffPollResponseSchema>;

/**
 * Freebuff (Codebuff) OAuth Provider — PKCE polling flow.
 *
 * Auth flow:
 *   1. POST /api/auth/cli/code { fingerprintId, codeChallenge, state, clientId }
 *      → { loginUrl, fingerprintHash, expiresAt, flowId? }
 *   2. User opens loginUrl in browser → completes OAuth at codebuff.com
 *   3. GET /api/auth/cli/status?fingerprintId=...&fingerprintHash=...&expiresAt=...
 *      → { status: "pending"|"success"|"expired"|"error", authToken?, userId?, email? }
 *
 * Note: fingerprintId is derived from server-side hardware and may not match
 * the user's local CLI fingerprint. UI must surface the "paste credentials.json"
 * fallback when PKCE polling returns status "error" or auth fails.
 *
 * The provider object exposes the **standard OAuth v2 device_code** surface so
 * the shared OAuthModal and `/api/oauth/[provider]/[action]` route work without
 * special-casing Freebuff: `requestDeviceCode(config, codeChallenge, options)`
 * and `pollToken(config, deviceCode, codeVerifier, extraData, options)`.
 *
 * The polling parameters (fingerprintId / fingerprintHash / expiresAt) are
 * serialized into the `deviceCode` string returned by `requestDeviceCode` so
 * `pollToken` can decode and resume the same upstream poll loop. This matches
 * the Kiro / GitHub / Qwen pattern used by every other device_code provider.
 */

/** Options accepted by `requestDeviceCode` for testability + tracing. */
export interface FreebuffRequestDeviceCodeOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /**
   * Override the locally-derived fingerprintId. Production callers leave this
   * undefined so the server-side hardware snapshot is used. Tests inject a
   * deterministic value to avoid touching `node-machine-id` (native binding).
   */
  fingerprintIdOverride?: string;
}

/** Options accepted by `pollToken` for testability + tracing. */
export interface FreebuffPollOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

/** Wire shape returned by the upstream /api/auth/cli/code endpoint. */
export interface FreebuffDeviceCodeWireResponse {
  flowId?: string;
  loginUrl: string;
  fingerprintHash: string;
  expiresAt: number;
}

/**
 * Sleep helper that respects an AbortSignal.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Default sleep wrapper: uses the internal sleep() helper.
 */
function defaultSleepFn(ms: number): Promise<void> {
  return sleep(ms);
}

/**
 * Serialize the upstream polling parameters into the opaque `deviceCode`
 * string that the standard OAuth v2 device_code protocol hands back to the
 * client. The client echoes this value to `pollToken` verbatim, where we
 * decode it and resume the upstream polling loop.
 */
interface FreebuffDeviceCodePayload {
  fingerprintId: string;
  fingerprintHash: string;
  expiresAt: number;
}

function encodeDeviceCode(payload: FreebuffDeviceCodePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeDeviceCode(deviceCode: string): FreebuffDeviceCodePayload {
  try {
    const json = Buffer.from(deviceCode, "base64url").toString("utf8");
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof obj.fingerprintId === "string" &&
      typeof obj.fingerprintHash === "string" &&
      typeof obj.expiresAt === "number"
    ) {
      return obj as unknown as FreebuffDeviceCodePayload;
    }
  } catch {
    /* fall through */
  }
  throw new Error(
    "freebuff.pollToken: deviceCode is not a Freebuff-issued token (invalid base64url payload).",
  );
}

/**
 * Internal: POST /api/auth/cli/code with the PKCE pair + server-derived
 * fingerprintId. Returns the wire shape from the upstream. Kept as a named
 * function so it can be exercised by unit tests without going through the
 * provider-object indirection.
 */
export async function startFreebuffDeviceCode(
  config: typeof FREEBUFF_OAUTH_CONFIG,
  options: FreebuffRequestDeviceCodeOptions = {},
): Promise<FreebuffDeviceCodeWireResponse> {
  const doFetch = options.fetchImpl ?? fetch;
  const pkce = generatePKCE();
  const fingerprintId =
    options.fingerprintIdOverride ?? generateFreebuffFingerprint().fingerprintId;

  let response: Response;
  try {
    response = await doFetch(resolveAuthorizeUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        fingerprintId,
        codeChallenge: pkce.codeChallenge,
        state: pkce.state,
        clientId: config.clientId,
      }),
      signal: options.signal,
    });
  } catch (err) {
    throw new Error(
      `freebuff.startFreebuffDeviceCode: network error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `freebuff.startFreebuffDeviceCode failed: HTTP ${response.status} ${
        response.statusText
      } ${errorText}`,
    );
  }

  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (
    typeof data.loginUrl !== "string" ||
    typeof data.fingerprintHash !== "string" ||
    typeof data.expiresAt !== "number"
  ) {
    throw new Error(
      "freebuff.startFreebuffDeviceCode: response missing required fields " +
        "(loginUrl, fingerprintHash, expiresAt)",
    );
  }

  return {
    flowId: typeof data.flowId === "string" ? data.flowId : undefined,
    loginUrl: data.loginUrl,
    fingerprintHash: data.fingerprintHash,
    expiresAt: data.expiresAt,
  };
}

/**
 * Internal: poll the upstream /api/auth/cli/status endpoint until success,
 * expiry, error, or timeout. Returns the same wire shape as the upstream.
 * Exposed as a named function so unit tests can drive it without the
 * provider object indirection.
 *
 * Improvements:
 * - Progressive intervals (1s → 2s → 3s → 5s → 7s → 10s) for faster UX
 * - Jitter (±10%) to prevent thundering herd
 * - Network retry limit (max 3 attempts) for fail-fast on persistent errors
 * - Progress callback for UI feedback
 */
export async function pollFreebuffDeviceCode(
  config: typeof FREEBUFF_OAUTH_CONFIG,
  payload: FreebuffDeviceCodePayload,
  options: FreebuffPollOptions = {},
): Promise<FreebuffPollResponse> {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleepFn = options.sleepFn ?? defaultSleepFn;
  const deadline = now() + config.pollTimeoutMs;
  
  // Progressive intervals: faster initial polls for better UX
  const pollIntervals = [1000, 2000, 3000, 5000, 7000, 10000];
  const maxNetworkRetries = 3;
  
  const { fingerprintId, fingerprintHash, expiresAt } = payload;

  let attempt = 0;
  let networkErrorCount = 0;

  while (now() < deadline) {
    if (options.signal?.aborted) {
      return { status: "error", error: "aborted" };
    }

    const url = new URL(resolveTokenUrl());
    url.searchParams.set("fingerprintId", fingerprintId);
    url.searchParams.set("fingerprintHash", fingerprintHash);
    url.searchParams.set("expiresAt", String(expiresAt));

    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: options.signal,
      });
      networkErrorCount = 0; // Reset on successful fetch
    } catch (err) {
      networkErrorCount++;
      if (networkErrorCount >= maxNetworkRetries) {
        return {
          status: "error",
          error: `Network error after ${maxNetworkRetries} attempts`,
          errorCode: "network_error" as const,
        };
      }
      
      // Progressive backoff on network errors
      const intervalIndex = Math.min(attempt, pollIntervals.length - 1);
      const delay = pollIntervals[intervalIndex];
      options.onProgress?.(attempt, delay);
      await sleepFn(delay);
      attempt++;
      continue;
    }

    if (response.status === 410) {
      return { status: "expired", error: "Device code expired" };
    }
    if (response.status === 401) {
      // 401 from /api/auth/cli/status with the server-side fingerprintId
      // almost always means the OmniRoute server's hardware fingerprint
      // does not match the user's local Codebuff CLI fingerprint. Surface
      // this as a structured signal so the UI can recommend the
      // paste-credentials.json fallback instead of asking the user to
      // "try again". The structured `errorCode` is distinct from `error`
      // (which carries the upstream message verbatim) so `pollToken` can
      // branch on it without parsing strings.
      return {
        status: "error",
        error: `Authentication failed (HTTP 401)`,
        errorCode: "fingerprint_mismatch" as const,
        message: `Authentication failed (HTTP 401). The server-side hardware fingerprint does not match your local Codebuff CLI fingerprint — paste credentials.json instead.`,
      };
    }
    if (response.status === 403) {
      return {
        status: "error",
        error: `Authentication failed (HTTP 403)`,
      };
    }

    if (response.ok) {
      const raw = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const parsed = freebuffPollResponseSchema.safeParse(raw);
      if (parsed.success) {
        if (parsed.data.status !== "pending") {
          return parsed.data; // Early success - return immediately
        }
      }
    }

    // Progressive backoff with jitter to prevent thundering herd
    attempt++;
    const intervalIndex = Math.min(attempt - 1, pollIntervals.length - 1);
    const baseDelay = pollIntervals[intervalIndex];
    const jitter = baseDelay * 0.2 * (Math.random() - 0.5); // ±10% jitter
    const delay = Math.floor(baseDelay + jitter);
    
    options.onProgress?.(attempt, delay);
    await sleepFn(delay);
  }

  return { status: "expired", error: "Poll timeout exceeded" };
}

/**
 * Known placeholder `authToken` values emitted by stub / uninstalled
 * Freebuff CLI installs. We never want to treat these as a real token
 * — doing so would store a known-bad credential that the upstream
 * rejects immediately, and (worse) when pasted as JSON, the parser
 * would otherwise return the entire JSON string as the `authToken`,
 * producing the malformed `Authorization: Bearer <json>` header.
 */
const FREEBUFF_AUTH_TOKEN_PLACEHOLDERS = new Set([
  "not-a-uuid",
  "REFRESH_NEEDED",
]);

function isFreebuffAuthToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !FREEBUFF_AUTH_TOKEN_PLACEHOLDERS.has(value) &&
    freebuffUuidSchema.safeParse(value).success
  );
}

/**
 * Internal: best-effort parse of the pasted text into a FreebuffToken. Used by
 * `mapTokens` (import-token path) so the same logic can be unit-tested
 * independently from the connection-shaping concerns.
 *
 * Accepted shapes (in order):
 *
 *   1. `{"authToken": "<uuid>", "userId"?: "<uuid>", "email"?: "<email>"}`
 *      — the OmniRoute-documented shape (matches `freebuffTokenSchema`).
 *   2. `{"authToken": "not-a-uuid" (placeholder),
 *        "default": {
 *          "id": "<uuid>", "name": "...", "email": "...",
 *          "authToken": "<uuid>", "fingerprintId": "...", "fingerprintHash": "..."
 *        }}`
 *      — the legacy Freebuff CLI `~/.config/manicode/credentials.json` on
 *        disk. The real authToken + fingerprint triple live under `default`;
 *        the top-level `authToken` is a known placeholder that some
 *        installs leave behind even when `default.authToken` is valid.
 *   3. A bare UUID — the simplest paste fallback.
 *   4. Any other string — returned as `authToken` so the upstream can
 *      reject it with its own error (rather than silently storing garbage).
 */
export function parseFreebuffPastedCredentials(
  pasted: string,
): FreebuffToken {
  const trimmed = pasted?.trim() ?? "";
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;

      // Shape 1: direct FreebuffToken (top-level fields).
      const direct = freebuffTokenSchema.safeParse(obj);
      if (direct.success) return direct.data;

      // Shape 2: legacy CLI credentials.json — extract the real authToken
      // + fingerprint from `default`. Without this branch the parser
      // falls back to wrapping the entire JSON string as `authToken`,
      // which the default executor would then re-serialize into a
      // malformed `Authorization: Bearer <json>` header (bug observed in
      // v3.8.40 — see #TBD).
      if (obj.default && typeof obj.default === "object") {
        const def = obj.default as Record<string, unknown>;
        if (isFreebuffAuthToken(def.authToken)) {
          const parsed: FreebuffToken = {
            authToken: def.authToken,
            userId:
              typeof def.id === "string" &&
              freebuffUuidSchema.safeParse(def.id).success
                ? def.id
                : undefined,
            email:
              typeof def.email === "string" && def.email.length > 0
                ? def.email
                : undefined,
          };
          const fpId =
            typeof def.fingerprintId === "string" &&
            /^enhanced-[A-Za-z0-9_-]{43}$/.test(def.fingerprintId)
              ? def.fingerprintId
              : undefined;
          const fpHash =
            typeof def.fingerprintHash === "string" &&
            /^[a-f0-9]{64}$/.test(def.fingerprintHash)
              ? def.fingerprintHash
              : undefined;
          if (fpId) parsed.fingerprintId = fpId;
          if (fpHash) parsed.fingerprintHash = fpHash;
          return parsed;
        }
      }
    } catch {
      /* fall through to bare-token path */
    }
  }
  return { authToken: trimmed };
}

/**
 * Shape of the result returned by `sanitizeFreebuffAccessToken`. The fields
 * are intentionally narrow — only what is safe to overwrite on an existing
 * connection row without changing its identity (id, provider, authType, etc.).
 */
export interface FreebuffTokenRepair {
  /** The real UUID `authToken` extracted from a malformed stored value. */
  authToken: string;
  /** Carried over from `default.fingerprintId` when present. */
  fingerprintId?: string;
  /** Carried over from `default.fingerprintHash` when present. */
  fingerprintHash?: string;
  /** Carried over from `default.id` when it parses as a UUID. */
  userId?: string;
  /** Carried over from `default.email` when present. */
  email?: string;
}

/**
 * Detect and repair a malformed `accessToken` stored in a Freebuff connection
 * row.
 *
 * Background: in v3.8.40 and earlier, `parseFreebuffPastedCredentials` fell
 * through to `{ authToken: <whole JSON string> }` when `freebuffTokenSchema`
 * rejected the top-level `authToken: "not-a-uuid"` placeholder. The resulting
 * connection row stored the entire `credentials.json` blob as its
 * `accessToken`, which the default OpenAI executor then re-serialized into a
 * malformed `Authorization: Bearer { "authToken": ... }` header that
 * `Headers.append` rejected with an invalid-header-value exception (502 to
 * the client).
 *
 * v3.8.43 added Shape 2 to `parseFreebuffPastedCredentials` so new imports
 * extract the real `default.authToken` correctly. **Existing** connection
 * rows created before that fix still hold the JSON blob. This helper is the
 * single point that recognises the broken shape and returns the real UUID
 * + fingerprint triple so the caller can rewrite the row in place.
 *
 * Returns:
 *   - `null` if `raw` already looks like a valid UUID (no repair needed)
 *     OR is empty / not a string (caller cannot help)
 *   - `FreebuffTokenRepair` if `raw` looks like a Freebuff credentials blob
 *     AND a real UUID can be extracted from `default.authToken`
 *
 * Pure function — no DB / network side effects. Callers decide what to do
 * with the result (rewrite the row, log the repair, emit a warning, etc.).
 */
export function sanitizeFreebuffAccessToken(
  raw: unknown,
): FreebuffTokenRepair | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  // Fast path: already a clean UUID. Skip the JSON parse cost on the hot
  // path — the malformed-blob case is a one-time repair, not steady state.
  if (
    !raw.startsWith("{") &&
    freebuffUuidSchema.safeParse(raw).success
  ) {
    return null;
  }

  // Anything that starts with `{` might be the broken credentials.json blob
  // (Shape 2 of parseFreebuffPastedCredentials). Try to re-parse it.
  if (!raw.startsWith("{")) return null;

  const parsed = parseFreebuffPastedCredentials(raw);
  // Reject anything that didn't yield a clean UUID after re-parse — we
  // refuse to write a malformed token back to the DB.
  if (!freebuffUuidSchema.safeParse(parsed.authToken).success) return null;

  const repair: FreebuffTokenRepair = { authToken: parsed.authToken };
  if (parsed.userId) repair.userId = parsed.userId;
  if (parsed.email) repair.email = parsed.email;
  if (parsed.fingerprintId) repair.fingerprintId = parsed.fingerprintId;
  if (parsed.fingerprintHash) repair.fingerprintHash = parsed.fingerprintHash;
  return repair;
}

/**
 * Connection-row shape accepted by `repairFreebuffConnectionRow`. Intentionally
 * a structural subset of the full row — we only need the fields the repair
 * touches so callers can pass either a raw DB row or a normalized shape.
 */
export interface FreebuffRepairableConnectionRow {
  accessToken: unknown;
  providerSpecificData?: Record<string, unknown> | null;
}

/**
 * Apply `sanitizeFreebuffAccessToken` to a connection row and return the
 * updated fields. Returns `null` when the row is already clean (no repair
 * needed) so callers can branch on the result without diffing the input.
 *
 * The returned partial only contains the fields that changed. Callers are
 * responsible for the actual DB write (`updateProviderConnection` or
 * equivalent). The function does NOT bump `tokenExpiresAt` — the upstream
 * has no refresh endpoint and the user will need to re-auth when the
 * existing token expires anyway.
 *
 * Example (one-time repair script):
 *
 *   const rows = await getProviderConnections({ provider: "freebuff" });
 *   for (const row of rows) {
 *     const repair = repairFreebuffConnectionRow(row);
 *     if (repair) {
 *       console.warn(`repairing freebuff connection ${row.id}`);
 *       await updateProviderConnection(row.id, repair);
 *     }
 *   }
 */
export function repairFreebuffConnectionRow(
  row: FreebuffRepairableConnectionRow,
): Partial<FreebuffRepairableConnectionRow> | null {
  const repair = sanitizeFreebuffAccessToken(row.accessToken);
  if (!repair) return null;

  const updates: Partial<FreebuffRepairableConnectionRow> = {
    accessToken: repair.authToken,
  };

  // Merge fingerprint triple + userId / email into providerSpecificData.
  // We do NOT clobber existing fields the caller may have set — we only
  // fill in the keys we know about. This preserves any future extension
  // (instanceId, loginCompletedAt, etc.) that may already live in the row.
  const existing =
    row.providerSpecificData && typeof row.providerSpecificData === "object"
      ? row.providerSpecificData
      : {};
  const merged: Record<string, unknown> = { ...existing };
  if (repair.fingerprintId) merged.fingerprintId = repair.fingerprintId;
  if (repair.fingerprintHash) merged.fingerprintHash = repair.fingerprintHash;
  if (repair.userId) merged.userId = repair.userId;
  if (repair.email) merged.userEmail = repair.email;
  if (Object.keys(merged).length > 0) {
    updates.providerSpecificData = merged;
  }

  return updates;
}

export const freebuff = {
  config: FREEBUFF_OAUTH_CONFIG,
  /**
   * Freebuff participates in the standard OAuth v2 device_code protocol so the
   * shared `OAuthModal` and `/api/oauth/[provider]/[action]` route drive it
   * without special-casing. The paste-credentials.json fallback is exposed as
   * a second auth method via `FreebuffOAuthWrapper` (import-token path).
   */
  flowType: "device_code" as const,

  /**
   * Not supported: freebuff uses device-code polling, not redirect-based
   * authorization_code. Callers that want a browser OAuth flow should use
   * `requestDeviceCode` instead.
   */
  buildAuthUrl: (): string => {
    throw new Error(
      "freebuff.buildAuthUrl: not supported. Freebuff uses device_code; " +
        "call requestDeviceCode(config, codeChallenge) to start the flow.",
    );
  },

  /**
   * Standard OAuth v2 device_code surface — called by the shared
   * `/api/oauth/[provider]/device-code` route via the `requestDeviceCode`
   * wrapper in `lib/oauth/providers.ts`.
   *
   * The upstream polling parameters (`fingerprintId` / `fingerprintHash` /
   * `expiresAt`) are base64url-encoded into the returned `device_code` so the
   * client can echo them back verbatim to `pollToken`.
   */
  requestDeviceCode: async (
    config: typeof FREEBUFF_OAUTH_CONFIG,
    _codeChallenge: string,
    options: FreebuffRequestDeviceCodeOptions = {},
  ) => {
    const wire = await startFreebuffDeviceCode(config, options);
    const payload: FreebuffDeviceCodePayload = {
      fingerprintId:
        options.fingerprintIdOverride ?? generateFreebuffFingerprint().fingerprintId,
      fingerprintHash: wire.fingerprintHash,
      expiresAt: wire.expiresAt,
    };
    return {
      device_code: encodeDeviceCode(payload),
      user_code: "",
      verification_uri: wire.loginUrl,
      verification_uri_complete: wire.loginUrl,
      interval: Math.max(1, Math.ceil(config.pollIntervalMs / 1000)),
      expires_in: Math.max(1, Math.ceil((wire.expiresAt - Date.now()) / 1000)),
    };
  },

  /**
   * Standard OAuth v2 device_code polling — called by the shared
   * `/api/oauth/[provider]/poll` route via the `pollForToken` wrapper.
   *
   * Decodes the `deviceCode` we minted in `requestDeviceCode` and translates
   * the upstream Freebuff poll status into the standard OAuth error codes
   * (`authorization_pending`, `expired_token`, `access_denied`).
   */
  pollToken: async (
    config: typeof FREEBUFF_OAUTH_CONFIG,
    deviceCode: string,
    _codeVerifier: string | null,
    _extraData: unknown,
    options: FreebuffPollOptions = {},
  ) => {
    const payload = decodeDeviceCode(deviceCode);
    const result = await pollFreebuffDeviceCode(config, payload, options);

    if (result.status === "success") {
      return {
        ok: true as const,
        data: {
          access_token: result.authToken,
          user_id: result.userId,
          email: result.email,
        },
      };
    }
    if (result.status === "pending") {
      return {
        ok: true as const,
        data: { error: "authorization_pending" as const },
      };
    }
    if (result.status === "expired") {
      return {
        ok: true as const,
        data: {
          error: "expired_token" as const,
          error_description: result.error ?? "Device code expired",
        },
      };
    }
    // status === "error"
    // `fingerprint_mismatch` is special-cased so the UI can offer a
    // "Switch to paste credentials.json" CTA instead of "try again".
    // Any other `error` status is bubbled up as a generic access_denied
    // with the upstream message preserved verbatim.
    if (result.errorCode === "fingerprint_mismatch") {
      return {
        ok: true as const,
        data: {
          error: "access_denied" as const,
          error_description:
            result.message ?? "Hardware fingerprint mismatch with Codebuff upstream.",
          error_code: "fingerprint_mismatch" as const,
          recommended_action: "use_import_token" as const,
        },
      };
    }
    return {
      ok: true as const,
      data: {
        error: "access_denied" as const,
        error_description: result.message ?? result.error ?? "Authentication failed",
      },
    };
  },

  /**
   * Map a Freebuff upstream token bundle onto a connection record.
   *
   * The shared route calls this in two places:
   *
   *   1. `/api/oauth/[provider]/import-token` — input shape is
   *      `{ accessToken: <pasted text> }`. The pasted text can be:
   *        - a JSON object matching `freebuffTokenSchema`
   *          (`{ authToken, userId?, email? }`) — the credentials.json path
   *        - a bare UUID — the simplest paste fallback
   *   2. `/api/oauth/[provider]/poll` (success path) — input shape is
   *      `{ access_token, user_id?, email? }` produced by our
   *      `pollToken` adapter above.
   *
   * Returns connection-shaped data (`accessToken`, `refreshToken`,
   * `expiresIn`, `providerSpecificData`, etc.) so the shared
   * `createProviderConnection` / `updateProviderConnection` can spread it
   * into the DB row.
   */
  mapTokens: (input: Record<string, unknown>) => {
    let authToken: string;
    let userId: string | undefined;
    let email: string | undefined;
    let authMethod: "freebuff-import" | "freebuff-oauth";
    let fingerprintId: string | undefined;
    let fingerprintHash: string | undefined;

    if (typeof input?.accessToken === "string") {
      // Path 1: import-token route — pasted text or credentials.json
      const parsed = parseFreebuffPastedCredentials(input.accessToken);
      authToken = parsed.authToken;
      userId = parsed.userId;
      email = parsed.email;
      fingerprintId = parsed.fingerprintId;
      fingerprintHash = parsed.fingerprintHash;
      authMethod = "freebuff-import";
    } else if (typeof input?.access_token === "string") {
      // Path 2: device-code poll success — upstream OAuth bundle
      authToken = input.access_token;
      userId = typeof input.user_id === "string" ? input.user_id : undefined;
      email = typeof input.email === "string" ? input.email : undefined;
      authMethod = "freebuff-oauth";
    } else {
      throw new Error(
        "freebuff.mapTokens: unrecognized input shape " +
          "(expected { accessToken } for import-token or { access_token } for device-code poll).",
      );
    }

    return {
      accessToken: authToken,
      refreshToken: null,
      expiresIn: null,
      name: email ?? null,
      email: email ?? null,
      /**
       * Freebuff tokens have a hard 1-hour TTL (C6 in
       * `validation-scripts/final-validations.md`). The upstream has no
       * refresh endpoint, so we stamp the expiry here and let the
       * dashboard warn the user ~5 min before it elapses. Stored both
       * at the top level (consumed by `freebuffConnectionSchema`) and
       * inside `providerSpecificData` (consumed by the generic
       * `createProviderConnection` spread) so it survives whichever
       * storage path the route takes.
       */
      tokenExpiresAt: Date.now() + 60 * 60 * 1000,
      providerSpecificData: {
        ...(userId ? { userId } : {}),
        ...(fingerprintId ? { fingerprintId } : {}),
        ...(fingerprintHash ? { fingerprintHash } : {}),
        authMethod,
        tokenExpiresAt: Date.now() + 60 * 60 * 1000,
      },
    };
  },
};
