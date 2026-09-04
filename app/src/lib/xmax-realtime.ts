export type XmaxTransformState<TImage extends Blob = File> = {
  prompt: string;
  image: TImage | null;
};

export type XmaxRealtimeContext = {
  prompt: string;
  refImageUrl?: string | null;
};

export const XMAX_REALTIME_MODEL = 'x2.0' as const;
export const XMAX_REFERENCE_INPUT_LIMIT_BYTES = 15 * 1024 * 1024;
export const XMAX_REFERENCE_UPLOAD_TARGET_BYTES = 5 * 1024 * 1024;
export const XMAX_REFERENCE_MAX_DIMENSION = 2048;
export const XMAX_PASSTHROUGH_PROMPT =
  'Preserve the person, clothing, background, lighting, framing, and natural camera appearance exactly as the input.';

const XMAX_REFERENCE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function buildXmaxRealtimeContext(
  transform: XmaxTransformState,
  refImageUrl?: string | null,
): XmaxRealtimeContext {
  return {
    prompt: transform.prompt.trim() || XMAX_PASSTHROUGH_PROMPT,
    refImageUrl: transform.image ? refImageUrl ?? null : null,
  };
}

export function getXmaxRealtimeUserMessage(
  error: unknown,
  fallback = 'Morphly could not update the AI video. Please try again.',
): string {
  const candidate = typeof error === 'object' && error !== null
    ? error as { code?: unknown; message?: unknown; cause?: { message?: unknown } | unknown }
    : null;
  const code = typeof candidate?.code === 'string' ? candidate.code.toUpperCase() : '';
  const causeMessage = typeof candidate?.cause === 'object'
    && candidate.cause !== null
    && 'message' in candidate.cause
    && typeof candidate.cause.message === 'string'
    ? candidate.cause.message
    : '';
  const message = error instanceof Error
    ? error.message
    : typeof candidate?.message === 'string'
      ? candidate.message
      : causeMessage;
  const diagnosticMessage = `${message} ${causeMessage}`.trim();

  if (/moderation|content policy|safety|not accepted|rejected/i.test(diagnosticMessage)) {
    return 'That prompt or reference image was not accepted. Try a different request or image.';
  }

  switch (code) {
    case 'INVALID_API_KEY':
      return 'The AI session expired. Stop the stream and start it again.';
    case 'INVALID_MODEL':
      return 'Plus is temporarily unavailable. Please try again.';
    case 'INVALID_INPUT':
      return 'Plus could not apply that prompt or reference image. Check it and try again.';
    case 'UNSUPPORTED_MEDIA':
    case 'MEDIA_PROCESSING_ERROR':
      return 'Plus could not process that reference image. Select another image and try again.';
    case 'NETWORK_ERROR':
    case 'WEB_RTC_ERROR':
    case 'SESSION_ERROR':
      return 'The AI video connection was interrupted. Morphly is trying to recover it.';
    default:
      return fallback;
  }
}

export function shouldNormalizeXmaxReference(
  file: Pick<File, 'size' | 'type'>,
  width: number,
  height: number,
): boolean {
  return !XMAX_REFERENCE_MIME_TYPES.has(file.type.toLowerCase())
    || file.size > XMAX_REFERENCE_UPLOAD_TARGET_BYTES
    || Math.max(width, height) > XMAX_REFERENCE_MAX_DIMENSION;
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Morphly could not prepare this image for Plus.'));
      }
    }, 'image/jpeg', quality);
  });
}

export async function prepareXmaxReferenceImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Select a valid image file.');
  }

  if (file.size > XMAX_REFERENCE_INPUT_LIMIT_BYTES) {
    throw new Error('The reference image must be 15 MB or smaller.');
  }

  const bitmap = await createImageBitmap(file);

  try {
    if (!shouldNormalizeXmaxReference(file, bitmap.width, bitmap.height)) {
      return file;
    }

    const scale = Math.min(1, XMAX_REFERENCE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('Morphly could not prepare this image for Plus.');
    }

    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvasToJpeg(canvas, 0.86);
    const normalizedName = `${file.name.replace(/\.[^.]+$/, '') || 'reference'}.jpg`;

    return new File([blob], normalizedName, {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}
