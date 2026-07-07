// Minerva OA Read Sync — popup UI.
//
// Login: the email + password are POSTed straight to Minerva's existing /api/auth/login and are
// NEVER stored — only the returned JWT (token) is saved in chrome.storage.local, alongside the
// apiUrl, the agent's display name, and the on/off `enabled` flag. Logout clears the token.

'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_API = 'https://minerva-production-9309.up.railway.app';

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
    needsLogin: false,
  });
  $('apiUrl').value = cfg.apiUrl || DEFAULT_API;
  if (cfg.token) {
    $('agentName').textContent = cfg.agentName || '(บัญชี Minerva)';
    $('enabledToggle').checked = cfg.enabled !== false;
    setMsg($('sessionMsg'), cfg.needsLogin ? 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' : '', cfg.needsLogin ? 'err' : '');
    show('session');
  } else {
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
    // Store ONLY the JWT + apiUrl + display name. The password is discarded here and now.
    await chrome.storage.local.set({
      apiUrl,
      token: data.token,
      agentName: (data.agent && data.agent.name) || email,
      enabled: true,
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

document.addEventListener('DOMContentLoaded', () => {
  $('loginBtn').addEventListener('click', doLogin);
  $('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('logoutBtn').addEventListener('click', doLogout);
  $('enabledToggle').addEventListener('change', onToggle);
  render();
});
