"use strict";
// My Career Agent web app. No framework and no build step.
// Every value from the server is written with textContent or as an SVG text node, never as HTML,
// so a job posting or a contact name cannot inject script.

// ---------------------------------------------------------------- helpers
const $main = document.getElementById("main");
const SVGNS = "http://www.w3.org/2000/svg";

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  setAttrs(n, attrs);
  append(n, kids);
  return n;
}
function svg(tag, attrs, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  setAttrs(n, attrs);
  append(n, kids);
  return n;
}
function setAttrs(n, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "class") n.setAttribute("class", v);
    else if (k === "value") n.value = v;
    else if (k === "checked" || k === "selected") n[k] = !!v;
    else if (k === "style" && typeof v === "object") for (const [sk, sv] of Object.entries(v)) sk.startsWith("--") ? n.style.setProperty(sk, sv) : (n.style[sk] = sv);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
}
function append(n, kids) {
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) n.append(kid instanceof Node ? kid : String(kid));
}
function icon(name, label) {
  const s = svg("svg", { "aria-hidden": label ? null : "true", role: label ? "img" : null, "aria-label": label || null, width: 16, height: 16 });
  s.append(svg("use", { href: `#i-${name}` }));
  return s;
}
const clear = (node, ...kids) => { node.replaceChildren(); append(node, kids); return node; };
function render(...nodes) { clear($main, nodes); }
function toast(text) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 2000);
}
const MSG_ICON = { go: "check", hold: "alert", stop: "stop", info: "info" };
const msg = (kind, ...body) => el("div", { class: `msg ${kind}`, role: kind === "stop" ? "alert" : null }, icon(MSG_ICON[kind] || "info"), el("div", { class: "grow" }, body));
const loading = () => el("div", { class: "loading", "aria-label": "Loading" }, el("i"), el("i"), el("i"));
const todayIso = () => new Date().toISOString().slice(0, 10);
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const fmtDate = (d, opts) => {
  if (!d) return "";
  const t = new Date(String(d).length === 10 ? `${d}T12:00:00Z` : d);
  return Number.isNaN(+t) ? "" : t.toLocaleDateString(undefined, opts || { month: "short", day: "numeric" });
};
const fmtDay = (d) => fmtDate(d, { month: "short", day: "numeric", year: "numeric" });
function money(n, cur) {
  if (n === null || n === undefined || n === "") return "";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(Number(n)); }
  catch { return `${cur || ""} ${Math.round(Number(n)).toLocaleString()}`.trim(); }
}
const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s || "");
async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = el("textarea", { value: text }); document.body.append(t); t.select(); document.execCommand("copy"); t.remove(); }
  toast("Copied");
}
const TRAILING = new Set(["arrow", "out"]);
function btn(label, opts = {}) {
  const b = el("button", { type: opts.type || "button", class: `btn ${opts.kind || ""} ${opts.small ? "small" : ""}`.trim(), onclick: opts.onclick, "aria-label": opts.aria || null, title: opts.title || null },
    opts.icon && !TRAILING.has(opts.icon) ? icon(opts.icon) : null, label, opts.icon && TRAILING.has(opts.icon) ? icon(opts.icon) : null);
  return b;
}
/** Disables the button while the action runs, shows any error in `where`, and never fails silently. */
function action(button, where, fn) {
  button.addEventListener("click", async (e) => {
    e.preventDefault();
    if (button.getAttribute("aria-busy") === "true") return;
    button.setAttribute("aria-busy", "true");
    try { await fn(e); if (where) where.replaceChildren(); }
    catch (err) { if (err.status !== 401 && where) clear(where, msg("stop", err.message)); }
    finally { button.removeAttribute("aria-busy"); }
  });
  return button;
}
/** Two-step confirm for consequential actions: the first press arms it, the second does it. */
function confirmBtn(label, armedLabel, where, fn, kind = "danger") {
  const b = btn(label, { kind });
  let armed = false, t = null;
  b.addEventListener("click", async () => {
    if (!armed) {
      armed = true; b.classList.add("armed"); b.lastChild.textContent = armedLabel;
      t = setTimeout(() => { armed = false; b.classList.remove("armed"); b.lastChild.textContent = label; }, 5000);
      return;
    }
    clearTimeout(t);
    b.setAttribute("aria-busy", "true");
    try { await fn(); } catch (err) { if (where && err.status !== 401) clear(where, msg("stop", err.message)); }
    finally { b.removeAttribute("aria-busy"); armed = false; b.classList.remove("armed"); b.lastChild.textContent = label; }
  });
  return b;
}
function field(labelText, control, hint) {
  const id = control.id || `f${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return el("div", {}, el("label", { for: id }, labelText, hint ? el("span", { class: "note" }, ` ${hint}`) : null), control);
}
const input = (attrs) => el("input", attrs);
const select = (options, value, attrs = {}) =>
  el("select", attrs, options.map(([v, l]) => el("option", { value: v, selected: String(v) === String(value ?? "") }, l)));

// ---------------------------------------------------------------- session and API
// Signed-in browsers use an HttpOnly session cookie. A personal access token (POC accounts) is kept
// for this tab only, in sessionStorage, and sent as a bearer header.
const tokenStore = {
  mem: null,
  get() { try { return sessionStorage.getItem("mca_token") ?? this.mem; } catch { return this.mem; } },
  set(v) { this.mem = v; try { v ? sessionStorage.setItem("mca_token", v) : sessionStorage.removeItem("mca_token"); } catch {} },
};
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function request(method, path, body) {
  const headers = {};
  const tok = tokenStore.get();
  if (tok) headers.authorization = `Bearer ${tok}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try { res = await fetch(`/api${path}`, { method, headers, credentials: "same-origin", body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch { throw new ApiError(0, "Can't reach My Career Agent. Check your connection and try again."); }
  return res;
}
async function api(method, path, body) {
  const res = await request(method, path, body);
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && !path.startsWith("/auth/")) {
    state.me = null; tokenStore.set(null);
    location.hash = "#/signin";
    throw new ApiError(401, "Your session ended. Sign in again.");
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Something went wrong (${res.status}). Try again.`);
  return data;
}
/** Downloads an authenticated file (works for cookie and token sessions alike). */
async function download(path, fallbackName) {
  const res = await request("GET", path.replace(/^\/api/, ""));
  if (!res.ok) { let m = `Download failed (${res.status}).`; try { m = (await res.json()).error || m; } catch {} throw new ApiError(res.status, m); }
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") || "";
  const name = (/filename="?([^";]+)"?/.exec(cd) || [])[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const state = { me: null, aiKey: undefined };

// ---------------------------------------------------------------- lines and stages
// Each company owns one saturated line colour, from a stable hash of its id. Every hue holds 3:1
// against the working ground as a graphic; text never sits on a line colour.
// No red, green or amber: those mean state here and never sit on a line.
// Theme-aware: app.css defines --l0…--l6 for light and a lightened set for dark.
const LINE_COLOURS = ["var(--l0)", "var(--l1)", "var(--l2)", "var(--l3)", "var(--l4)", "var(--l5)", "var(--l6)"];
function hashOf(key) {
  let h = 2166136261;
  for (const ch of String(key || "")) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** The companies the person has applied to get distinct colours while there are ten or fewer;
 *  the assignment depends only on the set of companies, so it's the same on every screen. */
const lineAssign = new Map();
function assignLines(companyIds, first = []) {
  // Live companies claim distinct colours before the rest, so the map never repeats a colour.
  const lead = [...new Set(first.filter(Boolean).map(String))].sort();
  const ids = [...new Set([...lead, ...[...new Set(companyIds.filter(Boolean).map(String))].filter((x) => !lead.includes(x)).sort()])];
  lineAssign.clear();
  const used = new Set();
  for (const id of ids) {
    let i = hashOf(id) % LINE_COLOURS.length;
    for (let k = 0; k < LINE_COLOURS.length && used.has(i); k++) i = (i + 1) % LINE_COLOURS.length;
    used.add(i);
    if (used.size >= LINE_COLOURS.length) used.clear();
    lineAssign.set(id, LINE_COLOURS[i]);
  }
}
function lineColour(key) {
  return lineAssign.get(String(key)) || LINE_COLOURS[hashOf(key) % LINE_COLOURS.length];
}
async function ensureLines(force) {
  if (lineAssign.size && !force) return;
  try { const items = (await api("GET", "/applications")).items; assignLines(items.map((a) => a.company_id), items.filter((a) => ACTIVE.includes(a.state)).map((a) => a.company_id)); } catch {}
}
const bullet = (key, reached = true) => el("span", { class: `bullet ${reached ? "reached" : ""}`, style: { "--line": lineColour(key) }, "aria-hidden": "true" });
const coName = (key, name) => el("span", { class: "co" }, bullet(key), name);
const routeBadge = (key, name) => el("span", { class: "route", style: { "--line": lineColour(key) } }, name);

// Mirrors apps/api/src/lib/transitions.ts. The server enforces it; this only offers valid moves.
const NEXT = {
  queued: ["approved", "skipped"], approved: ["ready_for_review", "submitted", "failed", "skipped"],
  ready_for_review: ["submitted", "failed", "approved", "skipped"], failed: ["approved", "skipped"],
  submitted: ["screen", "interview", "rejected", "withdrawn", "offer"], screen: ["interview", "rejected", "withdrawn", "offer"],
  interview: ["interview", "offer", "rejected", "withdrawn"], offer: ["withdrawn"], rejected: [], withdrawn: [], skipped: ["queued"],
};
const STATE_LABEL = {
  queued: "Queued", approved: "Approved", ready_for_review: "Ready for review", submitted: "Submitted", screen: "Screen",
  interview: "Interview", offer: "Offer", rejected: "Rejected", withdrawn: "Withdrawn", failed: "Couldn't apply", skipped: "Skipped",
};
const STATE_TONE = { offer: "go", interview: "go", screen: "go", rejected: "stop", failed: "hold", ready_for_review: "hold" };
const STAGE_ORDER = ["queued", "approved", "ready_for_review", "failed", "submitted", "screen", "interview", "offer", "rejected", "withdrawn", "skipped"];
const stateTag = (s) => el("span", { class: `tag ${STATE_TONE[s] || ""}` }, STATE_LABEL[s] || s);
async function moveTo(appId, to, note) { await api("POST", `/applications/${appId}/status`, { state: to, note }); toast(STATE_LABEL[to]); }

const COUNTRIES = [["US", "United States"], ["GB", "United Kingdom"], ["CA", "Canada"], ["IE", "Ireland"], ["IT", "Italy"]];
const COUNTRY_NAME = Object.fromEntries(COUNTRIES);
const WORK_STATUS = [["needs_sponsorship", "Needs visa sponsorship"], ["work_visa", "Has a work visa (no sponsorship)"], ["permanent_resident", "Permanent resident"], ["citizen", "Citizen"]];
const CURRENCY = { US: "USD", GB: "GBP", CA: "CAD", IE: "EUR", IT: "EUR" };
/** Status choices worded the way each country says them. Values are the same everywhere. */
function workStatusFor(code) {
  if (code === "IE") return [["needs_sponsorship", "Needs an employment permit"], ["work_visa", "Has a permit or Stamp (no new permit)"], ["permanent_resident", "Stamp 4 or long-term residence"], ["citizen", "Irish, EU/EEA or Swiss citizen"]];
  if (code === "IT") return [["needs_sponsorship", "Needs a work permit or EU Blue Card"], ["work_visa", "Has a permesso di soggiorno for work"], ["permanent_resident", "EU long-term resident"], ["citizen", "Italian, EU/EEA or Swiss citizen"]];
  return WORK_STATUS;
}

// ---------------------------------------------------------------- shell
const ROUTES = [["today", "Today"], ["applications", "Applications"], ["followups", "Follow-ups"], ["network", "Network"], ["profile", "Profile"], ["settings", "Settings"]];
function shell(active) {
  const nav = document.getElementById("nav"), who = document.getElementById("who"), foot = document.getElementById("foot");
  if (!state.me) { nav.replaceChildren(); who.replaceChildren(); }
  else {
    clear(nav, ROUTES.map(([r, label]) => el("a", { href: `#/${r}`, "aria-current": r === active ? "page" : null }, label,
      r === "followups" && state.followupCount ? el("span", { class: "count", "aria-label": `${state.followupCount} due` }, state.followupCount) : null)));
    const out = btn("Sign out", { kind: "quiet" });
    out.addEventListener("click", signOut);
    clear(who, state.me.email ? el("span", { class: "email" }, state.me.email) : null, themeButton(), out);
  }
  clear(foot, el("span", {}, "You review and submit every application yourself."), el("a", { href: "#/privacy" }, "Privacy"), el("a", { href: "#/terms" }, "Terms"));
}
// Light/dark switch in the rail. It pins the opposite of what is showing; Settings › Appearance
// can hand the choice back to the system.
function themeButton() {
  const b = el("button", { type: "button", class: "theme-btn" });
  const draw = () => {
    const dark = window.mcaTheme && mcaTheme.current() === "dark";
    b.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    b.title = b.getAttribute("aria-label");
    b.replaceChildren(icon(dark ? "sun" : "moon"));
  };
  b.addEventListener("click", () => { mcaTheme.set(mcaTheme.current() === "dark" ? "light" : "dark"); });
  document.addEventListener("themechange", draw);
  draw();
  return b;
}
function appearance() {
  const out = el("div", { class: "chips", role: "radiogroup", "aria-label": "Theme" });
  const opts = [["system", "Match my device"], ["light", "Light"], ["dark", "Dark"]];
  const draw = () => out.replaceChildren(...opts.map(([v, l]) => {
    const on = mcaTheme.choice() === v;
    return el("button", { type: "button", class: "chip", role: "radio", "aria-checked": String(on), "aria-pressed": String(on), onclick: () => mcaTheme.set(v) }, l);
  }));
  document.addEventListener("themechange", draw);
  draw();
  return el("div", {}, el("p", { class: "note", style: { marginTop: 0 } }, "Dark mode suits evening sessions. The switch in the top bar flips it for now; this is the lasting choice."), out);
}
async function signOut() {
  try { if (!tokenStore.get()) await api("POST", "/auth/logout"); } catch {}
  tokenStore.set(null); state.me = null; state.aiKey = undefined;
  location.hash = "#/signin";
}
async function loadMe() {
  try { state.me = await api("GET", "/auth/me"); } catch (e) { state.me = null; if (e.status && e.status !== 401) throw e; }
  return state.me;
}

const VIEWS = {};
async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("?")[0].split("/");
  let [name = "", ...args] = parts;
  args = args.map(decodeURIComponent);
  if (["privacy", "terms"].includes(name)) { shell(name); await VIEWS[name](); return; }
  if (name === "forgot" || name === "reset") { shell("signin"); await VIEWS[name](...args); return; }
  if (!state.me) {
    render(loading());
    try { await loadMe(); } catch (e) { render(msg("stop", e.message)); return; }
  }
  if (!state.me) { shell("signin"); VIEWS.signin(name === "signup" ? "signup" : "signin"); return; }
  if (name === "signin" || name === "signup" || !name) name = state.me.onboarding.complete ? "today" : "setup";
  shell(name);
  render(loading());
  const view = VIEWS[name] || VIEWS.today;
  try { if (name !== "setup") await ensureLines(name === "today" || name === "applications"); await view(...args); }
  catch (e) { if (e.status !== 401) render(el("div", { class: "page-head" }, el("h1", {}, "That didn't load")), msg("stop", e.message, " ", el("a", { href: location.hash, onclick: () => setTimeout(route) }, "Try again"))); }
  if (!args.length) $main.focus({ preventScroll: true });
}
window.addEventListener("hashchange", () => { window.scrollTo(0, 0); document.getElementById("toast").classList.remove("show"); route(); });
const pageHead = (title, lede, ...actions) =>
  el("div", { class: "page-head" }, el("div", { class: "grow" }, el("h1", {}, title), lede ? el("p", { class: "lede" }, lede) : null), actions.length ? el("div", { class: "row" }, actions) : null);

