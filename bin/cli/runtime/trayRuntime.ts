import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const RUNTIME_DIR = join(homedir(), ".omniroute", "runtime");

export const SYSTRAY_PACKAGE = "systray2";
export const SYSTRAY_VERSION = "2.1.4";
const SYSTRAY_SPEC = `${SYSTRAY_PACKAGE}@${SYSTRAY_VERSION}`;

export function systrayModuleSpecifier(runtimeDir: string): string {
  return pathToFileURL(join(runtimeDir, "node_modules", SYSTRAY_PACKAGE)).href;
}

export function resolveSystrayBinName(platform: NodeJS.Platform): string | null {
  return platform === "linux" ? "tray_linux_release" : null;
}

export interface ChmodResult {
  changed: boolean;
  reason?: "unsupported" | "missing" | "chmod-failed";
}

export function chmodSystrayBinAt(runtimeRoot: string, platform: NodeJS.Platform): ChmodResult {
  const binName = resolveSystrayBinName(platform);
  if (!binName) return { changed: false, reason: "unsupported" };
  const binPath = join(runtimeRoot, "node_modules", SYSTRAY_PACKAGE, "traybin", binName);
  if (!existsSync(binPath)) return { changed: false, reason: "missing" };
  try {
    chmodSync(binPath, 0o755);
    return { changed: true };
  } catch {
    return { changed: false, reason: "chmod-failed" };
  }
}

export async function loadSystray(): Promise<(new (...args: unknown[]) => unknown) | null> {
  ensureRuntimeDir();
  if (!isInstalled()) {
    try {
      installSystray();
    } catch (err) {
      // Surface failures to stderr instead of staying silent — anyone hitting
      // a tray problem otherwise has zero diagnostic. (PR #1080)
      console.warn(`[omniroute] tray runtime install failed: ${(err as Error).message}`);
      return null;
    }
  }

  chmodSystrayBinAt(RUNTIME_DIR, process.platform);
  try {
    const mod = await import(systrayModuleSpecifier(RUNTIME_DIR));
    return (mod.default ?? mod.SysTray ?? mod) as (new (...args: unknown[]) => unknown) | null;
  } catch (err) {
    console.warn(`[omniroute] tray runtime import failed: ${(err as Error).message}`);
    return null;
  }
}

function ensureRuntimeDir(): void {
  if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true });
  const pkg = join(RUNTIME_DIR, "package.json");
  if (!existsSync(pkg)) {
    writeFileSync(pkg, JSON.stringify({ name: "omniroute-runtime", private: true }), "utf-8");
  }
}

function isInstalled(): boolean {
  return existsSync(join(RUNTIME_DIR, "node_modules", SYSTRAY_PACKAGE, "package.json"));
}

function installSystray(): void {
  // --save-exact persists systray2 to the runtime package.json so installing it does not
  // prune a sibling runtime dep (e.g. better-sqlite3 from nativeDeps.mjs, which writes to the
  // same runtime dir) as "extraneous", and so the tray dep survives a later sibling install.
  // Without it, a sibling install reproduces "No SQLite driver available".
  execSync(
    `npm install --prefix "${RUNTIME_DIR}" ${SYSTRAY_SPEC} --no-audit --no-fund --save-exact --silent`,
    { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 }
  );
}
