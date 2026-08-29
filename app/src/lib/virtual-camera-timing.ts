export function getNextVirtualCameraFrameClock(
  lastFrameAt: number,
  now: number,
  frameIntervalMs: number,
): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(frameIntervalMs) || frameIntervalMs <= 0) {
    return null;
  }

  if (lastFrameAt < 0 || !Number.isFinite(lastFrameAt)) {
    return now;
  }

  const elapsedMs = now - lastFrameAt;
  if (elapsedMs < frameIntervalMs) {
    return null;
  }

  // Carry fractional timing forward instead of resetting to `now`. A 30fps
  // decoded stream can then produce a true ~24fps output instead of 15fps.
  return now - (elapsedMs % frameIntervalMs);
}
