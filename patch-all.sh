#!/data/data/com.termux/files/usr/bin/bash
# patch-all.sh — apply all corrections from the review
set -e

REPO="${1:-$HOME/projects/deepseek-editor-sandbox}"
cd "$REPO" || { echo "✗ No such directory: $REPO"; exit 1; }

BK=".patch-backup/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"
for f in server.js public/index.html install.sh; do
  [ -f "$f" ] && cp "$f" "$BK/$(basename "$f")"
done
echo "── Backups saved to: $BK"
echo "── Patching in:      $(pwd)"
echo

python3 <<'PYEOF'
import os, re, sys

def read(p):
    with open(p, 'r', encoding='utf-8') as f: return f.read()

def write(p, s):
    with open(p, 'w', encoding='utf-8') as f: f.write(s)

STATS = {'ok':0, 'skip':0, 'fail':0}

def patch(path, old, new, label):
    if not os.path.exists(path):
        print(f'  ✗ {label}: {path} missing'); STATS['fail'] += 1; return False
    c = read(path)
    if old not in c:
        # already-applied detection: the new content's first non-blank line present?
        probe = new.strip().splitlines()[0] if new.strip() else None
        if probe and probe in c:
            print(f'  ⊘ {label}: already applied'); STATS['skip'] += 1; return True
        print(f'  ✗ {label}: pattern not found in {path}'); STATS['fail'] += 1; return False
    write(path, c.replace(old, new, 1))
    print(f'  ✓ {label}'); STATS['ok'] += 1; return True

def replace_top_level_fn(path, fn_name, new_fn, label):
    """Replace a top-level `function fnName(...) { ... }` block, matching the
       closing brace at column 0 (works for well-formatted JS)."""
    if not os.path.exists(path):
        print(f'  ✗ {label}: {path} missing'); STATS['fail'] += 1; return False
    c = read(path)
    pat = re.compile(r'^function ' + re.escape(fn_name) + r'\s*\(', re.MULTILINE)
    m = pat.search(c)
    if not m:
        print(f'  ⊘ {label}: function not found (may already be removed)'); STATS['skip'] += 1; return False
    end = re.compile(r'^\}', re.MULTILINE).search(c, m.start())
    if not end:
        print(f'  ✗ {label}: could not find closing brace'); STATS['fail'] += 1; return False
    if new_fn.strip() in c:
        print(f'  ⊘ {label}: already applied'); STATS['skip'] += 1; return True
    write(path, c[:m.start()] + new_fn + c[end.end():])
    print(f'  ✓ {label}'); STATS['ok'] += 1; return True

# ════════════════════════════════════════════════════════════════════
# A. server.js
# ════════════════════════════════════════════════════════════════════
print('A. server.js')

patch('server.js',
'''    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Provider error ' + upstream.status });
    res.setHeader('Content-Type', 'text/event-stream');''',
'''    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return res.status(upstream.status).json({
            error: 'Provider error ' + upstream.status,
            detail: redact(text).slice(0, 800),
        });
    }
    res.setHeader('Content-Type', 'text/event-stream');''',
'A1  /api/ai/stream — surface upstream error body')

patch('server.js',
'''    const cap = name === 'google_play_service_account' ? 20000 : 4000;
    if (value.length > cap) return res.status(400).json({ error: 'invalid value' });''',
'''    const cap = name === 'google_play_service_account' ? 20000 : 4000;
    if (value.length > cap) return res.status(400).json({ error: 'invalid value' });
    // Reject obvious placeholder text before it becomes a silent auth failure
    if (name.endsWith('_key') && /^sk-(paste|your|xxx|abc|test)/i.test(value.trim())) {
        return res.status(400).json({ error: 'Looks like a placeholder — paste the real key' });
    }''',
'A2  /api/secrets — reject placeholder keys')

patch('server.js',
"""const DEFAULT_GH_CLIENT_ID = process.env.DS_GITHUB_CLIENT_ID || 'Ov23liFZ2XqTa0eGnqJd';""",
"""const DEFAULT_GH_CLIENT_ID = process.env.DS_GITHUB_CLIENT_ID || 'Ov23liFZ2XqTa0eGnqJd';
if (!process.env.DS_GITHUB_CLIENT_ID && !String(secrets.github_client_id || '').trim()) {
    console.warn('[github] Using built-in OAuth client_id — device-flow sign-in will fail if that app is revoked.');
    console.warn('[github] Register your own at https://github.com/settings/developers → OAuth Apps → Enable Device Flow');
    console.warn('[github] Then set DS_GITHUB_CLIENT_ID or save a github_client_id secret.');
}""",
'A3  warn when default GitHub OAuth client_id is in use')