// ---------------------------------------------------------------- sign in / sign up
function gateArt() {
  const s = svg("svg", { viewBox: "0 0 520 220", "aria-hidden": "true" });
  const lines = [["#d1242f", 40], ["#0b5cad", 90], ["#1a7f37", 140], ["#c25e00", 190]];
  for (const [c, y] of lines) {
    s.append(svg("path", { d: `M10 ${y} H${300 - Math.abs(115 - y) / 3} C ${380} ${y}, ${390} 115, 430 115`, stroke: c, "stroke-width": 7, fill: "none", "stroke-linecap": "round" }));
    for (const x of [80, 170, 250]) s.append(svg("circle", { cx: x, cy: y, r: 8, fill: x < 200 || y < 100 ? c : "#15181d", stroke: c, "stroke-width": 4 }));
  }
  s.append(svg("rect", { x: 418, y: 22, width: 46, height: 186, rx: 23, fill: "#15181d", stroke: "#ecebe6", "stroke-width": 4 }));
  return s;
}
VIEWS.signin = (mode = "signin") => {
  const out = el("div", { "aria-live": "polite" });
  const email = input({ type: "email", autocomplete: "email", required: true, inputmode: "email" });
  const pw = input({ type: "password", autocomplete: mode === "signup" ? "new-password" : "current-password", required: true, minlength: mode === "signup" ? 10 : null });
  const invite = input({ autocomplete: "off", autocapitalize: "characters", spellcheck: "false" });
  const submit = btn(mode === "signup" ? "Create account" : "Sign in", { kind: "primary", type: "submit" });
  const forgotLink = el("a", { href: "#/forgot", class: "note", hidden: true, style: { marginLeft: "auto" } }, "Forgot your password?");
  const form = el("form", { novalidate: true },
    field("Email", email),
    field("Password", pw, mode === "signup" ? "(at least 10 characters)" : null),
    mode === "signup" ? field("Invite code", invite, "(from your beta invitation)") : null,
    el("div", { class: "row" }, submit, forgotLink),
    out);
  // "Forgot your password?" shows only when this server can send the reset email.
  if (mode === "signin") api("GET", "/auth/reset/available").then((r) => { if (r.available) forgotLink.hidden = false; }).catch(() => {});
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.setAttribute("aria-busy", "true");
    try {
      if (mode === "signup") await api("POST", "/auth/signup", { email: email.value, password: pw.value, inviteCode: invite.value });
      else await api("POST", "/auth/login", { email: email.value, password: pw.value });
      tokenStore.set(null);
      await loadMe();
      location.hash = state.me && state.me.onboarding.complete ? "#/today" : "#/setup";
      route();
    } catch (err) { clear(out, msg("stop", err.message)); }
    finally { submit.removeAttribute("aria-busy"); }
  });

  const tok = input({ type: "password", autocomplete: "off", placeholder: "mca_pat_…" });
  const tokOut = el("div");
  const tokBtn = btn("Use token", { type: "submit" });
  const tokForm = el("form", { class: "stack" }, field("Access token", tok), el("div", { class: "row" }, tokBtn), tokOut);
  tokForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    tokenStore.set(tok.value.trim());
    try { const me = await loadMe(); if (!me) throw new ApiError(401, "That token wasn't accepted."); location.hash = "#/today"; route(); }
    catch (err) { tokenStore.set(null); clear(tokOut, msg("stop", err.message)); }
  });

  const tab = (m, label) => el("button", { role: "tab", "aria-selected": String(m === mode), onclick: () => { location.hash = m === "signup" ? "#/signup" : "#/signin"; } }, label);
  render(el("div", { class: "gate" },
    el("div", { class: "gate-art" },
      el("div", {}, el("h1", {}, "Every application, timed for your offer window."),
        el("p", {}, "My Career Agent picks the roles worth your time at employers that actually sponsor, prepares each application from facts you've confirmed, and tells you when to follow up. You submit every application yourself.")),
      gateArt()),
    el("div", { class: "gate-form" },
      el("div", { class: "tabs", role: "tablist" }, tab("signin", "Sign in"), tab("signup", "Create account")),
      form,
      el("details", { style: { marginTop: "32px" } }, el("summary", {}, "Sign in with an access token"),
        el("p", { class: "note" }, "For accounts created before sign-up existed, or for testing. The token is kept in this tab only."), tokForm))));
  email.focus();
};
VIEWS.signup = () => VIEWS.signin("signup");

// Forgot password: ask for the email, then the link in it opens #/reset/<token>.
const gateShell = (title, lede, ...body) => render(el("div", { class: "gate" },
  el("div", { class: "gate-art" }, el("div", {}, el("h1", {}, "Every application, timed for your offer window.")), gateArt()),
  el("div", { class: "gate-form" }, el("h2", { style: { fontSize: "24px" } }, title), lede ? el("p", { class: "note measure" }, lede) : null, ...body,
    el("p", { class: "note", style: { marginTop: "24px" } }, el("a", { href: "#/signin" }, "Back to sign in")))));
VIEWS.forgot = () => {
  const out = el("div", { "aria-live": "polite" });
  const email = input({ type: "email", autocomplete: "email", required: true, inputmode: "email" });
  const send = btn("Send reset link", { kind: "primary", type: "submit" });
  const form = el("form", { novalidate: true }, field("Email", email), el("div", { class: "row" }, send), out);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    send.setAttribute("aria-busy", "true");
    try { const r = await api("POST", "/auth/forgot", { email: email.value }); clear(out, msg("go", r.message)); form.querySelector("input").disabled = true; send.disabled = true; }
    catch (err) { clear(out, msg("stop", err.message)); }
    finally { send.removeAttribute("aria-busy"); }
  });
  gateShell("Reset your password", "Enter the email you signed up with. We'll send a link to set a new password.", form);
  email.focus();
};
VIEWS.reset = async (token = "") => {
  history.replaceState(null, "", "#/reset"); // the token is single-use; keep it out of history
  gateShell("Set a new password", null, loading());
  const r = await api("POST", "/auth/reset/check", { token }).catch(() => ({ valid: false }));
  if (!r.valid) {
    gateShell("This link has expired", "Reset links work once, for 30 minutes. Ask for a new one.", el("div", { class: "row" }, el("a", { class: "btn primary", href: "#/forgot" }, "Send a new link")));
    return;
  }
  const out = el("div", { "aria-live": "polite" });
  const pw = input({ type: "password", autocomplete: "new-password", required: true, minlength: 10 });
  const pw2 = input({ type: "password", autocomplete: "new-password", required: true });
  const save = btn("Set password and sign in", { kind: "primary", type: "submit" });
  const form = el("form", { novalidate: true }, field("New password", pw, "(at least 10 characters)"), field("Type it again", pw2), el("div", { class: "row" }, save), out);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (pw.value !== pw2.value) { clear(out, msg("stop", "The two passwords don't match.")); return; }
    save.setAttribute("aria-busy", "true");
    try {
      await api("POST", "/auth/reset", { token, password: pw.value });
      tokenStore.set(null);
      await loadMe();
      toast("Password changed. You're signed in, and every other session was signed out.");
      location.hash = state.me && state.me.onboarding.complete ? "#/today" : "#/setup";
    } catch (err) { clear(out, msg("stop", err.message)); }
    finally { save.removeAttribute("aria-busy"); }
  });
  gateShell("Set a new password", "Setting it signs you in here and signs out every other device.", form);
  pw.focus();
};

// ---------------------------------------------------------------- setup wizard
const STEP_HELP = {
  work_auth: ["Where can you work?", "Pick the countries you're applying in and your status in each. If you need sponsorship, we only show employers with a public record of sponsoring."],
  targets: ["Which roles?", "Add the job titles you're applying for. Pay floors are optional; jobs that post less are flagged, not hidden."],
  facts: ["Start with your resume", "Upload it and we'll fill in your experience, education, skills, languages and contact details. You check it once and save."],
  languages: ["Languages", "Jobs that need a language you haven't listed are left out; a higher level than yours is flagged."],
  answers: ["Essential answers", "The questions every form asks. Packets copy these exactly and nothing is ever guessed."],
  network: ["LinkedIn connections (optional)", "Import your own LinkedIn export to see who can refer you. Nothing is scraped and your LinkedIn login is never used."],
};
VIEWS.setup = async (stepId) => {
  await loadMe();
  const steps = state.me.onboarding.steps;
  const current = steps.find((s) => s.id === stepId) || steps.find((s) => !s.done) || steps[steps.length - 1];
  const idx = steps.indexOf(current);
  const stepper = el("ol", { class: "stepper", "aria-label": "Setup progress" }, steps.map((s, i) =>
    el("li", { class: [s.done ? "done" : "", s === current ? "current" : "", s.optional ? "optional" : ""].join(" ") },
      el("a", { href: `#/setup/${s.id}`, "aria-current": s === current ? "step" : null },
        el("span", { class: "dot" }), el("span", {}, s.label, s.done ? el("span", { class: "vh" }, " (done)") : null)))));
  const body = el("div");
  const out = el("div");
  const next = async () => {
    await loadMe();
    const after = state.me.onboarding.steps.slice(idx + 1).find((s) => !s.done);
    location.hash = after ? `#/setup/${after.id}` : "#/setup/finish";
  };
  if (stepId === "finish" || (state.me.onboarding.complete && !stepId)) return setupFinish(stepper);
  const [title, help] = STEP_HELP[current.id];
  render(el("div", { class: "wizard" }, stepper, pageHead(title, help), out, body));
  await STEP_FORMS[current.id](body, next, out);
};
async function setupFinish(stepper) {
  const out = el("div");
  const go = btn("Build my first queue", { kind: "primary", icon: "arrow" });
  action(go, out, async () => {
    const r = await api("POST", "/queue/build");
    toast(`Queued ${r.queued}`);
    location.hash = "#/today";
  });
  render(el("div", { class: "wizard" }, stepper,
    pageHead(state.me.onboarding.complete ? "You're set up" : "Almost there",
      state.me.onboarding.complete
        ? "Your first queue is built from your targets, your confirmed facts and the employers that sponsor. After today it's rebuilt every morning at 06:05 UTC."
        : "Some required steps are still open. Pick one above to finish it."),
    state.me.onboarding.complete ? el("div", { class: "row" }, go, el("a", { class: "btn quiet", href: "#/settings" }, "Review settings first")) : null, out));
}
/** What "needs sponsorship" means in each country, shown under the status it applies to. */
const SPONSOR_EVIDENCE = {
  US: "Only employers with H-1B (LCA) and PERM filings",
  GB: "Only employers on the Home Office register of licensed sponsors",
  CA: "Only employers with approved LMIA positions",
  IE: "Only employers issued Irish employment permits (DETE); pay must reach the €40,904 Critical Skills or €36,605 General permit minimum",
  IT: "Italy publishes no sponsor list, so the posting's wording decides; pay must reach about €36,300 for an EU Blue Card",
};
/**
 * One country in the work-authorization grid: name, status and what that status means, aligned in
 * the same columns on the setup step and in Settings. `on` is the "applying here" checkbox, if any.
 */
function authRow(code, nameCell, status, on, ...extra) {
  const note = el("p", { class: "auth-note" });
  const row = el("div", { class: "auth-row" }, nameCell, status, ...extra, note);
  const sync = () => {
    const active = on ? on.checked : !!status.value;
    if (on) status.disabled = !on.checked;
    row.classList.toggle("off", !active);
    // In Settings the select itself already says "Not applying here".
    note.textContent = !active ? (on ? "Not applying here" : "") : status.value === "needs_sponsorship" ? SPONSOR_EVIDENCE[code] : "Every employer is shown";
  };
  if (on) on.addEventListener("change", sync);
  status.addEventListener("change", sync);
  sync();
  return row;
}
const wizardFoot = (primary, note, skip) => el("div", { class: "wizard-foot" }, el("span", { class: "grow" }, note || ""), skip, primary);

const STEP_FORMS = {
  async work_auth(body, next, out) {
    let p = null;
    try { p = await api("GET", "/profile"); } catch (e) { if (e.status !== 404) throw e; }
    const have = new Map(((p && p.workAuth) || []).map((a) => [a.country, a]));
    const home = select([["", "Choose…"], ...COUNTRIES, ["IN", "India"], ["CN", "China"], ["XX", "Somewhere else"]], (p && p.settings.home_country) || "", { id: "home-country" });
    const rows = COUNTRIES.map(([code, name]) => {
      const on = input({ type: "checkbox", checked: have.has(code) || (!have.size && code === "US"), id: `wa-${code}` });
      const st = select(workStatusFor(code), (have.get(code) || {}).status || "needs_sponsorship", { "aria-label": `Your status in ${name}` });
      return { code, on, st, node: authRow(code, el("label", { class: "check auth-name", for: on.id }, on, el("span", {}, name)), st, on) };
    });
    const save = btn("Save and continue", { kind: "primary", icon: "arrow" });
    action(save, out, async () => {
      const picked = rows.filter((r) => r.on.checked);
      if (!picked.length) throw new Error("Tick at least one country you're applying in.");
      const s = (p && p.settings) || {};
      await api("PUT", "/profile", { homeCountry: home.value && home.value !== "XX" ? home.value : null, dailyTarget: s.daily_target ?? 10, maxActiveProcesses: s.max_active_processes ?? 8, offerWindowStart: s.offer_window_start ?? null });
      for (const r of picked) await api("PUT", `/work-auth/${r.code}`, { status: r.st.value });
      await next();
    });
    clear(body, el("div", { class: "sheet" },
      el("div", { class: "auth-row" }, el("label", { class: "auth-name", for: home.id }, "Home country"), home),
      el("fieldset", { class: "auth-set" },
        el("legend", {}, "Countries you're applying in"),
        el("p", { class: "note" }, "Tick each one and choose your status there."),
        rows.map((r) => r.node))),
      wizardFoot(save));
  },

  async targets(body, next, out) {
    const p = await api("GET", "/profile");
    const countries = p.workAuth.map((a) => a.country);
    const list = el("ul", { class: "list" });
    const drawList = (items) => clear(list, items.length ? items.map((t) => el("li", {}, el("span", { class: "grow" }, el("strong", {}, t.title), el("span", { class: "note" }, ` · ${COUNTRY_NAME[t.country] || t.country}${t.seniority ? ` · ${t.seniority}` : ""}${t.pay_floor ? ` · from ${money(t.pay_floor, t.pay_currency)}` : ""}`))))
      : el("li", { class: "note" }, "No roles yet."));
    drawList(p.targets);
    // Suggested from the most recent role on the resume, while there are no targets yet.
    const title = input({ placeholder: "Data Engineer, Analytics Engineer", autocomplete: "off", value: p.targets.length ? "" : state.suggestedTitle || "" });
    const country = select(countries.map((c) => [c, COUNTRY_NAME[c] || c]), countries[0]);
    const level = select([["", "Any level"], ["entry", "Entry"], ["mid", "Mid"], ["senior", "Senior"], ["lead", "Lead"], ["executive", "Executive"]], "");
    const floor = input({ type: "number", min: 0, step: 1000, inputmode: "numeric" });
    const add = btn("Add role", { icon: "plus" });
    action(add, out, async () => {
      const titles = title.value.split(",").map((t) => t.trim()).filter(Boolean);
      if (!titles.length) throw new Error("Type a job title first.");
      for (const t of titles) await api("POST", "/targets", { title: t, country: country.value, seniority: level.value || null, payFloor: floor.value ? Number(floor.value) : null, payCurrency: floor.value ? CURRENCY[country.value] || "USD" : null });
      title.value = ""; drawList((await api("GET", "/profile")).targets); toast("Added");
    });
    const cont = btn("Continue", { kind: "primary", icon: "arrow" });
    action(cont, out, async () => { if (!(await api("GET", "/profile")).targets.length) throw new Error("Add at least one role."); await next(); });
    clear(body, el("div", { class: "sheet stack" }, list,
      el("div", { class: "grid" }, field("Job titles", title, "(comma separated)"), field("Country", country), field("Level", level), field(`Pay floor (${CURRENCY[countries[0]] || "USD"})`, floor, "(optional)")),
      el("div", { class: "row" }, add)), wizardFoot(cont));
  },

  async facts(body, next, out) {
    await resumeStep(body, next, out); // resume-step.js
  },

  async languages(body, next, out) {
    const p = await api("GET", "/profile");
    const editor = languagesEditor(p.languages);
    const save = btn("Save and continue", { kind: "primary", icon: "arrow" });
    action(save, out, async () => { await api("PUT", "/languages", editor.read()); await next(); });
    clear(body, el("div", { class: "sheet" }, editor.node), wizardFoot(save));
  },

  async answers(body, next, out) {
    const [r, p] = await Promise.all([api("GET", "/answers"), api("GET", "/profile")]);
    const mine = new Set(p.workAuth.map((a) => a.country.toLowerCase()));
    // Contact details, then the work-authorization questions of each country applied in.
    const wanted = r.missing.filter((q) => q.key.startsWith("contact.") || (/^(us|ie|it)\./.test(q.key) && mine.has(q.key.slice(0, 2)) && /right_to_work|needs_|work_authorized/.test(q.key)));
    const rows = wanted.map((q) => answerInput(q));
    const save = btn("Save and continue", { kind: "primary", icon: "arrow" });
    action(save, out, async () => {
      for (const row of rows) { const v = row.value(); if (v) await api("PUT", `/answers/${row.key}`, { answer: v, sensitive: row.sensitive }); }
      await loadMe();
      if (!state.me.onboarding.steps.find((s) => s.id === "answers").done) throw new Error(mine.size && [...mine].some((c) => ["us", "ie", "it"].includes(c)) ? "Fill in your name, email and the work questions for each country." : "Fill in your name and email.");
      await next();
    });
    clear(body, el("div", { class: "sheet" }, rows.length ? rows.map((x) => x.node) : el("p", {}, "These are all answered. You can change them any time in Settings.")),
      wizardFoot(save, "More questions (salary, notice period, voluntary EEO) are in Settings › Answer bank."));
  },

  async network(body, next, out) {
    const skip = el("a", { class: "btn quiet", href: "#/setup/finish" }, "Skip for now");
    const imp = linkedinImport(async () => { await loadMe(); location.hash = "#/setup/finish"; });
    clear(body, el("div", { class: "sheet" }, imp), wizardFoot(el("a", { class: "btn primary", href: "#/setup/finish" }, "Continue"), null, skip));
  },
};

