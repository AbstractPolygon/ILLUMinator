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

## Data cost, as FUN_18088bea0 computes it (all six presets)
- Per reference view r and trial depth: for each other view v, the capped colour difference
  `min(0.2, |dR| + |dG| + |dB|)` at the bilinear sample of view v's colours (corners outside the picture add
  nothing: the sample is not renormalised, and the view still counts). No gradient or interval term (0x2c50 = 0).
- Costs are ten times the mean over the V-1 other views (0x2cb0 = 10).
- Last pass only: the pairwise visibility maps from the occlusion task. A[r][v] (1: reference pixel hidden from
  v) leaves v out and the rest is scaled by n / (n - sum A) when 0 < sum A < n; B[v][r] sampled at the shifted spot
  (1: v's own pixel hidden from the reference) adds 1.2 / (V-1) per view (0x32d8).
- A pixel whose shifted views average above 0.95 (0x2ce0) in any channel at any trial depth is blown out: all its
  costs are zeroed and it is flagged. Where largest minus smallest cost is under 0.15 (0x2d40, tool units) the
  costs are zeroed too (flag value 1 - 0.5 x range / 0.15).
- Occlusion task pair problem (FUN_180891d60): two labels per pixel, visible = 2 x hole + capped colour cost,
  hidden = 2 x (1 - hole) + 0.05 (0x3278, 0x32a8), TRWS 3 iterations, weight 1.
- Solver smoothness slope p[12000] = 0.1 in every preset (it prints in decimal, so the preset table missed it).
- Passes: pass 0 (all views as reference) and pass 1 (last); parabola on the aggregated data costs only in the last
  pass, the 3x3 median after each.

## Depth labels (FUN_180891550, FUN_1809affd0)
- Whole lambda labels from p[0x28f0] = -35 up to min(p[0x2920] = 100, floor(lens infinityLambda) + 3 (p[0x3e00], 3 in five of the six presets)),
  step p[0x2950] = 1. The stack's maxLambda is that rounded up to a multiple of four (checked on 15 photos).
- Both passes use this one label list; the fine relabelling over the found range (DEPTH_PASSES.adapt) is ours, not the tool's.

## Views the depth is measured from
- The stack's seven EDOF perspective images (perImage[].perspective) are the centre plus six points at radius 0.4 and
  angles 30, 90 ... 330 degrees. Their parallax against the stack's own depth map (63 textured patches of constant lambda,
  photo batch4-1): 1.684 output px (2022 px wide render) per lambda for a 0.4 offset, i.e. 0.451 lens pitches per lambda,
  which equals 0.0814 x offset in sensor pixels only if the offset unit is one lens pitch (13.85 px). So u, v are in lens pitches.
- View preparation (FUN_1809b02f0) builds each view with ProjectPerspective(CircularAperture(0.12), u, v, CircularAperture(1.0)).
- Ring vectors p[0x2e38], p[0x2e78] (radius, angle step) are not in the presets; the 7 views follow from the stack files.
- The app now measures the Lytro-style depth from these seven views (worker.js depthViews) instead of the 37-view disc.

## View images for the depth cost
- No smoothing: the per-image processor FUN_180b674b0 is a separable blur with sigma p[0x31b8] = 0 in every preset.
- MatchColor (FUN_1809b3700): per-channel mean and spread of every other view moved onto the reference's; statistics by
  Welford's running mean, variance divided by (N - 1), floored at 1e-6 (FUN_1809af8f0).
- The cost caps (0.2), blown-out level (0.95) and flat level (0.15) are in the units of the views as projected, so the
  app compares linear light with 1.0 at the sensor's clip level, no gamma.
- Scored on 09eba2d6 and batch4-1 against the stack's depth map: gamma 0.5 + 3x3 box + brightest-value scaling 1.86 lambda mean error,
  linear + no smoothing + clip-level scale 1.45 (share off by more than 3 lambda 12.4% to 9.3%).

## ILLUM all-in-focus (EDOF) image: what the shipped tool actually does (Middleware.dll)
Function addresses are Ghidra's image-based names. Preset column index 3 = ILLUM latest (ProductID 2, ConfigVersion 2).

### Class map
- ProjectEdofSlave (vtable 181635d70, run 180bc76d0): mode 0, the per-lens-lambda splat the app already ports.
- ProjectEdofMultiViewSlave (vtable 181636488, run 180bcf980): the same splat for up to 8 views at once.
  Orchestrator FUN_180bcecb0 (called from FUN_1809caae0); worker FUN_180bd0250 (or FUN_180bd1d60 when the lens
  has a per-ray correction image). Splits rows over a thread pool and sums per-thread buffers (class 1816364a0).
- RefocusEdofMultiViewSlave: FUN_1809cd730 = post-processing of one view (below), not the projection.

### Multi-view splat (FUN_180bd0250), per ray
- Per-lens lambda lr is read from the depth map (image 1 of the depth holder), the second image is only used by
  the depth-provider variant. Per view k with viewpoint (u_k, v_k) (param_6[k]) and offset o_k (param_7[k]):
  position = P_k + (x - lr * (u - u_k) * lensScale) * zoom, 2x2 bilinear, weight = aperture table value * bilinear weight.
