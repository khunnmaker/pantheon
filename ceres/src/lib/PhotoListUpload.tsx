// Shared multi-image picker/uploader (Ceres multi-photo, 2026-07-22) — replaces the four
// near-identical per-spot upload UIs that used to live in RequestSheet, ExpenseSheet,
// PayPanel and NeeFulfillmentQueue (single-image state: `xUploadId` + `xPreview`).
//
// Each image is still uploaded individually on pick (the backend transport is unchanged —
// see docs/CERES_USER_GUIDE_TH.md / the backend commit this pairs with); this component just
// lets a host accumulate MANY of them into one array before submit. The host owns the array
// state (`items`) and passes a purpose-bound upload function — RequestSheet/ExpenseSheet/
// PayPanel/Nee each already have their own uploadMedia(...)/uploadReceipt(...) call with the
// purpose baked in, so this component stays agnostic to purpose entirely.
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera, Image as ImageIcon, Loader2, ScanLine, X } from 'lucide-react';
import { decodeUprightCanvas, downscaleCanvas, downscaleImage } from './image';
import { scanDocument, warmScanLibrary } from './scan';
import { MediaThumb } from './media';
import type { DuplicateReceipt, OcrResult } from './api';

type UploadPayload = { dataB64: string; contentType: string };
type PreviewChoice = 'scanned' | 'original' | 'retake';
type PickSource = 'camera' | 'gallery';
// 'pending' — scan still running, only the original is known yet.
// 'found' — a document candidate was located; scannedUrl is populated.
// 'not_found' — scan finished (or timed out / OpenCV unavailable) with nothing plausible.
type ScanStatus = 'pending' | 'found' | 'not_found';

function payloadToDataUrl(payload: UploadPayload): string {
  return `data:${payload.contentType};base64,${payload.dataB64}`;
}

export interface PhotoItem {
  // Real uploaded media id once done; a synthetic `__busy_*` placeholder id while the file
  // is still uploading (never sent to the server — filtered out by every host before submit
  // since only `!item.busy` items exist by then, but callers should defensively map only
  // real ids too).
  uploadId: string;
  // Local data-URL preview for a JUST-uploaded file (skips the signed-URL round trip
  // MediaThumb would otherwise do). Absent for a pre-existing saved image seeded from a
  // server row on edit — those render via MediaThumb-by-id instead.
  preview?: string;
  duplicate?: DuplicateReceipt | null;
  busy?: boolean;
}

export type PhotoUploadResult = { uploadId: string; url: string; ocr: OcrResult; duplicate: DuplicateReceipt | null };
// Purpose already bound by the host, e.g. (dataB64, contentType) => uploadMedia(dataB64, contentType, 'request_photo').
export type PhotoUploadFn = (dataB64: string, contentType: string) => Promise<PhotoUploadResult>;

const THUMB_SIZE = 80;

