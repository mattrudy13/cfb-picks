// Data and model code shared by the site (browser globals) and the Node scripts (via createRequire).
// No DOM access in here. Any change here changes recorded picks, so the page and the Action agree.
//
// Sign convention everywhere: a game's `margin` is home points − away points, and a `spread` is the
// home team's line (−7 = home favored by 7), the same as CFBD's `spread`. The home side covers when
// margin + spread > 0. A model's predicted margin M implies a model spread of −M.

// ---- Constants (fit by scripts/backtest.mjs on the training seasons; see data/backtest.json) ----

const MODEL = {
  elo: {
    k: 40,            // update size per game
    hfa: 15,          // home-field edge in Elo points, used inside the update only
    fcsStart: 1300,   // first-seen FCS (and lower) teams; FBS teams start at 1500
    carry: 1,         // share of a team's distance from 1500 kept into the next season
  },
  rating: {
    cap: 99,          // margin cap; the fit preferred none (99 = uncapped)
    hfa: 2,           // home field in points
    priorWeight: 3,   // how many games' worth of weight last season's rating gets
    carry: 0.9,       // share of last season's final rating kept as this season's prior
    newTeam: -30,     // prior for a team with no rating last season (new to FBS, or FCS)
  },
  blend: {
    eloPerPoint: 22.9, // Elo points per point of margin
    eloHfa: 2.9,      // home field added to the Elo margin, in points
    eloWeight: 0.3,   // share of Elo in the blend; the rest is the margin rating
  },
  sigma: 16.1,        // spread of actual margins around the model margin, in points
};

// ---- Helpers ----

