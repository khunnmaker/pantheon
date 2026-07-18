#!/usr/bin/env node

// Production Ceres staff-request smoke test for Pantheon e7f514d.
// Intentionally dependency-free: this file is copied to /tmp in the Railway API
// container and talks only to the local Fastify server over HTTP.

const BASE_URL = `http://localhost:${process.env.PORT || '3000'}`;
const AMOUNT = '5';
const MEMO = 'ทดสอบระบบ (smoke test) — จะถูก reverse';
const GM_EMAIL = 'md@prominent.local';
const STAFF_SLUGS = [
  'nadeer', 'anny', 'noey', 'bow', 'tham', 'rak', 'ta', 'arm', 'man',
  'boonson', 'kaew', 'lungko', 'wong', 'paeng', 'poopae', 'win', 'mail',
  'pin', 'lekmaeban', 'da', 'benz', 'meow',
];

const steps = [];
let nextStep = 1;
const state = {
  staffToken: null,
  gmToken: null,
  requestId: null,
  aiScreenStatus: null,
  approvalStatus: null,
  fulfillmentStatus: null,
  lane: null,
  initialEventId: null,
  reversalEventId: null,
  balanceBeforeSatang: null,
  balanceRestored: false,
  moneyReversed: false,
  requestTerminal: false,
  transferMediaCreated: false,
  guards: [],
};

class ApiError extends Error {
  constructor(method, path, status, code) {
    super(`${method} ${path} -> ${status} ${code}`);
    this.name = 'ApiError';
    this.method = method;
    this.path = path;
    this.status = status;
    this.code = code;
  }
}

class SmokeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SmokeError';
    this.code = code;
  }
}

function record(status, name, detail = '') {
  const item = { number: nextStep++, status, name, ...(detail ? { detail } : {}) };
  steps.push(item);
  console.log(`STEP ${item.number} ${status} - ${name}${detail ? `: ${detail}` : ''}`);
  return item;
}

function safeCode(error) {
  if (error instanceof ApiError || error instanceof SmokeError) return String(error.code);
  if (error?.name === 'AbortError') return 'timeout';
  return 'unexpected_error';
}

function assert(condition, code) {
  if (!condition) throw new SmokeError(code);
}

function toSatang(value) {
  const amount = Number.parseFloat(String(value));
  if (!Number.isFinite(amount)) throw new SmokeError('invalid_balance_projection');
  return Math.round(amount * 100);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path, { method = 'GET', token, body, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new ApiError(method, path, response.status, 'invalid_json_response');
      }
    }
    if (!response.ok) {
      const code = data && typeof data.error === 'string' ? data.error : 'http_error';
      throw new ApiError(method, path, response.status, code);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function parseEmployeePins(raw) {
  const pins = new Map();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 1) continue;
    const slug = trimmed.slice(0, colon);
    const pin = trimmed.slice(colon + 1);
    if (/^\d{6}$/.test(pin)) pins.set(slug, pin);
  }
  return pins;
}

async function login(email, password) {
  const data = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  assert(data && typeof data.token === 'string' && data.token.length > 0, 'login_token_missing');
  assert(data.agent && data.agent.email === email, 'login_identity_mismatch');
  return data;
}

async function getRequest(token) {
  const data = await api(`/api/ceres/requests/${encodeURIComponent(state.requestId)}`, { token });
  assert(data?.request?.id === state.requestId, 'request_read_mismatch');
  state.approvalStatus = data.request.approvalStatus;
  state.fulfillmentStatus = data.request.fulfillmentStatus;
  return data;
}

async function getBoard(token) {
  const data = await api('/api/ceres/board', { token });
  assert(data?.box && Number.isFinite(Number(data.box.balance)), 'board_balance_missing');
  return data;
}

async function getRequestMovements(token) {
  const data = await api('/api/ceres/movements', { token });
  assert(Array.isArray(data?.movements), 'movements_missing');
  return data.movements.filter((movement) => movement.requestId === state.requestId);
}

function activeInitialMoneyEvent(moneyEvents) {
  const reversals = new Set(
    moneyEvents
      .filter((event) => event.kind === 'reversal' && event.reversesEventId)
      .map((event) => event.reversesEventId),
  );
  return moneyEvents.find(
    (event) => ['payment', 'purchase'].includes(event.kind) && !reversals.has(event.id),
  ) || null;
}

