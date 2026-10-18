/* ═══════════════════════════════════════════════════════════════════
   core/ui.js — shared DOM helpers: toast, modal, confirm, context menu,
   escaping, clipboard.

   These were scattered through the 3700-line script; features now import
   them instead of relying on hoisted globals.
   ═══════════════════════════════════════════════════════════════════ */

/* ── escaping ───────────────────────────────────────────────────── */
export function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escAttr(s) {
  return escapeHtml(s);
}

/* ── toast ──────────────────────────────────────────────────────── */
let toastTimer = null;

/**
 * @param {string} msg
 * @param {'info'|'ok'|'warn'|'error'} [type]
 * @param {number} [ms]
 */
export function toast(msg, type, ms) {
  let el = document.getElementById('dsToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dsToast';
    el.className = 'ds-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'ds-toast active ' + (type || 'info');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'ds-toast ' + (type || 'info');
  }, ms || 2600);
}

/* ── confirm ────────────────────────────────────────────────────── */
let confirmCallback = null;

/**
 * @param {string} title
 * @param {string} msg
 * @param {(ok:boolean)=>void} cb
 * @param {string} [okLabel]
 */
export function showConfirm(title, msg, cb, okLabel) {
  const modal = document.getElementById('confirmModal');
  if (!modal) { cb(window.confirm(title + '\n' + msg)); return; }
  document.getElementById('confirmTitle').textContent = title || 'Are you sure?';
  document.getElementById('confirmMsg').textContent = msg || '';
  const ok = document.getElementById('confirmOk');
  if (ok) ok.textContent = okLabel || 'Confirm';
  confirmCallback = cb;
  modal.classList.add('active');
}

export function hideConfirm() {
  const modal = document.getElementById('confirmModal');
  if (modal) modal.classList.remove('active');
  confirmCallback = null;
}

/** Wire the confirm modal's buttons once, at boot. */
export function setupConfirmModal() {
  const ok = document.getElementById('confirmOk');
  const cancel = document.getElementById('confirmCancel');
  const modal = document.getElementById('confirmModal');
  if (ok) ok.onclick = () => {
    const cb = confirmCallback;
    hideConfirm();
    if (cb) cb(true);
  };
  if (cancel) cancel.onclick = () => {
    const cb = confirmCallback;
    hideConfirm();
    if (cb) cb(false);
  };
  if (modal) modal.onclick = (e) => { if (e.target === modal) hideConfirm(); };
}

/* ── prompt ─────────────────────────────────────────────────────── */
/**
 * Promise-based text prompt with nicer UX than window.prompt().
 * Resolves with the entered string, or null if cancelled/dismissed.
 *
 * @param {{title?:string, message?:string, default?:string,
 *          okLabel?:string, cancelLabel?:string, placeholder?:string}} [opts]
 * @returns {Promise<string|null>}
 */
export function promptDialog(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'pd-overlay';

    const box = document.createElement('div');
    box.className = 'pd-box';

    const h = document.createElement('div');
    h.className = 'pd-title';
    h.textContent = o.title || 'Input';
    box.appendChild(h);

    if (o.message) {
      const m = document.createElement('div');
      m.className = 'pd-message';
      m.textContent = o.message;
      box.appendChild(m);
    }

    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'pd-input';
    inp.value = o.default != null ? String(o.default) : '';
    inp.placeholder = o.placeholder || '';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    box.appendChild(inp);

    const row = document.createElement('div');
    row.className = 'pd-row';

    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.style.cssText = 'padding:8px 14px';
    cancel.textContent = o.cancelLabel || 'Cancel';

    const ok = document.createElement('button');
    ok.className = 'btn primary';
    ok.style.cssText = 'padding:8px 14px';
    ok.textContent = o.okLabel || 'OK';

    const done = (val) => {
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      resolve(val);
    };

    cancel.onclick = () => done(null);
    ok.onclick = () => done(inp.value);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(inp.value); }
      else if (e.key === 'Escape') done(null);
    });
    ov.onclick = (e) => { if (e.target === ov) done(null); };

    row.appendChild(cancel);
    row.appendChild(ok);
    box.appendChild(row);
    ov.appendChild(box);
    document.body.appendChild(ov);
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}

/* ── context menu ───────────────────────────────────────────────── */
let ctxItem = null;

export function showContextMenu(item, evt) {
  const menu = document.getElementById('ctxMenu');
  if (!menu) return;
  ctxItem = item;
  const x = (evt.touches && evt.touches[0] ? evt.touches[0].clientX : evt.clientX) || 0;
  const y = (evt.touches && evt.touches[0] ? evt.touches[0].clientY : evt.clientY) || 0;
  menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 200) + 'px';
  menu.classList.add('active');
  if (evt.preventDefault) evt.preventDefault();
}

export function hideContextMenu() {
  const menu = document.getElementById('ctxMenu');
  if (menu) menu.classList.remove('active');
  ctxItem = null;
}

export function getCtxItem() {
  return ctxItem;
}

/**
 * Wire the context menu's dismiss behaviour once, at boot.
 *
 * The menu *items* are bound by whoever owns the tree (legacy.js today,
 * features/files.js after the carve-out) because they need openFileFromTree,
 * renameItem, refreshTree, … Binding them here would drag the whole tree
 * into core/ui.js. What belongs to core is only the generic behaviour:
 * close on outside tap, close on Escape, close on scroll.
 */
export function setupContextMenu() {
  const menu = document.getElementById('ctxMenu');
  if (!menu) return;

  document.addEventListener('pointerdown', (e) => {
    if (!menu.classList.contains('active')) return;
    if (!menu.contains(e.target)) hideContextMenu();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('active')) hideContextMenu();
  });

  window.addEventListener('scroll', () => {
    if (menu.classList.contains('active')) hideContextMenu();
  }, true);
}

/* ── clipboard ──────────────────────────────────────────────────── */
export function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

/**
 * Copy text and flash the button that triggered it.
 * @param {string} text
 * @param {HTMLElement} [btn]
 */
export async function copyText(text, btn) {
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (err) { ok = false; }
  if (!ok) ok = fallbackCopy(text);
  if (btn) {
    const prev = btn.innerHTML;
    btn.innerHTML = ok ? '✓' : '✗';
    setTimeout(() => { btn.innerHTML = prev; }, 1200);
  }
  return ok;
}

/* ── misc ───────────────────────────────────────────────────────── */
export function isEditableTarget(e) {
  const t = e.target;
  if (!t) return false;
  const tag = (t.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || t.isContentEditable;
}

/** Load a <script> once; resolves when ready. */
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src="' + src + '"]');
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('failed: ' + src)));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => reject(new Error('failed: ' + src));
    document.head.appendChild(s);
  });
}

/** Try each source in order until one loads. */
export async function loadScriptFromAny(sources) {
  let lastErr;
  for (const src of sources) {
    try { await loadScript(src); return src; } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('no source loaded');
}

export default {
  escapeHtml, escAttr, toast, showConfirm, hideConfirm, setupConfirmModal,
  promptDialog,
  showContextMenu, hideContextMenu, getCtxItem, setupContextMenu,
  fallbackCopy, copyText, isEditableTarget, loadScript, loadScriptFromAny,
};
