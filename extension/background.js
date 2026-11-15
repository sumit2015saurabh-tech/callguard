/* CallGuard: service worker.
   Starts and stops tab capture for a live Telegram or WhatsApp Web call, hands captured clips
   (with the call's source and caller identity) to the CallGuard dashboard, which runs the
   microservice, the fraud category and the alert routing. It also keeps the toolbar badge in
   sync and answers the popup's reliability checks. The audio itself is recorded in offscreen.js. */
importScripts("store.js", "lib/core.js");
const store = self.CGStore;
const core = self.CGCore;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let live = { active: false };     // last snapshot from the offscreen recorder
let creating = null;              // in-flight offscreen document creation
const queue = [];                 // clip ids waiting for the dashboard
let pumping = false;

/* ---------- settings ---------- */
async function getSettings() {
  const v = await chrome.storage.local.get("cgSettings");
  return core.mergeSettings(core.SETTINGS_DEFAULTS, v.cgSettings);
}
async function setSettings(patch) {
  const next = core.mergeSettings(await getSettings(), patch);
  await chrome.storage.local.set({ cgSettings: next });
  return next;
}

/* ---------- toolbar badge ---------- */
function paintBadge() {
  if (!live.active) {
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
    chrome.action.setTitle({ title: "CallGuard" }).catch(() => {});
    return;
  }
  const n = Number(live.clips || 0);
  const parts = Number(live.parts || 0);
  const bits = [live.keepFullCall ? "one continuous recording" : `${n} voice clip${n === 1 ? "" : "s"}`];
  if (parts) bits.push(`${parts} analysis part${parts === 1 ? "" : "s"}`);
  const what = bits.join(" · ");
  chrome.action.setBadgeBackgroundColor({ color: "#c0392b" }).catch(() => {});
  chrome.action.setBadgeText({ text: live.keepFullCall ? "REC" : (n ? String(n) : "REC") }).catch(() => {});
  chrome.action.setTitle({ title: `CallGuard: capturing · ${what}${live.mic ? " · both voices" : ""}` }).catch(() => {});
}

/** Chrome needs an explicit click on the extension to capture tab audio on some pages. */
function askForClick() {
  chrome.action.setBadgeBackgroundColor({ color: "#b7791f" }).catch(() => {});
  chrome.action.setBadgeText({ text: "GO" }).catch(() => {});
  chrome.action.setTitle({ title: "Click CallGuard, then press “Capture this call”" }).catch(() => {});
  setTimeout(() => { paintBadge(); }, 8000);
}

/* ---------- offscreen recorder ---------- */
async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
      justification: "Records the audio of the Telegram or WhatsApp call tab (optionally with the microphone) and keeps the call audible while capturing.",
    }).catch((e) => {
      if (!/single offscreen/i.test(String(e && e.message))) throw e;
    }).finally(() => { creating = null; });
  }
  await creating;
}

/** "granted" | "denied" | "prompt" | "" (unknown) for the extension's microphone access. */
async function micPermission() {
  try { return (await navigator.permissions.query({ name: "microphone" })).state; }
  catch { return ""; }
}

/** Caller identity is read from the call screen by content.js in the call tab. */
async function askCaller(tabId, platform) {
  const read = async () => {
    const res = await chrome.tabs.sendMessage(tabId, { type: "cg:caller-info" }).catch(() => null);
    return res && res.caller ? res.caller : null;
  };
  let caller = await read();
  if (!caller) {
    /* A tab opened before the extension was installed has no content script yet. */
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }).catch(() => {});
    await sleep(150);
    caller = await read();
  }
  return core.cleanCaller({ ...(caller || {}), platform });
}

