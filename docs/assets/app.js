/* CallGuard dashboard: single-page app, no build step.
   Pipeline: audio -> transcriber microservice -> fraud category (from the service or your classifier)
             -> labels -> alert routing (nominee / bank / authorised people / emergency) -> history. */
(() => {
"use strict";
const D = window.CG_DATA;
const CATS = D.categories;
const CODES = Object.keys(CATS);

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
  el.className = "toast";
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
  workspace: "My workspace", mode: "demo", plan: "pro",
  transcriberUrl: "", classifierUrl: "", notifierUrl: "", apiKey: "", timeoutSec: 120,
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
  const m = s.match(/^f?\s*([0-9])$/i) || s.match(/^f([0-9])\b/i);
  if (m) return "F" + m[1];
  const low = s.toLowerCase();
  if (/^(not[\s_-]?fraud|legit|safe|ham|benign|none)$/.test(low)) return "F0";
  for (const c of CODES) if (low.includes(CATS[c].name.toLowerCase().split(" /")[0].toLowerCase())) return c;
  return null;
}

function normalise(raw) {
  raw = raw || {};
  const pick = (...ks) => { for (const k of ks) if (raw[k] != null && raw[k] !== "") return raw[k]; return undefined; };
  let conf = pick("confidence", "score", "probability", "prob");
  if (conf != null) { conf = Number(conf); if (conf > 1) conf /= 100; }
  return {
    transcript: pick("transcript", "text", "transcription") || "",
    summary: pick("summary", "call_summary", "abstract") || "",
    duration: pick("duration", "duration_sec", "duration_seconds"),
    language: pick("language", "lang"),
    token: pick("token", "call_token", "call_id", "id"),
    tokens: pick("tokens", "token_count", "num_tokens"),
    category: normCategory(pick("category", "label", "family", "class", "prediction", "fraud_type")),
    confidence: conf,
    scores: pick("scores", "probabilities"),
  };
}

function authHeaders() {
  const k = S.settings.apiKey;
  return k ? { Authorization: `Bearer ${k}`, "X-API-Key": k } : {};
}

async function fetchJSON(url, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), (S.settings.timeoutSec || 120) * 1000);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 160)}`);
    try { return JSON.parse(text); } catch { return { transcript: text }; }
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Timed out after ${S.settings.timeoutSec}s`);
    throw e;
  } finally { clearTimeout(t); }
}

const services = {
  async transcribe(blob, fileName, token, demoCode) {
    if (S.settings.mode === "live") {
      if (!S.settings.transcriberUrl) throw new Error("Add your transcriber URL in Settings first.");
      const fd = new FormData();
      fd.append("file", blob, fileName || "call.webm");
      fd.append("call_token", token);
      return normalise(await fetchJSON(S.settings.transcriberUrl, { method: "POST", body: fd, headers: authHeaders() }));
    }
    await sleep(1100 + Math.random() * 700);
    const pool = D.samples;
    const s = demoCode && demoCode !== "auto" ? pool.find((x) => x.category === demoCode) : pool[Math.floor(Math.random() * pool.length)];
    return { ...normalise({ transcript: s.transcript, summary: s.summary, duration: s.duration, language: "en" }), _demo: s };
  },
  async classify(tr, token) {
    if (tr.category) return { category: tr.category, confidence: tr.confidence, scores: tr.scores, by: "transcriber" };
    if (S.settings.mode === "live") {
      if (!S.settings.classifierUrl) throw new Error("The transcriber did not return a category and no classifier URL is set.");
      const r = normalise(await fetchJSON(S.settings.classifierUrl, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ transcript: tr.transcript, summary: tr.summary, call_token: token }),
      }));
      if (!r.category) throw new Error("Classifier response had no category (expected F0–F9).");
      return { category: r.category, confidence: r.confidence, scores: r.scores, by: "classifier" };
    }
    await sleep(600);
    const s = tr._demo;
    return { category: s.category, confidence: s.confidence, by: "demo" };
  },
  async notify(n, rec) {
    if (S.settings.mode === "live" && S.settings.notifierUrl) {
      await fetchJSON(S.settings.notifierUrl, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ to: n.to, name: n.name, role: n.role, channel: n.channel, subject: n.subject, body: n.body,
          call_token: rec.token, category: rec.category, category_name: rec.categoryName, risk: rec.risk, created_at: rec.createdAt }),
      });
      return "sent";
    }
    return "queued";   // no notifier: kept in the outbox with a one-click "open in mail app"
  },
};

/* ============================== labels + routing ============================== */
function autoLabels(rec) {
  const t = `${rec.transcript} ${rec.summary}`.toLowerCase();
  const L = [rec.category, rec.isFraud ? "fraud" : "safe", `${rec.risk}-risk`];
  if (rec.isBanking) L.push("banking");
  if (rec.confidence != null && rec.confidence < 0.6) L.push("needs-review");
  const rules = [
    ["otp-request", /\b(otp|one[- ]time code|verification code|login code)\b/],
    ["money-request", /(\$\s?\d|\bpay\b|send (the )?money|transfer|bail|fee\b|deposit)/],
    ["urgency", /(urgent|hurry|right now|immediately|within the hour|today|quickly|before the)/],
    ["threat", /(arrest|warrant|police|locked|deleted|send the video|or else)/],
    ["gift-card", /gift ?cards?/],
    ["crypto", /(bitcoin|crypto|usdt|btc|wallet)/],
    ["remote-access", /(anydesk|teamviewer|remote access|download .* app)/],
    ["secrecy", /(don't tell|do not tell|keep (this|it) secret|don't hang up|do not hang up)/],
  ];
  for (const [lab, rx] of rules) if (rx.test(t)) L.push(lab);
  if (rec.source === "demo") L.push("demo");
  if (rec.source === "sample") L.push("sample-data");
  return [...new Set(L)];
}

function warningText(rec) {
  const c = CATS[rec.category];
  return [
    `CallGuard flagged a call as ${rec.category} · ${c.name} (${rec.risk} risk${rec.confidence != null ? `, ${pct(rec.confidence)} confidence` : ""}).`,
    "",
    `When: ${new Date(rec.createdAt).toLocaleString()}`,
    `Call token: ${rec.token}`,
    "",
    `Summary: ${rec.summary || "(no summary returned)"}`,
    "",
    `Warning: ${c.advice}`,
    "",
    "Please check on the account holder. This alert was sent automatically by CallGuard.",
  ].join("\n");
}

