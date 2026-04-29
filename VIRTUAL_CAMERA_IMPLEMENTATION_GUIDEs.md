# Windows Virtual Camera Implementation Guide
## How to Build a System-Wide Virtual Camera on Windows (MF + DirectShow + Electron)

This guide documents exactly how Morphly's virtual camera ("Morphly G1") was implemented end-to-end — including every pitfall that caused hours of debugging. Follow this precisely and you will not need to debug any of these issues yourself.

---

## Architecture Overview

The system is split into five components that work as a pipeline:

```
Electron Renderer (canvas pixels)
    ↓  IPC (sendVirtualCameraFrame)
Electron Main Process (main.js)
    ↓  stdin pipe (40-byte header + BGRA payload)
morphly_cam_pipe_publisher.exe
    ↓  writes to file bridge (mf-bridge.bin)
MorphlyVirtualCameraMF.dll (MF Source, loaded by FrameServer)
    ↓  delivers NV12 frames
Windows Camera Framework (FrameServer.exe)
    ↓  exposes as camera device
WhatsApp / Zoom / Browser (getUserMedia)
```

There are **two DLLs**: one for DirectShow (legacy apps, OBS), one for Windows Media Foundation (modern apps, browsers, WhatsApp). Both must be registered. The MF DLL is the critical one for browsers and Teams/WhatsApp. The DirectShow DLL supports OBS and older apps.

---

## Part 1: Component Design

### 1.1 Shared Memory Protocol (`morphly_protocol.h`)

Define a single header struct that sits at byte 0 of the shared buffer. The publisher writes it; the MF source reads it.

```cpp
struct SharedFrameHeader {
    uint32_t magic;               // 0x4D43414D ("MCAM") — validate on read
    uint32_t version;             // protocol version, currently 1
    uint32_t width;               // frame width in pixels
    uint32_t height;              // frame height in pixels
    uint32_t stride;              // bytes per row (width * 4 for BGRA)
    uint32_t pixelFormat;         // 1 = BGRA32
    uint32_t fpsNumerator;        // e.g. 30
    uint32_t fpsDenominator;      // e.g. 1
    uint32_t payloadBytes;        // total pixel data bytes (stride * height)
    uint32_t reserved;            // used as seqlock sequence number (see below)
    uint64_t frameCounter;        // monotonically increasing frame number
    int64_t  timestampHundredsOfNs; // wall-clock timestamp (100ns units)
};
```

The pixel payload follows immediately after this struct in memory.

**Critical pitfall — seqlock correctness:** The `reserved` field is the seqlock sequence number. The publisher must increment it BEFORE writing frame data (to signal "write in progress") and THEN again AFTER writing is complete (to signal "safe to read"). The reader spins until it reads the same even value twice with no change — this means the write window is closed. **If you increment frameCounter before closing the write window, readers will read a partially written frame.** Always increment frameCounter as the LAST step inside the write window, just before the second seqlock increment.

### 1.2 Frame Bridge — Two Paths

The MF source attempts to open frames in this priority order:

1. **File bridge** (`C:\Users\Public\Documents\MorphlyG1\mf-bridge.bin`) — preferred because it works across session boundaries (e.g. FrameServer runs in Session 0, publisher runs in user session). The publisher creates this file with a file-backed memory map and writes frames to it. The MF source opens it read-only with `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`.

2. **Global shared memory** (`Global\MorphlyCam.FrameBuffer`) — requires `SeCreateGlobalPrivilege`. Only works if the publisher has this privilege or is running as SYSTEM/admin.

3. **Local shared memory** (`Local\MorphlyCam.FrameBuffer`) — only works within the same session. Falls back to this if neither of the above work.

