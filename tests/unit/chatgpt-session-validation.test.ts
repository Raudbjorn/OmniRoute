import { test } from "node:test";
import assert from "node:assert/strict";

import { WEB_COOKIE_PROVIDERS } from "../../src/shared/constants/providers/web-cookie.ts";
import { WEB_SESSION_CREDENTIAL_REQUIREMENTS } from "../../src/shared/providers/webSessionCredentials.ts";
import { usesChatGptBrowserSessionCredentials } from "../../src/shared/constants/chatgptWebCodex.ts";

test("the dashboard card describes the session provider", () => {
  const card = (WEB_COOKIE_PROVIDERS as Record<string, Record<string, unknown>>)["chatgpt-session"];
  assert.ok(card, "chatgpt-session must have a web-cookie card");
  assert.equal(card.alias, "cgpt-session");
  assert.equal(card.website, "https://chatgpt.com");
  assert.equal(card.subscriptionRisk, true);
  assert.equal(card.riskNoticeVariant, "webCookie");
  assert.equal(card.toolCalling, "emulated");
});

test("the credential requirement accepts a full cookie header", () => {
  const requirement = (
    WEB_SESSION_CREDENTIAL_REQUIREMENTS as Record<string, Record<string, unknown>>
  )["chatgpt-session"];
  assert.ok(requirement);
  assert.equal(requirement.kind, "cookie");
  assert.equal(requirement.acceptsFullCookieHeader, true);
});

test("validateProviderApiKey dispatch resolves chatgpt-session to its own validator", async () => {
  const { validateProviderApiKey } = await import("../../src/lib/providers/validation.ts");
  // "cookie:" decodes to an empty cookie (decodeChatGptWebCodexSecrets strips the
  // "cookie:" prefix), so validateChatGptSessionProvider returns its own
  // cookie-required rejection immediately — before any Chrome/CDP detection or
  // browser launch. A non-empty credential is required here: an empty apiKey is
  // intercepted by validateProviderApiKey's own "Provider and API key required"
  // gate before dispatch ever reaches the SPECIALTY_VALIDATORS map, which would
  // prove nothing about chatgpt-session's own registration.
  const result = await validateProviderApiKey({
    provider: "chatgpt-session",
    apiKey: "cookie:",
  });
  assert.equal(result.valid, false);
  assert.equal(result.error, "A ChatGPT cookie header or a stored browser session is required.");
});

test("validation rejects an empty credential without launching a browser", async () => {
  const { validateChatGptSessionProvider } =
    await import("../../src/lib/providers/validation/chatgptSession.ts");
  const result = await validateChatGptSessionProvider({ apiKey: "" });
  assert.equal(result.valid, false);
  assert.match(String(result.error), /cookie|credential/i);
});

test("an abandoned browser-verification flow is reaped past its TTL", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { getConfigDir } = await import("../../open-sse/vendor/codex-chatgpt-web/config.ts");
  const { connectionRuntimePaths } =
    await import("../../open-sse/executors/chatgpt-web-codex/storageState.ts");
  const { validateChatGptSessionProvider } =
    await import("../../src/lib/providers/validation/chatgptSession.ts");

  // Simulate a fresh-cookie validation that succeeded but was never finalized: its
  // authenticated storage state is left on disk, keyed by validationId, past the TTL.
  const validationId = `validation-${"a".repeat(24)}`;
  const paths = connectionRuntimePaths(validationId);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.storageStatePath, JSON.stringify({ cookies: [], origins: [] }));

  const manifestPath = path.join(getConfigDir(), "connections", "pending-validations.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ [validationId]: Date.now() - 20 * 60 * 1000 }));
  assert.ok(fs.existsSync(paths.root), "fixture directory should exist before reap");

  // Any call reaps abandoned validations first, even one that rejects immediately.
  await validateChatGptSessionProvider({ apiKey: "" });

  assert.equal(fs.existsSync(paths.root), false);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, number>;
  assert.equal(validationId in manifest, false);
});

test("usesChatGptBrowserSessionCredentials recognizes both browser-session providers", () => {
  assert.equal(usesChatGptBrowserSessionCredentials("chatgpt-web-codex"), true);
  assert.equal(usesChatGptBrowserSessionCredentials("chatgpt-session"), true);
  assert.equal(usesChatGptBrowserSessionCredentials("openai"), false);
  assert.equal(usesChatGptBrowserSessionCredentials(undefined), false);
});
