/* Unit tests for the extension's pure logic: settings validation, URL handling, voice-activity
   segmentation and clip clarity scoring. Run with:  node --test extension/test/ */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SETTINGS_DEFAULTS,
  normaliseDashboardUrl,
  platformFor,
  platformName,
  isTelegramUrl,
  isWhatsAppUrl,
  isCallUrl,
  cleanCaller,
  thresholdFor,
  mergeSettings,
  createSegmenter,
  analyseSamples,
  chooseMime,
  autoSendDecision,
} = require("../lib/core.js");

/* ---------- helpers ---------- */
function tone({ seconds = 1, rate = 16000, amp = 0.3, freq = 220 } = {}) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}
function square({ seconds = 0.5, rate = 16000 } = {}) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = i % 2 ? 1 : -1;
  return out;
}
function gap({ seconds = 1, rate = 16000 } = {}) {
  return new Float32Array(Math.round(seconds * rate));
}

/* ---------- settings ---------- */
test("settings: every capture option defaults on, and stays on", () => {
  const d = mergeSettings();
  assert.equal(d.sensitivity, "high");
  assert.equal(d.autoSend, true);
  assert.equal(d.duplex, true);
  assert.equal(d.skipUnclear, true);
  assert.equal(d.keepFullCall, true);
  assert.equal(d.autoStop, true);
  assert.equal(d.dashboardUrl, SETTINGS_DEFAULTS.dashboardUrl);

  /* There is no settings panel: a saved value can't switch a capture option off. */
  const off = mergeSettings(d, { autoSend: false, autoStop: false, keepFullCall: false, duplex: false, skipUnclear: false, sensitivity: "low" });
  for (const key of ["autoSend", "autoStop", "keepFullCall", "duplex", "skipUnclear"]) {
    assert.equal(off[key], true, `${key} stays on`);
  }
  assert.equal(off.sensitivity, "high", "sensitivity stays high");
  assert.equal(mergeSettings(d, { sensitivity: "max" }).sensitivity, "high", "unknown sensitivity falls back to high");
  assert.equal(mergeSettings(d, { autoSend: "yes" }).autoSend, true, "strings are not silently truthy");
  assert.equal(mergeSettings(d, { dashboardUrl: "not a url" }).dashboardUrl, d.dashboardUrl, "a bad URL is ignored");
});

test("settings: dashboard URLs are normalised and validated", () => {
  assert.equal(normaliseDashboardUrl("https://example.test/app/?q=1#x"), "https://example.test/app/");
  assert.equal(normaliseDashboardUrl("https://example.test"), "https://example.test/");
  assert.equal(normaliseDashboardUrl("  "), SETTINGS_DEFAULTS.dashboardUrl);
  assert.throws(() => normaliseDashboardUrl("ftp://example.test"), /http/i);
  assert.throws(() => normaliseDashboardUrl("nonsense"), /valid/i);
});

test("settings: Telegram and mic-related helpers", () => {
  assert.equal(isTelegramUrl("https://web.telegram.org/k/#-100"), true);
  assert.equal(isTelegramUrl("https://web.telegram.org.evil.test/"), false);
  assert.equal(isTelegramUrl("https://telegram.org/"), false);
  assert.equal(isTelegramUrl(""), false);
  assert.equal(thresholdFor("high"), 0.008);
  assert.equal(thresholdFor("low"), 0.03);
  assert.equal(thresholdFor("other"), 0.015);
});

test("settings: both call sites are recognised and labelled", () => {
  assert.equal(platformFor("https://web.telegram.org/k/#-100"), "telegram");
  assert.equal(platformFor("https://web.whatsapp.com/"), "whatsapp");
  assert.equal(platformFor("https://web.whatsapp.com" ), "", "a bare host is not a call page");
  assert.equal(platformFor("https://web.whatsapp.com.evil.test/"), "");
  assert.equal(platformFor("https://example.test/"), "");
  assert.equal(platformFor(""), "");

  assert.equal(isTelegramUrl("https://web.telegram.org/a/"), true);
  assert.equal(isWhatsAppUrl("https://web.whatsapp.com/"), true);
  assert.equal(isWhatsAppUrl("https://web.telegram.org/a/"), false);
  assert.equal(isCallUrl("https://web.whatsapp.com/"), true);
  assert.equal(isCallUrl("https://example.test/"), false);
  assert.equal(platformName("whatsapp"), "WhatsApp");
  assert.equal(platformName("telegram"), "Telegram");
  assert.equal(platformName("other"), "");
});

