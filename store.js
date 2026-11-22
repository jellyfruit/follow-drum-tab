/* follow-drum-tab song library: IndexedDB with a localStorage fallback.
 * Record: { id, title, artist, json (song text), youtubeId, sync: {anchors, offset}, metronome,
 *           progress: {level, stars, graduated, plays}, rate, lastSection, added, updated }
 */
(function (root) {
  'use strict';
  const DB = 'follow-drum-tab', STORE = 'songs', LS = 'fdt.songs.v1';
  let dbp = null;

  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
    return dbp;
  }

  // localStorage fallback (private browsing, old devices)
  const lsAll = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { return {}; } };
  const lsSave = (m) => { try { localStorage.setItem(LS, JSON.stringify(m)); } catch (e) {} };

  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const st = t.objectStore(STORE);
      const r = fn(st);
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }

  const api = {
    async list() {
      const db = await openDB();
      const rows = db ? await tx(db, 'readonly', (st) => st.getAll()) : Object.values(lsAll());
      return (rows || []).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    },
    async get(id) {
      const db = await openDB();
      return db ? tx(db, 'readonly', (st) => st.get(id)) : lsAll()[id];
    },
    async put(rec) {
      rec.updated = Date.now();
      const db = await openDB();
      if (db) await tx(db, 'readwrite', (st) => st.put(rec));
      else { const m = lsAll(); m[rec.id] = rec; lsSave(m); }
      return rec;
    },
    async del(id) {
      const db = await openDB();
      if (db) await tx(db, 'readwrite', (st) => st.delete(id));
      else { const m = lsAll(); delete m[id]; lsSave(m); }
    },
    newId(title) {
      const slug = String(title || 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'song';
      return slug + '-' + Date.now().toString(36);
    },
    // Ask the browser not to evict our data (Safari honours this for home-screen apps).
    async persist() {
      try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {}
      return false;
    },
  };
  root.FDTStore = api;
})(window);
