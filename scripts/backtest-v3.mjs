// Model v3 rolling backtest. Writes data/backtest-v3.json.
//
//   node scripts/backtest-v3.mjs
//
// The rules are in SPEC.md ("Model v3") and were written before this was run. In short:
// - Same rolling test as v2 (test seasons 2022–2025, everything chosen on earlier seasons only), with
//   v2's rating settings and v2's blend ("both": Elo, scoring, EPA, success rate, with fitted priors).
// - Change 1: a quarterback-change column in the blend, kept in a fold only if it lowers walk-forward
//   RMSE from 2018.
// - Change 2 (always on): edges are scaled by k = how much of the model's gap from the market held up in
//   past seasons, by game type, fit on closing lines from 2018 to the season before the test season.
// - A pass makes picks provisional; v2 is rerun alongside for comparison.

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
const PREDICT_FROM = 2018;   // first season with walk-forward blend weights (fit on 2016–2017)
const CLOSES_FROM = 2018;    // closing lines used to fit k start with the first walk-forward season
const OPENERS_FROM = 2021;   // first season CFBD has opening lines
const TESTS = range(2022, 2025);

const BREAKEVEN = 110 / 210;
const SPREAD_PRICE = -110;
const MIN_PICKS_PER_SEASON = 75;
const V2_THRESHOLDS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8];
const THRESHOLDS = [0.5, ...V2_THRESHOLDS]; // scaled edges are smaller
const WEEK_BUCKETS = [[0, 3], [4, 6], [7, 9], [10, 20]];
const TRUST_TERMS = ["base", "G5 vs G5", "Power 4 vs G5", "QB change", "week ≤ 6"];

const seasons = YEARS.map((season) => ({ season, games: read(`games-${season}.json`) }));
const lines = new Map();
for (const y of range(2016, 2025)) for (const l of read(`lines-${y}.json`)) lines.set(l.id, l.lines);
const passing = Object.fromEntries(range(2016, 2025).map((y) => [y, read(`passing-${y}.json`)]));
const eff = M.efficiencyIndex(YEARS.flatMap((y) => read(`advanced-${y}.json`)));
const contexts = {};
for (const y of range(2016, 2025)) {
  const portal = y >= 2021 ? read(`portal-${y}.json`) : [];
  contexts[y] = M.priorContext(read(`games-${y}.json`), read(`returning-${y}.json`), read(`talent-${y}.json`), portal);
}

const isFbsGame = (g) => g.homeClassification === "fbs" && g.awayClassification === "fbs";
const gamesIn = (ys) => seasons.filter((s) => ys.includes(s.season)).flatMap((s) => M.completedGames(s.games)).filter(isFbsGame);
const mse = (xs) => xs.reduce((s, x) => s + x * x, 0) / xs.length;

// ---- Ratings: v2's settings, so the only differences from v2 are the two changes ----

const v2 = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "backtest-v2.json"), "utf8"));
const { elo: eloP, margin: marginP, ppa: ppaP, successRate: srP } = v2.settings;

console.log("Running ratings…");
const elo = M.runElo(seasons, eloP);
const series = {};
for (const lag of [0, 1]) {
  const run = (valueOf, p) => M.runSeries(seasons, { valueOf, p, lag, priorFor: M.fittedPrior(contexts, p) }).pre;
  series[lag] = {
    elo: lag ? elo.preLag : elo.pre,
    marginPri: run((g) => g.margin, marginP),
    ppaPri: run((g) => eff(g, "ppa"), ppaP),
    srPri: run((g) => eff(g, "successRate"), srP),
    qb: M.qbSeries(seasons, passing, lag),
  };
}

const VARIANTS = {
  both: ["elo", "marginPri", "ppaPri", "srPri"],      // v2's choice in every fold
  bothQb: ["elo", "marginPri", "ppaPri", "srPri", "qb"],
};

// ---- Walk-forward predictions: season s uses blend weights fit on 2016…s−1 ----

const predictions = {}; // [lag][variant] → Map gameId → margin
for (const lag of [0, 1]) {
  predictions[lag] = {};
  for (const [name, keys] of Object.entries(VARIANTS)) {
    const inputs = keys.map((k) => series[lag][k]);
    const out = new Map();
    for (const s of range(PREDICT_FROM, 2025)) {
      const fit = gamesIn(range(2016, s - 1));
      const c = M.leastSquares(fit.map((g) => M.blendRow(g, inputs)), fit.map((g) => g.margin));
      for (const g of gamesIn([s])) out.set(g.id, M.dot(c, M.blendRow(g, inputs)));
    }
    predictions[lag][name] = out;
  }
}
const rmseOf = (variant, ys) => Math.sqrt(mse(gamesIn(ys).map((g) => g.margin - predictions[0][variant].get(g.id))));

