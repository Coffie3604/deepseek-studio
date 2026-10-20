'use strict';
/**
 * Origin / Host guard for the local backend.
 * ─────────────────────────────────────────────────────────────
 * The server intentionally has a huge amount of power (arbitrary
 * shell, filesystem, PTY). It only binds to loopback by default, but
 * that alone is NOT enough:
 *
 *   1. DNS rebinding — a hostile page can resolve evil.example to
 *      127.0.0.1 and then talk to us with `Host: evil.example`,
 *      bypassing same-origin checks in the browser.
 *   2. LAN access — users set HOST=0.0.0.0 to open the editor on a
 *      tablet. Without a token, anyone on the WiFi gets a root shell
 *      through the PTY socket.
 *
 * This module centralises the checks so `cors` and the `ws` upgrade
 * handler use exactly the same rules.
 */

const LOOPBACK_RE = /^(?:localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

function hostnameOf(value) {
    if (!value) return '';
    let h = String(value).trim();
    // Strip scheme if a full origin was passed in.
    h = h.replace(/^[a-z]+:\/\//i, '');
    // Strip credentials, port and path.
    h = h.replace(/^[^/@]*@/, '');
    h = h.split('/')[0];
    if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1); // [::1]:3001
    return h.split(':')[0];
}

/** Extra hostnames allowed to reach the panel (comma separated). */
function extraAllowedHosts() {
    return String(process.env.DS_ALLOWED_HOSTS || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

/**
 * @param {string} hostValue  value of the Host header (or an origin URL)
 * @param {{ bindAll?: boolean }} opts
 * @returns {boolean}
 */
function isAllowedHost(hostValue, opts = {}) {
    const host = hostnameOf(hostValue).toLowerCase();
    if (!host) return false;
    if (LOOPBACK_RE.test(host)) return true;
    if (extraAllowedHosts().includes(host)) return true;
    // When bound to all interfaces we still accept private/LAN literals —
    // the token gate (requireToken) is what protects those requests.
    if (opts.bindAll) {
        if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
        if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
        if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)) return true;
        if (/\.local$/.test(host)) return true;
    }
    return false;
}

/**
 * @param {string|undefined} origin        Origin header (undefined for curl/same-origin GET)
 * @param {string} hostHeader              Host header of the same request
 * @param {{ bindAll?: boolean }} opts
 */
function isAllowedOrigin(origin, hostHeader, opts = {}) {
    if (!origin) return true; // no Origin header → non-browser client
    let url;
    try { url = new URL(origin); } catch (_) { return false; }
    if (!/^https?:$/.test(url.protocol)) return false;
    if (extraAllowedHosts().includes(hostnameOf(url.host).toLowerCase())) return true;
    // A remote page can never be trusted, even if it points at 127.0.0.1.
    if (!isAllowedHost(url.host, { bindAll: false })) return false;
    // Origin host must match the Host we were reached on (prevents a page
    // served from another port/origin from embedding us).
    if (hostHeader && hostnameOf(url.host).toLowerCase() !== hostnameOf(hostHeader).toLowerCase()) return false;
    return true;
}

module.exports = {
    hostnameOf,
    isAllowedHost,
    isAllowedOrigin,
    extraAllowedHosts,
    LOOPBACK_RE,
};
