#!/usr/bin/env node
/**
 * DeepSeek Studio — Backend v2.3
 * ─────────────────────────────────────────────────────────────────────
 * Local-first coding backend for Termux (Android).
 *
 * v2.3 — FULL DEVELOPER FREEDOM
 *   ⚡ /api/compile        — language-aware syntax check for the ⚡ button
 *   🔑 /api/license/*      — Pro license status/save/remove
 *   🛠️  /api/deploy/install-tools — one-tap pkg install of missing tools
 *   📦 /api/deploy/artifacts       — recent AAB/APK scan
 *   🏷️  /api/git/tags/list         — populates the Git panel Tags box
 *   📱 Expanded Termux:API tools:
 *      clipboard get/set, battery, torch, vibrate, volume, TTS,
 *      dialog, wifi info, location, share, camera, fingerprint,
 *      sms send, call, download, storage info, sensors, contacts
 *
 * v2.2: /api/changelog + X-DeepSeek-Version header
 * v2.1: external folder linking + realpath-verified fs
 * v2.0: simple-git, @octokit/rest, node-pty, editkit
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

/* ─── Optional libraries ─── */
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
const editkitReady = (async () => {
    try {
        const mod = await import('editkit');
        editkitLib = mod.default || mod;
        console.log('[deps] editkit loaded — fuzzy patches enabled');
    } catch (err) {
        console.warn('[deps] editkit not available — using exact-match patch:', err && err.message);
    }
})();

let termuxApiLib = null;
try { termuxApiLib = require('termux-api'); } catch (_) { /* CLI fallback */ }

/* ─── Constants ─── */
const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const HOME = process.env.HOME || os.homedir();

const WORKSPACE = path.resolve(process.env.DS_WORKSPACE || path.join(HOME, 'projects'));
const SD_CARD_ROOT = path.join(HOME, 'storage', 'external-1');
const SD_BACKUP = path.join(SD_CARD_ROOT, 'DeepSeekBackups');
const KEYSTORE_DIR = path.join(HOME, '.deepseek-keystores');
const LICENSE_FILE = path.join(HOME, '.deepseek-license');
const SECRETS_FILE = path.join(HOME, '.deepseek-secrets.json');
const ASKPASS_HELPER = path.join(HOME, '.deepseek-git-askpass.sh');
const LINKS_FILE = path.join(HOME, '.deepseek-links.json');
const TERMUX_BASH = '/data/data/com.termux/files/usr/bin/bash';

const PRO_LICENSE_PREFIX = 'DS-PRO-';
const PKG_VERSION = (() => {
    try { return require('./package.json').version; } catch (_) { return '2.3.0'; }
})();

const CHANGELOG = [
    {
        version: '2.3.0', date: '2025-10', type: 'feature',
        items: [
            'Compile button now works for 15+ languages',
            'Pro license gating for signed AAB builds',
            'One-tap install of missing Android toolchain',
            'Recent artifacts scanner (AAB/APK)',
            'Git panel Tags list populates automatically',
            '15 new Termux:API tools: clipboard, battery, torch, vibrate, volume, TTS, dialog, wifi, location, share, camera, fingerprint, sms, call, storage',
        ],
    },
    {
        version: '2.2.0', date: '2025-10', type: 'feature',
        items: [
            'External folder linking — symlink any folder from your phone',
            'Folder picker modal with breadcrumb navigation',
            'Realpath-verified fs operations (no symlink escapes)',
            'Copy buttons on every copyable surface',
            'In-chat search with match highlighting',
            'Updates & Activity log panel',
        ],
    },
    {
        version: '2.1.0', date: '2025-10', type: 'feature',
        items: [
            'Dynamic ESM import for editkit',
            'Library status badges in Setup',
            'GPU renderer toggle for terminal (WebGL)',
            'Terminal search bar (Ctrl+F)',
        ],
    },
    {
        version: '2.0.0', date: '2025-10', type: 'feature',
        items: [
            'simple-git fluent git operations',
            '@octokit/rest typed GitHub API',
            'node-pty — real TTY (vim/htop/less work)',
            'editkit — Aider-style fuzzy SEARCH/REPLACE',
            'xterm.js 5.5 + WebGL/search/unicode11/serialize',
        ],
    },
    {
        version: '1.0.0', date: '2025-09', type: 'feature',
        items: ['Initial release'],
    },
];

