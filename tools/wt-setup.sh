#!/bin/sh
# Run from the root of a git worktree of this repo: links the untracked, heavy inputs (disc rip, ROM, decompiles, RAM dumps,
# audit index, node_modules) from the main checkout so typecheck, tests, test:disc and the emulator work without copies.
#   MAIN=/path/to/main/checkout sh tools/wt-setup.sh
set -e
MAIN=${MAIN:-/Users/tinzeljar/Documents/crash-bash}
[ "$(cd "$MAIN" && pwd)" = "$(pwd)" ] && { echo "run inside a worktree, not the main checkout"; exit 1; }
link() { [ -e "$2" ] || [ -L "$2" ] || ln -s "$1" "$2"; }
link "$MAIN/web/node_modules" web/node_modules
link "$MAIN/disc" disc
link "$MAIN/rom" rom
[ -d "$MAIN/tools/emu/node_modules" ] && link "$MAIN/tools/emu/node_modules" tools/emu/node_modules
for p in "$MAIN"/re/out_* "$MAIN"/re/img_*.bin "$MAIN"/re/dumps "$MAIN"/re/audit "$MAIN"/re/ram.bin "$MAIN"/re/out; do
  [ -e "$p" ] && link "$p" "re/$(basename "$p")"
done
for p in "$MAIN"/assets/portraits/*; do link "$p" "assets/portraits/$(basename "$p")"; done
echo "worktree linked to $MAIN"
