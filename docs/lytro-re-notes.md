# Lytro Desktop (Middleware.dll) reverse engineering notes

Read from the decompiled code (Ghidra) and the preset tables inside the DLL.

## EDOF projection (ProjectEdofSlave, project_edof_multiview.cpp)
- Each ray is splatted bilinearly onto the 2x2 output pixels around where it lands, weight = aperture table value.
- Aperture table: 256x256 raster of an IAperture over lens-normalised coordinates, index = int(c * 127.5 + 127.5).
  CircularAperture weight(x, y) = 1 if x^2 + y^2 < (0.5 * value)^2 else 0 (hard edge, flat). HexAperture likewise. Aperture value for EDOF: not recovered.
- Per-ray lambda = the lens's own lambda (one depth per lens, from the lens-resolution depth map).
- Z-test: a ray counts at a pixel if rayLambda - pixelLambda < tolerance. Preset tolerance (param 0x3f50) = 2.0 (enabled by param 0x3f20 = true).
- Median "reduce" pass (flags 0x2d / 0x2e, N0 = 5, from param 0x3ec0): OFF in every preset. Edge flag 0x2c is true in 5 of 6 presets.
- Presets: six loader functions (1808e23b0, 1808f4260, 1809057b0, 180916e10, 180927c70, 180938fa0), values extracted into scratch presets.txt.

## Edge artifact reduction (FUN_180bcd480)
- Enabled (0x4058 = true in all presets). Thresholds: depth step 3, image step 0.5, second difference 0.1.
- Implemented in app/js/core/superres.js (edgeArtifactReduce), CPU path only.

## DmResampler (lens-resolution depth to output resolution)
- Per lens an 8-bit mask: bit k set when neighbour k exists and |d - d_k| < threshold (FUN_180b99750).
- Cells whose four edge-neighbour bits are all set: depth copied (nearest lens) or smoothed (FUN_180b990b0).
- Other cells: contour of the surface boundary traced through 20 points per cell (FUN_180b9e060), rasterised to a per-subpixel neighbour label (FUN_180c5cae0), subpixel takes that neighbour lens's depth.
- Image is not used. Boundaries lie on lens-cell borders, i.e. about the same as nearest-lens sampling.

## Measured on photo 7 (fence), our render vs Lytro Desktop output, mean abs error 0..255
- baseline 7.64 (after per-ray colour depth match). Lytro's recipe as decoded (per-lens depth, 2-unit z-test, flat disc, bilinear) is worse: 8.07 to 8.59.
- Larger lens-disc share raises the bright excess beside the wire; smaller share lowers it but loses detail.

## Ground truth in every library photo
- stack.lfp holds Lytro's own EDOF renders (edofWarp acceleration): seven perspective images plus edof_preview.jpg, 2022x1404 with suggestedOverscan (43, 57), and a 541x376 lambda depth map. pitchRatio (3.7429 x, 3.7337 y) is output pixels per lens pitch.
- Our render at ideal scale (0.81042 of our scale-4 grid, i.e. pitchRatio.x / (4 / rowStep) / pitch) overlays edof_preview.jpg within about 1 px and 0.1-0.3 % scale on all photos tried (zoom -483 to 477): the geometry (with our default lens correction) is not the main error. The per-photo scale differences seen against full_lytro.npy come from that capture's own crop.
- edof_preview is a cleaner target than full_lytro: no unknown crop, same pixel grid for every photo.

## Depth finishing and solver (decompiled, checked against our code)

- Smoothness weights (`FUN_1809ae5a0`): for the right and lower neighbour,
  `|dR| + 2|dG| + |dB| <= 0.2` gives weight 1.0, otherwise 0.5 (presets 0x2f40/0x2f70). Same as `trwsVolume`.
- Multiview depth uses `MRFSolverTRWS` (the `MRFSolverBP` constructor is called from another class). Slot 1 runs
  the iteration loop (10 iterations, direction alternates on odd iterations); slot 4 is the per-pixel message update:
  belief = data + four incoming messages, message = truncated-linear transform (slope = p[0x2ee0] x weight,
  cap = 6 x slope) of 0.5 x belief minus the message back. Same as `trwsVolume`.
- Finishing after the solver (presets 0x3128 and 0x30c8 are on in all six presets):
  1. `FUN_1809b3c40`: parabola through the three aggregated data costs around the chosen label,
     applied only where the second difference is positive and the shift is under one label step.
     The chosen label comes from the smoothed result; the data volume, not the belief, supplies the parabola.
  2. `FUN_1809b2120`: 3x3 median of the depth, borders untouched.
- Plane prior (`FUN_1809b0b90` RANSAC plane per superpixel + `FUN_1809b3e90` cost term) is behind 0x3860, which is
  off in every preset; it is not part of the shipped pipeline.
- Port: `bestDepth(..., dataScores)` with `DEPTH_MATCH.dataParabola` (on). Not yet scored against Lytro's depth maps.
