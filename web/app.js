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
// Portfolio return periods (GET /me/returns), in button order.
const RETURN_PERIODS = [
  { key: "week", short: "1W", long: "Past week" },
  { key: "month", short: "1M", long: "Past month" },
  { key: "3months", short: "3M", long: "Past 3 months" },
  { key: "season", short: "Season", long: "This season, from Week 0" },
  { key: "ytd", short: "YTD", long: "Year to date" },
  { key: "all", short: "All-time", long: "All time" },
];

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
  payouts: [], // season payouts received
  returns: [], // gain or loss per period, from GET /me/returns
  compete: null, // { data, error } from GET /competitions
  competition: null, // { code, data, error } for one competition
  fund: null, // { name, data, error } for a fund card
  myFund: null, // GET /me/fund
  detail: null, // { id, data, error } for the team detail view
  leaderboard: null, // { data, error } from GET /leaderboard
  editingName: false,
  view: { conf: "all", q: "", priceMode: "week", returnsPeriod: "week", layout: "grid", ...loadPrefs() },
  tradePending: false,
  tradeQty: {}, // ticker -> share count being typed in the trade box
  options: { positions: [], activity: [] }, // the player's options
  optView: { expiry: "weekly", kind: "call", seriesId: null, qty: "1" },
};

// Teams are shown by name and ticker (Georgia GA). The internal id (UGA)
// stays behind the scenes: it's what trades and records point at.
const tick = (id) => state.teams.get(id)?.ticker || id;
const teamHref = (id) => `#/team/${encodeURIComponent(tick(id))}`;
const teamLabel = (id) => {
  const t = state.teams.get(id);
  return t ? `${esc(t.name)} <span class="tk-inline">${esc(tick(id))}</span>` : esc(id);
};

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return {
      conf: p.conf || "all",
      priceMode: p.priceMode === "season" ? "season" : "week",
      returnsPeriod: RETURN_PERIODS.some((r) => r.key === p.returnsPeriod) ? p.returnsPeriod : "week",
      layout: p.layout === "list" ? "list" : "grid",
    };
  } catch {
    return {};
  }
}
function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        conf: state.view.conf,
        priceMode: state.view.priceMode,
        returnsPeriod: state.view.returnsPeriod,
        layout: state.view.layout,
      })
    );
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
  position_limit: "You can own at most 1,000 shares, and 1,000 options, of any one team.",
  options_limit: "Options are capped at 25% of your net worth.",
  options_paused: "This team's options are paused while its game is on. They reopen after the final.",
  option_expired: "That option has expired.",
  insufficient_options: "You don't own that many of this option.",
  unknown_option: "That option isn't listed anymore.",
  unknown_competition: "That competition doesn't exist. Check the link.",
  competition_closed: "This competition is closed to new entries.",
  display_name_required: "Name your fund first. That's the name shown in standings.",
  invalid_league_name: "League names are 3–40 characters.",
  league_name_not_allowed: "That league name isn't allowed. Please pick another.",
  invalid_league_length: "Pick how long the league runs.",
  league_limit: "You can run at most 5 leagues at a time.",
  unknown_fund: "No fund by that name.",
};
const errorText = (err) => ERROR_TEXT[err.code] || "Something went wrong. Please try again.";

/* ---------- Data loading ---------- */

async function loadTeams() {
  try {
    const data = await api("/teams");
    state.teams = new Map(data.teams.map((t) => [t.id, t]));
    state.byTicker = new Map(data.teams.filter((t) => t.ticker).map((t) => [t.ticker, t.id]));
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
    state.payouts = [];
    state.returns = [];
    state.myFund = null;
    state.options = { positions: [], activity: [] };
    return;
  }
  try {
    const [me, holdings, txs, payouts, options, returns, fund] = await Promise.all([
      api("/me", { auth: true }),
      api("/me/holdings", { auth: true }),
      api("/me/transactions?limit=25", { auth: true }),
      api("/me/payouts", { auth: true }),
      api("/me/options", { auth: true }),
      api("/me/returns", { auth: true }),
      api("/me/fund", { auth: true }).catch(() => null),
    ]);
    state.myFund = fund;
    state.returns = returns.returns;
    state.options = options;
    state.me = me;
    state.holdings = new Map(holdings.holdings.map((h) => [h.team_id, h]));
    state.transactions = txs.transactions;
    state.payouts = payouts.payouts;
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
  state.detail = { id, data: null, error: null, options: null, mine: null };
  try {
    const [data] = await Promise.all([api(`/teams/${encodeURIComponent(id)}`), loadOptions(id), loadMine(id)]);
    state.detail.data = data;
  } catch (err) {
    if (state.detail?.id === id) state.detail.error = err;
  }
}

// Your position, total return and history for this team (signed in only).
async function loadMine(id) {
  if (!state.session) return;
  try {
    const mine = await api(`/me/teams/${encodeURIComponent(id)}`, { auth: true });
    if (state.detail?.id === id) state.detail.mine = mine;
  } catch {
    // Not critical: the page still works without it.
  }
}

// A team's options board (house quotes); refreshed with prices.
async function loadOptions(id) {
  try {
    const board = await api(`/teams/${encodeURIComponent(id)}/options`);
    if (state.detail?.id === id) state.detail.options = board;
  } catch {
    if (state.detail?.id === id) state.detail.options = { error: true };
  }
}

/* ---------- Routing ---------- */

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [page, arg] = hash.split("/");
  if (page === "team" && arg) {
    // Links use the ticker (#/team/GA); older links with the id (#/team/UGA) still work.
    const key = decodeURIComponent(arg).toUpperCase();
    return { page: "detail", ticker: state.byTicker?.get(key) || key };
  }
  if (page === "portfolio") return { page: "portfolio" };
  if (page === "leaderboard") return { page: "leaderboard" };
  if (page === "compete" && arg) return { page: "competition", code: decodeURIComponent(arg).toLowerCase() };
  if (page === "compete") return { page: "compete" };
  if (page === "fund" && arg) return { page: "fund", name: decodeURIComponent(arg) };
  if (page === "signin") return { page: "signin" };
  return { page: "market" };
}

async function onRouteChange() {
  const route = parseRoute();
  if (route.page === "detail" && state.detail?.id !== route.ticker) {
    state.detail = { id: route.ticker, data: null, error: null, options: null, mine: null };
    render();
    await loadDetail(route.ticker);
  }
  if (route.page === "leaderboard") {
    state.editingName = false;
    if (!state.leaderboard) render(); // show the loading state on first visit
    await loadLeaderboard();
  }
  if (route.page === "compete" || route.page === "competition" || route.page === "fund") {
    state.editingName = false;
    render(); // loading state
    await loadRoutePage(route);
  }
  render();
  window.scrollTo(0, 0);
}

// Data for the compete, competition and fund pages.
async function loadRoutePage(route = parseRoute()) {
  if (route.page === "compete") {
    try {
      const [data, opts] = await Promise.all([
        api("/competitions", { auth: "optional" }),
        api("/leagues/options").catch(() => null),
      ]);
      state.compete = { data, leagueOptions: opts?.options || null, error: null };
    } catch (err) {
      state.compete = { data: state.compete?.data || null, error: err };
    }
  } else if (route.page === "competition") {
    const keep = state.competition?.code === route.code ? state.competition.data : null;
    state.competition = { code: route.code, data: keep, error: null };
    try {
      const data = await api(`/competitions/${encodeURIComponent(route.code)}`, { auth: "optional" });
      if (state.competition.code === route.code) state.competition.data = data;
    } catch (err) {
      if (state.competition.code === route.code) state.competition.error = err;
    }
  } else if (route.page === "fund") {
    const keep = state.fund?.name === route.name ? state.fund.data : null;
    state.fund = { name: route.name, data: keep, error: null };
    try {
      const data = await api(`/funds/${encodeURIComponent(route.name)}`);
      if (state.fund.name === route.name) state.fund.data = data;
    } catch (err) {
      if (state.fund.name === route.name) state.fund.error = err;
    }
  }
}

/* ---------- Rendering: chrome ---------- */

