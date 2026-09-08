import assert from "node:assert/strict";
import test from "node:test";

import {
  getAntigravityContentHeaders,
  getAntigravityIdeNodeHeaders,
  getAntigravityLoadCodeAssistMetadata,
  getAntigravityOAuthUserAgent,
} from "../../open-sse/services/antigravityHeaders.ts";
import {
  clearAntigravityVersionCaches,
  seedAntigravityCliVersionCache,
  seedAntigravityIdeVersionCache,
} from "../../open-sse/services/antigravityVersion.ts";

test.afterEach(() => {
  clearAntigravityVersionCaches();
});

test("IDE and CLI content headers use independent cached versions", () => {
  seedAntigravityIdeVersionCache("2.2.0");
  seedAntigravityCliVersionCache("1.2.0");

  const ideHeaders = new Headers(getAntigravityContentHeaders("ide", "ide-token"));
  const cliHeaders = new Headers(getAntigravityContentHeaders("cli", "cli-token"));

  assert.match(ideHeaders.get("User-Agent") ?? "", /^antigravity\/ide\/2\.2\.0 /);
  assert.match(cliHeaders.get("User-Agent") ?? "", /^antigravity\/cli\/1\.2\.0 /);
  assert.equal(ideHeaders.get("Authorization"), "Bearer ide-token");
  assert.equal(cliHeaders.get("Authorization"), "Bearer cli-token");

  for (const headers of [ideHeaders, cliHeaders]) {
    for (const absent of [
      "x-client-name",
      "x-client-version",
      "x-machine-id",
      "x-vscode-sessionid",
      "X-Goog-Api-Client",
      "Client-Metadata",
    ]) {
      assert.equal(headers.get(absent), null, `${absent} must be absent from content headers`);
    }
  }
});

test("IDE Node OAuth and onboarding headers use the captured Google Node identity", () => {
  seedAntigravityIdeVersionCache("2.1.1");
  const headers = new Headers(getAntigravityIdeNodeHeaders("token"));

  assert.match(
    headers.get("User-Agent") ?? "",
    /^antigravity\/2\.1\.1 [^ ]+\/[^ ]+ google-api-nodejs-client\/10\.3\.0$/
  );
  assert.equal(headers.get("X-Goog-Api-Client"), "gl-node/22.21.1");
  assert.equal(headers.get("Authorization"), "Bearer token");
  assert.equal(headers.get("Client-Metadata"), null);
});

test("OAuth User-Agent selection keeps IDE and CLI identities independent", () => {
  seedAntigravityIdeVersionCache("2.2.0");
  seedAntigravityCliVersionCache("1.2.0");

  assert.match(
    getAntigravityOAuthUserAgent("ide"),
    /^antigravity\/2\.2\.0 [^ ]+\/[^ ]+ google-api-nodejs-client\/10\.3\.0$/
  );
  assert.match(getAntigravityOAuthUserAgent("cli"), /^antigravity\/cli\/1\.2\.0 /);
});

test("loadCodeAssist body metadata sends numeric protobuf-JSON enums, not a bare ideType string", () => {
  // Google's backend 403s loadCodeAssist/onboardUser when ideType is sent as
  // the string "ANTIGRAVITY" with platform/pluginType omitted — verified via
  // a live side-by-side against 9router (same account, same host) using the
  // full enum shape below, which succeeded. See antigravityHeaders.ts for
  // the full incident note.
  const metadata = getAntigravityLoadCodeAssistMetadata();
  assert.deepEqual(metadata, { ideType: 9, platform: metadata.platform, pluginType: 2 });
  assert.equal(typeof metadata.platform, "number");
});
