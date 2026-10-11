# cfb-picks: spec

College football spread and moneyline picks for every FBS game, from a blended team-rating model.
It's a static site on GitHub Pages (`mattrudy13.github.io/cfb-picks`) built the same way as te-tracker:
GitHub Actions write JSON into `data/`, the pages read it, and there's no server or build step.

The model has to pass a backtest on past seasons before any picks go public. If it fails, the site
still ships with model lines, ratings and the backtest, but no official picks.

Written 2026-10-10 from an interview. Decisions are marked **(decided)**. Anything I filled in
myself is marked **(assumed)** and listed again under "Assumptions to confirm" at the end.

## Scope

- **Markets (decided):** spreads and moneylines. Totals, team totals and first-half lines are out for now.
- **Games (decided):** every FBS game in the regular season, about 50–60 a week. FCS opponents only appear
  as the other side of an FBS game **(assumed:** no picks on FBS-vs-FCS games, because FCS ratings are thin
  and those lines are often off the board**)**. Bowls and the playoff are out for v0.1.
- **Books (assumed):** US-licensed books only, same rule as te-tracker, so every price can be bet. The
  offshore list is reused from te-tracker's `OFFSHORE_BOOKS`.

## Data sources

| Source | Used for | Key | Cost |
|---|---|---|---|
| CollegeFootballData (CFBD) | games, scores, past lines (open and close), SP+/FPI (display only), team logos and colors | `CFBD_API_KEY` repo secret (the same key h2h's Worker uses) | Free tier: 1,000 calls a month, shared with h2h |
| The Odds API | live spreads and moneylines (`americanfootball_ncaaf`, markets `spreads,h2h`, region `us`) | `ODDS_API_KEY` repo secret, shared with te-tracker | ~2 credits per snapshot for all games (featured markets are billed per market, not per game) |

**Odds API budget:** te-tracker uses ~375 of the 500 monthly credits. Three snapshots a week here add
~26 a month, which leaves ~100 for manual runs across both projects. te-tracker's README should be
updated to say the quota is shared.

**The key never reaches the browser.** Unlike h2h, the pages don't call CFBD. Actions fetch the data
and commit JSON, so no Worker is needed.

### Look-ahead bias (decided)

CFBD's SP+ and FPI endpoints appear to return **end-of-season** ratings, not each team's rating going
into each week. A backtest using them would already know how the season ended. So:

- The backtest uses only point-in-time inputs: **our own Elo** and **our own weekly margin rating**
  (below), both rebuilt from games already played.
- SP+ and FPI appear on the Team ratings page for context, but stay out of the picks unless a fair test
  shows they help.
- **(assumed)** From now on, `build-data` stores a weekly SP+/FPI snapshot so a fair test of them exists
  next season.
### Data check results (2026-10-10)

- **SP+ and FPI are end-of-season only.** `ratings/sp` and `ratings/fpi` accept `week=` but return
  identical numbers to the season call. They stay out of the model.
- **CFBD's stored pregame Elo can't be fully trusted as point-in-time.** In 11% of games a team's pregame
  Elo doesn't equal its previous postgame Elo. Most of those are next to FCS games, but ~50 FBS-vs-FBS games
  a season also differ, by up to 342 points (2023). **Decision: compute our own Elo** from game results in
  date order. It's a few lines of code and guaranteed to see only past games.
- **Lines, FBS vs FBS regular season (~735–760 games a year):**

  | Season | Closing spread | Opening spread | Opener from a US book | Moneyline |
  |---|---|---|---|---|
  | 2021 | 100% | 100% | 0% (Bovada only) | 93% |
  | 2022 | 100% | 99% | 0% (Bovada only) | 92% |
  | 2023 | 100% | 100% | 94% | 97% |
  | 2024 | 100% | 100% | 100% | 99% |
  | 2025 | 100% | 100% | 100% | 97% |

  2021–2022 openers come only from Bovada (offshore). That's fine for training. The 2024–2025 check seasons
  have DraftKings and ESPN Bet openers, so the go-live test uses US-book lines. The backtest closing line is
  the median across US providers, falling back to `consensus`, then Bovada.
- **CFBD quota:** free tier, 1,000 calls a month, **shared with h2h** (football and basketball). 917 were
  left on 2026-10-10. The backtest needs 10 calls (games + lines per season, `seasonType=regular`, no week),
  so the raw season files are cached in `data/raw/` and never refetched. Live workflows must also cache:
  a full-season games call plus a lines call per run, a few runs a week, stays well under 100 a month.

## The model

1. **Elo:** our own, computed from FBS game results in date order (CFBD's stored Elo failed the
   point-in-time check below). K-factor, margin-of-victory multiplier and the between-season pull to the mean
   are fit on the training seasons.
2. **Our own rating:** opponent-adjusted scoring margin. Each week, fit `margin = rating_home − rating_away
   + home_field` over this season's FBS games so far (ridge regression, so early weeks stay stable).
   Margins are capped (**assumed** 28 points) so blowouts don't dominate. The preseason prior is last
   season's final rating pulled partway back to average. It fades as games come in, at a rate the
   backtest sets.
3. **Blend:** the model spread is a weighted mix of the two, plus home field (0 at neutral sites).
   The weights, home-field size and prior fade are fit on the training seasons.
4. **Win probability:** from the model spread through a normal distribution, with the spread of
   outcomes (σ, likely about 14–17 points) fit on the training seasons. This drives the moneylines.

Constants live at the top of `model.js`, as in te-tracker. `model.js` is shared by the pages and the
Node scripts, so the Action records exactly what the page shows.

## Backtest

- **Seasons:** 2021–2025. **(assumed)** Fit everything (weights, σ, home field, edge threshold X) on
  **2021–2023**, then check it **once** on **2024–2025**. Choosing X with the test seasons included would
  make the results look better than they really are. The go-live decision uses only 2024–2025.
- **Lines:** CFBD's past lines, opener and closer. A backtest pick is "bet" at the **opener**, graded
  against the opener, and its CLV is how far the line moved toward the pick by the close.
- **Spread price (assumed):** −110 when CFBD has no price, so break-even is 52.4%. Pushes are void.
- **Moneylines:** priced from CFBD moneylines where they exist. Games without one are left out of the
  moneyline backtest.
- **Results by week:** ATS %, ROI, CLV and count, by season, by edge size and by week of season. The
  first week picks start is the first one where weeks before it lose money (decided: "let the backtest
  decide").
- **Output:** `data/backtest.json`, built locally once with `node scripts/backtest.mjs`. It's processed one
  season at a time to keep memory low.

### Go-live bar (decided)

Spread picks go live only if, on the 2024–2025 check seasons, picks at the chosen edge threshold:

- **beat the close**: average CLV > 0, **and**
- **win ≥ 52.4% ATS**, **and**
- **(assumed)** number at least ~150 picks, so the result isn't a small-sample fluke.

Moneylines have their own bar: ROI > 0 and CLV > 0 over the same seasons.

**If it fails (decided):** ship the board, ratings, team pages and backtest anyway. Best Bets says "No
proven edge yet". Picks are still recorded and graded as a **shadow record** that never counts as
official, so the model can earn its way in.

### Backtest results (2026-10-10)

`node scripts/backtest.mjs` → `data/backtest.json`. Fitted constants are in `model.js`. Picks need a 4.5-point
edge against the opener and start at week 4 (weeks 0–3 lost badly in training).

- **Go-live bar: not met.** On 2024–2025: 266 picks, **52.1% against the spread** at the opener (needs
  52.4%), CLV +1.45 points, ROI −0.6%. Underdog moneylines also fail (no opening prices, so no CLV).
- **The model knows nothing the closing line doesn't.** Graded at the close, the same picks win 47.9% in
  2024–2025 and ~50% across 2021–2025. Its margin error (RMSE ~16.0) is worse than the opener (15.4) and
  the close (15.3).
- **CLV is real, and it's the model's only edge.** A point of line is worth about 2.5% cover chance here
  (σ ≈ 16), so +1.1 points of CLV predicts ~52.7% at the opener if the close is fair. Across 2021–2025 the
  picks went 54.1% (train 55.8%, check 52.1%). So CLV can stay in the go-live bar.
- **About half the CLV comes from the previous week's results.** Ignoring the latest week cuts CLV from
  1.09 to 0.63 points. CFBD's openers have no timestamps, so some may predate those games (look-ahead
  lines). A live Tuesday snapshot comes after the market has seen them, so **the live edge is probably
  smaller than the backtest shows.**
- **Openers look genuine otherwise:** they move 1–2.3 points on average by the close, and DraftKings and
  ESPN Bet open more than a point apart in 27–42% of games, which copied or stale data wouldn't do.

## Picks

- **Spreads (decided):** every game where the model spread differs from the best available line by at
  least **X points**, with X set by the backtest. Some weeks have 2 picks, some have 12. **(assumed)** The
  edge counts half-points across 3 and 7 (key numbers) as worth more. This is tested in the backtest, not
  assumed to help.
- **Moneylines (decided):** underdogs only, expected profit > 0 at the best price, no longer than +600.
- **(assumed)** If the same game has a spread pick and a dog moneyline pick on the same team, both are
  shown, and the card notes they're the same side.
- **Locking and CLV:** copied from te-tracker. A pick locks at kickoff, a later snapshot replaces an
  unstarted pick but keeps its first price as `open*`, and the last snapshot before kickoff counts as the close.
- **Grading:** spreads win, lose or push against the recorded line. Moneylines win or lose. Profit is
  per $100 at the recorded price. Canceled games are void.
- Each pick shows a one-line reason, e.g. "Model −10.5 vs book −6.5; Elo and our rating agree."

## Schedule (GitHub Actions)

| Workflow | When (ET) | Does |
|---|---|---|
| `update-data.yml` | Sun 6 AM, Mon 6 AM, Wed 6 AM, plus every 3 h Sat noon–Sun 3 AM | CFBD games and scores → ratings → grade picks |
| `snapshot-odds.yml` | **Tue 10 AM, Fri 10 AM, Sat 9 AM (decided)** | build → Odds API → record picks |
| `check-assets.yml` | on push | asset stamp check, copied from te-tracker |

Times are UTC in cron, so they shift an hour when daylight saving ends. GitHub can start scheduled runs
hours late (te-tracker's TNF run did), so Saturday's snapshot is at 9 AM rather than right before noon
kickoffs. The update schedule is **(assumed)**.

## Pages

**Design (decided):** a new look, not a copy of te-tracker. I'll make 2–3 mockups of the Best Bets
page and game board to choose from before building pages. Team logos and colors come from CFBD, as in h2h.
Rules carried over from te-tracker: works at 375px with no sideways scroll, light and dark mode,
tooltips only for definitions, jargon explained in visible page notes, pronoun-neutral copy.

1. **Best Bets** (`index.html`): this week's spread and moneyline picks with best price and book, model
   line, edge, win %, EV per $100 and the reason. Below that is the **track record** (W–L–P, ATS %, units,
   ROI, CLV) and the shadow record, kept separate. Before the go-live bar is met, it shows "No proven edge
   yet" and links to Backtest.
2. **Game board** (`board.html`): every FBS game this week with kickoff, network, model spread vs best
   line, edge, both teams' win %, and dog moneyline value. Filter by conference. Finished games show the
   result against the line.
3. **Team ratings** (`ratings.html`): all FBS teams ranked by the blended rating, with our rating, Elo,
   SP+ and FPI next to it and the change over the last 3 weeks.
4. **Team page** (`team.html?id=`): the season schedule with the model line, actual close and cover
   result for each game, plus the rating over time.
5. **Backtest** (`backtest.html`): the results tables from `backtest.json`, with the training/check-season
   split stated plainly and whether the go-live bar was met.

Filters live in the URL, as in te-tracker.

## Repo layout

Same structure as te-tracker:

```
index.html board.html ratings.html team.html backtest.html
model.js      data + model, no DOM; shared by pages and scripts
common.js     DOM helpers
style.css
scripts/      build-data, fetch-odds, record-picks, grade-picks, backtest, stamp-assets (Node 22, no deps)
data/         <season>.json, odds-<season>.json, picks-<season>.json, backtest.json, seasons.json
```

`picks-<season>.json` uses te-tracker's shape (`weeks.N.picks[]` with `cat`, `price`, `book`, `modelProb`,
`marketProb`, `ev`, `why`, `open*`, `shadow?`, `result?`, `profit?`) plus `line` and `modelLine` for spreads.

## Build order

1. **Data check:** done 2026-10-10 (results above).
2. **Backtest:** `model.js` ratings and blend, plus `scripts/backtest.mjs`. Fit on 2021–2023 and check
   on 2024–2025. **Stop and review the results with Rudy** before building anything else.
3. **Live data:** `build-data`, `fetch-odds`, `record-picks`, `grade-picks` and the workflows.
4. **Design mockups**, then a pick.
5. **Pages:** Board, Ratings, Team, Backtest, then Best Bets.
6. **Ship** as v0.1. It's mid-October, so the live track record would start around week 9 or 10.

## Assumptions to confirm

- No picks on FBS-vs-FCS games.
- US-licensed books only, using te-tracker's offshore list.
- Weekly SP+/FPI snapshots stored from now on for next year's test.
- Fit on 2021–2023, check once on 2024–2025; go-live bar judged on 2024–2025 with at least ~150 picks.
- −110 assumed when past spread prices are missing.
- Margins capped at 28 in our rating.
- Key numbers (3, 7) weighted in the edge only if the backtest supports it.
- Spread and moneyline picks on the same side are both shown.
- The `update-data` schedule above.
