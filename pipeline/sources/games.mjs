// Per-game context -> data/games.json (004 design §2.2).
//
// Three sources, joined on the nflverse game id, none of them load-bearing on its own:
//   1. raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv  (CORS *, ~10-min cadence)
//      lines, moneylines, roof, surface, rest, div_game, the ESPN event id, gameday/gametime.
//   2. site.api.espn.com scoreboard, per week — the kickoff INSTANT (the only ISO-UTC source we
//      have; nflverse ships a local `gametime` with no zone and Sleeper's schedule has no time at
//      all, R6 §(b)), `venue.indoor`, and a temperature/conditions block on most events.
//   3. api.open-meteo.com — wind, which nothing else carries, for OUTDOOR games inside the 7-day
//      forecast horizon.
// Unknown stays `null`. Nothing here guesses.

import {
  POLITE_DELAY_MS,
  csvRecords,
  fetchJson,
  fetchText,
  numOrNull,
  round,
  sleep,
} from "../util.mjs";
import { SLEEPER_API } from "./sleeper.mjs";

/** Schema version of data/games.json (004 design §1). */
export const GAMES_VERSION = 1;

export const NFLDATA_GAMES_URL =
  "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
export const NFLDATA_AIRPORTS_URL =
  "https://raw.githubusercontent.com/nflverse/nfldata/master/data/airports.csv";
export const ESPN_SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
export const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

/** Regular-season weeks games.json covers. */
export const SEASON_WEEKS = 18;

/** Open-Meteo's free forecast horizon. Games beyond it get `null` wind, never a guess. */
export const WEATHER_HORIZON_DAYS = 7;

/**
 * nflverse/nfldata team code -> Sleeper team code. Measured live 2026-09-22 over the whole 2026
 * schedule: the two vocabularies agree on 31 of 32 codes and differ on exactly one — nflverse
 * writes the Rams `LA`, Sleeper writes `LAR`. Washington is `WAS` in BOTH (R6 §(f) warns about
 * `WSH`, which is ESPN's spelling, not nflverse's). `airports.csv` uses the nflverse vocabulary,
 * so the same map serves it.
 * @type {Readonly<Record<string, string>>}
 */
export const NFLVERSE_TO_SLEEPER = Object.freeze({ LA: "LAR" });

/** ESPN abbreviations that differ from Sleeper's. ESPN writes Washington `WSH`. */
export const ESPN_TO_SLEEPER = Object.freeze({ WSH: "WAS", LA: "LAR" });

/**
 * @param {unknown} code
 * @param {Readonly<Record<string, string>>} map
 * @returns {string|null}
 */
function mapTeam(code, map) {
  if (typeof code !== "string") return null;
  const upper = code.trim().toUpperCase();
  if (upper === "") return null;
  return map[upper] ?? upper;
}

/** @param {unknown} code @returns {string|null} */
export const nflverseTeam = (code) => mapTeam(code, NFLVERSE_TO_SLEEPER);

/** @param {unknown} code @returns {string|null} */
export const espnTeam = (code) => mapTeam(code, ESPN_TO_SLEEPER);

/**
 * Roofs that leave the field open to the weather. `closed` is a retractable roof that was shut,
 * so it plays as indoors; `open` is the same roof left open.
 */
const OUTDOOR_ROOFS = new Set(["outdoors", "open"]);
const INDOOR_ROOFS = new Set(["dome", "closed"]);

/**
 * Sleeper's own schedule, kept RAW. `buildSchedule` (sleeper.mjs) throws `game_id` away, but that
 * id is the join key the per-player stat rows use — verified live 2026-09-22: all 16 week-2
 * `game_id` values on the bulk stat rows equalled the schedule's, so this one 27 KB call stamps
 * the right `id` on every game of the season including weeks not yet played (design §2.2 allows a
 * `${week}|${away}@${home}` fallback; it is only reached when this call fails).
 * @param {string|number} season
 * @returns {Promise<Map<string, string>>} `${week}|${AWAY}@${HOME}` -> Sleeper game_id
 */
export async function fetchSleeperGameIds(season) {
  const rows = await fetchJson(`${SLEEPER_API}/schedule/nfl/regular/${season}`, { cacheBust: true });
  const out = new Map();
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const week = Number(row?.week);
    const home = typeof row?.home === "string" ? row.home.toUpperCase() : null;
    const away = typeof row?.away === "string" ? row.away.toUpperCase() : null;
    const id = typeof row?.game_id === "string" && row.game_id !== "" ? row.game_id : null;
    if (Number.isInteger(week) && home && away && id) out.set(`${week}|${away}@${home}`, id);
  }
  return out;
}