function answerInput(q, current = "") {
  const yesNo = q.hint && /yes\s*\/\s*no/i.test(q.hint);
  const control = yesNo ? select([["", "Choose…"], ["Yes", "Yes"], ["No", "No"]], current) : input({ value: current, placeholder: q.hint || "", autocomplete: q.key === "contact.email" ? "email" : q.key === "contact.full_name" ? "name" : q.key === "contact.phone" ? "tel" : "off" });
  const node = el("div", { class: "field" }, el("label", { class: "lbl", for: (control.id = `a-${q.key.replace(/\W/g, "-")}`) }, q.label, q.sensitive ? el("div", { class: "note" }, "Copied exactly, never rewritten") : null), control, el("span"));
  return { key: q.key, sensitive: !!q.sensitive, node, value: () => control.value.trim() };
}
function languagesEditor(items) {
  const LEVELS = [["A1", "A1 beginner"], ["A2", "A2"], ["B1", "B1 intermediate"], ["B2", "B2"], ["C1", "C1 advanced"], ["C2", "C2 proficient"], ["native", "Native"]];
  const rows = el("ul", { class: "list" });
  const add = (l = { language: "", level: "C1" }) => {
    const li = el("li", {}, el("div", { class: "grow", style: { maxWidth: "280px" } }, input({ value: l.language, placeholder: "Language", "aria-label": "Language" })),
      el("div", { style: { width: "180px" } }, select(LEVELS, l.level, { "aria-label": "Level" })));
    li.append(btn("Remove", { kind: "quiet", small: true, onclick: () => li.remove() }));
    rows.append(li);
  };
  (items.length ? items : [{ language: "English", level: "C2" }]).forEach(add);
  return {
    node: el("div", {}, rows, el("div", { class: "row", style: { marginTop: "8px" } }, btn("Add language", { icon: "plus", small: true, onclick: () => add() }))),
    read: () => [...rows.children].map((r) => ({ language: r.querySelector("input").value.trim(), level: r.querySelector("select").value })).filter((l) => l.language),
  };
}

// ---------------------------------------------------------------- today
async function windowStrip(timing) {
  const w = timing.window;
  const live = timing.estimates.length;
  const label = w.start ? `${fmtDate(w.start)} – ${fmtDate(w.end)}` : "No window yet";
  return el("div", { class: "strip", role: "region", "aria-label": "Offer window" },
    el("span", { class: "cap" }, "Offer window", el("span", { style: { fontWeight: 600 } }, label)),
    el("span", { class: "facts" },
      el("span", {}, el("b", {}, live), ` live ${live === 1 ? "process" : "processes"}`),
      w.start ? el("span", {}, el("b", {}, w.inside), " expected inside") : null,
      timing.heldBack.length ? el("span", {}, el("b", {}, timing.heldBack.length), " dream ", timing.heldBack.length === 1 ? "role" : "roles", " held back") : null,
      el("span", {}, w.source === "yours" ? "Window set by you" : w.source === "estimated" ? "Window estimated from live processes" : "Set a target date in Profile")),
    el("a", { href: "#/applications" }, "See the map"));
}
VIEWS.today = async (notice = null) => {
  if (!state.me.onboarding.complete && !state.me.hasProfile) { location.hash = "#/setup"; return; }
  const [q, timing, followups, sugg] = await Promise.all([api("GET", "/queue"), api("GET", "/timing"), api("GET", "/followups").catch(() => ({ items: [] })),
    api("GET", "/inbound/suggestions").catch(() => ({ items: [] }))]);
  state.followupCount = followups.items.length; shell("today");
  const out = el("div", { "aria-live": "polite" });
  const list = el("ul", { class: "queue", "aria-label": "Today's queue" });
  const build = btn(q.items.length ? "Rebuild queue" : "Build today's queue", { kind: q.items.length ? "" : "primary" });
  const summary = (r) => {
    const none = !r.queued && !r.excluded && !r.heldBack;
    return msg(none ? "hold" : "go", none ? (r.note || "No jobs matched yet.")
      : `Queued ${r.queued}. Left out ${r.excluded}${r.heldBack ? `, held back ${r.heldBack} for your offer window` : ""}.${r.note ? ` ${r.note}` : ""}`);
  };
  // Fetching and ranking run as a GitHub job (the Worker's free plan is too small for them), so the
  // page starts it and watches for the new queue. It keeps watching if you leave and come back.
  const watch = async (since) => {
    const status = el("p", { class: "note", role: "status" }, "Fetching new jobs and ranking them. This usually takes 1 to 3 minutes; you can leave this page.");
    clear(out, msg("info", status));
    build.setAttribute("aria-busy", "true");
    const until = Date.now() + 8 * 60_000;
    try {
      while (Date.now() < until) {
        await new Promise((ok) => setTimeout(ok, 8000));
        if (!location.hash.startsWith("#/today") || !document.body.contains(out)) return;
        const p = await api("GET", "/queue/refresh");
        if (p.done && p.run) { await VIEWS.today(summary(p.run)); return; }
      }
      clear(out, msg("hold", "This is taking longer than usual. Your queue will appear here when it's ready; check back in a few minutes."));
    } catch (e) { clear(out, msg("stop", e.message)); }
    finally { build.removeAttribute("aria-busy"); }
  };
  build.addEventListener("click", async (e) => {
    e.preventDefault();
    if (build.getAttribute("aria-busy") === "true") return;
    build.setAttribute("aria-busy", "true");
    try {
      const r = await api("POST", "/queue/refresh");
      build.removeAttribute("aria-busy");
      watch(r.requestedAt);
    } catch (err) {
      build.removeAttribute("aria-busy");
      if (err.status === 503) {
        // On-demand fetching isn't set up: rank what's already in the catalog.
        try { const r = await api("POST", "/queue/build"); await VIEWS.today(summary(r)); }
        catch (e2) { clear(out, msg("stop", e2.message)); }
      } else if (err.status !== 401) clear(out, msg("stop", err.message));
    }
  });
  if (notice instanceof Node) out.append(notice);
  else api("GET", "/queue/refresh").then((p) => { if (p.requestedAt && !p.done && Date.now() - new Date(p.requestedAt) < 8 * 60_000) watch(p.requestedAt); }).catch(() => {});
  const pending = q.items.filter((i) => i.state === "queued").length;
  const now = new Date();
  const head = el("div", { class: "today-head" },
    el("h1", {}, el("span", { class: "wd" }, now.toLocaleDateString(undefined, { weekday: "long" })),
      now.toLocaleDateString(undefined, { day: "numeric", month: "long" })),
    el("div", { class: "acts" }, el("a", { class: "btn quiet", href: "#/score" }, "Score a posting"), build),
    q.items.length ? el("p", { class: "lede" }, pending
      ? `${plural(pending, "role")} to review. Approve what you'll apply to, ask for a referral first where you can, then open the packet.`
      : "Everything in today's queue has a decision. Open the packets for the roles you approved.") : null);
  const excluded = el("div");
  let line = q.items.length ? dayLine(q.items) : null;
  onQueueChange = () => { if (line && line.isConnected) { const n = dayLine(q.items); line.replaceWith(n); line = n; } };
  render(head, await windowStrip(timing), suggestionsSheet(sugg.items), line, out,
    !state.me.onboarding.complete ? msg("hold", "Setup isn't finished, so the queue may be thin. ", el("a", { href: "#/setup" }, "Finish setup")) : null,
    q.items.length ? list : el("div", { class: "sheet empty" }, el("h3", {}, "Nothing queued for today"),
      el("p", { class: "note measure" }, "The queue is rebuilt every morning at 06:05 UTC from your targets, confirmed facts and the employers that sponsor. Build it now, or widen your targets in Profile."),
      el("div", { class: "row" }, el("a", { class: "btn", href: "#/profile" }, "Edit targets"))),
    excluded);
  for (const item of q.items) list.append(queueRow(item));
  const run = await api("GET", `/queue/runs/${todayIso()}`).catch(() => null);
  if (run && run.excluded && run.excluded.length)
    clear(excluded, el("details", { class: "sheet", style: { marginTop: "16px" } }, el("summary", {}, `Left out today: ${run.excluded.length}`),
      el("p", { class: "note" }, "Every job the builder skipped, with the reason. Change a setting if a reason looks wrong."),
      el("ul", { class: "list" }, run.excluded.slice(0, 200).map((x) => el("li", { class: "note" }, x.reason)))));
};
// Email proposes, you decide: each forwarded email that would change something waits here.
function suggestionsSheet(items) {
  if (!items || !items.length) return null;
  const list = el("ul", { class: "list suggestions" });
  const box = el("section", { class: "sheet", "aria-labelledby": "h-sugg", style: { marginBottom: "var(--s5)" } },
    el("div", { class: "sheet-head" }, el("h2", { id: "h-sugg" }, "From your email"), el("span", { class: "note" }, `${plural(items.length, "update")} to confirm`)), list);
  const row = (it) => {
    const s = it.suggestion || {};
    const out = el("div", { "aria-live": "polite" });
    const add = !it.application_id && s.company;
    const what = add
      ? el("span", {}, "Add ", el("strong", {}, s.company), s.title ? ` · ${s.title}` : "", "? You applied outside the app.")
      : el("span", {}, "Move ", routeBadge(it.company_id, it.company), " ", it.title ? el("span", { class: "note" }, `${it.title} `) : "", "to ", el("strong", {}, STATE_LABEL[s.to] || s.to), "?");
    const yes = btn(add ? "Add" : "Move", { small: true, kind: "primary" });
    const no = btn("Ignore", { small: true, kind: "quiet" });
    const li = el("li", { class: "sugg" },
      el("div", { class: "grow" }, el("div", { class: "what" }, what),
        el("div", { class: "note" }, `"${short(it.subject || "", 90)}" · ${short(it.from_address || "", 40)} · ${fmtDate(it.received_at, { month: "short", day: "numeric" })}`), out),
      el("div", { class: "acts" }, no, yes));
    const done = () => { li.remove(); if (!list.children.length) box.remove(); };
    action(yes, out, async () => { await api("POST", `/inbound/${it.id}/accept`); toast(add ? `Added ${s.company}` : `Moved to ${STATE_LABEL[s.to] || s.to}`); done(); });
    action(no, out, async () => { await api("POST", `/inbound/${it.id}/ignore`); done(); });
    return li;
  };
  list.append(...items.map(row));
  return box;
}
let onQueueChange = () => {};
// Today's line: one stop per role in the queue, filled once you approve or apply.
function dayLine(items) {
  const moved = (i) => !["queued", "skipped"].includes(i.state);
  const done = items.filter(moved).length;
  const order = [...items].sort((a, b) => Number(moved(b)) - Number(moved(a)) || Number(a.state === "skipped") - Number(b.state === "skipped"));
  const pct = items.length > 1 ? ((Math.max(done, 1) - 1) / (items.length - 1)) * 100 : done ? 100 : 0;
  return el("div", { class: "dayline" },
    el("div", { class: "count" }, el("b", {}, done), ` of ${items.length} approved`),
    el("ol", { style: { "--done": `${done ? pct : 0}%` }, "aria-hidden": "true" },
      order.map((i) => el("li", { class: moved(i) ? "on" : i.state === "skipped" ? "skip" : "" }, el("span")))));
}
function payLine(item) {
  const posted = item.pay_max || item.pay_min ? `${item.pay_min ? money(item.pay_min, item.pay_currency) + " – " : ""}${money(item.pay_max || item.pay_min, item.pay_currency)}` : null;
  const b = item.pay_benchmark;
  const bench = b ? `${b.scope === "company" ? "Filed" : "Market"} median ${money(b.p50, b.currency)} (${plural(b.n, "filing")})` : null;
  return [posted, bench].filter(Boolean).join(" · ");
}
function queueRow(item) {
  const drawer = el("div", { class: "drawer" });
  const tags = [];
  if (item.integrity === "alarm") tags.push(el("span", { class: "tag stop" }, icon("alert"), "Hidden text in posting"));
  if (item.gate_verdict === "FLAG") tags.push(el("span", { class: "tag hold" }, "Check requirements"));
  if (item.referral_name) tags.push(el("span", { class: "tag go" }, icon("user"), `Referral asked: ${item.referral_name}`));
  else if (item.contacts) tags.push(el("span", { class: "tag" }, icon("user"), `${plural(item.contacts, "contact")} there`));
  if (item.state !== "queued") tags.push(stateTag(item.state));
  const li = el("li", { class: "qrow" });
  const acts = el("div", { class: "acts" });
  const draw = () => {
    acts.replaceChildren();
    if (item.contacts && !item.referral_name) acts.append(btn("Referrals", { small: true, onclick: () => showReferrals(item, drawer) }));
    if (item.state === "queued") {
      const ap = btn("Approve", { kind: "primary", small: true, icon: "check" });
      action(ap, drawer, async () => { await moveTo(item.id, "approved"); item.state = "approved"; li.replaceWith(queueRow(item)); onQueueChange(); });
      const sk = btn("Skip", { small: true, kind: "quiet" });
      action(sk, drawer, async () => { await moveTo(item.id, "skipped"); item.state = "skipped"; onQueueChange(); li.classList.add("done"); acts.replaceChildren(el("span", { class: "note" }, "Skipped")); });
      acts.append(el("a", { class: "btn small quiet", href: `#/packet/${item.job_id}` }, "Packet"), sk, ap);
    } else acts.append(el("a", { class: "btn small primary", href: `#/packet/${item.job_id}` }, "Open packet", icon("arrow")));
  };
  draw();
  append(li, [
    el("div", { class: `fit${(item.fit_score ?? 0) < 60 ? " low" : ""}`, title: "Fit score out of 100, from your confirmed facts" }, item.fit_score ?? "–", el("small", {}, "fit")),
    el("div", {}, el("h3", {}, routeBadge(item.company_id, item.company), el("span", { class: "title" }, item.title)),
      el("div", { class: "meta" }, [item.location_text, item.remote_type, payLine(item)].filter(Boolean).join(" · ")),
      tags.length ? el("div", { class: "tags" }, tags) : null,
      item.notes ? el("p", { class: "note" }, item.notes) : null),
    acts, drawer]);
  return li;
}
async function showReferrals(item, box) {
  clear(box, loading());
  try {
    const r = await api("GET", `/referrals/${item.job_id}`);
    const out = el("div");
    clear(box, el("div", { style: { marginTop: "12px" } }, out, r.items.length ? r.items.map((p) => {
      const asked = btn("I asked", { kind: "primary", small: true, icon: "check" });
      action(asked, out, async () => { await api("POST", `/applications/${item.id}/referral`, { contactId: p.id }); toast("Ask recorded"); item.referral_name = p.full_name; box.closest(".qrow").replaceWith(queueRow(item)); });
      return el("div", { class: "person" },
        el("div", {}, el("strong", {}, p.full_name), el("div", { class: "note" }, [p.position, p.messages_count ? plural(p.messages_count, "message") : null, p.last_ask_at ? `asked ${fmtDay(p.last_ask_at)}` : null].filter(Boolean).join(" · "))),
        el("div", { class: "acts" },
          p.profile_url ? el("a", { class: "btn small", href: p.profile_url, target: "_blank", rel: "noopener noreferrer" }, "Open LinkedIn", icon("out")) : null,
          btn("Copy message", { small: true, icon: "copy", onclick: () => copy(p.draft) }), asked),
        el("pre", { class: "draft" }, p.draft));
    }) : el("p", { class: "note" }, "No contacts here yet.")));
  } catch (e) { clear(box, msg("stop", e.message)); }
}