**Critical pitfall:** FrameServer loads your MF DLL in **Session 0** (the system session). If your publisher runs in the user session (Session 1+), `Local\` shared memory is completely invisible between sessions. You MUST use the file bridge or `Global\` namespace. The file bridge at a `C:\Users\Public\` path is the most reliable approach since it requires no special privileges.

### 1.3 Security Descriptor for the File Bridge

The file bridge directory and its shared memory objects must be accessible from both Session 0 and user sessions. Use this SDDL string when creating the security attributes:

```
D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;LS)(A;;GA;;;AU)
```

This grants full access to: System (SY), Built-in Administrators (BA), Local Service (LS), and Authenticated Users (AU). Without this, FrameServer running as Local Service cannot read the file.

---

## Part 2: The Publisher (morphly_cam_pipe_publisher.exe)

This is a standalone Win32 console app that receives frames over stdin from Electron and writes them to the file bridge.

### 2.1 Pipe Header Protocol

Electron sends each frame as:
- **40-byte header** (PipeFrameHeader): magic (4), version (4), width (4), height (4), stride (4), fps (4), flags (4), payloadBytes (4), timestampHundredsOfNs (8)
- **Raw BGRA payload** immediately after (stride × height bytes)

### 2.2 Writing to the File Bridge

```cpp
// CORRECT seqlock write sequence:
header->reserved += 1;            // odd = write in progress
std::atomic_thread_fence(std::memory_order_release);

// Write all frame data
header->width = config.width;
header->height = config.height;
header->stride = config.stride;
header->fpsNumerator = config.fpsNumerator;
header->fpsDenominator = config.fpsDenominator;
header->payloadBytes = static_cast<uint32_t>(payloadBytes);
header->pixelFormat = kPixelFormatBgra32;
header->timestampHundredsOfNs = timestamp;
std::memcpy(payload, frameData, payloadBytes);
header->frameCounter += 1;       // LAST thing inside write window

std::atomic_thread_fence(std::memory_order_release);
header->reserved += 1;            // even = write complete, safe to read
```

**Critical pitfall:** Many implementations put `frameCounter += 1` before the final `reserved` increment. This causes readers to see a non-zero frameCounter while the write window is still open, leading to torn reads and green/corrupt frames in the camera output.

### 2.3 File Map Size

The file must be pre-sized to `sizeof(SharedFrameHeader) + payloadBytes`. For 1280×720 BGRA: `48 + (1280 × 4 × 720) = 3,686,448 bytes`. Create it with `CreateFileMapping` using this exact size. On subsequent opens, check the file size is ≥ this value before mapping.

---

## Part 3: The MF Source DLL (MorphlyVirtualCameraMF.dll)

This is a Windows Media Foundation virtual camera source. It implements `IMFMediaSource`, `IMFMediaStream`, `IMFGetService`, and registers itself as an `IMFVirtualCamera` with `MFCreateVirtualCamera`.

### 3.1 Media Type Negotiation

Expose exactly **two media types** in this order:
1. `MFVideoFormat_NV12` at index 0 (preferred — all modern apps use this)
2. `MFVideoFormat_YUY2` at index 1 (fallback for older apps)

**Critical pitfall:** Do NOT expose only YUY2. Browsers (Edge/Chrome) and WhatsApp strictly prefer NV12. If you only offer YUY2, browsers will fail `getUserMedia` silently or show a black feed. Always list NV12 first.

### 3.2 Sample Timestamps

Every sample MUST have `MFSampleExtension_CleanPoint = TRUE` and the sample time must be wall-clock time using `MFGetSystemTime()`. Never use a generated/calculated timestamp based on frame count.

```cpp
LONGLONG sampleTime = MFGetSystemTime(); // wall-clock, 100ns units
sample->SetSampleTime(sampleTime);
sample->SetUINT32(MFSampleExtension_CleanPoint, TRUE);
```

**Critical pitfall — two separate issues:**

1. **Missing CleanPoint:** If you do not set `MFSampleExtension_CleanPoint = TRUE` on every sample, Windows Camera Frame Server marks the stream as non-key-frame only. Chromium's camera stack refuses to deliver frames from such streams. The camera appears to work in Device Manager but getUserMedia gets 0 frames delivered to the page.

2. **Wrong timestamp source:** If you calculate timestamps from a start time + (frameIndex / fps), you get correct-looking values but they drift from the system clock. FrameServer compares sample timestamps against the system clock. If they drift by more than ~100ms, FrameServer silently drops frames. Use `MFGetSystemTime()` on each frame, not a calculated value.

### 3.3 Do NOT set CaptureMetadata

Do NOT call `IMFSample::QueryInterface` for `IMFCapturePhotoConfirmation` or try to add `MFSampleExtension_CaptureMetadata`. The `QueryInterface` for these will return `E_NOINTERFACE` and if you check the result and treat it as fatal, your entire frame delivery loop breaks. Simply skip this entirely — browsers do not need capture metadata from a virtual camera.

### 3.4 BGRA to NV12 Conversion

The file bridge always contains BGRA data. Convert to NV12 before delivering to MF:

```
NV12 layout:
  [Y plane: width × height bytes]
  [UV plane: width × (height/2) bytes, interleaved U,V pairs for 2×2 pixel blocks]

