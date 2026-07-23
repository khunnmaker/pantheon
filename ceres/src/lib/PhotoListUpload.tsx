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
//
// Photos are EXIF-upright-corrected and downscaled before upload (see ./image.ts); nothing
// else happens to them client-side.
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera, Image as ImageIcon, Loader2, X } from 'lucide-react';
import { decodeUprightCanvas, downscaleCanvas, downscaleImage } from './image';
import { MediaThumb } from './media';
import { nativeScannerAvailable, scanWithNativeScanner } from './nativeScanner';
import type { DuplicateReceipt, OcrResult } from './api';

type UploadPayload = { dataB64: string; contentType: string };

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

  async function handleFiles(fileList: FileList | File[] | null) {
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

  // EXIF-upright-decodes then downscales the picked file for upload. Falls back to the plain
  // downscale path (best-effort orientation) if the upright decode fails for any reason.
  async function resolveUploadPayload(file: File): Promise<UploadPayload> {
    try {
      return downscaleCanvas(await decodeUprightCanvas(file));
    } catch {
      return downscaleImage(file);
    }
  }

  // Inside the Ceres Android shell (nativeScannerAvailable()), route the camera buttons
  // through ML Kit's document scanner instead of the plain <input capture> — it produces a
  // cropped, deskewed, cleaned-up page instead of a raw photo. On the plain web/PWA (or if
  // the native call comes back 'unavailable' for any reason) we fail open to the ordinary
  // camera input so the button never just does nothing.
  async function openCamera() {
    if (!nativeScannerAvailable()) {
      // TEMP diagnostic (Android-app rollout, 2026-07-23): when running inside a bare Android
      // WebView (the Ceres shell would be one; ' wv)' UA token) that ISN'T LINE's in-app
      // browser, report why the native scanner path was skipped. Remove once the app is
      // confirmed working in the field.
      const ua = navigator.userAgent;
      if (/; wv\)/.test(ua) && !/Line\//i.test(ua)) {
        const cap = (window as any).Capacitor;
        const state = !cap
          ? 'bridge=none'
          : `bridge=yes native=${String(cap.isNativePlatform?.())} plugin=${String(Boolean(cap.Plugins?.DocumentScanner))}`;
        setCapNote(`[diag] ${state}`);
      }
      cameraRef.current?.click();
      return;
    }
    const capacity = Math.max(1, max - itemsRef.current.length);
    const result = await scanWithNativeScanner(capacity);
    if (result.status === 'ok') {
      void handleFiles(result.files);
    } else if (result.status === 'module_installing') {
      setCapNote('กำลังติดตั้งตัวสแกนของ Google — ลองแตะถ่ายรูปใหม่อีกครั้งในสักครู่ ระหว่างนี้ใช้กล้องปกติได้');
      cameraRef.current?.click();
    } else if (result.status === 'error') {
      // Surface the raw reason — this only shows in the failure lane and is what makes a
      // remote "scanner didn't open" report debuggable without adb.
      setCapNote(`ตัวสแกนไม่พร้อม (${result.message.slice(0, 140)}) — ใช้กล้องปกติแทน`);
      cameraRef.current?.click();
    }
    // 'cancelled' → user backed out of the scanner; do nothing.
  }

  function onCameraChange(e: React.ChangeEvent<HTMLInputElement>) {
    void handleFiles(e.target.files);
    e.target.value = '';
  }
  function onGalleryChange(e: React.ChangeEvent<HTMLInputElement>) {
    void handleFiles(e.target.files);
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
            onClick={() => void openCamera()}
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
                onClick={() => void openCamera()}
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
    </div>
  );
}
