// Rebuilds a per-game ledger for the season from git history: for every FBS-vs-FBS game, what the model and
// each sportsbook said at every odds snapshot before kickoff, CFBD's opener and close, the result, and any
// picks. For research: checking the trust factor, the threshold or a v4 idea on every game, not just picks.
//
//   node scripts/build-ledger.mjs    # writes data/ledger-<season>.json (gitignored; rebuild any time)
//
// Every odds snapshot is committed together with the <season>.json that build-data wrote in the same run,
// so each snapshot's model line is the one the picks saw. That needs the full history, so run this locally,
// not in Actions (their checkout is shallow). Games before the first snapshot (2026 weeks 1–6) have no
// snapshots, only CFBD's opener and close. Commits are read one at a time to keep memory low.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../model.js");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 1 << 28 }).toString();
const readData = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));

if (git("rev-parse", "--is-shallow-repository").trim() === "true") throw new Error("Needs full git history: git fetch --unshallow");

const { current: season } = readData("seasons.json");
const data = readData(`${season}.json`);
const closes = new Map(readData(`raw/lines-${season}.json`).map((r) => [r.id, r.lines]));
const picks = Object.values(readData(`picks-${season}.json`).weeks).flatMap((w) => w.picks);

// ---- Snapshots, oldest first ----

const snapshots = new Map(); // game id → [snapshot]
const seen = new Set();
const commits = git("log", "--reverse", "--format=%H", "--", `data/odds-${season}.json`).split("\n").filter(Boolean);
for (const sha of commits) {
  const odds = JSON.parse(git("show", `${sha}:data/odds-${season}.json`));
  if (seen.has(odds.takenAt)) continue; // a commit that touched the file without a new snapshot
  seen.add(odds.takenAt);
  let model = null;
  try { model = JSON.parse(git("show", `${sha}:data/${season}.json`)); } catch {}
  const modelGames = new Map((model?.games ?? []).map((g) => [g.id, g]));
  for (const [id, o] of Object.entries(odds.games)) {
    // Games that had started keep their earlier snapshot in the file; only pregame lines are new.
    if (Date.parse(o.commence) <= Date.parse(odds.takenAt)) continue;
    const g = modelGames.get(Number(id));
    const snap = {
      at: odds.takenAt,
      model: g ? { version: model.model.version ?? "v2", margin: g.modelMargin, trust: g.trust ?? 1, homeQb: g.homeQb, awayQb: g.awayQb } : null,
      median: o.spread?.median ?? null,
      mlMedian: o.ml ? { home: o.ml.medianHome, away: o.ml.medianAway } : null,
      books: o.byBook,
    };
    // The edge as the picks define it: trust × (model margin + median home line), positive = home.
    if (snap.model && snap.median != null) {
      snap.rawEdge = snap.model.margin + snap.median;
      snap.edge = snap.model.trust * snap.rawEdge;
    }
    (snapshots.get(Number(id)) ?? snapshots.set(Number(id), []).get(Number(id))).push(snap);
  }
}

// ---- One row per FBS-vs-FBS game ----

const dk = (lines, field) => lines?.find((l) => l.provider === "DraftKings")?.[field] ?? null;
const rows = data.games
  .filter((g) => g.homeFbs && g.awayFbs)
  .map((g) => {
    const lines = closes.get(g.id);
    return {
      id: g.id, week: g.week, start: g.start, home: g.home, away: g.away,
      homeConference: data.teams[g.home]?.conference ?? null, awayConference: data.teams[g.away]?.conference ?? null,
      neutral: g.neutral, completed: g.completed, homePoints: g.homePoints, awayPoints: g.awayPoints,
      // The model's pregame line as the current code and settings rebuild it (it only sees earlier games).
      // For what the live model actually said before a game, use the snapshots.
      rebuilt: { margin: g.modelMargin, trust: g.trust ?? 1, homeQb: g.homeQb, awayQb: g.awayQb },
      // CFBD's lines, home perspective: the backtest's rule (median of US books, then fallbacks), and
      // DraftKings alone, the one US book CFBD carries in 2026.
      cfbd: lines ? {
        open: M.lineValue(lines, "spreadOpen"), close: M.lineValue(lines, "spread"),
        dkOpen: dk(lines, "spreadOpen"), dkClose: dk(lines, "spread"),
      } : null,
      snapshots: snapshots.get(g.id) ?? [],
      picks: picks.filter((p) => p.gameId === g.id).map((p) => ({
        model: p.model ?? "v2", cat: p.cat, side: p.side, line: p.line, price: p.price, book: p.book, edge: p.edge ?? null,
        status: p.status ?? null, takenAt: p.takenAt, result: p.result ?? null, clvClose: p.clvClose ?? null,
      })),
    };
  })
  .sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id);

const out = path.join(DATA, `ledger-${season}.json`);
fs.writeFileSync(out, JSON.stringify({ season, builtAt: new Date().toISOString(), snapshots: seen.size, games: rows }));
const withSnaps = rows.filter((r) => r.snapshots.length).length;
console.log(`${rows.length} games (${withSnaps} with odds snapshots, ${rows.filter((r) => r.cfbd?.close != null).length} with a CFBD close), ` +
  `${seen.size} snapshots from ${commits.length} commits → ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
