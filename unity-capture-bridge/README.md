# Morphly UnityCapture bridge

This helper reads Morphly's 1280x720 RGBA frames from Electron over stdin and
publishes them through the shared-memory protocol implemented by the pinned
[`schellingb/UnityCapture`](../third_party/UnityCapture) submodule.

It is only a frame sender. The virtual camera device, DirectShow filter, COM
registration, media negotiation, and receiving side all remain upstream
UnityCapture code.

From `app/` on Windows:

```powershell
npm run virtual-camera:build
# Run the next command from an Administrator terminal for local development.
npm run virtual-camera:install
```

Packaged Morphly installers register the upstream 32-bit and 64-bit filters as
`Morphly Virtual Camera` automatically.
