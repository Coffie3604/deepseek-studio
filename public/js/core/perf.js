/* ═══════════════════════════════════════════════════════════════════
   core/perf.js — frame-level scheduling helpers for UI & UX.

   Why this exists: the legacy renderer rebuilt whole DOM subtrees
   (file tree, editor tab strip, activity feed) on *every* state change,
   synchronously. Toggling five folders in a row meant five full
   innerHTML teardowns in the same tick, each forcing layout. On a
   phone that is the difference between "responsive" and "janky".

   Two primitives:

     schedule(key, fn)   coalesces all calls with the same `key` into a
                         single run on the next animation frame. Calling
                         it 20x in one tick still renders once.
                         `key === false` behaves like a plain rAF queue.

     idle(fn)            runs `fn` when the browser is idle (or after a
                         short timeout fallback) — for non-critical work
                         like prefetching or analytics.

   Both are tear-off safe: `schedule` returns a cancel function, and a
   feature's destroy() can cancel its pending frame so a torn-down panel
   never renders into a detached DOM node.
   ═══════════════════════════════════════════════════════════════════ */

/** @type {Map<string, Function>} */
const pending = new Map();
let frame = 0;

function flush() {
  frame = 0;
  // Snapshot first: a render fn may schedule more work (e.g. tree render
  // discovers children), and we don't want to iterate a mutating map.
  const jobs = Array.from(pending.entries());
  pending.clear();
  for (const [key, fn] of jobs) {
    try {
      fn();
    } catch (err) {
      console.error('[perf] scheduled render "' + key + '" threw', err);
    }
  }
}

/**
 * Coalesce work into the next animation frame.
 * @param {string|false} key  dedupe key; same key replaces earlier fn
 * @param {Function} fn
 * @returns {() => void} cancel — no-op if it already ran
 */
export function schedule(key, fn) {
  const k = key || '\u0000anon';
  pending.set(k, fn);
  if (!frame) frame = requestAnimationFrame(flush);
  return () => {
    // Only cancel if this key still holds *our* function.
    if (pending.get(k) === fn) pending.delete(k);
  };
}

/** Run `fn` once, on the next frame, at most one queued instance. */
export function nextFrame(fn) {
  return schedule(false, fn);
}

/** Drop a queued job without running it. */
export function cancel(key) {
  if (key) pending.delete(key);
}

/** Run on idle, with a timeout so it always happens. */
export function idle(fn, timeoutMs) {
  if (typeof requestIdleCallback === 'function') {
    return requestIdleCallback(fn, { timeout: timeoutMs || 2000 });
  }
  return setTimeout(fn, Math.min(timeoutMs || 2000, 200));
}

/**
 * Memoise a pure function keyed by its first argument.
 * Used for the hot icon/color lookups that run once per tree row.
 * @param {(k:any)=>any} fn
 * @param {number} [limit]
 */
export function memo1(fn, limit) {
  const cache = new Map();
  const max = limit || 500;
  return function (k) {
    if (cache.has(k)) return cache.get(k);
    const v = fn(k);
    if (cache.size >= max) cache.clear();
    cache.set(k, v);
    return v;
  };
}

/** True when the user asked the OS to reduce motion (accessibility). */
export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (err) {
    return false;
  }
}

export default { schedule, nextFrame, cancel, idle, memo1, prefersReducedMotion };
