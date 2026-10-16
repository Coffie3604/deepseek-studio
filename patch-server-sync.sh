#!/data/data/com.termux/files/usr/bin/bash
# patch-server-sync.sh — GitHub sync + hardening for server.js
set -e

REPO="${1:-$HOME/projects/deepseek-editor-sandbox}"
cd "$REPO" || { echo "✗ No such directory: $REPO"; exit 1; }

BK=".patch-backup/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"
cp server.js "$BK/server.js"
echo "── Backup: $BK/server.js"
echo "── Patching: $(pwd)"
echo

python3 <<'PYEOF'
import os, sys

STATS = {'ok':0, 'skip':0, 'fail':0}

def read(p): return open(p, 'r', encoding='utf-8').read()
def write(p, s): open(p, 'w', encoding='utf-8').write(s)

def patch(old, new, label):
    c = read('server.js')
    if old not in c:
        probe = new.strip().splitlines()[0] if new.strip() else None
        if probe and probe in c:
            print(f'  ⊘ {label}: already applied'); STATS['skip'] += 1; return True
        print(f'  ✗ {label}: pattern not found'); STATS['fail'] += 1; return False
    write('server.js', c.replace(old, new, 1))
    print(f'  ✓ {label}'); STATS['ok'] += 1; return True

# ────────────────────────────────────────────────────────────────────
# 1. Askpass helper — proper username/password separation
# ────────────────────────────────────────────────────────────────────
patch(
'''try {
    fs.writeFileSync(ASKPASS_HELPER,
        '#!/data/data/com.termux/files/usr/bin/sh\\n' +
        'printf "%s\\\\n" "${GIT_ASKPASS_TOKEN:-}"\\n', { mode: 0o700 });
    fs.chmodSync(ASKPASS_HELPER, 0o700);
} catch (_) {}''',
'''try {
    // Git asks for username first, then password. Reply with a stable
    // username for token schemes ("x-access-token" is what GitHub wants
    // for PAT / fine-grained tokens) and the actual token for the
    // password prompt. Both are provided via env so nothing lands on disk.
    fs.writeFileSync(ASKPASS_HELPER,
        '#!/data/data/com.termux/files/usr/bin/sh\\n' +
        'case "$1" in\\n' +
        '  *[Uu]sername*) printf "%s\\\\n" "${GIT_ASKPASS_USER:-x-access-token}" ;;\\n' +
        '  *[Pp]assword*) printf "%s\\\\n" "${GIT_ASKPASS_TOKEN:-}" ;;\\n' +
        '  *) printf "%s\\\\n" "${GIT_ASKPASS_TOKEN:-}" ;;\\n' +
        'esac\\n', { mode: 0o700 });
    fs.chmodSync(ASKPASS_HELPER, 0o700);
} catch (_) {}''',
'1  askpass helper — split username / password')

# ────────────────────────────────────────────────────────────────────
# 2. gitLegacy — export GIT_ASKPASS_USER
# ────────────────────────────────────────────────────────────────────
patch(
'''    if (opts.token) {
        env.GIT_ASKPASS = ASKPASS_HELPER;
        env.GIT_ASKPASS_TOKEN = opts.token;
    } else {
        env.GIT_ASKPASS = 'echo';
    }''',
'''    if (opts.token) {
        env.GIT_ASKPASS = ASKPASS_HELPER;
        env.GIT_ASKPASS_TOKEN = opts.token;
        env.GIT_ASKPASS_USER = opts.user || 'x-access-token';
    } else {
        env.GIT_ASKPASS = 'echo';
    }''',
'2  gitLegacy — export GIT_ASKPASS_USER')

# ────────────────────────────────────────────────────────────────────
# 3. getGit — same treatment
# ────────────────────────────────────────────────────────────────────
patch(
'''    return g.env({
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: token ? ASKPASS_HELPER : 'echo',
        ...(token ? { GIT_ASKPASS_TOKEN: token } : {}),
    });''',
'''    return g.env({
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: token ? ASKPASS_HELPER : 'echo',
        ...(token ? { GIT_ASKPASS_TOKEN: token, GIT_ASKPASS_USER: 'x-access-token' } : {}),
    });''',
'3  getGit — export GIT_ASKPASS_USER')

