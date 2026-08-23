export type DecartTransformState<TImage extends Blob = File> = {
  prompt: string;
  enhance: boolean;
  image: TImage | null;
};

export type DecartSessionUpdate<TImage extends Blob = File> = {
  prompt?: string;
  enhance: boolean;
  image: TImage | null;
};

export const DECART_REFERENCE_INPUT_LIMIT_BYTES = 15 * 1024 * 1024;
export const DECART_REFERENCE_UPLOAD_TARGET_BYTES = 5 * 1024 * 1024;
export const DECART_REFERENCE_MAX_DIMENSION = 2048;

const DECART_REFERENCE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function buildDecartConnectInitialState() {
  // Establish the media path first. Sending image/prompt state during the room
  // handshake can fail asynchronously while the SDK still reports "connected".
  return { passthrough: true } as const;
}

export function buildDecartSessionUpdate<TImage extends Blob>(
  transform: DecartTransformState<TImage>,
): DecartSessionUpdate<TImage> | null {
  const prompt = transform.prompt.trim();

  if (!prompt && !transform.image) {
    return null;
  }

  return {
    ...(prompt ? { prompt } : {}),
    enhance: transform.enhance,
    image: transform.image,
  };
}

export function shouldNormalizeDecartReference(
  file: Pick<File, 'size' | 'type'>,
  width: number,
  height: number,
): boolean {
  return !DECART_REFERENCE_MIME_TYPES.has(file.type.toLowerCase())
    || file.size > DECART_REFERENCE_UPLOAD_TARGET_BYTES
    || Math.max(width, height) > DECART_REFERENCE_MAX_DIMENSION;
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Morphly could not prepare this image for Decart.'));
      }
    }, 'image/jpeg', quality);
  });
}

export async function prepareDecartReferenceImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Select a valid image file.');
  }

  if (file.size > DECART_REFERENCE_INPUT_LIMIT_BYTES) {
    throw new Error('The reference image must be 15 MB or smaller.');
  }

  const bitmap = await createImageBitmap(file);

  try {
    if (!shouldNormalizeDecartReference(file, bitmap.width, bitmap.height)) {
      return file;
    }

    const scale = Math.min(1, DECART_REFERENCE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('Morphly could not prepare this image for Decart.');
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