# ════════════════════════════════════════════════════════════════════
# B. public/index.html
# ════════════════════════════════════════════════════════════════════
print()
print('B. public/index.html')

patch('public/index.html',
'''function saveFile() {
  if (!openFile) { toast('No file open', 'error'); return; }
  fsWrite(openFile, fileContent).then(function() {''',
'''function saveFile() {
  if (!openFile) { toast('No file open', 'error'); return Promise.resolve(); }
  return fsWrite(openFile, fileContent).then(function() {''',
'B1  saveFile() returns a promise')

patch('public/index.html',
"""      if (r.ok) { s.textContent = '✅ Valid'; s.style.color = 'var(--green)'; localStorage.setItem('ds_key', k); }""",
"""      if (r.ok) {
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
      }""",
'B2  Test key — also save server-side')

patch('public/index.html',
'''    if (r.ok) {
      localStorage.setItem('ds_key', key);
      document.getElementById('apiKeyInput').value = key;''',
'''    if (r.ok) {
      localStorage.setItem('ds_key', key);
      document.getElementById('apiKeyInput').value = key;
      fetch(API + '/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'deepseek_key', value: key }),
      }).catch(function() {});''',
'B3  Wizard verify — also save server-side')

patch('public/index.html',
'''      } else {
        // existing non-streaming path — keep as-is
        if (!res.ok) throw new Error('API ' + res.status);
        var data = await res.json();
        var assistantMsg = data.choices[0].message;
        messages.push(assistantMsg);
        if (assistantMsg.content) { hideTypingIndicator(); appendMessage('assistant', assistantMsg.content); }
      }''',
'''      } else if (!res.ok) {
        // Provider rejected the request (400/401/402/429/503). The server may
        // include a `detail` field with the upstream body — surface it.
        const errBody = await res.text().catch(function() { return ''; });
        hideTypingIndicator();
        appendMessage('assistant', '**DeepSeek ' + res.status + '**\\n\\n```\\n' + errBody + '\\n```');
        return;
      } else {
        // Non-streaming happy path
        const data = await res.json();
        const assistantMsg = data.choices[0].message;
        messages.push(assistantMsg);
        if (assistantMsg.content) { hideTypingIndicator(); appendMessage('assistant', assistantMsg.content); }
      }''',
'B4  sendChat — surface real error body')

# B5 — full function replacement via brace-balanced search
NEW_RCC = r'''function renderChatContent(content) {
  var parts = content.split(/(```[\s\S]*?```)/g);
  var html = '';
  parts.forEach(function(p) {
    if (p.indexOf('```') === 0) {
      // ── Fenced code block ──
      var match = p.match(/```(\w*)\n?([\s\S]*?)```/);
      if (match) {
        var lang = match[1] || 'text';
        var code = match[2];
        var escaped = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        html += '<pre>' +
          '<span class="lang">' + escapeHtml(lang) + '</span>' +
          '<div class="pre-actions">' +
            '<button class="copy-btn pre-copy-btn" data-code="' + encodeURIComponent(code) + '" title="Copy code">' +
              '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
            '</button>' +
            '<button class="insert-code-btn" data-code="' + encodeURIComponent(code) + '">Insert</button>' +
          '</div>' +
          escaped +
        '</pre>';
      }
      return;
    }
    // ── Inline text with `code` spans. Split first so we can escape
    //    the plain text and the code content independently. ──
    var segments = [];
    var re = /`([^`]+)`/g, m, last = 0;
    while ((m = re.exec(p))) {
      if (m.index > last) segments.push({ t: 'text', v: p.slice(last, m.index) });
      segments.push({ t: 'code', v: m[1] });
      last = m.index + m[0].length;
    }
    if (last < p.length) segments.push({ t: 'text', v: p.slice(last) });

    var buf = '';
    segments.forEach(function(seg) {
      if (seg.t === 'text') {
        buf += escapeHtml(seg.v).replace(/\n/g, '<br>');
        return;
      }
      var safe = escAttr(seg.v);
      if (/\.(py|js|ts|kt|kts|java|dart|rs|go|html|css|json|xml|yaml|yml|sh|md|txt|c|cpp|swift)\b/.test(seg.v)) {
        buf += '<span class="file-path-link" data-path="' + safe + '">' + safe + '</span>';
      } else {
        buf += '<span class="cmd-link" data-cmd="' + safe + '" title="Click to run">' + safe + '</span>';
      }
    });
    html += '<p>' + buf + '</p>';
  });
  return html;
}'''
# Only replace if the old body still has the old (unsafe) inline-link pattern
if os.path.exists('public/index.html'):
    _c = read('public/index.html')
    if 'data-path=\\"' in _c or "data-path='" in _c:
        if 'escAttr(seg.v)' in _c:
            print('  ⊘ B5  renderChatContent: already applied'); STATS['skip'] += 1
        else:
            replace_top_level_fn('public/index.html', 'renderChatContent', NEW_RCC,
                                 'B5  renderChatContent — safe attribute escaping')
    else:
        print('  ⊘ B5  renderChatContent: inline-link pattern not present'); STATS['skip'] += 1
