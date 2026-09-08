import {
  cursorDbCandidatePaths,
  extractCursorTokensFromRows,
  fuzzyExtractCursorTokensFromRows,
  normalizeVscDbValue,
  tryAgentAuth,
  tryIdeAuth,
  verifyLinuxCursorInstalled,
} from "@/lib/cursor/tokenExtractor";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

describe("normalizeVscDbValue", () => {
  it("unwraps a JSON-encoded string", () => {
    assert.equal(normalizeVscDbValue('"abc"'), "abc");
  });

  it("returns the raw string when JSON parse fails", () => {
    assert.equal(normalizeVscDbValue("not-json"), "not-json");
  });

  it("returns the raw string when JSON parses to non-string", () => {
    assert.equal(normalizeVscDbValue("123"), "123");
    assert.equal(normalizeVscDbValue("{}"), "{}");
  });

  it("passes non-strings through unchanged", () => {
    assert.equal(normalizeVscDbValue(42 as unknown as string), 42);
    assert.equal(normalizeVscDbValue(null as unknown as string), null);
  });
});

describe("extractCursorTokensFromRows", () => {
  it("extracts tokens using exact primary keys", () => {
    const tokens = extractCursorTokensFromRows([
      { key: "cursorAuth/accessToken", value: "tok-1" },
      { key: "storage.serviceMachineId", value: "machine-1" },
    ]);
    assert.equal(tokens.accessToken, "tok-1");
    assert.equal(tokens.machineId, "machine-1");
  });

  it("accepts the alternative `cursorAuth/token` key", () => {
    const tokens = extractCursorTokensFromRows([
      { key: "cursorAuth/token", value: "tok-2" },
      { key: "storage.machineId", value: "machine-2" },
    ]);
    assert.equal(tokens.accessToken, "tok-2");
    assert.equal(tokens.machineId, "machine-2");
  });

  it("accepts the alternative `telemetry.machineId` key", () => {
    const tokens = extractCursorTokensFromRows([
      { key: "cursorAuth/accessToken", value: "tok-3" },
      { key: "telemetry.machineId", value: "machine-3" },
    ]);
    assert.equal(tokens.machineId, "machine-3");
  });

  it("prefers the first match and ignores duplicates", () => {
    const tokens = extractCursorTokensFromRows([
      { key: "cursorAuth/accessToken", value: "first" },
      { key: "cursorAuth/token", value: "second" },
    ]);
    assert.equal(tokens.accessToken, "first");
  });

  it("normalizes JSON-encoded values", () => {
    const tokens = extractCursorTokensFromRows([
      { key: "cursorAuth/accessToken", value: '"json-token"' },
      { key: "storage.serviceMachineId", value: '"json-machine"' },
    ]);
    assert.equal(tokens.accessToken, "json-token");
    assert.equal(tokens.machineId, "json-machine");
  });

  it("returns empty on no matches", () => {
    const tokens = extractCursorTokensFromRows([{ key: "irrelevant", value: "x" }]);
    assert.equal(tokens.accessToken, undefined);
    assert.equal(tokens.machineId, undefined);
  });

  it("extracts refresh token when present", () => {
    const tokens = extractCursorTokensFromRows([
      { key: "cursorAuth/accessToken", value: "tok-1" },
      { key: "cursorAuth/refreshToken", value: "ref-1" },
      { key: "storage.serviceMachineId", value: "machine-1" },
    ]);
    assert.equal(tokens.accessToken, "tok-1");
    assert.equal(tokens.refreshToken, "ref-1");
    assert.equal(tokens.machineId, "machine-1");
  });
});

describe("fuzzyExtractCursorTokensFromRows", () => {
  it("matches keys by substring containing `accesstoken` and `machineid`", () => {
    const tokens = fuzzyExtractCursorTokensFromRows([
      { key: "cursorAuth/someOtherAccessTokenKey", value: "fallback-token" },
      { key: "storage.someMachineId", value: "fallback-machine" },
    ]);
    assert.equal(tokens.accessToken, "fallback-token");
    assert.equal(tokens.machineId, "fallback-machine");
  });

  it("preserves already-found tokens (passes existing through)", () => {
    const tokens = fuzzyExtractCursorTokensFromRows(
      [
        { key: "cursorAuth/someOtherAccessTokenKey", value: "fallback-token" },
        { key: "storage.someMachineId", value: "fallback-machine" },
      ],
      { accessToken: "already-have-it" }
    );
    assert.equal(tokens.accessToken, "already-have-it");
    assert.equal(tokens.machineId, "fallback-machine");
  });

  it("is case-insensitive on the key match", () => {
    const tokens = fuzzyExtractCursorTokensFromRows([
      { key: "Some.ACCESSTOKEN.suffix", value: "tok" },
      { key: "Some.MACHINEID.suffix", value: "mid" },
    ]);
    assert.equal(tokens.accessToken, "tok");
    assert.equal(tokens.machineId, "mid");
  });
});

describe("cursorDbCandidatePaths", () => {
  it("returns a single path on Linux", () => {
    const paths = cursorDbCandidatePaths("linux", { home: "/home/test" });
    assert.deepEqual(paths, ["/home/test/.config/Cursor/User/globalStorage/state.vscdb"]);
  });

  it("returns empty array for unsupported platforms", () => {
    assert.deepEqual(cursorDbCandidatePaths("freebsd" as NodeJS.Platform, { home: "/x" }), []);
  });
});

