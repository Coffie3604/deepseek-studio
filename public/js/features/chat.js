import * as state from '../core/state.js';
import { on, emit } from '../core/bus.js';
import { toast, escapeHtml, showConfirm, copyText } from '../core/ui.js';
import { aiChatStream, aiComplete, aiToolCall, aiTools, aiPreview, aiRepoMap } from '../core/api.js';
import { schedule, cancel } from '../core/perf.js';

let elMessages, elInput, elSend, elStop, elAutoRun;
let tools = [];

// Tools that write to disk. These get a diff-review gate before executing
// (unless auto-run is enabled, which is the user opting into autonomy).
const MUTATING = new Set(['write_file', 'apply_patch', 'multi_patch', 'delete_file', 'move_file']);
let abort = null;
let busy = false;
let typingEl = null;
let unsubs = [];

export async function init() {
  elMessages = document.getElementById('chatMessages');
  elInput    = document.getElementById('aiInput');
  elSend     = document.getElementById('aiSendBtn');
  elStop     = document.getElementById('aiStopBtn');
  elAutoRun  = document.getElementById('autoRunToggle');

  if (elSend) elSend.onclick = send;
  if (elStop) elStop.onclick = stop;
  if (elInput) {
    elInput.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    };
    elInput.addEventListener('input', () => {
      elInput.style.height = 'auto';
      elInput.style.height = Math.min(elInput.scrollHeight, 140) + 'px';
    });
  }
  if (elAutoRun) {
    elAutoRun.checked = !!state.get('autoRunEnabled');
    elAutoRun.onchange = () => {
      state.set('autoRunEnabled', elAutoRun.checked);
      toast('Auto-run ' + (elAutoRun.checked ? 'ON' : 'OFF'), 'info');
    };
  }

  try { tools = (await aiTools()).tools || []; }
  catch (e) { console.warn('[chat] tools load failed', e); }

  restore();
  unsubs.push(on('chat:send', (p) => { if (p && p.text && elInput) { elInput.value = p.text; send(); } }));
}

export function destroy() {
  if (abort) { try { abort.abort(); } catch {} abort = null; }
  for (const un of unsubs) un();
  unsubs = [];
  busy = false;
  hideTyping();
}

export function mount()   { setTimeout(() => elInput && elInput.focus(), 60); }
export function unmount() {}

function restore() {
  const hist = state.get('chatHistory') || [];
  if (!hist.length) return;
  elMessages.innerHTML = '';
  for (const m of hist) {
    if (m.role === 'user') appendMessage('user', m.content, true);
    else if (m.role === 'assistant' && m.content) appendMessage('assistant', m.content, true);
  }
}

function renderContent(text) {
  let html = '';
  const parts = text.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    if (part.startsWith('```')) {
      const m = part.match(/```(\w*)\n?([\s\S]*?)```/);
      if (!m) continue;
      const lang = m[1] || 'text';
      const code = m[2];
      html +=
        '<div class="code-block">' +
          '<div class="code-head">' +
            '<span class="lang">' + escapeHtml(lang) + '</span>' +
            '<button class="copy-btn code-copy" data-copy-code="1" title="Copy code">⧉ Copy</button>' +
          '</div>' +
          '<pre>' + escapeHtml(code) + '</pre>' +
        '</div>';
    } else {
      html += '<p>' + escapeHtml(part).replace(/\n/g, '<br>') + '</p>';
    }
  }
  return html;
}

// Attach a "Copy" button to a chat message bubble. The button copies the
// message's raw text (code blocks included) to the clipboard.
function addCopyButton(el, getText) {
  if (!el) return;
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  const btn = document.createElement('button');
  btn.className = 'copy-btn msg-copy';
  btn.type = 'button';
  btn.title = 'Copy message';
  btn.textContent = '⧉ Copy';
  btn.onclick = async (e) => {
    e.stopPropagation();
    const ok = await copyText(getText());
    btn.textContent = ok ? '✓ Copied' : '✗ Failed';
    if (ok) toast('Copied to clipboard', 'info', 1400);
    setTimeout(() => { btn.textContent = '⧉ Copy'; }, 1400);
  };
  bar.appendChild(btn);
  el.appendChild(bar);
}

