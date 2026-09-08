import assert from "node:assert/strict";
import test from "node:test";

import {
  isOmniRouteServiceWorkerScript,
  shouldEnablePwaRegistration,
} from "../../src/shared/utils/pwaRegistration.ts";

test("shouldEnablePwaRegistration disables PWA in development", () => {
  assert.equal(
    shouldEnablePwaRegistration({
      hostname: "app.example.com",
      isDevelopment: true,
    }),
    false
  );
});

test("shouldEnablePwaRegistration disables PWA on loopback hosts", () => {
  for (const hostname of ["localhost", "127.0.0.1", "::1"]) {
    assert.equal(
      shouldEnablePwaRegistration({
        hostname,
        isDevelopment: false,
      }),
      false,
      `${hostname} should not register the OmniRoute service worker`
    );
  }
});

test("shouldEnablePwaRegistration allows non-loopback production hosts", () => {
  assert.equal(
    shouldEnablePwaRegistration({
      hostname: "omniroute.example.com",
      isDevelopment: false,
    }),
    true
  );
});

test("isOmniRouteServiceWorkerScript only matches the OmniRoute service worker path", () => {
  assert.equal(isOmniRouteServiceWorkerScript("https://app.example.com/sw.js"), true);
  assert.equal(isOmniRouteServiceWorkerScript("https://app.example.com/other-sw.js"), false);
  assert.equal(isOmniRouteServiceWorkerScript("not-a-url"), false);
  assert.equal(isOmniRouteServiceWorkerScript(undefined), false);
});
