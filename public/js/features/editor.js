import * as state from '../core/state.js';
import { on, emit } from '../core/bus.js';
import { toast, loadScript } from '../core/ui.js';
import { fsRead, fsWrite } from '../core/api.js';

// Monaco is fetched from a CDN. On Termux/Android the network is often slow,
// metered or filtered, so a single hard-coded CDN is a single point of
// failure: if it is blocked the editor is dead forever with no explanation.
// Try several mirrors, and remember which one worked.
// Each mirror needs its own loader filename: cdnjs and jsDelivr ship
// `loader.min.js`, but unpkg only serves `loader.js` (the .min variant 404s).
// Hard-coding one name silently killed the unpkg fallback.
const MIRRORS = [
  { base: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/', loader: 'vs/loader.min.js' },
  { base: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.39.0/min/', loader: 'vs/loader.min.js' },
  { base: 'https://unpkg.com/monaco-editor@0.39.0/min/', loader: 'vs/loader.js' },
];
const CDN_KEY = 'monacoCdnBase';
let cdnBase = null;

let ready = false;
let loading = null;
let opening = null;
let editor = null;
let host, empty, tabsBar, saveBtn;
let unsubs = [];

export async function init() {
  host    = document.getElementById('monaco');
  empty   = document.getElementById('editorEmpty');
  tabsBar = document.getElementById('editorTabsBar');
  saveBtn = document.getElementById('saveBtn');

  if (saveBtn) saveBtn.onclick = save;

  // Reuse the mirror that worked last time so we don't re-probe dead CDNs.
  try { cdnBase = state.get(CDN_KEY) || null; } catch { cdnBase = null; }

  // open() is async. Without a .catch() here a failed Monaco load became an
  // unhandled rejection and the editor silently did nothing — the exact
  // "editor can't edit files" symptom. open() now reports its own errors, so
  // this catch only stops the rejection escaping.
  unsubs.push(on('editor:open', (p) => {
    if (p && p.path) open(p.path).catch((e) => console.error('[editor] open failed', e));
  }));
  unsubs.push(on('editor:saved', () => renderTabs()));

  renderTabs();
  document.addEventListener('keydown', onKey);

  // Do NOT create Monaco here. init() runs at boot while the editor panel is
  // hidden; mount() is what runs when the panel is actually shown, and it is
  // responsible for building the instance and restoring the open file.
  if (editor) setTimeout(() => editor.layout(), 60);
}

export async function destroy() {
  for (const un of unsubs) un();
  unsubs = [];
  document.removeEventListener('keydown', onKey);
  if (editor) { try { editor.dispose(); } catch {} editor = null; }
  // Monaco itself stays loaded (window.monaco is global and expensive to
  // fetch twice); only the instance is disposed. `ready` therefore must NOT
  // be reset here — otherwise mount()/open() would try to create a second
  // instance on top of the disposed one.
  loading = null;
  // A pending open() must not keep its re-entrancy guard set across a
  // teardown, or the next open of the same path would be swallowed.
  opening = null;
}

export function mount() {
  // mount() is the only path that runs when the panel becomes visible, and it
  // is where Monaco is actually created. init()'s restore attempt happens at
  // boot, before any instance exists, so re-apply the open file here or the
  // editor comes up blank every time the user returns to the panel.
  const path = state.get('openFile');
  if (path) { open(path, true).catch((e) => console.error('[editor] mount open failed', e)); return; }
  if (!ready || !editor) loadMonaco().catch((e) => console.error('[editor] monaco load failed', e));
  else setTimeout(() => editor.layout(), 60);
}
export function unmount() {}

/** Load the Monaco AMD loader + editor from the first mirror that answers. */
async function loadMonacoLib() {
  if (window.monaco) return;
  // Put the mirror that worked last time first, then the rest in order.
  const order = cdnBase
    ? MIRRORS.filter((m) => m.base === cdnBase).concat(MIRRORS.filter((m) => m.base !== cdnBase))
    : MIRRORS.slice();
  let lastErr = null;
  for (const mirror of order) {
    const base = mirror.base;
    try {
      await loadScript(base + mirror.loader);
      // The AMD loader defines window.require. If the script "loaded" but the
      // loader is absent (blocked, truncated, or an HTML error page), fail
      // this mirror cleanly instead of throwing a confusing TypeError.
      if (typeof window.require !== 'function') {
        throw new Error('AMD loader missing after loading ' + mirror.loader);
      }
      await new Promise((resolve, reject) => {
        window.require.config({ paths: { vs: base + 'vs' } });
        window.require(['vs/editor/editor.main'], resolve, reject);
      });
      if (!window.monaco) throw new Error('loader ran but window.monaco is missing');
      cdnBase = base;
      try { state.set(CDN_KEY, base); } catch {}
      return;
    } catch (err) {
      lastErr = err;
      console.warn('[editor] Monaco mirror failed: ' + base, err);
    }
  }
  throw new Error(
    'Could not load Monaco from any mirror. Check your connection ' +
    '(the editor needs to download it once). ' + (lastErr ? lastErr.message : '')
  );
}

async function loadMonaco() {
  // `ready` means "Monaco is loaded AND an instance exists". After a panel
  // switch destroy() disposed the instance but left the library loaded, so
  // we must be able to re-create it — hence the `editor` check.
  if (ready && editor) return;
  if (loading) return loading;
  loading = (async () => {
    await loadMonacoLib();
    // The host element survives panel switches, but the empty-state node
    // may have been removed by a previous create().
    host = document.getElementById('monaco') || host;
    if (!host) throw new Error('editor host #monaco missing');
    empty = document.getElementById('editorEmpty');
    if (empty) empty.remove();
    editor = window.monaco.editor.create(host, {
      value: '',
      language: 'plaintext',
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: state.get('editorFontSize') || 13,
      minimap: { enabled: !!state.get('editorMinimap') },
      tabSize: 4,
      wordWrap: state.get('editorWordWrap') ? 'on' : 'off',
      padding: { top: 12, bottom: 12 },
    });
    editor.onDidChangeModelContent(() => {
      const path = state.get('openFile');
      if (!path) return;
      state.set('fileContent', editor.getValue());
      if (!state.get('fileModified')) {
        state.set('fileModified', true);
        const mod = Object.assign({}, state.get('modifiedFiles') || {});
        mod[path] = true;
        state.set('modifiedFiles', mod);
        renderTabs();
      }
    });
    ready = true;
  })().catch((err) => {
    // Never cache a rejected promise in `loading`, or every later open()
    // would fail with the same stale error.
    loading = null;
    ready = false;
    throw err;
  });
  return loading;
}

/**
 * Render a visible, actionable error inside the editor host instead of
 * leaving a blank panel. Includes a Retry button that re-attempts the load.
 */
function showLoadError(err) {
  const h = document.getElementById('monaco') || host;
  if (!h) { toast('Editor failed to load', 'error'); return; }
  h.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'editor-load-error';
  box.innerHTML =
    '<div class="ele-title">Editor could not load</div>' +
    '<div class="ele-msg"></div>' +
    '<button class="btn primary ele-retry" type="button">Retry</button>';
  box.querySelector('.ele-msg').textContent = String((err && err.message) || err);
  box.querySelector('.ele-retry').onclick = () => {
    // Force a fresh attempt: clear the cached rejection state.
    loading = null;
    ready = false;
    box.remove();
    const path = state.get('openFile');
    const p = path ? open(path, true) : loadMonaco();
    Promise.resolve(p).catch((e) => {
      console.error('[editor] retry failed', e);
      showLoadError(e);
    });
  };
  h.appendChild(box);
  toast('Editor failed to load — tap Retry', 'error', 4000);
}

async function open(path, silent) {
  // Reveal the panel FIRST. 'panel:show' -> switchPanel('editor') runs
  // destroy() on the editor when it is not the active panel, so we must let
  // the lifecycle settle before creating the Monaco instance — otherwise the
  // instance is disposed microseconds after it is built and the editor looks
  // permanently blank.
  if (!silent) {
    emit('panel:show', { name: 'editor' });
    // switchPanel is async; give it a tick to finish its destroy/init cycle.
    await new Promise((r) => setTimeout(r, 0));
  }

  // The editor is a "heavy" feature: the lifecycle destroys it when another
  // panel is shown, so an open request can arrive with no Monaco instance.
  // Rebuild it instead of silently doing nothing.
  if (!ready || !editor) {
    try {
      await loadMonaco();
    } catch (err) {
      // A failed Monaco download used to reject into the void: the caller in
      // init() does not await open(), so the user saw a blank panel and no
      // message at all. Tell them, and offer a retry.
      console.error('[editor] loadMonaco failed', err);
      showLoadError(err);
      throw err;
    }
  }

  // Re-entrancy guard: init() may call open() for the same path while we are
  // still awaiting fsRead below.
  if (opening === path) return;
  opening = path;
  try {
    await doOpen(path);
  } finally {
    if (opening === path) opening = null;
  }
}

async function doOpen(path) {
  const prev = state.get('openFile');
  if (prev && state.get('fileModified')) {
    const mod = Object.assign({}, state.get('modifiedFiles') || {});
    mod[prev] = true;
    state.set('modifiedFiles', mod);
  }

  const data = await fsRead(path);
  if (data.error) { toast(data.error, 'error'); return; }

  state.set('openFile', path);
  state.set('activeTabPath', path);
  state.set('fileContent', data.content || '');
  state.set('fileModified', false);

  const tabs = (state.get('openTabs') || []).slice();
  if (!tabs.includes(path)) tabs.push(path);
  state.set('openTabs', tabs);

  if (editor) {
    editor.setValue(state.get('fileContent'));
    window.monaco.editor.setModelLanguage(editor.getModel(), detectLang(path));
  } else {
    // The instance was disposed while fsRead was in flight (panel switch).
    // Rebuild it and re-apply the content we just loaded.
    await loadMonaco();
    if (editor) {
      editor.setValue(state.get('fileContent'));
      window.monaco.editor.setModelLanguage(editor.getModel(), detectLang(path));
    }
  }
  if (saveBtn) saveBtn.disabled = false;
  renderTabs();
}

async function save() {
  const path = state.get('openFile');
  if (!path) { toast('No file open', 'error'); return; }
  const content = editor ? editor.getValue() : state.get('fileContent');
  const r = await fsWrite(path, content);
  if (r.ok) {
    toast('Saved ' + path.split('/').pop(), 'success');
    state.set('fileModified', false);
    const mod = Object.assign({}, state.get('modifiedFiles') || {});
    delete mod[path];
    state.set('modifiedFiles', mod);
    renderTabs();
    emit('editor:saved', { path });
    emit('files:changed', { path });
  } else {
    toast(r.error || 'Save failed', 'error');
  }
}

function renderTabs() {
  if (!tabsBar) return;
  const tabs = state.get('openTabs') || [];
  const active = state.get('activeTabPath');
  const modified = state.get('modifiedFiles') || {};
  tabsBar.innerHTML = '';
  if (!tabs.length) { tabsBar.style.display = 'none'; return; }
  tabsBar.style.display = 'flex';
  for (const p of tabs) {
    const tab = document.createElement('div');
    tab.className = 'editor-tab' + (p === active ? ' active' : '');
    const name = p.split('/').pop();
    const dot = modified[p] ? '<span class="modified-dot"></span>' : '';
    tab.innerHTML = name + dot + '<span class="close-x">×</span>';
    tab.onclick = (e) => {
      if (e.target.classList.contains('close-x')) { e.stopPropagation(); closeTab(p); return; }
      if (p !== active) open(p);
    };
    tabsBar.appendChild(tab);
  }
}

function closeTab(p) {
  const tabs = (state.get('openTabs') || []).filter((t) => t !== p);
  state.set('openTabs', tabs);
  const active = state.get('activeTabPath');
  if (active === p) {
    const next = tabs[tabs.length - 1] || null;
    if (next) open(next);
    else {
      state.set('openFile', null);
      state.set('activeTabPath', null);
      if (editor) editor.setValue('');
      if (saveBtn) saveBtn.disabled = true;
      renderTabs();
    }
  } else renderTabs();
}

function onKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
}

function detectLang(path) {
  const ext = path.split('.').pop().toLowerCase();
  const map = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
    html: 'html', css: 'css', scss: 'scss',
    json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', sh: 'shell', bash: 'shell',
    toml: 'ini', ini: 'ini',
  };
  return map[ext] || 'plaintext';
}
