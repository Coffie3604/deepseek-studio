import * as state from '../core/state.js';
import { on, emit } from '../core/bus.js';
import { toast, loadScriptFromAny } from '../core/ui.js';

const CDN = 'https://cdn.jsdelivr.net/npm/';
const CORE = [
  CDN + '@xterm/xterm@5.5.0/lib/xterm.min.js',
  CDN + '@xterm/xterm@5.5.0/lib/xterm.js',
];
const ADDONS = [
  { key: 'fit',       urls: [CDN + '@xterm/addon-fit@0.10.0/lib/addon-fit.min.js', CDN + '@xterm/addon-fit@0.10.0/lib/addon-fit.js'] },
  { key: 'webLinks',  urls: [CDN + '@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js', CDN + '@xterm/addon-web-links@0.11.0/lib/addon-web-links.js'] },
  { key: 'webgl',     urls: [CDN + '@xterm/addon-webgl@0.18.0/lib/addon-webgl.min.js', CDN + '@xterm/addon-webgl@0.18.0/lib/addon-webgl.js'] },
  { key: 'serialize', urls: [CDN + '@xterm/addon-serialize@0.13.0/lib/addon-serialize.min.js', CDN + '@xterm/addon-serialize@0.13.0/lib/addon-serialize.js'] },
];

let term = null;
let ws = null;
let addons = { fit: null, webLinks: null, webgl: null, serialize: null };
let inited = false;
let initP = null;
let scrollback = '';
let unsubs = [];
let resizeT = null;
let ctrlArmed = false;
/* A `terminal:run` that arrived before we finished mounting. Flushed at the
   end of doInit(), once the socket exists. */
let pendingRun = null;

const KEYS = [
  { label: 'Esc',  data: '\x1b' },
  { label: 'Tab',  data: '\t' },
  { label: 'Ctrl', ctrl: true },
  { label: '↑',    data: '\x1b[A' },
  { label: '↓',    data: '\x1b[B' },
  { label: '←',    data: '\x1b[D' },
  { label: '→',    data: '\x1b[C' },
];

export async function init() {
  if (inited) return;
  if (initP) return initP;
  initP = doInit().finally(() => { initP = null; });
  return initP;
}

export async function destroy() {
  if (!inited) return;
  inited = false;

  if (term && addons.serialize) {
    try { scrollback = addons.serialize.serialize({ scrollback: 2000 }); } catch {}
  }
  for (const un of unsubs) un();
  unsubs = [];

  window.removeEventListener('resize', resizeHandled);
  clearTimeout(resizeT);

  if (ws) { try { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); } catch {} ws = null; }
  if (addons.webgl) { try { addons.webgl.dispose(); } catch {} }
  if (term) { try { term.dispose(); } catch {} }
  term = null;
  addons = { fit: null, webLinks: null, webgl: null, serialize: null };
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
export function unmount() {}

export function run(cmd, silent) {
  if (!ws || ws.readyState !== 1) { toast('Terminal not ready', 'error'); return false; }
  ws.send(JSON.stringify({ type: 'input', data: cmd + '\n' }));
  if (!silent) {
    const hist = (state.get('cmdHistory') || []).filter((c) => c !== cmd);
    hist.unshift(cmd);
    state.set('cmdHistory', hist.slice(0, 50));
  }
  return true;
}
export function send(data) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'input', data })); return true; }
  return false;
}
export function isReady() { return !!(term && ws && ws.readyState === 1); }

