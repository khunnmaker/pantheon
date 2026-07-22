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

// --- Corner refinement (subpixel-ish tightening of the coarse approxPolyDP quad) ---
const REFINE_MOVE_LIMIT_FRAC = 0.03; // a refined corner moving > 3% of the frame diagonal
// from its coarse position is treated as unstable and reverted to the coarse corner.
const REFINE_CORRIDOR_MIN_PX = 6; // minimum edge-pixel search corridor half-width
const REFINE_CORRIDOR_FRAC_OF_DIAG = 0.01; // corridor half-width as a fraction of the diagonal
const REFINE_SEGMENT_EXTEND_FRAC = 0.1; // allow edge points slightly beyond the coarse segment
// ends (near the corner) to still count toward that side's line fit
const REFINE_MIN_FIT_POINTS = 12; // below this many corridor points, fitLine is too noisy —
// fall back to the coarse (unfit) side line for that side
const REFINE_PARALLEL_SIN_EPS = 0.05; // |cross of two unit directions| below this ~= parallel
// (adjacent quad sides are normally near-perpendicular, so this only trips on genuine failure)
const REFINE_AREA_MIN_RATIO = 0.6; // refined quad area vs coarse quad area guard rails — outside
const REFINE_AREA_MAX_RATIO = 1.3; // this range (or non-convex), discard refinement entirely

// --- "Scanned paper" enhancement (illumination flattening + gentle stretch + unsharp) ---
const ENHANCE_MAX_EDGE = 1600; // never run enhancement above the upload-cap resolution
const ILLUM_SAMPLE_MAX_EDGE = 200; // per-channel illumination is estimated on a small proxy
// (downscale → blur → upscale) — much cheaper than a literal huge-kernel blur at full size
// and just as smooth, since illumination is by nature a very low-frequency signal.
const PAPER_TARGET = 245; // background gray level the flattened paper should land near
const CONTRAST_STRETCH_LO_PCT = 0.005; // percentile clip points for the global contrast stretch
const CONTRAST_STRETCH_HI_PCT = 0.995;
const CONTRAST_STRETCH_GENTLENESS = 0.6; // 0 = no stretch, 1 = full stretch to the clip points
const SHARPEN_SIGMA = 1.0; // unsharp mask Gaussian sigma
const SHARPEN_AMOUNT = 0.5; // mild — text crisper without visible halos

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
  let refineEdges: any;
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
    const coarse = best ? best.corners : fallbackLargestContour(cv, blurred, imgArea);
    if (!coarse) return null;

    // Corner refinement: approxPolyDP corners are coarse (integer contour vertices on a
    // ≤1000px work image), which is enough to visibly offset the warp from the paper's true
    // edge. Fit a line to the real edge pixels along each side and intersect adjacent sides
    // for a tighter corner. Guarded and fail-open — see refineQuadCorners.
    try {
      refineEdges = buildRefineEdgeMap(cv, blurred);
      if (refineEdges) {
        const frameDiag = Math.hypot(src.cols, src.rows);
        return refineQuadCorners(cv, refineEdges, coarse, frameDiag);
      }
    } catch {
      // fall through — refinement is a pure enhancement of `coarse`, never a requirement
    }
    return coarse;
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    refineEdges?.delete();
  }
}

// Builds the edge map that corner refinement searches for real document-border pixels.
// Reuses the same auto-Canny (median-derived thresholds) approach as detection strategy (a)
// so refinement sees the same edges that (most likely) produced the coarse quad. Returns
// null (never throws) on failure — caller treats that as "skip refinement".
function buildRefineEdgeMap(cv: CvNamespace, blurred: any): any {
  try {
    const median = medianGray(blurred);
    const lower = Math.max(0, Math.round(0.66 * median));
    const upper = Math.min(255, Math.round(1.33 * median));
    const edges = new cv.Mat();
    cv.Canny(blurred, edges, lower, upper);
    return edges;
  } catch {
    return null;
  }
}

