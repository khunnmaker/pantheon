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

  // Best-effort header title + real-LINE-name subtitle. Anchors verified against the live
  // chat.line.biz DOM (2026-07-07): the open chat's title is an <h4> in the chat-pane header
  // (div.p-2.border-bottom); the customer's REAL LINE display name sits in the right profile
  // panel as `div.h5 span.text-truncate` (shown as "(name)" — the parens are separate nodes,
  // the span holds just the name). NOTE: the page has NO h1/h2 and document.title is a static
  // "LINE Chat", so those older heuristics found nothing — kept only as last-resort fallbacks.
  // Emoji in names are rendered as <img>, so textContent comes back emoji-less; the server
  // matcher compensates with an emoji-insensitive comparison.
  function readHeaderNames() {
    let oaTitle;
    let oaSubName;
    try {
      // 1) Chat-pane header title (the OA-assigned name, e.g. "น.อ.หญิงกานดา ก323").
      const h4 =
        document.querySelector('div.p-2.border-bottom h4') ||
        document.querySelector('h4.mb-0.text-truncate') ||
        document.querySelector('h4.text-truncate');
      const ht = h4 ? (h4.textContent || '').trim() : '';
      if (ht && ht.length <= 120) oaTitle = ht;

      // 2) Profile-panel real LINE name (the "(name)" under the title; span holds just the name).
      const sub = document.querySelector('div.h5 span.text-truncate');
      const st = sub ? (sub.textContent || '').trim() : '';
      if (st && st.length <= 120 && st !== oaTitle) oaSubName = st;

      // 3) Last-resort fallbacks (older heuristics; harmless when they find nothing).
      if (!oaTitle) {
        const prof = document.querySelector('h3 span.user-select-text, h3.h4 span');
        const pt = prof ? (prof.textContent || '').trim() : '';
        if (pt && pt.length <= 120) oaTitle = pt;
      }
      if (!oaTitle) {
        const dt = (document.title || '').split('|')[0].trim();
        if (dt && !/^LINE/i.test(dt)) oaTitle = dt;
      }
      // Parenthesized subname embedded in the title text, e.g. "ชื่อ (kanda)".
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

  // --- one-click SWEEP (started/stopped from the popup) -------------------------------------
  // Walks the chat list top→bottom, opening each chat once at a human pace (~5–7s) so the
  // passive sync above captures every customer. Same logic as the proven console script:
  // rows are <a href="#"> found by their <h6> title; progress tracked by URL after each click.
  // Progress is mirrored to chrome.storage.local.sweep so the popup can display it live.
  let sweepRunning = false;
  let sweepStopFlag = false;

  const sweepReport = (patch) => {
    try { chrome.storage.local.set({ sweep: { running: sweepRunning, at: Date.now(), ...patch } }); } catch (_e) { /* ignore */ }
  };

  async function runSweep() {
    if (sweepRunning) return;
    sweepRunning = true;
    sweepStopFlag = false;

    const WAIT_MS = 5500;
    const JITTER_MS = 1500;
    const MAX_CHATS = 1000;
    const MAX_IDLE_SCROLLS = 8;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const clickedKeys = new Set();
    const visitedPaths = new Set();
    let idleScrolls = 0;

    const rows = () =>
      Array.from(document.querySelectorAll('a'))
        .filter((a) => a.querySelector('h6') && a.offsetParent !== null)
        .sort((x, y) => x.getBoundingClientRect().top - y.getBoundingClientRect().top);
    const keyOf = (a) => (a.textContent || '').replace(/\s+/g, ' ').trim();
    const scroller = () => {
      let el = (rows()[0] || {}).parentElement;
      while (el && el.scrollHeight <= el.clientHeight + 10) el = el.parentElement;
      return el;
    };

    sweepReport({ opened: 0, done: false });
    try {
      while (!sweepStopFlag && visitedPaths.size < MAX_CHATS) {
        const next = rows().find((a) => !clickedKeys.has(keyOf(a)));
        if (next) {
          idleScrolls = 0;
          clickedKeys.add(keyOf(next));
          next.click();
          await sleep(1200);
          if (location.pathname.includes('/chat/')) visitedPaths.add(location.pathname);
          sweepReport({ opened: visitedPaths.size, done: false });
          await sleep(WAIT_MS - 1200 + Math.random() * JITTER_MS);
        } else {
          const sc = scroller();
          if (!sc || idleScrolls >= MAX_IDLE_SCROLLS) break;
          sc.scrollTop += sc.clientHeight * 0.8;
          idleScrolls++;
          await sleep(1500);
        }
      }
    } catch (_e) {
      // a redesign mid-run degrades to "sweep ends early" — never breaks the page
    }
    sweepRunning = false;
    sweepReport({ opened: visitedPaths.size, done: true });
  }

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === 'sweep-start') {
        void runSweep();
        try { sendResponse({ ok: true, running: true }); } catch (_e) { /* ignore */ }
        return false;
      }
      if (msg && msg.type === 'sweep-stop') {
        sweepStopFlag = true;
        try { sendResponse({ ok: true, running: false }); } catch (_e) { /* ignore */ }
        return false;
      }
      return false;
    });
  } catch (_e) {
    // messaging unavailable — sweep just won't be startable from the popup
  }

  // First pass shortly after load.
  schedule();
})();
