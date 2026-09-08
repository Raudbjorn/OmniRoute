// Node.js-only route: uses child_process, fs, path via mitm/manager
// Dynamic imports prevent Turbopack from statically resolving native modules
export const runtime = "nodejs";

import { requireCliToolsAuth } from "@/lib/api/requireCliToolsAuth";
import { isSudoPasswordRequired } from "@/mitm/dns/dnsConfig";
import { isRoot } from "@/mitm/systemCommands";
import { resolveApiKey } from "@/shared/services/apiKeyResolver";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { cliMitmStartSchema, cliMitmStopSchema } from "@/shared/validation/schemas";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { NextResponse } from "next/server";

// GET - Check MITM status
export async function GET(request) {
  const authError = await requireCliToolsAuth(request);
  if (authError) return authError;

  try {
    const { getMitmStatus, getCachedPassword } = await import("@/mitm/manager.runtime");
    const status = await getMitmStatus();

    const hasCachedPassword = !!getCachedPassword();

    const needsSudoPassword = !hasCachedPassword && isSudoPasswordRequired();
    return NextResponse.json({
      running: status.running,
      pid: status.pid || null,
      dnsConfigured: status.dnsConfigured,
      certExists: status.certExists,
      hasCachedPassword,

      needsSudoPassword,
    });
  } catch (error) {
    console.log("Error getting MITM status:", sanitizeErrorMessage(error));
    return NextResponse.json({ error: "Failed to get MITM status" }, { status: 500 });
  }
}

// POST - Start MITM proxy
export async function POST(request) {
  const authError = await requireCliToolsAuth(request);
  if (authError) return authError;

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const validation = validateBody(cliMitmStartSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { apiKey: rawApiKey, keyId: rawKeyId, sudoPassword } = validation.data;
    const apiKeyId = rawKeyId ?? null;
    const apiKey = await resolveApiKey(apiKeyId, rawApiKey);
    if (!apiKey || apiKey === "sk_omniroute") {
      return NextResponse.json(
        { error: "Missing apiKey: provide a valid apiKey or a resolvable keyId" },
        { status: 400 }
      );
    }
    const { startMitm, getCachedPassword, setCachedPassword } =
      await import("@/mitm/manager.runtime");

    const isRootUser = isRoot();
    const pwd = sudoPassword || getCachedPassword() || "";

    if (!pwd && !isRootUser && isSudoPasswordRequired()) {
      return NextResponse.json({ error: "Missing sudoPassword" }, { status: 400 });
    }

    const result = await startMitm(apiKey, pwd);
    if (pwd) setCachedPassword(pwd);

    return NextResponse.json({
      success: true,
      running: result.running,
      pid: result.pid,
    });
  } catch (error) {
    console.log("Error starting MITM:", sanitizeErrorMessage(error));
    return NextResponse.json(
      { error: sanitizeErrorMessage(error) || "Failed to start MITM proxy" },
      { status: 500 }
    );
  }
}

// DELETE - Stop MITM proxy
export async function DELETE(request) {
  const authError = await requireCliToolsAuth(request);
  if (authError) return authError;

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const validation = validateBody(cliMitmStopSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { sudoPassword } = validation.data;
    const { stopMitm, getCachedPassword, setCachedPassword } =
      await import("@/mitm/manager.runtime");

    const isRootUser = isRoot();
    const pwd = sudoPassword || getCachedPassword() || "";

    if (!pwd && !isRootUser && isSudoPasswordRequired()) {
      return NextResponse.json({ error: "Missing sudoPassword" }, { status: 400 });
    }

    await stopMitm(pwd);
    if (sudoPassword) setCachedPassword(sudoPassword);

    return NextResponse.json({ success: true, running: false });
  } catch (error) {
    console.log("Error stopping MITM:", sanitizeErrorMessage(error));
    return NextResponse.json(
      { error: sanitizeErrorMessage(error) || "Failed to stop MITM proxy" },
      { status: 500 }
    );
  }
}
