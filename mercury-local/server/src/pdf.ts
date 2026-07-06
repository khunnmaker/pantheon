// PO PDF builder. Retires the /purchase-orders and /purchase-orders-taiwan skills' rules in code
// (see docs/MERCURY_BRIEF.md §6):
//   - Clean ENGLISH-ONLY PO, one PDF per vendor.
//   - Header: vendor + PO number + date + CC list (from Vendor.ccList).
//   - Columns: item name + order qty + unit split. NO internal code column.
//   - Taiwan vendors (Vendor.isTaiwan) → split into NORMAL vs SPECIAL sections by classification.
//   - Product picture per line: embed the image at photoRef (local path or http(s) URL); if
//     missing/unreadable, draw a placeholder box labelled "no image" — never crash.
//
// Pure-JS: pdfkit (no external binary / no headless chrome) so the one-click local app stays
// dependency-light. Images are fetched (URL) or read (file) into a Buffer; any failure → placeholder.
import PDFDocument from 'pdfkit';
import { readFileSync, existsSync, createWriteStream, mkdirSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { PKG_ROOT } from './env.js';

export interface PdfVendor {
  name: string;
  email: string;
  ccList: string;
  contactName: string;
  isTaiwan: boolean;
  terms: string;
}

export interface PdfLine {
  realName: string;
  qty: string;
  unit: string;
  classification: 'normal' | 'special';
  photoRef: string | null;
}

// Output folder for generated PDFs (GITIGNORED — see .gitignore po-output/).
export const PO_OUTPUT_DIR = resolve(PKG_ROOT, 'po-output');

function ensureOutputDir(): void {
  if (!existsSync(PO_OUTPUT_DIR)) mkdirSync(PO_OUTPUT_DIR, { recursive: true });
}

// Resolve a photoRef to an image Buffer, or null if it can't be loaded. Never throws.
async function loadImage(photoRef: string | null): Promise<Buffer | null> {
  if (!photoRef || !photoRef.trim()) return null;
  const ref = photoRef.trim();
  try {
    if (/^https?:\/\//i.test(ref)) {
      const res = await fetch(ref);
      if (!res.ok) return null;
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    }
    // Local file path — absolute, or relative to the package root.
    const p = isAbsolute(ref) ? ref : resolve(PKG_ROOT, ref);
    if (!existsSync(p)) return null;
    return readFileSync(p);
  } catch {
    return null; // unreadable / unsupported → placeholder
  }
}

// Layout constants.
const M = 50; // page margin
const ROW_H = 64; // row height (tall enough for the product thumbnail)
const IMG_W = 54;
const IMG_H = 54;

function safeFilename(s: string): string {
  return s.replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '') || 'vendor';
}

