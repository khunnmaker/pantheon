// Minerva OA Read Sync — service worker (MV3 background).
//
// Receives {type:'oa-sync', payload} from the content script, reads {apiUrl, token} from
// chrome.storage.local (written by the popup at login), and POSTs the payload to
// `${apiUrl}/api/oa-sync` with a Bearer token. On 401 it sets a `needsLogin` flag so the popup
// can prompt a re-login. It de-dupes identical consecutive payloads per oaChatId in memory.
//
// Also receives {type:'oa-open', url} from minerva-bridge.js (running on the Minerva console
// origin) when staff open a customer there, and — if a background chat.line.biz tab exists —
// silently retargets it to that customer's OA chat so the passive read-sync above fires without
// staff hunting for the chat manually. See handleOaOpen() below for the safety rules.
//
// It NEVER stores LINE credentials and NEVER handles message content (the payload has none).

'use strict';

// In-memory last-posted payload per oaChatId (best-effort; resets when the worker sleeps).
const lastPosted = {};

async function postSync(payload) {
  let cfg;
  try {
    cfg = await chrome.storage.local.get({ apiUrl: '', token: '', enabled: true });
  } catch (_e) {
    return;
  }
  if (!cfg || cfg.enabled === false) return;
  if (!cfg.apiUrl || !cfg.token) return; // not logged in yet

  const key = payload.oaChatId;
  const serialized = JSON.stringify(payload);
  if (lastPosted[key] === serialized) return; // identical to last POST — skip

  const url = cfg.apiUrl.replace(/\/+$/, '') + '/api/oa-sync';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.token,
      },
      body: serialized,
    });
    if (res.status === 401) {
      // token expired / revoked — flag for the popup, and stop treating this as posted.
      try { await chrome.storage.local.set({ needsLogin: true }); } catch (_e) { /* ignore */ }
      return;
    }
    if (res.ok) {
      lastPosted[key] = serialized;
      try { await chrome.storage.local.set({ needsLogin: false }); } catch (_e) { /* ignore */ }
    }
    // Other non-OK statuses: leave lastPosted unset so the next change retries.
  } catch (_e) {
    // network error — swallow; a later mutation will retry.
  }
}

// --- oa-open: auto-navigate a background chat.line.biz tab when a customer opens in Minerva ---
//
// Triggered only by minerva-bridge.js (a passive relay on the Minerva console origin). The URL
// shape is re-validated here regardless of what the relay already checked, so a compromised or
// buggy page can never make this worker navigate a tab to an arbitrary URL. It will NEVER steal
// focus (no `active: true`) and NEVER open a new tab — if every chat.line.biz tab is the user's
// active tab, or none exists, it does nothing. No URLs are ever logged.
const OA_CHAT_URL_RE = /^https:\/\/chat\.line\.biz\/[0-9A-Za-z@._-]+\/chat\/U[0-9a-f]{32}$/;
const OPEN_URL_COOLDOWN_MS = 60_000; // per-URL: don't re-navigate the same chat too often
const OPEN_GLOBAL_COOLDOWN_MS = 4_000; // global: avoid rapid-fire tab navigations
const lastOpenedByUrl = {}; // in-memory; resets when the worker sleeps (acceptable)
let lastOpenAt = 0;

async function handleOaOpen(url) {
  try {
    if (typeof url !== 'string' || !OA_CHAT_URL_RE.test(url)) return;

    let cfg;
    try {
      cfg = await chrome.storage.local.get({ enabled: true, autoOpen: true });
    } catch (_e) {
      return;
    }
    if (!cfg || cfg.enabled === false || cfg.autoOpen === false) return;

    const nowTs = Date.now();
    if (nowTs - lastOpenAt < OPEN_GLOBAL_COOLDOWN_MS) return;
    if (lastOpenedByUrl[url] && nowTs - lastOpenedByUrl[url] < OPEN_URL_COOLDOWN_MS) return;

    const tabs = await chrome.tabs.query({ url: 'https://chat.line.biz/*' });
    const target = tabs.find((t) => t.active === false);
    if (!target) return; // no background OA tab — never hijack a focused tab, never open a new one

    await chrome.tabs.update(target.id, { url });
    lastOpenAt = nowTs;
    lastOpenedByUrl[url] = nowTs;
  } catch (_e) {
    // swallow — a missed auto-open just means the next chat-open won't fast-path
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'oa-sync' && msg.payload && msg.payload.oaChatId) {
    postSync(msg.payload).finally(() => {
      try { sendResponse({ ok: true }); } catch (_e) { /* channel may be closed */ }
    });
    return true; // keep the message channel open for the async response
  }
  if (msg && msg.type === 'oa-open' && typeof msg.url === 'string') {
    handleOaOpen(msg.url).finally(() => {
      try { sendResponse({ ok: true }); } catch (_e) { /* channel may be closed */ }
    });
    return true; // keep the message channel open for the async response
  }
  return false;
});
