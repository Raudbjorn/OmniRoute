/**
 * Freebuff CLI Emulator — Type Definitions
 *
 * Wire types that mirror the Freebuff CLI (Bun + React Ink) protocol.
 * Every type here is derived from the live upstream contract documented in
 * `~/.config/manicode/freebuff-model-tests/phase4-deliverables/00-PROTOCOL-SPEC.md`
 * and validated against the running backend.
 *
 * @module lib/providers/freebuff/cliEmulator/types
 */

// ---------------------------------------------------------------------------
// Model registry — canonical mapping between model id and root agent.
// ---------------------------------------------------------------------------

/**
 * Tier classification of a Freebuff model. The upstream enforces an
 * allowlist of (agent, model) pairs per tier; requests outside the
 * allowlist are rejected with `free_mode_invalid_agent_model`.
 */
export type FreebuffTier = "premium" | "standard" | "limited" | "legacy";

/**
 * Canonical model descriptor. The `agent` field is the root agent id
 * stamped on `codebuff_metadata.agent`; the upstream uses this to
 * route the request to the correct LLM provider.
 */
export interface FreebuffModelDescriptor {
  /** Stable model id as known by the upstream (e.g. `mimo/mimo-v2.5`). */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Root agent id (e.g. `base2-free-mimo`). */
  readonly agent: string;
  /** Tier classification — drives fallback decisions. */
  readonly tier: FreebuffTier;
  /** Whether the model requires a referral code to access. */
  readonly requiresReferral?: boolean;
  /** Maximum context length in tokens. */
  readonly contextLength: number;
  /** Maximum output tokens. */
  readonly maxOutputTokens: number;
  /** Whether the model supports vision inputs. */
  readonly supportsVision?: boolean;
}

// ---------------------------------------------------------------------------
// Credentials — what the user pastes from credentials.json or what the
// device-code flow returns.
// ---------------------------------------------------------------------------

/**
 * Raw credentials shape as stored in `~/.config/manicode/credentials.json`.
 * The `authToken` is the bearer token; the fingerprint triple is required
 * for every request to the upstream.
 */
export interface FreebuffCredentials {
  /** Bearer token (UUID v4 format). */
  readonly authToken: string;
  /** Fingerprint id (e.g. `enhanced-In8ptT5VlArv8v94pTCmJOVNkcDSJKj_hYbkvpdhKes`). */
  readonly fingerprintId: string;
  /** SHA-256 hash of the fingerprint payload. */
  readonly fingerprintHash: string;
  /** User id (optional — used for analytics). */
  readonly userId?: string;
  /** User email (optional — used for analytics). */
  readonly email?: string;
  /** User display name (optional). */
  readonly name?: string;
}

// ---------------------------------------------------------------------------
// Session — what `POST /api/v1/freebuff/session` returns.
// ---------------------------------------------------------------------------

/**
 * Response from `POST /api/v1/freebuff/session`. The upstream returns
 * `status: "active"` when a queue seat is granted, `status: "waiting"`
 * when the user is queued, or `status: "ended"` after `DELETE`.
 */
export interface FreebuffSession {
  readonly status: "active" | "waiting" | "ended";
  /** UUID of the acquired seat — stamped on `x-freebuff-instance-id`. */
  readonly instanceId: string;
  /** Model id the seat is bound to. */
  readonly model: string;
  /** ISO-8601 timestamp when the seat was admitted. */
  readonly admittedAt: string;
  /** ISO-8601 timestamp when the seat expires (typically 1h). */
  readonly expiresAt: string;
  /** Milliseconds remaining until expiry. */
  readonly remainingMs: number;
  /** Effective access tier for this session. */
  readonly accessTier: "full" | "limited";
  /** ISO country code detected from the request IP. */
  readonly countryCode?: string;
  /** Reason for country-level blocking, if any. */
  readonly countryBlockReason?: string;
  /** Rate-limit snapshot for the requested model. */
  readonly rateLimit?: FreebuffRateLimit;
  /** Rate-limit snapshots keyed by model id. */
  readonly rateLimitsByModel?: Record<string, FreebuffRateLimit>;
}

export interface FreebuffRateLimit {
  readonly model: string;
  readonly limit: number;
  readonly period: "pacific_day" | "pacific_week";
  readonly resetTimeZone: string;
  readonly resetAt: string;
  readonly windowHours?: number;
  /** Fractional count — upstream sends floats (e.g. 2.1). */
  readonly recentCount: number;
}

