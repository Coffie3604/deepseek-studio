const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const PORT = 3001;
const WORKSPACE = path.join(process.env.HOME, 'deepseek-projects');
const SD_BACKUP = path.join(process.env.HOME, 'storage/external-1/DeepSeekBackups');
const SD_CARD_ROOT = path.join(process.env.HOME, 'storage/external-1');
const KEYSTORE_DIR = path.join(process.env.HOME, '.deepseek-keystores');
const LICENSE_FILE = path.join(process.env.HOME, '.deepseek-license');
const PRO_LICENSE_PREFIX = 'DS-PRO-';
const PKG_VERSION = require('./package.json').version;

if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true });
if (!fs.existsSync(KEYSTORE_DIR)) fs.mkdirSync(KEYSTORE_DIR, { recursive: true });

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ══════════ WAKE LOCK ══════════ */
// Acquire wake lock so Android doesn't kill us during long builds/tests
try {
    const { execSync } = require('child_process');
    execSync('command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock', { timeout: 5000 });
    console.log('🔒 Wake lock acquired');
} catch (e) {
    console.log('ℹ️  Wake lock not available (run: pkg install termux-api)');
}

/* ══════════ SAFETY ══════════ */
const BLOCKED_PATTERNS = [
    /rm\s+-rf\s+\/(?!data\/data\/com\.termux)/,
    /\bsudo\b/, /\bsu\b\s/, /\bmkfs\b/,
    /\bdd\s+if=\/dev\/(zero|random|urandom)/,
    /:\(\)\{.*\};:/,
    />\s*\/dev\/sd[a-z]/,
    /\bchmod\s+-R\s+777\s+\//,
    /\bmv\s+\/\*\s+\/tmp/,
    /\bchown\s+-R\s+root/,
];
function isCommandBlocked(cmd) {
    for (const p of BLOCKED_PATTERNS) if (p.test(cmd)) return p.source;
    return null;
}
// True only when `resolved` is `base` itself or a descendant of it.
// A plain startsWith() check is unsafe: "/home/x/deepseek-projects-evil"
// would pass a startsWith("/home/x/deepseek-projects") test.
function withinBase(base, resolved) {
    const b = path.resolve(base);
    const r = path.resolve(resolved);
    return r === b || r.startsWith(b + path.sep);
}
function isWithinWorkspace(p) {
    try {
        return withinBase(WORKSPACE, path.resolve(WORKSPACE, p || ''));
    } catch (e) { return false; }
}

/* ══════════ VERSION + HEALTH + RATE LIMIT ══════════ */
app.get('/api/version', (req, res) => {
    res.json({
        version: PKG_VERSION,
        node: process.version,
        uptime: process.uptime(),
        workspace: WORKSPACE,
        sdCard: fs.existsSync(SD_CARD_ROOT),
    });
});
app.get('/api/health', (req, res) => {
    res.json({ ok: true, ts: Date.now() });
});

const rateLimitMap = new Map();
app.use('/api/', function(req, res, next) {
    const ip = req.ip || 'local';
    const now = Date.now();
    const w = rateLimitMap.get(ip) || { count: 0, reset: now + 60000 };
    if (now > w.reset) { w.count = 0; w.reset = now + 60000; }
    w.count++;
    rateLimitMap.set(ip, w);
    if (w.count > 300) return res.status(429).json({ error: 'Too many requests' });
    next();
});
// Periodically drop stale rate-limit buckets so the map can't grow without bound.
setInterval(() => {
    const now = Date.now();
    for (const [ip, w] of rateLimitMap) if (now > w.reset) rateLimitMap.delete(ip);
}, 5 * 60 * 1000).unref();

/* ══════════ PROCESSES ══════════ */
app.get('/api/processes', (req, res) => {
    exec('ps -eo pid,comm,args --no-headers 2>/dev/null | head -40', { timeout: 5000 }, (err, stdout) => {
        if (err) return res.json({ processes: [] });
        const lines = (stdout || '').split('\n').filter(Boolean);
        const processes = lines.map(l => {
            const parts = l.trim().split(/\s+/);
            return { pid: parts[0], command: parts.slice(2).join(' ').slice(0, 80) };
        }).filter(p => p.pid && /^\d+$/.test(p.pid) && p.command);
        res.json({ processes });
    });
});
app.post('/api/processes/kill', (req, res) => {
    const { pid } = req.body || {};
    if (!pid || !/^\d+$/.test(String(pid))) return res.status(400).json({ error: 'invalid pid' });
    const n = parseInt(pid, 10);
    if (n === process.pid || n === 1) return res.status(403).json({ error: 'protected' });
    exec('kill ' + n + ' 2>&1', (err, so, se) => {
        res.json({ ok: !err, error: err ? (se || err.message) : null });
    });
});