function renderTape() {
  const list = [...state.teams.values()];
  const items = list
    .map((t) => {
      const ch = t.last_change_pct;
      const arrow = ch > 0 ? "▲" : ch < 0 ? "▼" : "–";
      return (
        `<span class="tape-item"><span class="tk">${esc(tick(t.id))}</span>` +
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
  $("tab-leaderboard").classList.toggle("active", route.page === "leaderboard" || route.page === "fund");
  $("tab-compete").classList.toggle("active", route.page === "compete" || route.page === "competition");

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
  else if (route.page === "compete") renderCompete();
  else if (route.page === "competition") renderCompetition();
  else if (route.page === "fund") renderFund();
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
    `<p>${all.length} programs, ranked by current price. Prices move on final scores, football news and every trade. Tap a team to trade.</p></div></div>` +
    `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px;align-items:center">` +
    `<input type="search" id="mkt-search" aria-label="Search programs" placeholder="Search team, mascot, or ticker…" value="${esc(state.view.q)}" style="flex:1;min-width:180px;background:var(--bg-panel-alt);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;padding:9px 12px">` +
    `<select id="mkt-conf" aria-label="Conference" style="background:var(--bg-panel-alt);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13.5px;padding:9px 10px">${confOptions}</select>` +
    `<nav class="tabs" id="mkt-pricemode">` +
    `<button data-mode="week" class="${mode === "week" ? "active" : ""}">This Week</button>` +
    `<button data-mode="season" class="${mode === "season" ? "active" : ""}">Season</button>` +
    `</nav>` +
    `<nav class="tabs" id="mkt-layout" aria-label="Layout">` +
    ["grid", "list"]
      .map(
        (l) =>
          `<button data-layout="${l}" class="${state.view.layout === l ? "active" : ""}" aria-pressed="${state.view.layout === l}" title="${l === "grid" ? "Grid" : "List"} view">` +
          `${LAYOUT_ICON[l]}<span>${l === "grid" ? "Grid" : "List"}</span></button>`
      )
      .join("") +
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
  document.querySelectorAll("#mkt-layout button").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.view.layout = btn.dataset.layout;
      savePrefs();
      document.querySelectorAll("#mkt-layout button").forEach((b) => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-pressed", String(b === btn));
      });
      renderGrid();
    })
  );
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
          (t.ticker || "").toLowerCase().includes(q) ||
          (t.mascot || "").toLowerCase().includes(q))
    )
    .sort((a, b) => b.current_price - a.current_price);

  if (!teams.length) {
    $("mkt-grid").innerHTML = `<div class="panel"><div class="empty-state">No programs match that search.</div></div>`;
    return;
  }
  if (state.view.layout === "list") {
    $("mkt-grid").innerHTML = marketList(teams);
    return;
  }

  const cards = teams
    .map((t) => {
      const pct = headlinePct(t);
      const held = state.holdings.get(t.id);
      const hist = t.history && t.history.length ? t.history : [t.current_price];
      const stroke = hist[hist.length - 1] >= hist[0] ? "var(--positive)" : "var(--negative)";
      return (
        `<a class="card" href="${teamHref(t.id)}" style="--tag-color:${safeColor(t.primary_color, "#E8A33D")}">` +
        `<div class="card-top"><div style="display:flex;align-items:center;gap:10px">` +
        teamMark(t, 44) +
        `<div><div class="tn">${esc(t.name)} <span class="tk">${esc(tick(t.id))}</span>${t.live_status ? ` <span class="live-tag">LIVE</span>` : ""}</div>` +
        `${t.mascot ? `<div class="nm">${esc(t.mascot)}</div>` : ""}${recordLine(t)}</div>` +
        `</div>${held ? `<span class="held-badge">${held.shares} sh</span>` : ""}</div>` +
        `<div class="card-mid"><div class="px">$${t.current_price.toFixed(2)}</div>` +
        `<div style="text-align:right"><div class="ch ${dirClass(pct)}">${fmtPct(pct)}</div>${coverTag(t)}</div></div>` +
        `<svg class="spark" viewBox="0 0 220 36" preserveAspectRatio="none" aria-hidden="true">` +
        `<polyline points="${sparklinePath(hist, 220, 36)}" fill="none" stroke="${stroke}" stroke-width="2"/></svg>` +
        `</a>`
      );
    })
    .join("");

  $("mkt-grid").innerHTML = `<div class="grid">${cards}</div>`;
}

const LAYOUT_ICON = {
  grid:
    `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="currentColor">` +
    `<rect x="0" y="0" width="6" height="6" rx="1"/><rect x="8" y="0" width="6" height="6" rx="1"/>` +
    `<rect x="0" y="8" width="6" height="6" rx="1"/><rect x="8" y="8" width="6" height="6" rx="1"/></svg>`,
  list:
    `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="currentColor">` +
    `<rect x="0" y="1" width="14" height="2.5" rx="1"/><rect x="0" y="5.75" width="14" height="2.5" rx="1"/>` +
    `<rect x="0" y="10.5" width="14" height="2.5" rx="1"/></svg>`,
};

