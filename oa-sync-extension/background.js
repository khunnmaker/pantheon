// Minerva OA Read Sync — service worker (MV3 background).
//
// Receives {type:'oa-sync', payload} from the content script, reads {apiUrl, token} from
// chrome.storage.local (written by the popup at login), and POSTs the payload to
// `${apiUrl}/api/oa-sync` with a Bearer token. On 401 it sets a `needsLogin` flag so the popup
// can prompt a re-login. It de-dupes identical consecutive payloads per oaChatId in memory.
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'oa-sync' && msg.payload && msg.payload.oaChatId) {
    postSync(msg.payload).finally(() => {
      try { sendResponse({ ok: true }); } catch (_e) { /* channel may be closed */ }
    });
    return true; // keep the message channel open for the async response
  }
  return false;
});
