#!/usr/bin/env python3
"""Build the Crash Bash rules body WOFF2 from the US disc's DAT entry 0733.

    python3 tools/disc.py 'disc/Crash Bash (USA).bin' disc/files
    python3 tools/dat.py disc/files/SCUS_945.70 disc/files/CRASHBSH/CRASHBSH.DAT disc/dat
    python3 -m pip install 'fonttools[woff]'  # in a virtual environment
    python3 tools/build_rules_font.py
"""

import argparse
from pathlib import Path
from string import ascii_lowercase, ascii_uppercase, digits

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

from t08 import decode_indices, parse


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'disc/dat/0733.t08.bin'
OUTPUT = ROOT / 'web/client/ui/crash-bash-rules.woff2'
CHARACTERS = ascii_uppercase + digits + ".,!'<>%:-"
FIRST_GLYPH = 2
CELL_SIZE = 16
INK_INDEX = 2

# SCUS_945.70 initializes the secondary advance table at 0x8005AFB4
# in FUN_80023A90. Positioning uses these widths before PS1 raster rounding.
ADVANCES = {' ': 6, '.': 4, ',': 6, '!': 6, "'": 6}
DEFAULT_ADVANCE = 11

# At 16 CSS px one texel measures 1.25 x 2 px, as in the 640 x 480 reference.
# The first native row is stroke only and the comma extends below row 6.
UNITS_PER_EM = 1024
X_UNITS = 80
Y_UNITS = 128
ASCENT = 7 * Y_UNITS
DESCENT = -Y_UNITS
CAP_HEIGHT = 6 * Y_UNITS
DIRECTIONS = ((1, 0), (0, 1), (-1, 0), (0, -1))


def trace(ink):
    """Trace the union of the filled texels, preserving corners and counters."""
    boundary = set()
    for x, y in ink:
        perimeter = ((x, y, 0), (x + 1, y, 1), (x + 1, y + 1, 2), (x, y + 1, 3))
        for edge_x, edge_y, direction in perimeter:
            dx, dy = DIRECTIONS[direction]
            reverse = (edge_x + dx, edge_y + dy, (direction + 2) % 4)
            if reverse in boundary:
                boundary.remove(reverse)
            else:
                boundary.add((edge_x, edge_y, direction))

    remaining = boundary.copy()
    while remaining:
        first = edge = min(remaining)
        corners = []
        while True:
            remaining.remove(edge)
            x, y, direction = edge
            dx, dy = DIRECTIONS[direction]
            x, y = x + dx, y + dy
            # At a diagonal contact, follow the right-hand edge of this pixel.
            turns = ((direction + 1) % 4, direction, (direction - 1) % 4)
            edge = next((x, y, turn) for turn in turns if (x, y, turn) in boundary)
            if direction != edge[2]:
                corners.append((x * X_UNITS, ASCENT - y * Y_UNITS))
            if edge == first:
                break
        yield corners


def build(source, output):
    data = source.read_bytes()
    _, palettes, textures, *_ = parse(data)
    if len(textures) < FIRST_GLYPH + len(CHARACTERS):
        raise ValueError(f'{source}: missing the US rules glyph texture range')

    glyphs = {name: TTGlyphPen(None).glyph() for name in ('.notdef', 'space')}
    metrics = {'.notdef': (DEFAULT_ADVANCE * X_UNITS, 0), 'space': (ADVANCES[' '] * X_UNITS, 0)}
    mapping = {ord(' '): 'space', ord('\N{NO-BREAK SPACE}'): 'space'}
    for index, char in enumerate(CHARACTERS, start=FIRST_GLYPH):
        texture = textures[index]
        palette = palettes[texture['clut']]['data']
        if (texture['width'], texture['height'], texture['bpp']) != (CELL_SIZE, CELL_SIZE, 4) or (
            palette[:3] != (0, 0x8000, 0xC210)
        ):
            raise ValueError(f'{source}: texture {index} does not match the US rules glyph format')

        # Index 1 is the original black stroke. The font carries the solid fill.
        ink = [(i % CELL_SIZE, i // CELL_SIZE)
               for i, value in enumerate(decode_indices(data, texture)) if value == INK_INDEX]
        if not ink:
            raise ValueError(f'{source}: texture {index} has no rules glyph fill')
        pen = TTGlyphPen(None)
        for corners in trace(ink):
            pen.moveTo(corners[0])
            for corner in corners[1:]:
                pen.lineTo(corner)
            pen.closePath()

        name = f'uni{ord(char):04X}'
        glyphs[name] = pen.glyph()
        metrics[name] = (ADVANCES.get(char, DEFAULT_ADVANCE) * X_UNITS,
                         min(x for x, _ in ink) * X_UNITS)
        mapping[ord(char)] = name

    for lower, upper in zip(ascii_lowercase, ascii_uppercase):
        mapping[ord(lower)] = mapping[ord(upper)]
    mapping[ord('`')] = mapping[ord("'")]

    family = 'Crash Bash Rules'
    builder = FontBuilder(UNITS_PER_EM, isTTF=True)
    builder.setupGlyphOrder(list(glyphs))
    builder.setupCharacterMap(mapping)
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics(metrics)
    builder.setupHorizontalHeader(ascent=ASCENT, descent=DESCENT)
    builder.setupNameTable({
        'familyName': family,
        'styleName': 'Regular',
        'fullName': family,
        'psName': 'CrashBashRules-Regular',
        'uniqueFontIdentifier': 'CrashBashRules-Regular-1.0',
        'version': 'Version 1.0',
        'description': 'Vector contours from Crash Bash (USA), DAT entry 0733, textures 2–46.',
    })
    builder.setupOS2(
        version=4, fsSelection=0xC0,
        sTypoAscender=ASCENT, sTypoDescender=DESCENT, sTypoLineGap=0,
        usWinAscent=ASCENT, usWinDescent=-DESCENT,
        sCapHeight=CAP_HEIGHT, sxHeight=CAP_HEIGHT,
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
