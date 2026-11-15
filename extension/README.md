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
   from the moment you press capture until you stop.
4. The recording is listed in the popup with playback, download and delete. Press
   **Analyze in CallGuard**, or **Send unsent** for everything, and the dashboard opens, analyzes it
   and saves it to history with a token and the usual alerts.
5. Auto-send is always on: each recording is handed over as soon as it is ready — 20-second parts
   while the call is live, the whole-call file when you stop — so alerts fire without waiting. The
   microservice accepts at most 120 seconds per request, so a whole-call file longer than that is
   not sent; the popup marks it **Too long · in parts** because its 20-second parts were already
   analyzed live during the call. The file stays local for playback and download.

**Stop** from the dock or the popup. A capture also ends by itself a few seconds after the call UI
disappears.

## Caller ID and source of call

The dock records the **number that is calling** as the caller ID, with the contact name shown
after it. It looks at a `tel:` link first, then the call screen, the open contact/profile panel
and the chat header, and keeps the strongest number it finds (7–15 digits, leading `+` kept).
The call's source — Telegram or WhatsApp — is labelled at the same time. Both travel with every
recording to the dashboard, which shows them on the result card, in the history table and its
**Source of call** filter, in the call detail drawer and in CSV/JSON exports. Reading the caller
is best effort: WhatsApp generates its own class names, so the extension falls back to the
visible call panel and then the open chat's header. If it can't find a number it keeps the name,
and if it finds neither it records the recording with the source and an empty caller ID rather
than guessing.

## What is recorded

- The **other party's voice**, taken from the Telegram or WhatsApp tab's audio, as one continuous
  recording per capture.
- Your own voice too: the microphone is always mixed in, at 0.8 gain so the caller stays dominant.
  It is **only** sent to the recorder — never played back through the speakers, which would cause
  feedback in the call.
- The whole-call file is never split: one file spans the capture from start to stop. It stays in the
  browser unless you send it, and the microservice accepts at most 120 seconds per request, so the
  file itself has to be trimmed before it can be analyzed; it can always be downloaded.
- The same audio is also cut into **20-second parts** that are queued and handed to the dashboard
  **one at a time**, in order, as soon as each part is ready. A long call is therefore
  analyzed while it happens, every request stays far inside the 120-second limit, and each part is
  deleted as soon as CallGuard accepts it — the popup still shows a single recording.

Everything is stored in the extension's IndexedDB on this device. Nothing is uploaded by the
extension itself: a clip only leaves the browser when you send it to CallGuard, and CallGuard
uploads it with your signed-in session (or API token) exactly like a manual upload.

## Clarity

Every **20-second analysis part** is decoded and measured before it is queued, so useless audio is
skipped instead of silently producing a bad transcript. The whole-call file is skipped — decoding 45
minutes of audio only to score it would cost far more memory than it is worth. Each part gets a
**0–100 clarity score** and a verdict:

| Verdict | Score | What it means |
|---|---|---|
| Good | 75–100 | Full level, no clipping, speech through most of the clip. |
| Fair | 50–74 | Usable, but quiet, clipped in places, or with long gaps. |
| Poor | 0–49 | Very quiet, heavily clipped, or almost entirely silence. |

The clarity gate is always on: a part that is mostly silence is dropped without spending a request
on it, and any recording that scores poor is marked *Unclear · not sent* instead of being sent
automatically — you can still send it by hand, and the score and reasons (`quiet`, `clipping`,
`mostly silence`, `long gaps`, …) show in the popup. The check runs on the actual recorded audio, so
mic mixing and tab volume are reflected in the result.

## Capture settings (fixed)

The popup has **no settings panel**. Every capture runs fully enabled:

