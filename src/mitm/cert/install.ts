import { exec } from "child_process";
import crypto from "crypto";
import fs from "fs";
import { execFileWithPassword, getErrorMessage } from "../systemCommands.ts";

const LINUX_CERT_NAME = "omniroute-mitm.crt";

interface LinuxCertConfig {
  dir: string;
  cmd: string;
}

const LINUX_CERT_PATHS: LinuxCertConfig[] = [
  // Debian / Ubuntu
  { dir: "/usr/local/share/ca-certificates", cmd: "update-ca-certificates" },
  // Arch Linux / CachyOS / Manjaro
  { dir: "/etc/ca-certificates/trust-source/anchors", cmd: "update-ca-trust" },
  // Fedora / RHEL / CentOS
  { dir: "/etc/pki/ca-trust/source/anchors", cmd: "update-ca-trust" },
  // openSUSE
  { dir: "/etc/pki/trust/anchors", cmd: "update-ca-certificates" },
];

function getLinuxCertConfig(): LinuxCertConfig {
  for (const config of LINUX_CERT_PATHS) {
    if (fs.existsSync(config.dir)) {
      return config;
    }
  }
  return LINUX_CERT_PATHS[0];
}

async function updateNssDatabases(
  certPath: string | null,
  action: "add" | "delete" = "add"
): Promise<void> {
  // Pass the runtime values via environment variables instead of string
  // interpolation. The shell receives them through its env and dereferences
  // with "$CERT_PATH" / "$CERT_NAME" / "$ACTION", so any shell metacharacters
  // they may contain stay inside the quoted argument — eliminating the
  // command-injection surface flagged by CodeQL js/shell-command-injection.
  const script = `
    set -u
    if ! command -v certutil &> /dev/null; then
      exit 0
    fi

    DIRS="$HOME/.pki/nssdb $HOME/snap/chromium/current/.pki/nssdb"

    if [ -d "$HOME/.mozilla/firefox" ]; then
      for profile in "$HOME"/.mozilla/firefox/*/; do
        if [ -f "\${profile}cert9.db" ] || [ -f "\${profile}cert8.db" ]; then
          DIRS="$DIRS $profile"
        fi
      done
    fi

    if [ -d "$HOME/snap/firefox/common/.mozilla/firefox" ]; then
      for profile in "$HOME"/snap/firefox/common/.mozilla/firefox/*/; do
        if [ -f "\${profile}cert9.db" ] || [ -f "\${profile}cert8.db" ]; then
          DIRS="$DIRS $profile"
        fi
      done
    fi

    for db in $DIRS; do
      if [ -d "$db" ]; then
        if [ "$ACTION" = "add" ]; then
          certutil -d sql:"$db" -A -t "C,," -n "$CERT_NAME" -i "$CERT_PATH" 2>/dev/null || \\
          certutil -d "$db" -A -t "C,," -n "$CERT_NAME" -i "$CERT_PATH" 2>/dev/null || true
        else
          certutil -d sql:"$db" -D -n "$CERT_NAME" 2>/dev/null || \\
          certutil -d "$db" -D -n "$CERT_NAME" 2>/dev/null || true
        fi
      fi
    done
  `;

  return new Promise((resolve) => {
    exec(
      script,
      {
        shell: "/bin/bash",
        env: {
          ...process.env,
          CERT_NAME: "OmniRoute MITM Root CA",
          CERT_PATH: certPath || "",
          ACTION: action,
        },
      },
      () => resolve()
    );
  });
}

// Get SHA1 fingerprint from cert file using Node.js crypto
function getCertFingerprint(certPath: string): string {
  const pem = fs.readFileSync(certPath, "utf-8");
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64");
  const pairs = crypto.createHash("sha1").update(der).digest("hex").toUpperCase().match(/.{2}/g);
  if (!pairs) {
    throw new Error(`Unable to compute certificate fingerprint for ${certPath}`);
  }
  return pairs.join(":");
}

/**
 * Check if certificate is already installed in system store
 */
export async function checkCertInstalled(certPath: string): Promise<boolean> {
  return checkCertInstalledLinux(certPath);
}

async function checkCertInstalledLinux(certPath: string): Promise<boolean> {
  try {
    const config = getLinuxCertConfig();
    const destFile = `${config.dir}/${LINUX_CERT_NAME}`;
    if (!fs.existsSync(destFile)) return false;
    return getCertFingerprint(certPath) === getCertFingerprint(destFile);
  } catch {
    return false;
  }
}

