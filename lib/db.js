// Penyimpanan hasil tangkapan di IndexedDB (dipakai service worker & halaman editor).
const DB_NAME = 'fullsnap';
const STORE = 'captures';
const KEEP_LATEST = 15;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('time', 'time');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function putCapture(record) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(record);
  await txDone(tx);
  await prune(db);
  db.close();
}

export async function getCapture(id) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).get(id);
  const result = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

export async function getLatestId() {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).index('time').openKeyCursor(null, 'prev');
  const id = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result ? req.result.primaryKey : null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return id;
}

async function prune(db) {
  const tx = db.transaction(STORE, 'readwrite');
  const index = tx.objectStore(STORE).index('time');
  const keys = await new Promise((resolve, reject) => {
    const req = index.getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // keys diurutkan berdasarkan waktu (lama → baru)
  const excess = keys.length - KEEP_LATEST;
  for (let i = 0; i < excess; i++) tx.objectStore(STORE).delete(keys[i]);
  await txDone(tx);
}
