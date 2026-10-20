/* ═══════════════════════════════════════════════════════════════════
   ai-tools-extra.js — second-generation AI capabilities

   Additive on purpose: server.js keeps its original 36 tools and merges
   these in. Exports:

     EXTRA_TOOL_SCHEMAS  OpenAI-style function schemas to advertise
     EXTRA_TOOL_CASES    name -> async handler map

   A handler gets ({ resolveInWorkspace, run, runShell, deps }) and
   returns { ok, display, result }. Handlers never touch req/res, which
   keeps this set unit-testable and reusable from any entry point.

   The theme is precision over volume: multi-file refactors, structural
   code queries, test-driven loops, long-term memory and plan tracking are
   what turn a chat toy into an agent that finishes a task on a phone.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'build', 'dist', '.dart_tool', '.next',
    '.gradle', 'target', '.venv', 'venv', '__pycache__', 'vendor',
    '.cache', 'coverage', '.expo', '.idea', '.vscode',
]);

/* Backup/snapshot dirs (.bak-*, .old, .orig) and any other dot-dir would
   otherwise flood the repo map and search results with stale copies. */
function isSkippableDir(name) {
    if (!name) return false;
    if (name.startsWith('.bak') || name.startsWith('.old') || name.startsWith('.orig')) return true;
    if (name.startsWith('.') && name !== '.github' && name !== '.vscode') return true;
    return false;
}

const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_FILES = 4000;

const obj = (properties, required) => ({
    type: 'object',
    properties,
    ...(required ? { required } : {}),
});

const str = (description = '') => ({ type: 'string', description });
const num = (description = '') => ({ type: 'number', description });
const bool = (description = '') => ({ type: 'boolean', description });
const arr = (items, description = '') => ({ type: 'array', items, description });

/* ═══════════════════════════════════════════════════════════════════
   Schemas
   ═══════════════════════════════════════════════════════════════════ */
const EXTRA_TOOL_SCHEMAS = [
    {
        type: 'function',
        function: {
            name: 'multi_patch',
            description: 'Apply several apply_patch-style edits across multiple files in ONE call. '
                + 'Much faster than one apply_patch per file. Each file is atomic: if an edit fails '
                + 'that file is left untouched and the failure reported, but other files still '
                + 'proceed. Use for refactors that span files.',
            parameters: obj({
                edits: {
                    type: 'array',
                    description: 'Edits applied in order.',
                    items: obj({
                        path: str('File path relative to project root'),
                        search: str('Unique existing text (3-5 lines of context)'),
                        replace: str('Replacement text'),
                        replace_all: bool('Replace every occurrence'),
                    }, ['path', 'search', 'replace']),
                },
                create_missing: bool('If a target file is missing, create it containing `replace`.'),
            }, ['edits']),
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_files',
            description: 'Read several files in one call, with line numbers, so you can build exact '
                + 'patches. Prefer this over many read_file calls.',
            parameters: obj({
                paths: arr({ type: 'string' }, 'Paths relative to project root'),
                max_bytes_each: num('Per-file byte cap (default 20000)'),
                line_numbers: bool('Prefix each line with its number (default true)'),
            }, ['paths']),
        },
    },
    {
        type: 'function',
        function: {
            name: 'code_search',
            description: 'Advanced structural search: regex, whole-word, file-type filters, '
                + 'definitions-only and multi-line matching. kind:"definition" jumps straight to '
                + 'where a symbol is declared.',
            parameters: obj({
                query: str('Search text or regex'),
                path: str('Subdirectory to search (default: project root)'),
                regex: bool('Treat query as a regular expression'),
                multiline: bool('Let the regex span lines (needs regex:true)'),
                word: bool('Match whole words only'),
                ignore_case: bool('Case-insensitive (default true)'),
                glob: str('Only files matching this glob, e.g. "*.js" or "*.{ts,tsx}"'),
                kind: { type: 'string', enum: ['any', 'definition', 'call'], description: 'definition = declarations only' },
                max_results: num('Default 80'),
            }, ['query']),
        },
    },
    {
        type: 'function',
        function: {
            name: 'outline',
            description: 'Structural outline (imports, classes, functions, methods, exports) of source '
                + 'files without reading the full text. The cheapest way to orient in a codebase.',
            parameters: obj({
                paths: arr({ type: 'string' }, 'Files to outline'),
                path: str('Or outline every source file under this folder'),
            }),
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_tests',
            description: 'Auto-detect the project test runner and run the suite. Returns pass/fail plus '
                + 'failure output. Use after changes instead of guessing the test command.',
            parameters: obj({
                cwd: str('Subdirectory to run in (default: project root)'),
                filter: str('Only run tests matching this pattern'),
                timeout_ms: num('Default 180000'),
            }),
        },
    },
    {
        type: 'function',
        function: {
            name: 'lint',
            description: 'Run the project linter / type-checker (eslint, tsc, dart analyze, ruff, '
                + 'flake8, golangci-lint…). Returns file:line:message diagnostics.',
            parameters: obj({
                cwd: str(),
                fix: bool('Apply autofixes where supported'),
                timeout_ms: num('Default 180000'),
            }),
        },
    },
    {
        type: 'function',
        function: {
            name: 'todo',
            description: 'Maintain a persistent task plan for this session. Actions: "set" replaces '
                + 'the list, "add" appends one item, "update" changes one item\'s status, "clear" '
                + 'empties it, "list" shows it. Plan with this before multi-step work.',
            parameters: obj({
                action: { type: 'string', enum: ['set', 'add', 'update', 'clear', 'list'] },
                items: arr({ type: 'string' }, 'For action=set'),
                text: str('For action=add'),
                index: num('For action=update (0-based)'),
                status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'] },
            }, ['action']),
        },
    },
    {
        type: 'function',
        function: {
            name: 'remember',
            description: 'Store a durable fact about this project or the user (stack, conventions, '
                + 'decisions, API quirks) that survives across sessions. Never store secrets or keys.',
            parameters: obj({
                fact: str('One self-contained sentence'),
                tag: str('Optional: convention | decision | bug | stack'),
            }, ['fact']),
        },
    },
    {
        type: 'function',
        function: {
            name: 'recall',
            description: 'Retrieve stored project memories, optionally filtered by tag or keyword.',
            parameters: obj({
                query: str('Keyword filter (optional)'),
                tag: str(),
                limit: num('Default 25'),
            }),
        },
    },
    {
        type: 'function',
        function: {
            name: 'fetch_url',
            description: 'Fetch a URL (docs, JSON APIs, error pages) and return readable text with '
                + 'HTML stripped. http/https only. Use instead of curl in run_command.',
            parameters: obj({
                url: str(),
                method: { type: 'string', enum: ['GET', 'POST', 'HEAD'] },
                body: str('Request body for POST'),
                content_type: str('Default application/json when body is set'),
                max_chars: num('Default 12000'),
            }, ['url']),
        },
    },
    {
        type: 'function',
        function: {
            name: 'json_query',
            description: 'Read a JSON file (or a JSON string) and extract a value with a dotted path, '
                + 'e.g. "scripts.build" or "dependencies.express". Saves reading whole manifests.',
            parameters: obj({
                path: str('File to read'),
                json: str('Alternatively, a JSON string'),
                pointer: str('Dotted path; numeric segments index arrays'),
            }),
        },
    },
    {
        type: 'function',
        function: {
            name: 'git_branch_diff',
            description: 'Summarise what changed on this branch versus a base ref: changed files, '
                + 'commit subjects and dependency changes. Great for writing a PR description.',
            parameters: obj({
                base: str('Base ref; auto-chosen merge base by default'),
                cwd: str(),
            }),
        },
    },
    {
        type: 'function',
        function: {
            name: 'project_summary',
            description: 'One-call orient: detects stack, package manager, scripts, entry points, '
                + 'directory layout, LOC by language and stored project memory. Call this FIRST on an '
                + 'unfamiliar project instead of listing files one by one.',
            parameters: obj({
                cwd: str('Default: project root'),
            }),
        },
    },
];