test("caller: identities are trimmed, capped and labelled", () => {
  const c = cleanCaller({ name: "  Asha   Rao ", number: "+91 98765-43210", platform: "whatsapp" });
  assert.equal(c.name, "Asha Rao");
  assert.equal(c.number, "+919876543210");
  assert.equal(c.platform, "whatsapp");
  assert.equal(c.label, "+919876543210 · Asha Rao", "the calling number leads the caller ID");

  assert.equal(cleanCaller({ number: "9876543210" }).label, "9876543210");
  assert.equal(cleanCaller({ name: "Asha Rao", number: "00 91 98765 43210" }).label, "+919876543210 · Asha Rao");
  assert.equal(cleanCaller({ name: "Unknown" }).label, "Unknown");
  assert.equal(cleanCaller({ name: "Unknown", platform: "signal" }).platform, "", "unknown platforms are dropped");
  assert.deepEqual(cleanCaller(null), { name: "", number: "", handle: "", platform: "", label: "" });
  assert.equal(cleanCaller({ handle: "tg:123456789", platform: "telegram" }).label, "tg:123456789", "Telegram ID when the number is hidden");
  assert.equal(cleanCaller({ handle: "@scam_desk", name: "Bank Help" }).label, "@scam_desk · Bank Help");
  assert.equal(cleanCaller({ number: "+14135550123", handle: "tg:1" }).label, "+14135550123", "a number beats the ID");
  assert.equal(cleanCaller({ handle: "<img onerror=x>" }).handle, "imgonerrorx");
  assert.ok(cleanCaller({ name: "x".repeat(200) }).name.length <= 80);
});

test("settings: recording type falls back to the first supported candidate", () => {
  assert.equal(chooseMime(["a", "b"], (t) => t === "b"), "b");
  assert.equal(chooseMime(["a"], () => false), "");
  assert.equal(chooseMime(["a"], () => { throw new Error("boom"); }), "");
  assert.equal(chooseMime(null, () => true), "");
});

/* ---------- voice-activity segmentation ---------- */
test("segmenter: opens on speech and closes after the silence window", () => {
  const seg = createSegmenter({ threshold: 0.02, frameMs: 100, silenceMs: 300, minSpeechMs: 200 });

  assert.equal(seg.step(0.001, 0).open, null, "background noise does not open a clip");
  const opened = seg.step(0.05, 100);
  assert.deepEqual(opened.open, { startedAt: 100 });

  assert.equal(seg.step(0.05, 200).close, null);
  assert.equal(seg.step(0.05, 300).close, null);
  assert.equal(seg.step(0.05, 400).close, null, "short gaps keep the same clip open");

  seg.step(0.001, 500);
  seg.step(0.001, 600);
  const closed = seg.step(0.001, 700);
  assert.ok(closed.close, "closes once quiet for silenceMs");
  assert.equal(closed.close.startedAt, 100);
  assert.equal(closed.close.endedAt, 700);
  assert.equal(closed.close.loudMs, 400);
  assert.equal(seg.current(), null);
});

test("segmenter: a loud burst shorter than minSpeechMs is reported so it can be dropped", () => {
  const seg = createSegmenter({ threshold: 0.02, frameMs: 100, silenceMs: 200, minSpeechMs: 350 });
  seg.step(0.09, 0);
  seg.step(0.001, 100);
  const closed = seg.step(0.001, 200).close;
  assert.ok(closed);
  assert.equal(closed.loudMs, 100);
  assert.ok(closed.loudMs < 350, "the recorder discards this clip");
});

test("segmenter: continuous speech is split at maxClipMs and reopens", () => {
  const seg = createSegmenter({ threshold: 0.01, frameMs: 100, maxClipMs: 1000, silenceMs: 900 });
  assert.ok(seg.step(0.05, 0).open);
  let closed = null;
  for (let t = 100; t <= 1000; t += 100) closed = seg.step(0.05, t).close || closed;
  assert.ok(closed, "long speech is cut, not lost");
  assert.ok(closed.endedAt - closed.startedAt >= 1000);
  assert.ok(seg.step(0.05, 1100).open, "a new clip starts immediately");
});

