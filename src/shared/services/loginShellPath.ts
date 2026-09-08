import { execFileSync } from "node:child_process";
import path from "node:path";

/** Merge an extra PATH string into a base PATH: de-duped, base entries kept first. */
export function mergeShellPath(
  basePath: string,
  extraPath: string,
  delimiter: string = path.delimiter
): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...basePath.split(delimiter), ...extraPath.split(delimiter)]) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.join(delimiter);
}

/** Extract the value of the `PATH=` line from `env`-style shell output. */
export function parseShellPathOutput(output: string): string | null {
  if (!output) return null;
  for (const line of output.split("\n")) {
    if (line.startsWith("PATH=")) {
      return line.slice("PATH=".length).trim() || null;
    }
  }
  return null;
}

export interface LoginShellPathOptions {
  platform?: NodeJS.Platform;
  shell?: string;
  /** Injectable shell runner (returns the raw stdout); defaults to a safe execFileSync. */
  runShell?: (shell: string) => string;
}

export function getLoginShellPath(opts: LoginShellPathOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return null;
  const shell = opts.shell || process.env.SHELL || "/bin/bash";
  if (!/^[\w./-]+$/.test(shell)) return null;
  const run =
    opts.runShell ||
    ((sh: string): string =>
      execFileSync(sh, ["-ilc", "command -p env"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }));
  try {
    return parseShellPathOutput(run(shell));
  } catch {
    return null;
  }
}

// The `$SHELL -ilc` spawn costs ~100-500ms, so compute it once per process.
let cached: string | null | undefined;

/** Cached {@link getLoginShellPath} — computed once, reused for every detection/spawn. */
export function getCachedLoginShellPath(): string | null {
  if (cached === undefined) cached = getLoginShellPath();
  return cached;
}
