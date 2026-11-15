# CallGuard capture extension (Telegram Web)

A Manifest V3 Chrome extension that records the audio of a **live Telegram Web call** and sends
each spoken segment ("voice clip") into the **CallGuard dashboard**, where it runs through the
normal pipeline: microservice → transcript, summary and fraud category → history → alert routing.

The extension has no build step, no runtime dependencies and makes no network requests of its
own. Privacy: [`PRIVACY.md`](PRIVACY.md). Current release: **1.0.0** (Manifest V3).

## Install

1. Sign in to CallGuard in a tab, e.g. <https://sumit2015saurabh-tech.github.io/callguard/>.
   Clips are handed to that tab, so the account must be logged in there.
2. Open `chrome://extensions`, switch on **Developer mode**, choose **Load unpacked**, and pick
   this `extension/` folder.
3. Pin the CallGuard icon to the toolbar.

For a packaged install, drag the zip from [Release](#release) onto `chrome://extensions`, or publish
it to the Chrome Web Store.

## Capture a call

1. Open the call at `web.telegram.org` (Web K or Web A). A small **CallGuard dock** appears in the
   bottom-right corner; it shows whether a call is detected.
2. Press **Capture this call** in the dock, or press the CallGuard toolbar icon and use
   **Capture this call** there. The first time you are asked to confirm that everyone on the call
   agrees to being recorded.
3. Speak normally. The extension plays the captured audio back through your speakers (Chrome mutes
   a captured tab, so this keeps the call audible) and starts a clip whenever a voice is detected.
   A pause of about a second closes the clip; long speech is split into 40-second clips.
4. Clips are listed in the popup with playback, download and delete. Press
   **Analyze in CallGuard** on a clip, or **Send unsent** for all of them, and the dashboard opens,
   analyzes the clip and saves it to history with a token and the usual alerts.
5. Turn on **Send each voice clip to CallGuard while the call is live** (Settings) to have every
   clip analyzed as soon as it is captured, so alerts fire during the call rather than after it.

**Stop** from the dock or the popup. With **Stop when the Telegram call ends** on, a capture also
ends by itself a few seconds after the call UI disappears.

## What is recorded

- The **other party's voice**, taken from the Telegram tab's audio, split into voice clips.
- Your own voice too, when **Mix my microphone into the recording** is on (Settings). The mic is
  mixed in at 0.8 gain so the caller stays dominant, and it is **only** sent to the recorder — never
  played back through the speakers, which would cause feedback in the call.
- Optionally the whole call as one separate recording (Settings → *Also keep the whole call*). That
  file is for download only; it is never sent to the microservice, because the service accepts at
  most 120 seconds per request.

Everything is stored in the extension's IndexedDB on this device. Nothing is uploaded by the
extension itself: a clip only leaves the browser when you send it to CallGuard, and CallGuard
uploads it with your signed-in session (or API token) exactly like a manual upload.

## Clarity

Every **voice clip** (up to 40 s) is decoded and measured before it is stored, so a useless
recording is visible instead of silently producing a bad transcript. The whole-call file is skipped
— decoding 45 minutes of audio only to score it would cost far more memory than it is worth. Each
voice clip gets a **0–100 clarity score** and a verdict:

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
| CallGuard dashboard URL | the public dashboard | Where clips are handed over. Another host asks for site access the first time. |
| Send each voice clip while the call is live | off | Analyzes every new clip automatically (queued, one at a time). |
| Also keep the whole call as one recording | on | Saves one `…-call.webm` for evidence/download. |
| Stop when the Telegram call ends | on | Ends the capture shortly after the call UI disappears. |
| Mix my microphone into the recording | off | Adds your own voice to every clip (recording only). |
| Don't auto-send clips with poor clarity | on | Keeps quiet or clipped clips locally until you send them. |
| Voice detection sensitivity | medium | Lower thresholds pick up quieter speech; raise it in a noisy room. |

The toolbar badge shows `REC` and the clip count while capturing, and `GO` if Chrome wants the
capture started from the icon (see below).

## How it works

```
web.telegram.org tab ──tabCapture──▶ offscreen document (Web Audio + MediaRecorder)
                                        │  voice-activity detection → clips
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
  document does the Web Audio routing, VAD splitting and IndexedDB writes.
- `content.js` — the Telegram dock, and the bridge that posts a clip into the dashboard page.
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
| Host: `web.telegram.org` | Show the dock and know when a call is in progress. |
| Host: the dashboard | Relay clips into the page. |

## Release

Current version: **1.0.0**. No build step, no dependencies — the folder (or the zip) is the release.

```bash
node --test extension/test/*.test.js                                   # unit tests
mkdir -p dist && (cd extension && zip -r ../dist/callguard-extension-1.0.0.zip . -x 'test/*' -x 'STORE.md')
```

Before uploading:

1. Bump `version` in `manifest.json` and the zip name above; Chrome refuses a repeated version.
2. Run the unit tests, then load the unpacked extension and press **Settings → Run reliability
   checks**.
3. Capture a short Telegram call end to end: clip captured → clarity shown → sent → appears in the
   dashboard's history with a token and alerts.
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
  stop and start the capture again. Do not mute the Telegram tab: muting the tab mutes the capture.
- **“Log in to CallGuard…”** The dashboard tab is on the login screen. Log in, then send again.
- **“CallGuard is busy with another call.”** The dashboard runs one pipeline at a time; the
  extension retries a few times and otherwise leaves the clip in the list for a later send.
- **Clips not appearing in history?** Check that the dashboard's Settings has a working
  microservice URL, and that the clip is 120 seconds or shorter.
- Recording calls can require everyone's consent. The extension asks once; you remain responsible
  for following the law where you are.
