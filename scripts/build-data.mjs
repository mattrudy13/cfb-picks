// Builds data/<season>.json for the site: every game this season with the model's line and win
// chance, and the team ratings table.
//
//   CFBD_API_KEY=... node scripts/build-data.mjs   # fetch this season's games and stats, then build
//   node scripts/build-data.mjs --offline          # rebuild from the files already in data/raw/
//
// The live model is v3 if it passed its backtest, else v2 (SPEC.md, "Model v3"): the `live` block of
// that backtest's file, run over 2015 to now so the ratings and priors match the backtest exactly.
//
// CFBD calls: 2 per run (games, advanced stats), plus one passing-stats call per newly finished week,
// about 3 closing-lines calls per finished week, plus SP+ and FPI (2) once a week. The free tier's 1,000 a month is shared with h2h.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { trimPassing } from "./trim.mjs";

const require = createRequire(import.meta.url);
const M = require("../model.js");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const RAW = path.join(DATA, "raw");
const offline = process.argv.includes("--offline");
const KEY = process.env.CFBD_API_KEY;
if (!offline && !KEY) throw new Error("Set CFBD_API_KEY, or pass --offline");

const readData = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
const v2 = readData("backtest-v2.json");
const v3 = readData("backtest-v3.json");
const VERSION = v3.goLive.pass ? "v3" : "v2";
const live = VERSION === "v3" ? v3.live : v2.live;
const settings = v2.settings; // v3 reuses v2's rating settings
const SEASON = live.season;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const readRaw = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8"));
const writeRaw = (f, rows) => fs.writeFileSync(path.join(RAW, f), JSON.stringify(rows));
// The Monday that starts a moment's week, in Eastern time, e.g. "2026-10-12".
function etWeekStart(when) {
  const et = new Date(new Date(when).toLocaleString("en-US", { timeZone: "America/New_York" }));
  et.setDate(et.getDate() - ((et.getDay() + 6) % 7));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}