// The market as one row per team: rank, team, record, price, change, trend.
function marketList(teams) {
  const rows = teams
    .map((t, i) => {
      const pct = headlinePct(t);
      const held = state.holdings.get(t.id);
      const hist = t.history && t.history.length ? t.history : [t.current_price];
      const stroke = hist[hist.length - 1] >= hist[0] ? "var(--positive)" : "var(--negative)";
      return (
        `<a class="mkt-row" role="row" href="${teamHref(t.id)}" style="--tag-color:${safeColor(t.primary_color, "#E8A33D")}">` +
        `<span class="mr-rank" role="cell">${i + 1}</span>` +
        `<span class="mr-team" role="cell">${teamMark(t, 30)}<span class="mr-names">` +
        `<span class="tn">${esc(t.name)} <span class="tk">${esc(tick(t.id))}</span>` +
        `${t.live_status ? ` <span class="live-tag">LIVE</span>` : ""}${held ? ` <span class="held-badge">${held.shares} sh</span>` : ""}</span>` +
        `<span class="mr-sub">${esc(t.conference)}${t.mascot ? `<span class="mr-mascot"> &middot; ${esc(t.mascot)}</span>` : ""}</span></span></span>` +
        `<span class="mr-rec" role="cell">${t.records ? `${overallRec(t.records)} <span class="mr-ats">ATS ${atsRec(t.records)}</span>` : ""}</span>` +
        `<span class="mr-px" role="cell">$${t.current_price.toFixed(2)}</span>` +
        `<span class="mr-ch" role="cell"><span class="ch ${dirClass(pct)}">${fmtPct(pct)}</span>${coverTag(t)}</span>` +
        `<span class="mr-spark" role="cell"><svg viewBox="0 0 90 26" preserveAspectRatio="none" aria-hidden="true">` +
        `<polyline points="${sparklinePath(hist, 90, 26)}" fill="none" stroke="${stroke}" stroke-width="1.6"/></svg></span>` +
        `</a>`
      );
    })
    .join("");
  return (
    `<div class="mkt-list" role="table" aria-label="Market">` +
    `<div class="mkt-row mkt-head" role="row"><span role="columnheader">#</span><span role="columnheader">program</span>` +
    `<span class="mr-rec" role="columnheader">record</span><span class="mr-px" role="columnheader">price</span>` +
    `<span class="mr-ch" role="columnheader">${state.view.priceMode === "season" ? "season" : "last game"}</span>` +
    `<span class="mr-spark" role="columnheader">trend</span></div>` +
    rows +
    `</div>`
  );
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

// Week labels. Postseason games restart at week 1, so they get a name instead.
const isPostseason = (g) => g.season_type === "postseason";
const isPlayoff = (g) => /playoff|cfp|national championship/i.test(g.notes || "");
const weekLong = (g) => (isPostseason(g) ? (isPlayoff(g) ? "Playoff" : "Bowl") : `Week ${g.week}`);
const weekShort = (g) => (isPostseason(g) ? (isPlayoff(g) ? "CFP" : "Bowl") : `W${g.week}`);

// One point per price: the opening price, then the price after each game.
function chartPoints(d) {
  const games = d.game_log.slice().reverse(); // oldest first
  const points = [
    { label: "Open", price: d.price_history[0], event: null },
    ...games.map((e) => ({ label: weekShort(e), price: e.price_after, event: e })),
  ];
  // Trading and news move the price between games: end on where it is now.
  const now = state.teams.get(d.team.id)?.current_price ?? d.team.current_price;
  if (Math.abs(now - points[points.length - 1].price) >= 0.005) points.push({ label: "Now", price: now, event: null, now: true });
  return points;
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
  if (p.now) return `Now $${p.price.toFixed(2)}`;
  if (!p.event) return `Opening price $${p.price.toFixed(2)}`;
  const e = p.event;
  const result = e.team_score > e.opp_score ? "won" : e.team_score < e.opp_score ? "lost" : "tied";
  return `${weekLong(e)}, ${result} ${e.team_score}-${e.opp_score} vs ${e.opponent_name || e.opponent_id}: $${p.price.toFixed(2)}, ${fmtPct(e.pct_change)}`;
}

function tipHtml(p) {
  if (p.now) {
    return `<div class="tip-head">Now</div><div class="tip-price">$${p.price.toFixed(2)}</div><div class="tip-note">After trading and news since the last game</div>`;
  }
  if (!p.event) {
    return `<div class="tip-head">Opening price</div><div class="tip-price">$${p.price.toFixed(2)}</div><div class="tip-note">Program Prestige Score</div>`;
  }
  const e = p.event;
  const opp = esc(e.opponent_name || e.opponent_id);
  const res = e.team_score > e.opp_score ? "W" : e.team_score < e.opp_score ? "L" : "T";
  return (
    `<div class="tip-head">${weekLong(e)} &middot; ${res} ${e.team_score}-${e.opp_score} vs ${opp}</div>` +
    (e.notes ? `<div class="tip-note">${esc(e.notes)}</div>` : "") +
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
    `<div class="log-item"><span class="lw">${weekLong(e)}</span> &middot; ${e.notes ? `<strong>${esc(e.notes)}</strong>: ` : ""}${text}${summary}${proj} ` +
    `<span class="ld ch ${e.pct_change >= 0 ? "up" : "down"}">${fmtPct(e.pct_change)}</span> ` +
    `<span class="log-price">&rarr; $${e.price_after.toFixed(2)}</span></div>`
  );
}

// A price move between games: a line move, a poll, and so on.
function newsItem(m) {
  const when = new Date(m.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    `<div class="log-item"><span class="lw">${esc(when)}</span> &middot; ${esc(m.summary)} ` +
    `<span class="ld ch ${m.pct_change >= 0 ? "up" : "down"}">${fmtPct(m.pct_change)}</span> ` +
    `<span class="log-price">&rarr; $${m.price_after.toFixed(2)}</span></div>`
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
    `<div class="upcoming-item"><span><span class="lw" style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint)">${isPostseason(g) ? weekShort(g) : `Wk ${g.week}`}</span> ` +
    `${g.is_home ? "vs" : "@"} <a class="opp" href="${teamHref(g.opponent_id)}">${esc(oppName)}</a>` +
    `${g.notes ? ` <span class="up-note">${esc(g.notes)}</span>` : ""}</span>` +
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
      ? `${held.shares} shares @ avg $${held.avg_cost.toFixed(2)} &middot; worth ${fmtMoney(held.market_value)} if sold now`
      : "No position yet.";
    tradePanel =
      `<div class="trade-form">` +
      `<div class="trade-row"><input type="number" id="trade-qty" aria-label="Shares" min="1" step="1" inputmode="numeric" placeholder="Shares" value="${esc(state.tradeQty[ticker] ?? "1")}"></div>` +
      `<div class="trade-summary"><span>Buy total</span><strong id="trade-cost">…</strong></div>` +
      `<div class="trade-quote" id="trade-quote"></div>` +
      `<div class="trade-buttons">` +
      `<button class="btn-buy" id="btn-buy">Buy</button>` +
      `<button class="btn-sell" id="btn-sell"${heldShares < 1 ? " disabled" : ""}>Sell</button></div>` +
      `<div class="position-note">${positionNote}</div>` +
      `<div class="position-note">Buying power: ${fmtMoney(cash)} (~${Math.floor(cash / t.current_price)} sh)</div>` +
      `<div class="stale-note">Every trade moves the price: buying nudges it up and selling nudges it down, ` +
      `so a big order fills at a slightly higher (or lower) average. Buy and sell prices differ by 0.5%.</div>` +
      `</div>`;
  }

  $("main").innerHTML =
    `<a class="detail-back" href="#/">&larr; Back to market</a>` +
    `<div class="detail-head"><div style="display:flex;align-items:center;gap:16px">` +
    teamMark(t, 84) +
    `<div class="tk-name"><div class="tk">${esc(t.conference)} &middot; STRENGTH ${t.strength}</div>` +
    `<h1>${esc(t.name)} <span class="h1-tk">${esc(tick(t.id))}</span></h1>${t.mascot ? `<div class="nm">${esc(t.mascot)}</div>` : ""}${recordChips(t)}</div></div>` +
    `<div class="detail-price">` +
    `<nav class="tabs" id="detail-pricemode" style="margin-bottom:8px;display:inline-flex">` +
    `<button data-mode="week" class="${mode === "week" ? "active" : ""}" style="padding:5px 11px;font-size:12px">Week</button>` +
    `<button data-mode="season" class="${mode === "season" ? "active" : ""}" style="padding:5px 11px;font-size:12px">Season</button></nav>` +
    `<div class="px">$${t.current_price.toFixed(2)}</div>` +
    `<div class="ch ${dirClass(pct)}">${fmtPct(pct)}${mode === "season" ? ` since IPO ($${t.ipo_price.toFixed(2)})` : " last game"}</div>` +
    (t.live_status
      ? `<div class="live-line"><span class="live-tag">LIVE</span> ${esc(t.live_status)}</div>` +
        `<div class="position-note" style="margin-top:4px">Price is moving with the score. The final result settles it.</div>`
      : lastGame) +
    `</div></div>` +
    positionBox(t) +
    `<div class="detail-body">` +
    `<div class="panel"><h2>price history</h2><div class="chart-wrap">${panelBody((d) => priceChart(chartPoints(d)))}</div></div>` +
    `<div class="panel"><h2>trade</h2>${tradePanel}</div>` +
    `</div>` +
    `<div class="panel options-panel" style="margin-top:16px"><h2>options</h2>${optionsPanel(t)}</div>` +
    historyPanel(t) +
    `<div class="detail-body" style="margin-top:16px">` +
    `<div class="panel"><h2>game log</h2><div class="log-list">${panelBody((d) =>
      d.game_log.length ? d.game_log.map(gameLogItem).join("") : `<div class="log-item">No games played yet this season.</div>`
    )}</div></div>` +
    `<div class="panel"><h2>up next</h2><div class="upcoming-list">${panelBody((d) =>
      d.upcoming.length
        ? d.upcoming.slice(0, 5).map((g) => upcomingItem(t, g)).join("")
        : `<div class="log-item">No more games scheduled.</div>`
    )}</div></div>` +
    `</div>` +
    (data?.news?.length
      ? `<div class="panel" style="margin-top:16px"><h2>market news</h2><div class="log-list">${data.news.map(newsItem).join("")}</div></div>`
      : "");

  if (data) bindPriceChart($("main"), chartPoints(data));
  bindOptionsPanel(t);

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
  // Live quotes: what this many shares would actually fill at right now.
  let quoteSeq = 0;
  let quoteTimer = null;
  async function refreshQuote() {
    const q = qty();
    const seq = ++quoteSeq;
    $("btn-buy").disabled = true;
    $("btn-sell").disabled = state.tradePending || q < 1 || q > heldShares;
    if (q < 1) {
      $("trade-cost").textContent = "—";
      $("trade-quote").textContent = "";
      return;
    }
    try {
      const path = (side) => `/quote?team_id=${encodeURIComponent(ticker)}&side=${side}&shares=${q}`;
      const [buy, sell] = await Promise.all([api(path("buy")), q <= heldShares ? api(path("sell")) : null]);
      if (seq !== quoteSeq || !$("trade-cost")) return; // superseded, or the page changed
      $("trade-cost").textContent = fmtMoney(buy.amount);
      $("trade-quote").innerHTML =
        `Avg $${buy.avg_price.toFixed(2)}/share &middot; price after: $${buy.price_after.toFixed(2)}` +
        (sell ? `<br>Sell ${q}: ${fmtMoney(sell.amount)} (avg $${sell.avg_price.toFixed(2)})` : "");
      $("btn-buy").disabled = state.tradePending || buy.amount > cash;
    } catch (err) {
      if (seq !== quoteSeq || !$("trade-cost")) return;
      $("trade-cost").textContent = "—";
      $("trade-quote").textContent = errorText(err);
    }
  }
  qtyInput.addEventListener("input", () => {
    state.tradeQty[ticker] = qtyInput.value; // survives the periodic re-render
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(refreshQuote, 200);
  });
  refreshQuote();
  $("btn-buy").addEventListener("click", () => trade(ticker, "buy", qty()));
  $("btn-sell").addEventListener("click", () => trade(ticker, "sell", qty()));
}

/* ---------- Your stake in a team ---------- */

// Total return on everything you've done with this team: what you've taken
// out (sales, option sales and payouts) plus what you hold now (at what it
// would sell for), minus what you've put in.
function positionBox(t) {
  const m = state.detail?.id === t.id ? state.detail.mine : null;
  if (!m || m.invested <= 0) return "";
  const up = m.total_return >= 0;
  const card = (label, val, cls = "") =>
    `<div class="summary-card"><div class="label">${label}</div><div class="val ${cls}">${val}</div></div>`;
  const held = m.shares_value + m.options_value;
  return (
    `<div class="panel position-box"><h2>your position</h2><div class="summary-row${m.options_qty ? "" : " two"}">` +
    card(
      "total return",
      `${up ? "+" : "-"}${fmtMoney(Math.abs(m.total_return))}` +
        (m.total_return_pct === null ? "" : ` <span class="pct">(${fmtPct(m.total_return_pct)})</span>`),
      `ch ${up ? "up" : "down"}`
    ) +
    card(
      "shares value",
      m.shares
        ? `${fmtMoney(m.shares_value)}<div class="sub">${m.shares} share${m.shares === 1 ? "" : "s"} @ $${m.avg_cost.toFixed(2)} avg</div>`
        : `$0.00<div class="sub">no shares held</div>`
    ) +
    // Only when you hold options on this team.
    (m.options_qty
      ? card(
          "options value",
          `${fmtMoney(m.options_value)}<div class="sub">${m.options_qty} option${m.options_qty === 1 ? "" : "s"} at the buy-back price</div>`
        )
      : "") +
    `</div><div class="stale-note" style="margin-top:8px">Put in ${fmtMoney(m.invested)} &middot; taken out ${fmtMoney(m.returned)} ` +
    `(sales, options and payouts) &middot; holding ${fmtMoney(held)}</div></div>`
  );
}

function historyPanel(t) {
  const m = state.detail?.id === t.id ? state.detail.mine : null;
  if (!m || !m.history.length) return "";
  const item = (h) => {
    const when = new Date(h.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    let what;
    let amount = fmtMoney(h.amount);
    let cls = "";
    if (h.kind === "shares") {
      what = `${h.side === "buy" ? "Bought" : "Sold"} ${h.qty} share${h.qty === 1 ? "" : "s"} @ $${h.price.toFixed(2)}`;
      if (h.side === "sell") cls = "ch up";
    } else if (h.kind === "option") {
      const contract = `${fmtStrike(h.strike)} ${h.option_kind}${h.qty === 1 ? "" : "s"}`;
      if (h.side === "settle") {
        what = h.amount > 0 ? `${h.qty} ${contract} settled: paid $${h.price.toFixed(2)} each` : `${h.qty} ${contract} expired worthless`;
        amount = h.amount > 0 ? `+${fmtMoney(h.amount)}` : "$0.00";
        if (h.amount > 0) cls = "ch up";
      } else {
        what = `${h.side === "buy" ? "Bought" : "Sold"} ${h.qty} ${contract} @ $${h.price.toFixed(2)}`;
        if (h.side === "sell") cls = "ch up";
      }
    } else {
      what = `Payout: ${esc(h.summary)} (${h.qty} sh &times; $${h.price.toFixed(2)})`;
      amount = `+${fmtMoney(h.amount)}`;
      cls = "ch up";
    }
    return `<div class="log-item"><span class="lw">${esc(when)}</span> &middot; ${what} <span class="ld ${cls}">${amount}</span></div>`;
  };
  return (
    `<div class="panel" style="margin-top:16px"><h2>your history</h2>` +
    `<div class="log-list">${m.history.map(item).join("")}</div></div>`
  );
}

/* ---------- Options ---------- */

const fmtStrike = (n) => `$${Number(n).toFixed(n % 1 ? 2 : 0)}`;
function expiryLabel(o) {
  if (o.expiry_kind === "season") {
    return o.expires_at ? `Season (settles ${fmtExpiry(o.expires_at)})` : "Season (settles after the national title game)";
  }
  return fmtExpiry(o.expires_at);
}
function fmtExpiry(ts) {
  return (
    new Date(ts).toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", timeZone: "America/New_York",
    }) + " ET"
  );
}
const contractLabel = (o) => `${o.team_id ? tick(o.team_id) + " " : ""}${fmtStrike(o.strike)} ${o.kind}`;

