// Native ML Kit Document Scanner bridge (Ceres Android shell, 2026-07-23).
// The Capacitor shell injects window.Capacitor into the live site; on the plain web/PWA
// this module reports unavailable and PhotoListUpload keeps the ordinary camera input.
// No @capacitor/* imports here on purpose — the web bundle carries zero native weight.

// Minimal shape of the runtime bridge the shell injects — deliberately loose (`any` for the
// plugin itself) since we only ever call a handful of methods on it and don't want a
// @capacitor/core type import pulling native code into the web bundle.
interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  convertFileSrc?: (uri: string) => string;
  Plugins?: {
    DocumentScanner?: {
      isGoogleDocumentScannerModuleAvailable?: () => Promise<{ available: boolean }>;
      installGoogleDocumentScannerModule?: () => Promise<void>;
      scanDocument: (options: {
        galleryImportAllowed: boolean;
        pageLimit: number;
        resultFormats: 'JPEG' | 'PDF' | 'JPEG_PDF';
        scannerMode: 'FULL' | 'BASE' | 'BASE_WITH_FILTER';
      }) => Promise<{ scannedImages?: string[] }>;
    };
  };
}

declare global {
  interface Window {
    Capacitor?: CapacitorBridge;
  }
}

export function nativeScannerAvailable(): boolean {
  const cap = window.Capacitor;
  return Boolean(cap?.isNativePlatform?.() && cap.Plugins?.DocumentScanner);
}

// The native plugin rejects with a plain message string on user-cancel — as of
// @capacitor-mlkit/document-scanner's Android implementation (DocumentScannerPlugin.java,
// StartIntentSenderForResult callback, non-RESULT_OK branch) that message is literally
// "Scan cancelled or failed. Result code: <code>" — so we match case-insensitively on the
// substring 'cancel' rather than pinning an exact string or a numeric code.
function isCancelledError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.toLowerCase().includes('cancel');
}

// Discriminated result so the caller can tell the user WHY the native scanner didn't run
// (module still downloading vs a real error) instead of silently opening the plain camera —
// which reads as "the Google scanner just doesn't work" during rollout.
export type NativeScanResult =
  | { status: 'ok'; files: File[] }
  | { status: 'cancelled' }
  | { status: 'module_installing' }
  | { status: 'error'; message: string };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'unknown');
}

export async function scanWithNativeScanner(pageLimit: number): Promise<NativeScanResult> {
  const plugin = window.Capacitor?.Plugins?.DocumentScanner;
  if (!plugin) return { status: 'error', message: 'bridge_no_plugin' };

  try {
    if (plugin.isGoogleDocumentScannerModuleAvailable) {
      const moduleCheck = await plugin.isGoogleDocumentScannerModuleAvailable();
      if (!moduleCheck.available) {
        // Best-effort kick-off — don't block this attempt on the (slow) module download.
        // Fire-and-forget on purpose: the next scan attempt will find the module installed.
        void plugin.installGoogleDocumentScannerModule?.();
        return { status: 'module_installing' };
      }
    }
  } catch {
    // Module-availability check itself failed — fall through and just try scanDocument;
    // some devices/plugin versions don't support the check at all.
  }

  let result: { scannedImages?: string[] };
  try {
    result = await plugin.scanDocument({
      galleryImportAllowed: false,
      pageLimit,
      resultFormats: 'JPEG',
      scannerMode: 'FULL',
    });
  } catch (err) {
    return isCancelledError(err) ? { status: 'cancelled' } : { status: 'error', message: errText(err) };
  }

  const uris = result.scannedImages ?? [];
  if (uris.length === 0) return { status: 'error', message: 'no_pages_returned' };

  const convert = window.Capacitor?.convertFileSrc;
  const files: File[] = [];
  for (let i = 0; i < uris.length; i++) {
    try {
      const src = convert?.(uris[i]) ?? uris[i];
      const response = await fetch(src);
      const blob = await response.blob();
      files.push(new File([blob], `scan-${i}.jpg`, { type: 'image/jpeg' }));
    } catch {
      // Skip just this page — a partial scan set is still useful to the user.
    }
  }
  if (files.length === 0) return { status: 'error', message: 'scan_file_read_failed' };
  return { status: 'ok', files };
}
