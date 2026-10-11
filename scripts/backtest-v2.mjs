// Model v2 rolling backtest. Writes data/backtest-v2.json.
//
//   node scripts/backtest-v2.mjs
//
// The rules are in SPEC.md ("Model v2") and were written before this was run. In short:
// - Every prediction is walk-forward: a season's prior coefficients and blend weights are fit on earlier
//   seasons only, and each week's ratings use only earlier weeks.
// - The rating settings (Elo K, prior weight…) are fit once, on 2016–2020 margins, before any test season.
// - Test seasons 2022–2025. Each fold picks, from earlier seasons only: which v2 changes to keep (walk-forward
//   RMSE from 2018), then the edge threshold and start week (opener seasons from 2021).
// - Go-live is judged on what each fold picked, plus the cautious (one-week lag) version's CLV.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const M = require("../model.js");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = path.join(ROOT, "data", "raw");
const read = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8"));
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const YEARS = range(2015, 2025);
const SETTINGS_FIT = range(2016, 2020); // rating settings, fit on margins only
const PREDICT_FROM = 2018;              // first season with walk-forward blend weights (fit on 2016–2017)
const OPENERS_FROM = 2021;              // first season CFBD has opening lines
const TESTS = range(2022, 2025);

const BREAKEVEN = 110 / 210;
const SPREAD_PRICE = -110;
const MIN_PICKS_PER_SEASON = 75;
const THRESHOLDS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8];
const WEEK_BUCKETS = [[0, 3], [4, 6], [7, 9], [10, 20]];

const seasons = YEARS.map((season) => ({ season, games: read(`games-${season}.json`) }));
const lines = new Map();
for (const y of range(OPENERS_FROM, 2025)) for (const l of read(`lines-${y}.json`)) lines.set(l.id, l.lines);
const eff = M.efficiencyIndex(YEARS.flatMap((y) => read(`advanced-${y}.json`)));
const contexts = {};
for (const y of range(2016, 2025)) {
  const portal = y >= 2021 ? read(`portal-${y}.json`) : [];
  contexts[y] = M.priorContext(read(`games-${y}.json`), read(`returning-${y}.json`), read(`talent-${y}.json`), portal);
}

const isFbsGame = (g) => g.homeClassification === "fbs" && g.awayClassification === "fbs";
const gamesIn = (ys) => seasons.filter((s) => ys.includes(s.season)).flatMap((s) => M.completedGames(s.games)).filter(isFbsGame);
const mse = (xs) => xs.reduce((s, x) => s + x * x, 0) / xs.length;

// ---- Rating settings: fit once on 2016–2020 (no test season involved) ----

function coordSearch(start, grid, score) {
  let best = { p: { ...start }, s: score(start) };
  for (let round = 0; round < 2; round++) {
    for (const [key, values] of Object.entries(grid)) {
      for (const v of values) {
        if (v === best.p[key]) continue;
        const p = { ...best.p, [key]: v };
        const s = score(p);
        if (s < best.s) best = { p, s };
      }
    }
  }
  return best.p;
}

const settingsSeasons = seasons.filter((s) => s.season <= 2020);
const settingsGames = gamesIn(SETTINGS_FIT);
// Score a rating by the in-sample fit of margin on (rating difference, home) over 2016–2020.
function fitScore(pre) {
  const X = settingsGames.map((g) => M.blendRow(g, [pre]));
  const y = settingsGames.map((g) => g.margin);
  const c = M.leastSquares(X, y);
  return mse(y.map((v, i) => v - M.dot(c, X[i])));
}

