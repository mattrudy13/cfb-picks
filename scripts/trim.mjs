// Trimming shared by fetch-history.mjs and build-data.mjs, so past and live files have the same shape.

// One row per team per game from CFBD's games/players?category=passing: who threw and how many
// attempts ("C/ATT" is "17/34"). Negative ids are team rows, not players.
export function trimPassing(games, week) {
  return games.flatMap((g) => g.teams.map((t) => {
    const catt = t.categories.find((c) => c.name === "passing")?.types.find((x) => x.name === "C/ATT")?.athletes ?? [];
    return {
      gameId: g.id, week, team: t.team,
      passers: catt.map((a) => ({ id: a.id, name: a.name, att: Number(String(a.stat).split("/")[1]) || 0 }))
        .filter((a) => a.att > 0 && !String(a.id).startsWith("-")),
    };
  }));
}
