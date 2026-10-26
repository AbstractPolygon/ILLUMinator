#!/bin/bash
# usage: run_eslf2.sh DIR OUT : eslf for scratchpad/syn/DIR/raw.lfp
export WINEPREFIX=/tmp/wp WINEDEBUG=-all
P=$SCRATCH
cd $P/tntrun
/usr/lib/wine/wine64 /home/user/rgon/lytro-power-tools/lpt/resources/bin/tnt.exe --lfp-in $P/syn/$1/raw.lfp --calibration-in $P/cal/g --eslf-out $2.png > $2.log 2>&1
echo done > $2.done