function optionsPanel(t) {
  const board = state.detail?.id === t.id ? state.detail.options : null;
  if (!board) return `<div class="loading" style="padding:20px">Loading…</div>`;
  if (board.error) return `<div class="log-item">Couldn't load options. They'll retry shortly.</div>`;
  if (!board.options.length) return `<div class="log-item">Options for ${esc(t.name)} will be listed shortly.</div>`;

  const v = state.optView;
  const weekly = board.options.find((o) => o.expiry_kind === "weekly");
  const list = board.options.filter((o) => o.expiry_kind === v.expiry && o.kind === v.kind);
  if (!list.some((o) => o.id === v.seriesId)) {
    // Default to the strike nearest the football price.
    const near = list.slice().sort((a, b) => Math.abs(a.strike - board.football_price) - Math.abs(b.strike - board.football_price))[0];
    v.seriesId = near?.id ?? null;
  }
  const owned = new Map(state.options.positions.map((p) => [p.series_id, p.qty]));
  const tab = (group, value, label) =>
    `<button data-${group}="${value}" class="${v[group] === value ? "active" : ""}">${esc(label)}</button>`;

  const rows = list
    .map((o) => {
      const sel = o.id === v.seriesId;
      const itm = o.kind === "call" ? board.football_price > o.strike : board.football_price < o.strike;
      return (
        `<tr class="opt-row${sel ? " selected" : ""}" data-series="${o.id}" aria-selected="${sel}">` +
        `<td class="opt-strike">${fmtStrike(o.strike)}${itm ? ` <span class="itm" title="In the money: worth something if it expired now">ITM</span>` : ""}` +
        `${owned.get(o.id) ? `<div class="own-mobile">${owned.get(o.id)} owned</div>` : ""}</td>` +
        `<td><button type="button" class="opt-px opt-px-buy" data-pick="${o.id}" aria-label="Buy ${fmtStrike(o.strike)} ${o.kind} at $${o.ask.toFixed(2)}">Buy $${o.ask.toFixed(2)}</button></td>` +
        `<td><button type="button" class="opt-px opt-px-sell" data-pick="${o.id}" aria-label="Sell ${fmtStrike(o.strike)} ${o.kind} at $${o.bid.toFixed(2)}">Sell $${o.bid.toFixed(2)}</button></td>` +
        `<td class="opt-own">${owned.get(o.id) || ""}</td></tr>`
      );
    })
    .join("");

  const selected = list.find((o) => o.id === v.seriesId);
  let order;
  if (board.paused) {
    order = `<div class="opt-paused"><span class="live-tag">LIVE</span> Options are paused while ${esc(t.name)} is playing. They reopen after the final.</div>`;
  } else if (!state.session) {
    order = `<div class="position-note">Sign in to trade options.</div>`;
  } else {
    order =
      `<div class="trade-form opt-order">` +
      (selected
        ? `<div class="opt-contract"><strong>${esc(tick(t.id))} ${fmtStrike(selected.strike)} ${selected.kind}</strong> &middot; expires ${esc(expiryLabel(selected))}</div>`
        : "") +
      `<div class="trade-row"><input type="number" id="opt-qty" aria-label="Options" min="1" max="1000" step="1" inputmode="numeric" value="${esc(v.qty)}"></div>` +
      `<div class="opt-summary" id="opt-summary"></div>` +
      `<div class="trade-buttons"><button class="btn-buy" id="opt-buy">Buy</button><button class="btn-sell" id="opt-sell">Sell</button></div>` +
      `</div>`;
  }

  return (
    `<p class="opt-explain">A <strong>call</strong> pays if ${esc(t.name)}'s football price ends <em>above</em> the strike; ` +
    `a <strong>put</strong> pays if it ends <em>below</em>. Each pays the difference per option, in cash, at expiry. ` +
    `<span class="opt-fp">Football price now: <strong>$${board.football_price.toFixed(2)}</strong></span> ` +
    `(the price from games, lines and polls, without trading hype). 1 option = 1 share.</p>` +
    `<div class="opt-tabs"><nav class="tabs" id="opt-expiry">${tab("expiry", "weekly", weekly ? fmtExpiry(weekly.expires_at) : "This week")}${tab("expiry", "season", "Season")}</nav>` +
    `<nav class="tabs" id="opt-kind">${tab("kind", "call", "Calls")}${tab("kind", "put", "Puts")}</nav></div>` +
    `<div class="stale-note" style="margin:10px 0 6px">Tap a price to pick an option. ITM = in the money: it would pay something if it expired now.</div>` +
    `<div class="table-scroll"><table class="holdings opt-table"><thead><tr><th>strike</th><th>buy at</th><th>sell back at</th><th class="opt-own">you own</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>` +
    order
  );
}

