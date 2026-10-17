# DeepSeek Studio — Improvement Plan (sandbox → main)

Staging repo: `deepseek-editor-sandbox` (port **3002**)
Production repo: `deepseek-editor` (port **3001**, ships `aligned-test.apk`)

> **Status: cross-checked against the working tree.** The previous revision of
> this file described the *pre-split* codebase. Most of §1 and §2 have since
> landed. This revision records what is actually done, what is half-done, and
> what is still open — verified by reading the files, not from memory.

---

## 0. Cross-check: what the previous plan claimed vs. what is true

| Claim in previous plan | Reality | Verdict |
|---|---|---|
| `public/index.html` is 4823 lines with inline `<style>` + 3700-line `<script>` | **981 lines**, zero `<style>`, one `<script type="module" src="/js/boot.js">` | ✅ **DONE** |
| `server.js` is 3419 lines | **3429 lines**, still one file, 90 routes | ❌ **NOT DONE** |
| `sw.js` cache is `v5`, drifts from `boot v2.6.0` | `CACHE_NAME = 'deepseek-studio-v6'`, `boot v2.7.0 (modular)` | ✅ **DONE** |
| `sw.js` precaches `/` but not the `js/*` modules | `PRECACHE_URLS` lists all 10 module files | ✅ **DONE** |
| `sendChat()` has no `AbortController` | `sendChat()` now streams through `core/api.js` `aiStreamRaw()`; Stop button bound | ✅ **DONE** |
| `chatHistory` unbounded in `localStorage` | Still `localStorage.setItem('ds_chat', …)`, no cap, no IndexedDB | ❌ **NOT DONE** |
| `MainActivity.DEFAULT_URL` hardcoded to `3001` | **No `android/` directory exists in this repo at all** | ❓ **UNVERIFIABLE** |
| Three `patch-*.sh` scripts, no test gate | `patch-*.sh` still present, but `npm test` now runs `check:server` + `check:modules` | ⚠️ **PARTIAL** |
| No `DS_ENV` in `/api/version` | `DS_ENV` present, returns `sandbox`/`production` + `staging` flag | ✅ **DONE** |
| Terminal key row missing | `KEY_ROW` implemented in `features/terminal.js` (Esc/Tab/Ctrl/arrows/`/`/`-`/`\|`/`~`) | ✅ **DONE** |
| `promote.sh` missing | `scripts/promote.sh` still missing | ❌ **NOT DONE** |

**Verified green:** `npm run check:modules` → `✓ module graph clean — 10 files,
all imports resolve`. All 9 modules pass `node --check` in ESM mode.

---

## 1. Web split — mostly landed, one real defect

Current shape (measured):

```
public/index.html          981   markup only
public/app.css            1380
public/js/boot.js          125   wiring only, no logic
public/js/legacy.js       3697   ← the migration staging area
public/js/main.js         3727   ← DEAD FILE, see below
public/js/core/state.js    140
public/js/core/bus.js       78
public/js/core/api.js      160
public/js/core/lifecycle.js 122
public/js/core/ui.js       293
public/js/features/terminal.js 452
public/js/features/chat.js   1   ← stub: `/* chat feature */`
```

### 1a. 🔴 Delete `public/js/main.js` — it is dead and misleading

`main.js` is the pre-split script, still starting with
`console.log('[DS] boot v2.6.0')`. Nothing references it: `index.html` loads
only `boot.js`, and the sole mention of the string `main.js` anywhere is a
comment inside `legacy.js` telling you to remove an import from it. It is
3727 lines of stale `var`-global code sitting next to the real module graph.

It is also a trap: it is the file a future reader will open first, and it will
teach them the wrong architecture. **Delete it.** If you want a safety net,
`git rm` is the safety net.

### 1b. 🟡 `legacy.js` still owns the terminal's public surface

`features/terminal.js` is a real module (452 lines, `init`/`destroy`/`mount`/
`unmount`/`run`/`send`/`isReady`, bus contract documented in the header). But
`legacy.js` still defines shims that exist only to keep old call sites alive:

```js
function initTerminal() { /* boot.js registers the feature; nothing to do */ }
function setupTerminalSearch() { /* Bound by features/terminal.js */ }
function sendToTerminal(cmd, silent) {
  switchPrimaryPanel('terminal');
  emit('terminal:run', { cmd, silent: !!silent });
  return true;
}
```

