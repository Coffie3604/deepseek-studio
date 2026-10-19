/* ═══════════════════════════════════════════════════════════════════
   js/legacy.js — TEMPORARY shim

   This is the original inline <script> from index.html, moved verbatim
   into an ES module so it can be loaded with <script type="module">.
   It is NOT the target architecture — it is the migration staging area.

   Rules for this file:
     - It may only SHRINK. Every migration step deletes a chunk from here
       and adds a features/*.js module.
     - Do not add new code here.
     - When it is empty, delete it and remove the import in boot.js.

   Carve-out order (ROADMAP.md §1): terminal → files → editor → chat.

   The `var` declarations below are module-scoped now, not globals. The
   export block at the bottom re-publishes the ones that index.html's
   inline onclick="" handlers and other modules still reference.
   ═══════════════════════════════════════════════════════════════════ */

/* The terminal carve-out needs to emit `terminal:run` / `terminal:write`
   instead of touching xterm directly, and the panel switch now goes
   through the lifecycle so heavy features get torn down on mobile.
   Everything else still uses its own module-scoped `var`s and fetch()
   calls; each carve-out replaces those with core/* imports. */
import { emit } from './core/bus.js';
import { switchPanel } from './core/lifecycle.js';
import { aiStreamRaw } from './core/api.js';


/* ═══════════════════════════════════════════════════════════════════
   GLOBAL STATE
   ═══════════════════════════════════════════════════════════════════ */
var API = window.location.protocol === 'file:' ? 'http://127.0.0.1:3001' : window.location.origin;
var editor = null;
var monacoLoaded = false;
var openFile = null;
var fileContent = '';
var fileModified = false;
var openTabs = [];
var activeTabPath = null;
var bookmarks = JSON.parse(localStorage.getItem('ds_bookmarks') || '[]');
var recentFiles = JSON.parse(localStorage.getItem('ds_recent') || '[]');
var chatHistory = JSON.parse(localStorage.getItem('ds_chat') || '[]');
/* Abort plumbing for sendChat() — see stopChat(). */
var chatAbortCtrl = null;
var chatAborted = false;
/* term / ws / termAddons moved to features/terminal.js — this file no
   longer owns a terminal instance. */
var isMobile = window.innerWidth <= 900;
var currentProject = localStorage.getItem('ds_current_project') || null;
var currentLang = { lang: 'unknown', build: null, run: null };
var ctxItem = null;
var confirmCallback = null;
var autoGitEnabled = localStorage.getItem('auto_git') !== 'false';
var autoRunEnabled = localStorage.getItem('auto_run') === 'true';
var streamEnabled = localStorage.getItem('stream_enabled') !== 'false';
var expandedFolders = {};
var treeCache = {};
var deferredInstallPrompt = null;
var activeTabPanel = 'chat';
var modifiedFiles = {};
var cmdHistory = JSON.parse(localStorage.getItem('ds_cmd_history') || '[]');
var envVars = JSON.parse(localStorage.getItem('ds_env_vars') || '{}');
var termAutoScroll = localStorage.getItem('term_auto_scroll') !== 'false';
var termWebgl = localStorage.getItem('term_webgl') !== 'false';
var editorWordWrap = localStorage.getItem('editor_word_wrap') !== 'false';
var editorMinimap = localStorage.getItem('editor_minimap') === 'true';
var editorFontSize = parseInt(localStorage.getItem('editor_font_size') || '13');
var isAITyping = false;
var aiTypingEl = null;
var newFilePrefix = '';

/* External link state for the picker modal */
var lfCurrentPath = '';
var lfCurrentParent = null;
var lfSelectedPath = '';
var lfAllowedRoots = [];
var linkIndex = {};

/* Activity log (persisted) */
var activityLog = JSON.parse(localStorage.getItem('ds_activity') || '[]');

/* NEW: Git/GitHub records — persistent audit log of every git action */
var gitRecords = JSON.parse(localStorage.getItem('ds_git_records') || '[]');

/* ═══════════════════════════════════════════════════════════════════
   CHANGELOG
   ═══════════════════════════════════════════════════════════════════ */
var CHANGELOG = [
  {
    version: '2.4.0', date: '2025-10', type: 'feature',
    items: [
      '🔒 Security: HOME removed from allowed external roots (blocks secret exfiltration via symlink)',
      '🌊 Streaming responses now actually stream when the toggle is ON',
      '⌨️  Keyboard shortcuts no longer fire while typing in inputs',
      '🧰 Single source of truth for AI_TOOLS (server-side)',
      '🔀 New rebase endpoint (POST git-rebase API)',
      '🩺 ds-update refuses to run with local commits instead of silently corrupting',
      '🐛 Fixed TOML compile recipe',
      '✨ Stale-while-revalidate service worker',
    ],
  },
  {
    version: '2.3.0', date: '2025-10', type: 'feature',
    items: [
      '⚡ <b>Compile button</b> — 15+ languages syntax check',
      '📦 <b>Recent artifacts</b> scanner (AAB/APK)',
      '🏷️ <b>Tags list</b> auto-populates in Git panel',
      '📱 <b>18 new Termux:API tools</b> — clipboard, battery, torch, vibrate, volume, TTS, dialog, wifi, location, share, camera, fingerprint, sms, call, contacts, sensor, brightness, IR',
      '🔧 <b>One-tap toolchain install</b> (openjdk-17, gradle)',
      '🔑 <b>Pro license</b> — activate/remove for signed AAB',
      '📜 <b>Git/GitHub records</b> — audit log of every action',
      '📋 <b>Always-visible copy icon</b> on every chat message'
    ]
  },
  {
    version: '2.2.0', date: '2025-10', type: 'feature',
    items: [
      '🔗 External folder linking — symlink any folder from your phone',
      '📁 Folder picker modal with breadcrumb navigation',
      '🛡️ Realpath-verified fs operations (no symlink escapes)',
      '📋 Copy buttons on every copyable surface',
      '🔍 In-chat search with match highlighting',
      '📜 Updates &amp; Activity log panel'
    ]
  },
  {
    version: '2.1.0', date: '2025-10', type: 'feature',
    items: [
      '🩺 Dynamic ESM import for <code>editkit</code>',
      '📊 Library status badges in Setup',
      '🎨 GPU renderer toggle for terminal (WebGL)',
      '🔎 Terminal search bar (Ctrl+F)'
    ]
  },
  {
    version: '2.0.0', date: '2025-10', type: 'feature',
    items: [
      '⚡ <b>simple-git</b> — fluent git operations',
      '🐙 <b>@octokit/rest</b> — typed GitHub API',
      '🖥️ <b>node-pty</b> — real TTY',
      '🧠 <b>editkit</b> — fuzzy SEARCH/REPLACE',
      '🎨 xterm.js 5.5 + WebGL/search/unicode11/serialize',
      '🔐 Server-side secret store'
    ]
  },
  {
    version: '1.0.0', date: '2025-09', type: 'feature',
    items: ['🎉 Initial release']
  }
];

/* ═══════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════ */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function logActivity(kind, message) {
  var entry = { ts: Date.now(), kind: kind, message: String(message).slice(0, 200) };
  activityLog.unshift(entry);
  activityLog = activityLog.slice(0, 100);
  try { localStorage.setItem('ds_activity', JSON.stringify(activityLog)); } catch (e) {}
  renderActivity();
}

function renderActivity() {
  var el = document.getElementById('activityList');
  if (!el) return;
  if (!activityLog.length) {
    el.innerHTML = '<div style="color:var(--fg-4);font-size:11px;padding:6px">No activity yet</div>';
    return;
  }
  el.innerHTML = '';
  var iconMap = { file: 'fa-file-code', tool: 'fa-cog', error: 'fa-exclamation-triangle', save: 'fa-save', git: 'fa-code-branch' };
  activityLog.slice(0, 30).forEach(function(a) {
    var div = document.createElement('div');
    div.className = 'activity-item kind-' + a.kind;
    var d = new Date(a.ts);
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    var ss = String(d.getSeconds()).padStart(2, '0');
    div.innerHTML =
      '<span class="act-time">' + hh + ':' + mm + ':' + ss + '</span>' +
      '<span class="act-icon"><i class="fas ' + (iconMap[a.kind] || 'fa-circle') + '"></i></span>' +
      '<span class="act-body">' + escapeHtml(a.message) + '</span>';
    el.appendChild(div);
  });
}

/* ─── Git/GitHub Records ─── */
function logGitRecord(kind, summary, detail) {
  var rec = {
    ts: Date.now(),
    kind: String(kind || 'git'),
    summary: String(summary || '').slice(0, 200),
    detail: detail ? String(detail).slice(0, 500) : ''
  };
  gitRecords.unshift(rec);
  gitRecords = gitRecords.slice(0, 150);
  try { localStorage.setItem('ds_git_records', JSON.stringify(gitRecords)); } catch (e) {}
  renderGitRecords();
}

function renderGitRecords() {
  var el = document.getElementById('gitRecordsList');
  if (!el) return;
  if (!gitRecords.length) {
    el.innerHTML = '<div style="color:var(--fg-4);font-size:11px;padding:6px">No git activity yet</div>';
    return;
  }
  var icons = {
    clone:  { i: 'fa-cloud-download-alt', c: 'var(--blue)' },
    commit: { i: 'fa-check-circle',      c: 'var(--green)' },
    push:   { i: 'fa-upload',             c: 'var(--green)' },
    pull:   { i: 'fa-download',           c: 'var(--blue)' },
    fetch:  { i: 'fa-sync',               c: 'var(--blue)' },
    branch: { i: 'fa-code-branch',        c: '#A97BFF' },
    merge:  { i: 'fa-code-branch',        c: 'var(--yellow)' },
    tag:    { i: 'fa-tag',                c: 'var(--yellow)' },
    stash:  { i: 'fa-box',                c: 'var(--fg-2)' },
    reset:  { i: 'fa-undo',               c: 'var(--red)' },
    revert: { i: 'fa-undo',               c: 'var(--orange)' },
    identity:{ i: 'fa-id-card',           c: 'var(--blue)' },
    token:  { i: 'fa-key',                c: 'var(--yellow)' },
    error:  { i: 'fa-exclamation-triangle', c: 'var(--red)' }
  };
  var html = '';
  gitRecords.slice(0, 50).forEach(function(r) {
    var meta = icons[r.kind] || { i: 'fa-code-branch', c: 'var(--fg-3)' };
    var d = new Date(r.ts);
    var pad = function(n) { return String(n).padStart(2, '0'); };
    var stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
                ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    html += '<div class="activity-item kind-git">' +
      '<span class="act-time" title="' + stamp + '">' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '</span>' +
      '<span class="act-icon" style="color:' + meta.c + '"><i class="fas ' + meta.i + '"></i></span>' +
      '<span class="act-body"><b style="color:' + meta.c + ';text-transform:uppercase;font-size:9px;letter-spacing:.5px">' + r.kind + '</b> — ' +
        escapeHtml(r.summary) +
        (r.detail ? '<br><span style="color:var(--fg-3);font-size:10px;font-family:monospace">' + escapeHtml(r.detail) + '</span>' : '') +
      '</span></div>';
  });
  el.innerHTML = html;
}

function renderChangelog() {
  var el = document.getElementById('changelogList');
  if (!el) return;
  el.innerHTML = '';
  /* Prefer server-canonical changelog; fall back to the embedded copy on failure. */
  fetch(API + '/api/changelog').then(function(r) { return r.json(); }).then(function(d) {
    if (d && Array.isArray(d.changelog) && d.changelog.length) renderChangelogList(d.changelog);
  }).catch(function() {});
  renderChangelogList(CHANGELOG);
}
function renderChangelogList(entries) {
  var el = document.getElementById('changelogList');
  if (!el) return;
  el.innerHTML = '';
  entries.forEach(function(entry) {
    var div = document.createElement('div');
    div.className = 'log-entry ' + (entry.type || 'feature');
    var badgeText = entry.type === 'fix' ? 'Fix' : entry.type === 'breaking' ? 'Breaking' : 'New';
    var html = '<div class="log-head">' +
                 '<span class="log-version">v' + entry.version + '</span>' +
                 '<span class="log-date">' + entry.date + '</span>' +
                 '<span class="log-badge ' + (entry.type || 'feature') + '">' + badgeText + '</span>' +
               '</div>' +
               '<ul>';
    entry.items.forEach(function(item) { html += '<li>' + item + '</li>'; });
    html += '</ul>';
    div.innerHTML = html;
    el.appendChild(div);
  });
}

function renderSystemHealth() {
  var el = document.getElementById('sysHealthStatus');
  if (!el) return;
  fetch(API + '/api/health').then(function(r) { return r.json(); }).then(function(d) {
    if (d && d.ok) {
      el.textContent = '✅ healthy · last check ' + new Date(d.ts || Date.now()).toLocaleTimeString();
      el.style.color = 'var(--green)';
    } else {
      el.textContent = '⚠️ unhealthy'; el.style.color = 'var(--yellow)';
    }
  }).catch(function() { el.textContent = '✗ unreachable'; el.style.color = 'var(--red)'; });
}

function renderDiagnostics() {
  var el = document.getElementById('sysDiagnostics');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = 'Loading diagnostics…';
  fetch(API + '/api/diagnostics').then(function(r) { return r.json(); }).then(function(d) {
    var libs = d.libs || {}, feats = d.features || {};
    var on = Object.keys(libs).filter(function(k) { return libs[k]; });
    var off = Object.keys(libs).filter(function(k) { return !libs[k]; });
    var lines = [
      'version   : ' + (d.version || '?'),
      'node      : ' + (d.node || '?'),
      'platform  : ' + (d.platform || '?') + ' / ' + (d.arch || '?'),
      'uptime    : ' + (d.uptime || 0) + 's',
      'workspace : ' + (d.workspace || '?'),
      'linkCount : ' + (d.linkCount || 0),
      'ghToken   : ' + (d.hasGitHubToken ? 'yes' : 'no'),
      '',
      'libs on   : ' + (on.join(', ') || '(none)'),
      'libs off  : ' + (off.join(', ') || '(none)'),
      'features  : ' + Object.keys(feats).filter(function(k) { return feats[k]; }).join(', ')
    ];
    el.textContent = lines.join('\n');
  }).catch(function(err) { el.textContent = 'Diagnostics failed: ' + err; });
}

function renderCurrentVersion() {
  var el = document.getElementById('logCurrentVersion');
  if (!el) return;
  fetch(API + '/api/version').then(function(r) { return r.json(); }).then(function(d) {
    var libs = d.libs || {};
    var active = Object.keys(libs).filter(function(k) { return libs[k]; }).length;
    el.innerHTML = 'v' + (d.version || '?') + ' · Node ' + (d.node || '?') + ' · ' +
                   active + '/' + Object.keys(libs).length + ' libs loaded';
  }).catch(function() {
    el.textContent = 'Backend offline';
    el.style.color = 'var(--red)';
  });
}

/* Universal copy helper */
function copyText(text, btnOrEl) {
  var onOk = function() {
    if (btnOrEl && btnOrEl.classList) {
      btnOrEl.classList.add('copied');
      var old = btnOrEl.innerHTML;
      btnOrEl.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(function() {
        btnOrEl.classList.remove('copied');
        btnOrEl.innerHTML = old;
      }, 1400);
    }
    toast('Copied', 'success');
  };
  var onFail = function() { toast('Copy failed', 'error'); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onOk).catch(function() {
      fallbackCopy(text) ? onOk() : onFail();
    });
  } else {
    fallbackCopy(text) ? onOk() : onFail();
  }
}

/* ═══════════════════════════════════════════════════════════════════
   AI PROVIDER
   ═══════════════════════════════════════════════════════════════════ */
function getAIProvider() { return localStorage.getItem('ai_provider') || 'deepseek'; }
function getAIEndpoint() {
  var provider = getAIProvider();
  if (provider === 'gemini') {
    var key = localStorage.getItem('gemini_key') || '';
    return { provider: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + key, key: key };
  }
  return { provider: 'deepseek', url: 'https://api.deepseek.com/v1/chat/completions', key: localStorage.getItem('ds_key') || '' };
}

/* The server is the source of truth for keys (it reads ~/.deepseek-secrets.json).
   localStorage can be stale/empty after a reinstall, so ask the server first.
   These three were dropped during the extract-to-module move and the export
   block below still referenced them, which made the whole module fail to
   parse — i.e. the app booted to a blank page. Restored verbatim. */
var serverProviders = [];
function refreshServerProviders() {
  return fetch(API + '/api/ai/providers')
    .then(function(r) { return r.json(); })
    .then(function(list) {
      serverProviders = (list || []).filter(function(p) { return p.configured; }).map(function(p) { return p.id; });
      return serverProviders;
    })
    .catch(function() { return serverProviders; });
}
function providerReady(provider) {
  if (serverProviders.indexOf(provider) !== -1) return true;
  return !!(localStorage.getItem(provider === 'gemini' ? 'gemini_key' : 'ds_key') || '').trim();
}
/* Push a key to the server (source of truth) and refresh the cached list. */
function saveKeyToServer(name, value) {
  return fetch(API + '/api/secrets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, value: value }),
  }).then(function(r) { return r.json(); })
    .then(function(d) { return refreshServerProviders().then(function() { return d; }); })
    .catch(function() { return { ok: false }; });
}

/* ═══════════════════════════════════════════════════════════════════
   TOAST
   ═══════════════════════════════════════════════════════════════════ */


function toast(msg, type) {
  type = type || 'info';
  var t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function() { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2800);
  setTimeout(function() { t.remove(); }, 3200);
}

/* promptDialog — promise-based text prompt with nicer UX than window.prompt().
   Resolves with the entered string, or null if cancelled/dismissed. */
function promptDialog(opts) {
  opts = opts || {};
  return new Promise(function(resolve) {
    var title = opts.title || 'Input';
    var message = opts.message || '';
    var def = opts.default != null ? String(opts.default) : '';
    var okLabel = opts.okLabel || 'OK';
    var cancelLabel = opts.cancelLabel || 'Cancel';
    var placeholder = opts.placeholder || '';

    var ov = document.createElement('div');
    ov.className = 'pd-overlay';
    var box = document.createElement('div');
    box.className = 'pd-box';
    var h = document.createElement('div');
    h.className = 'pd-title';
    h.textContent = title;
    box.appendChild(h);
    if (message) {
      var m = document.createElement('div');
      m.className = 'pd-message';
      m.textContent = message;
      box.appendChild(m);
    }
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'pd-input';
    inp.value = def;
    inp.placeholder = placeholder;
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    box.appendChild(inp);
    var row = document.createElement('div');
    row.className = 'pd-row';
    var cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.style.cssText = 'padding:8px 14px';
    cancel.textContent = cancelLabel;
    var ok = document.createElement('button');
    ok.className = 'btn primary';
    ok.style.cssText = 'padding:8px 14px';
    ok.textContent = okLabel;
    var done = function(val) { if (ov.parentNode) ov.parentNode.removeChild(ov); resolve(val); };
    cancel.onclick = function() { done(null); };
    ok.onclick = function() { done(inp.value); };
    inp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); done(inp.value); }
      if (e.key === 'Escape') done(null);
    });
    ov.onclick = function(e) { if (e.target === ov) done(null); };
    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(row);
    ov.appendChild(box);
    document.body.appendChild(ov);
    setTimeout(function() { inp.focus(); inp.select(); }, 30);
  });
}

/* ═══════════════════════════════════════════════════════════════════
   FS HELPERS
   ═══════════════════════════════════════════════════════════════════ */
