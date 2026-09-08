/**
 * C2 regression guard — creating a `chatgpt-session` connection from the dashboard.
 *
 * `POST /api/providers` routes every provider accepted by
 * `usesChatGptBrowserSessionCredentials()` into `finalizeValidatedChatGptWebCodexSecrets`,
 * whose first statement is `JSON.parse`. The dashboard modals used to build the
 * `{version, cookie}` envelope only for `chatgpt-web-codex` and post the pasted Cookie header
 * verbatim for anything else, so every `chatgpt-session` save died with
 * `Unexpected token '_', "__Secure-n"... is not valid JSON`. These tests pin both halves of the
 * contract: the envelope the fixed modals send is accepted and stored as the VERIFIED storage
 * state (never the raw cookie), and a raw header is rejected — which is exactly why the client
 * must key its encoding off the same shared predicate the route uses.
 *
 * The browser probe is not run: the verification artifacts the real Playwright inspector leaves
 * behind are seeded on disk, and a CDP endpoint is configured so nothing in this file can ever
 * reach `chromium.launch()`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chatgpt-session-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// Hard "never launch Chrome" guarantee for the fire-and-forget auto-test the POST kicks off:
// with a CDP endpoint set, the vendored login inspector connects over CDP (to a dead loopback
// port here) instead of spawning a browser.
process.env.CHATGPT_WEB_CODEX_CDP_URL = "http://127.0.0.1:1";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const storageState = await import("../../open-sse/executors/chatgpt-web-codex/storageState.ts");
const browserLogin = await import("../../open-sse/vendor/codex-chatgpt-web/browser-login.ts");
const providersRoute = await import("../../src/app/api/providers/route.ts");
const bulkWebSessionRoute = await import("../../src/app/api/providers/bulk-web-session/route.ts");

const RAW_COOKIE = "__Secure-next-auth.session-token=session-value-abc; _cfuvid=cf-value";

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * Reproduce, without Playwright, exactly what a successful browser validation leaves on disk:
 * the cookie-derived storage state plus the verification marker the inspector writes on success.
 */
function seedVerifiedValidation(cookie: string): string {
  const validationId = `validation-${randomBytes(12).toString("hex")}`;
  const paths = storageState.connectionRuntimePaths(validationId);
  storageState.ensureConnectionStorageState(validationId, cookie);
  browserLogin.writeVerificationMarker(paths.storageStatePath, {
    solAvailable: false,
    proAvailable: false,
  });
  return validationId;
}

async function createConnection(apiKey: string, validationId: string): Promise<Response> {
  return providersRoute.POST(
    await makeManagementSessionRequest("http://localhost/api/providers", {
      method: "POST",
      headers: { "x-skip-model-sync": "true" },
      body: {
        provider: "chatgpt-session",
        name: `ChatGPT session ${randomBytes(4).toString("hex")}`,
        apiKey,
        providerSpecificData: { validationId },
      },
    })
  );
}

test("POST creates a chatgpt-session connection from a pasted cookie header", async () => {
  const validationId = seedVerifiedValidation(RAW_COOKIE);
  // What the fixed modals send for ANY provider `usesChatGptBrowserSessionCredentials()`
  // accepts — the raw pasted header wrapped in the shared credential envelope, with no
  // `runtimeKey` (this provider never has one).
  const envelope = JSON.stringify({ version: 1, cookie: RAW_COOKIE });

  const response = await createConnection(envelope, validationId);
  const body = (await response.json()) as { connection?: { id: string }; error?: string };

  assert.equal(response.status, 201, `expected 201, got ${response.status}: ${body.error ?? ""}`);
  assert.ok(body.connection?.id);

  const stored = (await providersDb.getProviderConnectionById(body.connection.id)) as Record<
    string,
    unknown
  > | null;
  assert.ok(stored);
  const persisted = JSON.parse(String(stored.apiKey)) as Record<string, unknown>;
  // The raw cookie is discarded in favour of the verified Playwright storage state.
  assert.equal(persisted.version, 2);
  assert.equal("cookie" in persisted, false);
  assert.equal("runtimeKey" in persisted, false);
  const state = persisted.storageState as Record<string, unknown>;
  assert.ok(Array.isArray(state.cookies));
  assert.equal(String(stored.apiKey).includes("session-value-abc"), true);
  assert.equal(
    String(stored.apiKey).includes(RAW_COOKIE),
    false,
    "the pasted Cookie header itself must never be persisted"
  );

  // The one-shot validation scratch directory is consumed by the finalize step.
  assert.equal(
    fs.existsSync(storageState.connectionRuntimePaths(validationId).storageStatePath),
    false
  );
});

