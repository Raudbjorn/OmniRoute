import assert from "node:assert/strict";
import test from "node:test";
import { resolveOpenCommand } from "../../bin/cli/commands/dashboard.mjs";

test("openFallback: linux/other uses 'xdg-open' command", () => {
  const { cmd, args } = resolveOpenCommand("linux", "http://localhost:20128");
  assert.equal(cmd, "xdg-open");
  assert.deepEqual(args, ["http://localhost:20128"]);
});

test("openFallback: unknown platform falls back to xdg-open", () => {
  const { cmd, args } = resolveOpenCommand("aix", "http://localhost:20128");
  assert.equal(cmd, "xdg-open");
  assert.deepEqual(args, ["http://localhost:20128"]);
});

test("openFallback: URL with special characters is passed through verbatim", () => {
  const url = "http://localhost:20128/dashboard?q=test&filter=a+b";
  const { cmd, args } = resolveOpenCommand("linux", url);
  assert.equal(cmd, "xdg-open");
  assert.equal(args[0], url);
});
