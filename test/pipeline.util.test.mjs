// Pipeline helpers: CSV parsing, name normalization, id ordering. No network.

import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  PIPELINE_VERSION,
  compact,
  compareIds,
  csvRecords,
  formatSize,
  gzipBytes,
  normalizeName,
  numOrNull,
  orderedById,
  orderedByKey,
  parseCsv,
  round,
  withCacheBust,
  writeJsonFile,
} from "../pipeline/util.mjs";

test("parseCsv handles plain rows", () => {
  assert.deepEqual(parseCsv("a,b,c\n1,2,3\n"), [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
});

test("parseCsv handles quoted fields, embedded commas, quotes and newlines", () => {
  const text = '"player","note"\n"Smith, Jr.","said ""hi"""\n"multi\nline","x"\n';
  assert.deepEqual(parseCsv(text), [
    ["player", "note"],
    ["Smith, Jr.", 'said "hi"'],
    ["multi\nline", "x"],
  ]);
});

test("parseCsv handles CRLF, an unterminated last line and empty fields", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,\r\n2,3"), [
    ["a", "b"],
    ["1", ""],
    ["2", "3"],
  ]);
});

test("parseCsv on empty input yields no rows", () => {
  assert.deepEqual(parseCsv(""), []);
});

test("csvRecords keys rows by header and drops blank trailing lines", () => {
  const { header, records } = csvRecords('"a","b"\n1,2\n\n');
  assert.deepEqual(header, ["a", "b"]);
  assert.deepEqual(records, [{ a: "1", b: "2" }]);
});

test("numOrNull treats NA and blank as unknown", () => {
  assert.equal(numOrNull("12.5"), 12.5);
  assert.equal(numOrNull("NA"), null);
  assert.equal(numOrNull(""), null);
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(Number.NaN), null);
  assert.equal(numOrNull(0), 0);
});

test("normalizeName strips punctuation, accents and generational suffixes", () => {
  assert.equal(normalizeName("Travis Etienne Jr."), "travisetienne");
  assert.equal(normalizeName("A.J. Brown"), "ajbrown");
  assert.equal(normalizeName("De'Von Achane"), "devonachane");
  assert.equal(normalizeName("Marvin Harrison Jr"), "marvinharrison");
  assert.equal(normalizeName("Vinny Anthony II"), "vinnyanthony");
  assert.equal(normalizeName("Amon-Ra St. Brown"), "amonrastbrown");
  assert.equal(normalizeName(undefined), "");
});

test("compareIds orders numeric ids first, then team codes", () => {
  const ids = ["KC", "9221", "19", "ARI", "12529"];
  assert.deepEqual(ids.slice().sort(compareIds), ["19", "9221", "12529", "ARI", "KC"]);
});

test("orderedById and orderedByKey produce a stable serialization", () => {
  const first = orderedById({ KC: 1, 9221: 2, 19: 3, ARI: 4 });
  const second = orderedById({ ARI: 4, 19: 3, KC: 1, 9221: 2 });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(orderedByKey({ b: 1, a: 2 })), '{"a":2,"b":1}');
});

test("compact drops null, undefined and non-finite fields but keeps zero", () => {
  assert.deepEqual(compact({ v: 0, r: null, pr: undefined, t: Number.NaN, sd: 1.5 }), { v: 0, sd: 1.5 });
});

test("round trims to two decimals by default", () => {
  assert.equal(round(21.3599999), 21.36);
  assert.equal(round(1.005, 2), 1.0);
});

test("withCacheBust appends cb with the right separator", () => {
  assert.match(withCacheBust("https://x/y"), /^https:\/\/x\/y\?cb=\d+$/);
  assert.match(withCacheBust("https://x/y?a=1"), /^https:\/\/x\/y\?a=1&cb=\d+$/);
});

test("the pipeline version is the league-agnostic v2 schema", () => {
  assert.match(PIPELINE_VERSION, /^2\./);
});

test("gzipBytes measures what GitHub Pages will actually transfer", () => {
  const text = JSON.stringify({ players: Array.from({ length: 500 }, (_, i) => [i, i / 3]) });
  const size = gzipBytes(text);
  assert.ok(size > 0 && size < text.length, `gzip ${size} vs raw ${text.length}`);
  assert.equal(gzipBytes(Buffer.from(text, "utf8")), size);
});

test("writeJsonFile reports raw and gzip size and writes parseable JSON with a trailing newline", () => {
  const file = join(mkdtempSync(join(tmpdir(), "tradewinds-util-")), "out.json");
  const value = { a: 1, b: [1, 2, 3] };
  const size = writeJsonFile(file, value);

  const written = readFileSync(file, "utf8");
  assert.equal(written, `${JSON.stringify(value)}\n`);
  assert.equal(size.bytes, Buffer.byteLength(written, "utf8"));
  assert.equal(size.gzip, gzipBytes(written));
  assert.deepEqual(JSON.parse(written), value);
  assert.equal(gunzipSync(gzipSync(Buffer.from(written, "utf8"))).toString("utf8"), written);
});

test("formatSize prints thousands separators and KB of gzip", () => {
  assert.equal(formatSize({ bytes: 1135834, gzip: 103424 }), "1,135,834 B (101 KB gz)");
});
