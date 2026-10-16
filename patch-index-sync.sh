#!/data/data/com.termux/files/usr/bin/bash
# patch-index-sync.sh — add GitHub sync UI to public/index.html
set -e

REPO="${1:-$HOME/projects/deepseek-editor-sandbox}"
cd "$REPO" || { echo "✗ No such directory: $REPO"; exit 1; }

BK=".patch-backup/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"
cp public/index.html "$BK/index.html"
echo "── Backup: $BK/index.html"

python3 <<'PYEOF'
import sys

STATS = {'ok':0, 'skip':0, 'fail':0}
P = 'public/index.html'

def read(p): return open(p, 'r', encoding='utf-8').read()
def write(p, s): open(p, 'w', encoding='utf-8').write(s)

def patch(old, new, label):
    c = read(P)
    if old not in c:
        probe = new.strip().splitlines()[0] if new.strip() else None
        if probe and probe in c:
            print(f'  ⊘ {label}: already applied'); STATS['skip'] += 1; return True
        print(f'  ✗ {label}: pattern not found'); STATS['fail'] += 1; return False
    write(P, c.replace(old, new, 1))
    print(f'  ✓ {label}'); STATS['ok'] += 1; return True

# ─── 1. Sync Status section in GitHub panel (after Repository) ───
patch(
'''        <div class="settings-section">
          <h3><i class="fas fa-code-branch"></i> Repository</h3>
          <p id="ghRepoInfo" style="font-size:11px;color:var(--fg-3);font-family:monospace;word-break:break-all">Not connected</p>
          <p id="ghBranchInfo" style="font-size:11px;color:var(--fg-3);font-family:monospace">Branch: -</p>
        </div>''',
'''        <div class="settings-section">
          <h3><i class="fas fa-code-branch"></i> Repository</h3>
          <p id="ghRepoInfo" style="font-size:11px;color:var(--fg-3);font-family:monospace;word-break:break-all">Not connected</p>
          <p id="ghBranchInfo" style="font-size:11px;color:var(--fg-3);font-family:monospace">Branch: -</p>
        </div>
        <div class="settings-section" id="ghSyncSection">
          <h3><i class="fas fa-arrows-rotate"></i> Sync Status</h3>
          <div id="ghSyncState" class="gh-sync-state">Not checked</div>
          <div id="ghRemoteInfo" class="gh-remote-info">—</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
            <button class="btn" id="ghSyncRefreshBtn" style="justify-content:center;padding:10px"><i class="fas fa-sync"></i> Check</button>
            <button class="btn primary" id="ghSyncNowBtn" style="justify-content:center;padding:10px"><i class="fas fa-cloud"></i> Sync Now</button>
          </div>
          <div id="ghSyncStrategyWrap" style="display:none;margin-top:8px">
            <p style="font-size:11px;color:var(--yellow);margin:0 0 8px 0">Branches have diverged. Choose how to reconcile:</p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <button class="btn warn" id="ghSyncRebaseBtn" style="justify-content:center;padding:10px">Rebase</button>
              <button class="btn warn" id="ghSyncMergeBtn" style="justify-content:center;padding:10px">Merge</button>
            </div>
          </div>
        </div>''',
'1  Sync Status section in GitHub panel')

