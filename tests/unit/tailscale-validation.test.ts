import assert from "node:assert/strict";
import test from "node:test";

import { tailscaleEnableSchema } from "../../src/app/api/tunnels/tailscale/routeUtils.ts";

test("tailscale enable accepts only valid TCP ports", () => {
  assert.equal(tailscaleEnableSchema.safeParse({ port: 1 }).success, true);
  assert.equal(tailscaleEnableSchema.safeParse({ port: 65535 }).success, true);
  assert.equal(tailscaleEnableSchema.safeParse({ port: 0 }).success, false);
  assert.equal(tailscaleEnableSchema.safeParse({ port: 65536 }).success, false);
});