/**
 * Install SSL certificate to system trust store
 */
export async function installCert(sudoPassword: string, certPath: string): Promise<void> {
  if (!fs.existsSync(certPath)) {
    throw new Error(`Certificate file not found: ${certPath}`);
  }

  const isInstalled = await checkCertInstalled(certPath);
  if (isInstalled) {
    // #9442: the fingerprint matched, but a restrictive umask at install time
    // may have left the system cert as 0600 — unreadable by non-root TLS
    // clients (curl, reqwest, uv, Python requests). Repair the mode before
    // the early return so re-running install fixes a previously wrong-mode
    // cert instead of silently skipping it.
    {
      const config = getLinuxCertConfig();
      await ensureSystemCertMode(`${config.dir}/${LINUX_CERT_NAME}`, sudoPassword);
    }
    console.log("✅ Certificate already installed");
    return;
  }

  if (process.env.OMNIROUTE_SKIP_SYSTEM_TRUST === "1") {
    console.log("[cert] OMNIROUTE_SKIP_SYSTEM_TRUST=1 — skipping OS trust-store mutation");
    return;
  }

  {
    await installCertLinux(sudoPassword, certPath);
  }
}

// ── Graceful fallback for containers / headless environments (#4546) ──────────
//
// In a container the system trust store can't be written (no sudo / read-only
// store / no interactive auth), so installCert() throws and used to abort the
// whole Agent Bridge start. The helpers below let callers treat that as a
// recoverable "skip" with a manual-install guide, instead of a hard failure.

const CERT_DOWNLOAD_URL = "/api/tools/agent-bridge/cert/download";

/** Why an automatic cert install did not complete. */
export type CertInstallReason = "canceled" | "environment";

/** Platform-specific steps the operator can run to trust the MITM root CA by hand. */
export interface CertManualGuide {
  platform: NodeJS.Platform;
  certPath: string;
  downloadUrl: string;
  steps: string[];
}

/** Structured outcome of an attempted cert install (never throws for env failures). */
export interface CertInstallResult {
  installed: boolean;
  skipped: boolean;
  reason?: CertInstallReason;
  /** Safe, already-sanitized message (no stack trace). */
  message?: string;
  manualGuide?: CertManualGuide;
}

/**
 * Classify a cert-install failure message. Only an explicit user cancellation
 * counts as "canceled"; every other failure (missing trust store, no sudo,
 * read-only FS, container) is treated as an "environment" failure that the
 * operator can resolve with a manual install.
 */
export function classifyCertInstallError(message: string): CertInstallReason {
  return /cancel+ed/i.test(message) ? "canceled" : "environment";
}

/**
 * Build the manual-install instructions for trusting the MITM root CA on the
 * given platform. Pure + platform-overridable so it is fully unit-testable.
 */
export function buildCertManualGuide(
  certPath: string,
  platform: NodeJS.Platform = process.platform
): CertManualGuide {
  let steps: string[];
  {
    // Linux — match the detected distro's anchor dir + refresh command.
    const config = getLinuxCertConfig();
    steps = [
      `sudo cp "${certPath}" ${config.dir}/${LINUX_CERT_NAME}`,
      `sudo ${config.cmd}`,
      `Container-friendly per-tool trust (no root needed): set NODE_EXTRA_CA_CERTS="${certPath}" (Node) or REQUESTS_CA_BUNDLE="${certPath}" (Python), or import "${certPath}" into your client's trust store.`,
    ];
  }
  return { platform, certPath, downloadUrl: CERT_DOWNLOAD_URL, steps };
}

/**
 * Attempt to install the cert, returning a structured result instead of
 * throwing on environment failures. A user-canceled authorization is reported
 * with reason "canceled" (not skipped); any other failure is reported as a
 * skippable "environment" failure carrying a manual-install guide so the bridge
 * can still start and the operator can trust the CA by hand.
 */
export async function installCertResult(
  sudoPassword: string,
  certPath: string
): Promise<CertInstallResult> {
  try {
    await installCert(sudoPassword, certPath);
    return { installed: true, skipped: false };
  } catch (error) {
    const message = getErrorMessage(error);
    const reason = classifyCertInstallError(message);
    if (reason === "canceled") {
      return { installed: false, skipped: false, reason, message };
    }
    return {
      installed: false,
      skipped: true,
      reason,
      message,
      manualGuide: buildCertManualGuide(certPath),
    };
  }
}

