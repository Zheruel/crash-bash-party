#!/bin/bash
cd "$(dirname "$0")"
printf "%s\n" "ballistix 0724.t61.bin" "polarPush 0487.t62.bin" "pogoPainter 0725.t60.bin" "crateCrush 0728.t5d.bin" "tankWars 0726.t5f.bin" "crashDash 0723.t63.bin" "ringDing 0719.t65.bin" "dragonDrop 0720.t64.bin" "malletMash 0718.t66.bin" "kegKaboom 0716.t68.bin" | xargs -P 4 -L 1 ./rung.sh
