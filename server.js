#!/usr/bin/env node
'use strict';

const express = require('express');
const { execFile, exec } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

let pty = null;
try { pty = require('node-pty'); }
catch (_) { console.warn('[deps] node-pty missing — pipe fallback'); }

const PKG_VERSION = '3.0.0';
const PORT = parseInt(process.env.PORT, 10) || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const BIND_ALL = HOST === '0.0.0.0' || HOST === '::';
const HOME = process.env.HOME || os.homedir();
const WORKSPACE = path.resolve(process.env.DS_WORKSPACE || path.join(HOME, 'projects'));
// Additional browsable roots. DS_ROOTS is a colon-separated list of absolute paths.
// DS_ALLOW_ANY_ROOT=1 lifts the sandbox entirely (use only on a trusted machine).
const ALLOW_ANY_ROOT = /^(1|true|yes)$/i.test(String(process.env.DS_ALLOW_ANY_ROOT || ''));
const EXTRA_ROOTS = String(process.env.DS_ROOTS || '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
const ROOTS = Array.from(new Set([WORKSPACE, ...EXTRA_ROOTS]));
const SECRETS_FILE = path.join(HOME, '.deepseek-secrets.json');
const ASKPASS_HELPER = path.join(HOME, '.deepseek-git-askpass.sh');
const TERMUX_BASH = '/data/data/com.termux/files/usr/bin/bash';

try { fs.mkdirSync(WORKSPACE, { recursive: true }); } catch (_) {}

try {
    fs.writeFileSync(ASKPASS_HELPER,
        '#!/data/data/com.termux/files/usr/bin/sh\n' +
        'case "$1" in\n' +
        '  *[Uu]sername*) printf "%s\\n" "${GIT_ASKPASS_USER:-x-access-token}" ;;\n' +
        '  *) printf "%s\\n" "${GIT_ASKPASS_TOKEN:-}" ;;\n' +
        'esac\n', { mode: 0o700 });
    fs.chmodSync(ASKPASS_HELPER, 0o700);
} catch (_) {}

const SECRET_NAMES = ['deepseek_key', 'openai_key', 'github_token', 'github_client_id'];
function loadSecrets() {
    try { return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) || {}; }
    catch (_) { return {}; }
}
let secrets = loadSecrets();
function saveSecrets() {
    try {
        fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
        fs.chmodSync(SECRETS_FILE, 0o600);
    } catch (err) { console.error('[secrets] save failed:', err.message); }
}
const ghToken = () => String(secrets.github_token || '').trim();

// ── GitHub token discovery ────────────────────────────────────────────────
// The token can come from several places. We check them in priority order so
// a token already present on the machine (gh CLI, env, git credential store)
// works without the user re-entering it in Settings.
const GH_TOKEN_SOURCES = [
    { id: 'settings', label: 'Settings (saved)', get: () => ghToken() },
    { id: 'env', label: 'Environment', get: () => String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim() },
    { id: 'gh-cli', label: 'gh CLI', get: () => {
        try {
            const hosts = path.join(HOME, '.config', 'gh', 'hosts.yml');
            const txt = fs.readFileSync(hosts, 'utf8');
            const m = txt.match(/oauth_token:\s*(\S+)/);
            return m ? m[1].trim() : '';
        } catch (_) { return ''; }
    } },
    { id: 'git-credential', label: 'git credential store', get: () => {
        try {
            const cfg = path.join(HOME, '.git-credentials');
            const txt = fs.readFileSync(cfg, 'utf8');
            const m = txt.match(/https:\/\/([^:@\s]+):([^@\s]+)@github\.com/);
            return m ? decodeURIComponent(m[2]).trim() : '';
        } catch (_) { return ''; }
    } },
];
function resolveGhToken() {
    for (const src of GH_TOKEN_SOURCES) {
        let v = '';
        try { v = src.get() || ''; } catch (_) { v = ''; }
        if (v) return { token: v, source: src.id, label: src.label };
    }
    return { token: '', source: null, label: null };
}
// Effective token used for git + API. Settings wins, then auto-discovery.
function effectiveGhToken() { return resolveGhToken().token; }
function ghTokenSource() { return resolveGhToken().source; }

const GH_TOKEN_RE = /^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{10,}$/;
function looksLikeGhToken(v) { return GH_TOKEN_RE.test(String(v || '').trim()); }

