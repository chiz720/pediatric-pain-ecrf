/**
 * Outbox reconciliation — the pure half of sync.
 *
 * Kept separate from IndexedDB so the rules that decide what gets deleted, what
 * gets retried and what gets quarantined are unit-testable. The outbox is the
 * sole source of truth for what has been delivered: a record leaves it only on
 * an explicit server acknowledgement.
 */

export const PENDING = 'pending';
export const INFLIGHT = 'inflight';
export const REJECTED = 'rejected';

export const MAX_BATCH = 25;

/** Reasons worth retrying: the server never saw a well-formed request. */
const TRANSIENT = new Set([
  'lock_timeout',
  'rate_limited',
  'server_error',
  'quota_exceeded',
]);

/** Oldest first, so a child's forms land in the order they were collected. */
export function nextBatch(records, { limit = MAX_BATCH, now = Date.now() } = {}) {
  return (records || [])
    .filter((r) => r.status === PENDING || r.status === INFLIGHT)
    .filter((r) => !r.retryAfter || Date.parse(r.retryAfter) <= now)
    .sort((a, b) => Date.parse(a.clientTs) - Date.parse(b.clientTs))
    .slice(0, limit);
}

export function toPayload(records, { token, deviceId, raterId, schemaVersion, appVersion, paramsVersion }) {
  return {
    token,
    deviceId,
    raterId,
    schemaVersion,
    appVersion,
    paramsVersion,
    submissions: records.map((r) => ({
      uuid: r.uuid,
      form: r.form,
      studyNumber: r.studyNumber,
      timepoint: r.timepoint ?? null,
      clientTs: r.clientTs,
      supersedes: r.supersedes ?? null,
      training: r.training === true,
      data: r.data,
    })),
  };
}

/**
 * Decide the fate of every record in a batch from one server response.
 *
 * `duplicates` are a success, not an error: it is what makes a flaky network
 * safe, because a retried batch cannot create a second row.
 */
export function reconcile(batch, response, { now = new Date().toISOString(), attempt = 1 } = {}) {
  const accepted = new Set(response?.accepted || []);
  const duplicates = new Set(response?.duplicates || []);
  const rejected = new Map((response?.rejected || []).map((r) => [r.uuid, r.reason]));

  const remove = [];
  const update = [];

  for (const record of batch) {
    if (accepted.has(record.uuid)) {
      remove.push({ uuid: record.uuid, outcome: 'accepted' });
      continue;
    }
    if (duplicates.has(record.uuid)) {
      remove.push({ uuid: record.uuid, outcome: 'duplicate' });
      continue;
    }
    if (rejected.has(record.uuid)) {
      const reason = rejected.get(record.uuid);
      if (TRANSIENT.has(reason)) {
        update.push({ ...record, status: PENDING, attempt: attempt + 1, lastReason: reason, retryAfter: backoffUntil(attempt, now) });
      } else {
        // Quarantined, not deleted. A rejected record is still data, and a
        // coordinator must be able to see and export it.
        update.push({ ...record, status: REJECTED, lastReason: reason, rejectedAt: now });
      }
      continue;
    }
    // Named in neither list: the server did not speak to this record. Retry it.
    update.push({ ...record, status: PENDING, attempt: attempt + 1, lastReason: 'unacknowledged', retryAfter: backoffUntil(attempt, now) });
  }

  return { remove, update };
}

/** Every record stays pending when the request itself fails. Nothing is lost. */
export function reconcileFailure(batch, error, { now = new Date().toISOString(), attempt = 1 } = {}) {
  return {
    remove: [],
    update: batch.map((r) => ({
      ...r,
      status: PENDING,
      attempt: attempt + 1,
      lastReason: String(error?.message || error || 'network_error'),
      retryAfter: backoffUntil(attempt, now),
    })),
  };
}

/** Exponential backoff with jitter, capped at five minutes. */
export function backoffUntil(attempt, now = new Date().toISOString()) {
  const base = Math.min(2 ** Math.max(0, attempt - 1) * 2000, 300000);
  const jitter = base * 0.25 * Math.random();
  return new Date(Date.parse(now) + base + jitter).toISOString();
}

export function pendingCount(records) {
  return (records || []).filter((r) => r.status === PENDING || r.status === INFLIGHT).length;
}

export function rejectedCount(records) {
  return (records || []).filter((r) => r.status === REJECTED).length;
}

/** Stable uuid: crypto where available, so a record keeps its idempotency key. */
export function newUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
