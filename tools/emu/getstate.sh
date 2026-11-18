#!/bin/sh
# getstate.sh out.bin  : dump current emulator state as base64 -> file
cd "$(dirname "$0")"
./c.sh 'btoa(String.fromCharCode.apply(null,EJS_emulator.gameManager.getState().subarray(0,1)))' >/dev/null
