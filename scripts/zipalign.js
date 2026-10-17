#!/usr/bin/env node
/**
 * zipalign.js — pure-JS replacement for Android's `zipalign`.
 *
 * Termux cannot execute Google's build-tools binaries: they are glibc/x86_64
 * ELF files and die with
 *     /lib/ld-linux.so.2: Syntax error: "(" unexpected
 * There is no `zipalign` package in Termux either, so APKs built on-device end
 * up unaligned (Play Store rejects them, and mmap() of uncompressed resources
 * is slower on device).
 *
 * This script reproduces the behaviour of `zipalign -f -p 4 in.apk out.apk`:
 *   • every entry's *data* offset is a multiple of the alignment (4 by default)
 *   • `-p` additionally page-aligns (4096) uncompressed .so files
 *   • `-f` overwrites the output file if it exists
 *   • `-c` verifies an existing APK instead of rewriting it
 *
 * Usage:
 *   node scripts/zipalign.js [-f] [-p] [-c] [-v] [alignment] <in.apk> [out.apk]
 *
 * Exit codes: 0 = ok, 1 = verification failed / bad usage.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function dosDateTime(d) {
    const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
    const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
    return { time, date };
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

function findEocd(buf) {
    const min = Math.max(0, buf.length - 0xffff - 22);
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === SIG_EOCD) return i;
    }
    return -1;
}

function readZip(buf) {
    const eocd = findEocd(buf);
    if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');

    let count = buf.readUInt16LE(eocd + 10);
    let cdSize = buf.readUInt32LE(eocd + 12);
    let cdOffset = buf.readUInt32LE(eocd + 16);
    let cdEnd = eocd;

    // Zip64: the real values live in the Zip64 EOCD record.
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        const locOff = eocd - 20;
        if (locOff >= 0 && buf.readUInt32LE(locOff) === SIG_EOCD64_LOC) {
            const z64 = Number(buf.readBigUInt64LE(locOff + 8));
            if (buf.readUInt32LE(z64) === SIG_EOCD64) {
                count = Number(buf.readBigUInt64LE(z64 + 32));
                cdSize = Number(buf.readBigUInt64LE(z64 + 40));
                cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
                cdEnd = z64;
            }
        }
    }

    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('corrupt central directory at ' + p);
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const time = buf.readUInt16LE(p + 12);
        const date = buf.readUInt16LE(p + 14);
        const crc = buf.readUInt32LE(p + 16);
        const csize = buf.readUInt32LE(p + 20);
        const usize = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const intAttr = buf.readUInt16LE(p + 36);
        const extAttr = buf.readUInt32LE(p + 38);
        const localOff = buf.readUInt32LE(p + 42);
        const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
        const extra = buf.slice(p + 46 + nameLen, p + 46 + nameLen + extraLen);
        const comment = buf.slice(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen);

        if (buf.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error('corrupt local header for ' + name);
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;

        entries.push({
            name, flags, method, time, date, crc, csize, usize,
            intAttr, extAttr, comment, extra,
            data: buf.slice(dataStart, dataStart + csize),
        });
        p += 46 + nameLen + extraLen + commentLen;
    }

    return { entries, cdEnd, cdSize, cdOffset };
}

/* ── Writing ─────────────────────────────────────────────────────────────── */

