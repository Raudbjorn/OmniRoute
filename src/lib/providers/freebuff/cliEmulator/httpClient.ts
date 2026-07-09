/**
 * Freebuff CLI Emulator — TLS-Impersonating HTTP Client
 *
 * Wraps `tls-client-node` (bogdanfinn/tls-client bindings) to emit a
 * TLS ClientHello that matches the Freebuff CLI (Bun runtime). The
 * upstream backend inspects the JA3/JA4 fingerprint and rejects
 * requests that don't match with `free_mode_cli_required`.
 *
 * Two backends are supported:
 *   1. `tls-client-node` (default) — uses bogdanfinn/tls-client via
 *      native bindings. Emulates Bun 0.1.0 by default.
 *   2. `wreq-js` (fallback) — Rust-powered wreq library with
 *      browser fingerprint impersonation.
 *
 * If neither library is available, falls back to global `fetch` —
 * which will fail with `free_mode_cli_required` but lets the rest of
 * the pipeline function for testing.
 *
 * @module lib/providers/freebuff/cliEmulator/httpClient
 */

import type {
  FreebuffHttpClient,
  FreebuffHttpRequest,
  FreebuffHttpResponse,
} from "./types.ts";

/**
 * Default TLS client identifier. The Freebuff CLI runs on Bun 0.1.0;
 * we impersonate that fingerprint to bypass `free_mode_cli_required`.
 */
export const DEFAULT_TLS_CLIENT_IDENTIFIER = "bun_0.1.0";

/**
 * Detect whether `tls-client-node` is loadable. We probe lazily so
 * that the module can be imported on systems where the native
 * bindings are not installed.
 */
async function tryLoadTlsClient(): Promise<typeof import("tls-client-node") | null> {
  try {
    const mod = await import("tls-client-node");
    return mod;
  } catch {
    return null;
  }
}

/**
 * Detect whether `wreq-js` is loadable.
 */
async function tryLoadWreqJs(): Promise<typeof import("wreq-js") | null> {
  try {
    const mod = await import("wreq-js");
    return mod;
  } catch {
    return null;
  }
}

/**
 * Resolve the best available HTTP backend. Priority:
 *   1. `tls-client-node` (preferred — bogdanfinn/tls-client)
 *   2. `wreq-js` (fallback — wreq Rust library)
 *   3. global `fetch` (last resort — will fail CLI fingerprint check)
 */
async function resolveBackend(): Promise<{
  name: "tls-client-node" | "wreq-js" | "fetch";
  fetch: FreebuffHttpClient["fetch"];
}> {
  const tlsClient = await tryLoadTlsClient();
  if (tlsClient) {
    return {
      name: "tls-client-node",
      fetch: (req) => tlsClientFetch(tlsClient, req),
    };
  }

  const wreq = await tryLoadWreqJs();
  if (wreq) {
    return {
      name: "wreq-js",
      fetch: (req) => wreqFetch(wreq, req),
    };
  }

  return {
    name: "fetch",
    fetch: (req) => globalFetch(req),
  };
}

/**
 * Fetch via `tls-client-node`. The library accepts a `clientIdentifier`
 * option that maps to a pre-configured TLS profile.
 */
async function tlsClientFetch(
  mod: typeof import("tls-client-node"),
  req: FreebuffHttpRequest,
): Promise<FreebuffHttpResponse> {
  const identifier = req.tlsClientIdentifier ?? DEFAULT_TLS_CLIENT_IDENTIFIER;
  const response = await mod.fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    clientIdentifier: identifier as Parameters<typeof mod.fetch>[1] extends infer T
      ? T extends { clientIdentifier?: infer C }
        ? C
        : never
      : never,
    // Pass through the abort signal if provided.
    ...(req.signal ? { signal: req.signal } : {}),
  } as Parameters<typeof mod.fetch>[1]);

  return {
    status: response.status,
    statusText: response.statusText ?? "",
    headers: Object.fromEntries(
      Object.entries(response.headers ?? {}).map(([k, v]) => [
        k,
        Array.isArray(v) ? v.join(", ") : String(v),
      ]),
    ),
    body: response.body as ReadableStream<Uint8Array>,
    async text() {
      return typeof response.body === "string"
        ? response.body
        : new TextDecoder().decode(response.body as ArrayBuffer);
    },
    async json<T = unknown>() {
      const text = await this.text();
      return JSON.parse(text) as T;
    },
  };
}

/**
 * Fetch via `wreq-js`. The library exposes a `fetch()` function that
 * accepts an `impersonate` option for browser fingerprint spoofing.
 */
async function wreqFetch(
  mod: typeof import("wreq-js"),
  req: FreebuffHttpRequest,
): Promise<FreebuffHttpResponse> {
  const identifier = req.tlsClientIdentifier ?? DEFAULT_TLS_CLIENT_IDENTIFIER;
  const response = await mod.fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    impersonate: identifier,
    ...(req.signal ? { signal: req.signal } : {}),
  } as Parameters<typeof mod.fetch>[1]);

  return {
    status: response.status,
    statusText: response.statusText ?? "",
    headers: Object.fromEntries(
      Object.entries(response.headers ?? {}).map(([k, v]) => [
        k,
        Array.isArray(v) ? v.join(", ") : String(v),
      ]),
    ),
    body: response.body as ReadableStream<Uint8Array>,
    async text() {
      return typeof response.body === "string"
        ? response.body
        : new TextDecoder().decode(response.body as ArrayBuffer);
    },
    async json<T = unknown>() {
      const text = await this.text();
      return JSON.parse(text) as T;
    },
  };
}

/**
 * Fallback to global `fetch`. This will fail the CLI fingerprint
 * check but lets the rest of the pipeline run for testing.
 */
async function globalFetch(req: FreebuffHttpRequest): Promise<FreebuffHttpResponse> {
  const response = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    ...(req.signal ? { signal: req.signal } : {}),
  });

  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body: response.body!,
    async text() {
      return response.text();
    },
    async json<T = unknown>() {
      return (await response.json()) as T;
    },
  };
}

/**
 * Cached backend resolution. The first call probes the available
 * libraries; subsequent calls reuse the result.
 */
let backendPromise: Promise<{
  name: "tls-client-node" | "wreq-js" | "fetch";
  fetch: FreebuffHttpClient["fetch"];
}> | null = null;

/**
 * Create a new HTTP client backed by the best available TLS-impersonating
 * library. The client is stateless and safe to share across requests.
 */
export async function createHttpClient(): Promise<FreebuffHttpClient> {
  if (!backendPromise) {
    backendPromise = resolveBackend();
  }
  const backend = await backendPromise;
  return { fetch: backend.fetch };
}

/**
 * Get the name of the backend that will be used. Useful for logging
 * and diagnostics.
 */
export async function getHttpClientBackendName(): Promise<
  "tls-client-node" | "wreq-js" | "fetch"
> {
  if (!backendPromise) {
    backendPromise = resolveBackend();
  }
  const backend = await backendPromise;
  return backend.name;
}
