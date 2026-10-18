#!/usr/bin/env node
// Syntax-only validation for a JS file (no execution).
// Usage: node scripts/syntax-check.js <file>
const fs = require('fs');
const vm = require('vm');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/syntax-check.js <file>');
  process.exit(2);
}

const src = fs.readFileSync(file, 'utf8');
try {
  new vm.Script(src, { filename: file });
  console.log(`OK  ${file}  (${src.length} bytes)`);
  process.exit(0);
} catch (err) {
  console.error(`FAIL ${file}`);
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
