// Grades recorded picks once their games are final. Runs after build-data.mjs.
//
//   node scripts/grade-picks.mjs          # NOW=<iso> to pretend it's another time (testing)
//
// Spread picks win, lose or push at the recorded line; moneylines win or lose. Profit is per $100 at the
// recorded price. A game that's still not final 5 days after kickoff (canceled or postponed) is void.
// Graded picks are never regraded.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { payout } = require("../model.js");
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const now = process.env.NOW ? Date.parse(process.env.NOW) : Date.now();

const { current: season } = JSON.parse(fs.readFileSync(path.join(DATA, "seasons.json"), "utf8"));
const data = JSON.parse(fs.readFileSync(path.join(DATA, `${season}.json`), "utf8"));
const file = path.join(DATA, `picks-${season}.json`);
if (!fs.existsSync(file)) process.exit(0);
const store = JSON.parse(fs.readFileSync(file, "utf8"));
const games = new Map(data.games.map((g) => [g.id, g]));

let graded = 0;
for (const wk of Object.values(store.weeks)) {
  for (const p of wk.picks) {
    if (p.result) continue;
    const g = games.get(p.gameId);
    if (!g?.completed || g.homePoints == null) {
      if (now - Date.parse(p.kickoff) > 5 * 864e5) Object.assign(p, { result: "V", profit: 0 }), graded++;
      continue;
    }
    const sideMargin = (g.homePoints - g.awayPoints) * (p.side === "home" ? 1 : -1);
    const cover = p.cat === "spread" ? sideMargin + p.line : sideMargin;
    p.result = cover > 0 ? "W" : cover < 0 ? "L" : "P";
    p.profit = p.result === "W" ? 100 * payout(p.price) : p.result === "L" ? -100 : 0;
    p.score = `${g.away} ${g.awayPoints}, ${g.home} ${g.homePoints}`;
    graded++;
  }
}
if (graded) {
  fs.writeFileSync(file, JSON.stringify(store, null, 1));
  console.log(`${graded} picks graded`);
}
