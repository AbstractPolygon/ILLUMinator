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

### Reconstruction filter bank, decoded (FUN_180bf08a0 ctor, FUN_180be3700 scale, FUN_180be3e90 SVD, FUN_180c64360 lookup)
Source data: the photo's reconstructionFilterRef PNG (8-bit RGB, 65 wide, 14040 tall = 24 lambdas x 3 x 3 tiles x 65 rows) and
its metadata JSON (targetWidth 2560, targetHeight 1778, numKernelsX/Y 3, zoomStep, focusStep, lambdas
-45,-40,-35,-30,-25,-20,-18,-16,-14,-12,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3).
- Entry index e = lambdaIndex * 9 + tile (tile = tileY * 3 + tileX; the generator indexes lambda by e / (tilesX * tilesY)).
  Entry rows start at e * 65. Each kernel pixel = PNG / 255 - 0.5 (signed, mid gray = 0), then divided by the per-channel sum of the
  65x65 entry (FUN_180826a10 is a sum, FUN_18082bfd0 a max).
- Settings come from the master params: mono flag 0x4340 (b0 on ILLUM, so green is copied into red and blue after scaling),
  sparsify threshold 0x4370 = 0.01, 0x43d0 = 0.1 (stored, role not found), rank count 0x43a0 = 1 (ILLUM), lambda scale spline from the point list
  at master 0x4408 (empty in all presets, so the scale function is unset/constant; scale factors below use it as 1).
- Scaling to the output size W x H (FUN_180bf4500): kernel scale (sx, sy) = s(lambda) * (W / targetWidth, H / targetHeight). New size =
  round-up(w * sx) forced odd. Larger than the source: bilinear resample; smaller: each source tap is splatted onto the
  new grid (FUN_18086ed80 1-D weights) and the result is divided by its alpha. Then entries with |value| <= 0.01 * (per-channel max) are zeroed
  (only when 0x4370 > 0), green copied to all three channels when mono, and FUN_180bf36e0 crops to the smallest centred
  window holding all non-zero taps.
- Rank-1 form (FUN_180bf3b90, SVD of the double-precision matrix, flags 0x28): for channel c and term r < rank,
  column vector = U[:, r], row vector = V[:, r], each divided by its own sum; gain G[r][c] = sum(row) * S[r] * sum(column) (before the divisions).
  Kernel = sum_r G[r] * column_r (x) row_r.
- Application (type 10, FUN_180c651c0): described above. Tile layout for an image W x H with 3 x 3 tiles: tile (i, j) covers
  [W*i/3, W*(i+1)/3) x [H*j/3, H*(j+1)/3) grown by m = int((H * f + 1) * 0.5) on interior sides, where f is the float at context +0x10; the
  window weight across a tile is a linear ramp (1/(n+1) steps) over the m-wide overlap on each interior side and 1 inside. Per pixel the entry is chosen
  by that pixel's depth lambda (nearest bank lambda) and the tile; horizontal pass uses the row vector, vertical pass the column vector, both as
  normalised averages with the depth-range weight. Range weight spline FUN_1809c62d0: trapezoid through (-4, 0), (-2, 1), (2, 1), (4, 0)
  in lambda difference, sampled into the LUT.
- Result accumulates out += G[r][c] * (vertical result) * tileWindow, with alpha channel 1.

## Lytro's own engine is available: Power Tools `tnt` (symbols, and it runs)
Source: github.com/rgon/lytro-power-tools (`lpt/resources/bin/tnt` Mach-O, `tnt.exe` PE). It is the LFE ("TNT 2.0, LFE 21") command-line engine.
- The Mach-O build keeps its full symbol table (25k names: `LFE::RefocusEdof`, `ProjectEdofMultiView`, `GridFilterImage1DDepthMasked`,
  `JointAdaptiveFilter`, `EdgeArtifactReduction`, ...). Import it in Ghidra to read the real names.
- `tnt.exe` runs under Wine (apt `wine64`): `tnt.exe --lfp-in raw.lfp --calibration-in <dir with unitdata/> --recipe-in rec.json --image-out out.png
  --depth-out d.png --depthrep png` takes about 45 s per photo. `--recipe-out` writes the default recipe; `viewFocusSpread = 100` gives the
  all-in-focus picture. `scripts/re/run_tnt_edof.sh` wraps it; `scripts/re/score_gt.py` scores an app render against it (registered MAE, fitted MAE,
  gradient ratio).

### RefocusEdof pipeline as named in the engine (RefocusEdof::operator())
ComputeOutputDepthMap (forward-warps the depth to the output grid keeping the nearer value, then medianFilterDepthMap) -> createDepthEdgeMap
(tolerance cfg 0x1f10) -> ProjectEdof / ProjectEdofMultiView::projection (up to 8 views) -> computeFilterBank + computeFilterIndexMap ->
reconstructProjectedImage: [disocclusionFilling | reconstructionHoleFilling (iterative 4-neighbour average of the filled neighbours, in
raster order, alpha <= 0 marks a hole) | InpaintImage (pyramid)] -> JointAdaptiveFilter (AdaptiveFilterMethod 7..10 = grid filter bank:
2D, 2D depth masked, separable 1D, separable 1D depth masked) -> InpaintImage + NormalizeImage (rgb / alpha) -> EdgeArtifactReduction ->
CorrectChromaticAberration -> setVariablySharpenImage / setUSMImage (per-lambda unsharp mask) -> finalImagePipeline.
- computeFilterIndexMap: index = clamp(int((lambda + L) / 0.25 + 0.5), 0, 2L / 0.25) with L = cfg 0x2c88 (kLambdaStep = 0.25, occlusion value counts as 0).
- GridFilterImage1DDepthMasked (horizontal and vertical pass): out = sum(w * k * c) / sum(w * k) with w the depth-range LUT, 0 when the
  sum is not positive, depth taken from the fourth channel. The kernel gain therefore cancels. Multiplying by the rank-1 gain made our port
  about 35 % too dark (MAE 30.4 against the engine); without it 8.4.

### Scores against the engine (photo b4-1, sharpening and noise reduction off in the engine)
app EDOF (B0): MAE 4.62, gradient ratio 1.03. lytroEdof port (L2): MAE 7.61, gradient ratio 0.64 (too soft). The B0 error is on the near thin
fence and the frame edges (the halo region).

### Depth algorithm as named in the engine (DepthMapAlgorithmSimple, tnt Mach-O)
Why it matters: the engine's depth map has crisp fence edges, ours is blurred and streaks along them (that is where the EDOF halos come from;
see `scripts/re/score_gt.py` and the engine's `--depth-out` for any photo).
computeDepthmap order: createDataCostVolume (DepthMapCreateDataCostSimpleSubset over sub-aperture images) -> ConfidenceByDataCostAnalysis (flag 0xd8)
-> AdjustImportanceByImageContent (0xc0) -> Optimization = MRF solver chosen by int at +0x48: 0 TRW-S (MRFSolverTRWS), 1 BP-M, 2 hierarchical BP
(MRFSolverHBP), with smoothness weights from BuildEdgeAdaptiveSmoothnessCost(image, ...) -> optional PlaneFitting (flag 0xa2: mean-shift segmentation
SegmentImageMeanShift, DepthMapPlaneFitting per segment, UpdateDataCostByFittingError) and a second Optimization -> CrossBasedDataCostAggregation
(unless 0x6d) -> SubPixelEstimate -> MedianFilter (0xa0) -> DecreaseDepthEdgeImportance (0xc1). Output depth is resampled with DmResampler
(boundary chains / line segments, LineIsectSubpixEvaluator) and RefocusEdof::scaleAndWarpDepthMap / BackProjectDepthMap::UpscaleMaps.
computeEnergyFunction = sum data[label] + sum over 4-neighbour pairs of min(|label_i - label_j| * s, T) * edgeWeight, with T = p[0x23] * s
(truncated linear smoothness). Config offsets (+0x48 solver, +0x58, +0x5c iterations, +0x94 edge-adaptive flag, +0x98/+0x9c edge params) still to be matched
with the preset values. Next: read BuildEdgeAdaptiveSmoothnessCost, the cost volume (DepthMapCreateDataCostSimpleSubset::Run), the MRF solvers and
the plane fitting, implement in the worker, and score the depth against `tnt --depth-out`.