# ────────────────────────────────────────────────────────────────────
# 4. clone — actually apply env() to the instance (bug fix)
# ────────────────────────────────────────────────────────────────────
patch(
'''        if (simpleGitFactory) {
            const g = simpleGitFactory({ baseDir: WORKSPACE });
            if (opts.token) g.env({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: ASKPASS_HELPER, GIT_ASKPASS_TOKEN: opts.token });
            else g.env({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' });
            await g.clone(url, name, ['--progress']);
            return res.json(gitOk({ stdout: 'Cloned into ' + name, dir: name }));
        }''',
'''        if (simpleGitFactory) {
            // Note: simple-git's .env() returns a *new* instance. The old code
            // called it and threw the result away, so the token never reached
            // the clone. Reassign it.
            let g = simpleGitFactory({ baseDir: WORKSPACE });
            g = opts.token
                ? g.env({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: ASKPASS_HELPER, GIT_ASKPASS_TOKEN: opts.token, GIT_ASKPASS_USER: 'x-access-token' })
                : g.env({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' });
            await g.clone(url, name, ['--progress']);
            return res.json(gitOk({ stdout: 'Cloned into ' + name, dir: name }));
        }''',
'4  clone — apply env() to the instance (token was discarded)')

# ────────────────────────────────────────────────────────────────────
# 5. Placeholder regex — broader
# ────────────────────────────────────────────────────────────────────
patch(
'''    // Reject obvious placeholder text before it becomes a silent auth failure
    if (name.endsWith('_key') && /^sk-(paste|your|xxx|abc|test)/i.test(value.trim())) {
        return res.status(400).json({ error: 'Looks like a placeholder — paste the real key' });
    }''',
'''    // Reject obvious placeholder text before it becomes a silent auth failure.
    // Covers the specific case from early docs (sk-paste-it-here) plus the
    // usual shapes of doc placeholders.
    if (name.endsWith('_key')) {
        const v = value.trim();
        const looksLikePlaceholder =
            /^sk-(paste|your|xxx|abc|test|foo|bar|placeholder|example|insert|enter|add)/i.test(v) ||
            /(paste-it-here|paste-your|placeholder|example-key|replace-me|change-me|insert-key|your-key-here)/i.test(v) ||
            /-here$/i.test(v);
        if (looksLikePlaceholder) {
            return res.status(400).json({ error: 'Looks like a placeholder — paste the real key' });
        }
    }''',
'5  placeholder regex — broader coverage')

# ────────────────────────────────────────────────────────────────────
# 6. LONG_RUNNING — include new endpoints
# ────────────────────────────────────────────────────────────────────
patch(
'''const LONG_RUNNING = new Set([
    '/api/git/clone', '/api/git/push', '/api/git/pull', '/api/git/pull/rebase',
    '/api/git/fetch', '/api/exec', '/api/ai/chat', '/api/ai/tool-call',
    '/api/backup/restore', '/api/deploy/build', '/api/deploy/download',
    '/api/deploy/upload-to-play', '/api/deploy/install-tools', '/api/compile',
]);''',
'''const LONG_RUNNING = new Set([
    '/api/git/clone', '/api/git/push', '/api/git/pull', '/api/git/pull/rebase',
    '/api/git/fetch', '/api/git/sync', '/api/git/status/upstream',
    '/api/exec', '/api/ai/chat', '/api/ai/tool-call',
    '/api/backup/restore', '/api/deploy/build', '/api/deploy/download',
    '/api/deploy/upload-to-play', '/api/deploy/install-tools', '/api/compile',
]);''',
'6  LONG_RUNNING — include new sync endpoints')

