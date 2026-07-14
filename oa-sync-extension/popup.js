// Minerva OA Read Sync — popup UI.
//
// Login: the email + password are POSTed straight to Minerva's existing /api/auth/login and are
// NEVER stored — only the returned JWT (token) is saved in chrome.storage.local, alongside the
// apiUrl, the agent's display name, and the on/off `enabled` flag. Logout clears the token.

'use strict';

const $ = (id) => document.getElementById(id);
// The api's custom domain (the Railway URL still works as an alias for older setups).
const DEFAULT_API = 'https://api.prominentdental.com';

function show(view) {
  $('loginView').style.display = view === 'login' ? 'block' : 'none';
  $('sessionView').style.display = view === 'session' ? 'block' : 'none';
}

function setMsg(el, text, kind) {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

async function render() {
  const cfg = await chrome.storage.local.get({
    apiUrl: DEFAULT_API,
    token: '',
    agentName: '',
    enabled: true,
    autoOpen: true,
    needsLogin: false,
  });
  $('apiUrl').value = cfg.apiUrl || DEFAULT_API;
  // An expired session (needsLogin, or token cleared by the worker after a 401) drops the
  // popup STRAIGHT to the login form with a clear message — never a logged-in-looking view.
  if (cfg.token && !cfg.needsLogin) {
    $('agentName').textContent = cfg.agentName || '(บัญชี Minerva)';
    $('enabledToggle').checked = cfg.enabled !== false;
    $('autoOpenToggle').checked = cfg.autoOpen !== false;
    setMsg($('sessionMsg'), '', '');
    show('session');
  } else {
    if (cfg.needsLogin) setMsg($('loginMsg'), 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 'err');
    show('login');
  }
}

async function doLogin() {
  const apiUrl = ($('apiUrl').value || DEFAULT_API).trim().replace(/\/+$/, '');
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!email || !password) {
    setMsg($('loginMsg'), 'กรุณากรอกอีเมลและรหัสผ่าน', 'err');
    return;
  }
  setMsg($('loginMsg'), 'กำลังเข้าสู่ระบบ…', '');
  $('loginBtn').disabled = true;
  try {
    const res = await fetch(apiUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      setMsg($('loginMsg'), res.status === 401 ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : ('เข้าสู่ระบบไม่สำเร็จ (' + res.status + ')'), 'err');
      return;
    }
    const data = await res.json();
    if (!data || !data.token) {
      setMsg($('loginMsg'), 'ไม่ได้รับ token จากเซิร์ฟเวอร์', 'err');
      return;
    }
    // Exchange the 12h console login for a long-lived (~180d), sync-only token so the background
    // sync doesn't die daily. Best-effort: if the endpoint is missing/old, keep the login token
    // (still works, just expires in 12h). The password is never stored either way.
    let token = data.token;
    try {
      const ex = await fetch(apiUrl + '/api/oa-sync/token', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + data.token },
      });
      if (ex.ok) {
        const exd = await ex.json();
        if (exd && exd.token) token = exd.token;
      }
    } catch (_e) {
      // network hiccup — fall back to the login token
    }
    // Store ONLY the JWT + apiUrl + display name. The password is discarded here and now.
    await chrome.storage.local.set({
      apiUrl,
      token,
      agentName: (data.agent && data.agent.name) || email,
      enabled: true,
      autoOpen: true,
      needsLogin: false,
    });
    $('password').value = '';
    await render();
  } catch (_e) {
    setMsg($('loginMsg'), 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้', 'err');
  } finally {
    $('loginBtn').disabled = false;
  }
}

async function doLogout() {
  await chrome.storage.local.set({ token: '', agentName: '', needsLogin: false });
  setMsg($('loginMsg'), '', '');
  await render();
}

async function onToggle() {
  await chrome.storage.local.set({ enabled: $('enabledToggle').checked });
  setMsg($('sessionMsg'), $('enabledToggle').checked ? 'เปิดใช้งานแล้ว' : 'ปิดการซิงก์ชั่วคราว', 'ok');
}

async function onAutoOpenToggle() {
  await chrome.storage.local.set({ autoOpen: $('autoOpenToggle').checked });
  setMsg($('sessionMsg'), $('autoOpenToggle').checked ? 'เปิดใช้งานอัตโนมัติแล้ว' : 'ปิดการเปิดอัตโนมัติแล้ว', 'ok');
}

// --- one-click sweep: start/stop the chat-list walk in the chat.line.biz tab ---------------
// The sweep itself runs in the content script (content.js runSweep); the popup only sends
// start/stop and mirrors progress from chrome.storage.local.sweep (updated per chat opened).

async function oaTab() {
  const tabs = await chrome.tabs.query({ url: 'https://chat.line.biz/*' });
  return tabs[0] || null;
}

async function sweepIsRunning() {
  const { sweep } = await chrome.storage.local.get({ sweep: null });
  // Consider it running only if the content script reported within the last 30s — a closed
  // tab mid-sweep would otherwise leave the popup stuck on "กำลังกวาด" forever.
  return !!(sweep && sweep.running && Date.now() - (sweep.at || 0) < 30_000);
}

async function renderSweep() {
  const btn = $('sweepBtn');
  if (!btn) return;
  const { sweep } = await chrome.storage.local.get({ sweep: null });
  const running = await sweepIsRunning();
  btn.textContent = running ? '⏹ หยุดกวาด (เปิดแล้ว ' + ((sweep && sweep.opened) || 0) + ' แชท)' : '🧹 เปิดแชททั้งหมดอัตโนมัติ (sweep)';
  if (!running && sweep && sweep.done) {
    setMsg($('sweepMsg'), 'รอบล่าสุด: เปิดไป ' + (sweep.opened || 0) + ' แชท', 'ok');
  }
}

async function onSweepClick() {
  const tab = await oaTab();
  if (!tab) {
    setMsg($('sweepMsg'), 'ไม่พบแท็บ chat.line.biz — เปิดและล็อกอินก่อนค่ะ', 'err');
    return;
  }
  const running = await sweepIsRunning();
  try {
    await chrome.tabs.sendMessage(tab.id, { type: running ? 'sweep-stop' : 'sweep-start' });
    setMsg($('sweepMsg'), running ? 'สั่งหยุดแล้ว — จะหยุดหลังแชทปัจจุบัน' : 'เริ่มกวาดแล้ว — ปิด popup ได้ ทำงานต่อเอง', 'ok');
  } catch (_e) {
    setMsg($('sweepMsg'), 'แท็บ chat.line.biz ยังไม่พร้อม — กด F5 ที่แท็บนั้นแล้วลองใหม่', 'err');
  }
  setTimeout(renderSweep, 500);
}

document.addEventListener('DOMContentLoaded', () => {
  $('loginBtn').addEventListener('click', doLogin);
  $('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('logoutBtn').addEventListener('click', doLogout);
  $('enabledToggle').addEventListener('change', onToggle);
  $('autoOpenToggle').addEventListener('change', onAutoOpenToggle);
  $('sweepBtn').addEventListener('click', onSweepClick);
  render();
  renderSweep();
  setInterval(renderSweep, 1000); // live progress while the popup stays open
});