/* ═══════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════ */
const LANG_BY_EXT = {
    '.js': 'JavaScript', '.cjs': 'JavaScript', '.mjs': 'JavaScript', '.jsx': 'JavaScript',
    '.ts': 'TypeScript', '.tsx': 'TypeScript', '.dart': 'Dart', '.py': 'Python',
    '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin',
    '.swift': 'Swift', '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.hpp': 'C++',
    '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.lua': 'Lua', '.sh': 'Shell',
    '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.json': 'JSON', '.yaml': 'YAML',
    '.yml': 'YAML', '.toml': 'TOML', '.md': 'Markdown', '.sql': 'SQL',
};

const CODE_EXTS = new Set(Object.keys(LANG_BY_EXT));

const extOf = (p) => path.extname(String(p || '')).toLowerCase();

function isBinary(buf) {
    const n = Math.min(buf.length, 4096);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
}

/** Supports * ? and {a,b} — enough for the file-type filters we expose. */
function globToRegex(glob) {
    let g = String(glob || '').trim();
    if (!g) return null;
    g = g.replace(/[.+^$()|[\]\\]/g, '\\$&');
    g = g.replace(/\{([^}]*)\}/g, (_, alts) => '(' + alts.split(',')
        .map((x) => x.trim().replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')');
    g = g.replace(/\*/g, '[^/]*').replace(/\?/g, '.');
    try { return new RegExp('^' + g + '$', 'i'); } catch (_) { return null; }
}

