# Large installer and interrupted updates

## Confirmed cause

The published v2.5.2 installer is 2,135,829,711 bytes (2.14 GB decimal).
The bundled local voice runtime is approximately 2,807 MiB before existing
packaging exclusions; its model files account for approximately 1,999 MiB.
The largest is the 1,302 MB WavLM speaker-reference checkpoint, which the
voice pipeline actually loads. It cannot simply be removed without breaking
voice matching. The installer already uses maximum compression.

The installed app's updater log on the affected machine confirms repeated
15-minute download timeouts and a subsequent `EPERM` on the partial installer.
The previous downloader enforced a total-duration timeout, discarded partial
progress, and did not reliably close the file writer when the network failed.

## Implemented locally

- An inactivity timeout replaces the total-duration limit: a slow but active
  download can continue longer than 15 minutes.
- Transient network/server failures retry with bounded backoff. Partial files
  survive retry exhaustion and app restarts.
- Resume uses validated HTTP ranges and matching release identity. Without a
  published digest, a strong ETag is required to combine responses safely.
- Servers that ignore ranges restart safely; changed or invalid ranges are
  rejected. The complete installer is verified before promotion and again
  before installation.
- Every attempt closes its reader and file handle, including cancellation and
  failure. Single-flight ownership begins before asynchronous cache checks.
- Available disk space is checked; progress includes download speed and ETA.

These changes do not modify the installed app or a published release. The user
must install a new build to get the corrected updater. No downloaded user file,
installed model, or existing log was removed during development.

## Package-size decision

A substantially smaller application installer requires separating the voice
runtime from app updates: install/download a versioned, verified engine once,
retain it across updates, and reuse it offline thereafter. This changes the
previous all-in-one/offline-installer requirement and needs the user's choice.
No model precision, model file, or voice feature was removed to claim a smaller
download. No reduced installer size has been measured or promised yet.

## Tests

Regression tests cover network interruption/resume, application restart,
cancellation, complete cached partials, ignored/malformed ranges, changed
release identity, checksum mismatch, non-retryable HTTP errors, validator
changes, and real local HTTP transfers that are slow or stalled. The tests do
not download the 2 GB release or start an installer, microphone or camera.
