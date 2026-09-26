// CFBx frontend. Ported from the single-file prototype
// (reference/cfbx-artifact.html). The views and styling are the same; the
// difference is where data comes from. Prices, cash and holdings are read
// from the API, and trades are *requests* the server executes at its own price.
// Nothing here computes or asserts a price.

import { helmetSVG } from "./helmet.js";

const cfg = window.CFBX_CONFIG || {};
const API = (cfg.apiUrl || "").replace(/\/$/, "");
const STARTING_CASH = 10000;
const SPREAD_FACTOR = 0.75; // only for labelling projected lines on upcoming games
const PREFS_KEY = "cfbx_view_prefs_v1";

const supabase =
  cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey)
    : null;

/* ---------- State ---------- */

const state = {
  teams: new Map(), // id -> team (incl. history)
  season: null,
  week: 0,
  teamsError: null,
  session: null, // Supabase session, or null when signed out
  me: null, // { cash, holdings_value, net_worth, ... }
  holdings: new Map(), // team_id -> holding row
  transactions: [],
  detail: null, // { id, data, error } for the team detail view
  leaderboard: null, // { data, error } from GET /leaderboard
  editingName: false,
  view: { conf: "all", q: "", priceMode: "week", ...loadPrefs() },
  tradePending: false,
};

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return { conf: p.conf || "all", priceMode: p.priceMode === "season" ? "season" : "week" };
  } catch {
    return {};
  }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ conf: state.view.conf, priceMode: state.view.priceMode }));
  } catch {
    /* storage unavailable: prefs just won't persist */
  }
}

/* ---------- Helpers ---------- */

const $ = (id) => document.getElementById(id);
const round2 = (n) => Math.round(n * 100) / 100;
const fmtMoney = (n) =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const fmtMargin = (n) => (n >= 0 ? "+" : "") + (Number.isInteger(n) ? n : n.toFixed(1));
const dirClass = (n) => (n > 0 ? "up" : n < 0 ? "down" : "flat");

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
const safeColor = (c, fallback) => (/^#[0-9a-f]{3,8}$/i.test(c || "") ? c : fallback);

function sparklinePath(history, w, h, pad = 3) {
  const hist = history.length > 1 ? history : [history[0], history[0]];
  const min = Math.min(...hist);
  const max = Math.max(...hist);
  const range = max - min || 1;
  const step = (w - 2 * pad) / (hist.length - 1);
  return hist
    .map((v, i) => `${(pad + i * step).toFixed(1)},${(h - pad - ((v - min) / range) * (h - 2 * pad)).toFixed(1)}`)
    .join(" ");
}

// Season move is measured from the IPO price, the first point of history.
function seasonPct(t) {
  return t.ipo_price ? round2(((t.current_price - t.ipo_price) / t.ipo_price) * 100) : 0;
}
const headlinePct = (t) => (state.view.priceMode === "season" ? seasonPct(t) : t.last_change_pct);

// "2-1", or "2-1-1" with ties/pushes.
const fmtRec = (a, b, c) => `${a}-${b}${c ? `-${c}` : ""}`;
const overallRec = (r) => fmtRec(r.overall.wins, r.overall.losses, r.overall.ties);
const atsRec = (r) => fmtRec(r.ats.wins, r.ats.losses, r.ats.pushes);

// The team's logo, falling back to the generic helmet when there's no logo
// URL or the image fails to load (see the error listener in boot()). The site
// is dark, so prefer ESPN's variant made for dark backgrounds.
function teamMark(t, size) {
  const helmet = helmetSVG(t.primary_color, t.secondary_color, size, t.name);
  const src = t.logo_dark_url || t.logo_url;
  if (!src || !/^(https:|data:image\/)/.test(src)) return helmet;
  return (
    `<span class="team-mark" style="width:${size}px;height:${size}px">` +
    `<img class="team-logo" src="${esc(src)}" width="${size}" height="${size}" alt="${esc(t.name)} logo" loading="lazy" decoding="async">` +
    `<span class="team-mark-fallback" hidden>${helmet}</span></span>`
  );
}

// teamMark by ticker, for lists that only carry the team id. `iconOnly`: just
// the logo (decorative, next to the ticker), nothing when there isn't one.
function miniMark(teamId, size, { iconOnly = false } = {}) {
  const t = state.teams.get(teamId);
  if (!t) return "";
  if (!iconOnly) return `<span class="mini-mark">${teamMark(t, size)}</span>`;
  const src = t.logo_dark_url || t.logo_url;
  if (!src || !/^(https:|data:image\/)/.test(src)) return "";
  return (
    `<span class="mini-mark" style="width:${size}px;height:${size}px">` +
    `<img class="team-logo" src="${esc(src)}" width="${size}" height="${size}" alt="" loading="lazy" decoding="async"></span>`
  );
}

// One-line summary under the name on market cards.
function recordLine(t) {
  if (!t.records) return "";
  return `<div class="rec"><span>${overallRec(t.records)}</span> &middot; <span>ATS ${atsRec(t.records)}</span></div>`;
}

// Overall / conference / ATS boxes on the team page.
function recordChips(t) {
  const r = t.records;
  if (!r) return "";
  const chip = (label, value, title) =>
    `<div class="rec-chip" title="${esc(title)}"><div class="rec-label">${esc(label)}</div><div class="rec-value">${value}</div></div>`;
  return (
    `<div class="rec-row">` +
    chip("overall", overallRec(r), "Season record") +
    (r.conference
      ? chip(t.conference, fmtRec(r.conference.wins, r.conference.losses, r.conference.ties), "Conference record")
      : "") +
    chip("vs spread", atsRec(r), "Against the spread: covered-missed(-push), games with a posted sportsbook line") +
    `</div>`
  );
}

function coverTag(t) {
  if (state.view.priceMode !== "week" || typeof t.last_covered !== "boolean") return "";
  return `<span class="cover-tag ${t.last_covered ? "covered" : "missed"}">${t.last_covered ? "COVERED" : "MISSED LINE"}</span>`;
}

let toastTimer = null;
function toast(msg, isError = false) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.className = "toast" + (isError ? " err" : "");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

/* ---------- API ---------- */

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function accessToken() {
  if (!supabase) return null;
  // getSession refreshes an expired access token when needed.
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token || null;
}

// auth: false (public), true (required), or "optional" (sent when signed in).
async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = await accessToken();
    if (!token && auth !== "optional") throw new ApiError(401, "signed_out");
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "network_error");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `http_${res.status}`);
  return data;
}

