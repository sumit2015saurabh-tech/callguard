# Chrome Web Store submission — CallGuard — Telegram call capture

Listing copy, the answers Chrome's review form asks for, and the order to submit in.
Version **1.0.0** · Manifest V3 · package `dist/callguard-extension-1.0.0.zip`.

## Listing

**Name:** CallGuard — Telegram call capture

**Short description (132 characters max):**
Capture the audio of a live Telegram Web call, split it into voice clips, and send them to CallGuard for scam analysis.

**Category:** Productivity
**Language:** English
**Homepage:** https://sumit2015saurabh-tech.github.io/callguard/
**Privacy policy URL:** host [`PRIVACY.md`](PRIVACY.md) at a public URL (GitHub Pages, or the
repository's file view) and paste that URL into the item.

### Detailed description

CallGuard protects people from scam calls. This companion extension captures a live Telegram Web
call and sends what was said to your own CallGuard dashboard, where it is transcribed, checked
against the fraud categories (F0–F9), saved with a date and token, and routed to the right person:
the bank fraud desk, a nominee, authorised contacts, or the emergency contact.

WHAT IT DOES

- A small dock appears on web.telegram.org and detects when a call is in progress.
- One click captures the call's audio, keeps the call audible, and splits speech into voice clips.
- Every clip is scored for clarity, so quiet, clipped or mostly-silent recordings are flagged
  instead of wasting an analysis.
- Send clips to CallGuard as they happen, or all at once afterwards.
- Optional: mix in your own microphone, keep one recording of the whole call, and stop
  automatically when the call ends.

WHAT IT DOES NOT DO

- It does not read your Telegram messages, contacts or account.
- It makes no network requests of its own and has no server. Audio stays on your device until you
  send it to your CallGuard dashboard, which uploads it with your signed-in session.
- It never records without you pressing Capture, and it asks you to confirm that everyone on the
  call agrees.

REQUIREMENTS

- A CallGuard account, signed in on the dashboard in the same browser.
- Google Chrome 116 or newer.

Record calls only where everyone on the call consents.

## Permission justifications (review form)

| Permission | Justification for the reviewer |
|---|---|
| `tabCapture` | Captures the audio of the Telegram tab the user explicitly starts a capture on, so the call can be recorded. |
| `activeTab` | Lets the capture start from the toolbar icon on the active tab, which Chrome requires for tab audio. |
| `audioCapture` | Used only when the user enables "Mix my microphone into the recording". |
| `offscreen` | A service worker cannot use MediaRecorder or Web Audio; a hidden document records the captured stream. |
| `storage`, `unlimitedStorage` | Stores settings and the captured clips locally (IndexedDB) so the user can preview, download or send them. |
| `scripting` | Injects the clip bridge into an already-open CallGuard dashboard tab. |
| Host `https://web.telegram.org/*` | Shows the capture dock and detects an active call. |
| Host `https://sumit2015saurabh-tech.github.io/*` | Places captured clips into the signed-in CallGuard dashboard. |

**Single purpose:** record a Telegram Web call the user starts and hand the captured audio to the
user's CallGuard dashboard for scam analysis.

**Remote code:** none. All code ships in the package; no `eval`, no remotely loaded scripts.

**Data usage:** the extension handles audio the user records. It is stored locally and sent only to
the user's CallGuard dashboard when the user sends it. It is not sold, not used for advertising or
creditworthiness, and not shared beyond the CallGuard service the user configured. Declare **Audio**
under user data and certify the Limited Use policy.

## Screenshots

At least one 1280×800 (or 640×400) screenshot. Capture a real session: the dock during a Telegram
call, and the popup with captured clips and clarity scores. Do not use mock-ups that show data
which cannot occur.

## Submit

1. Register as a Chrome Web Store developer (one-time fee) and create a new item.
2. Upload `dist/callguard-extension-1.0.0.zip`.
3. Paste the listing text above, add screenshots, and the public privacy-policy URL.
4. Fill in the permission justifications and the data-usage answers above.
5. Submit for review. Expect questions about `tabCapture`; the justification and the single-purpose
   statement above are written for that question.
