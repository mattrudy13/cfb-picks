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
- **Where the model loses to the market (training seasons, model vs closing-line RMSE):** Power 4 vs
  Group of 5 games 17.4 vs 14.8, weeks 0–3 17.1 vs 14.7. In G5 vs G5 and weeks 4–8 the gap is only ~0.4.
  So the weak spots are preseason priors and conference-vs-conference strength. The line moves toward the
  model only in Power 4 vs Power 4 games (18% of the gap) and late season (15%).

## Model v2 (decided 2026-10-10, written before running it)

v1 failed, so the model is being rethought. These rules are set before any v2 results are seen.

**Goal (decided): beat the opener and bet early.** The only edge v1 showed was getting ahead of the line
move, so v2 aims to predict where the line is going, and picks are meant to be bet Sunday night/Monday.
Picks are still judged against the opener.

**Changes to test (decided):**
1. **Per-play efficiency:** opponent-adjusted offense and defense from CFBD's per-game play-by-play
   stats (EPA per play, success rate), turned into a points rating. It joins the blend alongside Elo and the
   margin rating.
2. **Better preseason priors:** last season's rating adjusted for returning production, recruiting
   talent and (2021+) the transfer portal, plus a conference-strength prior so teams in a conference start
   near their conference's level. Targets the two worst gaps: weeks 0–3 and Power 4 vs G5.

Rejected for now: anchoring on the opening line, and situational spots (rest, travel, lookahead).

**Rolling test (decided).** Each test season uses only earlier seasons:

| Test season | Ratings fit on | Threshold and start week chosen on (openers) |
|---|---|---|
| 2022 | 2016–2021 | 2021 |
| 2023 | 2016–2022 | 2021–2022 |
| 2024 | 2016–2023 | 2021–2023 |
| 2025 | 2016–2024 | 2021–2024 |

**Amended 2026-10-10, before any v2 results:** CFBD has no opening lines before 2021 (2016–2020 have closing
lines only), so 2021 can't be a test season: its fold would have no earlier openers to choose a threshold
from. 2021 is used only to choose the 2022 fold's threshold and start week. Ratings still fit on 2016 on,
since that only needs game results.

Within each fold, everything is chosen on the fit seasons only: the constants, the blend weights, **which
of the two changes to keep** (a change stays only if it lowers fit-season RMSE), the edge threshold X and the
start week. The test season is graded once with those choices frozen. Results for all four versions
(v1, +efficiency, +priors, both) are reported for comparison, but **the go-live decision uses only the
version each fold picked on its own**. 2015 is warm-up for the ratings.

**Go-live bar for spreads (decided)**, across the four test seasons combined:
- ≥ 52.4% against the spread at the opener, and
- CLV > 0, and
- profitable at −110 in at least 3 of the 4 seasons, and
- ≥ 150 picks, and
- **the cautious version also shows CLV > 0.** It ignores the most recent week's games, in case some of
  CFBD's openers were posted before them. An edge that exists only when the model knows results the
  opener didn't is a fail.

**Moneylines (decided):** no backtest (CFBD has no opening moneylines). Underdog moneylines appear on the
game board and are tracked as an unofficial record from live prices.

### Model v2 results (2026-10-10)

`node scripts/backtest-v2.mjs` → `data/backtest-v2.json`. **Go-live bar: not met.**

| Test season | Version chosen | Threshold, start week | Picks | ATS at opener | ATS at close | ROI | CLV | Cautious CLV |
|---|---|---|---|---|---|---|---|---|
| 2022 | both | 1 pt, wk 7 | 306 | 49.7% | 49.3% | −5.2% | +0.12 | +0.03 |
| 2023 | both | 1 pt, wk 7 | 340 | 55.3% | 52.5% | +5.5% | +0.69 | +0.47 |
| 2024 | both | 4.5 pts, wk 4 | 111 | 48.2% | 42.7% | −8.0% | +1.63 | +0.75 |
| 2025 | both | 4 pts, wk 7 | 106 | 58.5% | 52.4% | +11.7% | +2.00 | +1.10 |
| **Total** | | | **863** | **52.8%** | **50.1%** | **+0.7%** | **+0.77** | **+0.45** |

Passes: ATS ≥ 52.4%, CLV > 0, ≥ 150 picks, cautious CLV > 0. **Fails: profitable in only 2 of 4 seasons.**

- **Still nothing beyond the closing line.** 50.1% ATS at the close, the same as v1.
- **Accuracy improved a little but still trails the market.** Walk-forward RMSE in 2022–2025 was 15.5–16.2,
  vs 15.1–15.7 for the opener. Efficiency helped every season (by ~0.07). Fitted priors helped 2018–2020 and
  2023 but hurt 2021, 2022, 2024 and 2025. Every fold kept both changes, because priors looked good on the
  older seasons.
- **The threshold choice was unstable.** With only one or two seasons of openers, the 2022 and 2023 folds
  chose a 1-point edge and week 7. That's why those seasons have ~300 picks each.