// ---------------------------------------------------------------- applications: the map and the table
function basisOf(timing) {
  const v = Object.values(timing.basis || {});
  return v.length && v.every((x) => x === "yours") ? "yours" : v.some((x) => x === "yours") ? "mixed" : "default";
}
const ACTIVE = ["submitted", "screen", "interview", "offer"];
const PREP = ["queued", "approved", "ready_for_review", "failed"];
const CLOSED = ["rejected", "withdrawn", "skipped"];
const STAGE_DEPTH = { submitted: 1, screen: 2, interview: 3, offer: 4 };

function transitMap(apps, timing) {
  const etaBy = new Map(timing.estimates.map((e) => [e.appId, e.expectedOffer]));
  const live = apps.filter((a) => ACTIVE.includes(a.state))
    .sort((a, b) => STAGE_DEPTH[b.state] - STAGE_DEPTH[a.state] || String(etaBy.get(a.id) || "").localeCompare(String(etaBy.get(b.id) || "")));
  // Six lines at most: live processes first, with up to two kept for held-back dream roles.
  const held = timing.heldBack.slice(0, Math.min(2, Math.max(0, 6 - Math.min(live.length, 4))));
  const shown = live.slice(0, 6 - held.length);
  // Narrow screens stack each company's name above its line instead of beside it.
  const compact = window.matchMedia("(max-width: 640px)").matches;
  const W = compact ? 340 : 1000, LEFT = compact ? 6 : 210;
  const COLS = compact ? [{ x: 40, label: "Sent" }, { x: 125, label: "Screen" }, { x: 210, label: "Interview" }] : [{ x: 300, label: "Submitted" }, { x: 470, label: "Screen" }, { x: 640, label: "Interview" }];
  const CAPX = compact ? 296 : 880, CAPW = compact ? 34 : 46, ROW = compact ? 60 : 48, TOP = compact ? 50 : 44;
  const n = shown.length + held.length;
  const H = TOP + Math.max(n, 1) * ROW + 34;
  const s = svg("svg", { class: "transit", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-labelledby": "transit-title transit-desc" });
  const w = timing.window;
  const winText = w.start ? `${fmtDate(w.start)} – ${fmtDate(w.end)}` : "not set";
  s.append(svg("title", { id: "transit-title" }, "Live applications converging on the offer window"),
    svg("desc", { id: "transit-desc" }, `${plural(shown.length, "live process", "live processes")} shown, ${held.length} held back. Offer window ${winText}. The table below lists every application.`));
  for (const c of COLS) {
    s.append(svg("text", { class: "col", x: c.x, y: 18, "text-anchor": "middle" }, c.label));
    s.append(svg("line", { class: "guide", x1: c.x, x2: c.x, y1: 28, y2: H - 26 }));
  }
  s.append(svg("text", { class: "col", x: compact ? CAPX + CAPW : CAPX + CAPW / 2, y: 18, "text-anchor": compact ? "end" : "middle" }, compact ? "Offers" : "Offer window"));
  if (compact) s.classList.add("compact");
  const capTop = TOP - 18, capH = Math.max(n, 1) * ROW + 4;
  s.append(svg("rect", { x: CAPX, y: capTop, width: CAPW, height: capH, rx: CAPW / 2, fill: "var(--interchange)", stroke: "var(--ground)", "stroke-width": 3 }));
  s.append(svg("text", { class: "cap-date", x: compact ? CAPX + CAPW : CAPX + CAPW / 2, y: capTop + capH + 18, "text-anchor": compact ? "end" : "middle" }, winText));

  shown.forEach((a, i) => {
    const y = TOP + i * ROW + ROW / 2 - 14 + (compact ? 10 : 0);
    const colour = lineColour(a.company_id);
    const depth = STAGE_DEPTH[a.state];
    const endX = depth >= 4 ? CAPX + 6 : COLS[depth - 1].x;
    const g = svg("g", { style: `--delay:${i * 70}ms` });
    const solid = svg("path", { class: "line-solid", d: `M${LEFT} ${y} H${endX}`, stroke: colour, style: `--len:${endX - LEFT}` });
    const eta = etaBy.get(a.id);
    // Only offers expected inside the window join the interchange; early or late ones stop short of it.
    const off = depth < 4 && eta && w.start ? (eta < w.start ? "early" : eta > w.end ? "late" : null) : null;
    const stopX = off ? CAPX - (compact ? 30 : 56) : CAPX;
    if (depth < 4) g.append(svg("path", { class: "line-ahead", d: `M${endX} ${y} H${stopX}`, stroke: colour }));
    if (off) g.append(svg("path", { d: `M${stopX} ${y - 8} V${y + 8}`, stroke: colour, "stroke-width": 4, "stroke-linecap": "round" }));
    g.append(solid);
    COLS.forEach((c, k) => {
      const reached = k < depth;
      g.append(svg("circle", { cx: c.x, cy: y, r: k === depth - 1 && depth < 4 ? 9 : 7, fill: reached ? colour : "var(--sheet)", stroke: colour, "stroke-width": 4 }));
    });
    const etaText = depth >= 4 ? "Offer" : eta ? `≈ ${fmtDate(eta)}${off ? `, ${off}` : ""}` : null;
    if (etaText) g.append(svg("text", { class: `eta ${off ? "off" : ""}`, x: (off ? stopX : CAPX) - 8, y: compact ? y - 16 : y - 9, "text-anchor": "end" }, etaText));
    const link = compact
      ? svg("a", { href: `#/packet/${a.job_id}` }, svg("text", { class: "name", x: 0, y: y - 16 }, short(a.company, 20)))
      : svg("a", { href: `#/packet/${a.job_id}` },
        svg("text", { class: "name", x: 0, y: y - 2 }, short(a.company, 22)),
        svg("text", { class: "sub", x: 0, y: y + 14 }, `${short(a.title, 24)} · ${STATE_LABEL[a.state].toLowerCase()}`));
    g.prepend(link);
    s.append(g);
  });
  held.forEach((h, j) => {
    const y = TOP + (shown.length + j) * ROW + ROW / 2 - 14 + (compact ? 10 : 0);
    const colour = lineColour(h.companyId);
    s.append(svg("g", {},
      svg("text", { class: "name", x: 0, y: compact ? y - 16 : y - 2 }, short(h.company || "Dream role", 22)),
      svg("text", { class: "sub", x: compact ? CAPX - 8 : 0, y: compact ? y - 16 : y + 14, "text-anchor": compact ? "end" : null }, `held until ${fmtDate(h.releaseOn)}`),
      svg("path", { class: "line-held", d: `M${LEFT} ${y} H${CAPX}`, stroke: colour })));
  });
  if (!n) {
    s.append(svg("text", { class: "sub", x: LEFT, y: TOP + 6 }, compact ? "No live processes yet." : "No live processes yet. Mark an application submitted and it joins the map."));
    s.append(svg("path", { class: "line-ahead", d: `M${LEFT} ${TOP + 20} H${CAPX}`, stroke: "var(--rule-strong)" }));
  }
  if (live.length + timing.heldBack.length > shown.length + held.length) s.setAttribute("data-more", String(live.length - shown.length));
  return { node: s, hidden: live.length - shown.length };
}
function legendSwatch(kind) {
  const s = svg("svg", { width: 34, height: 12, "aria-hidden": "true" });
  if (kind === "done") s.append(svg("path", { d: "M2 6 H24", stroke: "var(--ink)", "stroke-width": 5, "stroke-linecap": "round" }), svg("circle", { cx: 26, cy: 6, r: 4, fill: "var(--ink)" }));
  if (kind === "ahead") s.append(svg("path", { d: "M2 6 H32", stroke: "var(--ink)", "stroke-width": 3, "stroke-linecap": "round", "stroke-dasharray": "1 6" }));
  if (kind === "short") s.append(svg("path", { d: "M2 6 H24", stroke: "var(--ink)", "stroke-width": 3, "stroke-dasharray": "1 6", "stroke-linecap": "round" }), svg("path", { d: "M27 1 V11", stroke: "var(--ink)", "stroke-width": 3, "stroke-linecap": "round" }));
  if (kind === "held") s.append(svg("path", { d: "M2 6 H32", stroke: "var(--ink)", "stroke-width": 3, "stroke-dasharray": "8 5" }));
  return s;
}

VIEWS.applications = async () => {
  const [r, timing] = await Promise.all([api("GET", "/applications"), api("GET", "/timing")]);
  const apps = r.items;
  assignLines([...apps.map((a) => a.company_id), ...timing.heldBack.map((h) => h.companyId)], [...apps.filter((a) => ACTIVE.includes(a.state)).map((a) => a.company_id), ...timing.heldBack.map((h) => h.companyId)]);
  const etaBy = new Map(timing.estimates.map((e) => [e.appId, e.expectedOffer]));
  const map = transitMap(apps, timing);
  if (!sessionStorage.getItem("mca_drawn")) { map.node.classList.add("draw"); try { sessionStorage.setItem("mca_drawn", "1"); } catch {} }
  const basis = { yours: "from your own stage history", mixed: "partly from your own history, partly from typical stage times", default: "from typical stage times until you have your own" }[basisOf(timing)];

  // filters
  const groups = [["active", "Active", ACTIVE], ["prep", "In prep", PREP], ["closed", "Closed", CLOSED], ["all", "All", null]];
  const ui = { group: apps.some((a) => ACTIVE.includes(a.state)) ? "active" : "all", q: "", sort: "activity", dir: -1 };
  const chips = el("div", { class: "chips", role: "group", "aria-label": "Filter by stage" });
  const searchBox = input({ type: "search", placeholder: "Company, role or note", "aria-label": "Search applications" });
  searchBox.addEventListener("input", () => { ui.q = searchBox.value.trim().toLowerCase(); draw(); });
  const tbody = el("tbody");
  const out = el("div", { "aria-live": "polite" });
  const cols = [["company", "Company"], ["stage", "Stage"], ["submitted", "Submitted", "num"], ["activity", "Last activity", "num"], ["eta", "Expected offer", "num"], [null, "Referral"], [null, "Notes"], [null, "Move"]];
  const thead = el("tr");
  const sortVal = {
    company: (a) => String(a.company).toLowerCase(),
    stage: (a) => STAGE_ORDER.indexOf(a.state),
    submitted: (a) => a.submitted_at || "",
    activity: (a) => a.last_event_at || "",
    eta: (a) => etaBy.get(a.id) || "9999",
  };
  const drawHead = () => clear(thead, cols.map(([key, label, cls]) => el("th", { class: cls || null, scope: "col", "aria-sort": key && ui.sort === key ? (ui.dir > 0 ? "ascending" : "descending") : null },
    key ? el("button", { type: "button", onclick: () => { ui.dir = ui.sort === key ? -ui.dir : key === "company" || key === "eta" ? 1 : -1; ui.sort = key; draw(); } }, label) : label)));
  function draw() {
    drawHead();
    clear(chips, groups.map(([id, label, states]) => {
      const n = states ? apps.filter((a) => states.includes(a.state)).length : apps.length;
      return el("button", { type: "button", class: "chip", "aria-pressed": String(ui.group === id), onclick: () => { ui.group = id; draw(); } }, label, el("span", { class: "n" }, n));
    }));
    const states = groups.find((g) => g[0] === ui.group)[2];
    const rows = apps.filter((a) => (!states || states.includes(a.state)) &&
      (!ui.q || [a.company, a.title, a.notes, a.referral_name].some((v) => v && String(v).toLowerCase().includes(ui.q))))
      .sort((a, b) => { const x = sortVal[ui.sort](a), y = sortVal[ui.sort](b); return (x < y ? -1 : x > y ? 1 : 0) * ui.dir; });
    clear(tbody, rows.length ? rows.map((a) => appRow(a, etaBy, out)) : el("tr", {}, el("td", { colspan: cols.length },
      el("div", { class: "empty" }, el("h3", {}, apps.length ? "No applications match" : "No applications yet"),
        el("p", { class: "note" }, apps.length ? "Try another stage or clear the search." : "Approve roles on Today and they appear here, with every move logged.")))));
  }
  draw();
  render(pageHead("Applications", `Live processes converge on your offer window. Expected dates come ${basis}.`),
    el("div", { class: "transit-wrap" }, map.node,
      el("div", { class: "transit-legend" },
        el("span", {}, legendSwatch("done"), "Stages reached"), el("span", {}, legendSwatch("ahead"), "Still ahead"), el("span", {}, legendSwatch("held"), "Held back for timing"), el("span", {}, legendSwatch("short"), "Offer expected outside the window"),
        el("span", { class: "end" }, map.hidden > 0 ? `${map.hidden} more live in the table` : `Stage times: ${timing.stageDays.toScreen} / ${timing.stageDays.screenToInterview} / ${timing.stageDays.interviewToOffer} days`))),
    el("h2", {}, "All applications"),
    el("div", { class: "filters" }, el("div", { class: "search" }, icon("search"), searchBox), chips), out,
    el("div", { class: "tablebox" }, el("table", { class: "responsive" }, el("thead", {}, thead), tbody)));
};
function appRow(a, etaBy, out) {
  const tr = el("tr");
  const note = el("textarea", { class: "note-edit", rows: 1, value: a.notes || "", placeholder: "Add a note", "aria-label": `Note for ${a.company}`, maxlength: 2000 });
  note.addEventListener("blur", async () => {
    if ((a.notes || "") === note.value.trim()) return;
    try { await api("PATCH", `/applications/${a.id}/notes`, { notes: note.value }); a.notes = note.value.trim(); toast("Note saved"); }
    catch (e) { clear(out, msg("stop", e.message)); }
  });
  const moves = (NEXT[a.state] || []).filter((s) => s !== "submitted" && s !== a.state);
  const mover = moves.length ? select([["", "Move to…"], ...moves.map((s) => [s, STATE_LABEL[s]])], "", { "aria-label": `Move ${a.company} to` }) : null;
  if (mover) mover.addEventListener("change", async () => {
    if (!mover.value) return;
    try { await moveTo(a.id, mover.value); a.state = mover.value; a.last_event_at = new Date().toISOString(); tr.replaceWith(appRow(a, etaBy, out)); }
    catch (e) { clear(out, msg("stop", e.message)); mover.value = ""; }
  });
  const hist = btn("History", { kind: "quiet", small: true });
  let open = null;
  hist.setAttribute("aria-expanded", "false");
  hist.addEventListener("click", async () => {
    if (open) { open.remove(); open = null; hist.setAttribute("aria-expanded", "false"); return; }
    open = el("tr", { class: "history" }, el("td", { colspan: 8 }, loading()));
    tr.after(open); hist.setAttribute("aria-expanded", "true");
    try { const ev = await api("GET", `/applications/${a.id}/events`); clear(open.firstChild, timeline(ev.items)); }
    catch (e) { clear(open.firstChild, msg("stop", e.message)); }
  });
  append(tr, [
    el("td", { "data-label": "Company" }, el("a", { href: `#/packet/${a.job_id}`, class: "co" }, bullet(a.company_id, ACTIVE.includes(a.state)), a.company), el("div", { class: "title" }, a.title)),
    el("td", { "data-label": "Stage" }, stateTag(a.state)),
    el("td", { class: "num m-hide", "data-label": "Submitted" }, a.submitted_at ? fmtDate(a.submitted_at) : a.planned_date ? el("span", { class: "note" }, `planned ${fmtDate(a.planned_date)}`) : ""),
    el("td", { class: "num m-hide", "data-label": "Last activity" }, a.last_event_at ? fmtDate(a.last_event_at) : ""),
    el("td", { class: "num", "data-label": "Expected offer" }, etaBy.get(a.id) ? `≈ ${fmtDate(etaBy.get(a.id))}` : ""),
    el("td", { class: a.referral_name ? null : "m-hide", "data-label": "Referral" }, a.referral_name || el("span", { class: "note" }, "–")),
    el("td", { class: "notes", "data-label": a.notes ? "Notes" : null }, note),
    el("td", { "data-label": "Move" }, el("div", { class: "move" }, mover, hist)),
  ]);
  return tr;
}
function timeline(items) {
  if (!items.length) return el("p", { class: "note" }, "No history yet.");
  const describe = (e) => {
    const p = e.payload || {};
    if (e.kind === "state_change") return `${STATE_LABEL[p.from] || p.from || "New"} → ${STATE_LABEL[p.to] || p.to}${p.via === "email" ? " (from an email)" : ""}${p.note ? `: ${p.note}` : ""}`;
    if (e.kind === "employer_reply") return `Email from the employer: ${p.classification || "reply"}${p.subject ? ` “${short(p.subject, 70)}”` : ""}`;
    if (e.kind === "followup_sent") return "You sent a follow-up";
    if (e.kind === "thank_you_sent") return "You sent a thank-you";
    if (e.kind === "referral_asked") return `You asked ${p.name || "a contact"} for a referral`;
    return e.kind.replace(/_/g, " ");
  };
  return el("ol", { class: "timeline" }, items.map((e) => el("li", {}, el("time", { datetime: e.created_at }, fmtDate(e.created_at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })), el("span", {}, describe(e)))));
}

// ---------------------------------------------------------------- packet
VIEWS.packet = async (jobId) => {
  const [p, facts] = await Promise.all([api("GET", `/packets/${jobId}`), api("GET", "/facts")]);
  if (state.aiKey === undefined) state.aiKey = await api("GET", "/ai/key").then((r) => r.key).catch(() => null);
  const a = p.application;
  const out = el("div", { "aria-live": "polite" });
  const b = p.payBenchmark;
  const meta = [p.job.location_text, p.job.remote_type, a && STATE_LABEL[a.state]].filter(Boolean).join(" · ");
  const head = el("div", { class: "page-head" },
    el("div", { class: "grow" }, el("div", { class: "co-badge" }, routeBadge(p.job.company_id || p.job.company, p.job.company)), el("h1", { class: "co-head" }, p.job.title),
      el("p", { class: "lede" }, meta, b ? ` · ${b.scope === "company" ? "This employer's filed" : "Market"} median ${money(b.p50, b.currency)}, middle half ${money(b.p25, b.currency)}–${money(b.p75, b.currency)} (${plural(b.n, "filing")})` : "")),
    p.job.apply_url ? el("a", { class: "btn primary", href: p.job.apply_url, target: "_blank", rel: "noopener noreferrer" }, "Open application form", icon("out")) : null);
  const italian = p.language === "it";
  const lang = italian ? msg("info", el("strong", {}, "Italian application. "), "The posting is in Italian, so the CV, AI drafts and follow-ups are in Italian, and each answer shows what Italian forms call the field.") : null;
  const status = p.ready ? msg("go", "Packet ready. Fill in the form, review it, and submit it yourself.")
    : msg("hold", el("strong", {}, "Not ready yet"), el("ul", {}, p.blockers.map((x) => el("li", {}, x))));
  const integrity = p.job.integrity && p.job.integrity.level === "alarm"
    ? msg("stop", `This posting contains hidden or instruction-like text (${p.job.integrity.verdict}). Don't paste it into an AI tool.`) : null;

  const resume = el("section", { class: "sheet", "aria-labelledby": "h-resume" });
  resumeSheet(resume, p);
  const fields = el("section", { class: "sheet", "aria-labelledby": "h-fields" },
    el("div", { class: "sheet-head" }, el("h2", { id: "h-fields" }, "Copy into the form"), el("span", { class: "note" }, "Sensitive answers are copied exactly.")),
    p.fields.length ? p.fields.map((f) => el("div", { class: "field" }, el("div", { class: "lbl" }, f.label,
        f.formLabel ? el("div", { class: "note", lang: "it" }, `On the form: ${f.formLabel}`) : null, f.sensitive ? el("div", { class: "note" }, "Copy exactly") : null), el("div", { class: "val" }, f.value),
      btn("Copy", { small: true, icon: "copy", aria: `Copy ${f.label}`, onclick: () => copy(f.value) })))
      : el("p", { class: "note" }, "Your answer bank is empty. ", el("a", { href: "#/settings/answers" }, "Add answers"), " once and every packet uses them."),
    a && a.referral_name ? el("div", { class: "field" }, el("div", { class: "lbl" }, "Referred by"), el("div", { class: "val" }, a.referral_name), btn("Copy", { small: true, icon: "copy", onclick: () => copy(a.referral_name) })) : null);
  const editor = answersEditor(a, p.answers, facts.items, { ...p.job, language: p.language });
  const gateNotes = a && a.gates ? a.gates.flatMap((g) => g.notes.map((n) => `${g.gate}: ${n}`)) : [];
  const gates = gateNotes.length ? el("details", { class: "sheet" }, el("summary", {}, `Requirement notes (${gateNotes.length})`), el("ul", { class: "list" }, gateNotes.map((n) => el("li", { class: "note" }, n)))) : null;

  const actions = el("div", { class: "row" });
  if (a) {
    for (const s of (NEXT[a.state] || []).filter((x) => ["approved", "submitted", "failed", "skipped"].includes(x))) {
      if (s === "submitted") actions.append(confirmBtn("I submitted it", "Confirm: answers freeze after this", out, async () => { await moveTo(a.id, "submitted"); route(); }, "primary"));
      else { const x = btn({ approved: "Approve", failed: "Couldn't apply", skipped: "Skip" }[s]); action(x, out, async () => { await moveTo(a.id, s); route(); }); actions.append(x); }
    }
  }
  render(head, integrity, lang, status, out,
    el("div", { class: "stack" }, resume, fields, editor, gates),
    el("h2", {}, "Status"),
    a ? el("div", { class: "sheet" }, el("p", { style: { marginTop: 0 } }, "Now: ", stateTag(a.state)), actions.children.length ? actions : el("p", { class: "note" }, "Track later stages from Applications.")) : el("p", { class: "note" }, "This job isn't in your queue."));
};
function issueText(i) {
  const after = i.detail.includes(": ") ? i.detail.slice(i.detail.indexOf(": ") + 2) : "";
  if (i.code === "keyword_gap") return after ? `The posting asks for \u201c${after}\u201d, which no confirmed fact mentions. Add a fact if it's true.` : "The posting names skills no confirmed fact mentions.";
  if (i.code === "too_short") return "The resume is short for this role. Confirm more facts on your Profile to fill it out.";
  if (i.code === "missing_required") return after ? `Tracking systems may not find \u201c${after}\u201d in the PDF. Check it in the Word file.` : "Some required details may not be readable in the PDF. Check the Word file.";
  if (i.code === "no_phone") return "No phone number. Add one in Settings \u203a Answer bank.";
  if (i.code === "untranslated") return el("span", {}, i.detail.replace(" Add Italian versions on your Profile.", " "), el("a", { href: "#/profile/italian" }, "Add Italian versions"), ".");
  return i.detail;
}
async function resumeSheet(box, p) {
  const out = el("div");
  const files = el("div", { class: "files" });
  const italian = p.language === "it";
  const dl = (fmt, label, extra = "") => { const x = btn(label, { icon: "down" }); action(x, out, () => download(p.resume[fmt] + extra, `${italian && !extra ? "CV" : "Resume"}.${fmt}`)); return x; };
  clear(box, el("div", { class: "sheet-head" }, el("h2", { id: "h-resume" }, italian ? "CV in Italian for this job" : "Resume for this job"), el("span", { class: "note" }, "Built only from facts you've confirmed")), files, out, loading());
  try {
    const r = await api("GET", p.resume.check.replace(/^\/api/, ""));
    const c = r.check;
    files.append(dl("pdf", "PDF"), dl("docx", "Word"));
    if (italian) { const en = dl("pdf", "English version (PDF)", "&lang=en"); en.classList.add("quiet"); files.append(en); }
    box.lastChild.replaceWith(el("div", {},
      el("p", { class: "note" }, `${plural(r.resume.factIds.length, "confirmed fact")} used, ${plural(r.pages, "page")}`, c.keywordCoverage !== null ? `, covers ${Math.round(c.keywordCoverage * 100)}% of the posting's keywords` : "", "."),
      el("ul", { class: "issues" },
        c.issues.length ? c.issues.map((i) => el("li", {}, icon(i.severity === "error" ? "stop" : "alert"), el("span", {}, issueText(i))))
          : el("li", {}, icon("check"), el("span", {}, "Applicant tracking systems can read every line."))),
      r.warning ? msg("hold", r.warning) : null));
  } catch (e) {
    box.lastChild.replaceWith(e.status === 409 ? msg("hold", e.message, " ", el("a", { href: e.message.includes("name") ? "#/settings/answers" : "#/profile" }, "Fix it")) : msg("stop", e.message));
  }
}
function answersEditor(app, existing, facts, job) {
  const verified = facts.filter((f) => f.verified);
  const box = el("section", { class: "sheet", "aria-labelledby": "h-answers" });
  const list = el("div");
  const out = el("div", { "aria-live": "polite" });
  const rows = [];
  const editable = app && ["queued", "approved", "ready_for_review", "failed"].includes(app.state);
  function addRow(a = { label: "", kind: "short_answer", text: "", shortText: "", citedFactIds: [], maxChars: "" }) {
    const label = input({ value: a.label, placeholder: "Why do you want to work here?" });
    const kind = select([["short_answer", "Short answer"], ["motivation", "Motivation"], ["self_intro", "About you"], ["project", "A project"], ["other", "Other"]], a.kind);
    const max = input({ type: "number", min: 1, value: a.maxChars || "", inputmode: "numeric" });
    const text = el("textarea", { value: a.text, placeholder: "Your answer. Every number must come from a fact you cite below." });
    const shortT = el("textarea", { value: a.shortText || "", rows: 2, placeholder: "A shorter version, for forms with tight limits" });
    const count = el("span", { class: "counter", "aria-live": "polite" });
    const recount = () => { const n = [...text.value].length; const lim = Number(max.value) || 0; count.textContent = lim ? `${n} / ${lim} characters` : `${n} characters`; count.classList.toggle("over", !!lim && n > lim); };
    text.addEventListener("input", recount); max.addEventListener("input", recount); recount();
    const cites = el("div", { class: "facts-pick" }, verified.map((f) => el("label", { class: "check" }, input({ type: "checkbox", value: f.id, checked: a.citedFactIds.includes(f.id) }), el("span", {}, short(f.text, 110)))));
    const result = el("div");
    const node = el("div", { class: "answer" });
    const draftBtn = state.aiKey && editable ? btn(job.language === "it" ? "Draft in Italian with my AI" : "Draft with my AI", { small: true, icon: "spark" }) : null;
    if (draftBtn) action(draftBtn, result, async () => {
      if (!label.value.trim()) throw new Error("Type the question first.");
      const r = await api("POST", "/ai/draft", { jobId: job.id, question: label.value.trim(), kind: kind.value, maxChars: max.value ? Number(max.value) : undefined });
      text.value = r.answer.text; shortT.value = r.answer.shortText || ""; recount();
      for (const cb of cites.querySelectorAll("input")) cb.checked = r.answer.citedFactIds.includes(cb.value);
      clear(result, msg("info", `Drafted by ${r.model}. Read it and make it yours before saving.`), r.postingWarning ? msg("stop", `The posting has hidden text: ${r.postingWarning}`) : null);
      showReview(row, r.review);
    });
    const row = { get: () => ({ label: label.value.trim(), kind: kind.value, text: text.value, shortText: shortT.value.trim() || undefined,
      citedFactIds: [...cites.querySelectorAll("input:checked")].map((i) => i.value), maxChars: max.value ? Number(max.value) : undefined }), result };
    append(node, [
      el("div", { class: "grid q-grid" }, field("Question", label), field("Kind", kind), field("Limit", max, "(chars)")),
      el("div", { style: { marginTop: "12px" } }, el("div", { class: "row" }, el("label", { for: (text.id = `t${Math.random().toString(36).slice(2)}`), class: "grow", style: { margin: 0 } }, "Answer"), count), text),
      el("div", { style: { marginTop: "12px" } }, field("Short version", shortT, "(optional)")),
      el("div", { style: { marginTop: "12px" } }, el("div", { class: "label" }, "Facts this answer relies on"), verified.length ? cites : el("p", { class: "note" }, "Confirm facts on your Profile to cite them.")),
      editable ? el("div", { class: "row", style: { marginTop: "10px" } }, draftBtn, btn("Remove", { kind: "quiet", small: true, onclick: () => { node.remove(); rows.splice(rows.indexOf(row), 1); } })) : null,
      result]);
    if (!editable) node.querySelectorAll("input,textarea,select").forEach((x) => (x.disabled = true));
    rows.push(row);
    list.append(node);
    return row;
  }
  function showReview(row, r) {
    const problems = [...r.full.problems, ...(r.short ? r.short.problems.map((p) => `Short version: ${p}`) : []),
      ...(r.shortVariantMissing ? ["Add a short version for forms with tight limits."] : []),
      ...r.grounding.unsupportedFigures.map((f) => `“${f}” isn't in any cited, confirmed fact.`),
      ...(r.grounding.badCitations.length ? ["A cited fact isn't confirmed."] : [])];
    row.result.append(problems.length ? el("ul", { class: "issues" }, problems.map((p) => el("li", {}, icon("alert"), el("span", {}, p)))) : el("ul", { class: "issues" }, el("li", {}, icon("check"), el("span", {}, `Passes the checks. ${r.full.words} words.`))));
  }
  const collect = () => rows.map((r) => r.get()).filter((a) => a.label && a.text.trim());
  const check = btn("Check");
  action(check, out, async () => { const r = await api("POST", "/answers/review", collect()); rows.forEach((row) => row.result.replaceChildren()); r.items.forEach((x, i) => showReview(rows[i], x)); });
  const save = btn("Save answers", { kind: "primary" });
  action(save, out, async () => { const r = await api("PUT", `/applications/${app.id}/answers`, collect()); rows.forEach((row) => row.result.replaceChildren()); r.items.forEach((x, i) => showReview(rows[i], x)); toast("Saved"); });
  append(box, [
    el("div", { class: "sheet-head" }, el("h2", { id: "h-answers" }, "Free-text answers"), el("span", { class: "note" }, "Counted the way forms count them")),
    el("p", { class: "note measure", style: { marginTop: 0 } }, job.language === "it"
      ? (state.aiKey ? "Write them in Italian yourself, or draft in Italian with your own AI key, then check them here." : "Write them in Italian yourself or with any AI you use, then check them here.")
      : state.aiKey ? "Write them yourself or draft with your own AI key, then check them here." : "Write them yourself or with any AI you use, then check them here. To draft in the app, add your own AI key in Settings."),
    list,
    editable ? el("div", { class: "row", style: { marginTop: "16px" } }, btn("Add question", { icon: "plus", onclick: () => addRow() }), check, save) : el("p", { class: "note" }, app ? "Answers are frozen once you've submitted." : ""),
    out]);
  for (const a of existing) addRow(a);
  if (!existing.length && editable) addRow();
  existing.forEach((a, i) => a.review && showReview(rows[i], a.review));
  return box;
}

// ---------------------------------------------------------------- follow-ups
VIEWS.followups = async () => {
  const [f, inbound, gmail] = await Promise.all([api("GET", "/followups"), api("GET", "/inbound").catch((e) => (e.status === 409 ? null : Promise.reject(e))),
    api("GET", "/gmail").catch(() => null)]);
  state.followupCount = f.items.filter((x) => x.kind !== "consider_closing").length; shell("followups");
  const out = el("div", { "aria-live": "polite" });
  const items = f.items.map((it) => {
    const node = el("li", { class: "person" });
    const head = el("div", {}, el("h3", { class: "badged" }, routeBadge(it.companyId, it.company), el("span", { style: { fontWeight: 600 } }, it.title)),
      el("div", { class: "note" }, it.kind === "thank_you" ? `Interview ${fmtDay(it.interviewAt)}: send a thank-you within a day.` : it.kind === "follow_up" ? `${it.daysQuiet} days without a reply${it.sent ? `, ${plural(it.sent, "follow-up")} sent` : ""}.` : it.note));
    if (it.kind === "consider_closing") {
      const close = btn("Close it", { small: true });
      action(close, out, async () => { await moveTo(it.appId, "withdrawn", "Closed after no reply"); node.remove(); });
      append(node, [head, el("div", { class: "acts" }, close)]);
      return node;
    }
    const sent = btn("Mark sent", { kind: "primary", small: true, icon: "check" });
    action(sent, out, async () => { await api("POST", `/followups/${it.appId}/sent`, { kind: it.kind }); toast("Logged"); node.remove(); state.followupCount--; shell("followups"); });
    const text = (it.draft.subject ? `Subject: ${it.draft.subject}\n\n` : "") + it.draft.body;
    append(node, [head, el("div", { class: "acts" }, btn("Copy draft", { small: true, icon: "copy", onclick: () => copy(text) }), sent),
      el("pre", { class: "draft" }, text),
      it.draft.warnings.length ? el("ul", { class: "issues", style: { gridColumn: "1 / -1" } }, it.draft.warnings.map((w) => el("li", {}, icon("alert"), el("span", {}, w)))) : null]);
    return node;
  });
  render(pageHead("Follow-ups", "Drafts use only what you already sent the employer. Send them from your own email, then mark them sent."),
    out,
    el("section", { class: "sheet" }, el("div", { class: "sheet-head" }, el("h2", {}, "Due now"), el("span", { class: "note" }, "At most two follow-ups per application")),
      items.length ? el("ul", { class: "list" }, items) : el("div", { class: "empty", style: { padding: "8px 0" } }, el("h3", {}, "Nothing due"),
        el("p", { class: "note measure" }, "A follow-up comes due after 10 quiet days, and a thank-you the day you move an application to Interview."))),
    inboundSheet(inbound, gmail));
};
const EMAIL_KIND = { application_confirmation: "Confirmation", interview_invite: "Interview invitation", rejection: "Rejection", job_alert: "Job alert", recruiter_reply: "Reply", other: "Reply" };
// The words a Gmail filter forwards on: what job emails say, not who sends them, so employers
// that aren't on any job board are caught too. The app drops anything that isn't about you.
const GMAIL_FILTER = '"your application" OR "thank you for applying" OR "thanks for applying" OR "application received" OR "next steps" OR interview OR unfortunately OR "move forward" OR candidacy OR from:(greenhouse.io OR lever.co OR ashbyhq.com OR myworkday.com OR smartrecruiters.com OR icims.com OR workablemail.com OR jobvite.com)';
function forwardingGuide(inbound) {
  const code = inbound.forwardingCode;
  const step = (n, title, ...body) => el("li", {}, el("span", { class: "dot", "aria-hidden": "true" }, n), el("div", {}, el("strong", {}, title), ...body));
  return el("div", { class: "stack" },
    el("p", { class: "note measure", style: { marginTop: 0 } }, "Forward job emails here and the app proposes the update: an application moves only when you confirm it on Today. Emails that aren't about your applications are dropped, never stored."),
    el("ol", { class: "guide" },
      step(1, "Your forwarding address", el("div", { class: "secret", style: { marginTop: "8px" } }, el("span", {}, inbound.address), btn("Copy", { small: true, icon: "copy", onclick: () => copy(inbound.address) }))),
      step(2, "Add it in Gmail", el("p", { class: "note" }, "Gmail › Settings › See all settings › Forwarding and POP/IMAP › Add a forwarding address. Gmail sends a confirmation code to it, which shows up here."),
        code ? el("div", { class: "row", style: { marginTop: "8px" } }, el("span", { class: "tag go" }, icon("check"), "Code from Gmail"), el("strong", { class: "code-big" }, code.code),
            btn("Copy", { small: true, icon: "copy", onclick: () => copy(code.code) }), code.link ? el("a", { class: "btn small", href: code.link, target: "_blank", rel: "noopener" }, "Confirm in Gmail") : null)
          : el("p", { class: "note" }, "Waiting for Gmail's confirmation email. Reload this page a minute after adding the address.")),
      step(3, "Forward only job emails", el("p", { class: "note" }, "In Gmail, open the search options (the sliders in the search bar), paste this into Has the words, then Create filter › Forward it to your address. Leave “Forward a copy of incoming mail” off, so the rest of your mail stays put."),
        el("div", { class: "secret wrap", style: { marginTop: "8px" } }, el("span", {}, GMAIL_FILTER), btn("Copy", { small: true, icon: "copy", onclick: () => copy(GMAIL_FILTER) }))),
      step(4, "Anything it misses", el("p", { class: "note" }, "A recruiter writing “free Thursday?” won't match the filter. Forward that one by hand to the same address."))));
}
// Job emails reach the app two ways: Gmail (signed in with Google, metadata only) or a forwarding
// address (when the server has a mail domain). Either moves applications the same way.
function gmailBody(g) {
  const out = el("div", { "aria-live": "polite" });
  // Forwarding is the way in for now; sign-in shows only to manage an existing link.
  if (!g || !g.available || !g.link) return null;
  if (!g.link) {
    const connect = btn("Connect Gmail", { kind: "primary", icon: "out" });
    action(connect, out, async () => { const r = await api("POST", "/gmail/connect"); location.href = r.url; });
    return el("div", { class: "stack" },
      el("p", { class: "note measure", style: { marginTop: 0 } },
        "Sign in with Google and the app checks your inbox every 3 hours for application confirmations, interview invitations and rejections, and moves the matching application. It reads senders and subjects only, never the text of your emails, and keeps only job-related ones. You can disconnect at any time."),
      out, el("div", { class: "row" }, connect));
  }
  const l = g.link;
  const check = btn("Check now", { small: true });
  action(check, out, async () => { await api("POST", "/gmail/sync"); clear(out, msg("info", "Checking your inbox. New job emails show up below in a minute or two.")); });
  const off = confirmBtn("Disconnect", "Press again to disconnect", out, async () => { await api("DELETE", "/gmail"); toast("Gmail disconnected"); route(); });
  off.classList.add("small");
  return el("div", { class: "stack" },
    el("div", { class: "row" }, el("span", { class: "tag go" }, icon("check"), "Gmail connected"), el("strong", {}, l.email),
      el("span", { class: "note" }, l.first_sync_pending ? "First check reads the last 30 days" : l.last_sync_at ? `Last checked ${fmtDate(l.last_sync_at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "")),
    l.last_error ? msg("stop", l.last_error) : null,
    out, el("div", { class: "row" }, check, off));
}
function inboundBody(inbound, gmail = null) {
  if (!inbound) return [el("p", { class: "note" }, "Finish setup to get your forwarding address.")];
  const recent = inbound.recent || [];
  const viaGmail = gmailBody(gmail);
  return [
    viaGmail,
    inbound.address ? el("div", { style: viaGmail ? { marginTop: "20px", paddingTop: "16px", borderTop: "1px solid var(--rule)" } : {} }, forwardingGuide(inbound))
      : viaGmail ? null : msg("info", "Job emails aren't switched on for this server yet: it needs a mail domain for the forwarding address (see DEPLOY.md). Until then, update stages from Applications."),
    recent.length ? el("div", { class: "tablebox", style: { marginTop: "16px" } }, el("table", { class: "responsive" },
      el("thead", {}, el("tr", {}, ["Received", "From", "Subject", "Read as", "Result"].map((h) => el("th", { scope: "col" }, h)))),
      el("tbody", {}, recent.map((m) => el("tr", {},
        el("td", { "data-label": "Received" }, fmtDate(m.received_at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })),
        el("td", { "data-label": "From" }, short(m.from_address, 40)), el("td", { "data-label": "Subject" }, short(m.subject, 80)),
        el("td", { "data-label": "Read as" }, EMAIL_KIND[m.classification] || "\u2013"),
        el("td", { "data-label": "Result" }, m.status === "pending" ? "Waiting for you on Today" : m.status === "ignored" ? "Ignored"
          : m.action ? `${m.action === "added" ? "Added" : STATE_LABEL[m.action] || m.action.replace(/_/g, " ")}${m.company ? ` \u00b7 ${m.company}` : ""}` : m.company ? `Noted \u00b7 ${m.company}` : "Noted")))))) : null,
  ];
}
const inboundSheet = (inbound, gmail) => el("section", { class: "sheet", style: { marginTop: "16px" }, id: "forwarding" }, el("div", { class: "sheet-head" }, el("h2", {}, "Job emails")), inboundBody(inbound, gmail));

// Google sends the browser back here (via /api/gmail/callback); finish with this session's sign-in.
VIEWS.gmail = async () => {
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  history.replaceState(null, "", "#/settings/email"); // the code is single-use; keep it out of history
  if (q.get("error") || !q.get("code")) {
    render(pageHead("Gmail not connected"), msg("hold", q.get("error") === "access_denied" ? "You didn't allow access, so nothing was connected." : "Google didn't finish the sign-in. Try again from Settings."),
      el("a", { class: "btn", href: "#/settings/email" }, "Back to Settings"));
    return;
  }
  render(pageHead("Connecting Gmail"), loading());
  try {
    const r = await api("POST", "/gmail/exchange", { code: q.get("code"), state: q.get("state") });
    toast(`Gmail connected: ${r.email}`);
    await VIEWS.settings("email");
  } catch (e) {
    render(pageHead("Gmail not connected"), msg("stop", e.message), el("a", { class: "btn", href: "#/settings/email" }, "Back to Settings"));
  }
};

// ---------------------------------------------------------------- network
function linkedinImport(after) {
  const out = el("div", { "aria-live": "polite" });
  const conn = input({ type: "file", accept: ".csv,text/csv" }), msgs = input({ type: "file", accept: ".csv,text/csv" });
  const read = (i) => (i.files && i.files[0] ? i.files[0].text() : Promise.resolve(null));
  const go = btn("Import", { kind: "primary" });
  action(go, null, async () => {
    try {
      const connectionsCsv = await read(conn);
      if (!connectionsCsv) throw new Error("Choose Connections.csv first.");
      const r = await api("POST", "/connections/import", { connectionsCsv, messagesCsv: await read(msgs) });
      clear(out, msg("go", `Imported ${plural(r.imported, "person", "people")}. ${r.matched} work at ${plural(r.companies, "company", "companies")} you could apply to.`), r.warnings.map((w) => msg("hold", w)));
      if (after) await after();
    } catch (e) { clear(out, msg("stop", e.message)); }
  });
  return el("div", { class: "stack" },
    el("ol", { class: "note measure", style: { paddingLeft: "18px", margin: 0 } },
      el("li", {}, "On LinkedIn, open Me › Settings & Privacy › Data privacy › Get a copy of your data."),
      el("li", {}, "Choose Connections and Messages and request the archive. LinkedIn emails you when it's ready."),
      el("li", {}, "Unzip it and choose the two files below. Import again every week or two; earlier asks are kept.")),
    el("div", { class: "grid" }, field("Connections.csv", conn), field("messages.csv", msgs, "(optional, ranks warm contacts first)")),
    el("div", { class: "row" }, go), out);
}
VIEWS.network = async () => {
  const r = await api("GET", "/connections");
  const by = new Map();
  for (const c of r.items) { const k = c.company || "Other"; if (!by.has(k)) by.set(k, { id: c.company_id, people: [] }); by.get(k).people.push(c); }
  const groups = [...by].sort((a, b) => b[1].people.length - a[1].people.length);
  render(pageHead("Network", "People at companies you could apply to, warmest first. Ask for a referral before you apply."),
    el("section", { class: "sheet" }, el("h2", {}, "Import your LinkedIn export"), linkedinImport(() => VIEWS.network())),
    el("h2", {}, `People at your companies${groups.length ? ` (${r.items.length})` : ""}`),
    groups.length ? el("div", { class: "sheet" }, el("ul", { class: "list" }, groups.map(([co, g]) => el("li", { style: { display: "block" } },
      el("details", {}, el("summary", {}, coName(g.id || co, co), el("span", { class: "note", style: { fontWeight: 400 } }, ` · ${plural(g.people.length, "person", "people")}`)),
        el("ul", { class: "list", style: { marginTop: "8px" } }, g.people.map((p) => el("li", {}, el("span", { class: "grow" }, el("strong", {}, p.full_name), " ",
          el("span", { class: "note" }, [p.position, p.messages_count ? plural(p.messages_count, "message") : null, p.last_ask_at ? `asked ${fmtDay(p.last_ask_at)}` : null].filter(Boolean).join(" · ")))))))))))
      : el("div", { class: "sheet empty" }, el("h3", {}, "No contacts yet"), el("p", { class: "note" }, "Import your export above. Only people at companies in the catalog are shown.")));
};

// ---------------------------------------------------------------- profile
VIEWS.profile = async (part) => {
  let p;
  try { p = await api("GET", "/profile"); } catch (e) { if (e.status === 404) { location.hash = "#/setup"; return; } throw e; }
  const [facts, timing] = await Promise.all([api("GET", "/facts"), api("GET", "/timing")]);
  render(pageHead("Profile", `${p.facts.verified} of ${plural(p.facts.n, "fact")} confirmed. Only confirmed facts count toward scores, resumes and answers.`),
    el("div", { class: "stack" }, factsSheet(facts.items), italianSheet(p, facts.items, part === "italian"), targetsSheet(p), languagesSheet(p), timingSheet(p, timing)));
  if (part) { const t = document.getElementById(part); if (t) { t.scrollIntoView(); const f = t.querySelector("h2"); if (f) { f.tabIndex = -1; f.focus({ preventScroll: true }); } } }
};
// Italian versions of facts: used when a posting is in Italian. Only the user's words
// (or their own AI's draft, which they review) are saved; nothing is translated silently.
const TRANSLATABLE = ["role", "achievement", "education", "project", "certification"];
function italianSheet(p, items, asked) {
  const wantsItaly = p.workAuth.some((a) => a.country === "IT") || p.targets.some((t) => t.country === "IT");
  if (!wantsItaly && !asked) return null;
  const out = el("div", { "aria-live": "polite" });
  const rows = items.filter((f) => f.verified && TRANSLATABLE.includes(f.kind) && f.lang !== "it");
  if (!rows.length) return el("section", { class: "sheet", id: "italian" }, el("h2", {}, "Italian versions"), out,
    el("p", { class: "note measure" }, items.some((f) => f.lang === "it") ? "Your facts are already in Italian, so Italian CVs use them as written." : "Confirmed roles, achievements and education show up here so you can give each an Italian version."));
  const boxes = new Map();
  const count = el("span", { class: "note" });
  const recount = () => { const n = rows.filter((f) => (boxes.get(f.id).value || "").trim()).length; count.textContent = `${n} of ${rows.length} have an Italian version`; };
  const list = el("ul", { class: "list" }, rows.map((f) => {
    const ta = el("textarea", { rows: 2, lang: "it", style: { minHeight: "64px" }, placeholder: "Versione italiana", "aria-label": `Italian version of: ${f.text}` });
    ta.value = (f.translations && f.translations.it) || "";
    ta.addEventListener("input", recount);
    const problem = el("div", { class: "note" });
    boxes.set(f.id, ta); ta._problem = problem;
    return el("li", { style: { display: "block" } },
      el("div", { class: "note" }, [f.kind[0].toUpperCase() + f.kind.slice(1), f.org].filter(Boolean).join(" · ")),
      el("div", { style: { margin: "4px 0 8px" } }, f.text), ta, problem);
  }));
  recount();
  const save = btn("Save Italian versions", { kind: "primary" });
  action(save, out, async () => {
    let n = 0;
    for (const f of rows) {
      const v = boxes.get(f.id).value.trim();
      const was = ((f.translations && f.translations.it) || "").trim();
      if (v === was) continue;
      await api("PATCH", `/facts/${f.id}`, { translations: { it: v || null } });
      f.translations = { ...(f.translations || {}), it: v || undefined }; n++;
    }
    toast(n ? `Saved ${plural(n, "version")}` : "Nothing changed");
  });
  const ai = state.aiKey ? btn("Translate missing with my AI", { icon: "spark" }) : null;
  if (ai) action(ai, out, async () => {
    const missing = rows.filter((f) => !boxes.get(f.id).value.trim()).slice(0, 40);
    if (!missing.length) { toast("Every fact has an Italian version"); return; }
    const r = await api("POST", "/ai/translate", { to: "it", factIds: missing.map((f) => f.id) });
    let flagged = 0;
    for (const it of r.items) {
      const ta = boxes.get(it.id); if (!ta) continue;
      ta.value = it.text;
      ta._problem.textContent = it.problems && it.problems.length ? `Check this: ${it.problems.join(" ")}` : "";
      if (it.problems && it.problems.length) flagged++;
    }
    recount();
    clear(out, msg("info", `Drafted ${plural(r.items.length, "version")}${flagged ? `; ${flagged} need a closer look` : ""}. Read them, fix anything that's off, then save. Nothing is saved until you do.`));
  });
  return el("section", { class: "sheet", id: "italian" },
    el("div", { class: "sheet-head" }, el("h2", {}, "Italian versions"), count),
    el("p", { class: "note measure", style: { marginTop: 0 } }, "Italian postings get a CV in Italian. Each confirmed fact uses the Italian version you give here; facts without one stay in English and the CV check says so."),
    out, list,
    el("div", { class: "row", style: { marginTop: "12px" } }, save, ai,
      ai ? null : el("span", { class: "note" }, "To draft these in the app, add your own AI key in Settings.")));
}
function factsSheet(items) {
  const out = el("div", { "aria-live": "polite" });
  const kind = select(["role", "achievement", "skill", "project", "education", "certification", "language"].map((k) => [k, k[0].toUpperCase() + k.slice(1)]), "achievement");
  const text = el("textarea", { rows: 2, placeholder: "Cut pipeline cost 40% for 3M users by moving batch jobs to incremental loads" });
  const org = input({ placeholder: "Hooli" });
  const skills = input({ placeholder: "python, sql, aws" });
  const start = input({ type: "date" }), end = input({ type: "date" });
  const add = btn("Add confirmed fact", { kind: "primary", icon: "plus" });
  action(add, out, async () => {
    await api("POST", "/facts", [{ kind: kind.value, text: text.value, org: org.value.trim() || null, skills: skills.value.split(",").map((x) => x.trim()).filter(Boolean), startDate: start.value || null, endDate: end.value || null, verified: true }]);
    toast("Added"); route();
  });
  const byKind = {};
  for (const f of items) (byKind[f.kind] = byKind[f.kind] || []).push(f);
  return el("section", { class: "sheet", id: "facts" },
    el("div", { class: "sheet-head" }, el("h2", {}, "Facts"), el("a", { class: "btn small quiet", href: "#/setup/facts" }, icon("up"), "Import a resume")),
    out,
    items.length ? el("ul", { class: "list" }, items.map((f) => {
      const ver = input({ type: "checkbox", checked: f.verified, "aria-label": "Confirmed true" });
      ver.addEventListener("change", async () => { try { await api("PATCH", `/facts/${f.id}`, { verified: ver.checked }); toast(ver.checked ? "Confirmed" : "Unconfirmed"); } catch (e) { ver.checked = !ver.checked; clear(out, msg("stop", e.message)); } });
      const li = el("li", {},
        el("label", { class: "check", style: { alignItems: "center" } }, ver, el("span", { class: "vh" }, "Confirmed")),
        el("div", { class: "grow" }, el("div", {}, f.text), el("div", { class: "note" }, [f.kind, f.org, f.skills.join(", "), [f.start_date, f.end_date].filter(Boolean).map(fmtDay).join(" – ")].filter(Boolean).join(" · "))));
      li.append(confirmBtn("Delete", "Delete for good", out, async () => { await api("DELETE", `/facts/${f.id}`); li.remove(); toast("Deleted"); }));
      li.lastChild.classList.add("small");
      return li;
    })) : el("p", { class: "note" }, "No facts yet. Add roles, achievements and skills, one true statement each."),
    el("h3", { style: { marginTop: "24px", marginBottom: "12px" } }, "Add a fact"),
    el("div", { class: "grid" }, field("Kind", kind), field("Company or school", org), field("From", start), field("To", end, "(blank if current)")),
    el("div", { style: { marginTop: "12px" } }, field("Statement", text)),
    el("div", { style: { marginTop: "12px" } }, field("Skills", skills, "(comma separated)")),
    el("div", { class: "row", style: { marginTop: "12px" } }, add));
}
function targetsSheet(p) {
  const out = el("div");
  const countries = p.workAuth.length ? p.workAuth.map((a) => a.country) : ["US"];
  const title = input({ placeholder: "Data Engineer" });
  const country = select(countries.map((c) => [c, COUNTRY_NAME[c] || c]), countries[0]);
  const level = select([["", "Any level"], ["entry", "Entry"], ["mid", "Mid"], ["senior", "Senior"], ["lead", "Lead"], ["executive", "Executive"]], "");
  const floor = input({ type: "number", min: 0, step: 1000, inputmode: "numeric" });
  const add = btn("Add role", { icon: "plus" });
  action(add, out, async () => {
    await api("POST", "/targets", { title: title.value, country: country.value, seniority: level.value || null, payFloor: floor.value ? Number(floor.value) : null, payCurrency: floor.value ? CURRENCY[country.value] || "USD" : null });
    toast("Added"); route();
  });
  return el("section", { class: "sheet", id: "targets" }, el("h2", {}, "Target roles"), out,
    el("ul", { class: "list" }, p.targets.map((t) => {
      const rm = btn("Remove", { kind: "quiet", small: true });
      action(rm, out, async () => { await api("DELETE", `/targets/${t.id}`); route(); });
      return el("li", {}, el("span", { class: "grow" }, el("strong", {}, t.title), el("span", { class: "note" }, ` · ${COUNTRY_NAME[t.country] || t.country}${t.seniority ? ` · ${t.seniority}` : ""}${t.pay_floor ? ` · from ${money(t.pay_floor, t.pay_currency)}` : ""}`)), rm);
    })),
    el("div", { class: "grid", style: { marginTop: "12px" } }, field("Title", title), field("Country", country), field("Level", level), field("Pay floor", floor, "(optional)")),
    el("div", { class: "row", style: { marginTop: "12px" } }, add));
}
function languagesSheet(p) {
  const out = el("div");
  const editor = languagesEditor(p.languages);
  const save = btn("Save languages", { kind: "primary" });
  action(save, out, async () => { await api("PUT", "/languages", editor.read()); toast("Saved"); });
  return el("section", { class: "sheet", id: "languages" }, el("h2", {}, "Languages"), editor.node, out, el("div", { class: "row", style: { marginTop: "12px" } }, save));
}
function timingSheet(p, timing) {
  const s = p.settings;
  const out = el("div");
  const daily = input({ type: "number", min: 0, max: 20, value: s.daily_target, inputmode: "numeric" });
  const maxA = input({ type: "number", min: 1, max: 30, value: s.max_active_processes, inputmode: "numeric" });
  const win = input({ type: "date", value: s.offer_window_start || "" });
  const save = btn("Save", { kind: "primary" });
  action(save, out, async () => {
    await api("PUT", "/profile", { homeCountry: s.home_country, dailyTarget: Number(daily.value), maxActiveProcesses: Number(maxA.value), offerWindowStart: win.value || null });
    toast("Saved");
  });
  const d = timing.stageDays;
  return el("section", { class: "sheet", id: "timing" }, el("h2", {}, "Pace and timing"),
    el("div", { class: "grid" }, field("Applications per day", daily, "(0–20)"), field("Most live processes at once", maxA), field("Offers should land around", win, "(optional)")),
    el("p", { class: "note measure" }, "With a date set, dream companies are held back so their offers arrive inside a 20-day window around it, alongside the rest."),
    el("dl", { class: "kv" },
      el("dt", {}, "To a screen"), el("dd", {}, `${d.toScreen} days`),
      el("dt", {}, "Screen to interview"), el("dd", {}, `${d.screenToInterview} days`),
      el("dt", {}, "Interview to offer"), el("dd", {}, `${d.interviewToOffer} days`),
      el("dt", {}, "Learned from"), el("dd", {}, { yours: "Your own applications", mixed: "Your own applications where there are two or more per stage, typical times elsewhere", default: "Typical times, until you have two of your own per stage" }[basisOf(timing)])),
    out, el("div", { class: "row", style: { marginTop: "12px" } }, save));
}

// ---------------------------------------------------------------- settings
const SETTINGS = [["appearance", "Appearance"], ["answers", "Answer bank"], ["work", "Work authorization"], ["companies", "Companies"], ["email", "Job emails"], ["connectors", "AI connectors"], ["ai", "Your AI key"], ["plan", "Plan"], ["account", "Account"]];
VIEWS.settings = async (section) => {
  const [answers, p, prefs, tokens, aiKey, billing, inbound, gmail] = await Promise.all([
    api("GET", "/answers"), api("GET", "/profile").catch(() => null), api("GET", "/preferences"), api("GET", "/tokens"), api("GET", "/ai/key"), api("GET", "/billing"),
    api("GET", "/inbound").catch(() => null), api("GET", "/gmail").catch(() => null)]);
  state.aiKey = aiKey.key;
  const sec = (id, title, ...body) => el("section", { class: "sheet", id: `s-${id}`, "aria-labelledby": `h-${id}` }, el("h2", { id: `h-${id}` }, title), body);
  render(pageHead("Settings"),
    el("div", { class: "split settings" },
      el("nav", { class: "section-nav", "aria-label": "Settings sections" }, SETTINGS.map(([id, l]) => el("a", { href: `#/settings/${id}`, onclick: (e) => { e.preventDefault(); document.getElementById(`s-${id}`).scrollIntoView({ behavior: "smooth" }); history.replaceState(null, "", `#/settings/${id}`); } }, l))),
      el("div", {},
        sec("appearance", "Appearance", appearance()),
        sec("answers", "Answer bank", answerBank(answers, (p && p.workAuth) || [])),
        sec("work", "Work authorization", workAuth(p)),
        sec("companies", "Companies", companies(prefs.items)),
        sec("email", "Job emails", inboundBody(inbound, gmail)),
        sec("connectors", "AI connectors", connectors(tokens.items)),
        sec("ai", "Your AI key", aiSettings(aiKey)),
        sec("plan", "Plan", plan(billing)),
        sec("account", "Account", accountSettings()))));
  if (section) { const t = document.getElementById(`s-${section}`); if (t) t.scrollIntoView(); }
};
function answerBank(r, workAuth = []) {
  const out = el("div", { "aria-live": "polite" });
  // Country questions (us.*, ie.*, it.*) only for the countries you apply in.
  const mine = new Set(workAuth.map((a) => a.country.toLowerCase()));
  const relevant = (k) => { const m = /^(us|ie|it|gb|ca)\./.exec(k); return !m || mine.has(m[1]); };
  r = { ...r, missing: r.missing.filter((q) => relevant(q.key)) };
  const row = (key, label, value, sensitive, hint, removable) => {
    const q = { key, label, sensitive, hint };
    const x = answerInput(q, value || "");
    const save = btn("Save", { small: true });
    action(save, out, async () => { if (!x.value()) throw new Error(`Type an answer for “${label}” first.`); await api("PUT", `/answers/${key}`, { answer: x.value(), sensitive }); toast("Saved"); });
    const acts = el("div", { class: "row", style: { flexWrap: "nowrap" } }, save);
    if (removable) { const del = btn("Delete", { small: true, kind: "quiet" }); action(del, out, async () => { await api("DELETE", `/answers/${key}`); x.node.remove(); toast("Deleted"); }); acts.append(del); }
    x.node.lastChild.replaceWith(acts);
    return x.node;
  };
  const key = input({ placeholder: "custom.portfolio" }), val = input({ placeholder: "https://…" });
  const add = btn("Add", { icon: "plus" });
  action(add, out, async () => { await api("PUT", `/answers/${key.value.trim()}`, { answer: val.value, sensitive: false }); toast("Saved"); route(); });
  return el("div", {},
    el("p", { class: "note measure", style: { marginTop: 0 } }, "Packets copy these into forms exactly. Sensitive answers are never rewritten, and nothing is guessed."),
    out,
    r.items.map((a) => row(a.question_key, a.label, a.answer, a.sensitive, "", true)),
    r.missing.length ? el("details", { style: { marginTop: "16px" } }, el("summary", {}, `Not answered yet (${r.missing.length})`), r.missing.map((q) => row(q.key, q.label, "", q.sensitive, q.hint, false))) : null,
    el("h3", { style: { marginTop: "24px", marginBottom: "12px" } }, "Add your own"),
    el("div", { class: "grid" }, field("Key", key, "(starts with custom.)"), field("Answer", val)), el("div", { class: "row", style: { marginTop: "12px" } }, add));
}
function workAuth(p) {
  const out = el("div", { "aria-live": "polite" });
  const have = new Map(((p && p.workAuth) || []).map((a) => [a.country, a]));
  const rows = COUNTRIES.map(([code, name]) => {
    const a = have.get(code);
    const st = select([["", "Not applying here"], ...workStatusFor(code)], a ? a.status : "", { "aria-label": `Your status in ${name}` });
    // Italy has no employer register, so there is no record count to set.
    const min = code === "IT" ? el("span", { class: "note auth-na" }, "–") : input({ type: "number", min: 0, value: a ? a.min_lca_filings : code === "US" ? 5 : 1, inputmode: "numeric", "aria-label": `Fewest sponsorship records in ${name}` });
    const perm = code === "US" ? input({ type: "number", min: 0, value: a ? a.min_perm_certified : 3, inputmode: "numeric", "aria-label": "Fewest PERM certifications" }) : el("span", { class: "note auth-na" }, "–");
    const save = btn("Save", { small: true });
    action(save, out, async () => {
      if (!st.value) throw new Error(`To stop applying in ${name}, remove its target roles in Profile.`);
      await api("PUT", `/work-auth/${code}`, { status: st.value, minLcaFilings: code === "IT" ? 0 : Number(min.value), minPermCertified: code === "US" ? Number(perm.value) : 0 }); toast("Saved");
    });
    // The column headings name these on wide screens; on narrow ones each carries its own label.
    const num = (label, control) => el("label", { class: "auth-num" }, el("span", { class: "auth-num-label" }, label), control);
    return authRow(code, el("span", { class: "auth-name" }, name), st, null, code === "IT" ? min : num("Min. records", min), code === "US" ? num("Min. PERM", perm) : perm, save);
  });
  return el("div", {},
    el("p", { class: "note measure", style: { marginTop: 0 } }, "When you need sponsorship, employers must show a public record: H-1B (LCA) filings and PERM certifications in the US, a Home Office sponsor licence in the UK (A-rated by default), approved LMIA positions in Canada, Irish employment permits issued (DETE) in Ireland. Italy has no public list, so the posting decides. The numbers are the fewest records an employer needs."),
    el("div", { class: "auth-head", "aria-hidden": "true" }, el("span", {}, "Country"), el("span", {}, "Your status"), el("span", {}, "Min. records"), el("span", {}, "Min. PERM"), el("span")),
    el("div", { class: "auth-table" }, rows), out);
}
function companies(prefs) {
  const out = el("div");
  const q = input({ type: "search", placeholder: "Search the employer catalog", "aria-label": "Search companies" });
  const results = el("ul", { class: "list" });
  const setPref = async (id, body) => { await api("PUT", `/companies/${id}/preference`, body); toast("Saved"); route(); };
  const tierBtns = (c) => [["warmup", "Warm-up"], ["mid", "Mid"], ["dream", "Dream"]].map(([t, l]) => { const b = btn(l, { small: true, kind: c.tier === t ? "primary" : "" }); action(b, out, () => setPref(c.id || c.company_id, { tier: t })); return b; });
  const search = el("form", { class: "row" }, el("div", { class: "grow" }, q), btn("Search", { type: "submit" }));
  search.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api("GET", `/companies?q=${encodeURIComponent(q.value.trim())}`);
      clear(results, r.items.length ? r.items.slice(0, 30).map((c) => {
        const reason = input({ placeholder: "Reason (optional)", "aria-label": `Why block ${c.name}` });
        const block = btn("Block", { small: true, kind: "danger" });
        action(block, out, () => setPref(c.id, { blockMode: "hard", reason: reason.value.trim() || "Blocked" }));
        return el("li", {}, el("span", { class: "grow" }, coName(c.id, c.name)), tierBtns(c), el("div", { style: { width: "170px" } }, reason), block);
      }) : el("li", { class: "note" }, "No match in the catalog."));
    } catch (err) { clear(out, msg("stop", err.message)); }
  });
  return el("div", {},
    el("p", { class: "note measure", style: { marginTop: 0 } }, "Warm-up companies come first so you practise before the ones you want most. Dream companies are timed for your offer window. Blocked companies never appear."),
    search, results, out,
    prefs.length ? el("div", {}, el("h3", { style: { margin: "24px 0 8px" } }, "Your choices"), el("ul", { class: "list" }, prefs.map((c) => {
      const clr = btn("Clear", { small: true, kind: "quiet" });
      action(clr, out, () => setPref(c.company_id, { tier: null, blockMode: null }));
      return el("li", {}, el("span", { class: "grow" }, coName(c.company_id, c.name)), c.block_mode ? el("span", { class: "tag stop" }, `Blocked${c.block_reason ? `: ${c.block_reason}` : ""}`) : el("span", { class: "tag" }, { warmup: "Warm-up", mid: "Mid", dream: "Dream" }[c.tier] || c.tier), clr);
    }))) : null);
}
function connectors(items) {
  const out = el("div", { "aria-live": "polite" });
  const name = input({ placeholder: "Claude Desktop", "aria-label": "Token name" });
  const make = btn("Create token", { kind: "primary" });
  const origin = location.origin;
  action(make, out, async () => {
    const r = await api("POST", "/tokens", { name: name.value.trim() });
    clear(out, msg("hold", "Copy it now. It won't be shown again."), el("div", { class: "secret" }, el("span", {}, r.token), btn("Copy", { small: true, icon: "copy", onclick: () => copy(r.token) })),
      el("p", { class: "note" }, "Add it to your AI tool's MCP settings. For example:"),
      el("pre", { class: "code" }, JSON.stringify({ mcpServers: { "my-career-agent": { type: "http", url: `${origin}/mcp`, headers: { Authorization: `Bearer ${r.token}` } } } }, null, 2)),
      btn("Done, refresh the list", { small: true, onclick: () => route() }));
  });
  return el("div", {},
    el("p", { class: "note measure", style: { marginTop: 0 } }, "Connect any AI assistant that speaks MCP to read your queue and packets, check answers and save drafts. Connectors can't mark an application submitted; only you can."),
    el("dl", { class: "kv" }, el("dt", {}, "Server address"), el("dd", {}, el("span", { class: "mono" }, `${origin}/mcp`)), el("dt", {}, "Sign-in"), el("dd", {}, "A token from below, sent as a Bearer header")),
    el("ul", { class: "list", style: { marginTop: "12px" } }, items.length ? items.map((t) => {
      const li = el("li", {}, el("span", { class: "grow" }, el("strong", {}, t.name), el("span", { class: "note" }, ` · ${t.prefix}… · created ${fmtDay(t.created_at)} · ${t.last_used_at ? `last used ${fmtDay(t.last_used_at)}` : "never used"}`)));
      li.append(confirmBtn("Revoke", "Revoke now", out, async () => { await api("DELETE", `/tokens/${t.id}`); li.remove(); toast("Revoked"); }));
      li.lastChild.classList.add("small");
      return li;
    }) : el("li", { class: "note" }, "No tokens yet.")),
    el("div", { class: "row", style: { marginTop: "12px" } }, el("div", { style: { width: "260px" } }, name), make), out);
}
function aiSettings(r) {
  const out = el("div", { "aria-live": "polite" });
  if (!r.available) return msg("info", "Your own AI key isn't switched on for this server yet. You can still draft answers with any AI tool and check them in the packet.");
  const provider = select([["anthropic", "Anthropic"], ["openai", "OpenAI"]], r.key ? r.key.provider : "anthropic", { "aria-label": "Provider" });
  const key = input({ type: "password", autocomplete: "off", placeholder: r.key ? `Saved key ends ${r.key.last4}` : "Paste your API key", "aria-label": "API key" });
  const model = input({ placeholder: r.defaults[provider.value], value: r.key && r.key.model !== r.defaults[r.key.provider] ? r.key.model : "", "aria-label": "Model" });
  provider.addEventListener("change", () => { model.placeholder = r.defaults[provider.value]; });
  const save = btn(r.key ? "Replace key" : "Save key", { kind: "primary" });
  action(save, out, async () => { const x = await api("PUT", "/ai/key", { provider: provider.value, apiKey: key.value, model: model.value.trim() || undefined }); state.aiKey = x; toast("Saved"); route(); });
  const rm = r.key ? confirmBtn("Remove key", "Remove now", out, async () => { await api("DELETE", "/ai/key"); state.aiKey = null; toast("Removed"); route(); }) : null;
  return el("div", {},
    el("p", { class: "note measure", style: { marginTop: 0 } }, "Optional. Drafts are sent to your provider with your confirmed facts and the posting, billed to your account. The key is encrypted and only used when you press “Draft with my AI”. Every draft is checked before you can save it."),
    r.key ? el("p", {}, el("span", { class: "tag go" }, icon("check"), `${r.key.provider === "anthropic" ? "Anthropic" : "OpenAI"} key ending ${r.key.last4}`), el("span", { class: "note" }, ` · model ${r.key.model}`)) : null,
    el("div", { class: "grid" }, field("Provider", provider), field("API key", key), field("Model", model, "(optional)")),
    out, el("div", { class: "row", style: { marginTop: "12px" } }, save, rm));
}
function plan(b) {
  if (!b.enabled) return el("div", {}, el("p", { style: { marginTop: 0 } }, el("span", { class: "tag go" }, "Free beta")), el("p", { class: "note measure" }, "Everything is free during the beta. If that changes, you'll be told in advance and nothing is charged without you choosing a plan."));
  const out = el("div");
  const act = b.plan === "paid" ? btn("Manage billing", { icon: "out" }) : btn("Upgrade", { kind: "primary" });
  action(act, out, async () => { const r = await api("POST", b.plan === "paid" ? "/billing/portal" : "/billing/checkout"); location.href = r.url; });
  return el("div", {}, el("dl", { class: "kv" }, el("dt", {}, "Plan"), el("dd", {}, b.plan === "paid" ? "Paid" : "Free"), el("dt", {}, "Applications per day"), el("dd", {}, String(b.dailyLimit)),
    b.renewsOn ? [el("dt", {}, "Renews"), el("dd", {}, fmtDay(b.renewsOn))] : null), out, el("div", { class: "row", style: { marginTop: "12px" } }, act));
}
// What "Start setup over" can clear. Applications are opt-in: they're a record of real submissions.
const RESET_PARTS = [
  ["facts_resume", "Facts from your resume", "Roles, achievements, education and skills you imported", true],
  ["facts_manual", "Facts you added by hand", null, true],
  ["answers", "Saved answers", "Contact details, visa answers and anything else in your answer bank", true],
  ["languages", "Languages", null, true],
  ["work_auth", "Work authorization and home country", "Also clears your offer-window date", true],
  ["targets", "Target roles", null, true],
  ["companies", "Company tiers and blocks", null, true],
  ["contacts", "LinkedIn contacts", "People imported from your LinkedIn export", true],
  ["applications", "Applications and their history", "Including notes, forwarded employer emails and today's queue", false],
];
function startOver() {
  const out = el("div", { "aria-live": "polite" });
  const list = el("ul", { class: "list reset-list" }, el("li", {}, loading()));
  const boxes = [];
  const go = confirmBtn("Clear and start over", "Confirm: this can't be undone", out, async () => {
    const picked = boxes.filter((b) => b.cb.checked).map((b) => b.key);
    if (!picked.length) throw new Error("Tick at least one thing to clear.");
    await api("POST", "/account/reset", { clear: picked });
    state.suggestedTitle = null;
    toast("Cleared. Starting setup again.");
    await loadMe();
    location.hash = "#/setup";
  });
  api("GET", "/account/reset").then(({ counts }) => {
    clear(list, RESET_PARTS.map(([key, label, hint, on]) => {
      const n = counts[key] ?? 0;
      const cb = input({ type: "checkbox", checked: on && n > 0, disabled: n === 0 });
      boxes.push({ key, cb });
      return el("li", {}, el("label", { class: "check grow" + (n === 0 ? " empty-part" : "") }, cb,
        el("span", {}, el("strong", {}, label), el("span", { class: "note" }, ` · ${key === "work_auth" ? (n ? plural(n, "country", "countries") : "none set") : n === 0 ? "nothing saved" : String(n)}`),
          hint ? el("span", { class: "note", style: { display: "block" } }, hint) : null)));
    }));
  }).catch((e) => clear(list, el("li", {}, msg("stop", e.message))));
  return el("div", { id: "start-over" },
    el("h3", { style: { margin: "28px 0 8px" } }, "Start setup over"),
    el("p", { class: "note measure" }, "Tick what to clear, then go through setup again. Your login, access tokens, AI key and plan stay. Download your data first if you want a copy."),
    list, el("div", { class: "row", style: { marginTop: "12px" } }, go), out);
}

