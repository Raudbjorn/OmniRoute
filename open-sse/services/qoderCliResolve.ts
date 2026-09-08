import { getCliRuntimeStatus, getKnownToolPaths } from "@/shared/services/cliRuntime";

export function getQoderCliCommand(): string {
  const explicit = String(process.env.CLI_QODER_BIN || "").trim();
  return explicit || "qodercli";
}

export type QoderCliInvocation = { command: string; useShell: boolean };

// Resolving through cliRuntime does synchronous fs walks plus a `--version`
// healthcheck spawn; memoize the result so we don't repeat that on every chat /
// quota request. The install location is effectively static for a running host.
const QODER_RESOLVE_TTL_MS = 5 * 60 * 1000;
// Keyed on the fallback command (which folds in CLI_QODER_BIN) so changing the
// override — or a test pointing at a fresh stub — invalidates a stale entry
// instead of spawning a since-deleted binary.
let qoderInvocationCache: (QoderCliInvocation & { key: string; expiresAt: number }) | null = null;

/** Test-only: drop the memoized qodercli command resolution. */
export function __clearQoderCliInvocationCache(): void {
  qoderInvocationCache = null;
}

/**
 * Resolve the exact command + shell flag to spawn qodercli. `deps` is injectable
 * for unit tests; production uses the real cliRuntime exports.
 */
export async function resolveQoderCliInvocation(
  explicitCommand?: string | null,
  deps: {
    getStatus?: typeof getCliRuntimeStatus;
  } = {}
): Promise<QoderCliInvocation> {
  const explicit = String(explicitCommand || "").trim();
  const getStatus = deps.getStatus || getCliRuntimeStatus;
  // Only the default path is cached; an explicit per-call command or an injected
  // resolver (tests) always resolves fresh and never touches the shared cache.
  const cacheable = !explicit && !deps.getStatus;
  const fallback = explicit || getQoderCliCommand();

  if (
    cacheable &&
    qoderInvocationCache &&
    qoderInvocationCache.key === fallback &&
    qoderInvocationCache.expiresAt > Date.now()
  ) {
    return { command: qoderInvocationCache.command, useShell: qoderInvocationCache.useShell };
  }

  let command = fallback;
  try {
    const status = await getStatus("qoder");
    if (status && status.installed && status.commandPath) {
      command = status.commandPath;
    }
  } catch {
    /* fall back to the bare/explicit command — spawn will surface a real ENOENT */
  }

  const invocation: QoderCliInvocation = { command, useShell: false };
  if (cacheable) {
    qoderInvocationCache = {
      ...invocation,
      key: fallback,
      expiresAt: Date.now() + QODER_RESOLVE_TTL_MS,
    };
  }
  return invocation;
}

/**
 * Build the operator-facing "qodercli not found" error, listing the paths the
 * resolver searched plus the `CLI_QODER_BIN` override hint (#6263).
 */
export function buildQoderCliNotFoundHint(runError: string): string {
  let searchedHint = "";
  try {
    const candidates = getKnownToolPaths("qoder");
    if (candidates.length > 0) {
      searchedHint = ` Searched: ${candidates.slice(0, 6).join(", ")}.`;
    }
  } catch {
    /* best-effort — the path list is only advisory for the error message */
  }
  return (
    `Qoder CLI (qodercli) was not found on the OmniRoute host (${runError}).` +
    searchedHint +
    " Install it from https://qoder.com, or set CLI_QODER_BIN to the absolute path " +
    "of the qodercli binary. " +
    "PAT auth is driven through the local qodercli binary."
  );
}