- **Not a basis for a decision:** with each fold's own threshold rule applied to every version, efficiency
  alone went 55.7% on 313 picks. That's one of four versions, picked after seeing the test seasons, so the
  spec rules don't let it count.

**After the backtest:** the rest of the 2026 season is tracked unofficially from a Sunday-night snapshot as
the final check. Adding that snapshot changes the decided schedule, so it waits for Rudy's go-ahead.

## Model v3 (decided 2026-10-11, written before running it)

v2 failed (profitable in 2 of 4 seasons). A breakdown of its 863 backtest picks showed why: its picks
expected to beat the opener by 4.2 points and beat it by 1.3, so most of each edge was the model's own
error. The misses clustered in G5-vs-G5 games (50.9%), in teams it stayed wrong about for weeks (Purdue
1–8, New Mexico 2–9, Syracuse 2–9), and in blowouts that look like starter changes it couldn't see.
v3 targets those two causes. These rules are set before any v3 results are seen.

**Changes (decided):**
1. **Quarterback changes.** CFBD's per-game passing stats (`games/players?category=passing`) give each
   passer's attempts. Before each game, a team is flagged when the passer who threw the most in its last
   game threw **under half of the team's pass attempts so far this season** (needs ≥ 2 earlier games).
   That catches a backup taking over, so the team's ratings were mostly built with someone else at QB. The
   blend gets one more column, home flag − away flag, with its weight fit like the others. It's kept in a
   fold only if it lowers walk-forward RMSE from 2018, the same rule v2 used for its changes.
2. **Trust that varies by game type.** The model's line is pulled toward the market by a factor fit on
   past seasons: adjusted margin = market + k × (model − market), where
   k = k0 + k1·(G5 vs G5) + k2·(Power 4 vs G5) + k3·(either team QB-flagged) + k4·(week ≤ 6),
   clamped to [0, 1]. The k's are an OLS fit of (margin − market) on (model − market) and its products
   with those flags, using **closing lines** from 2018 to the season before the test season. Power 4 is
   SEC, Big Ten, Big 12, ACC, Notre Dame, and the Pac-12 through 2023. Picks use the adjusted edge
   k × (model + opener). The same factor on every game would only act like a higher threshold, which v2
   already tested, so only the game-type terms can change which games get picked. This layer is always on.

**Test (decided):** the v2 rolling test unchanged: test seasons 2022–2025, rating settings from v2,
threshold and start week chosen on 2021…T−1 openers. The threshold grid gains 0.5 (adjusted edges are
smaller). The cautious version ignores the latest week for the QB flag too. v2 is rerun alongside for
comparison.

**Go-live (decided):** the same five checks. Because this is the third model tested on the same seasons,
a pass makes picks **provisional**, not official. They become official only after the live 2026 record
shows CLV > 0 over ≥ 100 spread picks. If v3 fails, the site stays on v2 and the result is reported.

**Data:** passing stats 2016–2026 (≈ 160 CFBD calls, once) and closing lines 2016–2020 (5 calls).
Live: one passing call per completed week.

### Model v3 results (2026-10-11)

`node scripts/backtest-v3.mjs` → `data/backtest-v3.json`. **Go-live bar: met, so picks are provisional.**

| Test season | QB flag | Trust in a Power 4 game | Threshold, start week | Picks | ATS at opener | ATS at close | ROI | CLV | Cautious CLV |
|---|---|---|---|---|---|---|---|---|---|
| 2022 | kept | 0% | 0.5 pts, wk 4 | 50 | 53.1% | 51.0% | +1.3% | +0.10 | −0.20 |
| 2023 | kept | 4% | 0.5 pts, wk 4 | 29 | 53.6% | 46.4% | +2.3% | +1.93 | +1.24 |
| 2024 | dropped | 12% | 1.5 pts, wk 0 | 0 | – | – | – | – | – |
| 2025 | kept | 19% | 0.5 pts, wk 0 | 93 | 57.0% | 48.9% | +8.8% | +1.94 | +1.34 |
| **Total** | | | | **172** | **55.3%** | **49.1%** | **+5.6%** | **+1.40** | **+0.79** |

For comparison (not the decision): v2 rerun 863 picks, 52.8%, 2 of 4 seasons; v2 + QB flag alone 606
picks, 54.4%, 2 of 4; v2 + trust alone 176 picks, 55.7%, 3 of 4 (passes).

**Why the pass is weak:**
- **Still nothing beyond the closing line:** 49.1% at the close. Any edge is still getting ahead of line moves.
- **The trust layer did the work, and its fitted values swing a lot.** Trust in a Power 4 game went 0%, 4%,
  12%, 19% across the folds. Fit against closing lines, the model's gap from the market is worth close to
  nothing, so picks are the few games where a small share of a big gap clears the threshold.