// A fitted (or coarse-fallback) line for one side of the quad, expressed as a point plus a
// unit direction vector — the representation both cv.fitLine and a plain two-point line
// share, so intersection math doesn't need to branch on which one produced it.
interface SideLine {
  point: Corner;
  dir: Corner;
}

// Refines all four corners of `coarse` using real edge pixels near each side, then applies
// the guard rails: any single corner that would move more than ~3% of the frame diagonal, or
// whose two adjacent side-lines are near-parallel (unstable intersection), reverts to its
// coarse position individually. After that, the whole refined quad is checked for convexity
// and a sane area (60–130% of the coarse quad's area); if either check fails, refinement is
// discarded wholesale and the original coarse quad is returned. Never throws.
function refineQuadCorners(
  cv: CvNamespace,
  edgeMap: any,
  coarse: [Corner, Corner, Corner, Corner],
  frameDiag: number,
): [Corner, Corner, Corner, Corner] {
  try {
    const [tl, tr, bl, br] = coarse;
    // Perimeter order tl → tr → br → bl → tl, so each side pairs with its true neighbors.
    const corridor = Math.max(REFINE_CORRIDOR_MIN_PX, frameDiag * REFINE_CORRIDOR_FRAC_OF_DIAG);
    const top = fitSideLine(cv, edgeMap, tl, tr, corridor) ?? coarseLine(tl, tr);
    const right = fitSideLine(cv, edgeMap, tr, br, corridor) ?? coarseLine(tr, br);
    const bottom = fitSideLine(cv, edgeMap, br, bl, corridor) ?? coarseLine(br, bl);
    const left = fitSideLine(cv, edgeMap, bl, tl, corridor) ?? coarseLine(bl, tl);

    const moveLimit = frameDiag * REFINE_MOVE_LIMIT_FRAC;
    const newTl = safeIntersect(left, top, tl, moveLimit);
    const newTr = safeIntersect(top, right, tr, moveLimit);
    const newBr = safeIntersect(right, bottom, br, moveLimit);
    const newBl = safeIntersect(bottom, left, bl, moveLimit);
    const refined: [Corner, Corner, Corner, Corner] = [newTl, newTr, newBl, newBr];

    if (!isRefinementSane(refined, coarse)) return coarse;
    return refined;
  } catch {
    return coarse;
  }
}

// Fits a line to edge-map pixels found within `corridor` px of the infinite line through
// (a, b), restricted to a bounding box around the segment (slightly extended past its ends
// so real corners — which sit a little outside the coarse segment when the coarse corner
// undershoots — still contribute). Returns null (caller falls back to the coarse two-point
// line for that side) when too few points survive to trust a fit.
function fitSideLine(cv: CvNamespace, edgeMap: any, a: Corner, b: Corner, corridor: number): SideLine | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const segLen = Math.hypot(dx, dy);
  if (segLen < 1) return null;
  const ux = dx / segLen;
  const uy = dy / segLen;
  const nx = -uy;
  const ny = ux;
  const ext = Math.max(corridor, segLen * REFINE_SEGMENT_EXTEND_FRAC);

  const cols = edgeMap.cols;
  const rows = edgeMap.rows;
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - ext));
  const maxX = Math.min(cols - 1, Math.ceil(Math.max(a.x, b.x) + ext));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - ext));
  const maxY = Math.min(rows - 1, Math.ceil(Math.max(a.y, b.y) + ext));
  if (maxX < minX || maxY < minY) return null;

  const data: Uint8Array = edgeMap.data;
  const pts: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    const rowOff = y * cols;
    for (let x = minX; x <= maxX; x++) {
      if (data[rowOff + x] === 0) continue;
      const relX = x - a.x;
      const relY = y - a.y;
      const t = (relX * ux + relY * uy) / segLen;
      if (t < -REFINE_SEGMENT_EXTEND_FRAC || t > 1 + REFINE_SEGMENT_EXTEND_FRAC) continue;
      const perp = Math.abs(relX * nx + relY * ny);
      if (perp > corridor) continue;
      pts.push(x, y);
    }
  }
  if (pts.length / 2 < REFINE_MIN_FIT_POINTS) return null;

  let ptsMat: any;
  let lineOut: any;
  try {
    ptsMat = cv.matFromArray(pts.length / 2, 1, cv.CV_32SC2, pts);
    lineOut = new cv.Mat();
    cv.fitLine(ptsMat, lineOut, cv.DIST_L2, 0, 0.01, 0.01);
    const d: Float32Array = lineOut.data32F;
    const dirLen = Math.hypot(d[0], d[1]) || 1;
    return { dir: { x: d[0] / dirLen, y: d[1] / dirLen }, point: { x: d[2], y: d[3] } };
  } catch {
    return null;
  } finally {
    ptsMat?.delete();
    lineOut?.delete();
  }
}