test("segmenter: reset forgets an open clip", () => {
  const seg = createSegmenter({ threshold: 0.02 });
  seg.step(0.05, 0);
  assert.ok(seg.current());
  seg.reset();
  assert.equal(seg.current(), null);
});

/* ---------- clarity ---------- */
test("clarity: a clear, loud clip scores good with no complaints", () => {
  const r = analyseSamples(tone({ amp: 0.3 }), { sampleRate: 16000 });
  assert.equal(r.verdict, "good");
  assert.ok(r.score >= 75, `score ${r.score}`);
  assert.deepEqual(r.reasons, []);
  assert.ok(r.speechSeconds > 0.9, "continuous speech is not mistaken for silence");
});

test("clarity: a very quiet recording is flagged", () => {
  const r = analyseSamples(tone({ amp: 0.006 }), { sampleRate: 16000 });
  assert.equal(r.verdict, "poor");
  assert.ok(r.reasons.includes("very quiet"));
  assert.ok(r.reasons.includes("faint"));
});

test("clarity: clipped audio is flagged", () => {
  const r = analyseSamples(square(), { sampleRate: 16000 });
  assert.equal(r.verdict, "poor");
  assert.ok(r.reasons.includes("clipping"));
  assert.ok(r.clippedRatio > 0.9);
});

test("clarity: silence and mostly-silent clips are flagged", () => {
  const silent = analyseSamples(gap(), { sampleRate: 16000 });
  assert.equal(silent.score, 0);
  assert.equal(silent.verdict, "poor");
  assert.ok(silent.reasons.includes("silence"));

  const mostlySilent = new Float32Array(16000);          // 5% tone, 95% silence
  mostlySilent.set(tone({ seconds: 0.05, amp: 0.3 }), 0);
  const r = analyseSamples(mostlySilent, { sampleRate: 16000 });
  assert.ok(r.reasons.includes("mostly silence"));
  assert.notEqual(r.verdict, "good");
  assert.ok(r.silenceRatio > 0.9);
});

test("clarity: an empty buffer is handled", () => {
  const r = analyseSamples(new Float32Array(0), { sampleRate: 16000 });
  assert.equal(r.score, 0);
  assert.equal(r.verdict, "poor");
  assert.ok(r.reasons.includes("no audio"));
});

test("auto-send: a mostly-silent part is dropped, other parts are queued", () => {
  const silent = { kind: "chunk", duration: 20, clarity: { verdict: "poor", reasons: ["mostly silence"] } };
  assert.deepEqual(autoSendDecision(silent, { skipUnclear: true }), { send: false, drop: true, skipWhy: "" });

  const quiet = { kind: "chunk", duration: 20, clarity: { verdict: "poor", reasons: ["very quiet"] } };
  assert.deepEqual(autoSendDecision(quiet, { skipUnclear: true }), { send: true, drop: false, skipWhy: "" });

  const good = { kind: "chunk", duration: 20, clarity: { verdict: "good", reasons: [] } };
  assert.deepEqual(autoSendDecision(good, {}), { send: true, drop: false, skipWhy: "" });
});

test("auto-send: a whole-call file over the dashboard's 120 s limit is kept local", () => {
  assert.deepEqual(autoSendDecision({ kind: "call", duration: 125, clarity: null }, {}),
    { send: false, drop: false, skipWhy: "too-long" });
  assert.deepEqual(autoSendDecision({ kind: "call", duration: 43, clarity: null }, {}),
    { send: true, drop: false, skipWhy: "" });
  assert.equal(autoSendDecision({ kind: "call", duration: 120, clarity: null }, {}).send, true);
});

test("auto-send: unclear voice clips are skipped only while skipUnclear is on", () => {
  const clip = { kind: "voice", duration: 8, clarity: { verdict: "poor", reasons: ["very quiet"] } };
  assert.deepEqual(autoSendDecision(clip, { skipUnclear: true }), { send: false, drop: false, skipWhy: "unclear" });
  assert.deepEqual(autoSendDecision(clip, { skipUnclear: false }), { send: true, drop: false, skipWhy: "" });
});
