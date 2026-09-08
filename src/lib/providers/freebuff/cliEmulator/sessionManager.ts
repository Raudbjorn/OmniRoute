/**
 * Freebuff CLI Emulator — Session Manager
 *
 * Manages the lifecycle of a Freebuff queue seat:
 *
 *   1. `POST /api/v1/freebuff/session` — acquire a seat for a model
 *   2. `DELETE /api/v1/freebuff/session` — release the seat
 *
 * The upstream enforces "1 chat seat per token" — a second claim
 * while a seat is active returns 409 Conflict with `model_locked`.
 * The session manager handles this transparently by releasing the
 * stale seat before retrying.
 *
 * @module lib/providers/freebuff/cliEmulator/sessionManager
 */

import { z } from "zod";
import type {
  FreebuffHttpClient,
  FreebuffRateLimit,
  FreebuffSession,
  FreebuffSessionManager,
} from "./types.ts";
import {
  FreebuffCountryBlockedError,
  FreebuffModelLockedError,
  FreebuffSessionError,
} from "./types.ts";

/**
 * Zod schema for the upstream session response. Mirrors the wire
 * format exactly — note that `recentCount` is a float (e.g. 2.1),
 * not an integer.
 */
const freebuffRateLimitSchema = z.object({
  model: z.string(),
  limit: z.number().nonnegative(),
  period: z.enum(["pacific_day", "pacific_week"]),
  resetTimeZone: z.string(),
  resetAt: z.string().datetime(),
  windowHours: z.number().nonnegative().optional(),
  recentCount: z.number().nonnegative(),
});

const freebuffSessionResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("active"),
    instanceId: z.string().uuid(),
    model: z.string(),
    admittedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    remainingMs: z.number().nonnegative(),
    accessTier: z.enum(["full", "limited"]),
    countryCode: z.string().optional(),
    countryBlockReason: z.string().optional(),
    rateLimit: freebuffRateLimitSchema.optional(),
    rateLimitsByModel: z.record(z.string(), freebuffRateLimitSchema).optional(),
  }),
  z.object({
    status: z.literal("waiting"),
    position: z.number().int().positive(),
    estimatedWaitMs: z.number().nonnegative().optional(),
  }),
  z.object({
    status: z.literal("ended"),
  }),
]);

/**
 * Default base URL for the Freebuff upstream.
 */
export const FREEBUFF_BASE_URL = "https://www.codebuff.com";

/**
 * Resolve the session endpoint URL.
 */
export function sessionEndpoint(baseUrl: string = FREEBUFF_BASE_URL): string {
  return `${baseUrl.replace(/\/$/, "")}/api/v1/freebuff/session`;
}

/**
 * Create a new session manager backed by the given HTTP client.
 */
export function createSessionManager(
  httpClient: FreebuffHttpClient,
  baseUrl: string = FREEBUFF_BASE_URL,
): FreebuffSessionManager {
  return {
    async claim({ authToken, modelId, signal }) {
      const response = await httpClient.fetch({
        url: sessionEndpoint(baseUrl),
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "user-agent": "ai-sdk/openai-compatible/1.0.0/codebuff",
          "x-freebuff-model": modelId,
        },
        body: JSON.stringify({ modelId }),
        ...(signal ? { signal } : {}),
      });

      const body = await response.json().catch(() => null);

      // Handle 403 country-blocked
      if (response.status === 403 && body?.countryBlockReason === "country_not_allowed") {
        throw new FreebuffCountryBlockedError(
          `Country ${body.countryCode ?? "unknown"} is not allowed for free mode`,
          body.countryCode,
        );
      }

      // Handle 409 conflict (model locked)
      if (response.status === 409) {
        throw new FreebuffModelLockedError(
          body?.error?.message ?? "Model is locked — another session is active",
        );
      }

      // Handle other non-OK responses
      if (!response.ok) {
        throw new FreebuffSessionError(
          body?.error?.message ?? `HTTP ${response.status} from ${sessionEndpoint(baseUrl)}`,
          response.status,
          JSON.stringify(body),
        );
      }

      const parsed = freebuffSessionResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new FreebuffSessionError(
          `Invalid session response: ${parsed.error.message}`,
          response.status,
          JSON.stringify(body),
        );
      }

      if (parsed.data.status === "waiting") {
        throw new FreebuffSessionError(
          `Waiting room position: ${parsed.data.position}`,
          503,
          JSON.stringify(body),
        );
      }

      if (parsed.data.status === "ended") {
        throw new FreebuffSessionError(
          "Session ended unexpectedly",
          500,
          JSON.stringify(body),
        );
      }

      return parsed.data as FreebuffSession;
    },

    async release({ authToken, instanceId, signal }) {
      const response = await httpClient.fetch({
        url: sessionEndpoint(baseUrl),
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "user-agent": "ai-sdk/openai-compatible/1.0.0/codebuff",
          "x-freebuff-instance-id": instanceId,
        },
        ...(signal ? { signal } : {}),
      });

      if (!response.ok && response.status !== 204) {
        // Best-effort release — log but don't throw.
        const text = await response.text().catch(() => "");
        console.warn(
          `[freebuff.emulator] Failed to release session ${instanceId}: HTTP ${response.status} ${text}`,
        );
      }
    },
  };
}

/**
 * Re-export the rate-limit type for convenience.
 */
export type { FreebuffRateLimit };
