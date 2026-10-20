import * as state from './core/state.js';
import { emit, on } from './core/bus.js';
import { register, initAll, switchPanel } from './core/lifecycle.js';
import { setupConfirmModal } from './core/ui.js';

import * as chat     from './features/chat.js';
import * as editor   from './features/editor.js';
import * as files    from './features/files.js';
import * as git      from './features/git.js';
import * as settings from './features/settings.js';
import * as terminal from './features/terminal.js';

state.define('currentProject', null, { persist: true });
state.define('openFile', null);
state.define('fileContent', '');
state.define('fileModified', false);
state.define('openTabs', []);
state.define('activeTabPath', null);
state.define('modifiedFiles', {});
state.define('expandedFolders', {});
state.define('chatHistory', [], { persist: true });
state.define('cmdHistory', [], { persist: true });
state.define('termAutoScroll', true,  { persist: true });
state.define('termWebgl',      true,  { persist: true });
state.define('editorWordWrap', true,  { persist: true });
state.define('editorMinimap',  false, { persist: true });
state.define('editorFontSize', 13,    { persist: true });
state.define('autoRunEnabled', false, { persist: true });
state.define('backendOnline',  false);

register('files',    files,    { heavy: false });
register('editor',   editor,   { heavy: true  });
register('chat',     chat,     { heavy: false });
register('terminal', terminal, { heavy: true  });
register('git',      git,      { heavy: false });
register('settings', settings, { heavy: false });

function showPanel(name) {
  if (!name) return;
  const tab = document.querySelector('.ptab[data-panel="' + name + '"]');
  if (!tab) return;
  state.set('activePanel', name);
  document.querySelectorAll('.ptab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  tab.classList.add('active');
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');
  // switchPanel is async and may re-enter via 'panel:show'; swallow rejections
  // so a failed mount can never leave an unhandled promise rejection behind.
  Promise.resolve(switchPanel(name)).catch((err) =>
    console.error('[boot] switchPanel("' + name + '") failed', err));
}

function wirePanels() {
  document.querySelectorAll('.ptab').forEach((tab) => {
    tab.onclick = () => showPanel(tab.getAttribute('data-panel'));
  });
  // Features ask for a panel to be revealed (e.g. editor after opening a file).
  on('panel:show', (p) => showPanel(p && p.name));
}

function wireSideTabs() {
  document.querySelectorAll('.stab').forEach((tab) => {
    tab.onclick = () => {
      const name = tab.getAttribute('data-tab');
      if (!name) return;
      activatePanel(name);
    };
  });

  // Programmatic switches (e.g. a feature asking for the terminal). Keep the
  // tab strip and panel visibility in step with the lifecycle, otherwise the
  // lifecycle thinks "terminal" is active while the chat panel is showing.
  on('terminal:run:request', (p) => activatePanel(p && p.name ? p.name : 'terminal'));
  on('panel:request', (p) => activatePanel(p && p.name ? p.name : 'chat'));
}

/** Make `name` the visible panel. Safe to call repeatedly. */
function activatePanel(name) {
  const tab = document.querySelector('.ptab[data-panel="' + name + '"]');
  if (!tab) return;
  state.set('activePanel', name);
  document.querySelectorAll('.ptab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  tab.classList.add('active');
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');
  switchPanel(name);
}

function wireDrawers() {
  const ml = document.getElementById('menuLeftBtn');
  const mr = document.getElementById('menuRightBtn');
  const bd = document.getElementById('backdrop');
  const ft = document.getElementById('fileTree');
  const sb = document.getElementById('sidebar');
  const closeAll = () => {
    if (ft) ft.classList.remove('open');
    if (sb) sb.classList.remove('open');
    if (bd) bd.classList.remove('active');
  };
  if (ml) ml.onclick = () => { ft.classList.add('open'); bd.classList.add('active'); };
  if (mr) mr.onclick = () => { sb.classList.add('open'); bd.classList.add('active'); };
  if (bd) bd.onclick = closeAll;
}

async function pollStatus() {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  try {
    const r = await fetch('/api/health');
    const d = await r.json();
    if (dot) dot.className = 'dot on';
    if (txt) txt.textContent = 'Online';
    state.set('backendOnline', true);
  } catch {
    if (dot) dot.className = 'dot off';
    if (txt) txt.textContent = 'Offline';
    state.set('backendOnline', false);
  }
}

async function loadProjects() {
  const sel = document.getElementById('projectSelector');
  if (!sel) return;
  try {
    const r = await fetch('/api/fs/list?path=');
    const items = await r.json();
    const dirs = Array.isArray(items) ? items.filter((i) => i.isDir) : [];
    sel.innerHTML = '<option value="">— select project —</option>' +
      dirs.map((d) => '<option value="' + d.name + '">' + d.name + '</option>').join('');
    const cur = state.get('currentProject');
    if (cur) sel.value = cur;
  } catch {}
}

function wireProjectSelector() {
  const sel = document.getElementById('projectSelector');
  if (!sel) return;
  sel.onchange = () => {
    const name = sel.value;
    if (!name) return;
    state.set('currentProject', name);
    emit('project:change', { name });
  };
}

function wireClearChat() {
  const btn = document.getElementById('clearChatBtn');
  if (!btn) return;
  btn.onclick = () => {
    state.set('chatHistory', []);
    const box = document.getElementById('chatMessages');
    if (box) box.innerHTML = '';
  };
}

async function start() {
  console.log('[DS] boot v3.0.0');
  try { setupConfirmModal(); } catch (e) { console.error(e); }

  wirePanels();
  wireSideTabs();
  wireDrawers();
  wireProjectSelector();
  wireClearChat();

  await initAll();

  // The chat panel is the default. Report it through the lifecycle so its
  // internal `activePanel` matches the DOM; earlier this only set the state
  // key and emitted an event, leaving the lifecycle on `null`, so the first
  // tap on the already-visible Chat tab was treated as "no change".
  activatePanel('chat');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
