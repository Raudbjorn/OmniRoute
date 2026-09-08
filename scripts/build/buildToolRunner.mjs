import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Absolute path of a tool's own `bin` entry inside the local dependency tree,
 * or `null` when the package (or the entry it advertises) is not there.
 *
 * @param {string} packageName Package that ships the tool, e.g. `"esbuild"`.
 * @param {string} binName Key in that package's `bin` map, e.g. `"esbuild"`.
 * @param {string} [root] Directory holding `node_modules` (defaults to repo root).
 * @returns {string | null}
 */
export function resolveLocalBinEntry(packageName, binName, root = ROOT) {
  try {
    const packageJsonPath = join(root, "node_modules", packageName, "package.json");
    if (!existsSync(packageJsonPath)) return null;
    const meta = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const relative = typeof meta.bin === "string" ? meta.bin : meta.bin?.[binName];
    if (!relative) return null;
    const absolute = join(root, "node_modules", packageName, relative);
    return existsSync(absolute) ? absolute : null;
  } catch {
    return null;
  }
}

export function isNativeExecutable(entryPath) {
  try {
    const fd = openSync(entryPath, "r");
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    closeSync(fd);
    return (
      (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) || // ELF
      head.readUInt32BE(0) === 0xfeedfacf || // Mach-O 64
      head.readUInt32BE(0) === 0xcffaedfe || // Mach-O 64 (LE on disk)
      (head[0] === 0x4d && head[1] === 0x5a)
    );
  } catch {
    return false;
  }
}

export function planBuildToolSpawn({
  binName,
  args,
  entryPath = null,
  entryIsNative = false,
  root = ROOT,
}) {
  // Preferred: the tool's own entry point, spawned with no shim and no shell.
  if (entryPath) {
    return entryIsNative
      ? { file: entryPath, args: [...args], shell: false }
      : { file: process.execPath, args: [entryPath, ...args], shell: false };
  }
  const shim = join(root, "node_modules", ".bin", binName);
  return { file: shim, args: [...args], shell: false };
}

/**
 * Run a locally installed build tool, synchronously, on any platform.
 *
 * @param {string} packageName Package that ships the tool, e.g. `"esbuild"`.
 * @param {string} binName Key in that package's `bin` map, e.g. `"esbuild"`.
 * @param {readonly string[]} args Arguments for the tool.
 * @param {import("node:child_process").ExecFileSyncOptions} [options] Passed to `execFileSync`.
 * @returns {void}
 */
export function runBuildTool(packageName, binName, args, options = {}) {
  const entryPath = resolveLocalBinEntry(packageName, binName);
  const plan = planBuildToolSpawn({
    binName,
    args,
    entryPath,
    entryIsNative: entryPath ? isNativeExecutable(entryPath) : false,
  });
  execFileSync(plan.file, plan.args, plan.shell ? { ...options, shell: true } : options);
}