Luma (Y):   Y = ((66*R + 129*G + 25*B + 128) >> 8) + 16
Chroma Cb:  U = ((-38*R - 74*G + 112*B + 128) >> 8) + 128
Chroma Cr:  V = ((112*R - 94*G - 18*B + 128) >> 8) + 128

For the UV plane, average U and V over each 2×2 block of pixels.
```

BGRA pixel byte order: `[Blue, Green, Red, Alpha]` — note Blue comes first, not Red.

### 3.5 COM Registration

The MF source CLSID must be registered in `HKEY_LOCAL_MACHINE\SOFTWARE\Classes\CLSID\{your-guid}` with an `InprocServer32` key pointing to the full path of your DLL. Set the `ThreadingModel` to `Both`.

The DLL must also be registered as an `IMFVirtualCamera` using `MFCreateVirtualCamera`. This creates the device entry that Windows Camera Framework picks up. The device persists after reboot as a system-lifetime virtual camera — you do not need to re-register it on every launch.

```cpp
hr = MFCreateVirtualCamera(
    MF_VIRTUALCAMERA_LIFETIME_SYSTEM,     // persists across reboots
    MF_VIRTUALCAMERA_ACCESS_ALLOW_ALL,    // accessible from all processes
    nullptr,                              // no window
    friendlyName,                         // L"Morphly G1"
    nullptr,                              // no symbolic link override
    &sourceClsid,                         // your registered COM CLSID
    nullptr, 0,                           // no custom media types at registration
    camera.GetAddressOf());