async function startCapture(tabId) {
  if (live.active) return { ok: false, reason: "A capture is already running. Stop it first." };
  if (tabId == null) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabId = tab && tab.id;
  }
  const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const platform = tab ? core.platformFor(tab.url) : "";
  if (!tab || !platform) {
    return { ok: false, reason: "Open the call in web.telegram.org or web.whatsapp.com, then start the capture there." };
  }

  /* Two-way calls need the microphone. The hidden recorder can't ask for it, so the first time
     we open a small page that asks; the user then presses Capture again. */
  const pre = await getSettings();
  if (pre.duplex) {
    const state = await micPermission();
    if (state === "prompt") {
      await chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
      return { ok: false, reason: "Allow the microphone in the tab that just opened (once), then press “Capture this call” again so your voice is recorded too." };
    }
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch {
    askForClick();
    return {
      ok: false,
      needsIconClick: true,
      reason: "Chrome only lets tab audio be captured after a click on the extension itself. Click the CallGuard icon in the toolbar, then press “Capture this call”.",
    };
  }

  await ensureOffscreen();
  const settings = await getSettings();
  const caller = await askCaller(tab.id, platform);
  const sessionId = `${platform === "whatsapp" ? "wa" : "tg"}-${Date.now().toString(36)}`;
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "cg:start-capture",
    streamId,
    tabId: tab.id,
    tabUrl: tab.url,
    tabTitle: tab.title || `${core.platformName(platform)} call`,
    platform,
    caller,
    sessionId,
    settings,
  }).catch((e) => ({ ok: false, reason: (e && e.message) || String(e) }));

  if (!res || !res.ok) {
    await chrome.offscreen.closeDocument().catch(() => {});
    return { ok: false, reason: (res && res.reason) || "The recorder didn't start." };
  }
  live = {
    active: true, sessionId, tabId: tab.id, tabTitle: tab.title || `${core.platformName(platform)} call`,
    platform, caller,
    startedAt: new Date().toISOString(), clips: 0, parts: 0, partsSent: 0, lastResult: null,
    level: 0, speech: false,
    mic: !!res.mic, micError: res.micError || "", duplex: !!settings.duplex,
  };
  paintBadge();
  return { ok: true, sessionId, mic: !!res.mic, micError: res.micError || "" };
}

async function stopCapture(reason) {
  if (!live.active) {
    live = { active: false };
    paintBadge();
    return { ok: true, clips: 0 };
  }
  const res = await chrome.runtime.sendMessage({
    target: "offscreen", type: "cg:stop-capture", reason: reason || "stopped",
  }).catch(() => null);
  live = { active: false };
  paintBadge();
  await chrome.offscreen.closeDocument().catch(() => {});
  return { ok: true, clips: (res && res.clips) || 0 };
}

/* ---------- handing clips to the dashboard ---------- */
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function waitForComplete(tabId) {
  for (let i = 0; i < 80; i++) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (tab.status === "complete") return;
    await sleep(300);
  }
}

async function findOrOpenDashboard(base, focus) {
  const pattern = new URL(base).origin + "/*";
  let tab = null;
  try { tab = (await chrome.tabs.query({ url: pattern }))[0] || null; } catch { /* no access */ }
  if (tab) {
    if (focus) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  } else {
    tab = await chrome.tabs.create({ url: base, active: !!focus });
    if (tab.id == null) throw new Error("Chrome blocked opening the CallGuard tab.");
    await waitForComplete(tab.id);
  }
  await ensureBridge(tab.id, base);
  return tab;
}

/** Make sure content.js is live in the dashboard tab (it relays the clip into the page). */
async function ensureBridge(tabId, base) {
  const ping = () => chrome.tabs.sendMessage(tabId, { type: "cg:ping" }).then((r) => !!(r && r.ok)).catch(() => false);
  if (await ping()) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch {
    throw new Error(`Couldn't reach ${base}. Give the extension access to that site, reload the tab, then try again.`);
  }
  for (let i = 0; i < 12; i++) {
    if (await ping()) return;
    await sleep(300);
  }
  throw new Error("The CallGuard page didn't answer. Reload it and try again.");
}

