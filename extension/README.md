# CallGuard capture extension (Telegram & WhatsApp Web)

A Manifest V3 Chrome extension that records the audio of a **live Telegram Web or WhatsApp Web
call** and sends the recording into the **CallGuard dashboard**, where it runs through the normal
pipeline: microservice → transcript, summary and fraud category → history → alert routing. Each
recording also carries the **source of the call** (Telegram or WhatsApp) and the **caller ID** read
from the call screen.

The extension has no build step, no runtime dependencies and makes no network requests of its
own. Privacy: [`PRIVACY.md`](PRIVACY.md). Current release: **1.1.0** (Manifest V3).

## Install

1. Sign in to CallGuard in a tab, e.g. <https://sumit2015saurabh-tech.github.io/callguard/>.
   Clips are handed to that tab, so the account must be logged in there.
2. Open `chrome://extensions`, switch on **Developer mode**, choose **Load unpacked**, and pick
   this `extension/` folder.
3. Pin the CallGuard icon to the toolbar.

For a packaged install, drag the zip from [Release](#release) onto `chrome://extensions`, or publish
it to the Chrome Web Store.

## Capture a call

1. Open the call at `web.telegram.org` (Web K or Web A) or `web.whatsapp.com`. A small
   **CallGuard dock** appears in the bottom-right corner; it shows whether a call is detected, the
   platform, and the caller it can read from the call screen.
2. Press **Capture this call** in the dock, or press the CallGuard toolbar icon and use
   **Capture this call** there. The first time you are asked to confirm that everyone on the call
   agrees to being recorded.
3. Speak normally. The extension plays the captured audio back through your speakers (Chrome mutes
   a captured tab, so this keeps the call audible) and records the call as **one continuous file**
   from the moment you press capture until you stop. Turn off *Record the whole call as one
   continuous file* in Settings to get a separate short clip per utterance instead (a pause of
   about a second closes a clip, and long speech is split at 40 seconds).
4. The recording is listed in the popup with playback, download and delete. Press
   **Analyze in CallGuard**, or **Send unsent** for everything, and the dashboard opens, analyzes it
   and saves it to history with a token and the usual alerts. The microservice accepts at most
   120 seconds per request, so a whole-call file longer than that must be trimmed (or captured as
   short clips) before it can be analyzed; it can always be downloaded.
5. Turn on **Send to CallGuard automatically** (Settings) to have each recording handed over as
   soon as it is ready — a clip while the call is live, the whole-call file when you stop — so
   alerts fire without waiting.

**Stop** from the dock or the popup. With **Stop when the call ends** on, a capture also ends by
itself a few seconds after the call UI disappears.

## Caller ID and source of call

The dock reads the contact name (and phone number, when WhatsApp shows one for an unsaved
contact) from the call screen, and labels the capture with the platform — Telegram or WhatsApp.
Both travel with every clip to the dashboard, which shows them on the result card, in the
history table and its **Source of call** filter, in the call detail drawer and in CSV/JSON
exports. Reading the caller is best effort: WhatsApp generates its own class names, so the
extension falls back to the visible call panel and then the open chat's header. If it can't find
a name it records the clip with the source and an empty caller ID rather than guessing.

## What is recorded

- The **other party's voice**, taken from the Telegram or WhatsApp tab's audio, as one continuous
  recording per capture (or as separate voice clips, when the whole-call file is switched off).
- Your own voice too, when **Mix my microphone into the recording** is on (Settings). The mic is
  mixed in at 0.8 gain so the caller stays dominant, and it is **only** sent to the recorder — never
  played back through the speakers, which would cause feedback in the call.
- The whole-call file is never split: one file spans the capture from start to stop. The microservice
  accepts at most 120 seconds per request, so a longer call must be trimmed (or captured as short
  clips) before it can be analyzed; it can always be downloaded.

Everything is stored in the extension's IndexedDB on this device. Nothing is uploaded by the
extension itself: a clip only leaves the browser when you send it to CallGuard, and CallGuard
uploads it with your signed-in session (or API token) exactly like a manual upload.

## Clarity

Every **voice clip** (up to 40 s, i.e. when the whole-call file is switched off) is decoded and
measured before it is stored, so a useless recording is visible instead of silently producing a bad
transcript. The whole-call file is skipped — decoding 45 minutes of audio only to score it would
cost far more memory than it is worth. Each voice clip gets a **0–100 clarity score** and a verdict:

| Verdict | Score | What it means |
|---|---|---|
| Good | 75–100 | Full level, no clipping, speech through most of the clip. |
| Fair | 50–74 | Usable, but quiet, clipped in places, or with long gaps. |
| Poor | 0–49 | Very quiet, heavily clipped, or almost entirely silence. |

The popup shows the score and the reasons (`quiet`, `clipping`, `mostly silence`, `long gaps`, …).
With **Don't auto-send clips with poor clarity** on (default), a poor clip is kept and marked
*Unclear · not sent* instead of being sent automatically; you can still send it by hand. The check
runs on the actual recorded audio, so mic mixing and tab volume are reflected in the result.

## Settings (toolbar icon → Settings)

| Setting | Default | What it does |
|---|---|---|
| CallGuard dashboard URL | the public dashboard | Where recordings are handed over. Another host asks for site access the first time. |
| Send to CallGuard automatically | off | Hands each recording over as soon as it is ready (queued, one at a time). |
| Record the whole call as one continuous file | on | One `…-call.webm` per capture. Uncheck for a short clip per utterance. |
| Stop when the call ends | on | Ends the capture shortly after the call UI disappears. |
| Mix my microphone into the recording | off | Adds your own voice to every clip (recording only). |
| Don't auto-send clips with poor clarity | on | Keeps quiet or clipped clips locally until you send them. |
| Voice detection sensitivity | medium | Lower thresholds pick up quieter speech; raise it in a noisy room. |

The toolbar badge shows `REC` while capturing (or the clip count when you record a clip per
utterance), and `GO` if Chrome wants the capture started from the icon (see below).

## How it works

```
Telegram / WhatsApp tab ──tabCapture──▶ offscreen document (Web Audio + MediaRecorder)
                                        │  one continuous recording (VAD only for the meter)
                                        ▼
                                   IndexedDB (audio + metadata)
                                        │
   popup ──chrome.runtime──▶ service worker ──chrome.tabs.sendMessage──▶ content.js in the
                                                                        dashboard tab
                                                                             │ window.postMessage
                                                                             ▼
                                                          CallGuard app.js → runPipeline
```

- `background.js` — service worker: starts/stops the capture, finds or opens the dashboard tab,
  queues clips, paints the badge. No network access.
- `offscreen.js` — the recorder. MV3 service workers have no `MediaRecorder`, so an offscreen
  document does the Web Audio routing, the recording (one continuous file, or VAD clips) and the
  IndexedDB writes.
- `content.js` — the call dock on Telegram and WhatsApp (including caller-ID reading), and the
  bridge that posts a clip into the dashboard page.
- `docs/assets/app.js` handles `postMessage` clips in `importExtensionClip()` and reuses
  `runPipeline()`, so extension clips behave exactly like uploads (history, labels, alerts).
- `lib/core.js` — the pure logic: settings validation, URL helpers, the VAD segmenter and clarity
  scoring. No `chrome.*`, DOM or Web Audio, so it is covered by unit tests.
- `store.js`, `popup.html/js/css` — shared IndexedDB helper and the popup UI.

The dashboard must be loaded *after* the extension is installed once, so its content script can
relay clips; the extension reloads/reinjects the bridge when needed.

## Permissions

| Permission | Why |
|---|---|
| `tabCapture` | Read the audio of the Telegram tab (only while you press capture). |
| `activeTab` | Lets the capture start from the toolbar icon. |
| `audioCapture` | Mix the microphone into the recording when that setting is on. |
| `offscreen` | Host the recorder, which a service worker cannot do. |
| `storage`, `unlimitedStorage` | Settings and the clip store. |
| `scripting` | Inject the bridge into an already-open dashboard tab. |
| Host: `web.telegram.org`, `web.whatsapp.com` | Show the dock, read the caller and know when a call is in progress. |
| Host: the dashboard | Relay clips into the page. |

## Release

Current version: **1.1.0**. No build step, no dependencies — the folder (or the zip) is the release.

```bash
node --test extension/test/*.test.js                                   # unit tests
mkdir -p dist && (cd extension && zip -r ../dist/callguard-extension-1.1.0.zip . -x 'test/*' -x 'STORE.md')
```

Before uploading:

1. Bump `version` in `manifest.json` and the zip name above; Chrome refuses a repeated version.
2. Run the unit tests, then load the unpacked extension and press **Settings → Run reliability
   checks**.
3. Capture a short Telegram call and a short WhatsApp call end to end: clip captured → clarity
   shown → sent → appears in the dashboard's history with a token, the correct source and caller
   ID, and alerts.
4. Publish the dashboard with `./deploy.sh` whenever `docs/assets/app.js` changes, so the bridge
   that accepts clips is live before the extension is handed out.
5. Paste the listing text, permission justifications and data-usage answers from
   [`STORE.md`](STORE.md) into the Chrome Web Store item, add screenshots, and give it a public URL
   for [`PRIVACY.md`](PRIVACY.md).

## Tests and checks

Unit tests in `extension/test/core.test.js` cover the parts that are easy to get subtly wrong — voice-activity segmentation,
settings validation, URL handling and clarity scoring:

```bash
node --test extension/test/*.test.js        # Node 18+
```

Or run every check at once, from the repository root:

```bash
./extension_check.sh              # syntax, manifest, wiring, tests, hygiene, dashboard bridge,
                                 # plus Chrome's own pack validation and a headless boot
./extension_check.sh --fast       # skip the Chrome checks
./extension_check.sh --package    # also build dist/callguard-extension-<version>.zip
```

The popup also has **Settings → Run reliability checks**, which verifies at runtime: tab-capture and
offscreen APIs present, bridge injection available, clip storage readable/writable, a Telegram tab
open, the dashboard URL valid, and whether the dashboard bridge answers (i.e. the dashboard tab is
loaded and logged in). Everything is reported as a pass/fail line, so a broken setup is obvious
before a call starts.

## Limits and troubleshooting

- **“Chrome only lets tab audio be captured after a click on the extension itself.”** Chrome needs
  an explicit extension click for tab audio on some pages. Press the CallGuard toolbar icon and
  start the capture there; the badge shows `GO` until you do.
- **The call goes silent while capturing?** That means the captured audio isn't being played back;
  stop and start the capture again. Do not mute the Telegram or WhatsApp tab: muting the tab mutes
  the capture.
- **Caller ID is empty?** The call screen showed no readable contact name when the capture started
  (WhatsApp's markup is generated, and group calls have no single caller). The clip is still saved
  with its source; the caller ID can be supplied when analysing an upload in the dashboard.
- **“Log in to CallGuard…”** The dashboard tab is on the login screen. Log in, then send again.
- **“CallGuard is busy with another call.”** The dashboard runs one pipeline at a time; the
  extension retries a few times and otherwise leaves the clip in the list for a later send.
- **Clips not appearing in history?** Check that the dashboard's Settings has a working
  microservice URL, and that the clip is 120 seconds or shorter.
- Recording calls can require everyone's consent. The extension asks once; you remain responsible
  for following the law where you are.