const ERROR_TEXT = {
  insufficient_funds: "Not enough cash for that order.",
  insufficient_shares: "You don't own that many shares.",
  invalid_shares: "Enter a whole number of shares.",
  invalid_side: "Unknown order type.",
  unknown_team: "That program isn't listed.",
  signed_out: "Sign in to trade.",
  invalid_token: "Your session expired. Sign in again.",
  missing_token: "Sign in to trade.",
  network_error: "Can't reach the server. Check your connection and try again.",
  invalid_display_name: "Use 3–24 letters, numbers, spaces, dots, dashes or underscores, starting and ending with a letter or number.",
  display_name_taken: "That name is taken. Try another.",
  display_name_not_allowed: "That name isn't allowed. Please pick another.",
};
const errorText = (err) => ERROR_TEXT[err.code] || "Something went wrong. Please try again.";

/* ---------- Data loading ---------- */

async function loadTeams() {
  try {
    const data = await api("/teams");
    state.teams = new Map(data.teams.map((t) => [t.id, t]));
    state.season = data.season;
    state.week = data.week;
    state.teamsError = null;
  } catch (err) {
    state.teamsError = err;
  }
}

async function loadAccount() {
  if (!state.session) {
    state.me = null;
    state.holdings = new Map();
    state.transactions = [];
    return;
  }
  try {
    const [me, holdings, txs] = await Promise.all([
      api("/me", { auth: true }),
      api("/me/holdings", { auth: true }),
      api("/me/transactions?limit=25", { auth: true }),
    ]);
    state.me = me;
    state.holdings = new Map(holdings.holdings.map((h) => [h.team_id, h]));
    state.transactions = txs.transactions;
  } catch (err) {
    if (err.status === 401) {
      await supabase?.auth.signOut();
      state.session = null;
      state.me = null;
    } else {
      toast(errorText(err), true);
    }
  }
}

async function loadLeaderboard() {
  try {
    state.leaderboard = { data: await api("/leaderboard?limit=100", { auth: "optional" }), error: null };
  } catch (err) {
    state.leaderboard = { data: state.leaderboard?.data || null, error: err };
  }
}

async function loadDetail(id) {
  state.detail = { id, data: null, error: null };
  try {
    state.detail.data = await api(`/teams/${encodeURIComponent(id)}`);
  } catch (err) {
    if (state.detail?.id === id) state.detail.error = err;
  }
}

/* ---------- Routing ---------- */

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [page, arg] = hash.split("/");
  if (page === "team" && arg) return { page: "detail", ticker: decodeURIComponent(arg).toUpperCase() };
  if (page === "portfolio") return { page: "portfolio" };
  if (page === "leaderboard") return { page: "leaderboard" };
  if (page === "signin") return { page: "signin" };
  return { page: "market" };
}

async function onRouteChange() {
  const route = parseRoute();
  if (route.page === "detail" && state.detail?.id !== route.ticker) {
    state.detail = { id: route.ticker, data: null, error: null };
    render();
    await loadDetail(route.ticker);
  }
  if (route.page === "leaderboard") {
    state.editingName = false;
    if (!state.leaderboard) render(); // show the loading state on first visit
    await loadLeaderboard();
  }
  render();
  window.scrollTo(0, 0);
}

/* ---------- Rendering: chrome ---------- */

function renderTape() {
  const list = [...state.teams.values()];
  const items = list
    .map((t) => {
      const ch = t.last_change_pct;
      const arrow = ch > 0 ? "▲" : ch < 0 ? "▼" : "–";
      return (
        `<span class="tape-item"><span class="tk">${esc(t.id)}</span>` +
        `<span class="px">${t.current_price.toFixed(2)}</span>` +
        `<span class="ch ${dirClass(ch)}">${arrow} ${Math.abs(ch).toFixed(2)}%</span></span>`
      );
    })
    .join("");
  const tape = $("tape");
  tape.innerHTML = items + items;
  tape.style.animationDuration = Math.max(34, list.length * 2.6) + "s";
}

function renderAccount() {
  const el = $("acct");
  if (!supabase) {
    el.innerHTML = "";
    return;
  }
  if (!state.session) {
    el.innerHTML = `<a class="btn-secondary" href="#/signin" style="text-decoration:none">Sign in</a>`;
    return;
  }
  const cash = state.me ? fmtMoney(state.me.cash) : "—";
  const nw = state.me ? fmtMoney(state.me.net_worth) : "—";
  el.innerHTML =
    `<div class="stat"><div class="label">cash</div><div class="value" id="hdr-cash">${cash}</div></div>` +
    `<div class="stat"><div class="label">net worth</div><div class="value" id="hdr-networth">${nw}</div></div>` +
    `<button class="btn-secondary" id="btn-signout" title="${esc(state.session.user?.email)}">Sign out</button>`;
  $("btn-signout").addEventListener("click", async () => {
    await supabase.auth.signOut();
  });
}

function render() {
  const route = parseRoute();
  renderTape();
  renderAccount();
  $("tab-market").classList.toggle("active", route.page === "market" || route.page === "detail");
  $("tab-portfolio").classList.toggle("active", route.page === "portfolio");
  $("tab-leaderboard").classList.toggle("active", route.page === "leaderboard");

  if (state.teamsError && !state.teams.size) {
    $("main").innerHTML =
      `<div class="panel"><div class="empty-state"><div class="big">Market unavailable</div>` +
      `${esc(errorText(state.teamsError))}<br><br><button class="btn-secondary" id="btn-retry">Retry</button></div></div>`;
    $("btn-retry").addEventListener("click", async () => {
      await loadTeams();
      render();
    });
    return;
  }
  if (route.page === "market") renderMarket();
  else if (route.page === "detail") renderDetail(route.ticker);
  else if (route.page === "portfolio") renderPortfolio();
  else if (route.page === "leaderboard") renderLeaderboard();
  else if (route.page === "signin") renderSignIn();
}

/* ---------- Rendering: market ---------- */

