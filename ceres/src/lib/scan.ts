// In-page "phone scanner" step for Ceres receipt/slip photos (2026-07-22).
//
// The browser can't invoke the native OS document-scanner UI, so this reimplements the
// gist of it with OpenCV.js (via the `@techstark/opencv-js` npm build, a plain browser
// bundle of opencv.js — no native/Node deps, unlike the `jscanify` package itself whose
// npm main entry pulls in `canvas`/`jsdom`). The edge-detection + four-corner + perspective
// warp approach mirrors jscanify's well-known technique (MIT), reimplemented directly
// against cv so we don't take on that dependency's Node-oriented install footprint.
//
// Hard requirement: OpenCV.js is ~8MB of WASM. It must ONLY load via the dynamic import()
// below — never a static import — so it lands in its own lazy chunk and the main bundle
// stays put. `warmScanLibrary()` lets a host component kick that fetch off early (e.g. as
// soon as a sheet with a photo step mounts) so it's likely already resolved by the time the
// user actually snaps a photo.
//
// Fail-open, always: every stage here is wrapped so a load failure, a timeout, or "no
// plausible document edges found" all collapse to the same outcome — `scanned: null` — and
// the caller (PhotoListUpload) just proceeds with the untouched (but EXIF-corrected)
// original photo exactly as before this feature existed. Nothing in here may throw across
// the public functions; nothing in here may block indefinitely (single overall timeout).
import { decodeUprightCanvas } from './image';

export interface ScanOutcome {
  // Warped + lightly contrast-enhanced document, full resolution — null when OpenCV never
  // became available or no plausible document quad was found in the photo.
  scanned: HTMLCanvasElement | null;
  // EXIF-upright full-resolution source canvas — always present when this function returns
  // non-null, so callers get the orientation fix even on the "no scan candidate" path.
  original: HTMLCanvasElement;
}

interface Corner {
  x: number;
  y: number;
}

// A surviving 4-vertex candidate from any one detection strategy, plus the score used to
// pick the best candidate across all strategies (see `findBestQuadInMap`).
interface QuadCandidate {
  corners: [Corner, Corner, Corner, Corner];
  score: number;
}

const LOAD_TIMEOUT_MS = 8000;
const WORK_MAX_EDGE = 1000; // detection runs on a shrunk copy for speed; the warp itself
// always uses the full-resolution original so output quality isn't capped by this.
const MIN_AREA_RATIO = 0.08; // reject contours covering too little of the frame (no document)
const MAX_AREA_RATIO = 0.98; // reject "the whole photo is the contour" (no border found)
const MORPH_CLOSE_KERNEL = 7; // bridges gaps in the edge map (e.g. a finger occluding the border)
const MAX_CONTOURS_PER_MAP = 10; // top-N by area considered per strategy, keeps this bounded
const APPROX_EPSILONS = [0.02, 0.03, 0.04]; // fractions of arc length tried for approxPolyDP

let cvPromise: Promise<CvNamespace | null> | null = null;

// Minimal shape of the bits of the OpenCV.js API used below — the real module has no
// first-party types for the runtime object, so this keeps call sites checked without
// pulling in a heavyweight type dependency.
type CvNamespace = any;

// Kicks off the OpenCV.js dynamic import ahead of time (call from a component's mount
// effect). Safe to call repeatedly — the load runs once and is cached; a failed load
// clears the cache so a later call retries (a slow first download on mobile must not
// disable scanning for the whole session). Never throws and never rejects; resolves to
// `null` on failure. Deliberately NOT time-limited — per-photo waits are bounded by the
// withTimeout race in scanDocument instead, so a load that outlives one photo's patience
// is still available for the next photo.
export function warmScanLibrary(): Promise<CvNamespace | null> {
  if (!cvPromise) {
    cvPromise = loadCvInner().catch(() => {
      cvPromise = null;
      return null;
    });
  }
  return cvPromise;
}