// Wire up per-code-block copy buttons inside a message element.
function wireCodeCopy(el) {
  if (!el) return;
  el.querySelectorAll('.code-copy').forEach((btn) => {
    if (btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.onclick = async (e) => {
      e.stopPropagation();
      const block = btn.closest('.code-block');
      const pre = block && block.querySelector('pre');
      const ok = await copyText(pre ? pre.textContent : '');
      btn.textContent = ok ? '✓ Copied' : '✗ Failed';
      setTimeout(() => { btn.textContent = '⧉ Copy'; }, 1400);
    };
  });
}

function appendMessage(role, content, skipSave) {
  if (!elMessages) return null;
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  if (role === 'assistant') {
    div.innerHTML = renderContent(content);
    wireCodeCopy(div);
  } else {
    div.textContent = content;
  }
  addCopyButton(div, () => content);
  elMessages.appendChild(div);
  elMessages.scrollTop = elMessages.scrollHeight;
  if (!skipSave && content) {
    const hist = (state.get('chatHistory') || []).slice();
    hist.push({ role, content });
    state.set('chatHistory', hist.slice(-100));
  }
  return div;
}

function showTyping() {
  hideTyping();
  if (!elMessages) return;
  typingEl = document.createElement('div');
  typingEl.className = 'typing-indicator';
  typingEl.innerHTML = '<span></span><span></span><span></span>';
  elMessages.appendChild(typingEl);
  elMessages.scrollTop = elMessages.scrollHeight;
}
function hideTyping() {
  if (typingEl) { typingEl.remove(); typingEl = null; }
}

function toolBubble(name, args) {
  hideTyping();
  if (!elMessages) return null;
  const el = document.createElement('div');
  el.className = 'tool-call running';
  const preview =
    name === 'write_file'   ? (args.path || '') :
    name === 'apply_patch'  ? (args.path || '') + ' → ' + ((args.search || '').slice(0, 40).replace(/\n/g, ' ')) :
    name === 'move_file'    ? (args.from || '') + ' → ' + (args.to || '') :
    name === 'run_command'  ? (args.command || '').slice(0, 60) :
    name === 'grep_search'  ? '"' + (args.pattern || '') + '"' :
    name === 'find_files'   ? (args.pattern || '') :
                              (args.path || '');
  el.innerHTML =
    '<div class="tool-head">' +
      '<span class="tool-name">' + escapeHtml(name) + '</span>' +
      '<span class="tool-arg">' + escapeHtml(preview) + '</span>' +
      '<span class="tool-status">…</span>' +
      '<button class="copy-btn tool-copy" type="button" title="Copy tool call">⧉</button>' +
    '</div>';
  const copyBtn = el.querySelector('.tool-copy');
  if (copyBtn) {
    copyBtn.onclick = async (e) => {
      e.stopPropagation();
      const out = el.querySelector('.tool-output');
      const payload =
        name + ' ' + JSON.stringify(args, null, 2) +
        (out ? '\n\n--- output ---\n' + out.textContent : '');
      const ok = await copyText(payload);
      copyBtn.textContent = ok ? '✓' : '✗';
      setTimeout(() => { copyBtn.textContent = '⧉'; }, 1200);
    };
  }
  elMessages.appendChild(el);
  elMessages.scrollTop = elMessages.scrollHeight;
  return el;
}

function finishTool(el, result) {
  if (!el) return;
  el.classList.remove('running');
  el.classList.add(result.ok ? 'success' : 'error');
  const st = el.querySelector('.tool-status');
  if (st) st.textContent = result.ok ? '✓' : '✗';
  if (result.display) {
    const out = document.createElement('div');
    out.className = 'tool-output';
    out.textContent = result.display;
    el.appendChild(out);
  }
}

// Render a unified-diff preview and resolve(true) on Approve, false on Reject.
// `preview` comes from /api/ai/preview: { ok, kind, path, diff, added, removed }.
function showDiffReview(name, args, preview, resolve) {
  hideTyping();
  const wrap = document.createElement('div');
  wrap.className = 'diff-review';

  const target = preview.path || args.path || args.to || args.from || '';
  const added = preview.added || 0;
  const removed = preview.removed || 0;

  const head = document.createElement('div');
  head.className = 'diff-head';
  head.innerHTML =
    '<span class="diff-tool">' + escapeHtml(name) + '</span>' +
    '<span class="diff-path">' + escapeHtml(target) + '</span>' +
    '<span class="diff-stat"><b class="add">+' + added + '</b> <b class="del">-' + removed + '</b></span>';
  wrap.appendChild(head);

  const body = document.createElement('pre');
  body.className = 'diff-body';
  const lines = String(preview.diff || '').split('\n');
  // Cap the rendered diff so a huge rewrite can't lock up the WebView.
  const MAX_LINES = 400;
  const shown = lines.slice(0, MAX_LINES);
  body.innerHTML = shown.map((ln) => {
    let cls = 'ctx';
    if (ln.startsWith('+++') || ln.startsWith('---')) cls = 'meta';
    else if (ln.startsWith('@@')) cls = 'hunk';
    else if (ln.startsWith('+')) cls = 'add';
    else if (ln.startsWith('-')) cls = 'del';
    return '<span class="dl ' + cls + '">' + escapeHtml(ln || ' ') + '</span>';
  }).join('');
  if (lines.length > MAX_LINES) {
    body.innerHTML += '<span class="dl meta">… ' + (lines.length - MAX_LINES) + ' more lines</span>';
  }
  wrap.appendChild(body);

  const bar = document.createElement('div');
  bar.className = 'diff-actions';
  const reject = document.createElement('button');
  reject.className = 'btn btn-ghost';
  reject.type = 'button';
  reject.textContent = 'Reject';
  const approve = document.createElement('button');
  approve.className = 'btn btn-primary';
  approve.type = 'button';
  approve.textContent = 'Approve & apply';
  bar.appendChild(reject);
  bar.appendChild(approve);
  wrap.appendChild(bar);

  elMessages.appendChild(wrap);
  elMessages.scrollTop = elMessages.scrollHeight;

  const done = (ok) => {
    approve.disabled = true;
    reject.disabled = true;
    wrap.classList.add(ok ? 'approved' : 'rejected');
    bar.innerHTML = '<span class="diff-verdict">' + (ok ? '✓ Applied' : '✗ Rejected') + '</span>';
    resolve(ok);
  };
  approve.onclick = () => done(true);
  reject.onclick = () => done(false);
}

async function send() {
  if (busy) return;
  if (!tools.length) { toast('Loading AI tools…', 'info'); return; }

  const project = state.get('currentProject');
  if (!project) { toast('Select a project first', 'error'); return; }

  const text = (elInput.value || '').trim();
  if (!text) return;

  elInput.value = '';
  elInput.style.height = 'auto';
  appendMessage('user', text);
  showTyping();

  busy = true;
  elSend.hidden = true;
  elStop.hidden = false;
  abort = new AbortController();

  const messages = [{ role: 'system', content: buildSystem(project) }];
  for (const m of (state.get('chatHistory') || [])) {
    if (m.role === 'user' || m.role === 'assistant') messages.push({ role: m.role, content: m.content });
  }

  try {
    await runAgentLoop(messages);
  } catch (err) {
    hideTyping();
    if (abort && abort.signal.aborted) appendMessage('assistant', '_(stopped)_', true);
    else appendMessage('assistant', 'Error: ' + (err.message || err));
  } finally {
    busy = false;
    abort = null;
    elSend.hidden = false;
    elStop.hidden = true;
    hideTyping();
  }
}

function buildSystem(project) {
  // Advertise the tools the server ACTUALLY exposes, not a hardcoded subset.
  // The server merges base + extra tools; if we hardcode, the model never
  // learns about multi_patch / run_tests / outline / remember / etc.
  const names = tools.map((t) => (t.function && t.function.name) || t.name).filter(Boolean);
  const toolLine = names.length
    ? 'Tools available: ' + names.join(', ') + '.\n\n'
    : '';

  const repoMap = state.get('repoMap') || '';
  const mapBlock = repoMap
    ? '\nProject map (auto-generated, may be stale):\n' + repoMap + '\n'
    : '';

  return (
    'You are DeepSeek Studio, an AI coding agent running on Termux (Android).\n' +
    'Project: "' + project + '". All paths are relative to "' + project + '/".\n\n' +
    'Rules:\n' +
    '- BE DECISIVE. Act on the task; do not just analyze.\n' +
    '- Spend at most 2-3 read/search ops to understand, then start editing.\n' +
    '- Prefer multi_patch over many single apply_patch calls for multi-file work.\n' +
    '- After editing code, run the project tests (run_tests) or lint (lint) and fix failures.\n' +
    '- Use todo to track multi-step work; use remember to persist durable facts.\n' +
    '- When done with a coherent chunk, STOP and give a 1-2 sentence summary.\n\n' +
    toolLine +
    'Use apply_patch for ANY edit to an existing file (give 3-5 lines of context).\n' +
    'Use write_file ONLY for new files. Never touch node_modules, .git, build, dist.' +
    mapBlock
  );
}

// ─── Context compaction ─────────────────────────────────────────────
// Long agent sessions accumulate tool output fast (a single `run_tests`
// can be thousands of tokens). When the wire payload grows past a budget
// we summarise the oldest turns into one compact system note, keeping the
// original system prompt and the most recent turns verbatim.
const COMPACT_CHAR_BUDGET = 60000;   // ~15k tokens of history
const COMPACT_KEEP_RECENT  = 6;      // always keep last N messages verbatim

function approxChars(messages) {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') n += m.content.length;
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  }
  return n;
}