- Aperture table is the same 256x256 raster of an IAperture (index = int(c * 127.5 + 127.5)) used in mode 0.
- Occlusion test per touched pixel: accept when lr - zbuf_k[pixel] < tol, tol = config +0x28; zbuf_k are per-view
  float images prepared before this pass (smaller lambda = nearer, so zbuf holds the minimum). Rays more than tol behind are dropped.
- Output is premultiplied (RGB * w, alpha = sum w). FUN_180bc3060 un-premultiplies afterwards: rgb / a when a > eps,
  otherwise a constant fill colour (holes are later filled by FUN_1809c86f0 from the lambda = 0 pinhole view).

### Perspective view without depth (FUN_1809c8340 -> FUN_180bbffc0 / FUN_180bc03c0 / FUN_180bc0910)
- Not a refocus. The projector is constructed with lambda = 0 in all four slots (the 4th register argument is 0):
  position = x * scale + offset, i.e. the view is a pinhole-like image from (u, v); u, v only shift the output origin
  (-lensScale * u * zoom * width) and move the aperture window in the table lookup.
  Aperture inner = CircularAperture(0.15 on ILLUM; 0.12 in the depth view preparation FUN_1809b02f0), outer = 1.0.
- With ILLUM master flags 0x408 = 0 (depth provider), 0x438 = 0, 0x710 = 0 the writer is FUN_180bc2750 (2x2 bilinear
  accumulate of rgb and weight into float4). 0x6b0 = 1: per-lens table FUN_180b576e0; 0x4d08 = 1: ray correction image
  (aberration correction) is added to each ray before the table lookup.

### Post filters on the projected view (FUN_1809c8c30, in order)
1. FUN_1809c8340 (pinhole) or FUN_1809c86f0 (hole fill from a precomputed projection).
2. FUN_180bc6200 when master 0x468 (b1 in all presets): type from enum 0x498, 0 = FUN_180c5ecc0 with (0x4d0, 0x500),
   1 = FUN_180c5fa10 with (0x530, 0x560, 0x590, 0x5c0).
3. FUN_180bcc0d0 filter provider, switch on enum 0x3f80: ILLUM columns 1..4 = 10, F01 = 1. When the type is 7..10 and
   there is no depth holder (+0xe8) while 0x3fb8 = b1 it falls back to enum 0x3fe8 (= 2 on ILLUM).
   Type 10 = FUN_180c651c0 (depth-aware tiled filter bank, below). Type 2 = FUN_180b9e870 (same bank, no depth).
4. FUN_180bc3060 un-premultiply, FUN_180bcd480 (master 0x4058 = b1): depth-edge correction (below),
   FUN_180bc3650 (master 0x4df8, b1 only in column 4).
5. FUN_1809bd440 colour develop (CCT matrix, Noise Ninja, tone LUT, Lab unsharp) as in grid_edof_outline.

### Depth-aware reconstruction filter (FUN_180c651c0 -> FUN_180c65f10 -> FUN_180c66710 + FUN_180c67290)
- The input image's alpha channel is replaced with the per-pixel depth (lambda). The image is cut into a tile grid
  (the 3x3 regions of the reconstruction-filter bank) with linear-ramp windows; the overlap is
  ((height * f + 1) * 0.5) px where f is the float at +0x10 of the filter context. Each tile's result is weighted by
  the product of the horizontal and vertical ramp and accumulated.
- Filter lookup FUN_180c64360(bank, tileX, tileY, lambda): the bank holds one entry per sorted lambda list value
  (24 values) and per tile; the entry is the nearest list value (ties go to the lower one when
  (lambda - L[i-1]) * 2 <= L[i] - L[i-1]). A pixel without depth (sentinel _DAT_1821f022c) uses lambda 0.
- Each entry is a sum of separable terms: pass 1 (horizontal) runs every term r over the tile, pass 2 (vertical)
  convolves the result with the term's column vector and adds it with a per-term RGB gain. Both passes are normalised
  weighted averages, sum(k * w * I) / sum(k * w), set to 0 when sum(k * w) <= 0.
- Depth range weight w: LUT[clamp(int(lambda_neighbour - (lambda_centre - off)), 0, N - 1)] with off = float at +0x58 and
  N = int at +0x54: neighbours nearer than the centre by more than off get LUT[0], so foreground does not bleed
  into background. LUT contents not yet recovered.
- Where this matters for the app: the output of the splat is blurred/noisy at the 0.5-lens-pitch aperture and the
  bank corrects it per depth and image region; the app has no equivalent, which is the likely cause of the
  fine-detail mismatch next to the denoise/sharpen differences.

### Depth-edge correction (FUN_180bcd480, master 0x4058)
- Works on the develop-pipeline colour space image with a 3-pixel border; a pixel row is processed when the depth
  difference to the next pixel exceeds t0 = master 0x42b0 (3 on ILLUM). With a = |I[x+1] - I[x]|,
  b = |I[x+2] - 2 I[x+1] + I[x]|-style second-difference sum over the four taps, the correction is applied when
  b < t1 = master 0x4310... (thresholds 0x42b0 = 3, 0x42e0 = 0.5, 0x4310 = 0.1 on ILLUM) and the step is moved by
  (I[x+1] - I[x]) * c1 - (I[x+2] - I[x-1]) * c2 on the two sides of the edge (it sharpens the colour step at depth edges
  horizontally, then vertically). Constants c1, c2 at 1816361cc/1816361c8 not yet read.