function bindOptionsPanel(t) {
  const panel = document.querySelector(".options-panel");
  if (!panel) return;
  const v = state.optView;
  panel.querySelectorAll("[data-expiry], [data-kind]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.expiry) v.expiry = b.dataset.expiry;
      if (b.dataset.kind) v.kind = b.dataset.kind;
      v.seriesId = null;
      renderDetail(t.id);
    })
  );
  // Tapping a row or its Buy/Sell price picks that option and jumps to the order box.
  panel.querySelectorAll(".opt-row").forEach((r) =>
    r.addEventListener("click", () => {
      v.seriesId = Number(r.dataset.series);
      renderDetail(t.id);
      const box = $("opt-qty");
      if (box) {
        box.focus({ preventScroll: true });
        box.select();
        box.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    })
  );

  const qtyInput = $("opt-qty");
  if (!qtyInput) return;
  const board = state.detail.options;
  const o = board.options.find((x) => x.id === v.seriesId);
  const owned = state.options.positions.find((p) => p.series_id === v.seriesId)?.qty || 0;
  const qty = () => (/^\d+$/.test(qtyInput.value.trim()) ? parseInt(qtyInput.value, 10) : 0);
  const update = () => {
    v.qty = qtyInput.value;
    const n = qty();
    const cash = state.me ? state.me.cash : 0;
    $("opt-buy").disabled = state.tradePending || !o || n < 1 || n > 1000 || n * o.ask > cash;
    $("opt-sell").disabled = state.tradePending || !o || n < 1 || n > owned;
    // The buttons say exactly what you'll pay or get: "Buy 6 @ $1.02".
    $("opt-buy").textContent = o && n > 0 ? `Buy ${n} @ $${o.ask.toFixed(2)}` : "Buy";
    $("opt-sell").textContent = o && n > 0 ? `Sell ${n} @ $${o.bid.toFixed(2)}` : "Sell";
    if (!o || n < 1) {
      $("opt-summary").textContent = "";
      return;
    }
    const cost = n * o.ask;
    const breakeven = o.kind === "call" ? o.strike + o.ask : o.strike - o.ask;
    $("opt-summary").innerHTML =
      `Buy ${n} ${fmtStrike(o.strike)} ${o.kind}${n === 1 ? "" : "s"}: <strong>${fmtMoney(cost)}</strong>. ` +
      `Pays $1 per option for every $1 the football price ends ${o.kind === "call" ? "above" : "below"} ${fmtStrike(o.strike)}; ` +
      `breaks even ${o.kind === "call" ? "above" : "below"} $${breakeven.toFixed(2)}. Most you can lose: ${fmtMoney(cost)}.` +
      (owned ? `<br>You own ${owned}. Selling back pays $${o.bid.toFixed(2)} each.` : "");
  };
  qtyInput.addEventListener("input", update);
  update();
  $("opt-buy").addEventListener("click", () => optionTrade(t.id, v.seriesId, "buy", qty()));
  $("opt-sell").addEventListener("click", () => optionTrade(t.id, v.seriesId, "sell", qty()));
}

async function optionTrade(ticker, seriesId, side, qty) {
  if (state.tradePending || !seriesId || qty < 1) return;
  state.tradePending = true;
  try {
    const r = await api("/options/trade", { method: "POST", auth: true, body: { series_id: seriesId, side, qty } });
    toast(`${side === "buy" ? "Bought" : "Sold"} ${r.qty} ${tick(r.team_id)} ${fmtStrike(r.strike)} ${r.kind}${r.qty === 1 ? "" : "s"} @ $${r.price.toFixed(2)} · ${fmtMoney(r.amount)}`);
    await Promise.all([loadAccount(), loadOptions(ticker), loadMine(ticker)]);
  } catch (err) {
    toast(errorText(err), true);
    if (err.status === 401) await loadAccount();
  } finally {
    state.tradePending = false;
    render();
  }
}

