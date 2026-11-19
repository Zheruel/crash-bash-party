#!/bin/sh
# rdm.sh <hexaddr> <nwords> : read 32-bit words from emu RAM (base heap offset 6176336)
curl -s -G "localhost:${DRV_PORT:-9371}/eval" --data-urlencode "js=(()=>{const H=EJS_emulator.Module.HEAPU8;const b=6176336+($1-0x80000000);const o=[];for(let i=0;i<${2:-1};i++)o.push((H[b+4*i]|H[b+4*i+1]<<8|H[b+4*i+2]<<16|H[b+4*i+3]<<24));return [EJS_emulator.gameManager.functions.getFrameNum(),o]})()"
