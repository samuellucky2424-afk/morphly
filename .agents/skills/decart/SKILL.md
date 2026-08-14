---
name: decart
description: Use when building with Decart for realtime video transformation, video generation or editing, and image generation or editing. Reach for this skill when you need Decart's realtime APIs for live video effects, avatar animation, or restyling, or when you need to generate or edit videos and images with Decart models.
license: MIT
compatibility: Requires Node.js or Python. Works with any framework.
metadata:
  author: decart
  version: "1.0"
  mintlify-proj: decart
---

# Decart

Decart is an AI video/image platform centered on realtime transformation, with three APIs: Realtime (WebRTC, sub-500ms), Queue (async batch video generation/editing), and Process (sync image generation/editing). SDKs for JavaScript, Python, Android, and Swift. Auth via API key from platform.decart.ai — set `DECART_API_KEY` env var. Docs: https://docs.platform.decart.ai

## When to use

- **Realtime video transformation** — camera effects, video conferencing filters, AR/VR overlays, photo booths, live streaming
- **Batch video generation** — marketing clips, social content, product demos, and animations from text or images
- **Batch video editing** — edit existing videos with text prompts, reference images, or both
- **Video restyling** — apply artistic styles to live streams or existing videos
- **Image generation/editing** — mockups, thumbnails, creative assets, and image-to-image transformation
- **Character transformation** — transform user's live camera feed into characters (anime, fantasy, etc.)
- **Framework integration** — Vercel AI SDK, TanStack AI, LangChain.js all supported

## API selection

| You want to... | API | Method | Best for |
|---|---|---|---|
| Transform live camera/video | Realtime | `client.realtime.connect()` | Interactive apps, below 500ms latency |
| Restyle live video with artistic styles | Realtime | `client.realtime.connect()` | Live style transfer |
| Edit existing video | Queue | `client.queue.submitAndPoll()` | Video transformation, unlimited duration |
| Restyle existing video | Queue | `client.queue.submitAndPoll()` | Batch style transfer |
| Edit an image | Process | `client.process()` | Sync results, thumbnails |

## Model selection

| Use case | Model | Type |
|---|---|---|
| Character transform live | `lucy-2.1` | Realtime |
| Artistic style transfer live | `lucy-restyle-2` | Realtime |
| Virtual try-on (live or batch) | `lucy-vton-3.5` | Realtime + Batch |
| Video editing (best quality) | `lucy-2.1` | Batch |
| Video restyling | `lucy-restyle-2` | Batch |
| Image editing | `lucy-image-2` | Process |

## Quick start patterns

### Realtime (connect + transform)

```javascript
const model = models.realtime("lucy-2.1");
const stream = await navigator.mediaDevices.getUserMedia({
  video: { frameRate: model.fps, width: model.width, height: model.height }
});
const rt = await client.realtime.connect(stream, {
  model,
  mirror: "auto", // pre-flip front-camera input so server-baked pixels render correctly
  onRemoteStream: (s) => { videoEl.srcObject = s; }
});
await rt.set({ prompt: "Transform into anime character", image: refImage, enhance: true });
```

### Queue (video editing)

```javascript
const result = await client.queue.submitAndPoll({
  model: models.video("lucy-2.1"),
  data: videoFile,
  prompt: "Transform into anime style",
  resolution: "720p",
});
```

### Process (image editing)

```javascript
const image = await client.process({
  model: models.image("lucy-image-2"),
  data: imageFile,
  prompt: "Change the background to a beach",
  resolution: "720p",
});
```

## Authentication

- **Server-side**: Set `DECART_API_KEY` env var. The SDK picks it up automatically.
- **Client-side**: Generate short-lived tokens on your backend via `client.tokens.create()`, then send `token.apiKey` to the frontend.
- **Token options**: `expiresIn` (1–3600s, default 60s), `allowedModels` (restrict model access), `allowedOrigins` (pin to canonical web origins, browser-enforced), `constraints` (e.g. `realtime.maxSessionDuration`).
- **NEVER** expose permanent API keys in browser or mobile code.

## Camera constraints

Always use `model.fps`, `model.width`, `model.height` from the SDK to avoid scaling artifacts.

Pass `resolution: "1080p"` to `realtime.connect()` (or the SDK equivalent) when you need a 1080p remote stream; defaults to 720p.

## Boundaries

### What agents CAN do

- Generate integration code for all three APIs (Realtime, Queue, Process)
- Help select models, configure SDK, set up authentication
- Write WebRTC realtime streaming code
- Build framework integrations (Vercel AI SDK, TanStack AI, LangChain.js)
- Troubleshoot connection, moderation, and billing issues

### What agents CANNOT do

- Create or manage Decart accounts, API keys, or billing
- Access the Decart dashboard or platform settings
- Test realtime connections (requires actual WebRTC + camera)
- Verify credit balance or usage
- Bypass content moderation policies

## Common gotchas

- NEVER expose permanent API keys in client code. Use client tokens for browser/mobile, and pass `allowedOrigins` so a leaked token can't be replayed from another web origin.
- ALWAYS use `model.fps`, `model.width`, `model.height` for camera constraints. Mismatched resolution causes latency and artifacts.
- ALWAYS call `disconnect()` and stop media tracks when done. Leaving connections open causes memory leaks and billing.
- Catch errors from `set()`, `setPrompt()`, `setImage()`. Moderation rejections throw here.
- Listen to `connectionChange` events. The SDK auto-reconnects, but your UI must reflect the state.
- Keep `enhance: true` (default) unless you need exact prompt control.
- Use `submitAndPoll()` for queue jobs. Don't manually poll faster than every 2 seconds.
- Image editing (`i2i`) only works with Process API, not Queue API. Queue is for video only.
- Realtime sessions end silently when credits run out. Listen for disconnect events.
- For Lucy 2.1 character transform, use clear portrait photos with good lighting.
- Lucy Clip (`lucy-clip`) is legacy with a 5-second clip limit. Use `lucy-2.1` for new projects (unlimited duration).
- `lucy-2.1` accepts a reference image, a text prompt, or both together for maximum control.
- Use `mirror: "auto"` on `realtime.connect()` for selfie streams instead of CSS-flipping the displayed video.

## Verification checklist

- [ ] API key stored in environment variable, never hardcoded
- [ ] Client tokens generated on backend for any browser/mobile realtime usage
- [ ] Camera resolution matches model's fps, width, height constraints
- [ ] Error handlers on `set()`, `setPrompt()`, `setImage()` calls
- [ ] `connectionChange` listener updates UI on disconnect/reconnect
- [ ] `disconnect()` called and media streams stopped on cleanup
- [ ] `enhance: true` enabled unless exact prompt control needed
- [ ] Queue API for video editing, Process API for images
- [ ] Moderation errors caught and shown to user gracefully
- [ ] Tested on real device for mobile (simulator lacks WebRTC)

## Resources

- Full docs navigation: https://docs.platform.decart.ai/llms.txt
- Models overview: https://docs.platform.decart.ai/getting-started/models
- Realtime best practices: https://docs.platform.decart.ai/models/realtime/streaming-best-practices
- JavaScript SDK: https://docs.platform.decart.ai/sdks/javascript-realtime
- Android SDK: https://docs.platform.decart.ai/sdks/android