/**
 * The season's slice of nflverse `games.csv`, mapped to Sleeper team codes.
 * @param {string|number} season
 * @param {{ text?: string }} [options] pre-fetched CSV, for tests
 * @returns {Promise<{ header: string[], rows: object[] }>}
 */
export async function fetchNflverseGames(season, options = {}) {
  const text = options.text ?? (await fetchText(NFLDATA_GAMES_URL));
  const { header, records } = csvRecords(text);
  const wanted = String(season);
  /** @type {object[]} */
  const rows = [];
  for (const record of records) {
    if (String(record.season) !== wanted) continue;
    if (record.game_type && record.game_type !== "REG") continue;
    const week = Number(record.week);
    const home = nflverseTeam(record.home_team);
    const away = nflverseTeam(record.away_team);
    if (!Number.isInteger(week) || !home || !away) continue;
    const spreadLine = numOrNull(record.spread_line);
    rows.push({
      nv: record.game_id || null,
      espn: record.espn || null,
      week,
      home,
      away,
      gameday: record.gameday || null,
      gametime: record.gametime || null,
      // nflverse `spread_line` is POSITIVE when the home team is favoured; design §2.2 (and the
      // ESPN odds block, which agrees) wants NEGATIVE = home favoured, so the sign is flipped.
      spread: spreadLine === null ? null : round(-spreadLine, 2),
      total: numOrNull(record.total_line),
      mlHome: numOrNull(record.home_moneyline),
      mlAway: numOrNull(record.away_moneyline),
      roof: record.roof || null,
      surface: record.surface || null,
      div: record.div_game === "" || record.div_game == null ? null : record.div_game === "1",
      restHome: numOrNull(record.home_rest),
      restAway: numOrNull(record.away_rest),
      stadium: record.stadium || null,
    });
  }
  return { header, rows };
}

/**
 * `team -> {lat, lon}` from nflverse `airports.csv`.
 *
 * These are AIRPORTS, not stadiums (R6 §(f)): typically 8–30 km from the venue and as much as
 * ~60 km (PVD is nowhere near Gillette). At Open-Meteo's ~11 km model grid that is one or two
 * cells, which is inside the noise for wind speed and temperature — but it is NOT a stadium
 * coordinate and must never be presented as one. `LA`/`LAC` share LAX and `NYG`/`NYJ` share EWR,
 * which is correct: those pairs share a stadium.
 * @param {{ text?: string }} [options]
 * @returns {Promise<Record<string, {lat:number, lon:number}>>}
 */
export async function fetchAirports(options = {}) {
  const text = options.text ?? (await fetchText(NFLDATA_AIRPORTS_URL));
  const { records } = csvRecords(text);
  /** @type {Record<string, {lat:number, lon:number}>} */
  const out = {};
  for (const record of records) {
    const team = nflverseTeam(record.team);
    const lat = numOrNull(record.latitude);
    const lon = numOrNull(record.longitude);
    if (team && lat !== null && lon !== null) out[team] = { lat, lon };
  }
  return out;
}

/**
 * One week of the ESPN scoreboard, reduced to what games.json keeps.
 * @param {string|number} season
 * @param {number} week
 * @returns {Promise<Map<string, object>>} `${week}|${AWAY}@${HOME}` -> {espn, kick, indoor, …}
 */
export async function fetchEspnWeek(season, week) {
  const url = `${ESPN_SCOREBOARD_URL}?week=${week}&seasontype=2&dates=${season}`;
  const body = await fetchJson(url);
  return espnWeekIndex(body, week);
}

/**
 * Reduce a raw ESPN scoreboard body. Split out so tests can feed a saved payload.
 * @param {any} body
 * @param {number} week
 * @returns {Map<string, object>}
 */
