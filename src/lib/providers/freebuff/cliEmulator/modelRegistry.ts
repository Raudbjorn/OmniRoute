/**
 * Freebuff CLI Emulator — Canonical Model Registry
 *
 * The single source of truth for the model → agent mapping. Every
 * entry here is derived from the live upstream contract documented in
 * `~/.config/manicode/freebuff-model-tests/phase4-deliverables/00-PROTOCOL-SPEC.md`
 * and validated against the running backend.
 *
 * The upstream enforces a `FREE_MODE_AGENT_MODELS` allowlist: only
 * specific (agent, model) pairs are accepted in free mode. Requests
 * outside the allowlist are rejected with `free_mode_invalid_agent_model`.
 *
 * @module lib/providers/freebuff/cliEmulator/modelRegistry
 */

import type { FreebuffModelDescriptor } from "./types.ts";

/**
 * Canonical model registry. The order matters: when falling back from
 * a premium model to a limited one, we iterate in declaration order.
 */
export const FREEBUFF_MODELS: ReadonlyArray<FreebuffModelDescriptor> = [
  // ── Premium tier ────────────────────────────────────────────────────
  {
    id: "minimax/minimax-m3",
    name: "MiniMax M3 (Bedrock)",
    agent: "base2-free-minimax-m3",
    tier: "standard",
    contextLength: 200_000,
    maxOutputTokens: 16_384,
    supportsVision: true,
  },
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    agent: "base2-free-deepseek",
    tier: "premium",
    contextLength: 128_000,
    maxOutputTokens: 8_192,
  },
  {
    id: "mimo/mimo-v2.5-pro",
    name: "MiMo V2.5 Pro",
    agent: "base2-free-mimo-pro",
    tier: "premium",
    contextLength: 128_000,
    maxOutputTokens: 8_192,
    supportsVision: true,
  },
  {
    id: "moonshotai/kimi-k2.6",
    name: "Kimi K2.6",
    agent: "base2-free-kimi",
    tier: "premium",
    contextLength: 256_000,
    maxOutputTokens: 8_192,
    supportsVision: true,
  },
  {
    id: "z-ai/glm-5.2",
    name: "GLM 5.2",
    agent: "base2-free-glm",
    tier: "premium",
    requiresReferral: true,
    contextLength: 1_000_000,
    maxOutputTokens: 8_192,
    supportsVision: true,
  },

  // ── Limited tier (geo-blocked countries fall back here) ─────────────
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    agent: "base2-free-deepseek-flash",
    tier: "limited",
    contextLength: 128_000,
    maxOutputTokens: 8_192,
  },
  {
    id: "mimo/mimo-v2.5",
    name: "MiMo V2.5",
    agent: "base2-free-mimo",
    tier: "limited",
    contextLength: 128_000,
    maxOutputTokens: 8_192,
    supportsVision: true,
  },

  // ── Legacy tier ─────────────────────────────────────────────────────
  {
    id: "minimax/minimax-m2.7",
    name: "MiniMax M2.7 (WK / LITE)",
    agent: "base2-free",
    tier: "legacy",
    contextLength: 200_000,
    maxOutputTokens: 8_192,
    supportsVision: true,
  },
];

/**
 * Lookup table keyed by model id. Built once at module load for O(1)
 * access in the hot path.
 */
const MODEL_BY_ID: ReadonlyMap<string, FreebuffModelDescriptor> = new Map(
  FREEBUFF_MODELS.map((m) => [m.id, m]),
);

/**
 * Resolve a model id to its canonical descriptor. Returns `null` if
 * the model is not in the registry.
 */
export function getModelDescriptor(modelId: string): FreebuffModelDescriptor | null {
  return MODEL_BY_ID.get(modelId) ?? null;
}

/**
 * Resolve a model id to its root agent id. Falls back to a
 * best-effort derivation if the model is not in the registry.
 */
export function getAgentForModel(modelId: string): string {
  const descriptor = getModelDescriptor(modelId);
  if (descriptor) return descriptor.agent;

  // Best-effort fallback for unknown models: derive the agent from
  // the model id. The upstream has been observed to accept these
  // patterns for legacy/unlisted models.
  const base = modelId.split("/").pop() ?? modelId;
  return `base2-free-${base.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

/**
 * Return all models in a given tier, in declaration order.
 */
export function getModelsByTier(
  tier: FreebuffModelDescriptor["tier"],
): ReadonlyArray<FreebuffModelDescriptor> {
  return FREEBUFF_MODELS.filter((m) => m.tier === tier);
}

/**
 * Return all limited-tier models, in declaration order. Used by the
 * fallback logic when a premium model is geo-blocked.
 */
export function getLimitedTierModels(): ReadonlyArray<FreebuffModelDescriptor> {
  return getModelsByTier("limited");
}

/**
 * Return all premium-tier models, in declaration order.
 */
export function getPremiumTierModels(): ReadonlyArray<FreebuffModelDescriptor> {
  return getModelsByTier("premium");
}

/**
 * Check whether a model is in the canonical registry.
 */
export function isKnownModel(modelId: string): boolean {
  return MODEL_BY_ID.has(modelId);
}

/**
 * Strip the OmniRoute provider prefix from a model id.
 * Examples:
 *   `freebuff/mimo/mimo-v2.5` → `mimo/mimo-v2.5`
 *   `fb/deepseek/deepseek-v4-flash` → `deepseek/deepseek-v4-flash`
 *   `mimo/mimo-v2.5` → `mimo/mimo-v2.5` (unchanged)
 */
export function stripProviderPrefix(modelId: string): string {
  const prefixes = ["freebuff/", "fb/"];
  for (const prefix of prefixes) {
    if (modelId.startsWith(prefix)) {
      return modelId.slice(prefix.length);
    }
  }
  return modelId;
}
