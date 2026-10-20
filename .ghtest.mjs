// Unit-test the GitHub connectivity helpers in isolation.
import fs from 'node:fs';

const src = fs.readFileSync('core/git.js', 'utf8');

// Pull out the pure helpers we want to exercise.
const grab = (name) => {
  const re = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`, 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + name);
  return m[0].replace(/^export\s+/, '');
};

const helpers = ['remoteKind', 'normalizeRemote', 'tokenSourceLabel'].map(grab).join('\n\n');

const mod = `
${helpers}
export { remoteKind, normalizeRemote, tokenSourceLabel };
`;

fs.writeFileSync('.ghtest-mod.mjs', mod);

const { remoteKind, normalizeRemote, tokenSourceLabel } = await import('./.ghtest-mod.mjs');

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};

console.log('remoteKind:');
t('ssh scp-style', remoteKind('git@github.com:user/repo.git') === 'ssh');
t('ssh url', remoteKind('ssh://git@github.com/user/repo.git') === 'ssh');
t('https', remoteKind('https://github.com/user/repo.git') === 'https');
t('http', remoteKind('http://github.com/user/repo.git') === 'https');
t('empty', remoteKind('') === null);
t('null', remoteKind(null) === null);

console.log('normalizeRemote:');
t('ssh -> https', normalizeRemote('git@github.com:user/repo.git') === 'https://github.com/user/repo.git');
t('https unchanged', normalizeRemote('https://github.com/user/repo.git') === 'https://github.com/user/repo.git');
t('strips .git', normalizeRemote('https://github.com/user/repo') === 'https://github.com/user/repo');
t('ssh url -> https', normalizeRemote('ssh://git@github.com/user/repo.git') === 'https://github.com/user/repo');

console.log('tokenSourceLabel:');
t('env', tokenSourceLabel('env') === 'GITHUB_TOKEN env var');
t('secrets', tokenSourceLabel('secrets') === '~/.deepseek-secrets.json');
t('null', tokenSourceLabel(null) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