export function espnWeekIndex(body, week) {
  const out = new Map();
  const events = Array.isArray(body?.events) ? body.events : [];
  for (const event of events) {
    const competition = Array.isArray(event?.competitions) ? event.competitions[0] : null;
    const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
    const home = espnTeam(competitors.find((c) => c?.homeAway === "home")?.team?.abbreviation);
    const away = espnTeam(competitors.find((c) => c?.homeAway === "away")?.team?.abbreviation);
    if (!home || !away) continue;
    const odds = Array.isArray(competition?.odds) ? competition.odds[0] : null;
    const weather = event?.weather && typeof event.weather === "object" ? event.weather : null;
    const indoor = competition?.venue?.indoor;
    out.set(`${week}|${away}@${home}`, {
      espn: typeof event?.id === "string" ? event.id : null,
      // `event.date` is a full ISO instant; normalize to whole seconds with a Z, like every other
      // timestamp this pipeline writes ("2026-09-25T00:15Z" -> "2026-09-25T00:15:00Z").
      kick: isoInstant(event?.date),
      indoor: typeof indoor === "boolean" ? indoor : null,
      spread: typeof odds?.spread === "number" ? odds.spread : null,
      total: typeof odds?.overUnder === "number" ? odds.overUnder : null,
      tempF: typeof weather?.temperature === "number" ? weather.temperature : null,
      wx: typeof weather?.displayValue === "string" ? weather.displayValue : null,
    });
  }
  return out;
}

/**
 * @param {unknown} value an ISO-ish instant
 * @returns {string|null} `YYYY-MM-DDTHH:MM:SSZ`, or null
 */
export function isoInstant(value) {
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return `${new Date(parsed).toISOString().slice(0, 19)}Z`;
}

/**
 * Hourly wind / temperature / precipitation probability at one venue, read at kickoff.
 * @param {{lat:number, lon:number}} at
 * @param {string} kickIso kickoff instant
 * @returns {Promise<{windMph:number|null, tempF:number|null, precipPct:number|null}>}
 */
