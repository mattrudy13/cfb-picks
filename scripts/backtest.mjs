// Backtests the spread and moneyline model on past seasons and writes data/backtest.json.
//
//   node scripts/backtest.mjs
//
// Reads only the cached files in data/raw/ (no CFBD calls). 2019–2020 warm up the ratings,
// 2021–2023 are the training seasons (every constant and the edge threshold are chosen there), and
// 2024–2025 are checked once with those choices frozen. The go-live bar is judged on 2024–2025 only,
// because a threshold picked while looking at the check seasons would overstate the edge.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const M = require("../model.js");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = path.join(ROOT, "data", "raw");

const WARMUP = [2019, 2020];
const TRAIN = [2021, 2022, 2023];
const CHECK = [2024, 2025];
const ALL = [...WARMUP, ...TRAIN, ...CHECK];

const BREAKEVEN = 110 / 210; // risk 110 to win 100: 52.38%
const MIN_PICKS = 150;
const ML_MAX_PRICE = 600;
const SPREAD_PRICE = -110; // CFBD's past spreads carry no price

const read = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8"));
const seasons = ALL.map((season) => ({ season, games: read(`games-${season}.json`) }));
const lines = new Map();
for (const y of [...TRAIN, ...CHECK]) for (const l of read(`lines-${y}.json`)) lines.set(l.id, l.lines);

const fbsGames = (ys) =>
  seasons
    .filter((s) => ys.includes(s.season))
    .flatMap((s) => M.completedGames(s.games))
    .filter((g) => g.homeClassification === "fbs" && g.awayClassification === "fbs");

const mse = (xs) => xs.reduce((s, x) => s + x * x, 0) / xs.length;

// ---- Fitting (training seasons only, against actual margins, never against lines) ----

// Least squares for margin = a·x + b·home. Returns [a, b].
function fit2(rows) {
  let sxx = 0, sxh = 0, shh = 0, sxy = 0, shy = 0;
  for (const { x, h, y } of rows) {
    sxx += x * x; sxh += x * h; shh += h * h; sxy += x * y; shy += h * y;
  }
  const det = sxx * shh - sxh * sxh;
  return [(sxy * shh - shy * sxh) / det, (shy * sxx - sxy * sxh) / det];
}

const train = fbsGames(TRAIN);

function scoreElo(p) {
  const { pre } = M.runElo(seasons, p);
  const rows = train.map((g) => {
    const e = pre.get(g.id);
    return { x: e.home - e.away, h: g.neutralSite ? 0 : 1, y: g.margin };
  });
  const [a, b] = fit2(rows);
  return { mse: mse(rows.map((r) => r.y - a * r.x - b * r.h)), eloPerPoint: 1 / a, eloHfa: b, pre };
}

function scoreRating(p) {
  const { pre } = M.runRatings(seasons, p);
  return { mse: mse(train.map((g) => g.margin - M.ratingMargin(pre.get(g.id), g.neutralSite, p))), pre };
}

// Coordinate search: sweep one constant at a time over its grid, keep the best, repeat.
function coordSearch(start, grid, score) {
  let best = { p: { ...start }, s: score(start) };
  for (let round = 0; round < 2; round++) {
    for (const [key, values] of Object.entries(grid)) {
      for (const v of values) {
        if (v === best.p[key]) continue;
        const p = { ...best.p, [key]: v };
        const s = score(p);
        if (s.mse < best.s.mse) best = { p, s };
      }
    }
  }
  return best;
}

console.log("Fitting Elo…");
const elo = coordSearch(M.MODEL.elo, {
  k: [15, 20, 25, 30, 35, 40, 50, 60],
  carry: [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1],
  hfa: [15, 25, 35, 55, 75],
  fcsStart: [1000, 1100, 1200, 1300],
}, scoreElo);

console.log("Fitting margin rating…");
const rating = coordSearch(M.MODEL.rating, {
  cap: [17, 21, 24, 28, 35, 99],
  priorWeight: [0.5, 1, 2, 3, 5, 8],
  carry: [0.3, 0.45, 0.6, 0.75, 0.9, 0.95, 1],
  hfa: [1.5, 2, 2.5, 3, 3.5],
  newTeam: [-30, -25, -20, -12, -6],
}, scoreRating);

const blendBase = { eloPerPoint: elo.s.eloPerPoint, eloHfa: elo.s.eloHfa };
const marginsFor = (g, w) =>
  M.modelMargin(elo.s.pre.get(g.id), rating.s.pre.get(g.id), g.neutralSite, {
    blend: { ...blendBase, eloWeight: w },
    rating: rating.p,
  });