These are correct but they are the *only* thing keeping `legacy.js`'s export
block honest. Finish the carve-out: change the call sites to
`bus.emit('terminal:run', …)` directly, then delete the three shims and their
entries in the `export {}` block at line 3569.

### 1c. 🟡 `switchPrimaryPanel` duplicates `boot.js`'s `wirePanels`

Both toggle `.ptab` / `.tab-panel` classes and both call `switchPanel()`.
`boot.js` wires `tab.onclick`; `legacy.js` exposes `switchPrimaryPanel` for
programmatic switches. Two implementations of the same DOM mutation will drift.
Collapse to one: keep `switchPrimaryPanel` (it is the one callers use) and have
`boot.js`'s `wirePanels` call it instead of reimplementing it.

### 1d. Remaining carve-out order (unchanged, still correct)

`files.js` → `editor.js` → `chat.js`. Chat last, it is the most entangled.
`features/chat.js` is currently a one-line stub, so chat is 100% still in
`legacy.js` (`sendChat` at 1475, `renderChatContent` at 1241).

Rule that keeps the split honest: **no feature imports another feature.**
Cross-panel actions go through `core/bus.js`. `boot.js` is the only file that
knows the whole set.

---

## 2. Server: split `server.js` — NOT STARTED

3429 lines, 90 routes, still one file. Target layout unchanged:

```
server/
  index.js            # express app, middleware, listen
  lib/paths.js        # WORKSPACE, resolveInWorkspace, safeRealPath
  lib/secrets.js      # load/save/redact
  lib/run.js          # run(), termuxCli(), fetchWithRetry()
  routes/fs.js        # /api/fs/*
  routes/ai.js        # /api/ai/*
  routes/git.js       # /api/git/*
  routes/exec.js      # /api/exec, /api/compile, /api/processes
  routes/license.js
  routes/system.js    # version, health, diagnostics, changelog
  pty.js              # WebSocket /pty
```

Same rule: routes never import each other, only `lib/*`.

**Do this one route group per commit.** 90 routes in one diff is unreviewable,
and `node --check` only proves it parses, not that a handler still resolves its
closure variables. Extract `lib/*` first (pure moves), then one `routes/*` file
at a time, running `npm run smoke` after each.

---

## 3. Android APK — sources are here, item 1 is done

**Correction to the previous revision: `android/` does exist** in this repo
(`android/app/src/main/java/com/coffie/deepseekstudio/{MainActivity,DeviceBridge}.java`,
`AndroidManifest.xml`, `res/values/*`). The earlier "no android/ directory"
verdict was wrong — it was checked from the wrong working directory.

Verified in `MainActivity.java`:

- ✅ **`DEFAULT_URL` now probes.** `CANDIDATE_URLS = ["http://127.0.0.1:3001/",
  "http://127.0.0.1:3002/"]` with a comment explaining 3001 = production,
  3002 = sandbox, and `showError("No backend on 3001 or 3002")` when both
  fail. The APK can reach the sandbox.
- ⚠️ `AndroidManifest.xml:5` still carries the stale comment
  `<!-- The editor backend runs on Termux at 127.0.0.1:3001 -->`. Cosmetic,
  but it is the first thing a reader sees. Update it to mention both ports.

Still unverified / open (carried over):

1. ~~`DEFAULT_URL` probe~~ — done, see above.
2. WebView ignores `sw.js` unless `ServiceWorkerController` is configured —
   the PWA offline story is web-only inside the APK.
3. `onBackPressed` is deprecated (API 33+); move to `OnBackPressedDispatcher`
   and route back to "close panel" before "exit".
4. No foreground service for the backend — if Termux is killed the WebView
   shows a dead page. Add a `ConnectionService` pinging `/api/health` every
   30 s with a "Restart backend" action.
5. No `ACTION_VIEW` / `ACTION_SEND` intent filter for `text/*`.
6. `usesCleartextTraffic="true"` globally — restrict via
   `network_security_config.xml` to `127.0.0.1`.
7. Add debug-only `WebView.setWebContentsDebuggingEnabled(true)`.
8. Add `android:enableOnBackInvokedCallback="true"` for Android 13+.

---

## 4. Web app — remaining work

**Correctness / robustness**

