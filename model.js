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
function runElo(seasons, p = MODEL.elo) {
  const r = new Map();
  const pre = new Map();
  const finals = {};
  for (const { season, games } of seasons) {
    for (const [t, v] of r) r.set(t, 1500 + (v - 1500) * p.carry);
    for (const g of completedGames(games)) {
      const h = r.get(g.homeTeam) ?? (isFbs(g.homeClassification) ? 1500 : p.fcsStart);
      const a = r.get(g.awayTeam) ?? (isFbs(g.awayClassification) ? 1500 : p.fcsStart);
      pre.set(g.id, { home: h, away: a });
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
    finals[season] = Object.fromEntries(r);
  }
  return { pre, finals };
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

if (typeof module !== "undefined") {
  module.exports = {
    MODEL, median, normCdf, homeWinProb, payout, evPer100, completedGames, runElo, solveRatings, runRatings,
    eloMargin, ratingMargin, modelMargin, US_BOOKS, lineValue,
  };
}