let eloWeight = 0, bestBlend = Infinity;
for (let w = 0; w <= 1.0001; w += 0.05) {
  const e = mse(train.map((g) => g.margin - marginsFor(g, w)));
  if (e < bestBlend) [bestBlend, eloWeight] = [e, Math.round(w * 100) / 100];
}

const MODEL = {
  elo: elo.p,
  rating: rating.p,
  blend: { ...blendBase, eloWeight },
  sigma: Math.sqrt(bestBlend),
};
const modelMargin = (g) => M.modelMargin(elo.s.pre.get(g.id), rating.s.pre.get(g.id), g.neutralSite, MODEL);

// ---- Game rows with lines ----

function gameRows(ys) {
  return fbsGames(ys).flatMap((g) => {
    const ls = lines.get(g.id) ?? [];
    const close = M.lineValue(ls, "spread");
    const open = M.lineValue(ls, "spreadOpen");
    if (close == null) return [];
    const model = modelMargin(g);
    return [{
      id: g.id, season: g.season, week: g.week, home: g.homeTeam, away: g.awayTeam, margin: g.margin,
      model, open, close,
      homeMl: M.lineValue(ls, "homeMoneyline"), awayMl: M.lineValue(ls, "awayMoneyline"),
    }];
  });
}
const rowsTrain = gameRows(TRAIN);
const rowsCheck = gameRows(CHECK);

const rmse = (rows, pred) => Math.sqrt(mse(rows.map((r) => r.margin - pred(r))));
const accuracy = (rows) => ({
  games: rows.length,
  modelRmse: rmse(rows, (r) => r.model),
  closeRmse: rmse(rows, (r) => -r.close),
  openRmse: rmse(rows.filter((r) => r.open != null), (r) => -r.open),
});

// ---- Spread picks ----

// A pick at the opener when |model margin + opener| ≥ x. Graded against the opener; CLV is how far the
// line moved toward the pick by the close, in points.
function spreadPicks(rows, x, minWeek = 0) {
  return rows.flatMap((r) => {
    if (r.open == null || r.week < minWeek) return [];
    const edge = r.model + r.open;
    if (Math.abs(edge) < x) return [];
    const side = edge > 0 ? 1 : -1; // 1 = home
    const cover = (r.margin + r.open) * side;
    return [{
      ...r, side, edge: Math.abs(edge),
      result: cover > 0 ? "W" : cover < 0 ? "L" : "P",
      clv: (r.open - r.close) * side,
    }];
  });
}

function summarize(picks) {
  const w = picks.filter((p) => p.result === "W").length;
  const l = picks.filter((p) => p.result === "L").length;
  const push = picks.length - w - l;
  const units = w * M.payout(SPREAD_PRICE) - l;
  return {
    picks: picks.length, w, l, push,
    ats: w + l ? w / (w + l) : null,
    roi: w + l ? units / (w + l) : null,
    clv: picks.length ? picks.reduce((s, p) => s + p.clv, 0) / picks.length : null,
  };
}

// Threshold and start week, chosen on training only: the highest ATS among thresholds with enough picks.
const THRESHOLDS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8];
const byThreshold = (rows) => THRESHOLDS.map((x) => ({ x, ...summarize(spreadPicks(rows, x)) }));
const trainByX = byThreshold(rowsTrain);
const eligible = trainByX.filter((t) => t.picks >= MIN_PICKS * (TRAIN.length / CHECK.length));
const chosenX = (eligible.length ? eligible : trainByX).reduce((a, b) => (b.ats > a.ats ? b : a)).x;

const WEEK_BUCKETS = [[0, 3], [4, 6], [7, 9], [10, 20]];
const byWeek = (rows, x) =>
  WEEK_BUCKETS.map(([a, b]) => ({
    weeks: `${a}–${b === 20 ? "end" : b}`,
    ...summarize(spreadPicks(rows, x).filter((p) => p.week >= a && p.week <= b)),
  }));
const trainWeeks = byWeek(rowsTrain, chosenX);
// Picks start after the last early bucket that lost money in training (decided: "let the backtest decide").
let startWeek = 0;
for (const [i, b] of trainWeeks.entries()) {
  if (i < 2 && b.ats != null && b.ats < BREAKEVEN) startWeek = WEEK_BUCKETS[i][1] + 1;
}

const bySeason = (rows, x, minWeek) =>
  [...new Set(rows.map((r) => r.season))].map((season) => ({
    season, ...summarize(spreadPicks(rows.filter((r) => r.season === season), x, minWeek)),
  }));

const checkSpread = summarize(spreadPicks(rowsCheck, chosenX, startWeek));
const spreadPass = {
  clv: checkSpread.clv > 0,
  ats: checkSpread.ats >= BREAKEVEN,
  sample: checkSpread.picks >= MIN_PICKS,
};