// Returns a NEW messages array with old turns folded into a summary note.
// On any failure it returns the input unchanged — compaction must never
// break a working turn.
async function compactMessages(messages) {
  if (approxChars(messages) <= COMPACT_CHAR_BUDGET) return messages;

  const system = messages[0] && messages[0].role === 'system' ? messages[0] : null;
  const rest = system ? messages.slice(1) : messages.slice();
  if (rest.length <= COMPACT_KEEP_RECENT) return messages;

  const cut = rest.length - COMPACT_KEEP_RECENT;
  const old = rest.slice(0, cut);
  const recent = rest.slice(cut);

  const transcript = old.map((m) => {
    const role = m.role || 'unknown';
    let body = typeof m.content === 'string' ? m.content : '';
    if (m.tool_calls) {
      body += ' [called: ' + m.tool_calls.map((t) => t.function && t.function.name).filter(Boolean).join(', ') + ']';
    }
    return role.toUpperCase() + ': ' + body.slice(0, 1200);
  }).join('\n\n');

  const res = await aiComplete({
    provider: 'deepseek',
    messages: [
      {
        role: 'system',
        content:
          'You compress coding-agent transcripts. Produce a dense factual summary ' +
          'preserving: files touched, decisions made, commands run and their outcomes, ' +
          'errors encountered, and any unfinished work. Omit pleasantries. ' +
          'Use terse bullet points. Max 400 words.',
      },
      { role: 'user', content: transcript },
    ],
    maxTokens: 700,
  }, { signal: abort.signal });

  if (res.aborted) return messages;
  if (!res.ok || !res.content) {
    console.warn('[chat] compaction failed, keeping full history', res.error);
    return messages;
  }

  const note = {
    role: 'system',
    content: 'Summary of earlier conversation (older turns were compacted to save context):\n' + res.content,
  };
  toast('Context compacted (' + old.length + ' turns summarised)', 'info', 2000);
  return system ? [system, note, ...recent] : [note, ...recent];
}

