import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  assertNativeDriverSelected,
  buildSmokeEnv,
  DB_TOUCH_PATH,
  FATAL_LOG_PATTERNS,
  LINUX_EXECUTABLE_NAMES,
  waitForDatabaseOpen,
} from "../../scripts/dev/smoke-electron-packaged.mjs";

test("electron smoke discovers the default Linux executable name", () => {
  assert.ok(LINUX_EXECUTABLE_NAMES.includes("omniroute-desktop"));
});

test("electron smoke env allowlists runtime variables and drops secrets", () => {
  const dataDir = path.join("/tmp", "omniroute-electron-smoke-test");
  const env = buildSmokeEnv({
    currentPlatform: "linux",
    dataDir,
    parentEnv: {
      DISPLAY: ":99",
      GITHUB_TOKEN: "should-not-leak",
      PATH: "/usr/bin",
      SNYK_TOKEN: "should-not-leak",
    },
  });

  // Expected values are built with path.join so the assertions hold on every
  // host platform: buildSmokeEnv() composes its redirected paths with join(),
  // which yields backslashes on Windows even when currentPlatform is "linux".
  assert.equal(env.DATA_DIR, dataDir);
  assert.equal(env.DISPLAY, ":99");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, path.join(dataDir, "home"));
  assert.equal(env.XDG_CONFIG_HOME, path.join(dataDir, "config"));
  assert.equal(env.ELECTRON_ENABLE_LOGGING, "1");
  assert.equal(env.ELECTRON_ENABLE_STACK_DUMPING, "1");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.SNYK_TOKEN, undefined);
});

test("electron smoke treats Electron process errors as fatal startup logs", () => {
  const logs = [
    "[Electron] Unhandled Rejection: Error: startup failed",
    "[Electron] Uncaught Exception: Error: startup failed",
  ];

  for (const log of logs) {
    assert.ok(
      FATAL_LOG_PATTERNS.some((pattern) => pattern.test(log)),
      `${log} should match a fatal log pattern`
    );
  }
});

// #7592: on a cold restart against an already-persisted DATA_DIR, a stale-ABI
// better-sqlite3 binary used to fail to load and silently fall through to the
// sql.js (WASM) driver. These are the regression guards for that assertion.
test("electron smoke accepts every native SQLite driver on the startup log", () => {
  for (const driver of ["bun:sqlite", "better-sqlite3", "node:sqlite"]) {
    assert.doesNotThrow(() =>
      assertNativeDriverSelected(`[electron] [DB] Driver: ${driver} | file: /data/storage.sqlite`)
    );
  }
});

test("electron smoke flags a cold-restart fallback to the sql.js WASM driver", () => {
  assert.throws(
    () => assertNativeDriverSelected("[electron] [DB] Driver: sql.js | file: /data/storage.sqlite"),
    /fell back to the sql\.js \(WASM\) driver/
  );
});

test("electron smoke flags startup logs missing any driver selection line", () => {
  assert.throws(
    () => assertNativeDriverSelected("[electron] [server] listening on 20128"),
    /no database activity/
  );
});

test("electron smoke waits for database-open evidence after touching a DB-backed endpoint", async () => {
  assert.equal(DB_TOUCH_PATH, "/api/monitoring/health");
  let logs = "[electron] [Server] [STARTUP] ready\n";
  setTimeout(() => {
    logs += "[electron] [Server] [DB] Added usage_history.combo_strategy column\n";
  }, 60);
  const seen = await waitForDatabaseOpen(() => logs, { timeoutMs: 2_000, pollMs: 20 });
  assert.match(seen, /\[DB\] Added/);
});

test("electron smoke fails clearly when the database never opens", async () => {
  await assert.rejects(
    () =>
      waitForDatabaseOpen(() => "[electron] [Server] [STARTUP] ready\n", {
        timeoutMs: 120,
        pollMs: 20,
      }),
    /logged no \[DB\]\/\[Migration\] startup line within 120ms/
  );
});

test("electron smoke driver guard: native line, DB evidence and sql.js fallback", () => {
  assert.doesNotThrow(() =>
    assertNativeDriverSelected("[DB] Driver: better-sqlite3 | file: /tmp/x/storage.sqlite\n")
  );
  assert.doesNotThrow(() =>
    assertNativeDriverSelected(
      "[electron] [Server] [DB] Added call_logs.session_tag column\n[electron] [Server] [Migration] Applied: 046_database_settings\n"
    )
  );
  assert.throws(
    () => assertNativeDriverSelected("[DB] Driver: sql.js | file: /tmp/x/storage.sqlite\n"),
    /sql\.js \(WASM\) driver/
  );
  assert.throws(
    () => assertNativeDriverSelected("[STARTUP] nothing here\n"),
    /no database activity/
  );
});