const AI_TOOLS = [
    { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a file. Paths relative to project root.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'read_file', description: 'Read file contents', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'list_files', description: 'List files in a directory', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    { type: 'function', function: { name: 'create_folder', description: 'Create a new folder', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'delete_file', description: 'Delete a file or folder', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'move_file', description: 'Move or rename a file', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
    { type: 'function', function: { name: 'copy_file', description: 'Copy a file', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
    { type: 'function', function: { name: 'apply_patch', description: 'Edit an existing file by finding a unique search string and replacing it. Include 3-5 lines of context.', parameters: { type: 'object', properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'search', 'replace'] } } },
    { type: 'function', function: { name: 'grep_search', description: 'Search for a regex pattern in files', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, ignoreCase: { type: 'boolean' } }, required: ['pattern'] } } },
    { type: 'function', function: { name: 'find_files', description: 'Find files matching a glob pattern', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
    { type: 'function', function: { name: 'run_command', description: 'Run any shell command in Termux. Set background=true for servers/watchers.', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, background: { type: 'boolean' } }, required: ['command'] } } },
    { type: 'function', function: { name: 'notify', description: 'Send an Android notification.', parameters: { type: 'object', properties: { title: { type: 'string' }, message: { type: 'string' } }, required: ['message'] } } },
    { type: 'function', function: { name: 'termux_toast', description: 'Show a quick Android toast popup (<200 chars).', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } },
    { type: 'function', function: { name: 'termux_open_url', description: 'Open a URL in the Android default browser.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
    { type: 'function', function: { name: 'termux_clipboard_get', description: 'Read the Android system clipboard.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'termux_clipboard_set', description: 'Write text to the Android system clipboard.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
    { type: 'function', function: { name: 'termux_battery_status', description: 'Get battery percentage, temperature, charging status.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'termux_torch', description: 'Turn the camera flash on or off.', parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] } } },
    { type: 'function', function: { name: 'termux_vibrate', description: 'Vibrate the phone.', parameters: { type: 'object', properties: { duration: { type: 'number' } } } } },
    { type: 'function', function: { name: 'termux_volume', description: 'Get or set device volume.', parameters: { type: 'object', properties: { stream: { type: 'string' }, action: { type: 'string' }, volume: { type: 'number' } } } } },
    { type: 'function', function: { name: 'termux_brightness', description: 'Get or set screen brightness.', parameters: { type: 'object', properties: { level: { type: 'number' } } } } },
    { type: 'function', function: { name: 'termux_sensor', description: 'List or read device sensors.', parameters: { type: 'object', properties: { sensor: { type: 'string' } } } } },
    { type: 'function', function: { name: 'termux_tts_speak', description: 'Speak text out loud using Android TTS.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
    { type: 'function', function: { name: 'termux_dialog', description: 'Native Android dialog.', parameters: { type: 'object', properties: { kind: { type: 'string' }, title: { type: 'string' }, message: { type: 'string' }, default: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } } } } },
    { type: 'function', function: { name: 'termux_wifi_info', description: 'Get current WiFi SSID, IP, BSSID.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'termux_wifi_scan', description: 'Scan nearby WiFi networks.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'termux_location', description: 'Get GPS/network location.', parameters: { type: 'object', properties: { provider: { type: 'string' } } } } },
    { type: 'function', function: { name: 'termux_camera_photo', description: 'Take a photo.', parameters: { type: 'object', properties: { path: { type: 'string' }, camera: { type: 'number' } } } } },
    { type: 'function', function: { name: 'termux_share', description: 'Open the Android share sheet.', parameters: { type: 'object', properties: { file: { type: 'string' }, text: { type: 'string' }, title: { type: 'string' } } } } },
    { type: 'function', function: { name: 'termux_download', description: 'Download a URL using Android DownloadManager.', parameters: { type: 'object', properties: { url: { type: 'string' }, path: { type: 'string' } }, required: ['url'] } } },
    { type: 'function', function: { name: 'termux_sms_send', description: 'Send an SMS.', parameters: { type: 'object', properties: { number: { type: 'string' }, message: { type: 'string' } }, required: ['number', 'message'] } } },
    { type: 'function', function: { name: 'termux_call', description: 'Place a phone call.', parameters: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] } } },
    { type: 'function', function: { name: 'termux_contacts', description: 'Read contacts from the device.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'termux_fingerprint', description: 'Prompt for fingerprint authentication.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'termux_storage_info', description: 'Get disk space info.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'termux_ir_transmit', description: 'Transmit an IR pattern.', parameters: { type: 'object', properties: { frequency: { type: 'number' }, pattern: { type: 'array', items: { type: 'number' } } }, required: ['pattern'] } } }
];

/* ─── Directory setup ─── */
for (const dir of [WORKSPACE, KEYSTORE_DIR]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}
try {
    fs.writeFileSync(ASKPASS_HELPER,
        '#!/data/data/com.termux/files/usr/bin/sh\n' +
        'printf "%s\\n" "${GIT_ASKPASS_TOKEN:-}"\n', { mode: 0o700 });
    fs.chmodSync(ASKPASS_HELPER, 0o700);
} catch (_) {}

/* ─── Stores ─── */
function loadLinks() {
    try {
        const p = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
        return (p && typeof p === 'object') ? p : {};
    } catch (_) { return {}; }
}
function saveLinks() {
    try {
        fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2), { mode: 0o600 });
        fs.chmodSync(LINKS_FILE, 0o600);
    } catch (err) { console.error('[links] save failed:', err.message); }
}
let links = loadLinks();

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
function safeRealPath(p) {
    try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); }
}

const ALLOWED_EXTERNAL_ROOTS = (() => {
    // Only phone storage — never Termux home, which contains secrets
    const candidates = ['/storage/emulated/0', '/storage/self/primary', '/sdcard'];
    const out = new Set();
    for (const c of candidates) {
        try { out.add(fs.realpathSync(c)); } catch (_) {}
    }
    return [...out];
})();

function isAllowedExternal(absPath) {
    if (!absPath) return false;
    let real;
    try { real = fs.realpathSync(absPath); } catch (_) { return false; }
    for (const root of ALLOWED_EXTERNAL_ROOTS) {
        if (real === root || real.startsWith(root + path.sep)) return true;
    }
    return false;
}

function resolveInWorkspace(rel, base = WORKSPACE) {
    const target = path.resolve(base, rel == null ? '' : String(rel));
    if (!withinBase(base, target)) return null;
    const workspaceReal = safeRealPath(WORKSPACE);
    const check = (abs) => {
        const real = safeRealPath(abs);
        if (withinBase(workspaceReal, real)) return true;
        if (isAllowedExternal(real)) return true;
        return false;
    };
    if (fs.existsSync(target)) return check(target) ? target : null;
    let cur = target;
    const root = path.parse(cur).root;
    while (cur !== root && !fs.existsSync(cur)) cur = path.dirname(cur);
    if (cur === root) return target;
    return check(cur) ? target : null;
}

/* ─── Express baseline ─── */
app.disable('x-powered-by');
app.use(cors({
    origin: (origin, cb) => {
        // No Origin header = same-origin or curl → allow
        if (!origin) return cb(null, true);
        // Loopback origins only
        if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return cb(null, true);
        return cb(null, false);
    },
    credentials: false,
}));
app.use(express.json({ limit: '25mb' }));
app.use((req, res, next) => {
    if (req.body && typeof req.body === 'object') {
        for (const k of ['__proto__', 'constructor', 'prototype']) {
            if (Object.prototype.hasOwnProperty.call(req.body, k)) delete req.body[k];
        }
    }
    res.setHeader('X-DeepSeek-Version', PKG_VERSION);
    next();
});

/* ─── Rate limiting ─── */
const rateLimitMap = new Map();
const RATE_LIMIT_PER_MIN = parseInt(process.env.DS_RATE_LIMIT, 10) || 600;
const LONG_RUNNING = new Set([
    '/api/git/clone', '/api/git/push', '/api/git/pull', '/api/git/pull/rebase',
    '/api/git/fetch', '/api/exec', '/api/ai/chat', '/api/ai/tool-call',
    '/api/backup/restore', '/api/deploy/build', '/api/deploy/aab',
    '/api/deploy/install-tools', '/api/compile',
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

/* ─── Shell helpers ─── */
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

/* ─── Termux:API helper — CLI-first with module fallback ─── */
function termuxCli(cmd, args = [], timeout = 8000) {
    return run(cmd, args, { timeout });
}
function shellQuote(s) {
    return "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'";
}

/* ═══════════════════════════════════════════════════════════════════
   git
   ═══════════════════════════════════════════════════════════════════ */
const ghToken = () => String(secrets.github_token || '').trim();

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

function getGit(relDir = '') {
    if (!simpleGitFactory) throw Object.assign(new Error('simple-git not installed'), { status: 500 });
    const workdir = resolveInWorkspace(relDir);
    if (!workdir) throw Object.assign(new Error('Forbidden'), { status: 403 });
    const token = ghToken();
    const g = simpleGitFactory({ baseDir: workdir, binary: 'git', maxConcurrentProcesses: 4, trimmed: true });
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

function gitOk(extra = {}) { return Object.assign({ code: 0, ok: true, stdout: '', stderr: '' }, extra); }
function gitErr(err) {
    const msg = redact(err && err.message ? err.message : String(err));
    return { code: typeof (err && err.code) === 'number' ? err.code : 1, ok: false, stdout: '', stderr: msg, error: msg };
}

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
            'termux-api': !!termuxApiLib,
        },
    });
});

app.get('/api/changelog', (_req, res) => {
    res.json({ current: PKG_VERSION, changelog: CHANGELOG });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/diagnostics', (_req, res) => {
    res.json({
        version: PKG_VERSION, node: process.version,
        platform: process.platform, arch: process.arch,
        uptime: Math.floor(process.uptime()),
        workspace: WORKSPACE,
        allowedExternalRoots: ALLOWED_EXTERNAL_ROOTS,
        linkCount: Object.keys(links).length,
        libs: {
            'simple-git': !!simpleGitFactory, '@octokit/rest': !!OctokitLib,
            'node-pty': !!ptyLib, 'editkit': !!editkitLib, 'termux-api': !!termuxApiLib,
        },
        features: {
            gitFluent: !!simpleGitFactory, githubOctokit: !!OctokitLib,
            realPty: !!ptyLib, fuzzyPatch: !!editkitLib,
            externalLinks: true, termuxApiModule: !!termuxApiLib,
            compile: true, license: true,
        },
        secrets: Object.keys(secrets),
        hasGitHubToken: !!ghToken(),
    });
});

/* ═══════════════════════════════════════════════════════════════════
   Secrets
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
        const raw = await fsp.readdir(target, { withFileTypes: true });
        const items = [];
        for (const d of raw) {
            if (d.name === '.gitkeep') continue;
            const isLinked = !!links[d.name];
            if (d.name === '.git' && !isLinked) continue;
            const full = path.join(target, d.name);
            let isExternal = false;
            try {
                const real = fs.realpathSync(full);
                if (!withinBase(WORKSPACE, real) && isAllowedExternal(real)) isExternal = true;
            } catch (_) {}
            items.push({
                name: d.name,
                isDir: d.isDirectory() || (d.isSymbolicLink() && fs.existsSync(full) && fs.statSync(full).isDirectory()),
                isLink: d.isSymbolicLink(),
                external: isExternal,
                path: path.relative(WORKSPACE, full).replace(/\\/g, '/'),
            });
        }
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
    try {
        const real = fs.realpathSync(target);
        if (!withinBase(WORKSPACE, real) && isAllowedExternal(real)) {
            return res.status(400).json({
                error: 'Target is outside workspace — use /api/fs/link to remove the link.',
                requiresUnlink: true,
            });
        }
    } catch (_) {}
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
   External Folder Linking
   ═══════════════════════════════════════════════════════════════════ */
function validLinkName(name) {
    return typeof name === 'string' && name.length > 0 && name.length <= 100 &&
        !name.includes('/') && !name.includes('\\') &&
        name !== '.' && name !== '..' && /^[A-Za-z0-9._-]+$/.test(name);
}

app.get('/api/fs/links', async (_req, res) => {
    const out = [];
    for (const [name, meta] of Object.entries(links)) {
        const linkPath = path.join(WORKSPACE, name);
        let exists = false, isSymlink = false, targetExists = false, isDir = false, size = null;
        try {
            const lst = await fsp.lstat(linkPath);
            exists = true; isSymlink = lst.isSymbolicLink();
        } catch (_) {}
        try {
            const st = await fsp.stat(linkPath);
            targetExists = true; isDir = st.isDirectory(); size = st.size;
        } catch (_) {}
        out.push({
            name, target: meta.target, createdAt: meta.createdAt || null,
            exists, isSymlink, targetExists, isDir, size,
            broken: exists && !targetExists,
        });
    }
    res.json({ links: out, allowedRoots: ALLOWED_EXTERNAL_ROOTS });
});

app.post('/api/fs/link', async (req, res) => {
    const rawTarget = String((req.body || {}).target || '').trim();
    if (!rawTarget) return res.status(400).json({ error: 'target path required' });
    if (!path.isAbsolute(rawTarget)) return res.status(400).json({ error: 'target must be absolute' });
    let stat;
    try { stat = await fsp.stat(rawTarget); }
    catch (e) { return res.status(404).json({ error: 'Target not found: ' + rawTarget }); }
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Target must be a directory' });
    if (!isAllowedExternal(rawTarget)) {
        return res.status(403).json({ error: 'Target is outside the allowed roots', allowedRoots: ALLOWED_EXTERNAL_ROOTS });
    }
    const realTarget = safeRealPath(rawTarget);
    if (withinBase(safeRealPath(WORKSPACE), realTarget)) {
        return res.status(400).json({ error: 'Target is already inside the workspace' });
    }
    let name = String((req.body || {}).name || '').trim();
    if (!name) name = path.basename(realTarget);
    if (!validLinkName(name)) return res.status(400).json({ error: 'Invalid link name' });
    const linkPath = path.join(WORKSPACE, name);
    if (fs.existsSync(linkPath) || links[name]) {
        return res.status(409).json({ error: 'A link or file already exists at: ' + name });
    }
    try {
        await fsp.symlink(realTarget, linkPath, 'dir');
        links[name] = { target: realTarget, createdAt: new Date().toISOString() };
        saveLinks();
        console.log('[links] created ' + name + ' → ' + realTarget);
        res.json({ ok: true, link: { name, target: realTarget } });
    } catch (err) {
        res.status(500).json({ error: 'Symlink failed: ' + err.message });
    }
});

app.delete('/api/fs/link', async (req, res) => {
    const name = String(req.query.name || '').trim();
    if (!validLinkName(name)) return res.status(400).json({ error: 'invalid link name' });
    const linkPath = path.join(WORKSPACE, name);
    if (!withinBase(WORKSPACE, linkPath)) return res.status(403).json({ error: 'Forbidden' });
    try {
        let removed = false;
        if (fs.existsSync(linkPath) || (() => { try { fs.lstatSync(linkPath); return true; } catch { return false; } })()) {
            const lst = fs.lstatSync(linkPath);
            if (lst.isSymbolicLink()) { await fsp.unlink(linkPath); removed = true; }
            else return res.status(400).json({ error: 'Refusing to delete: entry is not a symlink.' });
        }
        if (links[name]) { delete links[name]; saveLinks(); }
        console.log('[links] removed ' + name);
        res.json({ ok: true, removed });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/fs/browse', async (req, res) => {
    const raw = String(req.query.path || '').trim();
    if (!raw) {
        const suggestions = [
            { name: 'Termux home', path: HOME },
            { name: 'Shared storage', path: '/storage/emulated/0' },
            { name: 'Downloads', path: path.join(HOME, 'storage', 'downloads') },
            { name: 'Documents', path: path.join(HOME, 'storage', 'documents') },
            { name: 'DCIM (photos)', path: path.join(HOME, 'storage', 'dcim') },
            { name: 'SD card', path: path.join(HOME, 'storage', 'external-1') },
        ].filter((s) => { try { return fs.existsSync(s.path) && isAllowedExternal(s.path); } catch { return false; } });
        return res.json({ path: '', parent: null, roots: true, items: suggestions });
    }
    if (!path.isAbsolute(raw)) return res.status(400).json({ error: 'path must be absolute' });
    if (!isAllowedExternal(raw)) return res.status(403).json({ error: 'Outside allowed roots', allowedRoots: ALLOWED_EXTERNAL_ROOTS });
    try {
        const rawEntries = await fsp.readdir(raw, { withFileTypes: true });
        const items = rawEntries
            .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
            .map((d) => ({ name: d.name, path: path.join(raw, d.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
        const parent = path.dirname(raw);
        const parentAllowed = parent !== raw && isAllowedExternal(parent);
        res.json({ path: raw, parent: parentAllowed ? parent : null, roots: false, items });
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
   Compile — language-aware syntax check
   ═══════════════════════════════════════════════════════════════════ */
const COMPILE_RECIPES = {
    py:   { cmd: 'python3 -c "import py_compile,sys;py_compile.compile(sys.argv[1],doraise=True)" "$1"', lang: 'python' },
    js:   { cmd: 'node --check "$1"', lang: 'javascript' },
    mjs:  { cmd: 'node --check "$1"', lang: 'javascript' },
    cjs:  { cmd: 'node --check "$1"', lang: 'javascript' },
    ts:   { cmd: 'npx --yes tsc --noEmit --skipLibCheck "$1"', lang: 'typescript' },
    tsx:  { cmd: 'npx --yes tsc --noEmit --skipLibCheck --jsx react "$1"', lang: 'typescript' },
    json: { cmd: 'node -e "JSON.parse(require(\'fs\').readFileSync(process.argv[1],\'utf8\'))" "$1"', lang: 'json' },
    sh:   { cmd: 'bash -n "$1"', lang: 'shell' },
    bash: { cmd: 'bash -n "$1"', lang: 'shell' },
    c:    { cmd: 'cc -fsyntax-only "$1"', lang: 'c' },
    cpp:  { cmd: 'c++ -fsyntax-only "$1"', lang: 'cpp' },
    cc:   { cmd: 'c++ -fsyntax-only "$1"', lang: 'cpp' },
    rs:   { cmd: 'rustc --edition=2021 --crate-type=bin --emit=metadata -o /dev/null "$1"', lang: 'rust' },
    go:   { cmd: 'gofmt -e "$1" >/dev/null', lang: 'go' },
    java: { cmd: 'javac -d "$(mktemp -d)" "$1"', lang: 'java' },
    kt:   { cmd: 'kotlinc "$1" -d "$(mktemp -d)" 2>&1 || kotlinc "$1" -include-runtime -d /tmp/ds-kt.jar', lang: 'kotlin' },
    dart: { cmd: 'dart analyze "$1"', lang: 'dart' },
    yaml: { cmd: 'python3 -c "import yaml,sys;yaml.safe_load(open(sys.argv[1]))" "$1"', lang: 'yaml' },
    yml:  { cmd: 'python3 -c "import yaml,sys;yaml.safe_load(open(sys.argv[1]))" "$1"', lang: 'yaml' },
    html: { cmd: null, lang: 'html', note: 'HTML has no compile step — open in browser to check' },
    css:  { cmd: null, lang: 'css',  note: 'CSS has no compile step' },
    scss: { cmd: null, lang: 'scss', note: 'SCSS requires sass — install with: pkg install nodejs && npm i -g sass' },
    md:   { cmd: null, lang: 'markdown', note: 'Markdown has no compile step' },
    xml:  { cmd: 'xmllint --noout "$1" 2>&1 || echo "install: pkg install libxml2-utils"', lang: 'xml' },
    php:  { cmd: 'php -l "$1"', lang: 'php' },
    rb:   { cmd: 'ruby -c "$1"', lang: 'ruby' },
    lua:  { cmd: 'luac -p "$1"', lang: 'lua' },
    sql:  { cmd: null, lang: 'sql', note: 'SQL has no generic syntax check' },
    toml: { cmd: 'python3 -c "import sys;try:\\n    import tomllib as t\\nexcept: import tomli as t\\nt.load(open(sys.argv[1],\'rb\'))" "$1"', lang: 'toml' },
};

app.post('/api/compile', async (req, res) => {
    const rel = String((req.body || {}).path || '');
    const target = resolveInWorkspace(rel);
    if (!target) return res.status(403).json({ error: 'Forbidden' });
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'File not found' });
    if (!fs.statSync(target).isFile()) return res.status(400).json({ error: 'Not a file' });

    const ext = path.extname(target).toLowerCase().replace(/^\./, '');
    const recipe = COMPILE_RECIPES[ext];
    if (!recipe) {
        return res.json({ ok: false, lang: ext || 'unknown', cmd: null, code: 1,
            output: 'No compile rule for .' + ext });
    }
    if (!recipe.cmd) {
        return res.json({ ok: true, lang: recipe.lang, cmd: null, code: 0,
            output: recipe.note || 'Nothing to compile' });
    }

    const esc = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    const cmd = recipe.cmd.replace(/\$1/g, esc(target));
    const workdir = path.dirname(target);

    const r = await run('sh', ['-c', cmd], { cwd: workdir, timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
    const output = redact((r.stdout || '') + (r.stderr ? '\n' + r.stderr : '')) || '(no output)';
    res.json({
        ok: !r.failed, lang: recipe.lang, cmd,
        code: r.failed ? (typeof r.code === 'number' ? r.code : 1) : 0,
        output,
    });
});

/* ═══════════════════════════════════════════════════════════════════
   License — gates signed AAB builds
   ═══════════════════════════════════════════════════════════════════ */
function readLicense() {
    try {
        if (!fs.existsSync(LICENSE_FILE)) return '';
        return fs.readFileSync(LICENSE_FILE, 'utf8').trim();
    } catch (_) { return ''; }
}
function writeLicense(key) {
    fs.writeFileSync(LICENSE_FILE, String(key).trim() + '\n', { mode: 0o600 });
    try { fs.chmodSync(LICENSE_FILE, 0o600); } catch (_) {}
}
function validateLicense(key) {
    if (typeof key !== 'string') return false;
    const k = key.trim();
    return k.startsWith(PRO_LICENSE_PREFIX) && /^DS-PRO-[A-Z0-9-]{12,}$/i.test(k);
}

app.get('/api/license/status', (_req, res) => {
    const key = readLicense();
    if (!key) return res.json({ pro: false, key: '' });
    const pro = validateLicense(key);
    res.json({ pro, key: pro ? redact(key) : '' });
});

app.post('/api/license/save', (req, res) => {
    const key = String((req.body || {}).key || '').trim();
    if (!validateLicense(key)) {
        return res.status(400).json({ ok: false, error: 'Invalid license format. Expected DS-PRO-XXXX-XXXX-XXXX.' });
    }
    try { writeLicense(key); res.json({ ok: true, key: redact(key) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/license/remove', (_req, res) => {
    try {
        if (fs.existsSync(LICENSE_FILE)) fs.unlinkSync(LICENSE_FILE);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════
   AI tool calls
   ═══════════════════════════════════════════════════════════════════ */
function toolResult(res, ok, display, result) {
    return res.json({ ok: !!ok, display: display || '', result: result || {} });
}

function applyPatchSmart(original, search, replace, replaceAll) {
    if (editkitLib) {
        try {
            const fn = editkitLib.applyEdits || editkitLib.applySearchReplace || editkitLib.patch;
            if (typeof fn === 'function') {
                const r = fn(original, search, replace, { replaceAll: replaceAll === true });
                if (r && typeof r === 'object' && 'ok' in r) {
                    if (r.ok) return { ok: true, content: r.content != null ? r.content : r.result, count: r.count || 1, fuzzy: !!r.fuzzy };
                    return { ok: false, error: r.error || 'editkit rejected the patch' };
                }
                if (typeof r === 'string') return { ok: true, content: r, count: 1, fuzzy: true };
            }
        } catch (_) {}
    }
    let idx = 0, count = 0;
    while ((idx = original.indexOf(search, idx)) !== -1) { count++; idx += search.length; }
    if (count === 0) {
        const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
        if (norm(search) && norm(original).includes(norm(search))) {
            return { ok: false, error: 'whitespace mismatch — search matches only after normalization' };
        }
        return { ok: false, error: 'no match' };
    }
    if (count > 1 && replaceAll !== true) return { ok: false, error: 'ambiguous (' + count + ' matches)', count };
    const content = replaceAll === true ? original.split(search).join(replace) : original.replace(search, replace);
    return { ok: true, content, count: replaceAll === true ? count : 1, fuzzy: false };
}

app.post('/api/ai/tool-call', async (req, res) => {
    const { name, args } = req.body || {};
    if (!name) return res.status(400).json({ error: 'tool name required' });
    const a = args || {};
    try {
        switch (name) {
        /* ────────── File operations ────────── */
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
                .filter((d) => d.name !== '.gitkeep')
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
            try {
                const real = fs.realpathSync(target);
                if (!withinBase(WORKSPACE, real) && isAllowedExternal(real)) {
                    return toolResult(res, false, 'Refusing to delete external link target — unlink instead', { error: 'external-protected' });
                }
            } catch (_) {}
            await fsp.rm(target, { recursive: true, force: true });
            return toolResult(res, true, 'Deleted: ' + a.path, { ok: true });
        }
        case 'move_file': {
            const src = resolveInWorkspace(a.from);
            const dst = resolveInWorkspace(a.to);
            if (!src || !dst) return res.status(403).json({ error: 'outside workspace' });
            if (!fs.existsSync(src)) return toolResult(res, false, 'Source not found: ' + a.from, { error: 'not found' });
            await fsp.mkdir(path.dirname(dst), { recursive: true });
            await fsp.rename(src, dst);
            return toolResult(res, true, 'Moved ' + a.from + ' → ' + a.to, { ok: true });
        }
        case 'copy_file': {
            const src = resolveInWorkspace(a.from);
            const dst = resolveInWorkspace(a.to);
            if (!src || !dst) return res.status(403).json({ error: 'outside workspace' });
            if (!fs.existsSync(src)) return toolResult(res, false, 'Source not found: ' + a.from, { error: 'not found' });
            await fsp.mkdir(path.dirname(dst), { recursive: true });
            await fsp.copyFile(src, dst);
            return toolResult(res, true, 'Copied ' + a.from + ' → ' + a.to, { ok: true });
        }
        case 'apply_patch': {
            await editkitReady;
            const target = resolveInWorkspace(a.path);
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            if (!fs.existsSync(target)) return toolResult(res, false, 'File not found: ' + a.path, { error: 'not found' });
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
            const skip = new Set(['node_modules', '.git', 'build', 'dist', '.dart_tool', '.next', '.gradle', 'target']);
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
            walk(base, 0);
            return toolResult(res, hits.length > 0, 'Found ' + hits.length + ' file' + (hits.length === 1 ? '' : 's'), { files: hits });
        }
        /* ────────── Shell ────────── */
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
        /* ────────── Termux:API — original three ────────── */
        case 'notify': {
            const rawTitle = String((a.title || 'DeepSeek Studio')).slice(0, 100);
            const rawMsg = String((a.message || '')).slice(0, 400);
            if (termuxApiLib && typeof termuxApiLib.notification === 'function') {
                try {
                    await new Promise((resolve, reject) => {
                        const n = termuxApiLib.notification({ title: rawTitle, content: rawMsg });
                        if (n && typeof n.on === 'function') n.on('error', reject).on('end', resolve);
                        else resolve();
                    });
                    return toolResult(res, true, 'Notified (module): ' + rawTitle, { ok: true, via: 'module' });
                } catch (_) {}
            }
            const r = await termuxCli('termux-notification', ['--title', rawTitle, '--content', rawMsg, '--priority', 'high', '--vibrate', '300']);
            return toolResult(res, !r.failed,
                r.failed ? 'Notification failed — is termux-api installed? (pkg install termux-api)' : 'Notified: ' + rawTitle,
                { ok: !r.failed, via: 'cli' });
        }
        case 'termux_toast': {
            const msg = String((a.message || '')).slice(0, 200);
            const r = await termuxCli('termux-toast', [msg], 3000);
            return toolResult(res, !r.failed, r.failed ? 'Toast failed (termux-api?)' : 'Toast shown', { ok: !r.failed });
        }
        case 'termux_open_url': {
            const url = String((a.url || '')).slice(0, 2000);
            if (!/^https?:\/\//i.test(url)) return toolResult(res, false, 'Invalid URL', { error: 'bad url' });
            const r = await termuxCli('termux-open-url', [url], 5000);
            return toolResult(res, !r.failed, r.failed ? 'Open URL failed' : 'Opened: ' + url, { ok: !r.failed });
        }
        /* ────────── Termux:API — clipboard ────────── */
        case 'termux_clipboard_get': {
            const r = await termuxCli('termux-clipboard-get', [], 5000);
            if (r.failed) return toolResult(res, false, 'Clipboard read failed', { error: r.stderr || 'no output' });
            return toolResult(res, true, 'Read ' + r.stdout.length + ' chars from clipboard', { text: r.stdout });
        }
        case 'termux_clipboard_set': {
            const text = String(a.text || '');
            const r = await termuxCli('termux-clipboard-set', [text], 5000);
            return toolResult(res, !r.failed, r.failed ? 'Clipboard write failed' : 'Copied ' + text.length + ' chars to clipboard', { ok: !r.failed });
        }
        /* ────────── Termux:API — battery ────────── */
        case 'termux_battery_status': {
            const r = await termuxCli('termux-battery-status', [], 5000);
            if (r.failed) return toolResult(res, false, 'Battery status failed', { error: r.stderr });
            try {
                const d = JSON.parse(r.stdout);
                return toolResult(res, true,
                    'Battery: ' + d.percentage + '% (' + d.status + ', ' + d.temperature + '°C, ' + d.plugged + ')',
                    d);
            } catch (_) { return toolResult(res, true, 'Battery status read', { raw: r.stdout }); }
        }
        /* ────────── Termux:API — torch ────────── */
        case 'termux_torch': {
            const on = a.on === true || a.on === 'on';
            const r = await termuxCli('termux-torch', [on ? 'on' : 'off'], 5000);
            return toolResult(res, !r.failed, r.failed ? 'Torch failed' : ('Torch ' + (on ? 'on' : 'off')), { ok: !r.failed, on });
        }
        /* ────────── Termux:API — vibrate ────────── */
        case 'termux_vibrate': {
            const dur = String(parseInt(a.duration, 10) || 300);
            const r = await termuxCli('termux-vibrate', ['-d', dur], 5000);
            return toolResult(res, !r.failed, r.failed ? 'Vibrate failed' : ('Vibrated ' + dur + 'ms'), { ok: !r.failed });
        }
        /* ────────── Termux:API — volume ────────── */
        case 'termux_volume': {
            const stream = String(a.stream || 'music');
            const action = String(a.action || 'get');
            const argv = ['-s', stream];
            if (action === 'get') argv.push('-g');
            else if (action === 'set') argv.push('-v', String(a.volume || 0));
            else if (action === 'up') argv.push('-u');
            else if (action === 'down') argv.push('-d');
            const r = await termuxCli('termux-volume', argv, 5000);
            return toolResult(res, !r.failed, r.failed ? 'Volume failed' : (stream + ' volume: ' + (r.stdout.trim() || 'done')), { ok: !r.failed, raw: r.stdout });
        }
        /* ────────── Termux:API — TTS ────────── */
        case 'termux_tts_speak': {
            const text = String(a.text || '').slice(0, 1000);
            if (!text) return toolResult(res, false, 'No text to speak', { error: 'empty' });
            const r = await termuxCli('termux-tts-speak', [text], 30000);
            return toolResult(res, !r.failed, r.failed ? 'TTS failed' : ('Spoke ' + text.length + ' chars'), { ok: !r.failed });
        }
        /* ────────── Termux:API — dialog ────────── */
        case 'termux_dialog': {
            const kind = String(a.kind || 'text');
            const title = String(a.title || 'DeepSeek Studio');
            const argv = [];
            if (kind === 'confirm') {
                argv.push('--title', title, '--yesno', String(a.message || 'Continue?'));
            } else if (kind === 'text') {
                argv.push('--title', title, '--inputbox', String(a.message || 'Enter text'), String(a.default || ''));
            } else if (kind === 'password') {
                argv.push('--title', title, '--passwordbox', String(a.message || 'Password'));
            } else if (kind === 'list') {
                const items = Array.isArray(a.items) ? a.items.map((x) => String(x)) : [];
                if (!items.length) return toolResult(res, false, 'list requires items[]', { error: 'items required' });
                argv.push('--title', title, '--menu', String(a.message || 'Choose'), ...items);
            } else if (kind === 'radio') {
                const items = Array.isArray(a.items) ? a.items.map((x) => String(x)) : [];
                argv.push('--title', title, '--radiolist', String(a.message || 'Pick one'), ...items.flatMap((x) => ['off', x]));
            } else {
                return toolResult(res, false, 'Unknown dialog kind: ' + kind, { error: 'bad kind' });
            }
            const r = await termuxCli('termux-dialog', argv, 120000);
            // Dialog exits 1 on cancel — that's not a failure for our purposes
            return toolResult(res, true, 'Dialog ' + kind + ': ' + (r.stdout.trim() || '(cancelled)'),
                { ok: !r.failed, cancelled: r.failed, raw: r.stdout });
        }
        /* ────────── Termux:API — wifi ────────── */
        case 'termux_wifi_info': {
            const r = await termuxCli('termux-wifi-connectioninfo', [], 5000);
            if (r.failed) return toolResult(res, false, 'WiFi info failed', { error: r.stderr });
            try { const d = JSON.parse(r.stdout); return toolResult(res, true, 'WiFi: ' + (d.ssid || '?') + ' (' + (d.ip || '?') + ')', d); }
            catch (_) { return toolResult(res, true, 'WiFi info read', { raw: r.stdout }); }
        }
        case 'termux_wifi_scan': {
            const r = await termuxCli('termux-wifi-scaninfo', [], 15000);
            if (r.failed) return toolResult(res, false, 'WiFi scan failed', { error: r.stderr });
            try { const list = JSON.parse(r.stdout); return toolResult(res, true, 'Found ' + list.length + ' networks', { networks: list }); }
            catch (_) { return toolResult(res, true, 'WiFi scan done', { raw: r.stdout }); }
        }
        /* ────────── Termux:API — location ────────── */
        case 'termux_location': {
            const provider = String(a.provider || 'gps');
            const r = await termuxCli('termux-location', ['-p', provider, '-r', 'once'], 60000);
            if (r.failed) return toolResult(res, false, 'Location failed', { error: r.stderr });
            try {
                const d = JSON.parse(r.stdout);
                return toolResult(res, true, 'Location: ' + d.latitude + ', ' + d.longitude + ' (±' + d.accuracy + 'm)', d);
            } catch (_) { return toolResult(res, true, 'Location read', { raw: r.stdout }); }
        }
        /* ────────── Termux:API — share ────────── */
        case 'termux_share': {
            const file = a.file ? resolveInWorkspace(a.file) : null;
            const text = a.text ? String(a.text) : null;
            const title = String(a.title || 'Share from DeepSeek Studio');
            const argv = ['-t', title];
            if (file && fs.existsSync(file)) argv.push('-f', file);
            else if (text) argv.push('-c', 'text/plain', text);
            else return toolResult(res, false, 'Provide either file or text', { error: 'no content' });
            const r = await termuxCli('termux-share', argv, 8000);
            return toolResult(res, !r.failed, r.failed ? 'Share failed' : 'Share sheet opened', { ok: !r.failed });
        }
        /* ────────── Termux:API — camera photo ────────── */
        case 'termux_camera_photo': {
            const target = resolveInWorkspace(a.path || 'photo-' + Date.now() + '.jpg');
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            await fsp.mkdir(path.dirname(target), { recursive: true });
            const r = await termuxCli('termux-camera-photo', ['-c', String(a.camera || 0), target], 60000);
            return toolResult(res, !r.failed && fs.existsSync(target),
                r.failed ? 'Camera failed' : 'Photo saved: ' + path.relative(WORKSPACE, target),
                { ok: !r.failed, path: path.relative(WORKSPACE, target) });
        }
        /* ────────── Termux:API — fingerprint ────────── */
        case 'termux_fingerprint': {
            const r = await termuxCli('termux-fingerprint', [], 120000);
            return toolResult(res, true, 'Fingerprint: ' + (r.stdout.trim() || '(cancelled)'),
                { ok: !r.failed, cancelled: r.failed, raw: r.stdout });
        }
        /* ────────── Termux:API — sms ────────── */
        case 'termux_sms_send': {
            const number = String(a.number || '').trim();
            const body = String(a.message || '');
            if (!number || !body) return toolResult(res, false, 'number and message required', { error: 'missing fields' });
            const r = await termuxCli('termux-sms-send', ['-n', number, body], 15000);
            return toolResult(res, !r.failed, r.failed ? 'SMS failed' : ('SMS sent to ' + number), { ok: !r.failed });
        }
        /* ────────── Termux:API — call ────────── */
        case 'termux_call': {
            const number = String(a.number || '').trim();
            if (!number) return toolResult(res, false, 'number required', { error: 'missing' });
            const r = await termuxCli('termux-telephony-call', [number], 8000);
            return toolResult(res, !r.failed, r.failed ? 'Call failed' : ('Called ' + number), { ok: !r.failed });
        }
        /* ────────── Termux:API — storage ────────── */
        case 'termux_storage_info': {
            const r = await termuxCli('termux-storage-get', [], 100);
            // storage-get opens a picker — we want df instead
            const d = await run('sh', ['-c', 'df -h /data /storage/emulated/0 2>/dev/null | tail -n +2'], { timeout: 5000 });
            return toolResult(res, !d.failed, 'Storage info read', { raw: d.stdout });
        }
        /* ────────── Termux:API — sensors ────────── */
        case 'termux_sensor': {
            const sensor = String(a.sensor || '');
            const argv = sensor ? ['-s', sensor, '-l'] : ['-l'];
            const r = await termuxCli('termux-sensor', argv, 8000);
            return toolResult(res, !r.failed, r.failed ? 'Sensor read failed' : 'Sensors: ' + r.stdout.split('\n').length + ' lines', { raw: r.stdout.slice(0, 4000) });
        }
        /* ────────── Termux:API — contacts ────────── */
        case 'termux_contacts': {
            const r = await termuxCli('termux-contact-list', [], 10000);
            if (r.failed) return toolResult(res, false, 'Contacts read failed', { error: r.stderr });
            try {
                const list = JSON.parse(r.stdout);
                return toolResult(res, true, 'Found ' + list.length + ' contacts', { count: list.length, preview: list.slice(0, 20) });
            } catch (_) { return toolResult(res, true, 'Contacts read', { raw: r.stdout.slice(0, 2000) }); }
        }
        /* ────────── Termux:API — download ────────── */
        case 'termux_download': {
            const url = String(a.url || '');
            if (!/^https?:\/\//i.test(url)) return toolResult(res, false, 'Invalid URL', { error: 'bad url' });
            const target = resolveInWorkspace(a.path || 'download-' + Date.now());
            if (!target) return res.status(403).json({ error: 'outside workspace' });
            await fsp.mkdir(path.dirname(target), { recursive: true });
            const r = await termuxCli('termux-download', ['-t', target, url], 300000);
            return toolResult(res, !r.failed, r.failed ? 'Download failed' : ('Downloaded to ' + path.relative(WORKSPACE, target)),
                { ok: !r.failed, path: path.relative(WORKSPACE, target) });
        }
        /* ────────── Termux:API — brightness ────────── */
        case 'termux_brightness': {
            const level = a.level != null ? String(parseInt(a.level, 10)) : null;
            const argv = level ? [level] : [];
            const r = await termuxCli('termux-brightness', argv, 5000);
            return toolResult(res, !r.failed,
                r.failed ? 'Brightness failed (usually needs root / special permission)'
                    : (level ? 'Brightness set to ' + level : 'Brightness read'),
                { ok: !r.failed, raw: r.stdout });
        }
        /* ────────── Termux:API — infrared ────────── */
        case 'termux_ir_transmit': {
            const freq = String(parseInt(a.frequency, 10) || 38000);
            const pattern = Array.isArray(a.pattern) ? a.pattern.map((x) => String(parseInt(x, 10))).join(' ') : '';
            if (!pattern) return toolResult(res, false, 'pattern required (array of ints)', { error: 'missing pattern' });
            const r = await termuxCli('sh', ['-c', 'termux-infrared-transmit -f ' + freq + ' ' + pattern], 8000);
            return toolResult(res, !r.failed, r.failed ? 'IR transmit failed (device may not have IR blaster)' : 'IR transmitted', { ok: !r.failed });
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
   Git endpoints
   ═══════════════════════════════════════════════════════════════════ */
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
                g.status(), g.branchLocal().catch(() => ({ current: '' })), g.getRemotes(true).catch(() => []),
            ]);
            const changes = status.files.map((f) => f.path);
            const remoteLines = remotes.map((r) => r.name + '\t' + (r.refs && (r.refs.fetch || r.refs.push)) || '');
            return res.json({ isRepo: true, branch: branch.current || '', changes, changeCount: changes.length, remote: remoteLines[0] || '' });
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
        res.json({ isRepo: true, branch: (branch.stdout || 'unknown').trim(), changes, changeCount: changes.length, remote: remoteLines[0] || '' });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

app.post('/api/git/status/detailed', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            const s = await g.status(['--porcelain=v1', '-uall']);
            const files = s.files.map((f) => ({ status: (f.index || ' ') + (f.working_dir || ' '), path: f.path }));
            return res.json({ files });
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['status', '--porcelain=v1', '-uall']);
        const files = r.stdout.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2), path: l.slice(3) }));
        res.json({ files, error: r.failed ? r.stderr : null });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

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
            const commits = log.all.map((c) => ({ hash: c.hash, author: c.author, email: c.email, when: c.when, subject: c.subject, message: c.subject, date: c.when }));
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
        if (simpleGitFactory) { const g = getGit(rel); return res.json({ output: await g.show([hash, '--stat', '--patch']) }); }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['show', '--stat', '--patch', hash]);
        res.json({ output: r.stdout || r.stderr });
    } catch (e) { res.status(500).json({ error: redact(e.message) }); }
});

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
            if (opts.token) g.env({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: ASKPASS_HELPER, GIT_ASKPASS_TOKEN: opts.token });
            else g.env({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' });
            await g.clone(url, name, ['--progress']);
            return res.json(gitOk({ stdout: 'Cloned into ' + name, dir: name }));
        }
        const r = await gitLegacy(WORKSPACE, ['clone', '--progress', url, name], Object.assign({ timeout: 300000, maxBuffer: 30 * 1024 * 1024 }, opts));
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr, dir: name });
    } catch (e) { const err = gitErr(e); err.dir = name; res.status(500).json(err); }
});

app.post('/api/git/push', async (req, res) => {
    const { cwd, message, commitOnly } = req.body || {};
    const rel = cwd || '';
    const msg = String(message || 'Update').slice(0, 2000);
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            await g.add(['-A']);
            let commitOut = '', commitErr = '';
            try { const c = await g.commit(msg); commitOut = c.commit || 'committed'; }
            catch (e) {
                commitErr = redact(e.message || String(e));
                if (!/nothing to commit|no changes added|no changes/i.test(commitErr)) return res.json({ code: 1, ok: false, stdout: commitOut, stderr: commitErr });
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
        if (commit.failed && !/nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)) return res.json({ code: commit.code, ok: false, stdout: commit.stdout, stderr: commit.stderr });
        const push = await gitLegacy(workdir, ['push'], { timeout: 180000, token: ghToken() || undefined });
        res.json({ code: push.code, ok: !push.failed, stdout: commit.stdout + push.stdout, stderr: commit.stderr + push.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/pull', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            try { const r = await g.pull(['--no-edit']); const out = JSON.stringify(r); return res.json(gitOk({ stdout: out, conflicted: /CONFLICT/.test(out) })); }
            catch (e) { const m = redact(e.message || String(e)); return res.json({ code: 1, ok: false, conflicted: /CONFLICT/.test(m), stdout: '', stderr: m }); }
        }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['pull', '--no-edit'], { timeout: 180000, token: ghToken() || undefined });
        res.json({ code: r.code, ok: !r.failed && !/CONFLICT/.test(r.stdout + r.stderr), conflicted: /CONFLICT|Automatic merge failed/.test(r.stdout + r.stderr), stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/pull/rebase', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) { const g = getGit(rel); return res.json(gitOk({ stdout: JSON.stringify(await g.pull(['--rebase', '--no-edit'])) })); }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['pull', '--rebase', '--no-edit'], { timeout: 180000, token: ghToken() || undefined });
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/fetch', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) { const g = getGit(rel); return res.json(gitOk({ stdout: JSON.stringify(await g.fetch(['--all', '--prune'])) })); }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['fetch', '--all', '--prune'], { timeout: 180000, token: ghToken() || undefined });
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/set-remote', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    const url = String((req.body || {}).url || '');
    if (!url || !/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) return res.status(400).json({ error: 'invalid url' });
    try {
        if (simpleGitFactory) { const g = getGit(rel); await g.removeRemote('origin').catch(() => {}); const r = await g.addRemote('origin', url); return res.json(gitOk({ stdout: r || 'remote set' })); }
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
        res.json({ code: (r1.failed || r2.failed || r3.failed) ? 1 : 0, stdout: (r1.stdout + r2.stdout + r3.stdout), stderr: redact(r1.stderr + r2.stderr + r3.stderr) });
    } catch (err) { res.status(500).json(gitErr(err)); }
});

app.post('/api/git/branches', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) {
            const g = getGit(rel);
            const [local, remote] = await Promise.all([g.branchLocal().catch(() => ({ all: [], current: '' })), g.branch(['-r']).catch(() => ({ all: [] }))]);
            const remoteNames = remote.all.filter((b) => !b.includes('->') && b !== 'HEAD');
            return res.json({ branches: [...new Set([...local.all, ...remoteNames])], current: local.current || '', local: local.all, remote: remoteNames });
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
        if (simpleGitFactory) { const g = getGit(cwd || ''); await g.checkout(name); return res.json(gitOk({ stdout: 'Switched to ' + name })); }
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
            try { const r = await g.merge([source, '--no-edit']); return res.json(gitOk({ stdout: r || 'merged', conflicted: /CONFLICT/.test(String(r)) })); }
            catch (e) { const m = redact(e.message || String(e)); return res.json({ ok: false, conflicted: /CONFLICT/i.test(m), stdout: '', stderr: m, error: m }); }
        }
        const workdir = resolveInWorkspace(cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['merge', source, '--no-edit']);
        const out = r.stdout + r.stderr;
        res.json({ ok: !r.failed && !/CONFLICT/.test(out), conflicted: /CONFLICT|Automatic merge failed/.test(out), stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/merge/abort', async (req, res) => {
    try {
        if (simpleGitFactory) { const g = getGit((req.body || {}).cwd || ''); await g.raw(['merge', '--abort']); return res.json(gitOk({ stdout: 'Merge aborted' })); }
        const workdir = resolveInWorkspace((req.body || {}).cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['merge', '--abort']);
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/conflicts', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) { const g = getGit(rel); const out = await g.raw(['diff', '--name-only', '--diff-filter=U']); return res.json({ files: out.split('\n').filter(Boolean) }); }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['diff', '--name-only', '--diff-filter=U']);
        res.json({ files: r.stdout.split('\n').filter(Boolean) });
    } catch (e) { res.status(500).json({ error: redact(e.message), files: [] }); }
});

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
            if (Array.isArray(paths) && paths.length) { const safe = paths.filter((p) => typeof p === 'string' && !p.startsWith('-')); await g.add(safe); }
            else { await g.add(['-A']); }
            return res.json(gitOk({ stdout: 'staged' }));
        }
        const workdir = resolveInWorkspace(cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const args = ['add'];
        if (Array.isArray(paths) && paths.length) { for (const p of paths) { if (typeof p === 'string' && !p.startsWith('-')) args.push('--', p); } }
        else args.push('-A');
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
            default: out = await g.stash(message ? ['push', '-m', String(message).slice(0, 200)] : ['push']);
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
        if (simpleGitFactory) { const g = getGit(cwd || ''); await g.raw(['cherry-pick', hash]); return res.json(gitOk({ stdout: 'cherry-picked' })); }
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
        if (simpleGitFactory) { const g = getGit(cwd || ''); await g.raw(['revert', '--no-edit', hash]); return res.json(gitOk({ stdout: 'reverted' })); }
        const workdir = resolveInWorkspace(cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['revert', '--no-edit', hash], { timeout: 60000 });
        res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

/* ─── Tags — with list endpoint that populates the Git panel ─── */
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
            if (action === 'push') { await g.pushTags(); return res.json(gitOk({ stdout: 'tags pushed' })); }
            if (action === 'delete') { if (!validRef(name)) return res.status(400).json({ error: 'invalid tag name' }); await g.tag(['-d', name]); return res.json(gitOk({ stdout: 'tag deleted' })); }
            return res.status(400).json({ error: 'unknown action' });
        }
        const workdir = resolveInWorkspace(cwd || '');
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        if (action === 'list' || !action) { const r = await gitLegacy(workdir, ['tag', '--sort=-creatordate']); return res.json({ tags: r.stdout.split('\n').filter(Boolean) }); }
        if (action === 'create') {
            if (!validRef(name)) return res.status(400).json({ error: 'invalid tag name' });
            const r = await gitLegacy(workdir, ['tag', '-a', name, '-m', String(message || name).slice(0, 200)]);
            return res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr });
        }
        if (action === 'push') { const r = await gitLegacy(workdir, ['push', '--tags'], { timeout: 120000, token: ghToken() || undefined }); return res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr }); }
        if (action === 'delete') { if (!validRef(name)) return res.status(400).json({ error: 'invalid tag name' }); const r = await gitLegacy(workdir, ['tag', '-d', name]); return res.json({ code: r.code, ok: !r.failed, stdout: r.stdout, stderr: r.stderr }); }
        res.status(400).json({ error: 'unknown action' });
    } catch (e) { res.status(500).json(gitErr(e)); }
});

app.post('/api/git/tags/list', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) { const g = getGit(rel); const t = await g.tags(); return res.json({ tags: t.all }); }
        const workdir = resolveInWorkspace(rel);
        if (!workdir) return res.status(403).json({ error: 'Forbidden' });
        const r = await gitLegacy(workdir, ['tag', '--sort=-creatordate']);
        res.json({ tags: r.stdout.split('\n').filter(Boolean) });
    } catch (e) { res.status(500).json({ error: redact(e.message), tags: [] }); }
});

