# Morphly release readiness

The approved white/red theme, customer communications, camera-repair changes, voice-buffer improvements and authentication fixes are included in version 2.5.2. The version tag triggers the Windows release workflow; an installer is available only after artifact verification and publication succeed. Final affected-device acceptance and production email activation remain external checks, not completed tests. See `docs/releases/v2.5.2.md`.

## White/red theme — approved and implemented

- Interactive sample: `design-previews/morphly-white-red.html`.
- Dashboard image: `design-previews/morphly-white-red.png`.
- Review dialog image: `design-previews/morphly-white-red-feedback.png`.
- Follows the installed UI/UX Pro Max skill's minimal/Swiss dashboard guidance: white surfaces, readable dark text, red primary buttons, restrained borders, and green status indicators with text.
- Keeps voice controls left, live output right, session controls below, and a small dismissible announcement at the top.
- Checked at 1440, 1000 and 375 pixels. Red button/white label contrast is 5.58:1.
- Shared tokens in `app/src/styles/theme.css` now style the actual dashboard, login/signup, settings, wallet, billing, admin pages, feedback, navigation, menus, onboarding and error/update surfaces. The private admin portal and customer email templates also use white/red.
- Electron startup/error/capture windows use white surfaces and a forced light native theme, independent of Windows dark mode. Video frame content and camera output pixels are intentionally unchanged.
- 139 Node tests, TypeScript, and the production Vite build pass. The page audit uses isolated browser fixtures: no live model, camera, microphone, payment or email is started.
- The original images above remain design samples, not evidence of a running voice engine. Current UI screenshots are under `build/engagement-qa/theme-*.png`.

## Virtual-camera registration — implementation complete, affected-device check required

User reports failure on new devices and after updating the current release. Do not mark this fixed based only on a build or this machine's registry.

Implemented:

- `app/build/afterPack.cjs` copies both DirectShow and Media Foundation components; it does not register a camera on the user's device.
- `app/build/installer.nsh` registers and verifies both components during NSIS installation. Package configuration uses a per-machine installer with elevation.
- The updater's uninstall hook preserves registrations; the incoming installer refreshes COM paths. The native registrar preserves a healthy camera identity and handles a locked DLL with a versioned side-by-side binary.
- Settings → Virtual Camera offers a checked, single-flight repair. Elevation is requested only by the user's repair action, never by status polling. Repair is blocked during live streaming; success requires a fresh registration check.
- Routine and installer probes check COM activation/enumeration without competing for a live video stream. The explicit native `probe` command retains its video-frame test.
- Windows 10 installs retain the legacy camera without attempting the Windows 11 Media Foundation API; the UI explains the modern-camera limitation.

Validation: C++ build, NSIS install/uninstall macro compilation, repair-service tests, and browser tests for busy/cancel/retry/verified states passed. Browser IPC was mocked: those UI tests do not prove Windows registration. An earlier local native probe passed, but Windows Application Control blocked execution of the final newly compiled helper. No policy was disabled or bypassed. Verify an appropriately signed/trusted build on a clean Windows 11 device and an upgrade from the previous release, including WhatsApp enumeration and live frames, before claiming affected-device acceptance. No OS registration was modified during these checks.

## Voice performance — buffering fixes implemented and measured

User reports lag despite strong hardware. The affected machine has not been benchmarked; its exact cause is not confirmed.

Implemented in `app/server/meanvc-realtime.py` and `app/server/meanvc-runtime.js`:

- The bundled engine uses CPU inference.
- Device blocks are 160 ms; inference processes two 80 ms model blocks.
- Lower requested driver latency; WASAPI preferred with shared-mode format conversion and matching microphone/output drivers. Full device names remain distinguishable, including after status refresh.
- One queued input and at most two queued outputs; stale audio is discarded. Playback starts with one block and adds a safety block when measured processing approaches the deadline. Short fades soften underruns without replaying stale speech.
- Inference stays on the worker, outside the audio callback. Models warm without any voice profile or audio stream; Start reuses the process. Upstream offline feature-history tensors are released during live processing to prevent long-session RAM growth.
- Bundled status polling and Start no longer synchronously discover/probe a separate Python installation on Electron's main thread. This removes a source of UI and camera-frame stalls.
- The readiness details expose processing time, actual driver latency, queue depth and gaps. Overload is reported, not hidden by increasing latency indefinitely.

Validation: seven mocked audio regression tests pass and now run in the release workflow after runtime restoration. A real bundled-model smoke test warmed without a profile or microphone, processed synthetic audio for 12 seconds, changed pitch 0 → +4 → −4, and stopped cleanly. On the local i5-1135G7, the isolated run measured 116.3 ms mean / 123.2 ms p95 processing per 160 ms device block, no input/output drops and one startup underrun. A concurrent build/browser stress run missed deadlines (387.9 ms mean, with drops); hardware capacity and other workloads still matter. These are synthetic processing measurements, not microphone-to-speaker latency or perceived voice-quality certification. Test sustained conversion with the affected laptop's actual microphone/output before claiming universal lag-free performance.

To repeat without microphone access, run from `app/.meanvc/runtime-40ms`:

```powershell
./python.exe ../../tests/voice-runtime-smoke.py
```

## Customer emails, reviews and announcements

Implementation and local tests complete; activation steps and remaining production configuration are in `docs/customer-communications.md`.
