/* ═══════════════════════════════════════════════════════════════════
   core/api.js — every fetch to the backend lives here

   Features never call fetch() directly. That gives us one place for:
     - the base URL (window.location.origin)
     - JSON error normalisation ({ ok:false, error })
     - retry/backoff on transient failures (the server already has
       fetchWithRetry; the client had none)
     - AbortController plumbing for the streaming chat endpoint
   ═══════════════════════════════════════════════════════════════════ */

export const API = window.location.protocol === 'file:' ? 'http://127.0.0.1:3001' : window.location.origin;

/** Normalise a Response into { ok, ...json } without throwing on HTML. */
async function toJson(res) {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    return { ok: false, error: 'Bad JSON from ' + res.url + ' (' + res.status + ')' };
  }
  if (!res.ok && data && data.ok === undefined) data.ok = false;
  return data;
}

/**
 * fetch + JSON + optional retry.
 * @param {string} path  e.g. '/api/fs/list?path=...'
 * @param {RequestInit & {retries?:number, retryDelay?:number}} [opts]
 */
export async function request(path, opts) {
  const o = opts || {};
  const retries = o.retries === undefined ? 0 : o.retries;
  const retryDelay = o.retryDelay === undefined ? 400 : o.retryDelay;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(API + path, o);
      // Retry only on gateway/network-ish statuses.
      if (retries > 0 && (res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
        await sleep(retryDelay * Math.pow(2, attempt));
        continue;
      }
      return await toJson(res);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(retryDelay * Math.pow(2, attempt));
        continue;
      }
    }
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr || 'network error') };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const jsonPost = (path, body, extra) =>
  request(path, Object.assign({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }, extra || {}));

/* ── filesystem ─────────────────────────────────────────────────── */
export const fsList = (p) => request('/api/fs/list?path=' + encodeURIComponent(p || ''));
export const fsRead = (p) => request('/api/fs/read?path=' + encodeURIComponent(p));
export const fsWrite = (p, content) => jsonPost('/api/fs/write', { path: p, content });
export const fsDelete = (p) => request('/api/fs/delete?path=' + encodeURIComponent(p), { method: 'DELETE' });
export const fsRename = (oldPath, newPath) => jsonPost('/api/fs/rename', { oldPath, newPath });
export const fsMkdir = (p) => jsonPost('/api/fs/mkdir', { path: p });

/* ── system ─────────────────────────────────────────────────────── */
export const health = () => request('/api/health', { retries: 1, retryDelay: 250 });
export const version = () => request('/api/version');
export const diagnostics = () => request('/api/diagnostics');
export const changelog = () => request('/api/changelog');

/* ── ai ─────────────────────────────────────────────────────────── */
export const aiProviders = () => request('/api/ai/providers');
export const aiKeys = (name, value) => jsonPost('/api/ai/keys', { name, value });

/**
 * Streaming chat. Returns an object with .abort() so the UI can offer
 * a Stop button — the old sendChat() had no way to cancel a runaway
 * stream, which on mobile drains battery and data.
 *
 * @param {object} payload
 * @param {(chunk:string)=>void} onChunk
 * @param {(err:Error)=>void} [onError]
 * @returns {{abort:()=>void, done:Promise<void>}}
 */
export function aiStream(payload, onChunk, onError) {
  const ctrl = new AbortController();
  const done = (async () => {
    try {
      const res = await fetch(API + '/api/ai/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error('stream failed: HTTP ' + res.status);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buf += decoder.decode(value, { stream: true });
        // Server sends SSE-ish "data: {...}\n\n" frames.
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const parsed = JSON.parse(raw);
            const text = parsed.delta || parsed.content || parsed.text || '';
            if (text) onChunk(text);
          } catch (err) {
            // Non-JSON frame — pass it through verbatim.
            onChunk(raw);
          }
        }
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user pressed Stop
      if (onError) onError(err);
      else console.error('[api] stream error', err);
    }
  })();
  return { abort: () => ctrl.abort(), done };
}

/**
 * Streaming chat, provider-native passthrough.
 *
 * `aiStream()` above flattens frames to text, which is fine for a plain
 * answer but throws away `tool_calls` — so it could never drive the agent
 * loop. This variant hands the caller the raw upstream delta object
 * (`choices[0].delta`) and keeps the AbortController, so the Stop button
 * works and tool calls survive.
 *
 * @param {object} payload  { provider, messages, tools, toolChoice, maxTokens }
 * @param {(delta:object)=>void} onDelta
 * @param {(err:Error)=>void} [onError]
 * @returns {{abort:()=>void, done:Promise<void>}}
 */
export function aiStreamRaw(payload, onDelta, onError) {
  const ctrl = new AbortController();
  const done = (async () => {
    let res;
    try {
      res = await fetch(API + '/api/ai/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (onError) onError(err); else console.error('[api] stream error', err);
      return;
    }
    if (!res.ok) {
      // The server returns JSON ({ error, detail }) on provider rejection.
      const body = await res.text().catch(() => '');
      const err = new Error('HTTP ' + res.status + (body ? ': ' + body.slice(0, 800) : ''));
      err.status = res.status;
      err.body = body;
      if (onError) onError(err); else console.error('[api] stream error', err);
      return;
    }
    if (!res.body) {
      const err = new Error('stream failed: no body');
      if (onError) onError(err); else console.error('[api] stream error', err);
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
            if (!line.startsWith('data:')) continue; // skips ': ping' keep-alives
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch (err) {
              continue; // partial/garbled frame — drop it
            }
            if (parsed && parsed.error) {
              const err = new Error(String(parsed.error));
              if (onError) onError(err); else console.error('[api] stream error', err);
              continue;
            }
            const choice = parsed && parsed.choices && parsed.choices[0];
            if (choice && choice.delta) onDelta(choice.delta);
          }
        }
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user pressed Stop
      if (onError) onError(err); else console.error('[api] stream error', err);
    }
  })();
  return { abort: () => ctrl.abort(), done };
}

/* ── git ────────────────────────────────────────────────────────── */
export const gitStatus = (project) => request('/api/git/status?project=' + encodeURIComponent(project || ''));
export const gitAction = (action, body) => jsonPost('/api/git/' + action, body);
export const ghCall = (endpoint, body) => jsonPost(endpoint, body);

/* ── exec ───────────────────────────────────────────────────────── */
export const exec = (cmd, cwd) => jsonPost('/api/exec', { cmd, cwd });
export const compile = (body) => jsonPost('/api/compile', body);
export const processes = () => request('/api/processes');

export default {
  API, request, fsList, fsRead, fsWrite, fsDelete, fsRename, fsMkdir,
  health, version, diagnostics, changelog,
  aiProviders, aiKeys, aiStream, aiStreamRaw,
  gitStatus, gitAction, ghCall,
  exec, compile, processes,
};