app.post('/api/git/undo', async (req, res) => {
    const rel = (req.body || {}).cwd || '';
    try {
        if (simpleGitFactory) { const g = getGit(rel); await g.raw(['reset', '--soft', 'HEAD~1']); return res.json(gitOk({ stdout: 'reverted last commit (soft)' })); }
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
        if (simpleGitFactory) { const g = getGit(rel); await g.init(['-b', 'main']).catch(async () => { await g.init(); }); return res.json(gitOk({ stdout: 'initialized' })); }
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
   GitHub REST API
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
        try { const { data } = await gh.users.getAuthenticated(); return res.json({ connected: true, login: data.login, name: data.name, avatar: data.avatar_url, publicRepos: data.public_repos }); }
        catch (e) { return res.json({ connected: false, error: redact(e.message) }); }
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
            return res.json({ repos: data.map((repo) => ({ name: repo.name, fullName: repo.full_name, private: repo.private, cloneUrl: repo.clone_url, sshUrl: repo.ssh_url, defaultBranch: repo.default_branch, updatedAt: repo.updated_at, description: repo.description })) });
        } catch (e) { return res.status(e.status || 500).json({ error: redact(e.message) }); }
    }
    const r = await githubApi('/user/repos?sort=updated&per_page=' + perPage);
    if (!r.ok) return res.status(r.status).json({ error: (r.data && r.data.message) || 'GitHub request failed' });
    res.json({ repos: (r.data || []).map((repo) => ({ name: repo.name, fullName: repo.full_name, private: repo.private, cloneUrl: repo.clone_url, sshUrl: repo.ssh_url, defaultBranch: repo.default_branch, updatedAt: repo.updated_at, description: repo.description })) });
});

