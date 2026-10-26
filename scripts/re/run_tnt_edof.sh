#!/bin/bash
# Renders an all-in-focus picture with Lytro's own engine (Lytro Power Tools tnt.exe, run under Wine).
# usage: run_tnt_edof.sh RAW.lfp CALIBRATION_DIR OUT_PREFIX [RECIPE.json]
# A recipe is the JSON that tnt --recipe-out writes, with viewFocusSpread = 100 (all in focus); set viewSharpness2,
# viewSharpenDetail, viewLuminanceNoiseReduction and viewColorNoiseReduction to 0 to compare the reconstruction alone.
export WINEPREFIX=${WINEPREFIX:-/tmp/wp} WINEDEBUG=-all
TNT=${TNT:-lytro-power-tools/lpt/resources/bin/tnt.exe}
/usr/lib/wine/wine64 "$TNT" --lfp-in "$1" --calibration-in "$2" ${4:+--recipe-in "$4"} --image-out "$3.png" --depth-out "$3_depth.png" --depthrep png
