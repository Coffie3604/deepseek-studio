import * as state from '../core/state.js';
import { on, emit } from '../core/bus.js';
import { toast, promptDialog, showConfirm, escapeHtml, showContextMenu, hideContextMenu, getCtxItem } from '../core/ui.js';
import { fsList, fsWrite, fsDelete, fsRename, fsMkdir, roots as fetchRoots } from '../core/api.js';

let ftBody, newFileBtn, newFolderBtn, refreshBtn, rootSelect;
let unsubs = [];
let currentRoot = '';   // absolute path of the active root; '' = default workspace
let rootList = [];

export async function init() {
  ftBody       = document.getElementById('ftBody');
  newFileBtn   = document.getElementById('newFileBtn');
  newFolderBtn = document.getElementById('newFolderBtn');
  refreshBtn   = document.getElementById('refreshTreeBtn');

  if (newFileBtn) newFileBtn.onclick = newFile;
  if (newFolderBtn) newFolderBtn.onclick = newFolder;
  if (refreshBtn) refreshBtn.onclick = refresh;

  await loadRoots();

  document.querySelectorAll('#ctxMenu .ctx-item').forEach((item) => {
    item.onclick = () => handleAction(item.getAttribute('data-action'));
  });
  document.addEventListener('pointerdown', (e) => {
    const menu = document.getElementById('ctxMenu');
    if (menu && menu.classList.contains('active') && !menu.contains(e.target)) hideContextMenu();
  });

  unsubs.push(on('files:changed', refresh));
  unsubs.push(on('project:change', refresh));

  await refresh();
}

export async function destroy() {
  for (const un of unsubs) un();
  unsubs = [];
}
export function mount() { refresh(); }
export function unmount() {}

// Build the root picker from /api/roots and restore the last choice.
async function loadRoots() {
  const info = await fetchRoots();
  if (!info || info.error) return;
  rootList = info.roots || [];
  const saved = state.get('activeRoot');
  currentRoot = saved && rootList.includes(saved) ? saved : (info.workspace || '');
  state.set('activeRoot', currentRoot);
  renderRootPicker();
}

function renderRootPicker() {
  const host = document.getElementById('ftRoots');
  if (!host) return;
  if (rootList.length <= 1) { host.innerHTML = ''; return; }
  host.innerHTML = '<select id="ftRootSelect" title="Browse root"></select>';
  const sel = host.querySelector('#ftRootSelect');
  for (const r of rootList) {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = r.replace(/^\/data\/data\/com\.termux\/files\/home/, '~');
    if (r === currentRoot) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    currentRoot = sel.value;
    state.set('activeRoot', currentRoot);
    state.set('expandedFolders', {});
    refresh();
  };
}

async function refresh() {
  if (!ftBody) return;
  const items = await fsList(currentRoot);
  if (items.error) { ftBody.innerHTML = '<div class="ft-empty">' + escapeHtml(items.error) + '</div>'; return; }
  ftBody.innerHTML = '';
  if (!items.length) { ftBody.innerHTML = '<div class="ft-empty">Empty folder.<br>Click + to add a file.</div>'; return; }
  await renderTree(items, 0, ftBody, '');
}

async function renderTree(items, depth, container, parentPath) {
  const expanded = state.get('expandedFolders') || {};
  const modified = state.get('modifiedFiles') || {};
  const active   = state.get('openFile');

  for (const it of items) {
    // Paths are relative to the active root; absolute when browsing outside it.
    const rel = parentPath ? parentPath + '/' + it.name : it.name;
    const path = it.abs || (currentRoot ? currentRoot + '/' + rel : rel);
    const open = !!expanded[path];

    const el = document.createElement('div');
    el.className = 'tree-item' + (active === path ? ' active' : '');
    el.style.paddingLeft = (10 + depth * 14) + 'px';

    const chev = it.isDir ? '<span class="chevron' + (open ? ' open' : '') + '">▸</span>' : '<span class="chevron"></span>';
    const icon = it.isDir ? '📁' : '📄';
    const badge = modified[path] ? '<span class="file-badge">M</span>' : '';
    el.innerHTML = chev + '<span class="tree-icon">' + icon + '</span>' +
      '<span class="tree-name">' + escapeHtml(it.name) + '</span>' + badge;

    el.onclick = () => {
      if (it.isDir) {
        const next = Object.assign({}, expanded);
        next[path] = !next[path];
        state.set('expandedFolders', next);
        refresh();
      } else {
        emit('editor:open', { path });
      }
    };

    let pressTimer = null;
    el.addEventListener('touchstart', (e) => {
      pressTimer = setTimeout(() => openCtx({ path, name: it.name, isDir: it.isDir }, e), 550);
    }, { passive: true });
    el.addEventListener('touchend', () => clearTimeout(pressTimer));
    el.addEventListener('touchmove', () => clearTimeout(pressTimer));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); openCtx({ path, name: it.name, isDir: it.isDir }, e); });

    container.appendChild(el);

    if (it.isDir && open) {
      const kids = await fsList(path);
      if (Array.isArray(kids) && kids.length) await renderTree(kids, depth + 1, container, rel);
    }
  }
}

function openCtx(item, evt) {
  const menu = document.getElementById('ctxMenu');
  if (menu) {
    const openItem = menu.querySelector('[data-action="open"]');
    if (openItem) openItem.style.display = item.isDir ? 'none' : 'flex';
  }
  showContextMenu({ path: item.path, name: item.name, isDir: item.isDir }, evt);
}

async function handleAction(action) {
  const item = getCtxItem();
  hideContextMenu();
  if (!item) return;

  if (action === 'open' && !item.isDir) {
    emit('editor:open', { path: item.path });
    return;
  }
  if (action === 'rename') {
    const name = await promptDialog({ title: 'Rename', default: item.name });
    if (!name || name === item.name) return;
    const dir = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
    const newPath = dir ? dir + '/' + name : name;
    const r = await fsRename(item.path, newPath);
    if (r.ok) { toast('Renamed', 'success'); emit('files:changed', {}); }
    else toast(r.error || 'Rename failed', 'error');
    return;
  }
  if (action === 'delete') {
    showConfirm('Delete "' + item.name + '"?', 'Cannot be undone.', async (ok) => {
      if (!ok) return;
      const r = await fsDelete(item.path);
      if (r.ok) { toast('Deleted', 'success'); emit('files:changed', {}); }
      else toast(r.error || 'Delete failed', 'error');
    }, 'Delete');
  }
}

async function newFile() {
  const name = await promptDialog({ title: 'New file', placeholder: 'src/utils/helper.py' });
  if (!name) return;
  const clean = name.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  const target = currentRoot ? currentRoot + '/' + clean : clean;
  const r = await fsWrite(target, '');
  if (r.ok) {
    toast('Created ' + clean, 'success');
    emit('files:changed', {});
    emit('editor:open', { path: clean });
  } else toast(r.error || 'Create failed', 'error');
}

async function newFolder() {
  const name = await promptDialog({ title: 'New folder', placeholder: 'src/components' });
  if (!name) return;
  const clean = name.replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (!clean) return;
  const target = currentRoot ? currentRoot + '/' + clean : clean;
  const r = await fsMkdir(target);
  if (r.ok) {
    toast('Created folder ' + clean, 'success');
    emit('files:changed', {});
  } else toast(r.error || 'Create failed', 'error');
}