// Build one PO PDF for a vendor. Returns the absolute path written.
export async function buildPoPdf(opts: {
  vendor: PdfVendor;
  poNumber: string;
  date?: Date;
  lines: PdfLine[];
}): Promise<string> {
  ensureOutputDir();
  const { vendor, poNumber, lines } = opts;
  const date = opts.date ?? new Date();

  // Pre-load all images (concurrently) so the sync pdfkit drawing loop has Buffers ready.
  const images = await Promise.all(lines.map((l) => loadImage(l.photoRef)));
  const lineImgs = lines.map((l, i) => ({ line: l, img: images[i] }));

  const outPath = resolve(PO_OUTPUT_DIR, `${safeFilename(poNumber)}_${safeFilename(vendor.name)}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margin: M });
  const stream = createWriteStream(outPath);
  doc.pipe(stream);

  const pageRight = doc.page.width - M;

  // ── Header ────────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#c2560c').text('PURCHASE ORDER', M, M);
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10).fillColor('#333');
  const headerTop = doc.y;
  // Left column: vendor
  doc.font('Helvetica-Bold').text('To:', M, headerTop);
  doc.font('Helvetica').text(vendor.name, M + 60, headerTop);
  if (vendor.contactName) doc.text(`Attn: ${vendor.contactName}`, M + 60, doc.y);
  if (vendor.email) doc.text(vendor.email, M + 60, doc.y);
  // Right column: PO meta (drawn from headerTop)
  const metaX = pageRight - 200;
  doc.font('Helvetica-Bold').text('PO No:', metaX, headerTop, { width: 90, continued: false });
  doc.font('Helvetica').text(poNumber, metaX + 90, headerTop);
  doc.font('Helvetica-Bold').text('Date:', metaX, headerTop + 15);
  doc.font('Helvetica').text(date.toISOString().slice(0, 10), metaX + 90, headerTop + 15);
  if (vendor.terms) {
    doc.font('Helvetica-Bold').text('Terms:', metaX, headerTop + 30);
    doc.font('Helvetica').text(vendor.terms, metaX + 90, headerTop + 30, { width: 110 });
  }

  doc.moveDown(1);
  // CC list
  const cc = vendor.ccList
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (cc.length) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#666').text(`CC: ${cc.join(', ')}`, M);
  }
  doc.moveDown(0.5);

  // ── Sections ────────────────────────────────────────────────────────────────
  // Taiwan vendors split NORMAL vs SPECIAL; everyone else is one section.
  let cursorY = Math.max(doc.y, headerTop + 70);

  const drawSection = async (title: string | null, secLines: typeof lineImgs) => {
    if (secLines.length === 0) return;
    if (title) {
      cursorY = ensureSpace(doc, cursorY, 30);
      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .fillColor('#c2560c')
        .text(title, M, cursorY);
      cursorY += 20;
    }
    cursorY = drawTableHeader(doc, cursorY, pageRight);
    for (const { line, img } of secLines) {
      cursorY = ensureSpace(doc, cursorY, ROW_H);
      cursorY = drawRow(doc, cursorY, pageRight, line, img);
    }
    cursorY += 10;
  };

  if (vendor.isTaiwan) {
    const normal = lineImgs.filter((l) => l.line.classification !== 'special');
    const special = lineImgs.filter((l) => l.line.classification === 'special');
    await drawSection('NORMAL ITEMS', normal);
    await drawSection('SPECIAL ITEMS', special);
  } else {
    await drawSection(null, lineImgs);
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  cursorY = ensureSpace(doc, cursorY, 40);
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#999')
    .text('Please confirm receipt of this order and expected ship date.', M, cursorY + 10);

  doc.end();
  await new Promise<void>((res, rej) => {
    stream.on('finish', () => res());
    stream.on('error', rej);
  });
  return outPath;
}

// Draw the table header row (item / qty / unit — NO internal code column) and return the new y.
function drawTableHeader(doc: PDFKit.PDFDocument, y: number, pageRight: number): number {
  const nameX = M + IMG_W + 12;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#666');
  doc.text('IMAGE', M, y);
  doc.text('ITEM', nameX, y);
  doc.text('QTY', pageRight - 150, y, { width: 60, align: 'right' });
  doc.text('UNIT', pageRight - 70, y, { width: 70, align: 'right' });
  y += 14;
  doc.moveTo(M, y).lineTo(pageRight, y).strokeColor('#e5b98a').stroke();
  return y + 6;
}

// Draw one product row: image (or placeholder) + name + qty + unit. Returns the new y.
function drawRow(
  doc: PDFKit.PDFDocument,
  y: number,
  pageRight: number,
  line: PdfLine,
  img: Buffer | null,
): number {
  const nameX = M + IMG_W + 12;
  // Image or placeholder box.
  if (img) {
    try {
      doc.image(img, M, y, { fit: [IMG_W, IMG_H] });
    } catch {
      drawPlaceholder(doc, y);
    }
  } else {
    drawPlaceholder(doc, y);
  }
  // Text columns (vertically roughly centred against the thumbnail).
  const textY = y + 18;
  doc.font('Helvetica').fontSize(10).fillColor('#222');
  doc.text(line.realName, nameX, textY, { width: pageRight - nameX - 160 });
  doc.text(line.qty || '-', pageRight - 150, textY, { width: 60, align: 'right' });
  doc.text(line.unit || 'pcs', pageRight - 70, textY, { width: 70, align: 'right' });
  // Row separator.
  const bottom = y + ROW_H - 6;
  doc.moveTo(M, bottom).lineTo(pageRight, bottom).strokeColor('#f0e0d0').stroke();
  return y + ROW_H;
}

// A grey "no image" placeholder box in the image column.
function drawPlaceholder(doc: PDFKit.PDFDocument, y: number): void {
  doc
    .rect(M, y, IMG_W, IMG_H)
    .fillColor('#f2f2f2')
    .fill()
    .strokeColor('#cccccc')
    .rect(M, y, IMG_W, IMG_H)
    .stroke();
  doc
    .font('Helvetica')
    .fontSize(7)
    .fillColor('#999')
    .text('no image', M, y + IMG_H / 2 - 4, { width: IMG_W, align: 'center' });
}

// If fewer than `need` px remain on the page, add a page and reset y to the top margin.
function ensureSpace(doc: PDFKit.PDFDocument, y: number, need: number): number {
  const bottom = doc.page.height - M;
  if (y + need > bottom) {
    doc.addPage();
    return M;
  }
  return y;
}
