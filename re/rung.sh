#!/bin/bash
# rung.sh <name> <overlay file>  -> out_<name>/all.c
cd "$(dirname "$0")"
export JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home
len=$(stat -f %z "../disc/dat/$2")
export OVL_END=$(printf "%x" $((0x800b32b4 + len)))
H=/opt/homebrew/opt/ghidra/libexec/support/analyzeHeadless
mkdir -p proj_$1
$H proj_$1 g -import img_$1.bin -overwrite -loader BinaryLoader -loader-baseAddr 0x80010000 -processor MIPS:LE:32:default -cspec default -preScript Setup.java -postScript DecompileAll.java out_$1 -scriptPath scripts > log_$1.txt 2>&1
echo "$1 $(grep -c '^// ====' out_$1/all.c) functions"
