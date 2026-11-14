# CallGuard: scam-call detection dashboard (SaaS)

**Live:** https://sumit2015saurabh-tech.github.io/callguard/

CallGuard is the customer-facing dashboard for a scam-call detection service. A user uploads or records a call. The dashboard sends the audio to a **transcriber microservice**, gets back a transcript and summary, gets a **fraud category (F0–F9)** from your trained model, labels the call, **alerts the right people** and keeps a **searchable history**.

It is a static single-page app (HTML/CSS/JS, no build step), hosted on GitHub Pages from `docs/`.

## Accounts (required)

Nobody sees the dashboard without logging in.

- **Sign up, two ways:**
  - **Continue with Google:** one tap using the Google account already signed in on the device (Google One Tap and the Sign in with Google button). No new password is needed, and the user ID comes from the Gmail address.
  - **Register a user ID:** full name, a unique **user ID** (3–20 characters: letters, numbers, `.` or `_`), an optional email, and a password (8+ characters with a letter and a number, entered twice).
- **Log in:** Continue with Google, or user ID / email plus password. Google users can also set a password in Settings. You can stay logged in on the device for up to 30 days.
- **Per-user data:** each account has its own calls, contacts, settings and history.
- **Settings → Account:** change password, log out.
- **Security:** passwords are never stored. Only a salted PBKDF2-SHA-256 hash (210,000 rounds) is kept, compared in constant time.
- **Limitation:** there is no server yet, so accounts live in the browser where they were created. To log in from any device, connect an auth backend (Firebase Auth, Supabase or your own API) behind the same screens.

## Fraud categories

| Code | Category | Banking? |
|---|---|---|
| F0 | Not fraud | – |
| F1 | Financial impersonation | ✔ |
| F2 | Account takeover | ✔ |
| F3 | Government impersonation | |
| F4 | Tech support / business impersonation | |
| F5 | Romance / catfishing | |
| F6 | Pig-butchering / investment | |
| F7 | Honeytrap / sextortion | |
| F8 | Family emergency / voice clone | |
| F9 | Prize / job / advance-fee | |

## Alert routing

| Result | What happens |
|---|---|
| **Not fraud (F0)** | Saved with date, token and summary. No alerts. |
| **Banking fraud (F1, F2)** | Email to the **bank fraud desk** that the nominee added. |
| **Other fraud (F3–F9)** | App notification + email to the **nominee**, with the summary and a warning. |
| **Every fraud** | Email to each **authorised person** the user added. If there are none, email the **emergency contact** by default. |

## Features

- **Analyze:** upload a file (MP3/WAV/M4A/OGG/WEBM/FLAC) or record from the mic. A five-step pipeline view shows what happened.
- **Every call gets:** date, unique token (`CG-YYYYMMDD-XXXXXX`), summary, transcript, duration, word/token count, category, confidence, risk, and auto labels (`otp-request`, `money-request`, `urgency`, `threat`, `gift-card`, `crypto`, `remote-access`, `secrecy`, `banking`, `needs-review`, …) plus your own labels.
- **History:** filter by text, date range, time-of-day range (overnight ranges work), fraud type, verdict, risk, label and alert status. Sort, and export the filtered list as CSV or JSON.
- **History folder on your computer** (Chrome/Edge): mirrors every call to `CallGuard-History/<date>/<time_type_token>/` with `call.json`, `summary.txt`, `transcript.txt`, the audio, and an `index.csv`.
- **Call detail drawer:** audio playback, transcript, labels, alert log, a "correct type" review (re-routes alerts), mark reviewed, delete.
- **Alerts:** a log of all alerts with status (sent / delivered / in outbox / failed / not sent), one-click "open in mail app", and retry.
- **Overview:** KPIs, calls-per-day chart, fraud-by-type chart (click a bar to filter history), latest fraud, and the current routing.
- **Plans and usage:** Starter / Family Pro / Business tiers with a monthly usage meter. Billing is not connected.
- **Settings:** Demo vs Live mode, service URLs, API key, timeout, browser notifications, backup and restore, sample data.

Data stays in the user's browser (IndexedDB plus the optional local folder). Nothing is sent anywhere except the service URLs you configure.

## Connecting your services (Live mode)

Set these in **Settings → Services**. The API key, if set, is sent as `Authorization: Bearer <key>` and `X-API-Key`. Each service must allow CORS from the dashboard's origin.

### 1. Transcriber microservice (required)

`POST <transcriberUrl>` with `multipart/form-data`:

| field | value |
|---|---|
| `file` | the audio |
| `call_token` | CallGuard's token for this call |

Response JSON. Only `transcript` or `summary` is required:

```json
{
  "transcript": "Caller: This is your bank...",
  "summary": "Caller pretends to be the bank and asks for the OTP.",
  "duration": 112,
  "language": "en",
  "tokens": 154,
  "category": "F1",
  "confidence": 0.91
}
```

If the transcriber already returns `category` (`"F3"`, `3`, or a category name), it is used directly.

### 2. Classifier: your trained model (optional)

Called only when the transcriber gives no category.

`POST <classifierUrl>` with JSON `{"transcript": "...", "summary": "...", "call_token": "CG-..."}` returns `{"category": "F0".."F9", "confidence": 0.0–1.0}`.

### 3. Notifier (optional)

Sends the emails and push notifications.

`POST <notifierUrl>` with JSON for each alert:

```json
{ "to": "fraud@bank.com", "name": "Bank", "role": "Bank", "channel": "email",
  "subject": "⚠ Banking fraud alert: Financial impersonation (CG-20261114-6Z0Y5U)",
  "body": "…summary + warning…", "call_token": "CG-…", "category": "F1",
  "category_name": "Financial impersonation", "risk": "high", "created_at": "2026-11-14T12:17:00Z" }
```

Without a notifier, emails wait in the **outbox** and open in the user's mail app with one click.

## Demo mode

The default mode. No audio leaves the browser: the transcriber and classifier responses are simulated from built-in sample calls, so the whole flow can be tried on the public site. **Load sample history** fills the dashboard with example calls and example contacts.

## Run locally

```bash
cd docs && python3 -m http.server 8000   # open http://localhost:8000
```

## Switching on Google sign-in

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** of type **Web application**.
2. Under **Authorised JavaScript origins**, add `https://sumit2015saurabh-tech.github.io` (and `http://localhost:8000` for local testing).
3. Paste the client ID into `docs/assets/config.js` as `googleClientId`, then push.