test("POST rejects a raw cookie header and never echoes a stack or a path", async () => {
  const validationId = seedVerifiedValidation(RAW_COOKIE);

  const response = await createConnection(RAW_COOKIE, validationId);
  const body = (await response.json()) as { error?: string };

  assert.equal(response.status, 400);
  assert.ok(body.error);
  // Routed through sanitizeErrorMessage: no stack tail, no absolute source path.
  assert.doesNotMatch(String(body.error), /\n\s+at /);
  assert.doesNotMatch(String(body.error), /at \//);
  // The German fallback is gone — this provider is labelled in English.
  assert.doesNotMatch(String(body.error), /Browserprüfung/);
});

test("bulk-web-session import rejects chatgpt-session and chatgpt-web-codex", async () => {
  // Both providers read their encoded, browser-verified storage state from `credentials.apiKey`
  // (decodeChatGptWebCodexSecrets). This route stores a raw cookie in providerSpecificData with
  // apiKey left null, which neither executor can use — a bulk-imported connection would sit
  // unverified and never run. Must be rejected up front, not silently created broken.
  for (const provider of ["chatgpt-session", "chatgpt-web-codex"]) {
    const response = await bulkWebSessionRoute.POST(
      await makeManagementSessionRequest("http://localhost/api/providers/bulk-web-session", {
        method: "POST",
        body: {
          provider,
          entries: [{ name: `${provider} bulk import`, credential: RAW_COOKIE }],
        },
      })
    );
    const body = (await response.json()) as { error?: string };
    assert.equal(response.status, 400, `expected 400 for ${provider}, got ${response.status}`);
    assert.match(String(body.error), /browser-session verification/);
  }
});

test("both dashboard modals derive the credential envelope from the shared predicate", () => {
  // The client/server drift that caused C2 is only detectable at the source level: the modals
  // are React components with no unit-testable seam. A bare "the predicate's name appears
  // somewhere in the file" check would still pass a modal that calls the predicate for an
  // unrelated purpose (e.g. a UI label) while gating the actual envelope on something else — so
  // this pins the exact chain instead: find the identifier assigned from
  // `usesChatGptBrowserSessionCredentials(provider)`, then require THAT SAME identifier to be
  // the ternary condition immediately gating a `{ version: 1, cookie: ... }` envelope.
  const modalPaths = [
    "src/app/(dashboard)/dashboard/providers/[id]/components/modals/AddApiKeyModal.tsx",
    "src/app/(dashboard)/dashboard/providers/[id]/components/modals/EditConnectionModal.tsx",
  ] as const;
  for (const modal of modalPaths) {
    // ast-grep(detect-non-literal-fs-filename-typescript): `modal` is one of the two literal
    // paths above, never external input — this loop variable isn't attacker-controlled.
    const source = fs.readFileSync(modal, "utf8");
    const predicateAssignment = source.match(
      /const\s+(\w+)\s*=\s*usesChatGptBrowserSessionCredentials\(provider\)/
    );
    assert.ok(
      predicateAssignment,
      `${modal} must assign a variable from usesChatGptBrowserSessionCredentials(provider)`
    );
    const gateVar = predicateAssignment[1];
    const envelopeGate = new RegExp(
      `${gateVar}\\s*\\?\\s*JSON\\.stringify\\(\\{[\\s\\S]{0,120}?version:\\s*1[\\s\\S]{0,120}?cookie:`
    );
    assert.match(
      source,
      envelopeGate,
      `${modal} must gate the { version: 1, cookie } envelope on ${gateVar}, ` +
        `not on any other condition`
    );
    assert.doesNotMatch(
      source,
      /=\s*isChatGptWebCodex\s*\n?\s*\?\s*JSON\.stringify\(\{/,
      `${modal} must not gate the credential envelope on the codex-only provider id`
    );
  }
});