async function trade(ticker, side, shares) {
  if (state.tradePending || shares < 1) return;
  state.tradePending = true;
  $("btn-buy").disabled = true;
  $("btn-sell").disabled = true;
  try {
    const r = await api("/trade", { method: "POST", auth: true, body: { team_id: ticker, side, shares } });
    toast(`${side === "buy" ? "Bought" : "Sold"} ${r.shares} ${tick(r.team_id)} @ $${r.price.toFixed(2)} · ${fmtMoney(r.amount)}`);
    // Pull fresh numbers: the server is the authority, and the trade moved the price.
    await Promise.all([loadAccount(), loadTeams(), loadMine(ticker)]);
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
      `<thead><tr><th>program</th><th>shares</th><th>avg cost</th><th>price</th><th>value if sold</th><th>gain / loss</th></tr></thead><tbody>` +
      holdings
        .map((h) => {
          const cost = h.shares * h.avg_cost;
          const gl = h.unrealized_pl;
          const glPct = cost ? round2((gl / cost) * 100) : 0;
          return (
            `<tr><td class="nm-cell"><div class="nm-flex">${miniMark(h.team_id, 32)}<div>` +
            `<a href="${teamHref(h.team_id)}" style="text-decoration:none">${esc(h.name)}</a><br><span class="tk-mini">${esc(tick(h.team_id))}</span></div></div></td>` +
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
            `${x.side === "buy" ? "Bought" : "Sold"} ${x.shares} ${miniMark(x.team_id, 18, { iconOnly: true })}<a href="${teamHref(x.team_id)}">${teamLabel(x.team_id)}</a> @ $${x.price.toFixed(2)} ` +
            `<span class="ld">${fmtMoney(x.amount)}</span></div>`
        )
        .join("") +
      `</div></div>`
    : "";

  const payouts = state.payouts.length
    ? `<div class="panel" style="margin-top:16px"><h2>payouts received</h2><div class="log-list">` +
      state.payouts
        .map(
          (p) =>
            `<div class="log-item"><span class="lw">${esc(new Date(p.paid_at).toLocaleDateString())}</span> &middot; ` +
            `${miniMark(p.team_id, 18, { iconOnly: true })}<a href="${teamHref(p.team_id)}">${teamLabel(p.team_id)}</a> ` +
            `${esc(p.summary)}: ${p.shares} sh &times; $${p.per_share.toFixed(2)} ` +
            `<span class="ld ch up">+${fmtMoney(p.amount)}</span></div>`
        )
        .join("") +
      `</div></div>`
    : "";

  const opt = state.options;
  const optionsBody = opt.positions.length
    ? `<div class="panel table-scroll" style="margin-top:16px"><h2>options</h2><table class="holdings">` +
      `<thead><tr><th>contract</th><th>expires</th><th>qty</th><th>avg cost</th><th>value if sold</th><th>gain / loss</th></tr></thead><tbody>` +
      opt.positions
        .map(
          (p) =>
            `<tr><td class="nm-cell"><a href="${teamHref(p.team_id)}" style="text-decoration:none">${esc(contractLabel(p))}</a>` +
            `${p.paused ? ` <span class="live-tag">LIVE</span>` : ""}</td>` +
            `<td>${esc(expiryLabel(p))}</td><td>${p.qty}</td><td>$${p.avg_cost.toFixed(2)}</td><td>$${p.value.toFixed(2)}</td>` +
            `<td class="ch ${p.unrealized_pl >= 0 ? "up" : "down"}" style="background:none;padding:12px 10px">${p.unrealized_pl >= 0 ? "+" : "-"}$${Math.abs(p.unrealized_pl).toFixed(2)}</td></tr>`
        )
        .join("") +
      `</tbody></table></div>`
    : "";
  const optionsActivity = opt.activity.length
    ? `<div class="panel" style="margin-top:16px"><h2>options activity</h2><div class="log-list">` +
      opt.activity
        .map((a) => {
          const what =
            a.side === "settle"
              ? a.amount > 0
                ? `${esc(contractLabel(a))} settled at $${a.settle_price.toFixed(2)}: paid $${a.price.toFixed(2)} &times; ${a.qty}`
                : `${esc(contractLabel(a))} expired worthless (settled at $${a.settle_price.toFixed(2)})`
              : `${a.side === "buy" ? "Bought" : "Sold"} ${a.qty} ${esc(contractLabel(a))} @ $${a.price.toFixed(2)}`;
          const amount = a.side === "settle" ? (a.amount > 0 ? `+${fmtMoney(a.amount)}` : "$0.00") : fmtMoney(a.amount);
          return (
            `<div class="log-item"><span class="lw">${esc(new Date(a.created_at).toLocaleString())}</span> &middot; ${what} ` +
            `<span class="ld${a.side === "settle" && a.amount > 0 ? " ch up" : ""}">${amount}</span></div>`
          );
        })
        .join("") +
      `</div></div>`
    : "";

  const returns = state.returns.length
    ? `<div class="panel returns-panel"><div class="returns-head"><h2>returns</h2>` +
      `<nav class="tabs" id="returns-tabs" aria-label="Return period">` +
      RETURN_PERIODS.map(
        (p) =>
          `<button data-period="${p.key}" class="${p.key === state.view.returnsPeriod ? "active" : ""}" title="${esc(p.long)}">${esc(p.short)}</button>`
      ).join("") +
      `</nav></div><div id="returns-body">${returnsBody()}</div></div>`
    : "";

  const fund =
    state.myFund && state.me.display_name
      ? `<div class="panel" style="margin-bottom:16px"><div class="returns-head"><h2>your fund</h2>` +
        `<a class="btn-secondary" style="text-decoration:none;padding:5px 11px;font-size:12px" href="${fundHref(state.me.display_name)}">Public fund card</a></div>` +
        fundStatsHtml(state.myFund) +
        `</div>`
      : "";

  $("main").innerHTML = head + standing + summary + returns + fund + body + optionsBody + payouts + optionsActivity + trades;
  document.querySelectorAll("#returns-tabs button").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.view.returnsPeriod = btn.dataset.period;
      savePrefs();
      document.querySelectorAll("#returns-tabs button").forEach((b) => b.classList.toggle("active", b === btn));
      $("returns-body").innerHTML = returnsBody();
    })
  );
}

// The selected period's gain or loss, with where it was measured from.
function returnsBody() {
  const p = RETURN_PERIODS.find((x) => x.key === state.view.returnsPeriod) || RETURN_PERIODS[0];
  const r = state.returns.find((x) => x.period === p.key);
  if (!r) return "";
  const [y, m, d] = r.since.split("-").map(Number);
  const since = new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const from =
    p.key === "all"
      ? `Since you joined on ${since}`
      : r.joined
        ? `${p.long}: since you joined on ${since}`
        : `${p.long}: since ${since}`;
  const up = r.gain >= 0;
  return (
    `<div class="returns-val"><span class="ch ${up ? "up" : "down"}">${up ? "+" : "-"}${fmtMoney(Math.abs(r.gain))}</span>` +
    `<span class="ch ${up ? "up" : "down"} returns-pct">${fmtPct(r.gain_pct)}</span></div>` +
    `<div class="returns-note">${esc(from)} &middot; ${fmtMoney(r.start_value)} &rarr; ${fmtMoney(r.net_worth)}</div>`
  );
}

/* ---------- Rendering: leaderboard ---------- */

function nameForm(current, submitLabel = "Join leaderboard") {
  return (
    `<form id="name-form" novalidate style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start">` +
    `<input class="field" id="name-input" aria-label="Display name" maxlength="24" autocomplete="nickname" ` +
    `placeholder="Display name" value="${esc(current || "")}" style="flex:1;min-width:180px;margin:0">` +
    `<button class="btn-primary" type="submit" id="name-save">${current ? "Save" : esc(submitLabel)}</button>` +
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
    render();
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
      const route = parseRoute();
      await Promise.all([
        route.page === "leaderboard" ? loadLeaderboard() : null,
        ["compete", "competition"].includes(route.page) ? loadRoutePage(route) : null,
        loadAccount(),
      ]);
      toast(`Your fund is ${r.display_name}. That's the name on leaderboards and in competitions.`);
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
            `<td class="nm-cell"><a href="${fundHref(r.display_name)}">${esc(r.display_name)}</a>${r.is_me ? ' <span class="you-badge">you</span>' : ""}</td>` +
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

/* ---------- Rendering: competitions ---------- */

const KIND_LABEL = {
  week: "Weekly sprint",
  month: "Monthly",
  season: "Season",
  event: "Special event",
  league: "Private league",
};
const fmtWhen = (ts) =>
  new Date(ts).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtDay = (ts) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const fundHref = (name) => `#/fund/${encodeURIComponent(name)}`;

function untilText(ts) {
  const ms = new Date(ts) - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600000);
  if (h >= 48) return `in ${Math.round(h / 24)} days`;
  if (h >= 1) return `in ${h}h ${Math.floor((ms % 3600000) / 60000)}m`;
  return `in ${Math.max(1, Math.round(ms / 60000))}m`;
}

function compStatus(c) {
  if (c.finished) return { cls: "final", text: "Final" };
  if (c.started) return { cls: "live", text: `Live · ends ${fmtWhen(c.ends_at)}` };
  return { cls: "open", text: `Starts ${untilText(c.starts_at)}` };
}

// Name your fund: shown wherever a display name is needed to play.
function fundNamePanel(why) {
  if (!supabase) return "";
  if (!state.session) {
    return `<div class="panel" style="margin-bottom:16px"><div class="position-note"><a href="#/signin">Sign in</a> ${esc(why)}</div></div>`;
  }
  if (state.me?.display_name && !state.editingName) return "";
  return (
    `<div class="panel" style="margin-bottom:16px"><h2>name your fund</h2>` +
    `<p class="position-note" style="margin:0 0 12px">Your fund name is how you show up in standings and on the leaderboard. Your email is never shown.</p>` +
    nameForm(state.me?.display_name || "", "Save fund name") +
    `</div>`
  );
}

function compCard(c) {
  const st = compStatus(c);
  const me = c.me;
  const mine = c.joined
    ? me?.rank
      ? `<span class="comp-me">#${me.rank} · <span class="txt-${dirClass(me.return_pct)}">${fmtPct(me.return_pct)}</span></span>`
      : `<span class="comp-me">${c.started ? (me && !me.qualified ? "needs trades to rank" : "entered") : "entered"}</span>`
    : "";
  return (
    `<a class="comp-card" href="#/compete/${encodeURIComponent(c.code)}">` +
    `<div class="comp-top"><span class="comp-kind">${esc(KIND_LABEL[c.kind] || c.kind)}</span>` +
    `<span class="comp-status ${st.cls}">${esc(st.text)}</span></div>` +
    `<div class="comp-name">${esc(c.name)}</div>` +
    (c.sponsor_name ? `<div class="comp-sponsor">presented by ${esc(c.sponsor_name)}</div>` : "") +
    (c.prize ? `<div class="comp-prize">Prize: ${esc(c.prize)}</div>` : "") +
    `<div class="comp-foot"><span>${c.entrants} ${c.entrants === 1 ? "fund" : "funds"}` +
    `${c.finished && c.winner ? ` · won by ${esc(c.winner)}` : ""}` +
    `${!c.finished && c.min_trades ? ` · ${c.min_trades}+ trade${c.min_trades === 1 ? "" : "s"} to rank` : ""}</span>${mine}</div>` +
    `</a>`
  );
}

function renderCompete() {
  const head =
    `<div class="section-head"><div><h1>Compete</h1>` +
    `<p>Same market, same prices. Competitions rank funds by percent return over a set window, so every fund starts even.</p></div></div>`;
  const cs = state.compete;
  if (!cs?.data) {
    $("main").innerHTML =
      head +
      (cs?.error
        ? `<div class="panel"><div class="empty-state">${esc(errorText(cs.error))}</div></div>`
        : `<div class="loading">Loading competitions…</div>`);
    return;
  }
  const all = cs.data.competitions;
  const section = (title, list, empty) =>
    `<h2 class="comp-section">${esc(title)}</h2>` +
    (list.length ? `<div class="comp-grid">${list.map(compCard).join("")}</div>` : `<div class="panel comp-empty">${empty}</div>`);

  const yours = all.filter((c) => c.joined && !c.finished);
  const open = all.filter((c) => !c.joined && !c.started && !c.is_private);
  const live = all.filter((c) => !c.joined && c.started && !c.finished && !c.is_private);
  const done = all.filter((c) => c.finished);

  const league =
    `<h2 class="comp-section">private leagues</h2>` +
    `<div class="panel league-panel">` +
    (state.session
      ? `<p class="position-note" style="margin:0 0 12px">Start a league, send friends the link, and see who runs the best fund. Everyone is scored from when they join.</p>` +
        `<form id="league-form" class="league-form" novalidate>` +
        `<input class="field" id="league-name" maxlength="40" placeholder="League name" aria-label="League name" style="margin:0">` +
        `<select id="league-length" aria-label="How long it runs" class="field" style="margin:0">` +
        (cs.leagueOptions || [{ value: "week", label: "1 week" }, { value: "season", label: "Rest of the season" }])
          .map(
            (o) =>
              `<option value="${esc(o.value)}"${o.value === "season" ? " selected" : ""}` +
              `${o.ends_at ? ` title="Ends ${esc(fmtWhen(o.ends_at))}"` : ""}>${esc(o.label)}</option>`
          )
          .join("") +
        `</select>` +
        `<button class="btn-primary" type="submit" id="league-create">Create league</button></form>` +
        `<div class="form-msg" id="league-msg" role="status" aria-live="polite"></div>`
      : `<div class="position-note"><a href="#/signin">Sign in</a> to start a league with friends.</div>`) +
    `</div>`;

  $("main").innerHTML =
    head +
    fundNamePanel("to enter competitions and start leagues.") +
    (yours.length ? section("your competitions", yours, "") : "") +
    section("open for entry", open, "Nothing open right now. New weekly sprints open before each slate of games.") +
    (live.length ? section("live now", live, "") : "") +
    league +
    (done.length ? section("recently finished", done, "") : "");

  bindNameForm();
  $("league-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("league-msg");
    $("league-create").disabled = true;
    try {
      const c = await api("/leagues", {
        method: "POST",
        auth: true,
        body: { name: $("league-name").value.trim(), length: $("league-length").value },
      });
      state.competition = { code: c.code, data: c, error: null };
      location.hash = `#/compete/${encodeURIComponent(c.code)}`;
      toast(`League created. Share the link to invite friends.`);
    } catch (err) {
      msg.className = "form-msg err";
      msg.textContent = errorText(err);
      $("league-create").disabled = false;
    }
  });
}

