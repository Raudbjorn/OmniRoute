import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { LLMLINGUA_SERVER_SOURCE } from "../../../src/lib/services/installers/llmlinguaServer.ts";

test(
  "LLMLingua HTTP server validates requests and returns the worker's actual compression",
  { skip: process.env.RUN_SERVICES_INT !== "1" },
  async (t) => {
    const dir = mkdtempSync(path.join(import.meta.dirname, ".llmlingua-"));
    const workerFile = path.join(dir, "worker.cjs");
    writeFileSync(
      workerFile,
      `const {parentPort}=require('node:worker_threads'); parentPort.on('message', ({id,text}) => parentPort.postMessage({id,ok:true,text:text.slice(0,5)}));`
    );
    const base = await startServer(t, dir, workerFile);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const response = await fetch(`${base}/compress`, {
      method: "POST",
      body: JSON.stringify({ text: "hello world", compressionRate: 0.5 }),
    });
    assert.deepEqual(await response.json(), { text: "hello", compressed: true, ratio: 5 / 11 });
    for (const body of ["{", JSON.stringify({ text: "hello", compressionRate: -1 })]) {
      const bad = await fetch(`${base}/compress`, { method: "POST", body });
      assert.equal(bad.status, 400);
      assert.ok(!(await bad.text()).includes("at /"));
    }
    const oversized = await fetch(`${base}/compress`, {
      method: "POST",
      body: "x".repeat(1_100_000),
    });
    assert.equal(oversized.status, 413);
    await oversized.text();
  }
);

async function startServer(t: TestContext, dir: string, workerFile?: string) {
  const serverFile = path.join(dir, "server.mjs");
  writeFileSync(
    serverFile,
    LLMLINGUA_SERVER_SOURCE +
      '\nserver.on("listening", () => console.log(server.address().port));\n'
  );
  const inheritedEnv = { ...process.env };
  delete inheritedEnv.LLMLINGUA_WORKER_FILE;
  const child = spawn(process.execPath, [serverFile], {
    env: {
      ...inheritedEnv,
      PORT: "0",
      ...(workerFile === undefined ? {} : { LLMLINGUA_WORKER_FILE: workerFile }),
      LLMLINGUA_WORKER_ARGV: "[]",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const port = await Promise.race([
    once(child.stdout, "data").then(([data]) => Number(String(data).trim())),
    once(child, "exit").then(() => {
      throw new Error("Compression service exited before listening");
    }),
  ]);
  return `http://127.0.0.1:${port}`;
}

for (const workerFile of [
  undefined,
  "relative-worker.cjs",
  path.join(import.meta.dirname, "missing-worker.cjs"),
  "/nonexistent-llmlingua-runtime/worker.cjs",
]) {
  test(
    `LLMLingua stays available with unavailable worker: ${workerFile}`,
    { skip: process.env.RUN_SERVICES_INT !== "1", timeout: 10000 },
    async (t) => {
      const dir = mkdtempSync(path.join(import.meta.dirname, ".llmlingua-"));
      const base = await startServer(t, dir, workerFile);
      for (const endpoint of ["/health", "/healthz"]) {
        assert.equal((await fetch(`${base}${endpoint}`)).status, 200);
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(`${base}/compress`, {
          method: "POST",
          body: JSON.stringify({ text: "hello world" }),
        });
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: "Compression runtime unavailable" });
      }
    }
  );
}