| Always on | What it does |
|---|---|
| Whole-call recording | One `…-call.webm` per capture, from capture to stop. |
| Send to CallGuard automatically | Hands each recording over as soon as it is ready; a live call goes in 20-second parts (queued, one at a time). |
| Stop when the call ends | Ends the capture shortly after the call UI disappears. |
| Two-way recording | Adds your own voice to the recording (recorded, never played back). |
| Clarity gate | Quiet, clipped or mostly-silent audio is never auto-sent. |
| Voice detection sensitivity | High, so quiet speech is picked up too. |
| Audio quality | Opus at 128 kbps; the microphone is requested at 48 kHz. |

Only the dashboard URL (where recordings are handed over) is configurable, in
`lib/core.js` (`SETTINGS_DEFAULTS.dashboardUrl`); `mergeSettings()` re-applies the fixed options, so
a value saved by an older build can't turn a feature back off.

## Long calls

A live call is never handed over as one request. With auto-send on, the recorder closes a part every
20 seconds, saves it, and puts it in the queue; the service worker keeps one part in flight,
retries while the dashboard is busy, and deletes a part once CallGuard has it. A service worker that
Chrome unloads mid-queue resumes from the parts still marked as queued. Parts carry the same source,
caller and timestamps as the recording, so they appear in history in call order as
`…-part003.webm`.

While a capture runs, the dock in WhatsApp/Telegram shows the part count. After five minutes it
posts a warning inside the call page, and if any part comes back as fraud it says so immediately
with the category. This message is for you, in your own page: nothing is sent to the other party.

Returning to the popup's list: parts are a transport detail and are **not** listed as clips — the
call stays one recording. Turn auto-send on **before** starting a capture; the setting is read when
the capture starts.

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
2. Run the unit tests (`./extension_check.sh --fast`), then load the unpacked extension and capture
   a short call to confirm the popup lists it and it reaches CallGuard on its own.
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

`./extension_check.sh` also verifies the wiring the extension depends on: manifest and script order
in both pages, unit tests, and (when Chrome is present) that Chrome packs the extension and that the
dashboard boots.

## Limits and troubleshooting

- **“Chrome only lets tab audio be captured after a click on the extension itself.”** Chrome needs
  an explicit extension click for tab audio on some pages. Press the CallGuard toolbar icon and
  start the capture there; the badge shows `GO` until you do.
- **The call goes silent while capturing?** That means the captured audio isn't being played back;
  stop and start the capture again. Do not mute the Telegram or WhatsApp tab: muting the tab mutes
  the capture.
- **Caller ID is empty?** Neither the call screen nor a visible `tel:` link / contact panel showed
  a number when the capture started. WhatsApp hides the number for saved contacts (it shows the
  name only), and group calls have no single caller; open the contact's info panel once and its
  number is picked up on the next capture. The recording is still saved with its source, and the
  caller ID can be supplied when analysing an upload in the dashboard.
- **Long call, nothing in history yet?** Auto-send must be on when the capture starts. Parts are
  queued one at a time, so a busy dashboard lags behind the call instead of dropping anything, and
  a part that is nearly all silence is skipped instead of wasting a request.
- **“Log in to CallGuard…”** The dashboard tab is on the login screen. Log in, then send again.
- **“CallGuard is busy with another call.”** The dashboard runs one pipeline at a time; the
  extension retries a few times and otherwise leaves the clip in the list for a later send.
- **Clips not appearing in history?** Check that the dashboard's Settings has a working
  microservice URL, and that the clip is 120 seconds or shorter.
- Recording calls can require everyone's consent. The extension asks once; you remain responsible
  for following the law where you are.


## Two-way calls (your voice as Speaker 2)

The recording is always stereo: the caller on the left channel (Speaker 1), your microphone on the
right (Speaker 2). The transcription service transcribes each side
separately and labels the turns. Chrome can't show its microphone prompt inside the hidden
recorder, so the first time you capture the popup asks for it: capture starts first, then the mic
is added to the running recording once you allow it. If the prompt is refused (or you start from
the dock), the call is still recorded caller-only, and **Allow microphone** in the popup opens the
one-time grant page (`mic.html`) — no tab opens automatically.
