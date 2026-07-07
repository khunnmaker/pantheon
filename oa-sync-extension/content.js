// Minerva OA Read Sync — content script (passive DOM reader).
//
// Runs on https://chat.line.biz/* in the staff member's OWN logged-in browser. It NEVER calls
// LINE's private APIs and NEVER reads message bodies — it only observes, for the chat that is
// currently OPEN: the OA-native chat id (from the URL), the header title + any parenthesized
// subtitle (best-effort, defensive), and the last "Read"/"อ่านแล้ว" marker near the OA's own
// bubbles. It posts {oaChatId, oaTitle, oaSubName, readLabel} to the background worker, which
// forwards it to Minerva. Everything is wrapped in try/catch so a LINE redesign degrades to
// "does nothing" rather than throwing.

(function () {
  'use strict';

  const CHAT_RE = /\/chat\/(U[0-9a-f]{32})/;
  const MARKER_RE = /^(Read|อ่านแล้ว)$/;
  const TIME_RE = /^\d{1,2}:\d{2}$/;

  // Last payload we SENT per oaChatId, so we only message the worker on a real change.
  const lastSentByChat = {};

  function currentChatId() {
    try {
      const m = location.pathname.match(CHAT_RE);
      return m ? m[1] : null;
    } catch (_e) {
      return null;
    }
  }

  // Best-effort header title + parenthesized subtitle. chat.line.biz is an SPA; document.title
  // usually holds the open chat partner's name. We also probe a few defensive, text-based
  // selectors for the header region and pull "(subname)" out of the nearest heading text.
  function readHeaderNames() {
    let oaTitle;
    let oaSubName;
    try {
      // document.title is typically "<partner name> | LINE Official Account" — take the head part.
      const dt = (document.title || '').split('|')[0].trim();
      if (dt && !/^LINE/i.test(dt)) oaTitle = dt;

      // Probe likely header text nodes (defensive: try several, ignore failures). We look at the
      // top-of-page headings and take the first short, non-empty one as a fallback/refinement.
      const candidates = Array.from(
        document.querySelectorAll('header h1, header h2, [class*="Header"] h1, [class*="header"] h2, h1, h2')
      );
      for (const el of candidates) {
        const t = (el.textContent || '').trim();
        if (t && t.length <= 120) {
          if (!oaTitle) oaTitle = t;
          // A parenthesized display name near the header, e.g. "น.อ.หญิงกานดา ก323 (kanda)".
          const paren = t.match(/[（(]\s*([^（()）]{1,80}?)\s*[）)]/);
          if (paren && paren[1].trim()) {
            oaSubName = paren[1].trim();
            // Strip the "(...)" from the title so oaTitle is just the OA-assigned name.
            oaTitle = t.replace(/[（(][^（()）]*[）)]/g, '').trim() || oaTitle;
          }
          break;
        }
      }
      // Also check the title itself for a parenthesized subname if not found above.
      if (!oaSubName && oaTitle) {
        const paren = oaTitle.match(/[（(]\s*([^（()）]{1,80}?)\s*[）)]/);
        if (paren && paren[1].trim()) {
          oaSubName = paren[1].trim();
          oaTitle = oaTitle.replace(/[（(][^（()）]*[）)]/g, '').trim();
        }
      }
    } catch (_e) {
      // ignore — names are best-effort
    }
    return { oaTitle: oaTitle || undefined, oaSubName: oaSubName || undefined };
  }

  // Scan the whole page for the LAST element whose trimmed text is exactly "Read"/"อ่านแล้ว",
  // then look for a nearby HH:MM time to append. Text-based, so it survives class renames.
  function readMarker() {
    try {
      const all = document.querySelectorAll('span, div, p, time');
      let marker = null;
      for (const el of all) {
        // Only leaf-ish nodes: avoid huge containers whose text merely contains "Read".
        if (el.children.length > 0) continue;
        const t = (el.textContent || '').trim();
        if (MARKER_RE.test(t)) marker = el; // keep the last match in document order
      }
      if (!marker) return undefined;
      const markerText = (marker.textContent || '').trim();

      // Find a nearby time: check siblings of the marker and of its parent.
      const near = [];
      if (marker.parentElement) {
        near.push(...marker.parentElement.children);
        if (marker.parentElement.parentElement) near.push(...marker.parentElement.parentElement.children);
      }
      let time = '';
      for (const el of near) {
        if (el === marker) continue;
        if (el.children && el.children.length > 0) continue;
        const t = (el.textContent || '').trim();
        if (TIME_RE.test(t)) { time = t; break; }
      }
      return time ? `${markerText} ${time}` : markerText;
    } catch (_e) {
      return undefined;
    }
  }

  function collect() {
    const oaChatId = currentChatId();
    if (!oaChatId) return null;
    const { oaTitle, oaSubName } = readHeaderNames();
    const readLabel = readMarker();
    const payload = { oaChatId };
    if (oaTitle) payload.oaTitle = oaTitle;
    if (oaSubName) payload.oaSubName = oaSubName;
    if (readLabel) payload.readLabel = readLabel;
    return payload;
  }

  function maybeSync() {
    let payload;
    try {
      payload = collect();
    } catch (_e) {
      return;
    }
    if (!payload) return;
    const key = payload.oaChatId;
    const serialized = JSON.stringify(payload);
    if (lastSentByChat[key] === serialized) return; // unchanged — skip

    // Respect the master on/off toggle stored by the popup (default ON if unset).
    try {
      chrome.storage.local.get({ enabled: true }, (cfg) => {
        if (!cfg || cfg.enabled === false) return;
        lastSentByChat[key] = serialized;
        try {
          chrome.runtime.sendMessage({ type: 'oa-sync', payload });
        } catch (_e) {
          // worker may be asleep/reloading — the next mutation will retry
          delete lastSentByChat[key];
        }
      });
    } catch (_e) {
      // storage unavailable — ignore this tick
    }
  }

  // Debounced observer: recompute at most once per DEBOUNCE ms after DOM churn settles.
  let timer = null;
  const DEBOUNCE = 2000;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(maybeSync, DEBOUNCE);
  }

  try {
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
  } catch (_e) {
    // no body yet / observer unsupported — the interval below still covers SPA nav
  }

  // SPA route changes may not touch document.body much; poll the pathname every second and
  // trigger a recompute when the open chat changes.
  let lastPath = location.pathname;
  setInterval(() => {
    try {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        schedule();
      }
    } catch (_e) {
      // ignore
    }
  }, 1000);

  // First pass shortly after load.
  schedule();
})();
