/* ═══════════════════════════════════════════════════════════════════
   core/bus.js — tiny synchronous event emitter

   The ONLY sanctioned way for one feature to talk to another.
   No feature may import another feature; they emit and listen here.

   Event names are namespaced "<feature>:<verb>":
     editor:open      { path }            chat wants a file opened
     editor:insert    { code }            chat wants code inserted
     editor:saved     { path }            editor finished a write
     editor:modified  { path, dirty }     dirty-flag changed
     files:changed    { path }            tree needs a refresh
     files:refresh    {}                  force tree reload
     terminal:run     { cmd }             run a command in the pty
     terminal:focus   {}
     chat:send        { text }            inject a prompt into chat
     chat:stop        {}
     panel:switch     { name }            chat|editor|terminal|files
     project:change   { name }            currentProject changed
     backend:status   { online }
   ═══════════════════════════════════════════════════════════════════ */

const listeners = new Map();

/**
 * Subscribe to an event.
 * @param {string} event
 * @param {(payload:any)=>void} fn
 * @returns {()=>void} unsubscribe
 */
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => off(event, fn);
}

/** Subscribe once. */
export function once(event, fn) {
  const un = on(event, (payload) => { un(); fn(payload); });
  return un;
}

/** Unsubscribe. */
export function off(event, fn) {
  const set = listeners.get(event);
  if (set) set.delete(fn);
}

/**
 * Emit synchronously. A throwing listener must never break the emitter,
 * so each handler is isolated.
 */
export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set || set.size === 0) return;
  // Copy so a handler that unsubscribes mid-dispatch doesn't skip others.
  for (const fn of Array.from(set)) {
    try {
      fn(payload);
    } catch (err) {
      console.error('[bus] listener for "' + event + '" threw:', err);
    }
  }
}

/** Remove every listener (used by tests / full teardown). */
export function clear() {
  listeners.clear();
}

/** Debug helper: list registered event names and counts. */
export function inspect() {
  const out = {};
  for (const [k, v] of listeners) out[k] = v.size;
  return out;
}

export default { on, once, off, emit, clear, inspect };
