/**
 * OpenCode installation detection.
 * Purely filesystem-based — no shell interpolation (Hard Rule #13).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DetectionResult } from "../types";

const HOME = os.homedir();
const PATHS = [
  "/usr/bin/opencode",
  "/usr/local/bin/opencode",
  path.join(HOME, ".local", "bin", "opencode"),
  path.join(HOME, ".opencode"),
  path.join(HOME, ".config", "opencode"),
];

export function detectOpenCode(): DetectionResult {
  for (const p of PATHS) {
    if (fs.existsSync(p)) return { installed: true, path: p };
  }
  return { installed: false };
}