function renderMarket() {
  const all = [...state.teams.values()];
  const confs = [...new Set(all.map((t) => t.conference))].sort();
  if (state.view.conf !== "all" && !confs.includes(state.view.conf)) state.view.conf = "all";
  const mode = state.view.priceMode;

  const confOptions =
    `<option value="all">All conferences</option>` +
    confs.map((c) => `<option value="${esc(c)}"${c === state.view.conf ? " selected" : ""}>${esc(c)}</option>`).join("");

  const weekLabel = state.week ? `Week ${state.week}` : "Preseason";
  $("main").innerHTML =
    `<div class="section-head"><div><h1>Market — ${weekLabel}</h1>` +
    `<p>${all.length} programs, ranked by current price. Prices move after each final score. Tap a card to trade.</p></div></div>` +
    `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px;align-items:center">` +
    `<input type="search" id="mkt-search" aria-label="Search programs" placeholder="Search team, mascot, or ticker…" value="${esc(state.view.q)}" style="flex:1;min-width:180px;background:var(--bg-panel-alt);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;padding:9px 12px">` +
    `<select id="mkt-conf" aria-label="Conference" style="background:var(--bg-panel-alt);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13.5px;padding:9px 10px">${confOptions}</select>` +
    `<nav class="tabs" id="mkt-pricemode">` +
    `<button data-mode="week" class="${mode === "week" ? "active" : ""}">This Week</button>` +
    `<button data-mode="season" class="${mode === "season" ? "active" : ""}">Season</button>` +
    `</nav></div>` +
    `<div id="mkt-grid"></div>`;

  let timer = null;
  $("mkt-search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.view.q = e.target.value;
      renderGrid();
    }, 150);
  });
  $("mkt-conf").addEventListener("change", (e) => {
    state.view.conf = e.target.value;
    savePrefs();
    renderGrid();
  });
  document.querySelectorAll("#mkt-pricemode button").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.view.priceMode = btn.dataset.mode;
      savePrefs();
      renderMarket();
    })
  );
  renderGrid();
}

function renderGrid() {
  const q = state.view.q.trim().toLowerCase();
  const conf = state.view.conf;
  const teams = [...state.teams.values()]
    .filter(
      (t) =>
        (conf === "all" || t.conference === conf) &&
        (!q ||
          t.name.toLowerCase().includes(q) ||
          t.id.toLowerCase().includes(q) ||
          (t.mascot || "").toLowerCase().includes(q))
    )
    .sort((a, b) => b.current_price - a.current_price);

  const cards = teams
    .map((t) => {
      const pct = headlinePct(t);
      const held = state.holdings.get(t.id);
      const hist = t.history && t.history.length ? t.history : [t.current_price];
      const stroke = hist[hist.length - 1] >= hist[0] ? "var(--positive)" : "var(--negative)";
      return (
        `<a class="card" href="#/team/${encodeURIComponent(t.id)}" style="--tag-color:${safeColor(t.primary_color, "#E8A33D")}">` +
        `<div class="card-top"><div style="display:flex;align-items:center;gap:10px">` +
        teamMark(t, 44) +
        `<div><div class="tk">${esc(t.id)}</div><div class="nm">${esc(t.name)}${t.mascot ? " " + esc(t.mascot) : ""}</div>${recordLine(t)}</div>` +
        `</div>${held ? `<span class="held-badge">${held.shares} sh</span>` : ""}</div>` +
        `<div class="card-mid"><div class="px">$${t.current_price.toFixed(2)}</div>` +
        `<div style="text-align:right"><div class="ch ${dirClass(pct)}">${fmtPct(pct)}</div>${coverTag(t)}</div></div>` +
        `<svg class="spark" viewBox="0 0 220 36" preserveAspectRatio="none" aria-hidden="true">` +
        `<polyline points="${sparklinePath(hist, 220, 36)}" fill="none" stroke="${stroke}" stroke-width="2"/></svg>` +
        `</a>`
      );
    })
    .join("");

  $("mkt-grid").innerHTML = teams.length
    ? `<div class="grid">${cards}</div>`
    : `<div class="panel"><div class="empty-state">No programs match that search.</div></div>`;
}

/* ---------- Rendering: team detail ---------- */

// Round numbers for the price axis: ~4 gridlines at a 1/2/2.5/5 x 10^n step.
function niceTicks(min, max, count = 4) {
  if (max - min < 0.01) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.999; v += step) ticks.push(round2(v));
  return ticks;
}

// One point per price: the opening price, then the price after each game.
function chartPoints(d) {
  const games = d.game_log.slice().reverse(); // oldest first
  return [
    { label: "Open", price: d.price_history[0], event: null },
    ...games.map((e) => ({ label: `W${e.week}`, price: e.price_after, event: e })),
  ];
}

const fmtAxis = (v) => "$" + (Number.isInteger(v) ? v : v.toFixed(2));

