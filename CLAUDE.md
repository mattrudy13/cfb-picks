# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

College football spread picks from a team-rating model, published as a static GitHub Pages site
(https://mattrudy13.github.io/cfb-picks/). No server, no build step, no package.json, no dependencies:
plain HTML pages + `common.js`/`style.css` in the browser, and Node 22 ES-module scripts in `scripts/`.
GitHub Actions run the scripts and commit JSON into `data/`; the pages only read that JSON.

`SPEC.md` is the source of truth for every model and pick rule, with each decision dated and marked
**(decided)** or **(assumed)**. Read the relevant section before changing model or pick logic, and
record new decisions there.

## Commands

```sh
node scripts/build-data.mjs --offline   # rebuild data/<season>.json from data/raw/ (no API calls)
python3 -m http.server 8000             # serve the site at http://localhost:8000
node scripts/backtest-v3.mjs            # rerun the v3 backtest → data/backtest-v3.json
node scripts/backtest-v2.mjs            # v2 backtest (~12 s) → data/backtest-v2.json
node scripts/stamp-assets.mjs           # required after editing common.js or style.css
node scripts/stamp-assets.mjs --check   # what CI runs on push
NOW=<iso> node scripts/record-picks.mjs # pretend it's another time (also works for grade-picks)
node scripts/build-ledger.mjs           # per-game research ledger from git history (local only, gitignored)
```

There is no test suite or linter. Verify changes by running the scripts and checking the JSON diff,
then the pages in a browser.

- Live runs need `CFBD_API_KEY` / `ODDS_API_KEY`. Both are free tiers and CFBD's quota is **shared with h2h**, so
  avoid unnecessary live calls; prefer `--offline`. The Odds API key is this project's own (te-tracker has
  a separate key and quota, checked 2026-10-16).
- Test odds offline with `node scripts/fetch-odds.mjs --fixture <file>` in a scratch copy of the repo,
  never against the real `data/`.
- `scripts/fetch-history.mjs` is a one-time cache fill into `data/raw/`; it skips files already present.
  Raw season files are never refetched.

## Architecture

**Pipeline (GitHub Actions, scheduled Aug–Dec, cron in UTC):**
- `update-data.yml`: `build-data` → `grade-picks`, commits `data/` only if something other than the
  `updated` timestamp changed.
- `snapshot-odds.yml`: `build-data` → `fetch-odds` → `record-picks`. Sunday 9 PM ET is the "bet early" snapshot.
- Both share the `update-data` concurrency group and commit as `github-actions[bot]` with
  `data: ...` messages, so expect bot commits on `main`; pull before pushing.
- `check-assets.yml`: fails if `common.js`/`style.css` changed without restamping the `?v=` hashes in the HTML.

**Model versions and how the live model is chosen.** Each `scripts/backtest*.mjs` writes
`data/backtest*.json`, including a `live` block (inputs, blend coefficients, sigma, threshold, start week,
and for v3 the trust coefficients) and a `goLive` result. `build-data.mjs` picks v3 if
`backtest-v3.json` → `goLive.pass`, else v2, and reuses v2's rating `settings`. So the backtest output
files are live configuration: rerunning a backtest changes the live model. `common.js` likewise shows
the backtest matching `data.model.version`.

**`model.js`** holds all rating/model math (Elo, ridge opponent-adjusted margin, EPA/success rate,
fitted priors, blend, QB-change flag, v3 trust factor). It's CommonJS loaded into the ES-module scripts
via `createRequire`. The HTML pages don't load it; they read precomputed fields from
`data/<season>.json`. Any change here changes recorded picks.

**Sign conventions (from `model.js`):** `margin` = home − away points; `spread` is the home team's line
(−7 = home favored by 7, same as CFBD). Home covers when `margin + spread > 0`. Model margin M implies
model spread −M.

**Picks (`data/picks-<season>.json`, `weeks.N.picks[]`):**
- A pick **locks when first recorded**, at that snapshot's line and price. Later snapshots only update
  `closeMarket` (the "so far" line move); they never move or remove a pick. At most one spread and one moneyline pick
  per game per model. Graded picks are never regraded. Don't rewrite past picks; fixes to old picks
  have been done as explicit, separately committed changes.
- Each pick records its `model`; picks without one are v2. Records are kept separate per model.
- CLV that counts is `clvClose`, set by `grade-picks` from CFBD's closing lines (`data/raw/lines-<season>.json`),
  compared book by book against the `books` saved on the pick at posting. See SPEC.md, "Picks".
- Status: v3 picks are "provisional" until the live record shows `clvClose` > 0 over ≥ 100 spread picks.
- Moneyline recording is off (`RECORD_MONEYLINES = false` in `record-picks.mjs`, since 2026-10-11);
  already-recorded moneylines are still graded.
- Only US-licensed books count; FBS-vs-FBS regular-season games only.

**Backtest discipline.** No look-ahead: CFBD SP+/FPI are end-of-season only (display-only, never model
inputs), and the project computes its own Elo rather than trusting CFBD's. Each model's rules were
pre-registered in SPEC.md before it was run, and thresholds/start weeks are chosen only on seasons
before each test season. Keep new model work to that pattern.

**Pages** (`index`, `board`, `ratings`, `team`, `backtest`.html): each loads `common.js` plus an inline
script. Filters and sort state live in the URL. Design rules from SPEC.md: works at 375px with no sideways
scroll, light and dark mode, tooltips only for definitions, jargon explained in visible page notes.

`data/seasons.json` → `current` sets which season the scripts and pages use.
