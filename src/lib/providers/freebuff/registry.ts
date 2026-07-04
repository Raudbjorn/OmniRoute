import {
  isFreebuffEnabled,
  resolveFreebuffBaseUrl,
  resolveFreebuffCredentialsPath,
} from "./base";

/**
 * Freebuff provider runtime registry.
 *
 * Centralizes provider configuration that other layers (HTTP routes,
 * UI, transformers) consume. The provider is opt-in (env-gated), so
 * `getFreebuffProviderConfig()` returns `null` when disabled — callers
 * must handle that gracefully (typically: skip the route registration,
 * hide the UI card).
 *
 * @module lib/providers/freebuff/registry
 */

export interface FreebuffProviderConfig {
  /** Whether the provider is enabled (env gate + opt-in). */
  enabled: boolean;
  /** Resolved base URL for API calls. */
  baseUrl: string;
  /** Resolved credentials.json path (paste-fallback path). */
  credentialsPath: string;
  /** Provider id used in registry / persistence layers. */
  providerId: "freebuff";
  /** Default chat-completions path (OpenAI-compatible). */
  openaiChatPath: string;
  /** Default messages path (Anthropic-compatible). */
  anthropicMessagesPath: string;
}

/** Codebuff/Freebuff chat-completions endpoint (OpenAI-compatible). */
export const FREEBUFF_OPENAI_CHAT_PATH = "/api/v1/chat/completions";

/** Codebuff does not expose a separate Anthropic endpoint. Requests shaped
 *  for Anthropic should be translated and sent to the same chat-completions
 *  endpoint by the caller; this constant is kept as an alias for API symmetry. */
export const FREEBUFF_ANTHROPIC_MESSAGES_PATH = "/api/v1/chat/completions";

/**
 * Resolve the current provider configuration. Returns null when the
 * provider is disabled — callers should not register routes, UI, or
 * transformers in that case.
 */
export function getFreebuffProviderConfig(): FreebuffProviderConfig | null {
  if (!isFreebuffEnabled()) return null;
  return {
    enabled: true,
    baseUrl: resolveFreebuffBaseUrl(),
    credentialsPath: resolveFreebuffCredentialsPath(),
    providerId: "freebuff",
    openaiChatPath: FREEBUFF_OPENAI_CHAT_PATH,
    anthropicMessagesPath: FREEBUFF_ANTHROPIC_MESSAGES_PATH,
  };
}

/**
 * Returns the OpenAI-compatible chat-completions endpoint.
 * Throws when the provider is disabled.
 */
export function getFreebuffOpenAIEndpoint(): string {
  const cfg = getFreebuffProviderConfig();
  if (!cfg) {
    throw new Error(
      "freebuff.getFreebuffOpenAIEndpoint: provider is disabled (remove FREEBUFF_ENABLED=0)",
    );
  }
  return `${cfg.baseUrl}${cfg.openaiChatPath}`;
}

/**
 * Returns the Anthropic-compatible messages endpoint.
 * Throws when the provider is disabled.
 */
export function getFreebuffAnthropicEndpoint(): string {
  const cfg = getFreebuffProviderConfig();
  if (!cfg) {
    throw new Error(
      "freebuff.getFreebuffAnthropicEndpoint: provider is disabled (remove FREEBUFF_ENABLED=0)",
    );
  }
  return `${cfg.baseUrl}${cfg.anthropicMessagesPath}`;
}