// Price history: line with a marker per week, week labels, a price axis,
// direct labels on the first and latest price, and a hover/tap tooltip
// with each week's details (bindPriceChart wires it up after render).
function priceChart(points) {
  // Size the drawing to the room it will get (panel padding ~70px), so
  // axis text stays legible on phones instead of scaling down.
  const w = Math.round(Math.min(560, Math.max(300, (window.innerWidth || 560) - 70)));
  const h = w < 420 ? 210 : 240;
  const padL = 44, padR = 56, padT = 22, padB = 30;
  const prices = points.map((p) => p.price);
  const ticks = niceTicks(Math.min(...prices), Math.max(...prices));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const step = (w - padL - padR) / Math.max(points.length - 1, 1);
  const x = (i) => padL + (points.length === 1 ? (w - padL - padR) / 2 : i * step);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  const first = prices[0], last = prices[prices.length - 1];
  const color = last >= first ? "var(--positive)" : "var(--negative)";
  const every = Math.ceil(points.length / Math.floor((w - padL - padR) / 34)); // thin x labels when crowded

  const grid = ticks
    .map(
      (t) =>
        `<line x1="${padL}" x2="${w - padR + 8}" y1="${y(t)}" y2="${y(t)}" stroke="var(--border)" stroke-width="1"/>` +
        `<text class="axis-label" x="${padL - 8}" y="${y(t)}" dy=".32em" text-anchor="end">${fmtAxis(t)}</text>`
    )
    .join("");
  const xLabels = points
    .map((p, i) =>
      i % every === 0 || i === points.length - 1
        ? `<text class="axis-label" x="${x(i)}" y="${h - 8}" text-anchor="middle">${p.label}</text>`
        : ""
    )
    .join("");
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
  const dots = points
    .map((p, i) => `<circle cx="${x(i)}" cy="${y(p.price)}" r="4" fill="${color}" stroke="var(--bg-panel)" stroke-width="2"/>`)
    .join("");
  const direct = (i, anchor) =>
    `<text class="chart-value" x="${x(i) + (anchor === "start" ? 8 : 0)}" y="${y(points[i].price) - 10}" text-anchor="${anchor}">$${points[i].price.toFixed(2)}</text>`;
  const labels = direct(0, "start") + (points.length > 1 ? direct(points.length - 1, "start") : "");
  // Hit targets: a full-height column per point, wider than the marker.
  const hits = points
    .map((p, i) => {
      const x0 = i === 0 ? x(0) - step / 2 : (x(i - 1) + x(i)) / 2;
      const x1 = i === points.length - 1 ? x(i) + step / 2 : (x(i) + x(i + 1)) / 2;
      return `<rect class="chart-hit" data-i="${i}" x="${Math.max(0, x0)}" y="0" width="${Math.max(12, x1 - Math.max(0, x0))}" height="${h}" fill="transparent" tabindex="0" aria-label="${esc(pointText(p))}"/>`;
    })
    .join("");

  return (
    `<div class="chart-box">` +
    `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px" role="img" data-w="${w}" ` +
    `aria-label="Price by week, from $${first.toFixed(2)} to $${last.toFixed(2)}">` +
    grid +
    `<line class="chart-cross" x1="0" x2="0" y1="${padT - 6}" y2="${h - padB}" stroke="var(--text-faint)" stroke-dasharray="3 3" visibility="hidden"/>` +
    `<path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
    dots +
    labels +
    xLabels +
    hits +
    `</svg><div class="chart-tip" role="status" hidden></div></div>`
  );
}

// Plain-text version of a point, for screen readers.
function pointText(p) {
  if (!p.event) return `Opening price $${p.price.toFixed(2)}`;
  const e = p.event;
  const result = e.team_score > e.opp_score ? "won" : e.team_score < e.opp_score ? "lost" : "tied";
  return `Week ${e.week}, ${result} ${e.team_score}-${e.opp_score} vs ${e.opponent_name || e.opponent_id}: $${p.price.toFixed(2)}, ${fmtPct(e.pct_change)}`;
}

function tipHtml(p) {
  if (!p.event) {
    return `<div class="tip-head">Opening price</div><div class="tip-price">$${p.price.toFixed(2)}</div><div class="tip-note">Program Prestige Score</div>`;
  }
  const e = p.event;
  const opp = esc(e.opponent_name || e.opponent_id);
  const res = e.team_score > e.opp_score ? "W" : e.team_score < e.opp_score ? "L" : "T";
  return (
    `<div class="tip-head">Week ${e.week} &middot; ${res} ${e.team_score}-${e.opp_score} vs ${opp}</div>` +
    `<div class="tip-price">$${p.price.toFixed(2)} <span class="txt-${dirClass(e.pct_change)}">${fmtPct(e.pct_change)}</span></div>` +
    (e.summary ? `<div class="tip-note">${esc(e.summary)}${e.is_real_line || e.vs_fcs ? "" : " (SP+ line)"}</div>` : "")
  );
}

// Hover, tap and keyboard focus show a point's tooltip and a crosshair.
function bindPriceChart(root, points) {
  const box = root.querySelector(".chart-box");
  if (!box) return;
  const svg = box.querySelector("svg");
  const tip = box.querySelector(".chart-tip");
  const cross = box.querySelector(".chart-cross");
  const w = Number(svg.dataset.w);
  const show = (i) => {
    const dot = svg.querySelectorAll("circle")[i];
    const cx = Number(dot.getAttribute("cx"));
    const cy = Number(dot.getAttribute("cy"));
    cross.setAttribute("x1", cx);
    cross.setAttribute("x2", cx);
    cross.setAttribute("visibility", "visible");
    tip.innerHTML = tipHtml(points[i]);
    tip.hidden = false;
    const scale = svg.getBoundingClientRect().width / w;
    const half = tip.offsetWidth / 2;
    const left = Math.min(Math.max(cx * scale, half + 4), box.clientWidth - half - 4);
    const below = cy * scale - 14 - tip.offsetHeight < 0;
    tip.classList.toggle("below", below);
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? cy * scale + 14 : cy * scale - 14}px`;
  };
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
  };
  svg.querySelectorAll(".chart-hit").forEach((r) => {
    const i = Number(r.dataset.i);
    r.addEventListener("pointerenter", () => show(i));
    r.addEventListener("click", () => show(i));
    r.addEventListener("focus", () => show(i));
    r.addEventListener("blur", hide);
  });
  svg.addEventListener("pointerleave", hide);
}

function gameLogItem(e) {
  const opp = e.opponent_name || e.opponent_id;
  const won = e.team_score > e.opp_score;
  const text = won
    ? `def. ${esc(opp)} ${e.team_score}-${e.opp_score}`
    : `fell to ${esc(opp)} ${e.team_score}-${e.opp_score}`;
  const summary = e.summary ? ` (${esc(e.summary)})` : "";
  const proj = e.vs_fcs
    ? ` <span class="proj-tag">FCS</span>`
    : e.is_real_line
      ? ""
      : ` <span class="proj-tag">SP+ LINE</span>`;
  return (
    `<div class="log-item"><span class="lw">Week ${e.week}</span> &middot; ${text}${summary}${proj} ` +
    `<span class="ld ch ${e.pct_change >= 0 ? "up" : "down"}">${fmtPct(e.pct_change)}</span> ` +
    `<span class="log-price">&rarr; $${e.price_after.toFixed(2)}</span></div>`
  );
}