app.post('/api/github/create-repo', async (req, res) => {
    const { name, description, isPrivate, autoInit } = req.body || {};
    if (!name || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) return res.status(400).json({ error: 'invalid repo name' });
    const gh = getOctokit();
    if (gh) {
        try {
            const { data } = await gh.repos.createForAuthenticatedUser({ name, description: description || '', private: isPrivate !== false, auto_init: autoInit === true });
            return res.json({ ok: true, repo: { fullName: data.full_name, cloneUrl: data.clone_url, sshUrl: data.ssh_url, defaultBranch: data.default_branch } });
        } catch (e) { return res.status(e.status || 500).json({ error: redact(e.message) }); }
    }
    const r = await githubApi('/user/repos', { method: 'POST', body: JSON.stringify({ name, description: description || '', private: isPrivate !== false, auto_init: autoInit === true }) });
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
            const { data } = await gh.pulls.create({ owner, repo, title, body: body || '', base: base || 'main', head: headBranch, draft: draft === true });
            return res.json({ ok: true, number: data.number, url: data.html_url });
        }
        const r = await githubApi('/repos/' + slug + '/pulls', { method: 'POST', body: JSON.stringify({ title, body: body || '', base: base || 'main', head: headBranch, draft: draft === true }) });
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

app.get('/api/ai/tools', (_req, res) => res.json({ tools: AI_TOOLS }));

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
    if (Array.isArray(tools) && tools.length && p.cfg.supportsTools) { payload.tools = tools; payload.tool_choice = toolChoice || 'auto'; }
    let upstream;
    try { upstream = await fetchWithRetry(p.cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.key }, body: JSON.stringify(payload) }, { retries: 2, timeout: 180000 }); }
    catch (err) { return res.status(502).json({ error: 'Upstream unreachable: ' + redact(err.message) }); }
    if (!upstream.ok) { const text = await upstream.text().catch(() => ''); return res.status(upstream.status).json({ error: 'Provider error ' + upstream.status, detail: redact(text).slice(0, 500) }); }
    if (stream === true && upstream.body) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        try { for await (const chunk of upstream.body) res.write(chunk); }
        catch (err) { res.write('data: ' + JSON.stringify({ error: redact(err.message) }) + '\n\n'); }
        return res.end();
    }
    res.json(await upstream.json());
});