// ---- Moneylines: underdogs with EV > 0 at the median US closing price, no longer than +600 ----
// CFBD has no opening moneylines, so there's no CLV here, and these are closing prices.

function mlPicks(rows, minWeek = 0) {
  return rows.flatMap((r) => {
    if (r.week < minWeek || r.homeMl == null || r.awayMl == null) return [];
    const pHome = M.homeWinProb(r.model, MODEL.sigma);
    const dog = r.homeMl > r.awayMl ? { side: 1, price: r.homeMl, p: pHome } : { side: -1, price: r.awayMl, p: 1 - pHome };
    if (dog.price <= 0 || dog.price > ML_MAX_PRICE) return [];
    const ev = M.evPer100(dog.p, dog.price);
    if (ev <= 0) return [];
    const won = r.margin * dog.side > 0;
    return [{ ...r, ...dog, ev, won, profit: won ? M.payout(dog.price) : -1 }];
  });
}
const mlSummary = (picks) => ({
  picks: picks.length,
  w: picks.filter((p) => p.won).length,
  roi: picks.length ? picks.reduce((s, p) => s + p.profit, 0) / picks.length : null,
  avgPrice: M.median(picks.map((p) => p.price)),
});
const mlTrain = mlSummary(mlPicks(rowsTrain, startWeek));
const mlCheck = mlSummary(mlPicks(rowsCheck, startWeek));

// ---- Output ----

const out = {
  builtAt: new Date().toISOString(),
  seasons: { warmup: WARMUP, train: TRAIN, check: CHECK },
  model: MODEL,
  accuracy: { train: accuracy(rowsTrain), check: accuracy(rowsCheck) },
  spread: {
    threshold: chosenX,
    startWeek,
    breakeven: BREAKEVEN,
    train: { byThreshold: trainByX, byWeek: trainWeeks, bySeason: bySeason(rowsTrain, chosenX, startWeek) },
    check: {
      summary: checkSpread,
      byThreshold: byThreshold(rowsCheck),
      byWeek: byWeek(rowsCheck, chosenX),
      bySeason: bySeason(rowsCheck, chosenX, startWeek),
    },
    goLive: { ...spreadPass, pass: Object.values(spreadPass).every(Boolean) },
  },
  moneyline: {
    maxPrice: ML_MAX_PRICE,
    train: mlTrain,
    check: mlCheck,
    goLive: { roi: mlCheck.roi > 0, clv: null, pass: false, note: "No opening moneylines in CFBD, so CLV can't be measured; ROI alone isn't enough to go live." },
  },
};
fs.writeFileSync(path.join(ROOT, "data", "backtest.json"), JSON.stringify(out, null, 1));

// ---- Console report ----

const pct = (x) => (x == null ? "–" : (100 * x).toFixed(1) + "%");
const f1 = (x) => (x == null ? "–" : x.toFixed(2));
console.log("\nModel constants:", JSON.stringify(MODEL));
for (const k of ["train", "check"]) {
  const a = out.accuracy[k];
  console.log(`RMSE ${k}: model ${f1(a.modelRmse)}  open ${f1(a.openRmse)}  close ${f1(a.closeRmse)}  (${a.games} games)`);
}
console.log("\nSpread picks vs opener, by edge threshold (picks · ATS · ROI · CLV pts)");
console.log("  X    | train                         | check");
for (const [i, t] of trainByX.entries()) {
  const c = out.spread.check.byThreshold[i];
  const cell = (s) => `${String(s.picks).padStart(4)} ${pct(s.ats).padStart(6)} ${pct(s.roi).padStart(7)} ${f1(s.clv).padStart(6)}`;
  console.log(`  ${String(t.x).padEnd(4)} | ${cell(t)}    | ${cell(c)}${t.x === chosenX ? "  ← chosen" : ""}`);
}
console.log("\nBy week at the chosen threshold (train / check):");
for (const [i, b] of trainWeeks.entries()) {
  const c = out.spread.check.byWeek[i];
  console.log(`  weeks ${b.weeks.padEnd(7)} ${String(b.picks).padStart(4)} ${pct(b.ats).padStart(6)}   | ${String(c.picks).padStart(4)} ${pct(c.ats).padStart(6)}`);
}
console.log(`Start week: ${startWeek}`);
console.log("\nCheck seasons:", JSON.stringify(out.spread.check.bySeason));
console.log("Go-live (spread):", JSON.stringify(out.spread.goLive));
console.log("\nDog moneylines train:", JSON.stringify(mlTrain));
console.log("Dog moneylines check:", JSON.stringify(mlCheck));
