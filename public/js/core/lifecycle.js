/* ═══════════════════════════════════════════════════════════════════
   core/lifecycle.js — feature registry + panel switching

   Every feature module exports:
     init()      — bind DOM, subscribe to the bus, create heavy objects
     destroy()   — unbind, unsubscribe, dispose heavy objects
     mount()     — optional: called when its panel becomes visible
     unmount()   — optional: called when its panel is hidden

   Why this exists: on a phone, Monaco + xterm + the chat DOM all alive
   at once is the main source of jank. Switching panels now destroys the
   inactive feature's heavy objects and re-inits on return, instead of
   keeping three engines resident.

   A feature is registered with a `heavy` flag. Only heavy features are
   torn down on switch; light ones (files tree, git) stay mounted.
   ═══════════════════════════════════════════════════════════════════ */

import { emit } from './bus.js';

/** @type {Map<string, {mod:any, heavy:boolean, mounted:boolean, inited:boolean}>} */
const registry = new Map();

let activePanel = null;

/**
 * @param {string} name
 * @param {object} mod  module namespace with init/destroy/mount/unmount
 * @param {{heavy?:boolean}} [opts]
 */
export function register(name, mod, opts) {
  registry.set(name, {
    mod,
    heavy: !!(opts && opts.heavy),
    mounted: false,
    inited: false,
  });
}

/** Init every registered feature. Failures are isolated per feature. */
export async function initAll() {
  for (const [name, entry] of registry) {
    try {
      if (typeof entry.mod.init === 'function') await entry.mod.init();
      entry.inited = true;
    } catch (err) {
      console.error('[lifecycle] init failed for "' + name + '"', err);
    }
  }
}

/** Destroy every registered feature (full teardown). */
export async function destroyAll() {
  for (const [name, entry] of registry) {
    try {
      if (typeof entry.mod.destroy === 'function') await entry.mod.destroy();
      entry.inited = false;
      entry.mounted = false;
    } catch (err) {
      console.error('[lifecycle] destroy failed for "' + name + '"', err);
    }
  }
  activePanel = null;
}

/**
 * Switch the visible panel. Unmounts (and for heavy features, destroys)
 * the previous one, then mounts (and re-inits) the new one.
 * @param {string} name
 */
export async function switchPanel(name) {
  if (name === activePanel) return;
  const prev = activePanel ? registry.get(activePanel) : null;
  const next = registry.get(name);

  if (prev) {
    try {
      if (typeof prev.mod.unmount === 'function') await prev.mod.unmount();
      if (prev.heavy && typeof prev.mod.destroy === 'function') {
        await prev.mod.destroy();
        prev.inited = false;
      }
      prev.mounted = false;
    } catch (err) {
      console.error('[lifecycle] unmount failed for "' + activePanel + '"', err);
    }
  }

  activePanel = name;

  if (next) {
    try {
      if (next.heavy && !next.inited && typeof next.mod.init === 'function') {
        await next.mod.init();
        next.inited = true;
      }
      if (typeof next.mod.mount === 'function') await next.mod.mount();
      next.mounted = true;
    } catch (err) {
      console.error('[lifecycle] mount failed for "' + name + '"', err);
    }
  }

  emit('panel:switch', { name, prev: prev ? activePanel : null });
}

export function getActivePanel() {
  return activePanel;
}

export function isMounted(name) {
  const e = registry.get(name);
  return !!(e && e.mounted);
}

export function list() {
  const out = {};
  for (const [k, v] of registry) out[k] = { heavy: v.heavy, inited: v.inited, mounted: v.mounted };
  return out;
}

export default { register, initAll, destroyAll, switchPanel, getActivePanel, isMounted, list };
