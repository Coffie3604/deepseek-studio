/* ═══════════════════════════════════════════════════════════════════
   features/terminal.js — xterm + /pty WebSocket

   First feature carved out of the legacy script (it is the most
   isolated one). Everything it used to reach for as a global now comes
   from core/* or from the bus:

     term / ws / termAddons   → module-private here
     toast / copyText         → core/ui.js
     promptDialog             → core/ui.js
     currentProject           → state.get('currentProject')
     switchPrimaryPanel       → bus.emit('panel:switch')
     cmdHistory               → state (persisted)

   Lifecycle: `heavy: true`. On a phone, keeping xterm + WebGL alive
   while the user is in the chat panel is the main jank source, so the
   panel switch destroys the terminal and its socket, and re-inits on
   return. The scrollback is serialized before teardown so the user
   doesn't lose their session output.

   Bus contract:
     on  'terminal:run'    { cmd, silent }   run a command in the pty
     on  'terminal:focus'  {}                focus the terminal
     on  'terminal:clear'  {}                clear the screen
     emit 'terminal:status' { online, text } connection state changed
   ═══════════════════════════════════════════════════════════════════ */
/* features/terminal.js — xterm + /pty WebSocket */
import * as state from '../core/state.js';
import { on, emit } from '../core/bus.js';
import { toast, copyText, promptDialog, loadScriptFromAny } from '../core/ui.js';
import { exec } from '../core/api.js';

const CDN = 'https://cdn.jsdelivr.net/npm/';

const CORE_SOURCES = [
  CDN + '@xterm/xterm@5.5.0/lib/xterm.min.js',
  CDN + '@xterm/xterm@5.5.0/lib/xterm.js',
  CDN + 'xterm@5.3.0/lib/xterm.js',
];

const ADDONS = [
  { key: 'fit', urls: [CDN + '@xterm/addon-fit@0.10.0/lib/addon-fit.min.js', CDN + '@xterm/addon-fit@0.10.0/lib/addon-fit.js', CDN + 'xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js'] },
  { key: 'webLinks', urls: [CDN + '@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js', CDN + '@xterm/addon-web-links@0.11.0/lib/addon-web-links.js'] },
  { key: 'search', urls: [CDN + '@xterm/addon-search@0.15.0/lib/addon-search.min.js', CDN + '@xterm/addon-search@0.15.0/lib/addon-search.js'] },
  { key: 'unicode11', urls: [CDN + '@xterm/addon-unicode11@0.8.0/lib/addon-unicode11.min.js', CDN + '@xterm/addon-unicode11@0.8.0/lib/addon-unicode11.js'] },
  { key: 'webgl', urls: [CDN + '@xterm/addon-webgl@0.18.0/lib/addon-webgl.min.js', CDN + '@xterm/addon-webgl@0.18.0/lib/addon-webgl.js'] },
  { key: 'serialize', urls: [CDN + '@xterm/addon-serialize@0.13.0/lib/addon-serialize.min.js', CDN + '@xterm/addon-serialize@0.13.0/lib/addon-serialize.js'] },
];

let term = null;
let ws = null;
let addons = { fit: null, search: null, serialize: null, webgl: null, webLinks: null };
let inited = false;
let initPromise = null;
let savedScrollback = '';
let unsubs = [];
let resizeHandler = null;
let resizeTimer = null;
let ctrlArmed = false;
/* A `terminal:run` that arrived before we finished mounting. Flushed at the
   end of doInit(), once the socket exists. */
let pendingRun = null;

const KEY_ROW = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl', ctrl: true },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '←', data: '\x1b[D' },
  { label: '→', data: '\x1b[C' },
  { label: '/', data: '/' },
  { label: '-', data: '-' },
  { label: '|', data: '|' },
  { label: '~', data: '~' },
];

/* ═══════════════════════════════════════════════════════════════════
   PUBLIC API
   ═══════════════════════════════════════════════════════════════════ */

export async function init() {
  if (inited) return;
  if (initPromise) return initPromise;
  initPromise = doInit().finally(() => { initPromise = null; });
  return initPromise;
}

export async function destroy() {
  if (!inited) return;
  inited = false;

  // Keep the user's output across a panel switch.
  if (term && addons.serialize) {
    try { savedScrollback = addons.serialize.serialize({ scrollback: 2000 }); } catch (e) { /* ignore */ }
  }

  for (const un of unsubs) { try { un(); } catch (e) { /* ignore */ } }
  unsubs = [];

  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }
  clearTimeout(resizeTimer);

  if (ws) {
    try { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); } catch (e) { /* ignore */ }
    ws = null;
  }
  if (addons.webgl) { try { addons.webgl.dispose(); } catch (e) { /* ignore */ } }
  if (term) { try { term.dispose(); } catch (e) { /* ignore */ } }
  term = null;
  addons = { fit: null, search: null, serialize: null, webgl: null, webLinks: null };
}

