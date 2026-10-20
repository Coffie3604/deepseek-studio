import * as state from '../core/state.js';
import { on, emit } from '../core/bus.js';
import { toast, promptDialog, showConfirm, escapeHtml, showContextMenu, hideContextMenu, getCtxItem } from '../core/ui.js';
import { fsList, fsWrite, fsDelete, fsRename } from '../core/api.js';

let ftBody, newFileBtn, refreshBtn;
let unsubs = [];

export async function init() {
  ftBody     = document.getElementById('ftBody');
  newFileBtn = document.getElementById('newFileBtn');
  refreshBtn = document.getElementById('refreshTreeBtn');

  if (newFileBtn) newFileBtn.onclick = newFile;
  if (refreshBtn) refreshBtn.onclick = refresh;

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

async function refresh() {
  if (!ftBody) return;
  const items = await fsList('');
  if (items.error) { ftBody.innerHTML = '<div class="ft-empty">' + escapeHtml(items.error) + '</div>'; return; }
  ftBody.innerHTML = '';
  if (!items.length) { ftBody.innerHTML = '<div class="ft-empty">Empty workspace.<br>Click + to add a file.</div>'; return; }
  await renderTree(items, 0, ftBody, '');
}

async function renderTree(items, depth, container, parentPath) {
  const expanded = state.get('expandedFolders') || {};
  const modified = state.get('modifiedFiles') || {};
  const active   = state.get('openFile');

  for (const it of items) {
    const path = parentPath ? parentPath + '/' + it.name : it.name;
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
      if (Array.isArray(kids) && kids.length) await renderTree(kids, depth + 1, container, path);
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
  const r = await fsWrite(clean, '');
  if (r.ok) {
    toast('Created ' + clean, 'success');
    emit('files:changed', {});
    emit('editor:open', { path: clean });
  } else toast(r.error || 'Create failed', 'error');
}
