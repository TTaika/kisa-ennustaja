// Persists which <details class="card">/<details class="print-page"> sections
// a user has collapsed, so that choice survives a reload. Only collapsed
// (closed) keys are stored — a card nobody has touched, including any added
// later, defaults to open with no migration needed.
const STORAGE_KEY = "kisa-ennustaja:collapsed:v1";

function loadCollapsedSet() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedSet() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // localStorage unavailable (private mode / quota) — collapse memory is a
    // convenience, not critical data, so just skip persisting.
  }
}

let collapsed = loadCollapsedSet();

export function isCollapsed(key) {
  return collapsed.has(key);
}

// js/util/printExpand.js force-opens every <details> before printing and
// restores prior state after — those are programmatic, not a real user
// choice, and must never be recorded here. Setting the `open` IDL property
// queues a `toggle` event asynchronously (HTML spec), so the suppression
// window has to stay open past the synchronous mutations themselves; a
// task queued via setTimeout(...,0) AFTER the mutations runs after any
// `toggle` events queued by those mutations (FIFO task order), so it's a
// reliable point to lift the suppression.
let suppressed = false;
export function suppressPersistence(duringFn) {
  suppressed = true;
  try {
    duringFn();
  } finally {
    setTimeout(() => { suppressed = false; }, 0);
  }
}

// Sets the element's initial open state from storage and wires persistence
// for any future real toggle (user click/keyboard activation on <summary>).
export function bindCollapse(detailsEl, key) {
  detailsEl.open = !isCollapsed(key);
  detailsEl.addEventListener("toggle", () => {
    if (suppressed) return;
    if (detailsEl.open) collapsed.delete(key);
    else collapsed.add(key);
    saveCollapsedSet();
  });
}
