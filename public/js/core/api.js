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

export const roots     = () => request('/api/roots');
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

// ─── Retry / backoff ────────────────────────────────────────────────
// Transient failures (429 rate limit, 5xx, network blips) should not end
// the turn. We retry with exponential backoff + jitter, honouring
// Retry-After when the server sends one.
const RETRY_MAX = 4;            // total attempts = RETRY_MAX + 1
const RETRY_BASE_MS = 800;      // 0.8s, 1.6s, 3.2s, 6.4s
const RETRY_CAP_MS = 15000;

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 ||
         status === 429 || (status >= 500 && status <= 599);
}

function backoffMs(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const secs = Number(retryAfterHeader);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, RETRY_CAP_MS);
  }
  const base = Math.min(RETRY_BASE_MS * Math.pow(2, attempt), RETRY_CAP_MS);
  return Math.round(base * (0.75 + Math.random() * 0.5)); // ±25% jitter
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
  });
}

export function aiChatStream(payload, onDelta, onError, opts = {}) {
  const ctrl = new AbortController();
  const onRetry = opts.onRetry || null;
  const done = (async () => {
    let res = null;
    let lastErr = null;

    for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
      if (ctrl.signal.aborted) return;
      try {
        res = await fetch(API + '/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ stream: true }, payload)),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (err.name === 'AbortError') return;
        lastErr = err;
        res = null;
      }

      // Success, or a non-retryable HTTP error → stop retrying.
      if (res && res.ok) break;
      if (res && !isRetryableStatus(res.status)) break;
      if (attempt === RETRY_MAX) break;

      const wait = backoffMs(attempt, res && res.headers.get('retry-after'));
      const why = res ? ('HTTP ' + res.status) : (lastErr && lastErr.message) || 'network error';
      if (onRetry) onRetry({ attempt: attempt + 1, max: RETRY_MAX, wait, why });
      try { await sleep(wait, ctrl.signal); }
      catch { return; } // aborted while waiting
    }

    if (!res) {
      onError && onError(lastErr || new Error('network error'));
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

// Non-streaming completion, used for context compaction summaries.
export async function aiComplete(payload, opts = {}) {
  const ctrl = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) return { ok: false, aborted: true };
    opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    if (ctrl.signal.aborted) return { ok: false, aborted: true };
    let res = null;
    try {
      res = await fetch(API + '/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ stream: false }, payload)),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') return { ok: false, aborted: true };
      lastErr = err;
    }
    if (res && res.ok) {
      const data = await toJson(res);
      const choice = data.choices && data.choices[0];
      const content = choice && choice.message && choice.message.content;
      return { ok: true, content: content || '' };
    }
    if (res && !isRetryableStatus(res.status)) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: body || ('HTTP ' + res.status) };
    }
    if (attempt === RETRY_MAX) break;
    try { await sleep(backoffMs(attempt, res && res.headers.get('retry-after')), ctrl.signal); }
    catch { return { ok: false, aborted: true }; }
  }
  return { ok: false, error: (lastErr && lastErr.message) || 'network error' };
}

// ─── Context compaction ─────────────────────────────────────────────
// Long agent sessions overflow the model window. Rather than dropping the
// oldest turns blindly (which loses the task statement), we summarise the
// middle of the conversation and keep the system prompt + recent turns.
const COMPACT_TRIGGER_TOKENS = 24000;  // compact once history exceeds this
const COMPACT_KEEP_RECENT = 8;         // always keep the last N messages

// Rough token estimate: ~4 chars/token for English + code.
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function historyTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content);
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return total;
}

export function shouldCompact(messages) {
  if (!Array.isArray(messages) || messages.length < 4) return false;
  return historyTokens(messages) > COMPACT_TRIGGER_TOKENS;
}

// Deterministic fallback when the summariser call fails: keep system +
// recent, and leave a marker recording how much was dropped.
export function compactHistory(messages, opts = {}) {
  const keepRecent = opts.keepRecent || COMPACT_KEEP_RECENT;
  const summary = opts.summary || null;
  if (!Array.isArray(messages) || messages.length <= keepRecent + 1) {
    return messages.slice();
  }
  const system = messages.filter(m => m.role === 'system');
  const rest = messages.filter(m => m.role !== 'system');
  const dropped = rest.slice(0, Math.max(0, rest.length - keepRecent));
  const recent = rest.slice(-keepRecent);
  const marker = {
    role: 'system',
    content: summary
      ? `[Earlier conversation compacted — ${dropped.length} messages summarised]\n${summary}`
      : `[Earlier conversation compacted — ${dropped.length} messages omitted to fit the context window]`,
  };
  return [...system, marker, ...recent];
}

// Summarise the dropped middle via the model, then splice it back in.
export async function compactWithSummary(messages, opts = {}) {
  const keepRecent = opts.keepRecent || COMPACT_KEEP_RECENT;
  const rest = messages.filter(m => m.role !== 'system');
  if (rest.length <= keepRecent + 1) return messages.slice();
  const dropped = rest.slice(0, rest.length - keepRecent);
  const transcript = dropped.map(m => {
    const who = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool' : 'User';
    return `${who}: ${String(m.content || '').slice(0, 1200)}`;
  }).join('\n');

  const res = await aiComplete({
    messages: [
      { role: 'system', content: 'Summarise this coding-session transcript for continuity. Preserve: the user\'s goal, decisions made, files touched, and anything still unfinished. Be terse — bullet points, max 200 words.' },
      { role: 'user', content: transcript },
    ],
    temperature: 0.2,
    max_tokens: 400,
  }, opts);

  if (!res.ok || !res.content) return compactHistory(messages, { keepRecent });
  return compactHistory(messages, { keepRecent, summary: res.content.trim() });
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