/** Depth-first walk honouring SKIP_DIRS and a file budget. */
function walkFiles(baseDir, onFile, budget = MAX_SCAN_FILES) {
    let seen = 0;
    const stack = [baseDir];
    while (stack.length && seen < budget) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
        for (const e of entries) {
            if (seen >= budget) break;
            if (SKIP_DIRS.has(e.name) || isSkippableDir(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { stack.push(full); continue; }
            if (!e.isFile()) continue;
            seen++;
            onFile(full);
        }
    }
    return seen;
}

function readTextSafe(file) {
    try {
        const st = fs.statSync(file);
        if (st.size > MAX_SCAN_FILE_BYTES) return null;
        const buf = fs.readFileSync(file);
        if (isBinary(buf)) return null;
        return buf.toString('utf8');
    } catch (_) { return null; }
}

const withLineNumbers = (text) => text.split('\n')
    .map((l, i) => String(i + 1).padStart(5) + '│ ' + l).join('\n');

/* ═══════════════════════════════════════════════════════════════════
   Outline extraction — deliberately regex-based.

   A phone cannot afford a per-language AST per tool call, and an
   approximate outline answering "where is X defined" beats none.
   ═══════════════════════════════════════════════════════════════════ */
const OUTLINE_RULES = [
    { kind: 'fn',     re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
    { kind: 'fn',     re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
    { kind: 'class',  re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'type',   re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'method', re: /^\s{2,}(?:async\s+|static\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/ },
    { kind: 'def',    re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { kind: 'class',  re: /^\s*class\s+([A-Za-z_]\w*)/ },
    { kind: 'fn',     re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: 'fn',     re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { kind: 'type',   re: /^(?:pub\s+)?(?:struct|trait|impl|union)\s+([A-Za-z_]\w*)/ },
    { kind: 'fn',     re: /^\s*(?:public|private|protected|static|final|\s)+[\w<>\[\],\s]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/ },
];

function outlineFile(text) {
    const hits = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < 200; i++) {
        const line = lines[i];
        if (line.length > 400) continue;
        for (const rule of OUTLINE_RULES) {
            const m = rule.re.exec(line);
            if (m && m[1] && m[1] !== 'if' && m[1] !== 'for' && m[1] !== 'while' && m[1] !== 'switch') {
                hits.push(rule.kind + ' ' + m[1] + ' @' + (i + 1));
                break;
            }
        }
    }
    return hits;
}

/* ═══════════════════════════════════════════════════════════════════
   Runner detection — the whole reason run_tests/lint exist.

   Each candidate is { cmd, args, signals } where signals are filenames
   that must exist for the runner to be considered. First match wins, so
   order expresses preference (a repo with both jest and a bare test
   script should use the precise one).
   ═══════════════════════════════════════════════════════════════════ */
function existsIn(dir, name) {
    try { return fs.existsSync(path.join(dir, name)); } catch (_) { return false; }
}

function readJsonIn(dir, name) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (_) { return null; }
}

function detectTestRunner(dir) {
    const pkg = readJsonIn(dir, 'package.json');
    const scripts = (pkg && pkg.scripts) || {};
    const has = (...names) => names.some((n) => existsIn(dir, n));

    if (pkg) {
        if (has('vitest.config.ts', 'vitest.config.js', 'vitest.config.mts') || (pkg.devDependencies || {}).vitest) {
            return { name: 'vitest', cmd: 'npx', args: ['vitest', 'run'], kind: 'node' };
        }
        if (has('jest.config.js', 'jest.config.ts', 'jest.config.cjs') || (pkg.devDependencies || {}).jest) {
            return { name: 'jest', cmd: 'npx', args: ['jest', '--ci'], kind: 'node' };
        }
        if (has('playwright.config.ts', 'playwright.config.js')) {
            return { name: 'playwright', cmd: 'npx', args: ['playwright', 'test'], kind: 'node' };
        }
        if (scripts.test && !/no test specified/.test(scripts.test)) {
            return { name: 'npm test', cmd: 'npm', args: ['test', '--silent'], kind: 'node' };
        }
    }
    if (existsIn(dir, 'pubspec.yaml')) return { name: 'flutter test', cmd: 'flutter', args: ['test'], kind: 'dart' };
    if (has_any(dir, ['pyproject.toml', 'pytest.ini', 'tox.ini', 'setup.cfg']) || has('tests')) {
        return { name: 'pytest', cmd: 'python', args: ['-m', 'pytest', '-q'], kind: 'python' };
    }
    if (existsIn(dir, 'Cargo.toml')) return { name: 'cargo test', cmd: 'cargo', args: ['test', '--quiet'], kind: 'rust' };
    if (existsIn(dir, 'go.mod')) return { name: 'go test', cmd: 'go', args: ['test', './...'], kind: 'go' };
    if (has('build.gradle', 'build.gradle.kts')) return { name: 'gradle test', cmd: 'sh', args: ['-c', './gradlew test --console=plain || gradle test --console=plain'], kind: 'java' };
    return null;
}

function has_any(dir, names) { return names.some((n) => existsIn(dir, n)); }

function detectLinter(dir) {
    const pkg = readJsonIn(dir, 'package.json');
    const has = (...names) => names.some((n) => existsIn(dir, n));
    if (pkg) {
        if (has('.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', 'eslint.config.js', 'eslint.config.mjs')
            || (pkg.devDependencies || {}).eslint || (pkg.dependencies || {}).eslint) {
            return { name: 'eslint', cmd: 'npx', args: ['eslint', '.'], kind: 'node' };
        }
        if (has('tsconfig.json')) return { name: 'tsc', cmd: 'npx', args: ['tsc', '--noEmit'], kind: 'node' };
    }
    if (existsIn(dir, 'pubspec.yaml')) return { name: 'dart analyze', cmd: 'dart', args: ['analyze'], kind: 'dart' };
    if (has_any(dir, ['pyproject.toml', 'ruff.toml', '.ruff.toml'])) return { name: 'ruff', cmd: 'ruff', args: ['check', '.'], kind: 'python' };
    if (existsIn(dir, 'setup.cfg') || existsIn(dir, 'tox.ini')) return { name: 'flake8', cmd: 'flake8', args: ['.'], kind: 'python' };
    if (existsIn(dir, 'Cargo.toml')) return { name: 'cargo clippy', cmd: 'cargo', args: ['clippy', '--quiet'], kind: 'rust' };
    if (existsIn(dir, 'go.mod')) return { name: 'go vet', cmd: 'go', args: ['vet', './...'], kind: 'go' };
    return null;
}

const clip = (s, n) => {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n) + '\n…(truncated)' : t;
};

/* ═══════════════════════════════════════════════════════════════════
   Handlers

   Signature: (args, ctx) => Promise<{ ok, display, result }>
   ctx: { resolveInWorkspace, run, runShell, deps:{ applyPatchSmart }, memory, todo }
   ═══════════════════════════════════════════════════════════════════ */
async function multiPatch(a, ctx) {
    const edits = Array.isArray(a.edits) ? a.edits : [];
    if (!edits.length) return { ok: false, display: 'no edits given', result: { error: 'edits[] empty' } };

    const byFile = new Map();
    for (const e of edits) {
        if (!e || !e.path) continue;
        if (!byFile.has(e.path)) byFile.set(e.path, []);
        byFile.get(e.path).push(e);
    }

    const applied = [];
    const failed = [];
    for (const [rel, list] of byFile) {
        const abs = ctx.resolveInWorkspace(rel);
        if (!abs) { failed.push({ path: rel, error: 'outside workspace' }); continue; }

        let original = null;
        if (fs.existsSync(abs)) {
            original = await fsp.readFile(abs, 'utf8');
        } else if (a.create_missing === true) {
            original = '';
        } else {
            failed.push({ path: rel, error: 'not found' });
            continue;
        }

        // Apply the file's edits to an in-memory copy; only touch disk if
        // every edit for that file succeeded. Half-applied files are the
        // single most confusing failure mode for an LLM, so we avoid them.
        let content = original;
        let changed = 0;
        let aborted = null;
        for (const e of list) {
            if (e.search === '' && a.create_missing === true && original === '') {
                content = String(e.replace == null ? '' : e.replace);
                changed++;
                continue;
            }
            const r = ctx.deps.applyPatchSmart(content, String(e.search || ''), String(e.replace || ''), e.replace_all === true);
            if (!r.ok) { aborted = r.error || 'search text not found'; break; }
            content = r.content;
            changed++;
        }
        if (aborted) { failed.push({ path: rel, error: aborted }); continue; }

        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, content, 'utf8');
        applied.push({ path: rel, edits: changed, bytes: Buffer.byteLength(content) });
    }

    const ok = failed.length === 0;
    return {
        ok: ok || applied.length > 0,
        display: 'Patched ' + applied.length + ' file' + (applied.length === 1 ? '' : 's')
            + (failed.length ? ', ' + failed.length + ' failed' : ''),
        result: { applied, failed },
    };
}

async function readFiles(a, ctx) {
    const paths = Array.isArray(a.paths) ? a.paths.slice(0, 20) : [];
    if (!paths.length) return { ok: false, display: 'no paths', result: { error: 'paths[] empty' } };
    const cap = Number(a.max_bytes_each) > 0 ? Number(a.max_bytes_each) : 20000;
    const numbered = a.line_numbers !== false;

    const files = [];
    for (const rel of paths) {
        const abs = ctx.resolveInWorkspace(rel);
        if (!abs) { files.push({ path: rel, error: 'outside workspace' }); continue; }
        if (!fs.existsSync(abs)) { files.push({ path: rel, error: 'not found' }); continue; }
        let text;
        try { text = await fsp.readFile(abs, 'utf8'); }
        catch (e) { files.push({ path: rel, error: 'unreadable' }); continue; }
        const truncated = text.length > cap;
        const body = truncated ? text.slice(0, cap) : text;
        files.push({
            path: rel,
            lines: text.split('\n').length,
            truncated,
            content: numbered ? withLineNumbers(body) : body,
        });
    }
    const good = files.filter((f) => !f.error).length;
    return { ok: good > 0, display: 'Read ' + good + '/' + files.length + ' file(s)', result: { files } };
}

async function codeSearch(a, ctx) {
    const query = String(a.query || '');
    if (!query) return { ok: false, display: 'query required', result: { error: 'missing query' } };

    const base = ctx.resolveInWorkspace(a.path || '');
    if (!base) return { ok: false, display: 'outside workspace', result: { error: 'outside workspace' } };

    const flags = (a.ignore_case !== false ? 'i' : '') + (a.multiline ? 's' : '');
    let source = a.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (a.word) source = '\\b' + source + '\\b';

    // definitions-only: reuse the outline rule shapes as a cheap "is this a
    // declaration line?" predicate, then keep only lines that also match.
    let re;
    try { re = new RegExp(source, flags); }
    catch (e) { return { ok: false, display: 'bad regex', result: { error: e.message } }; }

    const fileRe = globToRegex(a.glob);
    const max = Math.min(Number(a.max_results) || 80, 200);
    const matches = [];
    const defOnly = a.kind === 'definition';
    const callOnly = a.kind === 'call';

    walkFiles(base, (full) => {
        if (matches.length >= max) return;
        const ext = extOf(full);
        if (fileRe) {
            if (!fileRe.test(path.basename(full)) && !fileRe.test(path.relative(base, full))) return;
        } else if (!CODE_EXTS.has(ext) && ext !== '') {
            return;
        }
        const text = readTextSafe(full);
        if (text == null) return;
        const rel = path.relative(ctx.workspace, full);
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && matches.length < max; i++) {
            const line = lines[i];
            if (!re.test(line)) continue;
            if (defOnly && !isDeclaration(line)) continue;
            if (callOnly && isDeclaration(line)) continue;
            matches.push({ file: rel, line: i + 1, text: line.trim().slice(0, 200) });
        }
    });

    return {
        ok: matches.length > 0,
        display: matches.length + ' match' + (matches.length === 1 ? '' : 'es') + ' for "' + clip(query, 40) + '"',
        result: { count: matches.length, matches },
    };
}

function isDeclaration(line) {
    return /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum|def|fn|func|struct|trait|pub)\b/.test(line)
        || /^\s*(?:public|private|protected|static)\s+/.test(line);
}

