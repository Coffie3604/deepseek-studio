import * as state from '../core/state.js';
import { on, emit } from '../core/bus.js';
import { toast, escapeHtml } from '../core/ui.js';
import {
  ghStatus, ghRepos, ghDeviceStart, ghDevicePoll, ghSignOut, ghCreateRepo,
  gitStatus, gitAdd, gitCommit, gitPush, gitPull, gitFetch,
  gitBranches, gitCheckout, gitSetRemote, gitClone, gitInit,
} from '../core/api.js';

let pollTimer = null;
let unsubs = [];

export async function init() {
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };

  bind('ghSignInBtn', signIn);
  bind('ghSignOutBtn', signOut);
  bind('ghCopyCodeBtn', () => {
    const code = document.getElementById('ghDeviceCode').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(code);
    toast('Code copied', 'success');
  });
  bind('ghOpenDeviceBtn', () => {
    window.open(window._ghVerifyUri || 'https://github.com/login/device', '_blank');
  });
  bind('ghCancelDeviceBtn', () => {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    setUI('out'); refreshStatus();
  });

  bind('ghCloneBtn', clone);
  bind('ghCreateRepoBtn', createRepo);
  bind('ghAddAllBtn', addAll);
  bind('ghCommitBtn', commit);
  bind('ghPushBtn', push);
  bind('ghPullBtn', pull);
  bind('ghFetchBtn', fetch);
  bind('ghCheckoutBtn', checkout);

  const picker = document.getElementById('ghRepoPicker');
  if (picker) picker.onchange = () => {
    const url = document.getElementById('ghCloneUrl');
    if (url && picker.value) url.value = picker.value;
  };

  unsubs.push(on('project:change', refreshAll));
  await refreshStatus();
}

export async function destroy() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  for (const un of unsubs) un();
  unsubs = [];
}
export function mount() { refreshAll(); }
export function unmount() {}

function setUI(s) {
  const ids = ['ghSignedOutUI', 'ghDeviceUI', 'ghSignedInUI'];
  const map = { out: 0, device: 1, in: 2 };
  ids.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.hidden = i !== map[s];
  });
}

async function refreshStatus() {
  const d = await ghStatus();
  if (d.connected) {
    setUI('in');
    const badge = document.getElementById('ghUserBadge');
    if (badge) {
      badge.innerHTML =
        (d.avatar ? '<img src="' + escapeHtml(d.avatar) + '" alt="">' : '') +
        '<div><div class="name">' + escapeHtml(d.login || 'user') + '</div>' +
        (d.name ? '<div class="sub">' + escapeHtml(d.name) + '</div>' : '') +
        '</div>';
    }
    loadRepos();
  } else setUI('out');
}

async function signIn() {
  const r = await ghDeviceStart();
  if (r.error) { toast(r.error, 'error'); return; }
  setUI('device');
  document.getElementById('ghDeviceCode').textContent = r.userCode;
  document.getElementById('ghDeviceHint').textContent = 'Waiting for authorization…';
  window._ghVerifyUri = r.verificationUriComplete || r.verificationUri;
  poll(r.deviceCode, r.interval || 5);
}

function poll(deviceCode, interval) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    const r = await ghDevicePoll(deviceCode);
    if (r.status === 'pending') return poll(deviceCode, r.interval || interval);
    if (r.status === 'authorized') {
      toast('Signed in as ' + (r.user ? r.user.login : 'GitHub'), 'success');
      setUI('in');
      refreshStatus();
      refreshAll();
      return;
    }
    if (r.status === 'expired') { document.getElementById('ghDeviceHint').textContent = 'Code expired'; setUI('out'); return; }
    if (r.status === 'denied') { document.getElementById('ghDeviceHint').textContent = 'Denied'; setUI('out'); return; }
    toast(r.error || 'Sign-in failed', 'error');
    setUI('out');
  }, Math.max(5, interval) * 1000);
}

async function signOut() {
  await ghSignOut();
  toast('Signed out', 'info');
  setUI('out');
  refreshStatus();
}