# ─── 2. Insert sync functions before refreshAllGitState ───
patch(
'''  function showGhOutput(text, error) {
    var el = document.getElementById('ghOutput');
    el.style.display = 'block';
    el.textContent = text || '(no output)';
    el.style.color = error ? 'var(--red)' : 'var(--fg-2)';
  }
  function refreshAllGitState() {''',
'''  function showGhOutput(text, error) {
    var el = document.getElementById('ghOutput');
    el.style.display = 'block';
    el.textContent = text || '(no output)';
    el.style.color = error ? 'var(--red)' : 'var(--fg-2)';
  }
  /* ─── Sync status pill ─────────────────────────────────────────── */
  function _syncStateLabel(state, ahead, behind) {
    switch (state) {
      case 'not-a-repo':  return { text: '○ Not a git repository',    cls: 'off' };
      case 'no-remote':   return { text: '○ No origin remote',         cls: 'off' };
      case 'no-upstream': return { text: '● Branch not pushed yet',    cls: 'warn' };
      case 'up-to-date':  return { text: '✓ Up to date with origin',   cls: 'on' };
      case 'ahead':       return { text: '↑ ' + ahead + ' commit' + (ahead === 1 ? '' : 's') + ' to push', cls: 'warn' };
      case 'behind':      return { text: '↓ ' + behind + ' commit' + (behind === 1 ? '' : 's') + ' to pull', cls: 'warn' };
      case 'diverged':    return { text: '⇅ Diverged (ahead ' + ahead + ', behind ' + behind + ')', cls: 'err' };
      default:            return { text: '● ' + (state || 'unknown'), cls: 'off' };
    }
  }
  function refreshSyncStatus() {
    var box = document.getElementById('ghSyncState');
    if (!box) return;
    if (!currentProject) { box.textContent = 'Select a project first'; box.className = 'gh-sync-state off'; return; }
    box.textContent = 'Checking…'; box.className = 'gh-sync-state off';
    ghCall('/api/git/status/upstream', { cwd: currentProject }).then(function(r) {
      if (r.error) { box.textContent = '✗ ' + r.error; box.className = 'gh-sync-state err'; return; }
      var info = _syncStateLabel(r.state, r.ahead || 0, r.behind || 0);
      box.textContent = info.text + (r.branch ? '  ·  ' + r.branch : '');
      box.className = 'gh-sync-state ' + info.cls;
      if (r.fetchError) box.textContent += '  ·  fetch error';
      var sw = document.getElementById('ghSyncStrategyWrap');
      if (sw) sw.style.display = (r.state === 'diverged') ? 'block' : 'none';
    }).catch(function(e) {
      box.textContent = '✗ ' + (e.message || 'check failed');
      box.className = 'gh-sync-state err';
    });
  }
  function refreshRemoteInfo() {
    var el = document.getElementById('ghRemoteInfo');
    if (!el) return;
    if (!currentProject) { el.textContent = '—'; return; }
    ghCall('/api/git/remote-info', { cwd: currentProject }).then(function(r) {
      if (!r.remotes || !r.remotes.length) { el.textContent = 'No remotes configured'; return; }
      var origin = r.remotes.find(function(x) { return x.name === 'origin'; }) || r.remotes[0];
      var url = origin.pushUrl || origin.fetchUrl || '';
      var tag = origin.provider === 'github' ? 'GitHub'
              : origin.provider === 'gitlab' ? 'GitLab'
              : origin.provider === 'bitbucket' ? 'Bitbucket'
              : origin.protocol === 'ssh' ? 'SSH' : 'other';
      var shortUrl = url.replace(/^https?:\\/\\//, '').replace(/^git@/, '').replace(/:/, '/').replace(/\\.git$/, '');
      el.innerHTML = '<span style="color:var(--blue)">' + tag + '</span> · ' + escAttr(shortUrl);
    }).catch(function() { el.textContent = '—'; });
  }
  function doSync(strategy) {
    if (!currentProject) { toast('Select a project first', 'error'); return; }
    var body = { cwd: currentProject };
    if (strategy) body.strategy = strategy;
    toast(strategy ? ('Syncing (' + strategy + ')…') : 'Syncing…', 'info');
    ghCall('/api/git/sync', body).then(function(r) {
      var label = r.state || (r.ok ? 'synced' : 'error');
      var ok = r.ok || r.state === 'diverged';
      showGhOutput(
        '=== sync ===\\n' +
        'state:    ' + label + '\\n' +
        'branch:   ' + (r.branch || '-') + '\\n' +
        'upstream: ' + (r.upstream || '-') + '\\n' +
        'ahead:    ' + (r.ahead || 0) + '   behind: ' + (r.behind || 0) + '\\n' +
        (r.error ? 'error:    ' + r.error + '\\n' : '') +
        '\\nsteps:\\n' +
        (r.steps || []).map(function(s) {
          return '  · ' + s.step + ': ' + (s.ok ? 'ok' : 'fail') + (s.detail ? ' — ' + s.detail : '');
        }).join('\\n') +
        (r.output ? '\\n\\noutput:\\n' + r.output : ''),
        !ok && r.state !== 'diverged'
      );
      if (r.state === 'diverged') toast('Diverged — pick rebase or merge', 'warn');
      else if (r.ok) { toast('Sync: ' + label, 'success'); logActivity('git', 'Sync: ' + label); logGitRecord('pull', 'Sync ' + label + (r.branch ? ' · ' + r.branch : '')); }
      else toast('Sync failed: ' + (r.error || label), 'error');
      refreshSyncStatus();
      refreshAllGitState();
    }).catch(function(e) { toast('Sync failed: ' + e.message, 'error'); });
  }
  (function wireSyncButtons() {
    var b1 = document.getElementById('ghSyncRefreshBtn');
    var b2 = document.getElementById('ghSyncNowBtn');
    var b3 = document.getElementById('ghSyncRebaseBtn');
    var b4 = document.getElementById('ghSyncMergeBtn');
    if (b1) b1.onclick = function() { refreshSyncStatus(); refreshRemoteInfo(); toast('Checking origin…', 'info'); };
    if (b2) b2.onclick = function() { doSync(); };
    if (b3) b3.onclick = function() { doSync('rebase'); };
    if (b4) b4.onclick = function() { doSync('merge'); };
  })();
  function refreshAllGitState() {''',
'2  sync functions inserted before refreshAllGitState')

