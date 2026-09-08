/** The npm binary to spawn on this platform. */
export function npmBin() {
  const isBun = Boolean(process.versions.bun);

  return isBun ? "bun" : "npm";
}

/**
 * `execFile` / `spawnSync` options for an npm call.
 *
 * @param {NodeJS.Platform} platform
 * @param {{ timeoutMs?: number, stdio?: string }} [options]
 */
export function npmExecOptions(options = {}) {
  const base = {};
  if (options.timeoutMs !== undefined) base.timeout = options.timeoutMs;
  if (options.stdio !== undefined) base.stdio = options.stdio;
  return { ...base, shell: false };
}
