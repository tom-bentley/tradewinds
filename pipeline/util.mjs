// Shared helpers for the Tradewinds data pipeline.
// Node >= 20 built-ins only (global fetch, node:fs, node:path, node:url). No npm dependencies.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";

/** Version stamped into data/meta.json. Bump when the output shape changes. */
export const PIPELINE_VERSION = "2.0.0";

/** Identifies this cron to the public APIs we read. */
export const USER_AGENT = "tradewinds-pipeline/2.0 (personal use)";

/** Minimum gap between outbound requests, so a run never looks like a burst. */
export const POLITE_DELAY_MS = 250;

/** Per-request abort deadline. The 16 MB player dump needs a generous one. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** Extra attempts after the first failure. */
export const FETCH_RETRIES = 2;

/** Backoff between attempts is RETRY_BACKOFF_MS * attemptNumber. */
export const RETRY_BACKOFF_MS = 750;

/** Decimals kept on projected stat values — enough precision, small diffs. */
export const POINTS_DECIMALS = 2;

/** Name suffixes dropped before matching a name across sources. */
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

const INTEGER_ID = /^\d+$/;
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Appends a cache-buster. Sleeper reads sit behind Cloudflare and can serve
 * tens of seconds of stale data without one (R4 §5).
 * @param {string} url
 * @returns {string}
 */
export function withCacheBust(url) {
  return `${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}`;
}

/**
 * Fetch a URL as text with retries, a timeout and a helpful error message.
 * @param {string} url
 * @param {{ cacheBust?: boolean, timeoutMs?: number, retries?: number }} [options]
 * @returns {Promise<string>}
 */
export async function fetchText(url, options = {}) {
  const {
    cacheBust = false,
    timeoutMs = REQUEST_TIMEOUT_MS,
    retries = FETCH_RETRIES,
  } = options;
  const target = cacheBust ? withCacheBust(url) : url;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS * attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(target, {
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
        signal: controller.signal,
        redirect: "follow",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (error) {
      lastError = new Error(
        `fetch failed (attempt ${attempt + 1}/${retries + 1}) for ${url}: ${error.message}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * Fetch a URL and parse it as JSON. Parse failures name the URL.
 * @param {string} url
 * @param {{ cacheBust?: boolean, timeoutMs?: number, retries?: number }} [options]
 * @returns {Promise<unknown>}
 */
export async function fetchJson(url, options) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `invalid JSON from ${url} (${text.length} bytes, starts "${text.slice(0, 60)}"): ${error.message}`,
      { cause: error },
    );
  }
}

/**
 * Minimal RFC-4180 CSV reader: quoted fields, doubled quotes inside them,
 * embedded commas and newlines, CR/LF or LF line endings.
 * @param {string} text
 * @returns {string[][]} rows of raw string fields
 */
export function parseCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let quoted = false;
  let pending = false; // something on this line has been seen

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      pending = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      pending = true;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      pending = false;
    } else if (ch !== "\r") {
      field += ch;
      pending = true;
    }
  }
  if (pending || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * CSV text to header + row objects. Blank trailing lines are dropped.
 * @param {string} text
 * @returns {{ header: string[], records: Record<string, string>[] }}
 */
export function csvRecords(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { header: [], records: [] };
  const header = rows[0].map((name) => name.trim());
  /** @type {Record<string, string>[]} */
  const records = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.length === 1 && row[0].trim() === "") continue;
    /** @type {Record<string, string>} */
    const record = {};
    for (let c = 0; c < header.length; c += 1) record[header[c]] = row[c] ?? "";
    records.push(record);
  }
  return { header, records };
}

/**
 * Coerce a CSV/JSON scalar to a finite number, or null. "NA" and "" are null.
 * @param {unknown} value
 * @returns {number|null}
 */
export function numOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "NA" || trimmed === "null") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Lowercase, de-accent, strip punctuation and generational suffixes, join.
 * "A.J. Brown" and "Travis Etienne Jr." become "ajbrown"/"travisetienne".
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeName(name) {
  if (typeof name !== "string") return "";
  const cleaned = name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");
  const parts = cleaned.split(/\s+/).filter(Boolean);
  while (parts.length > 1 && NAME_SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  return parts.join("");
}

/**
 * Stable id ordering: numeric ids ascending first, then the rest lexically.
 * (V8 already emits integer-like object keys numerically, so this matches
 * what JSON.stringify does and keeps day-to-day diffs minimal.)
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareIds(a, b) {
  const aNum = INTEGER_ID.test(a);
  const bNum = INTEGER_ID.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Rebuild a plain object with its keys in compareIds order.
 * @template T
 * @param {Record<string, T>} source
 * @returns {Record<string, T>}
 */
export function orderedById(source) {
  /** @type {Record<string, T>} */
  const out = {};
  for (const key of Object.keys(source).sort(compareIds)) out[key] = source[key];
  return out;
}

/**
 * Rebuild a plain object with its keys sorted lexically (team codes, source ids).
 * @template T
 * @param {Record<string, T>} source
 * @returns {Record<string, T>}
 */
export function orderedByKey(source) {
  /** @type {Record<string, T>} */
  const out = {};
  for (const key of Object.keys(source).sort()) out[key] = source[key];
  return out;
}

/**
 * @param {number} value
 * @param {number} [decimals]
 * @returns {number}
 */
export function round(value, decimals = POINTS_DECIMALS) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Drop null/undefined/non-finite entries so contract rows stay compact.
 * @template {Record<string, unknown>} T
 * @param {T} record
 * @returns {Partial<T>}
 */
export function compact(record) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out[key] = value;
  }
  return /** @type {Partial<T>} */ (out);
}

/**
 * @param {Date} [date]
 * @returns {string} ISO-8601 to whole seconds, e.g. "2026-09-09T12:00:00Z"
 */
export function isoTimestamp(date = new Date()) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * @param {string} file
 * @returns {unknown|null} parsed JSON, or null when absent/unreadable
 */
export function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write compact JSON plus a trailing newline (git-friendly).
 * @param {string} file
 * @param {unknown} value
 * @returns {{ bytes: number, gzip: number }} raw and gzipped size of what was written
 */
export function writeJsonFile(file, value) {
  const text = `${JSON.stringify(value)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  return { bytes: Buffer.byteLength(text, "utf8"), gzip: gzipBytes(text) };
}

/**
 * Transfer size of a payload once GitHub Pages gzips it.
 * @param {string|Buffer} text
 * @returns {number}
 */
export function gzipBytes(text) {
  return gzipSync(typeof text === "string" ? Buffer.from(text, "utf8") : text, { level: 9 }).length;
}

/**
 * Human-readable byte count: "1,135,834 B (101 KB gz)".
 * @param {{ bytes: number, gzip: number }} size
 * @returns {string}
 */
export function formatSize(size) {
  return `${size.bytes.toLocaleString("en-US")} B (${Math.round(size.gzip / 1024).toLocaleString("en-US")} KB gz)`;
}
