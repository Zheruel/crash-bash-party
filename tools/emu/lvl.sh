#!/bin/sh
# lvl.sh <hex4 value> <name> [wait s] [addr]
cd "$(dirname "$0")"
./c.sh 'EJS_emulator.gameManager.functions.toggleFastForward(0);EJS_emulator.gameManager.functions.resetCheat();EJS_emulator.gameManager.loadState(window.S0);1' >/dev/null
sleep 1.5
./c.sh "EJS_emulator.gameManager.functions.setCheat(0,1,\"${4:-8005A648} $1\");1" >/dev/null
./pad.sh cross 1 0.3
./c.sh 'EJS_emulator.gameManager.functions.setFastForwardRatio(6);EJS_emulator.gameManager.functions.toggleFastForward(1);1' >/dev/null
sleep ${3:-9}
./c.sh 'EJS_emulator.gameManager.functions.toggleFastForward(0);1' >/dev/null
sleep 1
curl -s "localhost:${DRV_PORT:-9333}/shot?f=$2"
