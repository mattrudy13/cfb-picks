# cfb-picks

College football spread and underdog moneyline picks from a team-rating model, with an honest track
record. A static site on GitHub Pages: https://mattrudy13.github.io/cfb-picks/

**Status:** the model missed its pre-registered backtest bar (see `SPEC.md` and the Backtest page), so
every pick is tracked as an **unofficial** record. The live test is whether betting Sunday night, before
the line moves, works.

- **Best Bets** (`index.html`): this week's picks and the unofficial record (win rate, ROI, line move).
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
| `scripts/backtest.mjs`, `scripts/backtest-v2.mjs` | The v1 and v2 backtests; v2 also writes the live model's settings (`data/backtest-v2.json` → `live`) |
| `scripts/build-data.mjs` | Fetches this season from CFBD and writes `data/<season>.json` |
| `scripts/fetch-odds.mjs` | The Odds API snapshot (US-licensed books only) → `data/odds-<season>.json` |
| `scripts/record-picks.mjs`, `scripts/grade-picks.mjs` | Maintain `data/picks-<season>.json` |
| `scripts/fetch-history.mjs` | One-time CFBD history into `data/raw/` (skips cached files) |

Secrets: `CFBD_API_KEY` (CollegeFootballData, free tier shared with h2h) and `ODDS_API_KEY` (shared with
te-tracker). Set with `gh secret set <NAME> -R mattrudy13/cfb-picks`.

## Running locally

```sh
node scripts/build-data.mjs --offline   # rebuild from data/raw/ (no API calls)
python3 -m http.server 8000             # then open http://localhost:8000
node scripts/backtest-v2.mjs            # rerun the backtest (~12 s)
```

After editing `common.js` or `style.css`, run `node scripts/stamp-assets.mjs` before committing.
Test offline odds with `node scripts/fetch-odds.mjs --fixture <file>` in a scratch copy of the repo,
never in `data/`.
