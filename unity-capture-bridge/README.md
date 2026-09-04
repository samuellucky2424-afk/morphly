# Morphly UnityCapture bridge

This helper reads Morphly's adaptive RGBA frames from Electron over stdin and
publishes them through the shared-memory protocol implemented by the pinned
[`schellingb/UnityCapture`](../third_party/UnityCapture) submodule.

The same process also publishes a top-down BGRA view to Morphly's Windows Media
Foundation camera. UnityCapture serves DirectShow clients such as SplitCam;
the Media Foundation source advertises NV12 first for WhatsApp and other modern
Windows camera clients. Consumer heartbeats keep full-rate conversion dormant
until one of those camera clients is actually reading frames.

From `app/` on Windows:

```powershell
npm run virtual-camera:build
# Run the next command from an Administrator terminal for local development.
npm run virtual-camera:install
```

Packaged Morphly installers register the upstream UnityCapture 32-bit and 64-bit
filters plus the Media Foundation source as `Morphly Virtual Camera`
automatically.