// Classify a git remote URL. SSH remotes cannot use a token, which is the
// single most common reason a "valid token" still fails to push.
function remoteKind(url) {
    const s = String(url || '').trim();
    if (!s) return null;
    if (/^git@[^:]+:/.test(s) || /^ssh:\/\//i.test(s)) return 'ssh';
    if (/^https?:\/\//i.test(s)) return 'https';
    if (/^git:\/\//i.test(s)) return 'git';
    return 'other';
}

// Convert an SSH remote to its HTTPS equivalent so token auth can be used.
// Handles both scp-style (git@host:owner/repo) and ssh:// URL forms.
function normalizeRemote(url) {
    let s = String(url || '').trim();
    if (!s) return s;
    const scp = s.match(/^git@([^:]+):(.+)$/);
    if (scp) s = `https://${scp[1]}/${scp[2]}`;
    // ssh://git@github.com/owner/repo(.git)  →  https://github.com/owner/repo
    s = s.replace(/^ssh:\/\/(?:git@)?([^/]+)\//i, 'https://$1/');
    // git://github.com/owner/repo → https://github.com/owner/repo
    s = s.replace(/^git:\/\/(?:git@)?([^/]+)\//i, 'https://$1/');
    return s.replace(/\.git$/, '');
}

// Extract "owner/repo" from any GitHub remote form, or null if not GitHub.
function githubRepoSlug(url) {
    const https = normalizeRemote(url);
    const m = String(https || '').match(/^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    return m ? `${m[1]}/${m[2]}` : null;
}

// True when the remote points at github.com in any form.
function isGithubRemote(url) {
    const s = String(url || '').trim();
    return /(^|@|\/\/)github\.com[:/]/i.test(s);
}

function redact(input) {
    let out = String(input == null ? '' : input);
    for (const v of Object.values(secrets)) {
        if (typeof v === 'string' && v.length >= 8) out = out.split(v).join('***REDACTED***');
    }
    return out
        .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '***')
        .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '***');
}

function withinBase(base, resolved) {
    const b = path.resolve(base);
    const r = path.resolve(resolved);
    return r === b || r.startsWith(b + path.sep);
}
// True when `resolved` sits inside any allowed root (or anywhere, if sandbox is off).
function withinAnyRoot(resolved) {
    if (ALLOW_ANY_ROOT) return true;
    const r = path.resolve(resolved);
    return ROOTS.some((root) => withinBase(root, r));
}
// The root that contains `resolved`, or null.
function rootOf(resolved) {
    const r = path.resolve(resolved);
    return ROOTS.find((root) => withinBase(root, r)) || null;
}
function resolvePath(rel, base) {
    if (!rel) return base || WORKSPACE;
    const s = String(rel);
    const b = base || WORKSPACE;
    const full = path.isAbsolute(s) ? path.resolve(s) : path.resolve(b, s);
    return withinAnyRoot(full) ? full : null;
}

const app = express();
app.disable('x-powered-by');

function isAllowedHost(hostHeader) {
    if (!hostHeader) return true;
    const host = String(hostHeader).split(':')[0].toLowerCase();
    if (['127.0.0.1', 'localhost', '::1', '[::1]', ''].includes(host)) return true;
    if (BIND_ALL) return true;
    const extra = String(process.env.DS_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return extra.includes(host);
}

app.use(cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        return cb(null, isAllowedHost(origin.replace(/^https?:\/\//, '').replace(/:\d+$/, '')));
    },
    credentials: false,
}));
app.use((req, res, next) => {
    if (!isAllowedHost(req.headers.host)) {
        return res.status(421).json({ error: 'Misdirected request: host not allowed' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-DeepSeek-Version', PKG_VERSION);
    next();
});
app.use(express.json({ limit: '25mb' }));
app.use((req, res, next) => {
    if (req.body && typeof req.body === 'object') {
        for (const k of ['__proto__', 'constructor', 'prototype']) {
            if (Object.prototype.hasOwnProperty.call(req.body, k)) delete req.body[k];
        }
    }
    next();
});

const aiHits = new Map();
app.use('/api/ai/', (req, res, next) => {
    const ip = req.ip || 'local';
    const now = Date.now();
    const w = aiHits.get(ip) || { count: 0, reset: now + 60000 };
    if (now > w.reset) { w.count = 0; w.reset = now + 60000; }
    w.count++;
    aiHits.set(ip, w);
    if (w.count > 120) return res.status(429).json({ error: 'Rate limited' });
    next();
});
setInterval(() => {
    const now = Date.now();
    for (const [ip, w] of aiHits) if (now > w.reset) aiHits.delete(ip);
}, 60 * 1000).unref();

const AI_PROVIDERS = {
    deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', keyName: 'deepseek_key' },
};
function providerStatus() {
    return Object.entries(AI_PROVIDERS)
        .filter(([, cfg]) => !!String(secrets[cfg.keyName] || '').trim())
        .map(([id]) => id);
}

app.get('/api/health', (_req, res) => {
    res.json({
        ok: providerStatus().length > 0, version: PKG_VERSION, ts: Date.now(),
        providers: providerStatus(), hasGitHub: !!effectiveGhToken(), ghTokenSource: ghTokenSource(), pty: !!pty,
    });
});
app.get('/api/version', (_req, res) => {
    res.json({
        version: PKG_VERSION, node: process.version, workspace: WORKSPACE,
        providers: providerStatus(), hasGitHub: !!effectiveGhToken(), ghTokenSource: ghTokenSource(), pty: !!pty,
        uptime: Math.round(process.uptime()),
    });
});

app.get('/api/secrets', (_req, res) => {
    const out = {};
    for (const name of SECRET_NAMES) {
        const v = secrets[name];
        out[name] = { configured: !!v, hint: v ? redact(v).slice(-4) : '' };
    }
    res.json(out);
});
app.post('/api/secrets', async (req, res) => {
    const { name, value } = req.body || {};
    if (!SECRET_NAMES.includes(name)) return res.status(400).json({ error: 'Unknown secret' });
    if (value == null || value === '') {
        delete secrets[name]; saveSecrets();
        return res.json({ ok: true, removed: true });
    }
    if (typeof value !== 'string' || value.length > 8000) return res.status(400).json({ error: 'Invalid value' });
    const v = value.trim();
    if (name === 'deepseek_key' && !/^sk-[A-Za-z0-9_-]{16,}$/.test(v)) return res.status(400).json({ error: 'Keys look like sk-xxxx' });
    if (name === 'github_token' && !/^(ghp_|gho_|ghu_|ghs_|github_pat_)/.test(v)) return res.status(400).json({ error: 'GitHub tokens start with ghp_ or github_pat_' });
    secrets[name] = v;
    saveSecrets();
    // Validate a GitHub token immediately so a typo/expired PAT is caught at
    // save time instead of surfacing later as a confusing push failure.
    if (name === 'github_token') {
        try {
            const r = await fetch('https://api.github.com/user', {
                headers: { Authorization: 'Bearer ' + v, Accept: 'application/vnd.github+json', 'User-Agent': 'deepseek-editor' },
            });
            if (r.ok) {
                const u = await r.json();
                const scopes = String(r.headers.get('x-oauth-scopes') || '');
                return res.json({ ok: true, name, verified: true, login: u.login, scopes });
            }
            const body = await r.json().catch(() => ({}));
            return res.json({
                ok: true, name, verified: false,
                warning: 'Saved, but GitHub rejected this token: ' + (body.message || ('HTTP ' + r.status)),
            });
        } catch (err) {
            return res.json({ ok: true, name, verified: false, warning: 'Saved, but could not reach GitHub to verify: ' + err.message });
        }
    }
    res.json({ ok: true, name });
});

// Re-check the currently stored token without changing it.
app.get('/api/github/verify', async (_req, res) => {
    const found = resolveGhToken();
    if (!found.token) return res.json({ ok: false, verdict: 'no-token', error: 'No GitHub token configured.' });
    try {
        const r = await fetch('https://api.github.com/user', {
            headers: { Authorization: 'Bearer ' + found.token, Accept: 'application/vnd.github+json', 'User-Agent': 'deepseek-editor' },
        });
        const scopes = String(r.headers.get('x-oauth-scopes') || '');
        if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            return res.json({ ok: false, verdict: 'bad-token', source: found.source, error: body.message || ('HTTP ' + r.status) });
        }
        const u = await r.json();
        const scopeList = scopes.split(',').map((s) => s.trim()).filter(Boolean);
        const canPush = scopeList.includes('repo') || scopeList.includes('public_repo') || scopeList.length === 0;
        return res.json({
            ok: true, verdict: canPush ? 'ok' : 'missing-scope',
            source: found.source, sourceLabel: found.label,
            login: u.login, scopes: scopeList,
            warning: canPush ? null : 'Token has no "repo" scope — pushes to private repos will fail.',
        });
    } catch (err) {
        return res.json({ ok: false, verdict: 'offline', error: 'Could not reach GitHub: ' + err.message });
    }
});

// One-click repair: convert an SSH origin to HTTPS so the saved token is used.
app.post('/api/github/repair-remote', async (req, res) => {
    const workdir = gitWorkdir(req.body);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    const rem = await gitCmd(workdir, ['remote', 'get-url', 'origin']);
    if (!rem.ok || !rem.stdout.trim()) return res.json({ ok: false, error: 'No "origin" remote to repair.' });
    const current = rem.stdout.trim();
    if (remoteKind(current) !== 'ssh') {
        return res.json({ ok: true, changed: false, remote: current, message: 'Remote is already HTTPS — nothing to change.' });
    }
    const next = normalizeRemote(current) + '.git';
    const set = await gitCmd(workdir, ['remote', 'set-url', 'origin', next]);
    if (!set.ok) return res.json({ ok: false, error: set.stderr || 'Failed to update remote.' });
    res.json({ ok: true, changed: true, from: current, remote: next, message: 'Remote switched to HTTPS — your token will now be used.' });
});
app.get('/api/roots', (_req, res) => {
    res.json({
        workspace: WORKSPACE,
        roots: ROOTS,
        allowAnyRoot: ALLOW_ANY_ROOT,
        home: HOME,
    });
});
app.get('/api/fs/list', async (req, res) => {
    const target = resolvePath(req.query.path);
    if (!target) return res.status(403).json({ error: 'Forbidden' });
    try {
        const entries = await fsp.readdir(target, { withFileTypes: true });
        const out = [];
        for (const d of entries) {
            if (d.name === '.gitkeep') continue;
            let isDir = d.isDirectory();
            let isLink = false;
            if (d.isSymbolicLink()) {
                isLink = true;
                try { const st = await fsp.stat(path.join(target, d.name)); isDir = st.isDirectory(); }
                catch (_) { isDir = false; }
            }
            const full = path.join(target, d.name);
            // Report paths relative to the root that contains them; fall back to absolute.
            const root = rootOf(full);
            const rel = root ? path.relative(root, full).replace(/\\/g, '/') : full;
            out.push({ name: d.name, isDir, isLink, path: rel, abs: full });
        }
        out.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
        res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/fs/read', async (req, res) => {
    const target = resolvePath(req.query.path);
    if (!target) return res.status(403).json({ error: 'Forbidden' });
    try {
        const st = await fsp.stat(target);
        if (!st.isFile()) return res.status(400).json({ error: 'Not a file' });
        if (st.size > 8 * 1024 * 1024) return res.status(413).json({ error: 'File too large' });
        res.json({ content: await fsp.readFile(target, 'utf8'), size: st.size });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/fs/write', async (req, res) => {
    const target = resolvePath((req.body || {}).path);
    if (!target) return res.status(403).json({ error: 'Forbidden' });
    try {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const content = req.body.content == null ? '' : String(req.body.content);
        await fsp.writeFile(target, content, 'utf8');
        res.json({ ok: true, bytes: Buffer.byteLength(content) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/fs/delete', async (req, res) => {
    const target = resolvePath(req.query.path);
    if (!target) return res.status(403).json({ error: 'Forbidden' });
    if (target === WORKSPACE) return res.status(400).json({ error: 'Refusing to delete workspace root' });
    try { await fsp.rm(target, { recursive: true, force: true }); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/fs/rename', async (req, res) => {
    const { oldPath, newPath } = req.body || {};
    const src = resolvePath(oldPath);
    const dst = resolvePath(newPath);
    if (!src || !dst) return res.status(403).json({ error: 'Forbidden' });
    try {
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.rename(src, dst);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/fs/mkdir', async (req, res) => {
    const target = resolvePath((req.body || {}).path);
    if (!target) return res.status(403).json({ error: 'Forbidden' });
    try { await fsp.mkdir(target, { recursive: true }); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

const BLOCKED_PATTERNS = [
    /\brm\s+-rf\s+\/(?!(data\/data\/com\.termux|storage))/,
    /\bsudo\b/, /\bmkfs\b/, /\b(shutdown|reboot|halt|poweroff)\b/,
    /\bdd\s+if=\/dev\/(zero|random|urandom)/,
];
app.post('/api/exec', (req, res) => {
    const { cmd, cwd } = req.body || {};
    if (!cmd || typeof cmd !== 'string') return res.status(400).json({ error: 'cmd required' });
    if (cmd.length > 8000) return res.status(413).json({ error: 'command too long' });
    for (const p of BLOCKED_PATTERNS) if (p.test(cmd)) return res.status(403).json({ error: 'Blocked: ' + p.source });
    const workdir = resolvePath(cwd || '');
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    exec(cmd, { cwd: workdir, timeout: 300000, maxBuffer: 20 * 1024 * 1024, shell: '/bin/sh' }, (err, stdout, stderr) => {
        res.json({
            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            stdout: redact(stdout || ''), stderr: redact(stderr || ''),
        });
    });
});

function gitEnv() {
    const token = effectiveGhToken();
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    // Never let a stale GIT_ASKPASS from the parent shell leak in.
    delete env.GIT_ASKPASS_TOKEN;
    delete env.GIT_ASKPASS_USER;
    if (token) {
        env.GIT_ASKPASS = ASKPASS_HELPER;
        env.GIT_ASKPASS_TOKEN = token;
        env.GIT_ASKPASS_USER = 'x-access-token';
        // Force HTTPS auth for github.com even if the remote is SSH-shaped, so a
        // token works without an SSH key. Cover every SSH spelling git accepts:
        // scp-style, ssh://, and the git:// protocol.
        const rewrites = [
            ['url.https://github.com/.insteadOf', 'git@github.com:'],
            ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
            ['url.https://github.com/.insteadOf', 'ssh://git@github.com:22/'],
            ['url.https://github.com/.insteadOf', 'git://github.com/'],
        ];
        env.GIT_CONFIG_COUNT = String(rewrites.length);
        rewrites.forEach(([k, v], i) => {
            env['GIT_CONFIG_KEY_' + i] = k;
            env['GIT_CONFIG_VALUE_' + i] = v;
        });
    } else {
        env.GIT_ASKPASS = 'echo';
        // No token: make sure SSH never hangs waiting for a passphrase.
        env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new';
    }
    return env;
}

// Translate raw git stderr into an actionable message.
function explainGitError(stderr, ctx = {}) {
    const s = String(stderr || '');
    if (/Permission denied \(publickey\)/i.test(s)) {
        return 'SSH auth failed: no key on GitHub. Save a GitHub token in Settings (or add your SSH key).';
    }
    if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(s)) {
        return 'GitHub auth failed: no valid token. Save a GitHub token in Settings.';
    }
    if (/Repository not found/i.test(s)) {
        return 'Repository not found — check the name and that your token has "repo" scope.';
    }
    if (/\b403\b|Resource not accessible|insufficient (?:scope|permission)/i.test(s)) {
        return 'Token lacks permission for this repo. Regenerate the PAT with "repo" scope (and SSO authorization if the org requires it).';
    }
    if (/\b401\b|Bad credentials/i.test(s)) {
        return 'Token is invalid or expired. Generate a new PAT and save it in Settings.';
    }
    if (/Repository not found/i.test(s)) {
        return 'Repository not found — check the name and that your token has "repo" scope.';
    }
    if (/GH013|push protection|secret scanning/i.test(s)) {
        return 'Push blocked by GitHub push protection — a secret was detected in the commits. Remove it and retry.';
    }
    if (/Protected branch|non-fast-forward|\[rejected\]/i.test(s)) {
        return 'Push rejected — remote has commits you do not have. Pull first, then push.';
    }
    if (/could not resolve host|Network is unreachable|timed out/i.test(s)) {
        return 'Network error reaching GitHub — check your connection.';
    }
    if (/src refspec .* does not match any/i.test(s)) {
        return 'Nothing to push — the branch has no commits yet.';
    }
    return '';
}
function gitCmd(cwd, args, timeout = 60000) {
    return new Promise((resolve) => {
        execFile('git', args, { cwd, env: gitEnv(), timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
            const out = redact(stdout || '');
            const errOut = redact(stderr || '');
            const res = {
                ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
                stdout: out, stderr: errOut,
            };
            if (err) {
                const hint = explainGitError(errOut + ' ' + (err.message || ''));
                if (hint) res.hint = hint;
            }
            resolve(res);
        });
    });
}
function gitWorkdir(body) { return resolvePath((body || {}).cwd || ''); }

app.post('/api/git/status', async (req, res) => {
    const workdir = gitWorkdir(req.body);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    const inside = await gitCmd(workdir, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok || !inside.stdout.trim().startsWith('true')) return res.json({ isRepo: false });
    const [status, branch, remote] = await Promise.all([
        gitCmd(workdir, ['status', '--porcelain', '-uall']),
        gitCmd(workdir, ['branch', '--show-current']),
        gitCmd(workdir, ['remote', 'get-url', 'origin']),
    ]);
    const files = status.stdout.split('\n').filter(Boolean).map((line) => ({
        status: line.slice(0, 2), path: line.slice(3),
    }));
    res.json({ isRepo: true, branch: branch.stdout.trim(), remote: remote.ok ? remote.stdout.trim() : '', files, changeCount: files.length });
});
app.post('/api/git/log', async (req, res) => {
    const workdir = gitWorkdir(req.body);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    const limit = Math.min(Math.max(parseInt((req.body || {}).limit, 10) || 30, 1), 200);
    const r = await gitCmd(workdir, ['log', '--pretty=format:%H%x1f%an%x1f%ar%x1f%s', '-' + limit]);
    const commits = r.stdout.split('\n').filter(Boolean).map((line) => {
        const [hash, author, when, subject] = line.split('\x1f');
        return { hash, author, when, subject };
    });
    res.json({ commits, ok: r.ok });
});
app.post('/api/git/diff', async (req, res) => {
    const workdir = gitWorkdir(req.body);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    const file = (req.body || {}).file;
    const args = ['diff', '--no-color'];
    if (file && typeof file === 'string' && !file.startsWith('-')) args.push('--', file);
    const unstaged = await gitCmd(workdir, args);
    const staged = await gitCmd(workdir, ['diff', '--cached', '--no-color'].concat(
        file && typeof file === 'string' && !file.startsWith('-') ? ['--', file] : []));
    res.json({ unstaged: unstaged.stdout, staged: staged.stdout });
});
app.post('/api/git/init', async (req, res) => {
    const workdir = gitWorkdir(req.body);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    const branch = String((req.body || {}).branch || 'main').replace(/[^A-Za-z0-9._-]/g, '');
    let r = await gitCmd(workdir, ['init', '-b', branch || 'main']);
    if (!r.ok) r = await gitCmd(workdir, ['init']);
    res.json(r);
});
app.post('/api/git/clone', async (req, res) => {
    const { url, dir } = req.body || {};
    if (!url || !/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) return res.status(400).json({ error: 'invalid url' });
    const fallback = url.split('/').pop().replace(/\.git$/, '').replace(/[^a-zA-Z0-9._-]/g, '_');
    const name = String(dir || fallback);
    const target = resolvePath(name);
    if (!target || target === WORKSPACE) return res.status(403).json({ error: 'Forbidden' });
    if (fs.existsSync(target)) return res.status(400).json({ error: 'Directory exists: ' + name });
    const r = await gitCmd(WORKSPACE, ['clone', '--progress', url, name], 300000);
    res.json({ ...r, dir: name });
});
app.post('/api/git/add', async (req, res) => {
    const workdir = gitWorkdir(req.body);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    const paths = (req.body || {}).paths;
    const args = ['add'];
    if (Array.isArray(paths) && paths.length) {
        for (const p of paths) if (typeof p === 'string' && !p.startsWith('-')) args.push('--', p);
    } else args.push('-A');
    res.json(await gitCmd(workdir, args, 30000));
});
app.post('/api/git/commit', async (req, res) => {
    const workdir = gitWorkdir(req.body);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    const msg = String((req.body || {}).message || 'Update').slice(0, 2000);
    await gitCmd(workdir, ['add', '-A']);
    res.json(await gitCmd(workdir, ['commit', '-m', msg], 60000));
});
app.post('/api/git/push', async (req, res) => {
    const workdir = gitWorkdir(req.body);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    const branch = (await gitCmd(workdir, ['branch', '--show-current'])).stdout.trim();
    if (!branch) return res.json({ ok: false, error: 'Detached HEAD — cannot push' });

    // Preflight: fail fast with a clear reason instead of a raw git dump.
    const remote = await gitCmd(workdir, ['remote', 'get-url', 'origin']);
    if (!remote.ok || !remote.stdout.trim()) {
        return res.json({ ok: false, error: 'No "origin" remote configured. Set one first.' });
    }
    const remoteUrl = remote.stdout.trim();
    const isSsh = /^(git@|ssh:\/\/)/.test(remoteUrl);
    const token = effectiveGhToken();
    if (isSsh && !token) {
        return res.json({
            ok: false, needsAuth: true,
            error: 'Remote uses SSH but no GitHub token is saved. Save a token in Settings, or add your SSH key to GitHub.',
        });
    }
    if (!token) {
        return res.json({ ok: false, needsAuth: true, error: 'No GitHub token. Save one in Settings to push.' });
    }

    const hasUpstream = (await gitCmd(workdir, ['rev-parse', '--abbrev-ref', branch + '@{upstream}'])).ok;
    const args = hasUpstream ? ['push'] : ['push', '-u', 'origin', branch];
    const result = await gitCmd(workdir, args, 180000);
    if (!result.ok && !result.hint) {
        result.hint = explainGitError(result.stderr) || 'Push failed — see stderr for details.';
    }
    res.json(result);
});

// Diagnose GitHub connectivity end-to-end and report exactly what is wrong.
app.get('/api/github/diagnose', async (req, res) => {
    // Default to the server's own repo (where server.js lives), not the file-browser
    // workspace root — otherwise `git rev-parse` runs one level above the repo and
    // reports isRepo:false even though a repo is right there. Note resolvePath('')
    // returns WORKSPACE (truthy), so an explicit query param must be distinguished
    // from the default rather than relying on a falsy fallback.
    const explicit = String(req.query.cwd || '').trim();
    const cwd = explicit ? (resolvePath(explicit) || __dirname) : __dirname;
    const found = resolveGhToken();
    const report = {
        token: { present: !!found.token, source: found.source, label: found.label, validFormat: looksLikeGhToken(found.token) },
        api: { reachable: false, authenticated: false, login: null, scopes: null, error: null },
        repo: { isRepo: false, remote: '', remoteKind: null, branch: '', upstream: false },
        ssh: { keyPresent: false, keyPath: null },
        verdict: 'unknown',
        fixes: [],
    };

    // 1. SSH key presence (informational — token is the primary path).
    const keyPath = path.join(HOME, '.ssh', 'id_ed25519');
    report.ssh.keyPresent = fs.existsSync(keyPath);
    report.ssh.keyPath = report.ssh.keyPresent ? keyPath : null;

    // 2. API reachability + auth.
    try {
        const r = await fetch('https://api.github.com/user', {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'deepseek-studio',
                ...(found.token ? { Authorization: 'Bearer ' + found.token } : {}),
            },
        });
        report.api.reachable = true;
        if (r.ok) {
            const d = await r.json().catch(() => ({}));
            report.api.authenticated = true;
            report.api.login = d.login || null;
            report.api.scopes = r.headers.get('x-oauth-scopes');
        } else {
            const d = await r.json().catch(() => ({}));
            report.api.error = d.message || ('HTTP ' + r.status);
        }
    } catch (err) {
        report.api.error = err.message;
    }

    // 3. Repo state.
    const inside = await gitCmd(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (inside.ok && inside.stdout.trim().startsWith('true')) {
        report.repo.isRepo = true;
        const [rem, br, up] = await Promise.all([
            gitCmd(cwd, ['remote', 'get-url', 'origin']),
            gitCmd(cwd, ['branch', '--show-current']),
            gitCmd(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}']),
        ]);
        report.repo.remote = rem.ok ? rem.stdout.trim() : '';
        report.repo.remoteKind = remoteKind(report.repo.remote);
        report.repo.httpsEquivalent = normalizeRemote(report.repo.remote);
        report.repo.githubSlug = githubRepoSlug(report.repo.remote);
        report.repo.isGithub = isGithubRemote(report.repo.remote);
        report.repo.branch = br.stdout.trim();
        report.repo.upstream = up.ok;
        // Report whether the token can actually write to this repo.
        if (report.repo.githubSlug && found.token && report.api.authenticated) {
            const pr = await ghFetch('/repos/' + report.repo.githubSlug);
            if (pr.ok) {
                report.repo.canPush = !!(pr.data.permissions && pr.data.permissions.push);
                report.repo.private = !!pr.data.private;
                if (!report.repo.canPush) {
                    report.fixes.push('Your token cannot push to ' + report.repo.githubSlug + ' — it needs "repo" scope and access to this repository.');
                }
            }
        }
    }

    // 4. Verdict + concrete fixes.
    if (!report.api.reachable) {
        report.verdict = 'offline';
        report.fixes.push('No network access to api.github.com — check connectivity.');
    } else if (!found.token) {
        report.verdict = 'no-token';
        report.fixes.push('Save a GitHub token: Settings → GitHub → paste a PAT with "repo" scope.');
        if (report.repo.remoteKind === 'ssh') {
            report.fixes.push('Or add your SSH public key to GitHub (Settings → SSH keys).');
        }
    } else if (!report.api.authenticated) {
        report.verdict = 'bad-token';
        report.fixes.push('Token rejected by GitHub (' + (report.api.error || 'unknown') + '). Generate a new PAT with "repo" scope.');
    } else if (!report.repo.isRepo) {
        report.verdict = 'not-a-repo';
        report.fixes.push('This folder is not a git repository — run git init.');
    } else if (!report.repo.remote) {
        report.verdict = 'no-remote';
        report.fixes.push('No "origin" remote — set one to a GitHub repo URL.');
    } else if (report.repo.remoteKind === 'ssh') {
        // Token is valid but the remote is SSH: git will still use the key.
        // Note: gitEnv() rewrites SSH→HTTPS automatically when a token exists,
        // so this is a warning rather than a hard failure.
        report.verdict = 'ssh-remote';
        report.fixes.push('Remote uses SSH. A saved token is applied automatically via insteadOf, but switching is more reliable:');
        report.fixes.push('git remote set-url origin ' + report.repo.httpsEquivalent + '.git');
        report.fixes.push('Or use the "Fix remote" button to switch automatically.');
        if (!report.ssh.keyPresent) {
            report.fixes.push('Or add an SSH key to GitHub (Settings → SSH keys).');
        }
    } else if (report.repo.canPush === false) {
        report.verdict = 'no-permission';
        report.fixes.push('Token is valid but cannot push to ' + (report.repo.githubSlug || 'this repo') + '. Regenerate the PAT with "repo" scope.');
    } else {
        report.verdict = 'ready';
    }
    res.json(report);
});
app.post('/api/git/pull', async (req, res) => {
    const workdir = gitWorkdir(req.body);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    res.json(await gitCmd(workdir, ['pull', '--no-edit'], 180000));
});
app.post('/api/git/fetch', async (req, res) => {
    const workdir = gitWorkdir(req.body);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    res.json(await gitCmd(workdir, ['fetch', '--all', '--prune'], 120000));
});
app.post('/api/git/branches', async (req, res) => {
    const workdir = gitWorkdir(req.body);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    const [all, cur] = await Promise.all([gitCmd(workdir, ['branch', '-a']), gitCmd(workdir, ['branch', '--show-current'])]);
    const branches = all.stdout.split('\n').filter(Boolean).map((b) => b.replace(/^\*?\s*/, '').trim()).filter((b) => !b.includes('->'));
    res.json({ branches: [...new Set(branches)], current: cur.stdout.trim() });
});
app.post('/api/git/checkout', async (req, res) => {
    const workdir = gitWorkdir(req.body);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    const name = String((req.body || {}).branch || '');
    if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(name)) return res.status(400).json({ error: 'invalid branch' });
    res.json(await gitCmd(workdir, ['checkout', name]));
});
app.post('/api/git/set-remote', async (req, res) => {
    const workdir = gitWorkdir(req.body);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    const url = String((req.body || {}).url || '');
    if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) return res.status(400).json({ error: 'invalid url' });
    await gitCmd(workdir, ['remote', 'remove', 'origin']);
    res.json(await gitCmd(workdir, ['remote', 'add', 'origin', url]));
});
app.post('/api/git/remotes', async (req, res) => {
    const workdir = gitWorkdir(req.body);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    const r = await gitCmd(workdir, ['remote', '-v']);
    res.json({ remotes: r.stdout.split('\n').filter(Boolean) });
});

const GH_DEVICE_SESSIONS = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [code, s] of GH_DEVICE_SESSIONS) if (now > s.expiresAt) GH_DEVICE_SESSIONS.delete(code);
}, 60 * 1000).unref();

async function ghFetch(pathname, init = {}) {
    const token = effectiveGhToken();
    if (!token) return { ok: false, status: 401, data: { message: 'No GitHub token' } };
    const res = await fetch('https://api.github.com' + pathname, {
        ...init,
        headers: {
            Authorization: 'Bearer ' + token,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'DeepSeek-Studio/' + PKG_VERSION,
            ...(init.headers || {}),
        },
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
}

app.get('/api/github/status', async (_req, res) => {
    const found = resolveGhToken();
    if (!found.token) return res.json({ connected: false, source: null });
    const r = await ghFetch('/user');
    if (!r.ok) return res.json({ connected: false, source: found.source, error: r.data && r.data.message });
    res.json({
        connected: true, source: found.source, sourceLabel: found.label,
        login: r.data.login, name: r.data.name, avatar: r.data.avatar_url,
    });
});
app.get('/api/github/device/config', (_req, res) => {
    res.json({ configured: !!(secrets.github_client_id || process.env.DS_GITHUB_CLIENT_ID) });
});
app.post('/api/github/device/start', async (req, res) => {
    const clientId = String(secrets.github_client_id || process.env.DS_GITHUB_CLIENT_ID || '').trim();
    if (!clientId) return res.status(500).json({ error: 'No OAuth client_id — save one in Settings' });
    const scope = String((req.body || {}).scope || 'repo read:user user:email').trim();
    const r = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, scope }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) return res.status(r.status || 500).json({ error: data.error_description || data.error || 'failed' });
    GH_DEVICE_SESSIONS.set(data.device_code, {
        clientId, interval: Math.max(5, data.interval || 5),
        expiresAt: Date.now() + (data.expires_in || 900) * 1000,
    });
    res.json({
        deviceCode: data.device_code, userCode: data.user_code,
        verificationUri: data.verification_uri || 'https://github.com/login/device',
        verificationUriComplete: data.verification_uri_complete,
        interval: Math.max(5, data.interval || 5), expiresIn: data.expires_in,
    });
});
app.post('/api/github/device/poll', async (req, res) => {
    const deviceCode = String((req.body || {}).deviceCode || '');
    const session = GH_DEVICE_SESSIONS.get(deviceCode);
    if (!session) return res.json({ status: 'expired' });
    if (Date.now() > session.expiresAt) { GH_DEVICE_SESSIONS.delete(deviceCode); return res.json({ status: 'expired' }); }
    const r = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: session.clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    const data = await r.json().catch(() => ({}));
    if (data.error === 'authorization_pending') return res.json({ status: 'pending' });
    if (data.error === 'slow_down') { session.interval += 5; return res.json({ status: 'pending', interval: session.interval }); }
    if (data.error === 'expired_token') { GH_DEVICE_SESSIONS.delete(deviceCode); return res.json({ status: 'expired' }); }
    if (data.error === 'access_denied') { GH_DEVICE_SESSIONS.delete(deviceCode); return res.json({ status: 'denied' }); }
    if (!data.access_token) return res.json({ status: 'error', error: data.error_description || data.error || 'no token' });
    secrets.github_token = String(data.access_token).trim();
    saveSecrets();
    GH_DEVICE_SESSIONS.delete(deviceCode);
    const user = await ghFetch('/user');
    res.json({ status: 'authorized', user: user.ok ? { login: user.data.login, name: user.data.name, avatar: user.data.avatar_url } : null });
});
app.post('/api/github/signout', (_req, res) => { delete secrets.github_token; saveSecrets(); res.json({ ok: true }); });
app.get('/api/github/repos', async (req, res) => {
    const perPage = Math.min(Math.max(parseInt(req.query.per_page, 10) || 50, 1), 100);
    const r = await ghFetch('/user/repos?sort=updated&per_page=' + perPage);
    if (!r.ok) return res.status(r.status).json({ error: (r.data && r.data.message) || 'github failed' });
    res.json({ repos: (r.data || []).map((repo) => ({
        name: repo.name, fullName: repo.full_name, private: repo.private,
        cloneUrl: repo.clone_url, sshUrl: repo.ssh_url, defaultBranch: repo.default_branch,
    })) });
});
app.post('/api/github/create-repo', async (req, res) => {
    const { name, description, isPrivate } = req.body || {};
    if (!name || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) return res.status(400).json({ error: 'invalid repo name' });
    const r = await ghFetch('/user/repos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: description || '', private: isPrivate !== false, auto_init: false }),
    });
    if (!r.ok) return res.status(r.status).json({ error: (r.data && r.data.message) || 'create failed' });
    res.json({ ok: true, repo: { fullName: r.data.full_name, cloneUrl: r.data.clone_url, defaultBranch: r.data.default_branch } });
});

function tool(name, description, props, required) {
    return { type: 'function', function: { name, description, parameters: { type: 'object', properties: props, required } } };
}
const str = (description) => ({ type: 'string', description });
const bool = () => ({ type: 'boolean' });
const BASE_TOOLS = [
    tool('read_file', 'Read the full contents of a file.', { path: str('Path relative to project root') }, ['path']),
    tool('write_file', 'Create or overwrite a file. Use for NEW files only.', { path: str(), content: str() }, ['path', 'content']),
    tool('apply_patch', 'Find a unique string in an existing file and replace it. Include 3-5 lines of context.', { path: str(), search: str(), replace: str(), replace_all: bool() }, ['path', 'search', 'replace']),
    tool('list_files', 'List files in a directory.', { path: str() }, []),
    tool('grep_search', 'Search for a regex pattern across files.', { pattern: str(), path: str(), ignore_case: bool() }, ['pattern']),
    tool('find_files', 'Find files by name glob (e.g. "*.py").', { pattern: str(), path: str() }, ['pattern']),
    tool('delete_file', 'Delete a file or folder.', { path: str() }, ['path']),
    tool('move_file', 'Move or rename a file.', { from: str(), to: str() }, ['from', 'to']),
    tool('create_folder', 'Create a folder.', { path: str() }, ['path']),
    tool('run_command', 'Run a shell command (git, npm, tests, builds). Set background:true for servers.', { command: str(), cwd: str(), background: bool() }, ['command']),
];

/* Second-generation tools (multi-file refactors, structural search, test
   loops, long-term memory, plan tracking). Loaded defensively so a broken
   optional module degrades the toolset instead of killing the server. */
let EXTRA_TOOLS = { schemas: [], cases: {} };
try {
    const extra = require('./lib/ai-tools-extra');
    EXTRA_TOOLS = { schemas: extra.EXTRA_TOOL_SCHEMAS || [], cases: extra.EXTRA_TOOL_CASES || {} };
} catch (err) {
    console.warn('[ai] extra tools unavailable:', err.message);
}
const AI_TOOLS = BASE_TOOLS.concat(EXTRA_TOOLS.schemas);

app.get('/api/ai/providers', (_req, res) => {
    res.json(Object.entries(AI_PROVIDERS).map(([id, cfg]) => ({ id, model: cfg.model, configured: !!String(secrets[cfg.keyName] || '').trim() })));
});
app.get('/api/ai/tools', (_req, res) => res.json({ tools: AI_TOOLS }));

app.post('/api/ai/chat', async (req, res) => {
    const body = req.body || {};
    const providerId = String(body.provider || 'deepseek').toLowerCase();
    const p = AI_PROVIDERS[providerId];
    if (!p) return res.status(400).json({ error: 'Unknown provider: ' + providerId });
    const key = String(secrets[p.keyName] || '').trim();
    if (!key) return res.status(400).json({ error: 'No API key for ' + providerId });
    const payload = {
        model: body.model || p.model,
        messages: Array.isArray(body.messages) ? body.messages : [],
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.3,
        max_tokens: typeof body.maxTokens === 'number' ? body.maxTokens : 4096,
    };
    if (Array.isArray(body.tools) && body.tools.length) { payload.tools = body.tools; payload.tool_choice = body.toolChoice || 'auto'; }
    const streaming = body.stream === true;
    if (streaming) payload.stream = true;

    const ctrl = new AbortController();
    let timer = null;
    if (streaming) res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    else timer = setTimeout(() => ctrl.abort(), 120000);

    let upstream;
    try {
        upstream = await fetch(p.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
            body: JSON.stringify(payload),
            signal: ctrl.signal,
        });
    } catch (err) {
        if (timer) clearTimeout(timer);
        if (err.name === 'AbortError') return res.status(499).json({ error: 'Cancelled' });
        return res.status(502).json({ error: 'Upstream unreachable: ' + redact(err.message) });
    }

    if (!upstream.ok) {
        if (timer) clearTimeout(timer);
        const text = await upstream.text().catch(() => '');
        return res.status(upstream.status).json({ error: 'Provider ' + upstream.status, detail: redact(text).slice(0, 800) });
    }

    if (!streaming) {
        try { const data = await upstream.json(); if (timer) clearTimeout(timer); return res.json(data); }
        catch (err) { if (timer) clearTimeout(timer); return res.status(502).json({ error: 'Bad JSON: ' + redact(err.message) }); }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
    if (typeof keepAlive.unref === 'function') keepAlive.unref();

    try {
        for await (const chunk of upstream.body) {
            if (res.destroyed || res.writableEnded) { ctrl.abort(); break; }
            res.write(chunk);
        }
    } catch (err) {
        if (!res.writableEnded && !ctrl.signal.aborted) res.write('data: ' + JSON.stringify({ error: redact(err.message) }) + '\n\n');
    } finally {
        clearInterval(keepAlive);
        if (!res.writableEnded) res.end();
    }
});

function toolResult(res, ok, display, extra) { res.json({ ok: !!ok, display: display || '', result: extra || {} }); }

function applyPatchSmart(original, search, replace, replaceAll) {
    let count = 0, idx = 0;
    while ((idx = original.indexOf(search, idx)) !== -1) { count++; idx += search.length; }
    if (count === 0) {
        const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
        if (norm(search) && norm(original).includes(norm(search))) return { ok: false, error: 'whitespace mismatch' };
        return { ok: false, error: 'search not found' };
    }
    if (count > 1 && !replaceAll) return { ok: false, error: 'ambiguous — ' + count + ' matches' };
    const content = replaceAll ? original.split(search).join(replace) : original.replace(search, replace);
    return { ok: true, content, count: replaceAll ? count : 1 };
}

/* Dry-run a mutating tool: compute what WOULD change without touching disk.
   Powers the diff-review gate in the chat UI. */
// Build a compact unified diff between two strings. Line-based LCS so the
// output is a real diff (not just "before/after"), which the UI renders.
function unifiedDiff(before, after, label) {
    const A = String(before == null ? '' : before).split('\n');
    const B = String(after == null ? '' : after).split('\n');
    const n = A.length, m = B.length;
    // Guard: LCS is O(n*m). For very large files fall back to a coarse diff.
    if (n * m > 4_000_000) {
        return {
            diff: '--- a/' + label + '\n+++ b/' + label + '\n@@ full rewrite @@\n' +
                  A.map((l) => '-' + l).join('\n') + '\n' + B.map((l) => '+' + l).join('\n'),
            added: m, removed: n,
        };
    }
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const out = ['--- a/' + label, '+++ b/' + label];
    let added = 0, removed = 0, i = 0, j = 0;
    while (i < n && j < m) {
        if (A[i] === B[j]) { out.push(' ' + A[i]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('-' + A[i]); removed++; i++; }
        else { out.push('+' + B[j]); added++; j++; }
    }
    while (i < n) { out.push('-' + A[i]); removed++; i++; }
    while (j < m) { out.push('+' + B[j]); added++; j++; }
    return { diff: out.join('\n'), added, removed };
}

app.post('/api/ai/preview', async (req, res) => {
    const { name, args = {}, cwd = '' } = req.body || {};
    const base = resolvePath(cwd) || WORKSPACE;
    const a = args || {};
    try {
        if (name === 'write_file') {
            const target = resolvePath(a.path, base);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            const before = fs.existsSync(target) ? await fsp.readFile(target, 'utf8') : '';
            const after = a.content == null ? '' : String(a.content);
            const d = unifiedDiff(before, after, a.path);
            return res.json({ ok: true, kind: 'write', path: a.path, before, after, created: !fs.existsSync(target), diff: d.diff, added: d.added, removed: d.removed });
        }
        if (name === 'apply_patch') {
            const target = resolvePath(a.path, base);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            if (!fs.existsSync(target)) return res.json({ ok: false, error: 'File not found: ' + a.path });
            const before = await fsp.readFile(target, 'utf8');
            const r = applyPatchSmart(before, a.search, a.replace == null ? '' : String(a.replace), a.replace_all === true);
            if (!r.ok) return res.json({ ok: false, error: r.error });
            const d = unifiedDiff(before, r.content, a.path);
            return res.json({ ok: true, kind: 'patch', path: a.path, before, after: r.content, replacements: r.count, diff: d.diff, added: d.added, removed: d.removed });
        }
        if (name === 'delete_file') {
            const target = resolvePath(a.path, base);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            if (!fs.existsSync(target)) return res.json({ ok: false, error: 'Not found: ' + a.path });
            const st = await fsp.stat(target);
            return res.json({ ok: true, kind: 'delete', path: a.path, isDir: st.isDirectory() });
        }
        if (name === 'move_file') {
            const src = resolvePath(a.from, base);
            const dst = resolvePath(a.to, base);
            if (!src || !dst) return res.status(403).json({ error: 'outside workspace' });
            return res.json({ ok: true, kind: 'move', from: a.from, to: a.to, exists: fs.existsSync(dst) });
        }
        return res.json({ ok: true, kind: 'none' });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

// Compact repo map for context injection: a tree of source files with line
// counts, capped so it fits comfortably in a system prompt on mobile.
const REPOMAP_SKIP = new Set(['node_modules', '.git', 'build', 'dist', '.cache', 'vendor', 'coverage']);
const REPOMAP_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|json|md|css|html)$/i;

app.get('/api/ai/repomap', async (req, res) => {
    const base = resolvePath(req.query.path) || WORKSPACE;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 400, 1), 2000);
    try {
        const lines = [];
        let count = 0;
        let truncated = false;
        async function walk(dir, depth) {
            if (count >= limit) { truncated = true; return; }
            let entries;
            try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
            catch { return; }
            entries.sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name));
            for (const ent of entries) {
                if (count >= limit) { truncated = true; return; }
                if (ent.name.startsWith('.') && ent.name !== '.env.example') continue;
                if (REPOMAP_SKIP.has(ent.name)) continue;
                const full = path.join(dir, ent.name);
                const rel = path.relative(base, full).split(path.sep).join('/');
                if (ent.isDirectory()) {
                    if (depth < 6) await walk(full, depth + 1);
                } else if (REPOMAP_EXT.test(ent.name)) {
                    let n = 0;
                    try {
                        const txt = await fsp.readFile(full, 'utf8');
                        n = txt.split('\n').length;
                    } catch {}
                    lines.push(rel + ' (' + n + ' lines)');
                    count++;
                }
            }
        }
        await walk(base, 0);
        const map = lines.join('\n');
        res.json({ ok: true, path: base, files: count, truncated, map });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

app.post('/api/ai/tool-call', async (req, res) => {
    const { name, args = {}, cwd = '' } = req.body || {};
    if (!name) return res.status(400).json({ error: 'tool name required' });
    const base = resolvePath(cwd) || WORKSPACE;
    const a = Object.assign({}, args);
    try {
        switch (name) {
        case 'read_file': {
            const target = resolvePath(a.path, base);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            if (!fs.existsSync(target)) return toolResult(res, false, 'Not found: ' + a.path);
            const content = await fsp.readFile(target, 'utf8');
            return toolResult(res, true, 'Read ' + content.length + ' bytes', { content: content.slice(0, 20000), truncated: content.length > 20000 });
        }
        case 'write_file': {
            const target = resolvePath(a.path, base);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            await fsp.mkdir(path.dirname(target), { recursive: true });
            const content = a.content == null ? '' : String(a.content);
            await fsp.writeFile(target, content, 'utf8');
            return toolResult(res, true, 'Wrote ' + Buffer.byteLength(content) + ' bytes to ' + a.path, { bytes: Buffer.byteLength(content) });
        }
        case 'apply_patch': {
            const target = resolvePath(a.path, base);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            if (!fs.existsSync(target)) return toolResult(res, false, 'File not found: ' + a.path);
            if (!a.search) return res.status(400).json({ error: 'search required' });
            const original = await fsp.readFile(target, 'utf8');
            const r = applyPatchSmart(original, a.search, a.replace == null ? '' : String(a.replace), a.replace_all === true);
            if (!r.ok) return toolResult(res, false, 'Patch failed: ' + r.error, { error: r.error });
            await fsp.writeFile(target, r.content, 'utf8');
            return toolResult(res, true, 'Patched ' + a.path + ' (' + r.count + ' replacement' + (r.count === 1 ? '' : 's') + ')', { replacements: r.count });
        }
        case 'list_files': {
            const target = resolvePath(a.path, base);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            if (!fs.existsSync(target)) return toolResult(res, false, 'Not found: ' + a.path);
            const items = (await fsp.readdir(target, { withFileTypes: true })).filter((d) => d.name !== '.gitkeep').map((d) => (d.isDirectory() ? '[dir] ' : '[file] ') + d.name);
            return toolResult(res, true, 'Listed ' + items.length + ' items', { items });
        }
        case 'grep_search': {
            const target = resolvePath(a.path, base);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            if (!a.pattern) return res.status(400).json({ error: 'pattern required' });
            let re;
            try { re = new RegExp(a.pattern, a.ignore_case ? 'i' : ''); }
            catch (_) { re = new RegExp(a.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), a.ignore_case ? 'i' : ''); }
            const skip = new Set(['node_modules', '.git', 'build', 'dist', '.dart_tool', '.next', '.gradle', 'target']);
            const matches = [];
            const walk = (dir, depth) => {
                if (matches.length >= 60 || depth > 8) return;
                let entries;
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
                for (const e of entries) {
                    if (matches.length >= 60) return;
                    if (skip.has(e.name)) continue;
                    const full = path.join(dir, e.name);
                    if (e.isDirectory()) { walk(full, depth + 1); continue; }
                    let st; try { st = fs.statSync(full); } catch (_) { continue; }
                    if (st.size > 2 * 1024 * 1024) continue;
                    let text; try { text = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
                    text.split('\n').forEach((line, i) => {
                        if (matches.length < 60 && re.test(line)) matches.push(path.relative(WORKSPACE, full) + ':' + (i + 1) + ': ' + line.trim().slice(0, 160));
                    });
                }
            };
            walk(target, 0);
            return toolResult(res, matches.length > 0, 'Found ' + matches.length + ' match' + (matches.length === 1 ? '' : 'es'), { matches });
        }
        case 'find_files': {
            const target = resolvePath(a.path, base);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            const glob = String(a.pattern || '');
            const rx = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
            const skip = new Set(['node_modules', '.git', 'build', 'dist', '.dart_tool', '.next', '.gradle', 'target']);
            const hits = [];
            const walk = (dir, depth) => {
                if (hits.length >= 80 || depth > 8) return;
                let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
                for (const e of entries) {
                    if (hits.length >= 80) return;
                    if (skip.has(e.name)) continue;
                    const full = path.join(dir, e.name);
                    if (e.isDirectory()) walk(full, depth + 1);
                    else if (rx.test(e.name)) hits.push(path.relative(WORKSPACE, full));
                }
            };
            walk(target, 0);
            return toolResult(res, hits.length > 0, 'Found ' + hits.length + ' file' + (hits.length === 1 ? '' : 's'), { files: hits });
        }
        case 'delete_file': {
            const target = resolvePath(a.path, base);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            if (target === WORKSPACE) return res.status(400).json({ error: 'cannot delete workspace root' });
            if (!fs.existsSync(target)) return toolResult(res, false, 'Not found');
            await fsp.rm(target, { recursive: true, force: true });
            return toolResult(res, true, 'Deleted: ' + a.path);
        }
        case 'move_file': {
            const src = resolvePath(a.from, base);
            const dst = resolvePath(a.to, base);
            if (!src || !dst) return res.status(403).json({ error: 'outside workspace' });
            if (!fs.existsSync(src)) return toolResult(res, false, 'Source not found: ' + a.from);
            await fsp.mkdir(path.dirname(dst), { recursive: true });
            await fsp.rename(src, dst);
            return toolResult(res, true, 'Moved ' + a.from + ' → ' + a.to);
        }
        case 'create_folder': {
            const target = resolvePath(a.path, base);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            await fsp.mkdir(target, { recursive: true });
            return toolResult(res, true, 'Created: ' + a.path);
        }
        case 'run_command': {
            const cmd = String(a.command || '');
            if (!cmd) return res.status(400).json({ error: 'command required' });
            for (const p of BLOCKED_PATTERNS) if (p.test(cmd)) return res.status(403).json({ error: 'Blocked: ' + p.source });
            const workdir = resolvePath(a.cwd, base) || base;
            const isBg = a.background === true;
            return exec(cmd, { cwd: workdir, timeout: isBg ? 3000 : 120000, maxBuffer: 20 * 1024 * 1024, shell: '/bin/sh' }, (err, stdout, stderr) => {
                if (isBg && err && err.killed) return toolResult(res, true, 'Started bg: ' + cmd.slice(0, 60), { background: true });
                const out = redact((stdout || '') + (stderr ? '\n' + stderr : ''));
                const trimmed = out.length > 6000 ? out.slice(0, 6000) + '\n...(truncated)' : out;
                toolResult(res, !err, 'Ran: ' + cmd.slice(0, 60) + (err ? ' (exit ' + (err.code || '?') + ')' : ' ok'), { code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: trimmed });
            });
        }
        default: {
            const handler = EXTRA_TOOLS.cases[name];
            if (!handler) return res.status(400).json({ error: 'Unknown tool: ' + name });
            const out = await handler(a, {
                resolveInWorkspace: (rel) => resolvePath(rel, base),
                run: (cmd, opts) => new Promise((resolve) => {
                    exec(cmd, { cwd: base, timeout: 180000, maxBuffer: 20 * 1024 * 1024, shell: '/bin/sh', ...(opts || {}) },
                        (err, stdout, stderr) => resolve({
                            ok: !err,
                            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
                            stdout: redact(stdout || ''),
                            stderr: redact(stderr || ''),
                        }));
                }),
                runShell: (cmd, opts) => new Promise((resolve) => {
                    exec(cmd, { cwd: base, timeout: 180000, maxBuffer: 20 * 1024 * 1024, shell: '/bin/sh', ...(opts || {}) },
                        (err, stdout, stderr) => resolve({
                            ok: !err,
                            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
                            stdout: redact(stdout || ''),
                            stderr: redact(stderr || ''),
                        }));
                }),
                deps: { applyPatchSmart },
                base,
            });
            return toolResult(res, out && out.ok, (out && out.display) || '', (out && out.result) || {});
        }
        }
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

// ── License status ────────────────────────────────────────────────────────
// The editor is free and open source; this endpoint exists so clients and CI
// can query entitlement state without special-casing a 404.
app.get('/api/license/status', (_req, res) => {
    res.json({
        ok: true,
        licensed: true,
        plan: 'open-source',
        edition: 'community',
        version: PKG_VERSION,
        expires: null,
        features: ['editor', 'terminal', 'git', 'ai', 'deploy', 'backup', 'compile'],
    });
});

// ── Toolchain detection ───────────────────────────────────────────────────
// Reports which build tools are actually installed so the UI can disable
// deploy/compile actions instead of failing at run time.
const TOOLCHAIN = [
    { id: 'node', bin: 'node', args: ['--version'], label: 'Node.js' },
    { id: 'npm', bin: 'npm', args: ['--version'], label: 'npm' },
    { id: 'git', bin: 'git', args: ['--version'], label: 'Git' },
    { id: 'python', bin: 'python3', args: ['--version'], label: 'Python' },
    { id: 'gcc', bin: 'gcc', args: ['--version'], label: 'GCC' },
    { id: 'make', bin: 'make', args: ['--version'], label: 'Make' },
    { id: 'docker', bin: 'docker', args: ['--version'], label: 'Docker' },
];
function probeTool(t) {
    return new Promise((resolve) => {
        execFile(t.bin, t.args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return resolve({ id: t.id, label: t.label, available: false, version: null });
            const out = String(stdout || stderr || '').trim().split('\n')[0];
            resolve({ id: t.id, label: t.label, available: true, version: out.slice(0, 120) });
        });
    });
}
app.get('/api/deploy/check-tools', async (_req, res) => {
    try {
        const tools = await Promise.all(TOOLCHAIN.map(probeTool));
        res.json({ ok: true, tools, available: tools.filter((t) => t.available).map((t) => t.id) });
    } catch (err) { res.status(500).json({ error: redact(err.message) }); }
});

// ── Deploy build ──────────────────────────────────────────────────────────
// Runs the project's build script (npm run build, falling back to a no-op when
// there is nothing to build). Never trusts client-supplied command strings.
app.post('/api/deploy/build', async (req, res) => {
    const workdir = gitWorkdir(req.body);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    const pkgPath = path.join(workdir, 'package.json');
    let script = null;
    try {
        const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
        if (pkg.scripts && pkg.scripts.build) script = 'build';
    } catch (_) { /* no package.json — nothing to build */ }
    if (!script) {
        return res.json({ ok: true, skipped: true, reason: 'No build script defined in package.json', workdir });
    }
    const started = Date.now();
    const r = await gitCmd(workdir, ['--version']); // warm check that git/cwd is valid
    const run = await new Promise((resolve) => {
        exec('npm run build', {
            cwd: workdir, timeout: 300000, maxBuffer: 20 * 1024 * 1024,
            shell: '/bin/sh', env: { ...process.env, CI: '1' },
        }, (err, stdout, stderr) => resolve({
            ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            stdout: redact(stdout || ''), stderr: redact(stderr || ''),
        }));
    });
    res.json({ ...run, script, workdir, durationMs: Date.now() - started, gitOk: r.ok });
});

// ── Backups ───────────────────────────────────────────────────────────────
// Snapshots live under <workspace>/.backups/<name>/<timestamp>/ and are plain
// file copies, so they survive restarts and can be restored by hand.
const BACKUP_DIRNAME = '.backups';
function backupRoot() { return path.join(WORKSPACE, BACKUP_DIRNAME); }
function safeBackupName(name) {
    const s = String(name || '').trim();
    if (!s || s.length > 120) return null;
    if (s.includes('/') || s.includes('\\') || s.includes('..') || s.startsWith('.')) return null;
    return s;
}
app.get('/api/backup/list', async (req, res) => {
    const root = backupRoot();
    const name = req.query.name ? safeBackupName(req.query.name) : null;
    if (req.query.name && !name) return res.status(400).json({ error: 'Invalid backup name' });
    try {
        const out = [];
        const names = name ? [name] : (await fsp.readdir(root, { withFileTypes: true }).catch(() => []))
            .filter((d) => d.isDirectory()).map((d) => d.name);
        for (const n of names) {
            const dir = path.join(root, n);
            const snaps = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
            for (const s of snaps) {
                if (!s.isDirectory()) continue;
                const full = path.join(dir, s.name);
                let bytes = 0, files = 0;
                const walk = async (p) => {
                    const ents = await fsp.readdir(p, { withFileTypes: true }).catch(() => []);
                    for (const e of ents) {
                        const fp = path.join(p, e.name);
                        if (e.isDirectory()) await walk(fp);
                        else { files++; try { bytes += (await fsp.stat(fp)).size; } catch (_) {} }
                    }
                };
                await walk(full);
                let createdAt = null;
                try { createdAt = (await fsp.stat(full)).mtime.toISOString(); } catch (_) {}
                out.push({ name: n, id: s.name, path: path.relative(WORKSPACE, full).replace(/\\/g, '/'), files, bytes, createdAt });
            }
        }
        out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        res.json({ ok: true, backups: out, count: out.length, root: path.relative(WORKSPACE, root).replace(/\\/g, '/') });
    } catch (err) { res.status(500).json({ error: redact(err.message) }); }
});
app.post('/api/backup/create', async (req, res) => {
    const body = req.body || {};
    const name = safeBackupName(body.name);
    if (!name) return res.status(400).json({ error: 'Invalid backup name' });
    const src = resolvePath(body.path || name);
    if (!src) return res.status(403).json({ error: 'Forbidden' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupRoot(), name, stamp);
    try {
        const st = await fsp.stat(src);
        if (!st.isDirectory()) return res.status(400).json({ error: 'Only directories can be backed up' });
        // Refuse to snapshot a directory into its own subtree (e.g. backing up
        // the workspace root would otherwise recurse into .backups forever).
        const rel = path.relative(src, dest);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
            return res.status(400).json({ error: 'Cannot back up a directory into its own subdirectory' });
        }
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.cp(src, dest, { recursive: true, filter: (p) => path.basename(p) !== '.git' });
        res.json({ ok: true, name, id: stamp, path: path.relative(WORKSPACE, dest).replace(/\\/g, '/') });
    } catch (err) { res.status(500).json({ error: redact(err.message) }); }
});

// ── Compile ───────────────────────────────────────────────────────────────
// Syntax-checks a single file using the right tool for its extension. This is
// a check, not a full build — it catches typos without running user code.
app.post('/api/compile', async (req, res) => {
    const body = req.body || {};
    const target = resolvePath(body.path);
    if (!target) return res.status(403).json({ error: 'Forbidden' });
    const ext = path.extname(target).toLowerCase();
    const runners = {
        '.js': ['node', ['--check', target]],
        '.mjs': ['node', ['--check', target]],
        '.cjs': ['node', ['--check', target]],
        '.json': ['node', ['-e', `JSON.parse(require('fs').readFileSync(${JSON.stringify(target)},'utf8'))`]],
        '.py': ['python3', ['-m', 'py_compile', target]],
        '.sh': ['sh', ['-n', target]],
    };
    const runner = runners[ext];
    if (!runner) return res.status(400).json({ error: `No compiler for ${ext || 'this file type'}` });
    try {
        const st = await fsp.stat(target);
        if (!st.isFile()) return res.status(400).json({ error: 'Not a file' });
        if (st.size > 4 * 1024 * 1024) return res.status(413).json({ error: 'File too large' });
    } catch (err) { return res.status(404).json({ error: err.message }); }
    const started = Date.now();
    execFile(runner[0], runner[1], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        res.json({
            ok: !err,
            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            compiler: runner[0],
            stdout: redact(stdout || ''),
            stderr: redact(stderr || ''),
            durationMs: Date.now() - started,
        });
    });
});

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, {
    setHeaders: (res, filePath) => { if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache'); },
}));
app.get(/^\/(?!api\/|pty).*/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.use('/api/', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
app.use((err, _req, res, _next) => {
    const msg = redact(err && err.message ? err.message : String(err));
    console.error('[error]', msg);
    if (res.headersSent) return;
    res.status(err && err.status ? err.status : 500).json({ error: msg });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/pty' });

function resolveShell() {
    if (fs.existsSync(TERMUX_BASH)) return TERMUX_BASH;
    for (const candidate of ['/system/bin/sh', '/bin/bash', '/bin/sh']) if (fs.existsSync(candidate)) return candidate;
    return 'bash';
}

wss.on('connection', (ws, req) => {
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(ip);
    if (!loopback && !BIND_ALL) { try { ws.close(1008, 'Forbidden'); } catch (_) {} return; }
    if (!isAllowedHost(req.headers.host)) { try { ws.close(1008, 'Bad host'); } catch (_) {} return; }

    const shell = resolveShell();
    const env = { ...process.env, TERM: 'xterm-256color', DS_WORKSPACE: WORKSPACE };

    if (pty) {
        let proc;
        try { proc = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: WORKSPACE, env }); }
        catch (err) { try { ws.send('\r\n[pty spawn failed: ' + redact(err.message) + ']\r\n'); } catch (_) {} try { ws.close(); } catch (_) {} return; }
        proc.onData((d) => { try { ws.send(d); } catch (_) {} });
        proc.onExit(({ exitCode }) => { try { ws.send('\r\n[process exited: ' + exitCode + ']\r\n'); } catch (_) {} try { ws.close(); } catch (_) {} });
        ws.on('message', (raw) => {
            const msg = raw.toString('utf8');
            if (msg.startsWith('{')) {
                try {
                    const parsed = JSON.parse(msg);
                    if (parsed.type === 'input') return proc.write(parsed.data);
                    if (parsed.type === 'resize' && parsed.cols > 0 && parsed.rows > 0) return proc.resize(parsed.cols, parsed.rows);
                } catch (_) {}
            }
            proc.write(msg);
        });
        ws.on('close', () => { try { proc.kill(); } catch (_) {} });
        ws.on('error', () => { try { proc.kill(); } catch (_) {} });
        return;
    }

    let proc;
    try { proc = require('child_process').spawn(shell, ['-l'], { cwd: WORKSPACE, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (err) { try { ws.send('\r\n[spawn failed: ' + redact(err.message) + ']\r\n'); } catch (_) {} try { ws.close(); } catch (_) {} return; }
    try { ws.send('\r\n\x1b[33m[note] node-pty not available — pipe mode\r\n\x1b[0m'); } catch (_) {}
    proc.stdout.on('data', (d) => { try { ws.send(d.toString('utf8')); } catch (_) {} });
    proc.stderr.on('data', (d) => { try { ws.send(d.toString('utf8')); } catch (_) {} });
    proc.on('exit', (code) => { try { ws.send('\r\n[process exited: ' + code + ']\r\n'); } catch (_) {} try { ws.close(); } catch (_) {} });
    ws.on('message', (raw) => {
        const msg = raw.toString('utf8');
        if (msg.startsWith('{')) {
            try { const parsed = JSON.parse(msg); if (parsed.type === 'input' && proc.stdin.writable) return proc.stdin.write(parsed.data); } catch (_) {}
        }
        if (proc.stdin.writable) proc.stdin.write(msg);
    });
    ws.on('close', () => { try { proc.kill('SIGTERM'); } catch (_) {} });
    ws.on('error', () => { try { proc.kill('SIGKILL'); } catch (_) {} });
});

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[' + signal + '] shutting down…');
    try { wss.close(); } catch (_) {}
    server.close(() => { console.log('closed.'); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => { console.error('[uncaughtException]', redact(err && err.message)); if (err && err.stack) console.error(redact(err.stack)); });
process.on('unhandledRejection', (reason) => { console.error('[unhandledRejection]', redact(reason && reason.message ? reason.message : reason)); });
server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error('\n✗ Port ' + PORT + ' in use. Stop with: pkill -f "node server.js"\n');
    } else console.error('\n✗ Server error:', err && err.message ? err.message : err);
    process.exit(1);
});
server.listen(PORT, HOST, () => {
    const line = '─'.repeat(50);
    console.log('');
    console.log('  DeepSeek Studio v' + PKG_VERSION);
    console.log(line);
    console.log('  URL:        http://' + HOST + ':' + PORT);
    console.log('  Workspace:  ' + WORKSPACE);
    console.log('  Node:       ' + process.version);
    console.log('  Providers:  ' + (providerStatus().join(', ') || 'none — paste a key in Settings'));
    const ghSrc = resolveGhToken();
    console.log('  GitHub:     ' + (ghSrc.token ? 'connected (' + ghSrc.label + ')' : 'not connected'));
    console.log('  Terminal:   ' + (pty ? 'node-pty (real TTY)' : 'pipe fallback'));
    console.log(line);
    console.log('');
});
module.exports = app;
