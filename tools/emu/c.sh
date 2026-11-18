#!/bin/sh
# c.sh <js>  : eval in emulator page
curl -s -G "localhost:${DRV_PORT:-9333}/eval" --data-urlencode "js=$1"
