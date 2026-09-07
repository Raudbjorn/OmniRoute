/**
 * Freebuff CLI Emulator — Agent Run Manager
 *
 * Manages the lifecycle of a Codebuff agent run:
 *
 *   1. `POST /api/v1/agent-runs` with `{ action: "START" }` → runId
 *   2. ... chat completion with the runId stamped on every event ...
 *   3. `POST /api/v1/agent-runs` with `{ action: "FINISH" }` → close
 *
 * The runId is the canonical correlation id used by the upstream to
 * link chat completion requests, SSE events, and analytics.
 *
 * @module lib/providers/freebuff/cliEmulator/agentRunner
 */

import { z } from "zod";
import type {
  FreebuffAgentRun,
  FreebuffAgentRunner,
  FreebuffHttpClient,
} from "./types.ts";
import { FreebuffSessionError } from "./types.ts";

/**
 * Zod schema for the agent-run START response.
 */
const freebuffAgentRunSchema = z.object({
  runId: z.string().uuid(),
  agent: z.string(),
  model: z.string(),
  status: z.enum(["started", "completed", "failed"]),
  startedAt: z.string().datetime(),
});

/**
 * Resolve the agent-runs endpoint URL.
 */
export function agentRunsEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/v1/agent-runs`;
}

/**
 * Create a new agent runner backed by the given HTTP client.
 */
export function createAgentRunner(
  httpClient: FreebuffHttpClient,
  baseUrl: string,
): FreebuffAgentRunner {
  return {
    async start({ authToken, agent, model, fingerprintId, fingerprintHash, instanceId, signal }) {
      const response = await httpClient.fetch({
        url: agentRunsEndpoint(baseUrl),
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "user-agent": "ai-sdk/openai-compatible/1.0.0/codebuff",
          "x-codebuff-fingerprint": fingerprintId,
          ...(fingerprintHash ? { "x-codebuff-fingerprint-hash": fingerprintHash } : {}),
          "x-freebuff-instance-id": instanceId,
        },
        body: JSON.stringify({
          action: "START",
          agent,
          model,
          fingerprintId,
          fingerprintHash,
          freebuffInstanceId: instanceId,
        }),
        ...(signal ? { signal } : {}),
      });

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        throw new FreebuffSessionError(
          body?.error?.message ?? `HTTP ${response.status} from agent-runs START`,
          response.status,
          JSON.stringify(body),
        );
      }

      const parsed = freebuffAgentRunSchema.safeParse(body);
      if (!parsed.success) {
        throw new FreebuffSessionError(
          `Invalid agent-run response: ${parsed.error.message}`,
          response.status,
          JSON.stringify(body),
        );
      }

      return parsed.data as FreebuffAgentRun;
    },

    async finish({ authToken, runId, status, signal }) {
      const response = await httpClient.fetch({
        url: agentRunsEndpoint(baseUrl),
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "user-agent": "ai-sdk/openai-compatible/1.0.0/codebuff",
        },
        body: JSON.stringify({
          action: "FINISH",
          runId,
          status,
        }),
        ...(signal ? { signal } : {}),
      });

      // Best-effort finish — log but don't throw.
      if (!response.ok && response.status !== 204) {
        const text = await response.text().catch(() => "");
        console.warn(
          `[freebuff.emulator] Failed to finish agent run ${runId}: HTTP ${response.status} ${text}`,
        );
      }
    },
  };
}
