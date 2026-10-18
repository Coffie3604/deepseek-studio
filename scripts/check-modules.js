#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   scripts/check-modules.js — static gate for the public/js module graph

   There is no bundler and no headless browser in Termux, so a broken
   import path or a renamed export only shows up as a blank page on the
   phone. This script catches that class of bug before it ships:

     1. every file under public/js parses as an ES module
     2. every `import ... from './x.js'` resolves to a real file
     3. every named import exists as an export in the target module
     4. every `export { a, b }` names something declared in that file
     5. no feature imports another feature (ROADMAP.md §1 rule)

   Exit code 0 = clean. Run via `npm test`.
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'public', 'js');
const TMP = path.join(ROOT, '.chk');

const errors = [];
const warnings = [];

/* ── collect files ────────────────────────────────────────────────── */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

if (!fs.existsSync(JS_DIR)) {
  console.error('✗ public/js not found — nothing to check');
  process.exit(1);
}

const files = walk(JS_DIR);
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

/* ── 1. syntax ────────────────────────────────────────────────────── */
fs.mkdirSync(TMP, { recursive: true });
const tmpFile = path.join(TMP, 'module-check.mjs');

for (const file of files) {
  fs.copyFileSync(file, tmpFile);
  try {
    execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
  } catch (err) {
    const msg = String(err.stderr || err.message)
      .split('\n')
      .filter((l) => /SyntaxError|^\s+\^/.test(l))
      .slice(0, 3)
      .join('\n');
    errors.push(`${rel(file)}: does not parse as an ES module\n${msg}`);
  }
}

/* ── 2/3. imports resolve, named imports exist ────────────────────── */
const IMPORT_RE = /import\s+(?:([\w$]+)\s*,\s*)?(?:\*\s+as\s+([\w$]+)|\{([^}]*)\}|([\w$]+))?\s*from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /import\s*['"]([^'"]+)['"]/g;

/** Cache of module path → Set of exported names. */
const exportCache = new Map();

function exportsOf(file) {
  if (exportCache.has(file)) return exportCache.get(file);
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();

  // export function foo / export async function foo / export const foo
  const declRe = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([\w$]+)/g;
  let m;
  while ((m = declRe.exec(src))) names.add(m[1]);

  // export { a, b as c }
  const listRe = /export\s*\{([^}]*)\}/g;
  while ((m = listRe.exec(src))) {
    for (const part of m[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const as = piece.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }

  // export default
  if (/export\s+default\b/.test(src)) names.add('default');

  exportCache.set(file, names);
  return names;
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);

  const checkSpec = (spec) => {
    if (!spec.startsWith('.')) return null; // bare specifier — not our concern
    const target = path.resolve(dir, spec);
    if (!fs.existsSync(target)) {
      errors.push(`${rel(file)}: import "${spec}" does not resolve to a file`);
      return null;
    }
    return target;
  };

  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src))) {
    const [, , , named, defaultOnly, spec] = m;
    const target = checkSpec(spec);
    if (!target) continue;

    const available = exportsOf(target);

    if (named) {
      for (const part of named.split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        const imported = piece.split(/\s+as\s+/)[0].trim();
        if (!available.has(imported)) {
          errors.push(
            `${rel(file)}: imports "${imported}" from ${rel(target)} but that module does not export it`
          );
        }
      }
    }
    if (defaultOnly && !available.has('default')) {
      errors.push(`${rel(file)}: default-imports ${rel(target)} which has no default export`);
    }
  }

  BARE_IMPORT_RE.lastIndex = 0;
  while ((m = BARE_IMPORT_RE.exec(src))) checkSpec(m[1]);
}

/* ── 4. export lists name something real ──────────────────────────── */
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const listRe = /export\s*\{([^}]*)\}/g;
  let m;
  while ((m = listRe.exec(src))) {
    for (const part of m[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const local = piece.split(/\s+as\s+/)[0].trim();
      // A local name must be declared somewhere in the file.
      const declared = new RegExp(
        '(?:function|const|let|var|class)\\s+' + local.replace(/\$/g, '\\$') + '\\b'
      ).test(src);
      if (!declared) {
        errors.push(`${rel(file)}: export list names "${local}" but it is not declared in the file`);
      }
    }
  }
}

/* ── 5. no feature imports another feature ────────────────────────── */
for (const file of files) {
  const r = rel(file);
  if (!r.includes('/features/')) continue;
  const src = fs.readFileSync(file, 'utf8');
  const re = /from\s*['"]([^'"]*features\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    errors.push(`${r}: imports another feature ("${m[1]}") — use the bus instead (ROADMAP.md §1)`);
  }
}

/* ── report ───────────────────────────────────────────────────────── */
try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }

for (const w of warnings) console.warn('⚠ ' + w);

if (errors.length) {
  console.error('\n✗ module graph check failed (' + errors.length + '):\n');
  for (const e of errors) console.error('  • ' + e + '\n');
  process.exit(1);
}

console.log('✓ module graph clean — ' + files.length + ' files, all imports resolve');
