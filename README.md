# cfb-picks

College football spread picks from a team-rating model, with an honest track record. A static site on GitHub Pages: https://mattrudy13.github.io/cfb-picks/

**Status:** model v3 passed its pre-registered backtest bar narrowly (55.3% at the opener on 172
picks, 2022–2025, but 49.1% at the close; see `SPEC.md` and the Backtest page), so its spread picks are
**provisional**. They become official only if the live 2026 record shows lines moving toward them over
100+ picks. Earlier models (v1, v2) missed the bar; v2's week 7 picks are kept as a separate record.
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

Secrets: `CFBD_API_KEY` (CollegeFootballData, free tier shared with h2h) and `ODDS_API_KEY` (shared with
te-tracker). Set with `gh secret set <NAME> -R mattrudy13/cfb-picks`.

## Running locally

```sh
node scripts/build-data.mjs --offline   # rebuild from data/raw/ (no API calls)
python3 -m http.server 8000             # then open http://localhost:8000
node scripts/backtest-v3.mjs            # rerun the live model's backtest (changes the live model's settings)
```

After editing `common.js` or `style.css`, run `node scripts/stamp-assets.mjs` before committing.
Test offline odds with `node scripts/fetch-odds.mjs --fixture <file>` in a scratch copy of the repo,
never in `data/`.
