import { execFile, type ExecFileOptions } from "node:child_process";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

export type Platform = "linux";

export interface LinuxPreviousState {
  platform: "linux";
  gnomeMode: string;
  httpHost: string;
  httpPort: string;
  httpsHost: string;
  httpsPort: string;
}

export type PreviousState = LinuxPreviousState;

export interface ApplyResult {
  platform: Platform;
  previousState: PreviousState;
}

// Injection seam for tests. Default implementation wraps node:child_process
// `execFile` so call-sites use array args (Hard Rule #13).
export type ExecFileFn = (
  file: string,
  args: string[],
  options?: ExecFileOptions
) => Promise<{ stdout: string; stderr: string }>;

let execImpl: ExecFileFn = defaultExec;

function defaultExec(
  file: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
      });
    });
  });
}

/**
 * Replace the underlying `execFile` runner (for tests).
 * Returns a `restore()` function that puts the default back.
 */
export function __setExec(fn: ExecFileFn): () => void {
  const prev = execImpl;
  execImpl = fn;
  return () => {
    execImpl = prev;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Linux — gsettings (GNOME); systems without gsettings are unsupported here.
// ────────────────────────────────────────────────────────────────────────────

async function readGsetting(key: string): Promise<string> {
  try {
    const { stdout } = await execImpl("gsettings", ["get", "org.gnome.system.proxy", key]);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function readGsubsetting(scheme: string, key: string): Promise<string> {
  try {
    // HR#13: concat (not template) — scheme is a hardcoded "http"|"https" constant.
    const { stdout } = await execImpl("gsettings", [
      "get",
      "org.gnome.system.proxy." + scheme,
      key,
    ]);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function linuxApply(port: number): Promise<LinuxPreviousState> {
  const previousState: LinuxPreviousState = {
    platform: "linux",
    gnomeMode: await readGsetting("mode"),
    httpHost: await readGsubsetting("http", "host"),
    httpPort: await readGsubsetting("http", "port"),
    httpsHost: await readGsubsetting("https", "host"),
    httpsPort: await readGsubsetting("https", "port"),
  };

  const portStr = String(port);
  await execImpl("gsettings", ["set", "org.gnome.system.proxy", "mode", "manual"]);
  await execImpl("gsettings", ["set", "org.gnome.system.proxy.http", "host", "127.0.0.1"]);
  await execImpl("gsettings", ["set", "org.gnome.system.proxy.http", "port", portStr]);
  await execImpl("gsettings", ["set", "org.gnome.system.proxy.https", "host", "127.0.0.1"]);
  await execImpl("gsettings", ["set", "org.gnome.system.proxy.https", "port", portStr]);
  return previousState;
}

async function linuxRevert(state: LinuxPreviousState): Promise<void> {
  const mode = state.gnomeMode || "'none'";
  await execImpl("gsettings", ["set", "org.gnome.system.proxy", "mode", mode]);
  if (state.httpHost) {
    await execImpl("gsettings", ["set", "org.gnome.system.proxy.http", "host", state.httpHost]);
  }
  if (state.httpPort) {
    await execImpl("gsettings", ["set", "org.gnome.system.proxy.http", "port", state.httpPort]);
  }
  if (state.httpsHost) {
    await execImpl("gsettings", ["set", "org.gnome.system.proxy.https", "host", state.httpsHost]);
  }
  if (state.httpsPort) {
    await execImpl("gsettings", ["set", "org.gnome.system.proxy.https", "port", state.httpsPort]);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Apply OmniRoute as the system-wide HTTP/HTTPS proxy at `127.0.0.1:<port>`.
 * Captures and returns the prior configuration so callers can revert later.
 *
 * Throws a sanitized `Error` if the underlying command fails (no stack/path
 * leakage — see Hard Rule #12).
 */
export async function apply(port: number): Promise<ApplyResult> {
  const platform: Platform = "linux";
  try {
    const previousState = await linuxApply(port);
    return { platform, previousState };
  } catch (err) {
    throw new Error(sanitizeErrorMessage(err) || "system proxy apply failed");
  }
}

/**
 * Restore the prior configuration captured by `apply()`. No-op if the
 * `previousState` payload does not match a known platform.
 */
export async function revert(previousState: PreviousState | unknown): Promise<void> {
  if (!previousState || typeof previousState !== "object") return;
  const state = previousState as Record<string, unknown>;
  const platform = state.platform;
  try {
    if (platform === "linux") await linuxRevert(state as unknown as LinuxPreviousState);
  } catch (err) {
    throw new Error(sanitizeErrorMessage(err) || "system proxy revert failed");
  }
}