else:
    print('  ✗ B5  public/index.html missing'); STATS['fail'] += 1

# B6 — remove the FIRST promptDialog (three-arg version). Keep the opts-object one.
if os.path.exists('public/index.html'):
    _c = read('public/index.html')
    matches = list(re.finditer(r'^function promptDialog\s*\(', _c, re.MULTILINE))
    if len(matches) >= 2:
        first = matches[0]
        # Sanity-check: first one should take (title, placeholder, defVal)
        snippet = _c[first.start():first.start()+90]
        if 'title' in snippet and ('placeholder' in snippet or 'defVal' in snippet):
            end = re.compile(r'^\}', re.MULTILINE).search(_c, first.start())
            if end:
                _c = _c[:first.start()] + _c[end.end():]
                write('public/index.html', _c)
                print('  ✓ B6  removed duplicate promptDialog')
                STATS['ok'] += 1
            else:
                print('  ✗ B6  could not find closing brace'); STATS['fail'] += 1
        else:
            print('  ⊘ B6  first promptDialog is not the 3-arg version; skipping'); STATS['skip'] += 1
    elif len(matches) == 1:
        print('  ⊘ B6  only one promptDialog present'); STATS['skip'] += 1
    else:
        print('  ✗ B6  promptDialog not found'); STATS['fail'] += 1
else:
    print('  ✗ B6  public/index.html missing'); STATS['fail'] += 1

patch('public/index.html',
"""  try { checkBackend(); setInterval(checkBackend, 8000); } catch (e) { console.log('checkBackend fail', e); }""",
"""  try { checkBackend(); setInterval(checkBackend, 8000); } catch (e) { console.log('checkBackend fail', e); }
  // Warn once if the server has no DeepSeek key — the chat path needs it
  fetch(API + '/api/version').then(function(r) { return r.json(); }).then(function(d) {
    var local = localStorage.getItem('ds_key');
    var serverHas = (d.providersConfigured || []).indexOf('deepseek_key') !== -1;
    if (local && !serverHas) {
      console.warn('[DS] Key is in localStorage but not on the server — chat will 400. ' +
                   'Click "Test key" in Setup to push it server-side.');
      toast('Chat key not synced — open Setup → Test key', 'warn');
    }
  }).catch(function() {});""",
'B7  startup check for key/server sync')

patch('public/index.html',
"""            Your key is stored only in this browser's localStorage. It never leaves your device except to call the DeepSeek API directly from your phone.""",
"""            Your key is stored in this browser's localStorage <b>and</b> on your local backend
            (<code>~/.deepseek-secrets.json</code>, mode 0600), because the streaming chat path
            runs through the backend. It is never sent anywhere except <code>api.deepseek.com</code>.""",
'B8  API-key panel wording fix')

# ════════════════════════════════════════════════════════════════════
# C. install.sh
# ════════════════════════════════════════════════════════════════════
print()
print('C. install.sh')

