import { execSync } from "child_process";
import { readFileSync } from "fs";
import os from "os";

let cachedRawId: string | null = null;

/**
 * Resets the cached machine ID.  Used primarily for testing so each
 * test case starts with a clean cache.
 */
export function resetMachineIdCache(): void {
  cachedRawId = null;
}

function getMachineIdRaw(): string {
  // Return cached result immediately (machine identity is stable at runtime)
  if (cachedRawId !== null) return cachedRawId;

  // Strategy 3: Linux — read machine-id files directly (no `head` or pipe)
  try {
    for (const filePath of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const content = readFileSync(/* turbopackIgnore: true */ filePath, "utf8")
          .trim()
          .toLowerCase();
        if (content.length > 8) {
          cachedRawId = content;
          return content;
        }
      } catch {
        // Try the next candidate file
      }
    }
  } catch {
    // Files not readable — continue
  }

  // Strategy 4: Node.js os.hostname() — no child process, works everywhere
  try {
    const hostname = os.hostname().toLowerCase();
    if (hostname) {
      cachedRawId = hostname;
      return hostname;
    }
  } catch {
    // os.hostname() not available — continue
  }

  // Strategy 5: execSync("hostname") shell fallback (for constrained environments)
  try {
    const hostname = execSync("hostname", { encoding: "utf8", timeout: 5000 });
    const id = hostname.trim().toLowerCase();
    if (id) {
      cachedRawId = id;
      return id;
    }
  } catch {
    // hostname failed — continue
  }

  cachedRawId = "unknown-machine";
  return "unknown-machine";
}

async function getRandomMachineFallbackId() {
  try {
    const cryptoFallback = await import("crypto");
    return cryptoFallback.randomUUID();
  } catch {
    if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      let r = 0;
      if (
        typeof globalThis !== "undefined" &&
        globalThis.crypto &&
        globalThis.crypto.getRandomValues
      ) {
        const arr = new Uint8Array(1);
        globalThis.crypto.getRandomValues(arr);
        r = arr[0] % 16;
      } else {
        r = (Date.now() % 16) | 0;
      }
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

/**
 * Get consistent machine ID using native registry/OS query with salt
 * This ensures the same physical machine gets the same ID across runs
 *
 * @param {string} salt - Optional salt to use (defaults to environment variable)
 * @returns {Promise<string>} Machine ID (16-character base32)
 */
export async function getConsistentMachineId(salt = null) {
  const saltValue = salt || process.env.MACHINE_ID_SALT || "endpoint-proxy-salt";
  try {
    const rawMachineId = getMachineIdRaw();
    // Create consistent ID using salt
    const crypto = await import("crypto");
    const hashedMachineId = crypto
      .createHash("sha256")
      .update(rawMachineId + saltValue)
      .digest("hex");
    // Return only first 16 characters for brevity
    return hashedMachineId.substring(0, 16);
  } catch (error) {
    console.log("Error getting machine ID:", error);
    // Fallback to random ID if node-machine-id fails
    return getRandomMachineFallbackId();
  }
}

/**
 * Get raw machine ID without hashing (for debugging purposes)
 * @returns {Promise<string>} Raw machine ID
 */
export async function getRawMachineId() {
  try {
    return getMachineIdRaw();
  } catch (error) {
    console.log("Error getting raw machine ID:", error);
    // Fallback to random ID if node-machine-id fails
    return getRandomMachineFallbackId();
  }
}

/**
 * Check if we're running in browser or server environment
 * @returns {boolean} True if in browser, false if in server
 */
export function isBrowser() {
  return typeof window !== "undefined";
}
