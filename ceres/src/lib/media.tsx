// Shared media-preview helper for the v2 staff-request screens (RequestSheet,
// MyRequests, NeeApprovalQueue, CeoOverview). Request rows only carry an opaque
// `requestPhotoUploadId` — never a URL — so any screen that wants to show the photo
// must resolve a short-lived signed URL first via GET /api/ceres/media/:id/url.
// The resolved URL is used only as an <img src>/<a href> target, never rendered as
// visible text.
import { useEffect, useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import { getMediaUrl } from './api';

interface MediaUrlState {
  url: string | null;
  loading: boolean;
  failed: boolean;
}

function useMediaUrlState(id: string | null | undefined): MediaUrlState {
  const [state, setState] = useState<MediaUrlState>({ url: null, loading: false, failed: false });
  useEffect(() => {
    setState({ url: null, loading: !!id, failed: false });
    if (!id) return undefined;
    let cancelled = false;
    getMediaUrl(id)
      .then((r) => {
        if (!cancelled) setState({ url: r.url, loading: false, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ url: null, loading: false, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);
  return state;
}

export function useMediaUrl(id: string | null | undefined): string | null {
  return useMediaUrlState(id).url;
}

export function MediaThumb({
  id,
  size = 56,
  alt = 'รูปแนบ',
  rounded = 'rounded-lg',
}: {
  id: string | null | undefined;
  size?: number;
  alt?: string;
  rounded?: string;
}) {
  const { url, loading, failed } = useMediaUrlState(id);
  if (!id) return null;
  if (loading) {
    return (
      <div
        style={{ width: size, height: size }}
        className={`shrink-0 ${rounded} border border-slate-200 bg-slate-50 flex items-center justify-center text-slate-300`}
      >
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }
  if (failed || !url) {
    return (
      <div
        style={{ width: size, height: size }}
        title="เปิดรูปไม่ได้"
        className={`shrink-0 ${rounded} border border-slate-200 bg-slate-50 flex items-center justify-center text-slate-300`}
      >
        <ImageOff size={17} />
      </div>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="shrink-0">
      <img src={url} alt={alt} style={{ width: size, height: size }} className={`object-cover ${rounded} border border-slate-200`} />
    </a>
  );
}
