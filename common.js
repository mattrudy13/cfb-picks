// Browser helpers shared by every page: data loading, formatting, team chips, the pick record and a
// small sortable table. Plain globals, no build step (te-tracker's convention).

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function loadJSON(path, { optional = false } = {}) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`${path}: HTTP ${res.status}`);
  }
  return res.json();
}

// Everything a page might need. Odds and picks don't exist until the first snapshot.
async function loadSite() {
  const { current } = await loadJSON("data/seasons.json");
  const [data, odds, picks, v2, v3] = await Promise.all([
    loadJSON(`data/${current}.json`),
    loadJSON(`data/odds-${current}.json`, { optional: true }),
    loadJSON(`data/picks-${current}.json`, { optional: true }),
    loadJSON("data/backtest-v2.json", { optional: true }),
    loadJSON("data/backtest-v3.json", { optional: true }),
  ]);
  setUpdated(data.updated);
  // `backtest` is the live model's own backtest.
  const backtest = data.model.version === "v3" ? v3 : v2;
  return { season: current, data, odds: odds ?? { games: {} }, picks: picks ?? { weeks: {} }, backtest, backtestV2: v2, backtestV3: v3 };
}

function setUpdated(iso) {
  const el = document.querySelector(".updated");
  if (el && iso) el.textContent = `Updated ${when(iso)} ET`;
}

function showError(err) {
  const main = document.querySelector("main");
  main.innerHTML = `<div class="card empty">Couldn't load the data (${esc(err.message)}). Try a refresh in a minute.</div>`;
  console.error(err);
}

// ---- Formatting ----

const MINUS = "−";
const signed = (x, digits = 1) => (x == null || Number.isNaN(x) ? "–" : (x > 0 ? "+" : x < 0 ? MINUS : "") + Math.abs(x).toFixed(digits));
// A spread to the nearest half point: −7.5, +3, PK.
const lineText = (x) => {
  if (x == null) return "–";
  const r = Math.round(x * 2) / 2;
  return r === 0 ? "PK" : (r > 0 ? "+" : MINUS) + Math.abs(r);
};
const pct = (x, digits = 0) => (x == null ? "–" : `${(100 * x).toFixed(digits)}%`);
const priceText = (p) => (p == null ? "–" : p > 0 ? `+${p}` : `${MINUS}${Math.abs(p)}`);
const implied = (p) => (p > 0 ? 100 / (p + 100) : -p / (-p + 100));

const ET = "America/New_York";
function when(iso) {
  return new Date(iso).toLocaleString("en-US", { timeZone: ET, weekday: "short", hour: "numeric", minute: "2-digit" });
}
// CFBD stores a kickoff time that isn't set yet as midnight Eastern.
function kickoff(iso) {
  const d = new Date(iso);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "numeric", minute: "numeric", hourCycle: "h23", weekday: "short", month: "short", day: "numeric" })
    .formatToParts(d).map((p) => [p.type, p.value]));
  const day = `${parts.weekday} ${parts.month} ${parts.day}`;
  return parts.hour === "00" && parts.minute === "00" ? `${day} · TBD` : `${day} · ${when(iso).split(" ").slice(1).join(" ")}`;
}

const BOOKS = {
  draftkings: "DraftKings", fanduel: "FanDuel", betmgm: "BetMGM", williamhill_us: "Caesars", espnbet: "ESPN BET",
  betrivers: "BetRivers", fanatics: "Fanatics", ballybet: "Bally Bet", hardrockbet: "Hard Rock Bet", fliff: "Fliff",
};
const bookName = (k) => BOOKS[k] ?? k;

// ---- Teams ----

