import type {
  BaseExecutor,
  ExecuteInput,
  ExecutorExecuteResult,
} from "@omniroute/open-sse/executors/base.ts";
import { getTargetFormat } from "@omniroute/open-sse/services/provider.ts";
import { dispatchToBifrost } from "./bifrostClient";
import {
  getBifrostRoutingConfig,
  resolveRelayRoutingBackend,
  shouldTryBifrostForRequest,
  getActiveBifrostCooldown,
  recordBifrostFailure,
  clearBifrostFailure,
} from "./bifrostRouting";

/** Dispatch only after the normal chat pipeline has authenticated, validated and accounted for admission. */
export function wrapExecutorWithBifrost(native: BaseExecutor, provider: string): BaseExecutor {
  if (process.env.BIFROST_INGRESS_ENABLED !== "1") return native;
  const wrapper: BaseExecutor = Object.create(native);
  wrapper.execute = async (input: ExecuteInput): Promise<ExecutorExecuteResult> => {
    const config = getBifrostRoutingConfig();
    const backend = resolveRelayRoutingBackend();
    const format = getTargetFormat(provider, input.credentials?.providerSpecificData);
    const model = `${provider}/${input.model}`;
    const decision = shouldTryBifrostForRequest(backend, config, { model });
    if (
      !config ||
      !decision.tryBifrost ||
      !["openai", "claude"].includes(format) ||
      (input.stream && !config.streamingEnabled)
    )
      return native.execute(input);
    input.signal?.throwIfAborted();
    let reason = "bifrost-cooldown";
    if (!getActiveBifrostCooldown(config.baseUrl)) {
      try {
        const targetPath =
          format === "claude" ? "/anthropic/v1/messages" : "/openai/v1/chat/completions";
        const result = await dispatchToBifrost({
          request: new Request("http://localhost/v1/chat/completions", {
            signal: input.signal ?? undefined,
          }),
          body: { ...(input.body as Record<string, unknown>), model, stream: input.stream },
          config,
          targetPath,
        });
        if (result.statusCode < 500) {
          clearBifrostFailure(config.baseUrl);
          return { response: result.response, transport: "bifrost" };
        }
        await result.response.body?.cancel();
      } catch (error) {
        if (input.signal?.aborted) throw error;
      }
      reason = "bifrost-error";
      recordBifrostFailure(config.baseUrl, reason);
    }
    const result = await native.execute(input);
    const response = result instanceof Response ? result : result.response;
    const headers = new Headers(response.headers);
    headers.set("X-Routing-Fallback", reason);
    headers.set("X-Routing-Fallback-Reason", reason);
    const fallback = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    return result instanceof Response ? fallback : { ...result, response: fallback };
  };
  return wrapper;
}