/** Who gets told, per the routing rules. Returns notification objects (not yet sent). */
function planAlerts(rec, C = S.contacts) {
  const out = [];
  if (!rec.isFraud) return out;
  const subject = `⚠ ${rec.isBanking ? "Banking fraud" : "Fraud"} alert: ${CATS[rec.category].name} (${rec.token})`;
  const body = warningText(rec);
  const add = (role, person, channel, extra = {}) => out.push({
    id: uid(), role, name: person?.name || "", to: person?.email || "", channel, subject, body,
    status: person?.email || channel === "in-app" ? "pending" : "skipped", at: new Date().toISOString(), ...extra,
  });

  if (rec.isBanking) {
    // Rule 2: banking fraud -> the bank the nominee added
    if (isEmail(C.bank.email)) add("Bank", { name: C.bank.name || "Bank fraud desk", email: C.bank.email }, "email");
    else add("Bank", null, "email", { reason: "No bank added yet (the nominee adds it in Contacts)." });
  } else {
    // Rule 1: any other fraud -> nominee gets a notification + email with summary and warning
    if (C.nominee.name || isEmail(C.nominee.email)) {
      add("Nominee", C.nominee, "in-app", { to: C.nominee.email || C.nominee.phone || "" });
      if (isEmail(C.nominee.email)) add("Nominee", C.nominee, "email");
    } else add("Nominee", null, "email", { reason: "No nominee added yet." });
  }
  // Rule 3: every fraud -> authorised people; if none, the emergency contact by default
  const auth = (C.authorised || []).filter((a) => isEmail(a.email));
  if (auth.length) auth.forEach((a) => add("Authorised person", a, "email"));
  else if (isEmail(C.emergency.email)) add("Emergency contact", C.emergency, "email", { fallback: true });
  else add("Emergency contact", null, "email", { reason: "No authorised person or emergency contact added." });

  // never email the same address twice for one call
  const seen = new Set();
  return out.filter((n) => { if (n.channel !== "email" || !n.to) return true; const k = n.to.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function dispatchAlerts(rec) {
  for (const n of rec.notifications) {
    if (n.status !== "pending") continue;
    try {
      n.status = n.channel === "in-app" && !(S.settings.mode === "live" && S.settings.notifierUrl) ? "delivered" : await services.notify(n, rec);
    } catch (e) { n.status = "failed"; n.reason = e.message; }
    n.at = new Date().toISOString();
  }
  if (rec.isFraud && S.settings.browserNotify && "Notification" in window && Notification.permission === "granted") {
    try { new Notification(`CallGuard: ${CATS[rec.category].name}`, { body: rec.summary || rec.token }); } catch { /* ignore */ }
  }
}

const mailto = (n) => `mailto:${encodeURIComponent(n.to)}?subject=${encodeURIComponent(n.subject)}&body=${encodeURIComponent(n.body)}`;

/* ============================== records ============================== */
function buildRecord({ token, createdAt, fileName, audioType, tr, cls, source }) {
  const code = cls.category;
  const c = CATS[code];
  const words = (tr.transcript.match(/\S+/g) || []).length;
  const rec = {
    id: token, token, createdAt, fileName: fileName || "", audioType: audioType || "",
    duration: tr.duration != null ? Number(tr.duration) : null, language: tr.language || "",
    transcript: tr.transcript, summary: tr.summary,
    tokens: tr.tokens != null ? Number(tr.tokens) : words,
    serviceToken: tr.token && tr.token !== token ? String(tr.token) : "",
    category: code, categoryName: c.name, isFraud: code !== "F0", isBanking: !!c.banking, risk: c.risk,
    confidence: cls.confidence != null ? Number(cls.confidence) : null, scores: cls.scores || null, classifiedBy: cls.by,
    source, labels: [], userLabels: [], notifications: [], reviewed: false, hasAudio: false,
  };
  rec.labels = autoLabels(rec);
  return rec;
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
  const cols = ["token", "date", "time", "category", "category_name", "verdict", "risk", "confidence", "duration_sec", "tokens", "labels", "alerts_sent", "summary"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map((r) => [r.token, localDate(r.createdAt), localTime(r.createdAt), r.category, r.categoryName,
    r.isFraud ? "fraud" : "not fraud", r.risk, r.confidence ?? "", r.duration ?? "", r.tokens ?? "",
    [...r.labels, ...r.userLabels].join("|"), r.notifications.filter((n) => ["sent", "delivered", "queued"].includes(n.status)).length, r.summary].map(q).join(","))].join("\n");
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
const labelChips = (rec, removable = false) => [
  ...rec.labels.map((l) => `<span class="chip chip-label">${esc(l)}</span>`),
  ...rec.userLabels.map((l) => `<span class="chip chip-user">${icon("tag")}${esc(l)}${removable ? `<span class="x" data-rmlabel="${esc(l)}" title="Remove">${icon("x")}</span>` : ""}</span>`),
].join("");
const confBar = (c) => c == null ? `<span class="faint">–</span>` : `<span class="conf"><span class="bar"><span style="width:${Math.round(c * 100)}%"></span></span><span class="mono">${pct(c)}</span></span>`;
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
    ${actions && n.status === "failed" ? `<button class="btn btn-sm" data-retry="${rec.id}:${n.id}">Retry</button>` : ""}
  </div>`;
}

/* ============================== router + chrome ============================== */
const TITLES = { overview: "Overview", analyze: "Analyze a call", history: "Call history", alerts: "Alerts", contacts: "Contacts & routing", plans: "Plan & usage", settings: "Settings" };
const VIEWS = {};

function route() {
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
  return S.calls.filter((c) => { const d = new Date(c.createdAt); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() && c.source !== "sample"; }).length;
}
const currentPlan = () => D.plans.find((p) => p.id === S.settings.plan) || D.plans[0];

function paintChrome() {
  $("#workspaceName").textContent = S.settings.workspace || "My workspace";
  const live = S.settings.mode === "live";
  const mp = $("#modePill");
  mp.className = `mode-pill ${live ? "live" : ""}`;
  mp.innerHTML = live ? `<span class="dot" style="background:var(--good)"></span>Live services` : `<span class="dot" style="background:var(--lav)"></span>Demo mode`;
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
    ${!S.calls.length ? `<div class="banner" style="margin-bottom:16px">${icon("shield")}<div><b>Welcome to CallGuard.</b> Analyse your first call, or load sample history to explore the dashboard.
      <div class="row" style="margin-top:10px"><a class="btn btn-sm btn-primary" href="#/analyze">${icon("wave")}Analyze a call</a><button class="btn btn-sm" id="seedBtn">Load sample history</button><a class="btn btn-sm btn-ghost" href="#/contacts">Set up contacts</a></div></div></div>` : ""}
    <div class="row" style="margin-bottom:14px">
      <div class="muted">Showing the last ${R} days</div><div class="spacer"></div>
      <div class="seg" id="rangeSeg">${[7, 14, 30].map((n) => `<button data-r="${n}" class="${n === R ? "on" : ""}">${n} days</button>`).join("")}</div>
    </div>
    <div class="grid g-4">
      <div class="card kpi"><div class="k-label"><span class="k-icon">${icon("wave")}</span>Calls analysed</div><div class="k-value">${inRange.length}</div><div class="k-foot">${inRange.filter((c) => !c.isFraud).length} not fraud</div></div>
      <div class="card kpi"><div class="k-label"><span class="k-icon" style="background:var(--critical-soft);color:var(--critical-ink)">${icon("alert")}</span>Fraud detected</div><div class="k-value">${fraud.length}</div><div class="k-foot">${banking} banking · ${fraud.length - banking} other</div></div>
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
  $$("[data-open]", root).forEach((li) => li.onclick = () => openDrawer(li.dataset.open));
  const seed = $("#seedBtn"); if (seed) seed.onclick = seedSamples;
};

function routingSummary() {
  const C = S.contacts;
  const who = (p, fallback) => p && (p.name || p.email) ? `<b>${esc(p.name || p.email)}</b>${p.email ? ` <span class="faint">${esc(p.email)}</span>` : ""}` : `<span class="status serious">${icon("alert")}${fallback}</span>`;
  const auth = C.authorised.filter((a) => isEmail(a.email));
  return `<table class="rules">
    <tr><td style="width:42%">${riskBadge("low")} Not fraud (F0)</td><td>Logged with date, token and summary. No alerts.</td></tr>
    <tr><td>${icon("bank")} Banking fraud (F1, F2)</td><td>Email to bank: ${who(C.bank.email ? { name: C.bank.name, email: C.bank.email } : null, "No bank added")}</td></tr>
    <tr><td>${icon("alert")} Other fraud (F3–F9)</td><td>Notification + email to nominee: ${who(C.nominee, "No nominee")}</td></tr>
    <tr><td>${icon("shield")} Every fraud</td><td>${auth.length ? `Authorised: ${auth.map((a) => `<b>${esc(a.name || a.email)}</b>`).join(", ")}` : `Emergency contact (default): ${who(C.emergency, "None added")}`}</td></tr>
  </table>`;
}

/* ============================== view: analyze ============================== */
VIEWS.analyze = (root) => {
  const live = S.settings.mode === "live";
  const plan = currentPlan(), used = monthUsage();
  root.innerHTML = `
    <p class="section-intro">Upload or record a call. CallGuard sends the audio to your transcriber service, gets the transcript and summary, decides the fraud type, labels the call, alerts the right people and saves everything to history.</p>
    ${!live ? `<div class="banner" style="margin-bottom:16px">${icon("alert")}<div><b>Demo mode.</b> No audio leaves your browser: the transcriber and classifier responses are simulated from sample calls. Add your service URLs in <a href="#/settings">Settings</a> and switch to Live to use your real model.</div></div>` : ""}
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
          ${!live ? `<div class="field" style="margin-top:14px"><label for="demoCode">Simulated service response</label>
            <select class="input" id="demoCode"><option value="auto">Random sample call</option>${CODES.map((c) => `<option value="${c}">${c} · ${esc(CATS[c].name)}</option>`).join("")}</select>
            <span class="hint">Demo only: pick what the fake transcriber should "hear". Use "Try a sample call" below if you have no audio file.</span></div>` : ""}
          <div class="row" style="margin-top:16px">
            <button class="btn btn-primary" id="analyzeBtn" disabled>${icon("wave")}Analyze call</button>
            ${!live ? `<button class="btn" id="sampleBtn">Try a sample call</button>` : ""}
          </div>
        </div>
        <div id="resultBox"></div>
      </div>
      <div class="card card-pad" style="align-self:start">
        <h3 style="margin-bottom:6px">2. Pipeline</h3>
        <div class="faint" style="font-size:12.5px;margin-bottom:8px">${live ? `Transcriber: <span class="mono">${esc(S.settings.transcriberUrl || "not set")}</span>` : "Simulated services"}</div>
        <ol class="steps" id="steps">${stepItems()}</ol>
      </div>
    </div>`;

  const setPending = (blob, name) => {
    S.pending = blob ? { blob, name } : null;
    $("#analyzeBtn").disabled = !blob;
    if (!blob) { $("#filePill").innerHTML = ""; return; }
    const url = URL.createObjectURL(blob);
    $("#filePill").innerHTML = `<div class="file-pill"><span class="k-icon" style="width:34px;height:34px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;background:var(--primary-soft);color:var(--primary-600)">${icon("wave")}</span>
      <div style="min-width:0"><div style="font-weight:620;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px">${esc(name)}</div><div class="faint" style="font-size:12px">${(blob.size / 1024 / 1024).toFixed(2)} MB</div></div>
      <audio controls src="${url}"></audio><button class="icon-btn" id="clearFile" aria-label="Remove file">${icon("x")}</button></div>`;
    $("#clearFile").onclick = () => setPending(null);
  };
  if (S.pending) setPending(S.pending.blob, S.pending.name);

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

  let rec = null, chunks = [], t0 = 0, timer = null;
  $("#recBtn").onclick = async () => {
    if (rec && rec.state === "recording") { rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = []; rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop()); clearInterval(timer);
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        setPending(blob, `recording-${localDate(new Date())}-${localTime(new Date()).replace(":", "")}.${folder.ext(blob.type)}`);
        $("#recBtn").innerHTML = `${icon("mic")}Record again`; $("#recState").textContent = "Recording ready.";
      };
      rec.start(); t0 = Date.now();
      $("#recBtn").innerHTML = `${icon("x")}Stop`;
      timer = setInterval(() => { $("#recState").innerHTML = `<span class="row"><span class="rec-dot"></span>Recording ${fmtDur((Date.now() - t0) / 1000)}</span>`; }, 250);
    } catch (e) { toast("Microphone not available: " + e.message, "alert"); }
  };

  $("#analyzeBtn").onclick = () => S.pending && runPipeline(S.pending.blob, S.pending.name);
  const sb = $("#sampleBtn"); if (sb) sb.onclick = () => runPipeline(null, "", true);
};

const STEPS = [
  ["upload", "Receive audio", "Audio file or recording"],
  ["transcribe", "Transcriber service", "Transcript + summary"],
  ["classify", "Fraud classification", "Category F0–F9 + confidence"],
  ["label", "Label & save", "Date, token, labels, history"],
  ["alert", "Route alerts", "Nominee · bank · authorised · emergency"],
];
const stepItems = (state = {}) => STEPS.map(([k, t, sub], i) => {
  const s = state[k] || {};
  return `<li class="${s.st || ""}" data-step="${k}"><span class="s-dot">${s.st === "done" ? icon("check") : s.st === "active" ? `<span class="spin"></span>` : s.st === "error" ? "!" : i + 1}</span>
    <div><div class="s-title">${t}</div><div class="s-sub">${esc(s.note || sub)}</div></div></li>`;
}).join("");

async function runPipeline(blob, fileName, sampleOnly = false) {
  const state = {};
  const set = (k, st, note) => { state[k] = { st, note }; const el = $("#steps"); if (el) el.innerHTML = stepItems(state); };
  const btn = $("#analyzeBtn"); if (btn) btn.disabled = true;
  $("#resultBox").innerHTML = "";
  const createdAt = new Date().toISOString();
  const token = makeToken(new Date(createdAt));
  let cur = "upload";
  try {
    set("upload", "done", sampleOnly ? "Sample call (no audio)" : `${fileName} · ${(blob.size / 1024).toFixed(0)} KB`);
    cur = "transcribe"; set("transcribe", "active", S.settings.mode === "live" ? "Uploading to transcriber…" : "Simulating transcriber…");
    const demoCode = $("#demoCode")?.value;
    const tr = await services.transcribe(blob, fileName, token, demoCode);
    if (tr.duration == null && blob) tr.duration = await audioDuration(blob);
    if (!tr.transcript && !tr.summary) throw new Error("Transcriber returned no transcript or summary.");
    set("transcribe", "done", `${(tr.transcript.match(/\S+/g) || []).length} words${tr.summary ? " · summary received" : " · no summary"}`);
    cur = "classify"; set("classify", "active", "Deciding fraud type…");
    const cls = await services.classify(tr, token);
    set("classify", "done", `${cls.category} · ${CATS[cls.category].name}${cls.confidence != null ? ` (${pct(cls.confidence)})` : ""}`);
    cur = "label"; set("label", "active");
    const rec = buildRecord({ token, createdAt, fileName: sampleOnly ? "sample call" : fileName, audioType: blob?.type, tr, cls, source: S.settings.mode === "live" ? "live" : "demo" });
    rec.notifications = planAlerts(rec);
    await saveRecord(rec, blob);
    set("label", "done", `${rec.labels.length} labels · saved${S.dir ? " + history folder" : ""}`);
    cur = "alert"; set("alert", "active");
    await dispatchAlerts(rec);
    await saveRecord(rec, null);
    const n = alertCount(rec);
    set("alert", "done", rec.isFraud ? `${n} alert${n === 1 ? "" : "s"} ${S.settings.mode === "live" && S.settings.notifierUrl ? "sent" : "ready"}` : "Not fraud: no alerts needed");
    $("#resultBox").innerHTML = resultCard(rec);
    bindResult($("#resultBox"), rec);
    S.pending = null;
    toast(rec.isFraud ? `Fraud detected: ${rec.categoryName}` : "Call looks safe", rec.isFraud ? "alert" : "shield");
  } catch (e) {
    set(cur, "error", e.message);
    $("#resultBox").innerHTML = `<div class="banner warn">${icon("alert")}<div><b>Analysis stopped.</b> ${esc(e.message)}</div></div>`;
  } finally { if (btn) btn.disabled = !S.pending; }
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
    <dl class="kv">
      <div><dt>Date</dt><dd>${fmtDT(rec.createdAt)}</dd></div>
      <div><dt>Token</dt><dd class="mono" title="${esc(rec.token)}">${esc(rec.token)}</dd></div>
      <div><dt>Confidence</dt><dd>${confBar(rec.confidence)}</dd></div>
      <div><dt>Duration · words</dt><dd>${fmtDur(rec.duration)} · ${rec.tokens ?? "–"}</dd></div>
    </dl>
    <div><div class="lbl" style="margin-bottom:6px">Summary (from transcriber)</div><div class="summary">${esc(rec.summary || "No summary returned.")}</div></div>
    <div><div class="lbl" style="margin-bottom:6px">Labels</div><div class="row" style="gap:6px">${labelChips(rec)}</div></div>
    <div><div class="lbl" style="margin-bottom:2px">Alerts</div>${rec.notifications.length ? rec.notifications.map((n) => notifRow(n, rec)).join("") : `<div class="faint">Not fraud, so nobody was alerted.</div>`}</div>
    <div class="row"><button class="btn" data-open="${rec.id}">Open full details</button><a class="btn btn-ghost" href="#/history">Go to history</a></div>
  </div>`;
}

function bindResult(box, rec) {
  $$("[data-open]", box).forEach((b) => b.onclick = () => openDrawer(b.dataset.open));
  bindNotifActions(box, () => { box.innerHTML = resultCard(S.calls.find((c) => c.id === rec.id)); bindResult(box, rec); });
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
    toast(n.status === "failed" ? "Still failing: " + n.reason : "Alert resent", n.status === "failed" ? "alert" : "check");
    rerender && rerender();
  });
}

/* ============================== view: history ============================== */
const defaultFilters = () => ({ q: "", from: "", to: "", tFrom: "", tTo: "", types: [], verdict: "all", risk: "all", label: "", alerts: "any", sort: "new" });

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
    if (F.verdict === "fraud" && !c.isFraud) return false;
    if (F.verdict === "safe" && c.isFraud) return false;
    if (F.verdict === "banking" && !c.isBanking) return false;
    if (F.risk !== "all" && c.risk !== F.risk) return false;
    if (F.label && ![...c.labels, ...c.userLabels].includes(F.label)) return false;
    if (F.alerts === "alerted" && !alertCount(c)) return false;
    if (F.alerts === "problem" && !c.notifications.some((n) => ["failed", "skipped", "queued"].includes(n.status))) return false;
    if (q && !`${c.token} ${c.summary} ${c.transcript} ${c.categoryName} ${c.fileName} ${c.labels.join(" ")} ${c.userLabels.join(" ")}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const by = { new: (a, b) => b.createdAt.localeCompare(a.createdAt), old: (a, b) => a.createdAt.localeCompare(b.createdAt),
    conf: (a, b) => (b.confidence ?? -1) - (a.confidence ?? -1), risk: (a, b) => ({ high: 0, medium: 1, low: 2 }[a.risk] - { high: 0, medium: 1, low: 2 }[b.risk]) || b.createdAt.localeCompare(a.createdAt) };
  return rows.sort(by[F.sort] || by.new);
}

VIEWS.history = (root) => {
  const F = S.filters = { ...defaultFilters(), ...(S.filters || {}) };
  const allLabels = [...new Set(S.calls.flatMap((c) => [...c.labels, ...c.userLabels]))].sort();
  root.innerHTML = `
    <div class="card">
      <div class="filters">
        <div class="f-row">
          <div class="field f-search"><label for="fq">Search</label><input class="input" id="fq" placeholder="Token, summary, transcript, label…" value="${esc(F.q)}"></div>
          <div class="field"><label for="ffrom">From date</label><input type="date" class="input" id="ffrom" value="${esc(F.from)}"></div>
          <div class="field"><label for="fto">To date</label><input type="date" class="input" id="fto" value="${esc(F.to)}"></div>
          <div class="field"><label for="ftf">From time</label><input type="time" class="input" id="ftf" value="${esc(F.tFrom)}"></div>
          <div class="field"><label for="ftt">To time</label><input type="time" class="input" id="ftt" value="${esc(F.tTo)}"></div>
          <div class="field"><label for="fsort">Sort</label><select class="input" id="fsort">
            ${[["new", "Newest first"], ["old", "Oldest first"], ["risk", "Highest risk"], ["conf", "Highest confidence"]].map(([v, t]) => `<option value="${v}" ${F.sort === v ? "selected" : ""}>${t}</option>`).join("")}</select></div>
        </div>
        <div class="f-row" style="grid-template-columns:repeat(4,minmax(0,1fr)) 2fr">
          <div class="field"><label for="fverdict">Verdict</label><select class="input" id="fverdict">
            ${[["all", "All calls"], ["fraud", "Fraud only"], ["safe", "Not fraud only"], ["banking", "Banking fraud"]].map(([v, t]) => `<option value="${v}" ${F.verdict === v ? "selected" : ""}>${t}</option>`).join("")}</select></div>
          <div class="field"><label for="frisk">Risk</label><select class="input" id="frisk">
            ${["all", "high", "medium", "low"].map((v) => `<option value="${v}" ${F.risk === v ? "selected" : ""}>${v === "all" ? "Any risk" : v[0].toUpperCase() + v.slice(1)}</option>`).join("")}</select></div>
          <div class="field"><label for="flabel">Label</label><select class="input" id="flabel"><option value="">Any label</option>
            ${allLabels.map((l) => `<option ${F.label === l ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
          <div class="field"><label for="falerts">Alerts</label><select class="input" id="falerts">
            ${[["any", "Any"], ["alerted", "Alerts sent"], ["problem", "Needs attention"]].map(([v, t]) => `<option value="${v}" ${F.alerts === v ? "selected" : ""}>${t}</option>`).join("")}</select></div>
          <div class="field"><span class="lbl">Quick range</span><div class="row" style="gap:6px">
            ${[["today", "Today"], ["7", "7 days"], ["30", "30 days"], ["all", "All time"]].map(([v, t]) => `<button class="chip-toggle" data-quick="${v}">${t}</button>`).join("")}</div></div>
        </div>
        <div><span class="lbl">Fraud type</span><div class="f-types" style="margin-top:6px">
          ${CODES.map((c) => `<button class="chip-toggle ${F.types.includes(c) ? "on" : ""}" data-type="${c}" title="${esc(CATS[c].name)}">${c} · ${esc(CATS[c].name.split(" /")[0])}</button>`).join("")}</div></div>
      </div>
      <div class="result-bar">
        <b id="resCount"></b><span class="faint" id="resSub"></span><div class="spacer"></div>
        <button class="btn btn-sm btn-ghost" id="resetF">Reset filters</button>
        <button class="btn btn-sm" id="expCsv">${icon("download")}CSV</button>
        <button class="btn btn-sm" id="expJson">${icon("download")}JSON</button>
        ${folder.supported ? `<button class="btn btn-sm btn-soft" id="syncDir">${icon("folder")}${S.dir ? "Sync to folder" : "Save to a folder"}</button>` : ""}
      </div>
      <div class="table-wrap"><table class="tbl"><thead><tr>
        <th>Date</th><th>Time</th><th>Token</th><th>Type</th><th>Verdict</th><th>Risk</th><th>Confidence</th><th>Labels</th><th class="num">Alerts</th>
      </tr></thead><tbody id="rows"></tbody></table></div>
    </div>`;

  const paint = () => {
    LS.set("filters", F);
    const rows = applyFilters(F);
    $("#resCount").textContent = `${rows.length} call${rows.length === 1 ? "" : "s"}`;
    $("#resSub").textContent = `${rows.filter((r) => r.isFraud).length} fraud · ${S.calls.length} in history`;
    $("#rows").innerHTML = rows.length ? rows.slice(0, 500).map((c) => `<tr data-open="${c.id}">
      <td class="nowrap">${fmtDate(c.createdAt)}</td><td class="mono">${localTime(c.createdAt)}</td>
      <td class="mono nowrap">${esc(c.token)}</td><td>${catChip(c.category)}</td><td>${verdictBadge(c)}</td><td>${riskBadge(c.risk)}</td>
      <td style="min-width:120px">${confBar(c.confidence)}</td>
      <td>${(() => { const ls = [...c.userLabels, ...c.labels.filter((l) => !CODES.includes(l) && !["fraud", "safe", "demo", "sample-data"].includes(l) && !l.endsWith("-risk"))];
        return `<div class="labels">${ls.slice(0, 2).map((l) => `<span class="chip ${c.userLabels.includes(l) ? "chip-user" : "chip-label"}">${esc(l)}</span>`).join("")}${ls.length > 2 ? `<span class="chip" title="${esc(ls.slice(2).join(", "))}">+${ls.length - 2}</span>` : ""}</div>`; })()}</td>
      <td class="num">${alertCount(c) || `<span class="faint">0</span>`}</td></tr>`).join("")
      : `<tr><td colspan="9"><div class="empty">${icon("clock")}<div>${S.calls.length ? "No calls match these filters." : "No calls yet. Analyse one to start your history."}</div></div></td></tr>`;
    $$("#rows [data-open]").forEach((tr) => tr.onclick = () => openDrawer(tr.dataset.open));
    return rows;
  };
  const bind = (id, key, ev = "input") => $(id).addEventListener(ev, (e) => { F[key] = e.target.value; paint(); });
  bind("#fq", "q"); bind("#ffrom", "from", "change"); bind("#fto", "to", "change"); bind("#ftf", "tFrom", "change"); bind("#ftt", "tTo", "change");
  bind("#fsort", "sort", "change"); bind("#fverdict", "verdict", "change"); bind("#frisk", "risk", "change"); bind("#flabel", "label", "change"); bind("#falerts", "alerts", "change");
  $$("[data-type]", root).forEach((b) => b.onclick = () => { const t = b.dataset.type; F.types = F.types.includes(t) ? F.types.filter((x) => x !== t) : [...F.types, t]; b.classList.toggle("on"); paint(); });
  $$("[data-quick]", root).forEach((b) => b.onclick = () => {
    const v = b.dataset.quick; F.to = v === "all" ? "" : localDate(new Date());
    F.from = v === "all" ? "" : v === "today" ? localDate(new Date()) : localDate(daysAgo(+v - 1));
    $("#ffrom").value = F.from; $("#fto").value = F.to; paint();
  });
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
        <dl class="kv">
          <div><dt>Date</dt><dd>${fmtDate(rec.createdAt)}</dd></div><div><dt>Time</dt><dd>${localTime(rec.createdAt)}</dd></div>
          <div><dt>Confidence</dt><dd>${confBar(rec.confidence)}</dd></div><div><dt>Duration</dt><dd>${fmtDur(rec.duration)}</dd></div>
          <div><dt>Words / tokens</dt><dd>${rec.tokens ?? "–"}</dd></div><div><dt>Source</dt><dd>${esc(rec.source)}${rec.classifiedBy ? ` · ${esc(rec.classifiedBy)}` : ""}</dd></div>
          <div><dt>File</dt><dd title="${esc(rec.fileName)}">${esc(rec.fileName || "–")}</dd></div><div><dt>Language</dt><dd>${esc(rec.language || "–")}</dd></div>
        </dl>
        ${audioUrl ? `<audio controls src="${audioUrl}" style="width:100%"></audio>` : ""}
        <div class="card card-pad"><div class="lbl" style="margin-bottom:6px">Summary</div><div class="summary">${esc(rec.summary || "No summary returned.")}</div>
          <div class="lbl" style="margin:14px 0 6px">Transcript</div><div class="quote">${esc(rec.transcript || "No transcript.")}</div></div>
        <div class="card card-pad"><div class="lbl" style="margin-bottom:8px">Labels</div>
          <div class="row" style="gap:6px">${labelChips(rec, true)}</div>
          <form class="row" id="labelForm" style="margin-top:12px"><input class="input" id="labelInput" placeholder="Add a label, e.g. reported-to-police" maxlength="40" style="flex:1"><button class="btn btn-soft">${icon("tag")}Add</button></form></div>
        <div class="card card-pad"><div class="row"><div class="lbl">Alerts</div><div class="spacer"></div>${rec.isFraud ? `<button class="btn btn-sm" id="reroute">Re-run routing</button>` : ""}</div>
          ${rec.notifications.length ? rec.notifications.map((n) => notifRow(n, rec)).join("") : `<div class="faint" style="margin-top:6px">No alerts for this call.</div>`}</div>
        <div class="card card-pad"><div class="lbl" style="margin-bottom:8px">Review</div>
          <div class="row"><select class="input" id="override" style="flex:1">${CODES.map((c) => `<option value="${c}" ${c === rec.category ? "selected" : ""}>${c} · ${esc(CATS[c].name)}</option>`).join("")}</select>
          <button class="btn" id="applyOverride">Correct type</button></div>
          <div class="row" style="margin-top:12px"><button class="btn btn-soft" id="markReviewed">${icon("check")}${rec.reviewed ? "Mark unreviewed" : "Mark reviewed"}</button>
          <button class="btn btn-sm btn-ghost" id="dlJson">${icon("download")}Download JSON</button><div class="spacer"></div>
          <button class="btn btn-sm btn-ghost btn-danger" id="delCall">${icon("trash")}Delete</button></div></div>
      </div>`;
    $("#drClose").onclick = close;
    $("#labelForm").onsubmit = async (e) => { e.preventDefault(); const v = $("#labelInput").value.trim().toLowerCase().replace(/\s+/g, "-"); if (v && !rec.userLabels.includes(v)) { rec.userLabels.push(v); await saveRecord(rec); } paint(); };
    $$("[data-rmlabel]", dr).forEach((x) => x.onclick = async () => { rec.userLabels = rec.userLabels.filter((l) => l !== x.dataset.rmlabel); await saveRecord(rec); paint(); });
    $("#markReviewed").onclick = async () => { rec.reviewed = !rec.reviewed; if (rec.reviewed) rec.userLabels = [...new Set([...rec.userLabels, "reviewed"])]; else rec.userLabels = rec.userLabels.filter((l) => l !== "reviewed"); await saveRecord(rec); paint(); };
    $("#applyOverride").onclick = async () => {
      const code = $("#override").value; if (code === rec.category) return;
      const wasFraud = rec.isFraud;
      Object.assign(rec, { category: code, categoryName: CATS[code].name, isFraud: code !== "F0", isBanking: CATS[code].banking, risk: CATS[code].risk, classifiedBy: "manual review" });
      rec.labels = autoLabels(rec); rec.userLabels = [...new Set([...rec.userLabels, "corrected"])];
      await saveRecord(rec);
      if (rec.isFraud && await modal({ title: "Send alerts for the corrected type?", body: `Routing will run again for <b>${code} · ${esc(CATS[code].name)}</b>.${wasFraud ? " Earlier alerts stay in the log." : ""}`, confirm: "Send alerts", cancel: "Not now" })) {
        rec.notifications = [...rec.notifications, ...planAlerts(rec)]; await dispatchAlerts(rec); await saveRecord(rec);
      }
      paint(); refreshUnder();
    };
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
    <p class="section-intro">Every alert CallGuard planned for a fraud call. Without a notifier service, emails wait in the outbox: open each one in your mail app with a click. In Live mode with a notifier URL they are sent automatically.</p>
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
    <p class="section-intro">Tell CallGuard who to warn. Banking fraud goes to the bank your nominee adds, other fraud goes to the nominee, and every fraud also goes to your authorised people (or your emergency contact if you have none).</p>
    <div class="grid g-2">
      <div class="card contact-card"><div class="c-head"><span class="c-icon">${icon("users")}</span><div><h3>You (account holder)</h3><div class="faint" style="font-size:12.5px">Shown in alerts so people know whose call it was</div></div></div>
        <div class="form-grid">${inp("user.name", "Full name", "text", "Your name")}${inp("user.email", "Email", "email", "you@example.com")}${inp("user.phone", "Phone", "tel", "+1 …")}</div></div>
      <div class="card contact-card"><div class="c-head"><span class="c-icon lav">${icon("users")}</span><div><h3>Nominee</h3><div class="faint" style="font-size:12.5px">Gets a notification + email for non-banking fraud (F3–F9)</div></div></div>
        <div class="form-grid">${inp("nominee.name", "Name", "text", "e.g. Priya Sharma")}${inp("nominee.relation", "Relation", "text", "Daughter, spouse…")}${inp("nominee.email", "Email", "email", "nominee@example.com")}${inp("nominee.phone", "Phone", "tel", "+1 …")}</div></div>
      <div class="card contact-card"><div class="c-head"><span class="c-icon sand">${icon("bank")}</span><div><h3>Bank fraud desk</h3><div class="faint" style="font-size:12.5px">Added by the nominee · emailed for banking fraud (F1, F2)</div></div></div>
        ${!nomineeReady ? `<div class="banner warn" style="margin-bottom:12px">${icon("alert")}<div>Add a nominee first. The nominee adds the bank.</div></div>` : ""}
        <div class="form-grid">${inp("bank.name", "Bank name", "text", "e.g. Chase", !nomineeReady)}${inp("bank.email", "Fraud-desk email", "email", "fraud@bank.com", !nomineeReady)}${inp("bank.branch", "Branch / notes", "text", "Optional", !nomineeReady)}
          <div class="field"><label>Added by</label><input class="input" disabled value="${esc(C.bank.addedBy || (nomineeReady ? C.nominee.name || C.nominee.email : "–"))}"></div></div>
        <div class="faint" style="font-size:12px;margin-top:10px">Never store account numbers here. The alert only carries the call summary and token.</div></div>
      <div class="card contact-card"><div class="c-head"><span class="c-icon rose">${icon("alert")}</span><div><h3>Emergency contact</h3><div class="faint" style="font-size:12.5px">Default: emailed for every fraud when no authorised person is set</div></div></div>
        <div class="form-grid">${inp("emergency.name", "Name", "text", "e.g. Rahul")}${inp("emergency.email", "Email", "email", "emergency@example.com")}${inp("emergency.phone", "Phone", "tel", "+1 …")}</div></div>
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

  $$("[data-path]", root).forEach((el) => el.addEventListener("change", () => {
    const [a, b] = el.dataset.path.split(".");
    const v = el.value.trim();
    if (el.type === "email" && v && !isEmail(v)) { toast("That email address doesn't look right", "alert"); el.focus(); return; }
    C[a][b] = v;
    if (a === "nominee" && C.bank.email) C.bank.addedBy = C.nominee.name || C.nominee.email;
    if (a === "bank") C.bank.addedBy = C.nominee.name || C.nominee.email;
    saveContacts(); toast("Saved"); VIEWS.contacts(root);
  }));
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
    <p class="section-intro">CallGuard is sold as a service: pick a plan per workspace. Usage counts real and demo analyses this month (sample history is not counted).</p>
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
  const live = st.mode === "live";
  root.innerHTML = `
    <div class="grid g-2">
      <div class="card card-pad stack">
        <div><h3>Services</h3><div class="faint" style="font-size:12.5px;margin-top:2px">Connect your transcriber and trained model. Demo mode simulates both.</div></div>
        <div class="seg" id="modeSeg"><button data-m="demo" class="${!live ? "on" : ""}">Demo</button><button data-m="live" class="${live ? "on" : ""}">Live services</button></div>
        <div class="field"><label for="sTr">Transcriber microservice URL</label><input class="input" id="sTr" data-k="transcriberUrl" placeholder="https://your-host/transcribe" value="${esc(st.transcriberUrl)}">
          <span class="hint">POST multipart <span class="mono">file</span> + <span class="mono">call_token</span>. Returns JSON with <span class="mono">transcript</span>, <span class="mono">summary</span> and optionally <span class="mono">category</span> / <span class="mono">confidence</span>.</span></div>
        <div class="field"><label for="sCl">Classifier URL (your trained model, optional)</label><input class="input" id="sCl" data-k="classifierUrl" placeholder="https://your-host/classify" value="${esc(st.classifierUrl)}">
          <span class="hint">Used only when the transcriber does not return a category. POST JSON <span class="mono">{transcript, summary, call_token}</span> → <span class="mono">{category: "F0".."F9", confidence}</span>.</span></div>
        <div class="field"><label for="sNo">Notifier URL (email / push, optional)</label><input class="input" id="sNo" data-k="notifierUrl" placeholder="https://your-host/notify" value="${esc(st.notifierUrl)}">
          <span class="hint">POST JSON <span class="mono">{to, role, channel, subject, body, call_token, category}</span> per alert. Without it, emails go to the outbox.</span></div>
        <div class="form-grid">
          <div class="field"><label for="sKey">API key (sent as Bearer)</label><input class="input" id="sKey" type="password" data-k="apiKey" value="${esc(st.apiKey)}" autocomplete="off"></div>
          <div class="field"><label for="sTo">Timeout (seconds)</label><input class="input" id="sTo" type="number" min="10" max="900" data-k="timeoutSec" value="${esc(st.timeoutSec)}"></div>
        </div>
        <div class="row"><button class="btn" id="testConn">Test transcriber</button><span class="faint" id="testOut" style="font-size:12.5px"></span></div>
      </div>
      <div class="stack">
        <div class="card card-pad stack">
          <div class="row"><span class="avatar" style="width:40px;height:40px">${esc(initials(S.user.name))}</span>
            <div><h3>${esc(S.user.name)}</h3><div class="faint" style="font-size:12.5px">@${esc(S.user.id)}${S.user.email ? ` · ${esc(S.user.email)}` : ""} · member since ${fmtDate(S.user.createdAt)}</div></div>
            <div class="spacer"></div><button class="btn btn-sm" id="logout2">${icon("logout")}Log out</button></div>
          ${S.user.googleSub ? `<div class="row faint" style="font-size:12.5px">${GOOGLE_G} Signed in with Google${S.user.hash ? " · password also set" : ""}</div>` : ""}
          <form class="form-grid" id="pwForm" style="grid-template-columns:${S.user.hash ? "1fr 1fr auto" : "1fr auto"};align-items:end">
            ${S.user.hash ? `<div class="field"><label for="pwCur">Current password</label><input class="input" id="pwCur" type="password" autocomplete="current-password" required></div>` : ""}
            <div class="field"><label for="pwNew">${S.user.hash ? "New password" : "Set a password (to also log in with your user ID)"}</label><input class="input" id="pwNew" type="password" autocomplete="new-password" required></div>
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
          <div class="row"><button class="btn" id="seed">Load sample history</button><button class="btn" id="backup">${icon("download")}Backup (JSON)</button>
            <label class="btn">Restore<input type="file" id="restore" accept="application/json" hidden></label></div>
          <div class="row"><button class="btn btn-ghost btn-danger" id="clearSample">Remove sample data</button><button class="btn btn-ghost btn-danger" id="wipe">${icon("trash")}Delete all data</button></div>
        </div>
      </div>
    </div>`;

  $("#logout2").onclick = () => auth.logout();
  $("#pwForm").onsubmit = async (e) => {
    e.preventDefault();
    try { await auth.changePassword(S.user.id, $("#pwCur")?.value || "", $("#pwNew").value); S.user = auth.users()[S.user.id]; toast("Password saved"); VIEWS.settings(root); }
    catch (ex) { toast(ex.message, "alert"); }
  };
  $("#modeSeg").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.m === "live" && !st.transcriberUrl) toast("Add the transcriber URL so live calls can be analysed", "alert");
    st.mode = b.dataset.m; saveSettings(); VIEWS.settings(root);
  };
  $$("[data-k]", root).forEach((el) => el.addEventListener("change", () => {
    const k = el.dataset.k; let v = el.value.trim();
    if (k.endsWith("Url") && v && !/^https?:\/\//i.test(v)) { toast("URLs must start with http:// or https://", "alert"); return; }
    if (k === "timeoutSec") v = Math.max(10, Math.min(900, +v || 120));
    st[k] = v; saveSettings(); toast("Saved");
  }));
  $("#sNotif").onchange = async (e) => {
    if (e.target.checked && "Notification" in window && Notification.permission !== "granted") {
      const p = await Notification.requestPermission(); if (p !== "granted") { e.target.checked = false; toast("Notifications were blocked", "alert"); return; }
    }
    st.browserNotify = e.target.checked; saveSettings();
  };
  $("#testConn").onclick = async () => {
    const out = $("#testOut");
    if (!st.transcriberUrl) { out.textContent = "Set the URL first."; return; }
    out.textContent = "Checking…";
    try { const r = await fetch(st.transcriberUrl, { method: "OPTIONS", headers: authHeaders() }); out.textContent = `Reachable (HTTP ${r.status}).`; }
    catch (e) { out.textContent = `Not reachable from the browser: ${e.message}. Check the URL and that the service allows CORS from this site.`; }
  };
  const pd = $("#pickDir"); if (pd) pd.onclick = async () => { try { await folder.connect(); VIEWS.settings(root); } catch (e) { if (e.name !== "AbortError") toast(e.message, "alert"); } };
  const sn = $("#syncNow"); if (sn) sn.onclick = async () => { try { await folder.syncAll(); } catch (e) { toast(e.message, "alert"); } };
  $("#seed").onclick = seedSamples;
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
  $("#clearSample").onclick = async () => {
    const n = S.calls.filter((c) => c.source === "sample");
    if (!n.length) return toast("No sample data to remove");
    for (const c of n) await idb.del(c.id);
    S.calls = S.calls.filter((c) => c.source !== "sample"); paintChrome(); toast(`Removed ${n.length} sample calls`);
  };
  $("#wipe").onclick = async () => {
    if (!await modal({ title: "Delete all CallGuard data?", body: `This removes all <b>${S.calls.length}</b> calls, audio, contacts and settings from this browser. It cannot be undone. Files in your history folder are not touched.`, confirm: "Delete everything", danger: true })) return;
    await idb.clear(); try { Object.keys(localStorage).filter((k) => k.startsWith(`cg.u.${NS}.`)).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
    location.reload();
  };
};

/* ============================== sample history ============================== */
async function seedSamples() {
  const C = S.contacts;
  if (!C.nominee.name && !C.nominee.email && !C.authorised.length && !C.emergency.email) {
    Object.assign(C, {
      nominee: { name: "Priya Sharma", email: "priya.sharma@example.com", phone: "", relation: "Daughter" },
      bank: { name: "Example Bank fraud desk", email: "fraud-desk@examplebank.example", branch: "", addedBy: "Priya Sharma" },
      emergency: { name: "Rahul Verma", email: "rahul.verma@example.com", phone: "" },
      authorised: [{ id: uid(), name: "Dr. Anita Rao", email: "anita.rao@example.com", relation: "Caregiver" }],
    });
    saveContacts();
  }
  const weights = { F0: 14, F1: 5, F2: 3, F3: 3, F4: 3, F5: 2, F6: 3, F7: 2, F8: 3, F9: 3 };
  const bag = Object.entries(weights).flatMap(([k, w]) => Array(w).fill(k));
  const n = 42;
  for (let i = 0; i < n; i++) {
    const code = bag[Math.floor(Math.random() * bag.length)];
    const s = D.samples.find((x) => x.category === code);
    const d = daysAgo(Math.floor(Math.random() * 21)); d.setHours(8 + Math.floor(Math.random() * 14), Math.floor(Math.random() * 60));
    const tr = normalise({ transcript: s.transcript, summary: s.summary, duration: s.duration + Math.round(Math.random() * 40 - 20), language: "en" });
    const rec = buildRecord({ token: makeToken(d), createdAt: d.toISOString(), fileName: `call-${localDate(d)}-${i + 1}.mp3`, tr,
      cls: { category: code, confidence: Math.min(0.99, Math.max(0.52, s.confidence + (Math.random() * 0.16 - 0.08))), by: "sample" }, source: "sample" });
    rec.notifications = planAlerts(rec).map((x) => ({ ...x, status: x.status === "pending" ? (x.channel === "in-app" ? "delivered" : Math.random() < 0.75 ? "sent" : "queued") : x.status, at: d.toISOString() }));
    if (Math.random() < 0.15) rec.userLabels.push(rec.isFraud ? "reported" : "family");
    await idb.put(rec); S.calls.push(rec);
  }
  S.calls.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  paintChrome(); toast(`Loaded ${n} sample calls`); route();
}

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
  logout() { try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* ignore */ } GLS.del("session"); location.hash = ""; location.reload(); },
};

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
      callback: (resp) => { try { onDone(this.accountFrom(resp.credential)); } catch (e) { onError(e.message); } },
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
    <div class="auth-card card">
      <div class="brand" style="padding:0 0 14px"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="9"/><path d="M16 6l8 3v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V9z"/></svg></span>
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
      <div class="faint" style="font-size:12px;margin-top:14px;text-align:center">Your call history is stored privately in this browser on this device.</div>
    </div>`;
  $$("[data-mode]", box).forEach((a) => a.onclick = (e) => { e.preventDefault(); authScreen(a.dataset.mode); });
  const err = (m) => { const e = $("#authErr"); e.hidden = !m; e.innerHTML = m ? `${icon("alert")}<div>${esc(m)}</div>` : ""; };
  google.mount($("#gBox"), mode, async (u) => {
    err(""); auth.startSession(u, true);
    await startApp(u, true);
    if (u._new) toast(`Account created with ${u.email}`, "check");
  }, err);
  $("#authForm").onsubmit = async (e) => {
    e.preventDefault(); err("");
    const btn = $("#authSubmit"); btn.disabled = true; const label = btn.textContent; btn.innerHTML = `<span class="spin"></span>`;
    try {
      if (mode === "signup") {
        if ($("#suPw").value !== $("#suPw2").value) throw new Error("The two passwords don't match.");
        const u = await auth.signup({ name: $("#suName").value, email: $("#suEmail").value, id: $("#suId").value, password: $("#suPw").value });
        authScreen("login", `Account <b>${esc(u.id)}</b> created. Log in with your user ID and password.`);
        $("#liId").value = u.id; $("#liPw").focus();
        return;
      }
      const u = await auth.login($("#liId").value, $("#liPw").value);
      auth.startSession(u, $("#liRemember").checked);
      await startApp(u, true);
    } catch (ex) { err(ex.message); btn.disabled = false; btn.textContent = label; }
  };
}

/* ============================== boot ============================== */
async function startApp(user, fresh = false) {
  S.user = user; NS = user.id;
  S.settings = { ...DEFAULT_SETTINGS, ...LS.get("settings", {}) };
  S.contacts = { ...JSON.parse(JSON.stringify(DEFAULT_CONTACTS)), ...LS.get("contacts", {}) };
  if (!S.contacts.user.name && !S.contacts.user.email) { S.contacts.user = { name: user.name, email: user.email, phone: "" }; saveContacts(); }
  S.filters = LS.get("filters", null);
  try { S.calls = (await idb.all()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); } catch { S.calls = []; }
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
}

function boot() {
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
