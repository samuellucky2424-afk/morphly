// Plus (Xmax) only: preprocess the reference into a "slightly soft, slightly dim selfie"
// so Xmax copies fewer over-sharp details (less waxy output). The original is never
// modified; previews keep using it. All values live in ONE config object.
export type XmaxReferenceSoftening = {
  maxSide: number;        // final output max side (px)
  downscale: number;      // downscale->upscale factor for detail loss (1 = off)
  blurPercent: number;    // blur radius as % of shorter side (0.5-1 recommended)
  brightness: number;     // 0.92-0.95 recommended
  contrast: number;       // 0.90-0.95 recommended
  quality: number;        // JPEG quality
};

export const XMAX_REFERENCE_SOFTENING_DEFAULTS: XmaxReferenceSoftening = {
  maxSide: 512, downscale: 0.75, blurPercent: 0.5, brightness: 0.94, contrast: 0.92, quality: 0.9,
};

const LIMITS: Record<keyof XmaxReferenceSoftening, [number, number]> = {
  maxSide: [128, 2048], downscale: [0.25, 1], blurPercent: [0, 5], brightness: [0.5, 1.2], contrast: [0.5, 1.2], quality: [0.5, 1],
};

export function normalizeXmaxReferenceSoftening(input?: Partial<XmaxReferenceSoftening> | null): XmaxReferenceSoftening {
  const out = { ...XMAX_REFERENCE_SOFTENING_DEFAULTS };
  for (const key of Object.keys(LIMITS) as (keyof XmaxReferenceSoftening)[]) {
    const v = input?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.min(LIMITS[key][1], Math.max(LIMITS[key][0], v));
  }
  out.maxSide = Math.round(out.maxSide);
  return out;
}

export function computeSofteningPlan(width: number, height: number, s: XmaxReferenceSoftening) {
  const scale = Math.min(1, s.maxSide / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const blurPx = Math.round(Math.min(outWidth, outHeight) * s.blurPercent) / 100;
  const filter = `blur(${blurPx}px) brightness(${s.brightness}) contrast(${s.contrast})`;
  return { outWidth, outHeight, smallWidth: Math.max(1, Math.round(outWidth * s.downscale)), smallHeight: Math.max(1, Math.round(outHeight * s.downscale)), blurPx, filter };
}

export async function softenXmaxReference(dataUrl: string, input?: Partial<XmaxReferenceSoftening> | null): Promise<string> {
  const s = normalizeXmaxReferenceSoftening(input);
  if (typeof document === 'undefined' || /^https:\/\//i.test(dataUrl)) return dataUrl;
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const plan = computeSofteningPlan(img.naturalWidth, img.naturalHeight, s);
    // 1) downscale (sharpness loss)
    const small = document.createElement('canvas');
    small.width = plan.smallWidth; small.height = plan.smallHeight;
    const sctx = small.getContext('2d');
    // 2) upscale + blur/brightness/contrast in one filtered draw
    const canvas = document.createElement('canvas');
    canvas.width = plan.outWidth; canvas.height = plan.outHeight;
    const ctx = canvas.getContext('2d');
    if (!sctx || !ctx) return dataUrl;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(img, 0, 0, plan.smallWidth, plan.smallHeight);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, plan.outWidth, plan.outHeight);
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = plan.filter;
    const pad = Math.ceil(plan.blurPx * 2); // oversize so blur doesn't pull in edges
    ctx.drawImage(small, -pad, -pad, plan.outWidth + pad * 2, plan.outHeight + pad * 2);
    ctx.filter = 'none';
    const out = canvas.toDataURL('image/jpeg', s.quality);
    console.info('[AI_REFERENCE]', {
      engine: 'xmax', source: `${img.naturalWidth}x${img.naturalHeight}`, output: `${plan.outWidth}x${plan.outHeight}`,
      via: `${plan.smallWidth}x${plan.smallHeight}`, filter: plan.filter, ...s, bytes: Math.round(out.length * 0.75),
    });
    return out;
  } catch (error) {
    console.warn('[AI_REFERENCE] preprocessing failed, sending original', error);
    return dataUrl;
  }
}