/**
 * Install the persisted MITM root CA cert (`cert/rootCa.ts`) into the OS
 * trust store. Named wrapper over {@link installCertResult} for call-site
 * clarity — the underlying platform installers
 * (`installCertLinux`/`installCertMac`/`installCertWindows`) are already
 * cert-path-agnostic and keep writing to the same `omniroute-mitm.crt`
 * trust-store slot the old single-leaf install used, so the CA cert simply
 * supersedes the old leaf under that slot; no new slot, no dual-trust
 * cleanup needed. Distinct from TPROXY's own `omniroute-tproxy-ca.crt` slot
 * (`src/mitm/tproxy/caTrust.ts`), which this feature does not touch. #6684
 */
export async function installCaCert(
  sudoPassword: string,
  caCertPath: string
): Promise<CertInstallResult> {
  return installCertResult(sudoPassword, caCertPath);
}

async function installCertLinux(sudoPassword: string, certPath: string): Promise<void> {
  try {
    const config = getLinuxCertConfig();
    const destFile = `${config.dir}/${LINUX_CERT_NAME}`;

    await execFileWithPassword("sudo", ["-S", "mkdir", "-p", config.dir], sudoPassword);
    await execFileWithPassword("sudo", ["-S", "cp", certPath, destFile], sudoPassword);
    // #9442: `cp` inherits the process umask. A restrictive umask (e.g. PM2
    // UMask=0077) creates the system cert as 0600 root:root, unreadable by
    // non-root TLS clients. Force the public cert to 0644 (world-readable).
    await execFileWithPassword("sudo", ["-S", "chmod", "0644", destFile], sudoPassword);
    await execFileWithPassword("sudo", ["-S", config.cmd], sudoPassword);

    await updateNssDatabases(certPath, "add");
  } catch (error) {
    const message = getErrorMessage(error);
    const msg = message.includes("canceled")
      ? "User canceled authorization"
      : "Certificate install failed";
    throw new Error(msg);
  }
}

/**
 * #9442 — ensure the system trust-store cert is world-readable (mode 0644).
 *
 * `installCertLinux()` now sets the mode explicitly after `cp`, but a cert
 * installed by an older build (before the chmod was added) may still be 0600
 * from a restrictive umask. `checkCertInstalledLinux()` only compares
 * fingerprints, so {@link installCert}'s already-installed branch calls this
 * helper to repair the mode on re-run. Best-effort: a stat/chmod failure
 * (e.g. dest removed between the fingerprint check and here) is swallowed —
 * the caller still reports "already installed" and a fresh install will run
 * next time the fingerprint no longer matches.
 */
export async function ensureSystemCertMode(destFile: string, sudoPassword: string): Promise<void> {
  try {
    const mode = fs.statSync(destFile).mode & 0o777;
    if (mode !== 0o644) {
      await execFileWithPassword("sudo", ["-S", "chmod", "0644", destFile], sudoPassword);
    }
  } catch {
    // best-effort: if stat/chmod fails, the mode repair is skipped
  }
}

/**
 * Uninstall SSL certificate from system store
 */
export async function uninstallCert(sudoPassword: string, certPath: string): Promise<void> {
  const isInstalled = await checkCertInstalled(certPath);
  if (!isInstalled) {
    console.log("Certificate not found in system store");
    return;
  }

  if (process.env.OMNIROUTE_SKIP_SYSTEM_TRUST === "1") {
    console.log("[cert] OMNIROUTE_SKIP_SYSTEM_TRUST=1 — skipping OS trust-store mutation");
    return;
  }

  {
    await uninstallCertLinux(sudoPassword, certPath);
  }
}

async function uninstallCertLinux(sudoPassword: string, certPath: string): Promise<void> {
  try {
    await updateNssDatabases(null, "delete");

    const config = getLinuxCertConfig();
    const destFile = `${config.dir}/${LINUX_CERT_NAME}`;

    if (fs.existsSync(destFile)) {
      await execFileWithPassword("sudo", ["-S", "rm", "-f", destFile], sudoPassword);
    }

    try {
      await execFileWithPassword("sudo", ["-S", config.cmd, "--fresh"], sudoPassword);
    } catch {
      await execFileWithPassword("sudo", ["-S", config.cmd], sudoPassword);
    }
  } catch (err) {
    throw new Error("Failed to uninstall certificate");
  }
}
