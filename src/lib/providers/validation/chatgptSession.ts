import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CHATGPT_WEB_CODEX_CONNECTOR_NAME } from "@/shared/constants/chatgptWebCodex";
import { inspectBrowserLoginCapabilities } from "@omniroute/open-sse/vendor/codex-chatgpt-web/browser-login.ts";
import { getConfigDir } from "@omniroute/open-sse/vendor/codex-chatgpt-web/config.ts";
import { decodeChatGptWebCodexSecrets } from "@omniroute/open-sse/executors/chatgpt-web-codex/credentials.ts";
import { detectChromeExecutable } from "@omniroute/open-sse/executors/chatgpt-web-codex.ts";
import {
  connectionRuntimePaths,
  ensureConnectionStorageState,
  ensureConnectionStorageStateFromCredential,
} from "@omniroute/open-sse/executors/chatgpt-web-codex/storageState.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

// A successful fresh-cookie validation leaves authenticated cookie-derived browser state on
// disk, keyed by `validationId`, so a later `finalizeValidatedChatGptWebCodexSecrets` call can
// pick it up and complete the save. If the caller abandons that flow (closes the tab, the save
// request never arrives), nothing else ever removes it. This tracks every pending validation's
// creation time and reaps directories left behind past the TTL, so an abandoned flow cannot
// retain live session cookies indefinitely.
const PENDING_VALIDATION_TTL_MS = 15 * 60 * 1000;

function pendingValidationsPath(): string {
  return join(getConfigDir(), "connections", "pending-validations.json");
}

function readPendingValidations(): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(pendingValidationsPath(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writePendingValidations(pending: Record<string, number>): void {
  const path = pendingValidationsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(pending));
}

function registerPendingValidation(validationId: string): void {
  const pending = readPendingValidations();
  pending[validationId] = Date.now();
  writePendingValidations(pending);
}

function reapAbandonedValidations(): void {
  const pending = readPendingValidations();
  const now = Date.now();
  let changed = false;
  for (const [validationId, createdAt] of Object.entries(pending)) {
    if (now - createdAt <= PENDING_VALIDATION_TTL_MS) continue;
    rmSync(connectionRuntimePaths(validationId).root, { recursive: true, force: true });
    delete pending[validationId];
    changed = true;
  }
  if (changed) writePendingValidations(pending);
}

export async function validateChatGptSessionProvider({
  apiKey,
  providerSpecificData = {},
}: {
  apiKey?: string;
  providerSpecificData?: Record<string, unknown>;
}) {
  try {
    reapAbandonedValidations();

    const secrets = decodeChatGptWebCodexSecrets(String(apiKey || ""));
    if (!secrets.cookie && !secrets.storageState) {
      return {
        valid: false,
        error: "A ChatGPT cookie header or a stored browser session is required.",
      };
    }

    const cdpEndpoint = process.env.CHATGPT_WEB_CODEX_CDP_URL?.trim();
    const chromeExecutablePath = detectChromeExecutable(
      typeof providerSpecificData.chromeExecutablePath === "string"
        ? providerSpecificData.chromeExecutablePath
        : undefined
    );
    if (!chromeExecutablePath && !cdpEndpoint) {
      return {
        valid: false,
        error:
          "No supported Chrome or Chromium was found. Install Chromium or configure the browser path.",
      };
    }

    const validationId = `validation-${randomBytes(12).toString("hex")}`;
    const paths = connectionRuntimePaths(validationId);
    const freshCookie = Boolean(secrets.cookie);
    if (secrets.cookie) ensureConnectionStorageState(validationId, secrets.cookie);
    else ensureConnectionStorageStateFromCredential(validationId, secrets);

    let capabilities;
    try {
      capabilities = await inspectBrowserLoginCapabilities({
        appName: CHATGPT_WEB_CODEX_CONNECTOR_NAME,
        ...(chromeExecutablePath ? { chromeExecutablePath } : {}),
        ...(cdpEndpoint ? { cdpEndpoint } : {}),
        storageStatePath: paths.storageStatePath,
        headed: false,
        proAvailable: false,
        autoApproveToolCalls: false,
      });
    } catch (error) {
      rmSync(paths.root, { recursive: true, force: true });
      throw error;
    }
    if (!freshCookie) rmSync(paths.root, { recursive: true, force: true });
    else registerPendingValidation(validationId);

    return {
      valid: true,
      error: null,
      method: "headless-browser",
      capabilities: {
        browser: "ready",
        storageState: "verified",
        login: "authenticated",
        solAvailable: capabilities.solAvailable,
        proAvailable: capabilities.proAvailable,
      },
      providerSpecificData: {
        solAvailable: capabilities.solAvailable,
        proAvailable: capabilities.proAvailable,
        browserVerified: true,
        ...(chromeExecutablePath ? { chromeExecutablePath } : {}),
        ...(freshCookie ? { validationId } : {}),
      },
    };
  } catch (error) {
    return {
      valid: false,
      error: sanitizeErrorMessage(error instanceof Error ? error.message : error),
    };
  }
}