- **The QB flag barely matters:** it changes walk-forward RMSE by 0.00–0.01 and is worth about half a point
  in the blend. It flags about 28% of games, so it's a broad signal, not a targeted one.
- **"3 of 4 profitable" includes a season with no picks** (2024 counts as not profitable) and a 2022 profit
  of +1.3% on 50 picks, about one game.
- **Small sample:** 172 picks at 55.3% has a 95% interval of roughly 48–63%.

**Live model:** `bothQb`, trust k = [0.170, −0.060, −0.088, −0.104, −0.177] (Power 4 17%, G5 vs G5 11%,
Power 4 vs G5 8%, QB change 7%, week ≤ 6 0%, terms add), threshold 0.5 trusted points, from week 0.
Underdog moneylines are **no longer recorded** (decided 2026-10-11): with trusted margins, the ones that still
cleared $10 of expected profit came from the normal curve's fat tails on long underdogs, not the model.
Already-recorded moneyline picks are still graded.

## Picks

- **Spreads (decided):** every FBS-vs-FBS game where the **trusted edge** (the game's trust factor × the model
  margin's gap from the **median** US line; trust = 1 before v3) is at least **X points** (live v3: X = 0.5,
  from week 0; v2 was X = 4 from week 7), recorded at the best line for
  that side. Key numbers (3, 7) aren't weighted: neither backtest tested it.
- **Moneylines (decided):** underdogs only, expected profit of at least $10 per $100 at the best price, no
  longer than +600. (Changed 2026-10-11 from > 0, which picked 27 of 59 week 7 games, most at $0–8. The
  week 7 picks recorded before the change stay as they were, since picks lock when posted.)
- **(assumed)** If the same game has a spread pick and a dog moneyline pick on the same team, both are
  shown, and the card notes they're the same side.
- **Locking and CLV (changed 2026-10-10 for the bet-early goal):** a pick locks the moment it's first
  recorded, at that snapshot's line and price, because that's when it would be bet. Later snapshots never
  move its line or remove it; they only update `closeMarket` (the market median). One spread and one
  moneyline pick per game at most, so a later snapshot can't take the other side. This replaces
  te-tracker's rule (replace unstarted picks, grade at the newest price).
- **CLV is measured to the real close (decided 2026-10-12, before any pick was graded):** the last snapshot
  isn't the close. A Thursday game's last snapshot is Tuesday morning, and a Saturday night game's is
  Saturday 9 AM, while the backtest's CLV used CFBD's closing line. So:
  - When a pick posts, every US book's line is saved on it (`books`). The week 7 picks got theirs from the
    snapshot commits in git history.
  - `build-data` fetches CFBD's lines for each finished week (`data/raw/lines-<season>.json`), refetching
    until a fetch lands a day after the week's last kickoff. That's about 3 calls a week.
  - `grade-picks` sets `clvClose` from the books CFBD reports that also priced the game at posting: the
    median line at posting minus the median at the close, over those books only, so a different set of
    books can't pass for a line move. A pick with no book in common gets no `clvClose` and doesn't count.
  - **(assumed)** A book whose CFBD close is more than 4 points (moneylines: 10 points of implied chance)
    from the last snapshot's median is treated as bad data and skipped. In 2024–2025, about 2% of games
    had CFBD's books 4+ points apart.
  - The provisional → official rule (Model v3) counts `clvClose` only. The pages show the move "so far"
    (to the latest snapshot) until the close is in, and the record counts only moves to the close.
- **All picks are unofficial** (`shadow: true`) while `data/backtest-v2.json` says the go-live bar failed.
- **Grading:** spreads win, lose or push against the recorded line. Moneylines win or lose. Profit is
  per $100 at the recorded price. Canceled games are void.
- Each pick shows a one-line reason, e.g. "Model −10.5 vs book −6.5; Elo and our rating agree."

## Schedule (GitHub Actions)

| Workflow | When (ET) | Does |
|---|---|---|
| `update-data.yml` | every 3 h Sat noon–Sun 3 AM, then Sun, Mon and Wed 6 AM | CFBD games and scores → ratings → grade picks |
| `snapshot-odds.yml` | **Sun 9 PM (added 2026-10-10), Tue 10 AM, Fri 10 AM, Sat 9 AM** | build → Odds API → record picks |
| `check-assets.yml` | on push | asset stamp check, copied from te-tracker |

Times are UTC in cron, so they shift an hour when daylight saving ends. GitHub can start scheduled runs
hours late (te-tracker's TNF run did), so Saturday's snapshot is at 9 AM rather than right before noon
kickoffs. The update schedule is **(assumed)**.

**Budgets:** CFBD ~2 calls per run, ~16 runs a week → ~70 a month, plus ~13 for closing lines, ~9 for
SP+/FPI and ~4 for passing stats → ~95 a month (plus h2h's traffic, same pool).
The Odds API: 4 snapshots × 2 credits → ~35 a month, on top of te-tracker's ~375 (500 free).

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
