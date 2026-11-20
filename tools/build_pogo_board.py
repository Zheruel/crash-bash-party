"""Build the versus Pogo floor atlas from USA T08 indices and the palettes selected by overlay 0725."""
from pathlib import Path

from t08 import decode_indices, parse, render, write_png

ROOT = Path(__file__).resolve().parents[1]
CELL = 64
WIDTH = CELL * 16
HEIGHT = CELL * 6


def build():
    # Each entry gives the source texture and the texture whose CLUT the game applies to it.
    layouts = {
        670: [(82 + mask, palette) for palette in (77, 74, 75, 76) for mask in range(16)] + [(82, 82)],
        674: [(60, palette) for palette in (60, 56, 53, 54, 55)],
        666: [(53, 53)] + [(78, palette) for palette in (68, 67, 65, 66)]
             + [(texture, texture) for texture in (61, 62, 63, 54, 64)],
        662: [(0, 0)] + [(texture, palette) for texture in (38, 49) for palette in (41, 38, 39, 40)],
    }
    atlas = bytearray(WIDTH * HEIGHT * 4)
    cell = 0
    for pack, entries in layouts.items():
        data = (ROOT / f'disc/dat/{pack:04d}.t08.bin').read_bytes()
        _, palettes, textures, *_ = parse(data)
        for index, palette_ref in entries:
            texture = textures[index]
            w, h = texture['width'], texture['height']
            rgba = render(decode_indices(data, texture), w, h, palettes[textures[palette_ref]['clut']])
            left, top = cell % 16 * CELL, cell // 16 * CELL
            for y in range(h):
                start = ((top + y) * WIDTH + left) * 4
                atlas[start:start + 4*w] = rgba[y*w*4:(y+1)*w*4]
            cell += 1
    write_png(ROOT / 'assets/textures/pogo-board.png', WIDTH, HEIGHT, atlas)


if __name__ == '__main__':
    build()