### ILLUM depth settings (tnt `GetBlitzenVersion1Configuration` = `FUN 1004e2bf0`; V1_1 only adds the sub-aperture vectors [0.25] and [45])
Member <- config value of DepthMapAlgorithmSimple (member byte offset): +0x00 min lambda -35; +0x04 100; +0x08 label step 1.0 (SubPixelEstimate argument);
+0x0c 1.0; +0x48 MRF solver 0 = TRW-S, +0x50 2.0, +0x54 10.0, +0x58 TRW-S flag true, +0x5c iterations 10, +0x60 0.5, +0x64 0.15, +0x68 0.95;
cross-based aggregation (CrossBasedDataCostAggregation) parameters +0x70 0.04, +0x74 0.025, +0x78 34, +0x7c 17, +0x80 4, +0x84 1.0, +0x88 1.5 (arm lengths 34 and 17);
MRF smoothness: +0x8c = 6.0 (truncation in label steps) and +0x90 = 0.1 (slope per label step) so a pair costs min(|dl| * 0.1, 0.6) * edgeWeight;
+0x94 edge-adaptive smoothness on, +0x98 colour threshold 0.2, +0x9c edge weight 0.5 (BuildEdgeAdaptiveSmoothnessCost: weight = 1 where
|dR| + 2|dG| + |dB| <= 0.2 between the two pixels, else 0.5, one weight image for horizontal and one for vertical pairs); +0xa0 median filter on.
Config rows still to read: plane fitting (+0xa4, +0xa8, +0xac, +0xb0, +0xb4, +0xb8, +0xbc) and the cost volume (DepthMapCreateDataCostSimpleSubset::Run).

### Where the app and the engine differ (measured against `tnt`, photo b4-1, sharpening and noise reduction off)
- The depth the app really uses there is Lytro Desktop's own (from stack.lfp): mean difference from the engine's own depth map is 1.2 lambda; fence edges are
  smoother and a little thicker in the app, and the engine's are jagged (the engine does not smooth them).
- Local shift between the app's render and the engine's, regressed on the engine's depth: dx = -0.097 px/lambda * lambda - 0.33 px (dy slope -0.018): the
  app's reference viewpoint is offset from the engine's, so near objects (the fence wire) land 1-3 px away. Largest error region of the photo.
- The photo metadata carries `lens.opticalCenterOffset` (x -2.5e-5 m, y -4.8e-5 m = -18 px, -34 px at the 1.4 um pitch), `lens.exitPupilOffset.z`, `lens.infinityLambda`,
  `focalLength`, `zoomStep`, `focusStep`. The app reads only infinityLambda. The engine builds its disc geometry from them:
  `HexMicrolensArrayModel::DiskCenter(i, j, MainLensModel, SensorModel, scale)` = lattice centre, rotated by the MLA rotation, with the pitch scaled by
  (exitPupil + mlaZ / c) / exitPupil, and the sensor offset added; `HexDiskArrayModel(CameraModel)` fills the lattice basis from it.
- My `lytroEdof` port (filter bank, hole fill) is not better than the app's EDOF: MAE 7.6 and gradient ratio 0.64 against 4.6 and 1.03, with colour fringes.

### Geometry correction table (photo section `geometryCorrectionRef`), decoded (LFE::GeometryErrorTable)
Layout, little endian: magic 0xAF0880FA, version 2, 15, 0, byte size, width, height (60 x 60 on this camera), then height rows of width (u, v) floats from byte 28.
CorrectLightfieldPoint: cell = (floor(w * (x + 0.5) + 0.5), floor(h * (y + 0.5) + 0.5)) clamped (nearest, no interpolation) for the lens's normalized
sensor place; the cell's (u, v) is subtracted from the ray's direction (lens pitches, lens-array axes) before the projection. The field on b4-1 runs
u -0.21..0.16, v -0.12..0.12 with mean (-0.0186, -0.0063): a viewpoint shift of the whole picture that the app's own per-lens offsets drop
(`whiteOffsets` subtracts the mean; the picture-fitted offsets are relative too), so near objects were 1-3 px off the engine's. `core/geometrytable.js` applies it.
Tested and refuted as the cause of the near-object shift: applying the table as a disc-centre shift (u -= table * pitch) made b4-1 worse against the engine (MAE 4.62 -> 4.96).
`HexLightfieldGeometry::DiskCenter(i, j, applyError)` adds the table value (rotated by the MLA rotation) to the model's disc centre, which is what the
app's image-fitted lens centres already contain, so applying it again double counts. Kept behind `globalThis.__useGeo`. The depth-proportional shift between the
app and the engine (about -0.097 px per lambda in x, -0.018 in y on b4-1) is therefore still unexplained; next: the engine's ray-to-image mapping
(`HexLightfieldGeometry::Project`, `Trace`, `SensorAlignedRefocusingEquationRatios`).

### Engine demosaic (StandardizeLightfield::commonPipeline -> ProcessRawImage -> DemosaicImageLF)
- ProcessRawImage(RawInfo, bool): the bool is cfg 0x1478 (default true, never overridden in the presets read so far). True = DemosaicImageLF::processImage
  on the whole sensor image (HexLightfield::Img), false = DemosaicImageAHD (DemosaicOneTile). The sensor is demosaiced before any ray is taken.
- processImage = processBorder (all pixels outside [4, W-4) x [4, H-4)) + Process (the interior, line by line through a 9 row ring buffer:
  initializeLine, interpolateGofBRLine, interpolateRBofBRLine, interpolateRBofGLine, processBufferBorder). The scalar `*_Gold<float>` functions
  compute the same thing pass by pass; constants verified identical in the SSE Line versions. Flags +0x120 (clamp >= 0) and +0x121 (median filter
  of colour differences) are 0 in the constructor, margin (+0x124) = 4, shift (+0x128) = 4.
- processBorder: 3x3 neighbourhood (clamped to the image) mean per colour; a green site keeps its raw value for G.
- init: zeros with alpha 1, raw value in its own channel; at green sites the channel of the horizontal neighbours' colour = mean of x-1, x+1, the other
  = mean of y-1, y+1 (raw).
- G at red/blue sites: 12 directions (h1 = -1 0 1 0 -2 -1 1 2 2 1 -1 -2, v1 = 0 -1 0 1 -1 -2 -2 -1 1 2 2 1, scale S = 1 x4, 0.5 x8):
  d_k = (|c - raw(x+2h, y+2v)| + |raw(x+h, y+v) - raw(x-h, y-v)|) * S_k; idx_k = trunc(clamp(d_k * (192 / sum d) - 1, 0, 64)) (idx 0 when sum = 0);
  w_k = EXPFLUT[idx_k] (65 floats at 0x100a0e6e0, first 0.9602, last 1e-5); G = c + sum w_k (raw_G(x+h, y+v) - X(x+h, y+v)) / sum w_k where X is the
  green site's initialised value of c's own colour.
- red at blue / blue at red sites: 4 diagonals (h2 = -1 1 1 -1, v2 = -1 -1 1 1), no S, scale 64: X = G - sum w (G(nb) - raw(nb)) / sum w.
- red and blue at green sites: the 12 directions again with the G scheme (scale 192): R = g - sum w (G(nb) - R(nb)) / sum w, B likewise.
- Ported in app/js/core/lfdemosaic.js (banded, window rows y0-5..y1+5; independent of the band size). Not ported yet: HotPixelCorrectionImage,
  SaturationState / SaturationRecoveryDiffusion and the ColorMosaic gain that run before it in commonPipeline.

### Standardized lightfield (what the engine's EDOF actually consumes), measured with `tnt --eslf-out` and synthetic raw files
Method (scripts/re): `tnt.exe --lfp-in x.lfp --calibration-in cal --eslf-out out.png` writes the standardized light field as a 16 bit RGBA PNG
(`png16.c` decodes it; 7574 x 5264 for the ILLUM = 541 x 376 tiles of 14 x 14). `patchraw.mjs` overwrites the raw section of an LFP in place (no hash
check) with a synthetic pattern (constant, x ramp, y ramp, level stripes) so the engine's response can be identified directly.
- Layout: `outputExternalStandardizedLightfield` = `LoadRAWLightfield` (Raw::Decode, StandardizeLightfield::operator()<Color1>, commonPipeline) then
  `project4d`: every pixel of the standardized image is scattered with 4D bilinear weights (tile coordinates of the lens centre `HexLightfieldGeometry::Project`
  normalised by the image size x (541, 376), pixel coordinates of its normalised (u, v) x 14) times the hex aperture, accumulated with its weight in the
  alpha channel and divided (alpha above 0.25 becomes 1, else 0: the corner holes). So the eslf tile mixes up to four hex lenses; it is not a lens image.
- Effective ILLUM configuration = `InitializeScalarParametersBlitzenVersion1_1` (1004e2bf0): `scripts/re/cfgparse.py` extracts offset -> value from the
  decompile (376 scalars). In commonPipeline: HotPixelCorrection on (0xa18, threshold 1.2), LF demosaic on (0x1478), ToneMap::Analyze always but Apply off
  (0x1240 = 0), black level 64 from the LUT path off (0x40 on with an empty LUT -> RawInfo black), SaturationState threshold 0.98 (0xfd8).
