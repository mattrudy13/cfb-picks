// Snapshots college football spreads and moneylines from The Odds API into data/odds-<season>.json.
//
//   ODDS_API_KEY=... node scripts/fetch-odds.mjs
//   node scripts/fetch-odds.mjs --fixture f.json   # offline test: f.json is an /odds response
//
// Cost: one call for every game, 1 credit per market per region (spreads + h2h, US region) = 2 credits.
// The free tier's 500 a month is shared with te-tracker (~375 a month there).
//
// Only US-licensed books count (te-tracker's rule), so every price shown can be bet. Games that have
// already kicked off keep their earlier snapshot, and each game remembers the first median line seen,
// which the board uses for the line move and record-picks uses for CLV.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { median } = require("../model.js");
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const API = "https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf/odds";
// Offshore books in The Odds API's "us" region (same list as te-tracker).
const OFFSHORE_BOOKS = new Set(["betonlineag", "bovada", "betus", "mybookieag", "lowvig", "betanysports", "everygame"]);
// The Odds API names that don't reduce to CFBD's school + mascot. Add to this when a run logs a miss.
const ALIASES = {
  "San Jose State Spartans": "San José State",
  "Hawaii Rainbow Warriors": "Hawai'i",
  "Miami (OH) RedHawks": "Miami (OH)",
  "UL Monroe Warhawks": "UL Monroe",
  "Louisiana Ragin Cajuns": "Louisiana",
  "Southern Mississippi Golden Eagles": "Southern Miss",
  "UMass Minutemen": "Massachusetts",
  "UConn Huskies": "UConn",
  "App State Mountaineers": "App State",
  "Appalachian State Mountaineers": "App State",
  "Sam Houston State Bearkats": "Sam Houston",
};

const fixtureArg = process.argv.indexOf("--fixture");
const fixture = fixtureArg > 0 ? JSON.parse(fs.readFileSync(process.argv[fixtureArg + 1], "utf8")) : null;
const KEY = process.env.ODDS_API_KEY;
if (!KEY && !fixture) throw new Error("Set ODDS_API_KEY, or pass --fixture");

const { current: season } = JSON.parse(fs.readFileSync(path.join(DATA, "seasons.json"), "utf8"));
const data = JSON.parse(fs.readFileSync(path.join(DATA, `${season}.json`), "utf8"));
const outFile = path.join(DATA, `odds-${season}.json`);
let prev = { games: {} };
try { prev = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch {}

let events, remaining = null;
if (fixture) events = fixture;
else {
  const res = await fetch(`${API}?apiKey=${KEY}&regions=us&markets=spreads,h2h&oddsFormat=american`);
  remaining = res.headers.get("x-requests-remaining");
  if (!res.ok) throw new Error(`odds: HTTP ${res.status} ${await res.text()}`);
  events = await res.json();
}

// ---- Match Odds API team names to CFBD schools ----

const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const bySchoolMascot = new Map();
for (const [school, t] of Object.entries(data.teams)) bySchoolMascot.set(norm(`${school} ${t.mascot ?? ""}`), school);
const aliasNorm = new Map(Object.entries(ALIASES).map(([k, v]) => [norm(k), v]));
function school(oddsName) {
  const n = norm(oddsName);
  return aliasNorm.get(n) ?? bySchoolMascot.get(n) ?? null;
}

// CFBD games by team pair, to find the CFBD id for an Odds API event.
const byPair = new Map();
for (const g of data.games) {
  const k = [g.home, g.away].sort().join("|");
  (byPair.get(k) ?? byPair.set(k, []).get(k)).push(g);
}
function cfbdGame(home, away, commence) {
  const list = byPair.get([home, away].sort().join("|")) ?? [];
  return list.find((g) => Math.abs(Date.parse(g.start) - Date.parse(commence)) < 3 * 864e5) ?? null;
}

// ---- Prices ----

const implied = (o) => (o > 0 ? 100 / (o + 100) : -o / (-o + 100));
// Best spread for a side: the most points, then the better price.
const bestLine = (offers) =>
  offers.reduce((a, b) => (a == null || b.line > a.line || (b.line === a.line && implied(b.price) < implied(a.price)) ? b : a), null);
const bestPrice = (offers) => offers.reduce((a, b) => (a == null || implied(b.price) < implied(a.price) ? b : a), null);

const now = Date.now();
const out = { takenAt: new Date().toISOString(), games: {}, unmatched: [] };
for (const ev of events) {
  const h = school(ev.home_team), a = school(ev.away_team);
  const g = h && a ? cfbdGame(h, a, ev.commence_time) : null;
  if (!g) {
    out.unmatched.push(`${ev.away_team} @ ${ev.home_team}${!h ? ` (no team: ${ev.home_team})` : ""}${!a ? ` (no team: ${ev.away_team})` : ""}`);
    continue;
  }
  const old = prev.games?.[g.id];
  // A game that has started keeps its last pregame snapshot.
  if (Date.parse(ev.commence_time) <= now && old) { out.games[g.id] = old; continue; }
  if (Date.parse(ev.commence_time) <= now) continue;

  const spreads = { home: [], away: [] }, mls = { home: [], away: [] }, books = {};
  for (const bk of ev.bookmakers ?? []) {
    if (OFFSHORE_BOOKS.has(bk.key)) continue;
    for (const mk of bk.markets ?? []) {
      // Outcomes are named for the Odds API's teams; orient them to CFBD's home and away.
      const side = (o) => (school(o.name) === g.home ? "home" : school(o.name) === g.away ? "away" : null);
      for (const o of mk.outcomes ?? []) {
        const s = side(o);
        if (!s) continue;
        if (mk.key === "spreads" && o.point != null) {
          spreads[s].push({ line: o.point, price: o.price, book: bk.key });
          (books[bk.key] ??= {})[s + "Line"] = o.point;
        }
        if (mk.key === "h2h") {
          mls[s].push({ price: o.price, book: bk.key });
          (books[bk.key] ??= {})[s + "Ml"] = o.price;
        }
      }
    }
  }
  if (!spreads.home.length && !mls.home.length) continue;
  const medianHome = median(spreads.home.map((o) => o.line));
  out.games[g.id] = {
    oddsId: ev.id,
    commence: ev.commence_time,
    home: g.home,
    away: g.away,
    spread: spreads.home.length
      ? { median: medianHome, home: bestLine(spreads.home), away: bestLine(spreads.away), books: spreads.home.length }
      : null,
    ml: mls.home.length && mls.away.length
      ? { home: bestPrice(mls.home), away: bestPrice(mls.away), medianHome: median(mls.home.map((o) => o.price)), medianAway: median(mls.away.map((o) => o.price)) }
      : null,
    byBook: books,
    // The first median line this game was seen at, carried through later snapshots.
    first: old?.first ?? (medianHome != null ? { line: medianHome, at: out.takenAt } : null),
  };
}
// Started games that dropped off the API keep their last snapshot too.
for (const [id, old] of Object.entries(prev.games ?? {})) {
  if (!out.games[id] && Date.parse(old.commence) <= now) out.games[id] = old;
}

fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`${Object.keys(out.games).length} games priced, ${out.unmatched.length} unmatched${remaining != null ? `, ${remaining} credits left` : ""}`);
for (const u of out.unmatched) console.log(`  unmatched: ${u}`);
