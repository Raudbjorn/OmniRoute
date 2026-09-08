import { InstallError } from "./utils";
/**
 * LLMLingua Server installer adapter for the ServiceSupervisor framework.
 *
 * Runs an external/embedded LLMLingua HTTP compression microservice daemon.
 * When active on loopback port 20135, prompt compression requests are dispatched
 * over HTTP to the existing ONNX worker in a supervised process.
 *
 * Binary location: $DATA_DIR/services/llmlingua/server.mjs
 * DB row:          version_manager WHERE tool = 'llmlingua'
 */

import { resolveWorkerFile } from "@omniroute/open-sse/services/compression/engines/llmlingua/worker.ts";
import { LLMLINGUA_SERVER_SOURCE } from "./llmlinguaServer";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/db/core";
import { upsertVersionManagerTool } from "@/lib/db/versionManager";

export const LLMLINGUA_DEFAULT_PORT = 20135;
export const LLMLINGUA_INSTALL_DIR = path.join(DATA_DIR, "services", "llmlingua");

export interface InstallResult {
  installedVersion: string;
  installPath: string;
  durationMs: number;
}

export interface SpawnArgs {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

function getLlmlinguaInstallDir(): string {
  return process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, "services", "llmlingua")
    : LLMLINGUA_INSTALL_DIR;
}

export function getServerScriptPath(): string {
  return path.join(getLlmlinguaInstallDir(), "server.mjs");
}

export async function getInstalledVersion(): Promise<string | null> {
  try {
    const pkgPath = path.join(getLlmlinguaInstallDir(), "package.json");
    if (!fs.existsSync(pkgPath) || !fs.existsSync(getServerScriptPath())) return null;
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export async function getLatestVersion(): Promise<string> {
  return "1.0.0";
}

export async function install(version = "latest"): Promise<InstallResult> {
  if (version !== "latest" && version !== "1.0.0")
    throw new InstallError("Unsupported service version", "Use latest or 1.0.0", 400);
  const startMs = Date.now();
  const installDir = getLlmlinguaInstallDir();

  fs.mkdirSync(installDir, { recursive: true });
  const hostPkgPath = path.join(installDir, "package.json");
  {
    fs.writeFileSync(
      hostPkgPath,
      JSON.stringify(
        {
          name: "omniroute-llmlingua-host",
          version: "1.0.0",
          private: true,
        },
        null,
        2
      ),
      "utf8"
    );
  }

  const serverScript = getServerScriptPath();
  fs.writeFileSync(serverScript, LLMLINGUA_SERVER_SOURCE, "utf8");

  const installedVersion = (await getInstalledVersion()) || "1.0.0";

  await upsertVersionManagerTool({
    tool: "llmlingua",
    installedVersion,
    binaryPath: serverScript,
    status: "stopped",
    port: LLMLINGUA_DEFAULT_PORT,
  });

  return {
    installedVersion,
    installPath: installDir,
    durationMs: Date.now() - startMs,
  };
}

export async function update(): Promise<InstallResult> {
  return install("latest");
}

export function resolveSpawnArgs(port = LLMLINGUA_DEFAULT_PORT): SpawnArgs {
  const serverScript = getServerScriptPath();
  const installDir = getLlmlinguaInstallDir();
  if (!fs.existsSync(serverScript)) {
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(serverScript, LLMLINGUA_SERVER_SOURCE, "utf8");
  }
  const { workerFile, execArgv } = resolveWorkerFile();

  return {
    command: process.execPath,
    args: [serverScript],
    env: {
      ...process.env,
      PORT: String(port),
      LLMLINGUA_WORKER_FILE: workerFile,
      LLMLINGUA_WORKER_ARGV: JSON.stringify(execArgv),
    },
    cwd: installDir,
  };
}