async function runAgentLoop(messages) {
  const MAX_ITER = Number(state.get('maxIterations')) || 20;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    if (abort.signal.aborted) return;

    // Fold old turns into a summary before the payload gets too big.
    messages = await compactMessages(messages);
    if (abort.signal.aborted) return;

    let text = '';
    const toolCalls = [];
    let liveMsg = null;

    await new Promise((resolve, reject) => {
      const stream = aiChatStream(
        { provider: 'deepseek', messages, tools, toolChoice: 'auto', maxTokens: 4096 },
        (delta) => {
          if (delta.content) {
            text += delta.content;
            if (!liveMsg) liveMsg = appendMessage('assistant', '', true);
            if (liveMsg) {
              // Tokens arrive far faster than the display refreshes. Coalesce
              // into one paint per frame: re-rendering + re-wiring listeners on
              // every token is what made long replies stutter.
              const node = liveMsg;
              schedule('chat:stream', () => {
                node.innerHTML = renderContent(text);
                wireCodeCopy(node);
                addCopyButton(node, () => text);
                elMessages.scrollTop = elMessages.scrollHeight;
              });
            }
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index != null ? tc.index : 0;
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.type) toolCalls[idx].type = tc.type;
              if (tc.function && tc.function.name) toolCalls[idx].function.name = tc.function.name;
              if (tc.function && tc.function.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
        },
        (err) => reject(err),
        {
          onRetry: ({ attempt, max, wait, why }) => {
            toast('Retrying (' + attempt + '/' + max + ') in ' + Math.round(wait / 1000) + 's — ' + why, 'info', 2500);
          },
        }
      );
      abort._stream = stream;
      stream.done.then(resolve, reject);
    });

    // Flush any frame still queued from the last tokens, so the final text is
    // painted before we finalize the message. Without this the tail of a reply
    // can be dropped when the stream ends mid-frame.
    cancel('chat:stream');
    if (liveMsg) {
      liveMsg.innerHTML = renderContent(text);
      wireCodeCopy(liveMsg);
      addCopyButton(liveMsg, () => text);
    }

    hideTyping();
    if (abort.signal.aborted) return;
    if (!text && !toolCalls.length) { appendMessage('assistant', '(no response)'); return; }
    if (text) {
      const hist = (state.get('chatHistory') || []).slice();
      hist.push({ role: 'assistant', content: text });
      state.set('chatHistory', hist.slice(-100));
    }

    const validTools = toolCalls.filter(Boolean);
    // ─── Belt-and-suspenders ─────────────────────────────────────
    // Force type:'function' on EVERY tool_call right before it goes
    // into the wire payload. If a delta ever omits `type`, or the
    // initializer hole gets hit, this line guarantees the field
    // exists. DeepSeek 422s with `missing field type` if it doesn't.
    for (const tc of validTools) if (!tc.type) tc.type = 'function';

    const assistantMsg = { role: 'assistant', content: text || null };
    if (validTools.length) assistantMsg.tool_calls = validTools;
    messages.push(assistantMsg);

    if (!validTools.length) return;

    for (const tc of validTools) {
      if (abort.signal.aborted) return;
      const name = tc.function.name;
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}

      if (!state.get('autoRunEnabled')) {
        const proceed = await new Promise((resolve) => {
          showConfirm('Run ' + name + '?', JSON.stringify(args).slice(0, 240), resolve, 'Run');
        });
        if (!proceed) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: 'user skipped' }) });
          continue;
        }
      }

      // ─── Diff-review gate ───────────────────────────────────────
      // For mutating tools, preview the change and let the user approve.
      // Skipped when auto-run is on (the user opted into autonomy).
      if (!state.get('autoRunEnabled') && MUTATING.has(name)) {
        const preview = await aiPreview(name, args, {
          cwd: state.get('currentProject'),
          signal: abort.signal,
        });
        if (preview.aborted) return;
        if (preview.ok && preview.kind !== 'none') {
          const proceed = await new Promise((resolve) => {
            showDiffReview(name, args, preview, resolve);
          });
          if (!proceed) {
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: 'user rejected the change' }) });
            continue;
          }
        }
      }

      const bubble = toolBubble(name, args);
      const result = await aiToolCall(name, args, {
        cwd: state.get('currentProject'),
        signal: abort.signal,
      });

      if (result.aborted) return;
      finishTool(bubble, result);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result.result || result) });

      if (['write_file', 'apply_patch', 'delete_file', 'move_file'].includes(name)) {
        emit('files:changed', { path: args.path || args.to });
      }
    }
    showTyping();
  }

  // Hit the iteration cap with work possibly unfinished. Offer to continue
  // rather than silently truncating — the loop state is still in `messages`.
  const cont = await new Promise((resolve) => {
    showConfirm(
      'Reached the ' + MAX_ITER + '-step limit',
      'The agent stopped mid-task. Continue for another ' + MAX_ITER + ' steps?',
      resolve,
      'Continue'
    );
  });
  if (cont && !abort.signal.aborted) {
    await runAgentLoop(messages);
  } else {
    appendMessage('assistant', '_(stopped at the ' + MAX_ITER + '-step limit)_', true);
  }
}

function stop() {
  if (!abort) return;
  try { abort.abort(); } catch {}
  if (abort._stream) { try { abort._stream.abort(); } catch {} }
}