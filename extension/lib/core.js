/* Pure logic shared by the service worker, the offscreen recorder and the popup:
   settings validation, URL helpers, voice-activity segmentation and clip clarity scoring.

   Nothing in here touches chrome.*, the DOM or Web Audio, so it can be exercised directly with
   `node --test extension/test/`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CGCore = api;
})(typeof globalThis !== "undefined" ? globalThis : null, function () {
  "use strict";

  const SETTINGS_DEFAULTS = Object.freeze({
    dashboardUrl: "https://sumit2015saurabh-tech.github.io/callguard/",
    autoSend: false,
    autoStop: true,
    keepFullCall: true,
    sensitivity: "medium",
    includeMic: false,
    skipUnclear: true,
  });

  const SENSITIVITIES = Object.freeze(["low", "medium", "high"]);
  const THRESHOLDS = Object.freeze({ low: 0.03, medium: 0.015, high: 0.008 });

  /* One VAD frame is 100 ms; a clip closes after 900 ms of quiet and is split at 40 s so it
     stays well inside the microservice's 120 s limit. */
  const SEGMENT_DEFAULTS = Object.freeze({
    frameMs: 100,
    silenceMs: 900,
    minSpeechMs: 350,
    maxClipMs: 40000,
  });

  const TELEGRAM = /^https:\/\/web\.telegram\.org\//;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const asBool = (value, fallback) => (typeof value === "boolean" ? value : fallback);
  const round3 = (v) => Math.round(v * 1000) / 1000;

  function normaliseDashboardUrl(raw) {
    const text = String(raw == null ? "" : raw).trim() || SETTINGS_DEFAULTS.dashboardUrl;
    let url;
    try { url = new URL(text); }
    catch { throw new Error("The CallGuard dashboard URL isn't valid."); }
    if (!/^https?:$/.test(url.protocol)) throw new Error("The CallGuard dashboard URL must start with http or https.");
    return url.origin + (url.pathname || "/");
  }

  function isTelegramUrl(url) {
    return TELEGRAM.test(String(url || ""));
  }

  function thresholdFor(sensitivity) {
    return THRESHOLDS[sensitivity] || THRESHOLDS.medium;
  }

  /** Merge a saved/patch settings object onto a base, ignoring wrong types and bad URLs. */
  function mergeSettings(base, patch) {
    const out = { ...SETTINGS_DEFAULTS, ...(base && typeof base === "object" ? base : {}) };
    const next = patch && typeof patch === "object" ? patch : {};

    for (const key of ["autoSend", "autoStop", "keepFullCall", "includeMic", "skipUnclear"]) {
      out[key] = asBool(next[key], asBool(out[key], SETTINGS_DEFAULTS[key]));
    }
    if (SENSITIVITIES.includes(next.sensitivity)) out.sensitivity = next.sensitivity;
    else if (!SENSITIVITIES.includes(out.sensitivity)) out.sensitivity = SETTINGS_DEFAULTS.sensitivity;

    if (next.dashboardUrl != null) {
      try { out.dashboardUrl = normaliseDashboardUrl(next.dashboardUrl); } catch { /* keep the previous URL */ }
    }
    try { out.dashboardUrl = normaliseDashboardUrl(out.dashboardUrl); }
    catch { out.dashboardUrl = SETTINGS_DEFAULTS.dashboardUrl; }
    return out;
  }

  /**
   * Voice-activity segmentation for one audio stream.
   * `step(rms, now)` is called once per frame and reports when a clip should start or stop.
   * Pure and time-driven, so tests can walk it through a conversation.
   */
  function createSegmenter(opts) {
    const cfg = { ...SEGMENT_DEFAULTS, threshold: THRESHOLDS.medium, ...(opts || {}) };
    let current = null;

    return {
      step(rms, now) {
        const at = Number.isFinite(now) ? now : Date.now();
        const loud = Number(rms) > cfg.threshold;
        const out = { loud, open: null, close: null };

        if (loud && !current) {
          current = { startedAt: at, loudMs: 0, silentMs: 0 };
          out.open = { startedAt: at };
        }
        if (!current) return out;

        if (loud) {
          current.loudMs += cfg.frameMs;
          current.silentMs = 0;
        } else {
          current.silentMs += cfg.frameMs;
        }
        if (current.silentMs >= cfg.silenceMs || at - current.startedAt >= cfg.maxClipMs) {
          out.close = { startedAt: current.startedAt, endedAt: at, loudMs: current.loudMs };
          current = null;
        }
        return out;
      },
      current() { return current ? { ...current } : null; },
      reset() { current = null; },
    };
  }

  /**
   * How usable a recorded clip is, from its decoded samples.
   * Checks level, clipping and how much of the clip actually carries speech.
   * Returns a 0–100 score with a verdict and the reasons that lowered it.
   */
  function analyseSamples(samples, opts) {
    const sr = (opts && opts.sampleRate) || 48000;
    const n = samples ? samples.length : 0;
    if (!n) {
      return { score: 0, verdict: "poor", reasons: ["no audio"], rms: 0, peak: 0, clippedRatio: 0, silenceRatio: 1, speechSeconds: 0, frames: 0 };
    }
    const frameSize = Math.max(1, Math.round(sr * 0.02));
    let peak = 0, sum = 0, clipped = 0, frameSum = 0, frameCount = 0;
    const frameRms = [];

    for (let i = 0; i < n; i++) {
      const v = Number(samples[i]) || 0;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
      if (a >= 0.985) clipped++;
      frameSum += v * v;
      if (++frameCount >= frameSize) {
        frameRms.push(Math.sqrt(frameSum / frameCount));
        frameSum = 0;
        frameCount = 0;
      }
    }
    if (frameCount) frameRms.push(Math.sqrt(frameSum / frameCount));

    const rms = Math.sqrt(sum / n);
    const clippedRatio = clipped / n;
    if (peak === 0) {
      return { score: 0, verdict: "poor", reasons: ["silence"], rms: 0, peak: 0, clippedRatio: 0, silenceRatio: 1, speechSeconds: 0, frames: frameRms.length };
    }

    const sorted = [...frameRms].sort((a, b) => a - b);
    const low = sorted[Math.floor((sorted.length - 1) * 0.1)] || 0;
    const high = sorted[Math.floor((sorted.length - 1) * 0.9)] || 0;
    /* Noise floor from the quietest frames, but never so high that continuous speech counts as silence. */
    const gate = Math.max(0.006, Math.min(low * 2.5, high * 0.35));
    const activeFrames = frameRms.filter((v) => v > gate).length;
    const speechRatio = frameRms.length ? activeFrames / frameRms.length : 0;
    const silenceRatio = 1 - speechRatio;

    let score = 100;
    const reasons = [];
    if (clippedRatio > 0.02) { score -= 55; reasons.push("clipping"); }
    else if (clippedRatio > 0.002) { score -= 25; reasons.push("some clipping"); }
    if (rms < 0.008) { score -= 50; reasons.push("very quiet"); }
    else if (rms < 0.02) { score -= 22; reasons.push("quiet"); }
    if (peak < 0.03) { score -= 15; reasons.push("faint"); }
    if (silenceRatio > 0.92) { score -= 40; reasons.push("mostly silence"); }
    else if (silenceRatio > 0.78) { score -= 12; reasons.push("long gaps"); }

    score = Math.round(clamp(score, 0, 100));
    return {
      score,
      verdict: score >= 75 ? "good" : score >= 50 ? "fair" : "poor",
      reasons,
      rms: round3(rms),
      peak: round3(peak),
      clippedRatio: round3(clippedRatio),
      silenceRatio: round3(silenceRatio),
      speechSeconds: round3((activeFrames * frameSize) / sr),
      frames: frameRms.length,
    };
  }

  /** First recording type the browser supports, or "" for the browser default. */
  function chooseMime(candidates, isSupported) {
    const list = Array.isArray(candidates) ? candidates : [];
    const test = typeof isSupported === "function" ? isSupported : () => false;
    for (const type of list) {
      try { if (test(type)) return type; } catch { /* try the next one */ }
    }
    return "";
  }

  return {
    SETTINGS_DEFAULTS,
    SENSITIVITIES,
    THRESHOLDS,
    SEGMENT_DEFAULTS,
    normaliseDashboardUrl,
    isTelegramUrl,
    thresholdFor,
    mergeSettings,
    createSegmenter,
    analyseSamples,
    chooseMime,
  };
});