async function cancelRequest(token, note) {
  const data = await api(`/api/ceres/requests/${encodeURIComponent(state.requestId)}/cancel`, {
    method: 'POST', token, body: { note },
  });
  state.approvalStatus = data?.request?.approvalStatus;
  state.fulfillmentStatus = data?.request?.fulfillmentStatus;
  assert(['cancelled', 'void'].includes(state.approvalStatus), 'request_not_terminal_after_cancel');
  state.requestTerminal = true;
  return data;
}

async function reverseEvent(token, eventId, reason) {
  const data = await api(`/api/ceres/request-money-events/${encodeURIComponent(eventId)}/reverse`, {
    method: 'POST',
    token,
    body: {
      reason,
      idempotencyKey: `ceres-smoke-reverse-${eventId}`,
    },
  });
  assert(data?.moneyEvent?.kind === 'reversal', 'reversal_event_missing');
  assert(data.moneyEvent.reversesEventId === eventId, 'reversal_target_mismatch');
  state.reversalEventId = data.moneyEvent.id;
  state.moneyReversed = true;
  return data.moneyEvent;
}

async function verifyRestoredState() {
  const detail = await getRequest(state.gmToken);
  const request = detail.request;
  const events = Array.isArray(detail.moneyEvents) ? detail.moneyEvents : [];
  const reversal = events.find(
    (event) => event.id === state.reversalEventId
      && event.kind === 'reversal'
      && event.reversesEventId === state.initialEventId,
  );
  assert(request.fulfillmentStatus === 'reversed', 'request_not_reversed');
  assert(Boolean(reversal), 'reversal_not_visible_on_request');

  const movements = await getRequestMovements(state.gmToken);
  if (state.lane === 'cash') {
    const outgoing = movements.find(
      (movement) => movement.requestMoneyEventId === state.initialEventId
        && movement.direction === 'out'
        && toSatang(movement.amount) === toSatang(AMOUNT),
    );
    const compensating = movements.find(
      (movement) => movement.requestMoneyEventId === state.reversalEventId
        && movement.direction === 'in'
        && movement.reversesMovementId === outgoing?.id
        && toSatang(movement.amount) === toSatang(AMOUNT),
    );
    assert(Boolean(outgoing), 'cash_out_movement_missing');
    assert(Boolean(compensating), 'cash_reversal_movement_missing');
  } else {
    assert(movements.length === 0, 'transfer_touched_cash_ledger');
  }

  const board = await getBoard(state.gmToken);
  state.balanceRestored = toSatang(board.box.balance) === state.balanceBeforeSatang;
  assert(state.balanceRestored, 'box_balance_not_restored');
}

async function cleanupAfterFailure() {
  if (!state.requestId) return;
  const token = state.gmToken || state.staffToken;
  if (!token) return;

  let detail;
  try {
    detail = await getRequest(token);
  } catch (error) {
    record('FAIL', 'cleanup request inspection', safeCode(error));
    return;
  }

  const events = Array.isArray(detail.moneyEvents) ? detail.moneyEvents : [];
  const active = activeInitialMoneyEvent(events);
  if (active && state.gmToken) {
    try {
      state.initialEventId = active.id;
      state.lane = active.lane;
      await reverseEvent(state.gmToken, active.id, 'smoke test emergency cleanup');
      record('PASS', 'cleanup fulfillment reversal', 'active money event reversed');
    } catch (error) {
      record('FAIL', 'cleanup fulfillment reversal', safeCode(error));
      return;
    }
  } else if (active) {
    record('FAIL', 'cleanup fulfillment reversal', 'manager_token_unavailable');
    return;
  }

  try {
    detail = await getRequest(state.gmToken || state.staffToken);
    if (detail.request.fulfillmentStatus === 'reversed' && state.gmToken && state.balanceBeforeSatang !== null) {
      await verifyRestoredState();
      record('PASS', 'cleanup financial verification', 'money projection and box balance restored');
    }
  } catch (error) {
    record('FAIL', 'cleanup financial verification', safeCode(error));
  }

  if (['cancelled', 'void', 'rejected'].includes(detail.request.approvalStatus)) {
    state.requestTerminal = true;
    return;
  }

  const cancelToken = detail.request.approvalStatus === 'pending_nee'
    ? state.staffToken
    : state.gmToken;
  if (!cancelToken) return;
  try {
    await cancelRequest(cancelToken, 'smoke test emergency cleanup');
    record('PASS', 'cleanup terminal cancellation', 'request cancelled');
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_cancellable') {
      state.guards.push({ step: 'cleanup terminal cancellation', guard: error.code });
      record('SKIP', 'cleanup terminal cancellation', `guard ${error.code}`);
    } else {
      record('FAIL', 'cleanup terminal cancellation', safeCode(error));
    }
  }
}

