import * as state from '../core/state.js';
import { on, emit } from '../core/bus.js';
import { toast, loadScript, copyText, promptDialog } from '../core/ui.js';
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
let menuBtn, menu, langBadge, fileInfo;
let unsubs = [];

// Files Monaco can syntax-highlight but that we can also render as a page.
const HTML_EXT = /\.(html?|htm|xhtml)$/i;

export async function init() {
  host    = document.getElementById('monaco');
  empty   = document.getElementById('editorEmpty');
  tabsBar = document.getElementById('editorTabsBar');
  saveBtn = document.getElementById('saveBtn');

  menuBtn   = document.getElementById('edMenuBtn');
  menu      = document.getElementById('edMenu');
  langBadge = document.getElementById('edLangBadge');
  fileInfo  = document.getElementById('edFileInfo');

  if (saveBtn) saveBtn.onclick = save;
  initToolbar();

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
  renderToolbarInfo();
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
  renderToolbarInfo();
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

/* ── Edit-tools dropdown ──────────────────────────────────────────
 * Monaco's own context menu is unreliable on touch devices (long-press
 * fights with scrolling), and Android WebView blocks programmatic
 * clipboard reads. So the toolbar exposes the same operations as explicit
 * buttons, and "Paste" falls back to a prompt when the async clipboard
 * API is unavailable.
 */
function initToolbar() {
  if (!menuBtn || !menu) return;

  menuBtn.onclick = (e) => {
    e.stopPropagation();
    toggleMenu(menu.hidden);
  };

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.ed-menu-item');
    if (!item || item.disabled) return;
    e.stopPropagation();
    closeMenu();
    runCommand(item.dataset.cmd);
  });

  // Close on outside tap / Escape.
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== menuBtn) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { closeMenu(); menuBtn.focus(); }
  });
}

function toggleMenu(open) {
  if (!menu || !menuBtn) return;
  menu.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(!!open));
  if (open) refreshMenuState();
}

function closeMenu() { toggleMenu(false); }

/** Disable actions that cannot work in the current state. */
function refreshMenuState() {
  if (!menu) return;
  const hasFile = !!state.get('openFile');
  const isHtml = hasFile && HTML_EXT.test(state.get('openFile'));
  for (const item of menu.querySelectorAll('.ed-menu-item')) {
    const cmd = item.dataset.cmd;
    if (cmd === 'preview') { item.disabled = !isHtml; item.hidden = !isHtml; }
    else if (cmd === 'format') item.disabled = !hasFile;
    else item.disabled = !hasFile;
  }
}

async function runCommand(cmd) {
  const path = state.get('openFile');

  // Commands that need no open file.
  if (cmd === 'save') { await save(); return; }
  if (!path) { toast('Open a file first', 'error'); return; }

  // Monaco-backed commands.
  if (editor) {
    const model = editor.getModel();
    switch (cmd) {
      case 'undo':   editor.trigger('toolbar', 'undo', null); return;
      case 'redo':   editor.trigger('toolbar', 'redo', null); return;
      case 'cut':    editor.trigger('toolbar', 'editor.action.clipboardCutAction', null); return;
      case 'copy':   editor.trigger('toolbar', 'editor.action.clipboardCopyAction', null); return;
      case 'selectAll': editor.trigger('toolbar', 'editor.action.selectAll', null); return;
      case 'find':   editor.trigger('toolbar', 'actions.find', null); return;
      case 'format': editor.getAction('editor.action.formatDocument')
                       ?.run().catch(() => toast('No formatter for this language', 'error'));
                     return;
      case 'copyAll': {
        const text = model ? model.getValue() : '';
        if (!text) { toast('File is empty', 'error'); return; }
        const ok = await copyText(text);
        toast(ok ? 'Copied whole file' : 'Copy blocked by browser', ok ? 'success' : 'error');
        return;
      }
      case 'paste': {
        // Prefer the async clipboard API; fall back to a prompt because
        // Android WebView often denies clipboard read without a user gesture.
        let text = null;
        try {
          if (navigator.clipboard && navigator.clipboard.readText) {
            text = await navigator.clipboard.readText();
          }
        } catch { text = null; }
        if (text == null) {
          text = await promptDialog({
            title: 'Paste',
            message: 'Clipboard access was blocked. Paste your text below.',
            okLabel: 'Insert',
          });
          if (text == null) return;
        }
        if (!text) { toast('Clipboard is empty', 'error'); return; }
        const sel = editor.getSelection();
        editor.executeEdits('toolbar', [{ range: sel, text, forceMoveMarkers: true }]);
        editor.focus();
        toast('Pasted', 'success');
        return;
      }
      case 'preview': openHtmlPreview(path); return;
    }
  }

  // Fallbacks when Monaco is not available (e.g. CDN blocked).
  if (cmd === 'copyAll') {
    const text = state.get('fileContent') || '';
    if (!text) { toast('File is empty', 'error'); return; }
    const ok = await copyText(text);
    toast(ok ? 'Copied whole file' : 'Copy blocked by browser', ok ? 'success' : 'error');
    return;
  }
  if (cmd === 'preview') { openHtmlPreview(path); return; }
  toast('Editor not ready yet', 'error');
}

/** Render an HTML file in a sandboxed iframe overlay. */
function openHtmlPreview(path) {
  const content = editor ? editor.getValue() : (state.get('fileContent') || '');
  const overlay = document.createElement('div');
  overlay.className = 'html-preview-overlay';
  overlay.innerHTML =
    '<div class="hp-head">' +
      '<span class="hp-title"></span>' +
      '<div class="hp-actions">' +
        '<button class="btn hp-reload" type="button">Reload</button>' +
        '<button class="btn hp-close" type="button">Close</button>' +
      '</div>' +
    '</div>' +
    '<iframe class="hp-frame" sandbox="allow-scripts allow-forms allow-modals"></iframe>';
  overlay.querySelector('.hp-title').textContent = path.split('/').pop();

  const frame = overlay.querySelector('.hp-frame');
  const load = () => { frame.srcdoc = content; };
  load();

  overlay.querySelector('.hp-reload').onclick = load;
  const close = () => overlay.remove();
  overlay.querySelector('.hp-close').onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  document.body.appendChild(overlay);
}

/** Update the language badge + file label in the toolbar. */
function renderToolbarInfo() {
  const path = state.get('openFile');
  if (langBadge) {
    if (!path) { langBadge.hidden = true; }
    else {
      const lang = detectLang(path);
      const isHtml = HTML_EXT.test(path);
      langBadge.hidden = false;
      langBadge.textContent = isHtml ? 'HTML' : lang;
      langBadge.className = 'ed-lang-badge' + (isHtml ? ' html' : '');
      langBadge.title = isHtml ? 'HTML file — Preview available in Edit menu' : lang;
    }
  }
  if (fileInfo) fileInfo.textContent = path || '';
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
      renderToolbarInfo();
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
