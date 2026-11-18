#!/bin/bash
# Keep the remaster's detail but the original texture's colours (Lab: 60/40 luminance blend, original a/b, original alpha).
#   tools/hd_colorfix.sh   -> reads assets/hd-raw/**, writes assets/hd/**
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
one() {
  rel="$1"; raw="$ROOT/assets/hd-raw/$rel"; orig="$ROOT/assets/textures/$rel"; out="$ROOT/assets/hd/$rel"
  [ -f "$orig" ] || return 0
  t=$(mktemp -d)
  read W H < <(magick identify -format "%w %h" "$raw")
  magick "$orig" -alpha off -filter Lanczos -resize ${W}x${H}! -colorspace Lab -separate "$t/o_%d.png"
  magick "$raw" -alpha off -colorspace Lab -separate "$t/h_%d.png"
  magick "$t/h_0.png" "$t/o_0.png" -compose blend -define compose:args=60 -composite "$t/l.png"
  mkdir -p "$(dirname "$out")"
  magick "$t/l.png" "$t/o_1.png" "$t/o_2.png" -set colorspace Lab -combine -colorspace sRGB \( "$raw" -alpha extract \) -compose copy_opacity -composite "$out"
  rm -rf "$t"
}
export -f one; export ROOT
cd "$ROOT/assets/hd-raw" && find . -name '*.png' | sed 's|^\./||' | xargs -P "${JOBS:-12}" -I{} bash -c 'one "$@"' _ {}
