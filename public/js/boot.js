/* ═══════════════════════════════════════════════════════════════════
   boot.js — the only file that knows about every feature

   No logic lives here. It declares the state keys the features share,
   registers the features with the lifecycle, and starts them.

   Why a separate boot file: features must never import each other
   (that is the rule that keeps the split honest). Something has to
   know the whole set, and this is it — ~60 lines, no behaviour.

   Load order matters only for this file: it is the last <script> in
   index.html, so the DOM is ready when it runs.
   ═══════════════════════════════════════════════════════════════════ */

import * as state from './core/state.js';
import { emit, on } from './core/bus.js';
import { register, initAll, switchPanel } from './core/lifecycle.js';
import { setupConfirmModal, setupContextMenu } from './core/ui.js';

import * as terminal from './features/terminal.js';

/* The migration staging area. It still owns the chat/editor/files panels;
   each carve-out deletes a chunk from it and adds a features/*.js module.
   Imported for its side effects (it defines the functions below) and for
   the named exports that index.html's inline onclick="" attributes call. */
import * as legacy from './legacy.js';

/* ── shared state (declared once, owned by nobody) ────────────────── */
state.define('currentProject', null, { persist: true });
state.define('openFile', null);
state.define('fileContent', '');
state.define('fileModified', false);
state.define('openTabs', []);
state.define('activeTabPath', null);
state.define('modifiedFiles', {});
state.define('bookmarks', [], { persist: true });
state.define('recentFiles', [], { persist: true });
state.define('chatHistory', [], { persist: true });
state.define('cmdHistory', [], { persist: true });
state.define('envVars', {}, { persist: true });
state.define('expandedFolders', {});
state.define('treeCache', {});
state.define('activePanel', 'chat');
state.define('backendOnline', false);
state.define('isAITyping', false);

/* ── preferences (persisted, read by features) ────────────────────── */
state.define('termAutoScroll', true, { persist: true });
state.define('termWebgl', true, { persist: true });
state.define('editorWordWrap', true, { persist: true });
state.define('editorMinimap', false, { persist: true });
state.define('editorFontSize', 13, { persist: true });
state.define('streamEnabled', true, { persist: true });
state.define('autoGitEnabled', true, { persist: true });
state.define('autoRunEnabled', false, { persist: true });

/* ── features ─────────────────────────────────────────────────────── */
/* `heavy: true` → destroyed on panel switch (Monaco / xterm / chat DOM). */
register('terminal', terminal, { heavy: true });

/* ── panel switching ──────────────────────────────────────────────── */
/* The legacy tab strip emits through the bus; the lifecycle decides
   whether the outgoing panel is torn down. */
function wirePanels() {
  document.querySelectorAll('.ptab').forEach((tab) => {
    tab.onclick = () => {
      const name = tab.getAttribute('data-panel');
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

/* ── inline handlers ──────────────────────────────────────────────── */
/* index.html still has 15 onclick="" attributes (quickPrompt, openDrawer,
   openWizardLink, verifyAndSaveWizardKey, closeApiKeyWizard). Inline
   handlers resolve against window, and ES modules are module-scoped, so
   those names are invisible unless we publish them explicitly.

   This list may only SHRINK: as each panel is carved out, its handler
   moves to a data-action listener and the name is deleted here. */
const INLINE_HANDLERS = [
  'openDrawer',
  'quickPrompt',
  'openWizardLink',
  'verifyAndSaveWizardKey',
  'closeApiKeyWizard',
];

function publishInlineHandlers() {
  for (const name of INLINE_HANDLERS) {
    const fn = legacy[name];
    if (typeof fn === 'function') window[name] = fn;
    else console.warn('[boot] inline handler "' + name + '" missing from legacy.js');
  }
}

/* ── start ────────────────────────────────────────────────────────── */
async function start() {
  console.log('[DS] boot v2.7.0 (modular)');

  try { setupConfirmModal(); } catch (e) { console.error('[boot] confirm modal', e); }
  try { setupContextMenu(); } catch (e) { console.error('[boot] context menu', e); }
  publishInlineHandlers();
  wirePanels();

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
