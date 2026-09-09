// Guards the deploy rule: a new app version must ship a new service-worker cache name, or
// installed PWAs keep serving the previous modules for one extra launch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const { APP_VERSION } = await import("../src/config.js");

test("sw.js CACHE name tracks APP_VERSION", () => {
  const m = sw.match(/^const CACHE = "([^"]+)";/m);
  assert.ok(m, "sw.js must declare `const CACHE = \"...\";`");
  assert.equal(m[1], `tradewinds-v${APP_VERSION}`);
});