console.log("Fitting rating settings on 2016–2020…");
const eloP = coordSearch(M.MODEL.elo, {
  k: [20, 30, 40, 50, 60], carry: [0.6, 0.7, 0.8, 0.9, 1], hfa: [15, 35, 55], fcsStart: [1100, 1200, 1300],
}, (p) => fitScore(M.runElo(settingsSeasons, p).pre));
const marginP = coordSearch(M.MODEL.rating, {
  cap: [21, 28, 35, 99], priorWeight: [1, 2, 3, 5, 8], carry: [0.6, 0.75, 0.9, 1], hfa: [1.5, 2, 2.5, 3], newTeam: [-30, -20, -12],
}, (p) => fitScore(M.runSeries(settingsSeasons, { valueOf: (g) => g.margin, priorFor: M.carryPrior(p), p })));
// Efficiency ratings: no cap and no home adjustment inside the solve (the blend's home term covers it).
const effBase = { cap: 999, hfa: 0, newTeam: marginP.newTeam };
const ppaP = coordSearch({ ...effBase, priorWeight: 3, carry: 0.75 }, { priorWeight: [1, 2, 3, 5, 8], carry: [0.5, 0.75, 0.9, 1] },
  (p) => fitScore(M.runSeries(settingsSeasons, { valueOf: (g) => eff(g, "ppa"), priorFor: M.carryPrior(p), p })));
const srP = coordSearch({ ...effBase, priorWeight: 3, carry: 0.75 }, { priorWeight: [1, 2, 3, 5, 8], carry: [0.5, 0.75, 0.9, 1] },
  (p) => fitScore(M.runSeries(settingsSeasons, { valueOf: (g) => eff(g, "successRate"), priorFor: M.carryPrior(p), p })));

// ---- Every rating series, normal and cautious (lag 1) ----

console.log("Running ratings…");
const elo = M.runElo(seasons, eloP);
const series = {};
for (const lag of [0, 1]) {
  const run = (valueOf, p, fitted) =>
    M.runSeries(seasons, { valueOf, p, lag, priorFor: fitted ? M.fittedPrior(contexts, p) : M.carryPrior(p) });
  series[lag] = {
    elo: lag ? elo.preLag : elo.pre,
    margin: run((g) => g.margin, marginP, false),
    marginPri: run((g) => g.margin, marginP, true),
    ppa: run((g) => eff(g, "ppa"), ppaP, false),
    ppaPri: run((g) => eff(g, "ppa"), ppaP, true),
    sr: run((g) => eff(g, "successRate"), srP, false),
    srPri: run((g) => eff(g, "successRate"), srP, true),
  };
}

const VARIANTS = {
  v1: ["elo", "margin"],
  efficiency: ["elo", "margin", "ppa", "sr"],
  priors: ["elo", "marginPri"],
  both: ["elo", "marginPri", "ppaPri", "srPri"],
};
const variantFor = (keepEff, keepPri) => (keepEff && keepPri ? "both" : keepEff ? "efficiency" : keepPri ? "priors" : "v1");

// ---- Walk-forward predictions: season s uses blend weights fit on 2016…s−1 ----

const predictions = {}; // [lag][variant] → Map gameId → { margin, sigma }
for (const lag of [0, 1]) {
  predictions[lag] = {};
  for (const [name, keys] of Object.entries(VARIANTS)) {
    const inputs = keys.map((k) => series[lag][k]);
    const out = new Map();
    for (const s of range(PREDICT_FROM, 2025)) {
      const fit = gamesIn(range(2016, s - 1));
      const X = fit.map((g) => M.blendRow(g, inputs));
      const y = fit.map((g) => g.margin);
      const c = M.leastSquares(X, y);
      const sigma = Math.sqrt(mse(y.map((v, i) => v - M.dot(c, X[i]))));
      for (const g of gamesIn([s])) out.set(g.id, { margin: M.dot(c, M.blendRow(g, inputs)), sigma });
    }
    predictions[lag][name] = out;
  }
}

const rmseOf = (variant, ys, lag = 0) =>
  Math.sqrt(mse(gamesIn(ys).map((g) => g.margin - predictions[lag][variant].get(g.id).margin)));

// ---- Picks against the opener (same rules as v1) ----