// ---- Trust factor k, fit on closing lines ----

// Regress how far the result beat the market on how far the model was from it, by game type.
function fitTrust(variant, ys) {
  const X = [], y = [];
  for (const g of gamesIn(ys)) {
    const close = M.lineValue(lines.get(g.id) ?? [], "spread");
    if (close == null) continue;
    const market = -close;
    X.push(M.trustRow(predictions[0][variant].get(g.id) - market, M.trustFlags(g, series[0].qb.get(g.id))));
    y.push(g.margin - market);
  }
  return { k: M.leastSquares(X, y), n: X.length };
}

// ---- Picks against the opener ----

// k = null means no trust layer (v2's rule).
function rowsFor(ys, variant, k, lag = 0) {
  return gamesIn(ys).flatMap((g) => {
    const ls = lines.get(g.id) ?? [];
    const open = M.lineValue(ls, "spreadOpen"), close = M.lineValue(ls, "spread");
    if (open == null || close == null) return [];
    const model = predictions[lag][variant].get(g.id);
    const trust = k ? M.trustFactor(k, M.trustFlags(g, series[lag].qb.get(g.id))) : 1;
    return [{ id: g.id, season: g.season, week: g.week, margin: g.margin, open, close, model, trust, edge: trust * (model + open) }];
  });
}

