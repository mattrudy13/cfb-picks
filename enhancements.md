# Enhancements

Possible improvements, written 2026-10-12 (week 7 of 2026, model v3 live and provisional). Each item has
an effort (**S** under an hour or two, **M** an evening or two, **L** a project) and a value
(**High / Med / Low**). None of these are decided. Model and pick changes still go through SPEC.md first.

## Do first

These are cheap, or they lose data every week they wait.

1. **Save weekly SP+/FPI snapshots** (gap 1). Each week that passes is gone for good.
2. **Keep a per-game ledger for every FBS game** (Picks & tracking). It's the only clean test data
   v4 will have, and it's lost week by week.
3. **Measure line move against the real close** (gap 2). The provisional → official rule depends on it.
4. **Fix the status shown on Best Bets** (gap 3). It's latent now, but it fires at exactly the moment that
   matters.
5. **Decide how strict the official rule is before reaching 100 picks** (Model & research). Changing it
   afterward would look like moving the goalposts.

## Gaps found

Things that don't match the spec or the code's own comments. These are closer to bugs than ideas.

### 1. Weekly SP+/FPI snapshots aren't being saved — S · High
SPEC.md (Look-ahead bias) assumed `build-data` would store a weekly SP+/FPI snapshot, so next season could
fairly test whether they help. CFBD only returns end-of-season numbers, so snapshots taken live are the
only point-in-time copies that will ever exist. But `build-data.mjs` overwrites `data/raw/sp-2026.json` and
`fpi-2026.json` in place about once a week. No history is building up. Fix: also write
`sp-2026-wk<N>.json` (or add each week to one file keyed by week) when refreshing. No extra CFBD calls.

### 2. Live line move isn't measured against the closing line — M · High
Live CLV uses the last odds snapshot before kickoff as the "close." With snapshots on Sunday night,
Tuesday, Friday and Saturday 9 AM ET, a Thursday game "closes" on Tuesday morning and a Saturday night game
about 10+ hours early (more when GitHub starts the run late). The backtest's CLV used CFBD's actual closing
line. So the number that decides provisional → official (CLV > 0 over 100 picks) isn't the number the
backtest promised. Fix: fetch `lines?year=2026&seasonType=regular` in `update-data` (about 1 CFBD call per
run, well within budget) and add a `closeTrue` to each graded pick. Show both, and base the rule on the
real close. This should go into SPEC.md before it's applied.

### 3. Best Bets would keep saying "provisional" after the record goes official — S · Med
`index.html` gets the status from `all.find((p) => p.cat === "spread")?.status`, which is the **oldest**
spread pick. Picks keep the status they were recorded with, so after the record turns official the
banner and record card would still read "provisional." Fix: use the newest pick's status, or compute it
the same way `statusNow()` in `record-picks.mjs` does.

### 4. Stale docs and copy — S · Low
- README: says `backtest-v2.mjs` writes the live model's settings, and its file table leaves out
  `backtest-v3.mjs`.
- `model.js` and `common.js` header comments say the pages load `model.js`. They don't.
- `index.html` meta description still advertises underdog moneyline picks.
- SPEC.md, Picks: "All picks are unofficial while `data/backtest-v2.json` says the go-live bar failed" is
  from before v3.
- After daylight saving ends Nov 1, the cron jobs run an hour earlier in ET. The Best Bets lede still says
  "Sunday 9 PM" (see Pipeline & ops).

## Model & research

All of these follow the existing pattern: write the rules in SPEC.md first, and choose thresholds only on
seasons before the test season.

**Treat 2026 as the holdout. Pre-register v4 before 2027. — S · High**
2022–2025 have now been tested against three models, so they can't give a clean answer anymore. The 2026
live season is the first truly unseen data. Don't refit anything on it mid-season. Write v4's rules
before the 2026 results are known, then test them on 2026 once the season ends.

**Make the official rule statistical. — S · High**
"Sum of CLV > 0 over 100 picks" flips on noise: one big move decides it. Something like "mean CLV > 0
with a one-sided 90% or 95% confidence interval above 0" says what the rule means. Decide before pick 100
and record it in SPEC.md. It also needs to say what happens if the record later falls back (right now
status never goes back).

**Use the real spread distribution, not a normal curve. — M · Med**
`homeWinProb` and `modelProb` use a normal CDF with one sigma. College margins bunch at 3, 7 and 10, so
half a point through a key number is worth more than half a point elsewhere. SPEC.md says neither
backtest tested key numbers. An empirical cover-probability table (margin vs. line, from 2015–2025 games)
would give a better win chance per pick. It would also remove the fat-tails problem that led to dropping
moneylines, if those ever come back.

