#!/usr/bin/env python3
"""Read-only export of the pinned original main-menu glyph outlines.

The emitted paths are the existing DefineFont3 glyphs, not another font or
redrawn artwork. No SWF output is written. Run on the CI/CD pristine input.
"""
import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

EXPECTED = "34ff145d96891ddea20278700c8b1fb6fd6273ca0e71b73d8bdf0df183fdbece"
raw = Path(sys.argv[1]).read_bytes()
assert hashlib.sha256(raw).hexdigest() == EXPECTED, "not the pinned original SWF"
body = zlib.decompress(raw[8:]) if raw[:3] == b"CWS" else raw[8:]


class Bits:
    def __init__(self, data, pos=0):
        self.data, self.bit = data, pos * 8

    def get(self, n, signed=False):
        value = 0
        for _ in range(n):
            value = (value << 1) | ((self.data[self.bit // 8] >> (7 - self.bit % 8)) & 1)
            self.bit += 1
        return value - (1 << n) if signed and n and value & (1 << (n - 1)) else value

    def align(self):
        self.bit = (self.bit + 7) // 8 * 8
        return self.bit // 8


def u16(data, pos):
    return struct.unpack_from("<H", data, pos)[0]


def shape(data):
    reader = Bits(data)
    fills, lines = reader.get(4), reader.get(4)
    x = y = 0
    paths, styles, coordinates = [], [], []
    while True:
        edge = reader.get(1)
        if not edge:
            flags = reader.get(5)
            if not flags:
                break
            assert not flags & 16, "unexpected glyph-local new styles"
            if flags & 1:
                count = reader.get(5)
                x, y = reader.get(count, True), reader.get(count, True)
                paths.append(["M", x, y])
                coordinates.append([x, y])
            record = {}
            if flags & 2:
                record["fill0"] = reader.get(fills)
            if flags & 4:
                record["fill1"] = reader.get(fills)
            if flags & 8:
                record["line"] = reader.get(lines)
            if record:
                styles.append(record)
            continue
        straight, count = reader.get(1), reader.get(4) + 2
        if straight:
            if reader.get(1):
                dx, dy = reader.get(count, True), reader.get(count, True)
            elif reader.get(1):
                dx, dy = 0, reader.get(count, True)
            else:
                dx, dy = reader.get(count, True), 0
            x, y = x + dx, y + dy
            paths.append(["L", x, y])
            coordinates.append([x, y])
        else:
            cx, cy = x + reader.get(count, True), y + reader.get(count, True)
            x, y = cx + reader.get(count, True), cy + reader.get(count, True)
            paths.append(["Q", cx, cy, x, y])
            coordinates.extend([[cx, cy], [x, y]])
    assert all(s.get("fill0", 0) in (0, 1) and s.get("fill1", 0) in (0, 1) and s.get("line", 0) == 0 for s in styles)
    return {"paths": paths, "styleRecords": styles,
            "controlBounds": [min(v[0] for v in coordinates), min(v[1] for v in coordinates),
                              max(v[0] for v in coordinates), max(v[1] for v in coordinates)]}


def tags(data, pos):
    while pos < len(data):
        header = u16(data, pos)
        pos += 2
        code, length = header >> 6, header & 63
        if length == 63:
            length = struct.unpack_from("<I", data, pos)[0]
            pos += 4
        payload = data[pos:pos + length]
        pos += length
        yield code, payload
        if code == 0:
            return
        if code == 39:
            yield from tags(payload, 4)


reader = Bits(body)
rect_bits = reader.get(5)
for _ in range(4):
    reader.get(rect_bits, True)
start = reader.align() + 4
font = next(p for code, p in tags(body, start) if code == 75 and u16(p, 0) == 205)
flags, name_length = font[2], font[4]
name = font[5:5 + name_length].decode("utf8").rstrip("\0")
base = 5 + name_length
count = u16(font, base)
base += 2
offset_bytes = 4 if flags & 8 else 2
offsets = [int.from_bytes(font[base + i * offset_bytes:base + (i + 1) * offset_bytes], "little") for i in range(count + 1)]
code_bytes = 2 if flags & 4 else 1
codes_at = base + offsets[-1]
codes = [int.from_bytes(font[codes_at + i * code_bytes:codes_at + (i + 1) * code_bytes], "little") for i in range(count)]
glyphs = {}
for letter in "ONLIE":
    index = codes.index(ord(letter))
    glyph_data = font[base + offsets[index]:base + offsets[index + 1]]
    glyphs[letter] = {"index": index, "glyphSha256": hashlib.sha256(glyph_data).hexdigest(), **shape(glyph_data)}
result = {"sourceSha256": EXPECTED, "fontId": 205, "fontName": name,
          "bold": bool(flags & 1), "hasLayout": bool(flags & 128), "unitsPerEm": 20480,
          "glyphs": glyphs}
print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
