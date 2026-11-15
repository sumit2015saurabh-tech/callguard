/* CallGuard recorder. Lives in an offscreen document because an MV3 service worker has no
   MediaRecorder or Web Audio. The service worker starts and stops it.

   The tab's audio is
     1. played back through the speakers (tab capture mutes the tab, so without this the call goes silent),
     2. optionally mixed with the microphone (recording only — the mic is never played back),
     3. recorded as one continuous file from capture start to stop — voice activity detection only
        drives the live meter (or, with the whole-call file switched off, a clip per utterance),
     4. handed to CallGuard in 20-second analysis parts while auto-send is on, and
     5. scored for clarity, so an unusable clip is visible instead of silently useless.

   Recordings are written to IndexedDB; this document never talks to the network. */
(() => {
  "use strict";
  const store = self.CGStore;
  const core = self.CGCore;
  const MIME = core.chooseMime(
    ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"],
    (type) => !!self.MediaRecorder && MediaRecorder.isTypeSupported(type)
  );
  /* High input quality: Opus at 128 kbps keeps the transcription service's audio clean. */
  const AUDIO_BITS_PER_SECOND = 128000;
  const RECORDER_OPTIONS = { audioBitsPerSecond: AUDIO_BITS_PER_SECOND, ...(MIME ? { mimeType: MIME } : {}) };
  const MAX_CALL_MS = 45 * 60 * 1000;
  const MIC_GAIN = 0.8;          // keeps the other party's voice dominant in the mix
  const FRAME_MS = core.SEGMENT_DEFAULTS.frameMs;

  const S = {
    session: null, mime: "audio/webm", captureStart: 0,
    ctx: null, stream: null, src: null, analyser: null, dest: null,
    mic: null, micSrc: null, micGain: null,
    vad: null, segmenter: null, ticker: null, limit: null,
    full: null, fullChunks: [], fullStartedAt: 0, fullDone: null,
    chunk: null, chunkTimer: null,
    seg: null, saving: new Set(), level: 0, speech: false, lastClarity: null,
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== "offscreen") return;
    if (msg.type === "cg:start-capture") {
      start(msg).then(sendResponse, (e) => sendResponse({ ok: false, reason: (e && e.message) || String(e) }));
      return true;
    }
    if (msg.type === "cg:stop-capture") {
      stop(msg.reason).then(sendResponse, (e) => sendResponse({ ok: false, reason: (e && e.message) || String(e) }));
      return true;
    }
    if (msg.type === "cg:set-caller") {          // caller ID found after the capture started
      if (S.session && msg.caller) S.session.caller = core.cleanCaller(msg.caller);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "cg:add-mic") {             // permission granted after the capture started
      addMic().then(sendResponse, (e) => sendResponse({ ok: false, reason: (e && e.message) || String(e) }));
      return true;
    }
    if (msg.type === "cg:offscreen-status") sendResponse({ ok: true, live: snapshot() });
  });

  function fileName(ms, kind, n) {
    const d = new Date(ms);
    const p = (v) => String(v).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const platform = S.session && S.session.platform === "whatsapp" ? "whatsapp" : "telegram";
    const label = kind === "call" ? "call" : kind === "chunk" ? `part${String(n).padStart(3, "0")}` : `clip${n}`;
    return `${platform}-${stamp}-${label}.webm`;
  }

  function snapshot() {
    return {
      active: !!S.session,
      sessionId: S.session ? S.session.id : "",
      startedAt: S.session ? S.session.startedAt : "",
      tabId: S.session ? S.session.tabId : null,
      tabTitle: S.session ? S.session.tabTitle : "",
      platform: S.session ? S.session.platform : "",
      caller: S.session ? S.session.caller : null,
      clips: S.session ? S.session.clips : 0,
      parts: S.session ? S.session.parts : 0,
      chunkSec: (S.session && S.session.chunkSec) || 0,
      longCallWarnSec: core.LONG_CALL_WARN_SEC,
      level: Math.round(S.level * 100) / 100,
      speech: !!S.speech,
      keepFullCall: !!(S.session && S.session.keepFullCall),
      mic: !!(S.session && S.session.mic),
      duplex: !!(S.session && S.session.duplex),
      micError: (S.session && S.session.micError) || "",
      lastClarity: S.lastClarity,
    };
  }

  function publish() {
    if (!S.session) return;
    chrome.runtime.sendMessage({ target: "background", type: "cg:live", live: snapshot() }).catch(() => {});
  }

  /* ---------- saving clips ---------- */
  function saveClip(blob, info) {
    const job = writeClip(blob, info).catch(() => {}).finally(() => S.saving.delete(job));
    S.saving.add(job);
    return job;
  }

  /** Decode the clip to measure it: exact duration, level, clipping and speech ratio.
   *  Voice clips only: decoding a long whole-call file would cost far more memory than it is worth. */
  async function measure(blob) {
    if (!S.ctx || S.ctx.state === "closed" || !blob.size) return { clarity: null, seconds: null };
    if (blob.size > 8 * 1024 * 1024) return { clarity: null, seconds: null };
    try {
      const audio = await S.ctx.decodeAudioData(await blob.arrayBuffer());
      const samples = audio.numberOfChannels ? audio.getChannelData(0) : null;
      return {
        clarity: samples && samples.length ? core.analyseSamples(samples, { sampleRate: audio.sampleRate }) : null,
        seconds: Number(audio.duration) || null,
      };
    } catch {
      return { clarity: null, seconds: null };   // best effort: an unreadable clip is still saved
    }
  }

  async function writeClip(blob, info) {
    if (!S.session) return;
    const measured = info.kind === "call" ? { clarity: null, seconds: null } : await measure(blob);
    if (!S.session) return;                       // stopped while decoding
    const n = info.kind === "call" ? 0
      : info.kind === "chunk" ? ++S.session.parts
      : ++S.session.clips;
    const suffix = info.kind === "call" ? "call" : info.kind === "chunk" ? `part${String(n).padStart(3, "0")}` : String(n).padStart(3, "0");
    const id = `${S.session.id}-${suffix}`;
    const clip = {
      id,
      sessionId: S.session.id,
      kind: info.kind,
      part: info.kind === "chunk" ? n : 0,
      createdAt: new Date(info.startedAt).toISOString(),
      duration: Math.round((measured.seconds || info.durationSec) * 10) / 10,
      size: blob.size,
      mime: "audio/webm",
      offsetSec: Math.max(0, Math.round((info.startedAt - S.captureStart) / 1000)),
      tabTitle: S.session.tabTitle || "",
      tabUrl: S.session.tabUrl || "",
      platform: S.session.platform || "",
      caller: S.session.caller || null,
      mic: !!S.session.mic,
      clarity: measured.clarity,
      fileName: fileName(info.startedAt, info.kind, n),
    };
    await store.addClip(clip, blob);
    if (info.kind === "voice") {
      S.lastClarity = measured.clarity;
      S.session.clipSeconds += clip.duration;
    }
    chrome.runtime.sendMessage({
      target: "background", type: "cg:clip-added",
      clip: {
        id: clip.id, kind: clip.kind, part: clip.part, duration: clip.duration,
        createdAt: clip.createdAt, sessionId: clip.sessionId, clarity: clip.clarity,
      },
    }).catch(() => {});
  }

  /* ---------- voice activity detection ---------- */
  function startVad() {
    const analyser = S.analyser;
    const buf = new Float32Array(analyser.fftSize);
    S.vad = setInterval(() => {
      if (!S.session || !S.analyser || !S.segmenter) return;
      S.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      S.level = Math.min(1, rms * 9);
      const act = S.segmenter.step(rms, Date.now());
      S.speech = act.loud;
      /* One continuous recording per call: with the whole-call recorder running, a pause must never
         chop the call into a new file. Speech detection still lights the meter in the dock. */
      if (!S.session.keepFullCall) {
        if (act.open) openSegment(act.open.startedAt);
        if (act.close) closeSegment(act.close);
      }
    }, FRAME_MS);
  }

  function openSegment(startedAt) {
    if (!S.dest || S.seg) return;
    let rec;
    try { rec = new MediaRecorder(S.dest.stream, RECORDER_OPTIONS); }
    catch { return; }
    const seg = { rec, startedAt, chunks: [], info: null, finish: null };
    seg.finished = new Promise((resolve) => { seg.finish = resolve; });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) seg.chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(seg.chunks, { type: S.mime });
      seg.chunks = [];
      const info = seg.info || {};
      const durationSec = Math.max(0.2, ((info.endedAt || Date.now()) - seg.startedAt) / 1000);
      if ((info.loudMs || 0) >= core.SEGMENT_DEFAULTS.minSpeechMs && blob.size > 1500) {
        saveClip(blob, { kind: "voice", startedAt: seg.startedAt, durationSec });
      }
      seg.finish();
    };
    try {
      rec.start(250);
      S.seg = seg;
    } catch { /* the next loud frame tries again */ }
  }

  function closeSegment(closed) {
    const seg = S.seg;
    if (!seg) return null;
    S.seg = null;
    seg.info = closed;
    if (seg.rec.state === "inactive") { seg.finish(); return seg; }   // never leave stop() waiting
    try { seg.rec.stop(); } catch { seg.finish(); }
    return seg;
  }

  /* ---------- whole-call recording ---------- */
  function startFull() {
    if (!S.dest) return false;
    let rec;
    try { rec = new MediaRecorder(S.dest.stream, RECORDER_OPTIONS); }
    catch { return false; }
    S.full = rec;
    S.fullChunks = [];
    S.fullStartedAt = Date.now();
    S.fullDone = new Promise((resolve) => {
      rec.addEventListener("stop", () => {
        const blob = new Blob(S.fullChunks, { type: S.mime });
        S.fullChunks = [];
        if (blob.size > 2000) {
          saveClip(blob, { kind: "call", startedAt: S.fullStartedAt, durationSec: (Date.now() - S.fullStartedAt) / 1000 });
        }
        resolve();
      }, { once: true });
    });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) S.fullChunks.push(e.data); };
    try { rec.start(2000); } catch { S.full = null; S.fullDone = null; return false; }
    return true;
  }

  /* ---------- analysis parts (queued to CallGuard while the call is live) ---------- */
  /* A part is a separate MediaRecorder restarted every CHUNK_SECONDS: a timeslice alone would
     produce fragments that can't be played or decoded on their own. The whole-call recorder keeps
     running alongside, so the evidence file is still one continuous recording. */
  function startPart() {
    if (!S.dest || !S.session || !S.session.chunkSec) return null;
    let rec;
    try { rec = new MediaRecorder(S.dest.stream, RECORDER_OPTIONS); }
    catch { return null; }
    const part = { rec, startedAt: Date.now(), chunks: [], finish: null };
    part.finished = new Promise((resolve) => { part.finish = resolve; });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) part.chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(part.chunks, { type: S.mime });
      part.chunks = [];
      const durationSec = Math.max(0.2, (Date.now() - part.startedAt) / 1000);
      if (blob.size > 1200) saveClip(blob, { kind: "chunk", startedAt: part.startedAt, durationSec });
      part.finish();
    };
    try { rec.start(1000); } catch { return null; }
    S.chunk = part;
    return part;
  }

  /** Close the current part and open the next one, so parts stay contiguous. */
  function rotatePart() {
    const part = S.chunk;
    S.chunk = null;
    if (part) {
      if (part.rec.state === "inactive") part.finish();
      else { try { part.rec.stop(); } catch { part.finish(); } }
    }
    startPart();
  }

  function stopParts() {
    clearInterval(S.chunkTimer);
    S.chunkTimer = null;
    const part = S.chunk;
    S.chunk = null;
    if (!part) return Promise.resolve();
    if (part.rec.state === "inactive") { part.finish(); return part.finished; }
    try { part.rec.stop(); } catch { part.finish(); }
    return part.finished;
  }

  /** A gain node that folds whatever it gets into one channel. */
  function mono(ctx) {
    const g = ctx.createGain();
    g.channelCount = 1; g.channelCountMode = "explicit"; g.channelInterpretation = "speakers";
    return g;
  }

  /* ---------- microphone (recording only, never to the speakers) ---------- */
  async function openMic() {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 },
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        },
        video: false,
      });
      const micSrc = S.ctx.createMediaStreamSource(mic);
      const gain = mono(S.ctx);
      gain.gain.value = MIC_GAIN;
      micSrc.connect(gain);
      gain.connect(S.merger, 0, 1);                  // right channel = me (Speaker 2)
      gain.connect(S.analyser);                      // my speech counts for voice detection too
      S.mic = mic;
      S.micSrc = micSrc;
      S.micGain = gain;
      S.session.mic = true;
      S.session.micError = "";
    } catch (e) {
      S.session.mic = false;
      S.session.micError = e && e.name === "NotAllowedError"
        ? "Chrome hasn't allowed the microphone for CallGuard. Press “Allow microphone” in the CallGuard popup to record your voice too."
        : (e && e.message) || "Microphone not available";
      chrome.runtime.sendMessage({ target: "background", type: "cg:mic-missing", reason: S.session.micError }).catch(() => {});
    }
  }

  /** Add the microphone to a capture that started before Chrome had allowed it. */
  async function addMic() {
    if (!S.session) return { ok: false, reason: "No capture is running." };
    if (!S.ctx || !S.merger) return { ok: false, reason: "The recorder isn't ready." };
    if (!S.mic) await openMic();
    return { ok: true, mic: !!S.mic, micError: S.session.micError || "" };
  }

  function closeMic() {
    try { if (S.mic) S.mic.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { if (S.micSrc) S.micSrc.disconnect(); } catch { /* ignore */ }
    try { if (S.micGain) S.micGain.disconnect(); } catch { /* ignore */ }
    S.mic = null; S.micSrc = null; S.micGain = null;
  }

  /* ---------- start / stop ---------- */
  async function start(msg) {
    if (S.session) throw new Error("A capture is already running.");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("This browser can't record tab audio.");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId } },
        video: false,
      });
    } catch {
      throw new Error("Chrome refused access to this tab's audio. Start the capture from the CallGuard icon in the toolbar.");
    }

    const ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    src.connect(ctx.destination);                    // keep the call audible while capturing
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.5;
    src.connect(analyser);
    /* Two-channel recording: left = the caller (tab audio), right = my microphone. The service
       transcribes each side on its own, so the transcript says who said what. */
    const merger = ctx.createChannelMerger(2);
    const callerMono = mono(ctx);
    src.connect(callerMono);
    callerMono.connect(merger, 0, 0);
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    merger.connect(dest);                            // recorder input

    const settings = msg.settings || {};
    S.stream = stream; S.ctx = ctx; S.src = src; S.analyser = analyser; S.dest = dest; S.merger = merger;
    S.mime = MIME || "audio/webm";
    S.level = 0; S.speech = false; S.lastClarity = null;
    S.captureStart = Date.now();
    S.session = {
      id: msg.sessionId,
      tabId: msg.tabId,
      tabUrl: msg.tabUrl || "",
      tabTitle: msg.tabTitle || "Call",
      platform: msg.platform === "whatsapp" ? "whatsapp" : "telegram",
      caller: core.cleanCaller(msg.caller || {}),
      startedAt: new Date(S.captureStart).toISOString(),
      sensitivity: core.SENSITIVITIES.includes(settings.sensitivity) ? settings.sensitivity : "medium",
      keepFullCall: settings.keepFullCall !== false,
      duplex: !!settings.duplex,
      mic: false,
      micError: "",
      clips: 0,
      clipSeconds: 0,
      parts: 0,
      /* Parts exist only when their destination is on: auto-send, and a whole-call recording that
         they belong to. With auto-send off nothing is queued, so nothing is cut up. */
      chunkSec: settings.autoSend && settings.keepFullCall !== false ? core.CHUNK_SECONDS : 0,
    };

    const track = stream.getAudioTracks()[0];
    if (track) track.addEventListener("ended", () => { stop("tab audio ended"); });

    if (S.session.duplex) await openMic();
    S.segmenter = core.createSegmenter({ threshold: core.thresholdFor(S.session.sensitivity) });
    /* The whole-call recorder is the recording: it runs from here until stop() and is saved as a
       single file, so a capture never shows up as a series of short clips. */
    if (S.session.keepFullCall && !startFull()) {
      throw new Error("The recorder didn't start in this browser. Stop other recordings and try again.");
    }
    if (S.session.chunkSec) {
      S.chunkTimer = setInterval(rotatePart, S.session.chunkSec * 1000);
      startPart();
    }
    startVad();
    S.ticker = setInterval(publish, 500);
    S.limit = setTimeout(() => { stop("max-length"); }, MAX_CALL_MS);
    publish();
    return { ok: true, sessionId: S.session.id, mic: S.session.mic, micError: S.session.micError };
  }

  async function stop(reason) {
    clearInterval(S.vad); clearInterval(S.ticker); clearTimeout(S.limit);
    S.vad = S.ticker = S.limit = null;
    if (!S.session) return { ok: true, clips: 0 };

    const session = S.session;
    const cur = S.segmenter ? S.segmenter.current() : null;
    const seg = S.seg
      ? closeSegment({ startedAt: S.seg.startedAt, endedAt: Date.now(), loudMs: cur ? cur.loudMs : core.SEGMENT_DEFAULTS.minSpeechMs })
      : null;
    if (seg) await seg.finished;
    await stopParts();
    if (S.full && S.full.state !== "inactive") {
      try { S.full.stop(); } catch { /* already stopping */ }
      if (S.fullDone) await S.fullDone;
    }
    await Promise.all([...S.saving]);

    const done = { ...session, endedAt: new Date().toISOString(), reason: reason || "stopped" };
    await store.saveSession(done).catch(() => {});
    closeMic();
    try { S.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { await S.ctx.close(); } catch { /* ignore */ }

    S.session = null; S.stream = null; S.ctx = null; S.src = null; S.analyser = null; S.dest = null;
    S.full = null; S.fullChunks = []; S.fullDone = null; S.seg = null; S.chunk = null;
    S.chunkTimer = null; S.level = 0; S.speech = false;
    S.segmenter = null;

    chrome.runtime.sendMessage({ target: "background", type: "cg:stopped", reason: done.reason, clips: done.clips }).catch(() => {});
    return { ok: true, clips: done.clips };
  }
})();
