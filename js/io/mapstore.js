// Persistence for the attached race map file.
//
// The raster deliberately does NOT live in the app state: a page of this map
// rendered to JPEG is ~6 MB, and localStorage — where the rest of the state
// goes — caps out around 5 MB for everything combined. So IndexedDB holds the
// bytes, while state.js keeps only the calibration and the file's identity.
// That also keeps "Vie JSON" small enough to email.

const DB_NAME = "kisa-ennustaja";
const DB_VERSION = 1;
const STORE = "mapFiles";
const KEY = "current";

// Bumped whenever the stored file changes, so a view caching the decoded
// raster can tell a replaced file apart from one with the same name.
let revision = 0;
export function mapRevision() { return revision; }

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB ei aukea"));
    req.onblocked = () => reject(new Error("IndexedDB on lukittu toisessa välilehdessä"));
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error || new Error("IndexedDB-kirjoitus epäonnistui"));
    t.onabort = () => reject(t.error || new Error("IndexedDB-kirjoitus keskeytyi"));
  });
}

// Store the user's map file. `file` is a File or Blob from an <input type=file>.
export async function putMapFile(file) {
  const db = await openDb();
  try {
    const record = {
      name: file.name || "kartta",
      type: file.type || "application/octet-stream",
      size: file.size,
      blob: file
    };
    await tx(db, "readwrite", store => store.put(record, KEY));
    revision++;
    return record;
  } finally {
    db.close();
  }
}

// Returns { name, type, size, blob } or null when nothing is attached.
export async function getMapFile() {
  const db = await openDb();
  try {
    return (await tx(db, "readonly", store => store.get(KEY))) || null;
  } finally {
    db.close();
  }
}

export async function clearMapFile() {
  const db = await openDb();
  try {
    await tx(db, "readwrite", store => store.delete(KEY));
    revision++;
  } finally {
    db.close();
  }
}