app.post('/api/ai/stream', async (req, res) => {
    req.body = Object.assign({}, req.body, { stream: true });
    const { provider, messages, tools, toolChoice, model, temperature, maxTokens } = req.body || {};
    const p = resolveProvider(provider);
    if (!p || !p.configured) return res.status(400).json({ error: 'Provider not configured' });
    const payload = { model: model || p.cfg.model, messages: Array.isArray(messages) ? messages : [], temperature: typeof temperature === 'number' ? temperature : 0.3, max_tokens: typeof maxTokens === 'number' ? maxTokens : 4096, stream: true };
    if (Array.isArray(tools) && tools.length && p.cfg.supportsTools) { payload.tools = tools; payload.tool_choice = toolChoice || 'auto'; }
    let upstream;
    try { upstream = await fetchWithRetry(p.cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.key }, body: JSON.stringify(payload) }, { retries: 1, timeout: 180000 }); }
    catch (err) { return res.status(502).json({ error: redact(err.message) }); }
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
        const r = await fetchWithRetry(p.cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.key }, body: JSON.stringify({ model: p.cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }) }, { retries: 0, timeout: 30000 });
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
                        try { const st = fs.statSync(full); if (st.isDirectory()) walk(full); else { fileCount++; sizeBytes += st.size; } } catch (_) {}
                    }
                };
                walk(dir);
                const sizeStr = sizeBytes < 1024 ? sizeBytes + ' B' : sizeBytes < 1024 * 1024 ? (sizeBytes / 1024).toFixed(1) + ' KB' : (sizeBytes / 1024 / 1024).toFixed(1) + ' MB';
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
        try { const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); if (pkg.dependencies && pkg.dependencies['react-native']) return 'react-native'; } catch (_) {}
    }
    return null;
}

