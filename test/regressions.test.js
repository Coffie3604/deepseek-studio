"use strict";
// Regression tests for two bugs found in the code audit:
//   1. run_command with background:true killed the process at 3s but reported ok.
//   2. resolvePath did not resolve symlinks, allowing workspace escape.
// Run with: npm test
const { test } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
// Avoid fetch's blocked-port list (4045, 4190, 6000, ...) by staying in a
// range Node's undici treats as safe.
const PORT = 8100 + Math.floor(Math.random() * 800);

// os.tmpdir() is /tmp on most systems but does not exist on Termux.
const TMP = path.join(ROOT, ".test-tmp");
fs.mkdirSync(TMP, { recursive: true });
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

function startServer(env = {}) {
    const child = spawn(process.execPath, ["server.js"], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
            PORT: String(PORT),
            HOST: "127.0.0.1",
            DS_WORKSPACE: fs.mkdtempSync(path.join(TMP, "ws-")),
        }, env),
        stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error("server did not start: " + out)), 15000);
        const onData = (d) => {
            out += d.toString();
            if (/URL:\s+http/i.test(out)) { clearTimeout(timer); resolve(child); }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("exit", (c) => { clearTimeout(timer); reject(new Error("exited " + c + ": " + out)); });
    });
}

const api = (p, body) => fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// GET helper for read-only routes that take query params, not a JSON body.
const apiGet = (p, params) => fetch(
    `http://127.0.0.1:${PORT}${p}?` + new URLSearchParams(params),
).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// ── Bug 2: symlink escape ────────────────────────────────────────────
test("fs read refuses a symlink that escapes the workspace", async () => {
    const ws = fs.mkdtempSync(path.join(TMP, "ws-"));
    const outside = fs.mkdtempSync(path.join(TMP, "outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET");
    fs.symlinkSync(outside, path.join(ws, "escape"));

    const child = await startServer({ DS_WORKSPACE: ws });
    try {
        const r = await apiGet("/api/fs/read", { path: "escape/secret.txt" });
        assert.notStrictEqual(r.status, 200, "symlink escape must not return 200");
        assert.ok(!JSON.stringify(r.body).includes("TOP-SECRET"), "must not leak file contents");
    } finally { child.kill(); }
});

test("fs read still works for a normal file in the workspace", async () => {
    const ws = fs.mkdtempSync(path.join(TMP, "ws-"));
    fs.writeFileSync(path.join(ws, "hello.txt"), "hello");

    const child = await startServer({ DS_WORKSPACE: ws });
    try {
        const r = await apiGet("/api/fs/read", { path: "hello.txt" });
        assert.strictEqual(r.status, 200);
        assert.ok(JSON.stringify(r.body).includes("hello"));
    } finally { child.kill(); }
});

// ── Bug 1: background command must survive ───────────────────────────
test("exec with background:true keeps the process alive past 3s", async () => {
    const ws = fs.mkdtempSync(path.join(TMP, "ws-"));
    const child = await startServer({ DS_WORKSPACE: ws });
    try {
        const marker = path.join(ws, "bg-marker.txt");
        // Write the marker after 5s; if the process were killed at 3s it never appears.
        // This must go through the run_command tool, which is the only path that
        // honours background:true. /api/exec is a blocking exec with no such flag.
        const r = await api("/api/ai/tool-call", {
            name: "run_command",
            args: { command: `sleep 5; echo alive > ${JSON.stringify(marker)}`, background: true },
        });
        assert.strictEqual(r.status, 200);
        await new Promise((res) => setTimeout(res, 7000));
        assert.ok(fs.existsSync(marker), "background process was killed before finishing");
        assert.strictEqual(fs.readFileSync(marker, "utf8").trim(), "alive");
    } finally { child.kill(); }
});