function renderCompetition() {
  const back = `<a class="detail-back" href="#/compete">&larr; All competitions</a>`;
  const cs = state.competition;
  if (!cs?.data) {
    $("main").innerHTML =
      back +
      (cs?.error
        ? `<div class="panel"><div class="empty-state"><div class="big">Competition not found</div>${esc(errorText(cs.error))}</div></div>`
        : `<div class="loading">Loading…</div>`);
    return;
  }
  const c = cs.data;
  const st = compStatus(c);
  const league = c.kind === "league";
  const link = `${location.origin}${location.pathname}#/compete/${encodeURIComponent(c.code)}`;
  const rules = league
    ? `Private league${c.created_by_name ? ` started by ${esc(c.created_by_name)}` : ""}. Ranked by percent return, and members are scored from when they join. Runs until ${esc(fmtWhen(c.ends_at))}.`
    : `Ranked by percent return from ${esc(fmtWhen(c.starts_at))} to ${esc(fmtWhen(c.ends_at))}. Entries close when it starts.` +
      (c.min_trades ? ` Make at least ${c.min_trades} trade${c.min_trades === 1 ? "" : "s"} during it to be ranked.` : "");

  // Your entry: join, leave, or where you stand.
  let mine = "";
  const canJoin = !c.finished && (!c.started || c.late_join);
  const canLeave = !c.finished && (!c.started || league);
  if (c.joined && c.me && c.started) {
    mine =
      `<div class="summary-row">` +
      `<div class="summary-card"><div class="label">your rank</div><div class="val">${c.me.rank ? `#${c.me.rank}` : "–"}` +
      ` <span style="font-size:14px;color:var(--text-muted)">of ${c.standings.filter((r) => r.rank).length}</span></div>` +
      (c.me.rank ? "" : `<div class="sub">${c.me.trades}/${c.min_trades} trades to rank</div>`) +
      `</div>` +
      `<div class="summary-card"><div class="label">your return</div><div class="val txt-${dirClass(c.me.return_pct ?? 0)}">${c.me.return_pct === null ? "–" : fmtPct(c.me.return_pct)}</div></div>` +
      `<div class="summary-card"><div class="label">trades during it</div><div class="val">${c.me.trades}</div></div>` +
      `</div>`;
  } else if (c.joined) {
    mine = `<div class="panel comp-entry"><div class="position-note">You're in. Scoring starts ${esc(untilText(c.starts_at))}, from your fund's value then.</div></div>`;
  } else if (canJoin) {
    mine = state.session && state.me?.display_name
      ? `<div class="panel comp-entry"><button class="btn-primary" id="comp-join">Join as ${esc(state.me.display_name)}</button>` +
        `<div class="form-msg" id="comp-msg" role="status" aria-live="polite"></div></div>`
      : fundNamePanel("to join.");
  }
  const actions =
    (c.joined && canLeave ? `<button class="btn-secondary" id="comp-leave">Leave</button>` : "") +
    (league || !c.finished ? `<button class="btn-secondary" id="comp-share">Copy invite link</button>` : "");

  const ranked = c.started;
  const rows = c.standings;
  const table = rows.length
    ? `<div class="panel table-scroll"><table class="holdings comp-table">` +
      `<thead><tr><th>rank</th><th>fund</th>${ranked ? "<th>return</th><th>trades</th>" : ""}</tr></thead><tbody>` +
      rows
        .map(
          (r) =>
            `<tr${r.is_me ? ' class="me-row"' : ""}>` +
            `<td>${r.rank ? (r.rank <= 3 ? `<span class="medal medal-${r.rank}">${r.rank}</span>` : r.rank) : "–"}</td>` +
            `<td class="nm-cell"><a href="${fundHref(r.display_name)}">${esc(r.display_name)}</a>${r.is_me ? ' <span class="you-badge">you</span>' : ""}</td>` +
            (ranked
              ? `<td class="txt-${dirClass(r.return_pct ?? 0)}">${r.return_pct === null ? "–" : fmtPct(r.return_pct)}</td>` +
                `<td>${r.trades}${r.qualified ? "" : ` <span class="unranked" title="Needs ${c.min_trades} trades to rank">needs ${c.min_trades}</span>`}</td>`
              : "") +
            `</tr>`
        )
        .join("") +
      `</tbody></table></div>`
    : `<div class="panel"><div class="empty-state">No funds yet. Be the first to join.</div></div>`;

  $("main").innerHTML =
    back +
    `<div class="comp-head"><div>` +
    `<div class="comp-kind">${esc(KIND_LABEL[c.kind] || c.kind)} · <span class="comp-status ${st.cls}">${esc(st.text)}</span></div>` +
    `<h1>${esc(c.name)}</h1>` +
    (c.sponsor_name
      ? `<div class="comp-sponsor">presented by ${c.sponsor_url ? `<a href="${esc(c.sponsor_url)}" target="_blank" rel="sponsored noopener">${esc(c.sponsor_name)}</a>` : esc(c.sponsor_name)}</div>`
      : "") +
    (c.prize ? `<div class="comp-prize">Prize: ${esc(c.prize)}</div>` : "") +
    `<p class="comp-rules">${rules}</p></div>` +
    (actions ? `<div class="comp-actions">${actions}</div>` : "") +
    `</div>` +
    mine +
    `<h2 class="comp-section">${ranked ? "standings" : "entered"} <span class="comp-count">${c.entrants}</span></h2>` +
    table;

  bindNameForm();
  $("comp-join")?.addEventListener("click", async () => {
    $("comp-join").disabled = true;
    try {
      state.competition.data = await api(`/competitions/${encodeURIComponent(c.code)}/join`, { method: "POST", auth: true });
      toast(`You're in ${c.name}.`);
      renderCompetition();
    } catch (err) {
      const msg = $("comp-msg");
      msg.className = "form-msg err";
      msg.textContent = errorText(err);
      $("comp-join").disabled = false;
    }
  });
  $("comp-leave")?.addEventListener("click", async () => {
    try {
      state.competition.data = await api(`/competitions/${encodeURIComponent(c.code)}/leave`, { method: "POST", auth: true });
      toast(`You left ${c.name}.`);
      renderCompetition();
    } catch (err) {
      toast(errorText(err), true);
    }
  });
  $("comp-share")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast("Invite link copied.");
    } catch {
      toast(link);
    }
  });
}

