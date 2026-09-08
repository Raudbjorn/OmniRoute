import { execFile, execFileSync, spawn } from "child_process";

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRoot(): boolean {
  try {
    return !!(process.getuid && process.getuid() === 0);
  } catch {
    return false;
  }
}

export function isSudoAvailable(): boolean {
  try {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
    execFileSync("sh", ["-c", "command -v sudo"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        // Node's execFile already sets error.message to "Command failed: <cmd>"
        // (for non-zero exit) or "spawn <cmd> ENOENT" (for missing binary).
        // Re-prefixing with "Command failed: " would double the prefix for the
        // non-zero exit case. Surface Node's message directly and only append
        // stderr when it contains additional context. (#3641)
        reject(new Error(getErrorMessage(error) + (stderr ? `\n${stderr}` : "")));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Truthy-env check for `OMNIROUTE_NO_SUDO`. Inlined (not imported from
 * `src/lib/db/apiKeys/modelPermissions.ts`) because that module pulls in the DB
 * read-cache graph and importing it here — into a low-level MITM primitive that
 * is loaded during cert bootstrap — would create a module cycle. The same tiny
 * helper is already duplicated locally in `runtimeSettings.ts` / `db/settings.ts`
 * for exactly this reason; behavior matches `isTruthyEnvFlag` byte-for-byte
 * (`1|true|yes|on`, case-insensitive, trimmed).
 */
export function isNoSudoEnv(): boolean {
  const value = process.env.OMNIROUTE_NO_SUDO;
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

export interface ResolvedSpawn {
  finalCommand: string;
  finalArgs: string[];
  stripSudo: boolean;
  needsPassword: boolean;
}

/**
 * Pure resolver for the sudo-stripping decision. Extracted so tests can assert
 * the resulting argv (and whether a password is written to stdin) WITHOUT
 * spawning a real `sudo`. `root`/`sudoAvailable` default to the live probes and
 * can be injected for deterministic tests; `noSudo` defaults to the
 * `OMNIROUTE_NO_SUDO` env flag.
 *
 * Strips the leading `sudo -S` (running the underlying command directly, same
 * user, no elevation) when running as root, when `sudo` is unavailable, OR when
 * the operator opts into root-less mode via `OMNIROUTE_NO_SUDO` (#6122). No
 * runtime value is ever interpolated into a shell — the argv array is preserved
 * and only the leading `sudo`/`-S` tokens are dropped (Hard Rule #13).
 */
export function resolveSudoSpawn(
  command: string,
  args: string[],
  overrides: { root?: boolean; sudoAvailable?: boolean; noSudo?: boolean } = {}
): ResolvedSpawn {
  const root = overrides.root ?? isRoot();
  const sudoAvailable = overrides.sudoAvailable ?? isSudoAvailable();
  const noSudo = overrides.noSudo ?? isNoSudoEnv();
  const stripSudo = command === "sudo" && (root || !sudoAvailable || noSudo);
  const needsPassword = !stripSudo && command === "sudo";
  let finalCommand = command;
  let finalArgs = args;

  if (stripSudo) {
    const realCmdIndex = args.findIndex((arg) => !arg.startsWith("-"));
    if (realCmdIndex !== -1) {
      finalCommand = args[realCmdIndex];
      finalArgs = args.slice(realCmdIndex + 1);
    }
  }

  return { finalCommand, finalArgs, stripSudo, needsPassword };
}

export function execFileWithPassword(
  command: string,
  args: string[],
  password: string,
  stdinAfterPassword = ""
): Promise<string> {
  // When running as root, when `sudo` is not installed on the host (slim
  // Docker images / containerized non-root runtime), OR when the operator sets
  // `OMNIROUTE_NO_SUDO` (root-less / user-namespace deployments — #6122), skip
  // `sudo -S` and run the underlying command directly — same user, no
  // elevation. This lets MITM operations triggered from inside `node:*-slim`
  // containers succeed for any command that does not actually require root
  // (everything but writing to /etc/hosts or the system trust store).
  const { finalCommand, finalArgs, needsPassword } = resolveSudoSpawn(command, args);

  return new Promise((resolve, reject) => {
    // `command` and `args` are never user-controlled. This helper is a
    // controlled wrapper called only from src/mitm/cert/install.ts with a
    // fixed allowlist of executables: "sudo", "certutil", "security",
    // "update-ca-certificates", "update-ca-trust", "cp", "mkdir", "rm".
    // `spawn` is used (not `exec`) so each arg is a separate argv entry and
    // shell metacharacters do not expand. See docs/security/SOCKET_DEV_FINDINGS.md §3.
    // nosemgrep
    const child = spawn(finalCommand, finalArgs, {
      // nosemgrep

      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (error: Error | null) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    };

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      settle(new Error(`Command failed: ${getErrorMessage(error)}\n${stderr}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        settle(null);
        return;
      }
      settle(new Error(`Command failed with code ${code}\n${stderr}`));
    });

    const stdinInput = needsPassword
      ? `${password}\n${stdinAfterPassword}`
      : stdinAfterPassword || "";
    if (stdinInput) {
      child.stdin?.write(stdinInput);
    }
    child.stdin?.end();
  });
}
