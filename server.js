#!/usr/bin/env node
/**
 * DeepSeek Studio — Backend v2
 * ─────────────────────────────────────────────────────────────────────
 * Local-first coding backend for Termux (Android). Serves the SPA in
 * ./public, exposes a filesystem + git + GitHub API, a PTY-over-WebSocket
 * terminal, and a provider-agnostic AI proxy.
 *
 * v2 upgrades:
 *   • simple-git    — fluent, structured, promise-based git ops
 *   • @octokit/rest — typed GitHub API with pagination + rate-limit awareness
 *   • node-pty      — real PTY (vim / htop / interactive TUIs now work)
 *   • editkit       — Aider-style fuzzy SEARCH/REPLACE matching
 *
 * Every optional library is loaded defensively: if it's missing, the
 * server logs a warning and falls back to the original code path. Nothing
 * hard-fails.
 *
 * Security: git tokens pass through an ephemeral GIT_ASKPASS helper so they
 * never land in .git/config, argv, or `ps` output. All provider keys stay
 * server-side and are redacted from every log line and error response.
 */

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

/* ─── Optional libraries (graceful fallback) ─── */
let simpleGitFactory = null;
try {
    const sg = require('simple-git');
    simpleGitFactory = typeof sg === 'function' ? sg : (sg.simpleGit || sg.default);
    if (typeof simpleGitFactory !== 'function') simpleGitFactory = null;
} catch (_) { console.warn('[deps] simple-git not available — using execFile git'); }

let OctokitLib = null;
try { OctokitLib = require('@octokit/rest').Octokit; } catch (_) {
    console.warn('[deps] @octokit/rest not available — using fetch-based GitHub API');
}

let ptyLib = null;
try { ptyLib = require('node-pty'); } catch (_) {
    console.warn('[deps] node-pty not available — using pipe fallback (no TTY)');
}

let editkitLib = null;
try { editkitLib = require('editkit'); } catch (_) {
    console.warn('[deps] editkit not available — using exact-match patch');
}

/* ─── Constants ─── */
const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const HOME = process.env.HOME || os.homedir();

const WORKSPACE = path.resolve(process.env.DS_WORKSPACE || path.join(HOME, 'deepseek-projects'));
const SD_CARD_ROOT = path.join(HOME, 'storage', 'external-1');
const SD_BACKUP = path.join(SD_CARD_ROOT, 'DeepSeekBackups');
const KEYSTORE_DIR = path.join(HOME, '.deepseek-keystores');
const LICENSE_FILE = path.join(HOME, '.deepseek-license');
const SECRETS_FILE = path.join(HOME, '.deepseek-secrets.json');
const ASKPASS_HELPER = path.join(HOME, '.deepseek-git-askpass.sh');
const TERMUX_BASH = '/data/data/com.termux/files/usr/bin/bash';

const PRO_LICENSE_PREFIX = 'DS-PRO-';
const PKG_VERSION = (() => {
    try { return require('./package.json').version; } catch (_) { return '0.0.0'; }
})();

/* ─── Directory setup ─── */
for (const dir of [WORKSPACE, KEYSTORE_DIR]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}
try {
    fs.writeFileSync(ASKPASS_HELPER,
        '#!/data/data/com.termux/files/usr/bin/sh\n' +
        '# Ephemeral git askpass helper — prints token from env,\n' +
        '# so it never appears in argv, .git/config, or ps output.\n' +
        'printf "%s\\n" "${GIT_ASKPASS_TOKEN:-}"\n', { mode: 0o700 });
    fs.chmodSync(ASKPASS_HELPER, 0o700);
} catch (_) {}

/* ─── Secret store (mode 0600) ─── */
function loadSecrets() {
    try {
        const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) { return {}; }
}
let secrets = loadSecrets();

function saveSecrets() {
    try {
        fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
        fs.chmodSync(SECRETS_FILE, 0o600);
    } catch (err) { console.error('[secrets] write failed:', err.message); }
}

function redact(input) {
    let out = String(input == null ? '' : input);
    for (const value of Object.values(secrets)) {
        if (typeof value === 'string' && value.length >= 8) out = out.split(value).join('***REDACTED***');
    }
    return out
        .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '***REDACTED***')
        .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '***REDACTED***')
        .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '***REDACTED***');
}

/* ─── Wake lock ─── */
try {
    require('child_process').execSync(
        'command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock',
        { timeout: 5000, stdio: 'ignore' });
    console.log('\uD83D\uDD12 Wake lock acquired');
} catch (_) {
    console.log('\u2139\uFE0F  Wake lock not available (run: pkg install termux-api)');
}

/* ─── Safety helpers ─── */
const BLOCKED_PATTERNS = [
    /rm\s+-rf\s+\/(?!(data\/data\/com\.termux|data\/data\/com\.termux\/files\/home))/,
    /\bsudo\b/, /\bmkfs\b/, /\bdd\s+if=\/dev\/(zero|random|urandom)/,
    /:\s*\(\)\s*\{.*\}\s*;\s*:/,
    />\s*\/dev\/(sd[a-z]|block\/)/,
    /\bchmod\s+-R\s+777\s+\//,
    /\bmv\s+\/\*\s+\/tmp/,
    /\bchown\s+-R\s+root/,
    /\b(shutdown|reboot|halt|poweroff)\b/,
];
function isCommandBlocked(cmd) {
    for (const p of BLOCKED_PATTERNS) if (p.test(cmd)) return p.source;
    return null;
}

function withinBase(base, resolved) {
    const b = path.resolve(base);
    const r = path.resolve(resolved);
    return r === b || r.startsWith(b + path.sep);
}

function resolveInWorkspace(rel, base = WORKSPACE) {
    const target = path.resolve(base, rel == null ? '' : String(rel));
    return withinBase(base, target) ? target : null;
}

/* ─── Express baseline ─── */
app.disable('x-powered-by');
app.use(cors({ origin: true }));
app.use(express.json({ limit: '25mb' }));
app.use((req, _res, next) => {
    if (req.body && typeof req.body === 'object') {
        for (const k of ['__proto__', 'constructor', 'prototype']) {
            if (Object.prototype.hasOwnProperty.call(req.body, k)) delete req.body[k];
        }
    }
    next();
});

/* ─── Rate limiting ─── */
const rateLimitMap = new Map();
const RATE_LIMIT_PER_MIN = parseInt(process.env.DS_RATE_LIMIT, 10) || 600;
const LONG_RUNNING = new Set([
    '/api/git/clone', '/api/git/push', '/api/git/pull', '/api/git/pull/rebase',
    '/api/git/fetch', '/api/exec', '/api/ai/chat', '/api/ai/tool-call',
    '/api/backup/restore', '/api/deploy/build', '/api/deploy/aab',
]);
app.use('/api/', (req, res, next) => {
    const ip = req.ip || 'local';
    const now = Date.now();
    const limit = LONG_RUNNING.has(req.path) ? Math.ceil(RATE_LIMIT_PER_MIN / 6) : RATE_LIMIT_PER_MIN;
    const w = rateLimitMap.get(ip) || { count: 0, reset: now + 60000 };
    if (now > w.reset) { w.count = 0; w.reset = now + 60000; }
    w.count++;
    rateLimitMap.set(ip, w);
    if (w.count > limit) return res.status(429).json({ error: 'Too many requests' });
    next();
});
setInterval(() => {
    const now = Date.now();
    for (const [ip, w] of rateLimitMap) if (now > w.reset) rateLimitMap.delete(ip);
}, 5 * 60 * 1000).unref();

/* ─── Low-level execFile helper (still used for keytool, sh, etc.) ─── */
function run(bin, argv, opts = {}) {
    return new Promise((resolve) => {
        execFile(bin, argv, {
            cwd: opts.cwd || WORKSPACE,
            timeout: opts.timeout || 30000,
            maxBuffer: opts.maxBuffer || 20 * 1024 * 1024,
            env: opts.env || process.env,
            windowsHide: true,
        }, (err, stdout, stderr) => {
            resolve({
                code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
                stdout: stdout || '', stderr: stderr || '', failed: !!err,
            });
        });
    });
}

/* ═══════════════════════════════════════════════════════════════════
   git: simple-git primary, execFile fallback
   ═══════════════════════════════════════════════════════════════════ */

const ghToken = () => String(secrets.github_token || '').trim();

/** Legacy git runner — used when simple-git isn't installed. */
async function gitLegacy(workdir, args, opts = {}) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (opts.token) {
        env.GIT_ASKPASS = ASKPASS_HELPER;
        env.GIT_ASKPASS_TOKEN = opts.token;
    } else {
        env.GIT_ASKPASS = 'echo';
    }
    const res = await run('git', args, { ...opts, cwd: workdir, env });
    res.stdout = redact(res.stdout);
    res.stderr = redact(res.stderr);
    return res;
}

/**
 * Build a simple-git instance for a workspace-relative dir.
 * Token is injected via GIT_ASKPASS so it never appears in argv or config.
 */
function getGit(relDir = '') {
    if (!simpleGitFactory) throw Object.assign(new Error('simple-git not installed'), { status: 500 });
    const workdir = resolveInWorkspace(relDir);
    if (!workdir) throw Object.assign(new Error('Forbidden'), { status: 403 });
    const token = ghToken();
    const g = simpleGitFactory({
        baseDir: workdir,
        binary: 'git',
        maxConcurrentProcesses: 4,
        trimmed: true,
    });
    return g.env({
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: token ? ASKPASS_HELPER : 'echo',
        ...(token ? { GIT_ASKPASS_TOKEN: token } : {}),
    });
}

function getOctokit() {
    if (!OctokitLib) return null;
    const token = ghToken();
    if (!token) return null;
    return new OctokitLib({ auth: token, userAgent: 'DeepSeek-Studio/' + PKG_VERSION });
}

