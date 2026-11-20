#!/usr/bin/env python3
"""Trace the US Crash Bash menu glyphs into a vector WOFF2.

Textures 48–95 of DAT entry 0733 match the menu glyphs in emulator VRAM.

    python3 tools/disc.py 'disc/Crash Bash (USA).bin' disc/files
    python3 tools/dat.py disc/files/SCUS_945.70 disc/files/CRASHBSH/CRASHBSH.DAT disc/dat
    python3 -m pip install 'fonttools[woff]'  # in a virtual environment
    python3 tools/build_menu_font.py
"""

import argparse
from pathlib import Path
from string import ascii_lowercase, ascii_uppercase, digits

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

from t08 import decode_indices, parse


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'disc/dat/0733.t08.bin'
OUTPUT = ROOT / 'web/client/ui/crash-bash-menu.woff2'
CHARACTERS = digits + ascii_uppercase + ".,':/=+-?%<>"

# The game draws 16-texel quads, advances 16 for a glyph and 12 for a
# space. The 512x240 framebuffer is shown at 640x480 in the reference.
UNITS_PER_EM = 1024
CELL_SIZE = 16
X_UNITS = 40
Y_UNITS = 64
BASELINE = 14 * Y_UNITS
DESCENT = BASELINE - UNITS_PER_EM

# Marching squares, with corners NW, NE, SE, SW in bits 0–3. Each pair
# crosses two edges with the filled pixels on its right. A diagonal
# contact keeps the two filled corners separate.
EDGE_PAIRS = (
    (), ('NW',), ('EN',), ('EW',), ('SE',), ('NW', 'SE'), ('SN',), ('SW',),
    ('WS',), ('NS',), ('EN', 'WS'), ('ES',), ('WE',), ('NE',), ('WN',), (),
)
EDGE_OFFSETS = {'N': (2, 1), 'E': (3, 2), 'S': (2, 3), 'W': (1, 2)}
# Double the CLUT's 5-bit gray levels so a half-brightness contour
# can cross between palette entries without landing on a sample.
INK_LEVELS = (0, 0, 16, 24, 32, 8)
INK_EDGE = 15


def trace(pixels):
    """Trace the fill at the CLUT's half-brightness edge, including holes."""
    padded = [[0] * (CELL_SIZE + 2)]
    for start in range(0, len(pixels), CELL_SIZE):
        # Index 0 is transparent and index 1 is the baked black stroke.
        padded.append([0, *(INK_LEVELS[index] for index in pixels[start:start + CELL_SIZE]), 0])
    padded.append(padded[0])

    edges = {}
    for y in range(CELL_SIZE + 1):
        top, bottom = padded[y:y + 2]
        for x in range(CELL_SIZE + 1):
            corners = ((top[x] > INK_EDGE) | (top[x + 1] > INK_EDGE) << 1
                       | (bottom[x + 1] > INK_EDGE) << 2 | (bottom[x] > INK_EDGE) << 3)
            origin_x, origin_y = 2 * (x - 1), 2 * (y - 1)
            for start, end in EDGE_PAIRS[corners]:
                x1, y1 = EDGE_OFFSETS[start]
                x2, y2 = EDGE_OFFSETS[end]
                edges[origin_x + x1, origin_y + y1] = (origin_x + x2, origin_y + y2)

    def interpolate(point):
        x, y = point
        col, row = (x + 1) // 2, (y + 1) // 2
        if x % 2 == 0:
            first, second = padded[row][col:col + 2]
            x += 2 * (INK_EDGE - first) / (second - first) - 1
        else:
            first, second = padded[row][col], padded[row + 1][col]
            y += 2 * (INK_EDGE - first) / (second - first) - 1
        return round(x * X_UNITS / 2), round(BASELINE - y * Y_UNITS / 2)

    while edges:
        start = next(iter(edges))
        points = [interpolate(start)]
        point = edges.pop(start)
        while point != start:
            points.append(interpolate(point))
            point = edges.pop(point)

        # Retain turns only. All corners come from the source texels.
        contour = []
        for i, point in enumerate(points):
            a, b = points[i - 1], points[(i + 1) % len(points)]
            dx1, dy1 = point[0] - a[0], point[1] - a[1]
            dx2, dy2 = b[0] - point[0], b[1] - point[1]
            if dx1 * dy2 != dx2 * dy1:
                contour.append(point)
        yield contour