function fsList(p) { return fetch(API + '/api/fs/list?path=' + encodeURIComponent(p || '')).then(function(r) { return r.json(); }); }
function fsRead(p) { return fetch(API + '/api/fs/read?path=' + encodeURIComponent(p)).then(function(r) { return r.json(); }); }
function fsWrite(p, content) { return fetch(API + '/api/fs/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p, content: content }) }).then(function(r) { return r.json(); }); }
function fsDelete(p) { return fetch(API + '/api/fs/delete?path=' + encodeURIComponent(p), { method: 'DELETE' }).then(function(r) { return r.json(); }); }
function fsRename(oldPath, newPath) { return fetch(API + '/api/fs/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPath: oldPath, newPath: newPath }) }).then(function(r) { return r.json(); }); }
async function ghCall(endpoint, body) { var r = await fetch(API + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }

/* ═══════════════════════════════════════════════════════════════════
   LINKS API
   ═══════════════════════════════════════════════════════════════════ */
function loadLinkIndex() {
  return fetch(API + '/api/fs/links').then(function(r) { return r.json(); }).then(function(data) {
    linkIndex = {};
    (data.links || []).forEach(function(l) { linkIndex[l.name] = l; });
    return linkIndex;
  }).catch(function() { return {}; });
}
function createLink(target, name) {
  return fetch(API + '/api/fs/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: target, name: name || undefined })
  }).then(function(r) { return r.json(); });
}
function removeLink(name) {
  return fetch(API + '/api/fs/link?name=' + encodeURIComponent(name), { method: 'DELETE' })
    .then(function(r) { return r.json(); });
}

/* ═══════════════════════════════════════════════════════════════════
   DRAWERS / TABS
   ═══════════════════════════════════════════════════════════════════ */
function openDrawer(which) {
  var map = { left: 'fileTree', right: 'sidebar' };
  var el = document.getElementById(map[which]);
  if (el) el.classList.add('open');
  var bd = document.getElementById('backdrop');
  if (bd) bd.classList.add('active');
}
function closeDrawers() {
  document.getElementById('fileTree').classList.remove('open');
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('backdrop').classList.remove('active');
}
function setupPrimaryTabs() {
  document.querySelectorAll('.ptab').forEach(function(tab) {
    tab.onclick = function() { switchPrimaryPanel(this.getAttribute('data-panel')); };
  });
}
function switchPrimaryPanel(name) {
  activeTabPanel = name;
  document.querySelectorAll('.ptab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
  var tab = document.querySelector('.ptab[data-panel="' + name + '"]');
  var panel = document.getElementById('panel-' + name);
  if (tab) tab.classList.add('active');
  if (panel) panel.classList.add('active');
  // Hand the switch to the lifecycle: it unmounts the outgoing panel and
  // destroys it if it is heavy (xterm today, Monaco/chat as they land).
  // Without this the terminal was never torn down on mobile.
  switchPanel(name).catch(function(e) { console.warn('[panel] switch failed', e); });
  if (name === 'editor' && !monacoLoaded) loadMonaco();
  // Terminal fit/focus on mount is features/terminal.js's job (mount()).
  if (name === 'editor') showTabBadge('editor', false);
  if (name === 'terminal') showTabBadge('terminal', false);
}
function showTabBadge(tabName, show) {
  var badge = document.getElementById(tabName + 'Badge');
  if (badge) badge.className = 'tab-badge' + (show ? ' show' : '');
}

/* ═══════════════════════════════════════════════════════════════════
   FILE TREE
   ═══════════════════════════════════════════════════════════════════ */
function refreshTree() {
  loadLinkIndex().then(function() {
    treeCache = {};
    loadTreeLevel('');
  });
}
function loadTreeLevel(parentPath) { fsList(parentPath).then(function(items) { treeCache[parentPath] = items; renderTree(); }); }
function renderTree() {
  var body = document.getElementById('ftBody');
  body.innerHTML = '';
  var rootItems = treeCache[''] || [];
  if (!rootItems.length) {
    body.innerHTML = '<div class="ft-empty">Empty workspace<br><br>Use <b>Templates</b>, <b>Generate</b>, or click the <b>🔗</b> button above to link a folder from your phone</div>';
    return;
  }
  renderItems(rootItems, 0, body);
}
function renderItems(items, depth, container) {
  items.forEach(function(it) {
    var div = document.createElement('div');
    var isExpanded = expandedFolders[it.path];
    div.className = 'tree-item' + (openFile === it.path ? ' active' : '');
    div.style.paddingLeft = (10 + depth * 14) + 'px';

    var chevronHtml = it.isDir
      ? '<i class="fas fa-chevron-right chevron' + (isExpanded ? ' open' : '') + '"></i>'
      : '<span class="chevron"></span>';

    var iconClass;
    if (it.isLink) iconClass = isExpanded ? 'fa-folder-open' : 'fa-folder';
    else if (it.isDir) iconClass = isExpanded ? 'fa-folder-open' : 'fa-folder';
    else iconClass = getFileIcon(it.name);
    var iconColor = it.isLink ? 'color:#58a6ff' : fileIconColor(it.name, it.isDir);

    var linkBadge = it.isLink
      ? '<span class="file-badge link" title="Linked from ' + (linkIndex[it.name] ? linkIndex[it.name].target : 'external') + '" style="background:#1f6feb22;color:var(--blue)">🔗</span>'
      : '';

    var modBadge = '';
    if (!it.isDir && modifiedFiles[it.path]) modBadge = '<span class="file-badge modified">M</span>';

    div.innerHTML = chevronHtml + '<i class="fas ' + iconClass + ' tree-icon" style="' + iconColor + '"></i>' +
                    '<span class="tree-name">' + escAttr(it.name) + '</span>' + linkBadge + modBadge;

    div.onclick = function() {
      if (it.isDir) {
        if (expandedFolders[it.path]) { delete expandedFolders[it.path]; renderTree(); }
        else { expandedFolders[it.path] = true; if (!treeCache[it.path]) loadTreeLevel(it.path); else renderTree(); }
      } else { openFileFromTree(it.path); if (isMobile) closeDrawers(); }
    };
    var pressTimer = null;
    div.addEventListener('touchstart', function(e) {
      pressTimer = setTimeout(function() { showContextMenu(it, e); if (navigator.vibrate) navigator.vibrate(30); }, 550);
    }, { passive: true });
    div.addEventListener('touchend', function() { clearTimeout(pressTimer); });
    div.addEventListener('touchmove', function() { clearTimeout(pressTimer); });
    div.addEventListener('contextmenu', function(e) { e.preventDefault(); showContextMenu(it, e); });
    container.appendChild(div);
    if (it.isDir && isExpanded && treeCache[it.path]) renderItems(treeCache[it.path], depth + 1, container);
  });
}
function getFileIcon(name) {
  var ext = name.split('.').pop().toLowerCase();
  if (['kt','kts','java','py','js','ts','jsx','tsx','dart','rs','go','swift','c','cpp','h','html','htm','css','scss','sass','json','xml','yaml','yml','sh','bash','toml','ini','conf','gradle'].includes(ext)) return 'fa-file-code';
  if (['md','markdown','txt','rst'].includes(ext)) return 'fa-file-alt';
  if (['png','jpg','jpeg','gif','svg','webp','ico','bmp'].includes(ext)) return 'fa-file-image';
  if (['mp4','webm','avi','mov','mkv'].includes(ext)) return 'fa-file-video';
  if (['mp3','wav','ogg','flac','m4a'].includes(ext)) return 'fa-file-audio';
  if (['zip','tar','gz','rar','7z','xz','bz2'].includes(ext)) return 'fa-file-archive';
  if (['pdf'].includes(ext)) return 'fa-file-pdf';
  if (['csv','xls','xlsx'].includes(ext)) return 'fa-file-excel';
  if (['doc','docx','odt'].includes(ext)) return 'fa-file-word';
  return 'fa-file';
}
function fileIconColor(name, isDir) {
  if (isDir) return 'color:var(--blue)';
  var ext = name.split('.').pop().toLowerCase();
  if (['py'].includes(ext)) return 'color:#3572A5';
  if (['js','jsx','mjs','cjs'].includes(ext)) return 'color:#f1e05a';
  if (['ts','tsx'].includes(ext)) return 'color:#3178c6';
  if (['kt','kts'].includes(ext)) return 'color:#A97BFF';
  if (['java'].includes(ext)) return 'color:#b07219';
  if (['dart'].includes(ext)) return 'color:#00B4AB';
  if (['rs'].includes(ext)) return 'color:#dea584';
  if (['go'].includes(ext)) return 'color:#00ADD8';
  if (['swift'].includes(ext)) return 'color:#ffac45';
  if (['html','htm'].includes(ext)) return 'color:#e34c26';
  if (['css','scss','sass'].includes(ext)) return 'color:#563d7c';
  if (['json'].includes(ext)) return 'color:#cbcb41';
  if (['md','markdown'].includes(ext)) return 'color:#519aba';
  if (['sh','bash'].includes(ext)) return 'color:#89e051';
  if (['yml','yaml','toml','ini','conf'].includes(ext)) return 'color:#6d8086';
  if (['png','jpg','jpeg','gif','svg','webp'].includes(ext)) return 'color:#a074c4';
  return 'color:var(--orange)';
}

/* ═══════════════════════════════════════════════════════════════════
   LINK FOLDER MODAL
   ═══════════════════════════════════════════════════════════════════ */
function openLinkFolderModal() {
  lfSelectedPath = '';
  lfCurrentPath = '';
  lfCurrentParent = null;
  document.getElementById('lfNameInput').value = '';
  document.getElementById('lfStatus').textContent = '';
  document.getElementById('lfLinkBtn').disabled = true;
  document.getElementById('linkFolderModal').classList.add('active');
  browseTo('');
}
function closeLinkFolderModal() {
  document.getElementById('linkFolderModal').classList.remove('active');
}
function browseTo(p) {
  var url = API + '/api/fs/browse' + (p ? '?path=' + encodeURIComponent(p) : '');
  var list = document.getElementById('lfList');
  list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--fg-3);font-size:12px">Loading…</div>';
  fetch(url).then(function(r) { return r.json(); }).then(function(data) {
    if (data.error) {
      list.innerHTML = '<div style="padding:16px;color:var(--red);font-size:12px">' + data.error + '</div>';
      return;
    }
    if (data.roots) lfAllowedRoots = data.items.map(function(i) { return i.path; });
    lfCurrentPath = data.path || '';
    lfCurrentParent = data.parent;
    renderBreadcrumb();
    renderFolderList(data.items || [], data.roots);
  }).catch(function(e) {
    list.innerHTML = '<div style="padding:16px;color:var(--red);font-size:12px">Error: ' + e.message + '</div>';
  });
}
function renderBreadcrumb() {
  var bc = document.getElementById('lfBreadcrumb');
  bc.innerHTML = '';
  if (!lfCurrentPath) {
    bc.innerHTML = '<span style="color:var(--fg-3)">Pick a starting location</span>';
    return;
  }
  var parts = lfCurrentPath.split('/').filter(Boolean);
  var acc = '';
  parts.forEach(function(part, i) {
    acc += '/' + part;
    var span = document.createElement('span');
    span.textContent = part;
    span.style.cursor = 'pointer';
    span.style.color = 'var(--blue)';
    span.onclick = function() { browseTo(acc); };
    bc.appendChild(span);
    if (i < parts.length - 1) {
      var sep = document.createElement('span');
      sep.textContent = '/';
      sep.style.color = 'var(--fg-4)';
      bc.appendChild(sep);
    }
  });
}
function renderFolderList(items, isRoots) {
  var list = document.getElementById('lfList');
  list.innerHTML = '';

  if (!isRoots && lfCurrentPath) {
    var useBtn = document.createElement('div');
    useBtn.style.cssText = 'padding:10px 12px;background:#1f6feb22;border-radius:6px;margin:4px 0;cursor:pointer;font-size:12px;color:var(--blue);font-weight:600';
    useBtn.innerHTML = '<i class="fas fa-check-circle"></i> Use this folder (' + (lfCurrentPath.split('/').pop() || lfCurrentPath) + ')';
    useBtn.onclick = function() { selectFolder(lfCurrentPath); };
    list.appendChild(useBtn);
  }

  if (!items.length) {
    var empty = document.createElement('div');
    empty.style.cssText = 'padding:16px;text-align:center;color:var(--fg-4);font-size:12px';
    empty.textContent = 'No subfolders';
    list.appendChild(empty);
    return;
  }

  items.forEach(function(it) {
    var row = document.createElement('div');
    row.style.cssText = 'padding:10px 12px;display:flex;align-items:center;gap:10px;cursor:pointer;border-radius:6px;font-size:13px';
    row.onmouseenter = function() { row.style.background = 'var(--bg-3)'; };
    row.onmouseleave = function() { row.style.background = 'transparent'; };
    row.innerHTML = '<i class="fas fa-folder" style="color:var(--blue);width:16px"></i>' +
                    '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escAttr(it.name) + '</span>' +
                    '<i class="fas fa-chevron-right" style="color:var(--fg-4);font-size:10px"></i>';
    if (isRoots) { row.title = it.path; }
    row.onclick = function() { browseTo(it.path); };
    list.appendChild(row);
  });
}
function selectFolder(path) {
  lfSelectedPath = path;
  var nameInput = document.getElementById('lfNameInput');
  if (!nameInput.value) {
    nameInput.placeholder = 'Defaults to "' + (path.split('/').pop() || 'link') + '"';
  }
  document.getElementById('lfLinkBtn').disabled = false;
  document.getElementById('lfStatus').textContent = '📁 Selected: ' + path;
  document.getElementById('lfStatus').style.color = 'var(--blue)';
}
function doCreateLink() {
  if (!lfSelectedPath) { toast('Select a folder first', 'error'); return; }
  var name = (document.getElementById('lfNameInput').value || '').trim();
  var btn = document.getElementById('lfLinkBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Linking…';
  createLink(lfSelectedPath, name || undefined).then(function(r) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-link"></i> Link this folder';
    if (r.ok) {
      toast('Linked: ' + r.link.name, 'success');
      logActivity('file', 'Linked external folder: ' + r.link.name);
      closeLinkFolderModal();
      refreshTree();
      loadLinksList();
    } else {
      document.getElementById('lfStatus').textContent = '❌ ' + (r.error || 'Link failed');
      document.getElementById('lfStatus').style.color = 'var(--red)';
    }
  }).catch(function(e) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-link"></i> Link this folder';
    document.getElementById('lfStatus').textContent = '❌ ' + e.message;
    document.getElementById('lfStatus').style.color = 'var(--red)';
  });
}
function loadLinksList() {
  var el = document.getElementById('linksList');
  if (!el) return;
  fetch(API + '/api/fs/links').then(function(r) { return r.json(); }).then(function(data) {
    var links = data.links || [];
    if (!links.length) {
      el.innerHTML = '<div style="color:var(--fg-4);font-size:11px;padding:6px">No external folders linked yet.</div>';
      return;
    }
    el.innerHTML = '';
    links.forEach(function(l) {
      var row = document.createElement('div');
      row.className = 'env-row';
      row.style.alignItems = 'center';
      var status = l.broken ? '⚠️' : (l.targetExists ? '✅' : '❌');
      var bg = l.broken ? '#9e6a0322' : (l.targetExists ? '#23863622' : '#da363322');
      row.style.background = bg;
      row.style.padding = '6px 10px';
      row.style.borderRadius = '6px';
      row.innerHTML = '<span style="flex:1;font-size:11px;line-height:1.4;overflow:hidden">' +
        '<b style="color:var(--fg-1)">' + status + ' ' + l.name + '</b><br>' +
        '<span style="color:var(--fg-3);font-family:monospace;font-size:10px;word-break:break-all">' + l.target + '</span>' +
      '</span>';
      var btn = document.createElement('button');
      btn.className = 'btn';
      btn.style.cssText = 'padding:6px 10px;font-size:11px';
      btn.innerHTML = '<i class="fas fa-unlink"></i>';
      btn.title = 'Unlink (folder is preserved)';
      btn.onclick = function() {
        showConfirm('Unlink "' + l.name + '"?',
          'The external folder is NOT deleted — only the link inside the workspace is removed.',
          function() {
            removeLink(l.name).then(function(r) {
              if (r.ok) { toast('Unlinked', 'success'); logActivity('file', 'Unlinked: ' + l.name); refreshTree(); loadLinksList(); }
              else toast(r.error || 'Unlink failed', 'error');
              hideConfirm();
            });
          }, 'Unlink');
      };
      row.appendChild(btn);
      el.appendChild(row);
    });
  }).catch(function() {
    el.innerHTML = '<div style="color:var(--red);font-size:11px">Backend offline</div>';
  });
}

/* ═══════════════════════════════════════════════════════════════════
   CONTEXT MENU / CONFIRM
   ═══════════════════════════════════════════════════════════════════ */
function showContextMenu(it, e) {
  ctxItem = it;
  var m = document.getElementById('ctxMenu');
  document.getElementById('ctxTitle').textContent = it.name;
  document.getElementById('ctxBookmark').innerHTML = '<i class="' + (bookmarks.indexOf(it.path) >= 0 ? 'fas' : 'far') + ' fa-star"></i> ' + (bookmarks.indexOf(it.path) >= 0 ? 'Remove bookmark' : 'Bookmark');

  var unlinkEl = document.getElementById('ctxUnlink');
  if (unlinkEl) { unlinkEl.style.display = it.isLink ? 'flex' : 'none'; }

  var rect = (e && e.target && e.target.getBoundingClientRect) ? e.target.getBoundingClientRect() : { left: 20, top: 150, bottom: 200 };
  var left = Math.min(rect.left, window.innerWidth - 240);
  var top = rect.bottom + 5;
  if (top + 480 > window.innerHeight - 10) top = Math.max(10, rect.top - 480);
  m.style.left = Math.max(10, left) + 'px';
  m.style.top = top + 'px';
  m.classList.add('active');
}
function hideContextMenu() { document.getElementById('ctxMenu').classList.remove('active'); ctxItem = null; }

function showConfirm(title, msg, cb, okLabel) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMsg').textContent = msg;
  document.getElementById('confirmOk').textContent = okLabel || 'Confirm';
  confirmCallback = cb;
  document.getElementById('confirmModal').classList.add('active');
}
function hideConfirm() { document.getElementById('confirmModal').classList.remove('active'); confirmCallback = null; }

/* ═══════════════════════════════════════════════════════════════════
   FILE OPERATIONS
   ═══════════════════════════════════════════════════════════════════ */
function renameItem(item) {
  var newName = window.prompt('Rename to:', item.name);
  if (!newName || newName === item.name) { hideContextMenu(); return; }
  if (item.isLink) { toast('Cannot rename a linked folder — unlink and re-link instead', 'warn'); hideContextMenu(); return; }
  var dir = item.path.split('/').slice(0, -1).join('/');
  var newPath = dir ? dir + '/' + newName : newName;
  fsRename(item.path, newPath).then(function(r) {
    if (r.ok) { toast('Renamed', 'success'); logActivity('file', 'Renamed: ' + item.path + ' → ' + newPath); refreshTree(); if (openFile === item.path) { openFile = newPath; renderEditorTabs(); } }
    else toast('Rename failed: ' + (r.error || ''), 'error');
    hideContextMenu();
  });
}
function detectLangForPath(path) {
  var ext = path.split('.').pop().toLowerCase();
  var map = { kt:'kotlin', kts:'kotlin', py:'python', dart:'dart', js:'javascript', jsx:'javascript', mjs:'javascript', cjs:'javascript', html:'html', htm:'html', css:'css', scss:'scss', sass:'scss', rs:'rust', go:'go', java:'java', ts:'typescript', tsx:'typescript', json:'json', xml:'xml', yaml:'yaml', yml:'yaml', toml:'ini', ini:'ini', md:'markdown', sh:'shell', bash:'shell', c:'c', h:'c', cpp:'cpp', hpp:'cpp', swift:'swift', txt:'plaintext' };
  return map[ext] || 'plaintext';
}
function trackRecent(path) {
  recentFiles = recentFiles.filter(function(p) { return p !== path; });
  recentFiles.unshift(path);
  recentFiles = recentFiles.slice(0, 10);
  localStorage.setItem('ds_recent', JSON.stringify(recentFiles));
}
function updateCtxIndicator() {
  var el = document.getElementById('ctxIndicator');
  if (!el) return;
  if (openFile) {
    el.textContent = '📄 ' + openFile.split('/').pop() + (fileModified ? ' ●' : '');
    el.className = 'ctx-indicator' + (fileModified ? ' modified' : '');
  } else {
    el.textContent = '📄 No file';
    el.className = 'ctx-indicator';
  }
  var badge = document.getElementById('contextBadge');
  var ctxInfo = document.getElementById('contextInfo');
  if (badge && ctxInfo) {
    if (currentProject) { badge.style.display = 'inline-flex'; ctxInfo.textContent = currentProject; }
    else badge.style.display = 'none';
  }
}
function openFileFromTree(path) {
  if (openFile && fileModified && editor) modifiedFiles[openFile] = true;
  openFile = path;
  activeTabPath = path;
  trackRecent(path);
  if (openTabs.indexOf(path) < 0) openTabs.push(path);
  renderEditorTabs();
  fsRead(path).then(function(r) {
    fileContent = r.content || '';
    fileModified = false;
    if (!monacoLoaded) {
      switchPrimaryPanel('editor');
      var iv = setInterval(function() {
        if (monacoLoaded && editor) {
          clearInterval(iv);
          editor.setValue(fileContent);
          monaco.editor.setModelLanguage(editor.getModel(), detectLangForPath(path));
        }
      }, 100);
    } else if (editor && window.monaco) {
      editor.setValue(fileContent);
      monaco.editor.setModelLanguage(editor.getModel(), detectLangForPath(path));
    }
    updateCtxIndicator();
    var topFolder = path.split('/')[0];
    if (topFolder && topFolder !== currentProject) setCurrentProject(topFolder);
    refreshTree();
  });
}
function renderEditorTabs() {
  var bar = document.getElementById('editorTabsBar');
  bar.innerHTML = '';
  if (!openTabs.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  openTabs.forEach(function(p) {
    var tab = document.createElement('div');
    tab.className = 'editor-tab' + (p === activeTabPath ? ' active' : '');
    var modifiedDot = modifiedFiles[p] ? '<span class="modified-dot"></span>' : '';
    tab.innerHTML = '<i class="fas ' + getFileIcon(p.split('/').pop()) + '"></i> ' + p.split('/').pop() + modifiedDot + '<span class="close-x">&times;</span>';
    tab.onclick = function(e) {
      if (e.target.classList.contains('close-x')) {
        e.stopPropagation();
        openTabs = openTabs.filter(function(x) { return x !== p; });
        if (activeTabPath === p) {
          activeTabPath = openTabs[openTabs.length - 1] || null;
          if (activeTabPath) openFileFromTree(activeTabPath);
          else { openFile = null; fileContent = ''; if (editor) editor.setValue(''); updateCtxIndicator(); }
        }
        renderEditorTabs();
        return;
      }
      if (p !== activeTabPath) openFileFromTree(p);
    };
    bar.appendChild(tab);
  });
}
function saveFile() {
  if (!openFile) { toast('No file open', 'error'); return Promise.resolve(); }
  return fsWrite(openFile, fileContent).then(function() {
    toast('Saved ' + openFile.split('/').pop(), 'success');
    logActivity('save', 'Saved ' + openFile);
    fileModified = false;
    delete modifiedFiles[openFile];
    updateCtxIndicator();
    renderEditorTabs();
    refreshTree();
    if (autoGitEnabled && currentProject) {
      fetch(API + '/api/git/auto-commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: currentProject, file: openFile }) })
        .then(function(r) { return r.json(); })
        .then(function(d) { if (d.ok) logGitRecord('commit', 'Auto-commit: ' + openFile.split('/').pop()); })
        .catch(function() {});
    }
  }).catch(function() { toast('Save failed', 'error'); });
}
function saveAsFile() {
  if (!openFile) { toast('No file open', 'error'); return; }
  var newPath = window.prompt('Save as (relative path):', openFile);
  if (!newPath || newPath === openFile) return;
  newPath = newPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  fsWrite(newPath, fileContent).then(function(r) {
    if (r.ok) { toast('Saved as ' + newPath, 'success'); logActivity('save', 'Saved as ' + newPath); refreshTree(); openFileFromTree(newPath); }
    else toast('Save As failed', 'error');
  });
}
function reloadFile() {
  if (!openFile) return;
  if (fileModified) showConfirm('Reload?', 'Unsaved changes will be lost.', function() { doReloadFile(); hideConfirm(); }, 'Reload');
  else doReloadFile();
}
function doReloadFile() {
  fsRead(openFile).then(function(r) {
    fileContent = r.content || '';
    fileModified = false;
    delete modifiedFiles[openFile];
    if (editor) editor.setValue(fileContent);
    updateCtxIndicator();
    renderEditorTabs();
    toast('Reloaded', 'success');
  });
}
function closeCurrentTab() {
  if (!activeTabPath) return;
  openTabs = openTabs.filter(function(x) { return x !== activeTabPath; });
  activeTabPath = openTabs[openTabs.length - 1] || null;
  if (activeTabPath) openFileFromTree(activeTabPath);
  else { openFile = null; fileContent = ''; if (editor) editor.setValue(''); updateCtxIndicator(); }
  renderEditorTabs();
}

/* ═══════════════════════════════════════════════════════════════════
   NEW FILE MODAL
   ═══════════════════════════════════════════════════════════════════ */
function openNewFileModal(prefix) {
  newFilePrefix = prefix || '';
  var m = document.getElementById('newFileModal');
  var inp = document.getElementById('newFilePath');
  var lbl = document.getElementById('newFilePrefixLabel');
  if (!m || !inp) return;
  lbl.textContent = prefix ? 'Save into: ' + prefix + '/' : 'Folder';
  inp.value = '';
  inp.placeholder = prefix ? 'filename.py (subfolders allowed)' : 'e.g. src/utils/helper.py';
  m.classList.add('active');
  setTimeout(function() { inp.focus(); }, 150);
}
function closeNewFileModal() { document.getElementById('newFileModal').classList.remove('active'); }
function createFromModal() {
  var raw = (document.getElementById('newFilePath').value || '').trim();
  if (!raw) { toast('Enter a filename', 'error'); return; }
  raw = raw.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  var fullPath = newFilePrefix ? newFilePrefix + '/' + raw : raw;
  var base = fullPath.split('/').pop();
  if (!base || base === '.' || base === '..') { toast('Invalid filename', 'error'); return; }
  closeNewFileModal();
  fsWrite(fullPath, '').then(function(r) {
    if (r && r.ok === false) { toast('Create failed: ' + (r.error || 'unknown'), 'error'); return; }
    toast('Created ' + fullPath, 'success');
    logActivity('file', 'Created ' + fullPath);
    var parts = fullPath.split('/');
    var acc = '';
    for (var i = 0; i < parts.length - 1; i++) {
      acc = acc ? acc + '/' + parts[i] : parts[i];
      expandedFolders[acc] = true;
      if (!treeCache[acc]) loadTreeLevel(acc);
    }
    refreshTree();
    openFileFromTree(fullPath);
  }).catch(function(e) { toast('Create failed: ' + e.message, 'error'); });
}
function setupNewFileModal() {
  document.getElementById('modalCancel').onclick = closeNewFileModal;
  document.getElementById('modalCreate').onclick = createFromModal;
  document.getElementById('newFilePath').onkeydown = function(e) { if (e.key === 'Enter') { e.preventDefault(); createFromModal(); } };
}

/* ═══════════════════════════════════════════════════════════════════
   CURRENT PROJECT
   ═══════════════════════════════════════════════════════════════════ */
function setCurrentProject(name) {
  currentProject = name;
  localStorage.setItem('ds_current_project', name || '');
  var sel = document.getElementById('workspaceSelector');
  if (sel) sel.value = name || '';
  fetch(API + '/api/detect-language?path=' + encodeURIComponent(name))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      currentLang = data;
      var badge = document.getElementById('langBadge');
      if (badge && currentLang.lang !== 'unknown') { badge.textContent = currentLang.lang.toUpperCase(); badge.style.display = 'inline-block'; }
    }).catch(function() {});
  updateChatWarn();
  updateCtxIndicator();
}
function updateChatWarn() {
  var badge = document.getElementById('chatWarnBadge');
  if (!badge) return;
  if (!currentProject) { badge.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Select a project'; badge.style.display = 'flex'; }
  else badge.style.display = 'none';
}
function loadWorkspaceSelector() {
  var sel = document.getElementById('workspaceSelector');
  if (!sel) return;
  fsList('').then(function(items) {
    var dirs = items.filter(function(i) { return i.isDir; });
    sel.innerHTML = '<option value="">-- select a project --</option>';
    dirs.forEach(function(d) {
      var opt = document.createElement('option');
      opt.value = d.name;
      opt.textContent = d.name + (d.isLink ? '  🔗' : '');
      if (d.name === currentProject) opt.selected = true;
      sel.appendChild(opt);
    });
    if (currentProject) sel.value = currentProject;
    updateChatWarn();
  });
  sel.onchange = function() {
    var newProj = this.value;
    if (newProj === currentProject) return;
    var dirty = Object.keys(modifiedFiles).length > 0;
    if (dirty) {
      var prev = currentProject;
      this.value = prev;
      showConfirm('Unsaved changes', 'You have ' + Object.keys(modifiedFiles).length + ' modified file(s). Switch projects anyway?',
        function() { modifiedFiles = {}; setCurrentProject(newProj); hideConfirm(); }, 'Switch');
    } else setCurrentProject(newProj);
  };
}

/* ═══════════════════════════════════════════════════════════════════
   TEMPLATES / GENERATOR
   ═══════════════════════════════════════════════════════════════════ */
var TEMPLATES = [
  { id: 'kotlin-hello', name: 'Kotlin Hello World', desc: 'Gradle Kotlin JVM project',
    files: { 'build.gradle.kts': 'plugins {\n    kotlin("jvm") version "1.9.22"\n    application\n}\nrepositories { mavenCentral() }\ndependencies { implementation(kotlin("stdlib")) }\napplication { mainClass.set("MainKt") }\n', 'src/main/kotlin/Main.kt': 'fun main() {\n    println("Hello from Kotlin!")\n}\n' }
  },
  { id: 'flutter-counter', name: 'Flutter Counter', desc: 'Stateful counter with Material Design',
    files: { 'pubspec.yaml': 'name: counter_app\ndescription: Counter app\nversion: 1.0.0\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n', 'lib/main.dart': 'import "package:flutter/material.dart";\nvoid main() => runApp(const MyApp());\nclass MyApp extends StatelessWidget {\n  const MyApp({super.key});\n  Widget build(BuildContext c) => MaterialApp(home: const CounterPage());\n}\nclass CounterPage extends StatefulWidget {\n  const CounterPage({super.key});\n  State<CounterPage> createState() => _St();\n}\nclass _St extends State<CounterPage> {\n  int n = 0;\n  Widget build(BuildContext c) => Scaffold(\n    appBar: AppBar(title: const Text("Counter")),\n    body: Center(child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [\n      Text("Count: $n", style: const TextStyle(fontSize: 32)),\n      ElevatedButton(onPressed: () => setState(() => n--), child: const Text("-")),\n      ElevatedButton(onPressed: () => setState(() => n++), child: const Text("+")),\n    ])),\n  );\n}\n' }
  },
  { id: 'python-cli', name: 'Python CLI', desc: 'Argparse command-line script',
    files: { 'main.py': '#!/usr/bin/env python3\nimport argparse\n\ndef greet(name):\n    print(f"Hello, {name}!")\n\nif __name__ == "__main__":\n    p = argparse.ArgumentParser()\n    p.add_argument("name", nargs="?", default="World")\n    a = p.parse_args()\n    greet(a.name)\n', 'requirements.txt': '' }
  },
  { id: 'node-express', name: 'Node + Express', desc: 'Minimal REST API',
    files: { 'package.json': '{\n  "name": "my-api",\n  "version": "1.0.0",\n  "main": "server.js",\n  "scripts": { "start": "node server.js" },\n  "dependencies": { "express": "^4.18.2" }\n}\n', 'server.js': 'const express = require("express");\nconst app = express();\nconst PORT = process.env.PORT || 8080;\napp.get("/", (q,s) => s.json({ message: "Hello!" }));\napp.listen(PORT, () => console.log("Server on " + PORT));\n' }
  },
  { id: 'web-static', name: 'Static Website', desc: 'HTML + CSS + JS starter',
    files: { 'index.html': '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<title>My Site</title>\n<link rel="stylesheet" href="style.css">\n</head>\n<body>\n<h1>Hello World</h1>\n<button onclick="alert(\'Clicked!\')">Click me</button>\n</body>\n</html>\n', 'style.css': 'body { font-family: sans-serif; text-align: center; padding: 40px; }\nh1 { color: #58a6ff; }\n', 'app.js': 'console.log("App loaded");\n' }
  },
  { id: 'rust-cli', name: 'Rust CLI', desc: 'Cargo binary project',
    files: { 'Cargo.toml': '[package]\nname = "my-rust-app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n', 'src/main.rs': 'fn main() {\n    println!("Hello from Rust!");\n}\n' }
  },
  { id: 'go-cli', name: 'Go Program', desc: 'Go module with main',
    files: { 'go.mod': 'module mygoapp\n\ngo 1.21\n', 'main.go': 'package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello from Go!")\n}\n' }
  }
];
function setupTemplates() {
  var list = document.getElementById('templatesList');
  if (!list) return;
  list.innerHTML = '';
  TEMPLATES.forEach(function(tpl) {
    var btn = document.createElement('button');
    btn.className = 'btn action-btn';
    btn.innerHTML = '<b>' + tpl.name + '</b><br><span style="font-size:11px;color:var(--fg-3)">' + tpl.desc + '</span>';
    btn.onclick = function() {
      var name = window.prompt('Project folder name:', tpl.id);
      if (!name) return;
      toast('Creating ' + name + '…', 'info');
      var files = Object.keys(tpl.files);
      var done = 0;
      files.forEach(function(fp) {
        fsWrite(name + '/' + fp, tpl.files[fp]).then(function() {
          done++;
          if (done === files.length) {
            toast('Created ' + name, 'success');
            logActivity('file', 'Created template: ' + name);
            fetch(API + '/api/git/auto-repo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: name }) }).catch(function() {});
            refreshTree(); loadWorkspaceSelector(); setCurrentProject(name);
            if (isMobile) closeDrawers();
          }
        }).catch(function(e) { toast('Failed: ' + e.message, 'error'); });
      });
    };
    list.appendChild(btn);
  });
}
function setupGenerator() {
  var btn = document.getElementById('genBtn');
  if (!btn) return;
  btn.onclick = async function() {
    var ai = getAIEndpoint();
    if (!ai.key) { toast('Add ' + ai.provider + ' API key in Setup tab', 'error'); return; }
    var prompt = document.getElementById('genPrompt').value.trim();
    var lang = document.getElementById('genLanguage').value;
    var projectName = (document.getElementById('genProjectName').value.trim() || 'ai-project-' + Date.now()).replace(/[^a-zA-Z0-9_-]/g, '-');
    if (!prompt) { toast('Enter a description', 'error'); return; }
    var progress = document.getElementById('genProgress');
    var progressBar = document.getElementById('genProgressBar');
    var fill = progressBar.querySelector('.fill');
    progressBar.style.display = 'block';
    fill.style.width = '10%'; fill.className = 'fill';
    progress.innerHTML = 'Asking ' + ai.provider + '…';
    var sys = 'You are a senior architect. The user wants a ' + lang + ' project. Respond ONLY with JSON: {"files":{"path":"content"},"buildCommand":null,"runCommand":null}. No markdown.';
    try {
      var text;
      if (ai.provider === 'gemini') {
        var res = await fetch(ai.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: sys + '\n\nUser request: ' + prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 8000 } }) });
        if (!res.ok) throw new Error('API ' + res.status);
        var data = await res.json();
        text = data.candidates[0].content.parts[0].text;
      } else {
        var res = await fetch(ai.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ai.key }, body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }], temperature: 0.3, max_tokens: 8000 }) });
        if (!res.ok) throw new Error('API ' + res.status);
        var data = await res.json();
        text = data.choices[0].message.content;
      }
      var fb = text.indexOf('{'), lb = text.lastIndexOf('}');
      if (fb >= 0 && lb > fb) text = text.slice(fb, lb + 1);
      var spec = JSON.parse(text);
      var files = spec.files || {};
      var names = Object.keys(files);
      progress.innerHTML = 'Writing ' + names.length + ' files…';
      for (var i = 0; i < names.length; i++) {
        await fsWrite(projectName + '/' + names[i], files[names[i]]);
        fill.style.width = (10 + (i / names.length) * 80) + '%';
        progress.innerHTML += '<br>✓ ' + names[i];
      }
      fill.style.width = '100%'; fill.className = 'fill success';
      progress.innerHTML += '<br><b>Done!</b>';
      toast('Generated ' + names.length + ' files', 'success');
      logActivity('file', 'Generated project: ' + projectName + ' (' + names.length + ' files)');
      fetch(API + '/api/git/auto-repo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: projectName }) }).catch(function() {});
      refreshTree(); loadWorkspaceSelector(); setCurrentProject(projectName);
      setTimeout(function() { progressBar.style.display = 'none'; }, 2000);
    } catch (e) {
      fill.className = 'fill error';
      progress.innerHTML = 'Error: ' + e.message;
      toast('Failed: ' + e.message, 'error');
    }
  };
}