function rowsFor(ys, variant, lag = 0) {
  return gamesIn(ys).flatMap((g) => {
    const ls = lines.get(g.id) ?? [];
    const open = M.lineValue(ls, "spreadOpen"), close = M.lineValue(ls, "spread");
    if (open == null || close == null) return [];
    return [{ id: g.id, season: g.season, week: g.week, margin: g.margin, open, close, model: predictions[lag][variant].get(g.id).margin }];
  });
}

function spreadPicks(rows, x, minWeek = 0) {
  return rows.flatMap((r) => {
    if (r.week < minWeek) return [];
    const edge = r.model + r.open;
    if (Math.abs(edge) < x) return [];
    const side = edge > 0 ? 1 : -1;
    const grade = (line) => { const c = (r.margin + line) * side; return c > 0 ? "W" : c < 0 ? "L" : "P"; };
    return [{ id: r.id, season: r.season, week: r.week, side, edge: Math.abs(edge), result: grade(r.open), resultClose: grade(r.close), clv: (r.open - r.close) * side }];
  });
}

function summarize(picks) {
  const count = (k, v) => picks.filter((p) => p[k] === v).length;
  const w = count("result", "W"), l = count("result", "L"), wc = count("resultClose", "W"), lc = count("resultClose", "L");
  return {
    picks: picks.length, w, l, push: picks.length - w - l,
    ats: w + l ? w / (w + l) : null,
    atsClose: wc + lc ? wc / (wc + lc) : null,
    roi: w + l ? (w * M.payout(SPREAD_PRICE) - l) / (w + l) : null,
    clv: picks.length ? picks.reduce((s, p) => s + p.clv, 0) / picks.length : null,
  };
}

function chooseThreshold(rows, nSeasons) {
  const table = THRESHOLDS.map((x) => ({ x, ...summarize(spreadPicks(rows, x)) }));
  const ok = table.filter((t) => t.picks >= MIN_PICKS_PER_SEASON * nSeasons);
  return (ok.length ? ok : table).reduce((a, b) => (b.ats > a.ats ? b : a)).x;
}
function chooseStartWeek(rows, x) {
  let start = 0;
  for (const [i, [a, b]] of WEEK_BUCKETS.slice(0, 2).entries()) {
    const s = summarize(spreadPicks(rows, x).filter((p) => p.week >= a && p.week <= b));
    if (s.ats != null && s.ats < BREAKEVEN) start = WEEK_BUCKETS[i][1] + 1;
  }
  return start;
}

// ---- Folds ----

const folds = TESTS.map((T) => {
  const past = range(PREDICT_FROM, T - 1);
  const base = rmseOf("v1", past);
  const keepEff = rmseOf("efficiency", past) < base;
  const keepPri = rmseOf("priors", past) < base;
  const variant = variantFor(keepEff, keepPri);
  const openerPast = range(OPENERS_FROM, T - 1);
  const pastRows = rowsFor(openerPast, variant);
  const x = chooseThreshold(pastRows, openerPast.length);
  const startWeek = chooseStartWeek(pastRows, x);
  const picks = spreadPicks(rowsFor([T], variant), x, startWeek);
  const cautious = spreadPicks(rowsFor([T], variant, 1), x, startWeek);
  // For comparison only: every variant with this fold's own threshold rule applied to it.
  const compare = Object.fromEntries(Object.keys(VARIANTS).map((v) => {
    const pr = rowsFor(openerPast, v);
    const vx = chooseThreshold(pr, openerPast.length);
    const vs = chooseStartWeek(pr, vx);
    return [v, { x: vx, startWeek: vs, rmse: rmseOf(v, [T]), ...summarize(spreadPicks(rowsFor([T], v), vx, vs)) }];
  }));
  return {
    test: T, keepEfficiency: keepEff, keepPriors: keepPri, variant, threshold: x, startWeek,
    pastRmse: Object.fromEntries(Object.keys(VARIANTS).map((v) => [v, rmseOf(v, past)])),
    result: summarize(picks), cautious: summarize(cautious), picks, compare,
  };
});

