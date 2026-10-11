// Builds data/<season>.json for the site: every game this season with the model's line and win
// chance, and the team ratings table.
//
//   CFBD_API_KEY=... node scripts/build-data.mjs   # fetch this season's games and stats, then build
//   node scripts/build-data.mjs --offline          # rebuild from the files already in data/raw/
//
// The live model is the one data/backtest-v2.json's `live` block names (picked by the rule in SPEC.md),
// run over 2015 to now so the ratings and priors match the backtest exactly.
//
// CFBD calls: 2 per run (games, advanced stats), plus SP+ and FPI (2) when the cached copies are more
// than 6 days old. The free tier's 1,000 a month is shared with h2h.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const M = require("../model.js");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const RAW = path.join(DATA, "raw");
const offline = process.argv.includes("--offline");
const KEY = process.env.CFBD_API_KEY;
if (!offline && !KEY) throw new Error("Set CFBD_API_KEY, or pass --offline");

const backtest = JSON.parse(fs.readFileSync(path.join(DATA, "backtest-v2.json"), "utf8"));
const { live, settings } = backtest;
const SEASON = live.season;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const readRaw = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8"));
const writeRaw = (f, rows) => fs.writeFileSync(path.join(RAW, f), JSON.stringify(rows));
const ageDays = (f) => {
  try { return (Date.now() - fs.statSync(path.join(RAW, f)).mtimeMs) / 864e5; } catch { return Infinity; }
};

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
  // SP+ and FPI are shown on the ratings page for context only (they're not in the model), so a
  // weekly refresh is enough.
  if (ageDays(`sp-${SEASON}.json`) > 6) {
    writeRaw(`sp-${SEASON}.json`, (await cfbd(`ratings/sp?year=${SEASON}`)).map((r) => pick(r, ["team", "rating", "ranking"])));
    writeRaw(`fpi-${SEASON}.json`, (await cfbd(`ratings/fpi?year=${SEASON}`)).map((r) => pick(r, ["team", "fpi"])));
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
};
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
  model: { variant: live.variant, inputs: live.inputs, threshold: live.threshold, startWeek: live.startWeek, sigma: live.sigma, homeField: homeCoef },
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