function coarseLine(a: Corner, b: Corner): SideLine {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { point: a, dir: { x: dx / len, y: dy / len } };
}

// Intersects two side lines and returns the intersection — unless the lines are near-parallel
// (unstable) or the intersection lands further than `moveLimit` from `coarseCorner`, in which
// case `coarseCorner` itself is returned unchanged.
function safeIntersect(l1: SideLine, l2: SideLine, coarseCorner: Corner, moveLimit: number): Corner {
  const denom = l1.dir.x * l2.dir.y - l1.dir.y * l2.dir.x;
  if (Math.abs(denom) < REFINE_PARALLEL_SIN_EPS) return coarseCorner;
  const t = ((l2.point.x - l1.point.x) * l2.dir.y - (l2.point.y - l1.point.y) * l2.dir.x) / denom;
  const ix = l1.point.x + t * l1.dir.x;
  const iy = l1.point.y + t * l1.dir.y;
  if (!Number.isFinite(ix) || !Number.isFinite(iy)) return coarseCorner;
  if (dist({ x: ix, y: iy }, coarseCorner) > moveLimit) return coarseCorner;
  return { x: ix, y: iy };
}

function polygonArea(poly: Corner[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function isConvexPoly(poly: Corner[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = poly[(i + 2) % poly.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) continue; // collinear — inconclusive, doesn't break convexity
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// Corners are stored as [tl, tr, bl, br]; the actual perimeter walk is tl → tr → br → bl.
function isRefinementSane(
  refined: [Corner, Corner, Corner, Corner],
  coarse: [Corner, Corner, Corner, Corner],
): boolean {
  const refinedPoly = [refined[0], refined[1], refined[3], refined[2]];
  const coarsePoly = [coarse[0], coarse[1], coarse[3], coarse[2]];
  if (!isConvexPoly(refinedPoly)) return false;
  const coarseArea = polygonArea(coarsePoly);
  if (coarseArea <= 0) return false;
  const ratio = polygonArea(refinedPoly) / coarseArea;
  return ratio >= REFINE_AREA_MIN_RATIO && ratio <= REFINE_AREA_MAX_RATIO;
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
// becomes an upright rectangle, then applies the "scanned paper" enhancement. The perspective
// warp itself always runs at full resolution (crop quality shouldn't be capped), but the
// enhancement step is bounded to ENHANCE_MAX_EDGE — see enhanceScan. Enhancement failure is
// contained right here: it falls back to the plain warped crop rather than losing the crop
// entirely, matching scan.ts's overall fail-open contract.
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

    try {
      enhanced = enhanceScan(cv, warped);
    } catch {
      enhanced = null;
    }
    const outCanvas = document.createElement('canvas');
    cv.imshow(outCanvas, enhanced ?? warped);
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

// "Scanned paper" enhancement — illumination-flattening ("paper whitening") rather than
// CLAHE: estimates per-channel background illumination with a cheap large-scale blur, divides
// it out so paper backgrounds land near-white regardless of shadows/uneven lighting, then
// applies a gentle global contrast stretch and a light unsharp mask so text stays crisp
// without halos. Runs per-RGB-channel (each with its own illumination estimate) so color
// content — stamps, colored slip paper, logos — survives even though shadows/gray cast don't.
// Bounded to ENHANCE_MAX_EDGE regardless of the input's resolution (warps can be 4000px+ on a
// modern phone camera; this step must never run at that size). Always returns a new Mat the
// caller must delete; throws are the caller's problem to catch (see warpAndEnhance).
function enhanceScan(cv: CvNamespace, rgba: any): any {
  let working = rgba;
  let resized: any;
  try {
    const longEdge = Math.max(rgba.cols, rgba.rows);
    if (longEdge > ENHANCE_MAX_EDGE) {
      const scale = ENHANCE_MAX_EDGE / longEdge;
      resized = new cv.Mat();
      cv.resize(
        rgba,
        resized,
        new cv.Size(Math.max(1, Math.round(rgba.cols * scale)), Math.max(1, Math.round(rgba.rows * scale))),
        0,
        0,
        cv.INTER_AREA,
      );
      working = resized;
    }
    return flattenAndSharpen(cv, working);
  } finally {
    resized?.delete();
  }
}

function flattenAndSharpen(cv: CvNamespace, rgba: any): any {
  const rgb = new cv.Mat();
  const channels = new cv.MatVector();
  let r: any, g: any, b: any;
  let flatR: any, flatG: any, flatB: any;
  let mergedVec: any;
  let merged: any;
  let stretched: any;
  let sharpened: any;
  try {
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    cv.split(rgb, channels);
    r = channels.get(0);
    g = channels.get(1);
    b = channels.get(2);
    flatR = flattenIlluminationChannel(cv, r);
    flatG = flattenIlluminationChannel(cv, g);
    flatB = flattenIlluminationChannel(cv, b);

    mergedVec = new cv.MatVector();
    mergedVec.push_back(flatR);
    mergedVec.push_back(flatG);
    mergedVec.push_back(flatB);
    merged = new cv.Mat();
    cv.merge(mergedVec, merged);

    stretched = globalContrastStretch(cv, merged);
    sharpened = unsharpMask(cv, stretched);

    const rgbaOut = new cv.Mat();
    cv.cvtColor(sharpened, rgbaOut, cv.COLOR_RGB2RGBA);
    return rgbaOut;
  } finally {
    rgb.delete();
    channels.delete();
    r?.delete();
    g?.delete();
    b?.delete();
    flatR?.delete();
    flatG?.delete();
    flatB?.delete();
    mergedVec?.delete();
    merged?.delete();
    stretched?.delete();
    sharpened?.delete();
  }
}

// Flattens one 8-bit channel's illumination: estimates a smooth background via a small proxy
// (downscale → blur → upscale — cheap and, since illumination is inherently low-frequency, as
// good as a literal huge-kernel blur at full size) then divides it out, rescaling so the
// background lands near PAPER_TARGET. `cv.divide`'s `scale` parameter does the divide-and-
// rescale in one call; `convertTo` back to CV_8U saturates, which is the "clip highlights"
// step. Caller owns and must delete the returned Mat.
function flattenIlluminationChannel(cv: CvNamespace, channel: any): any {
  const cols = channel.cols;
  const rows = channel.rows;
  const longEdge = Math.max(cols, rows);
  let small: any;
  let illumSmall: any;
  let illum: any;
  let channelF: any;
  let illumF: any;
  let ratio: any;
  try {
    let illumSource = channel;
    if (longEdge > ILLUM_SAMPLE_MAX_EDGE) {
      const scale = ILLUM_SAMPLE_MAX_EDGE / longEdge;
      small = new cv.Mat();
      cv.resize(
        channel,
        small,
        new cv.Size(Math.max(1, Math.round(cols * scale)), Math.max(1, Math.round(rows * scale))),
        0,
        0,
        cv.INTER_AREA,
      );
      illumSource = small;
    }
    const k = oddAtLeast3(Math.round(Math.max(illumSource.cols, illumSource.rows) / 6));
    illumSmall = new cv.Mat();
    cv.GaussianBlur(illumSource, illumSmall, new cv.Size(k, k), 0, 0, cv.BORDER_REPLICATE);

    if (small) {
      illum = new cv.Mat();
      cv.resize(illumSmall, illum, new cv.Size(cols, rows), 0, 0, cv.INTER_LINEAR);
    } else {
      illum = illumSmall;
      illumSmall = null; // ownership moved to `illum`, don't double-delete in finally
    }

    channelF = new cv.Mat();
    illumF = new cv.Mat();
    channel.convertTo(channelF, cv.CV_32F);
    // Tiny additive epsilon guards the (rare) fully-black-illumination-patch divide-by-zero.
    illum.convertTo(illumF, cv.CV_32F, 1, 1e-3);
    ratio = new cv.Mat();
    cv.divide(channelF, illumF, ratio, PAPER_TARGET);

    const out = new cv.Mat();
    ratio.convertTo(out, cv.CV_8U); // saturating cast = the clip-highlights step
    return out;
  } finally {
    small?.delete();
    illumSmall?.delete();
    illum?.delete();
    channelF?.delete();
    illumF?.delete();
    ratio?.delete();
  }
}

function oddAtLeast3(n: number): number {
  const v = Math.max(3, n);
  return v % 2 === 0 ? v + 1 : v;
}

// Gentle global contrast stretch: finds the (0.5th, 99.5th) percentile levels of the image's
// luminance and maps them toward black/white, but only partway (CONTRAST_STRETCH_GENTLENESS)
// so text gets crisper without blowing out midtones. Deliberately computed from a single
// luminance histogram and applied as ONE affine transform across all three channels — a
// per-channel stretch here would reintroduce the color cast the illumination flattening just
// removed. Always returns a new Mat; falls back to a plain clone if the histogram is
// degenerate (e.g. a flat/blank image) rather than dividing by zero.
function globalContrastStretch(cv: CvNamespace, rgb: any): any {
  const gray = new cv.Mat();
  try {
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    const data: Uint8Array = gray.data;
    const hist = new Array(256).fill(0);
    for (let i = 0; i < data.length; i++) hist[data[i]]++;
    const total = data.length;

    const loTarget = total * CONTRAST_STRETCH_LO_PCT;
    let lo = 0;
    let cum = 0;
    for (let v = 0; v < 256; v++) {
      cum += hist[v];
      if (cum >= loTarget) {
        lo = v;
        break;
      }
    }
    const hiTarget = total * CONTRAST_STRETCH_HI_PCT;
    let hi = 255;
    cum = 0;
    for (let v = 0; v < 256; v++) {
      cum += hist[v];
      if (cum >= hiTarget) {
        hi = v;
        break;
      }
    }

    const out = new cv.Mat();
    if (hi <= lo) {
      rgb.copyTo(out);
      return out;
    }
    const fullAlpha = 255 / (hi - lo);
    const fullBeta = -lo * fullAlpha;
    const alpha = 1 + (fullAlpha - 1) * CONTRAST_STRETCH_GENTLENESS;
    const beta = fullBeta * CONTRAST_STRETCH_GENTLENESS;
    rgb.convertTo(out, -1, alpha, beta);
    return out;
  } finally {
    gray.delete();
  }
}

// Mild unsharp mask: out = rgb*(1+amount) - blur(rgb)*amount. Low amount + modest sigma keeps
// text edges crisp without the visible halo a stronger sharpen would leave around them.
function unsharpMask(cv: CvNamespace, rgb: any): any {
  const blurred = new cv.Mat();
  try {
    cv.GaussianBlur(rgb, blurred, new cv.Size(0, 0), SHARPEN_SIGMA, SHARPEN_SIGMA, cv.BORDER_DEFAULT);
    const out = new cv.Mat();
    cv.addWeighted(rgb, 1 + SHARPEN_AMOUNT, blurred, -SHARPEN_AMOUNT, 0, out);
    return out;
  } finally {
    blurred.delete();
  }
}
