const fs = require('fs');
const p = 'public/index.html';
let s = fs.readFileSync(p, 'utf8');
const anchor = `  function showGhOutput(text, error) {
    var el = document.getElementById('ghOutput');`;
if (!s.includes(anchor)) { console.error('ANCHOR NOT FOUND'); process.exit(1); }
const block = `  /* ─── Create repo · PRs · Releases · Advanced git ─── */
  var $id = function(id) { return document.getElementById(id); };
  if ($id('ghCreateRepoBtn')) $id('ghCreateRepoBtn').onclick = async function() {
    if (!currentProject) { toast('Select a project first', 'error'); return; }
    var name = $id('ghNewRepoName').value.trim();
    if (!name) { toast('Repo name required', 'error'); return; }
    var desc = $id('ghNewRepoDesc').value.trim();
    var isPrivate = $id('ghNewRepoPrivate').checked;
    var r = await ghCall('/api/github/create-repo', { name: name, description: desc, isPrivate: isPrivate });
    if (r.error) { showGhOutput(r.error, true); toast('Create failed', 'error'); return; }
    var cloneUrl = r.repo && (r.repo.cloneUrl || r.repo.sshUrl);
    showGhOutput('Created ' + (r.repo ? r.repo.fullName : name), false);
    if (cloneUrl) {
      await ghCall('/api/git/set-remote', { cwd: currentProject, url: cloneUrl });
      toast('Repo created & origin set', 'success');
    } else { toast('Repo created', 'success'); }
    logActivity('git', 'Created GitHub repo: ' + name);
    logGitRecord('branch', 'Created repo ' + name, cloneUrl || '');
    if (window.loadGhRepoPicker) loadGhRepoPicker();
    refreshAllGitState();
  };
  if ($id('ghOpenPrBtn')) $id('ghOpenPrBtn').onclick = async function() {
    if (!currentProject) { toast('Select a project first', 'error'); return; }
    var title = $id('ghPrTitle').value.trim();
    if (!title) { toast('PR title required', 'error'); return; }
    var r = await ghCall('/api/github/open-pr', { cwd: currentProject, title: title, body: $id('ghPrBody').value, base: $id('ghPrBase').value.trim() || undefined });
    if (r.error) { showGhOutput(r.error, true); toast('PR failed', 'error'); return; }
    showGhOutput('Opened PR #' + r.number + '\\n' + r.url, false);
    toast('PR #' + r.number + ' opened', 'success');
    logGitRecord('branch', 'Opened PR #' + r.number, r.url || '');
  };
  if ($id('ghListPrsBtn')) $id('ghListPrsBtn').onclick = async function() {
    if (!currentProject) { toast('Select a project first', 'error'); return; }
    var r = await ghCall('/api/github/list-prs', { cwd: currentProject, state: 'open' });
    var el = $id('ghPrList');
    if (r.error) { el.innerHTML = '<span style="color:var(--red)">' + r.error + '</span>'; return; }
    if (!r.prs || !r.prs.length) { el.innerHTML = '<span style="color:var(--fg-3)">No open pull requests</span>'; return; }
    el.innerHTML = r.prs.map(function(pr) {
      return '<div style="padding:6px 0;border-bottom:1px solid var(--border-2)"><a href="' + pr.url + '" target="_blank" style="color:var(--blue);text-decoration:none">#' + pr.number + ' ' + pr.title + '</a><div style="color:var(--fg-3);font-size:10px">' + pr.head + ' → ' + pr.base + ' · ' + (pr.user || '') + '</div></div>';
    }).join('');
  };
  if ($id('ghCreateReleaseBtn')) $id('ghCreateReleaseBtn').onclick = async function() {
    if (!currentProject) { toast('Select a project first', 'error'); return; }
    var tag = $id('ghReleaseTag').value.trim();
    if (!tag) { toast('Tag required', 'error'); return; }
    var r = await ghCall('/api/github/create-release', { cwd: currentProject, tag: tag, name: $id('ghReleaseName').value.trim() || tag, body: $id('ghReleaseNotes').value });
    if (r.error) { showGhOutput(r.error, true); toast('Release failed', 'error'); return; }
    showGhOutput('Published release ' + tag + (r.url ? '\\n' + r.url : ''), false);
    toast('Release published', 'success');
    logGitRecord('push', 'Published release ' + tag, r.url || '');
  };
  if ($id('ghDiffBtn')) $id('ghDiffBtn').onclick = async function() {
    if (!currentProject) return;
    var r = await ghCall('/api/git/diff', { cwd: currentProject });
    showGhOutput('=== UNSTAGED ===\\n' + (r.unstaged || '(none)') + '\\n\\n=== STAGED ===\\n' + (r.staged || '(none)'), !!r.error);
  };
  if ($id('ghConflictsBtn')) $id('ghConflictsBtn').onclick = async function() {
    if (!currentProject) return;
    var r = await ghCall('/api/git/conflicts', { cwd: currentProject });
    showGhOutput((r.files && r.files.length) ? 'Conflicted files:\\n' + r.files.join('\\n') : 'No conflicts ✓', !!r.error);
  };
  if ($id('ghRebaseBtn')) $id('ghRebaseBtn').onclick = async function() {
    if (!currentProject) return;
    var onto = $id('ghRebaseOnto').value.trim();
    if (!onto) { toast('Ref required', 'error'); return; }
    var r = await ghCall('/api/git/rebase', { cwd: currentProject, onto: onto });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Rebased' : (r.conflicted ? 'Conflicts' : 'Rebase failed'), r.ok ? 'success' : 'error');
    logGitRecord('merge', r.ok ? 'Rebased onto ' + onto : 'Rebase failed');
    refreshAllGitState();
  };
  if ($id('ghSetRemoteBtn')) $id('ghSetRemoteBtn').onclick = async function() {
    if (!currentProject) return;
    var url = $id('ghRemoteUrl').value.trim();
    if (!url) { toast('URL required', 'error'); return; }
    var r = await ghCall('/api/git/set-remote', { cwd: currentProject, url: url });
    showGhOutput((r.stdout || '') + (r.stderr || ''), !r.ok);
    toast(r.ok ? 'Origin set' : 'Failed', r.ok ? 'success' : 'error');
    refreshAllGitState();
  };
  function showGhOutput(text, error) {
    var el = document.getElementById('ghOutput');`;
s = s.replace(anchor, block);
fs.writeFileSync(p, s);
console.log('OK wired');
