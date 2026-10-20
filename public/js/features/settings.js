import { toast } from '../core/ui.js';
import { secretsList, secretsSave, version } from '../core/api.js';

export async function init() {
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  bind('apiKeyTestBtn', saveApiKey);
  bind('githubTokenSaveBtn', saveGithubToken);
  bind('githubClientIdSaveBtn', saveGithubClientId);
  await refreshHints();
  await refreshBackend();
}
export function destroy() {}
export function mount() {}
export function unmount() {}

async function refreshHints() {
  const s = await secretsList();
  const apiHint = document.getElementById('apiKeyStatus');
  if (apiHint) {
    apiHint.textContent = (s.deepseek_key && s.deepseek_key.configured)
      ? '✓ Configured (…' + s.deepseek_key.hint + ')'
      : 'Not configured';
  }
}

async function refreshBackend() {
  const v = await version();
  const ver = document.getElementById('backendVersion');
  const stat = document.getElementById('backendStatus');
  if (ver) ver.textContent = 'v' + (v.version || '?') + ' · Node ' + (v.node || '?');
  if (stat) {
    if (v.error) stat.textContent = '✗ ' + v.error;
    else stat.textContent = '✓ ' + ((v.providers || []).join(', ') || 'no provider') +
      (v.hasGitHub ? ' · GitHub connected' : '');
  }
}

async function saveApiKey() {
  const input = document.getElementById('apiKeyInput');
  const key = (input.value || '').trim();
  if (!key) return toast('Enter a key first', 'error');
  const r = await secretsSave('deepseek_key', key);
  if (r.ok) { toast('API key saved', 'success'); input.value = ''; refreshHints(); refreshBackend(); }
  else toast(r.error || 'Save failed', 'error');
}

async function saveGithubToken() {
  const input = document.getElementById('githubTokenInput');
  const token = (input.value || '').trim();
  if (!token) return toast('Enter a token', 'error');
  const r = await secretsSave('github_token', token);
  if (r.ok) { toast('Token saved', 'success'); input.value = ''; refreshBackend(); }
  else toast(r.error || 'Save failed', 'error');
}

async function saveGithubClientId() {
  const input = document.getElementById('githubClientIdInput');
  const id = (input.value || '').trim();
  if (!id) return toast('Enter a client ID', 'error');
  const r = await secretsSave('github_client_id', id);
  if (r.ok) { toast('Client ID saved', 'success'); input.value = ''; }
  else toast(r.error || 'Save failed', 'error');
}
