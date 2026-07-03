// Client-side downscale for receipt photos before upload — phone camera photos can be
// several MB / very large dimensions; shrinking to a max 1600px edge keeps the upload
// small and fast while remaining plenty legible for OCR. Never upscales smaller images.
const MAX_EDGE = 1600;

export async function downscaleImage(file: File): Promise<{ dataB64: string; contentType: string }> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const { width, height } = img;
    const longEdge = Math.max(width, height);
    const scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1;
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas_unsupported');
    ctx.drawImage(img, 0, 0, targetW, targetH);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    const comma = dataUrl.indexOf(',');
    const dataB64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    return { dataB64, contentType: 'image/jpeg' };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image_load_failed'));
    img.src = src;
  });
}