function accountSettings() {
  const out = el("div", { "aria-live": "polite" });
  const parts = [];
  if (!state.me.email) {
    const email = input({ type: "email", autocomplete: "email", "aria-label": "Email" }), pw = input({ type: "password", autocomplete: "new-password", "aria-label": "New password" });
    const claim = btn("Add sign-in", { kind: "primary" });
    action(claim, out, async () => { await api("POST", "/auth/claim", { email: email.value, password: pw.value }); toast("Sign-in added"); await loadMe(); route(); });
    parts.push(msg("hold", "This account has no email and password yet. Add them so you can sign in without a token."),
      el("div", { class: "grid" }, field("Email", email), field("Password", pw, "(at least 10 characters)")), el("div", { class: "row", style: { marginTop: "12px" } }, claim));
  } else {
    const cur = input({ type: "password", autocomplete: "current-password" }), nxt = input({ type: "password", autocomplete: "new-password" });
    const change = btn("Change password");
    action(change, out, async () => { await api("POST", "/auth/password", { current: cur.value, next: nxt.value }); cur.value = nxt.value = ""; toast("Password changed. Other sessions were signed out."); });
    parts.push(el("dl", { class: "kv" }, el("dt", {}, "Email"), el("dd", {}, state.me.email)),
      el("h3", { style: { margin: "20px 0 12px" } }, "Change password"),
      el("div", { class: "grid" }, field("Current password", cur), field("New password", nxt)), el("div", { class: "row", style: { marginTop: "12px" } }, change));
  }
  const exp = btn("Download my data", { icon: "down" });
  action(exp, out, async () => download("/account/export", "my-career-agent-export.json"));
  const confirmBox = input({ placeholder: "Type DELETE", "aria-label": "Type DELETE to confirm", autocomplete: "off" });
  const pw = input({ type: "password", autocomplete: "current-password", "aria-label": "Your password" });
  const del = btn("Delete my account", { kind: "danger" });
  action(del, out, async () => {
    await api("DELETE", "/account", { confirm: confirmBox.value.trim(), password: pw.value });
    tokenStore.set(null); state.me = null; location.hash = "#/signin";
  });
  parts.push(el("h3", { style: { margin: "28px 0 8px" } }, "Your data"),
    el("p", { class: "note measure" }, "Download everything we hold about you as JSON: profile, facts, answers, contacts, applications and their history."),
    el("div", { class: "row" }, exp),
    startOver(),
    el("h3", { style: { margin: "28px 0 8px" } }, "Delete account"),
    el("p", { class: "note measure" }, "Deletes your account and all your data at once. This can't be undone. Download your data first if you want a copy."),
    el("div", { class: "grid" }, field("Confirm", confirmBox), state.me.email ? field("Password", pw) : null), el("div", { class: "row", style: { marginTop: "12px" } }, del),
    out);
  return el("div", {}, parts);
}