async function outline(a, ctx) {
    let targets = Array.isArray(a.paths) ? a.paths.slice(0, 15) : [];
    if (!targets.length && a.path) {
        const dir = ctx.resolveInWorkspace(a.path);
        if (!dir) return { ok: false, display: 'outside workspace', result: { error: 'outside workspace' } };
        walkFiles(dir, (full) => {
            if (targets.length < 25 && CODE_EXTS.has(extOf(full))) targets.push(path.relative(ctx.workspace, full));
        });
    }
    if (!targets.length) return { ok: false, display: 'nothing to outline', result: { error: 'give paths[] or path' } };

    const files = [];
    for (const rel of targets) {
        const abs = ctx.resolveInWorkspace(rel);
        if (!abs) { files.push({ path: rel, error: 'outside workspace' }); continue; }
        const text = readTextSafe(abs);
        if (text == null) { files.push({ path: rel, error: 'unreadable or binary' }); continue; }
        files.push({
            path: rel,
            language: LANG_BY_EXT[extOf(rel)] || 'unknown',
            lines: text.split('\n').length,
            symbols: outlineFile(text),
        });
    }
    const good = files.filter((f) => !f.error).length;
    return { ok: good > 0, display: 'Outlined ' + good + ' file(s)', result: { files } };
}

