import { stripSensitiveResponseHeaders } from "@omniroute/open-sse/utils/upstreamResponseHeaders.ts";
import { buildErrorBody, parseUpstreamError } from "@omniroute/open-sse/utils/error.ts";
import { finalizeReadableStream } from "@/app/api/v1/relay/chat/completions/streamFinalizer";
import type { BifrostRoutingConfig } from "./bifrostRouting";

export interface BifrostDispatchOptions {
  request: Request;
  body: Record<string, unknown>;
  config: BifrostRoutingConfig;
  targetPath?: string;
  onUsageRecorded?: (status: "success" | "error", statusCode: number) => void;
}

export interface BifrostForwardResult {
  response: Response;
  timedOut: boolean;
  statusCode: number;
}

function buildUpstreamHeaders(
  request: Request,
  config: BifrostRoutingConfig
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const reqId = request.headers.get("x-request-id") || request.headers.get("x-correlation-id");
  if (reqId) headers["x-request-id"] = reqId;

  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }
  return headers;
}

export async function dispatchToBifrost({
  request,
  body,
  config,
  targetPath = "/v1/chat/completions",
  onUsageRecorded,
}: BifrostDispatchOptions): Promise<BifrostForwardResult> {
  const upstreamHeaders = buildUpstreamHeaders(request, config);
  const wantsStream = Boolean(body.stream) && config.streamingEnabled;

  const ac = new AbortController();
  let timedOut = false;
  const tid = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, config.timeoutMs);

  const cleanBase = config.baseUrl.replace(/\/$/, "");
  const cleanPath = targetPath.startsWith("/") ? targetPath : `/${targetPath}`;
  const targetUrl = `${cleanBase}${cleanPath}`;

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.any([ac.signal, request.signal]),
    });
  } catch (error) {
    clearTimeout(tid);
    throw error;
  }

  const responseHeaders = stripSensitiveResponseHeaders(upstream.headers);
  if (!upstream.ok) {
    try {
      const parsed = await parseUpstreamError(upstream, null);
      responseHeaders.set("Content-Type", "application/json");
      return {
        response: new Response(JSON.stringify(buildErrorBody(parsed.statusCode, parsed.message)), {
          status: parsed.statusCode,
          headers: responseHeaders,
        }),
        timedOut,
        statusCode: parsed.statusCode,
      };
    } finally {
      clearTimeout(tid);
    }
  }
  responseHeaders.set("X-Routed-By", "bifrost");
  if (!wantsStream) {
    responseHeaders.set("Content-Type", upstream.headers.get("Content-Type") ?? "application/json");
  }

  if (upstream.body) {
    const stream = finalizeReadableStream(upstream.body, (error) => {
      clearTimeout(tid);
      const statusCode = timedOut ? 504 : upstream.status;
      const status = error || statusCode >= 500 ? "error" : "success";
      onUsageRecorded?.(status, statusCode);
    });

    return {
      response: new Response(stream, { status: upstream.status, headers: responseHeaders }),
      timedOut,
      statusCode: upstream.status,
    };
  }

  clearTimeout(tid);
  onUsageRecorded?.(upstream.status < 500 ? "success" : "error", upstream.status);

  return {
    response: new Response(upstream.body, { status: upstream.status, headers: responseHeaders }),
    timedOut,
    statusCode: upstream.status,
  };
}