const allPicks = folds.flatMap((f) => f.picks);
const total = summarize(allPicks);
const cautiousTotal = summarize(folds.flatMap((f) => spreadPicks(rowsFor([f.test], f.variant, 1), f.threshold, f.startWeek)));
const profitableSeasons = folds.filter((f) => f.result.roi > 0).length;
const goLive = {
  ats: total.ats >= BREAKEVEN,
  clv: total.clv > 0,
  seasons: profitableSeasons >= 3,
  sample: total.picks >= 150,
  cautiousClv: cautiousTotal.clv > 0,
};
goLive.pass = Object.values(goLive).every(Boolean);

// Market benchmark per test season.
const marketRmse = Object.fromEntries(TESTS.map((T) => {
  const rows = rowsFor([T], "v1");
  const r = (f) => Math.sqrt(mse(rows.map((x) => x.margin - f(x))));
  return [T, { open: r((x) => -x.open), close: r((x) => -x.close) }];
}));

const out = {
  builtAt: new Date().toISOString(),
  settings: { elo: eloP, margin: marginP, ppa: ppaP, successRate: srP },
  folds: folds.map(({ picks, ...f }) => f),
  total, cautious: cautiousTotal, profitableSeasons, breakeven: BREAKEVEN, goLive, marketRmse,
};
fs.writeFileSync(path.join(ROOT, "data", "backtest-v2.json"), JSON.stringify(out, null, 1));

// ---- Console report ----

const pct = (x) => (x == null ? "–" : (100 * x).toFixed(1) + "%");
const f2 = (x) => (x == null ? "–" : x.toFixed(2));
console.log("\nSettings:", JSON.stringify(out.settings));
console.log("\nWalk-forward RMSE by season (lower is better; market for test seasons):");
console.log("season  v1     eff    pri    both   | open   close");
for (const s of range(PREDICT_FROM, 2025)) {
  const m = marketRmse[s];
  console.log(`${s}    ${["v1", "efficiency", "priors", "both"].map((v) => f2(rmseOf(v, [s]))).join("  ")}  | ${m ? f2(m.open) + "  " + f2(m.close) : ""}`);
}
console.log("\nFolds (what each fold chose from earlier seasons, then its test season):");
for (const f of folds) {
  const r = f.result;
  console.log(`${f.test}: ${f.variant.padEnd(10)} X=${f.threshold} start wk ${f.startWeek}  picks ${r.picks}  ATS ${pct(r.ats)}  @close ${pct(r.atsClose)}  ROI ${pct(r.roi)}  CLV ${f2(r.clv)}  | cautious CLV ${f2(f.cautious.clv)}`);
}
console.log(`\nTotal: picks ${total.picks}  ATS ${pct(total.ats)}  @close ${pct(total.atsClose)}  ROI ${pct(total.roi)}  CLV ${f2(total.clv)}  profitable seasons ${profitableSeasons}/4`);
console.log(`Cautious: picks ${cautiousTotal.picks}  ATS ${pct(cautiousTotal.ats)}  CLV ${f2(cautiousTotal.clv)}`);
console.log("Go-live:", JSON.stringify(goLive));
console.log("\nComparison (each variant with its own fold-chosen threshold):");
for (const v of Object.keys(VARIANTS)) {
  const c = folds.map((f) => f.compare[v]);
  const tot = c.reduce((a, b) => ({ picks: a.picks + b.picks, w: a.w + b.w, l: a.l + b.l }), { picks: 0, w: 0, l: 0 });
  console.log(`${v.padEnd(10)} ${c.map((x) => `${x.picks}p ${pct(x.ats)}`).join(" | ")}  → ${tot.picks} picks ${pct(tot.w / (tot.w + tot.l))}`);
}
