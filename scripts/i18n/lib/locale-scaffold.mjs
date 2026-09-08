/**
 * Pure text helpers for scaffolding a new locale across every surface that
 * lists the supported languages. Text in, text out — no filesystem and no
 * Prettier: the orchestrator (scripts/i18n/add-locale.mjs) reads each file,
 * transforms it here and writes it back.
 *
 * `entry` is a `config/i18n.json` locale object (`code`, `label`, `name`,
 * `native`, `english`, `flag`, optional `aliases`) plus one helper key that is
 * never stored: `flagFile`, the `docs/assets/flags/<file>` to use when the
 * ISO-3166 file cannot be derived from the flag emoji (e.g. `sw` → `tz.svg`).
 *
 *   insertLocaleEntry(configText, entry)  config/i18n.json
 *   flagFileFor(entry)                    🇬🇷 → "gr.svg"
 *
 * Every insertion leaves the existing lines exactly as they are and places the
 * new one in `code` order (`localeCompare`, "en"): right before the first
 * existing entry that sorts after it, or after the last one. Duplicates throw.
 */

const REGIONAL_INDICATOR_A = 0x1f1e6;
const REGIONAL_INDICATOR_Z = REGIONAL_INDICATOR_A + 25;

function compareCodes(a, b) {
  return a.localeCompare(b, "en");
}

function requireCode(entry) {
  if (!entry || typeof entry.code !== "string" || entry.code.length === 0) {
    throw new Error("locale entry needs a non-empty code");
  }
  return entry.code;
}

function insertInCodeOrder(items, item, codeOf) {
  const code = codeOf(item);
  const at = items.findIndex((existing) => compareCodes(codeOf(existing), code) > 0);
  return at === -1 ? [...items, item] : [...items.slice(0, at), item, ...items.slice(at)];
}

export function flagFileFor(entry) {
  if (entry.flagFile) return entry.flagFile;
  const codePoints =
    typeof entry.flag === "string" ? [...entry.flag].map((char) => char.codePointAt(0)) : [];
  const isRegionalPair =
    codePoints.length === 2 &&
    codePoints.every((cp) => cp >= REGIONAL_INDICATOR_A && cp <= REGIONAL_INDICATOR_Z);
  if (!isRegionalPair) {
    throw new Error(`cannot derive a flag file from ${entry.flag}; pass flagFile explicitly`);
  }
  return (
    codePoints.map((cp) => String.fromCharCode(cp - REGIONAL_INDICATOR_A + 97)).join("") + ".svg"
  );
}

export function insertLocaleEntry(configText, entry) {
  const code = requireCode(entry);
  const config = JSON.parse(configText);
  if (!Array.isArray(config.locales)) throw new Error("config has no locales array");
  if (config.locales.some((locale) => locale.code === code)) {
    throw new Error(`${code} is already configured`);
  }
  const stored = { ...entry };
  delete stored.flagFile;
  config.locales = insertInCodeOrder(config.locales, stored, (locale) => locale.code);
  return JSON.stringify(config, null, 2) + "\n";
}
