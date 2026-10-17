/* ═══════════════════════════════════════════════════════════════════
   core/state.js — the single mutable store

   Replaces the ~45 `var` globals that used to sit at the top of the
   inline <script>. Features never declare module-level mutable state;
   they read/write through here so the lifecycle (init/destroy) can
   reset a feature cleanly when the mobile panel switches.

   Two kinds of state:
     - plain values      state.get('openFile') / state.set('openFile', p)
     - persisted values  state.persist('bookmarks', []) — auto-saved to
                         localStorage under "ds_<key>" and rehydrated on
                         load. JSON parse failures fall back to the
                         default instead of throwing (the old code threw
                         silently on a corrupt entry).
   ═══════════════════════════════════════════════════════════════════ */

import { emit } from './bus.js';

const LS_PREFIX = 'ds_';

/** @type {Map<string, any>} */
const store = new Map();
/** @type {Map<string, any>} */
const defaults = new Map();
/** @type {Set<string>} */
const persisted = new Set();
/** @type {Map<string, Set<Function>>} */
const watchers = new Map();

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[state] corrupt localStorage entry "' + key + '", using default', err);
    return fallback;
  }
}

function writeLS(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    return true;
  } catch (err) {
    // QuotaExceededError on long chat sessions — the old code swallowed
    // this. Surface it so the UI can warn instead of losing data silently.
    console.warn('[state] could not persist "' + key + '"', err);
    emit('state:persist-failed', { key, error: err });
    return false;
  }
}

/**
 * Declare a state key. Safe to call repeatedly (idempotent) so a feature
 * can declare its own slice in init().
 * @param {string} key
 * @param {any} defaultValue
 * @param {{persist?: boolean}} [opts]
 */
export function define(key, defaultValue, opts) {
  const persist = !!(opts && opts.persist);
  defaults.set(key, defaultValue);
  if (persist) persisted.add(key);
  if (!store.has(key)) {
    store.set(key, persist ? readLS(key, defaultValue) : defaultValue);
  }
  return store.get(key);
}

/** Read a value. */
export function get(key) {
  return store.get(key);
}

/**
 * Write a value. Notifies watchers and emits "state:<key>".
 * Persisted keys are written to localStorage.
 */
export function set(key, value) {
  const prev = store.get(key);
  if (prev === value) return value;
  store.set(key, value);
  if (persisted.has(key)) writeLS(key, value);
  const set_ = watchers.get(key);
  if (set_) {
    for (const fn of Array.from(set_)) {
      try { fn(value, prev); } catch (err) { console.error('[state] watcher threw', err); }
    }
  }
  emit('state:' + key, { value, prev });
  return value;
}

/** Reset a key to its declared default (used by feature destroy()). */
export function reset(key) {
  if (!defaults.has(key)) return undefined;
  const d = defaults.get(key);
  // Deep-ish copy so a reset array/object isn't shared with the default.
  const fresh = Array.isArray(d) ? d.slice() : (d && typeof d === 'object' ? Object.assign({}, d) : d);
  return set(key, fresh);
}

/**
 * Watch a key. Returns an unsubscribe function.
 * @param {string} key
 * @param {(value:any, prev:any)=>void} fn
 */
export function watch(key, fn) {
  if (!watchers.has(key)) watchers.set(key, new Set());
  watchers.get(key).add(fn);
  return () => {
    const s = watchers.get(key);
    if (s) s.delete(fn);
  };
}

/** Convenience: read-modify-write for arrays. */
export function push(key, item, cap) {
  const arr = (get(key) || []).slice();
  arr.push(item);
  if (cap && arr.length > cap) arr.splice(0, arr.length - cap);
  return set(key, arr);
}

/** Convenience: remove by predicate from an array key. */
export function removeWhere(key, predicate) {
  const arr = get(key) || [];
  return set(key, arr.filter((x) => !predicate(x)));
}

/** Snapshot for debugging. */
export function snapshot() {
  const out = {};
  for (const [k, v] of store) out[k] = v;
  return out;
}

export default { define, get, set, reset, watch, push, removeWhere, snapshot };