const isFbs = (c) => c === "fbs";
const median = (xs) => {
  const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Standard normal CDF (Abramowitz–Stegun 7.1.26, error < 1.5e-7). Good enough for win %.
function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
    Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

const homeWinProb = (margin, sigma = MODEL.sigma) => normCdf(margin / sigma);

// American odds → profit per $1 staked.
const payout = (american) => (american > 0 ? american / 100 : 100 / -american);
const evPer100 = (prob, american) => 100 * (prob * payout(american) - (1 - prob));

// Completed games in date order with a margin. Ties don't exist in college football since 1996.
function completedGames(games) {
  return games
    .filter((g) => g.completed && g.homePoints != null && g.awayPoints != null)
    .map((g) => ({ ...g, margin: g.homePoints - g.awayPoints }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

// ---- Elo ----

// Runs Elo over every season in order and returns each game's pregame ratings by game id, plus
// the ratings after each season. `seasons` is [{ season, games }] sorted by season.
// Only past games feed a rating, so it's safe to backtest on (CFBD's stored Elo isn't; see SPEC.md).
// `preLag` holds the ratings from before the previous week's games, for the cautious backtest
// (in case an opening line was posted before those games were played).
function runElo(seasons, p = MODEL.elo) {
  const r = new Map();
  const pre = new Map();
  const preLag = new Map();
  const finals = {};
  for (const { season, games } of seasons) {
    for (const [t, v] of r) r.set(t, 1500 + (v - 1500) * p.carry);
    const weekStart = new Map(); // week → ratings at the start of that week
    const seasonStart = new Map(r);
    for (const g of completedGames(games)) {
      if (!weekStart.has(g.week)) weekStart.set(g.week, new Map(r));
      const start = (t, c) => r.get(t) ?? (isFbs(c) ? 1500 : p.fcsStart);
      const h = start(g.homeTeam, g.homeClassification);
      const a = start(g.awayTeam, g.awayClassification);
      pre.set(g.id, { home: h, away: a });
      const lagged = weekStart.get(g.week - 1) ?? seasonStart;
      const lagOf = (t, c) => lagged.get(t) ?? (isFbs(c) ? 1500 : p.fcsStart);
      preLag.set(g.id, { home: lagOf(g.homeTeam, g.homeClassification), away: lagOf(g.awayTeam, g.awayClassification) });
      const diff = h - a + (g.neutralSite ? 0 : p.hfa);
      const expected = 1 / (1 + 10 ** (-diff / 400));
      const won = g.margin > 0 ? 1 : 0;
      // FiveThirtyEight's margin-of-victory multiplier: bigger wins move ratings more, but less so
      // when the favorite was expected to win big (stops runaway ratings for teams that run up scores).
      const winnerDiff = g.margin > 0 ? diff : -diff;
      const mov = Math.log(Math.abs(g.margin) + 1) * (2.2 / (winnerDiff * 0.001 + 2.2));
      const delta = p.k * mov * (won - expected);
      r.set(g.homeTeam, h + delta);
      r.set(g.awayTeam, a - delta);
    }
    // Games not played yet get the current ratings (the live site's upcoming games).
    for (const g of games.filter((x) => !x.completed)) {
      const cur = (t, c) => r.get(t) ?? (isFbs(c) ? 1500 : p.fcsStart);
      const now = { home: cur(g.homeTeam, g.homeClassification), away: cur(g.awayTeam, g.awayClassification) };
      pre.set(g.id, now);
      preLag.set(g.id, now);
    }
    finals[season] = Object.fromEntries(r);
  }
  return { pre, preLag, finals };
}

// ---- Margin rating ----

// Opponent-adjusted scoring margin, solved by coordinate descent: each team's rating is the
// weighted average of what each of its games implies, pulled toward a prior worth `priorWeight` games.
// All non-FBS teams share one "FCS" rating, since each one plays too few FBS games to rate alone.
function solveRatings(games, prior, p = MODEL.rating) {
  const name = (g, side) => (isFbs(g[side + "Classification"]) ? g[side + "Team"] : "FCS");
  const rows = games.map((g) => ({
    h: name(g, "home"),
    a: name(g, "away"),
    m: Math.max(-p.cap, Math.min(p.cap, g.margin)) - (g.neutralSite ? 0 : p.hfa),
  }));
  const teams = new Set(rows.flatMap((x) => [x.h, x.a]));
  const priorOf = (t) => prior[t] ?? p.newTeam;
  const r = new Map([...teams].map((t) => [t, priorOf(t)]));
  const byTeam = new Map([...teams].map((t) => [t, []]));
  for (const x of rows) {
    byTeam.get(x.h).push([x.a, x.m]);
    byTeam.get(x.a).push([x.h, -x.m]);
  }
  for (let iter = 0; iter < 40; iter++) {
    for (const [t, gs] of byTeam) {
      let sum = p.priorWeight * priorOf(t);
      for (const [opp, m] of gs) sum += m + r.get(opp);
      r.set(t, sum / (p.priorWeight + gs.length));
    }
  }
  return r;
}

// Pregame margin ratings for every game: each week's games use only earlier weeks' results.
// Returns pregame ratings by game id, plus each season's final ratings (the next season's prior).
function runRatings(seasons, p = MODEL.rating) {
  const pre = new Map();
  const finals = {};
  let prior = {};
  for (const { season, games } of seasons) {
    const done = completedGames(games);
    const weeks = [...new Set(done.map((g) => g.week))].sort((a, b) => a - b);
    const seasonPrior = Object.fromEntries(Object.entries(prior).map(([t, v]) => [t, v * p.carry]));
    for (const w of weeks) {
      const ratings = solveRatings(done.filter((g) => g.week < w), seasonPrior, p);
      const get = (g, side) => {
        const t = isFbs(g[side + "Classification"]) ? g[side + "Team"] : "FCS";
        return ratings.get(t) ?? seasonPrior[t] ?? p.newTeam;
      };
      for (const g of done.filter((x) => x.week === w)) pre.set(g.id, { home: get(g, "home"), away: get(g, "away") });
    }
    prior = Object.fromEntries(solveRatings(done, seasonPrior, p));
    finals[season] = prior;
  }
  return { pre, finals };
}

// ---- Blend ----

function eloMargin(e, neutral, b = MODEL.blend) {
  return (e.home - e.away) / b.eloPerPoint + (neutral ? 0 : b.eloHfa);
}

function ratingMargin(r, neutral, p = MODEL.rating) {
  return r.home - r.away + (neutral ? 0 : p.hfa);
}

function modelMargin(e, r, neutral, m = MODEL) {
  const w = m.blend.eloWeight;
  return w * eloMargin(e, neutral, m.blend) + (1 - w) * ratingMargin(r, neutral, m.rating);
}

// ---- Lines ----

// Sportsbooks licensed in the US. CFBD's past lines also carry Bovada (offshore) and aggregators;
// those are used only as a fallback when no US book has the number.
const US_BOOKS = new Set([
  "DraftKings", "ESPN Bet", "FanDuel", "BetMGM", "Caesars", "Caesars (Pennsylvania)",
  "Caesars Sportsbook (Colorado)", "William Hill (New Jersey)", "BetRivers", "Fanatics",
]);
const FALLBACK_BOOKS = ["consensus", "teamrankings", "Bovada"];

// The median of US books for a field, else the first fallback provider that has it.
function lineValue(lines, field) {
  const us = median(lines.filter((l) => US_BOOKS.has(l.provider)).map((l) => l[field]));
  if (us != null) return us;
  for (const prov of FALLBACK_BOOKS) {
    const v = lines.find((l) => l.provider === prov)?.[field];
    if (v != null) return v;
  }
  return null;
}

// ---- Model v2: efficiency ratings and fitted preseason priors (SPEC.md, "Model v2") ----

// Least squares fit of y on the columns of X. Add a column of 1s for an intercept. The tiny ridge
// term keeps the solve stable when two columns move together.
function leastSquares(X, y, ridge = 1e-6) {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j < k; j++) {
      A[j][k] += X[i][j] * y[i];
      for (let l = 0; l < k; l++) A[j][l] += X[i][j] * X[i][l];
    }
  }
  for (let j = 0; j < k; j++) A[j][j] += ridge * (A[j][j] || 1);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let l = c; l <= k; l++) A[r][l] -= f * A[c][l];
    }
  }
  return A.map((row, j) => row[k] / row[j]);
}
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