// ---------------------------------------------------------------------------
// Agent run — what `POST /api/v1/agent-runs` returns.
// ---------------------------------------------------------------------------

/**
 * Response from `POST /api/v1/agent-runs { action: "START" }`. The
 * `runId` is the canonical correlation id stamped on every chat
 * completion request and SSE event.
 */
export interface FreebuffAgentRun {
  readonly runId: string;
  readonly agent: string;
  readonly model: string;
  readonly status: "started" | "completed" | "failed";
  readonly startedAt: string;
}

// ---------------------------------------------------------------------------
// Wire envelope — top-level fields stamped on the chat completion body.
// ---------------------------------------------------------------------------

/**
 * Top-level wire envelope for `POST /api/v1/chat/completions`. The
 * upstream REQUIRES `runId`, `provider`, and `codebuff_metadata` at
 * the top level (NOT nested under a `codebuff` wrapper).
 */
export interface FreebuffWireEnvelope {
  /** The model id (e.g. `mimo/mimo-v2.5`). */
  readonly model: string;
  /** OpenAI-shaped messages array. */
  readonly messages: ReadonlyArray<unknown>;
  /** Whether to stream the response. */
  readonly stream: boolean;
  /** OpenAI stream options. */
  readonly stream_options?: { include_usage?: boolean };
  /** Correlation id — REQUIRED, else 400 "No runId found in request body". */
  readonly runId: string;
  /** Provider routing config — REQUIRED, else 400 "No provider found". */
  readonly provider: {
    /** Ordered list of preferred providers (e.g. `["DeepSeek"]`). */
    readonly order?: string[];
    /** Whether to allow fallback to other providers. */
    readonly allow_fallbacks: boolean;
    /** Sort strategy — typically `"price"`. */
    readonly sort: string;
  };
  /** Codebuff metadata — REQUIRED. */
  readonly codebuff_metadata: {
    readonly fingerprint_id: string;
    readonly client_id: string;
    readonly agent: string;
    readonly user_input_id: string;
    readonly cost_mode: "free" | "paid";
    readonly run_id: string;
    readonly freebuff_instance_id: string;
  };
  /** Free-form passthrough for tools, temperature, etc. */
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Headers — every header the upstream expects.
// ---------------------------------------------------------------------------

/**
 * Required + optional headers for every upstream request.
 */
export interface FreebuffHeaders {
  readonly Authorization: string;
  readonly "Content-Type": string;
  readonly Accept: string;
  readonly "user-agent": string;
  readonly "x-codebuff-fingerprint": string;
  readonly "x-codebuff-fingerprint-hash"?: string;
  readonly "x-freebuff-instance-id"?: string;
  readonly "x-freebuff-model"?: string;
  readonly "X-Codebuff-OpenRouter-Api-Key"?: string;
  /** Allow callers to inject extra headers (e.g. for testing). */
  readonly [key: string]: string | undefined;
}

// ---------------------------------------------------------------------------
// SSE events — what the upstream streams back.
// ---------------------------------------------------------------------------

/**
 * Parsed SSE event from the upstream chat completion stream. The
 * upstream emits a mix of OpenAI-shaped chunks (`data: {...}`) and
 * Codebuff-specific events (`event: <name>\ndata: {...}`).
 */
export type FreebuffSseEvent =
  | { type: "openai-chunk"; data: unknown }
  | { type: "codebuff-event"; event: string; data: unknown }
  | { type: "done" }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Chat options — public API for `emulateChat()`.
// ---------------------------------------------------------------------------

/**
 * Options for `emulateChat()`. Mirrors the OpenAI chat completion
 * request shape plus Freebuff-specific extensions.
 */
export interface FreebuffChatInput {
  readonly model: string;
  readonly messages: ReadonlyArray<unknown>;
  readonly stream?: boolean;
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly tools?: unknown;
  readonly tool_choice?: unknown;
  /** Free-form passthrough for any other OpenAI field. */
  readonly [key: string]: unknown;
}

export interface FreebuffChatContext {
  readonly credentials: FreebuffCredentials;
  /** Override the model → agent mapping (testing). */
  readonly modelOverride?: FreebuffModelDescriptor;
  /** Override the session id (testing). */
  readonly sessionId?: string;
  /** Override the user input id (testing). */
  readonly userInputId?: string;
  /** Abort signal. */
  readonly signal?: AbortSignal;
  /** Override the HTTP client (testing). */
  readonly httpClient?: FreebuffHttpClient;
  /** Override the session manager (testing). */
  readonly sessionManager?: FreebuffSessionManager;
  /** Override the agent runner (testing). */
  readonly agentRunner?: FreebuffAgentRunner;
}

// ---------------------------------------------------------------------------
// Errors — typed error hierarchy for fine-grained fallback decisions.
// ---------------------------------------------------------------------------

/**
 * Base error class for all Freebuff CLI emulator errors.
 */
export abstract class FreebuffError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus?: number;
  abstract readonly retryable: boolean;
}