function upcomingItem(team, g) {
  const opp = state.teams.get(g.opponent_id);
  const oppName = opp ? opp.name : g.opponent_id;
  let margin, tag;
  if (g.line_is_real) {
    margin = g.expected_margin;
    tag = `<span class="proj-tag real-tag">REAL LINE</span>`;
  } else {
    // No sportsbook line yet: show the SP+ estimate, clearly labelled.
    margin = opp ? round2((team.strength - opp.strength) * SPREAD_FACTOR) : null;
    tag = `<span class="proj-tag">PROJECTED</span>`;
  }
  const lineText =
    margin === null
      ? "no line yet"
      : margin === 0
        ? "pick'em"
        : margin > 0
          ? `favored by ${Math.abs(margin).toFixed(1)}`
          : `underdog by ${Math.abs(margin).toFixed(1)}`;
  return (
    `<div class="upcoming-item"><span><span class="lw" style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint)">Wk ${g.week}</span> ` +
    `${g.is_home ? "vs" : "@"} <a class="opp" href="#/team/${encodeURIComponent(g.opponent_id)}">${esc(oppName)}</a></span>` +
    `<span>${lineText} ${tag}</span></div>`
  );
}

function renderDetail(ticker) {
  const t = state.teams.get(ticker);
  if (!t) {
    $("main").innerHTML =
      `<a class="detail-back" href="#/">&larr; Back to market</a>` +
      `<div class="panel"><div class="empty-state"><div class="big">Unknown ticker</div>No program is listed as ${esc(ticker)}.</div></div>`;
    return;
  }
  const detail = state.detail?.id === ticker ? state.detail : null;
  const data = detail?.data;
  const mode = state.view.priceMode;
  const pct = headlinePct(t);
  const held = state.holdings.get(ticker);
  const heldShares = held ? held.shares : 0;
  const cash = state.me ? state.me.cash : 0;

  const lastGame =
    mode === "week" && typeof t.last_covered === "boolean"
      ? `<div class="cover-tag ${t.last_covered ? "covered" : "missed"}">${t.last_covered ? "COVERED" : "MISSED LINE"}</div>` +
        `<div class="position-note" style="margin-top:4px">Expected ${fmtMargin(t.last_expected)} · Actual ${fmtMargin(t.last_actual)}` +
        `${t.last_line_is_real ? " (real line)" : " (projected)"}</div>`
      : "";

  const panelBody = (render) =>
    detail?.error
      ? `<div class="log-item">Couldn't load this. ${esc(errorText(detail.error))}</div>`
      : data
        ? render(data)
        : `<div class="loading" style="padding:20px">Loading…</div>`;

  let tradePanel;
  if (!supabase) {
    tradePanel = `<div class="position-note">Trading isn't configured on this server.</div>`;
  } else if (!state.session) {
    tradePanel =
      `<div class="position-note" style="margin-bottom:12px">Sign in to trade. Every account starts with ${fmtMoney(STARTING_CASH)} in play money.</div>` +
      `<a class="btn-primary" href="#/signin" style="text-decoration:none;display:inline-block">Sign in</a>`;
  } else {
    const positionNote = held
      ? `${held.shares} shares @ avg $${held.avg_cost.toFixed(2)} &middot; current value $${(held.shares * t.current_price).toFixed(2)}`
      : "No position yet.";
    tradePanel =
      `<div class="trade-form">` +
      `<div class="trade-row"><input type="number" id="trade-qty" aria-label="Shares" min="1" step="1" inputmode="numeric" placeholder="Shares" value="1"></div>` +
      `<div class="trade-summary"><span>Est. total at $${t.current_price.toFixed(2)}</span><strong id="trade-cost">$${t.current_price.toFixed(2)}</strong></div>` +
      `<div class="trade-buttons">` +
      `<button class="btn-buy" id="btn-buy">Buy</button>` +
      `<button class="btn-sell" id="btn-sell"${heldShares < 1 ? " disabled" : ""}>Sell</button></div>` +
      `<div class="position-note">${positionNote}</div>` +
      `<div class="position-note">Buying power: ${fmtMoney(cash)} (~${Math.floor(cash / t.current_price)} sh)</div>` +
      `<div class="stale-note">Orders fill at the server's current price when received.</div>` +
      `</div>`;
  }

  $("main").innerHTML =
    `<a class="detail-back" href="#/">&larr; Back to market</a>` +
    `<div class="detail-head"><div style="display:flex;align-items:center;gap:16px">` +
    teamMark(t, 84) +
    `<div class="tk-name"><div class="tk">${esc(t.id)} &middot; ${esc(t.conference)} &middot; STRENGTH ${t.strength}</div>` +
    `<h1>${esc(t.name)}</h1>${t.mascot ? `<div class="nm">${esc(t.mascot)}</div>` : ""}${recordChips(t)}</div></div>` +
    `<div class="detail-price">` +
    `<nav class="tabs" id="detail-pricemode" style="margin-bottom:8px;display:inline-flex">` +
    `<button data-mode="week" class="${mode === "week" ? "active" : ""}" style="padding:5px 11px;font-size:12px">Week</button>` +
    `<button data-mode="season" class="${mode === "season" ? "active" : ""}" style="padding:5px 11px;font-size:12px">Season</button></nav>` +
    `<div class="px">$${t.current_price.toFixed(2)}</div>` +
    `<div class="ch ${dirClass(pct)}">${fmtPct(pct)}${mode === "season" ? ` since IPO ($${t.ipo_price.toFixed(2)})` : " last game"}</div>` +
    lastGame +
    `</div></div>` +
    `<div class="detail-body">` +
    `<div class="panel"><h2>price history</h2><div class="chart-wrap">${panelBody((d) => priceChart(chartPoints(d)))}</div></div>` +
    `<div class="panel"><h2>trade</h2>${tradePanel}</div>` +
    `</div>` +
    `<div class="detail-body" style="margin-top:16px">` +
    `<div class="panel"><h2>game log</h2><div class="log-list">${panelBody((d) =>
      d.game_log.length ? d.game_log.map(gameLogItem).join("") : `<div class="log-item">No games played yet this season.</div>`
    )}</div></div>` +
    `<div class="panel"><h2>up next</h2><div class="upcoming-list">${panelBody((d) =>
      d.upcoming.length
        ? d.upcoming.slice(0, 5).map((g) => upcomingItem(t, g)).join("")
        : `<div class="log-item">No more games scheduled.</div>`
    )}</div></div>` +
    `</div>`;

  if (data) bindPriceChart($("main"), chartPoints(data));

  document.querySelectorAll("#detail-pricemode button").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.view.priceMode = btn.dataset.mode;
      savePrefs();
      renderDetail(ticker);
    })
  );

  const qtyInput = $("trade-qty");
  if (!qtyInput) return;
  const qty = () => {
    const v = qtyInput.value.trim();
    return /^\d+$/.test(v) ? parseInt(v, 10) : 0;
  };
  function refreshCost() {
    const q = qty();
    $("trade-cost").textContent = fmtMoney(q * t.current_price);
    $("btn-buy").disabled = state.tradePending || q < 1 || q * t.current_price > cash;
    $("btn-sell").disabled = state.tradePending || q < 1 || q > heldShares;
  }
  qtyInput.addEventListener("input", refreshCost);
  refreshCost();
  $("btn-buy").addEventListener("click", () => trade(ticker, "buy", qty()));
  $("btn-sell").addEventListener("click", () => trade(ticker, "sell", qty()));
}

