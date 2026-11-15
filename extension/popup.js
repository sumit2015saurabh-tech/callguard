/* CallGuard popup: live capture state, captured clips, clarity, reliability checks, settings.
   Recording happens in the offscreen document, so closing this popup never stops a capture. */
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
  const fmtDur = (s) => `${Math.floor(Math.max(0, Number(s) || 0) / 60)}:${pad(Math.round(Math.max(0, Number(s) || 0) % 60))}`;
  const kb = (n) => (Number(n) > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((Number(n) || 0) / 1024))} KB`);
  const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const isCallTab = (tab) => !!tab && core.isCallUrl(tab.url);

  let live = { active: false };
  let settings = null;
  let activeTab = null;
  let callTabs = [];
  let clips = [];
  let signature = "";
  let settingsLoaded = false;
  const urls = new Map();
  let toastTimer = 0;

  init();

  async function init() {
    bind();
    const r = await send({ type: "cg:settings:get" });
    if (r && r.ok) { settingsLoaded = true; fillSettings(r.settings); }
    await refresh();
    setInterval(refresh, 1200);
    window.addEventListener("unload", () => urls.forEach((u) => URL.revokeObjectURL(u)));
  }

  function fillSettings(s) {
    if (!s) return;
    settings = s;
    if (document.activeElement !== $("#dashUrl")) $("#dashUrl").value = s.dashboardUrl || DASH;
    $("#autoSend").checked = !!s.autoSend;
    $("#keepFullCall").checked = s.keepFullCall !== false;
    $("#autoStop").checked = s.autoStop !== false;
    $("#duplex").checked = !!s.duplex;
    $("#skipUnclear").checked = s.skipUnclear !== false;
    $("#sens").value = s.sensitivity || "medium";
  }

  async function refresh() {
    const [st, tabList, tabs] = await Promise.all([
      send({ type: "cg:status" }),
      chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []),
      chrome.tabs.query({ url: ["https://web.telegram.org/*", "https://web.whatsapp.com/*"] }).catch(() => []),
    ]);
    if (st && st.ok) {
      live = st.live || { active: false };
      if (!settingsLoaded && st.settings) { settingsLoaded = true; fillSettings(st.settings); }
      else if (st.settings) settings = { ...(settings || {}), dashboardUrl: st.settings.dashboardUrl };
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
    const mic = live.mic ? " · mic mixed" : "";
    const caller = live.caller && live.caller.label ? ` · caller ${live.caller.label}` : "";
    $("#liveInfo").textContent = on
      ? (live.tabTitle ? `Capturing ${live.tabTitle}${caller}${mic}` : `Capturing the ${core.platformName(live.platform) || "call"} tab${caller}${mic}`)
      : isCallTab(activeTab) ? `${core.platformName(core.platformFor(activeTab.url)) || "Call"} tab ready to capture.` : callTabs.length ? "Switch to your call tab." : "Open web.telegram.org or web.whatsapp.com first.";
    $("#mainBtn").textContent = on ? "Stop capture" : "Capture this call";
    $("#mainBtn").classList.toggle("stop", on);
    $("#mainBtn").disabled = !on && !isCallTab(activeTab) && !callTabs.length;
    $("#note").hidden = !(on && live.micError);
    $("#note").textContent = on && live.micError ? `Mic unavailable: ${live.micError}` : "";
    $("#dashBtn").onclick = () => chrome.tabs.create({ url: (settings && settings.dashboardUrl) || DASH });
  }

  async function renderClips() {
    try {
      /* 20-second analysis parts are sent and deleted behind the scenes: list recordings only. */
      clips = (await store.clips()).filter((c) => c.kind !== "chunk")
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    } catch { clips = []; }
    const sig = clips.map((c) => `${c.id}:${c.result ? c.result.token || "r" : ""}:${c.queuedAt || ""}:${c.error || ""}:${c.autoSkipped || ""}`).join("|");
    if (sig === signature) return;
    signature = sig;
    const list = $("#clips");
    list.innerHTML = "";
    $("#empty").hidden = clips.length > 0;
    for (const c of clips) list.appendChild(await clipRow(c));
  }

  async function clipRow(c) {
    const li = document.createElement("li");
    li.className = "clip";
    li.dataset.id = c.id;
    const st = clipStatus(c);
    const clarity = c.clarity
      ? `<div class="sub">Clarity ${c.clarity.score}/100 · ${esc(c.clarity.verdict)}${c.clarity.reasons.length ? ` (${esc(c.clarity.reasons.join(", "))})` : ""}</div>`
      : "";
    li.innerHTML = `
      <div class="row between">
        <span class="title">${esc(clock(c.createdAt))} <span class="sub">· ${esc(fmtDur(c.duration))} · ${esc(kb(c.size))}${c.kind === "call" ? " · whole call" : " · clip"}${c.mic ? " · mic" : ""}</span></span>
        <span class="chip ${st.cls}">${esc(st.text)}</span>
      </div>
      ${c.result ? `<div class="sub">${esc(resultLine(c.result))}</div>` : ""}
      ${c.error ? `<div class="sub err">${esc(c.error)}</div>` : ""}
      ${clarity}
      <audio controls preload="none"></audio>
      <div class="actions">
        <button class="btn sm" data-act="send">Analyze in CallGuard</button>
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
    $("#sendAll").onclick = async () => {
      const r = await send({ type: "cg:send-all" });
      toast(r && r.ok ? `${r.queued} clip${r.queued === 1 ? "" : "s"} queued for CallGuard.` : (r && r.reason) || "Couldn't queue the clips.");
      signature = "";
      await renderClips();
    };
    $("#checksBtn").onclick = runChecks;

    $("#clips").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const li = btn.closest(".clip");
      const id = li && li.dataset.id;
      if (!id) return;
      const act = btn.dataset.act;
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
        await store.deleteClip(id).catch(() => {});
        if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
        signature = "";
        await renderClips();
      }
    });

    $("#dashUrl").onchange = saveDashboardUrl;
    $("#autoSend").onchange = () => savePatch({ autoSend: $("#autoSend").checked });
    $("#keepFullCall").onchange = () => savePatch({ keepFullCall: $("#keepFullCall").checked });
    $("#autoStop").onchange = () => savePatch({ autoStop: $("#autoStop").checked });
    $("#duplex").onchange = () => savePatch({ duplex: $("#duplex").checked });
    $("#skipUnclear").onchange = () => savePatch({ skipUnclear: $("#skipUnclear").checked });
    $("#sens").onchange = () => savePatch({ sensitivity: $("#sens").value });
  }

  async function runChecks() {
    const list = $("#checkList");
    list.innerHTML = "<li>Running checks…</li>";
    const r = await send({ type: "cg:check" });
    if (!r || !r.ok) {
      list.innerHTML = `<li class="bad"><b>!</b><span>${esc((r && r.reason) || "Checks couldn't run.")}</span></li>`;
      return;
    }
    list.innerHTML = "";
    for (const c of r.checks) {
      const li = document.createElement("li");
      if (!c.ok) li.className = "bad";
      li.innerHTML = `<b>${c.ok ? "✓" : "!"}</b><span>${esc(c.name)}</span><span class="sub">${esc(c.detail || "")}</span>`;
      list.appendChild(li);
    }
  }

  async function savePatch(patch) {
    const r = await send({ type: "cg:settings:set", patch });
    if (r && r.ok) settings = r.settings;
    else toast((r && r.reason) || "Couldn't save that setting.");
  }

  async function saveDashboardUrl() {
    const raw = $("#dashUrl").value.trim();
    let origin;
    try { origin = new URL(raw).origin; }
    catch { toast("That dashboard URL isn't valid."); return; }
    const granted = await chrome.permissions.contains({ origins: [origin + "/*"] }).catch(() => false);
    if (!granted) {
      const ok = await chrome.permissions.request({ origins: [origin + "/*"] }).catch(() => false);
      if (!ok) toast("Chrome didn't grant access to that site, so clips can't be handed to it.");
    }
    const r = await send({ type: "cg:settings:set", patch: { dashboardUrl: raw } });
    if (r && r.ok) { settings = r.settings; toast("Dashboard URL saved."); }
  }

  async function onMain() {
    const btn = $("#mainBtn");
    btn.disabled = true;
    if (live.active) {
      const r = await send({ type: "cg:stop", reason: "stopped from the popup" });
      toast(r && r.ok ? "Capture stopped." : (r && r.reason) || "Couldn't stop the capture.");
    } else {
      const target = isCallTab(activeTab) ? activeTab : callTabs[0];
      if (!target) { toast("Open a Telegram or WhatsApp call first."); return; }
      const r = await send({ type: "cg:start", tabId: target.id });
      if (r && r.ok) {
        toast(r.micError ? "Capturing, but the microphone wasn't available." : "Capturing this call.");
      } else {
        toast((r && r.reason) || "Couldn't start the capture.");
      }
    }
    await refresh();
  }

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
  }
})();