- Value response (G, constant raw 64..1023): linear above black 63..64 (slope 1/959 of the 16 bit range times about 0.855), then steeper above raw 600
  (x1.8 per count at 800..950: highlight handling), clipped at 57000. Flat-field gain is a smooth bowl per lens (about 21000 at the centre of a 14 x 14 tile
  to 60000 at the rim for a raw level of 500), not flat: the calibration modulation is divided out before the standardization.
- Geometry: the tile (I, J) centre holds the source ray whose position xi_src (centre-based, units of image width/height, -0.5..0.5) satisfies
  `xi_std = xi_src + dxy_norm(xi_src)` with xi_std = (I + 0.5) / 541 - 0.5 (eta likewise with 376) and dxy_norm the app's normalized ray warp table
  (`parseRayWarp(...).at(x, y, 0, 0)`, scale 0.9687, i.e. the table scaled to fill the frame). kappa = 1.0000; the residual over the whole picture is about
  -0.9 px (x) and -0.8 px (y) with 1 px noise, so the app's position mapping through the table is right to a pixel at u = v = 0. The radial displacement of
  the table (up to 350 px at the edges, 50 px at mid radius) is what makes the tile spacing in the sensor 13.3 px at I = 100 and 15.0 px at the centre.
- Still open: the (du, dv) part of the standardization (in-tile slope 0.85 .. 0.95 against 1.02), the exact interpolation filter, the hot pixel / saturation /
  highlight stages, the calibration flat-field, and the Catmull-Rom ScaleImage (separable, 1024 sample LUT, kernel widened by the scale) at the end of
  commonPipeline.

## Ray table applied per ray at projection (engine) and the port

- The engine never warps the finished picture. The camera's ray-warp table (dx, dy: fractions of the picture, du, dv: lens pitches) is attached to the standardized lightfield and applied to every ray when it is projected: corrected = coords + table.
- `HexLightfieldGeometry::Project`: P = origin + R(theta) * p * (i + j/2 - lambda*u, (sqrt(3)/2)*j - lambda*v) / ImageSize - 0.5. A lambda shift is exactly 1.0 px per px of offset, so the exact conversion is alpha = lambda / rowStep (0.080819), not the fitted 0.0814.
- The standardized image is the processed sensor image scaled (Catmull-Rom ScaleImage) by 14/pitch to 7574 x 5264; lens pitch is about 14 std px.
- ILLUM effective config: ProductID 2, ConfigVersion 1 -> GetBlitzenVersion1_1Configuration; ToneMap::Apply is off.
- Port: `lytroSplat({ rayWarp })` takes the table evaluator (`parseRayWarp(..., { tilt: false })`), corrects each ray's lens position and direction, and skips the post-hoc lens warp. `__lytro.noTable` turns it off.

## Saturation recovery and the EDOF aperture (Mach-O `tnt`), ported in lytroedof.js
- `SaturationState::Init`: mask = mosaic value > cfg 0xfd8 (0.98 on ILLUM). `SaturationRecoveryDiffusion` (ILLUM config mode 1, run on the Color1<float> mosaic
  before ProcessRawImage; mode 0 would run it after the demosaic): 20 in-place raster sweeps over x, y = 2 .. size-3; a masked pixel becomes
  max(own, mean of 4 same-colour neighbours) with the diagonals at green sites and the pixels two away (up, down, left, right) at red and blue (weight 0.25).
  The optional clamp to the Color4 limits is off (cfg 0x1068 = 0). Our port: saturated pixels keep their gained value and are diffused (`diffuseSaturation`).
- The EDOF aperture is `HexAperture(value, rotation, mlaAligned)` with value = `LightfieldLogic::NominalApertureFraction` =
  min(clamp(FNumberMicrolens / f), clamp(2 - FNumberMicrolens / f - K / DiskMaxPitch)), K = 2.0 for ILLUM (ProductID 2). On the 14 px standardized
  lightfield that is 1 - 2/14 = 0.857 when the f-numbers match. The shape is a hexagon, flat sides at |u| = 0.5 * value (lens pitches, row direction), corners
  on the v axis: inside if (|u| <= s and |v| <= s/sqrt3) or (|v| <= 2s/sqrt3 and |u| <= s and |v| + |u|/sqrt3 <= 2s/sqrt3), s = 0.5 * value.
  The earlier port used a full circle of radius 0.5 pitch. Against the engine on b4-1 (engine depth with exact lambda): MAE 7.26 -> 6.59, gradient ratio 0.70 -> 0.73.
- Still unread: the main lens f-number argument of LightfieldLogic (a metadata value), so 0.857 assumes micro f-number = main f-number.
- Scored against the engine on b4-1: the per-photo reading of NominalApertureFraction (micro f-number = sensorOffset.z / lensPitch = 1.85, main f-number 2.05 -> 0.9025) gives MAE 6.85,
  the fixed 1 - 2/14 = 0.857 gives 6.59, so the app keeps 0.857 and `nominalAperture(cam)` stays unused until the f-number inputs are read correctly (the micro f-number
  at +0x24 of HexMicrolensArrayModel and the `a` argument of LightfieldLogic are metadata-derived; one of them, or DiskMaxPitch, differs from my reading).
- HotPixelCorrectionImage::SimpleCorrection (ported in `correctedPlane`): for each listed hot pixel, est = 0.5 * (sum of the two same-colour neighbours along the axis with the smaller
  |far difference| + |near difference|); the pixel is replaced when 1.2 * est < value (cfg 0xa30) or value > 0.99. No measurable change on b4-1 (6.59 both).

## The engine's reconstruction filters (RefocusEdof::computeReconstructionFilterBank), ported as `buildEngineBank`
- For every lambda step (kLambdaStep 0.25) and each axis: `LightfieldLogic::ReconstructionFilter(config, size, aperture, lambda, 1.0, subsampling 0, axis)`.
  It takes the descriptor list at config 0x4b0 (scale >= 0.5; the list at 0x4d8 is for the subsampled case): 27 `SpecifiedBandsFilterDescriptor`s from
  `InitializeFilterDescriptorsBlitzenVersion1_1`, thresholds -34 -30 -28 -27 -21 -19 -17 -13 -10 -8 -6 -3 -2 -1 0 1 2.05 2.5 3.5 4 6 8.61 10 15 18 21 30, each with a magnitude
  response hm (x) and vm (y) at 17 frequencies hf, vf (multiples of 64.75 cycles per picture width, designed for a 2072 px picture); tables in `app/js/core/lytrofilters.js`.
  The filter at lambda is the lower descriptor (last threshold <= lambda) and the upper one (first threshold >= lambda) blended w * lower + (1 - w) * upper with
  w = |lambda - upper| / (|lambda - lower| + |lambda - upper|); a single descriptor outside the range or on a threshold.
- `SpecifiedBandsFilter::DesignFilter`: N = 2^ceil(log2(cell)) + 1 taps, cell = max over axes of (|lambda| + disk pitch) / (standardized image size / output size), disk pitch 14.
  Magnitude points (hf / size, hm) while hf <= size / 2, linear between, 0 outside; M = 2^ceil(log2 N) + 1 samples at f = i / (M - 1) / 2 with the linear phase
  exp(i 2 pi f * trunc((1 - N) / 2)), Hermitian mirror to 2M - 2 points, inverse DFT (+ angle, 1 / n), tap k (centre N / 2) = the real part at k. No window, no normalisation
  (the depth masked passes divide by the weighted kernel sum).
- Against the engine on b4-1 (engine depth): MAE 6.58 with these kernels, 6.59 with the photo's own 8 bit kernel bank, so the two agree and the remaining softness is elsewhere.

## EDOF reconstruction as the engine runs it (RefocusEdof::reconstructProjectedImage), ILLUM config; what the port now does
- Order: ProjectEdof (premultiplied splat, per-ray lambda from BackProjectDepthMap::RayTraceDepthMap) -> disocclusionFilling (a no-op for the centre view) ->
  InpaintImage::Apply (cfg 0x258 = 1, InpaintMethod 1 = DiffusionInterpolateImage = MultilevelDiffuse) -> JointAdaptiveFilter method 10 (GridFilterImage1DDepthMasked,
  separable, input already normalised, output alpha 1; so no NormalizeImage after it) -> EdgeArtifactReduction (cfg 0x1fc8) -> cfg 0x26d8 stage.
