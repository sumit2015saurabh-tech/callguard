/* CallGuard content script.

   On web.telegram.org and web.whatsapp.com it shows a small dock that captures the live call
   (the audio itself is recorded by the offscreen document; this only drives it), and reads the
   caller's phone number (and name) off the call screen so the dashboard knows who called and from where.

   On the CallGuard dashboard it is a bridge: it receives a captured clip from the service
   worker and posts it into the page, because only page code can save a call to the dashboard's
   history. The page answers over window.postMessage. */
(() => {
  "use strict";
  if (globalThis.__callguardInstalled) return;
  globalThis.__callguardInstalled = true;

  const PLATFORM_NAME = { telegram: "Telegram", whatsapp: "WhatsApp" };
  const platform = /(^|\.)web\.telegram\.org$/.test(location.hostname) ? "telegram"
    : /(^|\.)web\.whatsapp\.com$/.test(location.hostname) ? "whatsapp" : "";
  const onCallSite = !!platform;
  const onDashboard = !onCallSite;

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const fmtDur = (s) => `${Math.floor(Math.max(0, s) / 60)}:${pad(Math.round(Math.max(0, s) % 60))}`;
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  /* ---------- caller identity (best effort, read off the call screen) ---------- */
  const CALLER_BLOCK = /^(voice call|video call|incoming call|outgoing call|calling|ringing|connecting|reconnecting|call ended|end call|decline|accept|answer|mute|unmute|speaker|video|screen share|screen sharing|camera|chat|more|back|close|settings|whatsapp|whatsapp web|telegram|telegram web|end-to-end encrypted)$/i;

  function tidyCallerName(raw) {
    let s = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
    if (!s) return "";
    s = s.replace(/\s*[·•|]\s*(voice|video)?\s*call\b.*$/i, "").trim();
    s = s.replace(/\b(calling|ringing|connecting|reconnecting|call ended)\b.*$/i, "").trim();
    s = s.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/, "").trim();
    if (!s || s.length > 64) return "";
    if (CALLER_BLOCK.test(s)) return "";
    if (/^[\d\s()+.-]+$/.test(s)) return "";            // a bare number is handled separately
    return s;
  }

  /** A phone number in text, reduced to digits (leading + kept), or "" when it isn't plausible. */
  function phoneOf(text) {
    const raw = String(text == null ? "" : text).replace(/[\u200e\u200f\u202a-\u202e]/g, "").replace(/\s+/g, " ").trim();
    if (!raw || raw.length > 60) return "";
    const m = raw.match(/(?:\+|00)?\d[\d\s().-]{4,}\d/);
    if (!m) return "";
    let digits = m[0].replace(/[^\d+]/g, "");
    if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
    const count = digits.replace(/\D/g, "").length;
    if (count < 7 || count > 15 || !/^\+?\d+$/.test(digits)) return "";
    return digits;
  }

  function callerFrom(text) {
    const raw = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    if (!raw || raw.length > 120) return null;
    const number = phoneOf(raw);
    const name = tidyCallerName(raw);
    return name || number ? { name, number } : null;
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity) > 0.1;
  }

  /** Big visible elements that could be the call screen (Telegram names its classes, WhatsApp does not). */
  function callPanels() {
    const out = [];
    const add = (el) => {
      if (!(el instanceof HTMLElement) || el.closest("#callguard-dock") || out.includes(el)) return;
      out.push(el);
    };
    for (const sel of ['[data-testid="call-screen" i]', '[data-testid="call-info" i]', '[class*="call-screen" i]',
                       '[class*="call-interface" i]', '[class*="call-panel" i]', '[role="dialog"]',
                       '[class*="call" i]', '[id*="call" i]']) {
      let found;
      try { found = document.querySelectorAll(sel); } catch { continue; }
      for (const el of found) add(el);
    }
    return out.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 160 && r.height >= 120;
    }).slice(0, 12);
  }

  /* Where the peer's number can live: the call screen, the open contact/profile panel, the chat
     header. Chat bubbles are excluded so a number pasted in the conversation can't be picked up. */
  const PHONE_SCOPES = [
    '[data-testid="call-screen" i]', '[data-testid="call-info" i]', '[class*="call-screen" i]',
    '[class*="call-interface" i]', '[class*="call-panel" i]', '[class*="call" i]', '[role="dialog"]',
    '[data-testid="contact-info-drawer"]', '[class*="contact-info" i]', '[class*="profile" i]',
    '[class*="peer-info" i]', '[class*="info-panel" i]', '#column-right', '#right-column', '.Profile',
    '#main header', '[data-testid="conversation-info-header"]',
  ];
  const CHAT_BUBBLE = '[data-testid*="msg" i],[class*="message" i],[class*="bubble" i],[class*="chat-history" i]';

  /** The number that is calling: a tel: link first, then the open call/contact panel. */
  function findNumber() {
    try {
      for (const a of document.querySelectorAll('a[href^="tel:" i]')) {
        if (!(a instanceof HTMLElement) || a.closest("#callguard-dock") || a.closest(CHAT_BUBBLE)) continue;
        if (!visible(a)) continue;
        const n = phoneOf(String(a.getAttribute("href")).replace(/^tel:/i, ""));
        if (n) return n;
      }
    } catch { /* ignore */ }
    let budget = 3000;                            // the selectors below can match a lot of nodes
    for (const sel of PHONE_SCOPES) {
      let scopes;
      try { scopes = document.querySelectorAll(sel); } catch { continue; }
      for (const scope of scopes) {
        if (!(scope instanceof HTMLElement) || scope.closest("#callguard-dock")) continue;
        for (const el of scope.querySelectorAll("[title],a,span,div")) {
          if (--budget < 0) return "";
          if (el.children.length || el.closest(CHAT_BUBBLE) || el.closest("#callguard-dock")) continue;
          if (!visible(el)) continue;
          const n = phoneOf(el.getAttribute("title") || el.textContent);
          if (n) return n;
        }
      }
    }
    return "";
  }

  function findCaller() {
    const texts = [];
    for (const panel of callPanels()) {
      for (const el of panel.querySelectorAll("[title]")) texts.push(el.getAttribute("title"));
      for (const el of panel.querySelectorAll('h1,h2,h3,strong,b,[class*="peer-title" i],[class*="name" i],[class*="title" i]')) {
        if (el.children.length <= 1) texts.push(el.textContent);
      }
      for (const el of panel.querySelectorAll("span,div")) {
        if (!el.children.length) texts.push(el.textContent);
        if (texts.length > 80) break;
      }
      if (texts.length) break;
    }
    if (!texts.length) {                          // fall back to the open chat's header
      for (const sel of ["#main header [title]", '[data-testid="conversation-info-header-chat-title"]', '[class*="peer-title" i]']) {
        let found;
        try { found = document.querySelectorAll(sel); } catch { continue; }
        for (const el of found) { texts.push(el.getAttribute("title") || el.textContent); break; }
        if (texts.length) break;
      }
    }
    const caller = { name: "", number: "" };
    for (const text of texts) {
      const c = callerFrom(text);
      if (!c) continue;
      if (c.name && !caller.name) caller.name = c.name;
      if (c.number && !caller.number) caller.number = c.number;
    }
    /* The call screen often shows only the saved contact's name, so look for the calling number
       separately and let it lead the caller ID. */
    if (!caller.number) caller.number = findNumber();
    return {
      ...caller,
      label: caller.number ? (caller.name ? `${caller.number} · ${caller.name}` : caller.number) : caller.name,
    };
  }

  /* ============================ dashboard bridge ============================ */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "cg:ping") { sendResponse({ ok: true, platform, telegram: platform === "telegram" }); return; }
    if (msg.type === "cg:caller-info") {
      sendResponse({ ok: true, platform, caller: onCallSite ? findCaller() : { name: "", number: "", label: "" } });
      return;
    }
    if (msg.type !== "cg:dashboard-import") return;
    if (!onDashboard) { sendResponse({ ok: false, reason: "This tab isn't the CallGuard dashboard." }); return; }
    importClip(msg.clip).then(sendResponse, (e) => sendResponse({ ok: false, reason: (e && e.message) || String(e) }));
    return true;
  });

  function importClip(clip) {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      let timer = 0;
      const onMessage = (e) => {
        if (e.source !== window || e.origin !== location.origin) return;
        const d = e.data;
        if (!d || d.source !== "callguard-dashboard" || d.requestId !== requestId) return;
        cleanup();
        resolve(d.result || { ok: false, reason: "CallGuard sent no result." });
      };
      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
      }
      timer = setTimeout(() => {
        cleanup();
        resolve({ ok: false, reason: "CallGuard didn't answer in time. Open the dashboard, log in, then try again." });
      }, 90000);
      window.addEventListener("message", onMessage);
      window.postMessage({ source: "callguard-extension", type: "import-call", requestId, clip }, location.origin);
    });
  }

  if (!onCallSite) return;

  /* ============================ call dock ============================ */
  if (!document.body) {
    window.addEventListener("DOMContentLoaded", installDock, { once: true });
  } else {
    installDock();
  }

  function installDock() {
    const host = document.createElement("div");
    host.id = "callguard-dock";
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000;";
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .dock { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1d2b2a; }
        .pill, .panel { box-shadow: 0 10px 30px rgba(20, 40, 38, .22); border-radius: 14px; background: #fff; }
        .pill { display: flex; align-items: center; gap: 8px; border: 1px solid #d7e4df; padding: 8px 12px 8px 9px;
                cursor: pointer; font: inherit; font-weight: 650; color: #1d2b2a; }
        .pill:hover { border-color: #2f7f78; }
        .pill svg { width: 16px; height: 16px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #9db3ad; }
        .dot[data-on="1"] { background: #c0392b; animation: pulse 1.4s infinite; }
        @keyframes pulse { 50% { opacity: .35; } }
        .panel { width: 268px; padding: 12px; display: grid; gap: 9px; border: 1px solid #d7e4df; }
        .panel[hidden] { display: none; }
        .head { display: flex; align-items: center; gap: 6px; }
        .head b { flex: 1; font-size: 13px; }
        .x { border: 0; background: none; cursor: pointer; font-size: 16px; line-height: 1; color: #6b807b; padding: 2px 4px; }
        .state { color: #4f6260; }
        .meter { height: 4px; background: #eaf1ee; border-radius: 3px; overflow: hidden; }
        .meter span { display: block; height: 100%; width: 0; background: #2f7f78; transition: width .25s; }
        .meta { display: flex; justify-content: space-between; color: #6b807b; font-variant-numeric: tabular-nums; }
        .btn { width: 100%; height: 34px; border-radius: 9px; border: 1px solid #c9d7d1; background: #fff;
               font: inherit; font-weight: 650; cursor: pointer; color: #1d2b2a; }
        .btn.primary { background: #2f7f78; border-color: #2f7f78; color: #fff; }
        .btn.primary.stop { background: #c0392b; border-color: #c0392b; }
        .btn:disabled { opacity: .6; cursor: default; }
        .hint { color: #6b807b; font-size: 11.5px; }
        .hint b { color: #a32a2a; }
        .caller { color: #2f7f78; font-weight: 650; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .caller[hidden] { display: none; }
        .alert { border: 1px solid #f0c9c4; background: #fdf3f1; color: #8c2b22; border-radius: 10px;
                 padding: 8px; font-size: 11.5px; line-height: 1.45; }
        .alert[data-kind="warn"] { border-color: #edd9a8; background: #fffaf0; color: #6b5a33; }
        .alert[hidden] { display: none; }
        .confirm { border: 1px solid #f0d9a8; background: #fffaf0; border-radius: 10px; padding: 9px; display: grid; gap: 8px; }
        .confirm p { margin: 0; font-size: 11.5px; color: #6b5a33; }
        .confirm .row { display: flex; gap: 6px; }
        .confirm .row button { flex: 1; height: 30px; border-radius: 8px; border: 1px solid #d9c69a; background: #fff; font: inherit; cursor: pointer; }
        .confirm .row button.go { background: #8a6d2f; border-color: #8a6d2f; color: #fff; font-weight: 650; }
        .foot { display: flex; justify-content: space-between; font-size: 11.5px; }
        .foot a { color: #2f7f78; text-decoration: none; font-weight: 600; }
        .foot a:hover { text-decoration: underline; }
      </style>
      <div class="dock">
        <button class="pill" id="pill" title="CallGuard">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l7.5 3v5.6c0 4.6-3.2 8.2-7.5 9.4-4.3-1.2-7.5-4.8-7.5-9.4V5.5z" fill="#2f7f78"/><path d="M8.7 11.8l2.3 2.3 4.4-4.6" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>CallGuard</span>
          <span class="dot" id="dot"></span>
        </button>
        <div class="panel" id="panel" hidden>
          <div class="head"><b id="title">Call</b><button class="x" id="close" aria-label="Close">✕</button></div>
          <div class="state" id="state">Checking…</div>
          <div class="caller" id="caller" hidden></div>
          <div class="alert" id="alert" data-kind="fraud" hidden></div>
          <div class="meter"><span id="lvl"></span></div>
          <div class="meta"><span id="timer">0:00</span><span id="clips">0 clips</span></div>
          <button class="btn primary" id="btn">Capture this call</button>
          <div class="confirm" id="confirm" hidden>
            <p>Recording a call can need everyone's consent. Make sure everyone on the call agrees before you start.</p>
            <div class="row"><button id="cancel">Cancel</button><button class="go" id="agree">I agree, start</button></div>
          </div>
          <div class="hint" id="hint">Voice clips are saved in this extension.</div>
          <div class="foot"><a id="dash" href="#" target="_blank" rel="noopener">Open CallGuard</a><span id="auto"></span></div>
        </div>
      </div>`;

    const $ = (s) => root.querySelector(s);
    let live = { active: false };
    let settings = null;
    let callActive = false;
    let callSeen = false;
    let quietMs = 0;
    let confirming = false;
    let busy = false;
    let hint = "";
    let alertShown = "";
    let consent = false;
    let caller = { name: "", number: "", label: "" };
    let callerAt = 0;

    chrome.storage.local.get("cgConsent")
      .then((v) => { consent = !!(v && v.cgConsent); paint(); })
      .catch(() => {});

    $("#pill").onclick = () => {
      $("#panel").hidden = !$("#panel").hidden;
      if (!$("#panel").hidden) poll();
    };
    $("#close").onclick = () => { $("#panel").hidden = true; };
    /* A part that came back as fraud is pushed straight from the service worker. */
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== "cg:call-alert" || !msg.alert) return;
      live.lastResult = msg.alert;
      paint();
    });
    $("#cancel").onclick = () => { confirming = false; paint(); };
    $("#agree").onclick = async () => {
      consent = true;
      confirming = false;
      chrome.storage.local.set({ cgConsent: true }).catch(() => {});
      await start();
    };
    $("#btn").onclick = async () => {
      if (live.active) {
        busy = true; paint();
        const res = await send({ type: "cg:stop", reason: "stopped from Telegram" });
        busy = false;
        if (res && !res.ok) hint = res.reason || "Couldn't stop the capture.";
        await poll();
      } else if (!consent) {
        confirming = true; paint();
      } else {
        await start();
      }
    };

    async function start() {
      if (busy) return;
      busy = true; hint = "";
      paint();
      const res = await send({ type: "cg:start" });
      busy = false;
      if (!res || !res.ok) hint = (res && res.reason) || "Couldn't start the capture.";
      await poll();
    }

    /* A live call shows a large visible element whose class or id mentions "call" — or, on
       WhatsApp, a visible hang-up control (its class names are generated). */
    function detectCall() {
      let nodes;
      try { nodes = document.querySelectorAll('[class*="call" i],[id*="call" i],[data-testid*="call" i]'); } catch { nodes = []; }
      for (const el of nodes) {
        if (!(el instanceof HTMLElement) || el === host || host.contains(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 140) continue;
        const st = getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) < 0.1) continue;
        return true;
      }
      try {
        for (const el of document.querySelectorAll('[aria-label*="end call" i],[aria-label*="hang up" i],[data-icon*="end-call" i],[data-testid*="end-call" i]')) {
          if (el instanceof HTMLElement && !host.contains(el) && visible(el)) return true;
        }
      } catch { /* ignore */ }
      return false;
    }

    async function poll() {
      const res = await send({ type: "cg:status" });
      if (res && res.ok) {
        live = res.live || { active: false };
        settings = res.settings || settings;
      }
      callActive = detectCall();
      if (callActive && Date.now() - callerAt > 3000) {
        callerAt = Date.now();
        const found = findCaller();
        if (found.label && found.label !== caller.label) {
          caller = found;
          send({ type: "cg:caller", caller: { name: found.name, number: found.number } });
        }
      }
      if (live.active && callActive) callSeen = true;
      if (live.active && callSeen && !callActive && settings && settings.autoStop !== false) {
        quietMs += 1500;
        if (quietMs > 6000) {
          quietMs = 0; callSeen = false;
          await send({ type: "cg:stop", reason: "call ended" });
          await poll();
          return;
        }
      } else if (callActive) {
        quietMs = 0;
      }
      paint();
    }

    function paintTimer() {
      const t = live.active && live.startedAt ? (Date.now() - Date.parse(live.startedAt)) / 1000 : 0;
      $("#timer").textContent = fmtDur(t);
    }

    function paint() {
      const on = !!live.active;
      const n = Number(live.clips || 0);
      const name = PLATFORM_NAME[platform] || "Call";
      $("#title").textContent = `${name} call`;
      $("#dot").dataset.on = on ? "1" : "0";
      const mic = on && live.mic ? " · mic on" : "";
      $("#state").textContent = (on
        ? (live.speech ? "Recording · voice detected" : "Recording · quiet")
        : (callActive ? `${name} call detected` : `No ${name} call detected`)) + mic;
      $("#caller").hidden = !caller.label;
      $("#caller").textContent = caller.label ? `Caller ID: ${caller.label}` : "";
      $("#caller").title = caller.number ? `Calling number ${caller.number}` : "";
      const parts = Number(live.parts || 0);
      $("#clips").textContent = live.keepFullCall
        ? (parts ? `one recording · ${parts} part${parts === 1 ? "" : "s"}` : "one recording")
        : `${n} clip${n === 1 ? "" : "s"}`;
      /* The message back to the call: a fraud part, or a call that has simply run long. */
      const secs = on && live.startedAt ? (Date.now() - Date.parse(live.startedAt)) / 1000 : 0;
      const warnSec = Number(live.longCallWarnSec || 300);
      const res = live.lastResult;
      let alertText = "";
      let alertKind = "fraud";
      if (on && res && res.isFraud) {
        alertText = `CallGuard flagged part ${parts} of this call as ${res.categoryName || res.category || "fraud"}. It may be a scam — stop and verify before you share anything.`;
      } else if (on && secs >= warnSec) {
        alertKind = "warn";
        alertText = `This call has run ${fmtDur(secs)}${parts ? ` · ${parts} part${parts === 1 ? "" : "s"} analyzed` : ""}. Long calls are a common scam setup: confirm who is calling and keep payment details and codes out of it.`;
      }
      $("#alert").hidden = !alertText;
      $("#alert").dataset.kind = alertKind;
      $("#alert").textContent = alertText;
      /* The warning has to actually be seen: open the dock once per message, not on every tick. */
      const alertKey = !alertText ? "" : (on && res && res.isFraud ? `fraud:${res.token || res.at || parts}` : "long");
      if (alertKey && alertKey !== alertShown) {
        alertShown = alertKey;
        $("#panel").hidden = false;
      }
      $("#lvl").style.width = `${Math.round((live.level || 0) * 100)}%`;
      $("#btn").textContent = on ? "Stop capture" : "Capture this call";
      $("#btn").classList.toggle("stop", on);
      $("#btn").disabled = busy;
      $("#confirm").hidden = !confirming;
      $("#hint").innerHTML = hint ? `<b>${esc(hint)}</b>`
        : on ? "The call is saved in the extension as one recording; send it from the CallGuard popup or automatically."
             : "The other party's voice is captured from the tab. Nothing is sent anywhere until you send it.";
      $("#dash").href = (settings && settings.dashboardUrl) || "https://sumit2015saurabh-tech.github.io/callguard/";
      $("#auto").textContent = live.active && settings && settings.autoSend ? "auto-send on" : "";
      paintTimer();
    }

    /* Poll quickly while a capture is running or the panel is open, lazily when the tab is idle in
       the background, so an open Telegram tab doesn't keep waking the service worker. */
    async function loop() {
      await poll();
      const busy = live.active || callActive || !$("#panel").hidden;
      setTimeout(loop, busy ? 1500 : 5000);
    }
    setInterval(() => { if (live.active && !$("#panel").hidden) paintTimer(); }, 500);
    loop();
  }
})();