# C1 — add PORT variable
patch('install.sh',
'''BIN_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
UPDATE_ONLY=0''',
'''BIN_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
PORT="${DS_PORT:-3001}"
UPDATE_ONLY=0''',
'C1  add PORT variable')

# C2 — replace all 127.0.0.1:3002 with 127.0.0.1:${PORT}
if os.path.exists('install.sh'):
    _c = read('install.sh')
    n = _c.count('127.0.0.1:3002')
    if n > 0:
        _c = _c.replace('127.0.0.1:3002', '127.0.0.1:${PORT}')
        write('install.sh', _c)
        print(f'  ✓ C2  replaced {n} hard-coded port(s)')
        STATS['ok'] += 1
    else:
        print('  ⊘ C2  no 127.0.0.1:3002 found (already patched?)')
        STATS['skip'] += 1
else:
    print('  ✗ C2  install.sh missing'); STATS['fail'] += 1

# C3a — document --port in help
patch('install.sh',
'''  --dir <path>      Install directory (default: ~/projects/deepseek-editor)''',
'''  --dir <path>      Install directory (default: ~/projects/deepseek-editor)
  --port <n>        Backend port (default: 3001, env: DS_PORT)''',
'C3a --port in help text')

# C3b — handle --port in the arg loop
if os.path.exists('install.sh'):
    _c = read('install.sh')
    if '--port)' in _c:
        print('  ⊘ C3b --port arg parser: already present'); STATS['skip'] += 1
    else:
        m = re.search(r'^(\s*)(--dir\)[^\n]*\n)', _c, re.MULTILINE)
        if m:
            indent = m.group(1)
            insert = f'{indent}--port) PORT="$2"; shift 2 ;;\n'
            _c = _c[:m.start(2)] + insert + _c[m.start(2):]
            write('install.sh', _c)
            print('  ✓ C3b --port arg parser'); STATS['ok'] += 1
        else:
            print('  ✗ C3b could not find --dir) handler'); STATS['fail'] += 1
else:
    print('  ✗ C3b install.sh missing'); STATS['fail'] += 1

# C4 — re-apply fix-port-conflict.sh after write_script blocks
if os.path.exists('install.sh'):
    _c = read('install.sh')
    marker = '# Re-apply scoped-kill fix if it exists locally'
    if marker in _c:
        print('  ⊘ C4  fix-port-conflict re-apply: already present'); STATS['skip'] += 1
    else:
        # Insert right after the LAST write_script heredoc (matches until its closing EOF)
        # Find the last `write_script ` call and the next `EOF` line after it.
        last_ws = _c.rfind('write_script ds-')
        if last_ws == -1:
            print('  ✗ C4  no write_script ds- block found'); STATS['fail'] += 1
        else:
            eof_m = re.search(r'^EOF\s*$', _c[last_ws:], re.MULTILINE)
            if not eof_m:
                print('  ✗ C4  no closing EOF found after last write_script'); STATS['fail'] += 1
            else:
                insert_at = last_ws + eof_m.end()
                block = ('\n\n# Re-apply scoped-kill fix if it exists locally\n'
                         'if [ -f "$INSTALL_DIR/scripts/fix-port-conflict.sh" ]; then\n'
                         '  bash "$INSTALL_DIR/scripts/fix-port-conflict.sh" >/dev/null 2>&1 || true\n'
                         'fi')
                _c = _c[:insert_at] + block + _c[insert_at:]
                write('install.sh', _c)
                print('  ✓ C4  fix-port-conflict re-apply after install'); STATS['ok'] += 1
else:
    print('  ✗ C4  install.sh missing'); STATS['fail'] += 1

# ════════════════════════════════════════════════════════════════════
print()
print('── Summary:  {ok} applied   {skip} skipped   {fail} failed'.format(**STATS))
sys.exit(0 if STATS['fail'] == 0 else 1)
PYEOF

echo
if [ $? -eq 0 ]; then
  echo "✓ All patches applied cleanly."
else
  echo "⚠  Some patches did not match — review the ✗ lines above and apply manually."
fi
echo
echo "Next steps:"
echo "  git diff --stat"
echo "  git add server.js public/index.html install.sh"
echo "  git commit -m 'fix: surface provider errors, save key server-side, correct install.sh ports, fix XSS in chat links'"