/**
 * The upstream rejected the request because the TLS fingerprint does
 * not match the Freebuff CLI. This is the `free_mode_cli_required`
 * error from the upstream.
 */
export class FreebuffCliRequiredError extends FreebuffError {
  readonly code = "free_mode_cli_required";
  readonly httpStatus = 403;
  readonly retryable = false;
  constructor(message = "Free mode is only available through the freebuff CLI") {
    super(message);
    this.name = "FreebuffCliRequiredError";
  }
}

/**
 * The upstream rejected the (agent, model) combination. This is the
 * `free_mode_invalid_agent_model` error from the upstream.
 */
export class FreebuffInvalidAgentModelError extends FreebuffError {
  readonly code = "free_mode_invalid_agent_model";
  readonly httpStatus = 403;
  readonly retryable = false;
  constructor(
    message = "Free mode is only available for specific agent and model combinations",
    public readonly agent?: string,
    public readonly model?: string,
  ) {
    super(message);
    this.name = "FreebuffInvalidAgentModelError";
  }
}

/**
 * The user is in a geo-blocked country. The upstream returns
 * `countryBlockReason: "country_not_allowed"`.
 */
export class FreebuffCountryBlockedError extends FreebuffError {
  readonly code = "country_not_allowed";
  readonly httpStatus = 403;
  readonly retryable = false;
  constructor(
    message = "Country not allowed for this model",
    public readonly countryCode?: string,
  ) {
    super(message);
    this.name = "FreebuffCountryBlockedError";
  }
}

/**
 * The seat is locked (another session is active for this token).
 */
export class FreebuffModelLockedError extends FreebuffError {
  readonly code = "model_locked";
  readonly httpStatus = 409;
  readonly retryable = true;
  constructor(message = "Model is locked — another session is active") {
    super(message);
    this.name = "FreebuffModelLockedError";
  }
}

/**
 * The session acquisition failed for an unknown reason.
 */
export class FreebuffSessionError extends FreebuffError {
  readonly code = "session_error";
  readonly retryable: boolean;
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly upstreamBody?: string,
  ) {
    super(message);
    this.name = "FreebuffSessionError";
    this.retryable = httpStatus !== 401 && httpStatus !== 403;
  }
}

// ---------------------------------------------------------------------------
// HTTP client — abstraction over tls-client-node + global fetch.
// ---------------------------------------------------------------------------

/**
 * Minimal HTTP client interface used by the emulator. The default
 * implementation uses `tls-client-node` with Bun fingerprint
 * impersonation; tests can inject a mock.
 */
export interface FreebuffHttpClient {
  fetch(input: FreebuffHttpRequest): Promise<FreebuffHttpResponse>;
}

export interface FreebuffHttpRequest {
  readonly url: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  /** Optional TLS impersonation target. Defaults to Bun 0.1.0. */
  readonly tlsClientIdentifier?: string;
}

export interface FreebuffHttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly body: ReadableStream<Uint8Array>;
  /** Read the body as text (consumes the stream). */
  text(): Promise<string>;
  /** Read the body as JSON (consumes the stream). */
  json<T = unknown>(): Promise<T>;
}

// ---------------------------------------------------------------------------
// Session manager — abstraction over the session lifecycle.
// ---------------------------------------------------------------------------

export interface FreebuffSessionManager {
  /** Acquire a queue seat for the given model. */
  claim(options: {
    authToken: string;
    modelId: string;
    signal?: AbortSignal;
  }): Promise<FreebuffSession>;
  /** Release the current seat. */
  release(options: {
    authToken: string;
    instanceId: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Agent runner — abstraction over the agent-run lifecycle.
// ---------------------------------------------------------------------------

export interface FreebuffAgentRunner {
  start(options: {
    authToken: string;
    agent: string;
    model: string;
    fingerprintId: string;
    fingerprintHash?: string;
    instanceId: string;
    signal?: AbortSignal;
  }): Promise<FreebuffAgentRun>;
  finish(options: {
    authToken: string;
    runId: string;
    status: "completed" | "failed";
    signal?: AbortSignal;
  }): Promise<void>;
}
