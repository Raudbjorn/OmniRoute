import assert from "node:assert/strict";
import { test } from "node:test";
import type { BaseExecutor, ExecuteInput } from "../../../../open-sse/executors/base.ts";
import { wrapExecutorWithBifrost } from "../../../../src/shared/services/bifrost/bifrostExecutor.ts";
import { resetBifrostCooldowns } from "../../../../src/shared/services/bifrost/bifrostRouting.ts";

const input: ExecuteInput = {
  model: "test-model",
  body: { messages: [] },
  stream: false,
  credentials: {},
};

test("Bifrost executor preserves native default, dispatches wire formats, and falls back during cooldown", async (t) => {
  const env = { ...process.env };
  const fetch = globalThis.fetch;
  t.after(() => {
    process.env = env;
    globalThis.fetch = fetch;
    resetBifrostCooldowns();
  });
  delete process.env.BIFROST_INGRESS_ENABLED;
  let nativeCalls = 0;
  const native = {
    execute: async () => {
      nativeCalls++;
      return new Response("native");
    },
  } as BaseExecutor;
  assert.equal(wrapExecutorWithBifrost(native, "openai"), native);
  process.env.BIFROST_INGRESS_ENABLED = "1";
  process.env.BIFROST_BASE_URL = "http://127.0.0.1:8080";
  process.env.OMNIROUTE_RELAY_BACKEND = "bifrost";
  process.env.BIFROST_ENABLED = "1";
  let url = "";
  let fail = false;
  let calls = 0;
  globalThis.fetch = async (target) => {
    calls++;
    url = String(target);
    return new Response(fail ? "unavailable" : "{}", { status: fail ? 503 : 200 });
  };
  for (const [provider, endpoint] of [
    ["openai", "/openai/v1/chat/completions"],
    ["anthropic", "/anthropic/v1/messages"],
  ]) {
    const result = await wrapExecutorWithBifrost(native, provider).execute(input);
    const response = result instanceof Response ? result : result.response;
    assert.equal(response.headers.get("X-Routed-By"), "bifrost");
    assert.equal(url, `http://127.0.0.1:8080${endpoint}`);
    await response.text();
  }
  assert.equal(nativeCalls, 0);
  fail = true;
  const wrapper = wrapExecutorWithBifrost(native, "openai");
  await wrapper.execute(input);
  const afterFailure = calls;
  const fallback = await wrapper.execute(input);
  assert.equal(calls, afterFailure);
  assert.equal(nativeCalls, 2);
  assert.ok(fallback instanceof Response);
  assert.equal(fallback.headers.get("X-Routing-Fallback-Reason"), "bifrost-cooldown");
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(wrapper.execute({ ...input, signal: ac.signal }));
  assert.equal(nativeCalls, 2);
});

test("Bifrost fallback preserves immutable native responses and executor metadata", async (t) => {
  const env = { ...process.env };
  const fetch = globalThis.fetch;
  t.after(() => {
    process.env = env;
    globalThis.fetch = fetch;
    resetBifrostCooldowns();
  });
  Object.assign(process.env, {
    BIFROST_INGRESS_ENABLED: "1",
    BIFROST_BASE_URL: "http://127.0.0.1:8080",
    OMNIROUTE_RELAY_BACKEND: "bifrost",
    BIFROST_ENABLED: "1",
    BIFROST_STREAMING_ENABLED: "1",
    OMNIROUTE_BIFROST_FAILURE_COOLDOWN_MS: "60000",
  });
  let bifrostCalls = 0;
  globalThis.fetch = async () => {
    bifrostCalls++;
    return new Response("unavailable", { status: 503 });
  };
  for (const stream of [false, true]) {
    for (const structured of [false, true]) {
      resetBifrostCooldowns();
      const callsBefore = bifrostCalls;
      const contentType = stream ? "text/event-stream" : "application/json";
      const body = stream ? 'data: {"ok":true}\n\n' : '{"ok":true}';
      for (const reason of ["bifrost-error", "bifrost-cooldown"]) {
        const original = await fetch(`data:${contentType},${encodeURIComponent(body)}`);
        assert.throws(() => original.headers.set("X-Test", "immutable"), TypeError);
        const metadata = {
          url: "https://native.example/chat",
          headers: { "Content-Type": "application/json" },
          transformedBody: input.body,
          transport: "native",
        };
        const nativeResult = structured ? { ...metadata, response: original } : original;
        const native = { execute: async () => nativeResult } as BaseExecutor;
        const result = await wrapExecutorWithBifrost(native, "openai").execute({
          ...input,
          stream,
        });
        const response = result instanceof Response ? result : result.response;
        assert.equal(result instanceof Response, !structured);
        if (!(result instanceof Response)) assert.deepEqual(result, { ...metadata, response });
        assert.notEqual(response, original);
        assert.equal(response.body, original.body);
        assert.equal(response.bodyUsed, false);
        assert.equal(response.status, original.status);
        assert.equal(response.statusText, original.statusText);
        assert.equal(response.headers.get("Content-Type"), contentType);
        assert.equal(response.headers.get("X-Routing-Fallback"), reason);
        assert.equal(response.headers.get("X-Routing-Fallback-Reason"), reason);
        assert.equal(original.headers.get("X-Routing-Fallback"), null);
        assert.equal(original.headers.get("X-Routing-Fallback-Reason"), null);
        assert.equal(await response.text(), body);
      }
      assert.equal(bifrostCalls, callsBefore + 1);
    }
  }
});
