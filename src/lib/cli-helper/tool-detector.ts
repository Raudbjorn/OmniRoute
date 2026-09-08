import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { getCliTool, listCliTools } from "../../shared/constants/cliTools";
import {
  CLI_TOOL_IDS,
  getCliPrimaryConfigPath,
  getCliToolCommandCandidates,
  getLookupEnv,
  normalizeCliToolId,
} from "../../shared/services/cliRuntime";
import { resolveOpencodeConfigPath } from "../../shared/services/opencodeConfigPath";
import { getCurrentHermesAgentRoles } from "./config-generator/hermes-agent";
import { getHermesConfigPath } from "./config-generator/hermesHome";

const execFileAsync = promisify(execFile);
let execFileImpl = execFileAsync;

export function __setExecFileImpl(fn: typeof execFileAsync): void {
  execFileImpl = fn;
}

export interface DetectedTool {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
  configPath: string;
  configured: boolean;
  configContents?: string;

  // Rich per-role status for Hermes Agent
  hermesAgentRoles?: Record<
    string,
    {
      model: string;
      provider?: string;
      usingOmniRoute: boolean;
    }
  >;
}

type ToolDescriptor = { id: string; name: string; configPath: string };

// Keep the long-standing CLI status labels stable while the UI catalog uses
// marketing names (for example, "Open Claw").
const DETECTOR_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  openclaw: "OpenClaw",
};

/**
 * The detector is a read-only view over the shared runtime/UI catalogs.
 * Runtime-only entries (for example qoder) are retained, while guide-only UI
 * entries still appear with an empty config path and `installed: false`.
 */
const TOOLS: ToolDescriptor[] = Array.from(
  new Set([...listCliTools().map((tool) => tool.id), ...CLI_TOOL_IDS])
).map((id) => ({
  id,
  name: DETECTOR_NAME_OVERRIDES[id] || getCliTool(id)?.name || id,
  configPath: "",
}));

function expandHome(p: string): string {
  const home = os.homedir();
  return p.replace(/^~\//, home + "/");
}

function isConfigured(content: string, baseUrl: string): boolean {
  const normalized = baseUrl.replace(/\/+$/, "");
  return (
    content.includes(normalized) ||
    content.includes("localhost:20128") ||
    content.includes("OMNIROUTE_BASE_URL")
  );
}

async function detectBinary(name: string): Promise<{ installed: boolean; version?: string }> {
  const binaries = getCliToolCommandCandidates(name);
  if (binaries.length === 0) return { installed: false };
  const env = getLookupEnv();

  for (const binary of binaries) {
    try {
      const { stdout } = await execFileImpl(binary, ["--version"], { timeout: 5000, env });
      const version = stdout.trim().replace(/^v/, "");
      return { installed: true, version };
    } catch {
      try {
        // Try `which` as fallback (routed through execFileImpl so it stays mockable)
        const { stdout } = await execFileImpl("which", [binary], { timeout: 5000, env });
        if (stdout.trim()) {
          return { installed: true };
        }
      } catch {
        // Try the next declared command candidate.
      }
    }
  }

  return { installed: false };
}

async function readConfigFile(configPath: string): Promise<string | null> {
  try {
    const { readFileSync } = await import("node:fs");
    const expanded = expandHome(configPath);
    if (!expanded) return null;
    return readFileSync(expanded, "utf-8");
  } catch {
    return null;
  }
}

export async function detectTool(id: string): Promise<DetectedTool | null> {
  const canonicalId = normalizeCliToolId(id);
  const tool = TOOLS.find((t) => t.id === canonicalId);
  if (!tool) return null;

  const { installed, version } = await detectBinary(tool.id);
  const configPath =
    tool.id === "hermes" || tool.id === "hermes-agent"
      ? getHermesConfigPath()
      : getCliPrimaryConfigPath(tool.id) ||
        (tool.id === "opencode" ? resolveOpencodeConfigPath() : "");
  const configContents = await readConfigFile(configPath);
  const configured = !!configContents && isConfigured(configContents, "http://localhost:20128");

  const result: DetectedTool = {
    id: canonicalId,
    name: tool.name,
    installed,
    version,
    configPath,
    configured,
    configContents: configContents ?? undefined,
  };

  // Rich per-role status only for Hermes Agent
  if (tool.id === "hermes-agent") {
    try {
      const roles = await getCurrentHermesAgentRoles();
      const richRoles: Record<string, any> = {};

      Object.entries(roles).forEach(([role, info]) => {
        const usingOmni =
          info?.provider === "omniroute" ||
          (info?.base_url || "").includes("20128") ||
          (info?.base_url || "").includes("localhost:20128");

        richRoles[role] = {
          model: info.model,
          provider: info.provider,
          usingOmniRoute: usingOmni,
        };
      });

      result.hermesAgentRoles = richRoles;
    } catch {
      // ignore – rich status is optional
    }
  }

  return result;
}

export async function detectAllTools(): Promise<DetectedTool[]> {
  const results = await Promise.allSettled(TOOLS.map((t) => detectTool(t.id)));

  return results
    .filter((r) => r.status === "fulfilled" && r.value !== null)
    .map((r) => (r as PromiseFulfilledResult<DetectedTool>).value);
}