async function trade(ticker, side, shares) {
  if (state.tradePending || shares < 1) return;
  state.tradePending = true;
  $("btn-buy").disabled = true;
  $("btn-sell").disabled = true;
  try {
    const r = await api("/trade", { method: "POST", auth: true, body: { team_id: ticker, side, shares } });
    toast(`${side === "buy" ? "Bought" : "Sold"} ${r.shares} ${r.team_id} @ $${r.price.toFixed(2)} · ${fmtMoney(r.amount)}`);
    // Pull fresh account numbers: the server is the authority.
    await loadAccount();
  } catch (err) {
    toast(errorText(err), true);
    if (err.status === 401) await loadAccount();
  } finally {
    state.tradePending = false;
    render();
  }
}

/* ---------- Rendering: portfolio ---------- */

function renderPortfolio() {
  const head = `<div class="section-head"><div><h1>Portfolio</h1><p>Every account starts with ${fmtMoney(STARTING_CASH)} in play money.</p></div></div>`;
  if (!state.session) {
    $("main").innerHTML =
      head +
      `<div class="panel"><div class="empty-state"><div class="big">Sign in to see your portfolio</div>` +
      (supabase ? `<br><a class="btn-primary" href="#/signin" style="text-decoration:none;display:inline-block">Sign in</a>` : "") +
      `</div></div>`;
    return;
  }
  if (!state.me) {
    $("main").innerHTML = head + `<div class="loading">Loading portfolio…</div>`;
    return;
  }
  const standing = state.me.display_name
    ? `<p class="stale-note" style="margin:-8px 0 16px">Playing as <strong>${esc(state.me.display_name)}</strong> on the <a href="#/leaderboard">leaderboard</a>.</p>`
    : `<p class="stale-note" style="margin:-8px 0 16px">You're not on the leaderboard. <a href="#/leaderboard">Pick a display name</a> to join.</p>`;

  const nw = state.me.net_worth;
  const ret = round2(nw - STARTING_CASH);
  const retPct = round2((ret / STARTING_CASH) * 100);
  const summary =
    `<div class="summary-row">` +
    `<div class="summary-card"><div class="label">net worth</div><div class="val">${fmtMoney(nw)}</div></div>` +
    `<div class="summary-card"><div class="label">cash available</div><div class="val">${fmtMoney(state.me.cash)}</div></div>` +
    `<div class="summary-card"><div class="label">total return</div><div class="val ch ${ret >= 0 ? "up" : "down"}" style="background:none;padding:0">${ret >= 0 ? "+" : ""}${fmtMoney(ret)} (${fmtPct(retPct)})</div></div>` +
    `</div>`;

  const holdings = [...state.holdings.values()];
  const body = !holdings.length
    ? `<div class="panel"><div class="empty-state"><div class="big">No positions yet</div>Head to the market and buy your first shares.</div></div>`
    : `<div class="panel table-scroll"><table class="holdings">` +
      `<thead><tr><th>program</th><th>shares</th><th>avg cost</th><th>price</th><th>value</th><th>gain / loss</th></tr></thead><tbody>` +
      holdings
        .map((h) => {
          const cost = h.shares * h.avg_cost;
          const gl = h.unrealized_pl;
          const glPct = cost ? round2((gl / cost) * 100) : 0;
          return (
            `<tr><td class="nm-cell"><div class="nm-flex">${miniMark(h.team_id, 32)}<div>` +
            `<a href="#/team/${encodeURIComponent(h.team_id)}" style="text-decoration:none">${esc(h.name)}</a><br><span class="tk-mini">${esc(h.team_id)}</span></div></div></td>` +
            `<td>${h.shares}</td><td>$${h.avg_cost.toFixed(2)}</td><td>$${h.current_price.toFixed(2)}</td>` +
            `<td>$${h.market_value.toFixed(2)}</td>` +
            `<td class="ch ${gl >= 0 ? "up" : "down"}" style="background:none;padding:12px 10px">${gl >= 0 ? "+" : "-"}$${Math.abs(gl).toFixed(2)} (${fmtPct(glPct)})</td></tr>`
          );
        })
        .join("") +
      `</tbody></table></div>`;

  const trades = state.transactions.length
    ? `<div class="panel" style="margin-top:16px"><h2>recent trades</h2><div class="log-list">` +
      state.transactions
        .map(
          (x) =>
            `<div class="log-item"><span class="lw">${esc(new Date(x.created_at).toLocaleString())}</span> &middot; ` +
            `${x.side === "buy" ? "Bought" : "Sold"} ${x.shares} ${miniMark(x.team_id, 18, { iconOnly: true })}<a href="#/team/${encodeURIComponent(x.team_id)}">${esc(x.team_id)}</a> @ $${x.price.toFixed(2)} ` +
            `<span class="ld">${fmtMoney(x.amount)}</span></div>`
        )
        .join("") +
      `</div></div>`
    : "";

  $("main").innerHTML = head + standing + summary + body + trades;
}

/* ---------- Rendering: leaderboard ---------- */