async function sendClipToDashboard(id, opts = {}) {
  const clip = await store.clip(id);
  if (!clip) throw new Error("That clip isn't saved any more.");
  const blob = await store.blob(id);
  if (!blob) throw new Error("The audio for that clip was deleted.");

  const settings = await getSettings();
  let base;
  try { base = core.normaliseDashboardUrl(settings.dashboardUrl); }
  catch (e) { throw new Error(e.message); }
  /* The caller can be found after the capture started (a call screen takes a moment to paint),
     so fall back to the live caller before giving up on it. */
  const platform = clip.platform || (live.active ? live.platform : "") || core.platformFor(clip.tabUrl) || "";
  const savedCaller = clip.caller && (clip.caller.name || clip.caller.number || clip.caller.handle) ? clip.caller : null;
  const caller = core.cleanCaller(savedCaller || (live.active ? live.caller : {}) || {});
  const tab = await findOrOpenDashboard(base, opts.focus);
  const res = await chrome.tabs.sendMessage(tab.id, {
    type: "cg:dashboard-import",
    clip: {
      id: clip.id,
      fileName: clip.fileName || `${clip.id}.webm`,
      mime: "audio/webm",
      capturedAt: clip.createdAt,
      duration: clip.duration,
      tabTitle: clip.tabTitle || "",
      platform,
      caller,
      audio: await blobToBase64(blob),
    },
  }).catch((e) => ({ ok: false, reason: (e && e.message) || String(e) }));

  if (res && res.busy) {
    if (opts.attempt && opts.attempt >= 6) throw new Error("CallGuard stayed busy, so the clip is still here. Try again.");
    await sleep(5000);
    return sendClipToDashboard(id, { ...opts, attempt: (opts.attempt || 0) + 1 });
  }
  if (!res || !res.ok) throw new Error((res && res.reason) || "CallGuard didn't accept the clip.");
  return res.result || { ok: true };
}

/** A 20-second analysis part came back: remember it, and speak up in the call if it is fraud. */
function notePartResult(result) {
  if (!live.active) return;
  live.lastResult = {
    token: (result && result.token) || "",
    category: (result && result.category) || "",
    categoryName: (result && result.categoryName) || "",
    isFraud: !!(result && result.isFraud),
    at: new Date().toISOString(),
  };
  live.partsSent = Number(live.partsSent || 0) + 1;
  if (!live.lastResult.isFraud || live.tabId == null) return;
  /* The dock in the call tab shows this at once, so a warning reaches the user during the call. */
  chrome.tabs.sendMessage(live.tabId, {
    type: "cg:call-alert",
    alert: { kind: "fraud", ...live.lastResult, caller: live.caller },
  }).catch(() => {});
}

async function sendNow(id, opts = {}) {
  const clip = await store.clip(id);
  await store.patchClip(id, { queuedAt: new Date().toISOString(), autoSkipped: "", error: "" }).catch(() => {});
  try {
    const result = await sendClipToDashboard(id, opts);
    /* Analysis parts are transport, not recordings: once CallGuard has one it is deleted, so a
       long call never fills the popup with a hundred 20-second rows. */
    if (clip && clip.kind === "chunk") {
      await store.deleteClip(id).catch(() => {});
      notePartResult(result);
      return { ok: true, result };
    }
    await store.patchClip(id, { queuedAt: "", sentAt: new Date().toISOString(), result, error: "" });
    return { ok: true, result };
  } catch (e) {
    const reason = (e && e.message) || String(e);
    await store.patchClip(id, { queuedAt: "", error: reason });
    return { ok: false, reason };
  }
}

async function enqueue(id) {
  await store.patchClip(id, { queuedAt: new Date().toISOString(), autoSkipped: "", error: "" }).catch(() => {});
  if (!queue.includes(id)) queue.push(id);
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) await sendNow(queue.shift());
  } finally { pumping = false; }
}

/** A part that failed for good is dropped at the end of the call; the whole-call file still has it. */
async function pruneParts() {
  const clips = await store.clips().catch(() => []);
  for (const c of clips) {
    if (c.kind === "chunk" && c.error && !c.queuedAt) await store.deleteClip(c.id).catch(() => {});
  }
}