/* ══════════ FILESYSTEM ══════════ */
app.get('/api/fs/list', (req, res) => {
    const target = path.join(WORKSPACE, req.query.path || '');
    if (!withinBase(WORKSPACE, target)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const items = fs.readdirSync(target, { withFileTypes: true })
            .filter(d => d.name !== '.gitkeep' && d.name !== '.git')
            .map(d => ({
                name: d.name, isDir: d.isDirectory(),
                path: path.relative(WORKSPACE, path.join(target, d.name)).replace(/\\/g, '/'),
            }));
        items.sort((a, b) => a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
        res.json(items);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/fs/read', (req, res) => {
    const target = path.join(WORKSPACE, req.query.path);
    if (!withinBase(WORKSPACE, target)) return res.status(403).json({ error: 'Forbidden' });
    try { res.json({ content: fs.readFileSync(target, 'utf8') }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/fs/write', (req, res) => {
    const target = path.join(WORKSPACE, req.body.path);
    if (!withinBase(WORKSPACE, target)) return res.status(403).json({ error: 'Forbidden' });
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, req.body.content != null ? req.body.content : '', 'utf8');
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/fs/delete', (req, res) => {
    const target = path.join(WORKSPACE, req.query.path);
    if (!withinBase(WORKSPACE, target)) return res.status(403).json({ error: 'Forbidden' });
    try { fs.rmSync(target, { recursive: true, force: true }); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/fs/rename', (req, res) => {
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) return res.status(400).json({ error: 'paths required' });
    const src = path.join(WORKSPACE, oldPath);
    const dst = path.join(WORKSPACE, newPath);
    if (!withinBase(WORKSPACE, src) || !withinBase(WORKSPACE, dst)) return res.status(403).json({ error: 'Forbidden' });
    try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════ SHELL EXEC ══════════ */
app.post('/api/exec', (req, res) => {
    const { cmd, cwd } = req.body;
    if (!cmd) return res.status(400).json({ error: 'cmd required' });
    const blocked = isCommandBlocked(cmd);
    if (blocked) return res.status(403).json({ error: 'Blocked: ' + blocked });
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    exec(cmd, { cwd: workdir, timeout: 300000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        res.json({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
});

/* ══════════ AI TOOL CALLS ══════════ */
app.post('/api/ai/tool-call', (req, res) => {
    const { name, args } = req.body || {};
    if (!name) return res.status(400).json({ error: 'tool name required' });
    const a = args || {};
    try {
        if (name === 'write_file') {
            const target = path.join(WORKSPACE, a.path || '');
            if (!isWithinWorkspace(a.path)) return res.status(403).json({ error: 'outside workspace' });
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, a.content != null ? a.content : '', 'utf8');
            return res.json({ ok: true, display: 'Wrote ' + (a.content || '').length + ' bytes to ' + a.path, result: { bytes: (a.content || '').length } });
        }
        if (name === 'read_file') {
            const target = path.join(WORKSPACE, a.path || '');
            if (!isWithinWorkspace(a.path)) return res.status(403).json({ error: 'outside workspace' });
            if (!fs.existsSync(target)) return res.json({ ok: false, display: 'Not found: ' + a.path });
            const content = fs.readFileSync(target, 'utf8');
            return res.json({ ok: true, display: 'Read ' + content.length + ' bytes', result: { content: content.slice(0, 10000) } });
        }
        if (name === 'list_files') {
            const target = path.join(WORKSPACE, a.path || '');
            if (!isWithinWorkspace(a.path || '')) return res.status(403).json({ error: 'outside workspace' });
            if (!fs.existsSync(target)) return res.json({ ok: false, display: 'Not found: ' + a.path });
            const items = fs.readdirSync(target, { withFileTypes: true })
                .filter(d => d.name !== '.gitkeep' && d.name !== '.git')
                .map(d => (d.isDirectory() ? '📁 ' : '📄 ') + d.name);
            return res.json({ ok: true, display: 'Listed ' + items.length + ' items', result: { items } });
        }
        if (name === 'create_folder') {
            const target = path.join(WORKSPACE, a.path || '');
            if (!isWithinWorkspace(a.path)) return res.status(403).json({ error: 'outside workspace' });
            fs.mkdirSync(target, { recursive: true });
            return res.json({ ok: true, display: 'Created: ' + a.path, result: { ok: true } });
        }
        if (name === 'delete_file') {
            if (!isWithinWorkspace(a.path)) return res.status(403).json({ error: 'outside workspace' });
            const target = path.join(WORKSPACE, a.path);
            if (!fs.existsSync(target)) return res.json({ ok: false, display: 'Not found' });
            fs.rmSync(target, { recursive: true, force: true });
            return res.json({ ok: true, display: 'Deleted: ' + a.path, result: { ok: true } });
        }
        if (name === 'run_command') {
            const cmd = a.command || '';
            if (!cmd) return res.status(400).json({ error: 'command required' });
            const blocked = isCommandBlocked(cmd);
            if (blocked) return res.status(403).json({ error: 'Blocked: ' + blocked });
            const cwd = a.cwd ? path.join(WORKSPACE, a.cwd) : WORKSPACE;
            if (!withinBase(WORKSPACE, cwd)) return res.status(403).json({ error: 'outside workspace' });
            const isBg = a.background === true;
            const timeout = isBg ? 3000 : 120000;
            exec(cmd, { cwd, timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (isBg && err && err.killed) {
                    return res.json({ ok: true, display: 'Started bg: ' + cmd.slice(0, 60), result: { background: true } });
                }
                const output = (stdout || '') + (stderr ? '\n' + stderr : '');
                const trimmed = output.length > 4000 ? output.slice(0, 4000) + '\n...(truncated)' : output;
                res.json({ ok: !err, display: 'Ran: ' + cmd.slice(0, 60) + (err ? ' (exit ' + (err.code || '?') + ')' : ' ✓'), result: { code: err ? (err.code || 1) : 0, output: trimmed } });
            });
            return;
        }
        if (name === 'apply_patch') {

            const target = path.join(WORKSPACE, a.path || '');

            if (!isWithinWorkspace(a.path)) return res.status(403).json({ error: 'outside workspace' });

            if (!fs.existsSync(target)) return res.json({ ok: false, display: 'File not found: ' + a.path + ' — use read_file or write_file first', result: { error: 'not found' } });

            let content;

            try { content = fs.readFileSync(target, 'utf8'); }

            catch (e) { return res.json({ ok: false, display: 'Cannot read ' + a.path + ': ' + e.message }); }

            const search = a.search || '';

            const replace = a.replace || '';

            if (!search) return res.status(400).json({ error: 'search string required' });

            let idx = 0, count = 0;

            while ((idx = content.indexOf(search, idx)) !== -1) { count++; idx += search.length; }

            if (count === 0) {

                const norm = s => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');

                const normContent = norm(content);

                const normSearch = norm(search);

                if (normSearch && normContent.includes(normSearch)) {

                    // Re-apply on the ORIGINAL content's normalized form, but preserve original CRLF if present.

                    const usesCRLF = content.includes('\r\n');

                    const newNormalized = normContent.replace(normSearch, norm(replace));

                    const finalContent = usesCRLF ? newNormalized.replace(/\n/g, '\r\n') : newNormalized;

                    fs.writeFileSync(target, finalContent, 'utf8');

                    return res.json({ ok: true, display: 'Patched ' + a.path + ' (normalized whitespace; CRLF=' + usesCRLF + ')', result: { path: a.path, replaced: 1 } });

                }

                return res.json({ ok: false, display: 'search string NOT found in ' + a.path + ' — read_file first to see exact content, then match 3-5 lines of context', result: { error: 'not found' } });

            }

            if (count > 1 && !a.replace_all) {

                return res.json({ ok: false, display: 'search matches ' + count + ' times — add more context to make it unique, or set replace_all=true', result: { error: 'multiple matches', count } });

            }

            content = a.replace_all ? content.split(search).join(replace) : content.replace(search, replace);

            fs.writeFileSync(target, content, 'utf8');

            return res.json({ ok: true, display: 'Patched ' + a.path + ' (' + count + ' replacement' + (count > 1 ? 's' : '') + ')', result: { path: a.path, replaced: count } });

        }

        if (name === 'grep_search') {

            const pattern = a.pattern || '';

            if (!pattern) return res.status(400).json({ error: 'pattern required' });

            const searchPath = a.path ? path.join(WORKSPACE, a.path) : WORKSPACE;

            if (!isWithinWorkspace(a.path || '')) return res.status(403).json({ error: 'outside workspace' });

            const flags = a.ignoreCase ? '-i' : '';

            const escaped = pattern.replace(/"/g, '\\"');

            const cmd = 'grep -rnI ' + flags +

                ' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=build' +

                ' --exclude-dir=.dart_tool --exclude-dir=dist --exclude-dir=.next' +

                ' -- "' + escaped + '" "' + searchPath + '" 2>&1 | head -60';

            exec(cmd, { cwd: WORKSPACE, timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {

                const lines = (stdout || '').trim().split('\n').filter(Boolean);

                const cleaned = lines.map(l => l.replace(WORKSPACE + '/', '')).slice(0, 40);

                return res.json({

                    ok: true,

                    display: 'Found ' + cleaned.length + ' match(es) for "' + pattern + '"',

                    result: { matches: cleaned, count: cleaned.length }

                });

            });

            return;

        }

        if (name === 'find_files') {

            const pattern = a.pattern || '';

            if (!pattern) return res.status(400).json({ error: 'pattern required' });

            const searchPath = a.path ? path.join(WORKSPACE, a.path) : WORKSPACE;

            if (!isWithinWorkspace(a.path || '')) return res.status(403).json({ error: 'outside workspace' });

            const escaped = pattern.replace(/"/g, '\\"');

            const cmd = 'find "' + searchPath + '" -maxdepth 8 -type f -name "' + escaped + '"' +

                ' -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/build/*"' +

                ' -not -path "*/.dart_tool/*" -not -path "*/dist/*" -not -path "*/.next/*"' +

                ' 2>&1 | head -50';

            exec(cmd, { cwd: WORKSPACE, timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {

                const lines = (stdout || '').trim().split('\n').filter(Boolean);

                const cleaned = lines.map(l => l.replace(WORKSPACE + '/', ''));

                return res.json({

                    ok: true,

                    display: 'Found ' + cleaned.length + ' file(s) matching "' + pattern + '"',

                    result: { files: cleaned, count: cleaned.length }

                });

            });

            return;

        }

        if (name === 'notify') {

            const rawTitle = a.title || 'DeepSeek Studio';

            const rawMsg = a.message || 'Done';

            // Escape single-quotes and backslashes for shell single-quoted string

            const shellEscape = s => String(s).replace(/'/g, "'\\''");

            const cmd = 'termux-notification --title ' + "'" + shellEscape(rawTitle) + "'" +

                ' --content ' + "'" + shellEscape(rawMsg) + "'" +

                ' --priority high --vibrate 300 2>&1';

            exec(cmd, { timeout: 5000 }, (err) => {

                return res.json({

                    ok: !err,

                    display: err ? 'Notification failed — is termux-api installed?' : 'Notified: ' + rawTitle,

                    result: { ok: !err }

                });

            });

            return;

        }

        return res.status(400).json({ error: 'Unknown tool: ' + name });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ══════════ LANGUAGE DETECTION ══════════ */
app.get('/api/detect-language', (req, res) => {
    const dir = path.join(WORKSPACE, req.query.path || '');
    if (!withinBase(WORKSPACE, dir)) return res.status(403).json({ error: 'Forbidden' });
    const checks = [
        { file: 'pubspec.yaml', lang: 'flutter', build: 'flutter build apk --debug', run: 'flutter run' },
        { file: 'build.gradle.kts', lang: 'kotlin', build: './gradlew build', run: './gradlew run' },
        { file: 'build.gradle', lang: 'java-gradle', build: './gradlew build', run: './gradlew run' },
        { file: 'pom.xml', lang: 'java-maven', build: 'mvn package', run: 'mvn exec:java' },
        { file: 'package.json', lang: 'node', build: 'npm install', run: 'npm start' },
        { file: 'requirements.txt', lang: 'python', build: 'pip install -r requirements.txt', run: 'python main.py' },
        { file: 'Cargo.toml', lang: 'rust', build: 'cargo build', run: 'cargo run' },
        { file: 'go.mod', lang: 'go', build: 'go build', run: 'go run .' },
        { file: 'index.html', lang: 'web', build: null, run: 'python -m http.server 8080' },
    ];
    let detected = { lang: 'unknown', build: null, run: null };
    try {
        const files = fs.readdirSync(dir);
        for (const c of checks) if (files.includes(c.file)) { detected = { lang: c.lang, build: c.build, run: c.run }; break; }
    } catch (e) {}
    res.json(detected);
});

/* ══════════ COMPILE ══════════ */
app.post('/api/compile', (req, res) => {
    const { path: filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const target = path.join(WORKSPACE, filePath);
    if (!withinBase(WORKSPACE, target)) return res.status(403).json({ error: 'Forbidden' });
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'File not found' });
    const ext = filePath.split('.').pop().toLowerCase();
    const nameNoExt = path.basename(filePath, '.' + ext);
    const dir = path.dirname(target);
    const relDir = path.relative(WORKSPACE, dir).replace(/\\/g, '/');
    let cmd = null;
    switch (ext) {
        case 'kt': cmd = 'kotlinc "' + path.basename(target) + '" -include-runtime -d "' + nameNoExt + '.jar" && java -jar "' + nameNoExt + '.jar"'; break;
        case 'java': cmd = 'javac "' + path.basename(target) + '" && java ' + nameNoExt; break;
        case 'py': cmd = 'python "' + path.basename(target) + '"'; break;
        case 'js': cmd = 'node "' + path.basename(target) + '"'; break;
        case 'ts': cmd = 'npx ts-node "' + path.basename(target) + '"'; break;
        case 'go': cmd = 'go run "' + path.basename(target) + '"'; break;
        case 'rs': cmd = 'rustc "' + path.basename(target) + '" -o "' + nameNoExt + '" && ./"' + nameNoExt + '"'; break;
        case 'dart': cmd = 'dart run "' + path.basename(target) + '"'; break;
        case 'c': cmd = 'gcc "' + path.basename(target) + '" -o "' + nameNoExt + '" && ./"' + nameNoExt + '"'; break;
        case 'cpp': cmd = 'g++ "' + path.basename(target) + '" -o "' + nameNoExt + '" && ./"' + nameNoExt + '"'; break;
        case 'sh': cmd = 'bash "' + path.basename(target) + '"'; break;
        case 'html': return res.json({ ok: true, display: 'HTML — preview with browser', cmd: 'python -m http.server 8080', cwd: relDir });
        default: return res.status(400).json({ error: 'No compiler for .' + ext });
    }
    exec(cmd, { cwd: dir, timeout: 300000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        const output = (stdout || '') + (stderr ? '\n' + stderr : '');
        res.json({ ok: !err, cmd, cwd: relDir, code: err ? (err.code || 1) : 0, output });
    });
});

/* ══════════ GIT: BASICS ══════════ */
app.post('/api/git/status', (req, res) => {
    const { cwd } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    exec('git rev-parse --is-inside-work-tree 2>&1', { cwd: workdir }, (err, stdout) => {
        if (err || !stdout.includes('true')) return res.json({ isRepo: false });
        exec('git branch --show-current 2>&1 && echo "---" && git status --porcelain 2>&1 && echo "---" && git remote -v 2>&1', { cwd: workdir }, (e2, o2) => {
            const parts = (o2 || '').split('---').map(s => s.trim());
            const branch = parts[0] || 'unknown';
            const changes = (parts[1] || '').split('\n').filter(Boolean);
            const remotes = (parts[2] || '').split('\n').filter(Boolean);
            res.json({ isRepo: true, branch, changes, changeCount: changes.length, remote: remotes[0] || '' });
        });
    });
});
app.post('/api/git/log', (req, res) => {
    const { cwd } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    exec('git log --oneline -10 2>&1', { cwd: workdir, timeout: 10000 }, (err, stdout) => {
        res.json({ log: stdout || '', error: err ? err.message : null });
    });
});
app.post('/api/git/init', (req, res) => {
    const { cwd, branch } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    exec('git init -b ' + (branch || 'main') + ' 2>&1 || git init 2>&1', { cwd: workdir }, (err, so, se) => {
        res.json({ code: err ? 1 : 0, stdout: so || '', stderr: se || '' });
    });
});
app.post('/api/git/clone', (req, res) => {
    const { url, dir } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    const name = dir || url.split('/').pop().replace(/\.git$/, '');
    const target = path.join(WORKSPACE, name);
    if (!withinBase(WORKSPACE, target)) return res.status(403).json({ error: 'Forbidden' });
    if (fs.existsSync(target)) return res.status(400).json({ error: 'Directory exists: ' + name });
    exec('git clone "' + url + '" "' + name + '" 2>&1', { cwd: WORKSPACE, timeout: 180000 }, (err, so, se) => {
        res.json({ code: err ? 1 : 0, stdout: so || '', stderr: se || '', dir: name });
    });
});
app.post('/api/git/push', (req, res) => {
    const { cwd, message, commitOnly } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    const msg = (message || 'Update').replace(/"/g, '\\"');
    const cmd = commitOnly
        ? 'git add -A && git commit -m "' + msg + '" 2>&1'
        : 'git add -A && git commit -m "' + msg + '" 2>&1; git push 2>&1';
    exec(cmd, { cwd: workdir, timeout: 60000 }, (err, so, se) => {
        res.json({ code: err ? 1 : 0, stdout: so || '', stderr: se || '' });
    });
});
app.post('/api/git/pull', (req, res) => {
    const { cwd } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    exec('git pull 2>&1', { cwd: workdir, timeout: 60000 }, (err, so, se) => {
        res.json({ code: err ? 1 : 0, stdout: so || '', stderr: se || '' });
    });
});
app.post('/api/git/set-remote', (req, res) => {
    const { cwd, url } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    if (!url) return res.status(400).json({ error: 'url required' });
    exec('git remote remove origin 2>/dev/null; git remote add origin "' + url + '" 2>&1 && echo OK', { cwd: workdir }, (err, so, se) => {
        res.json({ code: err ? 1 : 0, stdout: so || '', stderr: se || '' });
    });
});
app.post('/api/git/set-identity', (req, res) => {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email required' });
    exec('git config --global user.name "' + name + '" && git config --global user.email "' + email + '" && git config --global credential.helper store && echo OK', { timeout: 10000 }, (err, so, se) => {
        res.json({ code: err ? 1 : 0, stdout: so || '', stderr: se || '' });
    });
});

/* ══════════ GIT: BRANCHES ══════════ */
app.post('/api/git/branches', (req, res) => {
    const { cwd } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    exec('git branch -a 2>&1 && echo "---" && git branch --show-current 2>&1', { cwd: workdir, timeout: 10000 }, (err, stdout) => {
        const parts = (stdout || '').split('---').map(s => s.trim());
        const all = (parts[0] || '').split('\n').filter(Boolean).map(b => b.replace(/^\*\s*/, '').trim());
        res.json({ branches: all, current: (parts[1] || '').trim(), error: err ? err.message : null });
    });
});
app.post('/api/git/branch/create', (req, res) => {
    const { cwd, name, checkout } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir) || !name) return res.status(403).json({ error: 'invalid' });
    const cmd = checkout ? 'git checkout -b "' + name + '" 2>&1' : 'git branch "' + name + '" 2>&1';
    exec(cmd, { cwd: workdir, timeout: 15000 }, (err, so, se) => {
        res.json({ ok: !err, stdout: so || '', stderr: se || '' });
    });
});
app.post('/api/git/branch/checkout', (req, res) => {
    const { cwd, name } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir) || !name) return res.status(403).json({ error: 'invalid' });
    exec('git checkout "' + name + '" 2>&1', { cwd: workdir, timeout: 15000 }, (err, so, se) => {
        res.json({ ok: !err, stdout: so || '', stderr: se || '' });
    });
});
app.post('/api/git/branch/delete', (req, res) => {
    const { cwd, name, force } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir) || !name) return res.status(403).json({ error: 'invalid' });
    exec('git branch ' + (force ? '-D' : '-d') + ' "' + name + '" 2>&1', { cwd: workdir, timeout: 15000 }, (err, so, se) => {
        res.json({ ok: !err, stdout: so || '', stderr: se || '' });
    });
});
app.post('/api/git/branch/merge', (req, res) => {
    const { cwd, source } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir) || !source) return res.status(403).json({ error: 'invalid' });
    exec('git merge "' + source + '" --no-edit 2>&1', { cwd: workdir, timeout: 30000 }, (err, so, se) => {
        const out = (so || '') + (se || '');
        res.json({ ok: !err && !/CONFLICT/.test(out), conflicted: /CONFLICT|Automatic merge failed/.test(out), stdout: so || '', stderr: se || '' });
    });
});

/* ══════════ GIT: STATUS/DETAILED + DIFF ══════════ */
app.post('/api/git/status/detailed', (req, res) => {
    const { cwd } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    exec('git status --porcelain=v1 -uall 2>&1', { cwd: workdir, timeout: 10000 }, (err, stdout) => {
        const lines = (stdout || '').split('\n').filter(Boolean);
        const files = lines.map(l => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
        res.json({ files, error: err ? err.message : null });
    });
});
app.post('/api/git/diff', (req, res) => {
    const { cwd, file } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    const target = file ? ' -- "' + file + '"' : '';
    exec('git diff --no-color' + target + ' 2>&1; echo "---STAGED---"; git diff --cached --no-color' + target + ' 2>&1', { cwd: workdir, timeout: 15000 }, (err, stdout) => {
        const parts = (stdout || '').split('---STAGED---');
        res.json({ unstaged: parts[0] || '', staged: parts[1] || '', error: err ? err.message : null });
    });
});

/* ══════════ GIT: ADD / RESET / STASH ══════════ */
app.post('/api/git/add', (req, res) => {
    const { cwd, paths } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    const target = paths && paths.length ? paths.map(p => '"' + p + '"').join(' ') : '-A';
    exec('git add ' + target + ' 2>&1', { cwd: workdir, timeout: 15000 }, (err, so, se) => {
        res.json({ ok: !err, stdout: so || '', stderr: se || '' });
    });
});
app.post('/api/git/reset', (req, res) => {
    const { cwd, paths, hard } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    let cmd;
    if (hard) cmd = 'git reset --hard HEAD 2>&1';
    else if (paths && paths.length) cmd = 'git reset HEAD ' + paths.map(p => '"' + p + '"').join(' ') + ' 2>&1';
    else cmd = 'git reset HEAD 2>&1';
    exec(cmd, { cwd: workdir, timeout: 15000 }, (err, so, se) => {
        res.json({ ok: !err, stdout: so || '', stderr: se || '' });
    });
});
app.post('/api/git/stash', (req, res) => {
    const { cwd, action, message } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    let cmd = 'git stash 2>&1';
    if (action === 'list') cmd = 'git stash list 2>&1';
    else if (action === 'pop') cmd = 'git stash pop 2>&1';
    else if (action === 'apply') cmd = 'git stash apply 2>&1';
    else if (action === 'drop') cmd = 'git stash drop 2>&1';
    else if (action === 'clear') cmd = 'git stash clear 2>&1';
    else if (action === 'push' && message) cmd = 'git stash push -m "' + message.replace(/"/g, '\\"') + '" 2>&1';
    exec(cmd, { cwd: workdir, timeout: 20000 }, (err, so, se) => {
        res.json({ ok: !err, stdout: so || '', stderr: se || '' });
    });
});

/* ══════════ GIT: CONFLICTS + MERGE ABORT ══════════ */
app.post('/api/git/conflicts', (req, res) => {
    const { cwd } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    exec('git diff --name-only --diff-filter=U 2>&1', { cwd: workdir, timeout: 10000 }, (err, stdout) => {
        const files = (stdout || '').split('\n').filter(Boolean);
        res.json({ files });
    });
});
app.post('/api/git/merge/abort', (req, res) => {
    const { cwd } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    exec('git merge --abort 2>&1', { cwd: workdir, timeout: 15000 }, (err, so, se) => {
        res.json({ ok: !err, stdout: so || '', stderr: se || '' });
    });
});

/* ══════════ GIT: CHERRY-PICK / REVERT ══════════ */
app.post('/api/git/cherry-pick', (req, res) => {
    const { cwd, commit } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir) || !commit) return res.status(403).json({ error: 'invalid' });
    exec('git cherry-pick "' + commit + '" 2>&1', { cwd: workdir, timeout: 30000 }, (err, so, se) => {
        const out = (so || '') + (se || '');
        const conflicted = /conflict/i.test(out);
        res.json({ ok: !err && !conflicted, conflicted, stdout: so || '', stderr: se || '' });
    });
});
app.post('/api/git/revert', (req, res) => {
    const { cwd, commit } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir) || !commit) return res.status(403).json({ error: 'invalid' });
    exec('git revert "' + commit + '" --no-edit 2>&1', { cwd: workdir, timeout: 30000 }, (err, so, se) => {
        const out = (so || '') + (se || '');
        const conflicted = /conflict/i.test(out);
        res.json({ ok: !err && !conflicted, conflicted, stdout: so || '', stderr: se || '' });
    });
});

/* ══════════ GIT: TAGS / REMOTES / FETCH / REBASE ══════════ */
app.post('/api/git/tags', (req, res) => {
    const { cwd, action, name, message } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    let cmd;
    if (action === 'list') cmd = 'git tag -l 2>&1';
    else if (action === 'create') cmd = 'git tag -a "' + name + '" -m "' + (message || name).replace(/"/g, '\\"') + '" 2>&1';
    else if (action === 'delete') cmd = 'git tag -d "' + name + '" 2>&1';
    else if (action === 'push') cmd = 'git push --tags 2>&1';
    else cmd = 'git tag -l 2>&1';
    exec(cmd, { cwd: workdir, timeout: 30000 }, (err, so, se) => {
        res.json({ ok: !err, stdout: so || '', stderr: se || '' });
    });
});
app.post('/api/git/remotes', (req, res) => {
    const { cwd } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    exec('git remote -v 2>&1', { cwd: workdir, timeout: 10000 }, (err, stdout) => {
        const lines = (stdout || '').split('\n').filter(Boolean);
        const remotes = {};
        lines.forEach(l => {
            const m = l.match(/^(\S+)\s+(\S+)\s+\((\w+)\)/);
            if (m) { if (!remotes[m[1]]) remotes[m[1]] = {}; remotes[m[1]][m[3]] = m[2]; }
        });
        res.json({ remotes });
    });
});
app.post('/api/git/fetch', (req, res) => {
    const { cwd, remote } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    exec('git fetch ' + (remote || 'origin') + ' 2>&1', { cwd: workdir, timeout: 60000 }, (err, so, se) => {
        res.json({ ok: !err, stdout: so || '', stderr: se || '' });
    });
});
app.post('/api/git/pull/rebase', (req, res) => {
    const { cwd } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    exec('git pull --rebase 2>&1', { cwd: workdir, timeout: 60000 }, (err, so, se) => {
        const out = (so || '') + (se || '');
        const conflicted = /conflict/i.test(out);
        res.json({ ok: !err && !conflicted, conflicted, stdout: so || '', stderr: se || '' });
    });
});

/* ══════════ GIT: LOG DETAILED + SHOW ══════════ */
app.post('/api/git/log/detailed', (req, res) => {
    const { cwd, limit } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    const n = limit || 20;
    exec('git log -' + n + ' --pretty=format:"%h|%an|%ar|%s" 2>&1', { cwd: workdir, timeout: 10000 }, (err, stdout) => {
        const commits = (stdout || '').split('\n').filter(Boolean).map(l => {
            const [hash, author, date, message] = l.split('|');
            return { hash, author, date, message };
        });
        res.json({ commits });
    });
});
app.post('/api/git/show', (req, res) => {
    const { cwd, commit } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    exec('git show --stat "' + commit + '" 2>&1', { cwd: workdir, timeout: 15000 }, (err, stdout) => {
        res.json({ output: stdout || '', error: err ? err.message : null });
    });
});

/* ══════════ GIT: AUTO INIT + AUTO COMMIT + UNDO ══════════ */
app.post('/api/git/auto-init', (req, res) => {
    const { cwd } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    const cmd = 'if [ ! -d .git ]; then git init -b main 2>&1; git add -A 2>&1; git commit -m "Initial commit" 2>&1 || true; fi; echo DONE';
    exec(cmd, { cwd: workdir, timeout: 30000 }, (err, so, se) => {
        res.json({ code: err ? 1 : 0, stdout: so || '', stderr: se || '' });
    });
});
app.post('/api/git/auto-commit', (req, res) => {
    const { cwd } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    exec('git config user.email 2>&1', { cwd: workdir }, (e1, out1) => {
        if (!out1 || out1.trim().length === 0) return res.json({ skipped: true, reason: 'no git identity set' });
        const msg = 'autosave ' + new Date().toISOString().slice(11, 19);
        exec('git add -A 2>&1; git diff --cached --quiet || git commit -m "' + msg + '" 2>&1', { cwd: workdir, timeout: 15000 }, (err, so, se) => {
            res.json({ ok: !err, stdout: so || '', stderr: se || '' });
        });
    });
});
app.post('/api/git/undo', (req, res) => {
    const { cwd } = req.body;
    const workdir = cwd ? path.join(WORKSPACE, cwd) : WORKSPACE;
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    exec('git log --oneline -2 2>&1', { cwd: workdir }, (err, stdout) => {
        const lines = (stdout || '').trim().split('\n');
        if (lines.length < 2) return res.json({ ok: false, error: 'Not enough commits' });
        exec('git revert HEAD --no-edit 2>&1', { cwd: workdir, timeout: 15000 }, (err2, out2, errOut) => {
            res.json({ ok: !err2, display: err2 ? 'Undo failed: ' + errOut : 'Reverted last commit', output: out2 || errOut || '' });
        });
    });
});

/* ══════════ LICENSE / PRO TIER ══════════ */
app.get('/api/license/status', (req, res) => {
    try {
        const key = fs.existsSync(LICENSE_FILE) ? fs.readFileSync(LICENSE_FILE, 'utf8').trim() : '';
        if (!key) return res.json({ pro: false, key: null });
        const valid = key.startsWith(PRO_LICENSE_PREFIX) && key.length >= 20;
        res.json({ pro: valid, key: valid ? key.slice(0, 12) + '…' : null });
    } catch (e) { res.json({ pro: false, key: null, error: e.message }); }
});
app.post('/api/license/save', (req, res) => {
    const { key } = req.body || {};
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'key required' });
    const trimmed = key.trim();
    if (!trimmed.startsWith(PRO_LICENSE_PREFIX) || trimmed.length < 20) return res.status(400).json({ error: 'Invalid format' });
    try { fs.writeFileSync(LICENSE_FILE, trimmed, 'utf8'); res.json({ ok: true, pro: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/license/remove', (req, res) => {
    try { if (fs.existsSync(LICENSE_FILE)) fs.unlinkSync(LICENSE_FILE); res.json({ ok: true, pro: false }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════ BACKUP ══════════ */
app.get('/api/backup/check', (req, res) => {
    try {
        const exists = fs.existsSync(SD_CARD_ROOT);
        const writable = exists && (function() {
            try {
                const test = path.join(SD_CARD_ROOT, '.write-test');
                fs.writeFileSync(test, 'x'); fs.unlinkSync(test); return true;
            } catch (e) { return false; }
        })();
        res.json({ exists, writable, path: SD_BACKUP });
    } catch (e) { res.json({ exists: false, writable: false, error: e.message }); }
});
app.post('/api/backup/create', (req, res) => {
    try {
        if (!fs.existsSync(SD_CARD_ROOT)) return res.status(400).json({ error: 'SD card not available' });
        if (!fs.existsSync(SD_BACKUP)) fs.mkdirSync(SD_BACKUP, { recursive: true });
        const now = new Date();
        const stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + '_' + String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0') + '-' + String(now.getSeconds()).padStart(2, '0');
        const dest = path.join(SD_BACKUP, stamp);
        exec('cp -r "' + WORKSPACE + '" "' + dest + '" 2>&1', { timeout: 180000 }, (err, so, se) => {
            if (err) return res.status(500).json({ error: se || err.message });
            let fileCount = 0, sizeBytes = 0;
            (function walk(dir) {
                try {
                    fs.readdirSync(dir).forEach(f => {
                        if (f === '.gitkeep') return;
                        const p = path.join(dir, f);
                        const st = fs.statSync(p);
                        if (st.isDirectory()) walk(p);
                        else { fileCount++; sizeBytes += st.size; }
                    });
                } catch (e) {}
            })(dest);
            const sizeStr = sizeBytes < 1024 ? sizeBytes + ' B' : sizeBytes < 1024 * 1024 ? (sizeBytes / 1024).toFixed(1) + ' KB' : (sizeBytes / 1024 / 1024).toFixed(1) + ' MB';
            try {
                const all = fs.readdirSync(SD_BACKUP).filter(f => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(f)).sort().reverse();
                all.slice(5).forEach(f => { exec('rm -rf "' + path.join(SD_BACKUP, f) + '"'); });
            } catch (e) {}
            res.json({ ok: true, path: dest, fileCount, size: sizeStr });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/backup/list', (req, res) => {
    try {
        if (!fs.existsSync(SD_BACKUP)) return res.json({ backups: [], available: fs.existsSync(SD_CARD_ROOT) });
        const backups = fs.readdirSync(SD_BACKUP)
            .filter(f => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(f))
            .sort().reverse()
            .map(name => {
                const dir = path.join(SD_BACKUP, name);
                let fileCount = 0, sizeBytes = 0;
                (function walk(d) {
                    try {
                        fs.readdirSync(d).forEach(f => {
                            if (f === '.gitkeep') return;
                            const p = path.join(d, f);
                            const st = fs.statSync(p);
                            if (st.isDirectory()) walk(p);
                            else { fileCount++; sizeBytes += st.size; }
                        });
                    } catch (e) {}
                })(dir);
                const sizeStr = sizeBytes < 1024 ? sizeBytes + ' B' : sizeBytes < 1024 * 1024 ? (sizeBytes / 1024).toFixed(1) + ' KB' : (sizeBytes / 1024 / 1024).toFixed(1) + ' MB';
                return { name, files: fileCount, size: sizeStr };
            });
        res.json({ backups, available: true });
    } catch (e) { res.status(500).json({ error: e.message, backups: [], available: false }); }
});
app.post('/api/backup/restore', (req, res) => {
    const { name } = req.body;
    if (!name || !/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(name)) return res.status(400).json({ error: 'invalid name' });
    const src = path.join(SD_BACKUP, name);
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'backup not found' });
    exec('rm -rf "' + WORKSPACE + '"/* 2>&1; cp -r "' + src + '"/* "' + WORKSPACE + '" 2>&1', { timeout: 180000 }, (err, so, se) => {
        if (err) return res.status(500).json({ error: se || err.message });
        res.json({ ok: true });
    });
});
app.delete('/api/backup/delete', (req, res) => {
    const { name } = req.query;
    if (!name || !/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(name)) return res.status(400).json({ error: 'invalid name' });
    const dir = path.join(SD_BACKUP, name);
    if (!withinBase(SD_BACKUP, dir)) return res.status(403).json({ error: 'Forbidden' });
    exec('rm -rf "' + dir + '" 2>&1', (err, so, se) => {
        if (err) return res.status(500).json({ error: se || err.message });
        res.json({ ok: true });
    });
});

/* ══════════ DEPLOY ══════════ */
function detectAndroidProject(dir) {
    const files = fs.readdirSync(dir);
    if (files.includes('pubspec.yaml')) return 'flutter';
    if (files.includes('build.gradle') || files.includes('build.gradle.kts')) return 'android';
    if (files.includes('package.json')) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            if (pkg.dependencies && pkg.dependencies['react-native']) return 'react-native';
        } catch (e) {}
    }
    return null;
}
app.get('/api/deploy/check-tools', (req, res) => {
    const tools = { java: false, gradle: false, flutter: false, androidSdk: false, keytool: false };
    const checks = [
        { cmd: 'java -version 2>&1', key: 'java' },
        { cmd: 'which gradle 2>&1 || echo MISSING', key: 'gradle' },
        { cmd: 'which flutter 2>&1 || echo MISSING', key: 'flutter' },
        { cmd: 'echo $ANDROID_HOME', key: 'androidSdk' },
        { cmd: 'which keytool 2>&1 || echo MISSING', key: 'keytool' },
    ];
    let done = 0;
    checks.forEach(c => {
        exec(c.cmd, { timeout: 10000 }, (err, stdout) => {
            if (c.key === 'androidSdk') tools.androidSdk = !!(stdout && stdout.trim() && !stdout.includes('$'));
            else tools[c.key] = !err && !(stdout || '').includes('MISSING');
            done++;
            if (done === checks.length) res.json(tools);
        });
    });
});
app.post('/api/deploy/create-keystore', (req, res) => {
    const { projectName, password, alias, dname } = req.body;
    if (!projectName || !password) return res.status(400).json({ error: 'projectName and password required' });
    const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const keystorePath = path.join(KEYSTORE_DIR, safeName + '.jks');
    if (fs.existsSync(keystorePath)) return res.status(400).json({ error: 'Keystore exists: ' + safeName });
    const aliasName = alias || safeName;
    const dnameStr = dname || 'CN=DeepSeek Studio, OU=Dev, O=DeepSeek, L=Unknown, ST=Unknown, C=US';
    const cmd = 'keytool -genkeypair -v -keystore "' + keystorePath + '" -alias "' + aliasName + '" -keyalg RSA -keysize 2048 -validity 10000 -storepass "' + password + '" -keypass "' + password + '" -dname "' + dnameStr + '" 2>&1';
    exec(cmd, { timeout: 30000 }, (err, so, se) => {
        if (err) return res.status(500).json({ error: se || err.message });
        res.json({ ok: true, path: keystorePath, alias: aliasName });
    });
});
app.get('/api/deploy/keystores', (req, res) => {
    try {
        const list = fs.readdirSync(KEYSTORE_DIR).filter(f => f.endsWith('.jks')).map(f => ({ name: f.replace('.jks', ''), path: path.join(KEYSTORE_DIR, f), size: fs.statSync(path.join(KEYSTORE_DIR, f)).size }));
        res.json({ keystores: list });
    } catch (e) { res.json({ keystores: [] }); }
});
app.post('/api/deploy/build', (req, res) => {
    const { cwd, keystore, alias, password, output } = req.body;
    if (!cwd) return res.status(400).json({ error: 'cwd required' });
    const workdir = path.join(WORKSPACE, cwd);
    if (!withinBase(WORKSPACE, workdir)) return res.status(403).json({ error: 'Forbidden' });
    if (!fs.existsSync(workdir)) return res.status(404).json({ error: 'Project not found' });
    const projectType = detectAndroidProject(workdir);
    if (!projectType) return res.status(400).json({ error: 'Not an Android project' });
    const wantAab = output !== 'apk';
    const licenseKey = fs.existsSync(LICENSE_FILE) ? fs.readFileSync(LICENSE_FILE, 'utf8').trim() : '';
    const isPro = licenseKey.startsWith(PRO_LICENSE_PREFIX) && licenseKey.length >= 20;
    if (wantAab && !isPro) return res.status(402).json({ error: 'Pro license required for AAB' });
    const keystorePath = keystore ? path.join(KEYSTORE_DIR, keystore + '.jks') : null;
    const aliasName = alias || (keystore || 'release');
    const pw = password || '';
    let cmd = '';
    let artifactPath = '';
    if (projectType === 'flutter') {
        const keyPropsPath = path.join(workdir, 'android', 'key.properties');
        if (!fs.existsSync(path.dirname(keyPropsPath))) fs.mkdirSync(path.dirname(keyPropsPath), { recursive: true });
        if (keystorePath && fs.existsSync(keystorePath)) {
            fs.writeFileSync(keyPropsPath, 'storePassword=' + pw + '\nkeyPassword=' + pw + '\nkeyAlias=' + aliasName + '\nstoreFile=' + keystorePath + '\n', 'utf8');
        }
        cmd = wantAab ? 'flutter build appbundle --release 2>&1' : 'flutter build apk --release 2>&1';
        artifactPath = wantAab ? path.join(workdir, 'build', 'app', 'outputs', 'bundle', 'release', 'app-release.aab') : path.join(workdir, 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk');
    } else if (projectType === 'react-native') {
        const androidDir = path.join(workdir, 'android');
        if (keystorePath && fs.existsSync(keystorePath)) {
            const gradleProps = path.join(androidDir, 'gradle.properties');
            let props = fs.existsSync(gradleProps) ? fs.readFileSync(gradleProps, 'utf8') : '';
            props += '\nDEEPSEEK_STORE_FILE=' + keystorePath + '\nDEEPSEEK_KEY_ALIAS=' + aliasName + '\nDEEPSEEK_STORE_PASSWORD=' + pw + '\nDEEPSEEK_KEY_PASSWORD=' + pw + '\n';
            fs.writeFileSync(gradleProps, props, 'utf8');
        }
        cmd = 'cd "' + androidDir + '" && ./gradlew ' + (wantAab ? 'bundleRelease' : 'assembleRelease') + ' 2>&1';
        artifactPath = wantAab ? path.join(androidDir, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab') : path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
    } else {
        if (keystorePath && fs.existsSync(keystorePath)) {
            const gradleProps = path.join(workdir, 'gradle.properties');
            let props = fs.existsSync(gradleProps) ? fs.readFileSync(gradleProps, 'utf8') : '';
            props += '\nDEEPSEEK_STORE_FILE=' + keystorePath + '\nDEEPSEEK_KEY_ALIAS=' + aliasName + '\nDEEPSEEK_STORE_PASSWORD=' + pw + '\nDEEPSEEK_KEY_PASSWORD=' + pw + '\n';
            fs.writeFileSync(gradleProps, props, 'utf8');
        }
        cmd = 'cd "' + workdir + '" && ./gradlew ' + (wantAab ? 'bundleRelease' : 'assembleRelease') + ' 2>&1';
        artifactPath = wantAab ? path.join(workdir, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab') : path.join(workdir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
    }
    exec(cmd, { cwd: workdir, timeout: 900000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
        const out = (stdout || '') + (stderr ? '\n' + stderr : '');
        const artifactExists = fs.existsSync(artifactPath);
        let artifactSize = 0;
        if (artifactExists) artifactSize = fs.statSync(artifactPath).size;
        res.json({
            ok: !err && artifactExists,
            projectType,
            output: out,
            artifact: artifactExists ? {
                path: path.relative(WORKSPACE, artifactPath),
                absPath: artifactPath,
                size: artifactSize,
                sizeStr: artifactSize < 1024 * 1024 ? (artifactSize / 1024).toFixed(1) + ' KB' : (artifactSize / 1024 / 1024).toFixed(1) + ' MB',
            } : null,
            code: err ? (err.code || 1) : 0,
        });
    });
});
app.get('/api/deploy/artifacts', (req, res) => {
    const results = [];
    (function walk(dir, depth) {
        if (depth > 6) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name === '.git') continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p, depth + 1);
            else if (e.name.endsWith('.aab') || e.name.endsWith('.apk')) {
                try {
                    const st = fs.statSync(p);
                    results.push({ name: e.name, path: path.relative(WORKSPACE, p), absPath: p, size: st.size, sizeStr: st.size < 1024 * 1024 ? (st.size / 1024).toFixed(1) + ' KB' : (st.size / 1024 / 1024).toFixed(1) + ' MB', mtime: st.mtime.toISOString() });
                } catch (e) {}
            }
        }
    })(WORKSPACE, 0);
    results.sort((a, b) => b.mtime.localeCompare(a.mtime));
    res.json({ artifacts: results.slice(0, 50) });
});
app.post('/api/deploy/install-tools', (req, res) => {
    const cmds = ['pkg update -y', 'pkg install -y openjdk-17 gradle wget unzip'];
    let idx = 0, allOutput = '';
    (function runNext() {
        if (idx >= cmds.length) return res.json({ ok: true, output: allOutput });
        const cmd = cmds[idx++];
        exec(cmd, { timeout: 600000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
            allOutput += '\n$ ' + cmd + '\n' + (stdout || '') + (stderr || '');
            runNext();
        });
    })();
});

/* ══════════ WEBSOCKET TERMINAL ══════════ */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/pty' });

wss.on('connection', (ws) => {
    const shell = spawn('bash', ['-l'], {
        cwd: WORKSPACE,
        env: { ...process.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
    });
    shell.stdout.on('data', d => ws.readyState === 1 && ws.send(d.toString('utf8')));
    shell.stderr.on('data', d => ws.readyState === 1 && ws.send(d.toString('utf8')));
    shell.on('exit', (code) => {
        if (ws.readyState === 1) ws.send('\r\n\x1b[33m[process exited: ' + code + ']\x1b[0m\r\n');
        ws.close();
    });
    shell.on('error', (err) => {
        if (ws.readyState === 1) ws.send('\r\n\x1b[31m[shell error: ' + err.message + ']\x1b[0m\r\n');
    });
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            if (data.type === 'input') shell.stdin.write(data.data);
        } catch (e) {
            shell.stdin.write(msg.toString());
        }
    });
    ws.on('close', () => {
        try { shell.kill('SIGTERM'); } catch (e) {}
        setTimeout(() => { try { shell.kill('SIGKILL'); } catch (e) {} }, 2000);
    });
    ws.on('error', () => {
        try { shell.kill('SIGKILL'); } catch (e) {}
    });
});

/* ══════════ GRACEFUL SHUTDOWN ══════════ */
function shutdown(signal) {
    console.log('\n[' + signal + '] Shutting down...');
    try { wss.close(); } catch (e) {}
    try {
        const { execSync } = require('child_process');
        execSync('command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock', { timeout: 3000 });
        console.log('🔓 Wake lock released');
    } catch (e) {}
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.message);
    console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
});

/* ══════════ BOOT ══════════ */
server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error('\n✗ Port ' + PORT + ' is already in use.');
        console.error('  Another DeepSeek Studio instance may be running.');
        console.error('  Stop it with: ds-stop   (or: pkill -f "node server.js")\n');
    } else {
        console.error('\n✗ Server error:', err && err.message ? err.message : err);
    }
    process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('===========================================');
    console.log('  DeepSeek Studio — Backend running');
    console.log('  v' + PKG_VERSION + ' · Node ' + process.version);
    console.log('===========================================');
    console.log('  URL:       http://127.0.0.1:' + PORT);
    console.log('  Workspace: ' + WORKSPACE);
    console.log('  Backups:   ' + SD_BACKUP);
    console.log('  Keystores: ' + KEYSTORE_DIR);
    console.log('  SD Card:   ' + (fs.existsSync(SD_CARD_ROOT) ? 'detected' : 'NOT FOUND'));
    console.log('===========================================');
    console.log('');
});