function luminance(hex) {
  const n = parseInt(String(hex || "#555555").replace("#", ""), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

// Team colors carry identity; the chip's text is black or white, whichever reads.
function chip(name, data) {
  const t = data.teams[name] ?? {};
  const bg = t.color && /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : "#5a6782";
  const fg = luminance(bg) > 0.25 ? "#0d131f" : "#ffffff";
  // Near-black colors vanish on the dark background, so they get a light edge.
  const edge = luminance(bg) < 0.02 ? ";box-shadow:inset 0 0 0 1px #5a6782" : "";
  const label = t.abbr || name.slice(0, 4).toUpperCase();
  return `<span class="chip" style="background:${bg};color:${fg}${edge}" aria-hidden="true">${esc(label)}</span>`;
}

function teamLink(name, data, { strong = false } = {}) {
  const t = data.teams[name];
  const label = `<span class="tname"${strong ? ' style="font-weight:600"' : ""}>${esc(name)}</span>`;
  if (!t?.fbs) return `<span class="team">${chip(name, data)}${label}</span>`;
  return `<a class="team" href="team.html?team=${encodeURIComponent(name)}">${chip(name, data)}${label}</a>`;
}

// ---- Picks ----

// Line move toward the pick. Spreads: points. Moneylines: the change in the market's implied chance, in
// percentage points. Once grade-picks has CFBD's closing line (`p.close`), it's the move to the close,
// book by book (`clvClose`, null if no book could be compared). Before that it's the move "so far", from
// posting to the latest odds snapshot; picks seen at only one snapshot have no move yet.
function pickMove(p) {
  if (p.close) return { move: p.clvClose ?? null, toClose: true };
  if (p.closeMarket == null || p.closeAt === p.takenAt) return { move: null, toClose: false };
  const move = p.cat === "spread"
    ? (p.marketLine - p.closeMarket) * (p.side === "home" ? 1 : -1)
    : 100 * (implied(p.closeMarket) - implied(p.marketPrice));
  return { move, toClose: false };
}

// The record's line move counts only moves to the close, the number the provisional → official rule uses.
function recordOf(picks) {
  const count = (r) => picks.filter((p) => p.result === r).length;
  const w = count("W"), l = count("L"), push = count("P"), graded = w + l;
  const profit = picks.reduce((s, p) => s + (p.profit ?? 0), 0);
  const clvs = picks.map((p) => p.clvClose).filter((x) => x != null);
  return {
    w, l, push, graded,
    winPct: graded ? w / graded : null,
    roi: graded ? profit / (100 * graded) : null,
    clv: clvs.length ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null,
    clvCount: clvs.length,
    open: picks.filter((p) => !p.result).length,
  };
}

const allPicks = (store) => Object.values(store.weeks ?? {}).flatMap((w) => w.picks);
// Which model made a pick; picks from before v3 have no model field.
const pickModel = (p) => p.model ?? "v2";
const pickStatus = (p) => p.status ?? (p.shadow ? "unofficial" : "official");

// ---- URL state ----

const params = () => new URLSearchParams(location.search);
function setParam(key, value) {
  const u = new URL(location.href);
  if (value == null || value === "") u.searchParams.delete(key);
  else u.searchParams.set(key, value);
  history.replaceState(null, "", u);
}

// ---- Sortable table ----
// cols: [{ key, label, right, html(row), sort(row) }]. Header clicks sort; the choice lives in the URL.

function renderTable(el, cols, rows, { sortKey, sortDir = "desc", param = "sort" } = {}) {
  const fromUrl = params().get(param);
  let key = fromUrl?.replace(/^-/, "") ?? sortKey;
  let dir = fromUrl ? (fromUrl.startsWith("-") ? "desc" : "asc") : sortDir;
  const draw = () => {
    const col = cols.find((c) => c.key === key);
    const sorted = col?.sort
      ? [...rows].sort((a, b) => {
          const x = col.sort(a), y = col.sort(b);
          if (x == null) return 1;
          if (y == null) return -1;
          return (x < y ? -1 : x > y ? 1 : 0) * (dir === "asc" ? 1 : -1);
        })
      : rows;
    el.innerHTML = `<table><thead><tr>${cols.map((c) => {
      const s = c.sort ? ` class="sortable${c.right ? " r" : ""}" tabindex="0" data-key="${c.key}"${c.key === key ? ` aria-sort="${dir === "asc" ? "ascending" : "descending"}"` : ""}` : c.right ? ' class="r"' : "";
      return `<th${s} scope="col">${c.label}</th>`;
    }).join("")}</tr></thead><tbody>${sorted.map((r) => `<tr${r.rowClass ? ` class="${r.rowClass}"` : ""}>${cols.map((c) => `<td${c.right ? ' class="r"' : ""}>${c.html(r)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    el.querySelectorAll("th.sortable").forEach((th) => {
      const go = () => {
        const k = th.dataset.key;
        dir = k === key ? (dir === "asc" ? "desc" : "asc") : "desc";
        key = k;
        setParam(param, (dir === "desc" ? "-" : "") + key);
        draw();
      };
      th.addEventListener("click", go);
      th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  };
  draw();
}

// ---- Shared page header ----

function header(active) {
  const tabs = [["index.html", "Best Bets"], ["board.html", "Board"], ["ratings.html", "Ratings"], ["backtest.html", "Backtest"]];
  return `<header class="topbar"><div class="wrap">
    <a class="wordmark" href="./">CFB<span>·</span>Picks</a>
    <nav class="tabs" aria-label="Pages">${tabs.map(([href, label]) => `<a href="${href}"${href === active ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>
    <div class="updated"></div>
  </div></header>`;
}
