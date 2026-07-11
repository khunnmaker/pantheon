// Minerva OA Read Sync — minerva-bridge.
//
// Runs on the Minerva console origin. It is a passive relay ONLY: it listens for same-origin
// window messages and forwards EXACTLY ONE message shape ({type:'minerva-oa-open', url}) to the
// background worker as {type:'oa-open', url}. It never reads page content, never reads DOM,
// never handles credentials, and forwards nothing else — the background worker independently
// re-validates the URL shape before acting on it.

(function () {
  'use strict';

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.type !== 'minerva-oa-open' || typeof d.url !== 'string') return;
    try { chrome.runtime.sendMessage({ type: 'oa-open', url: d.url }); } catch (_e) { /* worker asleep — drop */ }
  });
})();