async function loadCvInner(): Promise<CvNamespace> {
  // The dynamic import is the ONLY reference to this package anywhere in the app — that's
  // what makes Vite/Rollup split it into its own chunk instead of folding it into main.
  const mod: any = await import('@techstark/opencv-js');
  const cvModule: any = mod?.default ?? mod;
  if (!cvModule) throw new Error('cv_module_missing');
  if (typeof cvModule.then === 'function') {
    // Some builds export a Promise that resolves once the WASM runtime is ready.
    return await cvModule;
  }
  if (cvModule.Mat) {
    // Already-initialized module (rare, but the documented shape allows for it).
    return cvModule;
  }
  // Event-based init: resolve once the runtime signals it's ready.
  return await new Promise<CvNamespace>((resolve, reject) => {
    try {
      cvModule.onRuntimeInitialized = () => resolve(cvModule);
    } catch (e) {
      reject(e as Error);
    }
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('scan_timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// Runs the full scan attempt for one picked file. Never throws.
export async function scanDocument(file: File): Promise<ScanOutcome | null> {
  let original: HTMLCanvasElement;
  try {
    original = await decodeUprightCanvas(file);
  } catch {
    // Couldn't even decode the photo for scanning — caller falls all the way back to the
    // original raw-file upload path (today's behavior, unchanged).
    return null;
  }

  let scanned: HTMLCanvasElement | null = null;
  try {
    // Bound this photo's wait, but let the underlying load keep going for the next one.
    const cv = await withTimeout(warmScanLibrary(), LOAD_TIMEOUT_MS).catch(() => null);
    if (cv) {
      const workScale =
        original.width > WORK_MAX_EDGE || original.height > WORK_MAX_EDGE
          ? WORK_MAX_EDGE / Math.max(original.width, original.height)
          : 1;
      const workCanvas = workScale === 1 ? original : shrinkCopy(original, workScale);
      const corners = locateDocumentCorners(cv, workCanvas);
      if (corners) {
        const fullCorners = corners.map((p) => ({ x: p.x / workScale, y: p.y / workScale })) as [
          Corner,
          Corner,
          Corner,
          Corner,
        ];
        scanned = warpAndEnhance(cv, original, fullCorners);
      }
    }
  } catch {
    scanned = null;
  }
  return { scanned, original };
}

function shrinkCopy(canvas: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(canvas.width * scale));
  out.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('canvas_unsupported');
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

// Finds the four corners (in `canvas` pixel coordinates) of the best plausible document
// quad, or null if nothing plausible is found anywhere. Runs several independent
// binarization strategies (auto-Canny, fixed Canny, Otsu, adaptive threshold) since no
// single one is reliable across lighting/contrast conditions in the field (low-contrast
// paper-on-tile, finger occlusion, busy backgrounds); scores every surviving 4-vertex
// candidate across all of them and keeps the best. Falls back to the original
// largest-contour + quadrant-extreme heuristic if no strategy yields a clean quad, so a
// rough crop offer beats no offer at all (the user can always keep the original photo).
function locateDocumentCorners(cv: CvNamespace, canvas: HTMLCanvasElement): [Corner, Corner, Corner, Corner] | null {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    // Edge-preserving smoothing before any of the strategies below — cuts down on the
    // texture noise a busy background (tile grout, wood grain, a grid-paper backdrop)
    // would otherwise contribute as spurious contours.
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

    const imgArea = src.rows * src.cols;
    const maps = buildCandidateMaps(cv, blurred);
    let best: QuadCandidate | null = null;
    try {
      for (const map of maps) {
        const found = findBestQuadInMap(cv, map, imgArea);
        if (found && (!best || found.score > best.score)) best = found;
      }
    } finally {
      for (const m of maps) m.delete();
    }
    if (best) return best.corners;

    return fallbackLargestContour(cv, blurred, imgArea);
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
  }
}

// Approximates the median of a single-channel 8-bit Mat via a 256-bin histogram (no need
// to sort hundreds of thousands of pixels) — feeds the classic auto-Canny threshold
// formula (lower = 0.66*median, upper = 1.33*median).
function medianGray(mat: any): number {
  const data: Uint8Array = mat.data;
  const hist = new Array(256).fill(0);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  const half = data.length / 2;
  let cumulative = 0;
  for (let v = 0; v < 256; v++) {
    cumulative += hist[v];
    if (cumulative >= half) return v;
  }
  return 128;
}

// Builds the set of binary edge/region maps to search for a document quad in, each a
// different bet on what will separate the paper from its background. Caller owns and must
// delete every returned Mat. Never throws: on any failure partway through, whatever Mats
// were already built are deleted and an empty array is returned (locateDocumentCorners
// then just falls through to the fixed-heuristic fallback).
function buildCandidateMaps(cv: CvNamespace, blurred: any): any[] {
  const maps: any[] = [];
  let closeKernel: any;
  try {
    closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(MORPH_CLOSE_KERNEL, MORPH_CLOSE_KERNEL));

    // (a) Auto-Canny (median-derived thresholds) + morphological close. The close (not
    // just dilate) bridges gaps left where a finger occludes part of the document border.
    const median = medianGray(blurred);
    const lower = Math.max(0, Math.round(0.66 * median));
    const upper = Math.min(255, Math.round(1.33 * median));
    let edges = new cv.Mat();
    cv.Canny(blurred, edges, lower, upper);
    let closed = new cv.Mat();
    cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, closeKernel);
    edges.delete();
    maps.push(closed);

    // (b) Fixed Canny 50/150 (the original thresholds) + the same close, as a second,
    // independent bet — cheap insurance for scenes the auto thresholds misjudge.
    edges = new cv.Mat();
    cv.Canny(blurred, edges, 50, 150);
    closed = new cv.Mat();
    cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, closeKernel);
    edges.delete();
    maps.push(closed);

    // (c) Otsu threshold on the blurred gray — segments by brightness (bright paper vs a
    // darker background) rather than by edge gradients, which helps on low-contrast paper
    // edges Canny tends to miss.
    const otsu = new cv.Mat();
    cv.threshold(blurred, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    maps.push(otsu);

    // (d) Adaptive threshold — a local/regional variant of (c), cheap to add and catches
    // cases with uneven lighting across the frame that a single global Otsu level misses.
    const adaptive = new cv.Mat();
    cv.adaptiveThreshold(blurred, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 35, 10);
    maps.push(adaptive);

    return maps;
  } catch {
    for (const m of maps) m.delete();
    return [];
  } finally {
    closeKernel?.delete();
  }
}

// Searches one binary map for the best document-shaped quad: takes the top-N contours by
// area, tries a few approxPolyDP epsilons on each, keeps only convex 4-vertex results in
// the plausible area range, and scores each by area * rectangularity (how close its area
// is to its own minAreaRect's area — a true rectangle scores ~1.0, a skinny/irregular
// quad scores much lower). Returns the best candidate found in this map, or null.
function findBestQuadInMap(cv: CvNamespace, map: any, imgArea: number): QuadCandidate | null {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let best: QuadCandidate | null = null;
  try {
    cv.findContours(map, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const n = contours.size();
    const byArea: { idx: number; area: number }[] = [];
    for (let i = 0; i < n; i++) {
      const c = contours.get(i);
      byArea.push({ idx: i, area: cv.contourArea(c) });
      c.delete();
    }
    byArea.sort((a, b) => b.area - a.area);
    const top = byArea.slice(0, MAX_CONTOURS_PER_MAP);

    for (const { idx, area } of top) {
      if (area < imgArea * MIN_AREA_RATIO || area > imgArea * MAX_AREA_RATIO) continue;
      const c = contours.get(idx);
      try {
        const peri = cv.arcLength(c, true);
        for (const epsFrac of APPROX_EPSILONS) {
          const approx = new cv.Mat();
          try {
            cv.approxPolyDP(c, approx, epsFrac * peri, true);
            if (approx.rows !== 4) continue;
            if (!cv.isContourConvex(approx)) continue;

            const rect = cv.minAreaRect(approx);
            const rectArea = rect.size.width * rect.size.height;
            if (rectArea <= 0) continue;
            const rectangularity = Math.min(1, area / rectArea);
            const score = area * rectangularity;
            if (best && score <= best.score) continue;

            const corners = extractQuadrantCorners(approx, rect.center);
            if (corners) best = { corners, score };
          } finally {
            approx.delete();
          }
        }
      } finally {
        c.delete();
      }
    }
    return best;
  } finally {
    contours.delete();
    hierarchy.delete();
  }
}

// The original detection heuristic (fixed Canny 50/150 + dilate, largest contour by area,
// quadrant-extreme corners) — kept as the last-resort fallback when no strategy above
// yields a clean 4-vertex quad. Reuses the already-blurred gray Mat from the caller.
function fallbackLargestContour(cv: CvNamespace, blurred: any, imgArea: number): [Corner, Corner, Corner, Corner] | null {
  const edges = new cv.Mat();
  const dilated = new cv.Mat();
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.Canny(blurred, edges, 50, 150);
    cv.dilate(edges, dilated, kernel);
    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let bestIdx = -1;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area > bestArea) {
        bestArea = area;
        bestIdx = i;
      }
      c.delete();
    }
    if (bestIdx < 0) return null;
    if (bestArea < imgArea * MIN_AREA_RATIO || bestArea > imgArea * MAX_AREA_RATIO) return null;

    const best = contours.get(bestIdx);
    try {
      const rect = cv.minAreaRect(best);
      return extractQuadrantCorners(best, rect.center);
    } finally {
      best.delete();
    }
  } finally {
    edges.delete();
    dilated.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }
}

