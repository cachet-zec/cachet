/**
 * Turn a user-picked image into a data URI that fits the sealed-bundle
 * bound (400 KB server-side). Small files pass through untouched; large
 * ones are resized and re-encoded IN THE PAGE, before sealing — so the
 * hash commits to exactly the bytes that will be stored and served, and
 * the preview shows exactly what will be sealed. No integrity caveat.
 */

const ALLOWED = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Raw file size that fits the server bound without recompression. */
const MAX_RAW_BYTES = 280_000;
/** Target for compressed output: margin under the 400 KB data-URI bound. */
const MAX_DATA_URI_CHARS = 380_000;

export type SealableImage = { dataUri: string; compressed: boolean } | { error: string };

function readAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function imageToSealableDataUri(file: File): Promise<SealableImage> {
  if (!ALLOWED.includes(file.type)) {
    return { error: "PNG, JPEG, WebP or GIF only." };
  }
  if (file.size <= MAX_RAW_BYTES) {
    try {
      return { dataUri: await readAsDataUri(file), compressed: false };
    } catch {
      return { error: "Could not read this image." };
    }
  }
  if (file.type === "image/gif") {
    // Canvas re-encoding keeps only the first frame; refusing beats
    // silently sealing a frozen GIF.
    return { error: "GIFs cannot be compressed without losing animation - keep under ~280 KB." };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { error: "Could not read this image." };
  }
  try {
    // WebP keeps alpha and compresses better, so it is the target
    // wherever the browser can encode it. JPEG is the fallback, and it
    // has no alpha channel: transparent pixels would otherwise seal onto
    // black, so that path — and only that path — gets a white backdrop.
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const webpSupported = probe.toDataURL("image/webp").startsWith("data:image/webp");
    const mime = webpSupported ? "image/webp" : "image/jpeg";

    // Walk down sizes and qualities until the sealed URI fits. The
    // registry renders thumbnails and modest asset-page images, so
    // 1024 px is already generous.
    for (const maxSide of [1024, 768, 512]) {
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        return { error: "Could not read this image." };
      }
      if (!webpSupported) {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.85, 0.7, 0.55]) {
        const dataUri = canvas.toDataURL(mime, quality);
        if (dataUri.length <= MAX_DATA_URI_CHARS && dataUri.startsWith(`data:${mime}`)) {
          return { dataUri, compressed: true };
        }
      }
    }
    return { error: "Image too large even after compression." };
  } finally {
    bitmap.close();
  }
}

/** Human-readable size of a data URI's decoded payload. */
export function dataUriKilobytes(dataUri: string): number {
  return Math.round(((dataUri.length - dataUri.indexOf(",") - 1) * 3) / 4 / 1024);
}