- DiffusionInterpolateImage (cfg 0x2c0 = 1, 0x2d8 = 0.99, 0x2f0 = 1000, 0x308 = 3 sweeps): every pixel with alpha >= 0.99 is scaled to colour * 1000 / alpha with weight
  1000, the others stay as they are (x 1.0); then MultilevelDiffuse (Downsample = 3 x 3 binomial 1 2 1 / 4, skipping missing samples; RelaxRedBlack = (A + sum of the 4 B
  neighbours) / summed alpha, 3 sweeps per level; levels while a side >= 20, at most 10). The port had weight 1 for data (it smoothed the data itself); with 0.99 / 1000
  the MAE against the engine on b4-1 went 6.58 -> 5.95, the gradient ratio 0.735 -> 0.876 and the edge rise in the focal region 5.8 -> 4.2 px (engine 3.0).
- RayTraceRegion (BackProjectDepthMap, method 1 from cfg 0x1a00): per std pixel ray, Project at lambda 0, optional GeometryErrorTable (cfg 0x380) and ray warp table (0x2660),
  walks lambda from the min filtered depth to max + 1 in steps of 1 reading the depth map at the nearest texel, tolerances 1.0 and 2.0 (cfg 0x1a40, 0x1a58), min/max maps on
  (0x1a70). The depth map is first upscaled x5 (cfg 0x1ab8) with DmResampler (edge preserving, cfg 0x1aa0 on): not ported.
- HexLightfield disk model (HexMicrolensArrayModel::DiskPitch / DiskCenter, ported as `engineGrid`): disk pitch = lens pitch * (exit pupil[mm] + sensor offset z[um] / 1000) /
  exit pupil = 14.2899 px on b4-1 (the metadata's lens pitch / pixel pitch is 14.2857), so the lattices drift 2 px apart at the picture edge. Using it (E8) did not
  improve the score, so the app keeps its own lattice until the geometry is verified against the engine's tiles.
- Splat: ProjectGold: every std pixel p with confidence > 0: weight = aperture(u, v) times the bilinear weights of OutputPoint - 0.5; rgba * weight accumulates (alpha = sum).
- Not applied for the engine's picture (sharpening off): the per-lambda unsharp mask (cfg 0x5d8, amounts vs lambda and gain, `SmoothlyVaryingUnsharpMaskImage`) is only
  applied when the recipe's own sharpening is on (finalImagePipeline needs the recipe's USM amount > 0); `SharpenFilter` bank (cfg 0x100 = 0) is off.

## Ray range window, table post-processing, aperture (session notes, b4-1 against the engine with its own depth)
- `AberrationCorrectionCompact::Deserialize` runs RemoveChiefRayAngle (cfg 0x2690 off), ScaleSpatialCoordinate (0x26a8 on) and OffsetFocusPlane only when 0x26c0 is on (it is off on ILLUM), so the
  table keeps its defocus term. RemoveChiefRayAngle: at every (x, y) node the (du, dv) of the u = v = 0 ray (nearest in x, y, bilinear in u, v) is subtracted from all nodes there.
  Ported as `parseRayWarp(..., { chief: true })`; no change in the score (5.96 -> 5.96).
- The splat result does not depend on the table's u term (the ray meets the surface where it meets it): table u scale 0, 0.2 and 1 all score 5.96..5.99; only a wrong scale (3) hurts (11.4).
- `BackProjectDepthMap::ComputeMinMaxDepthMap`: the lambda range a ray is traced through is the min / max of the depth map in a window of radius ceil(L*0.5+0.5) lenses across and
  ceil(L/sqrt3+0.5) down (L = largest |lambda|, 35 on b4-1, depth pixel = one lens), built by passes with strides 1, 2, 4, ... so the radius is 1, 3, 7, 15, ... The port used 1 texel.
  Window sweep: 1 5.96, 2 5.85, 3 5.58, 4 5.32, 6 5.05, 8 5.00, 12 4.99. Now `minMaxRadius` (MAE 4.99, edge rise at lambda -10..-5 9.3 -> 6.2 px, engine 4.75).
