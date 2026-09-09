// Tiny fetch double for the data-layer tests: routes matched by URL substring/regex, every call
// recorded (url + init) so tests can assert cache-busting and `cache: "no-store"`.

import { readFileSync } from "node:fs";

/**
 * Read a JSON fixture from test/fixtures.
 * @param {string} name file name, e.g. "league.json"
 */
export function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

/** A minimal Response-like object. */
export function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

/** A handler that fails the way `fetch` fails when the network is gone. */
export function networkError(message = "fetch failed") {
  return () => {
    throw new TypeError(message);
  };
}

/** A handler that never resolves until the request is aborted. */
export function hangs() {
  return ({ init }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      });
    });
}

const matches = (match, url) =>
  typeof match === "function" ? match(url) : match instanceof RegExp ? match.test(url) : url.includes(match);

/**
 * @param {Array<{match: string|RegExp|Function, respond: any}>} routes `respond` may be a body,
 *   a Response-like object, or a function receiving `{ url, init, hit }`.
 * @returns {Function & {calls: object[], urls: Function, count: Function, route: Function}}
 */
export function makeFetchMock(routes = []) {
  const table = routes.map((route) => ({ ...route, hits: 0 }));
  const calls = [];

  const impl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init, cache: init?.cache });
    const route = table.find((candidate) => matches(candidate.match, url));
    if (!route) throw new TypeError(`fetch failed: no mock route for ${url}`);
    route.hits += 1;
    const out =
      typeof route.respond === "function" ? await route.respond({ url, init, hit: route.hits }) : route.respond;
    if (out && typeof out.json === "function") return out;
    return jsonResponse(out);
  };

  impl.calls = calls;
  impl.urls = (needle) =>
    calls.map((call) => call.url).filter((url) => (needle === undefined ? true : url.includes(needle)));
  impl.count = (needle) => impl.urls(needle).length;
  impl.route = (match) => table.find((candidate) => String(candidate.match) === String(match));
  return impl;
}
