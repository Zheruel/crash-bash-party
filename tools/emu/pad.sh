#!/bin/sh
# pad.sh <cross|circle|square|tri|up|down|left|right|start|select> [n] [gapms]
case "$1" in cross) i=0;; square) i=1;; select) i=2;; start) i=3;; up) i=4;; down) i=5;; left) i=6;; right) i=7;; circle) i=8;; tri) i=9;; esac
n=${2:-1}; gap=${3:-0.5}
for k in $(seq $n); do
curl -s -G localhost:${DRV_PORT:-9333}/eval --data-urlencode "js=EJS_emulator.gameManager.functions.simulateInput(0,$i,1);1" >/dev/null
sleep 0.15
curl -s -G localhost:${DRV_PORT:-9333}/eval --data-urlencode "js=EJS_emulator.gameManager.functions.simulateInput(0,$i,0);1" >/dev/null
sleep $gap
done
