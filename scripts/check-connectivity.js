#!/usr/bin/env node
/**
 * Cross-checks frontend ⇄ backend connectivity for DeepSeek Studio.
 *
 *  1. Every backend route used by the frontend must exist (no 404s).
 *  2. Every backend route registered should be referenced somewhere
 *     (frontend or documented), flagging orphans.
 *  3. LONG_RUNNING rate-limit entries must map to real routes.
 *  4. Static assets referenced by index.html / sw.js must exist on disk.
 *
 * Exit code 1 on any hard failure (missing route / missing asset).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const INDEX = path.join(ROOT, 'public', 'index.html');
const SW = path.join(ROOT, 'public', 'sw.js');

const read = (p) => fs.readFileSync(p, 'utf8');

/* ── Collect backend routes: METHOD /path ── */
function backendRoutes(src) {
  const set = new Map();
  const re = /app\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    set.set(m[1].toUpperCase() + ' ' + m[2], m[2]);
  }
  // Backend also registers a catch-all SPA/static route + /guide.
  set.set('GET /guide', '/guide');
  return set;
}

/* ── Collect frontend calls: {method, path} ── */
function frontendCalls(src) {
  const calls = [];
  // fetch(API + '/api/...' { method }) and fetch(API + '/api/...')
  const re = /fetch\(\s*(?:API|'')\s*\+\s*['"]([^'"?]+)/g;
  let m;
  while ((m = re.exec(src))) {
    // Look ahead a little for an explicit method
    const tail = src.slice(m.index, m.index + 240);
    const mm = /method:\s*['"](\w+)['"]/.exec(tail);
    calls.push({ method: (mm ? mm[1] : 'GET').toUpperCase(), path: m[1] });
  }
  // ghCall('/api/...', ...) — always POST
  const ghr = /ghCall\(\s*['"]([^'"?]+)/g;
  while ((m = ghr.exec(src))) calls.push({ method: 'POST', path: m[1] });
  // Dynamically-built URLs: any '/api/...' string literal also counts as a call.
  const lr = /['"]([^'"`]*\/api\/[a-zA-Z0-9/_.-]+)/g;
  while ((m = lr.exec(src))) calls.push({ method: 'ANY', path: m[1] });
  return calls;
}

function main() {
  const serverSrc = read(SERVER);
  const indexSrc = read(INDEX);
  const swSrc = fs.existsSync(SW) ? read(SW) : '';

  const be = backendRoutes(serverSrc);
  const bePaths = new Set([...be.values()]);
  const calls = frontendCalls(indexSrc);

  const errors = [];
  const warnings = [];

  /* 1 — frontend → backend */
  for (const { method, path: p } of calls) {
    if (method === 'ANY') continue; // URL-literal presence only; used for orphan detection
    if (bePaths.has(p)) continue;
    // tolerate same-path different-method (report method mismatch clearly)
    const anyMethod = [...be.keys()].some((k) => k.endsWith(' ' + p));
    if (anyMethod) errors.push(`METHOD MISMATCH: frontend ${method} ${p} — backend has no ${method}`);
    else errors.push(`MISSING ROUTE: frontend calls ${method} ${p} — no backend handler`);
  }

  /* 2 — backend orphans (informational) */
  const fePaths = new Set(calls.map((c) => c.path));
  const documented = new Set();
  for (const m of serverSrc.matchAll(/['"`](\/api\/[a-zA-Z0-9/_.-]+)['"`]/g)) documented.add(m[1]);
  for (const p of bePaths) {
    if (fePaths.has(p)) continue;
    if (p === '/guide' || p.startsWith('/api/fs/')) continue;
    warnings.push(`ORPHAN backend route (never called by frontend): ${p}`);
  }
  // The frontend's documented changelog mentions endpoints; don't over-report.
  // Only warn — never fail on orphans.

  /* 3 — LONG_RUNNING entries must be real routes */
  const lrMatch = /const LONG_RUNNING = new Set\(\[([\s\S]*?)\]\);/.exec(serverSrc);
  if (lrMatch) {
    for (const m of lrMatch[1].matchAll(/['"](\/api\/[^'"]+)['"]/g)) {
      if (!bePaths.has(m[1])) errors.push(`STALE rate-limit entry: ${m[1]} is not a registered route`);
    }
  }

  /* 4 — static assets referenced by HTML/SW must exist */
  const assetRefs = new Set();
  for (const src of [indexSrc, swSrc]) {
    for (const m of src.matchAll(/['"`]\/([a-zA-Z0-9._-]+\.(?:js|css|html|json|svg|png|webmanifest))['"`]/g)) {
      assetRefs.add(m[1]);
    }
  }
  for (const rel of assetRefs) {
    if (!fs.existsSync(path.join(ROOT, 'public', rel))) {
      errors.push(`MISSING ASSET: /${rel} referenced but not found in public/`);
    }
  }

  /* ── Report ── */
  for (const w of warnings) console.log('⚠  ' + w);
  for (const e of errors) console.error('✗  ' + e);
  console.log(
    `\n${bePaths.size} backend routes · ${calls.length} frontend calls · ` +
    `${assetRefs.size} assets · ${errors.length} error(s), ${warnings.length} warning(s)`
  );
  process.exit(errors.length ? 1 : 0);
}

main();
