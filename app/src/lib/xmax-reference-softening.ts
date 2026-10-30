// Plus (Xmax) only: soften the uploaded reference before it goes to Xmax so the
// model copies fewer high-frequency details (reduces the "waxy"/over-sharp look).
// The original image is never modified; previews keep using it.
export type XmaxReferenceSoftening = { blurPercent: number; maxSide: number; quality: number };

export const XMAX_REFERENCE_SOFTENING_DEFAULTS: XmaxReferenceSoftening = { blurPercent: 1.5, maxSide: 512, quality: 0.9 };

export function normalizeXmaxReferenceSoftening(input?: Partial<XmaxReferenceSoftening> | null): XmaxReferenceSoftening {
  const d = XMAX_REFERENCE_SOFTENING_DEFAULTS;
  const pick = (v: unknown, def: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
  return {
    blurPercent: pick(input?.blurPercent, d.blurPercent, 0, 10),
    maxSide: Math.round(pick(input?.maxSide, d.maxSide, 128, 2048)),
    quality: pick(input?.quality, d.quality, 0.5, 1),
  };
}

export function computeSofteningPlan(width: number, height: number, settings: XmaxReferenceSoftening) {
  const scale = Math.min(1, settings.maxSide / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const blurPx = Math.round(Math.min(outWidth, outHeight) * settings.blurPercent) / 100;
  return { outWidth, outHeight, blurPx };
}

export async function softenXmaxReference(dataUrl: string, input?: Partial<XmaxReferenceSoftening> | null): Promise<string> {
  const settings = normalizeXmaxReferenceSoftening(input);
  if (typeof document === 'undefined' || /^https:\/\//i.test(dataUrl)) return dataUrl;
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = dataUrl;
    await img.decode();
    const { outWidth, outHeight, blurPx } = computeSofteningPlan(img.naturalWidth, img.naturalHeight, settings);
    const canvas = document.createElement('canvas');
    canvas.width = outWidth;
    canvas.height = outHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, outWidth, outHeight);
    ctx.imageSmoothingQuality = 'high';
    // Draw slightly oversized so the blur doesn't pull transparent/white edges in.
    if (blurPx > 0) ctx.filter = `blur(${blurPx}px)`;
    const pad = Math.ceil(blurPx * 2);
    ctx.drawImage(img, -pad, -pad, outWidth + pad * 2, outHeight + pad * 2);
    ctx.filter = 'none';
    const out = canvas.toDataURL('image/jpeg', settings.quality);
    console.info('[AI_REFERENCE]', {
      engine: 'xmax', source: `${img.naturalWidth}x${img.naturalHeight}`, output: `${outWidth}x${outHeight}`,
      blurPx, blurPercent: settings.blurPercent, maxSide: settings.maxSide, quality: settings.quality,
      bytes: Math.round(out.length * 0.75),
    });
    return out;
  } catch (error) {
    console.warn('[AI_REFERENCE] softening failed, sending original', error);
    return dataUrl;
  }
}
