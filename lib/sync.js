/**
 * Sync client.
 *
 * Saving is synchronous to the outbox and returns immediately; sync is a
 * separate, invisible concern. The outbox is the sole source of truth for what
 * has been delivered — any non-acknowledged POST is a retry, never a loss.
 */

import { outbox, local } from './store.js';
import {
  nextBatch, toPayload, reconcile, reconcileFailure,
  pendingCount, rejectedCount, newUuid, PENDING, INFLIGHT,
} from './outbox.js';

let config = null;
let syncing = false;
const listeners = new Set();

export function configure(cfg) {
  config = cfg;
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function emit() {
  const records = await outbox.all();
  const state = {
    pending: pendingCount(records),
    rejected: rejectedCount(records),
    syncing,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
  };
  listeners.forEach((fn) => fn(state));
  return state;
}

/**
 * Queue a submission. Returns as soon as it is durably on disk — the rater is
 * never made to wait for the network, and never told a save failed because a
 * tablet is in a stairwell.
 */
export async function submit({ form, studyNumber, timepoint = null, data, supersedes = null }) {
  const record = {
    uuid: newUuid(),
    form,
    studyNumber,
    timepoint,
    supersedes,
    clientTs: new Date().toISOString(),
    status: PENDING,
    attempt: 0,
    training: config?.training === true,
    data,
  };
  await outbox.put(record);
  await local.put({ ...record, savedAt: record.clientTs });
  emit();
  flush().catch(() => {});
  return record;
}

/** Post one batch. Safe to call at any time; concurrent calls collapse. */
export async function flush() {
  if (syncing || !config?.endpointUrl) return emit();
  const records = await outbox.all();
  const batch = nextBatch(records);
  if (batch.length === 0) return emit();

  syncing = true;
  emit();
  const attempt = Math.max(...batch.map((r) => r.attempt || 0)) + 1;

  try {
    await outbox.putMany(batch.map((r) => ({ ...r, status: INFLIGHT })));

    const response = await post(toPayload(batch, {
      token: config.token,
      deviceId: config.deviceId,
      raterId: config.raterId,
      schemaVersion: config.schemaVersion,
      appVersion: config.appVersion,
      paramsVersion: config.paramsVersion,
    }));

    const { remove, update } = reconcile(batch, response, { attempt });
    if (remove.length) await outbox.removeMany(remove.map((r) => r.uuid));
    if (update.length) await outbox.putMany(update);

    if (response?.schemaVersion && response.schemaVersion !== config.schemaVersion) {
      listeners.forEach((fn) => fn({ updateAvailable: response.schemaVersion }));
    }
  } catch (err) {
    const { update } = reconcileFailure(batch, err, { attempt });
    await outbox.putMany(update);
  } finally {
    syncing = false;
  }

  return emit();
}

/**
 * text/plain avoids the CORS preflight, which Apps Script cannot answer. The
 * body is still JSON; only the declared media type differs.
 *
 * The cache-buster is not optional. Apps Script answers a POST with a 302 to
 * script.googleusercontent.com, and the browser caches that redirect against
 * the /exec URL. A second POST to the same URL is then sent straight to the
 * cached target — as a GET, because that is what browsers do when following a
 * 302 — so it never reaches doPost at all. It lands in doGet instead and comes
 * back as {"error":"unknown_mode"}, which looks like a response but
 * acknowledges nothing. Every retry after the first would fail forever, and
 * the outbox would grow without any error the rater could see. A unique URL
 * per attempt keeps each POST out of that cached redirect.
 */
async function post(payload) {
  // Apps Script intermittently answers a POST with a redirect that Chrome
  // follows as a GET, so the reply comes from doGet as {"error":"unknown_mode"}.
  //
  // Measured against the live deployment: when this happens the write has
  // ALREADY SUCCEEDED — only the acknowledgement is lost. So retrying is both
  // safe and necessary: safe because the submission uuid makes the second
  // attempt a no-op the server reports as a duplicate, and necessary because
  // without an acknowledgement the outbox would hold rows that are in fact
  // already in the workbook.
  //
  // This is the whole reason submissions carry a uuid. Without it, every
  // divert would put a second copy of the record in the sheet.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const body = await postOnce(payload);
    if (!(body && body.ok === false && body.error === 'unknown_mode')) return body;
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  throw new Error('post_diverted_to_get');
}

async function postOnce(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    // A unique URL per attempt keeps each POST clear of the cached redirect.
    const url = `${config.endpointUrl}${config.endpointUrl.includes('?') ? '&' : '?'}n=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Has this study number already been enrolled?
 *
 * One boolean, and the caller supplied the number it is asking about, so
 * nothing is read out of the workbook that the phone did not already hold. Any
 * failure — offline, timeout, an Apps Script divert — answers `false`: this
 * warns about a double enrolment, it never gates one, and a phone in a
 * stairwell must not be told a child is unknown any more firmly than that.
 */
export async function isEnrolled(studyNumber) {
  if (!config?.endpointUrl || !studyNumber) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const url = `${config.endpointUrl}?mode=check`
      + `&token=${encodeURIComponent(config.token)}`
      + `&sn=${encodeURIComponent(studyNumber)}`
      + `&n=${Date.now()}`;
    const res = await fetch(url, { redirect: 'follow', cache: 'no-store', signal: controller.signal });
    if (!res.ok) return false;
    const body = JSON.parse(await res.text());
    return body?.ok === true && body.enrolled === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Clock discipline: every derived interval depends on these timestamps. */
export async function checkClock() {
  if (!config?.endpointUrl) return { ok: true, skewSeconds: 0 };
  const before = Date.now();
  const controller = new AbortController();
  const healthTimer = setTimeout(() => controller.abort(), 20000);
  const res = await fetch(`${config.endpointUrl}?mode=health&n=${Date.now()}`,
    { redirect: 'follow', cache: 'no-store', signal: controller.signal }).finally(() => clearTimeout(healthTimer));
  const body = JSON.parse(await res.text());
  const rtt = Date.now() - before;
  const skewSeconds = Math.round((Date.parse(body.serverTs) - (before + rtt / 2)) / 1000);
  return { ok: Math.abs(skewSeconds) <= 120, skewSeconds, serverTs: body.serverTs };
}

export function startAutoSync() {
  if (typeof window === 'undefined') return;

  const wake = () => flush();

  addEventListener('online', wake);
  addEventListener('focus', wake);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) wake();
  });
  setInterval(wake, 60000);
  wake();
}
