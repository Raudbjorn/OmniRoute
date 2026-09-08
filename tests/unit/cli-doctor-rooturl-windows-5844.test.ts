import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("fileURLToPath does not keep the leading-slash drive-letter defect on the current platform", () => {
  // On any platform, fileURLToPath never yields a path starting with "/C:" for a
  // same-platform URL — it fully normalizes drive letters (win32) or leaves POSIX
  // paths untouched (posix), unlike the raw `.pathname` accessor used by the bug.
  const here = fileURLToPath(import.meta.url);
  assert.equal(here.startsWith("/C:"), false);
});

test("doctor.mjs source uses fileURLToPath(import.meta.url) and not the buggy new URL(...).pathname pattern", () => {
  const doctorSource = fs.readFileSync(path.resolve("bin/cli/commands/doctor.mjs"), "utf8");

  assert.match(
    doctorSource,
    /fileURLToPath\(import\.meta\.url\)/,
    "doctor.mjs must resolve rootDir via fileURLToPath(import.meta.url)"
  );

  assert.doesNotMatch(
    doctorSource,
    /new URL\(import\.meta\.url\)\.pathname/,
    "doctor.mjs must not regress to the buggy new URL(import.meta.url).pathname pattern"
  );
});
