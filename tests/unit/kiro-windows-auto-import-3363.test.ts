// ENVIRONMENT NOTE (sandbox better-sqlite3 / glibc limitation, not a code defect):
// This test constructs or exercises a real better-sqlite3-backed SQLite database.
// better-sqlite3 is a native addon; production and CI load it normally, but some
// sandboxes/dev boxes ship a system glibc older than the prebuilt binary requires
// ("GLIBC_2.29 not found"), so the native module fails to dlopen and any test that
// reaches better-sqlite3 directly (or asserts stdout that the load-failure warning
// would pollute) fails HERE while passing in CI. This is a known environment
// limitation, not a defect in the code under test: the OmniRoute runtime itself
// cascades to node:sqlite/sql.js when better-sqlite3 is unavailable. See
// tests/unit/_helpers/betterSqlite3Availability.ts for a guard helper.
/**
 * Regression guard for #3363 — Kiro auto-import failed on Windows because
 * tryKiroCliSqlite() only probed the Linux/macOS path
 * (~/.local/share/kiro-cli/data.sqlite3) and never checked the Kiro IDE
 * path that Windows users have: %APPDATA%\kiro\storage.db
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// @ts-ignore — better-sqlite3 has no bundled types in this project

// Set DATA_DIR before importing any app modules so isAuthRequired() reads from
// a fresh, empty settings DB (no password → requireLogin defaults to false).
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-kiro-3363-data-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");

// Import the GET handler at the module level so the DB is initialised once
// before any test runs.
const { GET } = await import("../../src/app/api/oauth/kiro/auto-import/route.ts");

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_APPDATA = process.env.APPDATA;
const ORIGINAL_FETCH = globalThis.fetch;

let tmpHome: string;

test.beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-kiro-3363-"));
  // Reset DB instance so each test gets a clean settings DB (no requireLogin).
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  // Override HOME so homedir() returns a temp dir where no kiro-cli DB exists.
  process.env.HOME = tmpHome;
  // On Windows os.homedir() reads USERPROFILE (not HOME), so isolate it too —
  // otherwise the probe reads the real ~/.aws/sso/cache and can find an actual
  // (e.g. external_idp organization) Kiro login on the test host.
  process.env.USERPROFILE = tmpHome;
  // Ensure APPDATA is unset by default; individual tests that need it set it.
  delete process.env.APPDATA;
});

test.afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_USERPROFILE !== undefined) {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  } else {
    delete process.env.USERPROFILE;
  }
  if (ORIGINAL_APPDATA !== undefined) {
    process.env.APPDATA = ORIGINAL_APPDATA;
  } else {
    delete process.env.APPDATA;
  }
  globalThis.fetch = ORIGINAL_FETCH;
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Helper to call the GET handler and parse the JSON body.
async function callGet(): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new Request("http://localhost/api/oauth/kiro/auto-import");
  const response = await GET(request);
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}
