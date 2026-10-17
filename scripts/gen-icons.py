#!/usr/bin/env python3
"""
Generate Android launcher icons from public/icon-512.png.

Pure stdlib (zlib + struct) so it runs on Termux without Pillow/ImageMagick.
Produces mipmap-*/ic_launcher.png at every density plus a round variant.
"""
import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "public", "icon-512.png")
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")

# density -> launcher icon size in px
DENSITIES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}


def read_png(path):
    """Decode a non-interlaced 8-bit RGB/RGBA PNG into (w, h, pixels[RGBA])."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG: %s" % path)

    pos = 8
    width = height = None
    bit_depth = color_type = None
    idat = b""
    palette = None
    trns = None

    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length

        if ctype == b"IHDR":
            width, height, bit_depth, color_type, comp, filt, interlace = struct.unpack(
                ">IIBBBBB", chunk)
            if bit_depth != 8:
                raise ValueError("only 8-bit PNGs supported (got %d)" % bit_depth)
            if interlace != 0:
                raise ValueError("interlaced PNGs not supported")
        elif ctype == b"PLTE":
            palette = chunk
        elif ctype == b"tRNS":
            trns = chunk
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break

    raw = zlib.decompress(idat)

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    stride = width * channels
    out = bytearray(width * height * 4)
    prev = bytearray(stride)
    p = 0

    for y in range(height):
        ftype = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride

        # Undo the PNG scanline filter.
        if ftype == 1:      # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:    # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:    # Average
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:    # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF

        prev = line

        # Expand to RGBA.
        o = y * width * 4
        if color_type == 6:
            out[o:o + width * 4] = line
        elif color_type == 2:
            for x in range(width):
                s = x * 3
                d = o + x * 4
                out[d] = line[s]
                out[d + 1] = line[s + 1]
                out[d + 2] = line[s + 2]
                out[d + 3] = 255
        elif color_type == 0:
            for x in range(width):
                g = line[x]
                d = o + x * 4
                out[d] = out[d + 1] = out[d + 2] = g
                out[d + 3] = 255
        elif color_type == 3:
            for x in range(width):
                idx = line[x]
                d = o + x * 4
                out[d] = palette[idx * 3]
                out[d + 1] = palette[idx * 3 + 1]
                out[d + 2] = palette[idx * 3 + 2]
                out[d + 3] = trns[idx] if (trns and idx < len(trns)) else 255
        elif color_type == 4:
            for x in range(width):
                g, a = line[x * 2], line[x * 2 + 1]
                d = o + x * 4
                out[d] = out[d + 1] = out[d + 2] = g
                out[d + 3] = a

    return width, height, out


def resize(src_w, src_h, src, dst_w, dst_h):
    """Box-filter downscale with premultiplied alpha (good quality, no deps)."""
    out = bytearray(dst_w * dst_h * 4)
    x_ratio = src_w / dst_w
    y_ratio = src_h / dst_h

    for dy in range(dst_h):
        y0 = int(dy * y_ratio)
        y1 = max(y0 + 1, int((dy + 1) * y_ratio))
        for dx in range(dst_w):
            x0 = int(dx * x_ratio)
            x1 = max(x0 + 1, int((dx + 1) * x_ratio))

            r = g = b = a = 0
            n = 0
            for sy in range(y0, min(y1, src_h)):
                row = sy * src_w * 4
                for sx in range(x0, min(x1, src_w)):
                    i = row + sx * 4
                    sa = src[i + 3]
                    r += src[i] * sa
                    g += src[i + 1] * sa
                    b += src[i + 2] * sa
                    a += sa
                    n += 1

            o = (dy * dst_w + dx) * 4
            if a > 0:
                out[o] = min(255, r // a)
                out[o + 1] = min(255, g // a)
                out[o + 2] = min(255, b // a)
                out[o + 3] = a // n
            else:
                out[o:o + 4] = b"\x00\x00\x00\x00"
    return out


def write_png(path, w, h, rgba):
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter: none
        raw += rgba[y * w * 4:(y + 1) * w * 4]

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload +
                struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png)


def round_mask(w, h, rgba):
    """Apply a circular alpha mask for the round launcher icon."""
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
    radius = min(w, h) / 2.0
    out = bytearray(rgba)
    for y in range(h):
        for x in range(w):
            d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            if d > radius:
                out[(y * w + x) * 4 + 3] = 0
            elif d > radius - 1.5:
                # 1.5px feather to avoid hard jaggies
                out[(y * w + x) * 4 + 3] = int(
                    out[(y * w + x) * 4 + 3] * (radius - d) / 1.5)
    return out


def main():
    if not os.path.exists(SRC):
        sys.exit("missing source icon: %s" % SRC)

    sw, sh, src = read_png(SRC)
    print("source: %s (%dx%d)" % (SRC, sw, sh))

    for density, size in DENSITIES.items():
        scaled = resize(sw, sh, src, size, size)

        square = os.path.join(RES, "mipmap-" + density, "ic_launcher.png")
        write_png(square, size, size, scaled)

        round_icon = os.path.join(RES, "mipmap-" + density, "ic_launcher_round.png")
        write_png(round_icon, size, size, round_mask(size, size, scaled))

        print("  %-8s %3dpx  -> mipmap-%s" % (density, size, density))

    print("done: %d icons" % (len(DENSITIES) * 2))


if __name__ == "__main__":
    main()
