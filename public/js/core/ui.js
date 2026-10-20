export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export const escAttr = escapeHtml;

let toastTimer = null;
export function toast(msg, type = 'info', ms = 2600) {
  let el = document.getElementById('dsToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dsToast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast ' + type + ' active';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast ' + type; }, ms);
}

let confirmCb = null;
export function showConfirm(title, msg, cb, okLabel) {
  const modal = document.getElementById('confirmModal');
  if (!modal) { if (cb) cb(true); return; }
  document.getElementById('confirmTitle').textContent = title || 'Are you sure?';
  document.getElementById('confirmMsg').textContent = msg || '';
  document.getElementById('confirmOk').textContent = okLabel || 'Confirm';
  confirmCb = cb;
  modal.classList.add('active');
}
export function hideConfirm() {
  const modal = document.getElementById('confirmModal');
  if (modal) modal.classList.remove('active');
  confirmCb = null;
}
export function setupConfirmModal() {
  const ok = document.getElementById('confirmOk');
  const cancel = document.getElementById('confirmCancel');
  const modal = document.getElementById('confirmModal');
  if (ok) ok.onclick = () => { const cb = confirmCb; hideConfirm(); if (cb) cb(true); };
  if (cancel) cancel.onclick = () => { const cb = confirmCb; hideConfirm(); if (cb) cb(false); };
  if (modal) modal.onclick = (e) => { if (e.target === modal) hideConfirm(); };
}

export function promptDialog(opts = {}) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'pd-overlay';
    ov.innerHTML =
      '<div class="pd-box">' +
        '<div class="pd-title">' + escapeHtml(opts.title || 'Input') + '</div>' +
        (opts.message ? '<div class="pd-message">' + escapeHtml(opts.message) + '</div>' : '') +
        '<input class="pd-input" type="text" autocomplete="off" spellcheck="false" />' +
        '<div class="pd-row">' +
          '<button class="btn" data-act="cancel">' + escapeHtml(opts.cancelLabel || 'Cancel') + '</button>' +
          '<button class="btn primary" data-act="ok">' + escapeHtml(opts.okLabel || 'OK') + '</button>' +
        '</div>' +
      '</div>';
    const inp = ov.querySelector('.pd-input');
    inp.value = opts.default != null ? String(opts.default) : '';
    inp.placeholder = opts.placeholder || '';
    const done = (val) => { ov.remove(); resolve(val); };
    ov.querySelector('[data-act=cancel]').onclick = () => done(null);
    ov.querySelector('[data-act=ok]').onclick = () => done(inp.value);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(inp.value); }
      else if (e.key === 'Escape') done(null);
    });
    ov.onclick = (e) => { if (e.target === ov) done(null); };
    document.body.appendChild(ov);
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}

let ctxItem = null;
export function showContextMenu(item, evt) {
  const menu = document.getElementById('ctxMenu');
  if (!menu) return;
  ctxItem = item;
  const x = (evt.touches && evt.touches[0] ? evt.touches[0].clientX : evt.clientX) || 0;
  const y = (evt.touches && evt.touches[0] ? evt.touches[0].clientY : evt.clientY) || 0;
  menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - 200) + 'px';
  menu.classList.add('active');
  if (evt.preventDefault) evt.preventDefault();
}
export function hideContextMenu() {
  const menu = document.getElementById('ctxMenu');
  if (menu) menu.classList.remove('active');
  ctxItem = null;
}
export function getCtxItem() { return ctxItem; }

export function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  document.body.removeChild(ta);
  return ok;
}
export async function copyText(text, btn) {
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {}
  if (!ok) ok = fallbackCopy(text);
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = ok ? '✓' : '✗';
    setTimeout(() => { btn.textContent = prev; }, 1200);
  }
  return ok;
}

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
export async function loadScriptFromAny(sources) {
  let lastErr;
  for (const src of sources) {
    try { await loadScript(src); return src; }
    catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('no source loaded');
}
