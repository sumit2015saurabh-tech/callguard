/* CallGuard dashboard: single-page app, no build step.
   Pipeline: audio -> transcriber microservice -> fraud category (from the service or your classifier)
             -> labels -> alert routing (nominee / bank / authorised people / emergency) -> history. */
(() => {
"use strict";
const D = window.CG_DATA;
const CATS = D.categories;
const CODES = Object.keys(CATS);

/* Where a call came from, and who was on the other end. The extension fills both in when it
   captures a Telegram or WhatsApp Web call; uploads and recordings can set them by hand. */
const CHANNELS = { phone: "Phone call", telegram: "Telegram", whatsapp: "WhatsApp" };
/** WhatsApp / Telegram from the name the extension gives its files ("whatsapp-20261114-…webm"). */
const channelFromName = (name) => { const m = String(name || "").toLowerCase().match(/^(whatsapp|telegram)[-_]/); return m ? m[1] : ""; };
const channelOf = (rec) => {
  if (!rec) return "phone";
  const source = String(rec.source || "");
  /* Calls saved before the source was recorded default to "phone"; trust stronger evidence. */
  if (CHANNELS[rec.channel] && rec.channel !== "phone") return rec.channel;
  if (source.includes("whatsapp")) return "whatsapp";
  if (source.includes("telegram")) return "telegram";
  if (/^(tg:|@)/.test(String(rec.callerHandle || ""))) return "telegram";
  return channelFromName(rec.fileName) || "phone";
};
const channelName = (rec) => CHANNELS[channelOf(rec)];
const channelChip = (rec) => `<span class="chip ch-${channelOf(rec)}">${esc(channelName(rec))}</span>`;
/** The caller's ID on that platform: phone number, Telegram user ID or @username. */
const handleText = (h) => (/^tg:\d+$/.test(h) ? `Telegram ID ${h.slice(3)}`
  : /^wa:lid:\d+$/.test(h) ? `WhatsApp ID ${h.slice(7)} (number hidden)` : h);
const callerKeyOf = (rec) => String((rec && (rec.callerNumber || handleText(rec.callerHandle || ""))) || "");
const callerIdOf = (rec) => {
  if (!rec) return "";
  const key = callerKeyOf(rec), name = rec.callerName || "";
  if (key || name) return key ? (name ? `${key} · ${name}` : key) : name;
  return String(rec.callerId || "");
};

/* ---------- shared fraud-caller list (all CallGuard users; scam classifier service) ----------
   The service only accepts a caller with the signed single-use ticket it returned for a fraud/uncertain call,
   and stores a keyed hash, never the number. "Not fraud for me" is a personal list kept in this browser. */
const lookupKeyOf = (rec) => String((rec && (rec.callerNumber || rec.callerHandle)) || "");
const sharedCallers = {
  url: () => String(CFG.callersUrl || "").replace(/\/+$/, ""),
  async post(path, body) {
    const r = await fetch(this.url() + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
    return j;
  },
  async check(caller) {
    if (!this.url() || !caller) return { flagged: false, reports: 0 };
    const out = await this.post("/v1/callers/check", { caller });
    return { ...out, ignoredByMe: notFraudForMe().includes(caller) };
  },
  report(caller, ticket, manual) { return this.post("/v1/callers/report", { caller, ticket, manual: !!manual }); },
};
const notFraudForMe = () => LS.get("notFraudCallers", []);
const setNotFraudForMe = (key, on) => {
  const s = new Set(notFraudForMe()); on ? s.add(key) : s.delete(key); LS.set("notFraudCallers", [...s]);
};
const repeatBanner = (rec) => {
  const p = rec.priorFlag;
  if (!p || !p.flagged || notFraudForMe().includes(lookupKeyOf(rec))) return "";
  const cat = CATS[p.category] ? `${p.category} · ${CATS[p.category].name}` : "fraud";
  return `<div class="banner warn">${icon("alert")}<div><b>Repeat fraud caller.</b> CallGuard users reported this caller as fraud
    ${p.reports} time${p.reports === 1 ? "" : "s"} before this call (${esc(cat)}${p.max_risk_score != null ? `, highest risk score ${p.max_risk_score}/100` : ""}, last ${fmtDate(p.last_seen)}).</div></div>`;
};
const sharedListRow = (rec) => {
  const key = lookupKeyOf(rec);
  if (!key) return `<div class="faint" style="font-size:12.5px">No caller ID for this call, so it can't be checked against the shared fraud-caller list.</div>`;
  const mine = notFraudForMe().includes(key);
  const canReport = rec.reportTicket && !rec.reported && ["fraud", "uncertain"].includes(rec.decision);
  return `<div class="row" style="gap:8px;align-items:center">
    ${rec.reported ? `<span class="status good">${icon("check")}On the shared fraud-caller list${rec.reported === "manual" ? " (reported by you)" : ""}</span>` : ""}
    ${canReport ? `<button class="btn btn-sm btn-danger" data-report="${rec.id}">${icon("alert")}Report caller as fraud</button>` : ""}
    <button class="btn btn-sm btn-ghost" data-notmine="${rec.id}">${mine ? "Show fraud warnings for this caller again" : "Not fraud for me"}</button>
    ${rec.sharedError ? `<span class="faint" style="font-size:12px">Shared list: ${esc(rec.sharedError)}</span>` : ""}</div>`;
};
/** After analysis: look up earlier reports, then auto-report a fraud call. Never blocks the pipeline. */
async function sharedCallerStep(rec) {
  const key = lookupKeyOf(rec);
  if (!key || !sharedCallers.url()) return;
  try {
    rec.priorFlag = await sharedCallers.check(key);
    if (rec.decision === "fraud" && rec.reportTicket && !rec.reported) {
      await sharedCallers.report(key, rec.reportTicket, false);
      rec.reported = "auto";
    }
    rec.sharedError = "";
  } catch (e) { rec.sharedError = String((e && e.message) || e); }
}
function bindSharedList(scope, rerender) {
  $$("[data-report]", scope).forEach((b) => b.onclick = async () => {
    const rec = S.calls.find((c) => c.id === b.dataset.report); if (!rec) return;
    if (!await modal({ title: "Report this caller as fraud?", body: `Adds <b>${esc(callerIdOf(rec))}</b> to the fraud-caller list shared by all CallGuard users, so they are warned when it calls. Only a hash of the caller ID is stored.`, confirm: "Report", danger: true })) return;
    try { await sharedCallers.report(lookupKeyOf(rec), rec.reportTicket, true); rec.reported = "manual"; rec.sharedError = ""; toast("Caller added to the shared fraud list", "alert"); }
    catch (e) { rec.sharedError = String((e && e.message) || e); toast(`Couldn't report: ${rec.sharedError}`, "alert"); }
    await saveRecord(rec); rerender();
  });
  $$("[data-notmine]", scope).forEach((b) => b.onclick = async () => {
    const rec = S.calls.find((c) => c.id === b.dataset.notmine); if (!rec) return;
    const key = lookupKeyOf(rec); setNotFraudForMe(key, !notFraudForMe().includes(key)); rerender();
  });
}
/** "WhatsApp number" / "Telegram ID" / "Phone number", for the call details. */
const callerKindOf = (rec) => {
  const ch = channelOf(rec);
  if (rec && rec.callerNumber) return ch === "phone" ? "Phone number" : `${CHANNELS[ch]} number`;
  if (rec && rec.callerHandle) return String(rec.callerHandle).startsWith("@") ? "Telegram username" : "Telegram ID";
  return "Caller ID";
};
/** Split what someone typed as the caller into a phone number or a platform ID. */
function parseCallerInput(raw, channel) {
  const v = String(raw || "").trim();
  if (!v) return { number: "", handle: "" };
  if (channel === "telegram" && /^\d{3,15}$/.test(v)) return { number: "", handle: `tg:${v}` };   // Telegram user ID
  const digits = v.replace(/[^\d+]/g, "");
  if (/^\+?[\d\s().-]{7,}$/.test(v) && digits.replace(/\D/g, "").length >= 7) return { number: digits, handle: "" };
  if (/^@?[A-Za-z]\w{3,31}$/.test(v)) return { number: "", handle: v.startsWith("@") ? v : `@${v}` };
  if (/^(tg:)?\d{3,15}$/i.test(v)) return { number: "", handle: `tg:${v.replace(/^tg:/i, "")}` };
  return { number: "", handle: v.replace(/[^\w@:.+-]/g, "").slice(0, 40) };
}

/* ============================== utilities ============================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (n, cls = "") => `<svg class="${cls}"><use href="#i-${n}"/></svg>`;
const pad = (n) => String(n).padStart(2, "0");
const localDate = (d) => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localTime = (d) => { d = new Date(d); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const fmtDT = (d) => new Date(d).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtDur = (s) => (s == null || isNaN(s)) ? "–" : `${Math.floor(s / 60)}:${pad(Math.round(s % 60))}`;
const pct = (x) => (x == null || isNaN(x)) ? "–" : `${Math.round(x * 100)}%`;
const uid = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
const initials = (n) => String(n || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const daysAgo = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d; };

function makeToken(date = new Date()) {
  const r = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 6).toUpperCase();
  return `CG-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${r}`;
}

function toast(msg, kind = "check") {
  const el = document.createElement("div");
  el.className = "toast" + (kind === "alert" ? " alert" : "");
  el.innerHTML = `${icon(kind)}<span>${esc(msg)}</span>`;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function modal({ title, body, confirm = "OK", cancel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const wrap = $("#modal");
    wrap.querySelector(".modal").innerHTML = `
      <h3>${esc(title)}</h3><div class="muted">${body}</div>
      <div class="actions">
        ${cancel ? `<button class="btn btn-ghost" data-v="0">${esc(cancel)}</button>` : ""}
        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-v="1">${esc(confirm)}</button>
      </div>`;
    wrap.hidden = false;
    const done = (v) => { wrap.hidden = true; wrap.onclick = null; resolve(v); };
    wrap.onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) done(b.dataset.v === "1"); else if (e.target === wrap) done(false); };
  });
}

const tip = {
  el: null,
  show(html, x, y) {
    this.el = this.el || $("#tooltip");
    this.el.innerHTML = html; this.el.hidden = false;
    const r = this.el.getBoundingClientRect();
    let left = x + 14, top = y - r.height - 12;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (top < 8) top = y + 16;
    this.el.style.left = `${left}px`; this.el.style.top = `${top}px`;
  },
  hide() { (this.el || $("#tooltip")).hidden = true; },
};

/* ============================== storage ============================== */
let NS = "";   // signed-in user id: every key and database below is per user
const GLS = {  // global (not per-user): accounts + session
  get(k, def) { try { const v = localStorage.getItem("cg." + k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem("cg." + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem("cg." + k); sessionStorage.removeItem("cg." + k); } catch { /* ignore */ } },
};
const LS = {
  get(k, def) { try { const v = localStorage.getItem(`cg.u.${NS}.${k}`); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(`cg.u.${NS}.${k}`, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

const idb = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open(`callguard_${NS}`, 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("calls", { keyPath: "id" }); d.createObjectStore("audio"); d.createObjectStore("kv"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode); const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && "result" in req ? req.result : undefined);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  };
  return {
    all: () => run("calls", "readonly", (s) => s.getAll()),
    put: (c) => run("calls", "readwrite", (s) => s.put(c)),
    del: (id) => run("calls", "readwrite", (s) => s.delete(id)),
    clear: () => Promise.all(["calls", "audio", "kv"].map((n) => run(n, "readwrite", (s) => s.clear()))),
    putAudio: (id, b) => run("audio", "readwrite", (s) => s.put(b, id)),
    getAudio: (id) => run("audio", "readonly", (s) => s.get(id)),
    delAudio: (id) => run("audio", "readwrite", (s) => s.delete(id)),
    kvGet: (k) => run("kv", "readonly", (s) => s.get(k)),
    kvSet: (k, v) => run("kv", "readwrite", (s) => s.put(v, k)),
  };
})();

const DEFAULT_SETTINGS = {
  workspace: "My workspace", plan: "pro",
  transcriberUrl: "", notifierUrl: "", apiKey: "", timeoutSec: 300,
  browserNotify: false, alertsSeenAt: 0,
};
const DEFAULT_CONTACTS = {
  user: { name: "", email: "", phone: "" },
  nominee: { name: "", email: "", phone: "", relation: "" },
  bank: { name: "", email: "", branch: "", addedBy: "" },
  authorised: [],
  emergency: { name: "", email: "", phone: "" },
};

const S = {
  user: null,             // {id, name, email, createdAt}
  settings: { ...DEFAULT_SETTINGS },
  contacts: JSON.parse(JSON.stringify(DEFAULT_CONTACTS)),
  calls: [],
  dir: null,              // FileSystemDirectoryHandle for the local history folder
  filters: null,
  overviewRange: 14,
  pending: null,          // audio chosen on the Analyze page
};
const saveSettings = () => { LS.set("settings", S.settings); paintChrome(); };
const saveContacts = () => LS.set("contacts", S.contacts);

/* ============================== services ============================== */
function normCategory(v) {
  if (v == null) return null;
  if (typeof v === "number" && v >= 0 && v <= 9) return "F" + Math.round(v);
  const s = String(v).trim();
  if (/^fx$/i.test(s)) return "FX";
  const m = s.match(/^f?\s*([0-9])$/i) || s.match(/^f([0-9])\b/i);
  if (m) return "F" + m[1];
  const low = s.toLowerCase();
  if (/^(not[\s_-]?fraud|legit|safe|ham|benign|none)$/.test(low)) return "F0";
  for (const c of CODES) if (low.includes(CATS[c].name.toLowerCase().split(" /")[0].toLowerCase())) return c;
  return null;
}

function normalise(raw) {
  raw = raw || {};
  for (const k of ["result", "data", "output", "response"]) if (raw[k] && typeof raw[k] === "object" && !Array.isArray(raw[k])) raw = { ...raw[k], ...raw };
  if (raw.transcript && typeof raw.transcript === "object") raw = { ...raw, transcript: raw.transcript.text || raw.transcript.full_text || "" };
  if (!raw.transcript && !raw.text && Array.isArray(raw.segments)) raw = { ...raw, transcript: raw.segments.map((x) => (x.speaker ? `${x.speaker}: ` : "") + (x.text || "").trim()).join("\n") };
  const pick = (...ks) => { for (const k of ks) if (raw[k] != null && raw[k] !== "") return raw[k]; return undefined; };
  // Classifier "classes": a decision word (fraud / uncertain / not_fraud) plus "key:value" details,
  // e.g. ["fraud", "category:F1", "risk_level:high", "type:financial_impersonation", "flag:F01", …].
  // "flag:Fnn" are red-flag IDs, NOT categories, so key:value entries are never read as a category directly.
  const kv = {}, plain = [];
  if (Array.isArray(raw.classes)) for (const c of raw.classes) {
    const t = String(c).trim(), i = t.indexOf(":");
    if (i > 0) { const k = t.slice(0, i).toLowerCase(); if (!(k in kv)) kv[k] = t.slice(i + 1).trim(); } else if (t) plain.push(t);
  }
  const decision = (plain[0] || "").toLowerCase().replace(/[\s-]+/g, "_");
  const suspected = decision === "fraud" || decision === "uncertain";
  const TYPE_SLUGS = { not_fraud: "F0", financial_impersonation: "F1", account_takeover: "F2", government_impersonation: "F3",
    tech_support_business_impersonation: "F4", romance: "F5", investment_crypto: "F6", sextortion: "F7",
    family_emergency: "F8", prize_job_advance_fee: "F9" };
  const fromKv = () => {
    if (kv.category) { const c = normCategory(kv.category); if (c) return c; if (/^unknown$/i.test(kv.category) && suspected) return "FX"; }
    if (kv.type && TYPE_SLUGS[kv.type.toLowerCase()]) { const c = TYPE_SLUGS[kv.type.toLowerCase()]; return c === "F0" && suspected ? "FX" : c; }
    return null;
  };
  const category = normCategory(pick("category", "family", "class", "prediction", "fraud_type"))
    ?? fromKv() ?? plain.map((c) => normCategory(c)).find(Boolean) ?? (suspected ? "FX" : null);
  const lvl = String(kv.risk_level || pick("risk_level") || "").toLowerCase();
  const risk = { high: "high", medium: "medium", low: "low", safe: "low" }[lvl];
  let conf = pick("confidence", "score", "probability", "prob");
  if (conf != null) { conf = Number(conf); if (conf > 1) conf /= 100; }
  // The scam classifier sends "risk_score:0-100" inside classes (the transcription API forwards only
  // classes + summary). It is a weighted rule/LLM/classifier score, NOT a probability -> shown as "Risk score".
  let riskScore = kv.risk_score != null ? Number(kv.risk_score) : Number(pick("risk_score"));
  riskScore = Number.isFinite(riskScore) ? Math.max(0, Math.min(100, Math.round(riskScore))) : null;
  return {
    transcript: pick("transcript", "text", "transcription") || "",
    summary: pick("summary", "call_summary", "abstract") || "",
    duration: pick("duration", "duration_sec", "duration_seconds"),
    language: pick("language", "lang"),
    token: pick("token", "call_token", "call_id", "id"),
    tokens: pick("tokens", "token_count", "num_tokens"),
    category, risk, decision,
    confidence: conf, riskScore,
    scores: pick("scores", "probabilities"),
    // "report:<ticket>" = signed single-use ticket to add this caller to the shared fraud-caller list; not a label
    reportTicket: kv.report || "",
    labels: toLabels(pick("labels", "tags", "call_labels", "classes")).filter((l) => !/^report:/i.test(l)),
  };
}
function toLabels(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,|;]/) : typeof v === "object" ? Object.keys(v).filter((k) => v[k]) : [String(v)];
  return [...new Set(arr.map((x) => String(typeof x === "object" && x ? (x.name || x.label || x.tag || "") : x).trim()).filter(Boolean))].slice(0, 30);
}

const CFG = Object.assign({ serviceUrl: "", audioField: "audio", healthUrl: "", authCheckUrl: "" }, window.CG_CONFIG || {});
/** Health + token-check URLs for whichever service URL is in use (config values only for the configured service). */
function svcUrls(url) {
  const origin = new URL(url).origin;
  const same = CFG.serviceUrl && new URL(CFG.serviceUrl).origin === origin;
  return { origin, health: (same && CFG.healthUrl) || origin + "/healthz", status: (same && CFG.authCheckUrl) || origin + "/v1/status" };
}
function authHeaders() {
  if (cloud.on) { const t = cloud.token(); return t ? { Authorization: `Bearer ${t}` } : {}; }
  const k = String(S.settings.apiKey || "").trim();
  return k ? { Authorization: `Bearer ${k}` } : {};
}

class ServiceError extends Error {
  constructor(title, detail) { super(`${title} ${detail}`.trim()); this.title = title; this.detail = detail; }
}

async function fetchJSON(url, opts) {
  const ctl = new AbortController();
  const secs = S.settings.timeoutSec || 120;
  const t = setTimeout(() => ctl.abort(), secs * 1000);
  let r;
  try {
    r = await fetch(url, { ...opts, signal: ctl.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new ServiceError("No response from the microservice.", `It did not answer within ${secs} seconds. It may be overloaded or the audio may be too long. You can raise the timeout in Settings.`);
    if (!navigator.onLine) throw new ServiceError("You're offline.", "Check your internet connection and try again.");
    let up = false;
    try { await fetch(svcUrls(url).health, { mode: "no-cors", cache: "no-store" }); up = true; } catch { up = false; }
    if (up) throw new ServiceError("The microservice blocked this website (CORS).", `The service at ${new URL(url).origin} is running but doesn't allow requests from ${location.origin}. Its owner must allow this origin in the service's CORS settings, including OPTIONS requests without a token.`);
    throw new ServiceError("Couldn't reach the microservice.", `No response from ${new URL(url).origin}. It may be down or starting up (free hosting can take about a minute to wake). Try again shortly.`);
  } finally { clearTimeout(t); }
  let text = "";
  try { text = await r.text(); } catch { text = ""; }
  if (!r.ok) {
    const why = {
      400: "It rejected the request (400 Bad Request). The audio format may not be supported.",
      401: cloud.on ? "It did not accept your sign-in (401 Unauthorized). Log out and log in again." : "It did not accept your API token (401 Unauthorized). Check the token in Settings → Microservice.",
      403: "Access denied (403 Forbidden). Check the API key in Settings.",
      404: "The URL was not found (404). Check the microservice URL in Settings.",
      405: "That URL doesn't accept uploads (405 Method Not Allowed).",
      408: "The microservice timed out (408).",
      413: "The audio file is too large for the microservice (413).",
      415: "The microservice doesn't accept this audio type (415).",
      422: "The microservice couldn't process this audio (422).",
      429: "It is processing another recording (429). Try again in a few seconds.",
      503: "The service isn't ready for this request (503).",
    }[r.status] || (r.status >= 500 ? `The microservice had an internal error (${r.status}). Try again later.` : `It answered with an error (HTTP ${r.status}).`);
    let detail = text, rid = "";
    try { const j = JSON.parse(text); detail = typeof j.detail === "string" ? j.detail : j.message || j.error || JSON.stringify(j.detail || j); rid = j.request_id || ""; } catch { /* plain text */ }
    const msg = (detail ? ` Service says: "${String(detail).replace(/\s+/g, " ").slice(0, 200)}"` : "") + (rid ? ` (request ID ${rid})` : "");
    const err = new ServiceError(r.status === 429 ? "The microservice is busy." : "The microservice returned an error.", why + msg);
    err.status = r.status; err.retryAfter = parseInt(r.headers.get("Retry-After") || "0", 10) || 0;
    throw err;
  }
  if (!text.trim()) throw new ServiceError("Empty response from the microservice.", "It answered but sent no data. Expected JSON with transcript, summary, category and labels.");
  try { return JSON.parse(text); }
  catch { throw new ServiceError("Unreadable response from the microservice.", `Expected JSON but got: "${text.replace(/\s+/g, " ").slice(0, 160)}"`); }
}

const services = {
  /** Send the uploaded audio to the microservice. Its JSON reply carries transcript, summary and the fraud category. */
  async analyse(blob, fileName, token, onWait, onTranscript) {
    if (!blob) throw new ServiceError("No audio.", "Upload an audio file or record a call first.");
    if (!S.settings.transcriberUrl) throw new ServiceError("Microservice not connected.", "Add its URL in Settings → Microservice.");
    if (cloud.on) { if (!(await cloud.fresh())) throw new ServiceError("Your sign-in expired.", "Log out and log in again, then retry."); }
    else if (!String(S.settings.apiKey || "").trim()) throw new ServiceError("API token missing.", "The microservice only accepts requests with your API token. Paste it in Settings → Microservice.");
    const fd = new FormData();
    fd.append(CFG.audioField || "audio", blob, fileName || "call.webm");   // exactly one field: the service rejects extras
    let raw = await this.viaJobs(fd, onWait, onTranscript);           // queued: many users at once, live position
    for (let attempt = 1; !raw; attempt++) {           // older service without a jobs API: direct call
      try { raw = await fetchJSON(S.settings.transcriberUrl, { method: "POST", body: fd, headers: authHeaders() }); break; }
      catch (e) {
        if (e.status !== 429 || attempt > 3) throw e;
        const wait = Math.min(30, Math.max(5, e.retryAfter || 10));
        onWait && onWait(`Service is busy with another recording. Retrying in ${wait}s (attempt ${attempt + 1} of 4)…`);
        await sleep(wait * 1000);
      }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ServiceError("Unreadable response from the microservice.", "Expected a JSON object.");
    const r = normalise(raw); r._raw = raw;
    if (!r.category) {
      const raw = (await Promise.resolve(r._raw)) || {};
      const got = raw.category != null ? `category "${String(raw.category).slice(0, 40)}"`
        : Array.isArray(raw.classes) ? `classes ${JSON.stringify(raw.classes).slice(0, 80)}` : "";
      throw new ServiceError("Incomplete response from the microservice.", got
        ? `It sent ${got}, but no fraud decision or category (F0–F9) could be read from it.`
        : `It didn't send a fraud category. Expected "classes" with a decision (fraud / uncertain / not_fraud) and "category:F0"…"F9".`);
    }
    if (!r.transcript && !r.summary) throw new ServiceError("Incomplete response from the microservice.", "It sent no transcript or summary.");
    return r;
  },
  /** Submit to POST /v1/jobs and poll GET /v1/jobs/{id}. Returns the result JSON, or null if the
   *  service has no jobs API (then the caller uses the direct endpoint). */
  async viaJobs(fd, onWait, onTranscript) {
    const url = S.settings.transcriberUrl;
    if (!/\/v1\/audio\/analyze\/?$/.test(new URL(url).pathname)) return null;
    const base = new URL(url).origin + "/v1/jobs";
    const say = (m) => onWait && onWait(m);
    let job;
    for (let attempt = 1; ; attempt++) {
      try { job = await fetchJSON(base, { method: "POST", body: fd, headers: authHeaders() }); break; }
      catch (e) {
        if (e.status === 404 || e.status === 405) return null;
        if (!(e.status === 503 && /waiting/i.test(e.detail || e.message)) || attempt > 10) throw e;
        const wait = Math.min(60, Math.max(10, e.retryAfter || 30));
        say(`The queue is full right now. Trying again in ${wait}s…`); await sleep(wait * 1000);
      }
    }
    if (!job || !job.job_id) return null;
    const label = { queued: "Waiting in line", transcribing: "Transcribing the audio", waiting_for_classifier: "Transcribed. Waiting for the fraud check",
                    classifying: "Checking for fraud" };
    const t0 = Date.now(), limit = Math.max(20 * 60, S.settings.timeoutSec || 0) * 1000;
    let misses = 0, view = job;
    while (true) {
      const secs = Math.round((Date.now() - t0) / 1000);
      if (view.status === "done") return view.result;
      if (view.transcript && onTranscript) { onTranscript(view.transcript); onTranscript = null; }
      if (view.status === "failed") {
        const er = view.error || {};
        throw new ServiceError("The microservice couldn't process this call.", `${er.detail || "Unknown error."}${er.status ? ` (code ${er.status})` : ""}`);
      }
      say(view.status === "queued" ? `${label.queued}: #${view.position || 1}${view.position > 1 ? ` (${view.position - 1} call${view.position > 2 ? "s" : ""} ahead of you)` : ""} · ${secs}s`
        : `${label[view.status] || view.status}… · ${secs}s`);
      if (Date.now() - t0 > limit) throw new ServiceError("No result from the microservice.", `It accepted the call but hasn't finished after ${Math.round(limit / 60000)} minutes. Try again later.`);
      await sleep(view.status === "queued" && view.position > 2 ? 4000 : 1000);
      if (cloud.on) await cloud.fresh();
      try { view = await fetchJSON(`${base}/${encodeURIComponent(job.job_id)}`, { headers: authHeaders() }); misses = 0; }
      catch (e) {
        if (e.status === 404) throw new ServiceError("The call was lost by the microservice.", "It probably restarted while your call was waiting. Nothing was saved. Try again.");
        if (e.status === 401 || ++misses > 6) throw e;
        say(`Connection hiccup, still waiting… · ${secs}s`);
      }
    }
  },
  async notify(n, rec) {
    const url = notifyUrl();
    if (n.channel !== "email") return "sent";   // in-app notification: shown on the Alerts page
    if (!url) return "queued";                  // no notifier: kept in the outbox with a one-click "open in mail app"
    try {
      await fetchJSON(url, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ to: n.to, name: n.name, role: n.role, channel: n.channel, subject: n.subject, body: n.body,
          call_token: rec.token, category: rec.category, category_name: rec.categoryName, risk: rec.risk, created_at: rec.createdAt,
          reply_to: S.contacts.user.email || S.user?.email || "" }),
      });
      return "sent";
    } catch (e) {
      // Email not switched on at the server yet: keep it in the outbox instead of calling it a failure.
      if (e.status === 503 || e.status === 404) { n.reason = "Email sending isn't switched on yet: open it in your mail app."; return "queued"; }
      throw e;
    }
  },
};

/* ============================== labels + routing ============================== */
function warningText(rec) {
  const c = CATS[rec.category];
  const U = S.contacts.user || {};
  const holder = [U.name || S.user?.name, U.email || S.user?.email, U.phone].filter(Boolean).join(" · ") || "a CallGuard user";
  const d = new Date(rec.createdAt);
  let tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { /* old browser */ }
  const when = d.toLocaleString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
  const caller = [rec.callerNumber, rec.callerHandle && rec.callerHandle !== rec.callerNumber ? rec.callerHandle : "", rec.callerName ? `(${rec.callerName})` : ""].filter(Boolean).join(" ") || "Unknown / hidden number";
  return [
    `FRAUD ALERT: CallGuard flagged a call to ${holder} as ${rec.category} · ${c.name}.`,
    "",
    `Risk:        ${String(rec.risk || "").toUpperCase()}${scoreText(rec) ? ` (${scoreText(rec)})` : ""}`,
    `Caller:      ${caller}`,
    `Call type:   ${CHANNELS[rec.channel] || "Phone call"}`,
    `Local time:  ${when}${tz ? ` (${tz})` : ""}`,
    `Call token:  ${rec.token}`,
    "",
    `What happened: ${rec.summary || "(no summary returned)"}`,
    "",
    `Advice: ${c.advice}`,
    "",
    `What to do now: call ${U.name || "the account holder"} directly on a number you already know (not the caller's). Make sure no OTP, PIN, password or payment was shared. ${rec.isBanking ? "If any bank details were shared, ask the bank to block the card / account right away." : ""}`.trim(),
    "",
    "This alert was sent automatically by CallGuard.",
  ].join("\n");
}

const notifyUrl = () => String(S.settings.notifierUrl || window.CG_CONFIG?.notifyUrl || "").trim();

/** Who gets told, per the routing rules. Returns notification objects (not yet sent). */
function planAlerts(rec, C = S.contacts) {
  const out = [];
  if (!rec.isFraud) return out;
  const who = [rec.callerNumber || rec.callerHandle, rec.callerName].filter(Boolean)[0];
  const subject = `⚠ ${rec.isBanking ? "Banking fraud" : "Fraud"} alert: ${CATS[rec.category].name}${who ? ` from ${who}` : ""} (${rec.token})`;
  const body = warningText(rec);
  const add = (role, person, channel, extra = {}) => out.push({
    id: uid(), role, name: person?.name || "", to: person?.email || "", channel, subject, body,
    status: person?.email || channel === "in-app" ? "pending" : "skipped", at: new Date().toISOString(), ...extra,
  });

  // Rule 1 (always, every fraud): the nominee gets a notification + email with the summary and warning
  if (C.nominee.name || isEmail(C.nominee.email)) add("Nominee", C.nominee, "in-app", { to: C.nominee.email || C.nominee.phone || "" });
  if (isEmail(C.nominee.email)) add("Nominee", C.nominee, "email");
  else add("Nominee", null, "email", { reason: "No nominee email added. Add one in Contacts: the nominee is always emailed." });
  // Rule 2: banking fraud -> also the bank the nominee added
  if (rec.isBanking) {
    if (isEmail(C.bank.email)) add("Bank", { name: C.bank.name || "Bank fraud desk", email: C.bank.email }, "email");
    else add("Bank", null, "email", { reason: "No bank added yet (the nominee adds it in Contacts)." });
  }
  // Rule 3: every fraud -> all authorised people AND the emergency contact
  const auth = (C.authorised || []).filter((a) => isEmail(a.email));
  auth.forEach((a) => add("Authorised person", a, "email"));
  if (isEmail(C.emergency.email)) add("Emergency contact", C.emergency, "email");
  else if (!auth.length) add("Emergency contact", null, "email", { reason: "No authorised person or emergency contact added." });

  // never email the same address twice for one call
  const seen = new Set();
  return out.filter((n) => { if (n.channel !== "email" || !n.to) return true; const k = n.to.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function dispatchAlerts(rec, { quiet = false } = {}) {
  for (const n of rec.notifications) {
    if (n.status !== "pending") continue;
    try {
      n.status = await services.notify(n, rec);
    } catch (e) { n.status = "failed"; n.reason = e.message; }
    n.at = new Date().toISOString();
  }
  const emails = rec.notifications.filter((n) => n.channel === "email" && n.to);
  const sent = emails.filter((n) => n.status === "sent").length, bad = emails.filter((n) => n.status === "failed");
  if (quiet) { /* summary shown by the caller */ }
  else if (rec.isFraud && emails.length) {
    if (bad.length) toast(`Fraud alert: ${sent} email${sent === 1 ? "" : "s"} sent, ${bad.length} failed (${bad[0].to}: ${bad[0].reason || "error"}). See Alerts.`, "alert");
    else if (sent) toast(`Fraud alert emailed to ${emails.filter((n) => n.status === "sent").map((n) => n.to).join(", ")}`, "alert");
  } else if (rec.isFraud) toast("Fraud call, but no one to email: add a nominee / emergency contact email in Contacts.", "alert");
  if (rec.isFraud && S.settings.browserNotify && "Notification" in window && Notification.permission === "granted") {
    try { new Notification(`CallGuard: ${CATS[rec.category].name}`, { body: rec.summary || rec.token }); } catch { /* ignore */ }
  }
}

const mailto = (n) => `mailto:${encodeURIComponent(n.to)}?subject=${encodeURIComponent(n.subject)}&body=${encodeURIComponent(n.body)}`;

/** A two-way call's transcript comes as "Caller: …" / "Receiver: …" turns; show them as speakers. */
const speakerText = (t) => String(t || "").replace(/^Caller:/gm, "Speaker 1 (caller):").replace(/^Receiver:/gm, "Speaker 2 (you):");

/* ============================== records ============================== */
function buildRecord({ token, createdAt, fileName, audioType, tr, cls, source, channel, caller }) {
  const code = cls.category;
  const c = CATS[code];
  const words = (tr.transcript.match(/\S+/g) || []).length;
  const callerName = String((caller && caller.name) || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const callerNumber = String((caller && caller.number) || "").replace(/\s+/g, " ").trim().slice(0, 24);
  /* Telegram user ID ("tg:123…") or @username, for callers whose number is hidden. */
  const callerHandle = String((caller && caller.handle) || "").replace(/[^\w@:.+-]/g, "").slice(0, 40);
  const callerKey = callerNumber || callerHandle;
  const rec = {
    id: token, token, createdAt, fileName: fileName || "", audioType: audioType || "",
    duration: tr.duration != null ? Number(tr.duration) : null, language: tr.language || "",
    transcript: tr.transcript, summary: tr.summary,
    tokens: tr.tokens != null ? Number(tr.tokens) : words,
    serviceToken: tr.token && tr.token !== token ? String(tr.token) : "",
    category: code, categoryName: c.name, isFraud: code !== "F0", isBanking: !!c.banking, risk: tr.risk || c.risk, decision: tr.decision || "",
    confidence: cls.confidence != null ? Number(cls.confidence) : null, scores: cls.scores || null, classifiedBy: cls.by,
    riskScore: tr.riskScore != null ? Number(tr.riskScore) : null,
    reportTicket: tr.reportTicket || "", priorFlag: null, reported: "",
    source, channel: CHANNELS[channel] ? channel : "phone",
    callerName, callerNumber, callerHandle,
    /* The caller ID is the number that called (or the platform ID); the contact name is shown after it. */
    callerId: callerKey ? (callerName ? `${callerKey} · ${callerName}` : callerKey) : callerName,
    labels: tr.labels || [], userLabels: [], notifications: [], reviewed: false, hasAudio: false,
  };
  return rec;
}

/* ---------- one call = one history entry ----------
   The extension sends 20 s live parts during a call (for in-call warnings) and the whole-call recording
   at the end, all with the call's sessionId. They update ONE record: the first creates it, later parts
   keep the most serious verdict and add to the transcript, and the whole-call recording (the complete
   context) becomes the final analysis. Alerts are planned once. */
const ANALYSIS_FIELDS = ["category", "categoryName", "isFraud", "isBanking", "risk", "decision", "riskScore",
  "confidence", "scores", "summary", "labels", "classifiedBy", "reportTicket", "language"];
const decisionRank = (r) => ({ fraud: 2, uncertain: 1 }[r && r.decision] || (r && r.isFraud ? 2 : 0));
function mergeSessionRecord(prev, next, kind) {
  const whole = kind === "call";
  const merged = { ...prev, parts: (prev.parts || 1) + (whole ? 0 : 1) };
  for (const k of ["callerNumber", "callerName", "callerHandle", "callerId"]) if (!merged[k] && next[k]) merged[k] = next[k];
  if (prev.wholeCall && !whole) return merged;                   // a late part never overrides the full call
  const worse = decisionRank(next) > decisionRank(prev)
    || (decisionRank(next) === decisionRank(prev) && (next.riskScore ?? -1) > (prev.riskScore ?? -1));
  if (whole || worse) for (const k of ANALYSIS_FIELDS) merged[k] = next[k];
  if (whole) {
    merged.wholeCall = true;
    merged.transcript = next.transcript; merged.duration = next.duration; merged.tokens = next.tokens;
    merged.fileName = next.fileName; merged.audioType = next.audioType;
  } else {
    merged.transcript = [prev.transcript, next.transcript].filter(Boolean).join("\n");
    merged.duration = (Number(prev.duration) || 0) + (Number(next.duration) || 0) || prev.duration;
    merged.tokens = (Number(prev.tokens) || 0) + (Number(next.tokens) || 0) || prev.tokens;
  }
  return merged;
}

async function saveRecord(rec, audioBlob) {
  if (audioBlob) { await idb.putAudio(rec.id, audioBlob); rec.hasAudio = true; }
  await idb.put(rec);
  const i = S.calls.findIndex((c) => c.id === rec.id);
  if (i >= 0) S.calls[i] = rec; else S.calls.unshift(rec);
  S.calls.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  await folder.writeCall(rec, audioBlob).catch(() => {});
  paintChrome();
}

/* ============================== local history folder ============================== */
const folder = {
  supported: "showDirectoryPicker" in window,
  async connect() {
    const h = await window.showDirectoryPicker({ id: "callguard-history", mode: "readwrite" });
    S.dir = h; await idb.kvSet("dir", h);
    await this.syncAll();
  },
  async ok(request = false) {
    if (!S.dir) return false;
    const o = { mode: "readwrite" };
    if ((await S.dir.queryPermission(o)) === "granted") return true;
    return request ? (await S.dir.requestPermission(o)) === "granted" : false;
  },
  async root() { return S.dir.getDirectoryHandle("CallGuard-History", { create: true }); },
  async write(dir, name, data) {
    const f = await dir.getFileHandle(name, { create: true });
    const w = await f.createWritable(); await w.write(data); await w.close();
  },
  ext(type) { return ({ "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/flac": "flac" })[String(type).split(";")[0]] || "audio"; },
  async writeCall(rec, blob) {
    if (!(await this.ok())) return false;
    const root = await this.root();
    const day = await root.getDirectoryHandle(localDate(rec.createdAt), { create: true });
    const dir = await day.getDirectoryHandle(`${localTime(rec.createdAt).replace(":", "")}_${rec.category}_${rec.token}`, { create: true });
    const meta = { ...rec }; delete meta.scores;
    await this.write(dir, "call.json", JSON.stringify(meta, null, 2));
    await this.write(dir, "summary.txt", `${rec.category} · ${rec.categoryName}\n${new Date(rec.createdAt).toLocaleString()}\nToken: ${rec.token}\n\n${rec.summary}\n`);
    await this.write(dir, "transcript.txt", rec.transcript);
    if (blob) await this.write(dir, `audio.${this.ext(blob.type || rec.audioType)}`, blob);
    await this.write(root, "index.csv", toCSV(S.calls));
    return true;
  },
  async syncAll() {
    if (!(await this.ok(true))) throw new Error("Folder permission was not granted.");
    for (const rec of S.calls) await this.writeCall(rec, rec.hasAudio ? await idb.getAudio(rec.id) : null);
    toast(`Saved ${S.calls.length} calls to your history folder`, "folder");
  },
};

function toCSV(rows) {
  const cols = ["token", "date", "time", "source", "caller_id", "category", "category_name", "verdict", "risk", "confidence", "risk_score", "duration_sec", "tokens", "labels", "alerts_sent", "summary"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map((r) => [r.token, localDate(r.createdAt), localTime(r.createdAt), channelName(r), callerIdOf(r), r.category, r.categoryName,
    r.isFraud ? "fraud" : "not fraud", r.risk, r.confidence ?? "", r.riskScore ?? "", r.duration ?? "", r.tokens ?? "",
    r.labels.join("|"), r.notifications.filter((n) => ["sent", "delivered", "queued"].includes(n.status)).length, r.summary].map(q).join(","))].join("\n");
}

function download(name, text, type = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ============================== shared bits of UI ============================== */
const riskStatus = (r) => ({ high: ["critical", "alert", "High"], medium: ["serious", "alert", "Medium"], low: ["good", "shield", "Low"] }[r] || ["warning", "alert", r]);
const riskBadge = (r) => { const [k, ic, t] = riskStatus(r); return `<span class="status ${k}">${icon(ic)}${t}</span>`; };
const verdictBadge = (rec) => rec.isFraud
  ? `<span class="status critical">${icon("alert")}Fraud</span>`
  : `<span class="status good">${icon("shield")}Not fraud</span>`;
const catChip = (code) => `<span class="chip chip-cat ${code === "F0" ? "safe" : ""}" title="${esc(CATS[code].name)}"><b>${code}</b> ${esc(CATS[code].name)}</span>`;
const labelChips = (rec) => rec.labels.length
  ? rec.labels.map((l) => `<span class="chip chip-label">${icon("tag")}${esc(l)}</span>`).join("")
  : `<span class="faint">No labels from the microservice.</span>`;
const confBar = (c) => c == null ? `<span class="faint">–</span>` : `<span class="conf"><span class="bar"><span style="width:${Math.round(c * 100)}%"></span></span><span class="mono">${pct(c)}</span></span>`;
/* Risk score 0-100 from the classifier (not a probability); falls back to a confidence value if a service sends one. */
/* Calls saved before riskScore was stored still carry it as a "risk_score:NN" label. */
const recScore = (rec) => {
  if (rec.riskScore != null) return rec.riskScore;
  const l = (rec.labels || []).find((x) => /^risk_score:\s*\d+(\.\d+)?$/i.test(String(x)));
  return l ? Math.max(0, Math.min(100, Math.round(Number(String(l).split(":")[1])))) : null;
};
const scoreBar = (rec) => { const s = recScore(rec); return s == null ? confBar(rec.confidence)
  : `<span class="conf"><span class="bar"><span style="width:${s}%"></span></span><span class="mono">${s}/100</span></span>`; };
const scoreText = (rec) => { const s = recScore(rec); return s != null ? `risk score ${s}/100` : rec.confidence != null ? `${pct(rec.confidence)} confidence` : ""; };
const scoreValue = (rec) => { const s = recScore(rec); return s != null ? s : rec.confidence != null ? rec.confidence * 100 : -1; };
const alertCount = (rec) => rec.notifications.filter((n) => ["sent", "delivered", "queued"].includes(n.status)).length;

const notifStatus = (n) => ({
  sent: `<span class="status good">${icon("check")}Sent</span>`,
  delivered: `<span class="status good">${icon("check")}Delivered</span>`,
  queued: `<span class="status warning">${icon("mail")}In outbox</span>`,
  failed: `<span class="status critical">${icon("alert")}Failed</span>`,
  skipped: `<span class="status serious">${icon("alert")}Not sent</span>`,
  pending: `<span class="status warning">${icon("clock")}Pending</span>`,
}[n.status] || n.status);
const roleIcon = (r) => ({ Bank: "bank", Nominee: "users", "Authorised person": "shield", "Emergency contact": "alert" }[r] || "mail");

function notifRow(n, rec, actions = true) {
  const target = n.channel === "in-app" ? `App notification${n.to ? " · " + esc(n.to) : ""}` : esc(n.to || n.reason || "");
  return `<div class="notif">
    <span class="n-icon">${icon(roleIcon(n.role))}</span>
    <div class="n-main"><div class="n-title">${esc(n.role)}${n.name ? ` · ${esc(n.name)}` : ""}${n.fallback ? ` <span class="chip">default</span>` : ""}</div>
      <div class="n-sub">${target}${n.reason && n.to ? ` · ${esc(n.reason)}` : ""}</div></div>
    ${notifStatus(n)}
    ${actions && n.channel === "email" && n.to && ["queued", "failed"].includes(n.status) ? `<a class="btn btn-sm btn-soft" href="${mailto(n)}" data-mailed="${rec.id}:${n.id}">${icon("mail")}Open in mail</a>` : ""}
    ${actions && (n.status === "failed" || (n.status === "queued" && n.channel === "email" && n.to && notifyUrl())) ? `<button class="btn btn-sm" data-retry="${rec.id}:${n.id}">${n.status === "queued" ? "Send now" : "Retry"}</button>` : ""}
  </div>`;
}

/* ============================== router + chrome ============================== */
const TITLES = { overview: "Overview", analyze: "Analyze a call", history: "Call history", alerts: "Alerts", contacts: "Contacts & routing", plans: "Plan & usage", settings: "Settings" };
const VIEWS = {};

function route() {
  /* #/call/<token>: open that call's full analysis (the extension's "View analysis" button). */
  const deep = location.hash.match(/^#\/call\/([\w-]{4,40})$/);
  if (deep) {
    const id = deep[1];
    history.replaceState(null, "", "#/history");
    route();
    if (S.calls.some((c) => c.id === id)) openDrawer(id);
    else toast("That call isn't in this browser's history.", "alert");
    return;
  }
  const name = (location.hash.match(/^#\/(\w+)/) || [])[1] || "overview";
  const v = VIEWS[name] ? name : "overview";
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === v));
  $("#pageTitle").textContent = TITLES[v];
  document.title = `${TITLES[v]} · CallGuard`;
  $("#sidebar").classList.remove("open");
  tip.hide();
  VIEWS[v]($("#view"));
  $("#view").focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function monthUsage() {
  const now = new Date();
  return S.calls.filter((c) => { const d = new Date(c.createdAt); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() ; }).length;
}
const currentPlan = () => D.plans.find((p) => p.id === S.settings.plan) || D.plans[0];

function paintChrome() {
  $("#workspaceName").textContent = S.settings.workspace || "My workspace";
  const live = !!S.settings.transcriberUrl;
  const mp = $("#modePill");
  mp.className = `mode-pill ${live ? "live" : ""}`;
  mp.innerHTML = live ? `<span class="dot" style="background:var(--good)"></span>Microservice connected` : `<a href="#/settings" title="Add the microservice URL in Settings" style="display:inline-flex;align-items:center;gap:6px;color:inherit;text-decoration:none"><span class="dot" style="background:var(--warning)"></span>Microservice not connected</a>`;
  const plan = currentPlan(), used = monthUsage();
  $("#usageMini").innerHTML = `<div class="row" style="justify-content:space-between"><b>${esc(plan.name)} plan</b><span class="faint">${used.toLocaleString()} / ${plan.calls.toLocaleString()}</span></div>
    <div class="meter"><span style="width:${Math.min(100, (used / plan.calls) * 100)}%"></span></div>
    <div class="faint" style="margin-top:6px">calls analysed this month</div>`;
  const unseen = S.calls.reduce((n, c) => n + c.notifications.filter((x) => new Date(x.at).getTime() > (S.settings.alertsSeenAt || 0) && x.status !== "skipped").length, 0);
  const b = $("#alertBadge"); b.hidden = !unseen; b.textContent = unseen > 99 ? "99+" : unseen;
}

/* ============================== charts (hand-built SVG) ============================== */
function lineChart(el, days, series) {
  const W = 640, H = 230, m = { t: 14, r: 14, b: 28, l: 34 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = Math.max(4, ...series.flatMap((s) => s.values));
  const step = Math.ceil(max / 4); const top = step * 4;
  const x = (i) => m.l + (days.length === 1 ? iw / 2 : (i * iw) / (days.length - 1));
  const y = (v) => m.t + ih - (v / top) * ih;
  const ticks = [0, 1, 2, 3, 4].map((k) => k * step);
  const labelEvery = Math.ceil(days.length / 7);
  const path = (vals) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Calls per day">
    <g class="axis">${ticks.map((t) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join("")}
      ${days.map((d, i) => (i % labelEvery === 0 || i === days.length - 1) ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}</text>` : "").join("")}</g>
    ${series.map((s) => `<path d="${path(s.values)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join("")}
    <line class="xhair" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" stroke="var(--text-3)" stroke-dasharray="3 3" opacity="0"/>
    ${series.map((s, si) => `<circle class="hdot" data-s="${si}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2" opacity="0"/>`).join("")}
    <rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/>
  </svg>`;
  const svg = el.querySelector("svg"), hit = svg.querySelector(".hit"), xh = svg.querySelector(".xhair");
  hit.addEventListener("mousemove", (e) => {
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    const i = Math.max(0, Math.min(days.length - 1, Math.round(((p.x - m.l) / iw) * (days.length - 1))));
    xh.setAttribute("x1", x(i)); xh.setAttribute("x2", x(i)); xh.setAttribute("opacity", 1);
    svg.querySelectorAll(".hdot").forEach((c) => { const s = series[c.dataset.s]; c.setAttribute("cx", x(i)); c.setAttribute("cy", y(s.values[i])); c.setAttribute("opacity", 1); });
    tip.show(`<div style="margin-bottom:4px;font-weight:650">${days[i].toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</div>
      ${series.map((s) => `<div class="t-row"><i style="background:${s.color}"></i>${esc(s.name)}<b>${s.values[i]}</b></div>`).join("")}`, e.clientX, e.clientY);
  });
  hit.addEventListener("mouseleave", () => { xh.setAttribute("opacity", 0); svg.querySelectorAll(".hdot").forEach((c) => c.setAttribute("opacity", 0)); tip.hide(); });
}

function barChart(el, rows) {
  // rows: [{code, label, value}] -> horizontal bars, one hue (magnitude), rounded data-end, baseline-anchored
  const W = 520, rowH = 30, m = { t: 4, r: 40, b: 4, l: 196 };
  const H = m.t + m.b + rows.length * rowH;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const iw = W - m.l - m.r;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Detections by fraud type">
    <line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${H - m.b}" stroke="var(--border-strong)"/>
    ${rows.map((r, i) => {
      const y = m.t + i * rowH + 7, h = rowH - 14, w = Math.max(r.value ? 4 : 0, (r.value / max) * iw);
      const d = w > 0 ? `M${m.l},${y} h${Math.max(0, w - 4)} a4,4 0 0 1 4,4 v${h - 8} a4,4 0 0 1 -4,4 h-${Math.max(0, w - 4)} z` : "";
      return `<g class="bar-row" data-i="${i}">
        <rect x="0" y="${m.t + i * rowH}" width="${W}" height="${rowH}" fill="transparent"/>
        <text x="${m.l - 10}" y="${y + h / 2 + 4}" text-anchor="end" font-size="12" fill="var(--text-2)" font-family="var(--font)"><tspan font-weight="700" fill="var(--text)">${r.code}</tspan> ${esc(r.label.length > 24 ? r.label.slice(0, 23) + "…" : r.label)}</text>
        ${d ? `<path d="${d}" fill="var(--series-1)"/>` : ""}
        <text x="${m.l + w + 7}" y="${y + h / 2 + 4}" font-size="12" fill="var(--text-2)" font-family="var(--font)">${r.value}</text></g>`;
    }).join("")}</svg>`;
  el.querySelectorAll(".bar-row").forEach((g) => {
    const r = rows[g.dataset.i];
    g.style.cursor = "pointer";
    g.addEventListener("mousemove", (e) => tip.show(`<div style="font-weight:650">${r.code} · ${esc(r.label)}</div><div class="t-row">Calls<b>${r.value}</b></div><div class="faint" style="color:#cfd8d6;margin-top:3px">Click to see them in history</div>`, e.clientX, e.clientY));
    g.addEventListener("mouseleave", () => tip.hide());
    g.addEventListener("click", () => { tip.hide(); S.filters = { ...defaultFilters(), types: [r.code], from: localDate(daysAgo(S.overviewRange - 1)) }; LS.set("filters", S.filters); location.hash = "#/history"; });
  });
}

/* ============================== view: overview ============================== */
VIEWS.overview = (root) => {
  const R = S.overviewRange;
  const start = daysAgo(R - 1);
  const inRange = S.calls.filter((c) => new Date(c.createdAt) >= start);
  const fraud = inRange.filter((c) => c.isFraud);
  const sent = inRange.reduce((n, c) => n + alertCount(c), 0);
  const banking = fraud.filter((c) => c.isBanking).length;
  const days = Array.from({ length: R }, (_, i) => daysAgo(R - 1 - i));
  const per = (list) => days.map((d) => list.filter((c) => localDate(c.createdAt) === localDate(d)).length);
  const plan = currentPlan(), used = monthUsage();

  root.innerHTML = `
    ${!S.calls.length ? `<div class="banner" style="margin-bottom:16px">${icon("shield")}<div><b>Welcome to CallGuard.</b> Upload your first call. Its fraud category comes from your microservice.
      <div class="row" style="margin-top:10px"><a class="btn btn-sm btn-primary" href="#/analyze">${icon("wave")}Analyze a call</a><a class="btn btn-sm" href="#/contacts">Set up contacts</a>${S.settings.transcriberUrl ? "" : `<a class="btn btn-sm btn-ghost" href="#/settings">Connect microservice</a>`}</div></div></div>` : ""}
    <div class="row" style="margin-bottom:14px">
      <div class="muted">Showing the last ${R} days</div><div class="spacer"></div>
      <div class="seg" id="rangeSeg">${[7, 14, 30].map((n) => `<button data-r="${n}" class="${n === R ? "on" : ""}">${n} days</button>`).join("")}</div>
    </div>
    <div class="grid g-4">
      <div class="card kpi k-link" id="kpiCalls" title="Show all calls in history"><div class="k-label"><span class="k-icon">${icon("wave")}</span>Calls analysed</div><div class="k-value">${inRange.length}</div><div class="k-foot">${inRange.filter((c) => !c.isFraud).length} not fraud</div></div>
      <div class="card kpi k-link" id="kpiFraud" title="Show fraud calls in history"><div class="k-label"><span class="k-icon" style="background:var(--critical-soft);color:var(--critical-ink)">${icon("alert")}</span>Fraud detected</div><div class="k-value">${fraud.length}</div><div class="k-foot">${banking} banking · ${fraud.length - banking} other</div></div>
      <div class="card kpi"><div class="k-label"><span class="k-icon" style="background:var(--lav-soft);color:#4b47a0">${icon("shield")}</span>Fraud rate</div><div class="k-value">${inRange.length ? Math.round((fraud.length / inRange.length) * 100) : 0}%</div><div class="k-foot">of analysed calls</div></div>
      <div class="card kpi"><div class="k-label"><span class="k-icon" style="background:var(--sand-soft);color:#7a5a1c">${icon("bell")}</span>Alerts sent</div><div class="k-value">${sent}</div><div class="k-foot">${used} / ${plan.calls.toLocaleString()} calls this month</div></div>
    </div>
    <div class="grid g-main" style="margin-top:18px">
      <div class="card">
        <div class="card-head"><h3>Calls per day</h3><span class="sub">hover for daily counts</span></div>
        <div class="legend" style="margin-top:10px"><span><i style="background:var(--series-1)"></i>All calls</span><span><i style="background:var(--series-2)"></i>Fraud</span></div>
        <div class="chart" id="lineChart"></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Fraud by type</h3><span class="sub">click a bar to filter history</span></div>
        <div class="chart" id="barChart" style="padding-top:12px"></div>
      </div>
    </div>
    <div class="grid g-2" style="margin-top:18px">
      <div class="card"><div class="card-head"><h3>Latest fraud calls</h3><div class="right"><a class="btn btn-sm btn-ghost" href="#/history">View all</a></div></div>
        ${fraud.length ? `<ul class="list">${fraud.slice(0, 5).map((c) => `<li data-open="${c.id}">
          <span class="l-icon" style="background:var(--critical-soft);color:var(--critical-ink)">${icon(c.isBanking ? "bank" : "alert")}</span>
          <div class="l-main"><div class="l-title">${c.category} · ${esc(c.categoryName)}</div><div class="l-sub">${esc(c.summary)}</div></div>
          <div class="l-meta">${fmtDT(c.createdAt)}</div></li>`).join("")}</ul>` : `<div class="empty">${icon("shield")}<div>No fraud calls in this period.</div></div>`}
      </div>
      <div class="card"><div class="card-head"><h3>Who gets alerted</h3><div class="right"><a class="btn btn-sm btn-ghost" href="#/contacts">Edit</a></div></div>
        <div class="card-pad" style="padding-top:12px">${routingSummary()}</div></div>
    </div>`;

  lineChart($("#lineChart"), days, [
    { name: "All calls", color: "var(--series-1)", values: per(inRange) },
    { name: "Fraud", color: "var(--series-2)", values: per(fraud) },
  ]);
  const bars = CODES.filter((c) => c !== "F0").map((code) => ({ code, label: CATS[code].name, value: fraud.filter((c) => c.category === code).length }));
  if (fraud.length) barChart($("#barChart"), bars); else $("#barChart").innerHTML = `<div class="empty">${icon("grid")}<div>Fraud types will appear here.</div></div>`;

  $("#rangeSeg").onclick = (e) => { const b = e.target.closest("button"); if (b) { S.overviewRange = +b.dataset.r; route(); } };
  const goFiltered = (patch) => { S.filters = { ...defaultFilters(), from: localDate(start), ...patch }; LS.set("filters", S.filters); location.hash = "#/history"; };
  $("#kpiCalls").onclick = () => goFiltered({});
  $("#kpiFraud").onclick = () => goFiltered({ verdict: "fraud" });
  $$("[data-open]", root).forEach((li) => li.onclick = () => openDrawer(li.dataset.open));
};

function routingSummary() {
  const C = S.contacts;
  const who = (p, fallback) => p && (p.name || p.email) ? `<b>${esc(p.name || p.email)}</b>${p.email ? ` <span class="faint">${esc(p.email)}</span>` : ""}` : `<span class="status serious">${icon("alert")}${fallback}</span>`;
  const auth = C.authorised.filter((a) => isEmail(a.email));
  return `<table class="rules">
    <tr><td style="width:42%">${riskBadge("low")} Not fraud (F0)</td><td>Logged with date, token and summary. No alerts.</td></tr>
    <tr><td>${icon("alert")} Every fraud (F1–F9)</td><td>Notification + email to nominee (always): ${who(isEmail(C.nominee.email) ? C.nominee : null, "No nominee email")}</td></tr>
    <tr><td>${icon("bank")} Banking fraud (F1, F2)</td><td>Also email to bank: ${who(C.bank.email ? { name: C.bank.name, email: C.bank.email } : null, "No bank added")}</td></tr>
    <tr><td>${icon("shield")} Every fraud</td><td>${auth.length ? `Authorised: ${auth.map((a) => `<b>${esc(a.name || a.email)}</b>`).join(", ")} · ` : ""}Emergency contact: ${who(isEmail(C.emergency.email) ? C.emergency : null, "None added")}</td></tr>
  </table>`;
}

/* ============================== view: analyze ============================== */
VIEWS.analyze = (root) => {
  const live = !!S.settings.transcriberUrl;
  const plan = currentPlan(), used = monthUsage();
  root.innerHTML = `
    <p class="section-intro">Upload or record a call. CallGuard sends the audio to your microservice, which returns the transcript, summary and fraud category. CallGuard then labels the call, alerts the right people and saves everything to history.</p>
    ${!live ? `<div class="banner warn" style="margin-bottom:16px">${icon("alert")}<div><b>Microservice not connected.</b> Calls can't be analysed until its URL is added in <a href="#/settings">Settings</a>.</div></div>` : ""}
    ${used >= plan.calls ? `<div class="banner warn" style="margin-bottom:16px">${icon("alert")}<div>You have used all ${plan.calls} calls on the ${esc(plan.name)} plan this month. <a href="#/plans">Upgrade</a> to keep analysing.</div></div>` : ""}
    <div class="grid g-main">
      <div class="stack">
        <div class="card card-pad">
          <div class="row" style="margin-bottom:14px"><h3>1. Choose audio</h3><div class="spacer"></div>
            <div class="seg" id="srcSeg"><button data-s="upload" class="on">Upload file</button><button data-s="record">Record</button></div></div>
          <div id="srcUpload">
            <label class="dropzone" id="dropzone">
              <input type="file" id="fileInput" accept="audio/*,.mp3,.wav,.m4a,.ogg,.webm,.flac" hidden>
              <span class="dz-icon">${icon("upload")}</span>
              <h3>Drop a call recording here</h3>
              <div class="muted">or click to browse · MP3, WAV, M4A, OGG, WEBM, FLAC</div>
            </label>
          </div>
          <div id="srcRecord" hidden>
            <div class="row" style="padding:18px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2)">
              <button class="btn btn-primary" id="recBtn">${icon("mic")}Start recording</button>
              <span id="recState" class="muted">Uses your microphone. Nothing is sent until you click Analyze.</span>
            </div>
          </div>
          <div id="filePill" style="margin-top:14px"></div>
          <div class="row" style="margin-top:16px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:end">
            <div class="field"><label for="aSource">Source of call</label>
              <select class="input" id="aSource">${Object.entries(CHANNELS).map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></div>
            <div class="field"><label for="aCallerName">Caller name (optional)</label>
              <input class="input" id="aCallerName" maxlength="80" placeholder="e.g. Asha Rao" autocomplete="off"></div>
            <div class="field"><label for="aCallerNumber" id="aCallerLbl">Caller number (optional)</label>
              <input class="input" id="aCallerNumber" maxlength="40" placeholder="+1 (555) 123-4567" autocomplete="off"></div>
          </div>
          <div class="row" style="margin-top:16px">
            <button class="btn btn-primary" id="analyzeBtn">${icon("wave")}Analyze call</button>
          </div>
        </div>
        <div id="resultBox"></div>
      </div>
      <div class="card card-pad" style="align-self:start">
        <h3 style="margin-bottom:6px">2. Pipeline</h3>
        <div class="faint" style="font-size:12.5px;margin-bottom:8px">${live ? `Microservice: <span class="mono">${esc(S.settings.transcriberUrl)}</span>` : "Microservice not connected"}</div>
        <ol class="steps" id="steps">${stepItems(S.run ? S.run.state : {})}</ol>
      </div>
    </div>`;

  const setPending = (blob, name, fresh = true) => {
    S.pending = blob ? { blob, name } : null;
    if (fresh) { if (!S.run || !S.run.running) S.run = null; renderRun(); }          // a new file clears the old result
    idb.kvSet("pending", S.pending).catch(() => {});                                  // survives reloads and tab switches
    if (!blob) { $("#filePill").innerHTML = ""; return; }
    const url = URL.createObjectURL(blob);
    $("#filePill").innerHTML = `<div class="file-pill"><span class="k-icon" style="width:34px;height:34px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;background:var(--primary-soft);color:var(--primary-600)">${icon("wave")}</span>
      <div style="min-width:0"><div style="font-weight:620;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px">${esc(name)}</div><div class="faint" style="font-size:12px">${(blob.size / 1024 / 1024).toFixed(2)} MB</div></div>
      <audio controls src="${url}"></audio><button class="icon-btn" id="clearFile" aria-label="Remove file">${icon("x")}</button></div>`;
    $("#clearFile").onclick = () => setPending(null);
  };
  if (S.pending) setPending(S.pending.blob, S.pending.name, false);
  else idb.kvGet("pending").then((p) => { if (p && p.blob && !S.pending && $("#filePill")) setPending(p.blob, p.name, false); }).catch(() => {});
  renderRun();

  $("#srcSeg").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("#srcSeg button").forEach((x) => x.classList.toggle("on", x === b));
    $("#srcUpload").hidden = b.dataset.s !== "upload"; $("#srcRecord").hidden = b.dataset.s !== "record";
  };
  const fi = $("#fileInput"), dz = $("#dropzone");
  fi.onchange = () => fi.files[0] && setPending(fi.files[0], fi.files[0].name);
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("over"); };
  dz.ondragleave = () => dz.classList.remove("over");
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) setPending(f, f.name); };

  recorder.onReady = (blob, name) => setPending(blob, name);
  $("#recBtn").onclick = () => (recorder.active() ? recorder.stop() : recorder.start());
  if (recorder.active()) $("#srcSeg [data-s=record]").click();
  recorder.paint();

  /* The caller box asks for what that platform uses: a number, or a Telegram username / ID. */
  const CALLER_HINT = {
    phone: ["Caller number (optional)", "+1 (555) 123-4567"],
    whatsapp: ["WhatsApp number (optional)", "+1 (555) 123-4567"],
    telegram: ["Telegram number, @username or ID (optional)", "@username or 123456789"],
  };
  const paintSource = () => { const [l, ph] = CALLER_HINT[$("#aSource").value] || CALLER_HINT.phone; $("#aCallerLbl").textContent = l; $("#aCallerNumber").placeholder = ph; };
  $("#aSource").onchange = paintSource;
  const fromName = () => { const ch = channelFromName(S.pending && S.pending.name); if (ch) { $("#aSource").value = ch; paintSource(); } };
  $("#fileInput").addEventListener("change", () => setTimeout(fromName, 0));
  dz.addEventListener("drop", () => setTimeout(fromName, 0));
  fromName(); paintSource();

  $("#analyzeBtn").onclick = () => runPipeline(S.pending?.blob || null, S.pending?.name || "", {
    channel: $("#aSource").value,
    caller: { name: $("#aCallerName").value, ...parseCallerInput($("#aCallerNumber").value, $("#aSource").value) },
  });
};

/* ---------- microphone recorder: lives outside the page, so switching pages never stops it ---------- */
const recorder = {
  rec: null, stream: null, chunks: [], t0: 0, timer: null, onReady: null,
  active() { return !!(this.rec && this.rec.state === "recording"); },
  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) { toast("Microphone not available: " + e.message, "alert"); return; }
    this.chunks = []; this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.onstop = () => {
      this.stream.getTracks().forEach((t) => t.stop()); clearInterval(this.timer);
      const blob = new Blob(this.chunks, { type: this.rec.mimeType || "audio/webm" });
      const name = `recording-${localDate(new Date())}-${localTime(new Date()).replace(":", "")}.${folder.ext(blob.type)}`;
      S.pending = { blob, name }; idb.kvSet("pending", S.pending).catch(() => {});
      if ($("#filePill") && this.onReady) this.onReady(blob, name);
      this.rec = null; this.paint();
      toast(`Recording saved (${fmtDur((Date.now() - this.t0) / 1000)}). Ready to analyse.`, "check");
    };
    this.rec.start(1000); this.t0 = Date.now();          // 1 s chunks: nothing lost if the page is busy
    this.timer = setInterval(() => this.paint(), 250);
    this.paint();
  },
  stop() { if (this.active()) this.rec.stop(); },
  /** Update the Analyze page controls (if shown) and the bar that's visible on every page. */
  paint() {
    const on = this.active(), t = on ? fmtDur((Date.now() - this.t0) / 1000) : "";
    const btn = $("#recBtn"), st = $("#recState");
    if (btn) btn.innerHTML = on ? `${icon("x")}Stop recording` : `${icon("mic")}${S.pending && /^recording-/.test(S.pending.name) ? "Record again" : "Start recording"}`;
    if (st) st.innerHTML = on ? `<span class="row"><span class="rec-dot"></span>Recording ${t}</span>`
      : (S.pending && /^recording-/.test(S.pending.name) ? "Recording ready." : "Uses your microphone. Nothing is sent until you click Analyze.");
    let bar = $("#recBar");
    if (!on) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement("div"); bar.id = "recBar"; bar.className = "rec-bar"; bar.setAttribute("role", "status");
      document.body.appendChild(bar);
    }
    bar.innerHTML = `<span class="rec-dot"></span><b>Recording ${t}</b><a href="#/analyze">Open</a><button type="button" id="recBarStop">${icon("x")}Stop</button>`;
    $("#recBarStop").onclick = () => this.stop();
  },
};
window.addEventListener("beforeunload", (e) => { if (recorder.active()) { e.preventDefault(); e.returnValue = ""; } });

/** Re-draw the current/last analysis (progress, result or error) into whatever Analyze page is showing. */
function renderRun() {
  const box = $("#resultBox"), steps = $("#steps"), btn = $("#analyzeBtn");
  if (!box) return;
  const r = S.run;
  if (steps) steps.innerHTML = stepItems(r ? r.state : {});
  if (btn) { btn.disabled = !!(r && r.running); btn.innerHTML = r && r.running ? `<span class="spin"></span> Analysing…` : `${icon("wave")}Analyze call`; }
  if (r && r.running && r.partial) {         // transcript arrives first; the fraud verdict follows
    box.innerHTML = `<div class="card card-pad"><div class="row" style="margin-bottom:8px"><span class="spin"></span><h3>Transcript ready. Checking for fraud…</h3></div>
      <div class="muted" style="white-space:pre-wrap;font-size:14px;line-height:1.55">${esc(speakerText(r.partial))}</div></div>`;
    return;
  }
  if (!r || r.running) { box.innerHTML = ""; return; }
  if (r.rec) { box.innerHTML = resultCard(r.rec); bindResult(box, r.rec); return; }
  if (r.error) {
    const { title, detail, canRetry } = r.error;
    box.innerHTML = `<div class="card card-pad err-card" role="alert">
      <div class="row" style="align-items:flex-start;gap:14px"><span class="v-icon err-icon">${icon("alert")}</span>
        <div style="flex:1;min-width:0"><h3>${esc(title)}</h3><div class="muted" style="margin-top:4px">${esc(detail)}</div>
          <div class="faint" style="font-size:12px;margin-top:8px">No result was saved and no alerts were sent.</div>
          <div class="row" style="margin-top:12px">${canRetry ? `<button class="btn btn-primary btn-sm" id="retryBtn">Try again</button>` : ""}
            ${/connected|URL|token|CORS|timeout|sign-in/i.test(detail + title) ? `<a class="btn btn-sm" href="#/settings">Open Settings</a>` : ""}</div></div></div></div>`;
    const rb = $("#retryBtn"); if (rb) rb.onclick = () => runPipeline(r.blob, r.fileName, r.opts);
  }
}

const STEPS = [
  ["upload", "Receive audio", "Audio file or recording"],
  ["transcribe", "Microservice", "Transcript, summary + category"],
  ["classify", "Fraud category", "F0–F9 from the microservice"],
  ["label", "Label & save", "Date, token, labels, history"],
  ["alert", "Route alerts", "Nominee · bank · authorised · emergency"],
];
const stepItems = (state = {}) => STEPS.map(([k, t, sub], i) => {
  const s = state[k] || {};
  return `<li class="${s.st || ""}" data-step="${k}"><span class="s-dot">${s.st === "done" ? icon("check") : s.st === "active" ? `<span class="spin"></span>` : s.st === "error" ? "!" : i + 1}</span>
    <div><div class="s-title">${t}</div><div class="s-sub">${esc(s.note || sub)}</div></div></li>`;
}).join("");

async function runPipeline(blob, fileName, opts = {}) {
  if (S.run && S.run.running) { toast("An analysis is already running.", "alert"); return; }
  const state = {};
  S.run = { state, running: true, blob, fileName, opts };
  const set = (k, st, note) => { state[k] = { st, note }; const el = $("#steps"); if (el) el.innerHTML = stepItems(state); };
  renderRun();
  const createdAt = opts.createdAt || new Date().toISOString();
  const token = makeToken(new Date(createdAt));
  let cur = "upload";
  try {
    if (!blob) throw new ServiceError("No audio.", "Upload an audio file or record a call first. Nothing is analysed without audio.");
    if (!blob.size) throw new ServiceError("The audio file is empty.", "Choose a recording that has sound in it.");
    if (blob.type && !/^audio\/|^video\/webm/.test(blob.type) && !/\.(mp3|wav|m4a|ogg|webm|flac|aac)$/i.test(fileName)) throw new ServiceError("That isn't an audio file.", `"${fileName}" is ${blob.type}. Upload MP3, WAV, M4A, OGG, WEBM or FLAC.`);
    const secs = await audioDuration(blob);
    const maxSecs = CFG.maxAudioSeconds || 120;
    if (secs != null && secs > maxSecs + 0.5) throw new ServiceError("Recording is too long.", `It is ${fmtDur(secs)} long. The microservice accepts up to ${fmtDur(maxSecs)}. Trim it and try again.`);
    set("upload", "done", `${fileName} · ${(blob.size / 1024).toFixed(0)} KB${secs != null ? ` · ${fmtDur(secs)}` : ""}`);
    cur = "transcribe"; set("transcribe", "active", "Sending audio to your microservice…");
    const tr = await services.analyse(blob, fileName, token, (note) => set("transcribe", "active", note),
      (text) => { S.run.partial = text; renderRun(); });
    if (tr.duration == null) tr.duration = secs;
    set("transcribe", "done", [tr.transcript ? `${(tr.transcript.match(/\S+/g) || []).length} words` : "", tr.summary ? "summary received" : "no summary", tr.labels.length ? `${tr.labels.length} labels` : ""].filter(Boolean).join(" · "));
    cur = "classify";
    const cls = { category: tr.category, confidence: tr.confidence, scores: tr.scores, by: "microservice" };
    set("classify", "done", `${cls.category} · ${CATS[cls.category].name}${tr.riskScore != null ? ` (risk score ${tr.riskScore}/100)` : cls.confidence != null ? ` (${pct(cls.confidence)})` : ""}`);
    cur = "label"; set("label", "active");
    let rec = buildRecord({ token, createdAt, fileName, audioType: blob.type, tr, cls, source: opts.source || "microservice", channel: opts.channel, caller: opts.caller });
    const prev = opts.sessionId ? S.calls.find((c) => c.sessionId === opts.sessionId) : null;
    if (opts.sessionId) { rec.sessionId = opts.sessionId; rec.wholeCall = opts.kind === "call"; rec.parts = opts.kind === "chunk" ? 1 : 0; }
    if (prev) {
      /* Another part (or the whole recording) of a call already in history: update that entry. */
      rec = mergeSessionRecord(prev, rec, opts.kind);
      if (rec.isFraud && !(rec.notifications || []).length) rec.notifications = planAlerts(rec);
      await saveRecord(rec, opts.kind === "call" || !prev.hasAudio ? blob : null);
    } else {
      rec.notifications = planAlerts(rec);
      await saveRecord(rec, blob);
    }
    await sharedCallerStep(rec);                      // repeat-caller lookup + auto-report a fraud call
    await saveRecord(rec, null);
    set("label", "done", `${rec.labels.length} labels · saved${S.dir ? " + history folder" : ""}${rec.priorFlag && rec.priorFlag.flagged ? ` · repeat fraud caller (${rec.priorFlag.reports}× before)` : ""}`);
    cur = "alert"; set("alert", "active");
    await dispatchAlerts(rec);
    await saveRecord(rec, null);
    const n = alertCount(rec);
    set("alert", "done", rec.isFraud ? (() => { const e = rec.notifications.filter((x) => x.channel === "email" && x.to); const ok = e.filter((x) => x.status === "sent").length; const f = e.filter((x) => x.status === "failed").length; return e.length ? `${ok} email${ok === 1 ? "" : "s"} sent${f ? `, ${f} failed` : ""}${e.length - ok - f ? `, ${e.length - ok - f} in outbox` : ""}` : "No contacts to email (add them in Contacts)"; })() : "Not fraud: no alerts needed");
    S.run.rec = rec;
    S.pending = null; idb.kvSet("pending", null).catch(() => {});
    if ($("#filePill")) $("#filePill").innerHTML = "";
    toast(rec.isFraud ? `Fraud detected: ${rec.categoryName}` : "Call looks safe", rec.isFraud ? "alert" : "shield");
    return rec;
  } catch (e) {
    const title = e.title || "Analysis stopped.", detail = e.detail ?? e.message;
    set(cur, "error", title);
    S.run.error = { title, detail, canRetry: !!blob && cur !== "upload" };
    return null;
  } finally { S.run.running = false; renderRun(); }
}

function audioDuration(blob) {
  return new Promise((res) => {
    const a = new Audio(); a.preload = "metadata";
    a.onloadedmetadata = () => { res(isFinite(a.duration) ? a.duration : null); URL.revokeObjectURL(a.src); };
    a.onerror = () => res(null);
    a.src = URL.createObjectURL(blob);
    setTimeout(() => res(null), 4000);
  });
}

function resultCard(rec) {
  const c = CATS[rec.category];
  return `<div class="card card-pad stack">
    <div class="verdict ${rec.isFraud ? "fraud" : "safe"}">
      <span class="v-icon">${icon(rec.isFraud ? "alert" : "shield")}</span>
      <div style="flex:1;min-width:0"><div class="row">${verdictBadge(rec)}${riskBadge(rec.risk)}${rec.isBanking ? `<span class="chip">${icon("bank")}Banking</span>` : ""}</div>
        <h2 style="margin-top:8px">${rec.category} · ${esc(c.name)}</h2>
        <div class="muted" style="margin-top:4px">${esc(c.advice)}</div></div>
    </div>
    ${repeatBanner(rec)}
    <dl class="kv">
      <div><dt>Date</dt><dd>${fmtDT(rec.createdAt)}</dd></div>
      <div><dt>Token</dt><dd class="mono" title="${esc(rec.token)}">${esc(rec.token)}</dd></div>
      <div><dt>Risk score</dt><dd>${scoreBar(rec)}</dd></div>
      <div><dt>Source of call</dt><dd>${esc(channelName(rec))}</dd></div>
      <div><dt>${esc(callerKindOf(rec))}</dt><dd>${esc(callerIdOf(rec) || "–")}</dd></div>
      <div><dt>Duration · words</dt><dd>${fmtDur(rec.duration)} · ${rec.tokens ?? "–"}</dd></div>
    </dl>
    <div><div class="lbl" style="margin-bottom:6px">Summary (from transcriber)</div><div class="summary">${esc(rec.summary || "No summary returned.")}</div></div>
    <div><div class="lbl" style="margin-bottom:6px">Labels</div><div class="row" style="gap:6px">${labelChips(rec)}</div></div>
    <div><div class="lbl" style="margin-bottom:6px">Shared fraud-caller list</div>${sharedListRow(rec)}</div>
    <div><div class="lbl" style="margin-bottom:2px">Alerts</div>${rec.notifications.length ? rec.notifications.map((n) => notifRow(n, rec)).join("") : `<div class="faint">Not fraud, so nobody was alerted.</div>`}</div>
    <div class="row"><button class="btn" data-open="${rec.id}">Open full details</button><a class="btn btn-ghost" href="#/history">Go to history</a></div>
  </div>`;
}

function bindResult(box, rec) {
  $$("[data-open]", box).forEach((b) => b.onclick = () => openDrawer(b.dataset.open));
  const again = () => { box.innerHTML = resultCard(S.calls.find((c) => c.id === rec.id)); bindResult(box, rec); };
  bindNotifActions(box, again);
  bindSharedList(box, again);
}

function bindNotifActions(scope, rerender) {
  $$("[data-mailed]", scope).forEach((a) => a.addEventListener("click", async () => {
    const [cid, nid] = a.dataset.mailed.split(":"); const rec = S.calls.find((c) => c.id === cid); if (!rec) return;
    const n = rec.notifications.find((x) => x.id === nid); if (!n) return;
    setTimeout(async () => {
      if (await modal({ title: "Did you send the email?", body: `Mark the alert to <b>${esc(n.to)}</b> as sent.`, confirm: "Yes, mark as sent", cancel: "Not yet" })) {
        n.status = "sent"; n.at = new Date().toISOString(); n.reason = "Sent from your mail app"; await saveRecord(rec); rerender && rerender();
      }
    }, 600);
  }));
  $$("[data-retry]", scope).forEach((b) => b.onclick = async () => {
    const [cid, nid] = b.dataset.retry.split(":"); const rec = S.calls.find((c) => c.id === cid);
    const n = rec?.notifications.find((x) => x.id === nid); if (!n) return;
    n.status = "pending"; n.reason = ""; await dispatchAlerts(rec); await saveRecord(rec);
    toast(n.status === "failed" ? "Still failing: " + n.reason : n.status === "queued" ? (n.reason || "Still in the outbox") : `Email sent to ${n.to}`, n.status === "sent" ? "check" : "alert");
    rerender && rerender();
  });
}

/* ============================== view: history ============================== */
const defaultFilters = () => ({ q: "", from: "", to: "", tFrom: "", tTo: "", types: [], channel: "all", verdict: "all", risk: "all", label: "", alerts: "any", sort: "new" });

function applyFilters(F) {
  const q = F.q.trim().toLowerCase();
  let rows = S.calls.filter((c) => {
    const d = localDate(c.createdAt), t = localTime(c.createdAt);
    if (F.from && d < F.from) return false;
    if (F.to && d > F.to) return false;
    if (F.tFrom || F.tTo) {
      const a = F.tFrom || "00:00", b = F.tTo || "23:59";
      if (a <= b ? (t < a || t > b) : (t < a && t > b)) return false;    // supports overnight ranges like 22:00–06:00
    }
    if (F.types.length && !F.types.includes(c.category)) return false;
    if (F.channel !== "all" && channelOf(c) !== F.channel) return false;
    if (F.verdict === "fraud" && !c.isFraud) return false;
    if (F.verdict === "safe" && c.isFraud) return false;
    if (F.verdict === "banking" && !c.isBanking) return false;
    if (F.risk !== "all" && c.risk !== F.risk) return false;
    if (F.label && !c.labels.includes(F.label)) return false;
    if (F.alerts === "alerted" && !alertCount(c)) return false;
    if (F.alerts === "problem" && !c.notifications.some((n) => ["failed", "skipped", "queued"].includes(n.status))) return false;
    if (q && !`${c.token} ${c.summary} ${c.transcript} ${c.categoryName} ${c.fileName} ${callerIdOf(c)} ${c.labels.join(" ")}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const by = { new: (a, b) => b.createdAt.localeCompare(a.createdAt), old: (a, b) => a.createdAt.localeCompare(b.createdAt),
    conf: (a, b) => scoreValue(b) - scoreValue(a), risk: (a, b) => ({ high: 0, medium: 1, low: 2 }[a.risk] - { high: 0, medium: 1, low: 2 }[b.risk]) || b.createdAt.localeCompare(a.createdAt) };
  return rows.sort(by[F.sort] || by.new);
}

VIEWS.history = (root) => {
  const F = S.filters = { ...defaultFilters(), ...(S.filters || {}) };
  const allLabels = [...new Set(S.calls.flatMap((c) => c.labels))].sort();
  const advCount = [F.tFrom, F.tTo, F.label].filter(Boolean).length + (F.channel !== "all") + (F.verdict !== "all") + (F.risk !== "all") + (F.alerts !== "any") + (F.types.length ? 1 : 0);
  root.innerHTML = `
    <div class="card">
      <div class="filters">
        <div class="f-row fr-top">
          <div class="field f-search"><label for="fq">Search</label><input class="input" id="fq" placeholder="Token, summary, transcript, label…" value="${esc(F.q)}"></div>
          <div class="field"><label for="ffrom">From date</label><input type="date" class="input" id="ffrom" value="${esc(F.from)}"></div>
          <div class="field"><label for="fto">To date</label><input type="date" class="input" id="fto" value="${esc(F.to)}"></div>
          <div class="field"><label for="fsort">Sort</label><select class="input" id="fsort">
            ${[["new", "Newest first"], ["old", "Oldest first"], ["risk", "Highest risk"], ["conf", "Highest risk score"]].map(([v, t]) => `<option value="${v}" ${F.sort === v ? "selected" : ""}>${t}</option>`).join("")}</select></div>
        </div>
        <div class="adv" id="advBody" ${advCount ? "" : "hidden"}>
          <div class="f-row fr-adv1">
            <div class="field"><label for="ftf">From time</label><input type="time" class="input" id="ftf" value="${esc(F.tFrom)}"></div>
            <div class="field"><label for="ftt">To time</label><input type="time" class="input" id="ftt" value="${esc(F.tTo)}"></div>
            <div class="field"><label for="fchannel">Source of call</label><select class="input" id="fchannel">
              ${[["all", "Any source"], ...Object.entries(CHANNELS)].map(([v, t]) => `<option value="${v}" ${F.channel === v ? "selected" : ""}>${t}</option>`).join("")}</select></div>
          </div>
          <div class="f-row fr-adv2">
            <div class="field"><label for="fverdict">Verdict</label><select class="input" id="fverdict">
              ${[["all", "All calls"], ["fraud", "Fraud only"], ["safe", "Not fraud only"], ["banking", "Banking fraud"]].map(([v, t]) => `<option value="${v}" ${F.verdict === v ? "selected" : ""}>${t}</option>`).join("")}</select></div>
            <div class="field"><label for="frisk">Risk</label><select class="input" id="frisk">
              ${["all", "high", "medium", "low"].map((v) => `<option value="${v}" ${F.risk === v ? "selected" : ""}>${v === "all" ? "Any risk" : v[0].toUpperCase() + v.slice(1)}</option>`).join("")}</select></div>
            <div class="field"><label for="flabel">Label</label><select class="input" id="flabel"><option value="">Any label</option>
              ${allLabels.map((l) => `<option ${F.label === l ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
            <div class="field"><label for="falerts">Alerts</label><select class="input" id="falerts">
              ${[["any", "Any"], ["alerted", "Alerts sent"], ["problem", "Needs attention"]].map(([v, t]) => `<option value="${v}" ${F.alerts === v ? "selected" : ""}>${t}</option>`).join("")}</select></div>
          </div>
          <div class="field"><span class="lbl">Quick range</span><div class="row" style="gap:6px">
            ${[["today", "Today"], ["7", "7 days"], ["30", "30 days"], ["all", "All time"]].map(([v, t]) => `<button class="chip-toggle" data-quick="${v}">${t}</button>`).join("")}</div></div>
          <div class="field"><span class="lbl">Fraud type</span><div class="f-types" style="margin-top:6px">
            ${CODES.map((c) => `<button class="chip-toggle ${F.types.includes(c) ? "on" : ""}" data-type="${c}" title="${esc(CATS[c].name)}">${c} · ${esc(CATS[c].name.split(" /")[0])}</button>`).join("")}</div></div>
        </div>
      </div>
      <div class="result-bar">
        <b id="resCount"></b><span class="faint" id="resSub"></span>
        <button class="btn btn-sm ${advCount ? "btn-soft" : "btn-ghost"}" id="advToggle">${icon("chev")}More filters${advCount ? ` <span class="chip">${advCount}</span>` : ""}</button>
        <div class="spacer"></div>
        <button class="btn btn-sm btn-ghost" id="resetF">Reset filters</button>
        <button class="btn btn-sm" id="expCsv">${icon("download")}CSV</button>
        <button class="btn btn-sm" id="expJson">${icon("download")}JSON</button>
        ${folder.supported ? `<button class="btn btn-sm btn-soft" id="syncDir">${icon("folder")}${S.dir ? "Sync to folder" : "Save to a folder"}</button>` : ""}
      </div>
      <div class="table-wrap"><table class="tbl"><thead><tr>
        <th>Date</th><th>Time</th><th>Source</th><th>Caller</th><th>Token</th><th>Type</th><th>Verdict</th><th>Risk</th><th>Risk score</th><th>Labels</th><th class="num">Alerts</th>
      </tr></thead><tbody id="rows"></tbody></table></div>
    </div>`;

  const paint = () => {
    LS.set("filters", F);
    const rows = applyFilters(F);
    $("#resCount").textContent = `${rows.length} call${rows.length === 1 ? "" : "s"}`;
    $("#resSub").textContent = `${rows.filter((r) => r.isFraud).length} fraud · ${S.calls.length} in history`;
    $("#rows").innerHTML = rows.length ? rows.slice(0, 500).map((c) => `<tr data-open="${c.id}">
      <td class="nowrap">${fmtDate(c.createdAt)}</td><td class="mono">${localTime(c.createdAt)}</td>
      <td>${channelChip(c)}</td><td>${callerIdOf(c) ? esc(callerIdOf(c)) : `<span class="faint">–</span>`}</td>
      <td class="mono nowrap">${esc(c.token)}</td><td>${catChip(c.category)}</td><td>${verdictBadge(c)}</td><td>${riskBadge(c.risk)}</td>
      <td style="min-width:120px">${scoreBar(c)}</td>
      <td>${(() => { const ls = c.labels;
        return ls.length ? `<div class="labels">${ls.slice(0, 2).map((l) => `<span class="chip chip-label">${esc(l)}</span>`).join("")}${ls.length > 2 ? `<span class="chip" title="${esc(ls.slice(2).join(", "))}">+${ls.length - 2}</span>` : ""}</div>` : `<span class="faint">–</span>`; })()}</td>
      <td class="num">${alertCount(c) || `<span class="faint">0</span>`}</td></tr>`).join("")
      : `<tr><td colspan="11"><div class="empty">${icon("clock")}<div>${S.calls.length ? "No calls match these filters." : "No calls yet."}</div>${S.calls.length ? "" : `<div class="row" style="justify-content:center;margin-top:12px"><a class="btn btn-primary btn-sm" href="#/analyze">${icon("wave")}Analyze your first call</a></div>`}</div></td></tr>`;
    $$("#rows [data-open]").forEach((tr) => tr.onclick = () => openDrawer(tr.dataset.open));
    return rows;
  };
  const bind = (id, key, ev = "input") => $(id).addEventListener(ev, (e) => { F[key] = e.target.value; paint(); });
  bind("#fq", "q"); bind("#ffrom", "from", "change"); bind("#fto", "to", "change"); bind("#ftf", "tFrom", "change"); bind("#ftt", "tTo", "change");
  bind("#fchannel", "channel", "change"); bind("#fsort", "sort", "change"); bind("#fverdict", "verdict", "change"); bind("#frisk", "risk", "change"); bind("#flabel", "label", "change"); bind("#falerts", "alerts", "change");
  $$("[data-type]", root).forEach((b) => b.onclick = () => { const t = b.dataset.type; F.types = F.types.includes(t) ? F.types.filter((x) => x !== t) : [...F.types, t]; b.classList.toggle("on"); paint(); });
  $$("[data-quick]", root).forEach((b) => b.onclick = () => {
    const v = b.dataset.quick; F.to = v === "all" ? "" : localDate(new Date());
    F.from = v === "all" ? "" : v === "today" ? localDate(new Date()) : localDate(daysAgo(+v - 1));
    $("#ffrom").value = F.from; $("#fto").value = F.to; paint();
  });
  $("#advToggle").onclick = () => { const b = $("#advBody"); b.hidden = !b.hidden; $("#advToggle").classList.toggle("btn-soft", !b.hidden); $("#advToggle").classList.toggle("btn-ghost", b.hidden); };
  $("#resetF").onclick = () => { S.filters = defaultFilters(); route(); };
  $("#expCsv").onclick = () => download(`callguard-history-${localDate(new Date())}.csv`, toCSV(paint()), "text/csv");
  $("#expJson").onclick = () => download(`callguard-history-${localDate(new Date())}.json`, JSON.stringify(paint(), null, 2), "application/json");
  const sd = $("#syncDir"); if (sd) sd.onclick = async () => { try { S.dir ? await folder.syncAll() : await folder.connect(); route(); } catch (e) { if (e.name !== "AbortError") toast(e.message, "alert"); } };
  paint();
};

/* ============================== drawer: call details ============================== */
async function openDrawer(id) {
  const rec = S.calls.find((c) => c.id === id); if (!rec) return;
  const dr = $("#drawer"), bd = $("#drawerBackdrop");
  let audioUrl = "";
  if (rec.hasAudio) { const b = await idb.getAudio(rec.id).catch(() => null); if (b) audioUrl = URL.createObjectURL(b); }
  const paint = () => {
    dr.innerHTML = `
      <div class="drawer-head"><div style="min-width:0"><div class="faint mono" style="font-size:12px">${esc(rec.token)}</div><h3>${rec.category} · ${esc(rec.categoryName)}</h3></div>
        <div class="spacer"></div><button class="icon-btn" id="drClose" aria-label="Close">${icon("x")}</button></div>
      <div class="drawer-body">
        <div class="verdict ${rec.isFraud ? "fraud" : "safe"}"><span class="v-icon">${icon(rec.isFraud ? "alert" : "shield")}</span>
          <div><div class="row">${verdictBadge(rec)}${riskBadge(rec.risk)}${rec.isBanking ? `<span class="chip">${icon("bank")}Banking</span>` : ""}${rec.reviewed ? `<span class="chip chip-cat safe">${icon("check")}Reviewed</span>` : ""}</div>
          <div class="muted" style="margin-top:8px">${esc(CATS[rec.category].advice)}</div></div></div>
        ${repeatBanner(rec)}
        <dl class="kv">
          <div><dt>Date</dt><dd>${fmtDate(rec.createdAt)}</dd></div><div><dt>Time</dt><dd>${localTime(rec.createdAt)}</dd></div>
          <div><dt>Risk score</dt><dd>${scoreBar(rec)}</dd></div><div><dt>Duration</dt><dd>${fmtDur(rec.duration)}</dd></div>
          <div><dt>Words / tokens</dt><dd>${rec.tokens ?? "–"}</dd></div><div><dt>Source of call</dt><dd>${esc(channelName(rec))}</dd></div>
          <div><dt>${esc(callerKindOf(rec))}</dt><dd>${esc(callerIdOf(rec) || "–")}</dd></div><div><dt>Classified by</dt><dd>${esc(rec.classifiedBy || rec.source || "–")}</dd></div>
          <div><dt>File</dt><dd title="${esc(rec.fileName)}">${esc(rec.fileName || "–")}</dd></div><div><dt>Language</dt><dd>${esc(rec.language || "–")}</dd></div>
        </dl>
        ${audioUrl ? `<audio controls src="${audioUrl}" style="width:100%"></audio>` : ""}
        <div class="card card-pad"><div class="lbl" style="margin-bottom:6px">Summary</div><div class="summary">${esc(rec.summary || "No summary returned.")}</div>
          <div class="lbl" style="margin:14px 0 6px">Transcript</div><div class="quote">${esc(speakerText(rec.transcript) || "No transcript.")}</div></div>
        <div class="card card-pad"><div class="lbl" style="margin-bottom:8px">Labels</div>
          <div class="row" style="gap:6px">${labelChips(rec)}</div>
          <div class="faint" style="font-size:12px;margin-top:8px">Labels come from the microservice.</div></div>
        <div class="card card-pad"><div class="lbl" style="margin-bottom:8px">Shared fraud-caller list</div>${sharedListRow(rec)}</div>
        <div class="card card-pad"><div class="row"><div class="lbl">Alerts</div><div class="spacer"></div>${rec.isFraud ? `<button class="btn btn-sm" id="reroute">Re-run routing</button>` : ""}</div>
          ${rec.notifications.length ? rec.notifications.map((n) => notifRow(n, rec)).join("") : `<div class="faint" style="margin-top:6px">No alerts for this call.</div>`}</div>
        <div class="card card-pad"><div class="lbl" style="margin-bottom:8px">Review</div>
          <div class="faint" style="font-size:12.5px;margin-bottom:10px">The category comes from your microservice and can't be changed here.</div>
          <div class="row"><button class="btn btn-soft" id="markReviewed">${icon("check")}${rec.reviewed ? "Mark unreviewed" : "Mark reviewed"}</button>
          <button class="btn btn-sm btn-ghost" id="dlJson">${icon("download")}Download JSON</button><div class="spacer"></div>
          <button class="btn btn-sm btn-ghost btn-danger" id="delCall">${icon("trash")}Delete</button></div></div>
      </div>`;
    $("#drClose").onclick = close;
    $("#markReviewed").onclick = async () => { rec.reviewed = !rec.reviewed; await saveRecord(rec); paint(); };
    bindSharedList(dr, paint);
    const rr = $("#reroute"); if (rr) rr.onclick = async () => {
      const plan = planAlerts(rec);
      if (!await modal({ title: "Re-run alert routing?", body: `This uses your current contacts and adds ${plan.length} alert${plan.length === 1 ? "" : "s"}:<br>${plan.map((n) => `· ${esc(n.role)} ${esc(n.to || n.reason || "")}`).join("<br>")}`, confirm: "Send", cancel: "Cancel" })) return;
      rec.notifications = [...rec.notifications, ...plan]; await dispatchAlerts(rec); await saveRecord(rec); paint(); refreshUnder();
    };
    $("#dlJson").onclick = () => download(`${rec.token}.json`, JSON.stringify(rec, null, 2), "application/json");
    $("#delCall").onclick = async () => {
      if (!await modal({ title: "Delete this call?", body: `Removes <b>${esc(rec.token)}</b> and its audio from this browser. This cannot be undone. Copies already saved to your history folder are kept.`, confirm: "Delete", danger: true })) return;
      await idb.del(rec.id); await idb.delAudio(rec.id).catch(() => {}); S.calls = S.calls.filter((c) => c.id !== rec.id);
      close(); paintChrome(); refreshUnder(); toast("Call deleted", "trash");
    };
    bindNotifActions(dr, paint);
  };
  const refreshUnder = () => { const v = (location.hash.match(/^#\/(\w+)/) || [])[1]; if (["history", "overview", "alerts"].includes(v)) VIEWS[v]($("#view")); };
  const close = () => { dr.classList.remove("open"); dr.setAttribute("aria-hidden", "true"); bd.hidden = true; if (audioUrl) URL.revokeObjectURL(audioUrl); document.removeEventListener("keydown", onKey); refreshUnder(); };
  const onKey = (e) => { if (e.key === "Escape" && $("#modal").hidden) close(); };
  paint();
  dr.classList.add("open"); dr.setAttribute("aria-hidden", "false"); bd.hidden = false; bd.onclick = close;
  document.addEventListener("keydown", onKey);
}

/* ============================== view: alerts ============================== */
VIEWS.alerts = (root) => {
  S.settings.alertsSeenAt = Date.now(); saveSettings();
  const all = S.calls.flatMap((c) => c.notifications.map((n) => ({ n, c }))).sort((a, b) => b.n.at.localeCompare(a.n.at));
  let fStatus = "all", fRole = "all";
  const counts = (st) => all.filter(({ n }) => st.includes(n.status)).length;
  root.innerHTML = `
    <p class="section-intro">Every alert CallGuard sent for a fraud call. Emails go out automatically from the CallGuard server to your nominee, your authorised people and, for banking fraud, your bank. If sending isn't available, they wait in the outbox: use <b>Send now</b> or open them in your mail app.</p>
    <div class="grid g-4" style="margin-bottom:18px">
      <div class="card kpi"><div class="k-label">Sent / delivered</div><div class="k-value">${counts(["sent", "delivered"])}</div></div>
      <div class="card kpi"><div class="k-label">In outbox</div><div class="k-value">${counts(["queued"])}</div></div>
      <div class="card kpi"><div class="k-label">Failed</div><div class="k-value">${counts(["failed"])}</div></div>
      <div class="card kpi"><div class="k-label">Not sent (missing contact)</div><div class="k-value">${counts(["skipped"])}</div></div>
    </div>
    <div class="card"><div class="card-head"><h3>Alert log</h3><div class="right">
      <select class="input" id="aRole" style="height:32px;width:auto">${["all", "Nominee", "Bank", "Authorised person", "Emergency contact"].map((r) => `<option value="${r}">${r === "all" ? "All recipients" : r}</option>`).join("")}</select>
      <select class="input" id="aStatus" style="height:32px;width:auto">${[["all", "Any status"], ["queued", "In outbox"], ["sent", "Sent"], ["delivered", "Delivered"], ["failed", "Failed"], ["skipped", "Not sent"]].map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>
    </div></div><div class="card-pad" id="aList" style="padding-top:8px"></div></div>`;
  const paint = () => {
    const rows = all.filter(({ n }) => (fStatus === "all" || n.status === fStatus) && (fRole === "all" || n.role === fRole));
    $("#aList").innerHTML = rows.length ? rows.slice(0, 300).map(({ n, c }) => `<div>
      <div class="row faint" style="font-size:12px;margin-top:12px"><span class="mono">${esc(c.token)}</span>·<span>${fmtDT(n.at)}</span>·<a href="#" data-open="${c.id}">${c.category} · ${esc(c.categoryName)}</a></div>
      ${notifRow(n, c)}</div>`).join("") : `<div class="empty">${icon("bell")}<div>No alerts match.</div></div>`;
    $$("[data-open]", root).forEach((a) => a.onclick = (e) => { e.preventDefault(); openDrawer(a.dataset.open); });
    bindNotifActions(root, () => VIEWS.alerts(root));
  };
  $("#aRole").onchange = (e) => { fRole = e.target.value; paint(); };
  $("#aStatus").onchange = (e) => { fStatus = e.target.value; paint(); };
  paint();
};

/* ============================== view: contacts ============================== */
VIEWS.contacts = (root) => {
  const C = S.contacts;
  const inp = (path, label, type = "text", ph = "", dis = false) => {
    const [a, b] = path.split(".");
    return `<div class="field"><label for="c-${a}-${b}">${label}</label><input class="input" id="c-${a}-${b}" data-path="${path}" type="${type}" placeholder="${esc(ph)}" value="${esc(C[a][b])}" ${dis ? "disabled" : ""}></div>`;
  };
  const nomineeReady = !!(C.nominee.name || C.nominee.email);
  root.innerHTML = `
    <p class="section-intro">Tell CallGuard who to warn. Every fraud is emailed to your nominee, your authorised people and your emergency contact. Banking fraud is also emailed to the bank your nominee adds.</p>
    <div class="grid g-2">
      <div class="card contact-card"><div class="c-head"><span class="c-icon">${icon("users")}</span><div><h3>You (account holder)</h3><div class="faint" style="font-size:12.5px">Shown in alerts so people know whose call it was</div></div></div>
        <div class="form-grid">${inp("user.name", "Full name", "text", "Your name")}${inp("user.email", "Email", "email", "you@example.com")}${inp("user.phone", "Phone", "tel", "+1 …")}</div></div>
      <div class="card contact-card"><div class="c-head"><span class="c-icon lav">${icon("users")}</span><div><h3>Nominee</h3><div class="faint" style="font-size:12.5px">Always gets a notification + email for every fraud. Email required</div></div></div>
        <div class="form-grid">${inp("nominee.name", "Name", "text", "e.g. Priya Sharma")}${inp("nominee.relation", "Relation", "text", "Daughter, spouse…")}${inp("nominee.email", "Email (required)", "email", "nominee@example.com")}${inp("nominee.phone", "Phone", "tel", "+1 …")}</div></div>
      <div class="card contact-card"><div class="c-head"><span class="c-icon sand">${icon("bank")}</span><div><h3>Bank fraud desk</h3><div class="faint" style="font-size:12.5px">Added by the nominee · emailed for banking fraud (F1, F2)</div></div></div>
        ${!nomineeReady ? `<div class="banner warn" style="margin-bottom:12px">${icon("alert")}<div>Add a nominee first. The nominee adds the bank.</div></div>` : ""}
        <div class="form-grid">${inp("bank.name", "Bank name", "text", "e.g. Chase", !nomineeReady)}${inp("bank.email", "Fraud-desk email", "email", "fraud@bank.com", !nomineeReady)}${inp("bank.branch", "Branch / notes", "text", "Optional", !nomineeReady)}
          <div class="field"><label>Added by</label><input class="input" disabled value="${esc(C.bank.addedBy || (nomineeReady ? C.nominee.name || C.nominee.email : "–"))}"></div></div>
        <div class="faint" style="font-size:12px;margin-top:10px">Never store account numbers here. The alert only carries the call summary and token.</div></div>
      <div class="card contact-card"><div class="c-head"><span class="c-icon rose">${icon("alert")}</span><div><h3>Emergency contact</h3><div class="faint" style="font-size:12.5px">Emailed for every fraud call</div></div></div>
        <div class="form-grid">${inp("emergency.name", "Name", "text", "e.g. Rahul")}${inp("emergency.email", "Email", "email", "emergency@example.com")}${inp("emergency.phone", "Phone", "tel", "+1 …")}</div>
        <div class="row" style="margin-top:12px;gap:8px">${isEmail(C.emergency.email) ? `<span class="status good">${icon("check")}Saved: ${esc(C.emergency.email)}</span>` : `<span class="faint" style="font-size:12.5px">Not saved yet</span>`}<div class="spacer"></div>
          <button class="btn btn-sm btn-ghost btn-danger" id="emDelete" ${C.emergency.name || C.emergency.email || C.emergency.phone ? "" : "disabled"}>${icon("trash")}Delete</button>
          <button class="btn btn-sm btn-primary" id="emSave">${icon("check")}Save</button></div></div>
    </div>
    <div class="card contact-card" style="margin-top:18px"><div class="c-head"><span class="c-icon">${icon("shield")}</span><div><h3>Authorised people</h3><div class="faint" style="font-size:12.5px">Emailed for every fraud call, whatever the type</div></div></div>
      <div class="grid g-3" id="authList">${C.authorised.map((a) => `<div class="person"><span class="avatar">${esc(initials(a.name || a.email))}</span><div style="min-width:0;flex:1"><div style="font-weight:620">${esc(a.name || "–")}${a.relation ? ` <span class="faint">· ${esc(a.relation)}</span>` : ""}</div><div class="faint" style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis">${esc(a.email)}</div></div><button class="icon-btn" data-rm="${a.id}" aria-label="Remove">${icon("x")}</button></div>`).join("") || `<div class="faint">None yet. Until you add one, the emergency contact is used.</div>`}</div>
      <form class="form-grid" id="authForm" style="margin-top:14px;grid-template-columns:1fr 1fr 1fr auto;align-items:end">
        <div class="field"><label for="aName">Name</label><input class="input" id="aName" required></div>
        <div class="field"><label for="aEmail">Email</label><input class="input" id="aEmail" type="email" required></div>
        <div class="field"><label for="aRel">Relation</label><input class="input" id="aRel" placeholder="Optional"></div>
        <button class="btn btn-primary">${icon("plus")}Add</button></form></div>
    <div class="card" style="margin-top:18px"><div class="card-head"><h3>Routing preview</h3><div class="right"><button class="btn btn-sm" id="previewBtn">Preview a test alert</button></div></div>
      <div class="card-pad" style="padding-top:12px">${routingSummary()}</div></div>`;

  /* Emergency contact: saved with its own Save button (auto-saving on blur would re-render the card
     and swallow the click on Save). Other cards save as soon as a field changes. */
  $$("[data-path]", root).forEach((el) => el.dataset.path.startsWith("emergency.") ? el.addEventListener("input", () => {
    const hint = $("#emSave", root); if (hint) hint.textContent = "Save changes";
  }) : el.addEventListener("change", () => {
    const [a, b] = el.dataset.path.split(".");
    const v = el.value.trim();
    if (el.type === "email" && v && !isEmail(v)) { toast("That email address doesn't look right", "alert"); el.focus(); return; }
    C[a][b] = v;
    if (a === "nominee" && C.bank.email) C.bank.addedBy = C.nominee.name || C.nominee.email;
    if (a === "bank") C.bank.addedBy = C.nominee.name || C.nominee.email;
    saveContacts(); toast("Saved"); VIEWS.contacts(root);
  }));
  $("#emSave").onclick = () => {
    const val = (b) => ($(`[data-path="emergency.${b}"]`, root)?.value || "").trim();
    const e = { name: val("name"), email: val("email").toLowerCase(), phone: val("phone") };
    if (!isEmail(e.email)) { toast("Enter a valid email for the emergency contact", "alert"); $(`[data-path="emergency.email"]`, root)?.focus(); return; }
    C.emergency = e; saveContacts(); toast(`Emergency contact saved: ${e.email}`); VIEWS.contacts(root);
  };
  $("#emDelete").onclick = async () => {
    if (!await modal({ title: "Delete the emergency contact?", body: `${esc(C.emergency.name || C.emergency.email || "This contact")} will no longer be emailed about fraud calls.`, confirm: "Delete", cancel: "Keep" })) return;
    C.emergency = { name: "", email: "", phone: "" }; saveContacts(); toast("Emergency contact deleted"); VIEWS.contacts(root);
  };
  $("#authForm").onsubmit = (e) => {
    e.preventDefault();
    const email = $("#aEmail").value.trim();
    if (!isEmail(email)) return toast("Enter a valid email", "alert");
    C.authorised.push({ id: uid(), name: $("#aName").value.trim(), email, relation: $("#aRel").value.trim() });
    saveContacts(); toast("Authorised person added"); VIEWS.contacts(root);
  };
  $$("[data-rm]", root).forEach((b) => b.onclick = () => { C.authorised = C.authorised.filter((a) => a.id !== b.dataset.rm); saveContacts(); VIEWS.contacts(root); });
  $("#previewBtn").onclick = () => {
    const mk = (code) => { const r = { category: code, categoryName: CATS[code].name, isFraud: true, isBanking: CATS[code].banking, risk: CATS[code].risk, token: "CG-TEST", createdAt: new Date().toISOString(), summary: "Test", confidence: 0.9 }; return planAlerts(r); };
    const fmt = (list) => list.map((n) => `<div class="row" style="margin:4px 0">${notifStatus(n.status === "pending" ? { status: "queued" } : n)} <b>${esc(n.role)}</b> <span class="faint">${esc(n.channel === "in-app" ? "app notification" : n.to || n.reason)}</span></div>`).join("");
    modal({ title: "Who would be alerted", body: `<div style="margin-top:6px"><b>Banking fraud (F1)</b>${fmt(mk("F1"))}</div><div style="margin-top:12px"><b>Other fraud (F3)</b>${fmt(mk("F3"))}</div><div class="faint" style="margin-top:10px">Nothing is sent from this preview.</div>`, confirm: "Close", cancel: "" });
  };
};

/* ============================== view: plans ============================== */
VIEWS.plans = (root) => {
  const used = monthUsage(), plan = currentPlan();
  root.innerHTML = `
    <p class="section-intro">CallGuard is sold as a service: pick a plan per workspace. Usage counts the calls analysed this month.</p>
    <div class="card card-pad" style="margin-bottom:18px"><div class="row"><div><div class="lbl">This month</div><div style="font-size:24px;font-weight:700">${used.toLocaleString()} <span class="faint" style="font-size:15px;font-weight:500">of ${plan.calls.toLocaleString()} calls</span></div></div><div class="spacer"></div><span class="chip chip-cat">${esc(plan.name)} plan</span></div>
      <div class="meter" style="height:10px"><span style="width:${Math.min(100, (used / plan.calls) * 100)}%"></span></div></div>
    <div class="grid g-3">${D.plans.map((p) => `<div class="card plan ${p.id === plan.id ? "current" : ""}">
      ${p.id === plan.id ? `<span class="chip chip-cat safe ribbon">${icon("check")}Current</span>` : p.id === "pro" ? `<span class="chip chip-user ribbon">Most popular</span>` : ""}
      <h3>${esc(p.name)}</h3><div class="tagline">${esc(p.tagline)}</div>
      <div class="price">$${p.price}<small> / month</small></div>
      <ul>${p.features.map((f) => `<li>${icon("check")}${esc(f)}</li>`).join("")}</ul>
      <div class="spacer"></div>
      <button class="btn ${p.id === plan.id ? "" : "btn-primary"}" data-plan="${p.id}" ${p.id === plan.id ? "disabled" : ""}>${p.id === plan.id ? "Your plan" : `Switch to ${esc(p.name)}`}</button></div>`).join("")}</div>
    <div class="faint" style="margin-top:14px;font-size:12.5px">Billing is not connected in this build: switching only changes the plan limits shown in the dashboard.</div>`;
  $$("[data-plan]", root).forEach((b) => b.onclick = () => { S.settings.plan = b.dataset.plan; saveSettings(); toast(`Switched to ${currentPlan().name}`); VIEWS.plans(root); });
};

/* ============================== view: settings ============================== */
VIEWS.settings = (root) => {
  const st = S.settings;
  root.innerHTML = `
    <div class="grid g-2">
      <div class="card card-pad stack">
        <div><h3>Microservice</h3><div class="faint" style="font-size:12.5px;margin-top:2px">Every call is sent here with your API token. The service checks the token, and the fraud category and labels come from its response.</div></div>
        <div class="field"><label for="sTr">Microservice URL</label><input class="input" id="sTr" data-k="transcriberUrl" placeholder="https://your-host/v1/audio/transcribe" value="${esc(st.transcriberUrl)}">
          <span class="hint">POST multipart <span class="mono">${esc(CFG.audioField)}</span> (one field only), header <span class="mono">Authorization: Bearer &lt;token&gt;</span>.</span></div>
        ${cloud.on ? `<div class="banner">${icon("shield")}<div>You're verified by your sign-in: every call carries your personal token, and the microservice checks it.</div></div>` : `<div class="field"><label for="sKey">API token</label><input class="input" id="sKey" type="password" data-k="apiKey" value="${esc(st.apiKey)}" autocomplete="off" spellcheck="false" placeholder="Paste the token issued by the service">
          <span class="hint">Required. Saved only in this browser, for your account. It's sent only to the microservice and never included in backups.</span></div>`}
        <div class="field"><label for="sNo">Notifier URL (optional, overrides the built-in email sender)</label><input class="input" id="sNo" data-k="notifierUrl" placeholder="${esc(window.CG_CONFIG?.notifyUrl || "https://your-host/notify")}" value="${esc(st.notifierUrl)}">
          <span class="hint">POST JSON <span class="mono">{to, role, channel, subject, body, call_token, category}</span> per alert. Without it, emails go to the outbox.</span></div>
        <div class="form-grid">
          <div class="field"><label for="sTo">Timeout (seconds)</label><input class="input" id="sTo" type="number" min="10" max="900" data-k="timeoutSec" value="${esc(st.timeoutSec)}"></div>
        </div>
        <div class="row"><button class="btn" id="testConn">Test connection &amp; token</button><span class="faint" id="testOut" style="font-size:12.5px"></span></div>
      </div>
      <div class="stack">
        <div class="card card-pad stack">
          <div class="row"><span class="avatar" style="width:40px;height:40px">${esc(initials(S.user.name))}</span>
            <div><h3>${esc(S.user.name)}</h3><div class="faint" style="font-size:12.5px">@${esc(S.user.id)}${S.user.email ? ` · ${esc(S.user.email)}` : ""} · member since ${fmtDate(S.user.createdAt)}</div></div>
            <div class="spacer"></div><button class="btn btn-sm" id="logout2">${icon("logout")}Log out</button></div>
          ${S.user.googleSub ? `<div class="row faint" style="font-size:12.5px">${GOOGLE_G} Signed in with Google${S.user.hash ? " · password also set" : ""}</div>` : ""}
          ${cloud.on ? `<div class="row faint" style="font-size:12.5px">${icon("shield")} Account stored securely on the CallGuard server · works on any device · you're verified automatically on every call</div>` : ""}
          <form class="form-grid" id="pwForm" style="grid-template-columns:${S.user.hash ? "1fr 1fr auto" : "1fr auto"};align-items:end">
            ${S.user.hash ? `<div class="field"><label for="pwCur">Current password</label><input class="input" id="pwCur" type="password" autocomplete="current-password" required></div>` : ""}
            <div class="field"><label for="pwNew">${S.user.hash || cloud.on ? "New password" : "Set a password (to also log in with your user ID)"}</label><input class="input" id="pwNew" type="password" autocomplete="new-password" required></div>
            <button class="btn">${S.user.hash ? "Change password" : "Set password"}</button></form>
        </div>
        <div class="card card-pad stack">
          <h3>Workspace</h3>
          <div class="field"><label for="sWs">Workspace name</label><input class="input" id="sWs" data-k="workspace" value="${esc(st.workspace)}"></div>
          <label class="row" style="cursor:pointer"><input type="checkbox" id="sNotif" ${st.browserNotify ? "checked" : ""}> <span>Show a browser notification on this device when fraud is detected</span></label>
        </div>
        <div class="card card-pad stack">
          <div><h3>History folder</h3><div class="faint" style="font-size:12.5px;margin-top:2px">Every call is kept in this browser. You can also mirror it to a folder on your computer:
            <span class="mono">CallGuard-History/&lt;date&gt;/&lt;time_type_token&gt;/</span> with call.json, summary.txt, transcript.txt, the audio, and an index.csv.</div></div>
          ${folder.supported ? `<div class="row"><button class="btn btn-soft" id="pickDir">${icon("folder")}${S.dir ? "Change folder" : "Choose folder"}</button>
            ${S.dir ? `<button class="btn" id="syncNow">Sync now</button><span class="faint">${esc(S.dir.name)}</span>` : ""}</div>`
            : `<div class="banner warn">${icon("alert")}<div>Your browser can't write to folders (Chrome and Edge can). Use CSV / JSON export in Call history instead.</div></div>`}
        </div>
        <div class="card card-pad stack">
          <h3>Data</h3>
          <div class="row"><button class="btn" id="backup">${icon("download")}Backup (JSON)</button>
            <label class="btn">Restore<input type="file" id="restore" accept="application/json" hidden></label></div>
          <div class="row"><button class="btn btn-ghost btn-danger" id="wipe">${icon("trash")}Delete all data</button></div>
        </div>
      </div>
    </div>`;

  $("#logout2").onclick = () => auth.logout();
  $("#pwForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      if (cloud.on) { await cloud.changePassword($("#pwNew").value, $("#pwCur")?.value || ""); toast("Password saved"); VIEWS.settings(root); return; }
      await auth.changePassword(S.user.id, $("#pwCur")?.value || "", $("#pwNew").value); S.user = auth.users()[S.user.id]; toast("Password saved"); VIEWS.settings(root);
    }
    catch (ex) { toast(ex.message, "alert"); }
  };
  $$("[data-k]", root).forEach((el) => el.addEventListener("change", () => {
    const k = el.dataset.k; let v = el.value.trim();
    if (k.endsWith("Url") && v && !/^https?:\/\//i.test(v)) { toast("URLs must start with http:// or https://", "alert"); return; }
    if (k === "timeoutSec") v = Math.max(10, Math.min(900, +v || 120));
    st[k] = v; saveSettings(); toast("Saved"); if (k === "transcriberUrl") VIEWS.settings(root);
  }));
  $("#sNotif").onchange = async (e) => {
    if (e.target.checked && "Notification" in window && Notification.permission !== "granted") {
      const p = await Notification.requestPermission(); if (p !== "granted") { e.target.checked = false; toast("Notifications were blocked", "alert"); return; }
    }
    st.browserNotify = e.target.checked; saveSettings();
  };
  $("#testConn").onclick = async () => {
    const out = $("#testOut");
    const say = (ok, m) => { out.innerHTML = `<span class="status ${ok ? "good" : "critical"}">${icon(ok ? "check" : "alert")}${esc(m)}</span>`; };
    if (!st.transcriberUrl) return say(false, "Set the microservice URL first.");
    out.innerHTML = `<span class="row"><span class="spin"></span>Checking… (a sleeping service can take a minute to wake)</span>`;
    const { origin, health, status } = svcUrls(st.transcriberUrl);
    // 1) is it running?
    let reachable = false;
    try { await fetch(health, { mode: "no-cors", cache: "no-store" }); reachable = true; } catch { reachable = false; }
    if (!reachable) return say(false, `Can't reach ${origin}. It may be down or the URL is wrong.`);
    // 2) does it let this website call it?
    try { await fetch(health, { cache: "no-store" }); }
    catch { return say(false, `Service is running, but it blocks requests from ${location.origin} (CORS). Its owner must allow this origin.`); }
    // 3) is the token accepted? (an authenticated GET; 401 = bad token)
    if (cloud.on) { if (!(await cloud.fresh())) return say(false, "Your sign-in expired. Log in again."); }
    else if (!String(st.apiKey || "").trim()) return say(false, "Service reachable. Now paste your API token.");
    try {
      const r = await fetch(status, { headers: authHeaders(), cache: "no-store" });
      if (r.status === 401 || r.status === 403) return say(false, cloud.on ? "Service reachable, but it didn't accept your sign-in (is SUPABASE_URL set on the service?)." : "Service reachable, but it rejected your API token.");
      if (r.status === 503) return say(false, "Service reachable, but it couldn't check your sign-in right now (503).");
      let j = {}; try { j = await r.json(); } catch { /* not JSON */ }
      if (r.ok && j.classifier_configured === false) return say(false, "Token accepted, but the service's classifier is not configured yet, so calls can't be classified.");
      if (r.ok && j.model_ready === false) return say(false, "Token accepted, but the speech model is still loading. Try again in a minute.");
      return say(true, r.ok ? `Connected. ${cloud.on ? "Your sign-in was verified." : "Token accepted."}${j.max_audio_seconds ? ` Max audio ${j.max_audio_seconds}s.` : ""}` : `Connected (HTTP ${r.status}). Token not rejected.`);
    } catch { return say(false, "Service reachable, but the token check was blocked (CORS on authenticated requests)."); }
  };
  const pd = $("#pickDir"); if (pd) pd.onclick = async () => { try { await folder.connect(); VIEWS.settings(root); } catch (e) { if (e.name !== "AbortError") toast(e.message, "alert"); } };
  const sn = $("#syncNow"); if (sn) sn.onclick = async () => { try { await folder.syncAll(); } catch (e) { toast(e.message, "alert"); } };
  $("#backup").onclick = () => download(`callguard-backup-${localDate(new Date())}.json`, JSON.stringify({ version: 1, settings: { ...st, apiKey: "" }, contacts: S.contacts, calls: S.calls }, null, 2), "application/json");
  $("#restore").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.calls)) throw new Error("Not a CallGuard backup");
      for (const c of data.calls) { c.hasAudio = false; await idb.put(c); }
      if (data.contacts) { S.contacts = { ...DEFAULT_CONTACTS, ...data.contacts }; saveContacts(); }
      S.calls = (await idb.all()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      paintChrome(); toast(`Restored ${data.calls.length} calls`);
    } catch (err) { toast("Restore failed: " + err.message, "alert"); }
  };
  $("#wipe").onclick = async () => {
    if (!await modal({ title: "Delete all CallGuard data?", body: `This removes all <b>${S.calls.length}</b> calls, audio, contacts and settings from this browser. It cannot be undone. Files in your history folder are not touched.`, confirm: "Delete everything", danger: true })) return;
    await idb.clear(); try { Object.keys(localStorage).filter((k) => k.startsWith(`cg.u.${NS}.`)).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
    location.reload();
  };
};

/* ============================== accounts: sign up + log in ==============================
   No server: accounts live in this browser. Passwords are never stored, only a salted
   PBKDF2-SHA-256 hash (210,000 rounds). Each user gets their own database and settings. */
const auth = {
  users() { return GLS.get("users", {}); },
  saveUsers(u) { GLS.set("users", u); },
  b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); },
  async hash(password, saltB64, iter = 210000) {
    const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    return this.b64(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
  },
  same(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; },
  find(login) {
    const u = this.users(), l = String(login || "").trim().toLowerCase();
    if (u[l]) return u[l];
    return Object.values(u).find((x) => x.email && x.email.toLowerCase() === l) || null;
  },
  passwordProblem(p) {
    if (p.length < 8) return "Password must be at least 8 characters.";
    if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return "Use at least one letter and one number.";
    return "";
  },
  /** A free user ID made from the email's local part, e.g. sumit.saurabh@x.com -> sumit.saurabh (or sumit.saurabh2). */
  idFromEmail(email) {
    const users = this.users();
    let base = String(email).split("@")[0].toLowerCase().replace(/[^a-z0-9_.]/g, "").slice(0, 16);
    if (base.length < 3) base = (base + "user").slice(0, 16);
    let id = base, n = 2;
    while (users[id]) id = `${base}${n++}`;
    return id;
  },
  async signup({ name, email, id, password }) {
    email = String(email || "").trim();
    id = String(id || "").trim().toLowerCase();
    if (!name.trim()) throw new Error("Enter your full name.");
    if (!/^[a-z0-9_.]{3,20}$/.test(id)) throw new Error("User ID: 3–20 characters, letters, numbers, dot or underscore.");
    if (!isEmail(email)) throw new Error("Enter a valid email address.");
    const pp = this.passwordProblem(password); if (pp) throw new Error(pp);
    const users = this.users();
    if (users[id]) throw new Error("That user ID is taken. Try another.");
    if (email && Object.values(users).some((x) => x.email && x.email.toLowerCase() === email.toLowerCase())) throw new Error("An account with this email already exists. Log in instead.");
    const salt = this.b64(crypto.getRandomValues(new Uint8Array(16)));
    users[id] = { id, name: name.trim(), email, method: "userid", salt, iter: 210000, hash: await this.hash(password, salt), createdAt: new Date().toISOString() };
    this.saveUsers(users);
    return users[id];
  },
  async login(login, password) {
    const u = this.find(login);
    if (u && !u.hash) throw new Error("This account uses Google. Tap \"Continue with Google\" above (or set a password in Settings after signing in).");
    // same work whether or not the user exists, so the response time doesn't reveal valid IDs
    const h = await this.hash(password, u ? u.salt : "AAAAAAAAAAAAAAAAAAAAAA==", u ? u.iter : 210000);
    if (!u || !this.same(h, u.hash)) throw new Error("User ID / email or password is incorrect.");
    const users = this.users(); users[u.id].lastLogin = new Date().toISOString(); this.saveUsers(users);
    return u;
  },
  async changePassword(id, current, next) {
    const users = this.users(), u = users[id];
    if (u.hash && !this.same(await this.hash(current, u.salt, u.iter), u.hash)) throw new Error("Current password is incorrect.");
    const pp = this.passwordProblem(next); if (pp) throw new Error(pp);
    u.salt = this.b64(crypto.getRandomValues(new Uint8Array(16))); u.iter = 210000; u.hash = await this.hash(next, u.salt);
    this.saveUsers(users);
  },
  startSession(u, remember) {
    const s = JSON.stringify({ id: u.id, at: Date.now() });
    try { (remember ? localStorage : sessionStorage).setItem("cg.session", s); } catch { /* ignore */ }
  },
  currentSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem("cg.session") || localStorage.getItem("cg.session") || "null");
      if (!s) return null;
      if (Date.now() - s.at > 30 * 24 * 3600 * 1000) { GLS.del("session"); return null; }   // 30-day max
      return this.users()[s.id] || null;
    } catch { return null; }
  },
  async logout() { try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* ignore */ } if (cloud.on) await cloud.logout(); GLS.del("session"); location.hash = ""; location.reload(); },
};

/* ============================== cloud accounts (Supabase Auth) ==============================
   When CG_CONFIG.supabaseUrl + supabaseAnonKey are set, accounts live on the sign-in server
   (passwords hashed there, usable from any device). Login returns a short-lived personal access
   token; every microservice call carries it and the microservice verifies it with Supabase. */
const supa = {
  url: String(CFG.supabaseUrl || "").replace(/\/+$/, ""), key: CFG.supabaseAnonKey || "",
  get on() { return !!(this.url && this.key); },
  s: null,                                   // {access_token, refresh_token, expires_at, user}
  async req(path, body, { method = "POST", token } = {}) {
    let r;
    try {
      r = await fetch(this.url + path, { method, headers: { apikey: this.key, "Content-Type": "application/json",
        Authorization: `Bearer ${token || this.key}` }, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new Error("Can't reach the sign-in server. Check your connection and try again."); }
    const text = await r.text(); let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!r.ok) {
      const m = String(j.msg || j.error_description || j.message || j.error || `HTTP ${r.status}`);
      if (/invalid login credentials/i.test(m)) throw new Error("User ID / email or password is incorrect.");
      if (/email not confirmed/i.test(m)) throw new Error("Confirm your email first: open the link we sent you, then log in.");
      if (/already registered|already exists/i.test(m)) throw new Error("An account with this email already exists. Log in instead.");
      if (/database error saving new user/i.test(m)) throw new Error("That user ID is taken. Try another.");
      if (/rate limit/i.test(m)) throw new Error("Too many attempts. Wait a minute and try again.");
      throw new Error(m);
    }
    return j;
  },
  store(sess, remember) {
    this.s = sess;
    const v = JSON.stringify(sess);
    try { sessionStorage.removeItem("cg.cloud"); localStorage.removeItem("cg.cloud"); (remember ? localStorage : sessionStorage).setItem("cg.cloud", v); } catch { /* ignore */ }
  },
  load() { try { return JSON.parse(sessionStorage.getItem("cg.cloud") || localStorage.getItem("cg.cloud") || "null"); } catch { return null; } },
  remembered() { try { return !!localStorage.getItem("cg.cloud"); } catch { return false; } },
  fromGoTrue(j, remember) {
    if (!j.access_token) return null;
    const sess = { access_token: j.access_token, refresh_token: j.refresh_token,
      expires_at: j.expires_at ? j.expires_at * 1000 : Date.now() + (j.expires_in || 3600) * 1000, user: j.user };
    this.store(sess, remember); return sess;
  },
  token() { return this.s && this.s.access_token; },
  /** Make sure the access token is valid for at least 2 more minutes (refreshes it if needed). */
  async fresh() {
    if (!this.s) return false;
    if (this.s.expires_at - Date.now() > 120000) return true;
    try { this.fromGoTrue(await this.req("/auth/v1/token?grant_type=refresh_token", { refresh_token: this.s.refresh_token }), this.remembered()); return true; }
    catch { return false; }
  },
  user() {
    const u = this.s.user || {}, m = u.user_metadata || {}, email = u.email || "";
    return { id: (m.user_id || email.split("@")[0] || "user").toLowerCase(), ns: "sb_" + u.id, name: m.name || m.full_name || email.split("@")[0],
      email, picture: m.avatar_url || m.picture || "", createdAt: u.created_at || new Date().toISOString(), cloud: true,
      googleSub: (u.app_metadata || {}).provider === "google" ? (m.sub || "google") : "" };
  },
  async signup({ name, email, id, password }) {
    email = String(email || "").trim(); id = String(id || "").trim().toLowerCase();
    if (!name.trim()) throw new Error("Enter your full name.");
    if (!/^[a-z0-9_.]{3,20}$/.test(id)) throw new Error("User ID: 3–20 characters, letters, numbers, dot or underscore.");
    if (!isEmail(email)) throw new Error("Enter a valid email address.");
    const pp = auth.passwordProblem(password); if (pp) throw new Error(pp);
    if (await this.req("/rest/v1/rpc/user_id_taken", { uid: id })) throw new Error("That user ID is taken. Try another.");
    const j = await this.req("/auth/v1/signup", { email, password, data: { name: name.trim(), user_id: id } });
    return { id, email, session: this.fromGoTrue(j, true) };   // no session => email confirmation required
  },
  async login(login, password, remember) {
    let email = String(login || "").trim();
    if (!email.includes("@")) {
      email = await this.req("/rest/v1/rpc/email_for_user_id", { uid: email.toLowerCase() });
      if (!email) { await sleep(400); throw new Error("User ID / email or password is incorrect."); }
    }
    this.fromGoTrue(await this.req("/auth/v1/token?grant_type=password", { email, password }), remember);
    return this.user();
  },
  async google(idToken) {
    this.fromGoTrue(await this.req("/auth/v1/token?grant_type=id_token", { provider: "google", id_token: idToken }), true);
    const u = this.user(); u._new = Date.now() - Date.parse(u.createdAt) < 60000; return u;
  },
  async changePassword(next, _current) {
    const pp = auth.passwordProblem(next); if (pp) throw new Error(pp);
    if (!(await this.fresh())) throw new Error("Your sign-in expired. Log in again.");
    await this.req("/auth/v1/user", { password: next }, { method: "PUT", token: this.token() });
  },
  async restore() {
    this.s = this.load();
    if (!this.s) return null;
    if (!(await this.fresh())) { this.store(null, false); try { sessionStorage.removeItem("cg.cloud"); localStorage.removeItem("cg.cloud"); } catch { /* ignore */ } return null; }
    return this.user();
  },
  async logout() {
    try { if (this.s) await this.req("/auth/v1/logout", null, { token: this.token() }); } catch { /* still log out locally */ }
    try { sessionStorage.removeItem("cg.cloud"); localStorage.removeItem("cg.cloud"); } catch { /* ignore */ }
  },
};

/* ============================== server accounts (the transcription service) ==============================
   When CG_CONFIG.accountsUrl is set: sign up / log in with user ID + password against that server.
   It stores the account (scrypt-hashed password) and returns a signed session token that is sent
   automatically with every call. No token to copy or paste. */
const srv = {
  url: String(CFG.accountsUrl || "").replace(/\/+$/, ""),
  get on() { return !!this.url; },
  s: null,                                   // {token, expires_at (ms), user}
  async req(path, body, token) {
    let r;
    try {
      r = await fetch(this.url + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body || {}) });
    } catch { throw new Error("Can't reach the sign-in server. Check your connection and try again (it may take a minute to wake up)."); }
    let j = {}; try { j = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) { const e = new Error(j.detail || `Sign-in server error (HTTP ${r.status}).`); e.status = r.status; throw e; }
    return j;
  },
  store(sess, remember) {
    this.s = sess;
    try { sessionStorage.removeItem("cg.srv"); localStorage.removeItem("cg.srv"); if (sess) (remember ? localStorage : sessionStorage).setItem("cg.srv", JSON.stringify(sess)); } catch { /* ignore */ }
  },
  remembered() { try { return !!localStorage.getItem("cg.srv"); } catch { return false; } },
  token() { return this.s && this.s.token; },
  async fresh() { return !!(this.s && this.s.expires_at - Date.now() > 120000); },
  user() {
    const u = this.s.user;
    return { id: u.id, ns: u.id, name: u.name, email: u.email, createdAt: u.created_at, cloud: true, hash: true };
  },
  async signup({ name, email, id, password }) {
    const pp = auth.passwordProblem(password); if (pp) throw new Error(pp);
    const j = await this.req("/v1/auth/signup", { name, user_id: id, email, password });
    return { id: j.user.id, email: j.user.email, session: true };    // no email confirmation step
  },
  async login(login, password, remember) {
    try {
      const j = await this.req("/v1/auth/login", { login, password });
      this.store({ token: j.token, expires_at: j.expires_at * 1000, user: j.user }, remember);
      return this.user();
    } catch (e) {
      if (e.status === 401 && auth.find(login)) throw new Error("Accounts now live on the CallGuard server, so log-ins work on any device. Please sign up once more. Use the same user ID to keep this browser's call history.");
      throw e;
    }
  },
  async google() { throw new Error("Google sign-in isn't switched on yet. Use your user ID and password."); },
  async changePassword(next, current) {
    const pp = auth.passwordProblem(next); if (pp) throw new Error(pp);
    const j = await this.req("/v1/auth/password", { current, new: next }, this.token());
    this.store({ ...this.s, token: j.token, expires_at: j.expires_at * 1000 }, this.remembered());
  },
  async restore() {
    try { this.s = JSON.parse(sessionStorage.getItem("cg.srv") || localStorage.getItem("cg.srv") || "null"); } catch { this.s = null; }
    if (!this.s || !(await this.fresh())) { this.store(null, false); return null; }
    return this.user();
  },
  async logout() {
    try { if (this.s) await this.req("/v1/auth/logout", {}, this.token()); } catch { /* still log out here */ }
    this.store(null, false);
  },
};
// Which account system is active: Supabase if configured, else the CallGuard server, else this browser only.
const cloud = supa.on ? supa : srv;

/* ---------- Google sign-in: uses the Google account already signed in on the device ---------- */
const google = {
  clientId: (window.CG_CONFIG && window.CG_CONFIG.googleClientId) || "",
  loading: null,
  load() {
    if (window.google?.accounts?.id) return Promise.resolve();
    return this.loading || (this.loading = new Promise((res, rej) => {
      const sc = document.createElement("script");
      sc.src = "https://accounts.google.com/gsi/client"; sc.async = true; sc.defer = true;
      sc.onload = () => res(); sc.onerror = () => rej(new Error("Could not reach Google. Check your connection."));
      document.head.appendChild(sc);
    }));
  },
  decode(jwt) {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(atob(part).split("").map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join(""));
    return JSON.parse(json);
  },
  /** Turn Google's ID token into a CallGuard account (create on first use, link by email if one exists). */
  accountFrom(credential) {
    const t = this.decode(credential);
    if (t.aud !== this.clientId) throw new Error("Google sign-in was issued for a different app.");
    if (!["accounts.google.com", "https://accounts.google.com"].includes(t.iss)) throw new Error("Unexpected sign-in issuer.");
    if (!t.exp || t.exp * 1000 < Date.now()) throw new Error("Google sign-in expired. Try again.");
    if (!t.email || t.email_verified === false) throw new Error("Your Google email is not verified.");
    const users = auth.users();
    let u = Object.values(users).find((x) => x.googleSub === t.sub)
         || Object.values(users).find((x) => x.email && x.email.toLowerCase() === t.email.toLowerCase());
    if (u) { Object.assign(users[u.id], { googleSub: t.sub, picture: t.picture || users[u.id].picture || "", lastLogin: new Date().toISOString() }); }
    else {
      const id = auth.idFromEmail(t.email);
      users[id] = { id, name: t.name || t.email.split("@")[0], email: t.email, method: "google", googleSub: t.sub,
                    picture: t.picture || "", createdAt: new Date().toISOString(), lastLogin: new Date().toISOString() };
      u = users[id];
    }
    const isNew = !users[u.id].lastLogin || users[u.id].createdAt === users[u.id].lastLogin;
    auth.saveUsers(users);
    return { ...users[u.id], _new: isNew };
  },
  async mount(el, mode, onDone, onError) {
    if (!this.clientId) { el.innerHTML = `<button type="button" class="btn g-btn" id="gFallback">${GOOGLE_G}Continue with Google</button>`;
      $("#gFallback").onclick = () => onError("Google sign-in is not switched on for this site yet. The site owner needs to add a Google Client ID."); return; }
    el.innerHTML = `<div class="g-loading"><span class="spin"></span> Loading Google…</div>`;
    try { await this.load(); } catch (e) { el.innerHTML = ""; onError(e.message); return; }
    window.google.accounts.id.initialize({
      client_id: this.clientId, auto_select: false, cancel_on_tap_outside: true, use_fedcm_for_prompt: true,
      context: mode === "signup" ? "signup" : "signin",
      callback: async (resp) => { try { onDone(cloud.on ? await cloud.google(resp.credential) : this.accountFrom(resp.credential)); } catch (e) { onError(e.message); } },
    });
    el.innerHTML = "";
    window.google.accounts.id.renderButton(el, { type: "standard", theme: "outline", size: "large", shape: "pill",
      text: mode === "signup" ? "signup_with" : "continue_with", logo_alignment: "center", width: Math.min(380, el.clientWidth || 380) });
    window.google.accounts.id.prompt();    // One Tap: "Continue as <name>" with the device's Google account
  },
};
const GOOGLE_G = `<svg viewBox="0 0 48 48" style="width:18px;height:18px"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>`;

function authScreen(mode = "login", note = "") {
  const box = $("#auth");
  box.hidden = false; $("#appRoot").hidden = true;
  document.title = mode === "login" ? "Log in · CallGuard" : "Sign up · CallGuard";
  box.innerHTML = `
    <div class="auth-cols">
      <div class="auth-pitch">
        <div class="brand" style="padding:0"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="9"/><path d="M16 6l8 3v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V9z"/></svg></span>
          <div><div class="brand-name">CallGuard</div><div class="brand-sub" style="color:#9fc6bf">Scam-call protection</div></div></div>
        <h1>Know if that call is a scam — before it costs you.</h1>
        <p>Upload or record a call and get a fraud verdict in seconds, with the right people alerted automatically.</p>
        <div class="stack" style="gap:18px;margin-top:auto">
          <div class="auth-feat"><span class="f-icon">${icon("shield")}</span><div><b>A verdict, not just a transcript</b><span class="f-sub">Ten scam types (F0–F9) with a risk score for every call.</span></div></div>
          <div class="auth-feat"><span class="f-icon">${icon("bell")}</span><div><b>The right people get told</b><span class="f-sub">Your nominee for personal scams, the bank's fraud desk for banking scams, family for everything.</span></div></div>
          <div class="auth-feat"><span class="f-icon">${icon("clock")}</span><div><b>A history you own</b><span class="f-sub">Summary, transcript, audio and alerts for every call — exportable any time.</span></div></div>
        </div>
        <div style="font-size:12px;color:#8fb8b1">Works with phone calls, plus Telegram &amp; WhatsApp Web calls via the CallGuard Chrome extension.</div>
      </div>
      <div class="auth-pane">
        <div class="brand auth-brand-sm" style="padding:0 0 14px"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="9"/><path d="M16 6l8 3v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V9z"/></svg></span>
          <div><div class="brand-name">CallGuard</div><div class="brand-sub">Scam-call protection</div></div></div>
      <h2>${mode === "login" ? "Welcome back" : "Create your account"}</h2>
      <p class="muted" style="margin:4px 0 16px">${mode === "login" ? "Continue with your Google account, or log in with your user ID and password." : "Sign up in one tap with the Google account on this device, or register a user ID."}</p>
      ${note ? `<div class="banner" style="margin-bottom:14px">${icon("check")}<div>${note}</div></div>` : ""}
      <div class="banner warn" id="authErr" hidden style="margin-bottom:14px"></div>
      <div id="gBox" class="g-box"></div>
      <div class="or"><span>or ${mode === "login" ? "log in with user ID" : "register with a user ID"}</span></div>
      <form id="authForm" class="stack" style="gap:14px" novalidate>
        ${mode === "signup" ? `
          <div class="field"><label for="suName">Full name</label><input class="input" id="suName" autocomplete="name" required></div>
          <div class="field"><label for="suId">User ID</label><input class="input" id="suId" autocomplete="username" required placeholder="e.g. sumit_s" maxlength="20">
            <span class="hint">3–20 characters: letters, numbers, dot or underscore. You'll log in with this.</span></div>
          <div class="field"><label for="suEmail">Email</label><input class="input" id="suEmail" type="email" autocomplete="email" required placeholder="you@example.com"></div>
          <div class="field"><label for="suPw">Password</label><input class="input" id="suPw" type="password" autocomplete="new-password" required>
            <span class="hint">At least 8 characters, with a letter and a number.</span></div>
          <div class="field"><label for="suPw2">Confirm password</label><input class="input" id="suPw2" type="password" autocomplete="new-password" required></div>`
        : `
          <div class="field"><label for="liId">User ID or email</label><input class="input" id="liId" autocomplete="username" required></div>
          <div class="field"><label for="liPw">Password</label><input class="input" id="liPw" type="password" autocomplete="current-password" required></div>
          <label class="row" style="cursor:pointer;font-size:13.5px"><input type="checkbox" id="liRemember" checked> Keep me logged in on this device</label>`}
        <button class="btn btn-primary" id="authSubmit" style="height:42px">${mode === "login" ? "Log in" : "Create account"}</button>
      </form>
      <div class="auth-switch">${mode === "login"
        ? `New to CallGuard? <a href="#" data-mode="signup">Sign up</a>`
        : `Already have an account? <a href="#" data-mode="login">Log in</a>`}</div>
      <div class="faint" style="font-size:12px;margin-top:14px;text-align:center">${cloud.on ? "Your account is stored securely on our sign-in server. Your call history stays private in this browser." : "Your call history is stored privately in this browser on this device."}</div>
      </div>
    </div>`;
  $$("[data-mode]", box).forEach((a) => a.onclick = (e) => { e.preventDefault(); authScreen(a.dataset.mode); });
  const err = (m) => { const e = $("#authErr"); e.hidden = !m; e.innerHTML = m ? `${icon("alert")}<div>${esc(m)}</div>` : ""; };
  google.mount($("#gBox"), mode, async (u) => {
    err(""); if (!cloud.on) auth.startSession(u, true);
    await startApp(u, true);
    if (u._new) toast(`Account created with ${u.email}`, "check");
  }, err);
  $("#authForm").onsubmit = async (e) => {
    e.preventDefault(); err("");
    const btn = $("#authSubmit"); btn.disabled = true; const label = btn.textContent; btn.innerHTML = `<span class="spin"></span>`;
    try {
      if (mode === "signup") {
        if ($("#suPw").value !== $("#suPw2").value) throw new Error("The two passwords don't match.");
        const form = { name: $("#suName").value, email: $("#suEmail").value, id: $("#suId").value, password: $("#suPw").value };
        const u = cloud.on ? await cloud.signup(form) : await auth.signup(form);
        if (cloud.on && u.session) { await cloud.logout(); cloud.s = null; }   // still log in explicitly, as before
        authScreen("login", cloud.on && !u.session
          ? `Account <b>${esc(u.id)}</b> created. We sent a confirmation link to <b>${esc(u.email)}</b>: open it, then log in with your user ID and password.`
          : `Account <b>${esc(u.id)}</b> created. Log in with your user ID and password.`);
        $("#liId").value = u.id; $("#liPw").focus();
        return;
      }
      let u;
      if (cloud.on) u = await cloud.login($("#liId").value, $("#liPw").value, $("#liRemember").checked);
      else { u = await auth.login($("#liId").value, $("#liPw").value); auth.startSession(u, $("#liRemember").checked); }
      await startApp(u, true);
    } catch (ex) { err(ex.message); btn.disabled = false; btn.textContent = label; }
  };
}

/* ============================== Chrome extension bridge ============================== */
/** A voice clip captured by the CallGuard Chrome extension arrives here as base64 audio.
 *  It goes through the same pipeline as an upload: microservice, fraud category, history
 *  and alert routing. The result is posted back to the extension's content script. */
async function importExtensionClip(clip) {
  if (!clip || typeof clip.audio !== "string") return { ok: false, reason: "That clip had no audio." };
  if (!S.user) return { ok: false, reason: "Log in to CallGuard in this browser, then send the clip again." };
  if (!S.settings.transcriberUrl) return { ok: false, reason: "Connect the microservice in Settings first." };
  if (S.run && S.run.running) return { ok: false, busy: true, reason: "CallGuard is busy with another call." };
  const b64 = String(clip.audio).replace(/^data:[^,]+,/, "");
  if (!b64 || b64.length > 12 * 1024 * 1024) return { ok: false, reason: "That clip is too large for the dashboard." };
  let blob;
  try {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: clip.mime || "audio/webm" });
  } catch { return { ok: false, reason: "The clip's audio couldn't be read." }; }
  if (!blob.size) return { ok: false, reason: "The clip was empty." };
  const when = clip.capturedAt && !isNaN(Date.parse(clip.capturedAt)) ? new Date(clip.capturedAt).toISOString() : new Date().toISOString();
  const channel = CHANNELS[clip.platform] ? clip.platform : "telegram";       // older clips have no platform
  const name = clip.fileName || `${channel}-call-${localTime(when).replace(":", "")}.webm`;
  const maxSecs = CFG.maxAudioSeconds || 120;
  const secs = clip.duration != null && !isNaN(Number(clip.duration)) ? Number(clip.duration) : await audioDuration(blob);
  if (secs != null && secs > maxSecs + 0.5) return { ok: false, reason: `That clip is ${fmtDur(secs)} long; the microservice accepts up to ${fmtDur(maxSecs)}.` };
  if (!location.hash.startsWith("#/analyze")) location.hash = "#/analyze";
  await sleep(30);                                  // let the Analyze page render its pipeline
  const sessionId = /^[\w.-]{1,80}$/.test(String(clip.sessionId || "")) ? String(clip.sessionId) : "";
  const kind = ["chunk", "call", "voice"].includes(clip.kind) ? clip.kind : "";
  const rec = await runPipeline(blob, name, { source: `${channel}-extension`, channel, caller: clip.caller || {}, createdAt: when, sessionId, kind });
  if (!rec) {
    const err = S.run && S.run.error;
    return { ok: false, reason: err ? `${err.title} ${err.detail}`.trim() : "The analysis didn't finish." };
  }
  return { ok: true, token: rec.token, category: rec.category, categoryName: rec.categoryName, isFraud: rec.isFraud, risk: rec.risk, alerts: alertCount(rec) };
}

/* Extension asks at the START of a live call: has this caller been reported as fraud? (shared list + my history) */
window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (!d || d.source !== "callguard-extension" || d.type !== "check-caller") return;
  const keys = [d.caller && d.caller.number, d.caller && d.caller.handle].map((x) => String(x || "").trim()).filter(Boolean);
  Promise.resolve().then(async () => {
    if (!keys.length) return { ok: true, flagged: false, reason: "no caller id" };
    if (keys.some((k) => notFraudForMe().includes(k))) return { ok: true, flagged: false, ignoredByMe: true };
    const mine = S.calls.filter((c) => c.decision === "fraud" && keys.includes(lookupKeyOf(c)));
    for (const k of keys) {
      const r = await sharedCallers.check(k).catch(() => null);
      if (r && r.flagged) return { ok: true, ...r, myReports: mine.length, key: k };
    }
    return mine.length ? { ok: true, flagged: true, reports: mine.length, category: mine[0].category, myReports: mine.length, key: keys[0] }
      : { ok: true, flagged: false };
  })
    .catch((err) => ({ ok: false, reason: String((err && err.message) || err) }))
    .then((result) => window.postMessage({ source: "callguard-dashboard", requestId: d.requestId, result }, location.origin));
});

window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (!d || d.source !== "callguard-extension" || d.type !== "import-call") return;
  Promise.resolve()
    .then(() => importExtensionClip(d.clip))
    .catch((err) => ({ ok: false, reason: String((err && err.message) || err) }))
    .then((result) => window.postMessage({ source: "callguard-dashboard", requestId: d.requestId, result }, location.origin));
});

/* ============================== boot ============================== */
async function startApp(user, fresh = false) {
  S.user = user; NS = user.ns || user.id;
  S.settings = { ...DEFAULT_SETTINGS, ...LS.get("settings", {}) };
  const retired = (CFG.retiredServiceUrls || []).some((u) => String(S.settings.transcriberUrl || "").startsWith(u));
  if ((!S.settings.transcriberUrl || retired) && CFG.serviceUrl) { S.settings.transcriberUrl = CFG.serviceUrl; if (retired) saveSettings(); }
  if ((S.settings.timeoutSec || 0) < 300) S.settings.timeoutSec = 300;   // transcription + cold start can be slow
  S.contacts = { ...JSON.parse(JSON.stringify(DEFAULT_CONTACTS)), ...LS.get("contacts", {}) };
  if (!S.contacts.user.name && !S.contacts.user.email) { S.contacts.user = { name: user.name, email: user.email, phone: "" }; saveContacts(); }
  S.filters = LS.get("filters", null);
  try { S.calls = (await idb.all()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); } catch { S.calls = []; }
  const fake = S.calls.filter((c) => c.source === "sample" || c.source === "demo");   // simulated calls from the old demo mode
  if (fake.length) { for (const c of fake) { await idb.del(c.id).catch(() => {}); await idb.delAudio(c.id).catch(() => {}); } S.calls = S.calls.filter((c) => !fake.includes(c)); }
  try { S.dir = (await idb.kvGet("dir")) || null; } catch { S.dir = null; }
  $("#auth").hidden = true; $("#appRoot").hidden = false;
  $("#userChip").innerHTML = `${user.picture ? `<img class="avatar" src="${esc(user.picture)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar">${esc(initials(user.name))}</span>`}
    <div style="min-width:0;flex:1"><div style="font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(user.name)}</div>
    <div class="faint" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">@${esc(user.id)}</div></div>
    <button class="icon-btn" id="logoutBtn" title="Log out" aria-label="Log out">${icon("logout")}</button>`;
  $("#logoutBtn").onclick = () => auth.logout();
  $("#menuBtn").onclick = () => $("#sidebar").classList.toggle("open");
  window.addEventListener("hashchange", route);
  if (fresh && !location.hash) location.hash = "#/overview";
  paintChrome();
  route();
  if (fresh) toast(`Welcome, ${user.name.split(" ")[0]}`, "shield");
  setTimeout(() => sendStuckAlerts().catch(() => {}), 3000);
}

/* Busy = analysing or recording: the update check (index.html) waits instead of reloading the page. */
window.CG_BUSY = () => !!((S.run && S.run.running) || recorder.active());

/** Fraud-alert emails from the last 24 hours still waiting in the outbox (for example, made by an older
    version of this page that couldn't send email) are sent now. Older ones stay for "Send now". */
async function sendStuckAlerts() {
  if (!notifyUrl()) return;
  const since = Date.now() - 24 * 3600 * 1000;
  let sent = 0, failed = 0;
  for (const rec of S.calls) {
    if (!rec.isFraud || new Date(rec.createdAt).getTime() < since) continue;
    const stuck = (rec.notifications || []).filter((n) => n.channel === "email" && n.to && n.status === "queued" && !n.reason);
    if (!stuck.length) continue;
    stuck.forEach((n) => { n.status = "pending"; });
    await dispatchAlerts(rec, { quiet: true });
    sent += stuck.filter((n) => n.status === "sent").length; failed += stuck.filter((n) => n.status === "failed").length;
    await saveRecord(rec, null);
  }
  if (sent || failed) { toast(`Sent ${sent} fraud-alert email${sent === 1 ? "" : "s"} that were waiting${failed ? `; ${failed} failed (see Alerts)` : ""}.`, failed ? "alert" : "check"); route(); }
}

async function boot() {
  if (cloud.on) {
    let u = null;
    try { u = await cloud.restore(); } catch { u = null; }
    if (!u) { authScreen(cloud.remembered() || GLS.get("seen", false) ? "login" : "signup"); GLS.set("seen", true); return; }
    return startApp(u).catch((e) => { console.error("CallGuard start failed", e); cloud.logout(); authScreen("login", `Please log in again. (${esc(e.message || e)})`); });
  }
  const fresh = () => authScreen(GLS.get("users", null) ? "login" : "signup");
  let u = null;
  try { u = auth.currentSession(); } catch { u = null; }
  if (!u) { fresh(); return; }
  startApp(u).catch((e) => {          // never leave a blank page: drop the session and show login
    console.error("CallGuard start failed", e);
    GLS.del("session");
    authScreen("login", `Please log in again. (${esc(e.message || e)})`);
  });
}
boot();
})();
