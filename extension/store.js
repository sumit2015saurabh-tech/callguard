/* Storage shared by the service worker, the offscreen recorder and the popup.
   Clip metadata in `clips`, the audio itself in `blobs` (keyed by clip id), one row per call in `sessions`.
   IndexedDB rather than chrome.storage: audio blobs are big and must stay binary. */
(() => {
  const NAME = "callguard-ext";
  const VERSION = 1;
  let opening = null;

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("clips")) db.createObjectStore("clips", { keyPath: "id" });
        if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
        if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return opening;
  }

  async function tx(storeName, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const req = fn(t.objectStore(storeName));
      t.oncomplete = () => resolve(req && "result" in req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const store = {
    async addClip(clip, blob) {
      await tx("blobs", "readwrite", (s) => s.put(blob, clip.id));
      await tx("clips", "readwrite", (s) => s.put(clip));
      return clip;
    },
    clips: () => tx("clips", "readonly", (s) => s.getAll()),
    clip: (id) => tx("clips", "readonly", (s) => s.get(id)),
    blob: (id) => tx("blobs", "readonly", (s) => s.get(id)),
    async patchClip(id, patch) {
      const clip = await store.clip(id);
      if (!clip) return null;
      Object.assign(clip, patch);
      await tx("clips", "readwrite", (s) => s.put(clip));
      return clip;
    },
    async deleteClip(id) {
      await tx("clips", "readwrite", (s) => s.delete(id));
      await tx("blobs", "readwrite", (s) => s.delete(id));
    },
    async clear() {
      await tx("clips", "readwrite", (s) => s.clear());
      await tx("blobs", "readwrite", (s) => s.clear());
      await tx("sessions", "readwrite", (s) => s.clear());
    },
    saveSession: (session) => tx("sessions", "readwrite", (s) => s.put(session)),
  };

  self.CGStore = store;
})();
