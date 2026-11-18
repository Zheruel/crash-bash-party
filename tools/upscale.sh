#!/bin/bash
# HD-remaster texture sets with gpt-image, keeping layout pixel-aligned and the original alpha mask.
#   tools/upscale.sh 0775 0777 ...      -> assets/hd/NNNN/texNNN.png (4x), originals untouched
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
G=~/.claude/skills/gpt-image/gen_image.sh
TMP="${TMPDIR:-/tmp}/upscale.$$"; mkdir -p "$TMP"
PROMPT="$TMP/p.txt"
cat > "$PROMPT" <<'P'
Use: HD remaster of a PlayStation 1 game texture tile; it is UV-mapped onto a 3D model, so geometry must not move.
Input images: Image 1: edit target (a pixelated low-res texture, nearest-neighbour enlarged).
Same image, same framing and canvas. Redraw it as a clean high-resolution texture: smooth anti-aliased edges, crisp painted detail, same colours and palette, keep small repeating details (dots, stripes, stitches). Every shape must stay in exactly the same position, size and outline as in Image 1; do not add, remove, move or restyle anything. Black areas stay pure black.
Avoid: pixelation, blur, new details, text, borders, frames.
P
one() {
  local src="$1" set="$2" name="$3"
  local out="$ROOT/assets/hd/$set/$name"
  [ -f "$out" ] && return 0
  read w h < <(magick identify -format "%w %h" "$src")
  (( w < 16 || h < 16 )) && return 0
  local r=$(( (w>h ? w*100/h : h*100/w) )); (( r > 300 )) && return 0
  local big="$TMP/$set-$name" ; local L=1024
  if (( w >= h )); then bw=$L; bh=$(( L*h/w )); else bh=$L; bw=$(( L*w/h )); fi
  magick "$src" -background black -alpha remove -filter point -resize ${bw}x${bh}! "$big"
  local res="$TMP/out-$set-$name"
  if ASPECT="$w:$h" "$G" "$res" "$PROMPT" "$big" >/dev/null 2>&1; then
    mkdir -p "$(dirname "$out")"
    local W=$((w*4)) H=$((h*4))
    # colour from the remaster, alpha from the original (nearest) so cutouts stay exact
    magick \( "$res" -resize ${W}x${H}! -alpha off \) \( "$src" -alpha extract -filter point -resize ${W}x${H}! \) -compose copy_opacity -composite "$out"
    echo "OK $set/$name"
  else echo "FAIL $set/$name"; fi
}
export -f one; export ROOT G TMP PROMPT
for set in "$@"; do
  for f in "$ROOT/assets/textures/$set"/tex*.png; do echo "$f $set $(basename "$f")"; done
done | xargs -P 8 -L 1 bash -c 'one "$0" "$1" "$2"'
rm -rf "$TMP"
