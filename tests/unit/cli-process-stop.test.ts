import assert from "node:assert/strict";
import test from "node:test";
import { stopProcessGracefully } from "../../bin/cli/utils/pid.mjs";

test("process stop sends SIGTERM and escalates only while the process is still alive", async (t) => {
  const signals: Array<string | number | undefined> = [];
  t.mock.method(process, "kill", (_pid: number, signal?: string | number) => {
    signals.push(signal);
    return true;
  });
  let running = true;
  await stopProcessGracefully({
    pid: 4242,
    isPidRunning: () => running,
    sleep: async () => {
      running = false;
    },
  });
  assert.deepEqual(signals, ["SIGTERM"]);
  signals.length = 0;
  await stopProcessGracefully({ pid: 4242, timeoutMs: 0, isPidRunning: () => true });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