**Target the line move directly. — L · Med**
The v3 results show the edge only exists before the market moves (55% vs. the opener, 49% vs. the close).
The trust layer already fits on closing lines. A model whose target is the closing line itself
(close − open, predicted from the model's gap and game type) aims at what's actually being measured. This
needs the per-game ledger to test on 2026.

**Cheap schedule features: rest, byes, travel. — M · Low–Med**
Days since each team's last game, coming off a bye, and short weeks can all be computed from the games
files already cached (no API calls). Long-distance travel needs venue coordinates (one CFBD `venues` call).
They'd go in as blend columns under v2's "keep it only if walk-forward RMSE drops" rule.

**Retest SP+/FPI in 2027. — M · Med (depends on gap 1)**
Once a season of weekly snapshots exists, run the fair test SPEC.md planned for.

**Better QB signal. — L · Low**
The v3 QB flag catches about 28% of games and is worth about half a point. A sharper version (starter
confirmed out, by name) needs a source of injury and depth-chart news that CFBD doesn't have. Probably not
worth it without a cheap feed.

## Picks & tracking

**Per-game ledger for every FBS game. — M · High**
Right now only picks keep their history. `data/2026.json` and `odds-2026.json` keep just the latest model
line and the first and latest market lines, overwritten every run. Add a `ledger-2026.json` that records,
for every FBS game: the model line, trust and raw edge at the Sunday snapshot, the market at each
snapshot, the real close, and the result. That lets you check how well the trust factor holds up, the
threshold choice and any v4 idea on all ~700 games instead of 100 picks.

**Store the line at every snapshot for each pick. — S · Med**
Keep `{ at, market }` per snapshot instead of overwriting `closeMarket`. That shows *when* the line moves
(for example, whether most of it happens by Tuesday), which matters for "bet early." It's also free; the snapshots
already run.

**Show the uncertainty on the record. — S · Med**
Add a 95% interval for win rate and line move, and a progress line toward the official bar (e.g.
"47 of 100 picks, average move +0.6, interval −0.2 to +1.4"). At these sample sizes the interval is the
honest headline.

**Split ROI into model edge and line shopping. — S · Low**
Each pick is recorded at the best line, not the median. Record how much better the best line was than the
median, so the record shows how much profit came from shopping and how much from the model.

**Shadow thresholds, labeled as diagnostics. — S · Low**
Log what picks would have been at 1.0 and 1.5 trusted points too, kept out of the record. Useful at season
end, but it invites picking the best threshold after the fact. Only worth it if it's pre-registered as
diagnostic-only.

## Pipeline & ops

**Tests with `node:test`. — M · High**
No dependencies needed (Node 22 has a test runner built in). Cover the costliest mistakes: sign
conventions in `model.js`, grading (win, loss, push, void after 5 days), and `record-picks` locking (a
later snapshot never moves or removes a pick, one pick per game per model), using fixtures and `NOW=`. Run
them in CI next to the asset check.

**Guard the live model against accidental changes. — S · Med**
Rerunning a backtest silently changes the live model, because `build-data` reads `live` from the backtest
file. Store a hash of the `live` block on each pick. Have `record-picks` stop with an error when it
changes mid-season unless the model version is bumped.

**Make Actions failures visible. — S · Med**
- Odds API team names that don't match CFBD are only logged. The run still succeeds and the game silently
  gets no pick. Print `::warning::` for each one so it shows in the Actions summary, or fail when an
  FBS-vs-FBS game is unmatched.
- Save `x-requests-remaining` into `odds-2026.json` and warn under ~50. The 500 credits are shared with
  te-tracker.

**Daylight saving fix. — S · Low**
After Nov 1 every cron runs an hour earlier in ET (Sunday's snapshot at 8 PM). Either split the crons by
month (`8-10` on the current UTC hours, `11-12` an hour later; that's off by a few days in years when daylight saving
ends after Nov 1) or update the page copy to say "around."

**Season rollover runbook. — M · Med**
For 2027, `build-data` takes the season from `backtest-v3.json` → `live.season`, then writes
`seasons.json`. Moving to 2027 means either a new backtest or editing `live.season`, along with caching
2026's history (lines, returning production, talent, portal) into `data/raw/`. Write the steps down in
README or SPEC before August 2027, or add a `--season` flag.

## Site & UX

**Charts of the record over time. — M · Med**
Cumulative profit and cumulative average line move by week, for v3 (and v2 and moneylines kept separate).
A line that's drifting above zero says more than one W–L number.

**Load less data per page. — M · Med**
Every page loads the full `data/2026.json` (~450 KB) even when it only needs team colors. Split it into
`teams`, `ratings` and `games` files so Best Bets and Ratings load a fraction of it on a phone.

**Past weeks on Best Bets. — S · Low**
Only this week gets cards; older weeks are rows in the history table. A week picker (in the URL, like the
other filters) would let you look back at a week's cards and results.

**Retire the moneyline card once it's all graded. — S · Low**
Once every recorded moneyline is graded, collapse the "Underdog moneylines" record into a small retired
note, the same way v2 is handled.
