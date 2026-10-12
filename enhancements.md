# Enhancements

Possible improvements, written 2026-10-12 (week 7 of 2026, model v3 live and provisional) and updated the
same day after the four gaps below were fixed. Each item has
an effort (**S** under an hour or two, **M** an evening or two, **L** a project) and a value
(**High / Med / Low**). None of these are decided. Model and pick changes still go through SPEC.md first.

## Do first

Done 2026-10-12:
- **CFBD's 2026 books checked.** DraftKings on every game, plus Bovada (offshore, not used). DraftKings
  had a close for all 329 FBS-vs-FBS games in weeks 1–6 and priced all 59 week 7 games in our snapshots,
  so the move to the close works, as DraftKings at posting vs. DraftKings at the close.
- **Per-game ledger.** `scripts/build-ledger.mjs` rebuilds it from git history (see Picks & tracking).
- **Official rule settled.** At least 100 v3 spread picks with a move to the close, and the one-sided 95%
  lower bound on the average move above 0. Checked at every snapshot, so it can fall back. In SPEC.md.

Next, in date order:
1. **Review the bad-data threshold after 3–4 graded weeks, before pick 100** (Picks & tracking).
2. **Pre-register v4 before the 2026 season ends** (Model & research).

## Gaps found (fixed 2026-10-12)

Four places where the code didn't match the spec or its own comments. All fixed; details in SPEC.md.

1. **Weekly SP+/FPI snapshots weren't being saved.** Now kept in `data/raw/ratings-history-<season>.json`
   once per ET week. 2026's history starts Oct 11; weeks 1–6 are lost.
2. **Live line move wasn't measured against the real close.** `grade-picks` now sets `clvClose` from CFBD's
   closing lines, book by book against the lines saved on the pick at posting, and the provisional →
   official rule counts only that. Week 7 picks got their posting-time book lines from git history.
3. **Best Bets would have kept saying "provisional" after the record went official.** It now uses the
   newest pick's status.
4. **Stale docs and copy, and daylight saving.** README, `model.js`/`common.js` headers, the Best Bets meta
   description and SPEC.md's status line are updated. The cron schedules are split by month so ET times
   stay fixed after Nov 1.

## Model & research

All of these follow the existing pattern: write the rules in SPEC.md first, and choose thresholds only on
seasons before the test season.

**Treat 2026 as the holdout. Pre-register v4 before 2027. — S · High**
2022–2025 have now been tested against three models, so they can't give a clean answer anymore. The 2026
live season is the first truly unseen data. Don't refit anything on it mid-season. Write v4's rules
before the 2026 results are known, then test them on 2026 once the season ends.

**Use the real spread distribution, not a normal curve. — M · Med**
`homeWinProb` and `modelProb` use a normal CDF with one sigma. College margins bunch at 3, 7 and 10, so
half a point through a key number is worth more than half a point elsewhere. SPEC.md says neither
backtest tested key numbers. An empirical cover-probability table (margin vs. line, from 2015–2025 games)
would give a better win chance per pick. It would also remove the fat-tails problem that led to dropping
moneylines, if those ever come back.