def build(source, output):
    data = source.read_bytes()
    _, palettes, textures, *_ = parse(data)
    first_glyph = 48
    if len(textures) < first_glyph + len(CHARACTERS):
        raise ValueError(f'{source}: missing the US menu glyph texture range')
    glyphs = {name: TTGlyphPen(None).glyph() for name in ('.notdef', 'space')}
    metrics = {'.notdef': (CELL_SIZE * X_UNITS, 0), 'space': (12 * X_UNITS, 0)}
    mapping = {ord(' '): 'space', ord('\N{NO-BREAK SPACE}'): 'space'}

    for index, char in enumerate(CHARACTERS, start=first_glyph):
        texture = textures[index]
        palette = palettes[texture['clut']]['data']
        if (texture['width'], texture['height'], texture['bpp']) != (CELL_SIZE, CELL_SIZE, 4) or (
            palette[:6] != (0, 0x8000, 0xA108, 0xB18C, 0xC210, 0x9084)
        ):
            raise ValueError(f'{source}: texture {index} does not match the US menu glyph format')
        pen = TTGlyphPen(None)
        left = CELL_SIZE * X_UNITS
        for points in trace(decode_indices(data, texture)):
            left = min(left, *(x for x, _ in points))
            pen.moveTo(points[0])
            for point in points[1:]:
                pen.lineTo(point)
            pen.closePath()
        name = f'uni{ord(char):04X}'
        glyphs[name] = pen.glyph()
        metrics[name] = (CELL_SIZE * X_UNITS, left)
        mapping[ord(char)] = name

    # The disc has a single case in this atlas. Alias lowercase to it so
    # HTML labels retain their original text and unsupported glyphs fall back.
    for lower, upper in zip(ascii_lowercase, ascii_uppercase):
        mapping[ord(lower)] = mapping[ord(upper)]

    family = 'Crash Bash Menu'
    builder = FontBuilder(UNITS_PER_EM, isTTF=True)
    builder.setupGlyphOrder(list(glyphs))
    builder.setupCharacterMap(mapping)
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics(metrics)
    builder.setupHorizontalHeader(ascent=BASELINE, descent=DESCENT)
    builder.setupNameTable({
        'familyName': family,
        'styleName': 'Regular',
        'fullName': family,
        'psName': 'CrashBashMenu-Regular',
        'uniqueFontIdentifier': 'CrashBashMenu-Regular-1.0',
        'version': 'Version 1.0',
        'description': 'Vector contours traced from Crash Bash (USA), DAT entry 0733, textures 48–95.',
    })
    builder.setupOS2(
        version=4, fsSelection=0xC0,
        sTypoAscender=BASELINE, sTypoDescender=DESCENT, sTypoLineGap=0,
        usWinAscent=BASELINE, usWinDescent=-DESCENT,
        sCapHeight=13 * Y_UNITS, sxHeight=13 * Y_UNITS,
    )
    builder.setupPost()
    font = builder.font
    font['head'].created = font['head'].modified = 3029529600  # 2000-01-01
    font.recalcTimestamp = False
    font.flavor = 'woff2'
    output.parent.mkdir(parents=True, exist_ok=True)
    font.save(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=SOURCE, help='extracted 0733.t08.bin')
    parser.add_argument('--output', type=Path, default=OUTPUT, help='output WOFF2 path')
    args = parser.parse_args()
    build(args.source, args.output)
    print(args.output)