export function mount() {
  // The panel just became visible: the host has real dimensions now.
  // init() is idempotent, so this both covers a fresh mount (heavy features
  // are skipped by initAll) and a re-mount after a teardown.
  const ready = inited ? Promise.resolve() : init();
  return ready
    .then(() => new Promise((r) => setTimeout(r, 60)))
    .then(() => {
      // Fit only once the panel has a size, otherwise xterm locks onto 1x1.
      try { addons.fit && addons.fit.fit(); } catch (e) { /* ignore */ }
    })
    .catch((e) => console.error('[term] mount failed', e));
}

/** Open the find bar (used by the quick-command palette via the bus). */
export function focusSearch() {
  const btn = document.getElementById('termSearchBtn');
  if (btn) btn.click();
}

export function unmount() {
  // Nothing to do — destroy() handles the heavy teardown.
}

/** Run a command in the pty (used by the Files/Git panels via the bus). */
export function run(cmd, silent) {
  if (!term) { toast('Terminal not ready', 'error'); return false; }
  if (!ws || ws.readyState !== 1) { toast('Terminal disconnected', 'error'); return false; }
  ws.send(JSON.stringify({ type: 'input', data: cmd + '\n' }));
  if (!silent) {
    const hist = (state.get('cmdHistory') || []).filter((c) => c !== cmd);
    hist.unshift(cmd);
    state.set('cmdHistory', hist.slice(0, 50));
  }
  return true;
}

/** Send raw bytes (Ctrl+C, paste, …). */
export function send(data) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'input', data })); return true; }
  return false;
}

export function isReady() { return !!(term && ws && ws.readyState === 1); }

/* ═══════════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════════ */

async function doInit() {
  const host = document.getElementById('terminal');
  if (!host) throw new Error('No #terminal host element');

  // Reuse an already-loaded xterm (second init after a panel switch).
  if (typeof window.Terminal === 'undefined') {
    console.log('[term] loading core from CDN…');
    await loadScriptFromAny(CORE_SOURCES);
  }
  if (typeof window.Terminal === 'undefined') {
    throw new Error('Core loaded but `Terminal` global is missing');
  }

  const loaded = await Promise.all(ADDONS.map((a) =>
    loadScriptFromAny(a.urls)
      .then((src) => ({ key: a.key, src }))
      .catch((err) => { console.warn('[term] addon failed:', a.key, err.message); return null; })
  ));
  const ok = {};
  loaded.forEach((a) => { if (a) ok[a.key] = a; });
  console.log('[term] addons loaded:', Object.keys(ok).join(', ') || 'none');

  term = new window.Terminal({
    cursorBlink: true,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: 13,
    lineHeight: 1.2,
    theme: { background: '#0a0e14', foreground: '#e6edf3', cursor: '#58a6ff', selectionBackground: '#1f6feb55' },
    scrollback: 10000,
    allowProposedApi: true,
    convertEol: false,
    cursorStyle: 'block',
  });

  if (ok.fit && window.FitAddon) {
    try { const fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); addons.fit = fit; } catch (e) { /* ignore */ }
  }
  if (ok.webLinks && window.WebLinksAddon) {
    try { const wl = new window.WebLinksAddon.WebLinksAddon(); term.loadAddon(wl); addons.webLinks = wl; } catch (e) { /* ignore */ }
  }
  if (ok.search && window.SearchAddon) {
    try { const s = new window.SearchAddon.SearchAddon(); term.loadAddon(s); addons.search = s; } catch (e) { /* ignore */ }
  }
  if (ok.unicode11 && window.Unicode11Addon) {
    try { term.loadAddon(new window.Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11'; } catch (e) { /* ignore */ }
  }
  if (ok.serialize && window.SerializeAddon) {
    try { const sz = new window.SerializeAddon.SerializeAddon(); term.loadAddon(sz); addons.serialize = sz; } catch (e) { /* ignore */ }
  }

  term.open(host);

  if (state.get('termWebgl') && ok.webgl && window.WebglAddon) {
    try {
      const webgl = new window.WebglAddon.WebglAddon();
      webgl.onContextLoss(() => {
        console.warn('[term] WebGL context lost — falling back to DOM renderer');
        try { webgl.dispose(); } catch (e) { /* ignore */ }
        addons.webgl = null;
      });
      term.loadAddon(webgl);
      addons.webgl = webgl;
    } catch (e) { console.warn('[term] WebGL addon load failed:', e.message); }
  }

  // Restore the scrollback we serialized in destroy().
  if (savedScrollback) {
    try { term.write(savedScrollback); } catch (e) { /* ignore */ }
    savedScrollback = '';
  }

  setTimeout(() => { try { addons.fit && addons.fit.fit(); } catch (e) { /* ignore */ } }, 300);

  connect();
  bindToolbar();
  bindSearch();
  bindKeyRow();
  bindBus();

  resizeHandler = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { try { addons.fit && addons.fit.fit(); } catch (e) { /* ignore */ } }, 150);
  };
  window.addEventListener('resize', resizeHandler);

  // Focus after the panel has laid out, so the soft keyboard opens on the
  // terminal instead of the address bar.
  setTimeout(() => { try { term && term.focus(); } catch (e) { /* ignore */ } }, 120);

  inited = true;
}