describe("verifyLinuxCursorInstalled (port: 9router#313)", () => {
  const okExec = async () => ({ stdout: "/usr/bin/cursor\n", stderr: "" });
  const failExec = async () => {
    throw new Error("which: no cursor in PATH");
  };
  const okAccess = async () => {};
  const failAccess = async () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };

  it("returns true when `which cursor` succeeds (does not probe the .desktop file)", async () => {
    let accessCalled = false;
    const installed = await verifyLinuxCursorInstalled({
      execFile: okExec,
      access: async () => {
        accessCalled = true;
      },
      home: "/home/test",
    });
    assert.equal(installed, true);
    assert.equal(accessCalled, false);
  });

  it("falls back to the cursor.desktop launcher when `which` fails", async () => {
    let probedPath = "";
    const installed = await verifyLinuxCursorInstalled({
      execFile: failExec,
      access: async (p) => {
        probedPath = p;
      },
      home: "/home/test",
    });
    assert.equal(installed, true);
    assert.equal(probedPath, "/home/test/.local/share/applications/cursor.desktop");
  });

  it("returns false when neither `which` nor the .desktop file resolve (phantom config)", async () => {
    const installed = await verifyLinuxCursorInstalled({
      execFile: failExec,
      access: failAccess,
      home: "/home/test",
    });
    assert.equal(installed, false);
  });

  it("probes `which cursor` with a fixed binary name and a bounded timeout", async () => {
    let calledWith: { file: string; args: string[]; timeout: number } | null = null;
    const installed = await verifyLinuxCursorInstalled({
      execFile: async (file, args, options) => {
        calledWith = { file, args, timeout: options.timeout };
        return { stdout: "/usr/bin/cursor", stderr: "" };
      },
      access: okAccess,
      home: "/home/test",
    });
    assert.equal(installed, true);
    assert.deepEqual(calledWith, {
      file: "which",
      args: ["cursor"],
      timeout: 5000,
    });
  });
});

describe("tryAgentAuth", () => {
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cursor-agent-auth-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_USERPROFILE !== undefined) {
      process.env.USERPROFILE = ORIGINAL_USERPROFILE;
    } else {
      delete process.env.USERPROFILE;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("finds a token in the primary auth.json candidate", async () => {
    const authDir = path.join(tmpHome, ".config", "cursor");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, "auth.json"),
      JSON.stringify({ accessToken: "primary-token" })
    );

    const result = await tryAgentAuth();
    assert.equal(result.found, true);
    assert.equal(result.accessToken, "primary-token");
    assert.equal(result.source, "cursor-agent");
  });

  it("falls back to agent-cli-state.json when auth.json is missing", async () => {
    const stateDir = path.join(tmpHome, ".cursor");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "agent-cli-state.json"),
      JSON.stringify({ accessToken: "fallback-token" })
    );

    const result = await tryAgentAuth();
    assert.equal(result.found, true);
    assert.equal(result.accessToken, "fallback-token");
    assert.equal(result.source, "cursor-agent");
  });

  it("reports not found when neither candidate has a usable accessToken", async () => {
    const stateDir = path.join(tmpHome, ".cursor");
    fs.mkdirSync(stateDir, { recursive: true });
    // Schema differs from what's expected — no accessToken field.
    fs.writeFileSync(
      path.join(stateDir, "agent-cli-state.json"),
      JSON.stringify({ authId: "some-id", displayName: "someone" })
    );

    const result = await tryAgentAuth();
    assert.equal(result.found, false);
    assert.equal(result.error, "cursor-agent auth.json not found");
  });

  it("reports not found when neither file exists", async () => {
    const result = await tryAgentAuth();
    assert.equal(result.found, false);
    assert.equal(result.error, "cursor-agent auth.json not found");
  });

  it("reports not found (does not throw) when auth.json contains malformed JSON", async () => {
    const authDir = path.join(tmpHome, ".config", "cursor");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "auth.json"), "{ this is not valid json ");

    const result = await tryAgentAuth();
    assert.equal(result.found, false);
    assert.equal(result.error, "cursor-agent auth.json not found");
  });

  it("falls through to the second candidate when the primary file is malformed JSON", async () => {
    const authDir = path.join(tmpHome, ".config", "cursor");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "auth.json"), "not json at all");

    const stateDir = path.join(tmpHome, ".cursor");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "agent-cli-state.json"),
      JSON.stringify({ accessToken: "fallback-after-malformed" })
    );

    const result = await tryAgentAuth();
    assert.equal(result.found, true);
    assert.equal(result.accessToken, "fallback-after-malformed");
  });
});

describe("tryIdeAuth", () => {
  let originalPlatformDescriptor: PropertyDescriptor | undefined;
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
  let tmpHome: string | undefined;

  beforeEach(() => {
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_USERPROFILE !== undefined) {
      process.env.USERPROFILE = ORIGINAL_USERPROFILE;
    } else {
      delete process.env.USERPROFILE;
    }
    if (tmpHome) {
      fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      tmpHome = undefined;
    }
  });

  it("dispatches to the unsupported-platform branch for a platform with no candidate paths", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });

    const result = await tryIdeAuth();
    assert.equal(result.found, false);
    assert.equal(result.error, "Unsupported platform");
  });
});
