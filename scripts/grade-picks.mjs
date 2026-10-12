// Grades recorded picks once their games are final, and measures each one's line move to the real close.
// Runs after build-data.mjs.
//
//   node scripts/grade-picks.mjs          # NOW=<iso> to pretend it's another time (testing)
//
// Spread picks win, lose or push at the recorded line; moneylines win or lose. Profit is per $100 at the
// recorded price. A game that's still not final 5 days after kickoff (canceled or postponed) is void.
// Graded picks are never regraded.
//
// Line move to the close (SPEC.md, "Picks", decided 2026-10-12): CFBD's closing line, compared book by book
// with the lines the same books had when the pick was posted (`p.books`), so a different set of books
// can't pass for a line move. Books CFBD doesn't report, or that didn't price the game at posting, are
// left out; a pick with no book in common gets no move and doesn't count toward the record's line move.
// A book whose CFBD close is far from our last pregame snapshot is treated as bad data and skipped (about
// 2% of 2024–2025 games had CFBD books 4+ points apart). Set once, from a CFBD fetch made at least a day
// after kickoff, and never changed after.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { payout, median } = require("../model.js");
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const RAW = path.join(DATA, "raw");
const now = process.env.NOW ? Date.parse(process.env.NOW) : Date.now();

// CFBD provider names → The Odds API book keys (the keys in `p.books`).
const CFBD_BOOKS = {
  DraftKings: "draftkings", FanDuel: "fanduel", BetMGM: "betmgm", BetRivers: "betrivers", "ESPN Bet": "espnbet",
  Fanatics: "fanatics", "Hard Rock Bet": "hardrockbet", "Bally Bet": "ballybet", Caesars: "williamhill_us",
  "Caesars (Pennsylvania)": "williamhill_us", "Caesars Sportsbook (Colorado)": "williamhill_us",
  "William Hill (New Jersey)": "williamhill_us",
};
const NOT_BOOKS = new Set(["consensus", "teamrankings", "numberfire", "Bovada"]); // aggregators and offshore
const SUSPECT_SPREAD = 4;   // points between a book's CFBD close and our last snapshot's median
const SUSPECT_ML = 0.10;    // the same for moneylines, in implied win chance

const { current: season } = JSON.parse(fs.readFileSync(path.join(DATA, "seasons.json"), "utf8"));
const data = JSON.parse(fs.readFileSync(path.join(DATA, `${season}.json`), "utf8"));
const file = path.join(DATA, `picks-${season}.json`);
if (!fs.existsSync(file)) process.exit(0);
const store = JSON.parse(fs.readFileSync(file, "utf8"));
const games = new Map(data.games.map((g) => [g.id, g]));
const readRaw = (f, empty) => { try { return JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8")); } catch { return empty; } };
const closes = new Map(readRaw(`lines-${season}.json`, []).map((r) => [r.id, r.lines]));
const fetched = readRaw(`lines-fetched-${season}.json`, {});

const implied = (p) => (p > 0 ? 100 / (p + 100) : -p / (-p + 100));
const unknownProviders = new Set();

// The pick's move to the close, or null if no book can be compared. Spreads in points, moneylines in
// percentage points of implied win chance, positive when the market moved toward the pick.
function closeOf(p) {
  const sign = p.side === "home" ? 1 : -1;
  const used = [], skipped = [], posted = [], closed = [];
  for (const l of closes.get(p.gameId) ?? []) {
    const key = CFBD_BOOKS[l.provider];
    if (!key) {
      if (!NOT_BOOKS.has(l.provider)) unknownProviders.add(l.provider);
      continue;
    }
    const at = p.books?.[key];
    if (p.cat === "spread") {
      if (at?.homeLine == null || l.spread == null) continue;
      if (Math.abs(l.spread - p.closeMarket) > SUSPECT_SPREAD) { skipped.push(key); continue; }
      posted.push(at.homeLine);
      closed.push(l.spread);
    } else {
      const atPrice = at?.[p.side + "Ml"], closePrice = p.side === "home" ? l.homeMoneyline : l.awayMoneyline;
      if (atPrice == null || closePrice == null) continue;
      if (Math.abs(implied(closePrice) - implied(p.closeMarket)) > SUSPECT_ML) { skipped.push(key); continue; }
      posted.push(atPrice);
      closed.push(closePrice);
    }
    used.push(key);
  }
  const close = { source: "cfbd", books: used, skipped, posted: median(posted), closed: median(closed) };
  if (!used.length) return { close, move: null };
  const move = p.cat === "spread"
    ? (close.posted - close.closed) * sign
    : 100 * (implied(close.closed) - implied(close.posted));
  return { close, move };
}

let graded = 0, closed = 0;
for (const wk of Object.values(store.weeks)) {
  for (const p of wk.picks) {
    if (!p.result) {
      const g = games.get(p.gameId);
      if (!g?.completed || g.homePoints == null) {
        if (now - Date.parse(p.kickoff) > 5 * 864e5) Object.assign(p, { result: "V", profit: 0 }), graded++;
        continue;
      }
      const sideMargin = (g.homePoints - g.awayPoints) * (p.side === "home" ? 1 : -1);
      const cover = p.cat === "spread" ? sideMargin + p.line : sideMargin;
      p.result = cover > 0 ? "W" : cover < 0 ? "L" : "P";
      p.profit = p.result === "W" ? 100 * payout(p.price) : p.result === "L" ? -100 : 0;
      p.score = `${g.away} ${g.awayPoints}, ${g.home} ${g.homePoints}`;
      graded++;
    }
    if (p.close || p.result === "V" || !(Date.parse(fetched[p.week] ?? 0) > Date.parse(p.kickoff) + 864e5)) continue;
    const { close, move } = closeOf(p);
    Object.assign(p, { close, clvClose: move });
    closed++;
  }
}
if (graded || closed) {
  fs.writeFileSync(file, JSON.stringify(store, null, 1));
  console.log(`${graded} picks graded, ${closed} measured against the close`);
}
for (const name of unknownProviders) console.log(`::warning::CFBD line provider not mapped to a book: ${name}`);