hr = camera->Start(nullptr);
```

**Critical pitfall:** `MFCreateVirtualCamera` is only available on Windows 11 (Build 22000+). On Windows 10, the MF virtual camera API does not exist. You must provide a DirectShow filter as a separate fallback for Windows 10 users.

### 3.6 DLL Deployment Path

The MF DLL must be deployed to a path accessible from Session 0. The best location is `C:\ProgramData\{AppName}\`. Do NOT deploy to the user's `AppData` folder — Session 0 / FrameServer cannot read from per-user paths.

---

## Part 4: The DirectShow Filter DLL (MorphlyVirtualCamera.dll)

This implements `IBaseFilter`, `IPin`, `IAMStreamControl`, and friends using the DirectShow Base Classes. It provides a camera device for Windows 10 / OBS / legacy apps.

### 4.1 Registration

Register via `DllRegisterServer` into:
- `HKLM\SOFTWARE\Classes\CLSID\{guid}\InprocServer32`
- `HKLM\SOFTWARE\Classes\CLSID\{guid}\FriendlyName`
- `HKLM\SYSTEM\CurrentControlSet\Control\DeviceClasses\{camera interface GUID}\...`

Use the DirectShow Base Classes (`amfilter.h`, `source.h`) from the Windows SDK samples — they handle most of the COM reference counting and filter graph wiring for you.

### 4.2 Pixel Format

The DirectShow filter should output `MEDIASUBTYPE_YUY2`. Apps like OBS use DirectShow and expect YUY2. Read from the same file bridge and convert from BGRA → YUY2.

---

## Part 5: The Registrar (morphly_cam_registrar.exe)

This is a small elevated utility that handles install/uninstall/probe operations. It must run as Administrator for system-wide registration.

### 5.1 Commands

- `install` — current user registration  
- `install --all-users` — machine-wide registration (requires admin)  
- `remove` — unregister camera  
- `remove --all-users --unregister-com` — full cleanup  
- `probe` — verify registration is healthy (exits 0 if OK, non-zero if not)

### 5.2 Probe Logic

The probe command should:
1. Verify the DLL files exist in their deployment paths
2. Verify the COM CLSIDs are registered in the registry
3. Call `MFCreateVirtualCamera` and immediately release — if this succeeds, registration is healthy

Do NOT rely on `Get-PnpDevice` or WMI camera enumeration for the probe. These are unreliable — a device can be fully functional but not appear in PnP for several minutes after registration. The DLL existence + CLSID registry check + MFCreateVirtualCamera round-trip is the authoritative probe.

---

## Part 6: The Electron Integration (main.js)

### 6.1 Starting the Publisher

Spawn `morphly_cam_pipe_publisher.exe` as a child process with `stdio: ['pipe', 'ignore', 'pipe']`. Write frames to `child.stdin`. Monitor `child.stdin` for `EPIPE` errors (publisher crashed) and restart automatically.

```js
const child = spawn(publisherPath, [], {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true
});
```

### 6.2 Frame Header (40 bytes, little-endian)

```
Offset  Size  Field
0       4     magic (0x4D43414D)
4       4     version (1)
8       4     width (1280)
12      4     height (720)
16      4     stride (1280 × 4 = 5120)
20      4     fps (30)
24      4     flags (1)
28      4     payloadBytes (stride × height)
32      8     timestampHundredsOfNs (from Date.now() × 10000)
```

### 6.3 Pixel Format from the Renderer

The Electron renderer captures canvas pixels as RGBA (browser native format). The publisher expects BGRA. **Always swap R and B channels before writing to the publisher.** This is a one-time byte-swap: for each pixel, swap byte[0] (Blue←Red) and byte[2] (Red←Blue).

### 6.4 Frame Rate Pacing

Do NOT call the publisher at an unconstrained rate. Drive it at exactly 30fps using a `setTimeout` loop that accounts for the time the previous write took:

```js
const elapsed = Date.now() - startedAt;
scheduleNext(Math.max(0, FRAME_INTERVAL_MS - elapsed));
```

### 6.5 Virtual Camera Registration on App Start

When the packaged app starts, call the registrar's `probe` command. If it fails, call `install --all-users` (requires the NSIS installer to have run elevated). Do NOT attempt repair in the unpackaged dev build — repair requires elevation and will always fail in a normal user session.

---

## Part 7: The NSIS Installer Script

Add a `customInstall` macro to your NSIS script that runs the registrar silently during installation. The installer runs elevated (NSIS `perMachine` + `allowElevation`), so the registration succeeds without a separate UAC prompt:

```nsis
!macro customInstall
  IfFileExists "$INSTDIR\resources\morphly-cam\morphly_cam_registrar.exe" 0 done
  nsExec::ExecToLog '"$INSTDIR\resources\morphly-cam\morphly_cam_registrar.exe" install --all-users'
  Pop $0
  StrCmp $0 "0" done
  ; retry current-user if all-users failed
  nsExec::ExecToLog '"$INSTDIR\resources\morphly-cam\morphly_cam_registrar.exe" install'
done:
!macroend

!macro customUnInstall
  IfFileExists "$INSTDIR\resources\morphly-cam\morphly_cam_registrar.exe" 0 done
  nsExec::ExecToLog '"$INSTDIR\resources\morphly-cam\morphly_cam_registrar.exe" remove --all-users --unregister-com'
  Pop $0
