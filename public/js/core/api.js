export const API = window.location.protocol === 'file:'
  ? 'http://127.0.0.1:3001'
  : window.location.origin;

async function toJson(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; }
  catch { return { ok: false, error: 'bad json (' + res.status + ')' }; }
}

export async function request(path, opts = {}) {
  try {
    const res = await fetch(API + path, opts);
    const data = await toJson(res);
    if (!res.ok && data.ok === undefined) data.ok = false;
    if (!res.ok && !data.error) data.error = 'HTTP ' + res.status;
    return data;
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

const jsonPost = (path, body) => request(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

export const fsList   = (p) => request('/api/fs/list?path=' + encodeURIComponent(p || ''));
export const fsRead   = (p) => request('/api/fs/read?path=' + encodeURIComponent(p));
export const fsWrite  = (p, content) => jsonPost('/api/fs/write', { path: p, content });
export const fsDelete = (p) => request('/api/fs/delete?path=' + encodeURIComponent(p), { method: 'DELETE' });
export const fsRename = (oldPath, newPath) => jsonPost('/api/fs/rename', { oldPath, newPath });
export const fsMkdir  = (p) => jsonPost('/api/fs/mkdir', { path: p });

export const health  = () => request('/api/health');
export const version = () => request('/api/version');

export const secretsList = () => request('/api/secrets');
export const secretsSave = (name, value) => jsonPost('/api/secrets', { name, value });

export const aiTools = () => request('/api/ai/tools');

export function aiChatStream(payload, onDelta, onError) {
  const ctrl = new AbortController();
  const done = (async () => {
    let res;
    try {
      res = await fetch(API + '/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ stream: true }, payload)),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      onError && onError(err);
      return;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      onError && onError(new Error(body || ('HTTP ' + res.status)));
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let parsed;
            try { parsed = JSON.parse(raw); } catch { continue; }
            if (parsed.error) { onError && onError(new Error(parsed.error)); continue; }
            const choice = parsed.choices && parsed.choices[0];
            if (choice && choice.delta) onDelta(choice.delta);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') onError && onError(err);
    }
  })();
  return { abort: () => ctrl.abort(), done };
}

export async function aiToolCall(name, args, opts = {}) {
  const body = { name, args: args || {} };
  if (opts.cwd) body.cwd = opts.cwd;
  try {
    const res = await fetch(API + '/api/ai/tool-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    const data = await toJson(res);
    if (!res.ok && data.ok === undefined) data.ok = false;
    return data;
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, aborted: true };
    return { ok: false, error: String(err.message || err) };
  }
}

export async function aiPreview(name, args, opts = {}) {
  const body = { name, args: args || {} };
  if (opts.cwd) body.cwd = opts.cwd;
  try {
    const res = await fetch(API + '/api/ai/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    return await toJson(res);
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, aborted: true };
    return { ok: false, error: String(err.message || err) };
  }
}

export async function aiRepoMap(path, limit) {
  try {
    const qs = new URLSearchParams();
    if (path) qs.set('path', path);
    if (limit) qs.set('limit', String(limit));
    const res = await fetch(API + '/api/ai/repomap?' + qs.toString());
    return await toJson(res);
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
}

export const gitStatus    = (cwd) => jsonPost('/api/git/status', { cwd });
export const gitLog       = (cwd, limit) => jsonPost('/api/git/log', { cwd, limit });
export const gitDiff      = (cwd, file) => jsonPost('/api/git/diff', { cwd, file });
export const gitInit      = (cwd) => jsonPost('/api/git/init', { cwd });
export const gitClone     = (url, dir) => jsonPost('/api/git/clone', { url, dir });
export const gitAdd       = (cwd, paths) => jsonPost('/api/git/add', { cwd, paths });
export const gitCommit    = (cwd, message) => jsonPost('/api/git/commit', { cwd, message });
export const gitPush      = (cwd) => jsonPost('/api/git/push', { cwd });
export const gitPull      = (cwd) => jsonPost('/api/git/pull', { cwd });
export const gitFetch     = (cwd) => jsonPost('/api/git/fetch', { cwd });
export const gitBranches  = (cwd) => jsonPost('/api/git/branches', { cwd });
export const gitCheckout  = (cwd, branch) => jsonPost('/api/git/checkout', { cwd, branch });
export const gitSetRemote = (cwd, url) => jsonPost('/api/git/set-remote', { cwd, url });

export const ghStatus      = () => request('/api/github/status');
export const ghRepos       = () => request('/api/github/repos?per_page=50');
export const ghDeviceStart = (scope) => jsonPost('/api/github/device/start', { scope });
export const ghDevicePoll  = (deviceCode) => jsonPost('/api/github/device/poll', { deviceCode });
export const ghSignOut     = () => jsonPost('/api/github/signout', {});
export const ghCreateRepo  = (body) => jsonPost('/api/github/create-repo', body);

export const exec = (cmd, cwd) => jsonPost('/api/exec', { cmd, cwd });