// Fund card: returns and trading record. Used on fund pages and the portfolio.
function fundStatsHtml(f) {
  const best = f.best_trade
    ? `${teamLabel(f.best_trade.team_id)} <span class="txt-${dirClass(f.best_trade.gain)}">${f.best_trade.gain >= 0 ? "+" : "-"}${fmtMoney(Math.abs(f.best_trade.gain))}</span>`
    : "–";
  const stat = (label, value, sub = "") =>
    `<div class="fund-stat"><div class="label">${label}</div><div class="val">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
  return (
    `<div class="fund-grid">` +
    stat("total return", `<span class="txt-${dirClass(f.total_return)}">${fmtPct(f.total_return_pct)}</span>`, `${f.total_return >= 0 ? "+" : "-"}${fmtMoney(Math.abs(f.total_return))}`) +
    stat("net worth", fmtMoney(f.net_worth)) +
    stat("trades", String(f.trades), f.closed_trades ? `${f.closed_trades} closed` : "") +
    stat("win rate", f.win_rate === null ? "–" : `${f.win_rate.toFixed(0)}%`, "of closed trades") +
    stat("best trade", best) +
    stat("biggest drop", f.max_drawdown_pct ? `-${f.max_drawdown_pct.toFixed(1)}%` : "0%", "from a high") +
    stat("most traded", f.favorite_team ? teamLabel(f.favorite_team) : "–") +
    stat("competitions", f.competition_wins ? `${f.competition_wins} win${f.competition_wins === 1 ? "" : "s"}` : f.best_finish ? `best #${f.best_finish}` : "–", f.competitions_finished ? `${f.competitions_finished} finished` : "") +
    `</div>`
  );
}

function renderFund() {
  const back = `<a class="detail-back" href="#/leaderboard">&larr; Leaderboard</a>`;
  const fs = state.fund;
  if (!fs?.data) {
    $("main").innerHTML =
      back +
      (fs?.error
        ? `<div class="panel"><div class="empty-state"><div class="big">Fund not found</div>${esc(errorText(fs.error))}</div></div>`
        : `<div class="loading">Loading…</div>`);
    return;
  }
  const f = fs.data;
  $("main").innerHTML =
    back +
    `<div class="section-head"><div><h1>${esc(f.display_name)}</h1>` +
    `<p>Fund since ${esc(fmtDay(f.member_since))}. Holdings stay private.</p></div></div>` +
    `<div class="panel">${fundStatsHtml(f)}</div>`;
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

// Google's own sign-in button (Google Identity Services), when GOOGLE_CLIENT_ID
// is set. Google's screen then names this site ("to continue to
// cfbxchange.com") instead of the Supabase address the redirect flow goes
// through. If Google's script can't load, the redirect button stays.
let gsiLoading = null;
function loadGoogleIdentity() {
  if (window.google?.accounts?.id) return Promise.resolve();
  gsiLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => (window.google?.accounts?.id ? resolve() : reject(new Error("gsi_unavailable")));
    s.onerror = () => reject(new Error("gsi_unavailable"));
    document.head.appendChild(s);
  }).catch((err) => {
    gsiLoading = null; // try again next time the page is shown
    throw err;
  });
  return gsiLoading;
}

async function mountGoogleButton() {
  // Supabase checks the token against a nonce only this page knows; Google
  // signs the token with its SHA-256.
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  const hashedNonce = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    await loadGoogleIdentity();
  } catch {
    return;
  }
  const wrap = $("signin-google-wrap");
  if (!wrap || parseRoute().page !== "signin") return; // left the page meanwhile
  window.google.accounts.id.initialize({
    client_id: cfg.googleClientId,
    nonce: hashedNonce,
    callback: async ({ credential }) => {
      const { error } = await supabase.auth.signInWithIdToken({ provider: "google", token: credential, nonce });
      // On success onAuthStateChange takes over and leaves this page.
      if (error) {
        const msg = $("signin-msg");
        if (!msg) return;
        msg.className = "form-msg err";
        msg.textContent = error.message || "Google sign-in didn't work. Try again.";
      }
    },
  });
  wrap.innerHTML = "";
  wrap.className = "gsi-wrap";
  window.google.accounts.id.renderButton(wrap, {
    type: "standard",
    theme: "outline",
    size: "large",
    text: "continue_with",
    shape: "rectangular",
    logo_alignment: "center",
    width: Math.max(200, Math.min(400, wrap.clientWidth || 320)),
  });
}

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
      ? `<div id="signin-google-wrap"><button class="btn-google" type="button" id="signin-google">${GOOGLE_G}<span>Continue with Google</span></button></div>` +
        `<div class="auth-or"><span>or use your email</span></div>`
      : `<p>Enter your email and we'll send you a sign-in link.</p>`) +
    `<form id="signin-form" novalidate>` +
    `<input class="field" type="email" id="signin-email" autocomplete="email" required placeholder="you@example.com" aria-label="Email">` +
    `<button class="btn-primary" type="submit" id="signin-submit" style="width:100%">Email me a link</button>` +
    `<div class="form-msg" id="signin-msg" role="status" aria-live="polite"></div></form></div>`;

  if (google && cfg.googleClientId) mountGoogleButton();
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
          if (["compete", "competition", "fund"].includes(parseRoute().page)) await loadRoutePage();
          if (session) signInState.email = null;
          if (session && parseRoute().page === "signin") location.hash = "#/";
          else render();
        }, 0);
      }
    });
  }

  await Promise.all([loadTeams(), loadAccount()]);
  await onRouteChange();

  // Prices move with every trade: refresh every 30s while the tab is open.
  // Skipped while someone is typing (re-rendering would reset their input).
  setInterval(async () => {
    if (document.hidden || state.tradePending) return;
    if (document.activeElement?.matches?.("input, textarea")) return;
    const route = parseRoute();
    await Promise.all([
      loadTeams(),
      state.session ? loadAccount() : null,
      route.page === "detail" ? loadOptions(route.ticker) : null,
      route.page === "detail" ? loadMine(route.ticker) : null,
      ["compete", "competition", "fund"].includes(route.page) ? loadRoutePage(route) : null,
    ]);
    if (document.activeElement?.matches?.("input, textarea")) return;
    render();
  }, 30000);

  // Prices only move when games finish, so refreshing on focus is enough.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    await Promise.all([loadTeams(), loadAccount()]);
    const route = parseRoute();
    if (route.page === "detail") await loadDetail(route.ticker);
    if (route.page === "leaderboard") await loadLeaderboard();
    if (["compete", "competition", "fund"].includes(route.page)) await loadRoutePage(route);
    render();
  });
}

boot();