/** A service worker can be stopped mid-queue: clips marked as queued are picked up again on wake. */
async function recoverQueue() {
  const clips = await store.clips().catch(() => []);
  for (const c of clips) {
    if (c.queuedAt && !c.result) enqueue(c.id);
  }
}

async function sendAll() {
  const clips = (await store.clips())
    .filter((c) => !c.result && !c.queuedAt)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const c of clips) await enqueue(c.id);
  return { ok: true, queued: clips.length };
}

/* ---------- reliability checks (popup → "Run reliability checks") ---------- */
async function runChecks() {
  const checks = [];
  const settings = await getSettings();

  const hasCapture = !!(chrome.tabCapture && chrome.tabCapture.getMediaStreamId);
  checks.push({ name: "Tab audio capture API", ok: hasCapture, detail: hasCapture ? "available" : "chrome.tabCapture is missing" });

  const hasOffscreen = !!(chrome.offscreen && chrome.offscreen.createDocument);
  checks.push({ name: "Offscreen recorder API", ok: hasOffscreen, detail: hasOffscreen ? "available" : "chrome.offscreen is missing (Chrome 116+)" });

  const hasScripting = !!(chrome.scripting && chrome.scripting.executeScript);
  checks.push({ name: "Bridge injection", ok: hasScripting, detail: hasScripting ? "available" : "chrome.scripting is missing" });

  try {
    const id = `check-${Date.now()}`;
    await store.addClip({ id, sessionId: "check", kind: "voice", createdAt: new Date().toISOString(), duration: 0, size: 2, fileName: "check.webm" }, new Blob(["ok"]));
    const read = await store.blob(id);
    await store.deleteClip(id);
    checks.push({ name: "Clip storage", ok: !!read && read.size === 2, detail: read ? "read/write ok" : "the audio blob was not stored" });
  } catch (e) {
    checks.push({ name: "Clip storage", ok: false, detail: (e && e.message) || String(e) });
  }

  const tg = await chrome.tabs.query({ url: "https://web.telegram.org/*" }).catch(() => []);
  const wa = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" }).catch(() => []);
  const callTabs = tg.length + wa.length;
  checks.push({
    name: "Call tab (Telegram / WhatsApp)",
    ok: callTabs > 0,
    detail: callTabs ? [tg.length && `${tg.length} Telegram`, wa.length && `${wa.length} WhatsApp`].filter(Boolean).join(", ") : "open web.telegram.org or web.whatsapp.com first",
  });

  let urlOk = false;
  try { core.normaliseDashboardUrl(settings.dashboardUrl); urlOk = true; } catch { /* reported below */ }
  checks.push({ name: "Dashboard URL", ok: urlOk, detail: urlOk ? settings.dashboardUrl : "invalid URL — fix it in Settings" });

  let bridgeOk = false;
  let bridgeDetail = "";
  try {
    const base = core.normaliseDashboardUrl(settings.dashboardUrl);
    const tabs = await chrome.tabs.query({ url: new URL(base).origin + "/*" });
    if (!tabs.length) bridgeDetail = "open the dashboard once, logged in";
    else {
      const r = await chrome.tabs.sendMessage(tabs[0].id, { type: "cg:ping" }).catch(() => null);
      bridgeOk = !!(r && r.ok);
      bridgeDetail = bridgeOk ? "ready to receive clips" : "reload the dashboard tab";
    }
  } catch (e) { bridgeDetail = (e && e.message) || String(e); }
  checks.push({ name: "Dashboard bridge", ok: bridgeOk, detail: bridgeDetail });

  checks.push({ name: "Long-call queue", ok: true, detail: settings.autoSend
    ? `${core.CHUNK_SECONDS}s parts, one request at a time, call warning after ${Math.round(core.LONG_CALL_WARN_SEC / 60)} min`
    : `idle until auto-send is on (${core.CHUNK_SECONDS}s parts)` });
  checks.push({ name: "Two-way recording", ok: true, detail: settings.duplex ? `on: caller left, my mic right (Speaker 2)` : "off: caller only" });
  checks.push({ name: "Clarity gate", ok: true, detail: settings.skipUnclear ? "poor clips are not auto-sent" : "off — every clip is auto-sent" });

  return { ok: true, checks };
}

