// IndexedDB の薄い Promise ラッパー
// stores:
//   exercises: {id(auto), name, part}
//   sessions:  {date 'YYYY-MM-DD', entries: [{exId, sets: [{w, r}]}]}
//   settings:  {key, value}

const DB_NAME = 'kintore';
const DB_VERSION = 1;

const db = {
  _db: null,

  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('exercises')) {
          d.createObjectStore('exercises', { keyPath: 'id', autoIncrement: true });
        }
        if (!d.objectStoreNames.contains('sessions')) {
          d.createObjectStore('sessions', { keyPath: 'date' });
        }
        if (!d.objectStoreNames.contains('settings')) {
          d.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => { this._db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },

  _tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  getAll(store) { return this._tx(store, 'readonly', s => s.getAll()); },
  get(store, key) { return this._tx(store, 'readonly', s => s.get(key)); },
  put(store, value) { return this._tx(store, 'readwrite', s => s.put(value)); },
  add(store, value) { return this._tx(store, 'readwrite', s => s.add(value)); },
  del(store, key) { return this._tx(store, 'readwrite', s => s.delete(key)); },
  clear(store) { return this._tx(store, 'readwrite', s => s.clear()); },
};