/** Normalize any git op result into the { code, ok, stdout, stderr } shape. */
function gitOk(extra = {}) {
    return Object.assign({ code: 0, ok: true, stdout: '', stderr: '' }, extra);
}
function gitErr(err) {
    const msg = redact(err && err.message ? err.message : String(err));
    return {
        code: typeof (err && err.code) === 'number' ? err.code : 1,
        ok: false, stdout: '', stderr: msg, error: msg,
    };
}
/** Run a git op and always reply with the legacy shape. */
async function gitReply(res, fn) {
    try {
        const result = await fn();
        if (result && typeof result === 'object' && 'code' in result && 'ok' in result) {
            return res.json(result);
        }
        let stdout = '';
        if (typeof result === 'string') stdout = result;
        else if (result && typeof result === 'object') {
            if (result.stdout) stdout = result.stdout;
            else stdout = JSON.stringify(result);
        }
        res.json(gitOk({ stdout: redact(stdout) }));
    } catch (e) {
        res.status(e && e.status ? e.status : 500).json(gitErr(e));
    }
}

/* ─── fetch with timeout + retry ─── */
async function fetchWithRetry(url, options = {}, conf = {}) {
    const retries = conf.retries == null ? 2 : conf.retries;
    const timeout = conf.timeout || 120000;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
            clearTimeout(timer);
            if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
                await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
                continue;
            }
            return res;
        } catch (err) {
            clearTimeout(timer);
            lastErr = err;
            if (attempt < retries) {
                await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
                continue;
            }
        }
    }
    throw lastErr || new Error('Request failed');
}

/* ═══════════════════════════════════════════════════════════════════
   Observability
   ═══════════════════════════════════════════════════════════════════ */
app.get('/api/version', (_req, res) => {
    res.json({
        version: PKG_VERSION, node: process.version, uptime: process.uptime(),
        workspace: WORKSPACE, sdCard: fs.existsSync(SD_CARD_ROOT),
        providersConfigured: Object.keys(secrets).filter((k) => k.endsWith('_key')),
        hasGitHubToken: !!ghToken(),
        libs: {
            'simple-git': !!simpleGitFactory,
            '@octokit/rest': !!OctokitLib,
            'node-pty': !!ptyLib,
            'editkit': !!editkitLib,
        },
    });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/diagnostics', (_req, res) => {
    res.json({
        version: PKG_VERSION,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        uptime: Math.floor(process.uptime()),
        workspace: WORKSPACE,
        libs: {
            'simple-git': !!simpleGitFactory,
            '@octokit/rest': !!OctokitLib,
            'node-pty': !!ptyLib,
            'editkit': !!editkitLib,
        },
        features: {
            gitFluent: !!simpleGitFactory,
            githubOctokit: !!OctokitLib,
            realPty: !!ptyLib,
            fuzzyPatch: !!editkitLib,
        },
        secrets: Object.keys(secrets),
        hasGitHubToken: !!ghToken(),
    });
});

/* ═══════════════════════════════════════════════════════════════════
   Secrets API
   ═══════════════════════════════════════════════════════════════════ */
app.get('/api/secrets', (_req, res) => {
    const out = {};
    for (const [k, v] of Object.entries(secrets)) {
        out[k] = { configured: !!v, hint: v ? redact(v).slice(-4) : '' };
    }
    res.json(out);
});

