import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { insertLocaleEntry, flagFileFor } from "../../scripts/i18n/lib/locale-scaffold.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readRepo = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

type LocaleEntry = {
  code: string;
  label?: string;
  name?: string;
  native: string;
  english?: string;
  flag: string;
  flagFile?: string;
  aliases?: string[];
};

type I18nConfig = {
  $schema?: string;
  default: string;
  rtl: string[];
  uiOnly?: string[];
  docsExcluded?: string[];
  locales: LocaleEntry[];
};

const el: LocaleEntry = {
  code: "el",
  label: "EL",
  name: "Ελληνικά",
  native: "Ελληνικά",
  english: "Greek",
  flag: "🇬🇷",
};

// A locale code that can never be configured, so the real-file tests keep passing after any
// real locale (Greek included) lands. Fails loudly if every candidate is taken.
const SENTINEL_CANDIDATES = ["zz", "zy", "zx"];
const sentinelCode = (config: I18nConfig): string => {
  const configured = new Set(config.locales.map((l) => l.code));
  const code = SENTINEL_CANDIDATES.find((candidate) => !configured.has(candidate));
  assert.ok(
    code,
    `every sentinel code (${SENTINEL_CANDIDATES.join(", ")}) is configured — extend SENTINEL_CANDIDATES`
  );
  return code;
};

// ---------------------------------------------------------------------------
// insertLocaleEntry
// ---------------------------------------------------------------------------

test("insertLocaleEntry keeps alphabetical order by code and rejects duplicates", () => {
  const cfg = JSON.stringify({
    default: "en",
    rtl: [],
    locales: [{ code: "de" }, { code: "en" }, { code: "es" }],
  });
  const out = JSON.parse(insertLocaleEntry(cfg, el)) as I18nConfig;
  assert.deepEqual(
    out.locales.map((l) => l.code),
    ["de", "el", "en", "es"]
  );
  assert.throws(() => insertLocaleEntry(JSON.stringify(out), el), /already configured/);
});

test("insertLocaleEntry inserts at both ends, strips flagFile and stores the entry's own keys", () => {
  const cfg = JSON.stringify({ default: "en", rtl: [], locales: [{ code: "de" }, { code: "es" }] });
  const first = JSON.parse(insertLocaleEntry(cfg, { ...el, code: "aa" })) as I18nConfig;
  assert.deepEqual(
    first.locales.map((l) => l.code),
    ["aa", "de", "es"]
  );
  const last = JSON.parse(
    insertLocaleEntry(cfg, { ...el, code: "zz", flagFile: "gr.svg", aliases: ["zz-x"] })
  ) as I18nConfig;
  assert.deepEqual(
    last.locales.map((l) => l.code),
    ["de", "es", "zz"]
  );
  assert.deepEqual(last.locales[2], {
    code: "zz",
    label: "EL",
    name: "Ελληνικά",
    native: "Ελληνικά",
    english: "Greek",
    flag: "🇬🇷",
    aliases: ["zz-x"],
  });
  assert.throws(() => insertLocaleEntry(cfg, { ...el, code: "" }), /code/);
});

test("insertLocaleEntry on the real config keeps every top-level key, its order and the existing code order", () => {
  const raw = readRepo("config/i18n.json");
  const before = JSON.parse(raw) as I18nConfig;
  const entry: LocaleEntry = { ...el, code: sentinelCode(before) };
  const text = insertLocaleEntry(raw, { ...entry, flagFile: "gr.svg" });
  assert.ok(text.endsWith("}\n"));
  const after = JSON.parse(text) as I18nConfig;

  assert.deepEqual(Object.keys(after), Object.keys(before));
  const { locales: beforeLocales, ...beforeRest } = before;
  const { locales: afterLocales, ...afterRest } = after;
  assert.deepEqual(afterRest, beforeRest);

  // The existing entries are untouched and keep their relative order.
  assert.equal(afterLocales.length, beforeLocales.length + 1);
  assert.deepEqual(
    afterLocales.filter((l) => l.code !== entry.code),
    beforeLocales
  );
  // ...and the new entry sits exactly where a full localeCompare("en") sort would put it:
  // before the first existing code that sorts after it, or last when none does.
  const sorted = [...beforeLocales.map((l) => l.code), entry.code].sort((a, b) =>
    a.localeCompare(b, "en")
  );
  assert.deepEqual(
    afterLocales.map((l) => l.code),
    sorted
  );
  const next = beforeLocales.findIndex((l) => l.code.localeCompare(entry.code, "en") > 0);
  assert.equal(
    afterLocales.findIndex((l) => l.code === entry.code),
    next === -1 ? beforeLocales.length : next
  );
  assert.deepEqual(
    afterLocales.find((l) => l.code === entry.code),
    entry
  );
});

// ---------------------------------------------------------------------------
// flagFileFor
// ---------------------------------------------------------------------------

test("flagFileFor derives the ISO-3166 file from the emoji and honours an override", () => {
  assert.equal(flagFileFor(el), "gr.svg");
  assert.equal(flagFileFor({ ...el, code: "kn", flag: "🇮🇳", flagFile: "in.svg" }), "in.svg");
  // An override that differs from the derivation proves the override really wins.
  assert.equal(flagFileFor({ ...el, code: "sw", flag: "🇰🇪", flagFile: "tz.svg" }), "tz.svg");
  assert.equal(flagFileFor({ ...el, code: "ja", flag: "🇯🇵" }), "jp.svg");
});

test("flagFileFor rejects anything that is not a regional-indicator pair unless flagFile is given", () => {
  assert.throws(() => flagFileFor({ ...el, flag: "🏳️" }), /pass flagFile explicitly/);
  assert.throws(() => flagFileFor({ ...el, flag: "🇬" }), /pass flagFile explicitly/);
  assert.throws(() => flagFileFor({ ...el, flag: "GR" }), /pass flagFile explicitly/);
  const noFlag: Partial<LocaleEntry> = { code: "x", native: "x" };
  assert.throws(() => flagFileFor(noFlag as LocaleEntry), /pass flagFile explicitly/);
  assert.equal(flagFileFor({ ...el, flag: "🏳️", flagFile: "custom.svg" }), "custom.svg");
});

