/* CallGuard popup: live capture state and captured clips.
   Recording happens in the offscreen document, so closing this popup never stops a capture.
   There is no settings panel: every capture option is fixed on in lib/core.js. */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const store = self.CGStore;
  const core = self.CGCore;
  const DASH = core.SETTINGS_DEFAULTS.dashboardUrl;

  const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, reason: (e && e.message) || String(e) }));
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  /* Round once, up front: rounding only the seconds can show 0:60 or 1:60. */
  const fmtDur = (s) => {
    const total = Math.round(Math.max(0, Number(s) || 0));
    return `${Math.floor(total / 60)}:${pad(total % 60)}`;
  };
  const kb = (n) => (Number(n) > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((Number(n) || 0) / 1024))} KB`);
  const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const isCallTab = (tab) => !!tab && core.isCallUrl(tab.url);
  /* CallGuard has not received this recording yet: never analyzed and not already in the queue.
     A whole-call file longer than the dashboard's 120 s limit is kept local, not "unsent". */
  const isUnsent = (c) => !c.result && !c.queuedAt && c.skipWhy !== "too-long";

  let live = { active: false };
  let settings = { dashboardUrl: DASH, duplex: true };
  let askingMic = false;
  let activeTab = null;
  let callTabs = [];
  let clips = [];
  let signature = "";
  let renderSeq = 0;
  const urls = new Map();
  let toastTimer = 0;

  init();

  async function init() {
    bind();
    await refresh();
    setInterval(refresh, 1200);
    window.addEventListener("unload", () => urls.forEach((u) => URL.revokeObjectURL(u)));
  }

  async function refresh() {
    const [st, tabList, tabs] = await Promise.all([
      send({ type: "cg:status" }),
      chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []),
      chrome.tabs.query({ url: ["https://web.telegram.org/*", "https://web.whatsapp.com/*"] }).catch(() => []),
    ]);
    if (st && st.ok) {
      live = st.live || { active: false };
      if (st.settings) settings = { ...settings, ...st.settings };
    }
    activeTab = (tabList && tabList[0]) || null;
    callTabs = tabs || [];
    paintLive();
    await renderClips();
  }

  function paintLive() {
    const on = !!live.active;
    const n = Number(live.clips || 0);
    $("#pill").dataset.on = on ? "1" : "0";
    $("#pill").textContent = on ? "Recording" : "Idle";
    $("#liveTitle").textContent = on ? (live.speech ? "Recording · voice detected" : "Recording · quiet") : "Not capturing";
    $("#timer").textContent = fmtDur(on && live.startedAt ? (Date.now() - Date.parse(live.startedAt)) / 1000 : 0);
    $("#level").style.width = `${Math.round((live.level || 0) * 100)}%`;
    const parts = Number(live.parts || 0);
    $("#clipCount").textContent = live.keepFullCall
      ? (parts ? `single · ${parts} part${parts === 1 ? "" : "s"}` : "single recording")
      : `${n} clip${n === 1 ? "" : "s"}`;
    const mic = live.mic ? " · both voices" : live.duplex ? " · caller only (your mic is off)" : "";
    const caller = live.caller && live.caller.label ? ` · caller ${live.caller.label}` : "";
    $("#liveInfo").textContent = on
      ? (live.tabTitle ? `Capturing ${live.tabTitle}${caller}${mic}` : `Capturing the ${core.platformName(live.platform) || "call"} tab${caller}${mic}`)
      : isCallTab(activeTab) ? `${core.platformName(core.platformFor(activeTab.url)) || "Call"} tab ready to capture.` : callTabs.length ? "Switch to your call tab." : "Open web.telegram.org or web.whatsapp.com first.";
    $("#mainBtn").textContent = on ? "Stop capture" : "Capture this call";
    $("#mainBtn").classList.toggle("stop", on);
    $("#mainBtn").disabled = !on && !isCallTab(activeTab) && !callTabs.length;
    $("#note").hidden = !(on && live.micError);
    $("#note").textContent = on && live.micError ? `Your voice isn't being recorded: ${live.micError}` : "";
    /* Already allowed (it just couldn't join this running capture): no "Allow" button, the note says restart. */
    const micOff = on && settings.duplex !== false && !live.mic && live.micPerm !== "granted";
    $("#micBtn").hidden = !micOff;
    $("#micBtn").title = (on && live.micError) || "Chrome needs your OK once to record your side of the call.";
    $("#dashBtn").onclick = () => chrome.tabs.create({ url: settings.dashboardUrl || DASH });
  }

  async function renderClips() {
    try {
      /* 20-second analysis parts are sent and deleted behind the scenes: list recordings only. */
      clips = (await store.clips()).filter((c) => c.kind !== "chunk")
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    } catch { clips = []; }
    paintUnsent(clips.filter(isUnsent).length);
    const sig = clips.map((c) => `${c.id}:${c.result ? c.result.token || "r" : ""}:${c.queuedAt || ""}:${c.error || ""}:${c.autoSkipped || ""}:${c.skipWhy || ""}`).join("|");
    if (sig === signature) return;
    signature = sig;
    const list = $("#clips");
    list.innerHTML = "";
    $("#empty").hidden = clips.length > 0;
    for (const c of clips) list.appendChild(await clipRow(c));
  }

  /* "Send unsent" is a retry for recordings that never reached CallGuard: hidden when there are
     none, so the label only ever appears next to a real count. */
  function paintUnsent(n) {
    const btn = $("#sendAll");
    const note = $("#unsentNote");
    btn.hidden = n === 0;
    btn.textContent = n ? `Send ${n} unsent` : "Send unsent";
    btn.title = "Hands every recording CallGuard hasn't received yet to CallGuard. Recordings it has already analyzed are not sent again.";
    note.hidden = n === 0;
    note.textContent = n ? `${n} recording${n === 1 ? " hasn't" : "s haven't"} reached CallGuard yet.` : "";
  }

  async function clipRow(c) {
    const li = document.createElement("li");
    li.className = "clip";
    li.dataset.id = c.id;
    const st = clipStatus(c);
    /* Already analyzed, or too long to analyze at all: open the dashboard instead of re-sending. */
    const openInstead = !!(c.result || c.skipWhy === "too-long");
    const clarity = c.clarity
      ? `<div class="sub">Clarity ${c.clarity.score}/100 · ${esc(c.clarity.verdict)}${c.clarity.reasons.length ? ` (${esc(c.clarity.reasons.join(", "))})` : ""}</div>`
      : "";
    const origin = [
      c.platform ? `source ${core.platformName(c.platform)}` : "",
      c.caller && c.caller.label ? `caller ${c.caller.label}` : "",
    ].filter(Boolean).join(" · ");
    li.innerHTML = `
      <div class="row between">
        <span class="title">${esc(clock(c.createdAt))} <span class="sub">· ${esc(fmtDur(c.duration))} · ${esc(kb(c.size))}${c.kind === "call" ? " · whole call" : " · clip"}${c.mic ? " · mic" : ""}</span></span>
        <span class="chip ${st.cls}">${esc(st.text)}</span>
      </div>
      ${origin ? `<div class="sub">${esc(origin)}</div>` : ""}
      ${c.result ? `<div class="sub">${esc(resultLine(c.result))}</div>` : ""}
      ${c.error ? `<div class="sub err">${esc(c.error)}</div>` : ""}
      ${clarity}
      <audio controls preload="metadata"></audio>
      <div class="actions">
        ${c.queuedAt ? "" : `<button class="btn sm" data-act="${openInstead ? "open" : "send"}" title="${openInstead ? "Open CallGuard" : "Analyze this recording in CallGuard"}">${openInstead ? "Open CallGuard" : "Analyze"}</button>`}
        <button class="btn sm" data-act="download">Download</button>
        <button class="btn sm ghost" data-act="delete">Delete</button>
      </div>`;
    const audio = li.querySelector("audio");
    const url = await urlFor(c.id);
    if (url) audio.src = url; else audio.remove();
    return li;
  }

  function clipStatus(c) {
    if (c.result) {
      return c.result.isFraud
        ? { cls: "bad", text: c.result.category || "Fraud" }
        : { cls: "good", text: c.result.category || "Saved" };
    }
    if (c.queuedAt) return { cls: "warn", text: "Sending…" };
    if (c.skipWhy === "too-long") return { cls: "warn", text: "Too long · in parts" };
    if (c.autoSkipped) return { cls: "warn", text: "Unclear · not sent" };
    if (c.error) return { cls: "bad", text: "Not sent" };
    return { cls: "", text: "Local only" };
  }

  function resultLine(r) {
    const bits = [];
    if (r.category) bits.push(`${r.category} · ${r.categoryName || "saved"}`);
    if (r.token) bits.push(r.token);
    if (r.alerts) bits.push(`${r.alerts} alert${r.alerts === 1 ? "" : "s"}`);
    return bits.filter(Boolean).join(" · ") || "Saved to CallGuard";
  }

  async function urlFor(id) {
    if (urls.has(id)) return urls.get(id);
    const blob = await store.blob(id).catch(() => null);
    if (!blob) return "";
    const url = URL.createObjectURL(blob);
    urls.set(id, url);
    return url;
  }

  function bind() {
    $("#mainBtn").onclick = onMain;
    /* Never automatic: a mic prompt can't be shown anywhere but a visible extension page,
       so this opens the one-time grant page only when the user asks for it. */
    $("#micBtn").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
    $("#sendAll").onclick = async () => {
      const r = await send({ type: "cg:send-all" });
      toast(r && r.ok ? `${r.queued} clip${r.queued === 1 ? "" : "s"} queued for CallGuard.` : (r && r.reason) || "Couldn't queue the clips.");
      signature = "";
      await renderClips();
    };
    $("#clips").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const li = btn.closest(".clip");
      const id = li && li.dataset.id;
      if (!id) return;
      const act = btn.dataset.act;
      if (act === "open") {
        chrome.tabs.create({ url: settings.dashboardUrl || DASH });
        return;
      }
      if (act === "send") {
        btn.disabled = true;
        btn.textContent = "Sending…";
        const r = await send({ type: "cg:send", clipId: id });
        toast(r && r.ok ? "Analyzed in CallGuard." : (r && r.reason) || "Couldn't hand the clip to CallGuard.");
        signature = "";
        await renderClips();
      } else if (act === "download") {
        const url = await urlFor(id);
        if (!url) { toast("That clip's audio is gone."); return; }
        const clip = clips.find((c) => c.id === id);
        const a = document.createElement("a");
        a.href = url;
        a.download = (clip && clip.fileName) || `${id}.webm`;
        a.click();
      } else if (act === "delete") {
        /* Through the service worker: it cancels a send in progress first, so a recording that is
           "Sending…" can always be deleted (and can't be written back by the send finishing). */
        const r = await chrome.runtime.sendMessage({ type: "cg:delete-clip", id }).catch(() => null);
        if (!r || !r.ok) await store.deleteClip(id).catch(() => {});
        if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
        signature = "";
        await renderClips();
      }
    });

  }

  async function onMain() {
    const btn = $("#mainBtn");
    btn.disabled = true;
    if (live.active) {
      const r = await send({ type: "cg:stop", reason: "stopped from the popup" });
      toast(r && r.ok ? "Capture stopped." : (r && r.reason) || "Couldn't stop the capture.");
    } else {
      const target = isCallTab(activeTab) ? activeTab : callTabs[0];
      if (!target) {
        toast("Open a Telegram or WhatsApp call first.");
        btn.disabled = false;                        // nothing to start, but keep the button usable
        return;
      }
      const r = await send({ type: "cg:start", tabId: target.id });
      if (r && r.ok) {
        toast(r.micError ? "Capturing, but the microphone wasn't available." : "Capturing this call.");
        if (!r.mic && settings.duplex !== false) await askMicForCapture();
      } else {
        toast((r && r.reason) || "Couldn't start the capture.");
      }
    }
    await refresh();
  }

  /* Chrome shows the microphone prompt only on a visible extension page, never in the hidden
     recorder. Ask here, in the popup, and add the mic to the capture that is already running: if
     the popup closes or the prompt is refused, the call is still recorded (caller only). */
  async function askMicForCapture() {
    if (askingMic) return;
    askingMic = true;
    try {
      let state = "";
      try { state = (await navigator.permissions.query({ name: "microphone" })).state; } catch { /* ask anyway */ }
      if (state === "denied") {
        toast("Your microphone is blocked for CallGuard. Press “Allow microphone” to unblock it.");
        return;
      }
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic.getTracks().forEach((t) => t.stop());
      const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "cg:add-mic" }).catch(() => null);
      if (r && r.mic) toast("Your voice is being recorded too.");
      else toast("Capturing the caller only — your microphone wasn't available.");
    } catch {
      toast("Capturing the caller only. Press “Allow microphone” to add your voice.");
    } finally {
      askingMic = false;
    }
  }

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
  }
})();