/* ═══════════════════════════════════════════════════════════════════
   AI_TOOLS — v2.3: 30 tools incl. 18 Termux:API integrations
   ═══════════════════════════════════════════════════════════════════ */
var AI_TOOLS = [];
fetch(API + '/api/ai/tools')
  .then(function(r) { return r.json(); })
  .then(function(d) { AI_TOOLS = d.tools || []; console.log('[DS] loaded', AI_TOOLS.length, 'AI tools'); })
  .catch(function(e) { console.warn('[DS] failed to load AI tools', e); });

function callTool(name, args) {
  return fetch(API + '/api/ai/tool-call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, args: args }) })
    .then(function(r) { return r.json(); })
    .catch(function(e) { return { ok: false, error: e.message }; });
}

/* ═══════════════════════════════════════════════════════════════════
   CHAT RENDERING
   ═══════════════════════════════════════════════════════════════════ */
function renderChatContent(content) {
  var parts = content.split(/(```[\s\S]*?```)/g);
  var html = '';
  parts.forEach(function(p) {
    if (p.indexOf('```') === 0) {
      var match = p.match(/```(\w*)\n?([\s\S]*?)```/);
      if (match) {
        var lang = match[1] || 'text';
        var code = match[2];
        var escaped = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        html += '<pre>' +
          '<span class="lang">' + lang + '</span>' +
          '<div class="pre-actions">' +
            '<button class="copy-btn pre-copy-btn" data-code="' + encodeURIComponent(code) + '" title="Copy code">' +
              '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
            '</button>' +
            '<button class="insert-code-btn" data-code="' + encodeURIComponent(code) + '">Insert</button>' +
          '</div>' +
          escaped +
        '</pre>';
      }
    } else {
      var esc = p.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      esc = esc.replace(/`([^`]+)`/g, function(m, code) {
        if (/\.(py|js|ts|kt|kts|java|dart|rs|go|html|css|json|xml|yaml|yml|sh|md|txt|c|cpp|swift)\b/.test(code)) {
          return '<span class="file-path-link" data-path="' + code + '">' + code + '</span>';
        }
        return '<span class="cmd-link" data-cmd="' + code + '" title="Click to run">' + code + '</span>';
      });
      html += '<p>' + esc.replace(/\n/g, '<br>') + '</p>';
    }
  });
  return html;
}
function appendMessage(role, content, skipSave) {
  var box = document.getElementById('chatMessages');
  var div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  if (role === 'assistant') {
    div.innerHTML = renderChatContent(content);
    div.querySelectorAll('.insert-code-btn').forEach(function(btn) {
      btn.onclick = function() { insertCodeToEditor(decodeURIComponent(this.getAttribute('data-code'))); };
    });
    div.querySelectorAll('.pre-copy-btn').forEach(function(btn) {
      btn.onclick = function() { copyText(decodeURIComponent(this.getAttribute('data-code')), this); };
    });
    div.querySelectorAll('.file-path-link').forEach(function(link) {
      link.onclick = function() { openFileFromTree(this.getAttribute('data-path')); switchPrimaryPanel('editor'); };
    });
    div.querySelectorAll('.cmd-link').forEach(function(link) {
      link.onclick = function() { sendToTerminal(this.getAttribute('data-cmd')); };
    });
  } else div.textContent = content;

  var copyBtn = document.createElement('button');
  copyBtn.className = 'msg-copy-btn';
  copyBtn.type = 'button';
  copyBtn.title = 'Copy message';
  copyBtn.setAttribute('aria-label', 'Copy message');
  copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  copyBtn.onclick = function(e) {
    e.stopPropagation();
    var ok = function() {
      copyBtn.classList.add('copied');
      copyBtn.title = 'Copied!';
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      setTimeout(function() {
        copyBtn.classList.remove('copied');
        copyBtn.title = 'Copy message';
        copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
      }, 1400);
      toast('Copied to clipboard', 'success');
    };
    var fail = function() { toast('Copy failed', 'error'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(content).then(ok).catch(function() { fallbackCopy(content) ? ok() : fail(); });
    } else { fallbackCopy(content) ? ok() : fail(); }
  };
  div.appendChild(copyBtn);

  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  if (!skipSave) {
    chatHistory.push({ role: role, content: content });
    if (chatHistory.length > 100) chatHistory = chatHistory.slice(-100);
    localStorage.setItem('ds_chat', JSON.stringify(chatHistory));
  }
  return div;
}
function fallbackCopy(text) {
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}
function restoreChatHistory() {
  var box = document.getElementById('chatMessages');
  if (!chatHistory.length) return;
  box.innerHTML = '';
  chatHistory.forEach(function(m) { appendMessage(m.role, m.content, true); });
}
function showTypingIndicator() {
  if (isAITyping) return;
  isAITyping = true;
  var box = document.getElementById('chatMessages');
  aiTypingEl = document.createElement('div');
  aiTypingEl.className = 'typing-indicator';
  aiTypingEl.innerHTML = '<span></span><span></span><span></span>';
  box.appendChild(aiTypingEl);
  box.scrollTop = box.scrollHeight;
}
function hideTypingIndicator() {
  if (aiTypingEl) { aiTypingEl.remove(); aiTypingEl = null; }
  isAITyping = false;
}
function makeToolBubble(name, args) {
  hideTypingIndicator();
  var box = document.getElementById('chatMessages');
  var div = document.createElement('div');
  div.className = 'tool-call running';

  var argPreview = '';
  if (name === 'write_file') argPreview = args.path || '';
  else if (name === 'apply_patch') argPreview = (args.path || '') + ' → ' + ((args.search || '').slice(0, 40).replace(/\n/g, ' '));
  else if (name === 'notify') argPreview = (args.message || '').slice(0, 60);
  else if (name === 'termux_toast') argPreview = (args.message || '').slice(0, 60);
  else if (name === 'termux_open_url') argPreview = (args.url || '').slice(0, 60);
  else if (name === 'termux_clipboard_set') argPreview = 'clipboard ← ' + (args.text || '').slice(0, 50);
  else if (name === 'termux_clipboard_get') argPreview = 'clipboard →';
  else if (name === 'termux_battery_status') argPreview = 'battery';
  else if (name === 'termux_torch') argPreview = (args.on ? 'ON' : 'OFF');
  else if (name === 'termux_vibrate') argPreview = (args.duration || 300) + 'ms';
  else if (name === 'termux_volume') argPreview = (args.stream || 'music') + ' ' + (args.action || 'get') + (args.volume != null ? ' → ' + args.volume : '');
  else if (name === 'termux_tts_speak') argPreview = '"' + (args.text || '').slice(0, 50) + '"';
  else if (name === 'termux_dialog') argPreview = (args.kind || 'text') + ': ' + (args.title || args.message || '').slice(0, 40);
  else if (name === 'termux_wifi_info') argPreview = 'wifi';
  else if (name === 'termux_wifi_scan') argPreview = 'scan wifi';
  else if (name === 'termux_location') argPreview = (args.provider || 'gps');
  else if (name === 'termux_share') argPreview = (args.file || args.text || '').slice(0, 50);
  else if (name === 'termux_camera_photo') argPreview = 'cam ' + (args.camera || 0);
  else if (name === 'termux_fingerprint') argPreview = 'authenticate';
  else if (name === 'termux_sms_send') argPreview = '→ ' + (args.number || '?');
  else if (name === 'termux_call') argPreview = '→ ' + (args.number || '?');
  else if (name === 'termux_contacts') argPreview = 'contacts';
  else if (name === 'termux_storage_info') argPreview = 'df';
  else if (name === 'termux_brightness') argPreview = args.level != null ? 'set ' + args.level : 'get';
  else if (name === 'termux_sensor') argPreview = (args.sensor || 'list');
  else if (name === 'termux_download') argPreview = (args.url || '').slice(0, 60);
  else if (name === 'termux_ir_transmit') argPreview = (args.frequency || 38000) + 'Hz';
  else if (name === 'move_file' || name === 'copy_file') argPreview = (args.from || '') + ' → ' + (args.to || '');
  else if (['read_file','list_files','create_folder','delete_file'].indexOf(name) >= 0) argPreview = args.path || '';
  else if (name === 'run_command') argPreview = (args.command || '').slice(0, 60);
  else if (name === 'grep_search') argPreview = '"' + (args.pattern || '') + '"';
  else if (name === 'find_files') argPreview = args.pattern || '';

  div.innerHTML = '<div class="tool-head"><span class="tool-icon"><i class="fas fa-cog fa-spin"></i></span><span class="tool-name">' + escAttr(name) + '</span><span class="tool-arg">' + escAttr(argPreview) + '</span><span class="tool-status">…</span></div>';

  var head = div.querySelector('.tool-head');
  var copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn tool-copy';
  copyBtn.title = 'Copy tool call';
  copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  copyBtn.onclick = function(e) {
    e.stopPropagation();
    var payload = 'Tool: ' + name + '\n' + JSON.stringify(args, null, 2);
    copyText(payload, this);
  };
  head.appendChild(copyBtn);

  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}
function updateToolBubble(bubble, result) {
  bubble.classList.remove('running');
  var statusEl = bubble.querySelector('.tool-status');
  var iconEl = bubble.querySelector('.tool-icon');
  if (result.ok) { bubble.classList.add('success'); if (statusEl) { if (statusEl) statusEl.textContent = '✓'; if (statusEl) statusEl.style.color = 'var(--green)'; } if (iconEl) if (iconEl) iconEl.innerHTML = '<i class="fas fa-check"></i>'; }
  else { bubble.classList.add('error'); if (statusEl) { if (statusEl) statusEl.textContent = '✗'; if (statusEl) statusEl.style.color = 'var(--red)'; } if (iconEl) if (iconEl) iconEl.innerHTML = '<i class="fas fa-times"></i>'; }
  if (result.display) {
    var out = document.createElement('div');
    out.className = 'tool-output';
    out.textContent = result.display;
    if (result.result && result.result.output) {
      var details = document.createElement('details');
      var summary = document.createElement('summary');
      summary.textContent = 'Show output';
      var pre = document.createElement('div');
      pre.textContent = result.result.output;
      details.appendChild(summary); details.appendChild(pre); out.appendChild(details);
    }
    var textToCopy = '';
    if (result.result && result.result.output) textToCopy = result.result.output;
    else if (result.display) textToCopy = result.display;
    if (textToCopy) {
      var outCopy = document.createElement('button');
      outCopy.className = 'copy-btn output-copy';
      outCopy.title = 'Copy output';
      outCopy.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      outCopy.onclick = function(e) { e.stopPropagation(); copyText(textToCopy, this); };
      out.insertBefore(outCopy, out.firstChild);
    }
    bubble.appendChild(out);
  }
  if (result && result.display) {
    var toolName = (bubble.querySelector('.tool-name') || {}).textContent || 'tool';
    logActivity(result.ok ? 'tool' : 'error', toolName + ': ' + result.display);
  }
  var box = document.getElementById('chatMessages');
  box.scrollTop = box.scrollHeight;
}
function showFileWrittenToast(path) {
  var t = document.createElement('div');
  t.className = 'toast success';
  t.style.cursor = 'pointer';
  t.innerHTML = '✅ AI wrote <b>' + path + '</b> — tap to open';
  t.onclick = function() { openFileFromTree(path); switchPrimaryPanel('editor'); t.remove(); };
  document.body.appendChild(t);
  setTimeout(function() { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 4500);
  setTimeout(function() { t.remove(); }, 4900);
}

/* ═══════════════════════════════════════════════════════════════════
   SEND CHAT
   ═══════════════════════════════════════════════════════════════════ */
async function sendChat() {
  var input = document.getElementById('aiInput');
  var msg = (input.value || '').trim();
  if (!AI_TOOLS.length) { toast('Loading AI tools… try again in a second', 'info'); return; }
  if (!msg) return;
  if (!currentProject) { toast('Select a project first', 'error'); return; }
  var ai = getAIEndpoint();
  if (!ai.key) { toast('Add ' + ai.provider + ' API key in Setup', 'error'); return; }

  input.value = ''; input.style.height = 'auto';
  appendMessage('user', msg);
  logActivity('tool', 'You: ' + msg.slice(0, 80));
  showTypingIndicator();

  // Abort plumbing: every sendChat() gets a fresh controller so the Stop
  // button can cancel a runaway stream (battery + data on mobile).
  chatAborted = false;
  chatAbortCtrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  setStopVisible(true);

  var sysPrompt = 'You are DeepSeek Studio, an AI coding agent running on Termux (Android). ' +
    'Project: "' + currentProject + '". All paths are relative to "' + currentProject + '/".\n\n' +
    '## Behavior\n' +
    '- BE DECISIVE. Act on the task; do not just analyze or explain what you would do.\n' +
    '- Spend AT MOST 2-3 read/search operations to understand the code, then start editing.\n' +
    '- If the request is ambiguous, make a reasonable assumption and act.\n' +
    '- When you finish a coherent chunk of work, STOP calling tools and give a 1-2 sentence summary of what changed.\n\n' +
    '## Tool usage\n' +
    '- Use apply_patch for ANY change to an EXISTING file. Provide 3-5 lines of unique context in the search string.\n' +
    '- Use write_file ONLY for brand-new files or complete rewrites (rare).\n' +
    '- Use read_file when you need to see current content before editing.\n' +
    '- Use grep_search to find symbols and usages - never run grep via run_command.\n' +
    '- Use find_files to locate files by name - never run find via run_command.\n' +
    '- Use run_command for installs, tests, builds, and running scripts. Set background=true for servers and watchers.\n' +
    '- Use termux_open_url to open URLs in the phone browser.\n' +
    '- Use termux_toast for quick status messages under 200 chars.\n' +
    '- Use termux_clipboard_get/set for the Android system clipboard.\n' +
    '- Use termux_battery_status, termux_torch, termux_vibrate, termux_volume, termux_brightness for device control.\n' +
    '- Use termux_tts_speak for text-to-speech.\n' +
    '- Use termux_dialog for native Android dialogs (text, password, confirm, list, radio).\n' +
    '- Use termux_wifi_info/scan, termux_location for network/GPS info.\n' +
    '- Use termux_share to share a file or text via the Android share sheet.\n' +
    '- Use termux_camera_photo, termux_sms_send, termux_call, termux_contacts for camera/telephony.\n' +
    '- Use termux_fingerprint, termux_sensor, termux_storage_info, termux_ir_transmit for device access.\n' +
    '- Use notify for important long-running events (>60s).\n\n' +
    '## Boundaries\n' +
    '- Never modify files outside "' + currentProject + '/".\n' +
    '- Do NOT touch node_modules, .git, build, .dart_tool, dist, .next.\n' +
    '- Do not install packages unless the task requires it.\n\n' +
    'When done, give a 1-2 sentence summary of what changed.';
  if (openFile) sysPrompt += '\n\nCurrently open file: ' + openFile + '\nContents:\n' + fileContent.slice(0, 2000);

  if (ai.provider === 'gemini') {
    try {
      var res = await fetch(ai.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: sysPrompt + '\n\nUser: ' + msg }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 4096 } }) });
      if (!res.ok) throw new Error('API ' + res.status);
      var data = await res.json();
      hideTypingIndicator();
      appendMessage('assistant', data.candidates[0].content.parts[0].text);
    } catch (e) { hideTypingIndicator(); appendMessage('assistant', 'Error: ' + e.message); }
    return;
  }

  var messages = [{ role: 'system', content: sysPrompt }, { role: 'user', content: msg }];
  var maxIterations = 40;
  for (var iter = 0; iter < maxIterations; iter++) {
    if (chatAborted) { hideTypingIndicator(); appendMessage('assistant', '_(stopped)_'); return; }
    try {
      var assistantMsg;
      if (streamEnabled) {
        // Streaming path — goes through core/api.js so the AbortController
        // created above is actually the one that cancels the request.
        var fullText = '', toolCalls = [], liveMsg = null, streamErr = null;
        var stream = aiStreamRaw(
          { provider: 'deepseek', messages: messages, tools: AI_TOOLS, toolChoice: 'auto', maxTokens: 4096 },
          function(d) {
            if (d.content) {
              fullText += d.content;
              if (!liveMsg) liveMsg = appendMessage('assistant', '', true);
              // Append-only: re-render only the streaming bubble, not the
              // whole transcript. renderChatContent is pure, so this is safe.
              liveMsg.innerHTML = renderChatContent(fullText);
              var box = document.getElementById('chatMessages');
              if (box) box.scrollTop = box.scrollHeight;
            }
            if (d.tool_calls) {
              for (var tci = 0; tci < d.tool_calls.length; tci++) {
                var tc = d.tool_calls[tci];
                var idx = tc.index != null ? tc.index : tci;
                if (!toolCalls[idx]) toolCalls[idx] = { id: '', function: { name: '', arguments: '' } };
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function && tc.function.name) toolCalls[idx].function.name = tc.function.name;
                if (tc.function && tc.function.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          },
          function(err) { streamErr = err; }
        );
        chatAbortCtrl = stream;
        await stream.done;
        hideTypingIndicator();
        if (chatAborted) {
          // Persist whatever streamed before the user hit Stop.
          if (fullText) saveChatMessage('assistant', fullText);
          appendMessage('assistant', '_(stopped)_', true);
          return;
        }
        if (streamErr) {
          // Provider rejected the request (400/401/402/429/503). The server
          // includes the upstream body in `detail` — surface it.
          appendMessage('assistant', '**DeepSeek**\n\n```\n' + String(streamErr.message || streamErr).slice(0, 900) + '\n```');
          return;
        }
        assistantMsg = { role: 'assistant', content: fullText || null };
        if (toolCalls.length) assistantMsg.tool_calls = toolCalls.filter(Boolean);
        messages.push(assistantMsg);
        // continue to the tool-call processing that already follows in the loop
      } else {
        // Non-streaming happy path
        var res = await fetch(API + '/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'deepseek', messages: messages, tools: AI_TOOLS, toolChoice: 'auto', maxTokens: 4096 }),
          signal: chatAbortCtrl ? chatAbortCtrl.signal : undefined
        });
        if (!res.ok) {
          const errBody = await res.text().catch(function() { return ''; });
          hideTypingIndicator();
          appendMessage('assistant', '**DeepSeek ' + res.status + '**\n\n```\n' + errBody + '\n```');
          return;
        }
        const data = await res.json();
        assistantMsg = data.choices[0].message;
        messages.push(assistantMsg);
        if (assistantMsg.content) { hideTypingIndicator(); appendMessage('assistant', assistantMsg.content); }
      }
      if (!assistantMsg.tool_calls || !assistantMsg.tool_calls.length) {
        hideTypingIndicator();
        setStopVisible(false);
        chatAbortCtrl = null;
        if (!assistantMsg.content) appendMessage('assistant', '(no response)');
        return;
      }
      for (var i = 0; i < assistantMsg.tool_calls.length; i++) {
        var tc = assistantMsg.tool_calls[i];
        var toolName = tc.function.name;
        var toolArgs = {};
        try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
        var bubble = makeToolBubble(toolName, toolArgs);
        if (!autoRunEnabled) {
          var proceed = await new Promise(function(resolve) {
            showConfirm('Run tool: ' + toolName + '?', JSON.stringify(toolArgs).slice(0, 200), function() { hideConfirm(); resolve(true); }, 'Run');
            var cancelBtn = document.getElementById('confirmCancel');
            var oldOnclick = cancelBtn.onclick;
            cancelBtn.onclick = function() { hideConfirm(); resolve(false); cancelBtn.onclick = oldOnclick; };
          });
          if (!proceed) {
            bubble.classList.remove('running'); bubble.classList.add('error');
            var st = bubble.querySelector('.tool-status');
            var ic = bubble.querySelector('.tool-icon');
            if (st) st.textContent = 'skipped';
            if (ic) ic.innerHTML = '<i class="fas fa-ban"></i>';
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: 'User skipped' }) });
            continue;
          }
        }
        if (['write_file','read_file','list_files','create_folder','delete_file','move_file','copy_file','run_command','grep_search','find_files','termux_camera_photo','termux_download','termux_share'].indexOf(toolName) >= 0) {
          if (!toolArgs.cwd && currentProject) toolArgs.cwd = currentProject;
          if (!toolArgs.path && currentProject && toolArgs.file) toolArgs.path = toolArgs.file;
        }
        if (toolName === 'run_command') {
          // Mirror the AI's command into the pty so the user sees it run.
          if (sendToTerminal(toolArgs.command || '', true)) showTabBadge('terminal', true);
        }
        var result = await callTool(toolName, toolArgs);
        updateToolBubble(bubble, result);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result.result || result) });
        if (toolName === 'write_file') { try { refreshTree(); } catch (e) {} showFileWrittenToast(toolArgs.path); }
        if (toolName === 'delete_file' || toolName === 'create_folder' || toolName === 'move_file' || toolName === 'copy_file') { try { refreshTree(); } catch (e) {} }
      }
      showTypingIndicator();
    } catch (e) {
      hideTypingIndicator();
      if (chatAborted || (e && e.name === 'AbortError')) {
        appendMessage('assistant', '_(stopped)_', true);
        return;
      }
      appendMessage('assistant', 'Error: ' + e.message);
      return;
    }
  }
  hideTypingIndicator();
  setStopVisible(false);
  chatAbortCtrl = null;
  appendMessage('assistant', '(reached max iterations — stopping)');
}

/* ── Stop button ──────────────────────────────────────────────────── */
function setStopVisible(on) {
  var send = document.getElementById('aiSendBtn');
  var stop = document.getElementById('aiStopBtn');
  if (send) send.style.display = on ? 'none' : '';
  if (stop) stop.style.display = on ? '' : 'none';
}
function stopChat() {
  if (!chatAbortCtrl) return;
  chatAborted = true;
  try { chatAbortCtrl.abort(); } catch (_) {}
  chatAbortCtrl = null;
  hideTypingIndicator();
  setStopVisible(false);
  toast('Stopped', 'info');
}

/* Persist a single message without re-rendering (used when a stream is
   stopped mid-flight so the partial answer is not lost). */
function saveChatMessage(role, content) {
  chatHistory.push({ role: role, content: content });
  if (chatHistory.length > 100) chatHistory = chatHistory.slice(-100);
  try {
    localStorage.setItem('ds_chat', JSON.stringify(chatHistory));
  } catch (e) {
    // Quota exceeded — drop the oldest half and retry once, then give up
    // loudly instead of silently losing the whole transcript.
    try {
      chatHistory = chatHistory.slice(-50);
      localStorage.setItem('ds_chat', JSON.stringify(chatHistory));
      toast('Chat history trimmed (storage full)', 'info');
    } catch (e2) {
      console.warn('[chat] persist failed', e2);
    }
  }
}
function quickPrompt(text) {
  document.getElementById('aiInput').value = text;
  sendChat();
}
function insertCodeToEditor(code) {
  switchPrimaryPanel('editor');
  var iv = setInterval(function() {
    if (monacoLoaded && editor) {
      clearInterval(iv);
      var sel = editor.getSelection();
      editor.executeEdits('ai-insert', [{ range: sel, text: code, forceMoveMarkers: true }]);
      editor.focus();
      toast('Code inserted', 'success');
    }
  }, 100);
}

/* ═══════════════════════════════════════════════════════════════════
   MONACO
   ═══════════════════════════════════════════════════════════════════ */
function loadMonaco() {
  if (monacoLoaded) return;
  var loader = document.createElement('script');
  loader.src = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs/loader.min.js';
  loader.onload = function() {
    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs' } });
    require(['vs/editor/editor.main'], function() {
      monacoLoaded = true;
      var target = document.getElementById('monaco');
      var empty = document.getElementById('editorEmpty');
      if (empty) empty.remove();
      editor = monaco.editor.create(target, {
        value: fileContent || '',
        language: openFile ? detectLangForPath(openFile) : 'plaintext',
        theme: 'vs-dark',
        automaticLayout: true,
        fontSize: editorFontSize,
        minimap: { enabled: editorMinimap },
        tabSize: 4,
        wordWrap: editorWordWrap ? 'on' : 'off',
        padding: { top: 12, bottom: 12 }
      });
      editor.onDidChangeModelContent(function() {
        fileContent = editor.getValue();
        if (!fileModified) {
          fileModified = true;
          if (openFile) modifiedFiles[openFile] = true;
          updateCtxIndicator();
          renderEditorTabs();
        }
      });
      if (openFile) editor.setValue(fileContent);
    });
  };
  document.head.appendChild(loader);
}

/* ═══════════════════════════════════════════════════════════════════
   TERMINAL
   ═══════════════════════════════════════════════════════════════════ */
function loadScript(src) {
  return new Promise(function(resolve, reject) {
    var s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = function() { resolve(src); };
    s.onerror = function() { reject(new Error('Failed: ' + src)); };
    document.head.appendChild(s);
  });
}
function loadScriptFromAny(sources) {
  var i = 0;
  function attempt() {
    if (i >= sources.length) return Promise.reject(new Error('All sources failed: ' + sources.join(', ')));
    var src = sources[i++];
    return loadScript(src).catch(attempt);
  }
  return attempt();
}

/* ═══════════════════════════════════════════════════════════════════
   TERMINAL — moved to features/terminal.js
   The xterm instance, the /pty socket, the toolbar, the find bar and the
   mobile key row all live there now. What stays here are thin shims for
   the legacy call sites (start(), the quick-command palette, the settings
   toggles) so this file keeps shrinking without breaking them.
   ═══════════════════════════════════════════════════════════════════ */
function initTerminal() {
  // boot.js registers the feature with the lifecycle; nothing to do here.
  // Kept so start()'s try/catch call site stays valid until it is deleted.
}
function updateTermInfo(text, online) {
  var t = document.getElementById('termInfoText');
  var p = document.getElementById('termPulse');
  if (t) t.textContent = text;
  if (p) p.style.background = online ? 'var(--green)' : 'var(--red)';
}
function setupTerminalSearch() {
  // Bound by features/terminal.js bindSearch() on init.
}
function sendToTerminal(cmd, silent) {
  switchPrimaryPanel('terminal');
  emit('terminal:run', { cmd: cmd, silent: !!silent });
  return true;
}

/* ═══════════════════════════════════════════════════════════════════
   BACKEND CHECK
   ═══════════════════════════════════════════════════════════════════ */
function checkBackend() {
  var dot = document.getElementById('statusDot');
  var txt = document.getElementById('statusText');
  var bs = document.getElementById('backendStatus');
  var banner = document.getElementById('offlineBanner');
  if (!navigator.onLine) {
    dot.className = 'dot offline';
    txt.textContent = 'Offline';
    if (bs) { bs.style.color = 'var(--red)'; bs.textContent = 'No internet'; }
    banner.classList.add('active');
    return;
  }
  fetch(API + '/api/version').then(function(r) { return r.json(); }).then(function(d) {
    dot.className = 'dot on';
    txt.textContent = 'Online';
    if (bs) { bs.style.color = 'var(--green)'; bs.textContent = 'Connected'; }
    var ver = document.getElementById('backendVersion');
    if (ver) ver.textContent = 'v' + (d.version || '?') + ' · Node ' + (d.node || '?');
    applyEnvBadge(d);
    banner.classList.remove('active');
    renderLibsStatus(d.libs || {});
  }).catch(function() {
    dot.className = 'dot off';
    txt.textContent = 'Error';
    if (bs) { bs.style.color = 'var(--red)'; bs.textContent = 'Backend not reachable'; }
    banner.classList.add('active');
    renderLibsStatus(null);
  });
}
/* Show the STAGING badge when the backend reports env:"sandbox".
   The sandbox runs on 3002 next to production on 3001; on a phone the two
   look identical, so the badge is the only thing preventing an edit to the
   wrong instance. Hidden entirely on production. */
function applyEnvBadge(info) {
  var el = document.getElementById('envBadge');
  if (!el) return;
  var staging = !!(info && (info.staging || info.env === 'sandbox'));
  el.style.display = staging ? '' : 'none';
  if (staging) {
    el.title = 'Staging instance — port ' + (info.port || 3002) + ' (production is 3001)';
    document.title = 'DeepSeek Studio — STAGING';
  } else {
    document.title = 'DeepSeek Studio';
  }
}
function renderLibsStatus(libs) {
  var el = document.getElementById('libsStatus');
  if (!el) return;
  if (!libs) { el.innerHTML = ''; return; }
  var labels = {
    'simple-git': 'Git (simple-git)',
    '@octokit/rest': 'GitHub (Octokit)',
    'node-pty': 'Real PTY',
    'editkit': 'Fuzzy patches',
    'termux-api': 'Termux API'
  };
  var html = '<div style="margin-top:10px;display:flex;flex-direction:column;gap:4px">';
  Object.keys(labels).forEach(function(k) {
    var on = !!libs[k];
    html += '<div class="lib-badge ' + (on ? 'on' : 'off') + '">' +
      '<i class="fas ' + (on ? 'fa-check-circle' : 'fa-circle-notch') + '"></i> ' +
      '<span>' + labels[k] + '</span>' +
      '<span class="lib-status">' + (on ? 'active' : 'fallback') + '</span>' +
    '</div>';
  });
  html += '</div>';
  el.innerHTML = html;
}
window.addEventListener('online', checkBackend);
window.addEventListener('offline', checkBackend);

/* ═══════════════════════════════════════════════════════════════════
   SIDEBAR TABS
   ═══════════════════════════════════════════════════════════════════ */
function setupSideTabs() {
  document.querySelectorAll('.stab').forEach(function(tab) {
    tab.onclick = function() {
      document.querySelectorAll('.stab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
      this.classList.add('active');
      var t = this.getAttribute('data-tab');
      var panel = document.getElementById('panel-' + t);
      if (panel) panel.classList.add('active');
      if (t === 'backup') refreshBackupList();
      if (t === 'deploy') { checkToolchain(); loadKeystores(); loadProjectsForDeploy(); refreshArtifacts(); }
      if (t === 'github') {
        if (window.refreshAllGitState) window.refreshAllGitState();
        if (window.renderGhAccount) window.renderGhAccount();
      }
      if (t === 'settings') { refreshLicenseStatus(); loadLinksList(); }
      if (t === 'term') { renderQuickCommands(); renderEnvVars(); renderCmdHistory(); }
      if (t === 'log') { renderChangelog(); renderActivity(); renderGitRecords(); renderCurrentVersion(); renderSystemHealth(); }
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════
   QUICK COMMANDS / ENV VARS / PROCESSES
   ═══════════════════════════════════════════════════════════════════ */
var QUICK_COMMANDS = [
  { icon: 'fa-search', cmd: null, label: 'Find in terminal', action: function() {
      switchPrimaryPanel('terminal');
      // The panel switch may re-init the terminal; give it a moment, then
      // ask it to open its own find bar over the bus.
      setTimeout(function() { emit('terminal:search'); }, 250);
  }},
  { icon: 'fa-folder', cmd: 'ls -la', label: 'List files' },
  { icon: 'fa-terminal', cmd: 'pwd', label: 'Print working dir' },
  { icon: 'fa-info-circle', cmd: 'uname -a', label: 'System info' },
  { icon: 'fa-hdd', cmd: 'df -h', label: 'Disk usage' },
  { icon: 'fa-microchip', cmd: 'free -h', label: 'Memory usage' },
  { icon: 'fa-network-wired', cmd: 'ifconfig 2>/dev/null || ip addr', label: 'Network info' },
  { icon: 'fa-list', cmd: 'ps aux | head -20', label: 'Running processes' },
  { icon: 'fa-history', cmd: 'history | tail -20', label: 'Recent commands' },
  { icon: 'fa-python', cmd: 'python --version', label: 'Python version' },
  { icon: 'fa-node', cmd: 'node --version', label: 'Node version' },
  { icon: 'fa-git-alt', cmd: 'git status', label: 'Git status' },
  { icon: 'fa-cube', cmd: 'pkg list-installed | wc -l', label: 'Package count' }
];
function renderQuickCommands() {
  var list = document.getElementById('quickCommandsList');
  if (!list) return;
  list.innerHTML = '';
  QUICK_COMMANDS.forEach(function(qc) {
    var div = document.createElement('div');
    div.className = 'quick-cmd';
    div.innerHTML = '<i class="fas ' + qc.icon + '"></i><span class="qc-cmd">' + (qc.cmd || '(action)') + '</span><span class="qc-label">' + qc.label + '</span>';
    div.onclick = function() {
      if (qc.action) qc.action();
      else sendToTerminal(qc.cmd);
      if (isMobile) closeDrawers();
    };
    list.appendChild(div);
  });
}
function renderEnvVars() {
  var list = document.getElementById('envVarsList');
  if (!list) return;
  var keys = Object.keys(envVars);
  if (!keys.length) { list.innerHTML = '<div style="color:var(--fg-4);font-size:11px;padding:4px">No custom variables</div>'; return; }
  list.innerHTML = '';
  keys.forEach(function(k) {
    var row = document.createElement('div');
    row.className = 'env-row';
    row.innerHTML = '<code style="flex:1;font-size:10px;color:var(--blue);overflow:hidden;text-overflow:ellipsis;line-height:36px;padding:0 8px">' + k + '=' + envVars[k] + '</code><button class="btn" style="padding:8px 10px;font-size:11px">✕</button>';
    row.querySelector('button').onclick = function() {
      delete envVars[k];
      localStorage.setItem('ds_env_vars', JSON.stringify(envVars));
      renderEnvVars();
    };
    list.appendChild(row);
  });
}
function renderCmdHistory() {
  var list = document.getElementById('cmdHistoryList');
  if (!list) return;
  if (!cmdHistory.length) { list.innerHTML = '<div style="color:var(--fg-4);font-size:11px;padding:6px">No commands yet</div>'; return; }
  list.innerHTML = '';
  cmdHistory.slice(0, 20).forEach(function(cmd) {
    var div = document.createElement('div');
    div.className = 'cmd-history-item';
    div.textContent = '$ ' + cmd;
    div.onclick = function() { sendToTerminal(cmd); };
    list.appendChild(div);
  });
}
function refreshProcesses() {
  var list = document.getElementById('processesList');
  if (!list) return;
  list.innerHTML = '<div style="padding:8px;color:var(--fg-3)">Loading…</div>';
  fetch(API + '/api/processes').then(function(r) { return r.json(); }).then(function(d) {
    if (!d.processes || !d.processes.length) { list.innerHTML = 'No active processes'; return; }
    list.innerHTML = d.processes.map(function(p) {
      return '<div style="display:flex;gap:8px;padding:6px 8px;border-bottom:1px solid var(--border-2);align-items:center"><span style="color:var(--blue);font-family:monospace;font-size:11px">' + p.pid + '</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;font-size:11px">' + p.command + '</span><button class="btn" data-pid="' + p.pid + '" style="padding:4px 8px;font-size:10px;color:var(--red)">Kill</button></div>';
    }).join('');
    list.querySelectorAll('button[data-pid]').forEach(function(btn) {
      btn.onclick = function() {
        var pid = this.getAttribute('data-pid');
        fetch(API + '/api/processes/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: pid }) }).then(function() { toast('Killed ' + pid, 'success'); refreshProcesses(); });
      };
    });
  }).catch(function() { list.innerHTML = '<div style="padding:8px;color:var(--red)">Backend offline</div>'; });
}

/* ═══════════════════════════════════════════════════════════════════
   GIT PANEL — with Git/GitHub records
   ═══════════════════════════════════════════════════════════════════ */
function colorForGitStatus(st) {
  if (!st) return 'var(--fg-2)';
  var s = String(st).trim();
  if (s === '??') return 'var(--fg-3)';
  if (s.indexOf('U') >= 0 || s === 'AA' || s === 'DD') return 'var(--red)';
  if (s.indexOf('A') >= 0) return 'var(--green)';
  if (s.indexOf('D') >= 0) return 'var(--red)';
  if (s.indexOf('M') >= 0 || s.indexOf('R') >= 0) return 'var(--yellow)';
  return 'var(--fg-2)';
}
function setupGithub() {
  var tIn = document.getElementById('ghToken');
  if (!tIn) return;
  tIn.value = localStorage.getItem('gh_token') || '';
  document.getElementById('ghName').value = localStorage.getItem('gh_name') || '';
  document.getElementById('ghEmail').value = localStorage.getItem('gh_email') || '';

  /* ─── GitHub Account (OAuth Device Flow) ─── */
  var devicePollTimer = null;
  function ghStatusEl() { return document.getElementById('ghAccountStatus'); }
  function ghSetUI(state) {
    document.getElementById('ghSignedOutUI').style.display = state === 'out' ? '' : 'none';
    document.getElementById('ghDeviceUI').style.display = state === 'device' ? '' : 'none';
    document.getElementById('ghSignedInUI').style.display = state === 'in' ? '' : 'none';
  }
  function renderGhAccount() {
    fetch(API + '/api/github/status').then(function(r) { return r.json(); }).then(function(d) {
      if (d.connected) {
        ghSetUI('in');
        ghStatusEl().innerHTML = '<span style="color:var(--green)">● Connected</span>';
        var badge = document.getElementById('ghUserBadge');
        var avatar = d.avatar ? '<img src="' + d.avatar + '" style="width:38px;height:38px;border-radius:50%">' : '';
        badge.innerHTML = avatar +
          '<div style="line-height:1.3"><div style="color:var(--fg-1);font-weight:600">' + (d.login || 'github user') + '</div>' +
          '<div style="font-size:11px;color:var(--fg-3)">' + (d.name || '') + (d.publicRepos != null ? ' · ' + d.publicRepos + ' public repos' : '') + '</div></div>';
        if (d.name && !document.getElementById('ghName').value) document.getElementById('ghName').value = d.name;
      } else {
        ghSetUI('out');
        ghStatusEl().innerHTML = '<span style="color:var(--fg-3)">○ Not signed in</span>';
      }
    }).catch(function() { ghStatusEl().textContent = 'Unable to reach backend'; });
  }
  window.renderGhAccount = renderGhAccount;
  renderGhAccount();

  function stopDevicePoll() { if (devicePollTimer) { clearTimeout(devicePollTimer); devicePollTimer = null; } }
  document.getElementById('ghSignInBtn').onclick = function() {
    ghStatusEl().textContent = 'Requesting device code…';
    fetch(API + '/api/github/device/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.error) { toast(d.error, 'error'); ghStatusEl().innerHTML = '<span style="color:var(--red)">' + d.error + '</span>'; return; }
        ghSetUI('device');
        document.getElementById('ghDeviceCode').textContent = d.userCode;
        document.getElementById('ghDeviceHint').textContent = 'Waiting for authorization…';
        window._ghVerificationUri = d.verificationUriComplete || d.verificationUri;
        pollDevice(d.deviceCode, d.interval || 5);
      })
      .catch(function() { toast('Failed to start GitHub sign-in', 'error'); });
  };
  document.getElementById('ghCopyCodeBtn').onclick = function() {
    var code = document.getElementById('ghDeviceCode').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(code);
    toast('Code copied', 'success');
  };
  document.getElementById('ghOpenDeviceBtn').onclick = function() {
    window.open(window._ghVerificationUri || 'https://github.com/login/device', '_blank');
  };
  document.getElementById('ghCancelDeviceBtn').onclick = function() {
    stopDevicePoll(); ghSetUI('out'); renderGhAccount();
  };
  document.getElementById('ghSignOutBtn').onclick = function() {
    if (!confirm('Sign out of GitHub? The stored token will be deleted.')) return;
    fetch(API + '/api/github/signout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function() { localStorage.removeItem('gh_token'); tIn.value = ''; toast('Signed out', 'info'); logGitRecord('auth', 'GitHub signed out'); renderGhAccount(); })
      .catch(function() { toast('Sign-out failed', 'error'); });
  };
  function pollDevice(deviceCode, interval) {
    stopDevicePoll();
    devicePollTimer = setTimeout(function() {
      fetch(API + '/api/github/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceCode: deviceCode }) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.status === 'pending') { document.getElementById('ghDeviceHint').textContent = 'Waiting for authorization…'; return pollDevice(deviceCode, d.interval || interval); }
          if (d.status === 'authorized') {
            toast('Signed in as ' + ((d.user && d.user.login) || 'GitHub user'), 'success');
            logActivity('git', 'GitHub signed in');
            logGitRecord('auth', 'GitHub signed in' + (d.user ? ' as ' + d.user.login : ''));
            ghSetUI('in'); renderGhAccount();
            if (window.loadWorkspaceSelector) loadWorkspaceSelector();
            if (window.loadGhRepoPicker) loadGhRepoPicker();
            return;
          }
          if (d.status === 'expired') { document.getElementById('ghDeviceHint').innerHTML = '<span style="color:var(--red)">Code expired — try again</span>'; ghSetUI('out'); return; }
          if (d.status === 'denied') { document.getElementById('ghDeviceHint').innerHTML = '<span style="color:var(--red)">Authorization denied</span>'; ghSetUI('out'); return; }
          toast(d.error || 'Sign-in failed', 'error'); ghSetUI('out');
        })
        .catch(function() { pollDevice(deviceCode, interval); });
    }, Math.max(5, interval) * 1000);
  }

  /* ─── Create repo · PRs · Releases · Advanced git ─── */
  var $id = function(id) { return document.getElementById(id); };
  if ($id('ghCreateRepoBtn')) $id('ghCreateRepoBtn').onclick = async function() {
    if (!currentProject) { toast('Select a project first', 'error'); return; }
    var name = $id('ghNewRepoName').value.trim();
    if (!name) { toast('Repo name required', 'error'); return; }
    var desc = $id('ghNewRepoDesc').value.trim();
    var isPrivate = $id('ghNewRepoPrivate').checked;
    var r = await ghCall('/api/github/create-repo', { name: name, description: desc, isPrivate: isPrivate });
    if (r.error) { showGhOutput(r.error, true); toast('Create failed', 'error'); return; }
    var cloneUrl = r.repo && (r.repo.cloneUrl || r.repo.sshUrl);
    showGhOutput('Created ' + (r.repo ? r.repo.fullName : name), false);
    if (cloneUrl) {
      await ghCall('/api/git/set-remote', { cwd: currentProject, url: cloneUrl });
      toast('Repo created & origin set', 'success');
    } else { toast('Repo created', 'success'); }
    logActivity('git', 'Created GitHub repo: ' + name);
    logGitRecord('branch', 'Created repo ' + name, cloneUrl || '');
    if (window.loadGhRepoPicker) loadGhRepoPicker();
    refreshAllGitState();
  };
  if ($id('ghOpenPrBtn')) $id('ghOpenPrBtn').onclick = async function() {
    if (!currentProject) { toast('Select a project first', 'error'); return; }
    var title = $id('ghPrTitle').value.trim();
    if (!title) { toast('PR title required', 'error'); return; }
    var r = await ghCall('/api/github/open-pr', { cwd: currentProject, title: title, body: $id('ghPrBody').value, base: $id('ghPrBase').value.trim() || undefined });
    if (r.error) { showGhOutput(r.error, true); toast('PR failed', 'error'); return; }
    showGhOutput('Opened PR #' + r.number + '\n' + r.url, false);
    toast('PR #' + r.number + ' opened', 'success');
    logGitRecord('branch', 'Opened PR #' + r.number, r.url || '');
  };
  if ($id('ghListPrsBtn')) $id('ghListPrsBtn').onclick = async function() {
    if (!currentProject) { toast('Select a project first', 'error'); return; }
    var r = await ghCall('/api/github/list-prs', { cwd: currentProject, state: 'open' });
    var el = $id('ghPrList');
    if (r.error) { el.innerHTML = '<span style="color:var(--red)">' + r.error + '</span>'; return; }
    if (!r.prs || !r.prs.length) { el.innerHTML = '<span style="color:var(--fg-3)">No open pull requests</span>'; return; }
    el.innerHTML = r.prs.map(function(pr) {
      return '<div style="padding:6px 0;border-bottom:1px solid var(--border-2)"><a href="' + pr.url + '" target="_blank" style="color:var(--blue);text-decoration:none">#' + pr.number + ' ' + pr.title + '</a><div style="color:var(--fg-3);font-size:10px">' + pr.head + ' → ' + pr.base + ' · ' + (pr.user || '') + '</div></div>';
    }).join('');
  };
  if ($id('ghCreateReleaseBtn')) $id('ghCreateReleaseBtn').onclick = async function() {
    if (!currentProject) { toast('Select a project first', 'error'); return; }
    var tag = $id('ghReleaseTag').value.trim();
    if (!tag) { toast('Tag required', 'error'); return; }
    var r = await ghCall('/api/github/create-release', { cwd: currentProject, tag: tag, name: $id('ghReleaseName').value.trim() || tag, body: $id('ghReleaseNotes').value });
    if (r.error) { showGhOutput(r.error, true); toast('Release failed', 'error'); return; }
    showGhOutput('Published release ' + tag + (r.url ? '\n' + r.url : ''), false);
    toast('Release published', 'success');
    logGitRecord('push', 'Published release ' + tag, r.url || '');
  };
  if ($id('ghDiffBtn')) $id('ghDiffBtn').onclick = async function() {
    if (!currentProject) return;
    var r = await ghCall('/api/git/diff', { cwd: currentProject });
    showGhOutput('=== UNSTAGED ===\n' + (r.unstaged || '(none)') + '\n\n=== STAGED ===\n' + (r.staged || '(none)'), !!r.error);
  };
  if ($id('ghConflictsBtn')) $id('ghConflictsBtn').onclick = async function() {
    if (!currentProject) return;
    var r = await ghCall('/api/git/conflicts', { cwd: currentProject });
    showGhOutput((r.files && r.files.length) ? 'Conflicted files:\n' + r.files.join('\n') : 'No conflicts ✓', !!r.error);
  };
  if ($id('ghRebaseBtn')) $id('ghRebaseBtn').onclick = async function() {
    if (!currentProject) return;
    var onto = $id('ghRebaseOnto').value.trim();
    if (!onto) { toast('Ref required', 'error'); return; }
    var r = await ghCall('/api/git/rebase', { cwd: currentProject, onto: onto });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Rebased' : (r.conflicted ? 'Conflicts' : 'Rebase failed'), r.ok ? 'success' : 'error');
    logGitRecord('merge', r.ok ? 'Rebased onto ' + onto : 'Rebase failed');
    refreshAllGitState();
  };
  if ($id('ghSetRemoteBtn')) $id('ghSetRemoteBtn').onclick = async function() {
    if (!currentProject) return;
    var url = $id('ghRemoteUrl').value.trim();
    if (!url) { toast('URL required', 'error'); return; }
    var r = await ghCall('/api/git/set-remote', { cwd: currentProject, url: url });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Origin set' : 'Failed', r.ok ? 'success' : 'error');
    refreshAllGitState();
  };
  if ($id('ghInitBtn')) $id('ghInitBtn').onclick = async function() {
    if (!currentProject) return;
    var r = await ghCall('/api/git/init', { cwd: currentProject });
    showGhOutput((r.stdout || '') + (r.stderr || '') + (r.message || ''), !r.ok);
    toast(r.ok ? 'Repo initialised' : 'Init failed', r.ok ? 'success' : 'error');
    logGitRecord('init', 'Initialised git repo');
    refreshAllGitState();
  };
  if ($id('ghAutoRepoBtn')) $id('ghAutoRepoBtn').onclick = async function() {
    if (!currentProject) { toast('Select a project first', 'error'); return; }
    toast('Setting up git repo…', 'info');
    var r = await ghCall('/api/git/auto-repo', { cwd: currentProject, createGitHub: false });
    var lines = (r.steps || []).map(function(s) { return '• ' + s.step + ': ' + s.status + ' — ' + (s.detail || ''); }).join('\n');
    showGhOutput((lines || r.error || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Repo ready ✓' : 'Auto-setup failed', r.ok ? 'success' : 'error');
    logGitRecord('init', 'Auto-setup repo' + (r.remoteUrl ? ' → ' + r.remoteUrl : ''));
    refreshAllGitState();
  };
  if ($id('ghRemotesBtn')) $id('ghRemotesBtn').onclick = async function() {
    if (!currentProject) return;
    var r = await ghCall('/api/git/remotes', { cwd: currentProject });
    if (r.error) { showGhOutput(r.error, true); return; }
    var list = (r.remotes || []).map(function(x) { return (x.name || '?') + '\t' + (x.url || ''); }).join('\n');
    showGhOutput(list || 'No remotes configured', false);
  };
  if ($id('ghBranchDeleteBtn')) $id('ghBranchDeleteBtn').onclick = async function() {
    if (!currentProject) return;
    var name = $id('ghBranchDeleteName').value.trim();
    if (!name) { toast('Branch name required', 'error'); return; }
    var r = await ghCall('/api/git/branch/delete', { cwd: currentProject, name: name });
    showGhOutput((r.stdout || '') + (r.stderr || ''), r.code !== 0);
    toast(r.code === 0 ? 'Branch deleted' : 'Delete failed', r.code === 0 ? 'success' : 'error');
    if (r.code === 0) logGitRecord('branch', 'Deleted branch ' + name);
    refreshAllGitState();
  };
  if ($id('ghCherryPickBtn')) $id('ghCherryPickBtn').onclick = async function() {
    if (!currentProject) return;
    var ref = $id('ghCherryPickRef').value.trim();
    if (!ref) { toast('Commit ref required', 'error'); return; }
    var r = await ghCall('/api/git/cherry-pick', { cwd: currentProject, ref: ref });
    showGhOutput((r.stdout || '') + (r.stderr || ''), r.code !== 0);
    toast(r.code === 0 ? 'Cherry-picked' : 'Cherry-pick failed', r.code === 0 ? 'success' : 'error');
    if (r.code === 0) logGitRecord('commit', 'Cherry-picked ' + ref);
    refreshAllGitState();
  };
  if ($id('ghRevertBtn')) $id('ghRevertBtn').onclick = async function() {
    if (!currentProject) return;
    var ref = $id('ghRevertRef').value.trim() || 'HEAD';
    var r = await ghCall('/api/git/revert', { cwd: currentProject, ref: ref });
    showGhOutput((r.stdout || '') + (r.stderr || ''), r.code !== 0);
    toast(r.code === 0 ? 'Reverted ' + ref : 'Revert failed', r.code === 0 ? 'success' : 'error');
    if (r.code === 0) logGitRecord('commit', 'Reverted ' + ref);
    refreshAllGitState();
  };
  if ($id('ghShowCommitBtn')) $id('ghShowCommitBtn').onclick = async function() {
    if (!currentProject) return;
    var ref = $id('ghShowCommitRef').value.trim();
    if (!ref) { toast('Commit ref required', 'error'); return; }
    var r = await ghCall('/api/git/show', { cwd: currentProject, ref: ref });
    showGhOutput(r.show || r.stdout || r.stderr || r.error || '(no output)', !r.ok && !r.show);
  };
  if ($id('ghRawLogBtn')) $id('ghRawLogBtn').onclick = async function() {
    if (!currentProject) return;
    var r = await ghCall('/api/git/log', { cwd: currentProject, limit: 20 });
    var lines = (r.commits || []).map(function(c) {
      return String(c.hash || '').slice(0, 7) + ' ' + (c.message || c.subject || '');
    }).join('\n');
    showGhOutput(lines || r.stdout || 'No commits', false);
  };
  function showGhOutput(text, error) {
    var el = document.getElementById('ghOutput');
    el.style.display = 'block';
    el.textContent = text || '(no output)';
    el.style.color = error ? 'var(--red)' : 'var(--fg-2)';
  }
  /* ─── Sync status pill ─────────────────────────────────────────── */
  function _syncStateLabel(state, ahead, behind) {
    switch (state) {
      case 'not-a-repo':  return { text: '○ Not a git repository',    cls: 'off' };
      case 'no-remote':   return { text: '○ No origin remote',         cls: 'off' };
      case 'no-upstream': return { text: '● Branch not pushed yet',    cls: 'warn' };
      case 'up-to-date':  return { text: '✓ Up to date with origin',   cls: 'on' };
      case 'ahead':       return { text: '↑ ' + ahead + ' commit' + (ahead === 1 ? '' : 's') + ' to push', cls: 'warn' };
      case 'behind':      return { text: '↓ ' + behind + ' commit' + (behind === 1 ? '' : 's') + ' to pull', cls: 'warn' };
      case 'diverged':    return { text: '⇅ Diverged (ahead ' + ahead + ', behind ' + behind + ')', cls: 'err' };
      default:            return { text: '● ' + (state || 'unknown'), cls: 'off' };
    }
  }
  function refreshSyncStatus() {
    var box = document.getElementById('ghSyncState');
    if (!box) return;
    if (!currentProject) { box.textContent = 'Select a project first'; box.className = 'gh-sync-state off'; return; }
    box.textContent = 'Checking…'; box.className = 'gh-sync-state off';
    ghCall('/api/git/status/upstream', { cwd: currentProject }).then(function(r) {
      if (r.error) { box.textContent = '✗ ' + r.error; box.className = 'gh-sync-state err'; return; }
      var info = _syncStateLabel(r.state, r.ahead || 0, r.behind || 0);
      box.textContent = info.text + (r.branch ? '  ·  ' + r.branch : '');
      box.className = 'gh-sync-state ' + info.cls;
      if (r.fetchError) box.textContent += '  ·  fetch error';
      var sw = document.getElementById('ghSyncStrategyWrap');
      if (sw) sw.style.display = (r.state === 'diverged') ? 'block' : 'none';
    }).catch(function(e) {
      box.textContent = '✗ ' + (e.message || 'check failed');
      box.className = 'gh-sync-state err';
    });
  }
  function refreshRemoteInfo() {
    var el = document.getElementById('ghRemoteInfo');
    if (!el) return;
    if (!currentProject) { el.textContent = '—'; return; }
    ghCall('/api/git/remote-info', { cwd: currentProject }).then(function(r) {
      if (!r.remotes || !r.remotes.length) { el.textContent = 'No remotes configured'; return; }
      var origin = r.remotes.find(function(x) { return x.name === 'origin'; }) || r.remotes[0];
      var url = origin.pushUrl || origin.fetchUrl || '';
      var tag = origin.provider === 'github' ? 'GitHub'
              : origin.provider === 'gitlab' ? 'GitLab'
              : origin.provider === 'bitbucket' ? 'Bitbucket'
              : origin.protocol === 'ssh' ? 'SSH' : 'other';
      var shortUrl = url.replace(/^https?:\/\//, '').replace(/^git@/, '').replace(/:/, '/').replace(/\.git$/, '');
      el.innerHTML = '<span style="color:var(--blue)">' + tag + '</span> · ' + escAttr(shortUrl);
    }).catch(function() { el.textContent = '—'; });
  }
  function doSync(strategy) {
    if (!currentProject) { toast('Select a project first', 'error'); return; }
    var body = { cwd: currentProject };
    if (strategy) body.strategy = strategy;
    toast(strategy ? ('Syncing (' + strategy + ')…') : 'Syncing…', 'info');
    ghCall('/api/git/sync', body).then(function(r) {
      var label = r.state || (r.ok ? 'synced' : 'error');
      var ok = r.ok || r.state === 'diverged';
      showGhOutput(
        '=== sync ===\n' +
        'state:    ' + label + '\n' +
        'branch:   ' + (r.branch || '-') + '\n' +
        'upstream: ' + (r.upstream || '-') + '\n' +
        'ahead:    ' + (r.ahead || 0) + '   behind: ' + (r.behind || 0) + '\n' +
        (r.error ? 'error:    ' + r.error + '\n' : '') +
        '\nsteps:\n' +
        (r.steps || []).map(function(s) {
          return '  · ' + s.step + ': ' + (s.ok ? 'ok' : 'fail') + (s.detail ? ' — ' + s.detail : '');
        }).join('\n') +
        (r.output ? '\n\noutput:\n' + r.output : ''),
        !ok && r.state !== 'diverged'
      );
      if (r.state === 'diverged') toast('Diverged — pick rebase or merge', 'warn');
      else if (r.ok) { toast('Sync: ' + label, 'success'); logActivity('git', 'Sync: ' + label); logGitRecord('pull', 'Sync ' + label + (r.branch ? ' · ' + r.branch : '')); }
      else toast('Sync failed: ' + (r.error || label), 'error');
      refreshSyncStatus();
      refreshAllGitState();
    }).catch(function(e) { toast('Sync failed: ' + e.message, 'error'); });
  }
  (function wireSyncButtons() {
    var b1 = document.getElementById('ghSyncRefreshBtn');
    var b2 = document.getElementById('ghSyncNowBtn');
    var b3 = document.getElementById('ghSyncRebaseBtn');
    var b4 = document.getElementById('ghSyncMergeBtn');
    if (b1) b1.onclick = function() { refreshSyncStatus(); refreshRemoteInfo(); toast('Checking origin…', 'info'); };
    if (b2) b2.onclick = function() { doSync(); };
    if (b3) b3.onclick = function() { doSync('rebase'); };
    if (b4) b4.onclick = function() { doSync('merge'); };
  })();
  function refreshAllGitState() {
    if (!currentProject) return;
    refreshSyncStatus();
    refreshRemoteInfo();
    ghCall('/api/git/status/detailed', { cwd: currentProject }).then(function(r) {
      var list = document.getElementById('ghChangesList');
      if (!r.files || !r.files.length) { list.innerHTML = '<div class="git-empty">✓ Working tree clean</div>'; return; }
      list.innerHTML = r.files.map(function(f) {
        var st = f.status || '??';
        var color = colorForGitStatus(st);
        return '<div class="git-change-row"><span class="git-status-code" style="color:' + color + '">' + st + '</span><span class="git-path">' + f.path + '</span></div>';
      }).join('');
    }).catch(function() {});
    ghCall('/api/git/branches', { cwd: currentProject }).then(function(r) {
      var list = document.getElementById('ghBranchList');
      if (!r.branches || !r.branches.length) { list.innerHTML = 'No branches'; return; }
      list.innerHTML = r.branches.map(function(b) {
        return '<div style="padding:4px 0;color:' + (b === r.current ? 'var(--blue)' : 'var(--fg-2)') + ';font-family:monospace;font-size:11px">' + (b === r.current ? '★ ' : '  ') + b + '</div>';
      }).join('');
      document.getElementById('ghBranchInfo').textContent = 'Branch: ' + (r.current || '-');
    }).catch(function() {});
    ghCall('/api/git/log/detailed', { cwd: currentProject, limit: 20 }).then(function(r) {
      var list = document.getElementById('ghLogList');
      if (!r.commits || !r.commits.length) { list.innerHTML = 'No commits'; return; }
      list.innerHTML = r.commits.map(function(c) {
        var date = c.date || c.when || '';
        var msg = c.message || c.subject || '';
        return '<div class="git-log-row" data-hash="' + String(c.hash || '') + '" style="padding:8px 0;border-bottom:1px solid var(--border-2);cursor:pointer">' +
          '<div style="color:var(--blue);font-family:monospace;font-size:10px">' + String(c.hash || '').slice(0, 7) + ' · ' + date + '</div>' +
          '<div style="color:var(--fg-1);font-size:12px;margin:3px 0">' + msg + '</div>' +
          '<div style="color:var(--fg-3);font-size:10px">by ' + (c.author || '?') + '</div></div>';
      }).join('');
      Array.prototype.forEach.call(list.querySelectorAll('.git-log-row'), function(row) {
        row.onclick = async function() {
          var ref = row.getAttribute('data-hash');
          if (!ref) return;
          var rr = await ghCall('/api/git/show', { cwd: currentProject, ref: ref });
          showGhOutput(rr.show || rr.stdout || rr.stderr || rr.error || '(no output)', !rr.ok && !rr.show);
        };
      });
    }).catch(function() {});
    ghCall('/api/git/status', { cwd: currentProject }).then(function(r) {
      var el = document.getElementById('ghRepoInfo');
      el.textContent = r.isRepo ? (r.remote || '(no remote set)') : 'Not a git repo';
    }).catch(function() {});

    /* Populate Tags list */
    ghCall('/api/git/tags/list', { cwd: currentProject }).then(function(r) {
      var list = document.getElementById('ghTagList');
      if (!list) return;
      if (!r.tags || !r.tags.length) {
        list.innerHTML = '<span style="color:var(--fg-4)">No tags yet</span>';
        return;
      }
      list.innerHTML = r.tags.map(function(t) {
        return '<div style="padding:3px 0;color:var(--yellow);font-family:monospace;font-size:11px">🏷️ ' + t + '</div>';
      }).join('');
    }).catch(function() {});
  }
  window.refreshAllGitState = refreshAllGitState;

  document.getElementById('ghSaveToken').onclick = function() {
    var token = tIn.value.trim();
    if (!token) { toast('Enter a token', 'error'); return; }
    fetch(API + '/api/secrets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'github_token', value: token }) })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ok) { toast('Token saved server-side', 'success'); logActivity('git', 'GitHub token saved'); logGitRecord('token', 'GitHub token saved server-side'); }
        else { localStorage.setItem('gh_token', token); toast('Saved locally (server rejected)', 'warn'); }
      })
      .catch(function() { localStorage.setItem('gh_token', token); toast('Saved locally', 'info'); });
  };
  document.getElementById('ghSaveIdentity').onclick = function() {
    var n = document.getElementById('ghName').value.trim();
    var e = document.getElementById('ghEmail').value.trim();
    if (!n || !e) { toast('Name + email required', 'error'); return; }
    localStorage.setItem('gh_name', n); localStorage.setItem('gh_email', e);
    ghCall('/api/git/set-identity', { name: n, email: e }).then(function(r) {
      toast(r.code === 0 ? 'Identity saved' : 'Failed', r.code === 0 ? 'success' : 'error');
      if (r.code === 0) logGitRecord('identity', n + ' <' + e + '>');
    });
  };
  document.getElementById('ghCloneBtn').onclick = async function() {
    var url = document.getElementById('ghCloneUrl').value.trim();
    if (!url) { toast('URL required', 'error'); return; }
    toast('Cloning…', 'info');
    var r = await ghCall('/api/git/clone', { url: url });
    showGhOutput((r.stdout || '') + (r.stderr || ''), r.code !== 0);
    if (r.code === 0) {
      toast('Cloned into ' + r.dir, 'success');
      logActivity('git', 'Cloned: ' + url);
      logGitRecord('clone', 'Cloned into ' + r.dir, url);
      refreshTree(); loadWorkspaceSelector(); setCurrentProject(r.dir);
    } else {
      toast('Clone failed', 'error');
      logGitRecord('error', 'Clone failed', (r.stderr || '').slice(0, 300));
    }
  };
  /* Populate the "pick one of your repositories" dropdown */
  function loadGhRepoPicker() {
    fetch(API + '/api/github/repos?per_page=100').then(function(r) { return r.json(); }).then(function(d) {
      var wrap = document.getElementById('ghRepoPickerWrap');
      var sel = document.getElementById('ghRepoPicker');
      if (!wrap || !sel) return;
      if (!d.repos || !d.repos.length) { wrap.style.display = 'none'; return; }
      wrap.style.display = '';
      sel.innerHTML = '<option value="">— pick one of your repositories —</option>' +
        d.repos.map(function(repo) {
          return '<option value="' + repo.cloneUrl + '">' + repo.fullName + (repo.private ? ' 🔒' : '') + '</option>';
        }).join('');
    }).catch(function() {});
  }
  window.loadGhRepoPicker = loadGhRepoPicker;
  document.getElementById('ghRepoPicker').onchange = function() {
    var v = this.value;
    if (v) document.getElementById('ghCloneUrl').value = v;
  };
  loadGhRepoPicker();
  document.getElementById('ghCreateBranchBtn').onclick = async function() {
    if (!currentProject) { toast('Select a project first', 'error'); return; }
    var name = document.getElementById('ghNewBranchName').value.trim();
    if (!name) { toast('Branch name required', 'error'); return; }
    var r = await ghCall('/api/git/branch/create', { cwd: currentProject, name: name, checkout: true });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Branch created' : 'Failed', r.ok ? 'success' : 'error');
    if (r.ok) { logActivity('git', 'Created branch: ' + name); logGitRecord('branch', 'Created & checked out: ' + name); }
    refreshAllGitState();
  };
  document.getElementById('ghCheckoutBranchBtn').onclick = async function() {
    if (!currentProject) return;
    var name = document.getElementById('ghNewBranchName').value.trim();
    if (!name) return;
    var r = await ghCall('/api/git/branch/checkout', { cwd: currentProject, name: name });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Checked out ' + name : 'Failed', r.ok ? 'success' : 'error');
    if (r.ok) { logActivity('git', 'Checked out: ' + name); logGitRecord('branch', 'Switched to: ' + name); }
    refreshAllGitState();
  };
  document.getElementById('ghMergeBtn').onclick = async function() {
    if (!currentProject) return;
    var src = document.getElementById('ghMergeSource').value.trim();
    if (!src) return;
    var r = await ghCall('/api/git/branch/merge', { cwd: currentProject, source: src });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    if (r.conflicted) {
      toast('Merge conflicts', 'error');
      document.getElementById('ghAbortMergeBtn').style.display = 'inline-flex';
      logGitRecord('merge', 'Conflicts merging: ' + src);
    } else if (r.ok) {
      toast('Merged', 'success');
      document.getElementById('ghAbortMergeBtn').style.display = 'none';
      logActivity('git', 'Merged: ' + src);
      logGitRecord('merge', 'Merged: ' + src);
    }
    refreshAllGitState();
  };
  document.getElementById('ghAbortMergeBtn').onclick = async function() {
    var r = await ghCall('/api/git/merge/abort', { cwd: currentProject });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Merge aborted' : 'Failed', r.ok ? 'success' : 'error');
    if (r.ok) logGitRecord('merge', 'Aborted merge');
    document.getElementById('ghAbortMergeBtn').style.display = 'none';
    refreshAllGitState();
  };
  document.getElementById('ghAddAllBtn').onclick = async function() {
    if (!currentProject) return;
    var r = await ghCall('/api/git/add', { cwd: currentProject });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Staged all' : 'Failed', r.ok ? 'success' : 'error');
    refreshAllGitState();
  };
  document.getElementById('ghResetAllBtn').onclick = async function() {
    if (!currentProject) return;
    var r = await ghCall('/api/git/reset', { cwd: currentProject });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Unstaged all' : 'Failed', r.ok ? 'success' : 'error');
    refreshAllGitState();
  };
  document.getElementById('ghCommitOnlyBtn').onclick = async function() {
    if (!currentProject) return;
    var msg = document.getElementById('ghCommitMsg').value.trim() || 'Update';
    var r = await ghCall('/api/git/push', { cwd: currentProject, message: msg, commitOnly: true });
    showGhOutput((r.stdout || '') + (r.stderr || ''), r.code !== 0);
    toast(r.code === 0 ? 'Committed' : 'Failed', r.code === 0 ? 'success' : 'error');
    if (r.code === 0) { logActivity('git', 'Committed: ' + msg); logGitRecord('commit', msg); }
    else logGitRecord('error', 'Commit failed', (r.stderr || '').slice(0, 300));
    refreshAllGitState();
  };
  document.getElementById('ghPushBtn').onclick = async function() {
    if (!currentProject) return;
    var msg = document.getElementById('ghCommitMsg').value.trim() || 'Update';
    var r = await ghCall('/api/git/push', { cwd: currentProject, message: msg });
    showGhOutput((r.stdout || '') + (r.stderr || ''), r.code !== 0);
    toast(r.code === 0 ? 'Pushed' : 'Push warnings', r.code === 0 ? 'success' : 'error');
    if (r.code === 0) { logActivity('git', 'Pushed: ' + msg); logGitRecord('push', msg); }
    else logGitRecord('error', 'Push failed', (r.stderr || '').slice(0, 300));
    refreshSyncStatus();
    refreshAllGitState();
  };
  document.getElementById('ghPullBtn').onclick = async function() {
    if (!currentProject) return;
    var r = await ghCall('/api/git/pull', { cwd: currentProject });
    showGhOutput((r.stdout || '') + (r.stderr || ''), r.code !== 0);
    toast(r.code === 0 ? 'Pulled' : 'Pull failed', r.code === 0 ? 'success' : 'error');
    if (r.code === 0) { logActivity('git', 'Pulled'); logGitRecord('pull', 'Pulled from origin'); }
    refreshSyncStatus();
    refreshAllGitState();
  };
  document.getElementById('ghPullRebaseBtn').onclick = async function() {
    if (!currentProject) return;
    var r = await ghCall('/api/git/pull/rebase', { cwd: currentProject });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Pulled (rebase)' : 'Failed', r.ok ? 'success' : 'error');
    logGitRecord('pull', r.ok ? 'Pulled --rebase' : 'Pull --rebase failed');
    refreshAllGitState();
  };
  document.getElementById('ghFetchBtn').onclick = async function() {
    if (!currentProject) return;
    var r = await ghCall('/api/git/fetch', { cwd: currentProject });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Fetched' : 'Failed', r.ok ? 'success' : 'error');
    logGitRecord('fetch', r.ok ? 'Fetched --all --prune' : 'Fetch failed');
    refreshSyncStatus();
    refreshAllGitState();
  };
  document.getElementById('ghStashPushBtn').onclick = async function() {
    if (!currentProject) return;
    var msg = document.getElementById('ghStashMsg').value.trim();
    var r = await ghCall('/api/git/stash', { cwd: currentProject, action: 'push', message: msg });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Stashed' : 'Failed', r.ok ? 'success' : 'error');
    logGitRecord('stash', r.ok ? ('Stashed' + (msg ? ': ' + msg : '')) : 'Stash failed');
    refreshAllGitState();
  };
  document.getElementById('ghStashPopBtn').onclick = async function() {
    if (!currentProject) return;
    var r = await ghCall('/api/git/stash', { cwd: currentProject, action: 'pop' });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Popped' : 'Failed', r.ok ? 'success' : 'error');
    if (r.ok) logGitRecord('stash', 'Popped latest stash');
    refreshAllGitState();
  };
  document.getElementById('ghStashListBtn').onclick = async function() {
    if (!currentProject) return;
    var r = await ghCall('/api/git/stash', { cwd: currentProject, action: 'list' });
    showGhOutput(r.stdout || '(no stashes)', !r.ok);
  };
  document.getElementById('ghStashClearBtn').onclick = function() {
    if (!currentProject) return;
    showConfirm('Clear all stashes?', 'This cannot be undone.', async function() {
      var r = await ghCall('/api/git/stash', { cwd: currentProject, action: 'clear', confirm: true });
      showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
      if (r.ok) logGitRecord('stash', 'Cleared all stashes');
      hideConfirm();
    }, 'Clear');
  };
  document.getElementById('ghLogBtn').onclick = refreshAllGitState;
  document.getElementById('ghTagCreateBtn').onclick = async function() {
    if (!currentProject) return;
    var name = document.getElementById('ghTagName').value.trim();
    if (!name) return;
    var r = await ghCall('/api/git/tags', { cwd: currentProject, action: 'create', name: name, message: name });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Tag created' : 'Failed', r.ok ? 'success' : 'error');
    if (r.ok) { logActivity('git', 'Tag created: ' + name); logGitRecord('tag', 'Created tag: ' + name); }
    refreshAllGitState();
  };
  document.getElementById('ghTagPushBtn').onclick = async function() {
    if (!currentProject) return;
    var r = await ghCall('/api/git/tags', { cwd: currentProject, action: 'push' });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Tags pushed' : 'Failed', r.ok ? 'success' : 'error');
    logGitRecord('tag', r.ok ? 'Pushed all tags' : 'Tag push failed');
  };
  document.getElementById('ghUndoBtn').onclick = function() {
    if (!currentProject) return;
    showConfirm('Revert last commit?', 'Creates a new commit undoing the last.', async function() {
      var r = await ghCall('/api/git/undo', { cwd: currentProject });
      showGhOutput(r.output || r.stdout || '', !r.ok);
      toast(r.ok ? 'Reverted' : 'Failed', r.ok ? 'success' : 'error');
      if (r.ok) { logActivity('git', 'Reverted last commit'); logGitRecord('revert', 'Soft reset of HEAD~1'); }
      hideConfirm(); refreshAllGitState();
    }, 'Revert');
  };
  document.getElementById('ghHardResetBtn').onclick = function() {
    if (!currentProject) return;
    showConfirm('Hard reset?', 'ALL uncommitted changes will be LOST.', async function() {
      var r = await ghCall('/api/git/reset', { cwd: currentProject, hard: true, confirm: true });
      showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
      toast(r.ok ? 'Hard reset done' : 'Failed', r.ok ? 'success' : 'error');
      if (r.ok) { logActivity('git', 'Hard reset'); logGitRecord('reset', 'Hard reset to HEAD'); }
      hideConfirm(); refreshAllGitState();
    }, 'Reset');
  };
}

/* ═══════════════════════════════════════════════════════════════════
   DEPLOY / BACKUP / LICENSE / PWA
   ═══════════════════════════════════════════════════════════════════ */
async function checkToolchain() {
  var statusEl = document.getElementById('toolchainStatus');
  var installBtn = document.getElementById('installToolsBtn');
  if (!statusEl) return;
  statusEl.innerHTML = 'Checking…';
  try {
    var r = await fetch(API + '/api/deploy/check-tools');
    var data = await r.json();
    var lines = [], missing = [];
    var labels = { java: 'Java (OpenJDK 17)', gradle: 'Gradle', flutter: 'Flutter SDK', androidSdk: 'Android SDK', keytool: 'keytool' };
    Object.keys(labels).forEach(function(k) { lines.push((data[k] ? '✅ ' : '❌ ') + labels[k]); if (!data[k]) missing.push(k); });
    statusEl.innerHTML = lines.join('<br>');
    if (installBtn) installBtn.style.display = missing.length > 0 ? 'inline-flex' : 'none';
  } catch (e) { if (statusEl) statusEl.textContent = 'Error: ' + e.message; }
}
async function installToolchain() {
  var btn = document.getElementById('installToolsBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Installing…';
  try {
    var r = await fetch(API + '/api/deploy/install-tools', { method: 'POST' });
    var data = await r.json();
    toast(data.ok ? 'Tools installed' : 'Install failed', data.ok ? 'success' : 'error');
    await checkToolchain();
  } catch (e) { toast('Install failed: ' + e.message, 'error'); }
  btn.disabled = false; btn.innerHTML = '<i class="fas fa-download"></i> Install Missing Tools';
}
async function createKeystore() {
  var projectName = document.getElementById('ksProjectName').value.trim();
  var password = document.getElementById('ksPassword').value.trim();
  var alias = document.getElementById('ksAlias').value.trim();
  if (!projectName || !password) { toast('Project name and password required', 'error'); return; }
  toast('Creating keystore…', 'info');
  try {
    var r = await fetch(API + '/api/deploy/create-keystore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectName: projectName, password: password, alias: alias }) });
    var data = await r.json();
    if (data.ok) { toast('Keystore created', 'success'); logActivity('git', 'Keystore created: ' + data.keystore); loadKeystores(); }
    else toast('Failed: ' + (data.error || 'unknown'), 'error');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}
async function loadKeystores() {
  var sel = document.getElementById('deployKeystore');
  var list = document.getElementById('keystoreList');
  if (!sel || !list) return;
  try {
    var r = await fetch(API + '/api/deploy/keystores');
    var data = await r.json();
    sel.innerHTML = '<option value="">-- no signing (debug) --</option>';
    if (!data.keystores || !data.keystores.length) { list.innerHTML = '<span style="color:var(--fg-4)">No keystores yet</span>'; return; }
    data.keystores.forEach(function(k) { var opt = document.createElement('option'); opt.value = k; opt.textContent = k; sel.appendChild(opt); });
    list.innerHTML = data.keystores.map(function(k) { return '• ' + k; }).join('<br>');
  } catch (e) { list.innerHTML = '<span style="color:var(--red)">Backend offline</span>'; }
}
async function loadProjectsForDeploy() {
  var sel = document.getElementById('deployProject');
  if (!sel) return;
  sel.innerHTML = '';
  try {
    var items = await fsList('');
    var dirs = items.filter(function(i) { return i.isDir; });
    if (!dirs.length) { sel.innerHTML = '<option value="">-- no projects --</option>'; return; }
    dirs.forEach(function(d) { var opt = document.createElement('option'); opt.value = d.name; opt.textContent = d.name; sel.appendChild(opt); });
  } catch (e) { sel.innerHTML = '<option value="">-- error --</option>'; }
}
async function buildDeploy() {
  var cwd = document.getElementById('deployProject').value;
  var output = document.getElementById('deployOutput').value;
  var keystore = document.getElementById('deployKeystore').value;
  var password = document.getElementById('deployPassword').value.trim();
  if (!cwd) { toast('Select a project', 'error'); return; }
  if (keystore && !password) { toast('Enter keystore password', 'error'); return; }
  var btn = document.getElementById('buildDeployBtn');
  var out = document.getElementById('buildOutput');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Building…';
  out.style.display = 'block'; out.textContent = 'Starting build…\n';
  try {
    var r = await fetch(API + '/api/deploy/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: cwd, keystore: keystore, password: password, output: output }) });
    var data = await r.json();
    out.textContent = data.output || data.error || '(no output)';
    if (data.artifact) { out.textContent += '\n\n✅ Artifact: ' + data.artifact.path; toast('Build succeeded', 'success'); logActivity('git', 'Built ' + output.toUpperCase() + ': ' + cwd); }
    else if (data.ok) toast('Build finished', 'info');
    else toast(data.error || 'Build failed', 'error');
    refreshArtifacts();
  } catch (e) { out.textContent = 'Error: ' + e.message; toast('Build failed', 'error'); }
  btn.disabled = false; btn.innerHTML = '<i class="fas fa-hammer"></i> Build';
}
async function refreshArtifacts() {
  var list = document.getElementById('artifactList');
  if (!list) return;
  try {
    var r = await fetch(API + '/api/deploy/artifacts');
    var data = await r.json();
    if (!data.artifacts || !data.artifacts.length) { list.innerHTML = '<span style="color:var(--fg-4)">No builds yet.</span>'; return; }
    list.innerHTML = data.artifacts.map(function(a) {
      var href = API + '/api/deploy/download?path=' + encodeURIComponent(a.path || '');
      return '<div class="backup-item"><div class="bk-name">' + a.name + '</div>' +
        '<div class="bk-meta">' + (a.sizeStr || '') + ' · ' + a.path + '</div>' +
        '<div style="margin-top:6px;display:flex;gap:6px">' +
        '<a class="btn icon-only" style="min-width:34px;min-height:34px;padding:6px" title="Download ' + (a.kind || '').toUpperCase() + '" href="' + href + '" download="' + a.name + '"><i class="fas fa-download"></i></a>' +
        '<button class="btn icon-only" style="min-width:34px;min-height:34px;padding:6px" title="Open in browser" onclick="window.open(\'' + href + '\', \'_blank\')"><i class="fas fa-up-right-from-square"></i></button>' +
        '</div></div>';
    }).join('');
  } catch (e) { list.innerHTML = '<span style="color:var(--red)">Backend offline</span>'; }
}
async function refreshLicenseStatus() {
  var el = document.getElementById('licenseStatus');
  if (!el) return;
  try {
    var r = await fetch(API + '/api/license/status');
    var d = await r.json();
    if (d.pro) { el.textContent = '✅ Pro active — ' + d.key; el.style.color = 'var(--green)'; }
    else { el.textContent = 'Free tier — AAB builds locked'; el.style.color = 'var(--fg-3)'; }
  } catch (e) { el.textContent = 'Backend offline'; el.style.color = 'var(--red)'; }
}
function setupBackup() {
  var nowBtn = document.getElementById('backupNowBtn');
  if (!nowBtn) return;
  nowBtn.onclick = async function() {
    toast('Backing up to SD card…', 'info');
    try {
      var r = await fetch(API + '/api/backup/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      var data = await r.json();
      if (data.ok) { toast('Backed up', 'success'); logActivity('git', 'Backup created: ' + data.name); refreshBackupList(); }
      else toast('Backup failed: ' + (data.error || 'unknown'), 'error');
    } catch (e) { toast('Backup failed: ' + e.message, 'error'); }
  };
  refreshBackupList();
  checkBackupAvailability();
}
async function checkBackupAvailability() {
  try {
    var r = await fetch(API + '/api/backup/list');
    var data = await r.json();
    var el = document.getElementById('backupStatus');
    if (!el) return;
    if (data.available) { el.textContent = '✅ SD card detected'; el.style.color = 'var(--green)'; }
    else { el.textContent = '❌ SD card not found (run termux-setup-storage)'; el.style.color = 'var(--red)'; }
  } catch (e) {}
}
async function refreshBackupList() {
  var list = document.getElementById('backupList');
  if (!list) return;
  try {
    var r = await fetch(API + '/api/backup/list');
    var data = await r.json();
    if (!data.backups || !data.backups.length) { list.innerHTML = '<div style="color:var(--fg-4);font-size:12px;text-align:center;padding:14px">No backups yet</div>'; return; }
    list.innerHTML = '';
    data.backups.forEach(function(b) {
      var div = document.createElement('div');
      div.className = 'backup-item';
      div.innerHTML = '<div class="bk-name">' + b.name + '</div><div class="bk-meta">' + b.size + ' &middot; ' + b.files + ' files</div><div style="margin-top:8px;display:flex;gap:8px"><button class="btn" style="padding:6px 12px;font-size:11px;flex:1;justify-content:center" data-action="restore" data-name="' + b.name + '">Restore</button><button class="btn" style="padding:6px 12px;font-size:11px;flex:1;justify-content:center" data-action="delete" data-name="' + b.name + '">Delete</button></div>';
      list.appendChild(div);
    });
    list.querySelectorAll('button[data-action="restore"]').forEach(function(btn) {
      btn.onclick = function() {
        var name = this.getAttribute('data-name');
        showConfirm('Restore from backup?', 'Overwrites workspace with ' + name + '.', async function() {
          var r = await fetch(API + '/api/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, confirm: true }) });
          var data = await r.json();
          toast(data.ok ? 'Restored' : 'Restore failed', data.ok ? 'success' : 'error');
          if (data.ok) logActivity('git', 'Restored from backup: ' + name);
          hideConfirm(); refreshTree();
        }, 'Restore');
      };
    });
    list.querySelectorAll('button[data-action="delete"]').forEach(function(btn) {
      btn.onclick = function() {
        var name = this.getAttribute('data-name');
        showConfirm('Delete backup?', 'Permanently deletes ' + name + '.', async function() {
          var r = await fetch(API + '/api/backup/delete?name=' + encodeURIComponent(name), { method: 'DELETE' });
          var data = await r.json();
          toast(data.ok ? 'Deleted' : 'Failed', data.ok ? 'success' : 'error');
          hideConfirm(); refreshBackupList();
        }, 'Delete');
      };
    });
  } catch (e) { list.innerHTML = '<div style="color:var(--red);font-size:12px;text-align:center;padding:14px">Backend offline</div>'; }
}

/* ═══════════════════════════════════════════════════════════════════
   API KEY WIZARD / PWA
   ═══════════════════════════════════════════════════════════════════ */
function openApiKeyWizard() {
  document.getElementById('wizKeyInput').value = localStorage.getItem('ds_key') || '';
  document.getElementById('wizStatus').textContent = '';
  document.getElementById('apiKeyWizardModal').classList.add('active');
}
function closeApiKeyWizard() { document.getElementById('apiKeyWizardModal').classList.remove('active'); }
function openWizardLink(url) { window.open(url, '_blank'); }
async function verifyAndSaveWizardKey() {
  var key = document.getElementById('wizKeyInput').value.trim();
  var statusEl = document.getElementById('wizStatus');
  if (!key || !key.startsWith('sk-')) { if (statusEl) statusEl.textContent = 'Key must start with sk-'; statusEl.className = 'wizard-status err'; return; }
  if (statusEl) statusEl.textContent = 'Verifying…'; statusEl.className = 'wizard-status pending';
  try {
    var r = await fetch('https://api.deepseek.com/v1/models', { headers: { 'Authorization': 'Bearer ' + key } });
    if (r.ok) {
      localStorage.setItem('ds_key', key);
      document.getElementById('apiKeyInput').value = key;
      fetch(API + '/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'deepseek_key', value: key }),
      }).catch(function() {});

      document.getElementById('apiKeyStatus').textContent = '✅ Valid — saved';
      document.getElementById('apiKeyStatus').style.color = 'var(--green)';
      if (statusEl) statusEl.textContent = '✅ Key verified and saved!'; statusEl.className = 'wizard-status ok';
      toast('API key saved', 'success');
      logActivity('file', 'DeepSeek API key saved');
      setTimeout(closeApiKeyWizard, 1500);
    } else { if (statusEl) statusEl.textContent = '❌ Rejected (status ' + r.status + ')'; statusEl.className = 'wizard-status err'; }
  } catch (e) { if (statusEl) statusEl.textContent = '❌ Network error: ' + e.message; statusEl.className = 'wizard-status err'; }
}
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() { navigator.serviceWorker.register('/sw.js').catch(function() {}); });
}
window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault(); deferredInstallPrompt = e;
  var btn = document.getElementById('installPwaBtn');
  if (btn) { btn.style.display = 'inline-flex'; document.getElementById('pwaStatus').textContent = 'Tap to install'; }
});
window.addEventListener('appinstalled', function() {
  deferredInstallPrompt = null;
  toast('🎉 Installed', 'success');
  var btn = document.getElementById('installPwaBtn');
  if (btn) btn.style.display = 'none';
  document.getElementById('pwaStatus').textContent = '✅ Installed';
});
function setupPwa() {
  var btn = document.getElementById('installPwaBtn');
  if (!btn) return;
  btn.onclick = async function() {
    if (deferredInstallPrompt) { deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; }
    else toast('Use browser menu → Add to Home screen', 'info');
  };
  if (window.matchMedia('(display-mode: standalone)').matches) {
    document.getElementById('pwaStatus').textContent = '✅ Running as installed app';
    btn.style.display = 'none';
  }
}

/* ═══════════════════════════════════════════════════════════════════
   CONTEXT MENU / CONFIRM / SNIPPETS
   ═══════════════════════════════════════════════════════════════════ */
function setupContextMenu() {
  document.getElementById('ctxOpen').onclick = function() {
    if (!ctxItem || ctxItem.isDir) return;
    var item = ctxItem; hideContextMenu();
    openFileFromTree(item.path); switchPrimaryPanel('editor');
  };
  document.getElementById('ctxNewFileHere').onclick = function() {
    if (!ctxItem) return;
    var item = ctxItem; hideContextMenu();
    var dir = item.isDir ? item.path : item.path.split('/').slice(0, -1).join('/');
    openNewFileModal(dir);
  };
  document.getElementById('ctxNewFolderHere').onclick = function() {
    if (!ctxItem) return;
    var item = ctxItem; hideContextMenu();
    var dir = item.isDir ? item.path : item.path.split('/').slice(0, -1).join('/');
    var name = prompt('New folder name' + (dir ? ' in ' + dir + '/' : ':'));
    if (!name) return;
    name = name.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
    var full = dir ? dir + '/' + name : name;
    fetch(API + '/api/ai/tool-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'create_folder', args: { path: full } })
    }).then(function(r) { return r.json(); }).then(function() {
      toast('Folder created: ' + full, 'success');
      logActivity('file', 'Created folder: ' + full);
      expandedFolders[full] = true;
      refreshTree();
    }).catch(function(e) { toast('Failed: ' + e.message, 'error'); });
  };
  document.getElementById('ctxReload').onclick = function() {
    if (!ctxItem || ctxItem.isDir) return;
    var item = ctxItem; hideContextMenu();
    if (openFile === item.path) reloadFile(); else toast('Open it first', 'info');
  };
  document.getElementById('ctxBookmark').onclick = function() {
    if (!ctxItem || ctxItem.isDir) return;
    var item = ctxItem; hideContextMenu();
    var idx = bookmarks.indexOf(item.path);
    if (idx >= 0) { bookmarks.splice(idx, 1); toast('Bookmark removed'); }
    else { bookmarks.push(item.path); toast('Bookmarked', 'success'); }
    localStorage.setItem('ds_bookmarks', JSON.stringify(bookmarks));
  };
  document.getElementById('ctxRename').onclick = function() { if (!ctxItem) return; var item = ctxItem; hideContextMenu(); renameItem(item); };
  document.getElementById('ctxCopyPath').onclick = function() {
    if (!ctxItem) return;
    var path = ctxItem.path;
    copyText(path);
    hideContextMenu();
  };
  document.getElementById('ctxTerminalHere').onclick = function() {
    if (!ctxItem) return;
    var item = ctxItem; hideContextMenu();
    var dir = item.isDir ? item.path : item.path.split('/').slice(0, -1).join('/');
    sendToTerminal('cd ~/projects/' + (dir ? dir : ''));
  };

  document.getElementById('ctxUnlink').onclick = function() {
    if (!ctxItem || !ctxItem.isLink) return;
    var item = ctxItem; hideContextMenu();
    showConfirm('Unlink "' + item.name + '"?',
      'The external folder is NOT deleted — only the link inside the workspace is removed.',
      function() {
        removeLink(item.name).then(function(r) {
          if (r.ok) { toast('Unlinked', 'success'); logActivity('file', 'Unlinked: ' + item.name); refreshTree(); loadLinksList(); }
          else toast(r.error || 'Unlink failed', 'error');
          hideConfirm();
        });
      }, 'Unlink');
  };

  document.getElementById('ctxDelete').onclick = function() {
    if (!ctxItem) return;
    var item = ctxItem; hideContextMenu();

    if (item.isLink) {
      showConfirm('Delete linked folder "' + item.name + '"?',
        'This is a linked external folder. The original files will NOT be deleted — only the link will be removed.',
        function() {
          removeLink(item.name).then(function(r) {
            if (r.ok) { toast('Link removed (files preserved)', 'success'); logActivity('file', 'Unlinked: ' + item.name); refreshTree(); loadLinksList(); }
            else toast(r.error || 'Failed', 'error');
            hideConfirm();
          });
        }, 'Unlink');
      return;
    }

    showConfirm('Delete "' + item.name + '"?', 'Cannot be undone.', function() {
      fsDelete(item.path).then(function(r) {
        if (r.ok) { toast('Deleted', 'success'); logActivity('file', 'Deleted: ' + item.path); delete treeCache[item.path]; refreshTree(); }
        else if (r.requiresUnlink) {
          toast('Use "Unlink" instead — this is an external folder', 'warn');
        } else toast('Delete failed', 'error');
        hideConfirm();
      });
    }, 'Delete');
  };
  document.addEventListener('click', function(e) {
    var menu = document.getElementById('ctxMenu');
    if (menu.classList.contains('active') && !menu.contains(e.target)) hideContextMenu();
  });
}
function setupConfirmModal() {
  document.getElementById('confirmCancel').onclick = hideConfirm;
  document.getElementById('confirmOk').onclick = function() { if (confirmCallback) confirmCallback(); };
  document.getElementById('confirmModal').onclick = function(e) { if (e.target === this) hideConfirm(); };
}

var SNIPPETS = [
  { name: 'Python script', desc: 'Basic Python script template', cmd: 'Create a Python script that ' },
  { name: 'REST API', desc: 'Express/FastAPI server', cmd: 'Create a REST API with endpoints for ' },
  { name: 'Flutter page', desc: 'New Flutter screen', cmd: 'Create a Flutter page with ' },
  { name: 'React component', desc: 'Functional React component', cmd: 'Create a React component that ' },
  { name: 'Unit tests', desc: 'Test file for current project', cmd: 'Write unit tests for ' },
  { name: 'Dockerfile', desc: 'Container for current project', cmd: 'Create a Dockerfile for ' },
  { name: 'CI/CD pipeline', desc: 'GitHub Actions workflow', cmd: 'Create a GitHub Actions workflow that ' },
  { name: 'README', desc: 'Project documentation', cmd: 'Write a README.md for ' },
  { name: 'SQL schema', desc: 'Database tables', cmd: 'Create SQL schema for ' },
  { name: 'Fix error', desc: 'Debug current file', cmd: 'Fix the error in the current file: ' },
  { name: 'Refactor', desc: 'Improve code structure', cmd: 'Refactor the current file to be more maintainable: ' },
  { name: 'Add logging', desc: 'Add debug logging', cmd: 'Add logging to the current file that ' }
];
function setupSnippets() {
  var input = document.getElementById('aiInput');
  var dropdown = document.getElementById('snippetDropdown');
  if (!input || !dropdown) return;
  function showSnippets(filter) {
    var items = SNIPPETS;
    if (filter) {
      var f = filter.toLowerCase();
      items = SNIPPETS.filter(function(s) { return s.name.toLowerCase().indexOf(f) >= 0 || s.desc.toLowerCase().indexOf(f) >= 0; });
    }
    if (!items.length) { dropdown.classList.remove('active'); return; }
    dropdown.innerHTML = '';
    items.forEach(function(s) {
      var div = document.createElement('div');
      div.className = 'snippet-item';
      div.innerHTML = '<div class="snip-name">' + s.name + '</div><div class="snip-desc">' + s.desc + '</div>';
      div.onclick = function() {
        input.value = s.cmd;
        dropdown.classList.remove('active');
        input.focus();
        input.setSelectionRange(s.cmd.length, s.cmd.length);
      };
      dropdown.appendChild(div);
    });
    dropdown.classList.add('active');
  }
  input.addEventListener('input', function() {
    var val = this.value;
    var m = val.match(/^\/([\w -]{0,30})$/);
    if (m) showSnippets(m[1]);
    else dropdown.classList.remove('active');
  });
  input.addEventListener('keydown', function(e) { if (e.key === 'Escape') dropdown.classList.remove('active'); });
  document.addEventListener('click', function(e) {
    if (!dropdown.contains(e.target) && e.target !== input) dropdown.classList.remove('active');
  });
}

/* ═══════════════════════════════════════════════════════════════════
   Chat tools (search, copy-all, export, clear records)
   ═══════════════════════════════════════════════════════════════════ */
var chatSearch = { matches: [], index: 0, query: '' };

function chatSearchUpdate() {
  var input = document.getElementById('chatSearchInput');
  var countEl = document.getElementById('chatSearchCount');
  if (!input) return;
  var q = (input.value || '').trim().toLowerCase();
  chatSearch.query = q;

  document.querySelectorAll('#chatMessages .chat-msg').forEach(function(m) {
    m.classList.remove('search-match', 'search-current');
  });

  if (!q) {
    chatSearch.matches = [];
    chatSearch.index = 0;
    if (countEl) countEl.textContent = '0/0';
    return;
  }

  var all = Array.from(document.querySelectorAll('#chatMessages .chat-msg'));
  chatSearch.matches = all.filter(function(m) {
    return (m.textContent || '').toLowerCase().indexOf(q) !== -1;
  });

  chatSearch.matches.forEach(function(m) { m.classList.add('search-match'); });

  if (chatSearch.matches.length) {
    if (chatSearch.index >= chatSearch.matches.length) chatSearch.index = 0;
    chatSearch.matches[chatSearch.index].classList.add('search-current');
    chatSearch.matches[chatSearch.index].scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else {
    chatSearch.index = 0;
  }

  if (countEl) {
    countEl.textContent = chatSearch.matches.length
      ? (chatSearch.index + 1) + '/' + chatSearch.matches.length
      : '0/0';
  }
}
function chatSearchNext() {
  if (!chatSearch.matches.length) return;
  chatSearch.index = (chatSearch.index + 1) % chatSearch.matches.length;
  chatSearchUpdate();
}
function chatSearchPrev() {
  if (!chatSearch.matches.length) return;
  chatSearch.index = (chatSearch.index - 1 + chatSearch.matches.length) % chatSearch.matches.length;
  chatSearchUpdate();
}
function chatSearchOpen() {
  var bar = document.getElementById('chatSearchBar');
  var input = document.getElementById('chatSearchInput');
  if (!bar) return;
  bar.classList.add('active');
  setTimeout(function() { input.focus(); input.select(); }, 50);
}
function chatSearchClose() {
  var bar = document.getElementById('chatSearchBar');
  var input = document.getElementById('chatSearchInput');
  if (bar) bar.classList.remove('active');
  if (input) input.value = '';
  chatSearch.query = '';
  chatSearch.matches = [];
  document.querySelectorAll('#chatMessages .chat-msg').forEach(function(m) {
    m.classList.remove('search-match', 'search-current');
  });
  var countEl = document.getElementById('chatSearchCount');
  if (countEl) countEl.textContent = '0/0';
}

function copyAllChat() {
  if (!chatHistory.length) { toast('Chat is empty', 'info'); return; }
  var md = '# DeepSeek Studio — Chat Export\n\n';
  md += '**Project:** `' + (currentProject || 'none') + '`\n';
  md += '**Date:** ' + new Date().toLocaleString() + '\n\n---\n\n';
  chatHistory.forEach(function(m) {
    if (m.role === 'user') md += '## 👤 You\n\n' + m.content + '\n\n';
    else if (m.role === 'assistant') md += '## 🤖 DeepSeek\n\n' + m.content + '\n\n';
  });
  copyText(md);
}
function exportChatJson() {
  if (!chatHistory.length) { toast('Chat is empty', 'info'); return; }
  var blob = new Blob([JSON.stringify(chatHistory, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'deepseek-chat-' + Date.now() + '.json';
  a.click();
  toast('Exported', 'success');
}

function setupChatTools() {
  var searchBtn = document.getElementById('chatSearchBtn');
  var copyAllBtn = document.getElementById('chatCopyAllBtn');
  var exportBtn = document.getElementById('chatExportBtn');
  var searchInput = document.getElementById('chatSearchInput');
  var searchPrev = document.getElementById('chatSearchPrev');
  var searchNext = document.getElementById('chatSearchNext');
  var searchClose = document.getElementById('chatSearchClose');
  var clearActivity = document.getElementById('clearActivityBtn');
  var clearGitRecords = document.getElementById('clearGitRecordsBtn');

  if (searchBtn) searchBtn.onclick = function() {
    var bar = document.getElementById('chatSearchBar');
    if (bar && bar.classList.contains('active')) chatSearchClose();
    else chatSearchOpen();
  };
  if (copyAllBtn) copyAllBtn.onclick = copyAllChat;
  if (exportBtn) exportBtn.onclick = exportChatJson;
  if (searchInput) {
    searchInput.oninput = chatSearchUpdate;
    searchInput.onkeydown = function(e) {
      if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? chatSearchPrev() : chatSearchNext(); }
      else if (e.key === 'Escape') { e.preventDefault(); chatSearchClose(); }
    };
  }
  if (searchPrev) searchPrev.onclick = chatSearchPrev;
  if (searchNext) searchNext.onclick = chatSearchNext;
  if (searchClose) searchClose.onclick = chatSearchClose;
  if (clearActivity) clearActivity.onclick = function() {
    activityLog = [];
    localStorage.removeItem('ds_activity');
    renderActivity();
    toast('Activity cleared');
  };
  if (clearGitRecords) clearGitRecords.onclick = function() {
    gitRecords = [];
    localStorage.removeItem('ds_git_records');
    renderGitRecords();
    toast('Git records cleared');
  };

  window.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      chatSearchOpen();
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════
   CLIPBOARD HELPERS
   ═══════════════════════════════════════════════════════════════════ */
function readClipboardInto(inputEl, statusCb) {
  if (!inputEl) return;
  var set = function(text) {
    text = (text || '').trim();
    if (!text) { if (statusCb) statusCb('Clipboard empty', 'error'); return; }
    inputEl.value = text;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    if (statusCb) statusCb('Pasted ' + text.length + ' chars', 'success');
  };
  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(set).catch(function() {
      inputEl.focus();
      if (statusCb) statusCb('Clipboard blocked — paste manually', 'warn');
    });
  } else {
    inputEl.focus();
    if (statusCb) statusCb('Clipboard not available — paste manually', 'warn');
  }
}
function toggleReveal(inputEl) {
  if (!inputEl) return;
  inputEl.type = inputEl.type === 'text' ? 'password' : 'text';
}

/* ═══════════════════════════════════════════════════════════════════
   BIND HEADER BUTTONS
   ═══════════════════════════════════════════════════════════════════ */
function inEditableField(e) {
    var t = e.target;
    if (!t) return false;
    var tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable === true;
}

function bindHeaderButtons() {
  var mL = document.getElementById('menuLeftBtn');
  var mR = document.getElementById('menuRightBtn');
  var bd = document.getElementById('backdrop');
  var cB = document.getElementById('compileBtn');
  var nb = document.getElementById('newFileBtn');
  var rtb = document.getElementById('refreshTreeBtn');
  var lfb = document.getElementById('linkFolderBtn');
  var saveBtn = document.getElementById('saveBtn');
  var aI = document.getElementById('aiInput');
  var aiSend = document.getElementById('aiSendBtn');
  var aR = document.getElementById('autoRunToggle');
  var aR2 = document.getElementById('autoRunToggle2');
  var aG = document.getElementById('autoGitToggle');
  var aP = document.getElementById('aiProvider');
  var gK = document.getElementById('geminiKeyInput');
  var gT = document.getElementById('geminiKeyTestBtn');
  var aK = document.getElementById('apiKeyInput');
  var aW = document.getElementById('apiKeyWizardBtn');
  var aT = document.getElementById('apiKeyTestBtn');

  if (mL) mL.onclick = function() { openDrawer('left'); };
  if (mR) mR.onclick = function() { openDrawer('right'); };
  if (bd) bd.onclick = closeDrawers;
  if (cB) cB.onclick = compileCurrent;
  if (nb) nb.onclick = function() { openNewFileModal(''); };
  if (rtb) rtb.onclick = refreshTree;
  if (lfb) lfb.onclick = openLinkFolderModal;
  if (saveBtn) saveBtn.onclick = saveFile;
  if (aiSend) aiSend.onclick = sendChat;
  var aiStop = document.getElementById('aiStopBtn');
  if (aiStop) aiStop.onclick = stopChat;

  var lfCancel = document.getElementById('lfCancelBtn');
  var lfLink = document.getElementById('lfLinkBtn');
  if (lfCancel) lfCancel.onclick = closeLinkFolderModal;
  if (lfLink) lfLink.onclick = doCreateLink;

  var slfb = document.getElementById('settingsLinkFolderBtn');
  if (slfb) slfb.onclick = openLinkFolderModal;

  var aSA = document.getElementById('actSaveAs');
  var aRL = document.getElementById('actReload');
  var aCT = document.getElementById('actClose');
  var aFD = document.getElementById('actFind');
  var aRP = document.getElementById('actReplace');
  var aFM = document.getElementById('actFormat');
  var aWW = document.getElementById('actWordWrap');
  var aMM = document.getElementById('actMinimap');
  if (aSA) aSA.onclick = saveAsFile;
  if (aRL) aRL.onclick = reloadFile;
  if (aCT) aCT.onclick = closeCurrentTab;
  if (aFD) aFD.onclick = function() { if (editor) editor.getAction('actions.find').run(); };
  if (aRP) aRP.onclick = function() { if (editor) editor.getAction('editor.action.startFindReplaceAction').run(); };
  if (aFM) aFM.onclick = function() { if (editor) editor.getAction('editor.action.formatDocument').run(); else toast('Open a file first', 'error'); };
  if (aWW) aWW.onclick = function() {
    editorWordWrap = !editorWordWrap;
    localStorage.setItem('editor_word_wrap', editorWordWrap ? 'true' : 'false');
    if (editor) editor.updateOptions({ wordWrap: editorWordWrap ? 'on' : 'off' });
    toast('Word wrap ' + (editorWordWrap ? 'on' : 'off'));
  };
  if (aMM) aMM.onclick = function() {
    editorMinimap = !editorMinimap;
    localStorage.setItem('editor_minimap', editorMinimap ? 'true' : 'false');
    if (editor) editor.updateOptions({ minimap: { enabled: editorMinimap } });
    toast('Minimap ' + (editorMinimap ? 'on' : 'off'));
  };

  if (aI) {
    aI.onkeydown = function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    };
    aI.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 140) + 'px';
    });
  }
  if (aR) {
    aR.checked = autoRunEnabled;
    aR.onchange = function() {
      autoRunEnabled = this.checked;
      localStorage.setItem('auto_run', autoRunEnabled ? 'true' : 'false');
      if (aR2) aR2.checked = autoRunEnabled;
      var lbl = document.getElementById('autoRunLabel');
      if (lbl) lbl.classList.toggle('on', autoRunEnabled);
      var hint = document.getElementById('autoRunHint');
      if (hint) hint.textContent = autoRunEnabled ? '(auto-run)' : '(off = confirm)';
      toast(autoRunEnabled ? 'Auto-run ON' : 'Auto-run OFF', 'info');
    };
    if (autoRunEnabled) {
      var lbl = document.getElementById('autoRunLabel');
      if (lbl) lbl.classList.add('on');
    }
  }
  if (aR2) {
    aR2.checked = autoRunEnabled;
    aR2.onchange = function() { if (aR) { aR.checked = this.checked; aR.onchange(); } };
  }
  if (aG) { aG.checked = autoGitEnabled; aG.onchange = function() { autoGitEnabled = this.checked; localStorage.setItem('auto_git', autoGitEnabled ? 'true' : 'false'); }; }
  if (aK) { aK.value = localStorage.getItem('ds_key') || ''; aK.oninput = function(e) { localStorage.setItem('ds_key', e.target.value); }; }
  if (aP) {
    aP.value = getAIProvider();
    aP.onchange = function() {
      localStorage.setItem('ai_provider', this.value);
      document.getElementById('deepseekKeySection').style.display = this.value === 'deepseek' ? 'block' : 'none';
      document.getElementById('geminiKeySection').style.display = this.value === 'gemini' ? 'block' : 'none';
      toast('Switched to ' + this.value, 'info');
    };
    document.getElementById('deepseekKeySection').style.display = aP.value === 'deepseek' ? 'block' : 'none';
    document.getElementById('geminiKeySection').style.display = aP.value === 'gemini' ? 'block' : 'none';
  }
  if (gK) { gK.value = localStorage.getItem('gemini_key') || ''; gK.oninput = function(e) { localStorage.setItem('gemini_key', e.target.value.trim()); }; }
  if (gT) gT.onclick = async function() {
    var k = (gK.value || '').trim();
    var s = document.getElementById('geminiKeyStatus');
    if (!k) { s.textContent = 'No key'; s.style.color = 'var(--red)'; return; }
    s.textContent = 'Testing…'; s.style.color = 'var(--yellow)';
    try {
      var r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + k);
      if (r.ok) { s.textContent = '✅ Valid — saved'; s.style.color = 'var(--green)'; localStorage.setItem('gemini_key', k); }
      else { s.textContent = '❌ Invalid (' + r.status + ')'; s.style.color = 'var(--red)'; }
    } catch (e) { s.textContent = '❌ Error: ' + e.message; s.style.color = 'var(--red)'; }
  };
  if (aW) aW.onclick = openApiKeyWizard;

  var apiKeyPaste = document.getElementById('apiKeyPasteBtn');
  var apiKeyReveal = document.getElementById('apiKeyRevealBtn');
  var wizPaste = document.getElementById('wizPasteBtn');
  var apiKeyStatusEl = document.getElementById('apiKeyStatus');
  var setKeyStatus = function(msg, type) {
    if (!apiKeyStatusEl) return;
    apiKeyStatusEl.textContent = msg;
    apiKeyStatusEl.style.color = type === 'error' ? 'var(--red)' : type === 'warn' ? 'var(--yellow)' : type === 'success' ? 'var(--green)' : 'var(--fg-3)';
  };
  if (apiKeyPaste) apiKeyPaste.onclick = function() { readClipboardInto(aK, setKeyStatus); };
  if (apiKeyReveal) apiKeyReveal.onclick = function() { toggleReveal(aK); };
  if (wizPaste) wizPaste.onclick = function() {
    var wizInput = document.getElementById('wizKeyInput');
    readClipboardInto(wizInput, function(msg, type) {
      var st = document.getElementById('wizStatus');
      if (st) { st.textContent = msg; st.className = 'wizard-status ' + (type === 'error' ? 'err' : type === 'warn' ? 'pending' : 'ok'); }
    });
  };
  if (aT) aT.onclick = async function() {
    var k = (aK.value || '').trim();
    var s = document.getElementById('apiKeyStatus');
    if (!k) { s.textContent = 'No key'; s.style.color = 'var(--red)'; return; }
    s.textContent = 'Testing…'; s.style.color = 'var(--yellow)';
    try {
      var r = await fetch('https://api.deepseek.com/v1/models', { headers: { 'Authorization': 'Bearer ' + k } });
      if (r.ok) {
        s.textContent = '✅ Valid';
        s.style.color = 'var(--green)';
        localStorage.setItem('ds_key', k);
        // NEW: push to server so /api/ai/stream works (the streaming path reads
        // the key from ~/.deepseek-secrets.json, not from the browser)
        fetch(API + '/api/secrets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'deepseek_key', value: k }),
        }).then(function(r2) { return r2.json(); }).then(function(d2) {
          if (d2 && d2.ok) toast('Key saved to server', 'success');
        }).catch(function() {});
      }
      else { s.textContent = '❌ Invalid (' + r.status + ')'; s.style.color = 'var(--red)'; }
    } catch (e) { s.textContent = '❌ ' + e.message; s.style.color = 'var(--red)'; }
  };

  var licInput = document.getElementById('licenseKeyInput');
  var licSave = document.getElementById('licenseSaveBtn');
  var licRemove = document.getElementById('licenseRemoveBtn');
  if (licSave) licSave.onclick = function() {
    fetch(API + '/api/license/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: licInput.value.trim() }) })
      .then(function(r) { return r.json(); })
      .then(function(d) { toast(d.ok ? 'License activated' : (d.error || 'Failed'), d.ok ? 'success' : 'error'); refreshLicenseStatus(); });
  };
  if (licRemove) licRemove.onclick = function() {
    fetch(API + '/api/license/remove', { method: 'DELETE' })
      .then(function(r) { return r.json(); })
      .then(function(d) { toast(d.ok ? 'License removed' : 'Failed', d.ok ? 'success' : 'error'); refreshLicenseStatus(); });
  };
  refreshLicenseStatus();

  /* Terminal toolbar (clear/run/copy/paste/Ctrl-C/scroll/kill) is bound by
     features/terminal.js bindToolbar() on init — not duplicated here. */

  var pkgInstall = document.getElementById('pkgInstallBtn');
  if (pkgInstall) pkgInstall.onclick = function() {
    var pkg = document.getElementById('pkgSearchInput').value.trim();
    if (!pkg) { toast('Enter package name', 'error'); return; }
    sendToTerminal('pkg install -y ' + pkg);
  };
  document.querySelectorAll('.pkg-btn').forEach(function(b) {
    b.onclick = function() { sendToTerminal(this.getAttribute('data-cmd')); };
  });
  var envAdd = document.getElementById('envAddBtn');
  if (envAdd) envAdd.onclick = function() {
    var k = document.getElementById('envKey').value.trim();
    var v = document.getElementById('envVal').value.trim();
    if (!k) return;
    envVars[k] = v;
    localStorage.setItem('ds_env_vars', JSON.stringify(envVars));
    document.getElementById('envKey').value = '';
    document.getElementById('envVal').value = '';
    renderEnvVars();
    sendToTerminal('export ' + k + '="' + v + '"', true);
    toast('Variable set', 'success');
  };
  var clearHist = document.getElementById('clearHistoryBtn');
  if (clearHist) clearHist.onclick = function() { cmdHistory = []; localStorage.setItem('ds_cmd_history', JSON.stringify(cmdHistory)); renderCmdHistory(); toast('History cleared'); };
  var refreshProc = document.getElementById('refreshProcessesBtn');
  if (refreshProc) refreshProc.onclick = refreshProcesses;

  var goChat = document.getElementById('goToChatBtn');
  if (goChat) goChat.onclick = function() { switchPrimaryPanel('chat'); if (isMobile) closeDrawers(); };
  var clearChat = document.getElementById('clearChatBtn');
  if (clearChat) clearChat.onclick = function() {
    showConfirm('Clear chat?', 'All chat history will be deleted.', function() {
      chatHistory = []; localStorage.removeItem('ds_chat');
      document.getElementById('chatMessages').innerHTML = '';
      hideConfirm(); toast('Chat cleared');
      logActivity('file', 'Chat history cleared');
    }, 'Clear');
  };
  var exportChat = document.getElementById('exportChatBtn');
  if (exportChat) exportChat.onclick = exportChatJson;

  var st = document.getElementById('streamToggle');
  if (st) { st.checked = streamEnabled; st.onchange = function() { streamEnabled = this.checked; localStorage.setItem('stream_enabled', streamEnabled ? 'true' : 'false'); }; }

  var tas = document.getElementById('termAutoScrollToggle');
  if (tas) { tas.checked = termAutoScroll; tas.onchange = function() { termAutoScroll = this.checked; localStorage.setItem('term_auto_scroll', termAutoScroll ? 'true' : 'false'); }; }

  var twgl = document.getElementById('termWebglToggle');
  if (twgl) {
    twgl.checked = termWebgl;
    twgl.onchange = function() {
      termWebgl = this.checked;
      localStorage.setItem('term_webgl', termWebgl ? 'true' : 'false');
      toast(termWebgl ? 'GPU renderer will load on next connect' : 'Using DOM renderer');
    };
  }

  var eww = document.getElementById('editorWordWrapToggle');
  var emm = document.getElementById('editorMinimapToggle');
  var efs = document.getElementById('editorFontSize');
  if (eww) { eww.checked = editorWordWrap; eww.onchange = function() { editorWordWrap = this.checked; localStorage.setItem('editor_word_wrap', editorWordWrap ? 'true' : 'false'); if (editor) editor.updateOptions({ wordWrap: editorWordWrap ? 'on' : 'off' }); }; }
  if (emm) { emm.checked = editorMinimap; emm.onchange = function() { editorMinimap = this.checked; localStorage.setItem('editor_minimap', editorMinimap ? 'true' : 'false'); if (editor) editor.updateOptions({ minimap: { enabled: editorMinimap } }); }; }
  if (efs) { efs.value = editorFontSize; efs.onchange = function() { editorFontSize = parseInt(this.value) || 13; localStorage.setItem('editor_font_size', editorFontSize); if (editor) editor.updateOptions({ fontSize: editorFontSize }); }; }

  var ckBtn = document.getElementById('checkToolsBtn');
  var iBtn = document.getElementById('installToolsBtn');
  var ckBtn2 = document.getElementById('createKeystoreBtn');
  var bBtn = document.getElementById('buildDeployBtn');
  var rBtn = document.getElementById('refreshArtifactsBtn');
  if (ckBtn) ckBtn.onclick = checkToolchain;
  if (iBtn) iBtn.onclick = installToolchain;
  if (ckBtn2) ckBtn2.onclick = createKeystore;
  if (bBtn) bBtn.onclick = buildDeploy;
  if (rBtn) rBtn.onclick = refreshArtifacts;

  window.addEventListener('keydown', function(e) {
    var isSave = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's';
    if (inEditableField(e) && !isSave) return;
    if (isSave && !e.shiftKey) { e.preventDefault(); saveFile(); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') { e.preventDefault(); saveAsFile(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'r' && activeTabPanel === 'editor') { e.preventDefault(); reloadFile(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); sendToTerminal('clear'); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'w') { e.preventDefault(); closeCurrentTab(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && activeTabPanel === 'terminal') {
      e.preventDefault();
      var btn = document.getElementById('termSearchBtn');
      if (btn) btn.click();
    }
    if (e.key === 'F5') { e.preventDefault(); checkBackend(); }
  });
}

/* ═══════════════════════════════════════════════════════════════════
   COMPILE — wired to server.js POST /api/compile
   ═══════════════════════════════════════════════════════════════════ */
async function compileCurrent() {
  if (!openFile) { toast('Open a file first', 'error'); return; }
  if (fileModified) { toast('Saving before compile…', 'info'); await saveFile(); }
  toast('Compiling ' + openFile.split('/').pop() + '…', 'info');
  switchPrimaryPanel('terminal');
  try {
    var r = await fetch(API + '/api/compile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: openFile }) });
    var data = await r.json();
    if (data.error) { toast('Compile error: ' + data.error, 'error'); return; }
    emit('terminal:write', {
      text: '\r\n\x1b[36m━━━ Compile: ' + openFile + ' ━━━\x1b[0m\r\n' +
            '\x1b[33m$ ' + (data.cmd || '') + '\x1b[0m\r\n' +
            (data.output || '(no output)') + '\r\n' +
            (data.ok ? '\x1b[32m✓ Success\x1b[0m' : '\x1b[31m✗ Failed (exit ' + data.code + ')\x1b[0m'),
    });
    toast(data.ok ? 'Compiled ✓' : 'Compile failed', data.ok ? 'success' : 'error');
    logActivity(data.ok ? 'tool' : 'error', 'Compile ' + openFile + (data.ok ? ' ok' : ' failed'));
  } catch (e) { toast('Compile failed: ' + e.message, 'error'); }
}

/* ═══════════════════════════════════════════════════════════════════
   AUTO-VERIFY API KEY
   ═══════════════════════════════════════════════════════════════════ */
(function setupAutoVerify() {
  var input = document.getElementById('apiKeyInput');
  if (!input) return;
  var statusEl = document.getElementById('apiKeyStatus');

  input.addEventListener('input', function() {
    if (!statusEl) return;
    var v = (this.value || '').trim();
    if (!v) { if (statusEl) statusEl.textContent = 'Not verified'; if (statusEl) statusEl.style.color = 'var(--fg-3)'; return; }
    if (!v.startsWith('sk-')) { if (statusEl) statusEl.textContent = '⚠ Keys start with sk-'; if (statusEl) statusEl.style.color = 'var(--yellow)'; return; }
    if (v.length < 20) { if (statusEl) statusEl.textContent = '⚠ Too short — ' + v.length + ' chars'; if (statusEl) statusEl.style.color = 'var(--yellow)'; return; }
    if (statusEl) statusEl.textContent = '✓ Key format looks valid — click Test to confirm';
    if (statusEl) statusEl.style.color = 'var(--green)';
  });

  var autoTestTimer = null;
  var lastTested = '';
  input.addEventListener('change', function() {
    var v = (this.value || '').trim();
    if (!v || !v.startsWith('sk-') || v.length < 20) return;
    if (v === lastTested) return;
    clearTimeout(autoTestTimer);
    autoTestTimer = setTimeout(function() {
      var testBtn = document.getElementById('apiKeyTestBtn');
      if (testBtn) { lastTested = v; testBtn.click(); }
    }, 600);
  });
})();

/* ═══════════════════════════════════════════════════════════════════
   START
   ═══════════════════════════════════════════════════════════════════ */
function start() {
  console.log('[DS] starting app v2.4.0');
  isMobile = window.innerWidth <= 900;

  try { bindHeaderButtons(); } catch (e) { console.log('bindHeaderButtons fail', e); }
  try { setupPrimaryTabs(); } catch (e) { console.log('setupPrimaryTabs fail', e); }
  try { setupSideTabs(); } catch (e) { console.log('setupSideTabs fail', e); }
  try { setupTemplates(); } catch (e) { console.log('setupTemplates fail', e); }
  try { setupGenerator(); } catch (e) { console.log('setupGenerator fail', e); }
  try { setupGithub(); } catch (e) { console.log('setupGithub fail', e); }
  try { setupBackup(); } catch (e) { console.log('setupBackup fail', e); }
  try { setupNewFileModal(); } catch (e) { console.log('setupNewFileModal fail', e); }
  try { setupContextMenu(); } catch (e) { console.log('setupContextMenu fail', e); }
  try { setupConfirmModal(); } catch (e) { console.log('setupConfirmModal fail', e); }
  try { setupPwa(); } catch (e) { console.log('setupPwa fail', e); }
  try { setupSnippets(); } catch (e) { console.log('setupSnippets fail', e); }
  try { setupChatTools(); } catch (e) { console.log('setupChatTools fail', e); }
  try { checkBackend(); setInterval(checkBackend, 8000); } catch (e) { console.log('checkBackend fail', e); }
  // Warn once if the server has no DeepSeek key — the chat path needs it
  fetch(API + '/api/version').then(function(r) { return r.json(); }).then(function(d) {
    var local = localStorage.getItem('ds_key');
    var serverHas = (d.providersConfigured || []).indexOf('deepseek_key') !== -1;
    if (local && !serverHas) {
      console.warn('[DS] Key is in localStorage but not on the server — chat will 400. ' +
                   'Click "Test key" in Setup to push it server-side.');
      toast('Chat key not synced — open Setup → Test key', 'warn');
    }
  }).catch(function() {});

  try { initTerminal(); } catch (e) { console.log('initTerminal fail', e); }
  try { refreshTree(); } catch (e) { console.log('refreshTree fail', e); }
  try { loadWorkspaceSelector(); } catch (e) { console.log('loadWorkspaceSelector fail', e); }
  try { restoreChatHistory(); } catch (e) { console.log('restoreChatHistory fail', e); }
  try { renderEditorTabs(); } catch (e) { console.log('renderEditorTabs fail', e); }
  try { updateChatWarn(); } catch (e) {}
  try { updateCtxIndicator(); } catch (e) {}
  try { loadLinksList(); } catch (e) {}
  try { renderChangelog(); renderActivity(); renderGitRecords(); renderCurrentVersion(); renderSystemHealth(); } catch (e) {}
  var _pingBtn = document.getElementById('sysPingBtn');
  if (_pingBtn) _pingBtn.onclick = renderSystemHealth;
  var _diagBtn = document.getElementById('sysDiagnosticsBtn');
  if (_diagBtn) _diagBtn.onclick = renderDiagnostics;
  if (currentProject) setCurrentProject(currentProject);
  logActivity('file', 'App started' + (currentProject ? ' (project: ' + currentProject + ')' : ''));

  setTimeout(function() {
    try { checkToolchain(); } catch (e) {}
    try { loadKeystores(); } catch (e) {}
    try { loadProjectsForDeploy(); } catch (e) {}
    try { refreshArtifacts(); } catch (e) {}
    try { refreshLicenseStatus(); } catch (e) {}
    try { renderQuickCommands(); } catch (e) {}
    try { renderEnvVars(); } catch (e) {}
    try { renderCmdHistory(); } catch (e) {}
    try { loadLinksList(); } catch (e) {}
  }, 2000);

  console.log('[DS] all setup done');
}

/* ═══════════════════════════════════════════════════════════════════
   PUBLIC SURFACE — what the rest of the app may still call.
   Shrinks as features take ownership. Delete entries as they migrate.
   ═══════════════════════════════════════════════════════════════════ */
export {
  openDrawer,
  quickPrompt,
  openWizardLink,
  verifyAndSaveWizardKey,
  closeApiKeyWizard,
  toast,
  escapeHtml,
  escAttr,
  copyText,
  showConfirm,
  hideConfirm,
  showContextMenu,
  hideContextMenu,
  fallbackCopy,
  loadScript,
  loadScriptFromAny,
  fsList,
  fsRead,
  fsWrite,
  fsDelete,
  fsRename,
  ghCall,
  checkBackend,
  refreshTree,
  renderTree,
  openFileFromTree,
  saveFile,
  sendChat,
  initTerminal,
  sendToTerminal,
  switchPrimaryPanel,
  setCurrentProject,
  logActivity,
  logGitRecord,
  renderChangelog,
  renderActivity,
  renderGitRecords,
  renderCurrentVersion,
  renderSystemHealth,
  renderDiagnostics,
  getAIProvider,
  getAIEndpoint,
  refreshServerProviders,
  providerReady,
  saveKeyToServer,
  updateChatWarn,
  loadWorkspaceSelector,
  renderEditorTabs,
  restoreChatHistory,
  renderQuickCommands,
  renderEnvVars,
  renderCmdHistory,
  checkToolchain,
  loadKeystores,
  loadProjectsForDeploy,
  refreshArtifacts,
  refreshLicenseStatus,
  loadLinksList,
  setupPwa,
  setupSnippets,
  setupChatTools,
  setupGithub,
  setupBackup,
  setupTemplates,
  setupGenerator,
  setupNewFileModal,
  setupContextMenu,
  setupSideTabs,
  setupPrimaryTabs,
  bindHeaderButtons,
  compileCurrent,
  insertCodeToEditor,
  loadMonaco,
  trackRecent,
  detectLangForPath,
  updateCtxIndicator,
  renderLibsStatus,
  refreshProcesses,
  colorForGitStatus,
  chatSearchUpdate,
  chatSearchNext,
  chatSearchPrev,
  chatSearchOpen,
  chatSearchClose,
  copyAllChat,
  exportChatJson,
  readClipboardInto,
  toggleReveal,
  inEditableField,
  promptDialog,
  appendMessage,
  renderChatContent,
  showTypingIndicator,
  hideTypingIndicator,
  makeToolBubble,
  updateToolBubble,
  showFileWrittenToast,
  callTool,
  openNewFileModal,
  closeNewFileModal,
  createFromModal,
  saveAsFile,
  reloadFile,
  doReloadFile,
  closeCurrentTab,
  renameItem,
  loadTreeLevel,
  renderItems,
  getFileIcon,
  fileIconColor,
  openLinkFolderModal,
  closeLinkFolderModal,
  browseTo,
  renderBreadcrumb,
  renderFolderList,
  selectFolder,
  doCreateLink,
  createLink,
  removeLink,
  loadLinkIndex,
  updateTermInfo,
  setupTerminalSearch,
  checkBackupAvailability,
  refreshBackupList,
  openApiKeyWizard,
  setupConfirmModal,
  CHANGELOG,
};
