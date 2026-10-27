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
  const isHeic = /\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type);
  if (isHeic) {
    throw new Error('iPhone HEIC photos are not supported. Choose a JPG or PNG (on iPhone: Settings > Camera > Formats > Most Compatible).');
  }
  if (file.type && !file.type.startsWith('image/')) {
    throw new Error('Select a valid image file.');
  }

  if (file.size > REFERENCE_INPUT_LIMIT_BYTES) {
    throw new Error('The reference image must be 15 MB or smaller.');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Morphly could not read this image. Please choose a JPG or PNG photo.');
  }

  try {
    if (!shouldNormalizeRealtimeReference(file, bitmap.width, bitmap.height)) {
      return file;
    }

    let maxDimension = REFERENCE_MAX_DIMENSION;
    let quality = 0.86;
    let blob: Blob | null = null;
    for (let pass = 0; pass < 6; pass += 1) {
      const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) {
        throw new Error('Morphly could not prepare this image for streaming.');
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      blob = await canvasToJpeg(canvas, quality);
      if (blob.size <= REFERENCE_UPLOAD_TARGET_BYTES * 0.9) break;
      quality = Math.max(0.6, quality - 0.08);
      maxDimension = Math.round(maxDimension * 0.8);
    }
    if (!blob || blob.size > REFERENCE_UPLOAD_TARGET_BYTES) {
      throw new Error('This image is too large to use. Please choose a smaller photo.');
    }
    const normalizedName = `${file.name.replace(/\.[^.]+$/, '') || 'reference'}.jpg`;

    return new File([blob], normalizedName, {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}