# ─── 3. Call sync + remote-info from refreshAllGitState ───
patch(
'''  function refreshAllGitState() {
    if (!currentProject) return;
    ghCall('/api/git/status/detailed', { cwd: currentProject }).then(function(r) {''',
'''  function refreshAllGitState() {
    if (!currentProject) return;
    refreshSyncStatus();
    refreshRemoteInfo();
    ghCall('/api/git/status/detailed', { cwd: currentProject }).then(function(r) {''',
'3  refreshAllGitState — call the two new refreshers')

# ─── 4. Push handler — refresh sync pill after ───
patch(
'''    if (r.code === 0) { logActivity('git', 'Pushed: ' + msg); logGitRecord('push', msg); }
    else logGitRecord('error', 'Push failed', (r.stderr || '').slice(0, 300));
    refreshAllGitState();''',
'''    if (r.code === 0) { logActivity('git', 'Pushed: ' + msg); logGitRecord('push', msg); }
    else logGitRecord('error', 'Push failed', (r.stderr || '').slice(0, 300));
    refreshSyncStatus();
    refreshAllGitState();''',
'4  push handler — refresh sync pill')

# ─── 5. Pull handler — refresh sync pill after ───
patch(
'''    if (r.code === 0) { logActivity('git', 'Pulled'); logGitRecord('pull', 'Pulled from origin'); }
    refreshAllGitState();''',
'''    if (r.code === 0) { logActivity('git', 'Pulled'); logGitRecord('pull', 'Pulled from origin'); }
    refreshSyncStatus();
    refreshAllGitState();''',
'5  pull handler — refresh sync pill')

# ─── 6. Fetch handler — refresh sync pill after ───
patch(
'''    logGitRecord('fetch', r.ok ? 'Fetched --all --prune' : 'Fetch failed');
    refreshAllGitState();''',
'''    logGitRecord('fetch', r.ok ? 'Fetched --all --prune' : 'Fetch failed');
    refreshSyncStatus();
    refreshAllGitState();''',
'6  fetch handler — refresh sync pill')

# ─── 7. CSS for the pill + remote info line (inside inline <style>) ───
patch(
'''.activity-item.kind-git   .act-icon { color: var(--yellow); }
</style>''',
'''.activity-item.kind-git   .act-icon { color: var(--yellow); }

/* ─── Sync status pill (v2.6) ─── */
.gh-sync-state {
  padding: 10px 12px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 10px;
  font-size: 12px;
  font-family: ui-monospace, 'JetBrains Mono', monospace;
  line-height: 1.4;
  word-break: break-word;
}
.gh-sync-state.on   { color: var(--green);  border-color: rgba(63,185,80,.4);  background: rgba(63,185,80,.06); }
.gh-sync-state.warn { color: var(--yellow); border-color: rgba(210,153,34,.4); background: rgba(210,153,34,.06); }
.gh-sync-state.err  { color: var(--red);    border-color: rgba(248,81,73,.4);  background: rgba(248,81,73,.06); }
.gh-sync-state.off  { color: var(--fg-3); }
.gh-remote-info {
  font-size: 11px;
  color: var(--fg-3);
  font-family: ui-monospace, 'JetBrains Mono', monospace;
  margin-bottom: 10px;
  word-break: break-all;
  line-height: 1.4;
}
</style>''',
'7  CSS — sync state pill + remote info line')

print()
print('── Summary: {ok} applied · {skip} skipped · {fail} failed'.format(**STATS))
sys.exit(0 if STATS['fail'] == 0 else 1)
PYEOF

if [ $? -eq 0 ]; then
  echo "✓ All patches applied cleanly."
else
  echo "⚠  Some patches did not match — review the ✗ lines above."
fi

echo
echo "Next steps:"
echo "  git add public/index.html patch-index-sync.sh"
echo "  git commit -m 'feat(ui): Git sync panel — status pill, remote info, one-tap sync'"
echo "  ~/projects/_tools/ds-promote"
echo "  ds-restart"
