import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextBatch, toPayload, reconcile, reconcileFailure, backoffUntil,
  pendingCount, rejectedCount, newUuid, PENDING, INFLIGHT, REJECTED, MAX_BATCH,
} from '../lib/outbox.js';

const rec = (uuid, over = {}) => ({
  uuid, form: '05_pain_obs', studyNumber: 'PPP-KN-0147-0', timepoint: 'T4',
  clientTs: '2026-09-11T10:00:00Z', status: PENDING, attempt: 0, data: { pain_rest: 3 },
  ...over,
});

test('batches are oldest first, so a child\'s forms land in collection order', () => {
  const records = [
    rec('c', { clientTs: '2026-09-11T12:00:00Z' }),
    rec('a', { clientTs: '2026-09-11T10:00:00Z' }),
    rec('b', { clientTs: '2026-09-11T11:00:00Z' }),
  ];
  assert.deepEqual(nextBatch(records).map((r) => r.uuid), ['a', 'b', 'c']);
});

test('a batch is capped, so one tablet with a backlog cannot time out the endpoint', () => {
  const records = Array.from({ length: 60 }, (_, i) =>
    rec(`u${i}`, { clientTs: new Date(Date.parse('2026-09-11T10:00:00Z') + i * 1000).toISOString() }));
  assert.equal(nextBatch(records).length, MAX_BATCH);
  assert.equal(nextBatch(records, { limit: 5 }).length, 5);
});

test('records in backoff are skipped until their retry time', () => {
  const now = Date.parse('2026-09-11T12:00:00Z');
  const records = [
    rec('waiting', { retryAfter: '2026-09-11T12:05:00Z' }),
    rec('ready', { retryAfter: '2026-09-11T11:55:00Z' }),
  ];
  assert.deepEqual(nextBatch(records, { now }).map((r) => r.uuid), ['ready']);
});

test('rejected records are never re-sent', () => {
  const records = [rec('a'), rec('b', { status: REJECTED })];
  assert.deepEqual(nextBatch(records).map((r) => r.uuid), ['a']);
});

test('the payload carries provenance the server needs to stamp every row', () => {
  const payload = toPayload([rec('a')], {
    token: 't', deviceId: 'tab-03', raterId: 'RN-014',
    schemaVersion: '1.0.0', appVersion: '2026.09.11', paramsVersion: '1.0.0',
  });
  assert.equal(payload.deviceId, 'tab-03');
  assert.equal(payload.submissions.length, 1);
  assert.deepEqual(Object.keys(payload.submissions[0]).sort(),
    ['clientTs', 'data', 'form', 'studyNumber', 'supersedes', 'timepoint', 'training', 'uuid']);
  assert.equal(payload.submissions[0].training, false);
});

test('accepted records leave the outbox', () => {
  const batch = [rec('a'), rec('b')];
  const { remove, update } = reconcile(batch, { accepted: ['a', 'b'] });
  assert.deepEqual(remove.map((r) => r.uuid), ['a', 'b']);
  assert.deepEqual(update, []);
});

test('a duplicate is a success — this is what makes a flaky network safe', () => {
  const batch = [rec('a')];
  const { remove } = reconcile(batch, { accepted: [], duplicates: ['a'] });
  assert.equal(remove[0].outcome, 'duplicate');
});

test('a transient rejection is retried with backoff', () => {
  const batch = [rec('a')];
  const { remove, update } = reconcile(batch, { rejected: [{ uuid: 'a', reason: 'lock_timeout' }] }, { attempt: 1 });
  assert.deepEqual(remove, []);
  assert.equal(update[0].status, PENDING);
  assert.equal(update[0].attempt, 2);
  assert.ok(update[0].retryAfter);
});

test('a permanent rejection is quarantined, not deleted — it is still data', () => {
  const batch = [rec('a')];
  const { remove, update } = reconcile(batch, { rejected: [{ uuid: 'a', reason: 'schema_version_unsupported' }] });
  assert.deepEqual(remove, []);
  assert.equal(update[0].status, REJECTED);
  assert.equal(update[0].lastReason, 'schema_version_unsupported');
  assert.ok(update[0].rejectedAt);
});

test('a record the server did not mention is retried, never assumed delivered', () => {
  const batch = [rec('a'), rec('b')];
  const { remove, update } = reconcile(batch, { accepted: ['a'] });
  assert.deepEqual(remove.map((r) => r.uuid), ['a']);
  assert.equal(update.length, 1);
  assert.equal(update[0].uuid, 'b');
  assert.equal(update[0].status, PENDING);
  assert.equal(update[0].lastReason, 'unacknowledged');
});

test('a failed request loses nothing', () => {
  const batch = [rec('a'), rec('b')];
  const { remove, update } = reconcileFailure(batch, new Error('Failed to fetch'), { attempt: 2 });
  assert.deepEqual(remove, []);
  assert.equal(update.length, 2);
  assert.ok(update.every((r) => r.status === PENDING));
  assert.ok(update.every((r) => r.attempt === 3));
  assert.match(update[0].lastReason, /Failed to fetch/);
});

test('an empty response retries the whole batch rather than clearing it', () => {
  const batch = [rec('a'), rec('b')];
  const { remove, update } = reconcile(batch, {});
  assert.deepEqual(remove, []);
  assert.equal(update.length, 2);
});

test('backoff grows and is capped at five minutes', () => {
  const now = '2026-09-11T12:00:00Z';
  const delay = (attempt) => Date.parse(backoffUntil(attempt, now)) - Date.parse(now);
  assert.ok(delay(1) >= 2000 && delay(1) < 3000);
  assert.ok(delay(3) >= 8000 && delay(3) < 11000);
  assert.ok(delay(20) >= 300000 && delay(20) <= 375000);
});

test('counters drive the header badge the ward nurse watches', () => {
  const records = [rec('a'), rec('b', { status: INFLIGHT }), rec('c', { status: REJECTED })];
  assert.equal(pendingCount(records), 2);
  assert.equal(rejectedCount(records), 1);
});

test('uuids are unique and well formed', () => {
  const ids = new Set(Array.from({ length: 500 }, newUuid));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
