import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "../data-dir.mjs";

// #9455: "supervisor" must be tracked so killAllSubprocesses() can stop the
// supervisor process, not just the child server it spawned (and respawns).
const SERVICES = ["server", "supervisor", "mitm", "tunnel/cloudflared", "tunnel/tailscale"];

function getServicePidPath(service) {
  return join(resolveDataDir(), service, ".pid");
}

export function writePidFile(service, pid) {
  try {
    const dir = join(resolveDataDir(), service);
    mkdirSync(dir, { recursive: true });
    writeFileSync(getServicePidPath(service), String(pid), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function readPidFile(service) {
  try {
    const file = getServicePidPath(service);
    if (!existsSync(file)) return null;
    const pid = parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function cleanupPidFile(service) {
  try {
    unlinkSync(getServicePidPath(service));
  } catch {}
}

export function killAllSubprocesses() {
  for (const service of SERVICES) {
    const pid = readPidFile(service);
    if (!pid) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    cleanupPidFile(service);
  }
}

export function isPidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForServer(port, timeout = 60000) {
  const start = Date.now();
  let tcpListeningSince = null;
  while (Date.now() - start < timeout) {
    const outcome = await pollHealthOnce(port);
    if (outcome === "ready") return true;
    if (outcome === "fast-reject") {
      if (tcpListeningSince === null) tcpListeningSince = Date.now();
      if (Date.now() - tcpListeningSince >= 3000) return true;
    } else {
      // "hanging" (request timed out with no response at all) or
      // "not-listening" — neither counts toward the grace window.
      tcpListeningSince = null;
    }
    await sleep(500);
  }
  return false;
}

// Polls /api/monitoring/health once and classifies the outcome:
// - "ready": got a 2xx HTTP response.
// - "fast-reject": got a non-2xx HTTP response, or the connection was
//   actively refused/reset (not a timeout) — the HTTP server is alive and
//   answering quickly, just not routing this endpoint yet (#2460).
// - "hanging": the request timed out waiting for any response — the
//   process accepted the TCP connection but never answered (#6800).
// - "not-listening": nothing is accepting connections on the port at all.
// #11766: probe both IPv4 and IPv6 loopback to handle servers listening on
// either family (or both).
async function pollHealthOnce(port) {
  const hosts = ["127.0.0.1", "::1"];
  const outcomes = [];

  // Probe both loopback families concurrently
  const results = await Promise.all(
    hosts.map(async (host) => {
      try {
        const res = await fetch(`http://${host}:${port}/api/monitoring/health`, {
          signal: AbortSignal.timeout(2000),
        });
        return { host, outcome: res.ok ? "ready" : "fast-reject" };
      } catch (err) {
        const outcome = err?.name === "TimeoutError" ? "hanging" : "error";
        return { host, outcome };
      }
    })
  );

  outcomes.push(...results.map((r) => r.outcome));

  // If either family is ready, the server is ready
  if (outcomes.includes("ready")) return "ready";

  // If either family is fast-reject, treat as fast-reject
  // (TCP is listening and rejecting, just route not ready yet)
  if (outcomes.includes("fast-reject")) return "fast-reject";

  // If either family is hanging, server accepted TCP but not answering
  // (still booting, must not report as ready per #6800)
  if (outcomes.includes("hanging")) return "hanging";

  // Both families failed — check if either port is actually listening
  // If listening, then errors above are route-level (fast-reject case)
  const listening = await isPortListening(port).catch(() => false);
  return listening ? "fast-reject" : "not-listening";
}

async function isPortListening(port) {
  const net = await import("node:net");
  // #11766: check both IPv4 and IPv6 loopback. Return true if either is listening.
  const hosts = ["127.0.0.1", "::1"];
  const results = await Promise.all(
    hosts.map(
      (host) =>
        new Promise((resolve) => {
          const socket = net.connect({ host, port, timeout: 1000 });
          const finish = (ok) => {
            try {
              socket.destroy();
            } catch {}
            resolve(ok);
          };
          socket.once("connect", () => finish(true));
          socket.once("error", () => finish(false));
          socket.once("timeout", () => finish(false));
        })
    )
  );
  return results.some((ok) => ok);
}

/** Send SIGTERM, wait for cleanup, and escalate only if the process stays alive. */
export async function stopProcessGracefully({
  pid,
  timeoutMs = 5000,
  pollIntervalMs = 100,
  isPidRunning: running = isPidRunning,
  sleep: wait = sleep,
}) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs && running(pid)) {
    await wait(pollIntervalMs);
  }
  if (running(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}
