// db.js
// IndexedDB persistence for Meus Drinks. Three stores: records, photos, meta.
// Database name is app-specific and stable — do not rename without a migration.

import { computeIdentity } from "./validation.js";

const DB_NAME = "meus-drinks-catalog-db";
const DB_VERSION = 1;
const CHANNEL_NAME = "meus-drinks-sync";

let openPromise = null;
let channel = null;

function getChannel() {
  if (channel) return channel;
  if (typeof BroadcastChannel === "undefined") return null;
  channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

/** Notify other tabs that data changed, so they can refresh their view. */
function broadcastChange(kind) {
  const ch = getChannel();
  if (ch) ch.postMessage({ kind, at: Date.now() });
}

export function onRemoteChange(handler) {
  const ch = getChannel();
  if (!ch) return () => {};
  const listener = (event) => handler(event.data);
  ch.addEventListener("message", listener);
  return () => ch.removeEventListener("message", listener);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function openDb() {
  if (openPromise) return openPromise;
  openPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains("records")) {
        const store = db.createObjectStore("records", { keyPath: "id" });
        store.createIndex("identity", "identity", { unique: true });
        store.createIndex("created_at", "created_at", { unique: false });
      }
      if (!db.objectStoreNames.contains("photos")) {
        db.createObjectStore("photos", { keyPath: "recordId" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
      // Future schema changes: migrate existing records here, preserving
      // ids, timestamps, ratings, comments and photos. Never recreate the
      // database as a shortcut.
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        openPromise = null;
      };
      resolve(db);
    };

    req.onerror = () => {
      openPromise = null;
      reject(req.error);
    };

    req.onblocked = () => {
      // Another tab is holding an older version open; the caller's promise
      // will resolve once it closes, or the open attempt errors out.
    };
  });
  return openPromise;
}

async function withTransaction(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
    Promise.resolve(fn(tx))
      .then((r) => {
        result = r;
      })
      .catch((err) => {
        try {
          tx.abort();
        } catch (_) {
          /* already aborting */
        }
        reject(err);
      });
  });
}

async function getMetaValue(tx, key, fallback) {
  const store = tx.objectStore("meta");
  const row = await reqToPromise(store.get(key));
  return row ? row.value : fallback;
}

function setMetaValue(tx, key, value) {
  tx.objectStore("meta").put({ key, value });
}

async function bumpRevision(tx) {
  const current = await getMetaValue(tx, "revision", 0);
  const next = current + 1;
  setMetaValue(tx, "revision", next);
  return next;
}

export async function getRevisionInfo() {
  return withTransaction(["meta"], "readonly", async (tx) => {
    const revision = await getMetaValue(tx, "revision", 0);
    const backedUpRevision = await getMetaValue(tx, "backedUpRevision", 0);
    const lastBackupAt = await getMetaValue(tx, "lastBackupAt", null);
    return { revision, backedUpRevision, lastBackupAt };
  });
}

export async function markBackedUp(revision) {
  return withTransaction(["meta"], "readwrite", async (tx) => {
    setMetaValue(tx, "backedUpRevision", revision);
    setMetaValue(tx, "lastBackupAt", new Date().toISOString());
  });
}

function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Creates a new record. `drink` is validated drink field data,
 * `extra` is { rating, comment, status }, `photos` is
 * { primary?: {blob, name, type}, secondary?: {blob, name, type} }.
 */
export async function createRecord(drink, extra, photos) {
  const now = new Date().toISOString();
  const identity = computeIdentity(drink);
  const record = {
    id: makeId(),
    identity,
    import_data: drink,
    rating: extra.rating ?? null,
    comment: extra.comment ?? "",
    status: extra.status ?? "want_to_try",
    has_primary_photo: !!(photos && photos.primary),
    has_secondary_photo: !!(photos && photos.secondary),
    created_at: now,
    updated_at: now,
  };

  await withTransaction(["records", "photos", "meta"], "readwrite", async (tx) => {
    const existing = await reqToPromise(tx.objectStore("records").index("identity").get(identity));
    if (existing) {
      throw new DuplicateIdentityError(existing);
    }
    tx.objectStore("records").add(record);
    if (photos && (photos.primary || photos.secondary)) {
      tx.objectStore("photos").put({
        recordId: record.id,
        primaryPhoto: photos.primary || null,
        secondaryPhoto: photos.secondary || null,
      });
    }
    await bumpRevision(tx);
  });

  broadcastChange("write");
  return record;
}

export class DuplicateIdentityError extends Error {
  constructor(existingRecord) {
    super("Já existe um drink com o mesmo nome, base e fonte.");
    this.name = "DuplicateIdentityError";
    this.existingRecord = existingRecord;
  }
}

export class ConcurrencyError extends Error {
  constructor() {
    super("Este drink foi alterado em outra aba. Reabra o registro.");
    this.name = "ConcurrencyError";
  }
}

export async function listRecords() {
  return withTransaction(["records"], "readonly", async (tx) => {
    return reqToPromise(tx.objectStore("records").getAll());
  });
}

export async function getRecord(id) {
  return withTransaction(["records"], "readonly", async (tx) => {
    return reqToPromise(tx.objectStore("records").get(id));
  });
}

export async function getPhotos(recordId) {
  return withTransaction(["photos"], "readonly", async (tx) => {
    const row = await reqToPromise(tx.objectStore("photos").get(recordId));
    return row || { recordId, primaryPhoto: null, secondaryPhoto: null };
  });
}

