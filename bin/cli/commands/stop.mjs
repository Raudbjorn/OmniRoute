import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { t } from "../i18n.mjs";
import {
  cleanupPidFile,
  isPidRunning,
  killAllSubprocesses,
  readPidFile,
  sleep,
  stopProcessGracefully,
} from "../utils/pid.mjs";

const execFileAsync = promisify(execFile);

export function registerStop(program) {
  program
    .command("stop")
    .description(t("stop.description"))
    .action(async (opts) => {
      const exitCode = await runStopCommand(opts);
      if (exitCode !== 0) process.exit(exitCode);
    });
}

export async function runStopCommand(opts = {}) {
  const pid = readPidFile("server");
  // #9455: when the server was started with a supervisor (the default), killing only
  // the child lets the supervisor respawn it immediately. The supervisor's PID is
  // persisted separately by serve.mjs; SIGTERM it FIRST so its handler sets
  // isShuttingDown=true and stops the child cleanly without respawning.
  const supervisorPid = readPidFile("supervisor");

  if (pid && isPidRunning(pid)) {
    console.log(t("stop.stopping", { pid }));
    try {
      if (supervisorPid && isPidRunning(supervisorPid)) {
        try {
          process.kill(supervisorPid, "SIGTERM");
        } catch {}
        // Give the supervisor a moment to cascade the shutdown to its child so we
        // don't race the child kill against the supervisor's own child stop.
        await sleep(300);
      }

      // Allow the server to finish its graceful shutdown before escalation.
      if (isPidRunning(pid)) {
        await stopProcessGracefully({ pid, timeoutMs: 5000, isPidRunning, sleep });
      }

      killAllSubprocesses();
      cleanupPidFile("server");
      cleanupPidFile("supervisor");
      console.log(t("stop.stopped"));
      return 0;
    } catch (err) {
      console.error(
        t("common.error", { message: err instanceof Error ? err.message : String(err) })
      );
      return 1;
    }
  }

  const port = opts.port ? parseInt(String(opts.port), 10) : 20128;
  if (pid === null) {
    console.log(t("stop.portFallback"));
    // #9455: a stale supervisor PID file would let the port-fallback stop also
    // leave the supervisor running and respawning. Stop it first.
    if (supervisorPid && isPidRunning(supervisorPid)) {
      try {
        process.kill(supervisorPid, "SIGTERM");
      } catch {}
    }
    const portFreed = await killByPort(port);
    killAllSubprocesses();
    cleanupPidFile("server");
    cleanupPidFile("supervisor");

    if (portFreed) {
      console.log(t("stop.stopped"));
    } else {
      console.log(t("stop.notRunning"));
    }
    return 0;
  }

  console.log(t("stop.notRunning"));
  return 0;
}

export async function killByPort(port, deps = {}) {
  const exec = deps.execFileAsync || execFileAsync;
  const kill = deps.processKill || ((p, sig) => process.kill(p, sig));
  const running = deps.isPidRunning || isPidRunning;
  const wait = deps.sleep || sleep;
  const platform = deps.platform || process.platform;

  return killByPortPosix(port, { exec, kill, running, wait });
}

function isTestEnvironment() {
  return (
    process.env.NODE_ENV === "test" ||
    (process.env.DATA_DIR && /omniroute-(cli-)?test/i.test(process.env.DATA_DIR))
  );
}

async function killByPortPosix(port, { exec, kill, running, wait }) {
  if (isTestEnvironment()) {
    return true;
  }
  let pids = [];
  try {
    const { stdout } = await exec("lsof", ["-ti", `:${port}`]);
    pids = stdout
      .trim()
      .split("\n")
      .map((p) => parseInt(p, 10))
      .filter((p) => Number.isFinite(p) && p > 0);
  } catch {
    // lsof not available or no process on port
  }
  return terminatePids(pids, { kill, running, wait });
}

async function terminatePids(pids, { kill, running, wait }) {
  if (pids.length === 0) return true;
  for (const p of pids) {
    try {
      kill(p, "SIGTERM");
    } catch {}
  }
  await wait(1000);
  for (const p of pids) {
    try {
      if (running(p)) kill(p, "SIGKILL");
    } catch {}
  }
  // Confirm the port is free: any PID still alive means we failed.
  return pids.every((p) => !running(p));
}
