import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import {
  __setExec,
  apply,
  revert,
  type ExecFileFn,
} from "../../src/mitm/inspector/systemProxyConfig.ts";

interface Call {
  file: string;
  args: string[];
}

function makeRecorder(stdoutByCmd: Record<string, string> = {}): {
  calls: Call[];
  exec: ExecFileFn;
} {
  const calls: Call[] = [];
  const exec: ExecFileFn = async (file, args) => {
    calls.push({ file, args });
    const key = `${file} ${args.join(" ")}`;
    for (const [pattern, out] of Object.entries(stdoutByCmd)) {
      if (key.includes(pattern)) return { stdout: out, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { calls, exec };
}

test("Linux apply uses gsettings with array args", async (t) => {
  const orig = os.platform;
  (os as { platform: () => NodeJS.Platform }).platform = () => "linux" as NodeJS.Platform;
  t.after(() => {
    (os as { platform: () => NodeJS.Platform }).platform = orig;
  });

  const { calls, exec } = makeRecorder({
    "get org.gnome.system.proxy mode": "'none'\n",
    "get org.gnome.system.proxy.http host": "''\n",
  });
  const restore = __setExec(exec);
  t.after(restore);

  const result = await apply(9090);
  assert.equal(result.platform, "linux");
  const setMode = calls.find(
    (c) => c.args[0] === "set" && c.args[1] === "org.gnome.system.proxy" && c.args[2] === "mode"
  );
  assert.ok(setMode);
  assert.deepEqual(setMode.args, ["set", "org.gnome.system.proxy", "mode", "manual"]);
  const setHost = calls.find(
    (c) =>
      c.args[0] === "set" && c.args[1] === "org.gnome.system.proxy.http" && c.args[2] === "host"
  );
  assert.ok(setHost);
  assert.deepEqual(setHost.args, ["set", "org.gnome.system.proxy.http", "host", "127.0.0.1"]);
  // port string is passed as own arg (no shell interpolation)
  const setPort = calls.find(
    (c) =>
      c.args[0] === "set" && c.args[1] === "org.gnome.system.proxy.http" && c.args[2] === "port"
  );
  assert.ok(setPort);
  assert.equal(setPort.args[3], "9090");
});

test("Linux revert restores recorded gnomeMode", async (t) => {
  const orig = os.platform;
  (os as { platform: () => NodeJS.Platform }).platform = () => "linux" as NodeJS.Platform;
  t.after(() => {
    (os as { platform: () => NodeJS.Platform }).platform = orig;
  });

  const { calls, exec } = makeRecorder();
  const restore = __setExec(exec);
  t.after(restore);

  await revert({
    platform: "linux",
    gnomeMode: "'auto'",
    httpHost: "old.host",
    httpPort: "1234",
    httpsHost: "",
    httpsPort: "",
  });
  const restoreMode = calls.find(
    (c) => c.args[0] === "set" && c.args[1] === "org.gnome.system.proxy" && c.args[2] === "mode"
  );
  assert.ok(restoreMode);
  assert.equal(restoreMode.args[3], "'auto'");
});

test("apply throws sanitized error when exec fails", async (t) => {
  const orig = os.platform;
  (os as { platform: () => NodeJS.Platform }).platform = () => "darwin" as NodeJS.Platform;
  t.after(() => {
    (os as { platform: () => NodeJS.Platform }).platform = orig;
  });

  const exec: ExecFileFn = async () => {
    throw new Error("ENOENT: /usr/bin/networksetup");
  };
  const restore = __setExec(exec);
  t.after(restore);

  await assert.rejects(
    () => apply(8080),
    (err: Error) => {
      // sanitizeErrorMessage strips paths; assert we still get an Error
      assert.ok(err instanceof Error);
      assert.ok(err.message.length > 0);
      return true;
    }
  );
});

test("revert no-ops for unknown platform payload", async (t) => {
  const { calls, exec } = makeRecorder();
  const restore = __setExec(exec);
  t.after(restore);

  await revert(null);
  await revert({ platform: "freebsd" });
  assert.equal(calls.length, 0);
});