// Per-game efficiency from CFBD's advanced stats: the home team's offense minus what its defense
// allowed. EPA per play is scaled by 70 plays and success rate by 100, so both read roughly like points.
const EFFICIENCY = { ppa: 70, successRate: 100 };
function efficiencyIndex(advancedRows) {
  const idx = new Map();
  for (const r of advancedRows) idx.set(`${r.gameId}|${r.team}`, r);
  return (g, key) => {
    const h = idx.get(`${g.id}|${g.homeTeam}`);
    if (h?.offense?.[key] != null && h?.defense?.[key] != null) return (h.offense[key] - h.defense[key]) * EFFICIENCY[key];
    const a = idx.get(`${g.id}|${g.awayTeam}`);
    if (a?.offense?.[key] != null && a?.defense?.[key] != null) return (a.defense[key] - a.offense[key]) * EFFICIENCY[key];
    return null;
  };
}

// Runs one rating (scoring margin, EPA or success rate) week by week over every season.
//   valueOf(g)  the game's home-minus-away value, or null to leave the game out
//   priorFor(season, prevFinal, history)  this season's prior per team; `history` holds every finished
//               season's { season, prevFinal, final } so a prior model can learn from earlier seasons only
//   lag         1 = each week ignores the previous week's games too (the cautious backtest)
// Returns { pre: Map gameId → { home, away } pregame ratings, final: { team: rating } }.
function runSeries(seasons, { valueOf, priorFor, p, lag = 0 }) {
  const pre = new Map();
  const history = [];
  let prevFinal = {};
  for (const { season, games } of seasons) {
    const all = completedGames(games);
    const rated = all.flatMap((g) => {
      const v = valueOf(g);
      return v == null ? [] : [{ ...g, margin: v }];
    });
    const prior = priorFor(season, prevFinal, history);
    // Ratings are set for every game on the schedule, played or not, so the live site can rate
    // upcoming games. Only completed games feed the ratings.
    const schedule = games.filter((g) => g.completed || g.homePoints == null);
    for (const w of new Set(schedule.map((g) => g.week))) {
      const ratings = solveRatings(rated.filter((g) => g.week < w - lag), prior, p);
      const get = (g, side) => {
        const t = isFbs(g[side + "Classification"]) ? g[side + "Team"] : "FCS";
        return ratings.get(t) ?? prior[t] ?? p.newTeam;
      };
      for (const g of schedule.filter((x) => x.week === w)) pre.set(g.id, { home: get(g, "home"), away: get(g, "away") });
    }
    // The prior model learns to predict a season-end rating built from that season's games alone
    // (almost no prior), so it isn't just learning to repeat its own prior.
    const evidence = Object.fromEntries(solveRatings(rated, {}, { ...p, priorWeight: 0.5, newTeam: 0 }));
    history.push({ season, prevFinal, final: evidence });
    prevFinal = Object.fromEntries(solveRatings(rated, prior, p));
  }
  // `final` is each team's rating after every completed game: the current rating, mid-season.
  return { pre, final: prevFinal };
}

