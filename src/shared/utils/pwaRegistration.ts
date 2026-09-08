const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeHostname(hostname: string | null | undefined): string {
  return (hostname || "").trim().toLowerCase();
}

export function shouldEnablePwaRegistration(options: {
  hostname?: string | null;
  isDevelopment?: boolean;
}): boolean {
  const hostname = normalizeHostname(options.hostname);

  if (options.isDevelopment) {
    return false;
  }

  if (!hostname) {
    return true;
  }

  return !LOOPBACK_HOSTNAMES.has(hostname);
}

export function isOmniRouteServiceWorkerScript(scriptUrl: string | null | undefined): boolean {
  if (!scriptUrl) {
    return false;
  }

  try {
    const parsedUrl = new URL(scriptUrl);
    return parsedUrl.pathname === "/sw.js";
  } catch {
    return false;
  }
}
