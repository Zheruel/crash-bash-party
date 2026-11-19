#!/bin/sh
# Big HUD digits as the game draws them: grey glyphs of the HUD atlas (t08 0731 tex009-018) modulated by a gouraud
# gradient (239,178,0) top -> (239,89,0) bottom (sampled from a native frame of the real game) -> assets/hud/bigN.png
cd "$(dirname "$0")/../assets" && mkdir -p hud
for n in 0 1 2 3 4 5 6 7 8 9; do
  t=$(printf %03d $((9 + n)))
  magick textures/0731/tex$t.png -channel RGB -fx "j<25 ? (channel(min(1,u.r*1.81), u.g*(1.35-0.68*j/24), 0)) : u" +channel hud/big$n.png
done
# ':' (tex019) for the clocks
magick textures/0731/tex019.png -channel RGB -fx "j<25 ? (channel(min(1,u.r*1.81), u.g*(1.35-0.68*j/24), 0)) : u" +channel hud/bigc.png
# Crate Crush health bar: green fill (lighter top line) and the red empty part, as sampled from native frames
magick -size 1x1 xc:'#84FB42' xc:'#73E331' xc:'#6BCB31' xc:'#5AAA29' xc:'#4A8A21' xc:'#396910' -append hud/barG.png
magick -size 1x6 xc:'#C60000' hud/barR.png
# Tank Wars mines left: the HUD strip of three (t08 0783 tex037, 32x16) cut to one / two
magick textures/0783/tex037.png -crop 11x16+0+0 +repage hud/mines1.png
magick textures/0783/tex037.png -crop 22x16+0+0 +repage hud/mines2.png
cp textures/0783/tex037.png hud/mines3.png
# Podium score strip (FUN_800b9b0c): the small digits (tex023-032) in the strip's yellow -> orange gouraud, sampled from
# a native frame: (255,194,0) top -> (255,138,0) bottom; and its additive frame colour (132,130,0)
for n in 0 1 2 3 4 5 6 7 8 9; do
  t=$(printf %03d $((23 + n)))
  magick textures/0731/tex$t.png -channel RGB -fx "j<10 ? (channel(min(1,u.r*2.1), u.g*(1.58-0.46*j/9), 0)) : u" +channel hud/sm$n.png
done
magick -size 1x1 xc:'#848200' hud/stripEdge.png