# ────────────────────────────────────────────────────────────────────
# 7. /api/git/push — full rewrite: auto-upstream, always push
# ────────────────────────────────────────────────────────────────────
OLD_PUSH = '''app.post('/api/git/push', async (req, res) => {
    const { cwd, message, commitOnly } = req.body || {};
    const rel = cwd || '';
    const msg = String(message || 'Update').slice(0, 2000);
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            await g.add(['-A']);
            let commitOut = '', commitErr = '';
            let committed = false;
            try { const c = await g.commit(msg); commitOut = c.commit || 'committed'; committed = true; }
            catch (e) {
                commitErr = redact(e.message || String(e));
                if (!/nothing to commit|no changes added|no changes/i.test(commitErr)) return res.json({ code: 1, ok: false, stdout: commitOut, stderr: commitErr });
            }
            if (commitOnly) return res.json(gitOk({ stdout: commitOut, stderr: commitErr }));
            // Working tree was already clean — don't push unrelated pre-existing commits
            if (!committed) return res.json(gitOk({ stdout: commitOut || 'Nothing to commit', stderr: commitErr }));
            const push = await g.push();
            const pushOut = JSON.stringify(push && push.pushed ? push.pushed : push || {});
            return res.json(gitOk({ stdout: commitOut + '\\n' + pushOut, stderr: commitErr }));
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        await gitLegacy(workdir, ['add', '-A']);
        const commit = await gitLegacy(workdir, ['commit', '-m', msg], { timeout: 60000 });
        if (commitOnly) return res.json({ code: commit.code, ok: !commit.failed, stdout: commit.stdout, stderr: commit.stderr });
        if (commit.failed && !/nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)) return res.json({ code: commit.code, ok: false, stdout: commit.stdout, stderr: commit.stderr });
        const push = await gitLegacy(workdir, ['push'], { timeout: 180000, token: ghToken() || undefined });
        res.json({ code: push.code, ok: !push.failed, stdout: commit.stdout + push.stdout, stderr: commit.stderr + push.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});'''

NEW_PUSH = '''app.post('/api/git/push', async (req, res) => {
    const { cwd, message, commitOnly, setUpstream } = req.body || {};
    const rel = cwd || '';
    const msg = String(message || 'Update').slice(0, 2000);
    const token = ghToken() || undefined;
    try {
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        if (!fs.existsSync(path.join(workdir, '.git'))) {
            return res.json({ code: 1, ok: false, stdout: '', stderr: 'Not a git repository', committed: false });
        }

        /* 1. Stage everything and attempt a commit */
        let commitOut = '', commitErr = '', committed = false, branch = '';

        if (simpleGitFactory) {
            const g = getGit(rel);
            try { branch = (await g.branchLocal()).current || ''; } catch (_) {}
            await g.add(['-A']);
            try {
                const c = await g.commit(msg);
                commitOut = c.commit || 'committed';
                committed = true;
            } catch (e) {
                commitErr = redact(e.message || String(e));
                if (!/nothing to commit|no changes added|no changes|working tree clean/i.test(commitErr)) {
                    return res.json({ code: 1, ok: false, stdout: commitOut, stderr: commitErr, committed: false, branch });
                }
            }
        } else {
            const b = await gitLegacy(workdir, ['branch', '--show-current'], { token });
            branch = (b.stdout || '').trim();
            await gitLegacy(workdir, ['add', '-A'], { token });
            const commit = await gitLegacy(workdir, ['commit', '-m', msg], { timeout: 60000, token });
            commitOut = commit.stdout || '';
            commitErr = commit.stderr || '';
            committed = !commit.failed;
            if (commit.failed && !/nothing to commit|no changes added|no changes|working tree clean/i.test(commitOut + commitErr)) {
                return res.json({ code: commit.code, ok: false, stdout: commitOut, stderr: commitErr, committed: false, branch });
            }
        }

        if (commitOnly) {
            return res.json(gitOk({
                stdout: commitOut || (committed ? 'committed' : 'Nothing to commit'),
                stderr: commitErr,
                committed, branch,
            }));
        }

        /* 2. Determine origin + upstream state */
        let hasOrigin = false, hasUpstream = false;
        if (simpleGitFactory) {
            const g = getGit(rel);
            try { hasOrigin = (await g.getRemotes(true)).some((r) => r.name === 'origin'); } catch (_) {}
            if (hasOrigin && branch) {
                try { await g.raw(['rev-parse', '--abbrev-ref', branch + '@{upstream}']); hasUpstream = true; } catch (_) {}
            }
        } else {
            hasOrigin = /(^|\\s)origin(\\s|$)/.test((await gitLegacy(workdir, ['remote', '-v'], { token })).stdout);
            if (hasOrigin && branch) {
                const u = await gitLegacy(workdir, ['rev-parse', '--abbrev-ref', branch + '@{upstream}'], { token });
                hasUpstream = !u.failed;
            }
        }

        if (!hasOrigin) {
            return res.json(gitOk({
                stdout: commitOut || '(nothing to commit)',
                stderr: commitErr,
                committed, branch,
                pushed: false, reason: 'no-remote',
                hint: 'Add a remote with /api/git/set-remote, or create a GitHub repo first.',
            }));
        }
        if (!branch) {
            return res.json({ code: 1, ok: false, stdout: commitOut, stderr: 'Detached HEAD — cannot push.', committed, branch: '' });
        }

        /* 3. Push — set upstream on first push (or when caller asks) */
        const wantSetUpstream = !hasUpstream || setUpstream === true;
        let pushOut = '', pushErr = '';
        if (simpleGitFactory) {
            const g = getGit(rel);
            try {
                const push = wantSetUpstream
                    ? await g.push(['-u', 'origin', branch])
                    : await g.push();
                pushOut = JSON.stringify(push && push.pushed ? push.pushed : push || {});
            } catch (e) {
                pushErr = redact(e.message || String(e));
                return res.json({ code: 1, ok: false, stdout: commitOut, stderr: pushErr, committed, pushed: false, branch });
            }
        } else {
            const args = wantSetUpstream ? ['push', '-u', 'origin', branch] : ['push'];
            const push = await gitLegacy(workdir, args, { timeout: 180000, token });
            pushOut = push.stdout || '';
            pushErr = push.stderr || '';
            if (push.failed) {
                return res.json({ code: push.code, ok: false, stdout: commitOut + pushOut, stderr: pushErr, committed, pushed: false, branch });
            }
        }

        res.json(gitOk({
            stdout: (commitOut ? commitOut + '\\n' : '') + pushOut,
            stderr: commitErr + pushErr,
            committed, pushed: true, branch,
            setUpstream: wantSetUpstream,
        }));
    } catch (e) { res.status(500).json(gitErr(e)); }
});'''