export async function fetchWeatherAt(at, kickIso) {
  const url =
    `${OPEN_METEO_URL}?latitude=${at.lat}&longitude=${at.lon}` +
    "&hourly=temperature_2m,precipitation_probability,wind_speed_10m" +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=${WEATHER_HORIZON_DAYS}&timezone=UTC`;
  return pickHour(await fetchJson(url), kickIso);
}

/**
 * Nearest hourly sample to kickoff. Open-Meteo returns `hourly.time` as `YYYY-MM-DDTHH:MM` in the
 * requested zone (UTC here), so the match is a straight string/time comparison.
 * @param {any} body
 * @param {string} kickIso
 * @returns {{windMph:number|null, tempF:number|null, precipPct:number|null}}
 */
export function pickHour(body, kickIso) {
  const none = { windMph: null, tempF: null, precipPct: null };
  const times = body?.hourly?.time;
  const kick = Date.parse(kickIso);
  if (!Array.isArray(times) || times.length === 0 || !Number.isFinite(kick)) return none;
  let best = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < times.length; i += 1) {
    const at = Date.parse(`${times[i]}${/Z$|[+-]\d\d:?\d\d$/.test(times[i]) ? "" : "Z"}`);
    if (!Number.isFinite(at)) continue;
    const delta = Math.abs(at - kick);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  // More than 90 minutes away means the forecast does not cover kickoff at all.
  if (best < 0 || bestDelta > 90 * 60 * 1000) return none;
  const at = (series) => {
    const list = body?.hourly?.[series];
    const value = Array.isArray(list) ? list[best] : null;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const wind = at("wind_speed_10m");
  const temp = at("temperature_2m");
  const precip = at("precipitation_probability");
  return {
    windMph: wind === null ? null : round(wind, 1),
    tempF: temp === null ? null : Math.round(temp),
    precipPct: precip === null ? null : Math.round(precip),
  };
}

/**
 * Does this game need a weather call? Only outdoor venues, only inside the forecast horizon.
 * @param {{roof:string|null, indoor:boolean|null, kick:string|null}} game
 * @param {number} nowMs
 * @returns {boolean}
 */
export function needsWeather(game, nowMs) {
  if (game.indoor === true) return false;
  if (game.roof && INDOOR_ROOFS.has(game.roof)) return false;
  if (game.indoor !== false && !(game.roof && OUTDOOR_ROOFS.has(game.roof))) return false;
  const kick = game.kick ? Date.parse(game.kick) : NaN;
  if (!Number.isFinite(kick)) return false;
  const ahead = kick - nowMs;
  return ahead > -6 * 3600_000 && ahead < WEATHER_HORIZON_DAYS * 86_400_000;
}

/**
 * Merge the nflverse slice, the Sleeper ids and the ESPN index into data/games.json rows.
 * Pure: every network read is a parameter.
 * @param {{ nflverse: object[], sleeperIds: Map<string, string>, espn: Map<string, object>,
 *           season: string|number, generatedAt: string }} input
 * @returns {object} data/games.json without weather
 */
export function buildGames(input) {
  const { nflverse, sleeperIds, espn, season, generatedAt } = input;
  const games = nflverse
    .map((row) => {
      const key = `${row.week}|${row.away}@${row.home}`;
      const extra = espn.get(key) ?? {};
      const roof = row.roof ?? null;
      const indoor =
        typeof extra.indoor === "boolean"
          ? extra.indoor
          : roof && INDOOR_ROOFS.has(roof)
            ? true
            : roof && OUTDOOR_ROOFS.has(roof)
              ? false
              : null;
      return {
        // Design §2.2 allows `${week}|${away}@${home}` when the Sleeper id cannot be derived; in
        // practice `fetchSleeperGameIds` covers the whole season, so the fallback is a safety net.
        id: sleeperIds.get(key) ?? key,
        nv: row.nv,
        espn: extra.espn ?? row.espn ?? null,
        week: row.week,
        kick: extra.kick ?? null,
        home: row.home,
        away: row.away,
        spread: row.spread ?? (typeof extra.spread === "number" ? extra.spread : null),
        total: row.total ?? (typeof extra.total === "number" ? extra.total : null),
        mlHome: row.mlHome,
        mlAway: row.mlAway,
        roof,
        surface: row.surface,
        indoor,
        tempF: extra.tempF ?? null,
        windMph: null,
        precipPct: null,
        wx: extra.wx ?? null,
        div: row.div,
        restHome: row.restHome,
        restAway: row.restAway,
      };
    })
    .sort((a, b) => a.week - b.week || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { version: GAMES_VERSION, generated_at: generatedAt, season: String(season), games };
}

/**
 * Build data/games.json end to end. Every source is optional: ESPN or Open-Meteo failing costs
 * kickoff times or wind, not the file; only the nflverse slice is required.
 * @param {{ season:string|number, week:number, generatedAt:string, nowMs?:number,
 *           weeks?:number[], log?:(m:string)=>void }} options
 * @returns {Promise<{ games:object|null, errors:Record<string,string>, weatherCalls:number }>}
 */
export async function collectGames(options) {
  const { season, generatedAt, log = () => {} } = options;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  /** @type {Record<string, string>} */
  const errors = {};

  let nflverse = [];
  try {
    nflverse = (await fetchNflverseGames(season)).rows;
    log(`nfldata: ${nflverse.length} ${season} regular-season rows`);
  } catch (error) {
    errors.nfldata = error.message;
    return { games: null, errors, weatherCalls: 0 };
  }
  if (nflverse.length === 0) {
    errors.nfldata = `no ${season} rows in games.csv`;
    return { games: null, errors, weatherCalls: 0 };
  }

  let sleeperIds = new Map();
  try {
    sleeperIds = await fetchSleeperGameIds(season);
    log(`sleeper schedule: ${sleeperIds.size} game ids`);
  } catch (error) {
    errors.sleeper_schedule = error.message;
  }
  await sleep(POLITE_DELAY_MS);

  const weeks =
    options.weeks ?? Array.from({ length: SEASON_WEEKS }, (_, i) => i + 1);
  /** @type {Map<string, object>} */
  const espn = new Map();
  let espnWeeks = 0;
  for (const week of weeks) {
    try {
      for (const [key, value] of await fetchEspnWeek(season, week)) espn.set(key, value);
      espnWeeks += 1;
    } catch (error) {
      errors[`espn_week${week}`] = error.message;
    }
    await sleep(POLITE_DELAY_MS);
  }
  log(`espn scoreboard: ${espn.size} events over ${espnWeeks}/${weeks.length} week(s)`);

  const games = buildGames({ nflverse, sleeperIds, espn, season, generatedAt });

  /** @type {Record<string, {lat:number, lon:number}>} */
  let airports = {};
  try {
    airports = await fetchAirports();
  } catch (error) {
    errors.airports = error.message;
  }

  let weatherCalls = 0;
  for (const game of games.games) {
    if (!needsWeather(game, nowMs)) continue;
    const at = airports[game.home];
    if (!at) continue;
    try {
      const weather = await fetchWeatherAt(at, game.kick);
      game.windMph = weather.windMph;
      game.precipPct = weather.precipPct;
      if (game.tempF === null) game.tempF = weather.tempF;
      weatherCalls += 1;
    } catch (error) {
      errors[`weather_${game.id}`] = error.message;
    }
    await sleep(POLITE_DELAY_MS);
  }
  log(`open-meteo: ${weatherCalls} outdoor venue(s) inside the ${WEATHER_HORIZON_DAYS}-day horizon`);

  return { games, errors, weatherCalls };
}