async function runTests(a, ctx) {
    const dir = ctx.resolveInWorkspace(a.cwd || '');
    if (!dir) return { ok: false, display: 'outside workspace', result: { error: 'outside workspace' } };
    const runner = detectTestRunner(dir);
    if (!runner) return { ok: false, display: 'no test runner detected', result: { error: 'no runner', hint: 'Create a test script or ask the user how tests are run.' } };

    const args = runner.args.slice();
    if (a.filter) {
        if (runner.kind === 'node' && runner.name === 'jest') args.push('-t', String(a.filter));
        else if (runner.kind === 'node' && runner.name === 'vitest') args.push('-t', String(a.filter));
        else if (runner.kind === 'python') args.push('-k', String(a.filter));
        else if (runner.kind === 'dart') args.push('--plain-name', String(a.filter));
    }

    const started = Date.now();
    const r = await ctx.run(runner.cmd, args, {
        cwd: dir,
        timeout: Math.min(Number(a.timeout_ms) || 180000, 600000),
        env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const ms = Date.now() - started;
    const out = (r.stdout || '') + (r.stderr ? '\n' + r.stderr : '');
    const pass = !r.failed;

    // Pull the runner's own summary line when we can find it; it is far more
    // useful to the model than a raw 400-line dump.
    const summaryLine = (out.match(/^(?:Tests:|Test Suites:|=+ .* =+|\d+ (?:passed|failed).*)$/m) || [''])[0];
    return {
        ok: pass,
        display: runner.name + ': ' + (pass ? 'PASS' : 'FAIL') + ' (' + (ms / 1000).toFixed(1) + 's)',
        result: {
            runner: runner.name,
            command: [runner.cmd].concat(args).join(' '),
            passed: pass,
            exit_code: r.code,
            duration_ms: ms,
            summary: summaryLine.trim(),
            output: clip(out, 6000),
        },
    };
}

async function lint(a, ctx) {
    const dir = ctx.resolveInWorkspace(a.cwd || '');
    if (!dir) return { ok: false, display: 'outside workspace', result: { error: 'outside workspace' } };
    const linter = detectLinter(dir);
    if (!linter) return { ok: false, display: 'no linter detected', result: { error: 'no linter', hint: 'No eslint/tsc/dart/ruff config found.' } };

    const args = linter.args.slice();
    if (a.fix === true) {
        if (linter.name === 'eslint') args.push('--fix');
        else if (linter.name === 'ruff') args.splice(args.indexOf('check') + 1, 0, '--fix');
    }
    const r = await ctx.run(linter.cmd, args, {
        cwd: dir,
        timeout: Math.min(Number(a.timeout_ms) || 180000, 600000),
        env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    const out = (r.stdout || '') + (r.stderr ? '\n' + r.stderr : '');
    return {
        ok: !r.failed,
        display: linter.name + ': ' + (r.failed ? 'issues found' : 'clean'),
        result: {
            linter: linter.name,
            command: [linter.cmd].concat(args).join(' '),
            clean: !r.failed,
            exit_code: r.code,
            output: clip(out, 6000),
        },
    };
}

/* ── Plan tracking ──────────────────────────────────────────────────
   Kept in memory for the server's lifetime. A plan is session state, not
   durable data: persisting it would resurrect stale tasks on restart. */
const PLAN = [];

async function todo(a) {
    const action = String(a.action || 'list');
    if (action === 'clear') { PLAN.length = 0; }
    else if (action === 'set') {
        PLAN.length = 0;
        for (const t of (Array.isArray(a.items) ? a.items : []).slice(0, 50)) {
            PLAN.push({ text: String(t), status: 'pending' });
        }
    } else if (action === 'add') {
        if (a.text) PLAN.push({ text: String(a.text), status: 'pending' });
    } else if (action === 'update') {
        const i = Number(a.index);
        if (PLAN[i]) PLAN[i].status = a.status || PLAN[i].status;
            else return { ok: false, display: 'no item at index ' + a.index, result: { items: PLAN } };
    }
    const done = PLAN.filter((p) => p.status === 'done').length;
    return {
        ok: true,
        display: 'Plan: ' + done + '/' + PLAN.length + ' done',
        result: { items: PLAN.map((p, i) => ({ index: i, ...p })) },
    };
}

/* ── Long-term memory ────────────────────────────────────────────────
   Durable facts about the project/user, persisted to a JSON file so they
   survive restarts. Deliberately tiny and append-only-ish: a phone has no
   room for a vector store, and a keyword filter over a few hundred
   sentences is genuinely useful. Secrets are rejected at the door. */
const MEMORY_FILE = process.env.DS_MEMORY_FILE
    || path.join(process.env.HOME || require('os').homedir(), '.deepseek-memory.json');
const MEMORY_MAX = 500;

function loadMemory() {
    try {
        const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
        return Array.isArray(raw) ? raw : [];
    } catch (_) { return []; }
}
function saveMemory(list) {
    try {
        fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(list.slice(-MEMORY_MAX), null, 2), { mode: 0o600 });
    } catch (_) { /* memory is best-effort; never fail a tool call over it */ }
}

const SECRETISH = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/;

async function remember(a) {
    const fact = String(a.fact || '').trim();
    if (!fact) return { ok: false, display: 'nothing to remember', result: { error: 'fact required' } };
    if (fact.length > 500) return { ok: false, display: 'fact too long', result: { error: 'max 500 chars' } };
    if (SECRETISH.test(fact)) {
        return { ok: false, display: 'refused: looks like a secret', result: { error: 'never store credentials' } };
    }
    const list = loadMemory();
    const tag = a.tag ? String(a.tag).slice(0, 32) : 'general';
    if (list.some((m) => m.fact.toLowerCase() === fact.toLowerCase())) {
        return { ok: true, display: 'Already remembered', result: { duplicate: true, total: list.length } };
    }
    list.push({ fact, tag, at: new Date().toISOString() });
    saveMemory(list);
    return { ok: true, display: 'Remembered (' + list.length + ' total)', result: { total: list.length, tag } };
}

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on',
    'for', 'and', 'or', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'be', 'from', 'we', 'i']);

function tokenize(s) {
    return String(s || '').toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/* Rank memories by token overlap (Jaccard-ish) plus a small recency bonus.
   Falls back to substring match so exact phrases still rank first. */
async function recall(a) {
    const rawQ = String(a.query || '').trim();
    const q = rawQ.toLowerCase();
    const tag = String(a.tag || '').trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(a.limit, 10) || 25, 1), 100);
    const all = loadMemory();
    let list = all;
    if (tag) list = list.filter((m) => String(m.tag || '').toLowerCase() === tag);

    if (!q) {
        const hits = list.slice(-limit);
        return {
            ok: true,
            display: hits.length ? hits.length + ' memory item(s)' : 'No matching memories',
            result: { items: hits, total: all.length },
        };
    }

    const qTokens = tokenize(rawQ);
    const now = Date.now();
    const scored = [];
    for (const m of list) {
        const fact = String(m.fact || '');
        const lower = fact.toLowerCase();
        let score = 0;
        if (lower.includes(q)) score += 10;                 // exact phrase
        const fTokens = new Set(tokenize(fact));
        let overlap = 0;
        for (const t of qTokens) if (fTokens.has(t)) overlap++;
        if (qTokens.length) score += (overlap / qTokens.length) * 5;
        if (String(m.tag || '').toLowerCase() === tag && tag) score += 1;
        const ageDays = (now - Date.parse(m.at || 0)) / 86400000;
        if (Number.isFinite(ageDays)) score += Math.max(0, 1 - ageDays / 90); // decay over 90d
        if (score > 0) scored.push({ m, score });
    }
    scored.sort((x, y) => y.score - x.score);
    const hits = scored.slice(0, limit).map((s) => s.m);
    return {
        ok: true,
        display: hits.length ? hits.length + ' memory item(s)' : 'No matching memories',
        result: { items: hits, total: all.length, query: rawQ },
    };
}

