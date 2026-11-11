(() => {
  'use strict';

  const CHANNEL_MAIN_TO_ISO = 'POLYPILOT_MAIN_TO_ISO_V1';
  const CHANNEL_ISO_TO_MAIN = 'POLYPILOT_ISO_TO_MAIN_V1';
  const IDB_NAME = 'PolyPilotBrainsDB_v1';
  const IDB_STORE = 'track_brains';
  const EXT_PREFIX = 'polypilot_brain::';

  class BrainStorage {
    constructor() {
      this._dbPromise = null;
      this._reqCounter = 0;
      this._pending = new Map();

      window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || event.data.__channel !== CHANNEL_ISO_TO_MAIN) {
          return;
        }
        const { type, payload, reqId } = event.data;
        if (type === 'STORAGE_RES' && reqId && this._pending.has(reqId)) {
          const { resolve } = this._pending.get(reqId);
          this._pending.delete(reqId);
          resolve(payload);
        } else if (type === 'POPUP_COMMAND' && typeof this.onPopupCommand === 'function') {
          this.onPopupCommand(payload);
        }
      });
      this.onPopupCommand = null;
    }

    _openDB() {
      if (this._dbPromise) return this._dbPromise;
      this._dbPromise = new Promise((resolve, reject) => {
        try {
          const req = indexedDB.open(IDB_NAME, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
              db.createObjectStore(IDB_STORE, { keyPath: 'trackId' });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        } catch (err) {
          reject(err);
        }
      });
      return this._dbPromise;
    }

    _callExtensionBridge(type, payload, timeoutMs = 220) {
      return new Promise((resolve) => {
        const reqId = 'req_' + (++this._reqCounter) + '_' + Date.now();
        const timer = setTimeout(() => {
          this._pending.delete(reqId);
          resolve({ ok: false, timeout: true });
        }, timeoutMs);

        this._pending.set(reqId, {
          resolve: (res) => {
            clearTimeout(timer);
            resolve(res || { ok: false });
          }
        });

        window.postMessage({
          __channel: CHANNEL_MAIN_TO_ISO,
          type,
          payload,
          reqId
        }, '*');
      });
    }

    publishStatus(snapshot) {
      window.postMessage({
        __channel: CHANNEL_MAIN_TO_ISO,
        type: 'STATUS_SNAPSHOT',
        payload: snapshot
      }, '*');
    }

    async saveTrackBundle(trackId, bundle) {
      const record = Object.assign({}, bundle, {
        trackId,
        savedAt: Date.now(),
        format: 'polypilot.trackbrain.v1'
      });

      // 1. Save to IndexedDB for fast synchronous-feeling local origin persistence
      try {
        const db = await this._openDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (_) {}

      // 2. Mirror to extension-wide chrome.storage.local so brains work across subdomains/mirrors
      try {
        await this._callExtensionBridge('STORAGE_SET', {
          items: {
            [EXT_PREFIX + trackId]: record
          }
        });
      } catch (_) {}

      return record;
    }

    async loadTrackBundle(trackId) {
      let idbRec = null;
      try {
        const db = await this._openDB();
        idbRec = await new Promise((resolve) => {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const req = tx.objectStore(IDB_STORE).get(trackId);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        });
      } catch (_) {}

      let extRec = null;
      try {
        const res = await this._callExtensionBridge('STORAGE_GET', { key: EXT_PREFIX + trackId });
        if (res && res.ok && res.data) extRec = res.data;
      } catch (_) {}

      if (idbRec && extRec) {
        return (extRec.savedAt || 0) > (idbRec.savedAt || 0) ? extRec : idbRec;
      }
      return extRec || idbRec || null;
    }

    async listSavedTracks() {
      const map = new Map();
      try {
        const db = await this._openDB();
        const all = await new Promise((resolve) => {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const req = tx.objectStore(IDB_STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        });
        for (const item of all) {
          if (item && item.trackId) map.set(item.trackId, item);
        }
      } catch (_) {}

      try {
        const res = await this._callExtensionBridge('STORAGE_GET', { key: null });
        if (res && res.ok && res.data) {
          for (const [k, v] of Object.entries(res.data)) {
            if (k.startsWith(EXT_PREFIX) && v && v.trackId) {
              const prev = map.get(v.trackId);
              if (!prev || (v.savedAt || 0) > (prev.savedAt || 0)) {
                map.set(v.trackId, v);
              }
            }
          }
        }
      } catch (_) {}

      return Array.from(map.values())
        .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
        .map((r) => ({
          trackId: r.trackId,
          trackName: r.trackName || r.trackId,
          episodesTrained: r.brain?.episodesTrained || 0,
          topRunsCount: Array.isArray(r.topRuns) ? r.topRuns.length : 0,
          bestTimeMs: r.topRuns?.[0]?.finishTimeMs ?? null,
          savedAt: r.savedAt
        }));
    }

    async deleteTrackBundle(trackId) {
      try {
        const db = await this._openDB();
        await new Promise((resolve) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).delete(trackId);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      } catch (_) {}
      try {
        await this._callExtensionBridge('STORAGE_REMOVE', { keys: [EXT_PREFIX + trackId] });
      } catch (_) {}
    }

    exportToDiskFile(bundle) {
      const payload = JSON.stringify(bundle, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const safeName = (bundle.trackName || bundle.trackId || 'polytrack')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .slice(0, 40);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}.polybrain.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 400);
      return payload.length;
    }

    parseImportedJson(jsonText) {
      const parsed = JSON.parse(jsonText);
      if (!parsed || !parsed.brain || !parsed.brain.weightsB64) {
        throw new Error('Invalid .polybrain.json file: missing neural weights.');
      }
      return parsed;
    }
  }

  window.PolyPilotStorage = {
    BrainStorage
  };
})();
