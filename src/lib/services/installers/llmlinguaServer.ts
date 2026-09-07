/** Installed as an ordinary Node entrypoint; uses the existing LLMLingua ONNX worker. */
export const LLMLINGUA_SERVER_SOURCE = String.raw`
import http from "node:http";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
const workerFile = process.env.LLMLINGUA_WORKER_FILE;
const { z } = createRequire(workerFile)("zod");
const schema = z.object({
  text: z.string().min(1).max(1_000_000),
  model: z.string().max(200).optional(),
  compressionRate: z.number().gt(0).lte(1).optional(),
});
let worker;
let pending;
let nextId = 0;
function reply(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
async function compress(payload) {
  if (!worker) {
    worker = new Worker(workerFile, { execArgv: JSON.parse(process.env.LLMLINGUA_WORKER_ARGV || "[]") });
    const current = worker;
    worker.on("message", message => { if (worker === current) pending?.(message); });
    const failed = () => { if (worker !== current) return; pending?.({ ok: false }); worker = undefined; };
    worker.on("error", failed);
    worker.on("exit", failed);
  }
  return new Promise(resolve => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending = undefined;
      const old = worker;
      worker = undefined;
      void old?.terminate();
      resolve({ ok: false });
    }, 60_000);
    pending = message => {
      if (message.id !== undefined && message.id !== id) return;
      clearTimeout(timer);
      pending = undefined;
      resolve(message);
    };
    worker.postMessage({ ...payload, id });
  });
}
let busy = false;
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && ["/health", "/healthz"].includes(req.url)) {
    reply(res, 200, { status: "healthy", service: "llmlingua" });
    return;
  }
  if (req.method !== "POST" || req.url !== "/compress") { reply(res, 404, { error: "Not found" }); return; }
  // ponytail: one inference at a time; add a bounded queue if measured throughput needs it.
  if (busy) { reply(res, 429, { error: "Compressor busy" }); return; }
  busy = true;
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > 1_048_576) { req.resume(); reply(res, 413, { error: "Request too large" }); return; }
      chunks.push(chunk);
    }
    const parsed = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) { reply(res, 400, { error: "Invalid compression request" }); return; }
    const result = await compress(parsed.data).catch(() => ({ ok: false }));
    if (!result.ok || typeof result.text !== "string" || !result.text) {
      reply(res, 503, { error: "Compression runtime unavailable" }); return;
    }
    const text = result.text.length <= parsed.data.text.length ? result.text : parsed.data.text;
    reply(res, 200, { text, compressed: text !== parsed.data.text, ratio: text.length / parsed.data.text.length });
  } catch {
    reply(res, 400, { error: "Invalid compression request" });
  } finally { busy = false; }
});
server.requestTimeout = 65_000;
server.listen(Number(process.env.PORT || "20135"), "127.0.0.1");
`;