/* ═══════════════════════════════════════════════════════════════════
   WEBSOCKET
   ═══════════════════════════════════════════════════════════════════ */

function connect() {
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/pty';
  try { ws = new WebSocket(wsUrl); }
  catch (e) { ws = new WebSocket('ws://127.0.0.1:3002/pty'); }

  ws.onopen = () => {
    term.writeln('\x1b[32m● Connected to Termux\x1b[0m');
    setStatus('Connected', true);
    try { addons.fit && addons.fit.fit(); } catch (e) { /* ignore */ }
  };
  ws.onmessage = (e) => {
    term.write(e.data);
    if (state.get('termAutoScroll')) term.scrollToBottom();
  };
  ws.onclose = () => {
    term.writeln('\r\n\x1b[31m● Disconnected\x1b[0m');
    setStatus('Disconnected', false);
  };
  ws.onerror = () => setStatus('Error', false);

  term.onData((data) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }));
  });
  term.onResize((size) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
  });
}

function setStatus(text, online) {
  const t = document.getElementById('termInfoText');
  const p = document.getElementById('termPulse');
  if (t) t.textContent = text;
  if (p) p.style.background = online ? 'var(--green)' : 'var(--red)';
  emit('terminal:status', { online, text });
}

/* ═══════════════════════════════════════════════════════════════════
   TOOLBAR
   ═══════════════════════════════════════════════════════════════════ */

function bindToolbar() {
  const $ = (id) => document.getElementById(id);

  const clear = $('termClearBtn');
  if (clear) clear.onclick = () => { if (term) term.clear(); };

  const copy = $('termCopyBtn');
  if (copy) copy.onclick = () => {
    if (!term) return;
    term.selectAll();
    copyText(term.getSelection());
    term.clearSelection();
  };

  const paste = $('termPasteBtn');
  if (paste) paste.onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      send(text);
    } catch (e) { toast('Clipboard denied', 'error'); }
  };

  const ctrlC = $('termCtrlCBtn');
  if (ctrlC) ctrlC.onclick = () => send('\x03');
  const ctrlD = $('termCtrlDBtn');
  if (ctrlD) ctrlD.onclick = () => send('\x04');

  const top = $('termTopBtn');
  if (top) top.onclick = () => { if (term) term.scrollToTop(); };
  const bottom = $('termBottomBtn');
  if (bottom) bottom.onclick = () => { if (term) term.scrollToBottom(); };

  const kill = $('termKillBtn');
  if (kill) kill.onclick = () => { send('\x03'); toast('Sent interrupt', 'info'); };

  // One-shot command, no PTY (works even if the socket is down).
  const runBtn = $('termRunBtn');
  if (runBtn) runBtn.onclick = async () => {
    const cmd = await promptDialog({ title: 'Run command', message: 'Command to execute (one-shot, in project dir):' });
    if (!cmd) return;
    if (term) term.writeln('\r\n\x1b[90m$ ' + cmd + '\x1b[0m');
    try {
      const d = await exec(cmd, state.get('currentProject') || '');
      if (term) {
        if (d.stdout) term.writeln(d.stdout.replace(/\n/g, '\r\n'));
        if (d.stderr) term.writeln('\x1b[31m' + d.stderr.replace(/\n/g, '\r\n') + '\x1b[0m');
        term.writeln('\x1b[90m[exit ' + (d.code != null ? d.code : '?') + ']\x1b[0m');
      }
    } catch (e) { toast('Exec failed', 'error'); }
  };
}

/* ═══════════════════════════════════════════════════════════════════
   SEARCH
   ═══════════════════════════════════════════════════════════════════ */

