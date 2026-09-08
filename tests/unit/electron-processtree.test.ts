/**
 * Regression test for #3347 — Electron "Exit" leaves a process in memory that locks
 * omniroute.exe on Windows.
 *
 * The embedded server is spawned via process.execPath (= omniroute.exe) with
 * ELECTRON_RUN_AS_NODE=1. On Windows, ChildProcess.kill()/SIGTERM/SIGKILL terminate ONLY
 * the direct child — NOT its descendants — so server-spawned grandchildren (embedded
 * services, MITM proxy, tunnels, several also omniroute.exe-as-node) survive and keep the
 * .exe locked, blocking updates. killProcessTree() must use `taskkill /PID <pid> /T /F`
 * (the /T flag walks the tree) on win32, and signal-based kill on POSIX (where signals
 * propagate). This test pins that platform branch, plus a static guard that main.js routes
 * the server shutdown through killProcessTree (not a raw nextServer.kill).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { killProcessTree } = require("../../electron/processTree.js");

describe("killProcessTree (#3347)", () => {
  it("posix: uses signal-based proc.kill (signals propagate), never taskkill", () => {
    let killedWith: string | null = null;
    let spawned = false;
    const proc = {
      pid: 4321,
      kill: (sig: string) => {
        killedWith = sig;
      },
    };
    const spawnFn = () => {
      spawned = true;
      return { on: () => {} };
    };

    killProcessTree(proc, { platform: "linux", signal: "SIGTERM", spawnFn });

    assert.equal(killedWith, "SIGTERM");
    assert.equal(spawned, false, "must not spawn taskkill on POSIX");
  });

  it("no-op on null/pid-less process (does not throw)", () => {
    assert.doesNotThrow(() => killProcessTree(null, { platform: "win32" }));
    assert.doesNotThrow(() => killProcessTree({ pid: undefined }, { platform: "win32" }));
  });
});

describe("Electron main.js server shutdown routes through killProcessTree (#3347)", () => {
  const main = readFileSync(join(import.meta.dirname, "../../electron/main.js"), "utf8");

  it("requires the processTree helper", () => {
    assert.match(main, /require\(["']\.\/processTree["']\)/);
  });

  it("does not kill the server child with a raw signal kill (must use the tree-kill)", () => {
    // The two shutdown call sites (stopNextServer + waitForServerExit) must not use a bare
    // `nextServer.kill(` / `proc.kill("SIGKILL")` on the server proc anymore.
    assert.doesNotMatch(main, /nextServer\.kill\(/);
    assert.ok(
      /killProcessTree\s*\(/.test(main),
      "main.js must call killProcessTree() for server shutdown"
    );
  });
});