- ✅ **`sendChat()` now goes through `core/api.js`.** Done, with one wrinkle
  worth recording: the original `aiStream()` *flattens* SSE frames to text
  (`parsed.delta || parsed.content || parsed.text`), which silently drops
  `choices[0].delta.tool_calls`. Wiring `sendChat` to it as-is would have
  killed the agent loop — the model would answer but never call a tool.
  So `core/api.js` gained **`aiStreamRaw(payload, onDelta, onError)`**, which
  hands back the raw upstream delta and keeps the AbortController. `aiStream()`
  stays for plain text-only callers. `sendChat` now assigns
  `chatAbortCtrl = stream`, so `stopChat()` aborts the real request and the
  partial answer is persisted via `saveChatMessage`. The non-streaming branch
  keeps its own `fetch()` (it needs `res.json()`, not a stream) but now passes
  `chatAbortCtrl.signal` too.
- 🔴 **`chatHistory` still unbounded in `localStorage`.** `legacy.js:1326`
  writes the whole array on every message; `state.js` persists `chatHistory`
  too. A long session hits the ~5 MB quota and `state.js` swallows it into a
  `state:persist-failed` event that nothing listens to. Move to IndexedDB with
  a message cap, or at minimum cap the array and surface the failure.
- 🟡 No retry/backoff on `/api/ai/stream` client-side. `fetchWithRetry` exists
  server-side; the client does not use it.

**Mobile UX**

- 🟡 Panel switching: `lifecycle.js` is implemented and `terminal` is
  registered `heavy: true`, but **only terminal is registered**. Monaco and the
  chat DOM are still never torn down, so the main jank source is only 1/3
  fixed. Register `editor` and `chat` as `heavy` when they are carved out.
- Bottom action bar (Chat / Editor / Terminal / Files) instead of the tab strip.
- Editor: swipe-left/right to switch tabs; long-press tab menu.
- Respect `env(safe-area-inset-*)`; needs `viewport-fit=cover`.
- `prefers-reduced-motion` handling for the drawer animations.

**Performance**

- Monaco still loads from CDN. Vendor to `public/vendor/monaco/` for offline
  cold start. (xterm is also CDN-loaded in `terminal.js` — same problem, and
  it is worse because the terminal is the panel that must work offline.)
- Lazy-load Git and Deploy panels.
- `renderChatContent()` re-renders the whole transcript per stream chunk.
  Append-only rendering for the streaming message.

**PWA**

- `share_target` in the manifest so Android's share sheet can send text to chat.
- `shortcuts` (New Chat / Open Terminal / New File).
- `display_override: ["window-controls-overlay", "standalone"]`.

---

## 5. Sandbox ↔ production discipline

- ✅ `server.js` defaults to 3002 with an explanatory comment.
- ✅ `DS_ENV` in `/api/version` (`sandbox` / `production` + `staging` flag).
- ✅ `npm test` = `check:server` + `check:modules`; `npm run smoke` hits
  `/api/health`. `check:modules` is genuinely useful — it caught nothing today,
  which is the point.
- ❌ `scripts/promote.sh` still missing. `patch-all.sh`,
  `patch-index-sync.sh`, `patch-server-sync.sh` are still the sync mechanism.
  Replace with one script that diffs sandbox → main and refuses to run if
  `npm test` fails.
- 🟡 `package.json` version is `2.6.0` while `boot.js` logs `2.7.0`. Bump the
  package version, or derive the boot log from `/api/version` so it cannot
  drift again.

---

## Suggested next three commits

1. `feat(web): IndexedDB chat history with a hard cap`
   — `saveChatMessage` already trims to 100 and retries once on quota, but
   `state.js` still persists `chatHistory` to `localStorage` independently and
   swallows the failure into an unlistened `state:persist-failed` event. One
   store, one cap, one place that reports failure.
2. `refactor(web): carve out features/files.js`
   — next in the order. `legacy.js` is 3768 lines; files is the least
   entangled remaining chunk.
3. `refactor(server): extract server/lib/* (pure moves)`
   — no route changes yet, just the shared helpers, gated on `npm test`.

### Done since the last revision

- ✅ `public/js/main.js` deleted (it was already gone — the previous plan's
  "next commit" was stale).
- ✅ `sendChat()` wired to `core/api.js` via the new `aiStreamRaw()`; Stop
  button now aborts the real request.
- ✅ `sw.js` cache bumped `v7` → `v8` so the new `api.js` is picked up.
- ✅ `android/` located; `DEFAULT_URL` probe confirmed implemented.