// For each quadrant around the contour's center, keeps the point furthest from center —
// the same "extreme corner per quadrant" heuristic jscanify uses, reimplemented directly.
// Returns [topLeft, topRight, bottomLeft, bottomRight] or null if any quadrant is empty.
function extractQuadrantCorners(contour: any, center: { x: number; y: number }): [Corner, Corner, Corner, Corner] | null {
  let tl: Corner | null = null;
  let tlDist = -1;
  let tr: Corner | null = null;
  let trDist = -1;
  let bl: Corner | null = null;
  let blDist = -1;
  let br: Corner | null = null;
  let brDist = -1;

  const data: Int32Array = contour.data32S;
  for (let i = 0; i < data.length; i += 2) {
    const x = data[i];
    const y = data[i + 1];
    const dx = x - center.x;
    const dy = y - center.y;
    const distSq = dx * dx + dy * dy;
    if (x < center.x && y < center.y) {
      if (distSq > tlDist) {
        tlDist = distSq;
        tl = { x, y };
      }
    } else if (x >= center.x && y < center.y) {
      if (distSq > trDist) {
        trDist = distSq;
        tr = { x, y };
      }
    } else if (x < center.x && y >= center.y) {
      if (distSq > blDist) {
        blDist = distSq;
        bl = { x, y };
      }
    } else {
      if (distSq > brDist) {
        brDist = distSq;
        br = { x, y };
      }
    }
  }
  if (!tl || !tr || !bl || !br) return null;
  return [tl, tr, bl, br];
}