**Target the line move directly. — L · Med**
The v3 results show the edge only exists before the market moves (55% vs. the opener, 49% vs. the close).
The trust layer already fits on closing lines. A model whose target is the closing line itself
(close − open, predicted from the model's gap and game type) aims at what's actually being measured. The
per-game ledger (`build-ledger.mjs`) has what's needed to test it on 2026.

**Cheap schedule features: rest, byes, travel. — M · Low–Med**
Days since each team's last game, coming off a bye, and short weeks can all be computed from the games
files already cached (no API calls). Long-distance travel needs venue coordinates (one CFBD `venues` call).
They'd go in as blend columns under v2's "keep it only if walk-forward RMSE drops" rule.

**Retest SP+/FPI in 2027. — M · Med (snapshots now saved; see gap 1)**
Once a season of weekly snapshots exists, run the fair test SPEC.md planned for.

**Better QB signal. — L · Low**
The v3 QB flag catches about 28% of games and is worth about half a point. A sharper version (starter
confirmed out, by name) needs a source of injury and depth-chart news that CFBD doesn't have. Probably not
worth it without a cheap feed.

## Picks & tracking

**Per-game ledger — done 2026-10-12.**
Every odds snapshot is committed together with the model output from the same run, so nothing was being
lost. `node scripts/build-ledger.mjs` walks that history and writes `data/ledger-<season>.json`
(gitignored): for every FBS-vs-FBS game, the model line, trust and edge plus each book's line at each
snapshot, CFBD's opener and close, the result and any picks. It reproduces every recorded spread pick's
edge exactly. Weeks before the first snapshot (2026 weeks 1–6) have only CFBD's opener and close. Run it
locally; Actions checkouts are shallow. This also covers the old "store the line at every snapshot for
each pick" idea.

**Show the uncertainty on the record. — S · Med**
Add a 95% interval for win rate and line move, and a progress line toward the official bar (e.g.
"47 of 100 picks measured to the close, average move +0.6, 95% lower bound −0.2"), using the same
calculation as `statusNow()` in `record-picks.mjs`. At these sample sizes the interval is the
honest headline.

**Split ROI into model edge and line shopping. — S · Low**
Each pick is recorded at the best line, not the median. Record how much better the best line was than the
median, so the record shows how much profit came from shopping and how much from the model.

**Review the bad-data threshold after a few weeks. — S · Med**
`grade-picks` skips a book whose CFBD close is more than 4 points (moneylines: 10 points of implied chance)
from our last snapshot's median, treating it as bad data. The 4 is an assumption based on 2024–2025, where
about 2% of games had CFBD's books 4+ points apart. Each pick lists its skipped books (`close.skipped`).
After 3–4 graded weeks, check how often books are skipped and whether those games had real late news. Do it
before pick 100. In 2026 CFBD only carries DraftKings, so a skipped book means the pick gets no move at
all, not a move from fewer books.

**Shadow thresholds, labeled as diagnostics. — S · Low**
Log what picks would have been at 1.0 and 1.5 trusted points too, kept out of the record. Useful at season
end, but it invites picking the best threshold after the fact. Only worth it if it's pre-registered as
diagnostic-only.

## Pipeline & ops

**Tests with `node:test`. — M · High**
No dependencies needed (Node 22 has a test runner built in). Cover the costliest mistakes: sign
conventions in `model.js`, grading (win, loss, push, void after 5 days), the move to the close in
`grade-picks` (book matching, the bad-data skip, signs for home and away, spreads and moneylines),
`record-picks` locking (a later snapshot never moves or removes a pick, one pick per game per model), and
`build-data`'s fetch rules for closing lines and SP+/FPI (which weeks it fetches, never refetching a finished
one). Use fixtures and `NOW=`, plus a stubbed `fetch` for `build-data`. The 2026-10-12 changes were checked
this way by hand in throwaway copies; turning those checks into tests is most of the work. Run them in CI
next to the asset check.

**Guard the live model against accidental changes. — S · Med**
Rerunning a backtest silently changes the live model, because `build-data` reads `live` from the backtest
file. Store a hash of the `live` block on each pick. Have `record-picks` stop with an error when it
changes mid-season unless the model version is bumped.

**Make Actions failures visible. — S · Med**
- Odds API team names that don't match CFBD are only logged. The run still succeeds and the game silently
  gets no pick. Print `::warning::` for each one so it shows in the Actions summary, or fail when an
  FBS-vs-FBS game is unmatched.
- Warn when a week's picks are measured against the close but none (or few) get a `clvClose`. With only
  DraftKings in CFBD's 2026 data, a change on CFBD's side (DraftKings dropped or renamed) would stall the
  official rule without anyone noticing. Unmapped providers already print a `::warning::`.
- Save `x-requests-remaining` into `odds-2026.json` and warn under ~50. The 500 credits are shared with
  te-tracker.

**Season rollover runbook. — M · Med**
For 2027, `build-data` takes the season from `backtest-v3.json` → `live.season`, then writes
`seasons.json`. Moving to 2027 means either a new backtest or editing `live.season`, along with caching
2026's history (returning production, talent, portal) into `data/raw/`. `lines-2026.json` and
`passing-2026.json` will already be complete from the live season (so `fetch-history` will skip them), and
`ratings-history-2026.json` holds the SP+/FPI snapshots for the 2027 retest. Write the steps down in
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
