import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FREEBUFF_CODEBUFF_BASE_URL,
  FREEBUFF_FREEBUFF_BASE_URL,
  FREEBUFF_DEFAULT_CREDENTIALS_PATH,
  isFreebuffEnabled,
  resolveFreebuffBaseUrl,
  resolveFreebuffCredentialsPath,
} from "@/lib/providers/freebuff/base";

describe("isFreebuffEnabled", () => {
  const ORIGINAL = process.env.FREEBUFF_ENABLED;

  after(() => {
    if (ORIGINAL === undefined) delete process.env.FREEBUFF_ENABLED;
    else process.env.FREEBUFF_ENABLED = ORIGINAL;
  });

  it("returns true when env var is unset (default ON)", () => {
    delete process.env.FREEBUFF_ENABLED;
    assert.equal(isFreebuffEnabled(), true);
  });

  it("returns true when env var is empty string", () => {
    process.env.FREEBUFF_ENABLED = "";
    assert.equal(isFreebuffEnabled(), true);
  });

  it("returns false when env var is '0' (explicit disable)", () => {
    process.env.FREEBUFF_ENABLED = "0";
    assert.equal(isFreebuffEnabled(), false);
  });

  it("returns false when env var is 'false' (explicit disable)", () => {
    process.env.FREEBUFF_ENABLED = "false";
    assert.equal(isFreebuffEnabled(), false);
  });

  it("returns true when env var is '1'", () => {
    process.env.FREEBUFF_ENABLED = "1";
    assert.equal(isFreebuffEnabled(), true);
  });

  it("returns true when env var is 'true'", () => {
    process.env.FREEBUFF_ENABLED = "true";
    assert.equal(isFreebuffEnabled(), true);
  });
});

describe("resolveFreebuffBaseUrl", () => {
  const ORIGINAL = process.env.FREEBUFF_TIER;

  after(() => {
    if (ORIGINAL === undefined) delete process.env.FREEBUFF_TIER;
    else process.env.FREEBUFF_TIER = ORIGINAL;
  });

  it("returns the free tier by default", () => {
    delete process.env.FREEBUFF_TIER;
    assert.equal(resolveFreebuffBaseUrl(), FREEBUFF_FREEBUFF_BASE_URL);
  });

  it("returns the free tier when FREEBUFF_TIER=free", () => {
    process.env.FREEBUFF_TIER = "free";
    assert.equal(resolveFreebuffBaseUrl(), FREEBUFF_FREEBUFF_BASE_URL);
  });

  it("returns the codebuff tier when FREEBUFF_TIER=codebuff", () => {
    process.env.FREEBUFF_TIER = "codebuff";
    assert.equal(resolveFreebuffBaseUrl(), FREEBUFF_CODEBUFF_BASE_URL);
  });

  it("returns the codebuff tier when FREEBUFF_TIER=paid", () => {
    process.env.FREEBUFF_TIER = "paid";
    assert.equal(resolveFreebuffBaseUrl(), FREEBUFF_CODEBUFF_BASE_URL);
  });
});

describe("resolveFreebuffCredentialsPath", () => {
  const ORIGINAL = process.env.FREEBUFF_CREDENTIALS_PATH;
  const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "";

  after(() => {
    if (ORIGINAL === undefined) delete process.env.FREEBUFF_CREDENTIALS_PATH;
    else process.env.FREEBUFF_CREDENTIALS_PATH = ORIGINAL;
  });

  it("returns the default manicode path (~ expanded) when env var is unset", () => {
    delete process.env.FREEBUFF_CREDENTIALS_PATH;
    if (!HOME) return; // skip if HOME not set
    assert.equal(
      resolveFreebuffCredentialsPath(),
      `${HOME}/.config/manicode/credentials.json`,
    );
    // The default constant still carries the literal ~ for documentation.
    assert.equal(FREEBUFF_DEFAULT_CREDENTIALS_PATH, "~/.config/manicode/credentials.json");
  });

  it("returns the env value when set explicitly", () => {
    process.env.FREEBUFF_CREDENTIALS_PATH = "/etc/freebuff/creds.json";
    assert.equal(
      resolveFreebuffCredentialsPath(),
      "/etc/freebuff/creds.json",
    );
  });

  it("expands a literal '~' to $HOME", () => {
    if (!HOME) return; // skip if HOME not set (Windows unusual env)
    process.env.FREEBUFF_CREDENTIALS_PATH = "~";
    assert.equal(resolveFreebuffCredentialsPath(), HOME);
  });

  it("expands a '~/' prefix to $HOME/", () => {
    if (!HOME) return;
    process.env.FREEBUFF_CREDENTIALS_PATH = "~/creds.json";
    assert.equal(resolveFreebuffCredentialsPath(), `${HOME}/creds.json`);
  });
});