function dist(a: Corner, b: Corner): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Warps `canvas` (full resolution) so the quad [topLeft, topRight, bottomLeft, bottomRight]
// becomes an upright rectangle, then applies a mild, color-preserving contrast boost.
function warpAndEnhance(
  cv: CvNamespace,
  canvas: HTMLCanvasElement,
  corners: [Corner, Corner, Corner, Corner],
): HTMLCanvasElement | null {
  const [tl, tr, bl, br] = corners;
  const outW = Math.max(200, Math.round((dist(tl, tr) + dist(bl, br)) / 2));
  const outH = Math.max(200, Math.round((dist(tl, bl) + dist(tr, br)) / 2));

  const src = cv.imread(canvas);
  let srcTri: any;
  let dstTri: any;
  let M: any;
  let warped: any;
  let enhanced: any;
  try {
    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, bl.x, bl.y, br.x, br.y]);
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, 0, outH, outW, outH]);
    M = cv.getPerspectiveTransform(srcTri, dstTri);
    warped = new cv.Mat();
    cv.warpPerspective(src, warped, M, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

    enhanced = enhanceContrast(cv, warped);
    const outCanvas = document.createElement('canvas');
    cv.imshow(outCanvas, enhanced);
    return outCanvas;
  } finally {
    src.delete();
    srcTri?.delete();
    dstTri?.delete();
    M?.delete();
    warped?.delete();
    enhanced?.delete();
  }
}

// Mild, color-preserving contrast enhancement: CLAHE (adaptive histogram equalization) on
// the L channel of Lab color space only, so receipts get more legible contrast without the
// color-cast/oversaturation that per-RGB-channel equalization would cause.
function enhanceContrast(cv: CvNamespace, rgba: any): any {
  const rgb = new cv.Mat();
  const lab = new cv.Mat();
  const channels = new cv.MatVector();
  let clahe: any;
  let lEq: any;
  let merged: any;
  let rgbOut: any;
  try {
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    cv.split(lab, channels);
    const l = channels.get(0);
    clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
    lEq = new cv.Mat();
    clahe.apply(l, lEq);
    lEq.copyTo(l);
    l.delete();

    merged = new cv.Mat();
    cv.merge(channels, merged);
    rgbOut = new cv.Mat();
    cv.cvtColor(merged, rgbOut, cv.COLOR_Lab2RGB);
    const rgbaOut = new cv.Mat();
    cv.cvtColor(rgbOut, rgbaOut, cv.COLOR_RGB2RGBA);
    return rgbaOut;
  } finally {
    rgb.delete();
    lab.delete();
    channels.delete();
    clahe?.delete();
    lEq?.delete();
    merged?.delete();
    rgbOut?.delete();
  }
}