function nameForm(current) {
  return (
    `<form id="name-form" novalidate style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start">` +
    `<input class="field" id="name-input" aria-label="Display name" maxlength="24" autocomplete="nickname" ` +
    `placeholder="Display name" value="${esc(current || "")}" style="flex:1;min-width:180px;margin:0">` +
    `<button class="btn-primary" type="submit" id="name-save">${current ? "Save" : "Join leaderboard"}</button>` +
    (current ? `<button class="btn-secondary" type="button" id="name-cancel">Cancel</button>` : "") +
    `</form>` +
    `<div class="form-msg" id="name-msg" role="status" aria-live="polite"></div>`
  );
}

function bindNameForm() {
  const form = $("name-form");
  if (!form) return;
  $("name-cancel")?.addEventListener("click", () => {
    state.editingName = false;
    renderLeaderboard();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("name-msg");
    const name = $("name-input").value.trim().replace(/\s+/g, " ");
    $("name-save").disabled = true;
    try {
      const r = await api("/me", { method: "PATCH", auth: true, body: { display_name: name } });
      if (state.me) state.me.display_name = r.display_name;
      state.editingName = false;
      await loadLeaderboard();
      toast(`You're on the leaderboard as ${r.display_name}.`);
      render();
    } catch (err) {
      msg.className = "form-msg err";
      msg.textContent = errorText(err);
      $("name-save").disabled = false;
    }
  });
}

function renderLeaderboard() {
  const lb = state.leaderboard;
  const players = lb?.data?.players ?? 0;
  const head =
    `<div class="section-head"><div><h1>Leaderboard</h1>` +
    `<p>Net worth at current prices. Everyone starts with ${fmtMoney(STARTING_CASH)}. ` +
    `Only players who pick a display name are listed.</p></div></div>`;

  if (!lb?.data) {
    $("main").innerHTML =
      head +
      (lb?.error
        ? `<div class="panel"><div class="empty-state">${esc(errorText(lb.error))}</div></div>`
        : `<div class="loading">Loading leaderboard…</div>`);
    return;
  }

  // Your standing, or the opt-in form.
  let standing = "";
  if (supabase && !state.session) {
    standing =
      `<div class="panel" style="margin-bottom:16px"><div class="position-note">` +
      `<a href="#/signin">Sign in</a> and pick a display name to join the leaderboard.</div></div>`;
  } else if (supabase && lb.data.me && !state.editingName) {
    const me = lb.data.me;
    standing =
      `<div class="summary-row">` +
      `<div class="summary-card"><div class="label">your rank</div><div class="val">#${me.rank} <span style="font-size:14px;color:var(--text-muted)">of ${players}</span></div></div>` +
      `<div class="summary-card"><div class="label">playing as</div><div class="val" style="font-family:var(--font-body);font-size:19px;overflow-wrap:anywhere">${esc(me.display_name)}</div>` +
      `<button class="btn-secondary" id="name-edit" style="margin-top:8px;padding:5px 11px;font-size:12px">Change name</button></div>` +
      `<div class="summary-card"><div class="label">net worth</div><div class="val">${fmtMoney(me.net_worth)}</div></div>` +
      `</div>`;
  } else if (supabase) {
    const current = lb.data.me?.display_name || "";
    standing =
      `<div class="panel" style="margin-bottom:16px"><h2>${current ? "change your display name" : "join the leaderboard"}</h2>` +
      (current
        ? ""
        : `<p class="position-note" style="margin:0 0 12px">Pick a public display name. Your email is never shown. You can change the name later.</p>`) +
      nameForm(current) +
      `</div>`;
  }

  const rows = lb.data.leaderboard;
  const table = rows.length
    ? `<div class="panel table-scroll"><table class="holdings">` +
      `<thead><tr><th>rank</th><th>player</th><th>net worth</th><th>return</th></tr></thead><tbody>` +
      rows
        .map((r) => {
          const ret = round2(r.net_worth - STARTING_CASH);
          const retPct = round2((ret / STARTING_CASH) * 100);
          return (
            `<tr${r.is_me ? ' class="me-row"' : ""}>` +
            `<td>${r.rank <= 3 ? `<span class="medal medal-${r.rank}">${r.rank}</span>` : r.rank}</td>` +
            `<td class="nm-cell">${esc(r.display_name)}${r.is_me ? ' <span class="you-badge">you</span>' : ""}</td>` +
            `<td>${fmtMoney(r.net_worth)}</td>` +
            `<td class="txt-${dirClass(ret)}">${fmtPct(retPct)}</td></tr>`
          );
        })
        .join("") +
      `</tbody></table></div>` +
      (players > rows.length ? `<p class="stale-note" style="margin-top:10px">Showing the top ${rows.length} of ${players} players.</p>` : "")
    : `<div class="panel"><div class="empty-state"><div class="big">No one's on the board yet</div>Pick a display name to be the first.</div></div>`;

  $("main").innerHTML = head + standing + table;

  $("name-edit")?.addEventListener("click", () => {
    state.editingName = true;
    renderLeaderboard();
    $("name-input")?.focus();
  });
  bindNameForm();
}

/* ---------- Rendering: sign in ---------- */

// Google's "G" mark, for the sign-in button.
const GOOGLE_G =
  `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">` +
  `<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>` +
  `<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>` +
  `<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>` +
  `<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>` +
  `</svg>`;

const RESEND_WAIT_S = 60; // Supabase allows one email per address per minute
const signInState = { email: null, sentAt: 0 };