app.post('/api/secrets', (req, res) => {
    const { name, value } = req.body || {};
    if (!name || !/^[a-z0-9_]{2,40}$/.test(name)) return res.status(400).json({ error: 'invalid secret name' });
    if (value === null || value === '' || typeof value === 'undefined') {
        delete secrets[name]; saveSecrets();
        return res.json({ ok: true, removed: true });
    }
    if (typeof value !== 'string' || value.length > 4000) return res.status(400).json({ error: 'invalid value' });
    secrets[name] = value.trim();
    saveSecrets();
    res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════════════
   Processes
   ═══════════════════════════════════════════════════════════════════ */
app.get('/api/processes', (_req, res) => {
    exec('ps -eo pid,comm,args --no-headers 2>/dev/null | head -40', { timeout: 5000 }, (err, stdout) => {
        if (err) return res.json({ processes: [] });
        const processes = String(stdout || '').split('\n').filter(Boolean).map((l) => {
            const parts = l.trim().split(/\s+/);
            return { pid: parts[0], command: parts.slice(2).join(' ').slice(0, 80) };
        }).filter((p) => p.pid && /^\d+$/.test(p.pid) && p.command);
        res.json({ processes });
    });
});

app.post('/api/processes/kill', (req, res) => {
    const pid = String((req.body || {}).pid || '');
    if (!/^\d+$/.test(pid)) return res.status(400).json({ error: 'invalid pid' });
    const n = parseInt(pid, 10);
    if (n === process.pid || n === 1) return res.status(403).json({ error: 'protected' });
    execFile('kill', ['-TERM', String(n)], (err) => {
        res.json({ ok: !err, error: err ? redact(err.message) : null });
    });
});

/* ═══════════════════════════════════════════════════════════════════
   Filesystem
   ═══════════════════════════════════════════════════════════════════ */
app.get('/api/fs/list', async (req, res) => {
    const target = resolveInWorkspace(req.query.path);
    if (!target) return res.status(403).json({ error: 'Forbidden' });
    try {
        const items = (await fsp.readdir(target, { withFileTypes: true }))
            .filter((d) => d.name !== '.gitkeep' && d.name !== '.git')
            .map((d) => ({
                name: d.name, isDir: d.isDirectory(),
                path: path.relative(WORKSPACE, path.join(target, d.name)).replace(/\\/g, '/'),
            }));
        items.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fs/read', async (req, res) => {
    const target = resolveInWorkspace(req.query.path);
    if (!target) return res.status(403).json({ error: 'Forbidden' });
    try {
        const stat = await fsp.stat(target);
        if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
        if (stat.size > 8 * 1024 * 1024) return res.status(413).json({ error: 'File too large (>8MB)' });
        res.json({ content: await fsp.readFile(target, 'utf8'), size: stat.size });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fs/write', async (req, res) => {
    const target = resolveInWorkspace((req.body || {}).path);
    if (!target) return res.status(403).json({ error: 'Forbidden' });
    try {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const content = req.body.content == null ? '' : String(req.body.content);
        await fsp.writeFile(target, content, 'utf8');
        res.json({ ok: true, bytes: Buffer.byteLength(content) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fs/delete', async (req, res) => {
    const target = resolveInWorkspace(req.query.path);
    if (!target) return res.status(403).json({ error: 'Forbidden' });
    if (target === WORKSPACE) return res.status(400).json({ error: 'Refusing to delete workspace root' });
    try { await fsp.rm(target, { recursive: true, force: true }); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fs/rename', async (req, res) => {
    const { oldPath, newPath } = req.body || {};
    if (!oldPath || !newPath) return res.status(400).json({ error: 'paths required' });
    const src = resolveInWorkspace(oldPath);
    const dst = resolveInWorkspace(newPath);
    if (!src || !dst) return res.status(403).json({ error: 'Forbidden' });
    try {
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.rename(src, dst);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════
   Shell exec
   ═══════════════════════════════════════════════════════════════════ */
app.post('/api/exec', (req, res) => {
    const { cmd, cwd } = req.body || {};
    if (!cmd || typeof cmd !== 'string') return res.status(400).json({ error: 'cmd required' });
    if (cmd.length > 8000) return res.status(413).json({ error: 'command too long' });
    const blocked = isCommandBlocked(cmd);
    if (blocked) return res.status(403).json({ error: 'Blocked: ' + blocked });
    const workdir = resolveInWorkspace(cwd || '');
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    exec(cmd, { cwd: workdir, timeout: 300000, maxBuffer: 20 * 1024 * 1024, shell: '/bin/sh' }, (err, stdout, stderr) => {
        res.json({
            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            stdout: redact(stdout || ''), stderr: redact(stderr || ''),
        });
    });
});

/* ═══════════════════════════════════════════════════════════════════
   AI tool calls
   ═══════════════════════════════════════════════════════════════════ */
function toolResult(res, ok, display, result) {
    return res.json({ ok: !!ok, display: display || '', result: result || {} });
}

/** Fuzzy patch via editkit, fallback to exact indexOf. */
function applyPatchSmart(original, search, replace, replaceAll) {
    if (editkitLib) {
        try {
            // editkit public API: attempt a tolerant search/replace
            const fn = editkitLib.applyEdits || editkitLib.applySearchReplace || editkitLib.patch;
            if (typeof fn === 'function') {
                const r = fn(original, search, replace, { replaceAll: replaceAll === true });
                if (r && typeof r === 'object' && 'ok' in r) {
                    if (r.ok) return { ok: true, content: r.content != null ? r.content : r.result, count: r.count || 1, fuzzy: !!r.fuzzy };
                    return { ok: false, error: r.error || 'editkit rejected the patch' };
                }
                if (typeof r === 'string') return { ok: true, content: r, count: 1, fuzzy: true };
            }
        } catch (e) {
            // fall through to exact match
        }
    }
    // Exact-match fallback
    let idx = 0, count = 0;
    while ((idx = original.indexOf(search, idx)) !== -1) { count++; idx += search.length; }
    if (count === 0) {
        const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
        if (norm(search) && norm(original).includes(norm(search))) {
            return { ok: false, error: 'whitespace mismatch — search matches only after normalization' };
        }
        return { ok: false, error: 'no match' };
    }
    if (count > 1 && replaceAll !== true) {
        return { ok: false, error: 'ambiguous (' + count + ' matches)', count };
    }
    const content = replaceAll === true ? original.split(search).join(replace) : original.replace(search, replace);
    return { ok: true, content, count: replaceAll === true ? count : 1, fuzzy: false };
}

app.post('/api/ai/tool-call', async (req, res) => {
    const { name, args } = req.body || {};
    if (!name) return res.status(400).json({ error: 'tool name required' });
    const a = args || {};
    try {
        switch (name) {
        case 'write_file': {
            const target = resolveInWorkspace(a.path);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            await fsp.mkdir(path.dirname(target), { recursive: true });
            const content = a.content == null ? '' : String(a.content);
            await fsp.writeFile(target, content, 'utf8');
            return toolResult(res, true, 'Wrote ' + Buffer.byteLength(content) + ' bytes to ' + a.path, { bytes: Buffer.byteLength(content) });
        }
        case 'read_file': {
            const target = resolveInWorkspace(a.path);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            if (!fs.existsSync(target)) return toolResult(res, false, 'Not found: ' + a.path, { error: 'not found' });
            const content = await fsp.readFile(target, 'utf8');
            return toolResult(res, true, 'Read ' + content.length + ' bytes', { content: content.slice(0, 20000), truncated: content.length > 20000 });
        }
        case 'list_files': {
            const target = resolveInWorkspace(a.path || '');
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            if (!fs.existsSync(target)) return toolResult(res, false, 'Not found: ' + a.path, { error: 'not found' });
            const items = (await fsp.readdir(target, { withFileTypes: true }))
                .filter((d) => d.name !== '.gitkeep' && d.name !== '.git')
                .map((d) => (d.isDirectory() ? '[dir] ' : '[file] ') + d.name);
            return toolResult(res, true, 'Listed ' + items.length + ' items', { items });
        }
        case 'create_folder': {
            const target = resolveInWorkspace(a.path);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            await fsp.mkdir(target, { recursive: true });
            return toolResult(res, true, 'Created: ' + a.path, { ok: true });
        }
        case 'delete_file': {
            const target = resolveInWorkspace(a.path);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            if (target === WORKSPACE) return res.status(400).json({ error: 'refusing to delete workspace root' });
            if (!fs.existsSync(target)) return toolResult(res, false, 'Not found', { error: 'not found' });
            await fsp.rm(target, { recursive: true, force: true });
            return toolResult(res, true, 'Deleted: ' + a.path, { ok: true });
        }
        case 'apply_patch': {
            const target = resolveInWorkspace(a.path);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            if (!fs.existsSync(target)) return toolResult(res, false, 'File not found: ' + a.path + ' — use read_file or write_file first', { error: 'not found' });
            const search = a.search || '';
            const replace = a.replace == null ? '' : String(a.replace);
            if (!search) return res.status(400).json({ error: 'search string required' });
            const original = await fsp.readFile(target, 'utf8');
            const r = applyPatchSmart(original, search, replace, a.replace_all === true);
            if (!r.ok) return toolResult(res, false, 'Patch failed: ' + r.error, { error: r.error, count: r.count });
            await fsp.writeFile(target, r.content, 'utf8');
            const label = r.fuzzy ? ' (fuzzy)' : '';
            return toolResult(res, true, 'Patched ' + a.path + label + ' (' + r.count + ' replacement' + (r.count === 1 ? '' : 's') + ')', { replacements: r.count, fuzzy: r.fuzzy });
        }
        case 'grep_search': {
            const base = resolveInWorkspace(a.path || '');
            if (!base) return res.status(403).json({ error: 'outside workspace' });
            const pattern = a.pattern || '';
            if (!pattern) return res.status(400).json({ error: 'pattern required' });
            let re;
            try { re = new RegExp(pattern, a.ignoreCase ? 'i' : ''); }
            catch (e) { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), a.ignoreCase ? 'i' : ''); }
            const skip = new Set(['node_modules', '.git', 'build', 'dist', '.dart_tool', '.next', '.gradle']);
            const matches = [];
            const maxHits = 60;
            const walk = (dir, depth) => {
                if (matches.length >= maxHits || depth > 8) return;
                let entries;
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
                for (const e of entries) {
                    if (matches.length >= maxHits) return;
                    if (skip.has(e.name)) continue;
                    const full = path.join(dir, e.name);
                    if (e.isDirectory()) { walk(full, depth + 1); continue; }
                    let st; try { st = fs.statSync(full); } catch (_) { continue; }
                    if (st.size > 2 * 1024 * 1024) continue;
                    let text; try { text = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
                    text.split('\n').forEach((line, i) => {
                        if (matches.length < maxHits && re.test(line)) {
                            matches.push(path.relative(WORKSPACE, full) + ':' + (i + 1) + ': ' + line.trim().slice(0, 160));
                        }
                    });
                }
            };
            walk(base, 0);
            return toolResult(res, matches.length > 0, 'Found ' + matches.length + ' match' + (matches.length === 1 ? '' : 'es'), { matches });
        }
        case 'find_files': {
            const base = resolveInWorkspace(a.path || '');
            if (!base) return res.status(403).json({ error: 'outside workspace' });
            const glob = String(a.pattern || '');
            const rx = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
            const skip = new Set(['node_modules', '.git', 'build', 'dist', '.dart_tool', '.next', '.gradle']);
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
            walk(base, 0);
            return toolResult(res, hits.length > 0, 'Found ' + hits.length + ' file' + (hits.length === 1 ? '' : 's'), { files: hits });
        }
        case 'run_command': {
            const cmd = a.command || '';
            if (!cmd) return res.status(400).json({ error: 'command required' });
            const blocked = isCommandBlocked(cmd);
            if (blocked) return res.status(403).json({ error: 'Blocked: ' + blocked });
            const cwd = resolveInWorkspace(a.cwd || '');
            if (!cwd) return res.status(403).json({ error: 'outside workspace' });
            const isBg = a.background === true;
            const timeout = isBg ? 3000 : 120000;
            return exec(cmd, { cwd, timeout, maxBuffer: 20 * 1024 * 1024, shell: '/bin/sh' }, (err, stdout, stderr) => {
                if (isBg && err && err.killed) {
                    return toolResult(res, true, 'Started bg: ' + cmd.slice(0, 60), { background: true });
                }
                const output = redact((stdout || '') + (stderr ? '\n' + stderr : ''));
                const trimmed = output.length > 6000 ? output.slice(0, 6000) + '\n...(truncated)' : output;
                toolResult(res, !err, 'Ran: ' + cmd.slice(0, 60) + (err ? ' (exit ' + (err.code || '?') + ')' : ' ok'), { code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: trimmed });
            });
        }
        case 'notify': {
            const rawTitle = String((a.title || 'DeepSeek Studio')).slice(0, 100);
            const rawMsg = String((a.message || '')).slice(0, 400);
            const esc = (s) => String(s).replace(/'/g, "'\\''");
            const cmd = 'termux-notification --title ' + "'" + esc(rawTitle) + "'" + ' --content ' + "'" + esc(rawMsg) + "'" + ' --priority high --vibrate 300 2>&1';
            return exec(cmd, { timeout: 5000 }, (err) => {
                toolResult(res, !err, err ? 'Notification failed — is termux-api installed?' : 'Notified: ' + rawTitle, { ok: !err });
            });
        }
        default:
            return res.status(400).json({ error: 'Unknown tool: ' + name });
        }
    } catch (e) {
        res.status(500).json({ error: redact(e.message) });
    }
});

/* ═══════════════════════════════════════════════════════════════════
   Language detection
   ═══════════════════════════════════════════════════════════════════ */
app.get('/api/detect-language', (req, res) => {
    const dir = resolveInWorkspace(req.query.path || '');
    if (!dir) return res.status(403).json({ error: 'Forbidden' });
    const checks = [
        { file: 'pubspec.yaml', lang: 'flutter', build: 'flutter build apk --debug', run: 'flutter run' },
        { file: 'build.gradle.kts', lang: 'kotlin', build: './gradlew build', run: './gradlew run' },
        { file: 'build.gradle', lang: 'java-gradle', build: './gradlew build', run: './gradlew run' },
        { file: 'pom.xml', lang: 'java-maven', build: 'mvn package', run: 'mvn exec:java' },
        { file: 'package.json', lang: 'node', build: 'npm install', run: 'npm start' },
        { file: 'requirements.txt', lang: 'python', build: 'pip install -r requirements.txt', run: 'python main.py' },
        { file: 'go.mod', lang: 'go', build: 'go build ./...', run: 'go run .' },
        { file: 'Cargo.toml', lang: 'rust', build: 'cargo build', run: 'cargo run' },
    ];
    for (const c of checks) {
        if (fs.existsSync(path.join(dir, c.file))) {
            return res.json({ language: c.lang, buildCommand: c.build, runCommand: c.run });
        }
    }
    res.json({ language: 'unknown', buildCommand: null, runCommand: null });
});

/* ═══════════════════════════════════════════════════════════════════
   Git endpoints — simple-git primary, legacy execFile fallback
   ═══════════════════════════════════════════════════════════════════ */

/* ── Status ── */
app.post('/api/git/status', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    const workdir = resolveInWorkspace(rel);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            const isRepo = await g.checkIsRepo().catch(() => false);
            if (!isRepo) return res.json({ isRepo: false });
            const [status, branch, remotes] = await Promise.all([
                g.status(),
                g.branchLocal().catch(() => ({ current: '' })),
                g.getRemotes(true).catch(() => []),
            ]);
            const changes = status.files.map((f) => f.path);
            const remoteLines = remotes.map((r) => r.name + '\t' + (r.refs && (r.refs.fetch || r.refs.push)) || '');
            return res.json({
                isRepo: true,
                branch: branch.current || '',
                changes,
                changeCount: changes.length,
                remote: remoteLines[0] || '',
            });
        }
        const inside = await gitLegacy(workdir, ['rev-parse', '--is-inside-work-tree']);
        if (inside.failed || !inside.stdout.includes('true')) return res.json({ isRepo: false });
        const [branch, status, remotes] = await Promise.all([
            gitLegacy(workdir, ['branch', '--show-current']),
            gitLegacy(workdir, ['status', '--porcelain']),
            gitLegacy(workdir, ['remote', '-v']),
        ]);
        const changes = status.stdout.split('\n').filter(Boolean);
        const remoteLines = remotes.stdout.split('\n').filter(Boolean);
        res.json({
            isRepo: true, branch: (branch.stdout || 'unknown').trim(), changes,
            changeCount: changes.length, remote: remoteLines[0] || '',
        });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

app.post('/api/git/status/detailed', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            const s = await g.status(['--porcelain=v1', '-uall']);
            const files = s.files.map((f) => ({
                status: (f.index || ' ') + (f.working_dir || ' '),
                path: f.path,
            }));
            return res.json({ files });
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['status', '--porcelain=v1', '-uall']);
        const files = r.stdout.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2), path: l.slice(3) }));
        res.json({ files, error: r.failed ? r.stderr : null });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

/* ── Log ── */
app.post('/api/git/log', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    const limit = Math.min(Math.max(parseInt((req.body || {}).limit, 10) || 10, 1), 200);
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            const log = await g.log({ maxCount: limit });
            return res.json({ log: log.all.map((c) => c.hash.slice(0, 7) + ' ' + c.message).join('\n') });
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['log', '--oneline', '-' + limit]);
        res.json({ log: r.stdout, error: r.failed ? r.stderr : null });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

app.post('/api/git/log/detailed', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    const limit = Math.min(Math.max(parseInt((req.body || {}).limit, 10) || 20, 1), 200);
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            const log = await g.log({ maxCount: limit, format: { hash: '%H', author: '%an', email: '%ae', when: '%ar', subject: '%s' } });
            const commits = log.all.map((c) => ({
                hash: c.hash, author: c.author, email: c.email,
                when: c.when, subject: c.subject,
                // Client may expect 'message' too:
                message: c.subject,
                date: c.when,
            }));
            return res.json({ commits });
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['log', '--pretty=format:%H%x1f%an%x1f%ae%x1f%ar%x1f%s', '-' + limit]);
        const commits = r.stdout.split('\n').filter(Boolean).map((line) => {
            const p = line.split('\x1f');
            return { hash: p[0], author: p[1], email: p[2], when: p[3], message: p[4], subject: p[4], date: p[3] };
        });
        res.json({ commits, error: r.failed ? r.stderr : null });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

app.post('/api/git/show', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    const hash = String((req.body || {}).hash || '');
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) return res.status(400).json({ error: 'invalid hash' });
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            const out = await g.show([hash, '--stat', '--patch']);
            return res.json({ output: out });
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['show', '--stat', '--patch', hash]);
        res.json({ output: r.stdout || r.stderr });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

/* ── Init / Clone ── */
app.post('/api/git/init', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    let branch = String((req.body || {}).branch || 'main');
    if (!/^[A-Za-z0-9._\/-]{1,80}$/.test(branch)) branch = 'main';
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            await g.init(['-b', branch]).catch(async () => { await g.init(); });
            return res.json(gitOk({ stdout: 'Initialized' }));
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        let r = await gitLegacy(workdir, ['init', '-b', branch]);
        if (r.failed) r = await gitLegacy(workdir, ['init']);
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/clone', async (req, res) => {
    const { url, dir } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) return res.status(400).json({ error: 'unsupported url scheme' });
    const fallbackName = url.split('/').pop().replace(/\.git$/, '').replace(/[^a-zA-Z0-9._-]/g, '_');
    const name = String(dir || fallbackName || 'repo');
    const target = resolveInWorkspace(name);
    if (!target || target === WORKSPACE) return res.status(403).json({ error: 'Forbidden' });
    if (fs.existsSync(target)) return res.status(400).json({ error: 'Directory exists: ' + name });

    const opts = {};
    if (/^https:\/\/(www\.)?github\.com\//i.test(url) && ghToken()) opts.token = ghToken();
    try {
        if (simpleGitFactory) {
            const g = simpleGitFactory({ baseDir: WORKSPACE });
            if (opts.token) {
                g.env({
                    GIT_TERMINAL_PROMPT: '0',
                    GIT_ASKPASS: ASKPASS_HELPER,
                    GIT_ASKPASS_TOKEN: opts.token,
                });
            } else {
                g.env({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' });
            }
            await g.clone(url, name, ['--progress']);
            return res.json(gitOk({ stdout: 'Cloned into ' + name, dir: name }));
        }
        const r = await gitLegacy(WORKSPACE, ['clone', '--progress', url, name], Object.assign({ timeout: 300000, maxBuffer: 30 * 1024 * 1024 }, opts));
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr, dir: name });
    } catch (e) {
        const err = gitErr(e);
        err.dir = name;
        res.status(500).json(err);
    }
});

/* ── Commit + push ── */
app.post('/api/git/push', async (req, res) => {
    const { cwd, message, commitOnly } = req.body || {};
    const rel = cwd || '';
    const msg = String(message || 'Update').slice(0, 2000);
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            await g.add(['-A']);
            let commitOut = '';
            let commitErr = '';
            try {
                const c = await g.commit(msg);
                commitOut = c.commit || 'committed';
            } catch (e) {
                commitErr = redact(e.message || String(e));
                if (!/nothing to commit|no changes added|no changes/i.test(commitErr)) {
                    return res.json({ code: 1, ok: false, stdout: commitOut, stderr: commitErr });
                }
            }
            if (commitOnly) return res.json(gitOk({ stdout: commitOut, stderr: commitErr }));
            const push = await g.push();
            const pushOut = JSON.stringify(push && push.pushed ? push.pushed : push || {});
            return res.json(gitOk({ stdout: commitOut + '\n' + pushOut, stderr: commitErr }));
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        await gitLegacy(workdir, ['add', '-A']);
        const commit = await gitLegacy(workdir, ['commit', '-m', msg], { timeout: 60000 });
        if (commitOnly) return res.json({ code: commit.code, ok: !commit.failed, stdout: commit.stdout, stderr: commit.stderr });
        if (commit.failed && !/nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)) {
            return res.json({ code: commit.code, ok: false, stdout: commit.stdout, stderr: commit.stderr });
        }
        const push = await gitLegacy(workdir, ['push'], { timeout: 180000, token: ghToken() || undefined });
        res.json({ code: push.code, ok: !push.failed, stdout: commit.stdout + push.stdout, stderr: commit.stderr + push.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/pull', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            try {
                const r = await g.pull(['--no-edit']);
                const out = JSON.stringify(r);
                return res.json(gitOk({ stdout: out, conflicted: /CONFLICT/.test(out) }));
            } catch (e) {
                const m = redact(e.message || String(e));
                return res.json({ code: 1, ok: false, conflicted: /CONFLICT/.test(m), stdout: '', stderr: m });
            }
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['pull', '--no-edit'], { timeout: 180000, token: ghToken() || undefined });
        res.json({
            code: r.code, ok: !r.failed && !/CONFLICT/.test(r.stdout + r.stderr),
            conflicted: /CONFLICT|Automatic merge failed/.test(r.stdout + r.stderr),
            stdout: r.stdout, stderr: r.stderr,
        });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/pull/rebase', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            const r = await g.pull(['--rebase', '--no-edit']);
            return res.json(gitOk({ stdout: JSON.stringify(r) }));
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['pull', '--rebase', '--no-edit'], { timeout: 180000, token: ghToken() || undefined });
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/fetch', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            const r = await g.fetch(['--all', '--prune']);
            return res.json(gitOk({ stdout: JSON.stringify(r) }));
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['fetch', '--all', '--prune'], { timeout: 180000, token: ghToken() || undefined });
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

/* ── Remotes ── */
app.post('/api/git/set-remote', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    const url = String((req.body || {}).url || '');
    if (!url || !/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) return res.status(400).json({ error: 'invalid url' });
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            await g.removeRemote('origin').catch(() => {});
            const r = await g.addRemote('origin', url);
            return res.json(gitOk({ stdout: r || 'remote set' }));
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        await gitLegacy(workdir, ['remote', 'remove', 'origin']);
        const r = await gitLegacy(workdir, ['remote', 'add', 'origin', url]);
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/remotes', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            const remotes = await g.getRemotes(true);
            return res.json({ remotes: remotes.map((r) => `${r.name}\t${r.refs && (r.refs.fetch || r.refs.push) || ''}`) });
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['remote', '-v']);
        res.json({ remotes: r.stdout.split('\n').filter(Boolean), error: r.failed ? r.stderr : null });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

app.post('/api/git/set-identity', async (req, res) => {
    const { name, email } = req.body || {};
    if (!name || !email) return res.status(400).json({ error: 'name and email required' });
    const n = String(name).slice(0, 100);
    const e = String(email).slice(0, 200);
    try {
        if (simpleGitFactory) {
            const g = simpleGitFactory({ baseDir: WORKSPACE });
            await g.addConfig('user.name', n);
            await g.addConfig('user.email', e);
            await g.addConfig('credential.helper', 'store');
            return res.json(gitOk({ stdout: 'Identity saved' }));
        }
        const r1 = await run('git', ['config', '--global', 'user.name', n], { timeout: 10000 });
        const r2 = await run('git', ['config', '--global', 'user.email', e], { timeout: 10000 });
        const r3 = await run('git', ['config', '--global', 'credential.helper', 'store'], { timeout: 10000 });
        res.json({
            code: (r1.failed || r2.failed || r3.failed) ? 1 : 0,
            stdout: (r1.stdout + r2.stdout + r3.stdout),
            stderr: redact(r1.stderr + r2.stderr + r3.stderr),
        });
    } catch (err) { res.status(500).json(gitErr(err)); }
});

/* ── Branches ── */
app.post('/api/git/branches', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            const [local, remote] = await Promise.all([
                g.branchLocal().catch(() => ({ all: [], current: '' })),
                g.branch(['-r']).catch(() => ({ all: [] })),
            ]);
            const remoteNames = remote.all.filter((b) => !b.includes('->') && b !== 'HEAD');
            return res.json({
                branches: [...new Set([...local.all, ...remoteNames])],
                current: local.current || '',
                local: local.all,
                remote: remoteNames,
            });
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['branch', '-a']);
        const cur = await gitLegacy(workdir, ['branch', '--show-current']);
        const all = r.stdout.split('\n').filter(Boolean).map((b) => b.replace(/^\*\s*/, '').trim());
        res.json({ branches: all, current: (cur.stdout || '').trim(), error: r.failed ? r.stderr : null });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

const validRef = (s) => typeof s === 'string' && s.length > 0 && s.length < 200 &&
    /^[A-Za-z0-9._\/-]+$/.test(s) && !s.includes('..') && !s.startsWith('-') && !s.endsWith('.lock');

app.post('/api/git/branch/create', async (req, res) => {
    const { cwd, name, checkout } = req.body || {};
    if (!validRef(name)) return res.status(400).json({ error: 'invalid branch name' });
    try {
        if (simpleGitFactory) {
            const g = getGit(cwd || '');
            if (checkout) await g.checkoutLocalBranch(name);
            else await g.raw(['branch', name]);
            return res.json(gitOk({ stdout: 'Branch created: ' + name }));
        }
        const workdir = resolveInWorkspace(cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = checkout ? await gitLegacy(workdir, ['checkout', '-b', name]) : await gitLegacy(workdir, ['branch', name]);
        res.json({ ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/branch/checkout', async (req, res) => {
    const { cwd, name } = req.body || {};
    if (!validRef(name)) return res.status(400).json({ error: 'invalid branch name' });
    try {
        if (simpleGitFactory) {
            const g = getGit(cwd || '');
            await g.checkout(name);
            return res.json(gitOk({ stdout: 'Switched to ' + name }));
        }
        const workdir = resolveInWorkspace(cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['checkout', name]);
        res.json({ ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/branch/delete', async (req, res) => {
    const { cwd, name, force } = req.body || {};
    if (!validRef(name)) return res.status(400).json({ error: 'invalid branch name' });
    try {
        if (simpleGitFactory) {
            const g = getGit(cwd || '');
            if (force === true) await g.raw(['branch', '-D', name]);
            else await g.deleteLocalBranch(name);
            return res.json(gitOk({ stdout: 'Branch deleted' }));
        }
        const workdir = resolveInWorkspace(cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const flag = force === true ? '-D' : '-d';
        const r = await gitLegacy(workdir, ['branch', flag, name]);
        res.json({ ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/branch/merge', async (req, res) => {
    const { cwd, source } = req.body || {};
    if (!validRef(source)) return res.status(400).json({ error: 'invalid source branch' });
    try {
        if (simpleGitFactory) {
            const g = getGit(cwd || '');
            try {
                const r = await g.merge([source, '--no-edit']);
                return res.json(gitOk({ stdout: r || 'merged', conflicted: /CONFLICT/.test(String(r)) }));
            } catch (e) {
                const m = redact(e.message || String(e));
                return res.json({ ok: false, conflicted: /CONFLICT/i.test(m), stdout: '', stderr: m, error: m });
            }
        }
        const workdir = resolveInWorkspace(cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['merge', source, '--no-edit']);
        const out = r.stdout + r.stderr;
        res.json({
            ok: !r.failed && !/CONFLICT/.test(out),
            conflicted: /CONFLICT|Automatic merge failed/.test(out),
            stdout: r.stdout, stderr: r.stderr,
        });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/merge/abort', async (req, res) => {
    try {
        if (simpleGitFactory) {
            const g = getGit((req.body || {}).cwd || '');
            await g.raw(['merge', '--abort']);
            return res.json(gitOk({ stdout: 'Merge aborted' }));
        }
        const workdir = resolveInWorkspace((req.body || {}).cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['merge', '--abort']);
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/conflicts', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            const out = await g.raw(['diff', '--name-only', '--diff-filter=U']);
            return res.json({ files: out.split('\n').filter(Boolean) });
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['diff', '--name-only', '--diff-filter=U']);
        res.json({ files: r.stdout.split('\n').filter(Boolean) });
    } catch (e) { res.status(500).json({ error: redact(e.message), files: [] }); }
});

/* ── Diff / Add / Reset / Stash ── */
app.post('/api/git/diff', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    const file = (req.body || {}).file;
    const fileSafe = file && typeof file === 'string' && !file.startsWith('-') ? file : null;
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            const [unstaged, staged] = await Promise.all([
                g.diff(fileSafe ? ['--', fileSafe] : []).catch(() => ''),
                g.diff(['--cached'].concat(fileSafe ? ['--', fileSafe] : [])).catch(() => ''),
            ]);
            return res.json({ unstaged, staged });
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const args = ['diff', '--no-color'];
        if (fileSafe) args.push('--', fileSafe);
        const unstaged = await gitLegacy(workdir, args);
        const stagedArgs = ['diff', '--cached', '--no-color'];
        if (fileSafe) stagedArgs.push('--', fileSafe);
        const staged = await gitLegacy(workdir, stagedArgs);
        res.json({ unstaged: unstaged.stdout, staged: staged.stdout, error: unstaged.failed ? unstaged.stderr : null });
    } catch (e) { res.status(500).json({ error: redact(e.message), unstaged: '', staged: '' }); }
});

app.post('/api/git/add', async (req, res) => {
    const { cwd, paths } = req.body || {};
    try {
        if (simpleGitFactory) {
            const g = getGit(cwd || '');
            if (Array.isArray(paths) && paths.length) {
                const safe = paths.filter((p) => typeof p === 'string' && !p.startsWith('-'));
                await g.add(safe);
            } else {
                await g.add(['-A']);
            }
            return res.json(gitOk({ stdout: 'staged' }));
        }
        const workdir = resolveInWorkspace(cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const args = ['add'];
        if (Array.isArray(paths) && paths.length) {
            for (const p of paths) { if (typeof p === 'string' && !p.startsWith('-')) args.push('--', p); }
        } else args.push('-A');
        const r = await gitLegacy(workdir, args, { timeout: 30000 });
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/reset', async (req, res) => {
    const { cwd, paths, hard, confirm } = req.body || {};
    if (hard === true && confirm !== true) return res.status(400).json({ error: 'hard reset requires confirm:true' });
    try {
        if (simpleGitFactory) {
            const g = getGit(cwd || '');
            if (hard === true) await g.raw(['reset', '--hard', 'HEAD']);
            else if (Array.isArray(paths) && paths.length) await g.raw(['reset', 'HEAD', '--'].concat(paths.filter((p) => typeof p === 'string' && !p.startsWith('-'))));
            else await g.raw(['reset', 'HEAD']);
            return res.json(gitOk({ stdout: 'reset' }));
        }
        const workdir = resolveInWorkspace(cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        let args;
        if (hard === true) args = ['reset', '--hard', 'HEAD'];
        else if (Array.isArray(paths) && paths.length) args = ['reset', 'HEAD', '--'].concat(paths.filter((p) => typeof p === 'string' && !p.startsWith('-')));
        else args = ['reset', 'HEAD'];
        const r = await gitLegacy(workdir, args, { timeout: 30000 });
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/stash', async (req, res) => {
    const { cwd, action, message, confirm } = req.body || {};
    if (action === 'clear' && confirm !== true) return res.status(400).json({ error: 'stash clear requires confirm:true' });
    try {
        if (simpleGitFactory) {
            const g = getGit(cwd || '');
            let out = '';
            switch (action) {
            case 'list': { const r = await g.stashList(); out = r.all.map((s) => s.hash + ' ' + s.message).join('\n'); break; }
            case 'pop': out = await g.stash(['pop']); break;
            case 'apply': out = await g.stash(['apply']); break;
            case 'drop': out = await g.stash(['drop']); break;
            case 'clear': out = await g.stash(['clear']); break;
            case 'push':
            default:
                out = await g.stash(message ? ['push', '-m', String(message).slice(0, 200)] : ['push']);
            }
            return res.json(gitOk({ stdout: out || '(done)' }));
        }
        const workdir = resolveInWorkspace(cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        let args;
        switch (action) {
        case 'list': args = ['stash', 'list']; break;
        case 'pop': args = ['stash', 'pop']; break;
        case 'apply': args = ['stash', 'apply']; break;
        case 'drop': args = ['stash', 'drop']; break;
        case 'clear': args = ['stash', 'clear']; break;
        case 'push': args = ['stash', 'push']; if (message) args.push('-m', String(message).slice(0, 200)); break;
        default: args = ['stash']; break;
        }
        const r = await gitLegacy(workdir, args, { timeout: 30000 });
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/cherry-pick', async (req, res) => {
    const { cwd, hash } = req.body || {};
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) return res.status(400).json({ error: 'invalid hash' });
    try {
        if (simpleGitFactory) {
            const g = getGit(cwd || '');
            await g.raw(['cherry-pick', hash]);
            return res.json(gitOk({ stdout: 'cherry-picked' }));
        }
        const workdir = resolveInWorkspace(cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['cherry-pick', hash], { timeout: 60000 });
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/revert', async (req, res) => {
    const { cwd, hash } = req.body || {};
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) return res.status(400).json({ error: 'invalid hash' });
    try {
        if (simpleGitFactory) {
            const g = getGit(cwd || '');
            await g.raw(['revert', '--no-edit', hash]);
            return res.json(gitOk({ stdout: 'reverted' }));
        }
        const workdir = resolveInWorkspace(cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['revert', '--no-edit', hash], { timeout: 60000 });
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/tags', async (req, res) => {
    const { cwd, action, name, message } = req.body || {};
    try {
        if (simpleGitFactory) {
            const g = getGit(cwd || '');
            if (action === 'list' || !action) {
                const tags = await g.tags();
                return res.json({ tags: tags.all });
            }
            if (action === 'create') {
                if (!validRef(name)) return res.status(400).json({ error: 'invalid tag name' });
                await g.addAnnotatedTag(name, String(message || name).slice(0, 200));
                return res.json(gitOk({ stdout: 'tag ' + name + ' created' }));
            }
            if (action === 'push') {
                await g.pushTags();
                return res.json(gitOk({ stdout: 'tags pushed' }));
            }
            if (action === 'delete') {
                if (!validRef(name)) return res.status(400).json({ error: 'invalid tag name' });
                await g.tag(['-d', name]);
                return res.json(gitOk({ stdout: 'tag deleted' }));
            }
            return res.status(400).json({ error: 'unknown action' });
        }
        const workdir = resolveInWorkspace(cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        if (action === 'list' || !action) {
            const r = await gitLegacy(workdir, ['tag', '--sort=-creatordate']);
            return res.json({ tags: r.stdout.split('\n').filter(Boolean) });
        }
        if (action === 'create') {
            if (!validRef(name)) return res.status(400).json({ error: 'invalid tag name' });
            const r = await gitLegacy(workdir, ['tag', '-a', name, '-m', String(message || name).slice(0, 200)]);
            return res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
        }
        if (action === 'push') {
            const r = await gitLegacy(workdir, ['push', '--tags'], { timeout: 120000, token: ghToken() || undefined });
            return res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
        }
        if (action === 'delete') {
            if (!validRef(name)) return res.status(400).json({ error: 'invalid tag name' });
            const r = await gitLegacy(workdir, ['tag', '-d', name]);
            return res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
        }
        res.status(400).json({ error: 'unknown action' });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/undo', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            await g.raw(['reset', '--soft', 'HEAD~1']);
            return res.json(gitOk({ stdout: 'reverted last commit (soft)' }));
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['reset', '--soft', 'HEAD~1'], { timeout: 30000 });
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/auto-init', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    const workdir = resolveInWorkspace(rel);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    if (fs.existsSync(path.join(workdir, '.git'))) return res.json(gitOk({ stdout: 'already a repo' }));
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            await g.init(['-b', 'main']).catch(async () => { await g.init(); });
            return res.json(gitOk({ stdout: 'initialized' }));
        }
        let r = await gitLegacy(workdir, ['init', '-b', 'main']);
        if (r.failed) r = await gitLegacy(workdir, ['init']);
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/auto-commit', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    const workdir = resolveInWorkspace(rel);
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    if (!fs.existsSync(path.join(workdir, '.git'))) return res.json({ code: 1, ok: false, stderr: 'not a git repo' });
    const file = (req.body || {}).file;
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const label = file ? 'Update ' + path.basename(file) : 'Auto-commit';
    const message = label + ' ' + stamp;
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            if (file && typeof file === 'string' && !file.startsWith('-')) await g.add(['--', file]);
            else await g.add(['-A']);
            try { const c = await g.commit(message); return res.json(gitOk({ stdout: c.commit || 'auto-committed' })); }
            catch (e) { return res.json({ code: 1, ok: false, stdout: '', stderr: redact(e.message) }); }
        }
        if (file && typeof file === 'string' && !file.startsWith('-')) await gitLegacy(workdir, ['add', '--', file]);
        else await gitLegacy(workdir, ['add', '-A']);
        const r = await gitLegacy(workdir, ['commit', '-m', message], { timeout: 60000 });
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

/* ═══════════════════════════════════════════════════════════════════
   GitHub REST API — Octokit primary, fetch fallback
   ═══════════════════════════════════════════════════════════════════ */
async function githubApi(pathname, options = {}) {
    const token = ghToken();
    if (!token) return { ok: false, status: 401, data: { message: 'No GitHub token configured' } };
    const headers = Object.assign({
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'DeepSeek-Studio/' + PKG_VERSION,
    }, options.headers || {});
    const res = await fetchWithRetry('https://api.github.com' + pathname, Object.assign({}, options, { headers }), { retries: 1, timeout: 30000 });
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
}

app.get('/api/github/status', async (_req, res) => {
    const gh = getOctokit();
    if (gh) {
        try {
            const { data } = await gh.users.getAuthenticated();
            return res.json({
                connected: true, login: data.login, name: data.name,
                avatar: data.avatar_url, publicRepos: data.public_repos,
            });
        } catch (e) { return res.json({ connected: false, error: redact(e.message) }); }
    }
    if (!ghToken()) return res.json({ connected: false });
    const r = await githubApi('/user');
    if (!r.ok) return res.json({ connected: false, error: r.data && r.data.message });
    res.json({ connected: true, login: r.data.login, name: r.data.name, avatar: r.data.avatar_url, publicRepos: r.data.public_repos });
});

app.get('/api/github/repos', async (req, res) => {
    const perPage = Math.min(Math.max(parseInt(req.query.per_page, 10) || 30, 1), 100);
    const gh = getOctokit();
    if (gh) {
        try {
            const { data } = await gh.repos.listForAuthenticatedUser({ sort: 'updated', per_page: perPage });
            return res.json({ repos: data.map((repo) => ({
                name: repo.name, fullName: repo.full_name, private: repo.private,
                cloneUrl: repo.clone_url, sshUrl: repo.ssh_url, defaultBranch: repo.default_branch,
                updatedAt: repo.updated_at, description: repo.description,
            })) });
        } catch (e) { return res.status(e.status || 500).json({ error: redact(e.message) }); }
    }
    const r = await githubApi('/user/repos?sort=updated&per_page=' + perPage);
    if (!r.ok) return res.status(r.status).json({ error: (r.data && r.data.message) || 'GitHub request failed' });
    res.json({ repos: (r.data || []).map((repo) => ({
        name: repo.name, fullName: repo.full_name, private: repo.private,
        cloneUrl: repo.clone_url, sshUrl: repo.ssh_url, defaultBranch: repo.default_branch,
        updatedAt: repo.updated_at, description: repo.description,
    })) });
});

app.post('/api/github/create-repo', async (req, res) => {
    const { name, description, isPrivate, autoInit } = req.body || {};
    if (!name || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) return res.status(400).json({ error: 'invalid repo name' });
    const gh = getOctokit();
    if (gh) {
        try {
            const { data } = await gh.repos.createForAuthenticatedUser({
                name, description: description || '', private: isPrivate !== false, auto_init: autoInit === true,
            });
            return res.json({ ok: true, repo: { fullName: data.full_name, cloneUrl: data.clone_url, sshUrl: data.ssh_url, defaultBranch: data.default_branch } });
        } catch (e) { return res.status(e.status || 500).json({ error: redact(e.message) }); }
    }
    const r = await githubApi('/user/repos', {
        method: 'POST',
        body: JSON.stringify({ name, description: description || '', private: isPrivate !== false, auto_init: autoInit === true }),
    });
    if (!r.ok) return res.status(r.status).json({ error: (r.data && r.data.message) || 'create failed' });
    res.json({ ok: true, repo: { fullName: r.data.full_name, cloneUrl: r.data.clone_url, sshUrl: r.data.ssh_url, defaultBranch: r.data.default_branch } });
});

function parseRepoSlug(remoteUrl) {
    const m = String(remoteUrl || '').match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/i);
    return m ? (m[1] + '/' + m[2]) : null;
}

app.post('/api/github/open-pr', async (req, res) => {
    const { cwd, title, body, base, head, draft } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    try {
        const g = getGit(cwd || '');
        const remoteUrl = (await g.remote(['get-url', 'origin'])) || '';
        const slug = parseRepoSlug(remoteUrl.trim());
        if (!slug) return res.status(400).json({ error: 'origin is not a GitHub remote' });
        const [owner, repo] = slug.split('/');
        const branchLocal = await g.branchLocal();
        const headBranch = head || branchLocal.current;
        if (!validRef(headBranch)) return res.status(400).json({ error: 'invalid head branch' });
        await g.push(['-u', 'origin', headBranch]).catch(() => {});
        const gh = getOctokit();
        if (gh) {
            const { data } = await gh.pulls.create({
                owner, repo, title, body: body || '', base: base || 'main', head: headBranch, draft: draft === true,
            });
            return res.json({ ok: true, number: data.number, url: data.html_url });
        }
        const r = await githubApi('/repos/' + slug + '/pulls', {
            method: 'POST',
            body: JSON.stringify({ title, body: body || '', base: base || 'main', head: headBranch, draft: draft === true }),
        });
        if (!r.ok) return res.status(r.status).json({ error: (r.data && r.data.message) || 'PR failed' });
        res.json({ ok: true, number: r.data.number, url: r.data.html_url });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

app.post('/api/github/list-prs', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    const state = (req.body || {}).state || 'open';
    try {
        const g = getGit(rel);
        const remoteUrl = (await g.remote(['get-url', 'origin'])) || '';
        const slug = parseRepoSlug(remoteUrl.trim());
        if (!slug) return res.status(400).json({ error: 'origin is not a GitHub remote' });
        const [owner, repo] = slug.split('/');
        const gh = getOctokit();
        if (gh) {
            const { data } = await gh.pulls.list({ owner, repo, state, per_page: 30 });
            return res.json({ prs: data.map((pr) => ({ number: pr.number, title: pr.title, state: pr.state, url: pr.html_url, head: pr.head.ref, base: pr.base.ref, user: pr.user && pr.user.login })) });
        }
        const r = await githubApi('/repos/' + slug + '/pulls?state=' + state + '&per_page=30');
        if (!r.ok) return res.status(r.status).json({ error: (r.data && r.data.message) || 'failed' });
        res.json({ prs: (r.data || []).map((pr) => ({ number: pr.number, title: pr.title, state: pr.state, url: pr.html_url, head: pr.head.ref, base: pr.base.ref, user: pr.user && pr.user.login })) });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

/* ═══════════════════════════════════════════════════════════════════
   AI proxy
   ═══════════════════════════════════════════════════════════════════ */
const AI_PROVIDERS = {
    deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', keyName: 'deepseek_key', supportsTools: true },
    openai: { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', keyName: 'openai_key', supportsTools: true },
    openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', model: 'deepseek/deepseek-chat', keyName: 'openrouter_key', supportsTools: true },
    groq: { url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', keyName: 'groq_key', supportsTools: true },
    gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-1.5-flash', keyName: 'gemini_key', supportsTools: true },
};

function resolveProvider(name) {
    const id = String(name || 'deepseek').toLowerCase();
    const cfg = AI_PROVIDERS[id];
    if (!cfg) return null;
    const key = String(secrets[cfg.keyName] || '').trim();
    return { id, cfg, key, configured: !!key };
}

app.get('/api/ai/providers', (_req, res) => {
    res.json(Object.entries(AI_PROVIDERS).map(([id, cfg]) => ({
        id, model: cfg.model, supportsTools: cfg.supportsTools,
        configured: !!String(secrets[cfg.keyName] || '').trim(),
    })));
});

app.post('/api/ai/chat', async (req, res) => {
    const { provider, messages, tools, toolChoice, model, temperature, maxTokens, stream } = req.body || {};
    const p = resolveProvider(provider);
    if (!p) return res.status(400).json({ error: 'Unknown provider' });
    if (!p.configured) return res.status(400).json({ error: 'No API key configured for ' + p.id });

    const payload = {
        model: model || p.cfg.model,
        messages: Array.isArray(messages) ? messages : [],
        temperature: typeof temperature === 'number' ? temperature : 0.3,
        max_tokens: typeof maxTokens === 'number' ? maxTokens : 4096,
    };
    if (Array.isArray(tools) && tools.length && p.cfg.supportsTools) {
        payload.tools = tools;
        payload.tool_choice = toolChoice || 'auto';
    }

    let upstream;
    try {
        upstream = await fetchWithRetry(p.cfg.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.key },
            body: JSON.stringify(payload),
        }, { retries: 2, timeout: 180000 });
    } catch (err) {
        return res.status(502).json({ error: 'Upstream unreachable: ' + redact(err.message) });
    }

    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return res.status(upstream.status).json({ error: 'Provider error ' + upstream.status, detail: redact(text).slice(0, 500) });
    }

    if (stream === true && upstream.body) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        try { for await (const chunk of upstream.body) res.write(chunk); }
        catch (err) { res.write('data: ' + JSON.stringify({ error: redact(err.message) }) + '\n\n'); }
        return res.end();
    }

    const data = await upstream.json();
    res.json(data);
});

app.post('/api/ai/stream', async (req, res) => {
    req.body = Object.assign({}, req.body, { stream: true });
    const { provider, messages, tools, toolChoice, model, temperature, maxTokens } = req.body || {};
    const p = resolveProvider(provider);
    if (!p || !p.configured) return res.status(400).json({ error: 'Provider not configured' });
    const payload = {
        model: model || p.cfg.model,
        messages: Array.isArray(messages) ? messages : [],
        temperature: typeof temperature === 'number' ? temperature : 0.3,
        max_tokens: typeof maxTokens === 'number' ? maxTokens : 4096,
        stream: true,
    };
    if (Array.isArray(tools) && tools.length && p.cfg.supportsTools) {
        payload.tools = tools; payload.tool_choice = toolChoice || 'auto';
    }
    let upstream;
    try {
        upstream = await fetchWithRetry(p.cfg.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.key },
            body: JSON.stringify(payload),
        }, { retries: 1, timeout: 180000 });
    } catch (err) { return res.status(502).json({ error: redact(err.message) }); }
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Provider error ' + upstream.status });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    try { for await (const chunk of upstream.body) res.write(chunk); }
    catch (err) { res.write('data: ' + JSON.stringify({ error: redact(err.message) }) + '\n\n'); }
    res.end();
});

app.post('/api/ai/test-key', async (req, res) => {
    const p = resolveProvider((req.body || {}).provider);
    if (!p) return res.status(400).json({ error: 'Unknown provider' });
    if (!p.configured) return res.status(400).json({ error: 'No key configured' });
    try {
        const r = await fetchWithRetry(p.cfg.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.key },
            body: JSON.stringify({ model: p.cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
        }, { retries: 0, timeout: 30000 });
        if (!r.ok) return res.json({ ok: false, status: r.status });
        res.json({ ok: true, model: p.cfg.model });
    } catch (err) { res.json({ ok: false, error: redact(err.message) }); }
});

/* ═══════════════════════════════════════════════════════════════════
   Backup
   ═══════════════════════════════════════════════════════════════════ */
app.post('/api/backup/create', async (_req, res) => {
    try {
        if (!fs.existsSync(SD_CARD_ROOT)) return res.status(400).json({ error: 'SD card not mounted' });
        await fsp.mkdir(SD_BACKUP, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        const dest = path.join(SD_BACKUP, stamp);
        await fsp.mkdir(dest, { recursive: true });
        const r = await run('sh', ['-c', 'cp -r "$1"/. "$2"/ 2>&1', 'sh', WORKSPACE, dest], { timeout: 300000 });
        if (r.failed) return res.status(500).json({ error: r.stderr || r.stdout });
        res.json({ ok: true, name: stamp });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/backup/list', (_req, res) => {
    try {
        if (!fs.existsSync(SD_BACKUP)) return res.json({ backups: [], available: false });
        const backups = fs.readdirSync(SD_BACKUP, { withFileTypes: true })
            .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(d.name))
            .map((d) => {
                const dir = path.join(SD_BACKUP, d.name);
                let fileCount = 0, sizeBytes = 0;
                const walk = (p) => {
                    let entries; try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return; }
                    for (const e of entries) {
                        if (e.name === '.gitkeep') continue;
                        const full = path.join(p, e.name);
                        try {
                            const st = fs.statSync(full);
                            if (st.isDirectory()) walk(full);
                            else { fileCount++; sizeBytes += st.size; }
                        } catch (_) {}
                    }
                };
                walk(dir);
                const sizeStr = sizeBytes < 1024 ? sizeBytes + ' B'
                    : sizeBytes < 1024 * 1024 ? (sizeBytes / 1024).toFixed(1) + ' KB'
                    : (sizeBytes / 1024 / 1024).toFixed(1) + ' MB';
                return { name: d.name, files: fileCount, size: sizeStr };
            })
            .sort((a, b) => b.name.localeCompare(a.name));
        res.json({ backups, available: true });
    } catch (err) { res.status(500).json({ error: err.message, backups: [], available: false }); }
});

app.post('/api/backup/restore', async (req, res) => {
    const { name, confirm } = req.body || {};
    if (!name || !/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(name)) return res.status(400).json({ error: 'invalid name' });
    if (confirm !== true) return res.status(400).json({ error: 'restore requires confirm:true' });
    const src = path.join(SD_BACKUP, name);
    if (!withinBase(SD_BACKUP, src) || !fs.existsSync(src)) return res.status(404).json({ error: 'backup not found' });
    const r = await run('sh', ['-c', 'rm -rf "$1"/* "$1"/.[!.]* 2>/dev/null; cp -r "$2"/. "$1"/ 2>&1', 'sh', WORKSPACE, src], { timeout: 300000 });
    if (r.failed) return res.status(500).json({ error: r.stderr || r.stdout });
    res.json({ ok: true });
});

app.delete('/api/backup/delete', async (req, res) => {
    const name = req.query.name;
    if (!name || !/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(name)) return res.status(400).json({ error: 'invalid name' });
    const dir = path.join(SD_BACKUP, name);
    if (!withinBase(SD_BACKUP, dir)) return res.status(403).json({ error: 'Forbidden' });
    try { await fsp.rm(dir, { recursive: true, force: true }); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════
   Deploy
   ═══════════════════════════════════════════════════════════════════ */
function detectAndroidProject(dir) {
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { return null; }
    if (files.includes('pubspec.yaml')) return 'flutter';
    if (files.includes('build.gradle') || files.includes('build.gradle.kts')) return 'android';
    if (files.includes('package.json')) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            if (pkg.dependencies && pkg.dependencies['react-native']) return 'react-native';
        } catch (_) {}
    }
    return null;
}

app.get('/api/deploy/check-tools', async (_req, res) => {
    const probe = async (cmd) => {
        const r = await run('sh', ['-c', cmd], { timeout: 15000 });
        return !r.failed && !r.stdout.includes('MISSING');
    };
    const [java, gradle, flutter, keytool] = await Promise.all([
        probe('java -version 2>&1 || echo MISSING'),
        probe('command -v gradle >/dev/null 2>&1 && gradle -v >/dev/null 2>&1 || echo MISSING'),
        probe('command -v flutter >/dev/null 2>&1 || echo MISSING'),
        probe('command -v keytool >/dev/null 2>&1 || echo MISSING'),
    ]);
    res.json({ java, gradle, flutter, keytool, androidSdk: !!(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT) });
});

app.post('/api/deploy/create-keystore', async (req, res) => {
    const { projectName, password, alias, dname } = req.body || {};
    if (!projectName || !password) return res.status(400).json({ error: 'projectName and password required' });
    const safeName = String(projectName).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    const keystorePath = path.join(KEYSTORE_DIR, safeName + '.jks');
    if (!withinBase(KEYSTORE_DIR, keystorePath)) return res.status(403).json({ error: 'Forbidden' });
    if (fs.existsSync(keystorePath)) return res.status(400).json({ error: 'Keystore exists: ' + safeName });
    const aliasName = String(alias || safeName).replace(/[^a-zA-Z0-9_-]/g, '_');
    const dnameStr = dname || 'CN=DeepSeek Studio, OU=Dev, O=DeepSeek, L=Unknown, ST=Unknown, C=US';
    const r = await run('keytool', [
        '-genkeypair', '-v', '-keystore', keystorePath, '-alias', aliasName,
        '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
        '-storepass', String(password), '-keypass', String(password), '-dname', dnameStr,
    ], { timeout: 60000 });
    if (r.failed) return res.status(500).json({ error: redact(r.stderr || r.stdout) });
    res.json({ ok: true, keystore: safeName });
});

app.get('/api/deploy/keystores', (_req, res) => {
    try {
        const list = fs.readdirSync(KEYSTORE_DIR).filter((f) => f.endsWith('.jks')).map((f) => f.replace(/\.jks$/, ''));
        res.json({ keystores: list });
    } catch (_) { res.json({ keystores: [] }); }
});

app.post('/api/deploy/build', async (req, res) => {
    const { cwd, output, keystore, alias, password } = req.body || {};
    const workdir = resolveInWorkspace(cwd || '');
    if (!workdir) return res.status(403).json({ error: 'Forbidden' });
    if (!fs.existsSync(workdir)) return res.status(404).json({ error: 'Project not found' });
    const projectType = detectAndroidProject(workdir);
    if (!projectType) return res.status(400).json({ error: 'Not an Android project' });

    const wantAab = output !== 'apk';
    const licenseKey = fs.existsSync(LICENSE_FILE) ? fs.readFileSync(LICENSE_FILE, 'utf8').trim() : '';
    const isPro = licenseKey.startsWith(PRO_LICENSE_PREFIX) && licenseKey.length >= 20;
    if (wantAab && !isPro) return res.status(402).json({ error: 'Pro license required for AAB' });

    const keystorePath = keystore ? path.join(KEYSTORE_DIR, String(keystore).replace(/[^a-zA-Z0-9_-]/g, '_') + '.jks') : null;
    if (keystorePath && !withinBase(KEYSTORE_DIR, keystorePath)) return res.status(403).json({ error: 'Forbidden' });
    const aliasName = String(alias || keystore || 'release');
    const pw = password || '';

    let cmd, cwdForRun, artifactPath;
    if (projectType === 'flutter') {
        cwdForRun = workdir;
        if (keystorePath && fs.existsSync(keystorePath)) {
            const keyPropsPath = path.join(workdir, 'android', 'key.properties');
            fs.mkdirSync(path.dirname(keyPropsPath), { recursive: true });
            fs.writeFileSync(keyPropsPath, 'storePassword=' + pw + '\nkeyPassword=' + pw + '\nkeyAlias=' + aliasName + '\nstoreFile=' + keystorePath + '\n', 'utf8');
        }
        cmd = wantAab ? 'flutter build appbundle --release 2>&1' : 'flutter build apk --release 2>&1';
        artifactPath = wantAab ? path.join(workdir, 'build', 'app', 'outputs', 'bundle', 'release', 'app-release.aab') : path.join(workdir, 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk');
    } else if (projectType === 'react-native') {
        const androidDir = path.join(workdir, 'android');
        cwdForRun = fs.existsSync(androidDir) ? androidDir : workdir;
        if (keystorePath && fs.existsSync(keystorePath)) {
            const gradleProps = path.join(androidDir, 'gradle.properties');
            let props = fs.existsSync(gradleProps) ? fs.readFileSync(gradleProps, 'utf8') : '';
            props += '\nDEEPSEEK_STORE_FILE=' + keystorePath + '\nDEEPSEEK_KEY_ALIAS=' + aliasName + '\nDEEPSEEK_STORE_PASSWORD=' + pw + '\nDEEPSEEK_KEY_PASSWORD=' + pw + '\n';
            fs.writeFileSync(gradleProps, props, 'utf8');
        }
        cmd = './gradlew ' + (wantAab ? 'bundleRelease' : 'assembleRelease') + ' 2>&1';
        artifactPath = wantAab ? path.join(androidDir, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab') : path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
    } else {
        cwdForRun = workdir;
        if (keystorePath && fs.existsSync(keystorePath)) {
            const gradleProps = path.join(workdir, 'gradle.properties');
            let props = fs.existsSync(gradleProps) ? fs.readFileSync(gradleProps, 'utf8') : '';
            props += '\nDEEPSEEK_STORE_FILE=' + keystorePath + '\nDEEPSEEK_KEY_ALIAS=' + aliasName + '\nDEEPSEEK_STORE_PASSWORD=' + pw + '\nDEEPSEEK_KEY_PASSWORD=' + pw + '\n';
            fs.writeFileSync(gradleProps, props, 'utf8');
        }
        cmd = './gradlew ' + (wantAab ? 'bundleRelease' : 'assembleRelease') + ' 2>&1';
        artifactPath = wantAab ? path.join(workdir, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab') : path.join(workdir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
    }

    const r = await run('sh', ['-c', cmd], { cwd: cwdForRun, timeout: 900000, maxBuffer: 50 * 1024 * 1024 });
    const out = redact(r.stdout + (r.stderr ? '\n' + r.stderr : ''));
    const artifactExists = fs.existsSync(artifactPath);
    let artifactSize = 0;
    if (artifactExists) artifactSize = fs.statSync(artifactPath).size;
    res.json({
        ok: !r.failed && artifactExists, projectType, output: out,
        artifact: artifactExists ? { path: path.relative(WORKSPACE, artifactPath), absPath: artifactPath, size: artifactSize } : null,
    });
});

app.get('/api/deploy/download', (req, res) => {
    const target = resolveInWorkspace(req.query.path || '');
    if (!target || !fs.existsSync(target)) return res.status(404).json({ error: 'not found' });
    res.download(target);
});

/* ═══════════════════════════════════════════════════════════════════
   Static SPA
   ═══════════════════════════════════════════════════════════════════ */
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, {
    setHeaders: (res, filePath) => {
        if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
}));
app.get('/guide', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'guide.html')));
app.get(/^\/(?!api\/|ws).*/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

/* ═══════════════════════════════════════════════════════════════════
   404 / error handlers
   ═══════════════════════════════════════════════════════════════════ */
app.use('/api/', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
app.use((err, _req, res, _next) => {
    const msg = redact(err && err.message ? err.message : String(err));
    console.error('[error]', msg);
    if (res.headersSent) return;
    res.status(err && err.status ? err.status : 500).json({ error: msg });
});

/* ═══════════════════════════════════════════════════════════════════
   HTTP server + PTY WebSocket
   ═══════════════════════════════════════════════════════════════════ */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/pty' });

/** Resolve a usable bash binary — Termux path preferred, /bin/bash fallback. */
function resolveShell() {
    if (fs.existsSync(TERMUX_BASH)) return TERMUX_BASH;
    for (const candidate of ['/data/data/com.termux/files/usr/bin/bash', '/system/bin/sh', '/bin/bash', '/bin/sh']) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return 'bash';
}

wss.on('connection', (ws, req) => {
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
    if (!['127.0.0.1', '::1', 'localhost'].includes(ip)) {
        try { ws.close(1008, 'Forbidden'); } catch (_) {}
        return;
    }

    const shellBin = resolveShell();
    const shellEnv = { ...process.env, TERM: 'xterm-256color', DS_WORKSPACE: WORKSPACE };

    /* ── Preferred path: real PTY via node-pty ── */
    if (ptyLib) {
        let term;
        try {
            term = ptyLib.spawn(shellBin, ['-l'], {
                name: 'xterm-256color',
                cols: 80,
                rows: 24,
                cwd: WORKSPACE,
                env: shellEnv,
            });
        } catch (err) {
            try { ws.send('\r\n[pty spawn failed: ' + redact(err.message) + ']\r\n'); } catch (_) {}
            try { ws.close(); } catch (_) {}
            return;
        }

        term.onData((d) => { try { ws.send(d); } catch (_) {} });
        term.onExit(({ exitCode }) => {
            try { ws.send('\r\n[process exited with code ' + exitCode + ']\r\n'); } catch (_) {}
            try { ws.close(); } catch (_) {}
        });

        ws.on('message', (raw) => {
            const msg = raw.toString('utf8');
            if (msg.startsWith('{')) {
                try {
                    const parsed = JSON.parse(msg);
                    if (parsed && parsed.type === 'resize' && parsed.cols > 0 && parsed.rows > 0) {
                        term.resize(parsed.cols, parsed.rows);
                        return;
                    }
                    if (parsed && parsed.type === 'input') {
                        term.write(parsed.data);
                        return;
                    }
                } catch (_) {}
            }
            term.write(msg);
        });

        ws.on('close', () => { try { term.kill(); } catch (_) {} });
        ws.on('error', () => { try { term.kill(); } catch (_) {} });
        return;
    }

    /* ── Fallback: child_process pipe (no TTY) ── */
    let shell;
    try {
        shell = require('child_process').spawn(shellBin, ['-l'], {
            cwd: WORKSPACE,
            env: shellEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (err) {
        try { ws.send('\r\n[error] failed to start shell: ' + redact(err.message) + '\r\n'); } catch (_) {}
        try { ws.close(); } catch (_) {}
        return;
    }

    shell.stdout.on('data', (d) => { try { ws.send(d.toString('utf8')); } catch (_) {} });
    shell.stderr.on('data', (d) => { try { ws.send(d.toString('utf8')); } catch (_) {} });
    shell.on('exit', (code) => {
        try { ws.send('\r\n[process exited with code ' + code + ']\r\n'); } catch (_) {}
        try { ws.close(); } catch (_) {}
    });

    ws.on('message', (raw) => {
        const msg = raw.toString('utf8');
        if (msg.startsWith('{')) {
            try {
                const parsed = JSON.parse(msg);
                if (parsed && parsed.type === 'input' && shell.stdin.writable) {
                    shell.stdin.write(parsed.data);
                    return;
                }
                if (parsed && parsed.type === 'resize') return; // no-op in fallback mode
            } catch (_) {}
        }
        if (shell.stdin.writable) shell.stdin.write(msg);
    });

    ws.on('close', () => {
        try { shell.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => { try { shell.kill('SIGKILL'); } catch (_) {} }, 2000);
    });
    ws.on('error', () => { try { shell.kill('SIGKILL'); } catch (_) {} });
});

/* ═══════════════════════════════════════════════════════════════════
   Graceful shutdown
   ═══════════════════════════════════════════════════════════════════ */
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[' + signal + '] Shutting down...');
    try { wss.close(); } catch (_) {}
    try {
        require('child_process').execSync(
            'command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock',
            { timeout: 3000, stdio: 'ignore' });
        console.log('\uD83D\uDD13 Wake lock released');
    } catch (_) {}
    server.close(() => { console.log('Server closed.'); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', redact(err && err.message));
    if (err && err.stack) console.error(redact(err.stack));
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', redact(reason && reason.message ? reason.message : reason));
});

/* ═══════════════════════════════════════════════════════════════════
   Boot
   ═══════════════════════════════════════════════════════════════════ */
server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error('\n\u2717 Port ' + PORT + ' is already in use.');
        console.error('  Another DeepSeek Studio instance may be running.');
        console.error('  Stop it with: pkill -f "node server.js"\n');
    } else {
        console.error('\n\u2717 Server error:', err && err.message ? err.message : err);
    }
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    const line = '===========================================';
    console.log('');
    console.log(line);
    console.log('  DeepSeek Studio — Backend');
    console.log('  v' + PKG_VERSION + ' \u00b7 Node ' + process.version);
    console.log(line);
    console.log('  URL:       http://' + HOST + ':' + PORT);
    console.log('  Workspace: ' + WORKSPACE);
    console.log('  Backups:   ' + SD_BACKUP);
    console.log('  Keystores: ' + KEYSTORE_DIR);
    console.log('  SD Card:   ' + (fs.existsSync(SD_CARD_ROOT) ? 'detected' : 'NOT FOUND'));
    console.log('  GitHub:    ' + (ghToken() ? 'token configured' : 'no token'));
    console.log(line);
    console.log('  Libraries:');
    console.log('    simple-git    ' + (simpleGitFactory ? '\u2713' : '\u2717 (using execFile)'));
    console.log('    @octokit/rest ' + (OctokitLib       ? '\u2713' : '\u2717 (using fetch)'));
    console.log('    node-pty      ' + (ptyLib          ? '\u2713' : '\u2717 (using pipe)'));
    console.log('    editkit       ' + (editkitLib      ? '\u2713' : '\u2717 (using exact match)'));
    console.log(line);
    console.log('');
});

module.exports = app;