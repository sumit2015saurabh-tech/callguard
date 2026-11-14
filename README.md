# CallGuard: scam-call detection dashboard (SaaS)

**Live:** https://sumit2015saurabh-tech.github.io/callguard/

CallGuard is the customer-facing dashboard for a scam-call detection service. A user uploads or records a call. The dashboard sends the audio to a **transcriber microservice**, gets back a transcript and summary, gets a **fraud category (F0–F9)** from your trained model, labels the call, **alerts the right people** and keeps a **searchable history**.

It is a static single-page app (HTML/CSS/JS, no build step), hosted on GitHub Pages from `docs/`.

## Accounts (required)

Nobody sees the dashboard without logging in.

- **Sign up, two ways:**
  - **Continue with Google:** one tap using the Google account already signed in on the device (Google One Tap and the Sign in with Google button). No new password is needed, and the user ID comes from the Gmail address.
  - **Register a user ID:** full name, a unique **user ID** (3–20 characters: letters, numbers, `.` or `_`), an email, and a password (8+ characters with a letter and a number, entered twice).
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
| FX | Fraud, type not identified | |

## Alert routing

| Result | What happens |
|---|---|
| **Not fraud (F0)** | Saved with date, token and summary. No alerts. |
| **Banking fraud (F1, F2)** | Email to the **bank fraud desk** that the nominee added. |
| **Other fraud (F3–F9)** | App notification + email to the **nominee**, with the summary and a warning. |
| **Every fraud** | Email to each **authorised person** the user added. If there are none, email the **emergency contact** by default. |

## Features

- **Analyze:** upload a file (MP3/WAV/M4A/OGG/WEBM/FLAC) or record from the mic. A five-step pipeline view shows what happened.
- **Every call gets:** date, unique token (`CG-YYYYMMDD-XXXXXX`), and from the microservice: summary, transcript, category, confidence and labels.
- **History:** filter by text, date range, time-of-day range (overnight ranges work), fraud type, verdict, risk, label and alert status. Sort, and export the filtered list as CSV or JSON.
- **History folder on your computer** (Chrome/Edge): mirrors every call to `CallGuard-History/<date>/<time_type_token>/` with `call.json`, `summary.txt`, `transcript.txt`, the audio, and an `index.csv`.
- **Call detail drawer:** audio playback, transcript, labels, alert log, mark reviewed, delete.
- **Alerts:** a log of all alerts with status (sent / delivered / in outbox / failed / not sent), one-click "open in mail app", and retry.
- **Overview:** KPIs, calls-per-day chart, fraud-by-type chart (click a bar to filter history), latest fraud, and the current routing.
- **Plans and usage:** Starter / Family Pro / Business tiers with a monthly usage meter. Billing is not connected.
- **Settings:** microservice URL, notifier URL, API key, timeout, browser notifications, backup and restore.

Data stays in the user's browser (IndexedDB plus the optional local folder). Nothing is sent anywhere except the service URLs you configure.

## Connecting your microservice

The fraud category and labels always come from **your microservice**. The dashboard never guesses or simulates them.

**Default service:** `https://call-audio-api-c3qg.onrender.com/v1/audio/analyze` (set in `docs/assets/config.js`).

### Token verification

Each user pastes the **API token issued by the service** in **Settings → Microservice**. It is saved only in their browser, under their account, and never included in backups. Every request sends `Authorization: Bearer <token>`. **The service verifies the token** and answers `401` if it's missing or wrong, and the dashboard shows that clearly. Without a token, the dashboard refuses to send audio. **Test connection & token** checks three things: the service is up (`/healthz`), the browser is allowed to call it (CORS), and the token is accepted, with the classifier configured (`/v1/status`).

### Required on the service: CORS

The service must allow the dashboard's origin, or browsers block every request:

```python
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(CORSMiddleware,
    allow_origins=["https://sumit2015saurabh-tech.github.io"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"])
```

Add this middleware **after** the token-check middleware, so it wraps it and answers `OPTIONS` preflights before any token check. Otherwise preflights get `401` and the browser blocks the call.

### Microservice: `POST <serviceUrl>`, `multipart/form-data`

Exactly **one** field, `audio`, holding the uploaded or recorded call (the service rejects extra fields). The recording can be at most 120 s long, which is checked before upload.

Response (Vinit's API passes on Srivarsh's classifier result):

```json
{ "request_id": "…", "text": "<transcript>",
  "classes": ["fraud", "category:F1", "risk_level:high", "risk_score:100", "type:financial_impersonation", "flag:F01"],
  "summary": "The caller claimed to be from the bank…" }
```

- **Category:** `category:F0`…`F9` in `classes`. Otherwise `type:<scam type>`, otherwise the decision word.
  `fraud` / `uncertain` with no type becomes **FX: Fraud (type not identified)**, so the alerts still go out.
  `flag:Fnn` entries are red-flag IDs and are never read as categories.
- **Risk:** `risk_level:high|medium|low`. **Labels:** every entry in `classes`, exactly as sent.
- A `429` (busy) is retried automatically after `Retry-After`, up to 3 times.

The chain: **dashboard → Vinit's `call-audio-api` (`/v1/audio/analyze`, speech to text) → Srivarsh's `scam-classifier` (`/v1/classify`) → back to the dashboard**, which saves the call, labels it and routes the alerts.

### Notifier (optional): `POST <notifierUrl>`

Sends the emails and notifications. It receives JSON for each alert:

```json
{ "to": "fraud@bank.com", "name": "Bank", "role": "Bank", "channel": "email",
  "subject": "⚠ Banking fraud alert: Financial impersonation (CG-20261114-6Z0Y5U)",
  "body": "…summary + warning…", "call_token": "CG-…", "category": "F1",
  "category_name": "Financial impersonation", "risk": "high", "created_at": "2026-11-14T12:17:00Z" }
```

Without a notifier, alerts wait in the **outbox**. Emails open in the user's mail app with one click.

## Run locally

```bash
cd docs && python3 -m http.server 8000   # open http://localhost:8000
```

## Switching on Google sign-in

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** of type **Web application**.
2. Under **Authorised JavaScript origins**, add `https://sumit2015saurabh-tech.github.io` (and `http://localhost:8000` for local testing).
3. Paste the client ID into `docs/assets/config.js` as `googleClientId`, then push.