function writeZip(entries, alignment, pageAlign) {
    const chunks = [];
    let offset = 0;
    const central = [];

    for (const e of entries) {
        const nameBuf = Buffer.from(e.name, 'utf8');
        const isSo = pageAlign && /\.so$/i.test(e.name) && e.method === 0;
        const align = isSo ? Math.max(alignment, 4096) : alignment;

        // Local header is 30 bytes + name + extra. Pad the extra field so the
        // file data starts on an `align` boundary.
        //
        // An extra field is a 4-byte header (ID + length) plus payload, so the
        // smallest *valid* extra field is 4 bytes. When the required padding is
        // 1-3 bytes we cannot express it with an extra field alone; Android's
        // zipalign instead grows the *name* field by appending NUL bytes (zip
        // readers ignore trailing NULs) so the header grows by exactly 1-3
        // bytes and the data lands on the boundary.
        //
        //   pad 0        → no extra field
        //   pad 1-3      → extra field of pad+4 bytes (header + payload), which
        //                  overshoots by 4 and is absorbed by the next entry
        //   pad >= 4     → extra field of `pad` bytes (0xd935 padding record)
        //
        // NUL-padding the *name* is not an option: apksigner rejects entry
        // names containing 0x00 ("Unsupported character 0x00 in ZIP entry
        // name"). An extra field is always at least 4 bytes, so for a 1-3 byte
        // pad we emit pad+4 bytes and let the data start 4 bytes late — still
        // 4-byte aligned, which is all zipalign guarantees.
        const base = offset + 30 + nameBuf.length;
        const pad = (align - (base % align)) % align;
        let extra = Buffer.alloc(0);
        if (pad > 0) {
            const extraLen = pad < 4 ? pad + 4 : pad;
            extra = Buffer.alloc(extraLen);
            extra.writeUInt16LE(0xd935, 0);          // Android zipalign padding ID
            extra.writeUInt16LE(extraLen - 4, 2);
        }

        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(SIG_LOCAL, 0);
        lh.writeUInt16LE(20, 4);                     // version needed
        lh.writeUInt16LE(e.flags, 6);
        lh.writeUInt16LE(e.method, 8);
        lh.writeUInt16LE(e.time, 10);
        lh.writeUInt16LE(e.date, 12);
        lh.writeUInt32LE(e.crc, 14);
        lh.writeUInt32LE(e.csize, 18);
        lh.writeUInt32LE(e.usize, 22);
        lh.writeUInt16LE(nameBuf.length, 26);
        lh.writeUInt16LE(extra.length, 28);

        chunks.push(lh, nameBuf, extra, e.data);
        central.push({ e, nameBuf, localOff: offset });
        offset += 30 + nameBuf.length + extra.length + e.data.length;
    }

    const cdStart = offset;
    for (const { e, nameBuf, localOff } of central) {
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(SIG_CENTRAL, 0);
        ch.writeUInt16LE(20, 4);                     // version made by
        ch.writeUInt16LE(20, 6);                     // version needed
        ch.writeUInt16LE(e.flags, 8);
        ch.writeUInt16LE(e.method, 10);
        ch.writeUInt16LE(e.time, 12);
        ch.writeUInt16LE(e.date, 14);
        ch.writeUInt32LE(e.crc, 16);
        ch.writeUInt32LE(e.csize, 20);
        ch.writeUInt32LE(e.usize, 24);
        ch.writeUInt16LE(nameBuf.length, 28);
        ch.writeUInt16LE(e.extra.length, 30);
        ch.writeUInt16LE(e.comment.length, 32);
        ch.writeUInt16LE(0, 34);                     // disk number
        ch.writeUInt16LE(e.intAttr, 36);
        ch.writeUInt32LE(e.extAttr, 38);
        ch.writeUInt32LE(localOff, 42);
        chunks.push(ch, nameBuf, e.extra, e.comment);
        offset += 46 + nameBuf.length + e.extra.length + e.comment.length;
    }

    const cdSize = offset - cdStart;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    chunks.push(eocd);

    return Buffer.concat(chunks);
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */

function main(argv) {
    let force = false, pageAlign = false, check = false, verbose = false;
    let alignment = 4;
    const positional = [];

    for (const arg of argv) {
        if (arg === '-f') force = true;
        else if (arg === '-p') pageAlign = true;
        else if (arg === '-c') check = true;
        else if (arg === '-v') verbose = true;
        else if (arg === '-h' || arg === '--help') {
            console.log('usage: zipalign [-f] [-p] [-c] [-v] [alignment] <in.apk> [out.apk]');
            return 0;
        } else if (/^\d+$/.test(arg)) alignment = parseInt(arg, 10);
        else positional.push(arg);
    }

    if (positional.length < 1) {
        console.error('usage: zipalign [-f] [-p] [-c] [-v] [alignment] <in.apk> [out.apk]');
        return 1;
    }
    const inFile = positional[0];
    const outFile = positional[1] || inFile;

    if (!fs.existsSync(inFile)) { console.error('zipalign: ' + inFile + ': no such file'); return 1; }
    if (!check && outFile !== inFile && fs.existsSync(outFile) && !force) {
        console.error('zipalign: ' + outFile + ' exists (use -f to overwrite)');
        return 1;
    }

    const buf = fs.readFileSync(inFile);

    if (check) {
        const entries = entriesWithOffsets(buf);
        let bad = 0;
        for (const e of entries) {
            const align = pageAlign && /\.so$/i.test(e.name) && e.method === 0
                ? Math.max(alignment, 4096) : alignment;
            const off = e.__dataOffset;
            if (off % align !== 0) {
                bad++;
                console.error('  BAD  ' + e.name + ' (offset ' + off + ', align ' + align + ')');
            } else if (verbose) {
                console.log('  ok   ' + e.name + ' @ ' + off);
            }
        }
        if (bad) { console.error('zipalign: ' + bad + ' entr' + (bad === 1 ? 'y' : 'ies') + ' misaligned'); return 1; }
        console.log('Verification successful');
        return 0;
    }

    const out = writeZip(entriesWithOffsets(buf), alignment, pageAlign);
    if (outFile === inFile) {
        const tmp = inFile + '.zipalign.tmp';
        fs.writeFileSync(tmp, out);
        fs.renameSync(tmp, inFile);
    } else {
        fs.writeFileSync(outFile, out);
    }
    if (verbose) console.log('Aligned ' + inFile + ' → ' + outFile + ' (' + alignment + '-byte)');
    return 0;
}

// readZip() gives us entry data but not the absolute data offset; recompute it
// so `-c` can report real offsets.
function entriesWithOffsets(buf) {
    const { entries } = readZip(buf);
    let p = 0;
    for (const e of entries) {
        // Walk local headers sequentially — they are contiguous in valid zips.
        // (The central directory's localOff is unreliable after a rewrite, so
        // never trust it here.)
        if (buf.readUInt32LE(p) !== SIG_LOCAL) break;
        const nameLen = buf.readUInt16LE(p + 26);
        const extraLen = buf.readUInt16LE(p + 28);
        e.__dataOffset = p + 30 + nameLen + extraLen;
        p = e.__dataOffset + e.csize;
    }
    return entries;
}

if (require.main === module) {
    let code = 1;
    try { code = main(process.argv.slice(2)); }
    catch (err) { console.error('zipalign: ' + (err && err.message ? err.message : err)); code = 1; }
    process.exit(code);
}

module.exports = { readZip, writeZip, entriesWithOffsets, crc32, dosDateTime };