/* ── Web fetch ───────────────────────────────────────────────────── */
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', '#x27': "'" };

function htmlToText(html) {
    return String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/(p|div|li|h[1-6]|tr|section|article|pre)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => HTML_ENTITIES[e.toLowerCase()] ?? m)
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function fetchUrl(a, ctx) {
    const url = String(a.url || '');
    if (!/^https?:\/\//i.test(url)) return { ok: false, display: 'only http/https allowed', result: { error: 'bad url' } };

    const method = ['GET', 'POST', 'HEAD'].includes(a.method) ? a.method : 'GET';
    const headers = {};
    if (method === 'POST') headers['Content-Type'] = a.content_type || 'application/json';
    if (typeof fetch !== 'function') return { ok: false, display: 'fetch unavailable (Node <18)', result: { error: 'no fetch' } };

    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch (_) {} }, 30000);
    let r;
    try {
        r = await fetch(url, {
            method,
            headers,
            body: method === 'POST' && a.body != null ? String(a.body) : undefined,
            signal: ctrl ? ctrl.signal : undefined,
            redirect: 'follow',
        });
    } catch (e) {
        clearTimeout(timer);
        return { ok: false, display: 'fetch failed: ' + e.message, result: { error: e.message } };
    }
    clearTimeout(timer);

    const ctype = (r.headers.get('content-type') || '').toLowerCase();
    const cap = Math.min(Number(a.max_chars) || 12000, 60000);
    let body = '';
    try { body = await r.text(); } catch (_) {}
    const isJson = ctype.includes('json') || /^\s*[[{]/.test(body);
    const text = isJson ? body : htmlToText(body);

    return {
        ok: r.ok,
        display: 'GET ' + new URL(url).host + ' → ' + r.status,
        result: {
            status: r.status,
            ok: r.ok,
            content_type: ctype || 'unknown',
            format: isJson ? 'json' : 'text',
            url: r.url || url,
            body: clip(text, cap),
            truncated: text.length > cap,
        },
    };
}

/* ── JSON pointer ────────────────────────────────────────────────── */
async function jsonQuery(a, ctx) {
    let raw = a.json;
    if (raw == null) {
        if (!a.path) return { ok: false, display: 'path or json required', result: { error: 'missing input' } };
        const abs = ctx.resolveInWorkspace(a.path);
        if (!abs) return { ok: false, display: 'outside workspace', result: { error: 'outside workspace' } };
        if (!fs.existsSync(abs)) return { ok: false, display: 'not found: ' + a.path, result: { error: 'not found' } };
        raw = await fsp.readFile(abs, 'utf8');
    }
    let doc;
    try { doc = JSON.parse(String(raw)); }
    catch (e) { return { ok: false, display: 'invalid JSON', result: { error: e.message } }; }

    const pointer = String(a.pointer || '').trim();
    if (!pointer) {
        return { ok: true, display: 'parsed JSON (' + Object.keys(doc).length + ' top-level keys)', result: { value: clip(JSON.stringify(doc, null, 2), 12000) } };
    }
    let cur = doc;
    for (const seg of pointer.split('.').filter(Boolean)) {
        if (cur == null || typeof cur !== 'object') { cur = undefined; break; }
        cur = Array.isArray(cur) && /^\d+$/.test(seg) ? cur[Number(seg)] : cur[seg];
    }
    if (cur === undefined) return { ok: false, display: 'no value at ' + pointer, result: { error: 'not found', pointer } };
    return {
        ok: true,
        display: pointer + ' → ' + (typeof cur),
        result: { pointer, type: Array.isArray(cur) ? 'array' : typeof cur, value: clip(JSON.stringify(cur, null, 2), 12000) },
    };
}

/* ── Branch diff summary ─────────────────────────────────────────── */
async function gitBranchDiff(a, ctx) {
    const dir = ctx.resolveInWorkspace(a.cwd || '');
    if (!dir) return { ok: false, display: 'outside workspace', result: { error: 'outside workspace' } };

    const git = (args) => ctx.run('git', args, { cwd: dir, timeout: 30000, env: { ...process.env, GIT_PAGER: 'cat' } });

    const inRepo = await git(['rev-parse', '--is-inside-work-tree']);
    if (inRepo.failed) return { ok: false, display: 'not a git repository', result: { error: 'not a repo' } };

    let base = String(a.base || '').trim();
    if (!base) {
        // Prefer the upstream merge base; fall back to first commit so a repo
        // with no remote still produces something useful.
        const mb = await git(['merge-base', 'HEAD', '@{u}']);
        if (!mb.failed) base = mb.stdout.trim();
        else {
            const first = await git(['rev-list', '--max-parents=0', 'HEAD']);
            base = first.failed ? '' : first.stdout.trim().split('\n')[0];
        }
    }

    const range = base ? base + '..HEAD' : 'HEAD';
    const [stats, names, log, current] = await Promise.all([
        git(['diff', '--shortstat', range]),
        git(['diff', '--name-status', range]),
        git(['log', '--oneline', '--no-decorate', '-n', '40', range]),
        git(['rev-parse', '--abbrev-ref', 'HEAD']),
    ]);

    const files = (names.stdout || '').trim().split('\n').filter(Boolean).map((line) => {
        const [status, ...rest] = line.split('\t');
        return { status, path: rest.join('\t') };
    });
    const commits = (log.stdout || '').trim().split('\n').filter(Boolean);

    // Dependency deltas: the noisy part of any PR description.
    let depChanges = null;
    const pkgDiff = await git(['diff', range, '--', 'package.json']);
    if (!pkgDiff.failed && pkgDiff.stdout) {
        const added = [];
        const removed = [];
        for (const line of pkgDiff.stdout.split('\n')) {
            const m = /^([+-])\s+"([^"]+)":\s*"([^"]+)"/.exec(line);
            if (!m || m[2] === 'name' || m[2] === 'version') continue;
            (m[1] === '+' ? added : removed).push(m[2] + '@' + m[3].replace(/^[~^]/, ''));
        }
        if (added.length || removed.length) depChanges = { added, removed };
    }

    return {
        ok: true,
        display: files.length + ' file(s), ' + commits.length + ' commit(s) vs ' + (base || 'HEAD'),
        result: {
            branch: (current.stdout || '').trim(),
            base: base || null,
            shortstat: (stats.stdout || '').trim(),
            files,
            commits,
            depChanges,
        },
    };
}

/* ── Project summary ─────────────────────────────────────────────── */
const STACK_MARKERS = [
    { file: 'package.json', stack: 'Node.js' },
    { file: 'pubspec.yaml', stack: 'Flutter/Dart' },
    { file: 'build.gradle', stack: 'Android (Gradle)' },
    { file: 'build.gradle.kts', stack: 'Android (Gradle KTS)' },
    { file: 'Cargo.toml', stack: 'Rust' },
    { file: 'go.mod', stack: 'Go' },
    { file: 'pyproject.toml', stack: 'Python' },
    { file: 'requirements.txt', stack: 'Python' },
    { file: 'Gemfile', stack: 'Ruby' },
    { file: 'composer.json', stack: 'PHP' },
    { file: 'deno.json', stack: 'Deno' },
    { file: 'Pipfile', stack: 'Python (Pipenv)' },
];

const ENTRY_CANDIDATES = [
    'server.js', 'index.js', 'main.js', 'app.js', 'src/index.js', 'src/main.js', 'src/index.ts',
    'lib/main.dart', 'main.go', 'src/main.rs', 'main.py', 'app.py', 'manage.py', 'index.html',
];

async function projectSummary(a, ctx) {
    const dir = ctx.resolveInWorkspace(a.cwd || '');
    if (!dir) return { ok: false, display: 'outside workspace', result: { error: 'outside workspace' } };

    const stacks = STACK_MARKERS.filter((m) => existsIn(dir, m.file)).map((m) => m.stack);
    const pkg = readJsonIn(dir, 'package.json');

    let packageManager = null;
    if (pkg) {
        if (existsIn(dir, 'pnpm-lock.yaml')) packageManager = 'pnpm';
        else if (existsIn(dir, 'yarn.lock')) packageManager = 'yarn';
        else if (existsIn(dir, 'bun.lockb')) packageManager = 'bun';
        else packageManager = 'npm';
    }

    const topLevel = [];
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (SKIP_DIRS.has(e.name) || e.name === '.git' || isSkippableDir(e.name)) continue;
            if (topLevel.length >= 30) break;
            topLevel.push((e.isDirectory() ? '[dir] ' : '[file] ') + e.name);
        }
    } catch (_) {}

    const loc = {};
    let files = 0;
    walkFiles(dir, (full) => {
        const lang = LANG_BY_EXT[extOf(full)];
        if (!lang) return;
        files++;
        const text = readTextSafe(full);
        if (text != null) loc[lang] = (loc[lang] || 0) + text.split('\n').length;
    });

    const scripts = (pkg && pkg.scripts) || {};
    const frameworks = pkg && pkg.dependencies
        ? Object.keys(pkg.dependencies).filter((d) => ['express', 'fastify', 'next', 'react', 'vue', 'svelte', 'koa', 'nestjs', 'hono'].some((f) => d.includes(f))).slice(0, 8)
        : [];

    return {
        ok: true,
        display: (stacks.join(' + ') || 'unknown stack') + ', ' + files + ' source files',
        result: {
            root: path.relative(ctx.workspace, dir) || '.',
            stacks,
            packageManager,
            frameworks,
            scripts,
            dependencies: pkg && pkg.dependencies ? Object.keys(pkg.dependencies).length : 0,
            entryPoints: ENTRY_CANDIDATES.filter((f) => existsIn(dir, f)),
            topLevel,
            locByLanguage: Object.fromEntries(Object.entries(loc).sort((x, y) => y[1] - x[1]).slice(0, 8)),
            sourceFiles: files,
            hasTests: !!detectTestRunner(dir),
            testRunner: (detectTestRunner(dir) || {}).name || null,
            linter: (detectLinter(dir) || {}).name || null,
            git: existsIn(dir, '.git'),
        },
    };
}

/* ═══════════════════════════════════════════════════════════════════
   Export map
   ═══════════════════════════════════════════════════════════════════ */
const EXTRA_TOOL_CASES = {
    multi_patch: multiPatch,
    read_files: readFiles,
    code_search: codeSearch,
    outline,
    run_tests: runTests,
    lint,
    todo,
    remember,
    recall,
    fetch_url: fetchUrl,
    json_query: jsonQuery,
    git_branch_diff: gitBranchDiff,
    project_summary: projectSummary,
};

/** Names of every tool this module provides — handy for tests/UI badges. */
const EXTRA_TOOL_NAMES = Object.keys(EXTRA_TOOL_CASES);

module.exports = {
    EXTRA_TOOL_SCHEMAS,
    EXTRA_TOOL_CASES,
    EXTRA_TOOL_NAMES,
    // Exported for unit tests.
    outlineFile,
    globToRegex,
    htmlToText,
    detectTestRunner,
    detectLinter,
    PLAN,
};


