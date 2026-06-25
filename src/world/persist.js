/* ------------------------------------------------------------------ *
 *  Inversia — persistence + file I/O (Phase 8)
 *
 *  The plumbing behind "never lose work" and "save / share a world":
 *    - IndexedDB AUTOSAVE of the working state (recipe + view preferences). The
 *      recipe already round-trips through the URL hash, but the hash only travels
 *      when someone copies the link; the autosave is the local safety net so a
 *      plain reload restores exactly what you had. It is also the substrate the
 *      Phase 10 overrides layer will attach to (we store a whole state object, not
 *      just the recipe, so adding an `overrides` key later is a non-event).
 *    - small FILE helpers (download a Blob, pick a File) used by the recipe-JSON
 *      export/import and the "Download world" bundle in bake.js.
 *
 *  Everything here degrades quietly: private-mode / blocked storage just means no
 *  autosave, never a thrown error into the app.
 * ------------------------------------------------------------------ */

const DB_NAME = "inversia";
const DB_VERSION = 1;
const STORE = "state";
const KEY = "working";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/**
 * Read the autosaved working state, or null when there's nothing stored / storage
 * is unavailable. Shape: `{ recipe, view: { style, layerVisibility }, savedAt }`.
 */
export async function loadState() {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

let saveTimer = 0;
let pendingState = null;

/**
 * Autosave the working state, debounced so a slider drag writes once on settle
 * rather than per frame. `state` is captured by reference at flush time, so pass a
 * snapshot if the caller keeps mutating it (the app passes a freshly built object).
 */
export function saveState(state, { debounce = 400 } = {}) {
  pendingState = state;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, debounce);
}

async function flush() {
  const state = pendingState;
  if (!state) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ...state, savedAt: Date.now() }, KEY);
  } catch {
    /* storage blocked — no autosave this session */
  }
}

// ---- file helpers --------------------------------------------------------

/** Trigger a browser download of `data` (string or Blob) as `filename`. */
export function downloadFile(filename, data, mime = "application/json") {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // give the click a tick to start before we revoke the object URL
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Open the OS file picker and resolve with the chosen File (or null if cancelled). */
export function pickFile(accept = "application/json,.json") {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files?.[0] || null), { once: true });
    // some browsers fire no event on cancel; this is best-effort and harmless.
    input.click();
  });
}
