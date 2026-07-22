// Client-side downscale for receipt photos before upload — phone camera photos can be
// several MB / very large dimensions; shrinking to a max 1600px edge keeps the upload
// small and fast while remaining plenty legible for OCR. Never upscales smaller images.
//
// Also fixes a long-standing gap: phones embed orientation as EXIF metadata rather than
// rotating the actual pixel grid, and a plain `new Image()` + `drawImage()` (the old
// approach here) ignores that metadata on enough browsers/webviews that sideways/upside
// down uploads happen in the wild. `createImageBitmap(file, { imageOrientation: 'from-image' })`
// decodes upright directly; we fall back to a plain <img> load (best-effort orientation)
// only when that option/API isn't available.
const MAX_EDGE = 1600;

type ImageSource = ImageBitmap | HTMLImageElement;

export async function downscaleImage(file: File): Promise<{ dataB64: string; contentType: string }> {
  const source = await decodeUprightBitmap(file);
  try {
    const { width, height } = getIntrinsicSize(source);
    const { targetW, targetH } = computeTargetSize(width, height, MAX_EDGE);
    const canvas = drawToCanvas(source, targetW, targetH);
    return canvasToJpeg(canvas);
  } finally {
    closeImageSource(source);
  }
}

// Same downscale contract as `downscaleImage`, but for a canvas already in hand (the
// scan.ts warp/enhance output) — reused so the scanned path produces byte-for-byte the
// same kind of payload (max 1600px edge, JPEG q0.8) as the untouched-photo path always has.
export function downscaleCanvas(canvas: HTMLCanvasElement): { dataB64: string; contentType: string } {
  const { targetW, targetH } = computeTargetSize(canvas.width, canvas.height, MAX_EDGE);
  const resized = targetW === canvas.width && targetH === canvas.height ? canvas : drawToCanvas(canvas, targetW, targetH);
  return canvasToJpeg(resized);
}

// Full-resolution, EXIF-corrected working canvas — the starting point for scan.ts's edge
// detection/perspective-warp, which needs full detail (not the 1600px upload-size cap) to
// find document corners reliably. Never throws internally; a decode failure here should be
// treated by the caller as "scanning unavailable for this file", not a hard error.
export async function decodeUprightCanvas(file: File): Promise<HTMLCanvasElement> {
  const source = await decodeUprightBitmap(file);
  try {
    const { width, height } = getIntrinsicSize(source);
    return drawToCanvas(source, width, height);
  } finally {
    closeImageSource(source);
  }
}

async function decodeUprightBitmap(file: File): Promise<ImageSource> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Some browsers support createImageBitmap but reject the imageOrientation option —
      // retry without it before giving up on the API entirely.
      try {
        return await createImageBitmap(file);
      } catch {
        // fall through to the <img> fallback below
      }
    }
  }
  return loadImageElement(file);
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('image_load_failed'));
    };
    img.src = objectUrl;
  });
}

function getIntrinsicSize(source: ImageSource): { width: number; height: number } {
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height };
  }
  return { width: source.width, height: source.height };
}

function closeImageSource(source: ImageSource) {
  if (typeof (source as ImageBitmap).close === 'function') {
    (source as ImageBitmap).close();
  }
}

function computeTargetSize(width: number, height: number, maxEdge: number): { targetW: number; targetH: number } {
  const longEdge = Math.max(width, height);
  const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
  return { targetW: Math.max(1, Math.round(width * scale)), targetH: Math.max(1, Math.round(height * scale)) };
}

function drawToCanvas(source: CanvasImageSource, targetW: number, targetH: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas_unsupported');
  ctx.drawImage(source, 0, 0, targetW, targetH);
  return canvas;
}

function canvasToJpeg(canvas: HTMLCanvasElement): { dataB64: string; contentType: string } {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
  const comma = dataUrl.indexOf(',');
  const dataB64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return { dataB64, contentType: 'image/jpeg' };
}