// ---------------------------------------------------------------- score a posting
VIEWS.score = async () => {
  const out = el("div", { "aria-live": "polite" });
  const title = input({ placeholder: "Senior Data Engineer" });
  const country = select(COUNTRIES, "US");
  const desc = el("textarea", { rows: 12, placeholder: "Paste the job description" });
  const go = btn("Score it", { kind: "primary" });
  const pct = (x) => `${Math.round(x * 100)}%`;
  action(go, null, async () => {
    try {
      const r = await api("POST", "/score", { title: title.value, description: desc.value, country: country.value });
      const s = r.score;
      clear(out, el("section", { class: "sheet", style: { marginTop: "16px" } },
        el("div", { class: "row" }, el("div", { class: "qrow", style: { padding: 0, gridTemplateColumns: "56px 1fr" } }, el("div", { class: "fit" }, s.total, el("small", {}, "fit")),
          el("div", {}, el("h3", {}, "Fit with your confirmed facts"), el("div", { class: "note" }, `Must-haves ${pct(s.mustHaveCoverage)} · nice-to-haves ${pct(s.niceToHaveCoverage)} · level ${pct(s.seniorityFit)} · years ${pct(s.yearsFit)}`))),
          el("span", { class: `tag ${r.gateVerdict === "PASS" ? "go" : r.gateVerdict === "FLAG" ? "hold" : "stop"}`, style: { marginLeft: "auto" } }, { PASS: "Requirements met", FLAG: "Check requirements", FAIL: "Requirements not met" }[r.gateVerdict] || r.gateVerdict)),
        r.integrity.level === "alarm" ? msg("stop", `Posting check: ${r.integrity.verdict}`) : null,
        r.gates.flatMap((g) => g.notes).length ? el("ul", { class: "issues" }, r.gates.flatMap((g) => g.notes).map((n) => el("li", {}, icon("alert"), el("span", {}, n)))) : null,
        el("h3", { style: { margin: "20px 0 4px" } }, "Matched"), el("p", {}, s.matched.join(", ") || "Nothing yet"),
        el("h3", { style: { margin: "20px 0 4px" } }, "Gaps"), r.suggestions.length ? el("ul", {}, r.suggestions.map((g) => el("li", {}, el("strong", {}, g.skill), ": ", g.note))) : el("p", { class: "note" }, "None among the skills this posting names."),
        s.redFlags.length ? [el("h3", { style: { margin: "20px 0 4px" } }, "Red flags"), el("ul", {}, s.redFlags.map((f) => el("li", {}, f)))] : null));
    } catch (e) { clear(out, msg("stop", e.message)); }
  });
  render(pageHead("Score a posting", "Paste any posting to see how your confirmed facts match it. Hidden text is removed first."),
    el("section", { class: "sheet" }, el("div", { class: "grid" }, field("Title", title), field("Country", country)), el("div", { style: { marginTop: "12px" } }, field("Description", desc)), el("div", { class: "row", style: { marginTop: "12px" } }, go)), out);
};