let calls = 0;
async function cfbd(pathAndQuery) {
  const res = await fetch(`https://api.collegefootballdata.com/${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
  });
  calls++;
  if (!res.ok) throw new Error(`${pathAndQuery}: HTTP ${res.status}`);
  return res.json();
}

// ---- Fetch this season (same trimming as fetch-history.mjs) ----

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] ?? null]));
const GAME_KEYS = ["id", "season", "week", "startDate", "neutralSite", "conferenceGame", "completed", "homeId",
  "homeTeam", "homeClassification", "homeConference", "homePoints", "awayId", "awayTeam", "awayClassification",
  "awayConference", "awayPoints"];
const SIDE_KEYS = ["plays", "ppa", "successRate", "explosiveness"];

if (!offline) {
  const games = await cfbd(`games?year=${SEASON}&seasonType=regular`);
  writeRaw(`games-${SEASON}.json`, games.filter((g) => [g.homeClassification, g.awayClassification].includes("fbs")).map((g) => pick(g, GAME_KEYS)));
  const adv = await cfbd(`stats/game/advanced?year=${SEASON}&seasonType=regular`);
  writeRaw(`advanced-${SEASON}.json`, adv.map((r) => ({
    ...pick(r, ["gameId", "season", "week", "team", "opponent"]),
    offense: pick(r.offense, SIDE_KEYS), defense: pick(r.defense, SIDE_KEYS),
  })));
  // Passing stats for v3's QB flag: each week once all its games are final (or a postponed one is
  // 5+ days past kickoff), so a cached week never needs a refetch.
  const passingFile = `passing-${SEASON}.json`;
  const have = fs.existsSync(path.join(RAW, passingFile)) ? readRaw(passingFile) : [];
  const done = new Set(have.map((r) => r.week));
  const finished = (g) => g.completed || Date.parse(g.startDate) < Date.now() - 5 * 864e5;
  const fbsGames = games.filter((g) => g.homeClassification === "fbs" || g.awayClassification === "fbs");
  for (const w of [...new Set(fbsGames.map((g) => g.week))].sort((a, b) => a - b)) {
    if (done.has(w) || !fbsGames.filter((g) => g.week === w).every(finished)) continue;
    have.push(...trimPassing(await cfbd(`games/players?year=${SEASON}&week=${w}&seasonType=regular&category=passing`), w));
  }
  writeRaw(passingFile, have);
  // Closing lines, for each pick's line move to the real close (grade-picks.mjs). Fetched once a week's
  // games are all final, then again until a fetch lands a day after its last kickoff, so a provider that
  // posts late is caught. About 3 calls a week. `lines-fetched-<season>.json` records when each week was
  // last fetched, so a week that's done is never fetched again.
  const linesFile = `lines-${SEASON}.json`, fetchedFile = `lines-fetched-${SEASON}.json`;
  let lines = fs.existsSync(path.join(RAW, linesFile)) ? readRaw(linesFile) : [];
  const fetched = fs.existsSync(path.join(RAW, fetchedFile)) ? readRaw(fetchedFile) : {};
  for (const w of [...new Set(fbsGames.map((g) => g.week))].sort((a, b) => a - b)) {
    const wk = fbsGames.filter((g) => g.week === w);
    const lastKick = Math.max(...wk.map((g) => Date.parse(g.startDate)));
    if (!wk.every(finished) || Date.parse(fetched[w] ?? 0) > lastKick + 864e5) continue;
    const rows = await cfbd(`lines?year=${SEASON}&week=${w}&seasonType=regular`);
    lines = lines.filter((r) => r.week !== w).concat(rows.map((r) => ({
      id: r.id, week: w,
      lines: (r.lines ?? []).map((l) => pick(l, ["provider", "spread", "spreadOpen", "homeMoneyline", "awayMoneyline"])),
    })));
    fetched[w] = new Date().toISOString();
  }
  writeRaw(linesFile, lines);
  writeRaw(fetchedFile, fetched);
  // SP+ and FPI: shown on the ratings page for context only (they're not in the model). CFBD only serves
  // the latest numbers, so each weekly fetch is also kept in a history file: the only point-in-time copy
  // that will exist for a fair test of them later (SPEC.md, "Look-ahead bias"). Once per ET week, which
  // starts Monday, so it lands on the Monday 6 AM run, after the weekend and before any weeknight games.
  const historyFile = `ratings-history-${SEASON}.json`;
  const history = fs.existsSync(path.join(RAW, historyFile)) ? readRaw(historyFile) : [];
  const lastTaken = history.at(-1)?.takenAt;
  if (!lastTaken || etWeekStart(lastTaken) !== etWeekStart(new Date())) {
    const sp = (await cfbd(`ratings/sp?year=${SEASON}`)).map((r) => pick(r, ["team", "rating", "ranking"]));
    const fpi = (await cfbd(`ratings/fpi?year=${SEASON}`)).map((r) => pick(r, ["team", "fpi"]));
    writeRaw(`sp-${SEASON}.json`, sp);
    writeRaw(`fpi-${SEASON}.json`, fpi);
    history.push({ takenAt: new Date().toISOString(), sp, fpi });
    writeRaw(historyFile, history);
  }
}

// ---- Run the live model ----

const YEARS = range(2015, SEASON);
const seasons = YEARS.map((season) => ({ season, games: readRaw(`games-${season}.json`) }));
const eff = M.efficiencyIndex(YEARS.flatMap((y) => readRaw(`advanced-${y}.json`)));
const contexts = {};
for (const y of range(2016, SEASON)) {
  contexts[y] = M.priorContext(readRaw(`games-${y}.json`), readRaw(`returning-${y}.json`), readRaw(`talent-${y}.json`),
    y >= 2021 ? readRaw(`portal-${y}.json`) : []);
}

// The rating inputs a model version can use (see VARIANTS in backtest-v2.mjs).
const elo = M.runElo(seasons, settings.elo);
const runner = {
  elo: () => ({ pre: elo.pre, final: elo.finals[SEASON] }),
  margin: () => M.runSeries(seasons, { valueOf: (g) => g.margin, p: settings.margin, priorFor: M.carryPrior(settings.margin) }),
  marginPri: () => M.runSeries(seasons, { valueOf: (g) => g.margin, p: settings.margin, priorFor: M.fittedPrior(contexts, settings.margin) }),
  ppa: () => M.runSeries(seasons, { valueOf: (g) => eff(g, "ppa"), p: settings.ppa, priorFor: M.carryPrior(settings.ppa) }),
  ppaPri: () => M.runSeries(seasons, { valueOf: (g) => eff(g, "ppa"), p: settings.ppa, priorFor: M.fittedPrior(contexts, settings.ppa) }),
  sr: () => M.runSeries(seasons, { valueOf: (g) => eff(g, "successRate"), p: settings.successRate, priorFor: M.carryPrior(settings.successRate) }),
  srPri: () => M.runSeries(seasons, { valueOf: (g) => eff(g, "successRate"), p: settings.successRate, priorFor: M.fittedPrior(contexts, settings.successRate) }),
  qb: () => ({ pre: qb, final: qbNow }),
};
// v3's QB flag for every scheduled game, and each team's flag for its next game (the "current" value).
const passing = Object.fromEntries(range(2016, SEASON).map((y) => [y, fs.existsSync(path.join(RAW, `passing-${y}.json`)) ? readRaw(`passing-${y}.json`) : []]));
const qb = M.qbSeries(seasons, passing);
// Teams with no game left keep 0 (no flag), so every team still gets a rating.
const qbNow = Object.fromEntries(seasons.at(-1).games.flatMap((g) => [[g.homeTeam, 0], [g.awayTeam, 0]]));
for (const g of [...seasons.at(-1).games].sort((a, b) => b.startDate.localeCompare(a.startDate))) {
  if (g.completed || !qb.has(g.id)) continue;
  qbNow[g.homeTeam] = qb.get(g.id).home; // the loop runs latest first, so the earliest unplayed game wins
  qbNow[g.awayTeam] = qb.get(g.id).away;
}
const inputs = live.inputs.map((k) => runner[k]());
const pres = inputs.map((x) => x.pre);
const homeCoef = live.coef[live.coef.length - 1];

// A team's power rating: its share of the blend in points, centered on the FBS average, so a game's
// model margin is power(home) − power(away) + home field.
const teams = readRaw(`teams-${SEASON}.json`);
const fbs = teams.filter((t) => t.classification === "fbs");
const centers = inputs.map((x) => M.mean(fbs.map((t) => x.final[t.school]).filter((v) => v != null)));
const power = (values) => values.reduce((s, v, i) => s + live.coef[i] * (v - centers[i]), 0);

const allGames = seasons.at(-1).games.filter((g) => g.homeClassification === "fbs" || g.awayClassification === "fbs");
const games = allGames
  .filter((g) => pres.every((pre) => pre.has(g.id)))
  .map((g) => {
    const margin = M.dot(live.coef, M.blendRow(g, pres));
    return {
      id: g.id, week: g.week, start: g.startDate, neutral: g.neutralSite, conferenceGame: g.conferenceGame,
      completed: g.completed, home: g.homeTeam, away: g.awayTeam,
      homeFbs: g.homeClassification === "fbs", awayFbs: g.awayClassification === "fbs",
      homePoints: g.homePoints, awayPoints: g.awayPoints,
      // Pregame power ratings, for the rating-over-time chart on team pages.
      homePower: power(pres.map((pre) => pre.get(g.id).home)),
      awayPower: power(pres.map((pre) => pre.get(g.id).away)),
      modelMargin: margin,
      homeWinProb: M.homeWinProb(margin, live.sigma),
      // v3: QB-change flags, and how much of the model's gap from the market to trust in this game.
      homeQb: qb.get(g.id)?.home ?? 0, awayQb: qb.get(g.id)?.away ?? 0,
      trust: live.trust ? M.trustFactor(live.trust, M.trustFlags(g, qb.get(g.id))) : 1,
    };
  })
  .sort((a, b) => a.start.localeCompare(b.start));

// The current week: the first one that still has an unplayed FBS game.
const week = Math.min(...games.filter((g) => !g.completed).map((g) => g.week), Infinity);

// ---- Ratings table ----

const readOpt = (f) => { try { return readRaw(f); } catch { return []; } };
const sp = Object.fromEntries(readOpt(`sp-${SEASON}.json`).map((r) => [r.team, r.rating]));
const fpi = Object.fromEntries(readOpt(`fpi-${SEASON}.json`).map((r) => [r.team, r.fpi]));
const ratings = fbs
  .map((t) => {
    const values = inputs.map((x) => x.final[t.school]);
    if (values.some((v) => v == null)) return null;
    // Change over the last three weeks: now vs the pregame rating from three weeks back.
    const past = games
      .filter((g) => g.week <= week - 3 && (g.home === t.school || g.away === t.school))
      .at(-1);
    const then = past ? (past.home === t.school ? past.homePower : past.awayPower) : null;
    const now = power(values);
    return {
      team: t.school,
      power: now,
      change3: then == null ? null : now - then,
      inputs: Object.fromEntries(live.inputs.map((k, i) => [k, values[i]])),
      sp: sp[t.school] ?? null,
      fpi: fpi[t.school] ?? null,
    };
  })
  .filter(Boolean)
  .sort((a, b) => b.power - a.power)
  .map((r, i) => ({ rank: i + 1, ...r }));

const out = {
  updated: new Date().toISOString(),
  season: SEASON,
  week: Number.isFinite(week) ? week : null,
  model: { version: VERSION, variant: live.variant, inputs: live.inputs, threshold: live.threshold, startWeek: live.startWeek, sigma: live.sigma, homeField: homeCoef, trust: live.trust ?? null },
  teams: Object.fromEntries(teams.map((t) => [t.school, {
    id: t.id, abbr: t.abbreviation, mascot: t.mascot, conference: t.conference, fbs: t.classification === "fbs",
    color: t.color, alt: t.alternateColor, logo: t.logo, logoDark: t.logoDark,
  }])),
  ratings,
  games,
};
fs.writeFileSync(path.join(DATA, `${SEASON}.json`), JSON.stringify(out));
fs.writeFileSync(path.join(DATA, "seasons.json"), JSON.stringify({ current: SEASON }));
console.log(`${SEASON} week ${out.week}: ${games.length} games, ${ratings.length} rated teams, ${calls} CFBD calls`);
