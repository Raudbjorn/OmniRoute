import { test } from "node:test";
import assert from "node:assert/strict";

test("messages: Bifrost cannot bypass API-key authentication", async (t) => {
  const env = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    process.env = env;
    globalThis.fetch = originalFetch;
  });
  process.env.BIFROST_BASE_URL = "http://127.0.0.1:8080";
  process.env.BIFROST_INGRESS_ENABLED = "1";
  process.env.OMNIROUTE_RELAY_BACKEND = "bifrost";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ choices: [] });
  };
  const { POST } = await import("../../../../src/app/api/v1/messages/route.ts");
  const res = await POST(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer invalid-test-key" },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
  );
  assert.equal(res.status, 401);
  assert.equal(calls, 0);
  await res.text();
});