// ---------------------------------------------------------------- privacy and terms (drafts)
VIEWS.privacy = async () => render(el("div", { class: "measure" }, pageHead("Privacy", "Draft for the beta, pending legal review."),
  el("section", { class: "sheet stack" },
    el("p", {}, "My Career Agent stores what you give it to prepare your applications: your profile, facts you confirm, answers you save, contacts you import from your own LinkedIn export, your applications and their history, and employer emails you choose to forward."),
    el("p", {}, "It's used only to run the service for you. It isn't sold, and it isn't used to train AI models. If you add your own AI key, drafting requests go to that provider under your account."),
    el("p", {}, "Your LinkedIn password is never asked for or stored, and LinkedIn is never scraped."),
    el("p", {}, "If you connect Gmail, the app gets Google's read-only metadata access: senders, subjects and dates, never the text of your emails or attachments. It keeps only job-related messages (application confirmations, interview invitations, rejections, and mail from applicant tracking systems) and skips everything else without storing it. The Google token is stored encrypted. Disconnecting in Settings deletes it and withdraws the access at Google."),
    el("p", {}, "You can download all your data or delete your account at any time from Settings › Account. Deletion is immediate."),
    el("p", {}, "Data is held on Cloudflare and Neon. Contact details for the data controller will be published here before the beta opens widely."))));
VIEWS.terms = async () => render(el("div", { class: "measure" }, pageHead("Terms", "Draft for the beta, pending legal review."),
  el("section", { class: "sheet stack" },
    el("p", {}, "My Career Agent suggests roles and prepares material. You review and submit every application yourself, and you're responsible for what you send."),
    el("p", {}, "Sponsorship evidence comes from public government records and can be out of date. It isn't legal or immigration advice."),
    el("p", {}, "The beta is free and may change. You'll be told before anything is charged."))));

// ---------------------------------------------------------------- start
route();
