// "ติดตั้งแอป Ceres" suggestion strip (owner ask, 2026-07-23): nudges Android WEB users
// toward the native app, whose ML Kit document scanner the browser can't provide.
//
// Shown only when ALL hold:
//   - Android user agent (iOS has no app — never tease it),
//   - NOT inside the Ceres shell itself (the shell appends 'CeresApp' to its UA,
//     see ceres/capacitor.config.ts),
//   - not previously dismissed on this device (localStorage flag).
// The APK is served by this same site (ceres/public/Ceres.apk → /Ceres.apk), so the button
// always hands out the currently deployed build — no Drive link to rot. When a new APK ships
// from the ceres-android.yml workflow, refresh ceres/public/Ceres.apk alongside it.
import { useState } from 'react';
import { Smartphone, X } from 'lucide-react';

const DISMISS_KEY = 'ceres_install_banner_dismissed';

function shouldShow(): boolean {
  try {
    const ua = navigator.userAgent;
    if (!/Android/i.test(ua)) return false;
    if (/CeresApp/.test(ua)) return false;
    if (localStorage.getItem(DISMISS_KEY) === '1') return false;
    return true;
  } catch {
    return false;
  }
}

export default function InstallAppBanner() {
  const [visible, setVisible] = useState(shouldShow);
  if (!visible) return null;

  function dismiss() {
    setVisible(false);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Storage unavailable — banner just returns next load.
    }
  }

  return (
    <div className="bg-amber-600 text-white px-3 py-2 flex items-center gap-2 text-xs">
      <Smartphone size={16} className="shrink-0" />
      <span className="flex-1 leading-snug">
        ติดตั้งแอป Ceres — ถ่ายใบเสร็จคมชัดขึ้นด้วยตัวสแกนเอกสารของ Google
      </span>
      <a
        href="/Ceres.apk"
        download
        className="shrink-0 rounded-lg bg-white text-amber-700 font-semibold px-2.5 py-1"
      >
        ติดตั้ง
      </a>
      <button type="button" onClick={dismiss} aria-label="ปิด" className="shrink-0 p-1 text-amber-100 hover:text-white">
        <X size={14} />
      </button>
    </div>
  );
}
