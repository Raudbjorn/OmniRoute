import { execFile } from "child_process";
import crypto from "crypto";
import fsSync, { createReadStream } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";
import { promisify } from "util";
import { getChecksums, getReleaseByVersion } from "./releaseChecker.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), ".omniroute");

type Platform = "linux" | "freebsd";
type Arch = "amd64" | "arm64";

function detectPlatform(): Platform {
  const p = os.platform();
  if (p === "linux") return "linux";

  return "linux";
}

function detectArch(): Arch {
  const a = os.arch();
  if (a === "x64") return "amd64";
  if (a === "arm64") return "arm64";
  return "amd64";
}

export function getAssetName(platform?: Platform, arch?: Arch): string {
  const plat = platform || detectPlatform();
  const arc = arch || detectArch();
  return `CLIProxyAPI_{version}_${plat}_${arc}${".tar.gz"}`;
}

export function getTargetPlatform(): { platform: Platform; arch: Arch } {
  return { platform: detectPlatform(), arch: detectArch() };
}

async function downloadFile(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);
  const fileStream = fsSync.createWriteStream(dest);
  await pipeline(res.body as unknown as NodeJS.ReadableStream, fileStream);
}

async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  await execFileAsync("tar", ["xzf", archivePath, "-C", destDir]);
}

async function verifyChecksum(filePath: string, expectedSha256: string): Promise<boolean> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (data: Buffer) => hash.update(data));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex").toLowerCase() === expectedSha256.toLowerCase();
}

function managedBinaryName(): string {
  return "cliproxyapi";
}

function findBinaryInDir(dir: string): string | null {
  const candidates = ["cli-proxy-api", "CLIProxyAPI"];
  for (const name of candidates) {
    if (fsSync.existsSync(path.join(/* turbopackIgnore: true */ dir, name))) {
      return path.join(/* turbopackIgnore: true */ dir, name);
    }
  }
  return null;
}

export async function downloadRelease(
  version: string,
  targetDir: string,
  signal?: AbortSignal,
  // Optional pre-detected target: lets a top-level orchestrator (installVersion)
  // read the runtime platform/arch exactly once and pass the value down instead of
  // this function independently re-reading os.platform()/os.arch() (#10244/#10293).
  target?: { platform: Platform; arch: Arch }
): Promise<string> {
  const release = await getReleaseByVersion(version);
  if (!release) throw new Error(`Version ${version} not found`);

  const { platform, arch } = target || getTargetPlatform();
  const ext = ".tar.gz";
  const assetName = `CLIProxyAPI_${release.version}_${platform}_${arch}${ext}`;
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) throw new Error(`No asset for ${platform}/${arch}`);

  const versionDir = path.join(targetDir, `cliproxyapi-${version}`);
  await fs.mkdir(versionDir, { recursive: true });

  const archivePath = path.join(versionDir, assetName);
  await downloadFile(asset.url, archivePath, signal);

  const checksums = await getChecksums(version);
  if (checksums.size > 0) {
    const expected = checksums.get(assetName);
    if (expected) {
      const valid = await verifyChecksum(archivePath, expected);
      if (!valid) {
        await fs.unlink(archivePath);
        throw new Error(`SHA256 checksum mismatch for ${assetName}`);
      }
    }
  }

  {
    await extractTarGz(archivePath, versionDir);
  }

  await fs.unlink(archivePath).catch(() => {});

  const binary = findBinaryInDir(versionDir);
  if (!binary) throw new Error(`Binary not found in extracted archive`);

  await fs.chmod(binary, 0o755);
  return binary;
}

export async function installVersion(version: string, dataDir?: string): Promise<string> {
  const dir = dataDir || DEFAULT_DATA_DIR;
  const binDir = path.join(dir, "bin");
  await fs.mkdir(binDir, { recursive: true });

  // Single runtime detection for this whole orchestration: read once here and
  // thread the value into downloadRelease() and the symlink/copy decision below,
  // instead of each step re-reading os.platform()/os.arch() independently
  // (#10244/#10293 — redundant reads are each an independent build-folding risk).
  const target = getTargetPlatform();
  const binary = await downloadRelease(version, binDir, undefined, target);

  const symlinkPath = path.join(binDir, managedBinaryName());
  try {
    await fs.unlink(symlinkPath);
  } catch {}
  {
    await fs.symlink(binary, symlinkPath);
  }

  return symlinkPath;
}

export async function getCurrentBinaryPath(dataDir?: string): Promise<string | null> {
  const dir = dataDir || DEFAULT_DATA_DIR;
  const symlinkPath = path.join(dir, "bin", managedBinaryName());
  try {
    const real = await fs.realpath(symlinkPath);
    return fsSync.existsSync(/* turbopackIgnore: true */ real) ? real : null;
  } catch {
    return null;
  }
}

export async function getInstalledVersions(dataDir?: string): Promise<string[]> {
  const dir = dataDir || DEFAULT_DATA_DIR;
  const binDir = path.join(dir, "bin");
  try {
    const entries = await fs.readdir(binDir);
    return entries
      .filter(
        (e) =>
          typeof e === "string" &&
          e.startsWith("cliproxyapi-") &&
          fsSync.statSync(path.join(/* turbopackIgnore: true */ binDir, e)).isDirectory()
      )
      .map((e) => e.replace("cliproxyapi-", ""));
  } catch {
    return [];
  }
}

export async function rollbackVersion(dataDir?: string): Promise<string | null> {
  const versions = await getInstalledVersions(dataDir);
  if (versions.length < 2) return null;

  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const previous = versions[1];

  const dir = dataDir || DEFAULT_DATA_DIR;
  const binDir = path.join(dir, "bin");
  const oldBinary = findBinaryInDir(path.join(binDir, `cliproxyapi-${previous}`));
  if (!oldBinary) return null;

  const symlinkPath = path.join(binDir, managedBinaryName());
  try {
    await fs.unlink(symlinkPath);
  } catch {}
  // Single runtime detection for this orchestration, via the module's one
  // canonical read point (getTargetPlatform -> detectPlatform -> os.platform()),
  // rather than a separate ad hoc os.platform() call (#10244/#10293).
  const { platform } = getTargetPlatform();
  {
    await fs.symlink(oldBinary, symlinkPath);
  }

  return previous;
}

export async function removeVersion(version: string, dataDir?: string): Promise<boolean> {
  const dir = dataDir || DEFAULT_DATA_DIR;
  const versionDir = path.join(dir, "bin", `cliproxyapi-${version}`);
  try {
    await fs.rm(versionDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