function bindSearch() {
  const bar = document.getElementById('termSearchBar');
  const btn = document.getElementById('termSearchBtn');
  const input = document.getElementById('termSearchInput');
  const prev = document.getElementById('termSearchPrev');
  const next = document.getElementById('termSearchNext');
  const close = document.getElementById('termSearchClose');
  const caseChk = document.getElementById('termSearchCase');
  const regexChk = document.getElementById('termSearchRegex');
  if (!btn || !bar) return;

  const openSearch = () => {
    bar.classList.add('active');
    setTimeout(() => { input.focus(); input.select(); }, 50);
  };
  const closeSearch = () => {
    bar.classList.remove('active');
    if (addons.search) { try { addons.search.clearDecorations(); } catch (e) { /* ignore */ } }
    if (term) term.focus();
  };
  const opts = () => ({ caseSensitive: caseChk.checked, regex: regexChk.checked, incremental: true });
  const findNext = () => { if (addons.search && input.value) addons.search.findNext(input.value, opts()); };
  const findPrev = () => { if (addons.search && input.value) addons.search.findPrevious(input.value, opts()); };

  btn.onclick = () => { if (bar.classList.contains('active')) closeSearch(); else openSearch(); };
  close.onclick = closeSearch;
  input.oninput = findNext;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) findPrev(); else findNext(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    else if (e.key === 'F3') { e.preventDefault(); findNext(); }
  };
  prev.onclick = findPrev;
  next.onclick = findNext;
  caseChk.onchange = findNext;
  regexChk.onchange = findNext;
}

/* ═══════════════════════════════════════════════════════════════════
   MOBILE KEY ROW
   xterm on Android is nearly unusable without Esc/Tab/Ctrl/arrows —
   the soft keyboard has none of them. The row is built once and only
   shown on touch-sized viewports (CSS handles the visibility).
   ═══════════════════════════════════════════════════════════════════ */

function bindKeyRow() {
  const row = document.getElementById('termKeyRow');
  if (!row) return;
  row.innerHTML = '';
  KEY_ROW.forEach((k) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tkey' + (k.ctrl ? ' tkey-mod' : '');
    b.textContent = k.label;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      if (k.ctrl) {
        ctrlArmed = !ctrlArmed;
        b.classList.toggle('armed', ctrlArmed);
        return;
      }
      if (ctrlArmed) {
        // Ctrl+<letter> → control code (Ctrl+C = 0x03).
        const ch = k.data.toLowerCase();
        if (ch.length === 1 && ch >= 'a' && ch <= 'z') {
          send(String.fromCharCode(ch.charCodeAt(0) - 96));
        } else {
          send(k.data);
        }
        ctrlArmed = false;
        const mod = row.querySelector('.tkey-mod');
        if (mod) mod.classList.remove('armed');
        return;
      }
      send(k.data);
    });
    row.appendChild(b);
  });
}

/* ═══════════════════════════════════════════════════════════════════
   BUS
   ═══════════════════════════════════════════════════════════════════ */

function bindBus() {
  unsubs.push(on('terminal:run', (p) => {
    if (!p || !p.cmd) return;
    // Ask the host to reveal our panel. The lifecycle (not terminal:run)
    // decides whether that tears down and re-creates us — which also
    // unsubscribes this listener — so no retry loop is needed or safe.
    // Waiting for a socket here could never succeed after a teardown.
    emit('terminal:run:request', { name: 'terminal' });
    // If we are already mounted and connected, run immediately. If we are
    // mid-mount, queue the command and flush it once init() finishes so it
    // is not silently dropped.
    if (!inited) {
      pendingRun = { cmd: p.cmd, silent: p.silent };
      init().catch((e) => { pendingRun = null; console.error('[term] init for run failed', e); });
      return;
    }
    let tries = 0;
    const attempt = () => {
      if (!inited) return;              // destroyed by a teardown
      if (run(p.cmd, p.silent)) return;
      if (++tries > 20) { toast('Terminal not ready', 'error'); return; }
      setTimeout(attempt, 150);
    };
    attempt();
  }));

  unsubs.push(on('terminal:focus', () => { if (term) term.focus(); }));
  unsubs.push(on('terminal:search', () => focusSearch()));
  unsubs.push(on('terminal:clear', () => { if (term) term.clear(); }));
  // Another feature wants to print into the terminal (compile output, etc.)
  // without owning an xterm instance.
  unsubs.push(on('terminal:write', (p) => {
    if (!term || !p || !p.text) return;
    term.write(String(p.text).replace(/\r?\n/g, '\r\n'));
  }));
}
