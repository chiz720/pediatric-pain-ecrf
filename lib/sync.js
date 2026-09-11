/**
 * Sync client.
 *
 * Saving is synchronous to the outbox and returns immediately; sync is a
 * separate, invisible concern. The outbox is the sole source of truth for what
 * has been delivered — any non-acknowledged POST is a retry, never a loss.
 */

import { outbox, roster, local } from './store.js';
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

    if (response?.roster) await roster.merge(response.roster);
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
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

    const body = JSON.parse(await res.text());
    // A reply from doGet means the POST was diverted by a cached redirect.
    // Treat it as a failed send, never as an acknowledgement.
    if (body && body.ok === false && body.error === 'unknown_mode') {
      throw new Error('post_diverted_to_get');
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the roster so a collector can act on children they did not enrol
 * themselves. Several people work one camp from their own phones, so this is
 * how a ward nurse learns about a child who reached recovery an hour ago.
 */
export async function refreshRoster() {
  if (!config?.endpointUrl || !config?.token) return [];
  const url = `${config.endpointUrl}?mode=roster&token=${encodeURIComponent(config.token)}&n=${Date.now()}`;

  // Building the roster server-side can take tens of seconds on a busy camp.
  // Bound it, or a slow reply ties up a request slot indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch(url, { redirect: 'follow', cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = JSON.parse(await res.text());
    if (body.roster) {
      await roster.merge(body.roster);
      lastRosterPull = Date.now();
      listeners.forEach((fn) => fn({ rosterUpdated: body.roster.length }));
    }
    return body.roster || [];
  } finally {
    clearTimeout(timer);
  }
}

let lastRosterPull = 0;
let rosterInFlight = null;
const ROSTER_MIN_INTERVAL = 60000;

/**
 * Throttled and single-flight: safe to call on every wake-up. Without the
 * in-flight guard a slow reply would let each timer tick start another pull,
 * stacking requests on an endpoint that is already struggling.
 */
export async function refreshRosterIfStale() {
  if (rosterInFlight) return rosterInFlight;
  if (Date.now() - lastRosterPull < ROSTER_MIN_INTERVAL) return;

  rosterInFlight = refreshRoster()
    .catch(() => {
      // Offline, slow, or unreachable. The cached roster still works, and the
      // next wake-up tries again.
    })
    .finally(() => { rosterInFlight = null; });

  return rosterInFlight;
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

  // Send what we have, and pick up what other collectors have enrolled. Both
  // run on the same triggers: coming back online, returning to the app, and a
  // slow background tick.
  const wake = () => { flush(); refreshRosterIfStale(); };

  addEventListener('online', wake);
  addEventListener('focus', wake);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) wake();
  });
  setInterval(wake, 60000);
  wake();
}