async function loadRepos() {
  const d = await ghRepos();
  const wrap = document.getElementById('ghRepoPickerWrap');
  const sel = document.getElementById('ghRepoPicker');
  if (!wrap || !sel) return;
  if (!d.repos || !d.repos.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  sel.innerHTML = '<option value="">— pick a repository —</option>' +
    d.repos.map((repo) =>
      '<option value="' + escapeHtml(repo.cloneUrl) + '">' +
        escapeHtml(repo.fullName) + (repo.private ? ' 🔒' : '') +
      '</option>'
    ).join('');
}

async function refreshAll() {
  const cwd = state.get('currentProject');
  if (!cwd) return;

  const s = await gitStatus(cwd);
  const repoEl = document.getElementById('ghRepoInfo');
  const branchEl = document.getElementById('ghBranchInfo');
  if (repoEl) repoEl.textContent = s.isRepo ? (s.remote || '(no remote)') : 'Not a git repo';
  if (branchEl) branchEl.textContent = 'Branch: ' + (s.branch || '—');

  const changesEl = document.getElementById('ghChangesList');
  if (changesEl) {
    if (!s.files || !s.files.length) changesEl.textContent = 'No changes';
    else changesEl.innerHTML = s.files.map((f) =>
      '<div class="git-change-row"><span class="git-status-code">' +
        escapeHtml(f.status) +
        '</span><span class="git-path">' + escapeHtml(f.path) + '</span></div>'
    ).join('');
  }

  const b = await gitBranches(cwd);
  const branchListEl = document.getElementById('ghBranchList');
  if (branchListEl) {
    if (!b.branches || !b.branches.length) branchListEl.textContent = '—';
    else branchListEl.innerHTML = b.branches.map((br) =>
      '<div class="branch-row' + (br === b.current ? ' current' : '') + '">' + escapeHtml(br) + '</div>'
    ).join('');
  }
}

function showOutput(text, error) {
  const el = document.getElementById('ghOutput');
  if (!el) return;
  el.hidden = false;
  el.textContent = text || '(no output)';
  el.classList.toggle('error', !!error);
}

async function addAll() {
  const cwd = state.get('currentProject');
  if (!cwd) return toast('Select a project first', 'error');
  const r = await gitAdd(cwd);
  toast(r.ok ? 'Staged all' : 'Failed', r.ok ? 'success' : 'error');
  refreshAll();
}

async function commit() {
  const cwd = state.get('currentProject');
  if (!cwd) return toast('Select a project first', 'error');
  const msg = (document.getElementById('ghCommitMsg').value || '').trim() || 'Update';
  const r = await gitCommit(cwd, msg);
  showOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
  toast(r.ok ? 'Committed' : 'Commit failed', r.ok ? 'success' : 'error');
  refreshAll();
}

async function push() {
  const cwd = state.get('currentProject');
  if (!cwd) return toast('Select a project first', 'error');
  const s = await gitStatus(cwd);
  if (s.files && s.files.length) {
    const msg = (document.getElementById('ghCommitMsg').value || '').trim() || 'Update';
    await gitAdd(cwd);
    await gitCommit(cwd, msg);
  }
  const r = await gitPush(cwd);
  showOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
  toast(r.ok ? 'Pushed' : 'Push failed', r.ok ? 'success' : 'error');
  refreshAll();
}

async function pull() {
  const cwd = state.get('currentProject');
  if (!cwd) return toast('Select a project first', 'error');
  const r = await gitPull(cwd);
  showOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
  toast(r.ok ? 'Pulled' : 'Pull failed', r.ok ? 'success' : 'error');
  emit('files:changed', {});
  refreshAll();
}

async function fetch() {
  const cwd = state.get('currentProject');
  if (!cwd) return toast('Select a project first', 'error');
  const r = await gitFetch(cwd);
  showOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
  toast(r.ok ? 'Fetched' : 'Fetch failed', r.ok ? 'success' : 'error');
}

async function checkout() {
  const cwd = state.get('currentProject');
  if (!cwd) return toast('Select a project first', 'error');
  const branch = (document.getElementById('ghBranchName').value || '').trim();
  if (!branch) return toast('Enter a branch name', 'error');
  const r = await gitCheckout(cwd, branch);
  showOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
  toast(r.ok ? 'Checked out ' + branch : 'Checkout failed', r.ok ? 'success' : 'error');
  emit('files:changed', {});
  refreshAll();
}

async function clone() {
  const url = (document.getElementById('ghCloneUrl').value || '').trim();
  if (!url) return toast('Enter a URL', 'error');
  toast('Cloning…', 'info');
  const r = await gitClone(url);
  if (r.ok) {
    toast('Cloned into ' + r.dir, 'success');
    emit('files:changed', {});
    state.set('currentProject', r.dir);
    emit('project:change', { name: r.dir });
  } else {
    toast(r.error || 'Clone failed', 'error');
    showOutput((r.stdout || '') + (r.stderr || ''), true);
  }
}

async function createRepo() {
  const name = (document.getElementById('ghNewRepoName').value || '').trim();
  if (!name) return toast('Repo name required', 'error');
  const desc = (document.getElementById('ghNewRepoDesc').value || '').trim();
  const isPrivate = document.getElementById('ghNewRepoPrivate').checked;
  const r = await ghCreateRepo({ name, description: desc, isPrivate });
  if (!r.ok) { toast(r.error || 'Create failed', 'error'); return; }
  const cloneUrl = r.repo && r.repo.cloneUrl;
  const cwd = state.get('currentProject');
  if (cwd && cloneUrl) {
    await gitInit(cwd);
    await gitSetRemote(cwd, cloneUrl);
    toast('Repo created, origin set', 'success');
  } else toast('Repo created', 'success');
  loadRepos();
  refreshAll();
}