// v1's prior: last season's final rating, pulled toward average.
const carryPrior = (p) => (season, prevFinal) =>
  Object.fromEntries(Object.entries(prevFinal).map(([t, v]) => [t, v * p.carry]));

// What's known about each FBS team before a season: its conference, the share of last season's
// offensive production (EPA) that returns, recruiting talent (z-score among FBS teams), and net
// transfer portal stars (in minus out; 0 before the portal data starts in 2021).
function priorContext(games, returning, talent, portal) {
  const conf = {};
  for (const g of games) {
    if (isFbs(g.homeClassification)) conf[g.homeTeam] = g.homeConference;
    if (isFbs(g.awayClassification)) conf[g.awayTeam] = g.awayConference;
  }
  const ret = Object.fromEntries(returning.filter((r) => r.percentPPA != null).map((r) => [r.team, r.percentPPA]));
  const tal = talent.filter((r) => conf[r.team] != null && r.talent != null);
  const tm = mean(tal.map((r) => r.talent));
  const tsd = Math.sqrt(mean(tal.map((r) => (r.talent - tm) ** 2))) || 1;
  const talentZ = Object.fromEntries(tal.map((r) => [r.team, (r.talent - tm) / tsd]));
  const net = {};
  for (const r of portal ?? []) {
    const stars = r.stars ?? 0;
    if (r.destination) net[r.destination] = (net[r.destination] ?? 0) + stars;
    if (r.origin) net[r.origin] = (net[r.origin] ?? 0) - stars;
  }
  return { conf, returning: ret, talent: talentZ, portal: net };
}

// Features for one team's prior. Last season's rating times the returning share lets a team that
// lost most of its production fall further than one that kept it.
function priorFeatures(team, prevFinal, ctx, newTeam) {
  const mates = Object.keys(ctx.conf).filter((t) => ctx.conf[t] === ctx.conf[team] && prevFinal[t] != null);
  const confLast = mates.length ? mean(mates.map((t) => prevFinal[t])) : newTeam;
  const last = prevFinal[team] ?? newTeam;
  const ret = (ctx.returning[team] ?? 0.5) - 0.5;
  return [1, last, confLast, ret, last * ret, ctx.talent[team] ?? 0, (ctx.portal[team] ?? 0) / 10];
}

// v2's prior: a regression of each season's rating on what was known before it, fit on earlier
// seasons only. Falls back to the carry prior until two seasons of history exist.
const fittedPrior = (contexts, p) => (season, prevFinal, history) => {
  const usable = history.filter((h) => contexts[h.season] && Object.keys(h.prevFinal).length);
  if (usable.length < 2 || !contexts[season]) return carryPrior(p)(season, prevFinal);
  const X = [], y = [];
  for (const h of usable) {
    const ctx = contexts[h.season];
    for (const t of Object.keys(ctx.conf)) {
      if (h.final[t] == null) continue;
      X.push(priorFeatures(t, h.prevFinal, ctx, p.newTeam));
      y.push(h.final[t]);
    }
  }
  const coef = leastSquares(X, y);
  const ctx = contexts[season];
  const out = Object.fromEntries(Object.keys(ctx.conf).map((t) => [t, dot(coef, priorFeatures(t, prevFinal, ctx, p.newTeam))]));
  out.FCS = (prevFinal.FCS ?? p.newTeam) * p.carry;
  return out;
};

// v2's predicted margin is a linear blend of rating differences (home − away) plus home field,
// with weights fit on earlier seasons.
const blendRow = (g, inputs) => [...inputs.map((pre) => pre.get(g.id).home - pre.get(g.id).away), g.neutralSite ? 0 : 1];

if (typeof module !== "undefined") {
  module.exports = {
    MODEL, median, normCdf, homeWinProb, payout, evPer100, completedGames, runElo, solveRatings, runRatings,
    eloMargin, ratingMargin, modelMargin, US_BOOKS, lineValue,
    leastSquares, dot, mean, efficiencyIndex, runSeries, carryPrior, priorContext, priorFeatures, fittedPrior, blendRow,
  };
}