async function doInit() {
  const host = document.getElementById('terminal');
  if (!host) throw new Error('No #terminal element');

  if (typeof window.Terminal === 'undefined') {
    console.log('[term] loading xterm…');
    await loadScriptFromAny(CORE);
  }
  if (typeof window.Terminal === 'undefined') throw new Error('xterm global missing');

  const loaded = await Promise.all(ADDONS.map((a) =>
    loadScriptFromAny(a.urls).then(() => a.key).catch(() => null)
  ));
  const ok = new Set(loaded.filter(Boolean));
  console.log('[term] addons:', [...ok].join(', ') || 'none');

  term = new window.Terminal({
    cursorBlink: true,
    fontFamily: "'JetBrains Mono','Fira Code',monospace",
    fontSize: 13,
    lineHeight: 1.2,
    theme: { background: '#0a0e14', foreground: '#e6edf3', cursor: '#58a6ff', selectionBackground: '#1f6feb55' },
    scrollback: 10000,
    allowProposedApi: true,
    cursorStyle: 'block',
  });

  if (ok.has('fit') && window.FitAddon) {
    try { const f = new window.FitAddon.FitAddon(); term.loadAddon(f); addons.fit = f; } catch {}
  }
  if (ok.has('webLinks') && window.WebLinksAddon) {
    try { term.loadAddon(new window.WebLinksAddon.WebLinksAddon()); } catch {}
  }
  if (ok.has('serialize') && window.SerializeAddon) {
    try { const s = new window.SerializeAddon.SerializeAddon(); term.loadAddon(s); addons.serialize = s; } catch {}
  }
  term.open(host);

  if (state.get('termWebgl') && ok.has('webgl') && window.WebglAddon) {
    try {
      const wg = new window.WebglAddon.WebglAddon();
      wg.onContextLoss(() => { try { wg.dispose(); } catch {} addons.webgl = null; });
      term.loadAddon(wg);
      addons.webgl = wg;
    } catch {}
  }

  if (scrollback) { try { term.write(scrollback); } catch {} scrollback = ''; }
  setTimeout(() => { try { addons.fit && addons.fit.fit(); } catch {} }, 300);

  bindTermOnce();
  connect();
  bindToolbar();
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

function resizeHandled() {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { try { addons.fit && addons.fit.fit(); } catch {} }, 150);
}

function bindTermOnce() {
  term.onData((data) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }));
  });
  term.onResize((size) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
  });
}

function connect() {
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/pty';
  ws = new WebSocket(url);
  ws.onopen = () => {
    term.writeln('\x1b[32m● Connected\x1b[0m');
    setStatus('Connected', true);
    try { addons.fit && addons.fit.fit(); } catch {}
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
}

function setStatus(text, online) {
  const t = document.getElementById('termStatusText');
  const p = document.getElementById('termPulse');
  if (t) t.textContent = text;
  if (p) p.style.background = online ? 'var(--green)' : 'var(--red)';
  emit('terminal:status', { online, text });
}

function bindToolbar() {
  const clear = document.getElementById('termClearBtn');
  if (clear) clear.onclick = () => { if (term) term.clear(); };

  const kill = document.getElementById('termKillBtn');
  if (kill) kill.onclick = () => {
    if (!ws) return;
    const old = ws;
    ws = null;
    try { old.onclose = old.onmessage = old.onerror = null; old.close(); } catch {}
    setTimeout(() => { if (term) term.clear(); connect(); }, 200);
  };
}

function bindKeyRow() {
  const row = document.getElementById('termKeyRow');
  if (!row) return;
  row.innerHTML = '';
  for (const k of KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tkey' + (k.ctrl ? ' tkey-mod' : '');
    b.textContent = k.label;
    b.onclick = (e) => {
      e.preventDefault();
      if (k.ctrl) {
        ctrlArmed = !ctrlArmed;
        b.classList.toggle('armed', ctrlArmed);
        return;
      }
      if (ctrlArmed) {
        const ch = k.data.toLowerCase();
        if (ch.length === 1 && ch >= 'a' && ch <= 'z') send(String.fromCharCode(ch.charCodeAt(0) - 96));
        else send(k.data);
        ctrlArmed = false;
        const mod = row.querySelector('.tkey-mod');
        if (mod) mod.classList.remove('armed');
        return;
      }
      send(k.data);
    };
    row.appendChild(b);
  }
}

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
      if (++tries > 20) return toast('Terminal not ready', 'error');
      setTimeout(attempt, 150);
    };
    attempt();
  }));
  unsubs.push(on('terminal:write', (p) => {
    if (!term || !p || !p.text) return;
    term.write(String(p.text).replace(/\r?\n/g, '\r\n'));
  }));
  unsubs.push(on('terminal:clear', () => { if (term) term.clear(); }));
}
