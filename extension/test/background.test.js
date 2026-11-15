/* Runs the real background.js against a fake Chrome API (node --test extension/test/).
   Covers the send queue (recordings first, stale parts dropped), delete while sending, tiny clips and
   the service worker losing its memory while the offscreen recorder keeps recording. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DIR = path.join(__dirname, "..");

function makeWorld() {
  const clips = new Map(), blobs = new Map();
  const sent = [];                         // clip ids the dashboard received, in order
  const listeners = [];
  let offscreen = null;                     // simulated recorder state ({ live }) or null
  let dashboardDelayMs = 5;
  const store = {
    async addClip(c, b) { clips.set(c.id, { ...c }); blobs.set(c.id, b); return c; },
    clips: async () => [...clips.values()].map((c) => ({ ...c })),
    clip: async (id) => (clips.has(id) ? { ...clips.get(id) } : undefined),
    blob: async (id) => blobs.get(id),
    async patchClip(id, p) { if (!clips.has(id)) return null; Object.assign(clips.get(id), p); return clips.get(id); },
    async deleteClip(id) { clips.delete(id); blobs.delete(id); },
  };
  const noop = () => Promise.resolve();
  const chrome = {
    runtime: {
      id: "test", lastError: null, getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: { addListener: (f) => listeners.push(f) },
      onInstalled: { addListener: () => {} },
      sendMessage: async (msg) => {
        if (msg.target === "offscreen" && msg.type === "cg:offscreen-status") return { ok: true, live: offscreen ? offscreen.live : { active: false } };
        if (msg.target === "offscreen" && msg.type === "cg:stop-capture") { offscreen = null; return { ok: true, clips: 1 }; }
        return null;
      },
    },
    storage: { local: { get: async () => ({}), set: noop } },
    action: { setBadgeText: noop, setTitle: noop, setBadgeBackgroundColor: noop },
    offscreen: { hasDocument: async () => !!offscreen, createDocument: noop, closeDocument: noop },
    tabs: {
      query: async () => [{ id: 7, url: "https://sumit2015saurabh-tech.github.io/callguard/#/analyze" }],
      get: async (id) => ({ id, status: "complete", url: "https://web.whatsapp.com/" }),
      update: noop, create: async () => ({ id: 9 }),
      onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} },
      sendMessage: async (_tab, msg) => {
        if (msg.type === "cg:ping") return { ok: true };
        if (msg.type === "cg:dashboard-import") {
          await new Promise((r) => setTimeout(r, dashboardDelayMs));
          sent.push(msg.clip.id);
          // the real dashboard answers with the result itself (no "result" wrapper)
          return { ok: true, token: `T-${msg.clip.id}`, category: "F0", categoryName: "Not fraud", isFraud: false };
        }
        return null;
      },
    },
    scripting: { executeScript: noop },
    notifications: { create: () => {} },
    tabCapture: { getMediaStreamId: async () => "s" },
  };
  const ctx = {
    chrome, console, setTimeout, clearTimeout, URL, Blob, btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    navigator: { permissions: { query: async () => ({ state: "granted" }) } },
    self: {}, Date,
  };
  ctx.self = ctx;
  ctx.importScripts = (...files) => {
    for (const f of files) {
      if (f === "store.js") { ctx.CGStore = store; continue; }
      vm.runInContext(fs.readFileSync(path.join(DIR, f), "utf8"), ctx, { filename: f });
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(DIR, "background.js"), "utf8"), ctx, { filename: "background.js" });
  const send = (msg) => new Promise((resolve) => {
    let answered = false;
    for (const f of listeners) {
      const keep = f(msg, { tab: { id: 1 } }, (r) => { answered = true; resolve(r); });
      if (keep !== true && !answered) resolve(undefined);
    }
  });
  const add = (id, extra) => store.addClip({ id, createdAt: new Date().toISOString(), duration: 20, ...extra }, new Blob(["x"]));
  return {
    ctx, store, sent, send, add, clips,
    setRecorder: (l) => { offscreen = l ? { live: l } : null; },
    setDelay: (ms) => { dashboardDelayMs = ms; },
    idle: async () => {                     // let fire-and-forget handlers start, then wait for the queue
      await new Promise((r) => setTimeout(r, 80));
      for (let i = 0; i < 300 && vm.runInContext("pumping", ctx); i++) await new Promise((r) => setTimeout(r, 10));
    },
  };
}

const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();   // 10 minutes ago

test("a new recording is sent before parts, and parts of an ended call are dropped", async () => {
  const w = makeWorld();
  for (let i = 0; i < 5; i++) await w.add(`part${i}`, { kind: "chunk", sessionId: "old-call", createdAt: old });
  for (let i = 0; i < 5; i++) await w.send({ type: "cg:clip-added", clip: { id: `part${i}`, kind: "chunk", duration: 20 } });
  await w.add("rec", { kind: "voice", sessionId: "new-call", duration: 60 });
  await w.send({ type: "cg:clip-added", clip: { id: "rec", kind: "voice", duration: 60 } });
  await w.idle();
  assert.deepEqual(w.sent, ["rec"], "only the new recording reaches the dashboard; stale parts are dropped");
  assert.ok(!w.clips.has("part0") && !w.clips.has("part4"), "stale parts are deleted");
  assert.equal(w.clips.get("rec").result.token, "T-rec");
});

test("parts of the call that is still live are sent", async () => {
  const w = makeWorld();
  w.setRecorder({ active: true, sessionId: "live-call", tabId: 1 });
  await w.send({ type: "cg:status" });                       // worker re-reads the recorder
  await w.add("p1", { kind: "chunk", sessionId: "live-call", createdAt: old });
  await w.send({ type: "cg:clip-added", clip: { id: "p1", kind: "chunk", duration: 20 } });
  await w.idle();
  assert.deepEqual(w.sent, ["p1"]);
});

test("a recording can be deleted while it is being sent, and is not written back", async () => {
  const w = makeWorld();
  w.setDelay(150);
  await w.add("rec", { kind: "voice", sessionId: "s", duration: 30 });
  await w.send({ type: "cg:clip-added", clip: { id: "rec", kind: "voice", duration: 30 } });
  await new Promise((r) => setTimeout(r, 30));                // send in flight
  assert.equal((await w.send({ type: "cg:delete-clip", id: "rec" })).ok, true);
  await w.idle();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!w.clips.has("rec"), "deleted clip stays deleted");
});

test("deleting a recording also removes leftover parts of that ended call", async () => {
  const w = makeWorld();
  await w.add("rec", { kind: "call", sessionId: "s1", duration: 2 });
  await w.add("p1", { kind: "chunk", sessionId: "s1" });
  await w.add("p2", { kind: "chunk", sessionId: "other" });
  await w.send({ type: "cg:delete-clip", id: "rec" });
  assert.ok(!w.clips.has("rec") && !w.clips.has("p1"));
  assert.ok(w.clips.has("p2"), "another call's parts are kept");
});

test("an accidental 2-second recording is kept local, not sent", async () => {
  const w = makeWorld();
  await w.add("tiny", { kind: "call", sessionId: "s", duration: 2 });
  await w.send({ type: "cg:clip-added", clip: { id: "tiny", kind: "call", duration: 2, clarity: null } });
  await w.idle();
  assert.deepEqual(w.sent, []);
  assert.equal(w.clips.get("tiny").skipWhy, "too-short");
});

test("after the worker forgot the capture, status and Stop still reach the recorder", async () => {
  const w = makeWorld();
  w.setRecorder({ active: true, sessionId: "rec-1", tabId: 3 });  // recorder running, worker memory empty
  const st = await w.send({ type: "cg:status" });
  assert.equal(st.live.active, true, "status shows the running capture");
  vm.runInContext("live = { active: false }", w.ctx);              // worker restarted again
  const stop = await w.send({ type: "cg:stop", reason: "test" });
  assert.equal(stop.ok, true);
  assert.equal(stop.clips, 1, "the recorder was actually told to stop");
});

test("live parts are skipped once the whole recording of the same (ended) call is queued", async () => {
  const w = makeWorld();
  await w.add("part1", { kind: "chunk", sessionId: "call-9" });                 // fresh, not stale
  await w.add("whole", { kind: "call", sessionId: "call-9", duration: 49 });
  await w.send({ type: "cg:clip-added", clip: { id: "part1", kind: "chunk", duration: 20 } });
  await w.send({ type: "cg:clip-added", clip: { id: "whole", kind: "call", duration: 49 } });   // waits as "ready"
  await w.idle();
  w.send({ type: "cg:send", clipId: "whole" });                                                  // the user presses Analyze
  await w.idle();
  assert.deepEqual(w.sent, ["whole"], "only the whole recording is analysed -> one history entry");
});

test("the dashboard receives the call's sessionId and kind with every recording", async () => {
  const w = makeWorld();
  let payload = null;
  const orig = w.ctx.chrome.tabs.sendMessage;
  w.ctx.chrome.tabs.sendMessage = async (t, msg) => { if (msg.type === "cg:dashboard-import") payload = msg.clip; return orig(t, msg); };
  await w.add("whole", { kind: "call", sessionId: "wa-abc", duration: 30 });
  await w.send({ type: "cg:send", clipId: "whole" });                       // the user presses Analyze
  await w.idle();
  assert.equal(payload.sessionId, "wa-abc");
  assert.equal(payload.kind, "call");
});

test("a whole-call recording waits as \"ready\" and goes only when the user presses Analyze", async () => {
  const w = makeWorld();
  await w.add("whole", { kind: "call", sessionId: "s7", duration: 40 });
  await w.send({ type: "cg:clip-added", clip: { id: "whole", kind: "call", duration: 40, clarity: null } });
  await w.idle();
  assert.deepEqual(w.sent, [], "not sent automatically");
  assert.equal(w.clips.get("whole").skipWhy, "ready");
  const r = await w.send({ type: "cg:send", clipId: "whole", focus: true });
  assert.equal(r.ok, true);
  assert.deepEqual(w.sent, ["whole"]);
  assert.equal(w.clips.get("whole").result.token, "T-whole", "the token comes back, so View analysis works");
});
