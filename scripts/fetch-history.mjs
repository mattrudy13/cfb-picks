// Fetches CFBD data that doesn't change during a season into data/raw/: past seasons for the backtest,
// and this season's preseason inputs and team list, trimmed to the fields the model uses.
//
//   CFBD_API_KEY=... node scripts/fetch-history.mjs
//
// Files that already exist are skipped, so a rerun costs no calls. The CFBD free tier (1,000 calls a
// month) is shared with h2h, so the call count is printed at the end.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trimPassing } from "./trim.mjs";

const RAW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "raw");
const KEY = process.env.CFBD_API_KEY;
if (!KEY) throw new Error("Set CFBD_API_KEY");

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] ?? null]));

const GAME_KEYS = ["id", "season", "week", "startDate", "neutralSite", "conferenceGame", "completed", "homeId",
  "homeTeam", "homeClassification", "homeConference", "homePoints", "awayId", "awayTeam", "awayClassification",
  "awayConference", "awayPoints"];
const SIDE_KEYS = ["plays", "ppa", "successRate", "explosiveness"];

const SOURCES = [
  {
    name: "games", years: range(2015, 2025), url: (y) => `games?year=${y}&seasonType=regular`,
    trim: (rows) => rows.filter((g) => [g.homeClassification, g.awayClassification].includes("fbs")).map((g) => pick(g, GAME_KEYS)),
  },
  {
    // Per-game, per-team play-by-play efficiency (unadjusted; the model adjusts for opponents itself).
    name: "advanced", years: range(2015, 2025), url: (y) => `stats/game/advanced?year=${y}&seasonType=regular`,
    trim: (rows) => rows.map((r) => ({
      ...pick(r, ["gameId", "season", "week", "team", "opponent"]),
      offense: pick(r.offense, SIDE_KEYS), defense: pick(r.defense, SIDE_KEYS),
    })),
  },
  {
    name: "returning", years: range(2016, 2026), url: (y) => `player/returning?year=${y}`,
    trim: (rows) => rows.map((r) => pick(r, ["season", "team", "conference", "totalPPA", "percentPPA", "usage"])),
  },
  {
    name: "talent", years: range(2015, 2026), url: (y) => `talent?year=${y}`,
    trim: (rows) => rows.map((r) => pick(r, ["year", "team", "talent"])),
  },
  {
    // The portal's records start with the 2021 season.
    name: "portal", years: range(2021, 2026), url: (y) => `player/portal?year=${y}`,
    trim: (rows) => rows.map((r) => pick(r, ["season", "origin", "destination", "position", "stars", "rating"])),
  },
  {
    // Betting lines. Openers exist only from 2021; earlier seasons have closing lines, which v3 uses to fit
    // how much to trust the model in each kind of game.
    name: "lines", years: range(2016, 2025), url: (y) => `lines?year=${y}&seasonType=regular`,
    trim: (rows) => rows.map((r) => ({
      id: r.id,
      lines: (r.lines ?? []).map((l) => pick(l, ["provider", "spread", "spreadOpen", "homeMoneyline", "awayMoneyline"])),
    })),
  },
  {
    // Each passer's attempts per game, for v3's quarterback-change flag. CFBD serves this one week at a
    // time, so a season is one call per regular-season week (about 15).
    name: "passing", years: range(2016, 2025), weeks: true,
    url: (y, w) => `games/players?year=${y}&week=${w}&seasonType=regular&category=passing`,
    trim: trimPassing,
  },
  {
    // Names, mascots (to match The Odds API's "School Mascot" names), logos and colors for the site.
    name: "teams", years: [2026], url: (y) => `teams?year=${y}`,
    trim: (rows) => rows.filter((t) => ["fbs", "fcs"].includes(t.classification)).map((t) => ({
      ...pick(t, ["id", "school", "mascot", "abbreviation", "conference", "classification", "color", "alternateColor"]),
      // The 128px logo and its dark-mode variant, as in h2h.
      logo: (t.logos ?? []).find((u) => u.includes("/logos/128/")) ?? null,
      logoDark: (t.logos ?? []).find((u) => u.includes("/logos-dark/128/")) ?? null,
    })),
  },
];

let calls = 0;
async function get(url, label) {
  const res = await fetch(`https://api.collegefootballdata.com/${url}`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
  });
  calls++;
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.json();
}
for (const src of SOURCES) {
  for (const y of src.years) {
    const file = path.join(RAW, `${src.name}-${y}.json`);
    if (fs.existsSync(file)) continue;
    let rows;
    if (src.weeks) {
      // Past seasons only; build-data.mjs keeps the live season's file up to date week by week.
      const games = JSON.parse(fs.readFileSync(path.join(RAW, `games-${y}.json`), "utf8"));
      rows = [];
      for (const w of [...new Set(games.map((g) => g.week))].sort((a, b) => a - b)) {
        rows.push(...src.trim(await get(src.url(y, w), `${src.name} ${y} wk ${w}`), w));
      }
    } else {
      rows = src.trim(await get(src.url(y), `${src.name} ${y}`));
    }
    fs.writeFileSync(file, JSON.stringify(rows));
    console.log(`${src.name}-${y}: ${rows.length} rows`);
  }
}
console.log(`${calls} CFBD calls`);
