import { getHermesHome } from "@/lib/cli-helper/config-generator/hermesHome";
import { execFileSync, spawn } from "child_process";
import fsSync from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { buildContainerWriteRefusal } from "../utils/containerConfigGuard";
import {
  describeContainerTarget,
  hasBindMountAt,
  isRunningInContainer,
  type ContainerEnvDeps,
} from "../utils/containerEnv";
import { withSettingsFallback } from "./cliInstallFallback";
import { AMP_RUNTIME_ENTRY, GROK_BUILD_RUNTIME_ENTRY } from "./cliRuntimeGrokBuild";
import { buildHealthcheckPath } from "./cliRuntimeHealthcheckPath";
import { findKnownPathMatch, isLocationTrusted } from "./cliRuntimeKnownPath";
import { getCachedLoginShellPath, mergeShellPath } from "./loginShellPath";
import { resolveOpencodeConfigPath as resolveOpenCodeConfigPath } from "./opencodeConfigPath";
const VALID_RUNTIME_MODES = new Set(["auto", "host", "container"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

const CLI_TOOLS: Record<string, any> = {
  claude: {
    defaultCommand: "claude",
    envBinKey: "CLI_CLAUDE_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 4000,
    paths: {
      settings: ".claude/settings.json",
      auth: [".claude/.credentials.json", ".config/claude/credentials.json"],
    },
  },
  codex: {
    defaultCommand: "codex",
    envBinKey: "CLI_CODEX_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 4000,
    paths: {
      config: ".codex/config.toml",
      auth: ".codex/auth.json",
    },
  },
  droid: {
    defaultCommand: "droid",
    envBinKey: "CLI_DROID_BIN",
    requiresBinary: true,
    // Droid CLI can be slow on some environments; 4s was causing false negatives.
    healthcheckTimeoutMs: 8000,
    paths: {
      settings: ".factory/settings.json",
    },
  },
  openclaw: {
    defaultCommand: "openclaw",
    envBinKey: "CLI_OPENCLAW_BIN",
    requiresBinary: true,
    // openclaw CLI may take >4s on cold start in containers.
    healthcheckTimeoutMs: 15000,
    paths: {
      settings: ".openclaw/openclaw.json",
    },
  },
  cursor: {
    defaultCommands: ["agent", "cursor"],
    envBinKey: "CLI_CURSOR_BIN",
    requiresBinary: true,
    // Cursor startup can be slower on first run in containerized host-mount mode.
    healthcheckTimeoutMs: 15000,
    paths: {
      config: ".cursor/cli-config.json",
      auth: ".config/cursor/auth.json",
      state: ".cursor/agent-cli-state.json",
    },
  },
  windsurf: {
    defaultCommand: null,
    envBinKey: "CLI_WINDSURF_BIN",
    requiresBinary: false,
    healthcheckTimeoutMs: 4000,
    paths: {},
  },
  devin: {
    defaultCommand: "devin",
    envBinKey: "CLI_DEVIN_BIN",
    requiresBinary: true,
    // devin acp cold-start can take a few seconds on first run
    healthcheckTimeoutMs: 12000,
    paths: {
      get config() {
        return path.join(os.homedir(), ".config", "devin", "config.json");
      },
    },
  },
  zcode: {
    defaultCommand: "zcode",
    envBinKey: "ZCODE_BIN",
    requiresBinary: true,
    // The app-server performs a local runtime handshake and can be slower on
    // the first launch while the user's ZCode profile is loaded.
    healthcheckTimeoutMs: 15000,
    paths: {
      config: ".zcode",
    },
  },
  cline: {
    defaultCommand: "cline",
    envBinKey: "CLI_CLINE_BIN",
    requiresBinary: true,
    // Cline startup/version check can take >4s on some environments.
    healthcheckTimeoutMs: 12000,
    paths: {
      globalState: ".cline/data/globalState.json",
      secrets: ".cline/data/secrets.json",
    },
  },
  kilo: {
    defaultCommand: "kilocode",
    envBinKey: "CLI_KILO_BIN",
    requiresBinary: true,
    // kilocode renders an ASCII logo banner on startup which can take >4s
    // on cold-start or low-resource environments (VPS, CI). Increase timeout
    // to avoid false healthcheck_failed results.
    healthcheckTimeoutMs: 15000,
    paths: {
      auth: ".local/share/kilo/auth.json",
    },
  },
  continue: {
    defaultCommand: "cn",
    envBinKey: "CLI_CONTINUE_BIN",
    requiresBinary: true,
    // opencode and continue may take up to 15s on first run / cold start on VPS
    healthcheckTimeoutMs: 15000,
    paths: {
      settings: ".continue/config.yaml",
    },
  },
  opencode: {
    defaultCommand: "opencode",
    envBinKey: "CLI_OPENCODE_BIN",
    requiresBinary: true,
    // opencode takes several seconds on cold start environments
    healthcheckTimeoutMs: 15000,
    paths: {
      config: ".config/opencode/opencode.json",
    },
  },
  hermes: {
    // Original / legacy simple Hermes entry (recovered from origin/main)
    defaultCommand: "hermes",
    envBinKey: "CLI_HERMES_BIN",
    requiresBinary: false,
    healthcheckTimeoutMs: 4000,
    paths: {
      config: ".config/hermes/config.json",
    },
  },
  "hermes-agent": {
    // Rich first-class support for the advanced Hermes Agent (multi-role: default, delegation, auxiliary.*)
    defaultCommand: "hermes",
    envBinKey: "CLI_HERMES_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 4000,
    paths: {
      // The relative path is kept for documentation purposes; getCliConfigPaths()
      // has a special case for hermes-agent that calls getHermesHome() instead of
      // getCliConfigHome(), so HERMES_HOME is always honoured (#3628).
      config: "config.yaml",
    },
  },
  amp: AMP_RUNTIME_ENTRY,
  qoder: {
    defaultCommand: "qodercli",
    envBinKey: "CLI_QODER_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 12000,
    paths: {
      config: ".qoder/settings.json",
      auth: ".qoder/auth.json",
    },
  },
  qwen: {
    defaultCommand: "qwen",
    envBinKey: "CLI_QWEN_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 12000,
    paths: {
      settings: ".qwen/settings.json",
      env: ".qwen/.env",
    },
  },
  aider: {
    defaultCommand: "aider",
    envBinKey: "CLI_AIDER_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 12000,
    paths: {
      config: ".aider.conf.yml",
    },
  },
  goose: {
    defaultCommand: "goose",
    envBinKey: "CLI_GOOSE_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 12000,
    paths: {
      config: ".config/goose/config.yaml",
    },
  },
  gemini: {
    defaultCommand: "gemini",
    envBinKey: "CLI_GEMINI_BIN",
    requiresBinary: true,
    // gemini-cli cold start (bundle + extension discovery) can exceed 4s.
    healthcheckTimeoutMs: 15000,
    paths: {
      settings: ".gemini/settings.json",
    },
  },
  // ── Plan 14 — new "custom" configType tools ───────────────────────────────
  forge: {
    defaultCommand: "forge",
    envBinKey: "CLI_FORGE_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 8000,
    paths: {
      config: ".forge/config.toml",
    },
  },
  jcode: {
    defaultCommand: "jcode",
    envBinKey: "CLI_JCODE_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 8000,
    paths: {
      config: ".jcode/config.toml",
    },
  },
  "prime-agent": {
    defaultCommand: "prime-agent",
    envBinKey: "CLI_PRIME_AGENT_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 8000,
    paths: {
      config: ".prime-agent/config.json",
    },
  },
  "grok-build": GROK_BUILD_RUNTIME_ENTRY,
  "deepseek-tui": {
    defaultCommand: "deepseek-tui",
    envBinKey: "CLI_DEEPSEEK_TUI_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 8000,
    paths: {
      config: ".config/deepseek-tui/config.toml",
    },
  },
  omp: {
    defaultCommand: "omp",
    envBinKey: "CLI_OMP_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 8000,
    paths: {
      config: ".omp/agent/models.yml",
    },
  },
  letta: {
    defaultCommand: "letta",
    envBinKey: "CLI_LETTA_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 8000,
    paths: {
      config: ".letta/lc-local-backend/providers/auth.json",
    },
  },
  codewhale: {
    defaultCommand: "codewhale",
    envBinKey: "CLI_CODEWHALE_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 8000,
    paths: {
      config: ".codewhale/config.toml",
    },
  },
  smelt: {
    defaultCommand: "smelt",
    envBinKey: "CLI_SMELT_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 8000,
    paths: {
      config: ".smelt/config.json",
    },
  },
  pi: {
    defaultCommand: "pi",
    envBinKey: "CLI_PI_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 8000,
    paths: {
      config: ".pi/config.json",
    },
  },
  // Config path reconciled with bin/cli/commands/setup-crush.mjs::resolveCrushTarget's
  // default (~/.config/crush/crush.json) so the dashboard and `omniroute setup-crush`
  // agree on one canonical config location.
  crush: {
    defaultCommand: "crush",
    envBinKey: "CLI_CRUSH_BIN",
    requiresBinary: true,
    healthcheckTimeoutMs: 8000,
    paths: {
      config: ".config/crush/crush.json",
    },
  },
  // 5dive keeps its credentials in root-owned auth profiles under a system
  // state dir, not under $HOME — getCliConfigPaths() has a special case for it
  // below, so the relative path here is documentation only.
  "5dive": {
    defaultCommand: "5dive",
    envBinKey: "CLI_5DIVE_BIN",
    requiresBinary: true,
    // `5dive --version` shells out through its own bundle; 4s is tight on a
    // host that is also running a fleet.
    healthcheckTimeoutMs: 12000,
    paths: {
      authProfiles: "auth-profiles",
    },
  },
};

/**
 * 5dive's state dir. 5dive itself reads `STATE_DIR` (default /var/lib/5dive);
 * that name is too generic to consume from OmniRoute's environment, so we take
 * an explicit override and otherwise use the same default.
 */
export const getFivediveStateDir = (): string =>
  process.env.CLI_5DIVE_STATE_DIR || "/var/lib/5dive";

/**
 * Compatibility aliases accepted by CLI/API callers.
 *
 * The runtime catalog keeps one canonical id per executable. Older surfaces
 * exposed a binary name (notably `kilocode`) or launcher aliases instead of
 * that id, so normalize them at the boundary rather than duplicating entries.
 */
export const CLI_TOOL_ALIASES: Readonly<Record<string, string>> = {
  fivedive: "5dive",
  "5dive-cli": "5dive",
  kilocode: "kilo",
  "kilo-code": "kilo",
  kilo_cli: "kilo",
  cc: "claude",
  "claude-code": "claude",
  "openai-codex": "codex",
  openai: "codex",
  "codex-app-server": "codex",
  cn: "continue",
  qodercli: "qoder",
};

/** Resolve a user-facing or legacy id to the canonical runtime id. */
export const normalizeCliToolId = (toolId: string): string => {
  const normalized = String(toolId || "")
    .trim()
    .toLowerCase();
  return CLI_TOOL_ALIASES[normalized] || normalized;
};

const parseBoolean = (value: unknown, defaultValue = true) => {
  if (value == null || value === "") return defaultValue;
  return !FALSE_VALUES.has(String(value).trim().toLowerCase());
};

const runProcess = (
  command: string,
  args: string[],
  {
    env,
    timeoutMs = 3000,
  }: {
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  } = {}
): Promise<any> =>
  new Promise((resolve) => {
    // Guard: reject commands with shell metacharacters — command comes from
    // server-controlled env vars/config, not HTTP input, but belt-and-suspenders.
    if (/[;&|`$<>\n\r]/.test(command)) {
      resolve({ ok: false, stdout: "", stderr: "rejected: unsafe command path", exitCode: -1 });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const done = (result: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      done({
        ok: false,
        code: null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        error: error?.message || "spawn_error",
      });
    });

    child.on("close", (code) => {
      done({
        ok: !timedOut && code === 0,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        error: timedOut ? "timeout" : null,
      });
    });
  });

const getRuntimeMode = () => {
  const mode = String(process.env.CLI_MODE || "auto")
    .trim()
    .toLowerCase();
  return VALID_RUNTIME_MODES.has(mode) ? mode : "auto";
};

/**
 * T12: Validate a CLI executable path to prevent shell injection.
 * Enforces: absolute path, no dangerous shell metacharacters, must exist and be a file.
 * Inspired by Antigravity Manager commit 96732c2 (Mar 11, 2026).
 */
const DANGEROUS_PATH_CHARS = ["&", "|", ";", "<", ">", "(", ")", "`", "$", "^", "%", "!"];

const isPathWithin = (childPath: string, parentPath: string): boolean => {
  // Normalize to forward slashes for consistent comparison
  const normalize = (p: string) => path.normalize(p).toLowerCase().replace(/\\/g, "/");
  const normalizedChild = normalize(childPath);
  const normalizedParent = normalize(parentPath);

  if (normalizedChild === normalizedParent) return true;

  // Ensure parent ends with / for proper prefix matching
  const parentWithSep = normalizedParent.endsWith("/") ? normalizedParent : normalizedParent + "/";

  return normalizedChild.startsWith(parentWithSep);
};

const isSafePath = (execPath: string): boolean => {
  if (!execPath || !path.isAbsolute(execPath)) return false;
  if (DANGEROUS_PATH_CHARS.some((c) => execPath.includes(c))) return false;
  // Allow path.sep and path.delimiter — no further character filtering needed
  return true;
};

/**
 * Validate that an environment variable value is a safe, absolute path
 * within acceptable directory trees. Rejects traversal, special chars,
 * and paths outside expected locations.
 */
const validateEnvPath = (value: string | undefined, allowedParents: string[]): string => {
  if (!value) return "";
  const trimmed = value.trim();

  // Reject if not absolute
  if (!path.isAbsolute(trimmed)) return "";

  // Reject dangerous characters (same as isSafePath but applied to env vars)
  if (DANGEROUS_PATH_CHARS.some((c) => trimmed.includes(c))) return "";

  // Reject if contains path traversal segments
  const normalized = path.normalize(trimmed);
  if (normalized.includes("..")) return "";

  // Reject if outside allowed parent directories
  if (allowedParents.length > 0) {
    const withinAllowed = allowedParents.some((parent) => isPathWithin(normalized, parent));
    if (!withinAllowed) return "";
  }

  return normalized;
};

/**
 * Detect the npm global bin directory.
 * Cached on first call — `execFileSync` is expensive, only run once.
 */
let _npmGlobalPrefix: string | undefined;
const getNpmGlobalPrefix = (): string => {
  if (_npmGlobalPrefix !== undefined) return _npmGlobalPrefix;

  const envPrefix = String(process.env.npm_config_prefix || "").trim();
  if (envPrefix && path.isAbsolute(envPrefix)) {
    _npmGlobalPrefix = envPrefix;
    return _npmGlobalPrefix;
  }

  try {
    const result = execFileSync("npm", ["config", "get", "prefix"], {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const prefix = result.trim();
    if (
      prefix &&
      path.isAbsolute(prefix) &&
      !DANGEROUS_PATH_CHARS.some((c) => prefix.includes(c))
    ) {
      _npmGlobalPrefix = prefix;
      return _npmGlobalPrefix;
    }
  } catch {}

  _npmGlobalPrefix = "";
  return _npmGlobalPrefix;
};

/**
 * Pre-compute expected parent directories at module startup for performance.
 * These are the allowed directories for CLI binary installation locations.
 */
const getExpectedParentPaths = (): string[] => {
  const home = os.homedir();
  const npmPrefix = getNpmGlobalPrefix();

  // Add common user bin directories
  const userBinPaths = [path.join(home, "bin"), path.join(home, ".local", "bin")];

  return [home, ...userBinPaths, npmPrefix].filter(Boolean);
};

const getExtraPaths = () =>
  String(process.env.CLI_EXTRA_PATHS || "")
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((p) => {
      // Must be absolute
      if (!path.isAbsolute(p)) return false;
      // No dangerous characters
      if (DANGEROUS_PATH_CHARS.some((c) => p.includes(c))) return false;
      // No path traversal
      if (path.normalize(p).includes("..")) return false;
      return true;
    });

export const getKnownToolPaths = (toolId: string): string[] => {
  toolId = normalizeCliToolId(toolId);
  const home = os.homedir();
  const paths: string[] = [];

  const npmPrefix = getNpmGlobalPrefix();

  const toolBins: Record<string, string[]> = {
    claude: ["claude"],
    codex: ["codex"],
    droid: ["droid"],
    openclaw: ["openclaw"],
    cursor: ["agent", "cursor"],
    cline: ["cline"],
    kilo: ["kilocode"],
    continue: ["cn"],
    opencode: ["opencode"],
    qoder: ["qodercli"],
    qwen: ["qwen"],
    "5dive": ["5dive"],
    devin: ["devin"],
  };

  const bins = toolBins[toolId] || [];

  {
    for (const posixName of bins) {
      const nodeBinDir = path.dirname(process.execPath);
      paths.push(path.join(nodeBinDir, posixName));

      if (npmPrefix) {
        paths.push(path.join(npmPrefix, "bin", posixName));
      }

      paths.push(path.join(home, ".local", "bin", posixName));
      // Only add system paths if they exist (avoids unnecessary stat calls)
      if (fsSync.existsSync("/usr/local/bin")) {
        paths.push(path.join("/usr", "local", "bin", posixName));
      }
      if (fsSync.existsSync("/usr/bin")) {
        paths.push(path.join("/usr", "bin", posixName));
      }

      if (toolId === "opencode") {
        paths.push(path.join(home, ".opencode", "bin", posixName));
      }
      if (toolId === "claude") {
        paths.push(path.join(home, ".claude", "bin", posixName));
      }
      // Devin CLI installs to ~/.local/share/devin/bin/devin (Linux)
      // or via shell installer to ~/.devin/bin/devin
      if (toolId === "devin") {
        paths.push(path.join(home, ".local", "share", "devin", "bin", "devin"));
        paths.push(path.join(home, ".devin", "bin", "devin"));
      }
    }
  }

  return paths;
};

export const getLookupEnv = () => {
  const env = { ...process.env };
  const extraPaths = getExtraPaths();
  const basePath = env.PATH || "";

  const loginShellPath = getCachedLoginShellPath();
  const enrichedPath = loginShellPath ? mergeShellPath(basePath, loginShellPath) : basePath;

  // Only add user-specified extra paths, NOT generic user directories
  // This is more secure - user explicitly opts in via CLI_EXTRA_PATHS
  if (extraPaths.length > 0 || enrichedPath !== basePath) {
    const mergedPath = [...extraPaths, enrichedPath].filter(Boolean).join(path.delimiter);
    if (mergedPath) {
      env.PATH = mergedPath;
    }
  }
  return env;
};

const resolveToolCommands = (toolId: string): string[] => {
  const tool = CLI_TOOLS[normalizeCliToolId(toolId)];
  if (!tool) return [];
  const envCommand = String(process.env[tool.envBinKey] || "").trim();
  if (envCommand) return [envCommand];
  if (Array.isArray(tool.defaultCommands) && tool.defaultCommands.length > 0) {
    return tool.defaultCommands.filter(Boolean);
  }
  return tool.defaultCommand ? [tool.defaultCommand] : [];
};

/**
 * Return command candidates without probing the filesystem.
 *
 * Lightweight consumers (config status and CLI inventory) use this to build
 * a version probe while getCliRuntimeStatus() remains the authoritative
 * health/runnability check.
 */
export const getCliToolCommandCandidates = (toolId: string): string[] =>
  resolveToolCommands(toolId);

const checkExplicitPath = async (commandPath: string) => {
  // Reject paths that look like injection attempts
  if (!isSafePath(commandPath)) {
    return { installed: false, commandPath: null, reason: "unsafe_path" };
  }

  try {
    await fs.access(commandPath, fs.constants.F_OK);
  } catch {
    return { installed: false, commandPath: null, reason: "not_found" };
  }

  try {
    await fs.access(commandPath, fs.constants.X_OK);
    return { installed: true, commandPath, reason: null };
  } catch {
    return { installed: true, commandPath, reason: "not_executable" };
  }
};

export const locateCommand = async (command: string, env: Record<string, string | undefined>) => {
  if (!command) {
    return { installed: false, commandPath: null, reason: "missing_command" };
  }

  if (command.includes("/") || command.includes("\\")) {
    return checkExplicitPath(command);
  }

  const located = await runProcess("sh", ["-c", 'command -v -- "$1"', "sh", command], {
    env,
    timeoutMs: 3000,
  });
  if (located.ok && located.stdout) {
    return { installed: true, commandPath: command, reason: null };
  }

  if (located.timedOut) {
    return { installed: false, commandPath: null, reason: "timeout" };
  }
  return { installed: false, commandPath: null, reason: "not_found" };
};

/**
 * Check if a command exists at a specific absolute path.
 * Used for known installation locations.
 *
 * Security hardening:
 * - Resolves symlinks and verifies target stays within expected directories
 * - Verifies file is a regular file (not directory, pipe, or device)
 * - Checks file size bounds (30B - 100MB) to detect suspicious binaries
 */
export const checkKnownPath = async (commandPath: string) => {
  if (!path.isAbsolute(commandPath)) {
    return { installed: false, commandPath: null, reason: "not_absolute" };
  }

  if (!isSafePath(commandPath)) {
    return { installed: false, commandPath: null, reason: "unsafe_path" };
  }

  try {
    // Resolve symlinks to get the real path and detect symlink escapes
    const realPath = await fs.realpath(commandPath);

    const isWithinExpected = await isLocationTrusted(
      commandPath,
      realPath,
      getExpectedParentPaths(),
      isPathWithin,
      fs.realpath
    );

    if (!isWithinExpected) {
      return { installed: false, commandPath: null, reason: "symlink_escape" };
    }

    // Verify it's a regular file with reasonable size
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) {
      return { installed: false, commandPath: null, reason: "not_file" };
    }

    if (stat.size < 30 || stat.size > 350 * 1024 * 1024) {
      return { installed: false, commandPath: null, reason: "suspicious_size" };
    }
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return { installed: false, commandPath: null, reason: "not_found" };
    }
    if (errorCode === "EINVAL") {
      return { installed: false, commandPath: null, reason: "invalid_path" };
    }
    return { installed: false, commandPath: null, reason: "access_error" };
  }

  try {
    await fs.access(commandPath, fs.constants.X_OK);
    return { installed: true, commandPath, reason: null };
  } catch {
    return { installed: true, commandPath, reason: "not_executable" };
  }
};

type KnownPathResult = Awaited<ReturnType<typeof checkKnownPath>>;

export const locateCommandCandidate = async (
  commands: string[],
  env: Record<string, string | undefined>,
  toolId?: string
) => {
  if (!Array.isArray(commands) || commands.length === 0) {
    return { command: null, installed: false, commandPath: null, reason: "missing_command" };
  }

  // SECURITY: First check known installation paths for this specific tool
  // This avoids searching PATH and reduces attack surface
  let bestKnownPathFailure: KnownPathResult | null = null;
  if (toolId) {
    const { match, bestFailure } = await findKnownPathMatch(
      getKnownToolPaths(toolId),
      checkKnownPath
    );
    if (match) {
      return {
        command: commands[0],
        installed: true,
        commandPath: match.commandPath,
        reason: match.reason,
      };
    }
    bestKnownPathFailure = bestFailure;
  }

  // Always try PATH — a stray/broken known-path guess must never hide a genuinely
  // PATH-resolvable binary (#7774). User can also set CLI_EXTRA_PATHS if needed.
  //
  // #10710: "timeout" is deliberately NOT terminal like other failure reasons
  // (unsafe_path, symlink_escape, ...). A timeout only proves the probe was
  // too slow, not that the binary is absent, so remaining command aliases are
  // still worth trying (the next one may resolve quickly). Remember the first
  // timeout as a fallback so a genuine "not_found" for every alias doesn't
  // silently swallow the fact that one probe never actually completed.
  let bestTimeoutFailure: Awaited<ReturnType<typeof locateCommand>> | null = null;
  for (const command of commands) {
    const located = await locateCommand(command, env);
    if (located.installed) {
      return { command, ...located };
    }
    if (located.reason === "timeout") {
      if (!bestTimeoutFailure) bestTimeoutFailure = located;
      continue;
    }
    if (located.reason !== "not_found") {
      return { command, ...located };
    }
  }

  if (bestTimeoutFailure) {
    return { command: commands[0], ...bestTimeoutFailure };
  }
  if (bestKnownPathFailure) {
    return { command: commands[0], ...bestKnownPathFailure };
  }
  return { command: commands[0], installed: false, commandPath: null, reason: "not_found" };
};

const checkRunnable = async (
  commandPath: string,
  env: Record<string, string | undefined>,
  timeoutMs = 4000
) => {
  // Minimal environment to prevent credential leakage to potentially malicious binaries
  const minimalEnv: Record<string, string | undefined> = {
    // #8036: merge in this Node's own bin dir so `#!/usr/bin/env node` npm CLIs
    // (e.g. codex) can resolve their interpreter under a minimal launcher PATH.
    PATH: buildHealthcheckPath(env.PATH || "", path.dirname(process.execPath)),
    HOME: env.HOME,
    TEMP: env.TEMP,
    TMP: env.TMP,
  };

  for (const args of [["--version"], ["-v"]]) {
    const result = await runProcess(commandPath, args, { env: minimalEnv, timeoutMs });
    // Validate output: must be non-empty and reasonable length (< 4KB)
    if (result.ok && result.stdout.length > 0 && result.stdout.length < 4096) {
      return { runnable: true, reason: null, version: result.stdout.trim() };
    }
  }
  return { runnable: false, reason: "healthcheck_failed" };
};

export const isCliConfigWriteAllowed = () =>
  parseBoolean(process.env.CLI_ALLOW_CONFIG_WRITES, true);

/**
 * Gate for every CLI-tool config write.
 *
 * Pass `targetPath` whenever the caller knows it: inside a container, a path
 * that is not bind-mounted from the host is thrown away when the container is
 * recreated, and the host CLI never sees it. Refusing beats writing a file the
 * operator will never find. Callers that omit the path keep the historical
 * flag-only behavior.
 */
export const ensureCliConfigWriteAllowed = (
  targetPath?: string,
  options: { containerDeps?: ContainerEnvDeps; toolLabel?: string; hostCommand?: string } = {}
) => {
  if (!isCliConfigWriteAllowed()) {
    return "CLI config writes are disabled (CLI_ALLOW_CONFIG_WRITES=false)";
  }
  if (!targetPath) return null;
  if (parseBoolean(process.env.OMNIROUTE_ALLOW_CONTAINER_CONFIG_WRITE, false)) return null;
  if (!describeContainerTarget(targetPath, options.containerDeps).ephemeral) return null;
  return buildContainerWriteRefusal(targetPath, {
    toolLabel: options.toolLabel,
    hostCommand: options.hostCommand,
  });
};

export const getCliConfigHome = (containerDeps?: ContainerEnvDeps) => {
  const override = String(process.env.CLI_CONFIG_HOME || "").trim();
  if (!override) return os.homedir();

  // Must be absolute
  if (!path.isAbsolute(override)) return os.homedir();

  // Must not contain dangerous characters
  if (DANGEROUS_PATH_CHARS.some((c) => override.includes(c))) return os.homedir();

  // Must not contain path traversal
  if (path.normalize(override).includes("..")) return os.homedir();

  // Must be within user's home directory (prevent reading from system dirs).
  //
  // Exception for containers: the compose `host` profile deliberately mounts the
  // operator's real config dirs at /host-home, which is outside the container
  // user's home (/home/node). A bind mount is proof the operator wired that path
  // in on purpose, so it is honoured; an arbitrary unmounted system dir is not.
  const home = os.homedir();
  const normalized = path.normalize(override);
  if (!isPathWithin(normalized, home)) {
    if (isRunningInContainer(containerDeps) && hasBindMountAt(normalized, containerDeps)) {
      return normalized;
    }
    return home; // Silently fall back to home
  }

  return normalized;
};

export const resolveOpencodeConfigPath = (
  _platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir()
) => resolveOpenCodeConfigPath(env, homeDir);

export const getOpenCodeConfigPath = () => resolveOpencodeConfigPath();

export const getCliConfigPaths = (toolId: string) => {
  toolId = normalizeCliToolId(toolId);
  const tool = CLI_TOOLS[toolId];
  if (!tool) return null;

  if (toolId === "opencode") {
    return {
      config: getOpenCodeConfigPath(),
    };
  }

  // hermes-agent: honour HERMES_HOME env var instead of the generic CLI_CONFIG_HOME (#3628).
  if (toolId === "hermes-agent") {
    return {
      config: path.join(getHermesHome(), "config.yaml"),
    };
  }

  // 5dive: auth profiles are root-owned and live in a system state dir, so the
  // $HOME-relative join every other tool uses would point at nothing.
  if (toolId === "5dive") {
    return {
      authProfiles: path.join(getFivediveStateDir(), "auth-profiles"),
    };
  }

  const home = getCliConfigHome();
  return Object.fromEntries(
    Object.entries(tool.paths).map(([key, relativePath]) => {
      let resolvedPath = "";
      if (Array.isArray(relativePath)) {
        // Find the first path that exists, or default to the first one
        resolvedPath = path.join(home, relativePath[0]);
        for (const p of relativePath) {
          const candidate = path.join(home, p);
          if (fsSync.existsSync(candidate)) {
            resolvedPath = candidate;
            break;
          }
        }
      } else {
        resolvedPath = path.join(home, relativePath as string);
      }
      return [key, resolvedPath];
    })
  );
};

export const getCliPrimaryConfigPath = (toolId: string) => {
  const paths = getCliConfigPaths(toolId);
  if (!paths) return null;
  const firstKey = Object.keys(paths)[0];
  return firstKey ? paths[firstKey] : null;
};

export const getCliRuntimeStatus = async (toolId: string) => {
  toolId = normalizeCliToolId(toolId);
  const tool = CLI_TOOLS[toolId];
  const runtimeMode = getRuntimeMode();
  if (!tool) {
    return {
      installed: false,
      runnable: false,
      command: null,
      commandPath: null,
      reason: "unknown_tool",
      runtimeMode,
      requiresBinary: false,
    };
  }

  const env = getLookupEnv();
  const commands = resolveToolCommands(toolId);
  const requiresBinary = tool.requiresBinary !== false;

  if (!requiresBinary && commands.length === 0) {
    return {
      installed: true,
      runnable: true,
      command: null,
      commandPath: null,
      reason: "not_required",
      runtimeMode,
      requiresBinary,
    };
  }

  const envCommand = String(process.env[tool.envBinKey] || "").trim();
  const hasEnvOverride = !!envCommand;

  const located = await locateCommandCandidate(commands, env, hasEnvOverride ? undefined : toolId);
  const command = located.command;

  if (!located.installed) {
    return withSettingsFallback(getCliConfigPaths(toolId)?.settings, {
      installed: false,
      runnable: false,
      command,
      commandPath: null,
      reason: located.reason || "not_found",
      runtimeMode,
      requiresBinary,
    });
  }

  if (located.reason === "not_executable") {
    return {
      installed: true,
      runnable: false,
      command,
      commandPath: located.commandPath,
      reason: "not_executable",
      runtimeMode,
      requiresBinary,
    };
  }

  const healthcheck = await checkRunnable(
    located.commandPath || command || "", // located + executable ⇒ commandPath set
    env,
    Number(tool.healthcheckTimeoutMs || 4000)
  );
  return {
    installed: true,
    runnable: healthcheck.runnable,
    version: healthcheck.version,
    command,
    commandPath: located.commandPath,
    reason: healthcheck.reason,
    runtimeMode,
    requiresBinary,
  };
};

export const CLI_TOOL_IDS = Object.keys(CLI_TOOLS);