export default function PhotoListUpload({
  items,
  onChange,
  upload,
  max = 10,
  onOcr,
  compact = false,
}: {
  items: PhotoItem[];
  onChange: (items: PhotoItem[]) => void;
  upload: PhotoUploadFn;
  max?: number;
  // Fired once per successfully uploaded file, in pick order — hosts that prefill an amount
  // from OCR guard it themselves (only the FIRST hit, only while the field is still empty).
  onOcr?: (ocr: OcrResult) => void;
  // Smaller empty-state tap targets (80px) for the PayPanel/Nee evidence-upload contexts,
  // vs the taller 96px boxes RequestSheet/ExpenseSheet use as their primary photo step.
  compact?: boolean;
}) {
  const [error, setError] = useState('');
  const [capNote, setCapNote] = useState('');
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const busySeq = useRef(0);
  // Kept in sync with the `items` prop so a fresh handleFiles() call always starts from the
  // latest committed list, even across two separate pick events in quick succession.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Scan-preview overlay (Ceres in-page "scan mode", 2026-07-22). Warms the ~8MB OpenCV.js
  // chunk as soon as a sheet with a photo step mounts, so it's usually already resolved by
  // the time a photo is actually picked — see scan.ts for the fail-open contract.
  useEffect(() => {
    void warmScanLibrary();
  }, []);
  const [preview, setPreview] = useState<{
    token: number;
    originalUrl: string;
    scannedUrl: string | null;
    status: ScanStatus;
  } | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const previewResolveRef = useRef<((choice: PreviewChoice) => void) | null>(null);
  // Bumped once per opened preview so a scan that resolves late — after the user already
  // accepted/retook, or after a newer photo's preview replaced this one — can tell it no
  // longer owns the open overlay and must not mutate it (or reopen a closed one).
  const previewTokenRef = useRef(0);

  // Opens the overlay right away showing the (already EXIF-upright) original, before the
  // scan attempt has resolved. Returns the token this session owns (for guarding the async
  // scan result below) plus a promise that settles when the user taps a button.
  function openPreview(originalUrl: string): { token: number; choice: Promise<PreviewChoice> } {
    const token = ++previewTokenRef.current;
    setShowOriginal(false);
    setPreview({ token, originalUrl, scannedUrl: null, status: 'pending' });
    const choice = new Promise<PreviewChoice>((resolve) => {
      previewResolveRef.current = resolve;
    });
    return { token, choice };
  }
  // Applies a (possibly late) scan result to the preview it belongs to. No-op if that
  // preview was already closed (user chose) or superseded by a later photo's preview.
  function applyScanResult(token: number, scannedUrl: string | null) {
    setPreview((prev) => {
      if (!prev || prev.token !== token) return prev;
      return { ...prev, status: scannedUrl ? 'found' : 'not_found', scannedUrl };
    });
  }
  function choosePreview(choice: PreviewChoice) {
    setPreview(null);
    const resolve = previewResolveRef.current;
    previewResolveRef.current = null;
    resolve?.(choice);
  }

  async function handleFiles(fileList: FileList | null, source: PickSource) {
    if (!fileList || fileList.length === 0) return;
    setError('');
    setCapNote('');
    const files = Array.from(fileList);
    const capacity = Math.max(0, max - itemsRef.current.length);
    if (files.length > capacity) setCapNote(`ได้สูงสุด ${max} รูป`);
    const toProcess = files.slice(0, capacity);

    // Sequential, on purpose — mirrors the old single-file flow per upload (downscale then
    // await the server round trip) and keeps OCR/duplicate results attributable per file.
    // Every mutation derives from itemsRef.current (NOT a loop-local snapshot): the user can
    // ✕-remove an already-uploaded thumb while a later file is still uploading, and a stale
    // snapshot would resurrect the removed item when the in-flight upload lands.
    for (const file of toProcess) {
      const tempId = `__busy_${Date.now()}_${busySeq.current++}`;
      const withBusy = [...itemsRef.current, { uploadId: tempId, busy: true }];
      itemsRef.current = withBusy;
      onChange(withBusy);
      try {
        const payload = await resolveUploadPayload(file);
        if (!payload) {
          // "ถ่ายใหม่" — drop this file's busy placeholder and re-open the same input the
          // user picked from; the rest of this batch (if any) is abandoned on purpose so a
          // retake never races with still-queued files from the same pick.
          const cleaned = itemsRef.current.filter((it) => it.uploadId !== tempId);
          itemsRef.current = cleaned;
          onChange(cleaned);
          (source === 'camera' ? cameraRef : galleryRef).current?.click();
          return;
        }
        const { dataB64, contentType } = payload;
        const result = await upload(dataB64, contentType);
        const previewUrl = `data:${contentType};base64,${dataB64}`;
        const resolved = itemsRef.current.map((it) =>
          it.uploadId === tempId
            ? { uploadId: result.uploadId, preview: previewUrl, duplicate: result.duplicate, busy: false }
            : it,
        );
        itemsRef.current = resolved;
        onChange(resolved);
        if (onOcr && result.ocr) onOcr(result.ocr);
      } catch {
        const cleaned = itemsRef.current.filter((it) => it.uploadId !== tempId);
        itemsRef.current = cleaned;
        onChange(cleaned);
        setError('อัปโหลดรูปไม่สำเร็จ ลองใหม่อีกครั้ง');
      }
    }
  }

  // Opens the preview for one picked file immediately (EXIF-upright original), runs the scan
  // attempt concurrently, and returns the payload to upload — or null if the user chose to
  // retake. Fails open at every stage: any scan failure/timeout/no-document-found just keeps
  // the original showing (with a muted note) rather than blocking or losing the photo — see
  // scan.ts's contract. The user may accept before the scan settles at all; the late scan
  // result is guarded by `token` so it can never mutate a preview that's since closed or been
  // replaced by a later photo in the same batch.
  async function resolveUploadPayload(file: File): Promise<UploadPayload | null> {
    let original: HTMLCanvasElement;
    try {
      original = await decodeUprightCanvas(file);
    } catch {
      // Couldn't even decode the photo — total fallback, no preview at all, identical to the
      // pre-scan-feature path.
      return downscaleImage(file);
    }

    const originalPayload = downscaleCanvas(original);
    const { token, choice } = openPreview(payloadToDataUrl(originalPayload));

    let scannedPayload: UploadPayload | null = null;
    // Fire-and-forget: never awaited by the button flow below, so the user can accept the
    // original at any time without waiting on this. Fail-open — scanDocument never throws
    // per its own contract, but the .catch is defensive against that contract changing.
    void scanDocument(file)
      .catch(() => null)
      .then((outcome) => {
        const found = outcome?.scanned ?? null;
        scannedPayload = found ? downscaleCanvas(found) : null;
        applyScanResult(token, scannedPayload ? payloadToDataUrl(scannedPayload) : null);
      });

    const picked = await choice;
    if (picked === 'retake') return null;
    if (picked === 'scanned' && scannedPayload) return scannedPayload;
    return originalPayload;
  }

  function onCameraChange(e: React.ChangeEvent<HTMLInputElement>) {
    void handleFiles(e.target.files, 'camera');
    e.target.value = '';
  }
  function onGalleryChange(e: React.ChangeEvent<HTMLInputElement>) {
    void handleFiles(e.target.files, 'gallery');
    e.target.value = '';
  }
  function removeAt(uploadId: string) {
    // Route through itemsRef (same as handleFiles) so a ✕ tap fired from a not-yet-re-rendered
    // list can't drop a busy placeholder that was appended in the same tick.
    const next = itemsRef.current.filter((it) => it.uploadId !== uploadId);
    itemsRef.current = next;
    onChange(next);
  }

  const emptyH = compact ? 80 : 96;
  const anyBusy = items.some((it) => it.busy);

  return (
    <div>
      {items.length === 0 ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => cameraRef.current?.click()}
            style={{ minHeight: emptyH }}
            className="flex-1 rounded-xl border-2 border-dashed border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 font-semibold flex flex-col items-center justify-center gap-1.5"
          >
            <Camera size={compact ? 20 : 24} />
            <span className={compact ? 'text-xs' : 'text-sm'}>ถ่ายรูป</span>
          </button>
          <button
            type="button"
            onClick={() => galleryRef.current?.click()}
            style={{ minHeight: emptyH }}
            className="flex-1 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-600 font-medium flex flex-col items-center justify-center gap-1.5"
          >
            <ImageIcon size={compact ? 20 : 24} />
            <span className={compact ? 'text-xs' : 'text-sm'}>เลือกรูป</span>
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {items.map((item) => (
              <div key={item.uploadId} className="relative shrink-0" style={{ width: THUMB_SIZE, height: THUMB_SIZE }}>
                {item.busy ? (
                  <div
                    style={{ width: THUMB_SIZE, height: THUMB_SIZE }}
                    className="rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-center text-slate-300"
                  >
                    <Loader2 className="animate-spin" size={18} />
                  </div>
                ) : item.preview ? (
                  <img
                    src={item.preview}
                    alt="รูปแนบ"
                    style={{ width: THUMB_SIZE, height: THUMB_SIZE }}
                    className="object-cover rounded-lg border border-slate-200"
                  />
                ) : (
                  <MediaThumb id={item.uploadId} size={THUMB_SIZE} />
                )}
                {!item.busy && (
                  <button
                    type="button"
                    onClick={() => removeAt(item.uploadId)}
                    aria-label="ลบรูป"
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-slate-700 text-white flex items-center justify-center shadow"
                  >
                    <X size={12} />
                  </button>
                )}
                {item.duplicate && (
                  <div
                    title={`ใบเสร็จซ้ำ: ${item.duplicate.partyName} ฿${item.duplicate.amount}`}
                    className="absolute bottom-0 left-0 right-0 bg-rose-600/90 text-white text-[9px] font-semibold text-center leading-tight py-0.5 rounded-b-lg"
                  >
                    ใบเสร็จซ้ำ
                  </div>
                )}
              </div>
            ))}
          </div>
          {items.length < max && (
            <div className="flex gap-2 mt-2.5">
              <button
                type="button"
                onClick={() => cameraRef.current?.click()}
                disabled={anyBusy}
                className="flex-1 min-h-[40px] rounded-lg border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 text-xs font-medium disabled:opacity-50"
              >
                ถ่ายเพิ่ม
              </button>
              <button
                type="button"
                onClick={() => galleryRef.current?.click()}
                disabled={anyBusy}
                className="flex-1 min-h-[40px] rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-600 text-xs font-medium disabled:opacity-50"
              >
                เลือกเพิ่ม
              </button>
            </div>
          )}
        </>
      )}

      {/* Camera: single shot per tap (no `multiple` — mobile cameras only ever return one
          file per invocation regardless); re-tapping "ถ่ายเพิ่ม" is how multiple camera shots
          accumulate. Gallery: `multiple` so one picker trip can select several at once. */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onCameraChange} />
      <input ref={galleryRef} type="file" accept="image/*" multiple className="hidden" onChange={onGalleryChange} />

      {capNote && <div className="text-xs text-amber-700 mt-1.5">{capNote}</div>}
      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-xs mt-1.5">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      {/* Scan preview overlay — opens for EVERY photo as soon as it's picked (showing the
          EXIF-upright original immediately), so "scan didn't find anything" is always
          visibly distinct from "nothing happened". The scan attempt runs concurrently; see
          resolveUploadPayload for the pending/found/not_found state machine and the token
          guard against late results. Above the sheet's own z-50 so it reads as a step on top
          of the open sheet, not a competing layer. */}
      {preview && (
        <div className="fixed inset-0 z-[60] bg-slate-900/60 flex items-end sm:items-center justify-center p-3">
          <div className="w-full sm:max-w-sm bg-white rounded-2xl overflow-hidden shadow-xl">
            <div className="px-4 pt-3.5 pb-1 flex items-center gap-1.5 text-sm font-semibold text-slate-700">
              <ScanLine size={16} className="text-amber-600" />
              ตรวจสอบรูปที่สแกน
            </div>
            <div className="px-4 pt-1.5 pb-2">
              <img
                src={showOriginal || preview.status !== 'found' ? preview.originalUrl : preview.scannedUrl!}
                alt="ตัวอย่างรูปที่สแกน"
                className="w-full max-h-[52vh] object-contain rounded-xl border border-slate-200 bg-slate-50"
              />
              {preview.status === 'pending' && (
                <div className="mt-2 flex items-center justify-center gap-1.5 text-xs text-slate-400">
                  <Loader2 className="animate-spin" size={12} />
                  กำลังปรับรูปแบบสแกน…
                </div>
              )}
              {preview.status === 'not_found' && (
                <div className="mt-2 text-center text-xs text-slate-400">หาขอบเอกสารไม่เจอ — ใช้รูปเดิมได้เลย</div>
              )}
              {preview.status === 'found' && (
                <button
                  type="button"
                  onClick={() => setShowOriginal((v) => !v)}
                  className="mt-2 w-full text-center text-xs text-amber-700 underline underline-offset-2"
                >
                  {showOriginal ? 'ดูรูปที่ปรับแล้ว' : 'เทียบกับรูปเดิม'}
                </button>
              )}
            </div>
            <div className="p-3.5 pt-1 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => choosePreview(preview.status === 'found' && !showOriginal ? 'scanned' : 'original')}
                className="min-h-[48px] rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-semibold text-sm"
              >
                ใช้รูปนี้
              </button>
              <div className="grid grid-cols-2 gap-2">
                {preview.status === 'found' && (
                  <button
                    type="button"
                    onClick={() => choosePreview('original')}
                    className="min-h-[44px] rounded-xl border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50"
                  >
                    ใช้รูปเดิม
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => choosePreview('retake')}
                  className={`min-h-[44px] rounded-xl border border-rose-300 text-rose-700 text-sm font-medium hover:bg-rose-50 ${
                    preview.status === 'found' ? '' : 'col-span-2'
                  }`}
                >
                  ถ่ายใหม่
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
