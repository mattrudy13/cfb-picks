// Records this snapshot's picks into data/picks-<season>.json. Runs after fetch-odds.mjs.
//
//   node scripts/record-picks.mjs          # NOW=<iso> to pretend it's another time (testing)
//
// Rules (SPEC.md, "Picks" and "Model v2"):
// - Spread: the model margin differs from the median US line by at least the live threshold, from the
//   live start week on, FBS vs FBS only. Recorded at the best line (then price) for that side.
// - Underdog moneyline: expected profit of at least $10 per $100 at the best price, no longer than +600.
//   A bare > 0 took about half the slate in week 7: small model errors read as edges on most dogs.
// - Every pick is `shadow: true` while the model hasn't passed the go-live bar, so none counts as official.
// - A pick locks the moment it's first recorded, at that snapshot's line and price: the goal is to bet
//   early (Sunday night), so a later snapshot never moves the line a pick is graded at or removes it.
//   Later snapshots before kickoff only update `closeMarket`, the market median used for CLV.
// - One spread pick and one moneyline pick per game at most, so a later snapshot can't take the other side.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../model.js");
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const now = process.env.NOW ? Date.parse(process.env.NOW) : Date.now();
const ML_MAX_PRICE = 600;
const ML_MIN_EV = 10; // per $100; added 2026-10-11

const { current: season } = JSON.parse(fs.readFileSync(path.join(DATA, "seasons.json"), "utf8"));
const data = JSON.parse(fs.readFileSync(path.join(DATA, `${season}.json`), "utf8"));
const odds = JSON.parse(fs.readFileSync(path.join(DATA, `odds-${season}.json`), "utf8"));
const backtest = JSON.parse(fs.readFileSync(path.join(DATA, "backtest-v2.json"), "utf8"));
const file = path.join(DATA, `picks-${season}.json`);
let store = { weeks: {} };
try { store = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}

const { threshold, startWeek } = data.model;
const shadow = !backtest.goLive.pass;
const fmt = (x) => (x > 0 ? `+${x}` : `${x}`);
const lineText = (x) => (x === 0 ? "PK" : fmt(Math.round(x * 2) / 2));

function picksFor(g, o) {
  const out = [];
  const base = { gameId: g.id, week: g.week, kickoff: o.commence, home: g.home, away: g.away, takenAt: odds.takenAt, shadow };
  const modelLine = -g.modelMargin; // home perspective, like a book's home spread
  if (o.spread?.median != null && g.week >= startWeek) {
    const edge = g.modelMargin + o.spread.median;
    if (Math.abs(edge) >= threshold) {
      const side = edge > 0 ? "home" : "away";
      const best = o.spread[side];
      const sign = side === "home" ? 1 : -1;
      const team = g[side];
      out.push({
        ...base, cat: "spread", side, team, line: best.line, price: best.price, book: best.book,
        modelLine, marketLine: o.spread.median, edge: Math.abs(edge),
        modelProb: M.normCdf((sign * g.modelMargin + best.line) / data.model.sigma),
        why: `Model ${g.home} ${lineText(modelLine)} vs market ${lineText(o.spread.median)}: ${team} by ${Math.abs(edge).toFixed(1)} pts`,
      });
    }
  }
  if (o.ml) {
    // The underdog is the side with the longer median price.
    const side = o.ml.medianHome > o.ml.medianAway ? "home" : "away";
    const best = o.ml[side];
    const p = side === "home" ? g.homeWinProb : 1 - g.homeWinProb;
    const ev = M.evPer100(p, best.price);
    if (best.price > 0 && best.price <= ML_MAX_PRICE && ev >= ML_MIN_EV) {
      out.push({
        ...base, cat: "ml", side, team: g[side], price: best.price, book: best.book,
        modelProb: p, marketPrice: side === "home" ? o.ml.medianHome : o.ml.medianAway, ev,
        why: `Model gives ${g[side]} ${(100 * p).toFixed(0)}% to win; ${fmt(best.price)} pays like ${(100 / (best.price / 100 + 1)).toFixed(0)}%`,
      });
    }
  }
  return out;
}

const fresh = [];
for (const g of data.games) {
  const o = odds.games[g.id];
  if (!o || !g.homeFbs || !g.awayFbs || g.completed || Date.parse(o.commence) <= now) continue;
  fresh.push(...picksFor(g, o));
}

// Existing picks stay as recorded. Unstarted ones get this snapshot's market as their close.
const existing = Object.values(store.weeks).flatMap((wk) => wk.picks);
let updated = 0;
for (const p of existing) {
  const o = odds.games[p.gameId];
  if (!o || Date.parse(p.kickoff) <= now || o.commence !== p.kickoff) continue;
  const market = p.cat === "spread" ? o.spread?.median : o.ml && (p.side === "home" ? o.ml.medianHome : o.ml.medianAway);
  if (market == null) continue;
  Object.assign(p, { closeMarket: market, closeAt: odds.takenAt });
  updated++;
}
const taken = new Set(existing.map((p) => `${p.cat}|${p.gameId}`));
let added = 0;
for (const p of fresh) {
  if (taken.has(`${p.cat}|${p.gameId}`)) continue;
  p.closeMarket = p.cat === "spread" ? p.marketLine : p.marketPrice;
  p.closeAt = p.takenAt;
  (store.weeks[p.week] ??= { picks: [] }).picks.push(p);
  added++;
}

store.updated = new Date(now).toISOString();
fs.writeFileSync(file, JSON.stringify(store, null, 1));
console.log(`${added} new picks, ${updated} earlier picks' closing line updated, at ${odds.takenAt}${shadow ? " (all unofficial)" : ""}`);
