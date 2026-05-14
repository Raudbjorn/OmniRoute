import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-oauth-kiro-poll-route-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;
const ORIGINAL_REQUIRE_API_KEY = process.env.REQUIRE_API_KEY;

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "test-oauth-kiro-poll-route-secret";
process.env.REQUIRE_API_KEY = "false";

const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const oauthRoute = await import("../../src/app/api/oauth/[provider]/[action]/route.ts");
const providerRegistry = await import("../../src/lib/oauth/providers/index.ts");

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  resetDb();
  await localDb.updateSettings({ requireLogin: false, password: "", cloudEnabled: false });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });

  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }

  if (ORIGINAL_API_KEY_SECRET === undefined) {
    delete process.env.API_KEY_SECRET;
  } else {
    process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
  }

  if (ORIGINAL_REQUIRE_API_KEY === undefined) {
    delete process.env.REQUIRE_API_KEY;
  } else {
    process.env.REQUIRE_API_KEY = ORIGINAL_REQUIRE_API_KEY;
  }
});

test("POST /api/oauth/kiro/poll persists imported metadata on created connection", async () => {
  const originalPollToken = providerRegistry.PROVIDERS.kiro.pollToken;

  providerRegistry.PROVIDERS.kiro.pollToken = async function () {
    return {
      ok: true,
      data: {
        access_token: "poll-access",
        refresh_token: "poll-refresh",
        expires_in: 3600,
        _clientId: "cid",
        _clientSecret: "csecret",
        _region: "us-east-1",
      },
    };
  };

  try {
    const request = new Request("http://localhost/api/oauth/kiro/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceCode: "device-123",
        extraData: { _clientId: "cid", _clientSecret: "csecret", _region: "us-east-1" },
        name: "Imported Name",
        accountName: "Imported Account",
        tagGroupLabel: "aws-kiro-import",
      }),
    });

    const response = await oauthRoute.POST(request, {
      params: Promise.resolve({ provider: "kiro", action: "poll" }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.success, true);

    const connections = await localDb.getProviderConnections({ provider: "kiro" });
    assert.equal(connections.length, 1);

    const created = connections[0] as any;
    assert.equal(created.name, "Imported Name");
    assert.equal(created.displayName, "Imported Account");
    assert.equal(created.group, "aws-kiro-import");
    assert.equal(created.providerSpecificData?.accountName, "Imported Account");
    assert.equal(created.providerSpecificData?.tagGroupLabel, "aws-kiro-import");
  } finally {
    providerRegistry.PROVIDERS.kiro.pollToken = originalPollToken;
  }
});
