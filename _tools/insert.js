const fs = require('fs');
const p = 'public/index.html';
let s = fs.readFileSync(p, 'utf8');
const anchor = `        </div>\n        <div class="settings-section">\n          <h3><i class="fas fa-undo"></i> Recovery</h3>`;
if (!s.includes(anchor)) { console.error('ANCHOR NOT FOUND'); process.exit(1); }
const block = `        </div>
        <div class="settings-section">
          <h3><i class="fas fa-plus-circle"></i> New GitHub Repository</h3>
          <input type="text" id="ghNewRepoName" placeholder="repo-name" style="margin-bottom:8px" />
          <input type="text" id="ghNewRepoDesc" placeholder="Description (optional)" style="margin-bottom:8px" />
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--fg-3);margin-bottom:10px"><input type="checkbox" id="ghNewRepoPrivate" checked /> Private repository</label>
          <button class="btn primary" id="ghCreateRepoBtn" style="width:100%;justify-content:center;padding:10px"><i class="fas fa-cloud"></i> Create and Set Origin</button>
          <h3 style="margin-top:18px"><i class="fas fa-code-branch"></i> Pull Requests</h3>
          <input type="text" id="ghPrTitle" placeholder="PR title" style="margin-bottom:8px" />
          <input type="text" id="ghPrBase" placeholder="base branch (default: main)" style="margin-bottom:8px" />
          <textarea id="ghPrBody" placeholder="Description (optional)" style="width:100%;min-height:56px;margin-bottom:10px;background:var(--bg-2);color:var(--fg-1);border:1px solid var(--border-1);border-radius:8px;padding:8px;font-family:inherit;font-size:12px"></textarea>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <button class="btn primary" id="ghOpenPrBtn" style="justify-content:center;padding:10px">Open PR</button>
            <button class="btn" id="ghListPrsBtn" style="justify-content:center;padding:10px">List PRs</button>
          </div>
          <div id="ghPrList" style="font-size:11px;margin-top:10px;max-height:200px;overflow-y:auto"></div>
          <h3 style="margin-top:18px"><i class="fas fa-tag"></i> Create Release</h3>
          <input type="text" id="ghReleaseTag" placeholder="v1.0.0" style="margin-bottom:8px" />
          <input type="text" id="ghReleaseName" placeholder="Release title (optional)" style="margin-bottom:8px" />
          <textarea id="ghReleaseNotes" placeholder="Release notes (optional)" style="width:100%;min-height:56px;margin-bottom:10px;background:var(--bg-2);color:var(--fg-1);border:1px solid var(--border-1);border-radius:8px;padding:8px;font-family:inherit;font-size:12px"></textarea>
          <button class="btn primary" id="ghCreateReleaseBtn" style="width:100%;justify-content:center;padding:10px">Publish GitHub Release</button>
        </div>
        <div class="settings-section">
          <h3><i class="fas fa-code-branch"></i> Advanced Git</h3>
          <button class="btn" id="ghDiffBtn" style="width:100%;justify-content:center;padding:10px">View Diff</button>
          <button class="btn warn" id="ghConflictsBtn" style="width:100%;justify-content:center;padding:10px;margin-top:8px">Show Conflicts</button>
          <input type="text" id="ghRebaseOnto" placeholder="rebase onto (e.g. origin/main)" style="margin-top:8px;margin-bottom:8px" />
          <button class="btn warn" id="ghRebaseBtn" style="width:100%;justify-content:center;padding:10px">Rebase Onto</button>
          <input type="text" id="ghRemoteUrl" placeholder="new origin url (https://...)" style="margin-top:8px;margin-bottom:8px" />
          <button class="btn" id="ghSetRemoteBtn" style="width:100%;justify-content:center;padding:10px">Set Origin Remote</button>
        </div>
        <div class="settings-section">
          <h3><i class="fas fa-undo"></i> Recovery</h3>`;
s = s.replace(anchor, block);
fs.writeFileSync(p, s);
console.log('OK inserted');