app.get('/api/deploy/check-tools', async (_req, res) => {
    const probe = async (cmd) => { const r = await run('sh', ['-c', cmd], { timeout: 15000 }); return !r.failed && !r.stdout.includes('MISSING'); };
    const [java, gradle, flutter, keytool] = await Promise.all([
        probe('java -version 2>&1 || echo MISSING'),
        probe('command -v gradle >/dev/null 2>&1 && gradle -v >/dev/null 2>&1 || echo MISSING'),
        probe('command -v flutter >/dev/null 2>&1 || echo MISSING'),
        probe('command -v keytool >/dev/null 2>&1 || echo MISSING'),
    ]);
    res.json({ java, gradle, flutter, keytool, androidSdk: !!(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT) });
});

app.post('/api/deploy/install-tools', async (req, res) => {
    const { tools } = req.body || {};
    const want = Array.isArray(tools) && tools.length ? tools : ['java', 'gradle', 'keytool'];
    const installers = {
        java:    'pkg install -y openjdk-17',
        keytool: 'pkg install -y openjdk-17',
        gradle:  'pkg install -y gradle',
        flutter: null,
        androidSdk: null,
    };
    const results = [];
    for (const t of want) {
        const cmd = installers[t];
        if (!cmd) { results.push({ tool: t, ok: false, skipped: true, reason: t + ' must be installed manually (see docs)' }); continue; }
        const r = await run('sh', ['-c', cmd], { timeout: 900000, maxBuffer: 30 * 1024 * 1024 });
        results.push({ tool: t, ok: !r.failed, code: r.failed ? (typeof r.code === 'number' ? r.code : 1) : 0, output: redact((r.stdout || '').slice(-2000) + (r.stderr ? '\n' + r.stderr.slice(-2000) : '')) });
    }
    const allOk = results.every((r) => r.ok || r.skipped);
    res.json({ ok: allOk, results });
});