/* ---------- messages ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type || msg.target === "offscreen") return;

  /* Updates from the recorder need no answer; replying would hold a port open on every tick. */
  if (msg.type === "cg:live") {
    live = msg.live && msg.live.active ? { ...live, ...msg.live } : { active: false, clips: 0 };
    paintBadge();
    return;
  }
  if (msg.type === "cg:mic-missing") {             // mic failed after all: offer the grant page
    micPermission().then((state) => {
      if (state !== "granted") chrome.tabs.create({ url: chrome.runtime.getURL("mic.html"), active: false }).catch(() => {});
    });
    return;
  }
  if (msg.type === "cg:stopped") {
    live = { active: false };
    paintBadge();
    chrome.offscreen.closeDocument().catch(() => {});
    pruneParts().catch(() => {});
    return;
  }
  if (msg.type === "cg:caller") {
    if (msg.caller && live.active && sender.tab && sender.tab.id === live.tabId) {
      live.caller = core.cleanCaller({ ...msg.caller, platform: live.platform });
      /* Clips and the whole-call file are saved with the recorder's copy, so update it too. */
      chrome.runtime.sendMessage({ target: "offscreen", type: "cg:set-caller", caller: live.caller }).catch(() => {});
      paintBadge();
    }
    return;
  }
  if (msg.type === "cg:clip-added") {
    (async () => {
      if (!msg.clip) return;
      const settings = await getSettings();
      if (!settings.autoSend) return;
      if (msg.clip.kind === "chunk") {
        /* A part that is nearly all silence has nothing to transcribe: drop it locally instead of
           spending a request on it. Everything else is queued, in order. */
        const clarity = msg.clip.clarity;
        if (clarity && clarity.verdict === "poor" && (clarity.reasons || []).includes("mostly silence")) {
          await store.deleteClip(msg.clip.id).catch(() => {});
          return;
        }
        enqueue(msg.clip.id);
        return;
      }
      /* A clip too unclear to transcribe is kept locally, not auto-sent. Manual send still works. */
      if (settings.skipUnclear !== false && msg.clip.clarity && msg.clip.clarity.verdict === "poor") {
        await store.patchClip(msg.clip.id, { autoSkipped: new Date().toISOString() });
        return;
      }
      enqueue(msg.clip.id);
    })().catch(() => {});
    return;
  }

  (async () => {
    try {
      switch (msg.type) {
        case "cg:start":
          sendResponse(await startCapture(msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id)));
          break;
        case "cg:stop":
          sendResponse(await stopCapture(msg.reason || "stopped"));
          break;
        case "cg:status":
          sendResponse({ ok: true, live, settings: await getSettings() });
          break;
        case "cg:send":
          sendResponse(await sendNow(msg.clipId, { focus: true }));
          break;
        case "cg:send-all":
          sendResponse(await sendAll());
          break;
        case "cg:settings:get":
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        case "cg:settings:set":
          sendResponse({ ok: true, settings: await setSettings(msg.patch || {}) });
          break;
        case "cg:check":
          sendResponse(await runChecks());
          break;
        default:
          sendResponse({ ok: false, reason: "Unknown request." });
      }
    } catch (e) {
      sendResponse({ ok: false, reason: (e && e.message) || String(e) });
    }
  })();
  return true;
});

/* ---------- capture hygiene ---------- */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (live.active && live.tabId === tabId) stopCapture("tab closed");
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (live.active && live.tabId === tabId && info.url && !core.isCallUrl(info.url)) stopCapture("left the call site");
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ cgSettings: await getSettings() });
  paintBadge();
});

/* Picks up anything the previous worker left queued (a 20 s part can outlive it). */
recoverQueue().catch(() => {});