function spreadPicks(rows, x, minWeek = 0) {
  return rows.flatMap((r) => {
    if (r.week < minWeek || Math.abs(r.edge) < x) return [];
    const side = r.edge > 0 ? 1 : -1;
    const grade = (line) => { const c = (r.margin + line) * side; return c > 0 ? "W" : c < 0 ? "L" : "P"; };
    return [{ id: r.id, season: r.season, week: r.week, side, edge: Math.abs(r.edge), trust: r.trust,
      result: grade(r.open), resultClose: grade(r.close), clv: (r.open - r.close) * side }];
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

function chooseThreshold(rows, nSeasons, grid) {
  const table = grid.map((x) => ({ x, ...summarize(spreadPicks(rows, x)) }));
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

// One fold under a given rule: which variant, whether to use the trust layer.
function runFold(T, { variant, trust }) {
  const openerPast = range(OPENERS_FROM, T - 1);
  const k = trust ? fitTrust(variant, range(CLOSES_FROM, T - 1)).k : null;
  const pastRows = rowsFor(openerPast, variant, k);
  const x = chooseThreshold(pastRows, openerPast.length, trust ? THRESHOLDS : V2_THRESHOLDS);
  const startWeek = chooseStartWeek(pastRows, x);
  const picks = spreadPicks(rowsFor([T], variant, k), x, startWeek);
  const cautious = spreadPicks(rowsFor([T], variant, k, 1), x, startWeek);
  return { test: T, variant, k, threshold: x, startWeek, result: summarize(picks), cautious: summarize(cautious), picks, cautiousPicks: cautious };
}

const totalsOf = (folds) => {
  const total = summarize(folds.flatMap((f) => f.picks));
  const cautious = summarize(folds.flatMap((f) => f.cautiousPicks));
  const profitableSeasons = folds.filter((f) => f.result.roi > 0).length;
  const goLive = { ats: total.ats >= BREAKEVEN, clv: total.clv > 0, seasons: profitableSeasons >= 3, sample: total.picks >= 150, cautiousClv: cautious.clv > 0 };
  goLive.pass = Object.values(goLive).every(Boolean);
  return { total, cautious, profitableSeasons, goLive };
};

// ---- v3: each fold keeps the QB column only if it lowers walk-forward RMSE on earlier seasons ----

const folds = TESTS.map((T) => {
  const past = range(PREDICT_FROM, T - 1);
  const rmse = { both: rmseOf("both", past), bothQb: rmseOf("bothQb", past) };
  const keepQb = rmse.bothQb < rmse.both;
  return { ...runFold(T, { variant: keepQb ? "bothQb" : "both", trust: true }), keepQb, pastRmse: rmse, testRmse: { both: rmseOf("both", [T]), bothQb: rmseOf("bothQb", [T]) } };
});
const v3 = totalsOf(folds);

// For comparison only (not the decision): v2 rerun, and each change on its own.
const compare = {
  v2: TESTS.map((T) => runFold(T, { variant: "both", trust: false })),
  qbOnly: TESTS.map((T) => runFold(T, { variant: "bothQb", trust: false })),
  trustOnly: TESTS.map((T) => runFold(T, { variant: "both", trust: true })),
};
const compareTotals = Object.fromEntries(Object.entries(compare).map(([k, f]) => [k, { ...totalsOf(f), seasons: f.map((x) => ({ test: x.test, threshold: x.threshold, startWeek: x.startWeek, ...x.result })) }]));

// Market benchmark per test season.
const marketRmse = Object.fromEntries(TESTS.map((T) => {
  const rows = rowsFor([T], "both", null);
  const r = (f) => Math.sqrt(mse(rows.map((x) => x.margin - f(x))));
  return [T, { open: r((x) => -x.open), close: r((x) => -x.close) }];
}));

// ---- The live 2026 model: the same fold rule with every season through 2025 ----

const LIVE_SEASON = 2026;
const livePast = range(PREDICT_FROM, LIVE_SEASON - 1);
const liveVariant = rmseOf("bothQb", livePast) < rmseOf("both", livePast) ? "bothQb" : "both";
const liveTrust = fitTrust(liveVariant, range(CLOSES_FROM, LIVE_SEASON - 1));
const liveOpeners = range(OPENERS_FROM, LIVE_SEASON - 1);
const liveRows = rowsFor(liveOpeners, liveVariant, liveTrust.k);
const liveX = chooseThreshold(liveRows, liveOpeners.length, THRESHOLDS);
const liveFit = gamesIn(range(2016, LIVE_SEASON - 1));
const liveInputs = VARIANTS[liveVariant].map((k) => series[0][k]);
const liveDesign = liveFit.map((g) => M.blendRow(g, liveInputs));
const liveCoef = M.leastSquares(liveDesign, liveFit.map((g) => g.margin));
const live = {
  season: LIVE_SEASON,
  variant: liveVariant,
  inputs: VARIANTS[liveVariant],
  coef: liveCoef,
  sigma: Math.sqrt(mse(liveFit.map((g, i) => g.margin - M.dot(liveCoef, liveDesign[i])))),
  trust: liveTrust.k,
  threshold: liveX,
  startWeek: chooseStartWeek(liveRows, liveX),
};

const strip = ({ picks, cautiousPicks, ...f }) => f;
const out = {
  builtAt: new Date().toISOString(),
  live,
  trustTerms: TRUST_TERMS,
  folds: folds.map(strip),
  ...v3,
  breakeven: BREAKEVEN,
  compare: compareTotals,
  marketRmse,
};
fs.writeFileSync(path.join(ROOT, "data", "backtest-v3.json"), JSON.stringify(out, null, 1));

// ---- Console report ----

const pct = (x) => (x == null ? "–" : (100 * x).toFixed(1) + "%");
const f2 = (x) => (x == null ? "–" : x.toFixed(2));
const qbFlagged = gamesIn(range(2016, 2025)).filter((g) => { const q = series[0].qb.get(g.id); return q.home || q.away; }).length;
console.log(`\nQB-flagged games 2016–2025: ${qbFlagged} of ${gamesIn(range(2016, 2025)).length}`);
console.log("\nWalk-forward RMSE (test season): both vs bothQb | market open, close");
for (const f of folds) console.log(`${f.test}  ${f2(f.testRmse.both)}  ${f2(f.testRmse.bothQb)}  | ${f2(marketRmse[f.test].open)}  ${f2(marketRmse[f.test].close)}   keepQb=${f.keepQb}`);
console.log("\nv3 folds:");
for (const f of folds) {
  const r = f.result;
  console.log(`${f.test}: ${f.variant.padEnd(6)} k=[${f.k.map(f2).join(", ")}] X=${f.threshold} wk ${f.startWeek}  picks ${r.picks}  ATS ${pct(r.ats)}  @close ${pct(r.atsClose)}  ROI ${pct(r.roi)}  CLV ${f2(r.clv)}  | cautious CLV ${f2(f.cautious.clv)}`);
}
const t = v3.total;
console.log(`\nv3 total: picks ${t.picks}  ATS ${pct(t.ats)}  @close ${pct(t.atsClose)}  ROI ${pct(t.roi)}  CLV ${f2(t.clv)}  profitable ${v3.profitableSeasons}/4  cautious CLV ${f2(v3.cautious.clv)}`);
console.log("Go-live:", JSON.stringify(v3.goLive));
console.log("\nComparison:");
for (const [k, c] of Object.entries(compareTotals)) {
  console.log(`${k.padEnd(10)} ${c.seasons.map((s) => `${s.picks}p ${pct(s.ats)}`).join(" | ")}  → ${c.total.picks} picks ${pct(c.total.ats)} @close ${pct(c.total.atsClose)} ROI ${pct(c.total.roi)} profitable ${c.profitableSeasons}/4 pass=${c.goLive.pass}`);
}
console.log("\nLive:", JSON.stringify(live));