patch(OLD_PUSH, NEW_PUSH, '7  /api/git/push — auto-upstream + always-push')

# ────────────────────────────────────────────────────────────────────
# 8. New endpoints: upstream status, remote-info, smart sync
#    Inserted right after /api/git/undo
# ────────────────────────────────────────────────────────────────────
UNDO_ANCHOR = '''app.post('/api/git/undo', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) { const g = getGit(rel); await g.raw(['reset', '--soft', 'HEAD~1']); return res.json(gitOk({ stdout: 'reverted last commit (soft)' })); }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['reset', '--soft', 'HEAD~1'], { timeout: 30000 });
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});'''

NEW_ENDPOINTS = UNDO_ANCHOR + '''

/* ────────────────────────────────────────────────────────────────────
   /api/git/status/upstream — how far ahead/behind of origin we are.
   Optionally fetches first (default true). Returns a single-word "state"
   so the UI can drive the sync button's label without extra logic.
   ──────────────────────────────────────────────────────────────────── */
app.post('/api/git/status/upstream', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    const doFetch = (req.body || {}).fetch !== false;
    const token = ghToken() || undefined;
    try {
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        if (!fs.existsSync(path.join(workdir, '.git'))) {
            return res.json({ ok: true, isRepo: false, state: 'not-a-repo' });
        }

        let fetchError = null;
        if (doFetch && simpleGitFactory) {
            try { await getGit(rel).fetch(['--quiet']); } catch (e) { fetchError = redact(e.message || String(e)); }
        } else if (doFetch) {
            const fr = await gitLegacy(workdir, ['fetch', '--quiet'], { timeout: 60000, token });
            if (fr.failed) fetchError = redact(fr.stderr || fr.stdout);
        }

        let branch = '', upstream = '', ahead = 0, behind = 0;
        let hasRemote = false, hasUpstream = false;

        if (simpleGitFactory) {
            const g = getGit(rel);
            try { branch = (await g.branchLocal()).current || ''; } catch (_) {}
            try { hasRemote = (await g.getRemotes(true)).some((r) => r.name === 'origin'); } catch (_) {}
            if (branch && hasRemote) {
                try {
                    upstream = (await g.raw(['rev-parse', '--abbrev-ref', branch + '@{upstream}'])).trim();
                    hasUpstream = true;
                } catch (_) {}
            }
            if (hasUpstream) {
                try {
                    const counts = (await g.raw(['rev-list', '--left-right', '--count', branch + '...' + upstream])).trim();
                    const parts = counts.split(/\\s+/).map((x) => parseInt(x, 10) || 0);
                    ahead = parts[0] || 0; behind = parts[1] || 0;
                } catch (_) {}
            }
        } else {
            branch = (await gitLegacy(workdir, ['branch', '--show-current'], { token })).stdout.trim();
            hasRemote = /(^|\\s)origin(\\s|$)/.test((await gitLegacy(workdir, ['remote', '-v'], { token })).stdout);
            if (branch && hasRemote) {
                const u = await gitLegacy(workdir, ['rev-parse', '--abbrev-ref', branch + '@{upstream}'], { token });
                if (!u.failed) { upstream = (u.stdout || '').trim(); hasUpstream = true; }
            }
            if (hasUpstream) {
                const counts = (await gitLegacy(workdir, ['rev-list', '--left-right', '--count', branch + '...' + upstream], { token })).stdout.trim();
                const parts = counts.split(/\\s+/).map((x) => parseInt(x, 10) || 0);
                ahead = parts[0] || 0; behind = parts[1] || 0;
            }
        }

        let dirty = false;
        if (simpleGitFactory) {
            try { dirty = (await getGit(rel).status()).files.length > 0; } catch (_) {}
        } else {
            dirty = (await gitLegacy(workdir, ['status', '--porcelain'], { token })).stdout.trim().length > 0;
        }

        const state = !hasRemote ? 'no-remote'
            : !hasUpstream ? 'no-upstream'
            : (ahead > 0 && behind > 0) ? 'diverged'
            : ahead > 0 ? 'ahead'
            : behind > 0 ? 'behind'
            : 'up-to-date';

        res.json({ ok: true, isRepo: true, branch, upstream, ahead, behind, dirty, hasRemote, hasUpstream, state, fetchError });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

/* ────────────────────────────────────────────────────────────────────
   /api/git/remote-info — parse the origin URL for display.
   Detects GitHub / GitLab / Bitbucket, HTTPS vs SSH, and returns a
   clickable web URL when the host is recognised.
   ──────────────────────────────────────────────────────────────────── */
app.post('/api/git/remote-info', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    const token = ghToken() || undefined;
    try {
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['remote', '-v'], { token });
        const lines = r.stdout.split('\\n').filter(Boolean);
        const map = {};
        for (const line of lines) {
            const parts = line.split(/\\s+/);
            if (parts.length < 3) continue;
            const [name, url, type] = parts;
            if (!map[name]) map[name] = { name, fetchUrl: '', pushUrl: '' };
            if (type === '(fetch)') map[name].fetchUrl = url;
            if (type === '(push)')  map[name].pushUrl  = url;
        }
        const out = Object.values(map).map((r) => {
            const url = r.pushUrl || r.fetchUrl || '';
            let provider = 'other', webUrl = null;
            const m = url.match(/github\\.com[:/]+([^/]+)\\/([^/]+?)(?:\\.git)?$/i);
            if (m) { provider = 'github'; webUrl = 'https://github.com/' + m[1] + '/' + m[2]; }
            else if (/gitlab\\.com[:/]/i.test(url)) provider = 'gitlab';
            else if (/bitbucket\\.org[:/]/i.test(url)) provider = 'bitbucket';
            const protocol = /^https?:\\/\\//i.test(url) ? 'https'
                : /^git@/i.test(url) ? 'ssh'
                : /^ssh:\\/\\//i.test(url) ? 'ssh'
                : /^git:\\/\\//i.test(url) ? 'git'
                : 'other';
            return { name: r.name, fetchUrl: r.fetchUrl, pushUrl: r.pushUrl, provider, protocol, webUrl };
        });
        res.json({ remotes: out });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

/* ────────────────────────────────────────────────────────────────────
   POST /api/git/sync — smart two-way sync with origin.
   Body: { cwd, strategy?: 'auto'|'rebase'|'merge', allowDirty?: boolean }

     1. Refuse if the working tree is dirty (unless allowDirty:true).
     2. Fetch origin.
     3. Compute ahead/behind.
     4. Only behind → pull --ff-only.
     5. Only ahead  → push.
     6. Diverged    → if strategy == 'auto', return the diverged state
                      and let the caller choose. Otherwise run
                      `pull --rebase` (rebase) or `pull --no-rebase` (merge),
                      and push afterwards for rebase.
     7. Report the final state.
   ──────────────────────────────────────────────────────────────────── */
app.post('/api/git/sync', async (req, res) => {
    const body = req.body || {};
    const rel = body.cwd || '';
    const strategy = String(body.strategy || 'auto').toLowerCase();
    const allowDirty = body.allowDirty === true;
    const token = ghToken() || undefined;
    const steps = [];

    try {
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        if (!fs.existsSync(path.join(workdir, '.git'))) {
            return res.json({ ok: false, state: 'not-a-repo', error: 'Not a git repository', steps });
        }

        /* 0. Dirty check */
        const dirtyProbe = await gitLegacy(workdir, ['status', '--porcelain'], { timeout: 15000, token });
        const dirty = dirtyProbe.stdout.trim().length > 0;
        if (dirty && !allowDirty) {
            return res.json({
                ok: false, state: 'dirty', dirty: true,
                error: 'Working tree has uncommitted changes. Commit or stash first.',
                steps,
            });
        }

        /* 1. Fetch */
        const fetched = await gitLegacy(workdir, ['fetch', '--quiet', 'origin'], { timeout: 120000, token });
        steps.push({ step: 'fetch', ok: !fetched.failed, detail: fetched.failed ? redact(fetched.stderr || fetched.stdout) : 'ok' });
        if (fetched.failed) {
            return res.json({ ok: false, state: 'error', error: 'Fetch failed: ' + redact(fetched.stderr || fetched.stdout), steps });
        }

        /* 2. Branch + upstream + counts */
        const branch = (await gitLegacy(workdir, ['branch', '--show-current'], { token })).stdout.trim();
        if (!branch) return res.json({ ok: false, state: 'detached', error: 'Detached HEAD', steps });

        const up = await gitLegacy(workdir, ['rev-parse', '--abbrev-ref', branch + '@{upstream}'], { token });
        if (up.failed) {
            const ls = await gitLegacy(workdir, ['ls-remote', '--heads', 'origin', branch], { token });
            if (/refs\\/heads\\//.test(ls.stdout)) {
                await gitLegacy(workdir, ['branch', '--set-upstream-to', 'origin/' + branch, branch], { token });
                steps.push({ step: 'set-upstream', ok: true, detail: 'origin/' + branch });
            } else {
                const push = await gitLegacy(workdir, ['push', '-u', 'origin', branch], { timeout: 180000, token });
                steps.push({ step: 'push-initial', ok: !push.failed, detail: push.failed ? redact(push.stderr || push.stdout) : 'ok' });
                return res.json({
                    ok: !push.failed,
                    state: push.failed ? 'error' : 'pushed-initial',
                    branch, ahead: 0, behind: 0, steps,
                    output: redact((push.stdout || '') + (push.stderr ? '\\n' + push.stderr : '')),
                });
            }
        }
        const upstream = (await gitLegacy(workdir, ['rev-parse', '--abbrev-ref', branch + '@{upstream}'], { token })).stdout.trim();
        const counts = (await gitLegacy(workdir, ['rev-list', '--left-right', '--count', branch + '...' + upstream], { token })).stdout.trim();
        const [ahead, behind] = counts.split(/\\s+/).map((x) => parseInt(x, 10) || 0);
        steps.push({ step: 'compare', ok: true, detail: 'ahead ' + ahead + ', behind ' + behind });

        /* 3. Up to date */
        if (ahead === 0 && behind === 0) {
            return res.json({ ok: true, state: 'up-to-date', branch, upstream, ahead, behind, steps });
        }

        /* 4. Behind only — fast-forward pull */
        if (behind > 0 && ahead === 0) {
            const pull = await gitLegacy(workdir, ['pull', '--ff-only', '--no-edit'], { timeout: 180000, token });
            steps.push({ step: 'pull-ff', ok: !pull.failed, detail: pull.failed ? redact(pull.stderr || pull.stdout) : 'ok' });
            return res.json({
                ok: !pull.failed,
                state: pull.failed ? 'error' : 'pulled',
                branch, upstream, ahead: 0, behind, steps,
                output: redact((pull.stdout || '') + (pull.stderr ? '\\n' + pull.stderr : '')),
            });
        }

        /* 5. Ahead only — push */
        if (ahead > 0 && behind === 0) {
            const push = await gitLegacy(workdir, ['push'], { timeout: 180000, token });
            steps.push({ step: 'push', ok: !push.failed, detail: push.failed ? redact(push.stderr || push.stdout) : 'ok' });
            return res.json({
                ok: !push.failed,
                state: push.failed ? 'error' : 'pushed',
                branch, upstream, ahead, behind: 0, steps,
                output: redact((push.stdout || '') + (push.stderr ? '\\n' + push.stderr : '')),
            });
        }

        /* 6. Diverged */
        if (strategy === 'auto') {
            return res.json({
                ok: false, state: 'diverged',
                error: 'Local and remote have diverged. Choose a strategy: "rebase" or "merge".',
                branch, upstream, ahead, behind, steps,
            });
        }
        const pullArgs = strategy === 'rebase'
            ? ['pull', '--rebase', '--no-edit']
            : ['pull', '--no-rebase', '--no-edit'];
        const pull = await gitLegacy(workdir, pullArgs, { timeout: 180000, token });
        const conflicted = /CONFLICT|Automatic merge failed|needs merge/i.test(pull.stdout + pull.stderr);
        steps.push({ step: 'pull-' + strategy, ok: !pull.failed, detail: pull.failed ? redact(pull.stderr || pull.stdout) : 'ok', conflicted });
        if (pull.failed) {
            return res.json({
                ok: false, state: conflicted ? 'conflict' : 'error', conflicted,
                branch, upstream, ahead, behind, steps,
                output: redact((pull.stdout || '') + (pull.stderr ? '\\n' + pull.stderr : '')),
            });
        }
        if (strategy === 'rebase') {
            const push = await gitLegacy(workdir, ['push'], { timeout: 180000, token });
            steps.push({ step: 'push-after-rebase', ok: !push.failed, detail: push.failed ? redact(push.stderr || push.stdout) : 'ok' });
            return res.json({
                ok: !push.failed, state: push.failed ? 'error' : 'synced',
                branch, upstream, ahead: 0, behind: 0, steps,
                output: redact((pull.stdout || '') + '\\n' + (push.stdout || '') + (push.stderr ? '\\n' + push.stderr : '')),
            });
        }
        return res.json({
            ok: true, state: 'synced', branch, upstream, ahead: 0, behind: 0, steps,
            output: redact(pull.stdout || ''),
        });
    } catch (e) { res.status(500).json({ error: redact(e.message), steps }); }
});'''

patch(UNDO_ANCHOR, NEW_ENDPOINTS, '8  new endpoints: status/upstream, remote-info, sync')

# ────────────────────────────────────────────────────────────────────
print()
print('── Summary: {ok} applied · {skip} skipped · {fail} failed'.format(**STATS))
sys.exit(0 if STATS['fail'] == 0 else 1)
PYEOF

echo
if [ $? -eq 0 ]; then
  echo "✓ All patches applied cleanly."
else
  echo "⚠  Some patches did not match — review the ✗ lines above."
fi

echo
echo "Next steps:"
echo "  node -c server.js                       # syntax check"
echo "  node check-connectivity.js              # verify routes"
echo "  git add server.js patch-server-sync.sh"
echo "  git commit -m 'feat(git): proper GitHub sync (auto-upstream, ahead/behind, smart sync)'"
