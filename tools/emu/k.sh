#!/bin/sh
# k.sh <keys> [n] [gap]
curl -s -G "localhost:${DRV_PORT:-9333}/key" --data-urlencode "k=$1" --data-urlencode "n=${2:-1}" --data-urlencode "gap=${3:-250}"
