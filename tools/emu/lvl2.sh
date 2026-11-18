#!/bin/sh
# lvl2.sh <dec level> : captures rules + gameplay frames
cd "$(dirname "$0")"
h=$(printf "%04X" $1)
./c.sh 'EJS_emulator.gameManager.functions.toggleFastForward(0);EJS_emulator.gameManager.functions.resetCheat();EJS_emulator.gameManager.loadState(window.S0);1' >/dev/null
sleep 1.5
./c.sh "EJS_emulator.gameManager.functions.setCheat(0,1,\"8005A648 $h\");1" >/dev/null
./pad.sh cross 1 0.3
./c.sh 'EJS_emulator.gameManager.functions.setFastForwardRatio(6);EJS_emulator.gameManager.functions.toggleFastForward(1);1' >/dev/null
sleep 9
./c.sh 'EJS_emulator.gameManager.functions.toggleFastForward(0);1' >/dev/null
sleep 0.5
curl -s "localhost:${DRV_PORT:-9333}/shot?f=lv2/R$1" >/dev/null
./pad.sh cross 1 2.0; ./pad.sh cross 1 2.0; ./pad.sh cross 1 2.0
./c.sh 'EJS_emulator.gameManager.functions.setFastForwardRatio(3);EJS_emulator.gameManager.functions.toggleFastForward(1);1' >/dev/null
sleep 6
./c.sh 'EJS_emulator.gameManager.functions.toggleFastForward(0);1' >/dev/null
curl -s "localhost:${DRV_PORT:-9333}/shot?f=lv2/G$1" >/dev/null
echo done $1
