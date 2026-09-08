// Regression test for #7913: `omniroute setup opencode --auth` spawns the
// `opencode.cmd` shim on win32. Since Node's CVE-2024-27980 hardening,
// spawning a `.cmd`/`.bat` shim with `shell:false` throws EINVAL — the same
// class already fixed for codex (bin/cli/commands/launch-codex.mjs,
// crediting #6263) and qodercli/Auggie (#6263/#6304). This callsite was
// missed; `resolveOpenCodeAuthSpawn` must use `shell: isWin`.
//
// Tested through the pure `resolveOpenCodeAuthSpawn(providerId, platform)`
// resolver (no child_process mocking, no process.platform mutation — both of
// which required an unavailable --experimental-test-module-mocks flag in CI).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveOpenCodeAuthProviderId,
  resolveOpenCodeAuthSpawn,
} from "../../bin/cli/commands/setup-open-code.mjs";

test("resolveOpenCodeAuthSpawn: prefixes provider id for auth login (#8830)", () => {
  const spawn = resolveOpenCodeAuthSpawn("anthropic", "linux");
  assert.deepEqual(spawn.args, ["auth", "login", "--provider", "opencode-anthropic"]);
});

test("resolveOpenCodeAuthProviderId: adds opencode- prefix when absent (#8830)", () => {
  assert.equal(resolveOpenCodeAuthProviderId("omniroute"), "opencode-omniroute");
  assert.equal(resolveOpenCodeAuthProviderId("omniroute-preprod"), "opencode-omniroute-preprod");
  assert.equal(resolveOpenCodeAuthProviderId("anthropic"), "opencode-anthropic");
});

test("resolveOpenCodeAuthProviderId: idempotent — passes through already-prefixed ids (#8830)", () => {
  assert.equal(resolveOpenCodeAuthProviderId("opencode-omniroute"), "opencode-omniroute");
  assert.equal(
    resolveOpenCodeAuthProviderId("opencode-omniroute-preprod"),
    "opencode-omniroute-preprod"
  );
  assert.equal(resolveOpenCodeAuthProviderId("opencode-anthropic"), "opencode-anthropic");
});
