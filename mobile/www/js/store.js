'use strict';
// Saved projects and their media, kept in the app's own storage on the phone (IndexedDB), so
// projects open again exactly as they were, even if the originals are moved or deleted.

const Store = (() => {
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('snippy', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('media')) d.createObjectStore('media', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
          if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then((r) => { out = r; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage was full or unavailable'));
    });
  }
  const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

  return {
    async projects() {
      const all = await tx('projects', 'readonly', (s) => req(s.getAll()));
      return (all || []).sort((a, b) => b.updated - a.updated);
    },
    getProject: (id) => tx('projects', 'readonly', (s) => req(s.get(id))),
    putProject: (p) => tx('projects', 'readwrite', (s) => { s.put(p); }),
    deleteProject: (id) => tx('projects', 'readwrite', (s) => { s.delete(id); }),
    getMedia: (id) => tx('media', 'readonly', (s) => req(s.get(id))),
    putMedia: (m) => tx('media', 'readwrite', (s) => { s.put(m); }),
    deleteMedia: (id) => tx('media', 'readwrite', (s) => { s.delete(id); }),
    allMedia: () => tx('media', 'readonly', (s) => req(s.getAll())),
    getBlob: (id) => tx('blobs', 'readonly', (s) => req(s.get(id))),
    putBlob: (id, blob) => tx('blobs', 'readwrite', (s) => { s.put(blob, id); }),
    deleteBlob: (id) => tx('blobs', 'readwrite', (s) => { s.delete(id); }),
    getCache: (k) => tx('cache', 'readonly', (s) => req(s.get(k))),
    putCache: (k, v) => tx('cache', 'readwrite', (s) => { s.put(v, k); }),
    // Media no project uses any more is removed, to free space.
    async tidy() {
      const ps = await this.projects();
      const used = new Set(ps.flatMap((p) => (p.data && p.data.media) || []));
      for (const m of await this.allMedia()) {
        if (!used.has(m.id)) { await this.deleteMedia(m.id); await this.deleteBlob(m.id); }
      }
    },
  };
})();
