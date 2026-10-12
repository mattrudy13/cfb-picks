// Records this snapshot's picks into data/picks-<season>.json. Runs after fetch-odds.mjs.
//
//   node scripts/record-picks.mjs          # NOW=<iso> to pretend it's another time (testing)
//
// Rules (SPEC.md, "Picks" and "Model v3"):
// - Spread: the edge is the game's trust factor × (model margin + median US line), and has to reach the
//   live threshold, from the live start week on, FBS vs FBS only. Recorded at the best line (then price)
//   for that side. (Before v3 the trust factor was 1.)
// - Underdog moneyline: no longer recorded (stopped 2026-10-11). With trust-adjusted margins the win
//   chance is close to the market's, so the picks that cleared $10 of expected profit came from the normal
//   curve giving long underdogs more chance than moneyline prices do, not from the model. The rule is
//   kept behind RECORD_MONEYLINES: at least $10 per $100 at the best price, no longer than +600.
//   Moneyline picks already recorded keep getting closing prices and grades.
// - Status: "unofficial" if the live model failed its backtest; under v3, "provisional" until its live
//   spread picks' line move to CFBD's close (CLV) is above 0 with 95% confidence over at least 100 picks,
//   then "official" (see statusNow). `shadow` stays for older pages.
// - Each pick records which model made it; a model's picks are judged on their own.
// - A pick locks the moment it's first recorded, at that snapshot's line and price: the goal is to bet
//   early (Sunday night), so a later snapshot never moves the line a pick is graded at or removes it.
//   Later snapshots before kickoff only update `closeMarket`, the last pregame market median: the page's
//   "so far" line move, and grade-picks' check for bad CFBD closing lines.
// - One spread pick and one moneyline pick per game per model at most, so a later snapshot can't take the
//   other side.

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
const RECORD_MONEYLINES = false; // stopped 2026-10-11, see above

const { current: season } = JSON.parse(fs.readFileSync(path.join(DATA, "seasons.json"), "utf8"));
const data = JSON.parse(fs.readFileSync(path.join(DATA, `${season}.json`), "utf8"));
const odds = JSON.parse(fs.readFileSync(path.join(DATA, `odds-${season}.json`), "utf8"));
const file = path.join(DATA, `picks-${season}.json`);
let store = { weeks: {} };
try { store = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}

const { threshold, startWeek, version } = data.model;
const modelOf = (p) => p.model ?? "v2"; // picks from before v3 have no model field
const existing = Object.values(store.weeks).flatMap((wk) => wk.picks);

// v3 picks are provisional until the live record backs the backtest up (SPEC.md, "Model v3" and "Picks"):
// at least 100 spread picks with a line move to CFBD's close (`clvClose`, set by grade-picks.mjs), and the
// one-sided 95% lower bound on their average move above 0, so a lucky run near zero doesn't pass (decided
// 2026-10-12). Checked at every snapshot, so if the record falls back, new picks are provisional again.
// The normal cutoff stands in for Student's t: at 100+ picks they differ by under 0.02.
const LIVE_CLV_PICKS = 100;
const Z_95_ONE_SIDED = 1.645;
function statusNow() {
  if (version !== "v3") return "unofficial";
  const clvs = existing.filter((p) => modelOf(p) === version && p.cat === "spread" && p.clvClose != null).map((p) => p.clvClose);
  if (clvs.length < LIVE_CLV_PICKS) return "provisional";
  const n = clvs.length, avg = clvs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(clvs.reduce((s, x) => s + (x - avg) ** 2, 0) / (n - 1));
  return avg - Z_95_ONE_SIDED * sd / Math.sqrt(n) > 0 ? "official" : "provisional";
}
const status = statusNow();
const shadow = status === "unofficial";
const fmt = (x) => (x > 0 ? `+${x}` : `${x}`);
const lineText = (x) => (x === 0 ? "PK" : fmt(Math.round(x * 2) / 2));

function picksFor(g, o) {
  const out = [];
  // `books`: every US book's lines when the pick is posted, so grade-picks can measure the move to the
  // close book by book against CFBD's closing lines.
  const base = { gameId: g.id, week: g.week, kickoff: o.commence, home: g.home, away: g.away, takenAt: odds.takenAt, model: version, status, shadow, books: o.byBook };
  const modelLine = -g.modelMargin; // home perspective, like a book's home spread
  const trust = g.trust ?? 1;
  // The margin the picks use: the market's, moved toward the model's by the trust factor.
  const adjusted = o.spread?.median == null ? g.modelMargin : -o.spread.median + trust * (g.modelMargin + o.spread.median);
  if (o.spread?.median != null && g.week >= startWeek) {
    const rawEdge = g.modelMargin + o.spread.median;
    const edge = trust * rawEdge;
    if (Math.abs(edge) >= threshold) {
      const side = edge > 0 ? "home" : "away";
      const best = o.spread[side];
      const sign = side === "home" ? 1 : -1;
      const team = g[side];
      out.push({
        ...base, cat: "spread", side, team, line: best.line, price: best.price, book: best.book,
        modelLine, marketLine: o.spread.median, edge: Math.abs(edge), rawEdge: Math.abs(rawEdge), trust,
        modelProb: M.normCdf((sign * adjusted + best.line) / data.model.sigma),
        why: trust === 1
          ? `Model ${g.home} ${lineText(modelLine)} vs market ${lineText(o.spread.median)}: ${team} by ${Math.abs(edge).toFixed(1)} pts`
          : `Model ${g.home} ${lineText(modelLine)} vs market ${lineText(o.spread.median)}, a ${Math.abs(rawEdge).toFixed(1)}-pt gap; trusting ${Math.round(100 * trust)}% of it in this kind of game leaves ${team} by ${Math.abs(edge).toFixed(1)}`,
      });
    }
  }
  if (RECORD_MONEYLINES && o.ml) {
    // The underdog is the side with the longer median price.
    const side = o.ml.medianHome > o.ml.medianAway ? "home" : "away";
    const best = o.ml[side];
    const homeProb = M.homeWinProb(adjusted, data.model.sigma);
    const p = side === "home" ? homeProb : 1 - homeProb;
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
let updated = 0;
for (const p of existing) {
  const o = odds.games[p.gameId];
  if (!o || Date.parse(p.kickoff) <= now || o.commence !== p.kickoff) continue;
  const market = p.cat === "spread" ? o.spread?.median : o.ml && (p.side === "home" ? o.ml.medianHome : o.ml.medianAway);
  if (market == null) continue;
  Object.assign(p, { closeMarket: market, closeAt: odds.takenAt });
  updated++;
}
const taken = new Set(existing.map((p) => `${modelOf(p)}|${p.cat}|${p.gameId}`));
let added = 0;
for (const p of fresh) {
  if (taken.has(`${p.model}|${p.cat}|${p.gameId}`)) continue;
  p.closeMarket = p.cat === "spread" ? p.marketLine : p.marketPrice;
  p.closeAt = p.takenAt;
  (store.weeks[p.week] ??= { picks: [] }).picks.push(p);
  added++;
}

store.updated = new Date(now).toISOString();
fs.writeFileSync(file, JSON.stringify(store, null, 1));
console.log(`${added} new ${version} picks (${status}), ${updated} earlier picks' closing line updated, at ${odds.takenAt}`);
