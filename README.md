# College football forecasting model

A model that predicts college football point spreads and tests them against sportsbook lines, with an
honest track record.

**Site:** https://mattrudy13.github.io/cfb-picks/

## At a glance

- **What it does:** rates every FBS team from game results and play-by-play efficiency (Elo, an
  opponent-adjusted margin, EPA and success rate), turns the ratings into a predicted spread for each
  game, and compares it with the betting market. Picks are saved before kickoff and graded automatically.
- **How it was tested:** each version's pass/fail bar was written down before its backtest ran
  ([SPEC.md](SPEC.md)), and each backtest season was predicted only from earlier seasons.
  - v1: 52.1% against the opening line on 266 picks (the bar is 52.4%). Missed.
  - v2: 52.8% on 863 picks, but profitable in only 2 of 4 seasons (the bar is 3). Missed.
  - v3: 55.3% on 172 picks over 2022–2025, profitable in 3 of 4 seasons. Passed, narrowly. Against the
    closing line it was 49.1%, so its live picks start as provisional.
- **Live record (as of Oct 21, 2026):** v3 is 6–10 on its first 16 picks (week 7), with 15 week 8 picks
  still to play. Picks become official only if, over 100+ live picks, lines move toward them by the
  close by more than luck would explain.
- **Built with:** JavaScript (Node 22), GitHub Actions on a schedule, GitHub Pages, and the
  CollegeFootballData and The Odds API data services. No server and no dependencies.

## Details

**Status:** model v3 passed its pre-registered backtest bar narrowly (55.3% at the opener on 172
picks, 2022–2025, but 49.1% at the close; see `SPEC.md` and the Backtest page), so its spread picks are
**provisional**. They become official only if, over 100+ live picks, lines move toward them by the close
by more than luck would explain (95% confidence). Earlier models (v1, v2) missed the bar; v2's week 7 picks are kept as a separate record.
Underdog moneylines were tracked through October 11, 2026, then stopped.

- **Best Bets** (`index.html`): this week's picks and the record (win rate, ROI, line move).
- **Board** (`board.html`): every FBS game with the model's line and win chance next to the market's.
- **Ratings** (`ratings.html`): power ratings for every FBS team, plus the Elo, scoring, EPA and success-rate
  ratings behind them; SP+ and FPI for comparison.
- **Team** (`team.html?team=<school>`): a team's schedule, model and market lines, results and rating over time.
- **Backtest** (`backtest.html`): how both models did on 2022–2025 and the go-live checklist.

## How it works

No server and no build step: GitHub Actions write JSON into `data/`, and Pages serves the HTML plus that JSON.

```
update-data.yml    Sat noon–Sun 3 AM every 3 h, Sun/Mon/Wed 6 AM ET   build-data → grade-picks
snapshot-odds.yml  Sun 9 PM, Tue + Fri 10 AM, Sat 9 AM ET             build-data → fetch-odds → record-picks
check-assets.yml   on push                                           stamp-assets --check
```

| File | What it is |
|---|---|
| `model.js` | Ratings (Elo, opponent-adjusted margin, EPA and success rate), fitted preseason priors, blend. Shared by the scripts |
| `common.js`, `style.css` | Browser helpers and styles for every page |
| `scripts/backtest.mjs`, `scripts/backtest-v2.mjs`, `scripts/backtest-v3.mjs` | The v1, v2 and v3 backtests. v2 and v3 also write their model's settings (`data/backtest-v*.json` → `live`); `build-data` runs v3's if it passed its bar, else v2's |
| `scripts/build-data.mjs` | Fetches this season from CFBD and writes `data/<season>.json`; also caches closing lines and weekly SP+/FPI snapshots in `data/raw/` |
| `scripts/fetch-odds.mjs` | The Odds API snapshot (US-licensed books only) → `data/odds-<season>.json` |
| `scripts/record-picks.mjs`, `scripts/grade-picks.mjs` | Maintain `data/picks-<season>.json`; grading also measures each pick's line move to CFBD's closing line |
| `scripts/fetch-history.mjs` | One-time CFBD history into `data/raw/` (skips cached files) |
| `scripts/build-ledger.mjs` | Research: every FBS game's model and book lines at each snapshot (from git history), CFBD open/close and result → `data/ledger-<season>.json` (gitignored) |

Secrets: `CFBD_API_KEY` (CollegeFootballData, free tier shared with h2h) and `ODDS_API_KEY` (this project's own key;
te-tracker has a separate one). Set with `gh secret set <NAME> -R mattrudy13/cfb-picks`.

## Running locally

```sh
node scripts/build-data.mjs --offline   # rebuild from data/raw/ (no API calls)
python3 -m http.server 8000             # then open http://localhost:8000
node scripts/backtest-v3.mjs            # rerun the live model's backtest (changes the live model's settings)
```

After editing `common.js` or `style.css`, run `node scripts/stamp-assets.mjs` before committing.
Test offline odds with `node scripts/fetch-odds.mjs --fixture <file>` in a scratch copy of the repo,
never in `data/`.
