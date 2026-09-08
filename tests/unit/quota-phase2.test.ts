import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-quota-phase2-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const { parseProviderQuotaHeaders, applyQuotaHeadersToState } =
  await import("../../src/lib/quota/quotaAdapters");
const { getQuotaAnalyticsSummary } = await import("../../src/lib/quota/quotaAnalytics");
const { getActiveQuotaResetItems, resetExpiredQuotaWindows } =
  await import("../../src/lib/quota/quotaResetTimers");
const { recordProviderQuotaUsage, getProviderQuota } =
  await import("../../src/lib/quota/providerQuotaState");
const { getDbInstance } = coreDb;

async function resetStorage() {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("parseProviderQuotaHeaders: parses OpenAI rate limit headers", () => {
  const headers = new Headers({
    "x-ratelimit-limit-tokens": "100000",
    "x-ratelimit-remaining-tokens": "80000",
    "x-ratelimit-reset-tokens": "60s",
  });
  const parsed = parseProviderQuotaHeaders(headers, "openai");
  assert.ok(parsed);
  assert.equal(parsed?.tokenLimit, 100000);
  assert.equal(parsed?.tokensRemaining, 80000);
  assert.equal(parsed?.tokensUsed, 20000);
  assert.equal(parsed?.windowResetMs, 60000);
});

test("parseProviderQuotaHeaders: parses Anthropic rate limit headers", () => {
  const headers = new Headers({
    "anthropic-ratelimit-input-tokens-limit": "50000",
    "anthropic-ratelimit-input-tokens-remaining": "10000",
    "anthropic-ratelimit-input-tokens-reset": "30s",
  });
  const parsed = parseProviderQuotaHeaders(headers, "anthropic");
  assert.ok(parsed);
  assert.equal(parsed?.tokenLimit, 50000);
  assert.equal(parsed?.tokensRemaining, 10000);
  assert.equal(parsed?.tokensUsed, 40000);
  assert.equal(parsed?.windowResetMs, 30000);
});

test("applyQuotaHeadersToState & getQuotaAnalyticsSummary: records and aggregates quota analytics", () => {
  const connId = "test-conn-p2-01";
  const model = "gpt-4o";
  const headers = {
    "x-ratelimit-limit-tokens": "100000",
    "x-ratelimit-remaining-tokens": "20000",
    "x-ratelimit-reset-tokens": "120s",
  };

  applyQuotaHeadersToState(connId, model, headers, "openai");

  const snapshot = getProviderQuota(connId, model);
  assert.ok(snapshot);
  assert.equal(snapshot?.tokensUsed, 80000);
  assert.equal(snapshot?.tokenLimit, 100000);

  const analytics = getQuotaAnalyticsSummary();
  assert.ok(analytics.totalConnectionsTracked > 0);
  assert.ok(analytics.connections.some((c) => c.connectionId === connId));
});
