// CFBx frontend. Ported from the single-file prototype
// (reference/cfbx-artifact.html). The views and styling are the same; the
// difference is where data comes from. Prices, cash and holdings are read
// from the API, and trades are *requests* the server executes at its own price.
// Nothing here computes or asserts a price.

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

function helmetSVG(primary, secondary, size = 56) {
  const p = safeColor(primary, "#3A4657");
  const s = safeColor(secondary, "#8993A3");
  const h = Math.round(size * 0.72);
  return (
    `<svg width="${size}" height="${h}" viewBox="0 0 120 90" aria-hidden="true">` +
    `<path d="M15,55 C15,20 45,10 70,10 C95,10 105,30 103,45 C101,58 90,63 79,60 L77,49 C76,43 69,39 59,39 L34,39 C24,39 19,45 17,55 Z" fill="${p}"/>` +
    `<path d="M69,10 C81,10 88,16 92,24" stroke="${s}" stroke-width="6" fill="none" stroke-linecap="round"/>` +
    `<circle cx="86" cy="43" r="5" fill="${s}"/>` +
    `<path d="M19,49 Q11,56 17,66" stroke="#9AA0A6" stroke-width="4.5" fill="none" stroke-linecap="round"/>` +
    `<path d="M26,46 Q17,55 24,68" stroke="#9AA0A6" stroke-width="4.5" fill="none" stroke-linecap="round"/>` +
    `<path d="M33,44 Q24,53 31,66" stroke="#9AA0A6" stroke-width="4.5" fill="none" stroke-linecap="round"/>` +
    `</svg>`
  );
}

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
        helmetSVG(t.primary_color, t.secondary_color, 44) +
        `<div><div class="tk">${esc(t.id)}</div><div class="nm">${esc(t.name)}${t.mascot ? " " + esc(t.mascot) : ""}</div></div>` +
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

function priceChart(hist) {
  const w = 560, h = 220, pad = 30;
  const min = Math.min(...hist), max = Math.max(...hist);
  const range = max - min || 1;
  const pts = hist
    .map((v, i) => {
      const x = pad + i * ((w - 2 * pad) / Math.max(hist.length - 1, 1));
      const y = h - pad - ((v - min) / range) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const color = hist[hist.length - 1] >= hist[0] ? "var(--positive)" : "var(--negative)";
  return (
    `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:560px" role="img" aria-label="Price history from $${hist[0].toFixed(2)} to $${hist[hist.length - 1].toFixed(2)}">` +
    `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--border)"/>` +
    `<text class="axis-label" x="${pad}" y="18">$${max.toFixed(2)}</text>` +
    `<text class="axis-label" x="${pad}" y="${h - pad + 16}">$${min.toFixed(2)}</text>` +
    `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.4"/></svg>`
  );
}

function gameLogItem(e) {
  const opp = e.opponent_name || e.opponent_id;
  const won = e.team_score > e.opp_score;
  const text = won
    ? `def. ${esc(opp)} ${e.team_score}-${e.opp_score}`
    : `fell to ${esc(opp)} ${e.team_score}-${e.opp_score}`;
  const summary = e.summary ? ` (${esc(e.summary)})` : "";
  const proj = e.is_real_line ? "" : ` <span class="proj-tag">SP+ LINE</span>`;
  return (
    `<div class="log-item"><span class="lw">Week ${e.week}</span> &middot; ${text}${summary}${proj} ` +
    `<span class="ld ch ${e.pct_change >= 0 ? "up" : "down"}">${fmtPct(e.pct_change)}</span></div>`
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
    helmetSVG(t.primary_color, t.secondary_color, 84) +
    `<div class="tk-name"><div class="tk">${esc(t.id)} &middot; ${esc(t.conference)} &middot; STRENGTH ${t.strength}</div>` +
    `<h1>${esc(t.name)}</h1>${t.mascot ? `<div class="nm">${esc(t.mascot)}</div>` : ""}</div></div>` +
    `<div class="detail-price">` +
    `<nav class="tabs" id="detail-pricemode" style="margin-bottom:8px;display:inline-flex">` +
    `<button data-mode="week" class="${mode === "week" ? "active" : ""}" style="padding:5px 11px;font-size:12px">Week</button>` +
    `<button data-mode="season" class="${mode === "season" ? "active" : ""}" style="padding:5px 11px;font-size:12px">Season</button></nav>` +
    `<div class="px">$${t.current_price.toFixed(2)}</div>` +
    `<div class="ch ${dirClass(pct)}">${fmtPct(pct)}${mode === "season" ? ` since IPO ($${t.ipo_price.toFixed(2)})` : " last game"}</div>` +
    lastGame +
    `</div></div>` +
    `<div class="detail-body">` +
    `<div class="panel"><h2>price history</h2><div class="chart-wrap">${panelBody((d) => priceChart(d.price_history))}</div></div>` +
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
            `<tr><td class="nm-cell"><a href="#/team/${encodeURIComponent(h.team_id)}" style="text-decoration:none">${esc(h.name)}</a><br><span class="tk-mini">${esc(h.team_id)}</span></td>` +
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
            `${x.side === "buy" ? "Bought" : "Sold"} ${x.shares} <a href="#/team/${encodeURIComponent(x.team_id)}">${esc(x.team_id)}</a> @ $${x.price.toFixed(2)} ` +
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

function renderSignIn() {
  if (!supabase) {
    $("main").innerHTML = `<div class="panel auth-panel"><h2>sign in</h2><p>Sign-in isn't configured on this server.</p></div>`;
    return;
  }
  if (state.session) {
    location.hash = "#/";
    return;
  }
  $("main").innerHTML =
    `<div class="panel auth-panel"><h2>sign in</h2>` +
    `<p>Enter your email and we'll send you a sign-in link. New here? The same link creates your account with ${fmtMoney(STARTING_CASH)} in play money.</p>` +
    `<form id="signin-form" novalidate>` +
    `<input class="field" type="email" id="signin-email" autocomplete="email" required placeholder="you@example.com" aria-label="Email">` +
    `<button class="btn-primary" type="submit" id="signin-submit" style="width:100%">Email me a link</button>` +
    `<div class="form-msg" id="signin-msg" role="status" aria-live="polite"></div></form></div>`;

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
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    $("signin-submit").disabled = false;
    if (error) {
      msg.className = "form-msg err";
      msg.textContent = error.message || "Couldn't send the link. Try again.";
    } else {
      msg.className = "form-msg ok";
      msg.textContent = `Check ${email} for your sign-in link.`;
    }
  });
}

/* ---------- Boot ---------- */

async function boot() {
  window.addEventListener("hashchange", onRouteChange);

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
