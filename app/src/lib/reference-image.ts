const REFERENCE_INPUT_LIMIT_BYTES = 15 * 1024 * 1024;
const REFERENCE_UPLOAD_TARGET_BYTES = 2_000_000;
const REFERENCE_MAX_DIMENSION = 2048;
const REFERENCE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export function shouldNormalizeRealtimeReference(
  file: Pick<File, 'size' | 'type'>,
  width: number,
  height: number,
): boolean {
  return !REFERENCE_MIME_TYPES.has(file.type.toLowerCase())
    || file.size > REFERENCE_UPLOAD_TARGET_BYTES
    || Math.max(width, height) > REFERENCE_MAX_DIMENSION;
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Morphly could not prepare this image for streaming.'));
      }
    }, 'image/jpeg', quality);
  });
}

export async function prepareRealtimeReferenceImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Select a valid image file.');
  }

  if (file.size > REFERENCE_INPUT_LIMIT_BYTES) {
    throw new Error('The reference image must be 15 MB or smaller.');
  }

  const bitmap = await createImageBitmap(file);

  try {
    if (!shouldNormalizeRealtimeReference(file, bitmap.width, bitmap.height)) {
      return file;
    }

    const scale = Math.min(1, REFERENCE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('Morphly could not prepare this image for streaming.');
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