app.get('/api/deploy/artifacts', (_req, res) => {
    const artifacts = [];
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const skip = new Set(['node_modules', '.git', 'dist', '.next', 'target']);
    const scanDir = (dir, depth) => {
        if (depth > 8 || artifacts.length >= 50) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            if (artifacts.length >= 50) return;
            if (skip.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { scanDir(full, depth + 1); continue; }
            if (!/\.(aab|apk)$/i.test(e.name)) continue;
            let st; try { st = fs.statSync(full); } catch (_) { continue; }
            if (st.mtimeMs < since) continue;
            artifacts.push({
                name: e.name,
                path: path.relative(WORKSPACE, full),
                absPath: full,
                size: st.size,
                sizeStr: st.size < 1024 ? st.size + ' B' : st.size < 1024 * 1024 ? (st.size / 1024).toFixed(1) + ' KB' : (st.size / 1024 / 1024).toFixed(2) + ' MB',
                mtime: new Date(st.mtimeMs).toISOString(),
                kind: /\.aab$/i.test(e.name) ? 'aab' : 'apk',
            });
        }
    };
    scanDir(WORKSPACE, 0);
    artifacts.sort((a, b) => b.mtime.localeCompare(a.mtime));
    res.json({ artifacts: artifacts.slice(0, 20) });
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
    const r = await run('keytool', ['-genkeypair', '-v', '-keystore', keystorePath, '-alias', aliasName, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-storepass', String(password), '-keypass', String(password), '-dname', dnameStr], { timeout: 60000 });
    if (r.failed) return res.status(500).json({ error: redact(r.stderr || r.stdout) });
    res.json({ ok: true, keystore: safeName });
});

app.get('/api/deploy/keystores', (_req, res) => {
    try { const list = fs.readdirSync(KEYSTORE_DIR).filter((f) => f.endsWith('.jks')).map((f) => f.replace(/\.jks$/, '')); res.json({ keystores: list }); }
    catch (_) { res.json({ keystores: [] }); }
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
    setHeaders: (res, filePath) => { if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache'); },
}));
app.get('/guide', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'guide.html')));
app.get(/^\/(?!api\/|ws).*/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use('/api/', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
app.use((err, _req, res, _next) => {
    const msg = redact(err && err.message ? err.message : String(err));
    console.error('[error]', msg);
    if (res.headersSent) return;
    res.status(err && err.status ? err.status : 500).json({ error: msg });
});

/* ═══════════════════════════════════════════════════════════════════
   HTTP + WebSocket PTY
   ═══════════════════════════════════════════════════════════════════ */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/pty' });

function resolveShell() {
    if (fs.existsSync(TERMUX_BASH)) return TERMUX_BASH;
    for (const candidate of ['/data/data/com.termux/files/usr/bin/bash', '/system/bin/sh', '/bin/bash', '/bin/sh']) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return 'bash';
}

wss.on('connection', (ws, req) => {
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
    if (!['127.0.0.1', '::1', 'localhost'].includes(ip)) { try { ws.close(1008, 'Forbidden'); } catch (_) {} return; }
    const shellBin = resolveShell();
    const shellEnv = { ...process.env, TERM: 'xterm-256color', DS_WORKSPACE: WORKSPACE };
    if (ptyLib) {
        let term;
        try { term = ptyLib.spawn(shellBin, ['-l'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: WORKSPACE, env: shellEnv }); }
        catch (err) { try { ws.send('\r\n[pty spawn failed: ' + redact(err.message) + ']\r\n'); } catch (_) {} try { ws.close(); } catch (_) {} return; }
        term.onData((d) => { try { ws.send(d); } catch (_) {} });
        term.onExit(({ exitCode }) => { try { ws.send('\r\n[process exited with code ' + exitCode + ']\r\n'); } catch (_) {} try { ws.close(); } catch (_) {} });
        ws.on('message', (raw) => {
            const msg = raw.toString('utf8');
            if (msg.startsWith('{')) {
                try {
                    const parsed = JSON.parse(msg);
                    if (parsed && parsed.type === 'resize' && parsed.cols > 0 && parsed.rows > 0) { term.resize(parsed.cols, parsed.rows); return; }
                    if (parsed && parsed.type === 'input') { term.write(parsed.data); return; }
                } catch (_) {}
            }
            term.write(msg);
        });
        ws.on('close', () => { try { term.kill(); } catch (_) {} });
        ws.on('error', () => { try { term.kill(); } catch (_) {} });
        return;
    }
    let shell;
    try { shell = require('child_process').spawn(shellBin, ['-l'], { cwd: WORKSPACE, env: shellEnv, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (err) { try { ws.send('\r\n[error] failed to start shell: ' + redact(err.message) + '\r\n'); } catch (_) {} try { ws.close(); } catch (_) {} return; }
    shell.stdout.on('data', (d) => { try { ws.send(d.toString('utf8')); } catch (_) {} });
    shell.stderr.on('data', (d) => { try { ws.send(d.toString('utf8')); } catch (_) {} });
    shell.on('exit', (code) => { try { ws.send('\r\n[process exited with code ' + code + ']\r\n'); } catch (_) {} try { ws.close(); } catch (_) {} });
    ws.on('message', (raw) => {
        const msg = raw.toString('utf8');
        if (msg.startsWith('{')) {
            try {
                const parsed = JSON.parse(msg);
                if (parsed && parsed.type === 'input' && shell.stdin.writable) { shell.stdin.write(parsed.data); return; }
                if (parsed && parsed.type === 'resize') return;
            } catch (_) {}
        }
        if (shell.stdin.writable) shell.stdin.write(msg);
    });
    ws.on('close', () => { try { shell.kill('SIGTERM'); } catch (_) {} setTimeout(() => { try { shell.kill('SIGKILL'); } catch (_) {} }, 2000); });
    ws.on('error', () => { try { shell.kill('SIGKILL'); } catch (_) {} });
});

/* ═══════════════════════════════════════════════════════════════════
   Shutdown + Boot
   ═══════════════════════════════════════════════════════════════════ */
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[' + signal + '] Shutting down...');
    try { wss.close(); } catch (_) {}
    try { require('child_process').execSync('command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock', { timeout: 3000, stdio: 'ignore' }); console.log('\uD83D\uDD13 Wake lock released'); } catch (_) {}
    server.close(() => { console.log('Server closed.'); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => { console.error('[uncaughtException]', redact(err && err.message)); if (err && err.stack) console.error(redact(err.stack)); });
process.on('unhandledRejection', (reason) => { console.error('[unhandledRejection]', redact(reason && reason.message ? reason.message : reason)); });

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
    console.log('  DeepSeek Studio — Backend v' + PKG_VERSION);
    console.log('  Node ' + process.version + ' · FULL DEVELOPER MODE');
    console.log(line);
    console.log('  URL:       http://' + HOST + ':' + PORT);
    console.log('  Workspace: ' + WORKSPACE);
    console.log('  Backups:   ' + SD_BACKUP);
    console.log('  Keystores: ' + KEYSTORE_DIR);
    console.log('  SD Card:   ' + (fs.existsSync(SD_CARD_ROOT) ? 'detected' : 'NOT FOUND'));
    console.log('  GitHub:    ' + (ghToken() ? 'token configured' : 'no token'));
    console.log('  Links:     ' + Object.keys(links).length + ' external folder(s)');
    console.log(line);
    console.log('  Libraries:');
    console.log('    simple-git    ' + (simpleGitFactory ? '\u2713' : '\u2717 (using execFile)'));
    console.log('    @octokit/rest ' + (OctokitLib       ? '\u2713' : '\u2717 (using fetch)'));
    console.log('    node-pty      ' + (ptyLib          ? '\u2713' : '\u2717 (using pipe)'));
    console.log('    editkit       ' + (editkitLib      ? '\u2713' : '\u2717 (using exact match)'));
    console.log('    termux-api    ' + (termuxApiLib    ? '\u2713' : '\u2717 (using CLI fallback)'));
    console.log(line);
    console.log('  Developer tools:');
    console.log('    compile       \u2713 (15+ languages)');
    console.log('    license       \u2713 (AAB gate)');
    console.log('    install-tools \u2713 (openjdk-17, gradle)');
    console.log('    artifacts     \u2713 (AAB/APK scanner)');
    console.log('    termux:api    \u2713 (18 tools)');
    console.log(line);
    console.log('');
});

module.exports = app;