done:
!macroend
```

Add an `afterPack` script (electron-builder hook) that copies the 4 native binaries into `resources/morphly-cam/` inside the packaged app before the installer is created:
- `morphly_cam_registrar.exe`
- `morphly_cam_pipe_publisher.exe`
- `MorphlyVirtualCamera.dll` (DirectShow)
- `MorphlyVirtualCameraMF.dll` (Media Foundation)

---

## Part 8: The GitHub Actions CI/CD Pipeline

The release workflow triggers ONLY on version tags (`v*.*.*`). A plain push to `main` does NOT create a release. To release:

1. Update `version` in `app/package.json`
2. Commit and push to `main`
3. Create and push the matching tag: `git tag v2.0.0 && git push origin v2.0.0`

The workflow:
1. Runs `cmake -S native-camera -B native-camera/build -A x64` then `cmake --build native-camera/build --config Release`
2. Runs `npm run electron:release` (which triggers `afterPack` to bundle native binaries)
3. Uploads `Morphly Setup {version}.exe` and `Morphly {version}.exe` (portable) as GitHub release assets
4. The `api/version.ts` endpoint serves the download URL dynamically from the GitHub Releases API — no hardcoded version needed

---

## Part 9: Complete List of Pitfalls (Do Not Skip)

These caused real multi-hour debugging sessions. Each one is non-obvious.

**Pitfall 1 — Seqlock frameCounter order:** `frameCounter` must be incremented INSIDE the write window, as the last write operation, before the closing seqlock increment. Putting it after causes torn reads.

**Pitfall 2 — MFSampleExtension_CleanPoint missing:** Every MF sample must have this set to TRUE. Without it, Chromium delivers 0 frames to `getUserMedia` even though FrameServer shows the stream as active.

**Pitfall 3 — Wrong sample timestamp source:** Use `MFGetSystemTime()` per-frame. Do not calculate from a base time + frame counter. FrameServer drops samples that are more than ~100ms ahead or behind the system clock.

**Pitfall 4 — NV12 not listed as first media type:** Chromium and WhatsApp select the first offered media type. If YUY2 is first, browsers may fail or show a black feed. NV12 must be index 0.

**Pitfall 5 — File bridge path is user-session-relative:** `C:\Users\{name}\AppData` is invisible to Session 0. Use `C:\Users\Public\Documents\{AppName}\` or `C:\ProgramData\{AppName}\` for files that FrameServer must read.

**Pitfall 6 — Local\ shared memory across sessions:** `Local\` kernel objects are session-scoped. FrameServer (Session 0) cannot open `Local\` objects created in Session 1. Always use the file bridge or `Global\` namespace.

**Pitfall 7 — RGBA vs BGRA:** Browser canvas `getImageData` returns RGBA. Windows expects BGRA. Forgetting to swap produces heavily red-shifted or blue-shifted output. Swap on write in Electron main, not in the DLL.

**Pitfall 8 — CaptureMetadata QueryInterface:** Calling `QueryInterface(IID_IMFCapturePhotoConfirmation)` on a virtual camera sample returns `E_NOINTERFACE`. If your code treats this as a fatal error or tries to set capture metadata attributes anyway, it breaks the delivery loop. Skip it entirely.

**Pitfall 9 — DLL deployment to user AppData:** The MF DLL path stored in the COM registry must be accessible from Session 0. Deploy to `C:\ProgramData\{AppName}\`. Deploying to `%LOCALAPPDATA%` causes "Class not registered" errors when FrameServer tries to load the DLL.

**Pitfall 10 — PnP visibility as probe:** `Get-PnpDevice` and WMI may not show the virtual camera for several minutes after registration, even when the camera is fully functional. Do not use PnP visibility as your health check. Use the registrar's probe command instead.

**Pitfall 11 — MFCreateVirtualCamera Windows 10:** This API does not exist on Windows 10. You must provide a DirectShow filter as a fallback and check `IsWindows11OrGreater()` at registration time.

**Pitfall 12 — Pushing a plain commit without a tag:** GitHub Actions Release workflow only fires on tag pushes, not branch pushes. `git push origin main` alone will not create a release or upload installer assets. You must `git tag vX.Y.Z && git push origin vX.Y.Z`.

---

## Summary: Files You Need to Create

| File | Purpose |
|---|---|
| `morphly_protocol.h` | SharedFrameHeader struct, magic constants |
| `morphly_ids.h` / `.cpp` | CLSIDs, friendly name, shared memory names, file bridge path |
| `morphly_publisher.cpp/.h` | Publisher library — creates file bridge, seqlock writes |
| `morphly_cam_pipe_publisher.cpp` | stdin pipe reader → calls publisher library |
| `mf_virtual_camera_source.cpp/.h` | IMFMediaSource, NV12/YUY2 delivery, CleanPoint |
| `dllmain.cpp` | COM DLL entry, DllRegisterServer / DllUnregisterServer |
| `registrar/main.cpp` | install / remove / probe CLI |
| `electron/main.js` | Spawn publisher, write pipe frames, registration health check |
| `build/installer.nsh` | NSIS customInstall/customUnInstall macros |
| `build/afterPack.cjs` | electron-builder hook, copies native binaries |
| `.github/workflows/release.yml` | CI: cmake → electron:release → upload assets on tag |
