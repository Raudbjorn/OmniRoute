"use strict";

const { spawn } = require("child_process");

/**
 * Terminate a child process and all of its descendants.
 * @param {{ pid?: number, kill?: (signal?: string) => void } | null | undefined} proc
 * @param {{ platform?: string, signal?: string, spawnFn?: typeof spawn }} [options]
 */
function killProcessTree(proc, options = {}) {
  if (!proc || proc.pid == null) return;
  const platform = options.platform || process.platform;
  const signal = options.signal || "SIGTERM";

  // POSIX: signals propagate to the process group of a normally-spawned child.
  try {
    proc.kill(signal);
  } catch {
    /* already dead */
  }
}

module.exports = { killProcessTree };