- RayTraceRegion also needs far > lambda for the interpolation branch (ported, no change) and reads an importance map (the depth state's, upscaled): rays whose hit texel has importance 0 are dropped
  (ProjectGold needs confidence > 0). The importance map is not ported; the engine does not output it.
- The `--eslf-out` picture is the project4d regrid of the standardized lightfield, not the lightfield itself, so its in-tile slopes (0.5 .. 0.95) say nothing about ray geometry. Stop using them.
- Still unexplained: a smaller aperture scores better than the nominal 0.857 even after the window fix (0.45: 4.06, 0.6: 4.18, 0.75: 4.50, 0.857: 4.99). Outer rays also come out 12..20 % too bright at r > 0.4 pitch
  against the engine's calibrated flat field (radial mean over the central tiles), so the app's vignetting estimate is the next suspect, with the importance map. Error is now concentrated along the near fence wire.

## Flat field, aperture, edge reduction (b4-1 against the engine, engine depth)
- The engine's flat field is the camera's white image stored inside every `raw.lfp` (`modulationDataRef`, 7728 x 5368 10 bit, plus `modulationDataMetadataRef`), not something it derives from the picture. A constant raw
  image gives the same bowl at raw levels 300 and 800, so the table is a fixed multiplicative model: the engine's gain at a lens's centre is 1 and rises to about 2.9 at the rim. `DemodulationAlgorithm4DDerived`
  builds a 4D table (position x direction, smoothed over the two direction axes by `filterDimensions3And4`) from that image; the port divides every pixel by its own modulation relative to the same colour at the lens centre
  (`correctedPlane(..., modulation)`, read by `decode.js` as `readModulation`). Radial mean of the rays over the central lenses now matches the engine's to 1 %; MAE 4.99 -> 4.52. The app's own estimate
  (`estimateVignetting`) was 20 % too bright at the rim.
- `ApplyReweighting` sets each standardized pixel's alpha to table^cfg 0x2470 (2.0) with the colour left demodulated (AssignInfluence is called with premultiply = false), so every ray counts equally in the numerator.
- cfg 0x1b18 = 0.7 is the importance factor of `DecreaseDepthEdgeImportance`; importance is never zero, so the `confidence > 0` test of ProjectGold does not drop rays here.
- Aperture: the nominal fraction from the metadata (0.9025) scores worse against the engine than a smaller hexagon (0.5: 3.93, 0.7: 4.09, 0.857: 4.52, 0.9025: 4.77). The port uses 0.5, the value measured against the engine.
- EdgeArtifactReduction (cfg 0x1fc8) now runs after the filter bank in the EDOF path (no change in score).
- Depth edges: dilating near objects by one depth pixel scores 3.78 against 3.87 (nearest depth). Most remaining error (14 % of pixels beside depth steps, MAE about 10) is a haze in the disoccluded band beside the near wire.
- Spectrum in near-focus flat areas: ours / engine amplitude 1.0, 0.98, 0.91, 0.84, 0.79, 0.75, 0.72 at 2, 4, 6, 8, 10, 12, 16 cycles per 64 px with the bank, 0.92..1.0 without; raising the bank's frequencies by 1.5 flattens it
  (hook `globalThis.__bankFS`); MAE unchanged.

## Test method correction (b4-1)
- The engine's own float depth (`tnt --lfp-out`, 541 x 376) must go through the app's lens-lattice mapping (`stackDepth`, rows of lenses are offset by half a lens). A plain image resize (`DOVER`
  files, used for most sweeps above) puts every second row half a lens off, which made the hazy, dotted band beside near objects. With the proper mapping (photo dir `b4-1e` = b4-1 with the engine's
  stack.lfp) the band is gone and the picture matches the engine's at the wire edges. Sweeps repeated with it: aperture 0.3 / 0.4 / 0.45 / 0.5 / 0.6 / 0.7 / 0.857 -> MAE 3.93 / 3.92 / 3.94 / 3.98 / 4.09 / 4.28 / 4.74.
  The lambda-dependent registration error against the engine is 0.005 px per lambda (dx), 0.002 (dy).
- Highlight response of the engine (constant raw stripes, white balanced output at a lens centre): linear (G slope 48.7 / raw count, R 1.31 x, B 1.39 x) up to raw 800, then R and B stop near 47 .. 48.5 k while G is
  raised by about 0.28 x what they lost, all three equal at raw 950 (48470) and 1000 (51518), 65535 at 1023. Not ported; it is the likely cause of the purple line on the bright wire's edge.
- Engine bank response relative to our unfiltered splat in near-focus flat areas (amplitude): 0.99 1.02 1.06 1.10 1.09 1.04 0.92 0.79 0.61 0.52 at 2 .. 28 cycles per 64 px; ours 1.01 1.0 0.97 0.92 0.86 0.78 0.66 0.63 0.52 0.46.
  The engine's has a mid-band bump, ours only rolls off.
- Current score with the engine's depth: MAE 3.92 (registered), 3.75 with a per-channel linear fit; with Lytro Desktop's stack depth 4.00. Most of what is left is the thin edges of the near wire and mid-band sharpness.

## SharpenRecoverHighlights (sensor-level luma boost)

ILLUM config enables it (0x11d8) with SaturationRecoveryType = 2 (the default, so the raw/post diffusion modes 0/1
are not used; the diffusion we ported is a near no-op). `SharpenRecoverHighlightsYCbCr` smooths the luma with a
FirstOrderIirFilterImage (c = cfg 0x1490 = 0.7, forward and backward along rows then columns) and sets
`Y' = low + (Y - low) * (1 + 0.25)` (amount cfg 0x14a8). The boost fades with the weight B3(2Y) (cubic B-spline
scaled to 1 at 0, zero from Y = 1); where the weight is gone only positive differences pass (clip cfg 0x14c0 = 0).
It runs on the demosaiced sensor image before the rays are traced. Ported as `SPLAT.sharpen`; on b4-1e MAE 3.92 -> 3.52,
gradient ratio 0.94 -> 1.01. amount 1.0 gives 5.44, c 0.5 / 0.85 give 3.63 / 3.55, so 0.25 / 0.7 is the optimum.

### Bank check after the sharpen stage (b4-1e)

Engine-designed bank 3.52 MAE, the photo's embedded PNG bank 3.50, designed bank with frequencies x0.8 / x1.25: 3.51 / 3.57.
The bank is not the bottleneck any more. Spectrum ratio vs the engine in focus (lambda -5..3) is 0.87-0.95 at mid band and
1.07-1.24 near Nyquist for both banks. The remaining error is spread over the picture (worst 10% of 64 px blocks hold 26%),
with ours slightly darker in the 100-200 level range.

## The engine path on the GPU (app/js/gpu/lytroengine.js)

CPU profile of the engine path (b4-1e, scale 3): the demosaic was 31% of the run, the corrected plane, plane completion and
luma boost another ~10%, the ray march only 2%. Those sensor-side stages now run on the GPU in bands of 256 rows with an
80 row overlap (demosaic 6 rows, luma smoothing 64): the corrected plane with the embedded flat field and hot pixel rule,
the three demosaic passes of DemosaicImageLF, the luma smoothing as 28 recursive-doubling passes (exact up to 0.7^64), and
the ray splat as one point per sensor pixel (hex aperture, ray table, RayTraceRegion march, 2x2 bilinear footprint with the
per-pixel depth tolerance in the fragment shader, additive blend into RGBA32F, needs EXT_float_blend). The hole filling and
the filter bank stay on the CPU.
Checked against the CPU on the same inputs (SwiftShader): mean relative difference of the summed weight 0.03%, colour
difference 4e-6, 0.05% of pixels differ by more than 5% (edge pixels where the depth march picks the other surface).
The engine's saturation diffusion is gone from the CPU path as well: SaturationRecoveryType defaults to 2, which does not diffuse.

## What the engine really runs for the EDOF picture (decompile pass, ILLUM configuration)

- `RefocusEdof::operator()` -> `ComputeOutputDepthMap` (method 1 of cfg 0x1a20, centre view: `RegularSampledProjection`, which upscales the depth map with
  `DmResampler` and reads it at the output pixels) -> `createDepthEdgeMap` (box of radius 4 around every depth step >= cfg 0x1f08 = 0.3) -> `ProjectEdof::operator()`.
- `ProjectEdof` flags from the config: 0x1a88 on (depth projection with `BackProjectDepthMap`: the ray march is done inside the projection), 0x1ec0 and 0x1ed8 OFF
  (so no per-pixel queues and no `robustFiltering`; the depth edge map is not used), 0x1f20 on with threshold 2.0 (rays more than 2 lambda behind the output depth
  are dropped: the z test), 0x380 and 0x2660 on (geometry error table, ray table). `ProjectGold` is the reference version and not what runs.
- `robustProjection`, per standardized pixel: aperture weight from a 256 x 256 table over -1..1 (index = 127.5 * c + 128), pixel alpha > 0, ray (with table), march with
  min/max maps, then the four bilinear corners are added `weight * rgba` when `lambda - outputDepth < 2.0`. Matches the port (lytroSplat).
- Aperture: the table is over -1..1, so HexAperture's flat sides at 0.5 * value are in units of the disk radius; the metadata's 0.9025 is 0.451 in the port's parameter.
  `engineAperture(cam)` uses that (the empirical optimum, 0.3 .. 0.5, contains it).
- The depth map, importance map and the min/max maps are all upscaled x5 first (`GetSourceDepthMap` -> `UpscaleMaps`: depth with `DmResampler`, the importance map
  with `ScaleImage`; `ComputeMinMaxDepthMap` then runs on the upscaled depth with its window radius scaled by the upscale). DepthResampleConfig from cfg: 0x1aa0 on (use the
  resampler), 0x1ae8 on (blend), 0x1ad0 = 0.8 (similarity threshold in lambda), 0x1ab8 = 5. Per lens an 8 bit similarity mask, then a Voronoi labelling of the cell
  (`calcPerPixelModifiedVoronoiPts`), boundary chains traced through boundary cells (`walkBoundary`, `LineIsectSubpixEvaluator`), and every sub pixel takes the
  inverse distance weighted (1 / sqrt(max(d^2, 0.01)), `calcSubpixelWeights`) mean of the lenses of its quadrant that are connected to its owner. Ported approximately
  (`userDepthAlphaUpscaled`: weights as in the engine, "connected" = within 0.8 lambda of the nearest lens).
- Not ported, and not available from the stack: the importance map (`DepthMapState::GetImportanceMap`, texels with importance < 0 are skipped by the ray march and the
  hit texel's importance is the ray's confidence) and the `BlendIlluminant` stage (cfg 0x1080 on: illuminant blend with `ChromaSuppressionMap`, cfg 0x1108 .. 0x1170).
- Tried and dropped on b4-1e: output depth from the upscaled map (halo 16.4 -> 19.6), skipping depth texels near depth steps (worse at every radius), no z test
  (3.52 -> 3.60), tolA / tolB swapped or widened (no change), depth smoothing off (no change).
- Highlights: the engine clamps every channel of the demosaiced picture at white (1.0 = G at full scale) before the luma boost; without it red and blue (white balance
  gains 1.27 and 1.34) stay above 1 where green clips and the bright edges come out pink. `SPLAT.sharpen.clampPre = 1`.

### Fence halo: engine oracle with a crisp two value depth (negative results)

`tnt.exe --depth-in` fed with a binary depth (wire -22.5, background -4.2, from the engine's own depth of b4-1e) renders without any grain beside the near wire; ours,
given the same depth, still has the dotted band (2 to 3 lenses wide) and its right wire edge sits about 0.8 lens left of the engine's. So the depth map, its x5
upscaling (DmResampler, similarity is on depth with threshold 0.8) and the importance map are not the cause: it is in our ray march or splat. Tried on that pair with no
fix: bilinear read of the upscaled depth, depth lookup shift of 0.25 .. 1.5 lens in x or y (x 1.0 moves the edge onto the engine's but worsens the halo region and the
knot), ray direction scale 0.9 .. 1.1, ray direction offset +-0.4 px (-0.4 on u slightly better, +0.4 worse), output depth from the upscaled map, full depth blending across
the step (dmSimilar 100). `tnt.exe` has no option that dumps the importance map (`TNTARG::outputImportanceMapName` is never set from an option string).

Follow up on the same oracle: the wire edge offset (about 2.3 px at lambda -22.5) is the "depth-proportional shift" noted under the geometry table (-0.097 px per lambda
in x). A ray direction offset of +0.4 px on u (applied to the march and to the splat) puts the edge exactly on the engine's, but worsens the whole picture (3.85 -> 4.01)
unless the lens position is moved by -0.2 lens at the same time (3.77, knot 4.44 -> 4.26); the optimum is shallow and noisy (+-0.1 changes the score by 0.05) and none of it
removes the dotted band, so no offset was adopted. `RayTraceRegion` read again: the march (start at the min filtered depth, step 1, texel = trunc((x - du * lambda) + 0.5) * size,
importance >= 0 gate, tolerances 1 and 2, far fallback with confidence 0.5, `far` initialised to -FLT_MAX) is identical to `marchRay`.

### Viewpoint shift = geometry table mean (found with constant-depth oracle runs)

With a constant depth fed to `tnt.exe --depth-in` (all -22.5, the near wire's lambda) the picture is pure ray geometry. Ours then differed from the engine by 1.4 px at
the wire edge (and had a halo score of 9.7 there). Adding the table's mean to every ray's direction (ru += -mean(u) * pitch, rv += -mean(v) * pitch = +0.266, +0.09 px
on b4-1) puts the edge on the engine's (1561.6 vs 1561.48) and cuts the halo score to 5.4; on the real photo (real depth) MAE against the engine 3.47 -> 3.24, knot
region 4.08 -> 3.85, whole 3.56 -> 3.44. The opposite sign is clearly worse (3.78). The per lens variation of the table stays absorbed by the fitted lens centres
(engine grid + full table = 3.55, engine grid alone 4.15, table with the wrong sign 4.90, so the table is the engine's own correction). `lytroSplat` applies the mean on the CPU
and `uRayShift` in the GPU shader (`opts.geoMean !== false`). The dotted band beside the near wire (binary depth) is not fixed by this: ray geometry at constant depth
matches the engine (no dots at all), so the dots come from how a depth step is handled.

### Engine path: Lytro's depth sits a constant -1 lambda off the plain rays (b4-2 was garbage)

`lytroEdof` took its lens resolution depth from `state.depth`, which for Lytro depth maps carries the app's ray table shift (`rayWarpShift`: constant per photo, -0.9 lambda on b4-1e, -1.1 on b4-3,
-4.5 on b4-2), while the x5 map (`depth5`) was built from the stack depth as it is. The march range (lo / hi, from `state.depth`) and the depth it reads disagreed by that shift and the b4-2 picture
came out as a smeared wall (MAE against the engine's own render 35.8). Reading the plain depth everywhere: b4-2 5.08, but b4-3 got worse (2.72 -> 2.79, gradient ratio 0.967 -> 0.879). Shift scale
sweep (0, 0.5, 1, 1.5 of the estimate): b4-2 best at 0, b4-3 best at 1 .. 1.5, so the estimate is unreliable on b4-2. A constant -1 lambda (`ENGINE_DEPTH_SHIFT`, applied to the lens depth and to the
x5 map) gives b4-1e 3.21 (was 3.24), b4-2 5.12, b4-3 2.73. The stack depth equals the engine's own depth-out (b4-2: mean abs difference 0.05 lambda, aligned).

More oracle results on b4-1 (real depth, vs the engine with its own depth saved and fed back):
- Reading the depth map shifted by -4 lens in x (equivalently a ray direction offset of -2.2 px used by the depth march only) removes the dotted band beside the near wire completely
  (halo score 19.8 -> 6.0, knot 4.03 -> 2.96) but costs 0.1 on the whole picture; so does the per cell table value (x2 .. x3) as that march offset (halo 6.1, whole 3.93 -> 4.06, MAE against
  the engine's own render 3.24 -> 3.32). Not adopted: the cause of the depth-proportional offset between the engine's depth map and the rays is still unknown (the ray table's chief ray
  and tilt terms were tried for the march only: no effect).
- Aperture: against constant depth renders of the engine the best aperture is the metadata's 0.9025 used directly (0.8 .. 0.9), not 0.451; with the real depth the larger aperture is
  worse (3.24 -> 3.51) because it exposes this offset. Engine's accumulate step and march (importance gate, conf > 0, tolerances) read again: identical to ours.

### More oracle results (b4-1 real depth, against the engine rendering its own saved depth)
- Viewpoint shift (geometry table mean) is also right at the engine's own aperture 0.9025: constant wire depth, wire edge 1561.56 vs engine 1561.48 (without it 1560.08), whole picture 3.28 -> 2.99;
  at constant background depth it costs 0.1 (2.87 -> 2.97) but halo and knot improve.
- A depth lookup offset that vanishes at the background depth (-2.2 px ray offset with a compensating lens shift), a field dependent offset (proportional to the lens position across the sensor)
  and the ray table's chief ray angle and tilt terms for the march only: none beats the plain constant offset; every variant costs 0.04 .. 0.2 on the whole picture. No law found.
- Nearer-wins (min) dilation of the x5 depth map by k texels (5 texels = 1 lens): halo at the near wire 19.8 -> 15.7 (k 5) -> 8.3 (k 12) -> 6.3 (k 16), whole picture flat up to k 10 (3.93 -> 3.92)
  and +0.1 at k 16. Against the engine's own renders at k 10: b4-1 MAE 3.24 -> 3.22, b4-2 5.08 -> 5.10, b4-3 2.72 -> 2.79 with the gradient ratio 0.967 -> 0.879 (softer thin structures), so not adopted.
- b4-2 needs a 3 px alignment shift against the engine (b4-1 0.1) also with the engine's own lens grid and table, and with or without the table mean: unexplained, probably depth proportional (its depth reaches +27).

### Near side growth of the x5 depth (adopted: 10 texels = 2 lens)
Earlier readings of the dilation results were confounded by the b4-3 depth bug (the identical 2.79 / 0.879 on b4-3 at every dilation came from the depth shift, not from the dilation, which does nothing on
that picture). With the constant shift in place, growing the near side of every depth step in the x5 map by 10 texels (`dilateNearest`, `D5_GROW`) gives: b4-1e wire halo 19.0 -> 9.1, knot 3.95 -> 3.08, whole
picture 3.96 -> 3.97, MAE against the engine 3.21 -> 3.22; b4-2 5.12 -> 5.14; b4-3 2.73 -> 2.73. It is empirical: Lytro's own pictures keep the near depth about two lenses past a step in the depth map, the cause is not found
(ray geometry matches the engine at constant depth, the resampler's owner split is at the cell midpoint like ours, the engine's ProjectEdof view offsets are 0 for this recipe, the output depth z grown by r px is worse:
r 3 -> 16.4 / whole 4.04, r 6 -> 19.4 / 4.23, r 9 -> 28.6 / 4.51). The lookup using only a fraction of the ray table's position shift (0, .5, 1.5, 2): no change in the halo.

### Edge blocks: where the remaining error is (b4-1, engine vs ours, 120 x 120 px blocks)
The three worst blocks of b4-1 are not the wire but other crisp depth steps (near -22 against far -3, one texel wide in the engine's depth) of the rope and fence links: ours shows comb like teeth along the
edge where the engine's edge is smooth (mean abs difference 8.4, 7.7, 7.6; the whole picture 3.2).
- At constant depth the same blocks differ by 7 .. 10 at our aperture (0.451) but by only 3.5 .. 4.8 at the engine's own (metadata 0.9025 used directly, no halving): ray geometry, demosaic, weights and aperture
  model are right in those blocks. At real depth the engine's aperture does not help (10.1, 7.9, 8.6): the extra error comes from how rays take their depth at the steps.
- No effect at all on the three blocks: how the x5 map is built (similarity 0.3 / 0.8 / 3, a level set contour instead of the nearest lens for the side of a step), the march step (0.5), the search window above
  the engine's own (31); worse with a smaller window (reach 3: 10.4 / 8.2 / 9.4), with dropping rays that hit texels near a step (k 1 .. 8: 7.8 .. 9.6), with the output depth grown (z), with the near side grown (helps the
  wire, hurts blocks 1 and 3 by 0.5 .. 0.8), with a lookup shift (helps blocks 1 and 3 and the wire, hurts block 2: not a translation).
- Even and odd lens rows give the same picture to 0.15 px: no row parity registration error.
- Alpha is complete everywhere (0.07 % of pixels below 0.99), so the teeth are rays that took a wrong depth, not holes.
- Displacement scale (0.0814 per lens map unit is 0.7 % above the 1 px per px of u and lambda the geometry gives): best 0.8 .. 0.9 at the engine's aperture (3.52 against 3.74) but still worse than 0.451 (3.22), not the cause.
- GPU against CPU with all of the above (shift -1, x5 growth, table mean ray shift): mean alpha difference 0.02 %, 907 of 2.4 M pixels over 5 %, colour 3e-6.
The cause at these steps is still open; the importance map (not available from the engine, no option dumps it) and the exact line segment tracing of the DmResampler remain the unported pieces.

### Raw files, the engine's off-centre views and its depth stage (own depth, no Lytro depth map)
- `tnt --lfp-out` writes 7 EDOF views at perspectives (u, v) in lens pitches: (-0.3464,-0.2), (-0.3464,0.2), (0,-0.4), (0,0), (0,0.4), (0.3464,-0.2), (0.3464,0.2).
  `lytroSplat` option `persp` ([u, v]) reproduces them: splat direction `ru - u*pitch`, u first, sign +1 (swapped or negated: MAE 12 to 19 against 4.4).
  Against those views b4-1 scores 4.2 to 4.5 (centre 3.2), the rest is a pure translation (`pivot` lambda), so the lambda to displacement scale and the ray geometry are right over a large parallax range.
- On raw input the engine path runs from our own depth. Classic style: MAE 3.48 against the engine render; Lytro style (`depthStyle: match`): 3.37; with Lytro's depth map: 3.22. b4-2 5.55 / 6.24 (match / classic), b4-3 2.73 / 2.72.
  The harness has no hardware GPU, so it falls to the classic style unless `globalThis.__forceStyle` is set.
- Our depth against the engine's depth map (`lo41.lfp` edofWarp depth, whole labels with sub-pixel): classic MAE 2.1 lambda, match 1.0, match with the engine's views 0.93. Smoothing 0.3 makes no difference.
  The engine's views (spec in `docs/lytro-depth-spec.md`, from `GetBlitzenVersion1Configuration`): a ring of eight at radius 0.25 lens pitches, 45 degrees apart, plus the center; now the default of `measureLytro` (`depthViews`).
- Still different: the engine's fence wires are flat plateaus with stair-stepped edges, ours have gradients and edges about 1 px (541 grid) off on one side; edge blocks 10.6 / 8.7 / 8.0 against 8.4 / 7.7 / 7.6 with Lytro's depth.
  A viewpoint offset on the depth views only translates the whole depth map.

### Edge shape experiments on b4-1e (Lytro depth, scored against the engine render; blocks = (760,280) (460,640) (580,400) halo, whole 3.25)
- Square near-side growth r = 10 (the default): 8.38 7.74 7.57 3.18. The wire edge shows teeth along diagonals; the knot region is cleanest.
- Contour level (`dmLevel`) with no growth: edges clean (7.88 7.82 6.80) but the halo 4.18. Round (disc) growth with `dmLevel`: r 4 / 6 / 8 / 10 / 14 gives halo 3.83 / 3.66 / 3.44 / 3.31 / 3.02 and blocks 1 and 3 from 8.04 / 7.08 (r 4) to 8.35 / 7.62 (r 14); teeth return at large r. Whole picture 3.23 to 3.25 in all.
  The wire edge (diagonal) wants a small growth, the knot (vertical edge) a large one: a plain dilation cannot be the engine's rule. Kept: square 10, `d5Round` and `dmLevel` as debug options.
- Output depth from the x5 map (`zFrom5`): halo 4.14 / 4.55 / 3.75 with the above, no gain.
- Not the cause of the teeth and fringe: edge artifact reduction, the filter bank, hole fill (all within 0.05 of the default).
- Raw files: the engine path from our own depth is 3.34 (Lytro-style depth) against 3.25 with Lytro's depth; edge blocks 10.6 / 8.7 / 8.0.

### Depth map placement for the engine picture (fit on the engine's binary depth oracle and on b4-1e)
- With the engine's binary depth (`--depth-in`), a lookup shift of -1.5 .. -4 lens fixed the halo at the knot but not elsewhere: the best shift differed by place (knot -4, left wire +1.5): a scale error. The engine's depth map spans its picture, which is 1.58 % tighter than ours (the scale of the fit against its render is 1.0158 on every photo).
  A placement of the depth map about its center (`DEPTH_MAP_PLACE`: kx, ky, dx, dy in texels) fit on the oracle: kx 0.9844 (x only) halo 18.6 -> 6.4, knot 3.75 -> 2.96. On the real photo a coordinate descent (blocks, halo, whole) gave kx 0.995, ky 1.015, dx -2, dy -1.5: blocks 8.4 7.7 7.6 -> 6.3 7.6 5.7, halo 3.18 -> 2.8, whole 3.25 -> 3.18.
  Applies to Lytro's depth in the engine path only (`ENGINE_PLACE`); our own measured depth is in our frame already. Near-side growth is no longer needed (growth 0 .. 4 is the same); default 4.
- The x5 resampler matches the engine's contour (`dmLevel`, see below); the importance map cannot change the picture (always 0.5 .. 1.0, never a weight): `docs/lytro-depth-spec.md` has the depth stage, the resampler spec was written to the session scratchpad.
- The raw path (own depth) is limited by the depth edges themselves: blocks 10.6 8.7 8.0 against 6.3 7.6 5.7 with Lytro's depth. A 1 texel shift of the engine's own depth changes those blocks by 0.5 .. 1.

### Raw path (own depth) frame experiments, b4-1e against the engine's raw render
- Fitting the estimator's own constants straight against the engine's depth map (depth-only runs, `lo41.lfp` depth): cost cap 0.2 -> 0.14, gamma 0.6 on the colour compare, cross aggregation arms 39/19 with 6 rounds: MAE 1.07 -> 0.90 lambda, edge MAE 4.66 -> 3.95. The picture does not follow (blocks 10.7 8.7 8.2, whole 3.43 against 3.41), so the defaults stay; the knobs are `lcost`, `cbca`, `trws`, `passes` in the debug options.
- Our depth injected through the Lytro-depth path (aligned to the engine's frame, with the engine placement and the x5 map) scores blocks 6.3 8.2 5.8: the depth content is as good as the engine's own. What differs is the frame: for our own depth the same kind of placement (about the picture center: kx 1.01, ky 1.05, shift -2, -1 lenses) cuts the blocks to 5.9 8.3 5.9, but sharpness on b4-3 drops (gradient ratio 0.957 -> 0.873) and b4-2 barely moves, so it is not adopted (`ownPlace` debug option).
  Tried with no effect: gain and offset of our depth (1.046, -0.36), half pixel registration, march only along the plain rays (`plainMarch`: whole 3.43 -> 3.33, blocks 9.3 8.1 8.8), a march-only ray direction offset (`marchDu`, `marchDv`), x5 upscaling of our own depth (`own5`).
- The ray table's origin offset field at the lens center (u = v = 0) reaches +-32 lens pixels at the picture corners and +-4 inside (see `dumpField`), so the engine's corrected rays sit far from the plain ones; the frame of a depth measured from plain views is not the engine's. Open: derive the frame change from that table instead of fitting an affine.

### b4-2 (zoom step 11): what differs from b4-1 / b4-3 (zoom 471 / 444)
- The engine's own depth for the three raw files (`--image-out x.png --depth-out x_depth.png`, labels run to `floor(infinityLambda) + 3` rounded up to 4: b4-1 4, b4-2 40, b4-3 8). Our depth against it with the b4-1 alignment: b4-3 MAE 1.07 (1 % of pixels off by more than 3 lambda), b4-1 1.07, b4-2 9.9 (94 % off): the engine puts the b4-2 sky at 25.3 where ours reaches 21, and its object range is ours + 5 (+1.1 on b4-3, +0.4 on b4-1), the size of the ray table lambda shift the app estimates per photo (-4.5, -1.1, -0.9). Shifting our depth by +2.5 lambda moves b4-2 only 5.23 -> 5.17.
- Constant depth oracle on b4-2 (engine `--depth-in` all +25 and all 0, ours the same): ours is displaced from the engine's picture by (dy, dx) = (+2.4, +1.3) px at lambda 0 and (+4.9, -0.6) at lambda 25 (b4-1e: 0.1 px): a position offset plus a depth proportional shift of 0.1 px per lambda, so the b4-2 geometry is not the b4-1 geometry. The table mean viewpoint shift on b4-2 is (0.536, -0.037) px (b4-1 0.273, 0.086); ruOff / rvOff move the picture by -6 px per px (ruOff on x, rvOff on y), so (-0.32, +0.42) would cancel the slope. The ray table origin field at u = v = 0 is point symmetric and zero at the center on every photo (up to 16 lens px at the b4-2 corners, 32 on b4-1, 27 on b4-3), so it does not explain it either.
- No effect on b4-2: the engine's own lens grid (`engineGrid`), the ray table flags (`rwOpts`: tilt, chief), the displacement scale (0.8 .. 1.25: 7.2 .. 5.8, not a clean minimum), the aperture (0.3 .. 0.7: MAE falls and sharpness falls). Open: the zoom dependent part of the engine's ray model (the calibration set it picks per zoom step), which b4-1 and b4-3 share and b4-2 does not.

### Ray model read from the decompile (docs/lytro-ray-model-spec.md) and what it changed
- The engine's ray model has no focal length, zoom, focus or optical centre term; zoom only selects the calibration sample (nearest zoom, then focus) whose numbers and GCT the photo already carries. lambda -> displacement is exactly 1 px per px of the pixel's offset from its disc centre (`HexLightfieldGeometry::Project`); LAMBDA_TO_ALPHA is an output grid constant.
- Order in the engine: GCT (CorrectLightfieldPoint) first, then the ray table looked up on the corrected direction, then Project; the aperture window is tested on the corrected direction. Ported as `gctFirst` and `apShift` (default on; CPU and GPU, the CPU visits one more pixel ring around each lens): b4-1e 3.17 -> 3.10 (edge blocks 5.8 7.7 4.9, halo 2.78), b4-2 5.15 -> 5.05, b4-3 2.73 -> 2.72; GPU against CPU 0.02 % mean.
- The lambda 0 offset on b4-2 is mostly our output frame: `samplerExtent` takes the lens index range, which loses a column and a row on b4-2 and moves the frame center by (-5.7, -7.4) px (b4-1 and b4-3 +0.9, -1.2); the fitted registration shift of the score script follows it (predicted dx 1.39 / fitted 1.51 on b4-2). Not a render error. The depth proportional shift (about 0.1 px per lambda on b4-2) is still unexplained; the spec lists four bisection runs on a patched LFP.
- Bisection on the engine (b4-2 copy with `geometryCorrectionRef` swapped for b4-1's table, or zeroed, same-length edit through the app's section index; constant depth +25 render): both give the same picture, which differs from the original by 0.43 grey levels on average and by 0.00 px in position. So the geometry table does not move the engine's constant-depth picture at all, the depth proportional shift of b4-2 is not the GCT; remaining candidates are the ray table section and the metadata numbers (E, sy, rotation, sensorOffset).

### Own depth read through the ray table's origin field (raw files)
A depth measured here is in the frame of the plain views; the engine's rays start where its ray table puts them (origin offset at the lens center up to +-32 lens px at the picture corners on b4-1, +-16 on b4-2, +-27 on b4-3, zero at the center, point symmetric). Reading our depth at `p - origin(p)` (`fieldPlacedGrid`, default for own depth in the engine path; the app's focus offset / field term is kept on top):
b4-1e whole 3.35 -> 3.07 (edge blocks 10.7 8.6 8.3 -> 6.6 7.8 5.9, halo 2.9), b4-2 5.36 -> 5.33, b4-3 2.71 -> 2.72 (sharpness unchanged); the opposite sign 3.64, half the field 3.19. With the frame right the estimator constants no longer matter (3.07 .. 3.08 across the variants), and the raw path is as close to the engine's raw picture as the path with Lytro's own depth (3.10).
(Dropping the focus offset / field term while remapping cost b4-3 9 % of its sharpness: that was the first attempt's artefact, not the field.)

### Where the engine path stands against the app's default render (raw files, mean pixel difference to the engine's raw picture, lower is better)
| photo | app default render | engine path, own depth |
|---|---|---|
| b4-1e (fence) | 4.56 | 3.08 (3.07 with the Lytro-style depth alone; classic 3.36) |
| b4-2 (tonearm, zoom 11) | 5.93 | about 5.1 to 5.3 |
| b4-3 | 3.32 | 2.72 |
The engine path (`lytroEngine`, off by default) needs the photo's ray table and modulation frame (raw files from the camera); it is now ahead on all three. Left: the b4-2 geometry (depth proportional shift), wire-interior texture, and the owner's decision on making it the default.

### Turntable (b4-2) sharpness: the lambda frame of our own depth
Edge sharpness (mean gradient on the engine picture's strong edges, ours / engine; 1.0 is as sharp; our picture resampled to the engine's grid so all numbers are a little low): b4-2 with plain own depth 0.80. Moving our depth by +3.5 / +5 / +7 / +9.5 lambda: 0.88 / 0.896 / 0.89 / 0.85 (MAE 5.37 -> 5.11 / 5.10 / 5.12 / 5.27); -1.77: 0.75. The engine's depth on that photo is ours + 5 in the object range (see the depth transfer table above), the same size as the ray table's lambda estimate (-4.5). The estimate is about -1 even on photos that need none (b4-1e needs about 0, b4-3 needs 0: the estimate +1.1 costs it 0.09 of sharpness), so the offset applied to own depth is `max(0, estimate - 1)` (`OWN_DEPTH_SHIFT = 'table'`): b4-2 0.80 -> 0.88, b4-1e 3.08 / 0.939, b4-3 2.71 / 0.892 unchanged.
Not the cause: the filter bank (the engine changes by 0.55 grey levels without the photo's reconstructionFilterRef, i.e. it does not really use it; our engine-built bank is insensitive to a lambda shift of -3 .. +6), the lens grid (`engineGrid`), the aperture. The direction dependent position term of b4-2's ray table does matter for sharpness (scale 0 / 0.5 / 1 / 1.5: 0.86 / 0.835 / 0.80 / 0.76 with our usual offset), consistent with it acting as a per-photo lambda offset between the rays and the depth.

### Edge sharpness against the engine at equal pixel size (render at scale 3.2366 so a pixel is the engine's size; the engine's picture resampled with a cubic filter, shift only)
Ours / engine mean gradient on the engine's strong edges: b4-1e 0.911, b4-2 0.879, b4-3 0.891, so ours is about 10 % softer on every photo, MAE 3.16 / 5.66 / 2.77 (no fit).
Tried on b4-1e (MAE, ratio; base 3.16, 0.911): luma boost amount 0.5 3.64, 1.009 (sharper but worse); edge artifact reduction off 3.17, 0.913; the photo's reconstruction bank 3.15, 0.913; no bank 3.41, 0.939; engine lattice 4.18; engine lattice plus the full geometry table per ray (sign +1) 3.64, 0.888 (sign -1: 5.83); fitted lattice plus the full table 3.82; aperture 0.38 / 0.55 / 0.7 / 0.9025: 3.26 / 3.10 / 3.12 / 3.42 with ratios 0.916 / 0.903 / 0.877 / 0.804. None closes the 10 % without raising the error; the fitted lens centres plus the mean viewpoint shift stay best.

## Aperture (disassembly, exact)

The engine's EDOF window is a hard, flat 0/1 hexagon (`HexAperture`, apothem 0.5 * NominalApertureFraction in lens pitches, i.e. 0.45125 pitch on b4-1), sampled into a 256x256 table over -1..1 and read by nearest lookup (index 127.5 * c + 128) on the GCT-corrected direction. `ImageAperture`/`smoothEdges` are not on the refocus path. Full spec: the aperture disassembly notes (HexAperture ctor 0x1003a01e0, operator() 0x1003a0a90, robustProjection lookup 0x1004890bf).

Measured against tnt renders (b4-1, mean abs difference, edge-gradient ratio ours/engine):

| input | aperture | MAE | edge ratio |
|---|---|---|---|
| constant depth -4.2 | halved flat (default) | 4.35 | 1.04 |
| constant depth -4.2 | exact 0.9025 hard | 2.47 | 0.92 |
| constant depth -4.2 | exact 0.9025, soft fall-off 0.15 | 2.36 | 0.95 |
| real photo, own depth | default / exact | 3.09 / 3.54 | 1.00 / 0.88 |
| real photo, engine depth | default / exact / exact+soft 0.2 | 3.11 / 3.29 / 3.14 | 1.02 / 0.95 / 0.97 |

At constant depth the exact aperture is clearly right. On real photos the halved aperture still scores as well or better, because it absorbs depth/placement error (ENGINE_PLACE, depth shift -1, D5_GROW were fitted under it). The default is therefore unchanged until those are re-fitted; `dbg.apExact` and the `apFall`/`apCone` splat options select the exact window for that work.

Re-fit under the exact aperture (b4-1, engine depth map, soft 0.2): depth shift -2/-1/0/+1/+2 λ gives fitted MAE 3.64/3.10/2.91/3.04/3.50, so the exact window wants no depth shift (the default's -1 λ compensates for the halved aperture). z-test tolerance 1/2/4 gives 2.94/2.91/2.88, insensitive. The floor of about 2.9 against 2.4 at constant depth therefore comes from how the engine's depth map is resampled and applied (DmResampler x5, frame registration), not from aperture, shift or tolerance.

### Exact aperture, constant depth -22.5 (b4-1, against tnt, mean abs difference / edge ratio)
Default (halved flat) 5.57 / 0.96; exact 0.9025 soft 0.2 2.82 / 0.86; exact without the filter bank 3.79 / 1.06; with the photo's bank 2.80 / 0.87. Output sharpening 25 / 50 on ours: 2.84 / 0.88 and 2.86 / 0.90 (the engine's difference is not sharpening). Ray displacement scale 0.98 / 1.02 and bank lambda shift +4 / +8 change nothing material (2.81..2.89). zFrom5 (output depth from the x5 map) changes nothing on the binary depth oracle (3.90 vs 3.92). With binary depth (din1) the default scores 3.92 / 0.73 and the exact aperture 4.23 / 0.63: the softest places are flat far regions (the door at about x 900, y 260..740), not the depth step, so the sharpness loss there is not an edge handling problem. The reconstruction bank is what separates 3.79 from 2.82 and also what softens (1.06 to 0.86): the engine ends between them.

Registration check at constant depth -22.5 (phase correlation per 256 px block, exact aperture): residual shift <= 0.15 px in 18 of 20 blocks (two low-texture blocks are outliers), so the remaining 5 to 10 % softness and the per-block mean difference spread (1.2 .. 4.8) are not misregistration. Bank design size x0.85 / x1.15 (`dbg.bankSize`): 2.90 / 2.79, ratio unchanged.
