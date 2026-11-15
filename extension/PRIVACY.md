# CallGuard capture extension — privacy

The extension records a Telegram Web call **you choose to capture** and hands the audio to the
CallGuard dashboard you are signed in to. This page describes exactly what that involves.

## What is recorded

- Audio of the Telegram tab, from the moment you press **Capture this call** until you press
  **Stop** (or the call ends on its own). It is saved as one continuous recording per capture. The
  same audio is also cut into 20-second parts that are queued for the dashboard automatically, one
  request at a time.
- Your microphone: it is always mixed into the recording and never played back.

## Where the audio is stored

In this browser, on this device: the extension's own IndexedDB, which Chrome isolates per
extension. Recording stops storing anything as soon as the capture ends, and a 20-second part is deleted from
the extension as soon as CallGuard accepts it. You can play, download or delete each recording in
the popup, and uninstalling the extension removes the store.

## What leaves the device, and when

Nothing is transmitted while recording. A recording is sent automatically once it is ready, or when
you press **Analyze in CallGuard** or **Send unsent**.
In that case the clip goes to the CallGuard dashboard tab you are signed in to, which uploads it to
the CallGuard microservice for transcription and fraud classification. From there, the dashboard's
own privacy and retention rules apply.

The extension itself makes **no network requests** and has no server.

## What is not collected

No analytics, telemetry, crash reporting, advertising identifiers, browsing history, cookies, or
account credentials. The extension does not read Telegram message text, contacts, or account data;
its content script only detects whether the call UI is present and drives the dock and the clip
hand-over.

## Microphone

`getUserMedia` is called when a capture starts, and only while a capture runs. Chrome records it
into the same recording; the raw microphone stream is not stored or sent separately.

## Consent

Recording calls can require the consent of everyone on the call. The extension asks you to confirm
this once before the first capture. That confirmation is not a legal substitute — you remain
responsible for following the law where you are.

## Changes

Material changes to what is recorded or transmitted will be noted in this file and in the release
notes of the extension.
