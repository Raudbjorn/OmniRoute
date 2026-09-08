import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-llmlingua-installer-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

// DB bootstrap
const core = await import("../../../../src/lib/db/core.ts");
const db = core.getDbInstance();

const llmlingua = await import("../../../../src/lib/services/installers/llmlingua.ts");

test("llmlingua service is seeded disabled and remains local-only", async () => {
  const { isLocalOnlyPath } = await import("../../../../src/server/authz/routeGuard.ts");
  assert.equal(isLocalOnlyPath("/api/services/llmlingua/start"), true);
  const row = db
    .prepare("SELECT auto_start, status FROM version_manager WHERE tool = ?")
    .get("llmlingua") as { auto_start: number; status: string };
  assert.equal(row.auto_start, 0);
  assert.equal(row.status, "not_installed");
});

test("llmlingua installer: getInstalledVersion returns null when not installed", async () => {
  const version = await llmlingua.getInstalledVersion();
  assert.equal(version, null);
});

test("llmlingua installer: install creates server script and updates version_manager DB", async () => {
  const result = await llmlingua.install("1.0.0");
  assert.equal(result.installedVersion, "1.0.0");
  assert.ok(fs.existsSync(llmlingua.getServerScriptPath()));

  const row = db.prepare("SELECT * FROM version_manager WHERE tool = 'llmlingua'").get() as
    { status?: string; port?: number } | undefined;
  assert.ok(row);
  assert.equal(row?.status, "stopped");
  assert.equal(row?.port, 20135);
});

test("llmlingua installer: resolveSpawnArgs builds node server spawn arguments", () => {
  const spawnArgs = llmlingua.resolveSpawnArgs(20135);
  assert.equal(spawnArgs.command, process.execPath);
  assert.deepEqual(spawnArgs.args, [llmlingua.getServerScriptPath()]);
  assert.equal(spawnArgs.env.PORT, "20135");
});

test("llmlingua installer: startup recreates a missing server without replacing existing files", () => {
  const script = llmlingua.getServerScriptPath();
  const original = fs.readFileSync(script, "utf8");
  fs.unlinkSync(script);
  llmlingua.resolveSpawnArgs();
  assert.equal(fs.readFileSync(script, "utf8"), original);
  fs.writeFileSync(script, original + "\n// retained");
  llmlingua.resolveSpawnArgs();
  assert.equal(fs.readFileSync(script, "utf8"), original + "\n// retained");
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