function cleanupSummary() {
  return {
    moneyReversed: state.moneyReversed,
    balanceRestored: state.balanceRestored,
    requestTerminal: state.requestTerminal,
    approvalStatus: state.approvalStatus,
    fulfillmentStatus: state.fulfillmentStatus,
    lane: state.lane,
    transferMediaCreated: state.transferMediaCreated,
    guards: state.guards,
  };
}

function finish(result, exitCode) {
  console.log(JSON.stringify({
    result,
    steps,
    requestId: state.requestId,
    cleanup: cleanupSummary(),
  }));
  process.exitCode = exitCode;
}

async function main() {
  let intendedPartial = false;
  try {
    // Same merge as api/src/env.ts: AGENT_PINS is the legacy name, EMPLOYEE_PINS wins on slug clash.
    const rawPins = [process.env.AGENT_PINS, process.env.EMPLOYEE_PINS].filter(Boolean).join(',');
    const gmPassword = process.env.GM_PASSWORD || process.env.MD_PASSWORD;
    assert(rawPins.length > 0, 'EMPLOYEE_PINS_and_AGENT_PINS_missing');
    assert(typeof gmPassword === 'string' && gmPassword.length > 0, 'GM_PASSWORD_and_MD_PASSWORD_missing');
    const pins = parseEmployeePins(rawPins);
    const configuredSlugs = STAFF_SLUGS.filter((slug) => pins.has(slug));
    assert(configuredSlugs.length > 0, 'no_seeded_ceres_employee_in_EMPLOYEE_PINS');

    const cards = await api('/api/auth/logins?app=ceres');
    assert(Array.isArray(cards), 'ceres_login_cards_invalid');
    const cardEmails = new Set(
      cards
        .filter((card) => card?.kind === 'pin' && typeof card.email === 'string')
        .map((card) => card.email),
    );
    const staffSlug = configuredSlugs.find((slug) => cardEmails.has(`${slug}@prominent.local`));
    assert(Boolean(staffSlug), 'configured_ceres_employee_not_seeded');
    record('PASS', 'runtime configuration and staff selection', 'local API reachable; seeded Ceres employee selected');

    const staffEmail = `${staffSlug}@prominent.local`;
    const staffLogin = await login(staffEmail, pins.get(staffSlug));
    state.staffToken = staffLogin.token;
    const bootstrap = await api('/api/ceres/bootstrap', { token: state.staffToken });
    assert(bootstrap?.role === 'messenger', 'selected_account_not_staff_role');
    assert(bootstrap.party && typeof bootstrap.party.id === 'string', 'selected_staff_has_no_ceres_party');
    assert(Array.isArray(bootstrap.categories) && bootstrap.categories.length > 0, 'no_active_ceres_category');
    assert(Array.isArray(bootstrap.entities) && bootstrap.entities.includes('PROM'), 'PROM_entity_unavailable');
    const category = bootstrap.categories.find(
      (item) => item && typeof item.name === 'string' && item.name && item.kind !== 'shipping',
    ) || bootstrap.categories.find((item) => item && typeof item.name === 'string' && item.name);
    assert(Boolean(category), 'no_usable_ceres_category');
    record('PASS', 'staff login and Ceres bootstrap', 'messenger role, party, category, and PROM entity verified');

    const created = await api('/api/ceres/requests', {
      method: 'POST',
      token: state.staffToken,
      timeoutMs: 180_000,
      body: {
        requestType: 'advance',
        entity: 'PROM',
        category: category.name,
        amount: AMOUNT,
        reason: MEMO,
      },
    });
    const request = created?.request;
    assert(request && typeof request.id === 'string', 'created_request_missing');
    state.requestId = request.id;
    state.approvalStatus = request.approvalStatus;
    state.fulfillmentStatus = request.fulfillmentStatus;
    assert(request.workflowVersion === 2, 'wrong_workflow_version');
    assert(request.requestType === 'advance', 'wrong_request_type');
    assert(toSatang(request.amount) === toSatang(AMOUNT), 'wrong_request_amount');
    assert(request.reason === MEMO, 'wrong_request_reason');
    assert(request.approvalStatus === 'pending_nee', 'wrong_initial_approval_status');
    assert(request.fulfillmentStatus === 'unfulfilled', 'wrong_initial_fulfillment_status');
    record('PASS', 'create 5 THB advance request', 'workflow v2 request persisted with server-derived requester identity');

    let screened = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const detail = await getRequest(state.staffToken);
      if (['clear', 'escalate'].includes(detail.request.aiScreenStatus)) {
        screened = detail.request;
        break;
      }
      assert(detail.request.aiScreenStatus === 'pending', 'invalid_ai_screen_status');
      await sleep(2_000);
    }
    assert(Boolean(screened), 'ai_screen_poll_timeout');
    state.aiScreenStatus = screened.aiScreenStatus;
    assert(screened.aiReview && screened.aiReview.verdict === state.aiScreenStatus, 'ai_review_projection_mismatch');
    record('PASS', 'poll AI pre-screen', `verdict ${state.aiScreenStatus}`);

    if (state.aiScreenStatus === 'escalate') {
      await cancelRequest(state.staffToken, 'smoke test stopped after AI escalation');
      state.balanceRestored = true;
      record('PASS', 'cancel escalated request', 'request terminally cancelled before any manager or CEO action');
      record('SKIP', 'GM approval, fulfillment, and reversal', 'AI escalation branch intentionally stops before the CEO path');
      finish('FULL', 0);
      return;
    }

    const gmLogin = await login(GM_EMAIL, gmPassword);
    state.gmToken = gmLogin.token;
    assert(gmLogin.agent?.role === 'gm', 'nee_account_not_gm');
    const boardBefore = await getBoard(state.gmToken);
    state.balanceBeforeSatang = toSatang(boardBefore.box.balance);
    record('PASS', 'GM Nee login and box baseline', 'GM identity and pre-fulfillment box projection verified');

    const approved = await api(`/api/ceres/requests/${encodeURIComponent(state.requestId)}/nee-decision`, {
      method: 'POST',
      token: state.gmToken,
      body: { decision: 'approve', note: 'production smoke test approval' },
    });
    state.approvalStatus = approved?.request?.approvalStatus;
    state.fulfillmentStatus = approved?.request?.fulfillmentStatus;
    if (state.approvalStatus !== 'approved') {
      state.guards.push({ step: 'GM approval', guard: state.approvalStatus || 'missing_status' });
      intendedPartial = true;
      record('SKIP', 'GM approval', `guard ${state.approvalStatus || 'missing_status'}; CEO path untouched`);
      await cancelRequest(state.gmToken, 'smoke test stopped at approval guard');
      state.balanceRestored = true;
      record('PASS', 'terminal cleanup after approval guard', 'unfulfilled request cancelled');
      finish('PARTIAL', 0);
      return;
    }
    assert(state.fulfillmentStatus === 'unfulfilled', 'approval_changed_fulfillment');
    record('PASS', 'GM Nee approval', 'below-threshold clear request approved without CEO action');

    let fulfilled = null;
    try {
      fulfilled = await api(`/api/ceres/requests/${encodeURIComponent(state.requestId)}/fulfill`, {
        method: 'POST',
        token: state.gmToken,
        body: {
          lane: 'cash',
          note: 'production smoke test cash fulfillment',
          idempotencyKey: `ceres-smoke-cash-${state.requestId}`,
        },
      });
      state.lane = 'cash';
      record('PASS', 'fulfill through CASH lane', 'cash fulfillment accepted');
    } catch (error) {
      if (!(error instanceof ApiError) || !['insufficient_cash', 'cash_account_missing'].includes(error.code)) {
        throw error;
      }
      state.guards.push({ step: 'CASH fulfillment', guard: error.code });
      record('SKIP', 'fulfill through CASH lane', `guard ${error.code}; falling back to TRANSFER`);

      // Valid 1x1 PNG. Construct a Buffer at runtime and send the route's JSON/base64 contract.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      );
      assert(
        png.length > 8 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        'generated_png_invalid',
      );
      const uploaded = await api('/api/ceres/media', {
        method: 'POST',
        token: state.gmToken,
        timeoutMs: 120_000,
        body: { dataB64: png.toString('base64'), contentType: 'image/png', purpose: 'transfer_slip' },
      });
      assert(typeof uploaded?.uploadId === 'string' && uploaded.uploadId.length > 0, 'transfer_slip_upload_missing');
      state.transferMediaCreated = true;
      record('PASS', 'generate and upload TRANSFER slip', 'valid PNG accepted as transfer_slip media');

      try {
        fulfilled = await api(`/api/ceres/requests/${encodeURIComponent(state.requestId)}/fulfill`, {
          method: 'POST',
          token: state.gmToken,
          body: {
            lane: 'transfer',
            transferSlipUploadId: uploaded.uploadId,
            note: 'production smoke test transfer fallback',
            idempotencyKey: `ceres-smoke-transfer-${state.requestId}`,
          },
        });
        state.lane = 'transfer';
        record('PASS', 'fulfill through TRANSFER lane', 'transfer fulfillment accepted with mandatory slip');
      } catch (transferError) {
        if (!(transferError instanceof ApiError) || ![400, 403, 409].includes(transferError.status)) {
          throw transferError;
        }
        state.guards.push({ step: 'TRANSFER fulfillment', guard: transferError.code });
        intendedPartial = true;
        record('SKIP', 'fulfill through TRANSFER lane', `guard ${transferError.code}`);
        await cancelRequest(state.gmToken, 'smoke test stopped after both fulfillment lanes were blocked');
        state.balanceRestored = true;
        record('PASS', 'terminal cleanup after fulfillment guards', 'unfulfilled request cancelled; no money event created');
        finish('PARTIAL', 0);
        return;
      }
    }

    const moneyEvent = fulfilled?.moneyEvent;
    assert(moneyEvent && typeof moneyEvent.id === 'string', 'fulfillment_event_missing');
    assert(moneyEvent.kind === 'payment', 'fulfillment_event_wrong_kind');
    assert(moneyEvent.lane === state.lane, 'fulfillment_lane_mismatch');
    assert(toSatang(moneyEvent.amount) === toSatang(AMOUNT), 'fulfillment_amount_mismatch');
    state.initialEventId = moneyEvent.id;

    const paidDetail = await getRequest(state.gmToken);
    assert(paidDetail.request.approvalStatus === 'approved', 'paid_request_not_approved');
    assert(paidDetail.request.fulfillmentStatus === 'paid', 'request_not_paid');
    const visibleInitial = paidDetail.moneyEvents?.find((event) => event.id === state.initialEventId);
    assert(Boolean(visibleInitial), 'fulfillment_not_visible_on_request');
    const paidMovements = await getRequestMovements(state.gmToken);
    const boardAfterFulfill = await getBoard(state.gmToken);
    if (state.lane === 'cash') {
      assert(typeof moneyEvent.cashMovementId === 'string', 'cash_movement_id_missing');
      assert(paidMovements.some(
        (movement) => movement.id === moneyEvent.cashMovementId
          && movement.requestMoneyEventId === moneyEvent.id
          && movement.direction === 'out'
          && toSatang(movement.amount) === toSatang(AMOUNT),
      ), 'cash_movement_not_visible');
      assert(
        toSatang(boardAfterFulfill.box.balance) === state.balanceBeforeSatang - toSatang(AMOUNT),
        'cash_balance_did_not_decrease',
      );
    } else {
      assert(moneyEvent.cashMovementId === null, 'transfer_created_cash_movement_id');
      assert(paidMovements.length === 0, 'transfer_created_cash_movement');
      assert(toSatang(boardAfterFulfill.box.balance) === state.balanceBeforeSatang, 'transfer_changed_box_balance');
    }
    record('PASS', 'verify fulfilled request and cash projection', `${state.lane} lane state, event, movement contract, and box projection matched`);

    await reverseEvent(state.gmToken, state.initialEventId, 'smoke test reversal');
    record('PASS', 'reverse fulfillment', 'append-only reversal event created');

    await verifyRestoredState();
    record('PASS', 'verify reversal and restored box balance', 'request reversed and cash ledger returned to its exact baseline');

    try {
      await cancelRequest(state.gmToken, 'smoke test terminal cleanup');
      record('PASS', 'terminally cancel request', 'request cancelled after reversal');
      finish('FULL', 0);
      return;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'not_cancellable') {
        state.guards.push({ step: 'terminal cancellation', guard: error.code });
        intendedPartial = true;
        record('SKIP', 'terminally cancel request', `guard ${error.code}; deployed v2 only allows manager cancel while unfulfilled`);
        await getRequest(state.gmToken);
        finish('PARTIAL', 0);
        return;
      }
      throw error;
    }
  } catch (error) {
    record('FAIL', 'smoke execution', safeCode(error));
    await cleanupAfterFailure();
    finish(intendedPartial ? 'PARTIAL' : 'FAIL', intendedPartial ? 0 : 1);
  }
}

await main();
