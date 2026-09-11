/**
 * IndexedDB persistence. Deliberately thin: every rule about what gets kept,
 * retried or removed lives in outbox.js, which is testable without a browser.
 *
 * Three stores:
 *   outbox    submissions awaiting server acknowledgement
 *   roster    enrolled children, so a ward tablet can build its due-list for
 *             children it did not enrol itself
 *   local     observations already collected on this device, for the due-list
 *             and for the previous-score warnings
 */

const DB_NAME = 'ppp-ecrf';
const DB_VERSION = 1;

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('outbox')) {
        const outbox = db.createObjectStore('outbox', { keyPath: 'uuid' });
        outbox.createIndex('status', 'status');
        outbox.createIndex('clientTs', 'clientTs');
      }
      if (!db.objectStoreNames.contains('roster')) {
        db.createObjectStore('roster', { keyPath: 'study_number' });
      }
      if (!db.objectStoreNames.contains('local')) {
        const local = db.createObjectStore('local', { keyPath: 'uuid' });
        local.createIndex('studyNumber', 'studyNumber');
        local.createIndex('form', 'form');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      t.abort();
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const all = (store) => {
  const req = store.getAll();
  return { __req: req };
};

/* ---------------- outbox ---------------- */

export const outbox = {
  async put(record) {
    await tx('outbox', 'readwrite', (s) => s.put(record));
    return record;
  },
  async putMany(records) {
    await tx('outbox', 'readwrite', (s) => records.forEach((r) => s.put(r)));
    return records;
  },
  async removeMany(uuids) {
    await tx('outbox', 'readwrite', (s) => uuids.forEach((u) => s.delete(u)));
  },
  all() {
    return tx('outbox', 'readonly', all);
  },
};

/* ---------------- roster ---------------- */

export const roster = {
  all() {
    return tx('roster', 'readonly', all);
  },
  async put(child) {
    await tx('roster', 'readwrite', (s) => s.put(child));
    return child;
  },
  async merge(children) {
    // Server rows win on conflict, but a locally enrolled child not yet synced
    // is never dropped.
    await tx('roster', 'readwrite', (s) => children.forEach((c) => s.put(c)));
  },
  async get(studyNumber) {
    return tx('roster', 'readonly', (s) => ({ __req: s.get(studyNumber) }));
  },
};

/* ---------------- local records ---------------- */

export const local = {
  all() {
    return tx('local', 'readonly', all);
  },
  async put(record) {
    await tx('local', 'readwrite', (s) => s.put(record));
    return record;
  },
  async byChild(studyNumber) {
    const rows = await tx('local', 'readonly', all);
    return rows.filter((r) => r.studyNumber === studyNumber);
  },
  async observationsByChild() {
    const rows = await tx('local', 'readonly', all);
    const out = {};
    for (const r of rows) {
      if (r.form !== '05_pain_obs') continue;
      (out[r.studyNumber] ||= []).push({ timepoint: r.timepoint, ...r.data });
    }
    return out;
  },
};

/** The escape hatch: everything on this device, for a password-protected export. */
export async function exportAll() {
  return {
    exportedAt: new Date().toISOString(),
    outbox: await outbox.all(),
    roster: await roster.all(),
    local: await local.all(),
  };
}