/**
 * Updates a record. `expectedUpdatedAt` must match the currently stored
 * updated_at (optimistic concurrency). `patch` may include drink fields
 * (import_data), rating, comment, status, and photos ({primary, secondary}
 * — pass `undefined` to leave a slot untouched, `null` to clear it).
 */
export async function updateRecord(id, expectedUpdatedAt, patch) {
  let updated;
  await withTransaction(["records", "photos", "meta"], "readwrite", async (tx) => {
    const store = tx.objectStore("records");
    const current = await reqToPromise(store.get(id));
    if (!current) throw new Error("Registro não encontrado.");
    if (current.updated_at !== expectedUpdatedAt) throw new ConcurrencyError();

    let identity = current.identity;
    let import_data = current.import_data;
    if (patch.drink) {
      import_data = patch.drink;
      identity = computeIdentity(patch.drink);
      if (identity !== current.identity) {
        const clash = await reqToPromise(store.index("identity").get(identity));
        if (clash && clash.id !== id) throw new DuplicateIdentityError(clash);
      }
    }

    if (patch.photos !== undefined) {
      const photoStore = tx.objectStore("photos");
      const row = (await reqToPromise(photoStore.get(id))) || {
        recordId: id,
        primaryPhoto: null,
        secondaryPhoto: null,
      };
      if (patch.photos.primary !== undefined) row.primaryPhoto = patch.photos.primary;
      if (patch.photos.secondary !== undefined) row.secondaryPhoto = patch.photos.secondary;
      if (row.primaryPhoto || row.secondaryPhoto) {
        photoStore.put(row);
      } else {
        photoStore.delete(id);
      }
      current.has_primary_photo = !!row.primaryPhoto;
      current.has_secondary_photo = !!row.secondaryPhoto;
    }

    updated = {
      ...current,
      identity,
      import_data,
      rating: patch.rating !== undefined ? patch.rating : current.rating,
      comment: patch.comment !== undefined ? patch.comment : current.comment,
      status: patch.status !== undefined ? patch.status : current.status,
      updated_at: new Date().toISOString(),
    };
    store.put(updated);
    await bumpRevision(tx);
  });
  broadcastChange("write");
  return updated;
}

export async function deleteRecord(id, expectedUpdatedAt) {
  await withTransaction(["records", "photos", "meta"], "readwrite", async (tx) => {
    const store = tx.objectStore("records");
    const current = await reqToPromise(store.get(id));
    if (!current) return; // already gone
    if (current.updated_at !== expectedUpdatedAt) throw new ConcurrencyError();
    store.delete(id);
    tx.objectStore("photos").delete(id);
    await bumpRevision(tx);
  });
  broadcastChange("write");
}

/**
 * Imports records from a backup file. `items` is an array of
 * { record, primaryPhoto, secondaryPhoto } where record has import_data,
 * rating, comment, status, created_at, updated_at (already validated).
 * `resolutions` maps identity -> "keep" | "replace" for duplicates found
 * during a prior dry run; identities absent from the map are treated as new.
 * Runs as one atomic transaction. Returns { added, replaced, kept }.
 */
export async function importRecords(items, resolutions) {
  let counts = { added: 0, replaced: 0, kept: 0 };
  await withTransaction(["records", "photos", "meta"], "readwrite", async (tx) => {
    const store = tx.objectStore("records");
    const photoStore = tx.objectStore("photos");
    const idIndex = store.index("identity");

    for (const item of items) {
      const identity = computeIdentity(item.record.import_data);
      const existing = await reqToPromise(idIndex.get(identity));
      if (existing) {
        const resolution = resolutions[identity] || "keep";
        if (resolution === "keep") {
          counts.kept += 1;
          continue;
        }
        const merged = {
          ...item.record,
          id: existing.id,
          identity,
          created_at: existing.created_at,
          updated_at: new Date().toISOString(),
        };
        store.put(merged);
        if (item.primaryPhoto || item.secondaryPhoto) {
          photoStore.put({
            recordId: existing.id,
            primaryPhoto: item.primaryPhoto || null,
            secondaryPhoto: item.secondaryPhoto || null,
          });
        } else {
          photoStore.delete(existing.id);
        }
        counts.replaced += 1;
      } else {
        const id = makeId();
        const fresh = { ...item.record, id, identity };
        store.add(fresh);
        if (item.primaryPhoto || item.secondaryPhoto) {
          photoStore.put({
            recordId: id,
            primaryPhoto: item.primaryPhoto || null,
            secondaryPhoto: item.secondaryPhoto || null,
          });
        }
        counts.added += 1;
      }
    }
    if (counts.added || counts.replaced) await bumpRevision(tx);
  });
  broadcastChange("restore");
  return counts;
}

/** Read-only snapshot of everything, for export. Returns records+photos+revision together. */
export async function exportSnapshot() {
  return withTransaction(["records", "photos", "meta"], "readonly", async (tx) => {
    const records = await reqToPromise(tx.objectStore("records").getAll());
    const photoRows = await reqToPromise(tx.objectStore("photos").getAll());
    const revision = await getMetaValue(tx, "revision", 0);
    const photosByRecord = new Map(photoRows.map((r) => [r.recordId, r]));
    return { records, photosByRecord, revision };
  });
}

/** Check whether an identity already exists, for pre-flight duplicate checks. */
export async function findByIdentity(identity) {
  return withTransaction(["records"], "readonly", async (tx) => {
    return reqToPromise(tx.objectStore("records").index("identity").get(identity));
  });
}