function renderSignIn() {
  if (!supabase) {
    $("main").innerHTML = `<div class="panel auth-panel"><h2>sign in</h2><p>Sign-in isn't configured on this server.</p></div>`;
    return;
  }
  if (state.session) {
    location.hash = "#/";
    return;
  }
  if (signInState.email) return renderCheckEmail();

  const google = (cfg.authProviders || []).includes("google");
  $("main").innerHTML =
    `<div class="panel auth-panel"><h2>sign in</h2>` +
    `<p>New here? Signing in creates your account with ${fmtMoney(STARTING_CASH)} in play money.</p>` +
    (google
      ? `<button class="btn-google" type="button" id="signin-google">${GOOGLE_G}<span>Continue with Google</span></button>` +
        `<div class="auth-or"><span>or use your email</span></div>`
      : `<p>Enter your email and we'll send you a sign-in link.</p>`) +
    `<form id="signin-form" novalidate>` +
    `<input class="field" type="email" id="signin-email" autocomplete="email" required placeholder="you@example.com" aria-label="Email">` +
    `<button class="btn-primary" type="submit" id="signin-submit" style="width:100%">Email me a link</button>` +
    `<div class="form-msg" id="signin-msg" role="status" aria-live="polite"></div></form></div>`;

  if (google) {
    $("signin-google").addEventListener("click", async () => {
      $("signin-google").disabled = true;
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: location.origin + location.pathname },
      });
      // On success the browser is already on its way to Google.
      if (error) {
        $("signin-google").disabled = false;
        const msg = $("signin-msg");
        msg.className = "form-msg err";
        msg.textContent = error.message || "Couldn't start Google sign-in. Try again.";
      }
    });
  }

  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("signin-email").value.trim();
    const msg = $("signin-msg");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      msg.className = "form-msg err";
      msg.textContent = "Enter a valid email address.";
      return;
    }
    $("signin-submit").disabled = true;
    const error = await sendSignInEmail(email);
    if (!$("signin-submit")) return; // signed in (or navigated away) meanwhile
    $("signin-submit").disabled = false;
    if (error) {
      msg.className = "form-msg err";
      msg.textContent = error;
    } else if (!state.session) {
      renderCheckEmail();
    }
  });
}

// Returns an error message, or null once the email is on its way.
async function sendSignInEmail(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname },
  });
  if (error) return error.message || "Couldn't send the email. Try again.";
  signInState.email = email;
  signInState.sentAt = Date.now();
  return null;
}

// After the email is sent: sign in with the code from it (handy when the link
// opens in a different browser, or a mail scanner has used it up), plus help
// finding an email that went to spam.
function renderCheckEmail() {
  const email = signInState.email;
  const from = cfg.authEmailFrom;
  $("main").innerHTML =
    `<div class="panel auth-panel"><h2>check your email</h2>` +
    `<p>We sent a sign-in email to <strong>${esc(email)}</strong>${from ? ` from <strong>${esc(from)}</strong>` : ""}. ` +
    `Click the link in it, or type the code from it here:</p>` +
    `<form id="code-form" novalidate>` +
    `<input class="field code-field" id="signin-code" inputmode="numeric" autocomplete="one-time-code" ` +
    `maxlength="10" placeholder="123456" aria-label="Sign-in code">` +
    `<button class="btn-primary" type="submit" id="code-submit" style="width:100%">Sign in</button>` +
    `<div class="form-msg" id="code-msg" role="status" aria-live="polite"></div></form>` +
    `<div class="auth-help"><div class="auth-help-title">Don't see it?</div><ul>` +
    `<li>Give it a minute, then check <strong>Spam</strong> or <strong>Junk</strong>` +
    `, plus Gmail's <strong>Promotions</strong> tab or Outlook's <strong>Other</strong> tab.</li>` +
    `<li>Search your mail for <strong>CFBx</strong>.</li>` +
    `<li>Found it in spam? Mark it <strong>Not spam</strong>${from ? ` and add ${esc(from)} to your contacts` : ""}, so the next one lands in your inbox.</li>` +
    `</ul></div>` +
    `<div class="auth-actions">` +
    `<button class="btn-secondary" type="button" id="code-resend"></button>` +
    `<button class="link-btn" type="button" id="code-change">Use a different email</button>` +
    `</div></div>`;

  const resend = $("code-resend");
  const tick = () => {
    if (!resend.isConnected) return clearInterval(timer);
    const left = Math.ceil((signInState.sentAt + RESEND_WAIT_S * 1000 - Date.now()) / 1000);
    resend.disabled = left > 0;
    resend.textContent = left > 0 ? `Resend in ${left}s` : "Resend email";
  };
  const timer = setInterval(tick, 1000);
  tick();

  resend.addEventListener("click", async () => {
    resend.disabled = true;
    const error = await sendSignInEmail(email);
    const msg = $("code-msg");
    if (!msg) return;
    msg.className = error ? "form-msg err" : "form-msg ok";
    msg.textContent = error || "Sent again. Only the newest email's code and link will work.";
    tick();
  });

  $("code-change").addEventListener("click", () => {
    signInState.email = null;
    renderSignIn();
  });

  $("code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = $("signin-code").value.replace(/\D/g, "");
    const msg = $("code-msg");
    if (token.length < 6) {
      msg.className = "form-msg err";
      msg.textContent = "Enter the code from the email (at least 6 digits).";
      return;
    }
    $("code-submit").disabled = true;
    const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
    if (!$("code-submit")) return;
    $("code-submit").disabled = false;
    if (error) {
      msg.className = "form-msg err";
      msg.textContent = "That code didn't work. It may have expired or been replaced by a newer email.";
    }
    // On success onAuthStateChange takes over and leaves this page.
  });
}

/* ---------- Boot ---------- */

async function boot() {
  window.addEventListener("hashchange", onRouteChange);
  // A logo that fails to load (missing, blocked, offline) shows the helmet.
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.classList.contains("team-logo")) return;
      const fallback = img.nextElementSibling;
      if (fallback) {
        fallback.removeAttribute("hidden");
        img.remove();
      } else {
        (img.closest(".mini-mark") || img).remove(); // icon-only: leave no gap
      }
    },
    true
  );

  if (supabase) {
    const { data } = await supabase.auth.getSession();
    state.session = data.session;
    supabase.auth.onAuthStateChange((event, session) => {
      const changed = (session?.user?.id || null) !== (state.session?.user?.id || null);
      state.session = session;
      if (changed) {
        // Defer: supabase-js recommends not awaiting its own calls inside this callback.
        setTimeout(async () => {
          await loadAccount();
          if (parseRoute().page === "leaderboard") await loadLeaderboard();
          if (session) signInState.email = null;
          if (session && parseRoute().page === "signin") location.hash = "#/";
          else render();
        }, 0);
      }
    });
  }

  await Promise.all([loadTeams(), loadAccount()]);
  await onRouteChange();

  // Prices only move when games finish, so refreshing on focus is enough.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    await Promise.all([loadTeams(), loadAccount()]);
    const route = parseRoute();
    if (route.page === "detail") await loadDetail(route.ticker);
    if (route.page === "leaderboard") await loadLeaderboard();
    render();
  });
}

boot();
