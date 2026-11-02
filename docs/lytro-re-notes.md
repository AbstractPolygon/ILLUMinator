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
(Corrected, see 'Saturation recovery is active' below: ILLUM sets SaturationRecoveryType 1 and the diffusion runs on the demodulated mosaic.)

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

## Engine lattice offset (new default)
A tnt render at a wrong constant depth is a moire of the lens lattice, so its spectral coherence with ours is a very sensitive probe of the lens centres. Scanning the splat lattice against tnt at constant -22.5 (b4-1, exact hard aperture) gave a sharp optimum at (ox, oy) = (-0.2, -0.4) px from the metadata lattice (pitch 14.2857, not the engine's DiskPitch 14.2899: pitch x1.0001 / x0.9999 are both worse; rotation +0.00005 rad best). Mean difference 2.82 -> 2.14, band coherence 0.59, and with a hard aperture 0.70. b4-3 (constant -10) prefers about (-0.3, -0.4) with the same trend, b4-2 improves with the same shift. The engine's own lattice (`engineGrid`) is worse as it stands.
Default now (`dbg.legacy` restores the old behaviour): rays shifted by ENGINE_LATTICE = (-0.25, -0.4) px, window 0.665 x the nominal aperture (0.6 on b4-1), Lytro depth shift 0 (was -1). Against tnt's real renders with the stored Lytro depth (fitted mean difference, edge ratio): b4-1 2.95 -> 2.51 (1.00 -> 1.00); b4-3 2.25 -> 2.20 (0.985 -> 0.977); b4-2 3.93 -> 3.27 (0.994 -> 0.932). Full nominal aperture with the lattice offset scores 2.70 / 2.24 / 3.43 with softer edges, so some ray error that grows toward the window edge is still compensated by the narrower window. GPU against CPU: 0.016 % mean alpha difference.

## Stage specs from the disassembly (raw -> standardized image, post-projection, final pipeline)
Full specs (scratchpad, summarised here): the engine divides by a modulation bitmap normalised by ONE mean per colour for the whole sensor (floor 0.02, outliers > 3.5 x mean replaced), reweights colour and alpha by m^2 (net colour raw * m, alpha m^2); our per-lens reference (`m > 0.15 * ref`) is replaced by the global reference (`modGlobal`, CPU and GPU, default on). JointAdaptiveFilter method 10 runs the PHOTO's reconstruction kernel PNG (the designed SpecifiedBandsFilter bank is only the fallback for a photo without it, and the aperture does not enter it); the app now uses the photo bank whenever the photo has one. The lattice offset is the engine's corner convention (+0.5 px) plus the mean GCT shift, i.e. about (-0.23, -0.41) on b4-1, matching the fitted (-0.25, -0.4). The final pipeline (colour matrix blended by CCT, Neat Image noise reduction mostly chroma at base ISO, tone spline, Lab-Y unsharp with a fixed amount about 1.2 to 1.5 and sigma 1.35 to 1.5 px independent of the sliders, sRGB, half-up rounding, no dither) differs from ours in domain, order and strength; not yet ported.
Against tnt's real renders (stored Lytro depth, fitted mean difference): b4-1 2.51 -> 2.41, b4-3 2.20 -> 1.78, b4-2 3.27 -> 2.97, edge ratios 1.00 / 1.00 / 0.99. GPU against CPU 0.016 %.

## Exact ray geometry and depth placement (stage 2 spec, now the default path)
The engine lattice (HexDiskArrayModel, pitch 14.2899 x 14.2906, edge coordinates: -0.5 for pixel indices), the geometry table's cell at each disk centre taken off the direction (nearest cell, no mean), the window on that direction, the ray table on it, the lambda ratios (cos th * pitch.x - sin th * pitch.y) / W and (cos th * pitch.y + sin th * pitch.x) / H, and the depth map read at its own raster position (541 x 376 over the whole sensor, x5 by DmResampler on that raster, then looked up by each ray's sensor position through the app's picture frame; no fitted placement, no grow) are in `lytroSplat` (`opts.exact`, CPU and GPU) and `engineDepthInFrame` (userdepth.js). Fitted mean difference against tnt's renders (stored Lytro depth): b4-1 2.41 -> 1.99, b4-3 1.78 -> 1.70, b4-2 2.97 -> 2.45, edge ratios 1.00 / 0.98 / 0.95, window 0.8 of the nominal. The picture frame is still the app's lens-range frame (the engine's is the whole sensor, 2022 x 1404), so the shift + scale fit in the score hides a rotation of 0.001 rad. GPU against CPU: 0.2 % mean alpha difference (1.4 % of pixels differ by more than 5 %, edge rays near the window and depth texel borders).

### Own (measured) depth on the exact geometry (unprocessed files)
Node runs measure the classic depth only unless FORCESTYLE=1 (no hardware GPU); with the app's combined depth (classic + Lytro-style) on b4-1: fitted mean difference against tnt 2.28 (window 0.65 of the nominal), against 1.99 with Lytro's stored depth map. Our depth in the picture's frame against the engine's own: correlation 0.93, slope 0.82 (classic alone 0.79 / 0.49, Lytro-style alone 0.94 / 0.84). The depth views are now read at the lenses' physical centres from the geometry table (`exactLensOffsets`: lattice node + cell offset times the pitch, no measurement from the picture), and the depth is placed by the ray table's origin field less the cell offset plus that lens offset (`fieldPlacedGrid(.., exact)`).

## Lytro Desktop's own pictures as the reference (stack.preadjust.lfp)
Each library photo's stack.preadjust.lfp holds Lytro Desktop 5.0.1's pre-adjust EDOF pictures (kind edofWarpPreAdjust, engine 21.0, OpenEXR float, 2022 x 1404, linear camera RGB; the section whose perspective is (0, 0) is the centre view; the other six are the 0.4 pitch ring). They register against tnt's renders with the same shift and scale, so tnt and the app are the same engine. Scored with gamma 2.2 display of our linear output (scripts: linscore.py), fitted mean difference over 13 photos (Lytro's stored depth map as the depth): legacy path 1.96, exact geometry 1.33, + BlendIlluminantSharpenGain (chroma suppression map and Lab luma sharpen, `bisgFilter`, GLSL in gpu/lytroengine.js) at the engine's full nominal window 1.13 (0.9: 1.22). The window that scored best on the way (0.665, 0.8) was compensating for the missing highlight handling and the wrong frame. With our own measured depth (combined style) on b4-1: 1.36 at window 0.8, 1.38 at 1.0, 1.40 at 0.65 (against 0.96 with Lytro's depth): the depth measurement is the remaining gap for raw files.

Own depth on b4-1e against the engine's in the picture's frame (Lytro-style 'match', smoothing 0): correlation 0.926, mean absolute difference 1.09 lambda, median 0.5. The wires' depth itself agrees (the engine's own views (the EXR pictures) give -20 .. -22 for the wires by parallax, same as ours); the difference is at the wire edges, where our transitions are wider and offset (the engine's TRW-S result is crisp). Averaging the views over the engine's circular aperture (0.12 pitch, `__lytro.viewAp`) did not change the match (0.929 vs 0.937), so view noise is not the limit on this bright photo.

## The engine's final sharpening in the app (`engineUnsharp`, CPU and GPU)
tnt's recipe path ignores the sharpness slider's size (any value from 1 to 150 gives the same picture; 0 turns it off) and runs a fixed per-lambda unsharp mask on the linear luminance of the normalized Lab after the tone curve, before the sRGB encoding: sigma 0.36 .. 0.40 lens pitches (0.38 here: W / 540.8 * 0.38 px), amount 3.0 x 0.40 .. 0.50 (1.35 here), soft threshold 0.004, a and b kept. Lytro Desktop's own preview (`edof_preview.jpg`) is 1.06 times sharper than tnt's default picture and 1.20 times sharper than tnt without sharpening, so the real application sharpens this way too. In the app a raw photo with the Lytro look and a sharpening amount above 0 now gets this mask (amount / 25 times its strength; the app's own sharpening is then off) after the tone curve: `detail.js engineUnsharp` for pixels and `gpu/renderer.js engineUnsharp` (a two pass blur and the Lab sharpen into the canvas; GPU against CPU 0.008 grey levels mean, 1 at most). Against tnt's default recipe picture of b4-1: edge ratio 0.853 -> 0.933, fitted mean difference 2.65 -> 2.40. Raising the amount to match the edge ratio (2.0, 2.7) worsens the difference (2.47, 2.60), so 1.35 stays; the rest of the edge deficit is in the colour pipeline (the app's fitted 'Lytro look' curve in place of the engine's colour matrix blend, tone spline and sRGB), not yet ported.

## The engine's colour pipeline in the app (raw photos)
Engine: camera RGB in its linear units x the photo's colour matrix (ccm) -> the 14 knot natural cubic spline T through a 4097 entry nearest lookup -> sRGB; no hue step. Its units are raw / 1023 less the black level, and its demodulation divides by the whole-sensor mean of the modulation bitmap, so its colour is ours times (white - black) / 1023 x (whole sensor mean / lens centre mean) per colour: 0.766 / 0.756 / 0.758 on b4-1 (a scalar fit against tnt gave 0.763; b4-3 0.763; b4-2 about 0.70 by fit, the formula gives its own). `engineColorScale` (lytroedof.js) computes it from the photo's modulation frame at open; colour matrix, tone spline and sRGB are `base.js` ENGINE_SPLINE / engineTable (CPU) and the GLSL in gpu/renderer.js (0.03 grey levels mean from the CPU, 2 at most). `settings.engineColor = false` keeps the fitted Lytro look. Against tnt's no-sharpening render (mean difference, fitted): b4-1 2.45 / 1.94 -> 1.56 / 1.40, b4-3 2.73 / 1.74 -> 1.61 / 1.10, b4-2 6.39 / 2.43 -> 2.69 / 1.50.

### Own-depth error anatomy (b4-1, combined style)
Against the engine's depth in the picture's frame, about 54% of the absolute error lies within 2 px of depth edges (25% of pixels); the rest is a bias that grows toward near objects (our nearest depth reaches about -1.9 where the engine reaches -2.3: thin near wires). A global depth gain does not help (ownGain 0.92 / 1 / 1.17: fitted difference 1.35 / 1.36 / 1.42 against the engine's EXR), so the 0.82-0.85 slope is the thin-object and edge behaviour of the match, not a scale error. The engine matches on a regular grid with one sample per lens pitch in both axes (541 x 376); ours is at the row step (615 x 427).
Matching on the engine's coarser grid (detail 0.866, about one sample per pitch) lowers the correlation with the engine's depth (0.909 against 0.928 at detail 1), so the raster spacing is not the cause of the own-depth gap.

### Depth views: the engine's colour path (read from RefocusSimpleMultiAperture::operator(), 0x100339f30)
The call order is ReconstructionFilter, ProjectMultiAperture, NormalizeImage, CorrectChromaticAberrationImage, initFinalImagePipeline, finalImagePipeline. In finalImagePipeline (0x10031fea0) the colour matrix (the metadata matrix at +0xa0, or the CCT-blended one when cfg +0x2790) is applied, and then, because GenerateSubApertureConfig sets GammaFunctionType 3, the HDTV gamma (RefocusCommon::resetParameters case 3, GammaFunctionHDTV::operator() 0x1003b7730): y = 4.5 x for x <= 0.018, else 1.099 x^0.45 - 0.099, clamped to 0..1. MatchColor runs after that, so the cost caps (0.2, blown-out 0.95, flat 0.15) are in the gamma domain. Ported as `DEPTH_PASSES.engineView` (matrix = camera matrix x engine colour units; `hdtvGamma`; views matched in the gamma domain, no extra scaling), used by CPU and GPU through `viewColors`. Effect on the fitted difference against the EXRs with our own depth: 5b8b8107 2.20 -> 2.18, b4-4 1.60 -> 1.58, b4-1 / 09eba2d6 unchanged. Not yet ported: CorrectChromaticAberrationImage on the views.

### Depth views rendered the engine's way (RefocusSimpleMultiAperture / ProjectMultiAperture, read from the code)
- `ProjectMultiAperture`'s flags are cfg 0x380 (geometry error table) and cfg 0x2660 (ray table), both on for ILLUM: every depth-view ray goes through the geometry table (direction), the aperture test on that direction, the ray table (origin), and is splatted bilinearly at lambda 0 into the view the ray's direction falls in (MNOAPTask::Run 0x100496080: per-ray aperture raster lookup, per-aperture image, 4 taps). Each view is a circular window of radius 0.12 pitches at the ring point (0.25 pitches, 45 degree steps) or the center.
- Chromatic aberration correction (CorrectChromaticAberrationImage, a per-channel radial scale from the static `blitzen_info` table of 10804 entries by zoom / focus step) is gated by cfg 0x26d8 = false for ILLUM, so it is not applied; confirmed on the output: the red / green / blue scales of our picture against the engine's differ by under 0.0005 (the table would give 0.006).
- Implemented as an option (`settings.engineViews` or `__lytro.engineViews`): `lytroSplat(.., {views, sensorRaster})`, `prepareEngineViews` in worker.js (CPU only). Results on b4-1 against Lytro Desktop's pre-adjust picture (fitted difference): match-only depth with the old views 1.32, engine views on our grid 1.27, engine views on the engine's own raster read through DmResampler 1.36 (sharpness 0.94); depth correlation with the engine's map 0.926 (old), 0.945 (engine views), 0.955 (engine raster). In the default combined style all three are 1.34 to 1.36. On the other photos the engine views help 09eba2d6 and b4-4 slightly (1.61 -> 1.56, 1.58 -> 1.54) and hurt the dark 5b8b8107 (2.18 -> 2.32), where the depth correlation drops (0.76 -> 0.59), so the remaining gap is in the match / solver on low light, not in the views' geometry.
- The depth magnitude against the engine's (slope 0.89 with engine views) is not a pure view-offset scale: scaling the matcher's offsets by 0.9025 gives slope 0.99 on b4-1 but not on the other photos (0.65, 0.47, 0.36), where shrinkage dominates.

### Depth solver pieces read from the code (no change needed unless noted)
- `BuildEdgeAdaptiveSmoothnessCost` (0x1001fbf00): right and down weights = 1.0 unless |dR| + 2|dG| + |dB| to the neighbour exceeds 0.2, then 0.5; same as `trwsVolume`.
- `CrossSkeletonImage` (0x1001df380): arm grows while the max-norm RGB difference to the anchor and to the previous pixel is under thr1 (0.04), and, after 17 steps, the anchor difference is under thr2 (0.025); at most 33 pixels; same as `crossArms`.
- `CrossBasedDataCostAggregation::filterOneSlice` (0x1002fb060): rounds alternate (even: vertical arm of the horizontal segments, odd: the reverse), each a line-integral-image sum divided by the summed segment length; same as `aggregateCross`.
- `MRFSolverTRWS::updateReweightedMessage` (0x1003018c0): out = gamma x belief - reverse message, forward and backward pass min(out[i], out[i-1] + slope), then min(cap, out - min); same as `send` in `trwsVolume`.
- One difference found and fixed: all of the above (arms, flatness blend, smoothness weights) run on the view image the cost compares (gamma domain, colour matched), not on a separate square-root image normalised to its maximum. With the engine's view colours the guide is now that image (`DEPTH_PASSES.engineView`; `passes.sqrtGuide` restores the old one). Fitted difference b4-1 1.32 -> 1.30, depth correlation +0.002 to +0.004 on the four photos tried.

### Black level (Metadata::findBlackLevelFromLut, InitializeBlackLevelOverridePointsBlitzenVersion1_1)
The engine's black level is a table over the sensor's analog gain (GetSensorAnalogGainGr) and the exposure duration, with four points all at one exposure value: gain 1: 64.08, 2: 64.87, 4: 65.12, 8: 66.39 counts (of 1023). The photo's metadata carries the same value rounded to a whole count (gain 1: 64, 1.5625 / 2 / 4: 65, 8: 66). `cameraInfo` now uses the table (linear between the points, constant beyond; `__lytro.noLutBlack` restores the rounded one). Effect on the 3 dark / high-gain photos against Lytro Desktop's pre-adjust pictures is inside the noise of the fitted score (1.80 vs 1.78, 1.13 vs 1.12, 1.31 vs 1.30; the fit's per-channel offset absorbs most of a 0.4 count shift), unfitted MAE equal to 0.03.

### Hot pixel correction (HotPixelCorrectionImage::SimpleCorrection 0x10044c640, operator() 0x10044c4b0)
The engine corrects only the pixels of the camera's calibration list (HOTPIXEL.BIN; the dark-image detector runs only when the list is empty), and only 3 or more pixels in from the border. The estimate is the mean of the two same-colour neighbours 2 pixels away along the smaller gradient (vertical |v(-2) - v(+2)| + |v(-1) - v(+1)| against the horizontal one, vertical on a tie), and the pixel is replaced only when it is above 1.2 times the estimate (cfg 0xa18) or above 0.99 of full scale. `fixHotPixels` follows that when a list is given (`listedHotPixels`); without a list it keeps the old median search (`__lytro.heuristicHot` forces it).

### Colour matrix by temperature (SensorCcm::getLinearlyBlendedCcm 0x1002f8330, LfeWhiteBalanceCct)
The sensor metadata lists matrices at 2850, 4150 and 6500 K (`devices.sensor.perCcm`). The engine takes the one at or beyond either end, otherwise blends the entries just below and above the photo's temperature linearly (the computed white balance temperature, or the user's when the white balance is overridden). The photo's stored `image.color.ccm` is exactly that blend at the as-shot temperature (b4-1: 4982 K gives 2.37697 against the stored 2.37695). `blendedCcm` / `engineCcm` apply it to the exact colour path, so a changed white balance temperature moves the matrix as well as the gains.

## Picture frame: the whole sensor, axes along the sensor

Lytro Desktop's picture (2022×1404 for a 7728×5368 capture) is the whole sensor, aligned with the sensor's
axes, not the lens grid's. One output pixel is `rowStep / scale` sensor pixels wide (scale 3.2366), and output
pixel k has its centre at sensor position `(k + 0.5) * spacing - 0.5`. At a render scale s the splat position is
`(l + 0.5) * s - 0.5`. Every render path now uses this frame: the sampler (`render.js`), CPU and GPU splats,
the depth views, user depth lookups, the lattice phase and the GPU view pass. Against the engine's pre-adjust
render, the fitted error on b4-1 went from 0.96 to 0.43, with scale 1.0158 -> 0.9999 and the shift at 0.
One latent bug surfaced with it: after lens-centre calibration the pattern removal kept using the first pass's
weights; it now takes the second pass's.

## Unsharp mask works in L*, not linear Y

The engine's unsharp mask blurs and thresholds the Lab lightness L* (a and b untouched), not linear luminance.
Calibrated against the engine's own render of b4-1 at its 2022 px width (the blur is 0.38 lens pitches, about
1.4 px there, so calibrate at that width, not on a small render): fitted error 1.92 with no mask, 1.64 with the
old linear-Y mask, 1.21 with the L* mask (amount 1.5, soft threshold 0.4 L*, sigma 0.38 pitches; amounts 1.35 to 1.8
fit equally). A halo limiter built from the gradient-mask table fitted worse and is not used. CPU (`engineUnsharp`)
and GPU (`USM_BLUR`/`USM_APPLY`) agree within one level.

## Picture size: the base grid covers the sensor (ceil, not round)

The engine's 2022 x 1404 picture is 625 x 434 lens-row steps times the 3.2366 scale (floor). The count is the
sensor divided by the row step, rounded up so the picture covers the whole sensor. Rounding to nearest gave 624
(2019 px) on photos whose row step is a little above nominal (b4-2), which looked like a +1 px x shift when scored.
With ceil all photos are 2022 x 1404 and the fitted error against the pre-adjust renders is: b4-2 0.72 to 0.67,
154bedc9 0.54 to 0.39, 5b8b8107 1.03 to 0.74; the remaining shift is 0.4 to 0.6 px in y (x is 0 to -0.1).

### Unsharp mask: the engine's full parameterisation (replaces the single fitted amount)
"Normalized Lab" in the engine's mask is L* / 100, so its soft threshold 0.004 is 0.4 L*: the L* reading and the engine's constants agree
(a linear-Y reading, with threshold 0.004 on Y, fits worse at every amount: 1.67 against 1.21). Each pixel's blur and amount now come from the
engine's baseline bank: sigma = r(lambda) lens pitches, amount = a(lambda) x G(total gain), the four-channel parameter map smoothed by a Gaussian of
0.003 x the picture width, the blur level per pixel, masking 0. Tables (piecewise linear, in `ENGINE_USM`): r: 0.40 outside -12..12, 0.36 for -8..8, 0.38 at +-9;
a: 0.40 outside -10..10, 0.45 at -8, 0.50 at -3, 0.45 at 0, 0.50 at 3, 0.45 at 8; G: 3.0 at gain 1, 2.0 at 3, 1.7 at 32, 1.0 at 120. Total gain = analog
gain (metadata devices.sensor.analogGain) times the digital gain above ISO 640. The depth comes from the render's own depth (`state.usmDepth`); the CPU
(`engineUnsharp` with an `engineUsmMap`) and the GPU (`USM_BLUR`/`USM_APPLY`, the map as an RG32F texture) agree within one level.
Check on b4-1 with the engine's own depth: fitted error 1.23 (constant 1.5: 1.21), so the per-lambda tables change little at gain 1; the gain table is what
matters on high-ISO photos (b4-2, gain 8: amount x0.65; fitted error 1.32 either way, edge ratio 1.043 against 1.065 for the gain-1 amount).

### Noise reduction (Neat Image, `NILib`): what it changes, and why it is not ported
The engine runs `NILib` (`resources/bin/NILib.dll`, 1.4 MB, the full Neat Image engine with CPU and GPU paths) on the picture with the default luminance / colour
amounts of 50. Measured by rendering the same photo with the engine's NR on and off (recipe `viewLuminanceNoiseReduction` / `viewColorNoiseReduction` 0) and scoring our picture
against both (fitted difference): b4-1 1.23 against the NR render, 0.89 against the no-NR render; b4-2 1.32 and 1.09. The two engine renders differ by a mean absolute
0.82 (b4-1) and 0.76 (b4-2) grey levels, almost all of it in a / b (rms change dL 0.20, da 0.95, db 1.04 on b4-1; 0.20, 0.80, 1.23 on b4-2), so NR is the largest single
stage still missing. Our picture carries 8% (gain 1) to 26-38% (gain 8) more a / b high-frequency energy than the engine's, with no colour bias (under 0.25 L*).
It is not a linear filter: a six-band linear regression of the change on band-passed no-NR chroma explains 33-53% of its variance, a Gaussian 16-46%, an L-guided joint
bilateral on a / b 39-56% (best of 36 parameter sets), so an approximation would remove only a third of the NR gap and is not shipped. The library itself is tiled
(96 px tiles with 40 px overlap, worker threads), control-flow obfuscated (state mutation around every call, scrambled vtables) and stripped (1398 functions, biggest
10 KB; entry points `NIFilter` 0x180003980 -> `FUN_180018130`), so reading the algorithm and the camera noise profiles is a separate large job. Ghidra project:
`scratchpad/ni/proj` (import done, function / string lists in `scratchpad/ni`). Probe tools: `tntrun/rec_edof_nonr.json` (the default recipe with both NR sliders at 0).

### Zoom-step "residual shift": none (it was the scorer)
With the frame and size fixes, the engine and the app were rendered at a constant depth of lambda 0 and 25 (`--depth-in`, a flat 541 x 376 map) on b4-1 and b4-2. A phase correlation of the two
2022 x 1404 pictures, without any registration step, finds them aligned to 0.00-0.07 px in all nine tiles (centre and corners) on both photos, at both depths. The 0.3-0.6 px
"shift" that `score_gt.py` / `linscore.py` print is a bias of their affine registration (it warps about the picture centre in pixel-corner coordinates), not an offset between the
pictures; it is the same at lambda 0 and 25 (b4-2: -0.5 and -0.6), so the old "depth-proportional shift" of zoom-step photos was only the old frame and size. Geometry is closed.

## Noise reduction: NILib (Neat Image) ported (`core/enginenr.js`, `core/enginenr-profiles.js`)

The engine's noise reduction is the Neat Image library (NILib.dll) run on the colour-matrixed picture, before the tone curve (step 10), in ProPhoto-D50 gamma 2.2 planes 0..255
(CopyIn: clamp, x^(1/2.2) x 255 through a 65536 entry table; CopyOut the inverse). The port was checked against the real library (Unicorn emulation of the DLL, plus the Wine harness):
tile helpers, one level, one channel, the noise maps and whole pictures of many sizes, profiles 10/12/14/17 (`test/enginenr.test.mjs`, golden output from the library; max error 0.02 of 255, mean 0.001).

- Profiles: "502" format, 18 in tnt.exe (the ILLUM's are 10..17), keyed by total gain (1.32 .. 41.11), the nearest key wins (`nrProfileIndex`). A profile holds per channel (Y, Cb, Cr) a type, 12 scalars, 3x63 control floats (9 control points)
  and the A (88 B) / B (640 B) blocks. The luma strength is `YNRAmountVsTotalGain` (`nrLumaStrength`: gain 1 -> 0.1, 4 -> 0.133, 8 -> 0.2); the colour strengths are 1.5 / 1.5; every other setting 1.0. The engine runs at slider 50.
- Colour: BT.601 YCbCr (offset 127.5, 0.2989/0.5866/0.1145, Cr = (R-Y) 0.713165, Cb = (B-Y) 0.564653).
- Filter: 3 level pyramid (2x2 box down, 0.75/0.25 bilinear up). Per level: Z = X / (sigma + 1e-4), 3x3 box RMS, soft limit, 8 (luma, radius 4) or 4 (chroma, radius 3) directional box filters along digital lines
  (angles 0, pi/2, pi/4, 3pi/4 and atan(0.5), atan(2), ...; offsets rint(k tan + 0.25)), energy per direction, argmax direction, clamp-affine weights, carried maps. Straight lines mirror at the ends, diagonals use a truncated window,
  lines shorter than 2r+1 their whole mean. Tiles 96 core + 16 context. Noise sigma maps come from per-level LUTs indexed by the 2x2-averaged intensity, mixed through the squared YCbCr matrix.
- In the app (`worker.js` `engineNrOn`): raw photos in the Lytro look with the exact engine colour, pictures at least 1000 px wide (the profiles describe the engine's own size), `settings.engineNr !== false`, sliders `engineNrLuma` / `engineNrColor`
  (50 = the engine). The GPU path reads the picture back for it. About 14 s at 2022 x 1404.
- Result against Lytro Desktop's default-recipe pictures with its own depth (registered, fitted MAE): b4-1 1.23 -> 0.86, b4-2 1.32 -> 1.00. NR off against its NR-off pictures: 0.89.

## Depth estimator (shipped Windows tnt.exe; `core/enginedepth.js`)

Reverse-engineered from the PE (Ghidra) and checked stage by stage against dumps taken under Wine with a hook DLL (vtable patching, return-address hijacks, real engine functions called on synthetic inputs). It differs from the Mach-O reading in several places; the PE is what the app ships.

- Raster: 541 x 376 (one sample per lens pitch). Labels: whole lambdas -35 .. floor(infinityLambda)+3 (max 100), padded to a multiple of 4.
- Views: 9 (eight on a ring of radius 0.25 at 0,45,..,315 degrees, indices 0..7, centre last at index 8). Each view is colour-rendered hdtvGamma(engineTone(clamp(M x rawlin))), M = ccm x engineScale, then MatchColor against the centre (mean/variance). The app's `DEPTH_VIEW_RING` has the centre at index 4: permutation `[0,1,2,3,5,6,7,8,4]`.
- Cost: bilinear samples at (x + lambda u, y + lambda v); per view min(L1 sad, 0.2); cost = 1.25 x the sum of the 4 largest of the 8. Float32 arithmetic including the floor-by-rounding tie at integer positions (the only source of the last 0.2 % of mismatches).
  A pixel's label vector is zeroed if any label's mean ring colour exceeds 8 x 0.95 or the cost curve is flat (value at rank ceil((L-1) x 0.5) minus the minimum < 0.075).
- Aggregation: cross arms (tau1 0.04, tau2 0.025, max 34, long 17), 4 alternating rounds, blended with a Sobel map (lo/hi) smoothed by a 5-tap Gaussian sigma 1 whose truncated border weights are renormalised (replicate, mirror, zero and erf borders all fail).
- Edge cues 1.0 / 0.5 (threshold 0.2); TRW-S: 4 message volumes, belief order data + M0 + M1 + M3 + M2, gamma 0.5, slope 0.1, truncation 6, 10 iterations, two alternating sweep orders.
- Sub-label: parabola on the beliefs (nearest index; the Mach-O used the data cost with floor index and fails), then a 3x3 median.
- Verified: cost volume 8.1M entries, no mismatch above 1e-5; aggregation under 2e-5; TRW-S labels 100.000 % identical; final map identical; the whole chain on the engine's own views 99.8 % identical pixels.
- Our views vs the engine's: the tone spline lowered the colour error 0.035 -> 0.0044; raw sharpen amount for the depth views fits at 0.35 (`VIEW_SHARPEN`); remaining raw per-pixel difference about 0.0085 (the engine's are smoother; the splat kernel is not exact yet).
- Own depth against Lytro Desktop (fitted MAE): b4-1 1.36 -> 1.01 (engine depth 0.86), 5b8b8107 1.35 -> 0.78 (0.74), b4-4 1.34 -> 0.81 (0.69), b4-2 1.96 (1.00, open: zoom step 11 geometry).
- Opt-in: `settings.engineViews` or `__lytro.engineViews` (CPU only, minutes).

### Depth views, second pass (hooked MNOAPTask::Run, 0x140269aa0 in the PE)
- The aperture raster handed to the multi-aperture projection is 256 x 256: 9 label discs (183..188 cells, radius 7.65 cells = 0.06 pitches; ring discs at 31.9 cells = 0.25), weights binary, lookup `(int)(dir * 127.5 + 127.5 + 0.5)`. The window radius is 0.06, not 0.12 (view coherence with the engine's views 0.6 -> 0.9). Four bilinear taps, weight = raster value (as ported).
- The engine's views are smoothed after the splat, the fitted separable kernel is about [0.17, 0.66, 0.17] (premultiplied colour and weight; the reconstruction filter bank at lambda 0 for a 7728 px standardized image gives [.183 .718 .183]); raw sharpen amount refitted 0.35 -> 0.2.
- The app's heuristic hot pixel test in `correctedPlane` (isDefect) is not in the engine (impulse test patterns survive in its views): only the calibration list is corrected; the exact path no longer runs it.
- Result: b4-2 raster depth against the engine's own 97.5 % within 0.5 lambda (mean abs 3.29 -> 0.47); own depth renders vs Lytro Desktop: b4-1 0.91 (engine depth 0.86), b4-2 1.06 (1.00).
- Open: for b4-2 the engine's view colour matrix fits the perCcm blend at about 3500 K (as-shot 2984 K): the engine's own AWB (awb2.cpp, 0x14025c050 / 0x14025bda0) decides the temperature.
- Colour temperature of the views (open): best-fit perCcm blend temperatures against the engine's view colours: b4-1 flat 5000..5500 (as-shot 4982), b4-4 about 3300 (3381), b4-2 about 3500 (2984), 5b8b8107 about 3200 (2763). The engine does not read the camera's `computed.cct`: it converts the white balance gains to a temperature and tint itself (PE 0x14016f5b0, inverse 0x14016f9c0) through a calibration table at config +0x19b0 (16 byte entries, cct at +0xc, built from the sensor's normalizedResponses, a single point at 5100 K in the metadata, plus its own illuminant data); the table is not decoded yet. Views use the as-shot matrix until it is (`__lytro.viewCct` overrides it for experiments).
- GPU depth views: `lytroSplatGpu` takes `views` (windows u, v, r^2): the splat vertex shader tests each ray's direction against the windows (a ray is in at most one, the discs do not overlap), places it at lambda 0 on the engine raster through the ray table's origin (bilinear, no depth march, no z test) and writes into a stack of W x H targets, view k in rows k * H. The plane pass skips the heuristic defect test when only the calibration list applies (`listedOnly`). Against the CPU views on b4-1 (software GL): mean relative alpha difference 1.2 %, colour 0.001, 2.7 % of texels differ by more than 5 % (edge rays); 150 s on SwiftShader. The post-filter ([.17 .66 .17]) and the estimator stay on the CPU.
- Default (owner's decision): raw photos with the engine's tables measure depth the engine's way (engine views, GPU or CPU, and `core/enginedepth.js`, match style); `settings.engineViews = false` or `settings.depthStyle` restores the blend / classic styles. b4-1 with no flags: fitted 0.91.
- Whole-library check with the new default (raw photos, own depth, fitted MAE in grey levels against Lytro Desktop's pre-adjust pictures): 017c4fd7 0.44, 09eba2d6 0.52, 154bedc9 0.39, 16d960f3 0.36, b4-4 0.70, 5b8b8107 0.75; against its default-recipe pictures: b4-1 0.91 (unfitted 1.13), b4-2 1.06 (unfitted 2.18).
- b4-2's final colour: the as-shot matrix is the best for the final picture (unfitted MAE 2.18; a matrix blended at 3300 K 2.66, 3600 K 3.15), so only the depth views use the engine's other temperature; the unfitted gap (fitted 1.06) is a per-channel gain (R x1.03 in display space). The engine's gain to temperature conversion (0x14016f5b0) uses a calibration table whose source is not found: config +0x19b0 is only zero-initialised in the product constructors; metadata supplies a single `normalizedResponses` point (5100 K: r .764, g 1, b .742, the white balance gains of b4-1 at 4982 K are 1/response). `__lytro.cct` overrides the as-shot temperature for experiments.

### White balance (AWB2, `LFE::AWB2`, PE 0x14025c4b0 and friends), found by inline hooks on the running engine
- The engine does not use the camera's white balance gains: it recomputes them (recipe viewWhiteBalance auto) from a 541 x 376 RGB + luma image (engine colour units divided by the camera's gains) and only then converts them to a temperature (0x14016f5b0) and picks the colour matrix. Camera gains (metadata) against the engine's: b4-1 (1.2742, 1, 1.3409) / (1.2716, 1, 1.354); b4-2 (1, 1.0224, 1.7773) / (1, 1.0206, 1.8182); b4-4 (1.1285, 1, 1.7587) / (1.1368, 1, 1.7749); 5b8b8107 (1, 1.0586, 1.9227) / (1, 1.0477, 1.98). Views and the final colour use the ratio engine / camera on top of the matrix at the as-shot temperature.
- Pipeline (ILLUM, config values dumped from the object at +0x18): optional 2D Gaussian on the image (sigma 2..4, from the gain thresholds 1 -> 1, 8 -> 4); module correction scale = default responses (0.7516, 1, 0.7453) / the photo's normalizedResponses; per pixel with luma in [0.005, 0.5]: chroma coordinates u = (log2 R + log2 B - 2 log2 G + 1.45) x 56, v = (log2 B - log2 R + 1.7) x 20 (R, G, B scaled by the responses), a 64 x 64 4-bit table (LUT1 at obj+0x20, rows reversed; LUT2 at obj+0x1020 blended by the low-light weight, exposure x gain against 0.005 .. 0.006) gives a weight that is cut by a factor ramp of v (36 .. 48) times the ROI weight (mode 1: (0.75 H - y) / (0.75 H)); the weighted mean of the unscaled colours gives gains max / mean; the total weight x 0.0625 blends them with the camera's gains between 2048 and 6144; then a cct (table of r/b -> cct: 2300 .415, 2800 .529, 3800 .737, 4200 .818, 6700 1.322, 10640 1.803) and an additive correction by cct (7 knots 2300 2800 3100 3900 4800 6700 8000, tables per colour blended by the low-light weight); finally divided by the smallest. b4-2: LUT stage (1, 1.0808, 2.0577) at 2610 K, final (1, 1.0206, 1.8182); the port reproduces the LUT stage to 0.2 % and the correction exactly.
- AWB image (verified against the engine's own, correlation 0.998 on b4-1): one colour sample per lens, the raw picture at the lens centre of the engine's lattice, bilinear between the four pixels (each pixel in its own Bayer bucket), (raw - black) / 1023 divided by the modulation frame normalised by its mean per colour (values under 0.02 dropped), scattered bilinearly onto the 541 x 376 raster at (centre x / pitch - 0.5, centre y / pitch - 0.5); alpha is BT.601 luma. A wider disc or the depth views do not match (corr 0.8 .. 0.95). Exposure x gain (shutter.frameExposureDuration, analogGain) and the photo's normalizedResponses are the other inputs. Ported as `core/enginewb.js` (`awbImage`, `engineAwb`, `awbPost`; tables in `enginewb-tables.js`), LUT stage within 0.3 % of the engine's on all six photos tried (b4-1 1.2679 / 1.3533 against 1.2716 / 1.354).
- Use: the depth views take the stored matrix times the engine's gains over the camera's (b4-2 against the engine's views: colour error 0.0120 -> 0.0067, b4-1 0.0066 -> 0.0061); the final picture takes its matrix blended at the engine's temperature and not the gains (b4-2 unfitted 2.18 -> 2.01, fitted 1.06 -> 1.02; b4-1 1.13 -> 1.18, fitted 0.91 -> 0.93; applying the gains as well gives 1.02 on b4-1 but 3.51 on b4-2, so something else about the final pipeline's colour is still unexplained: the engine's illuminant blend stages, `BlendIlluminant`).
- Whole library (own depth, default path, fitted MAE against Lytro Desktop's pre-adjust pictures): 2bc3358c 0.36, 57f2af75 0.61, aae68775 0.75, b4-3 0.32, d24cf288 0.53, eba001cb 0.65, f72b3923 0.98 (0.98 with the gain fitted on midtones; the plain mean gives 1.72 because the engine's picture carries highlights up to 4.5 where ours stop near 1.3: the window of that photo, raw saturated, comes out at 2.5 in the engine's linear picture against 1.26 in ours, and between 0.85 and 1.2 ours is 15 to 25 % low). The engine does not stop at white: its saturated pixels keep the demodulation gain; not ported (the highlight response measured on constant stripes, see above, is the likely rule).
- Saturated raw pixels (a blown window, f72b3923): the engine's linear picture there is 2.5 where ours is 1.26. Measured against the local saturated fraction (engine G / ours: 1.1 at 2 .. 10 %, 1.65 at 10 .. 25 %, 1.5 at 25 .. 50 %, 2.1 at 50 .. 75 %, 2.5 at over 75 %); a constant factor on saturated pixels fitted on the displayed (clipped) picture: 1.25 MAE 1.06, 1.4 0.91, 1.6 0.95, 2.0 1.01, 2.6 1.10 (against 1.18); restricted to pixels whose four same-colour neighbours are saturated as well 1.4 gives 0.86 and leaves wire glints alone (b4-1 0.93 -> 0.94 fitted). `SPLAT.satBoost` 1.4, CPU and GPU. The engine's real rule is not this (its response grows with the saturated area).

## Highlight response, measured on constant raw photos (engine, exposure -3)
- The engine's response to a constant raw level L (every sensor pixel = L, b4-1 geometry) is smooth and neutral from L about 950 up to **1002**, and then jumps at **1003**: display 106.7 (L 1000..1002) -> 142.3 (L 1003..1023, still slowly rising with L - 64). 1003 = 0.98 x 1023 rounded up, the `SaturationState` threshold (cfg 0xfd8 = 0x3f7ae148 = 0.98, mask = mosaic > 0.98). So the mask is on the raw white-normalised mosaic, and the step is the engine's saturated-pixel handling, not a smooth highlight curve. The jump is about x1.77 in linear light against the unsaturated neutral value at the same level.
- A 64 px checkerboard of 700 / 1023 does not come out as a checkerboard: the output varies only 108..112 (G, display) between the blocks, so the saturated handling is not pointwise (a large-radius low-pass is involved: the YCbCr `SharpenRecoverHighlights` IIR on Y, or the chroma suppression neighbourhood max). G sites saturated alone (R/B at 700) give a strongly coloured G-heavy result (R 0, G 153.7, B 9.6 display), R/B sites saturated alone (G at 700) give (147.6, 99.6, 147): colour suppression depends on which channels saturate.
- Code map (Mach-O tnt, symbols): `ILLUM` Blitzen 1.1 config sets SaturationRecoveryType 1 (0xfb8; the earlier note that it defaults to 2 is wrong for ILLUM), saturation threshold 0.98 (0xfd8), ChromaSuppressionMapEvaluationType 1, BlendIlluminantType 1, blend colourspace 2, 0x10d8 = 0.55, ChromaSuppressionType 0 (0x1108), 0x1128 = -0.8, 0x1140 = -0.3, 0x1158 = 4.0, 0x1170 = 6.0. `SaturationRecoveryDiffusion` (20 sweeps: masked pixel = max(own, mean of 4 same colour neighbours), then optional min with the Color4 limits) does nothing on a constant field, so it cannot produce the step. `ChromaSuppressionMap::Init` (0x1001a2b80) builds a per pixel map from the gained mosaic (value x WB gain, clamped 0..1, looked up in a 4001 entry table built from a SparseFunction in the config vector at 0x1018 - empty in the ILLUM scalar config, so filled somewhere else) and, for evaluation types other than 2, a 3x3 neighbourhood max; `BlendIlluminantTask::Run` (0x100196ac0) transforms every pixel to the blend colourspace, derives per channel ratios against thresholds (0x28..0x34), multiplies by the map and blends the two chroma channels toward 0 (neutral), then transforms back. `SharpenRecoverHighlightsYCbCrPostfilterTask::Run` (0x1003604f0) only changes the luma: lowpass + w(Y) x detail + (1 - w(Y)) x max(detail beyond a threshold, 0) with w falling toward 1 in highlights.
- Not done yet: the exact luminance rule for saturated pixels (the x1.77 step) and the config knots for the chroma suppression table. `SPLAT.satBoost` (1.4 on saturated pixels with four saturated same-colour neighbours) stays only as the stopgap fit until the engine's own rule is ported.
- ChromaSuppressionMap weight curve (`InitializeChromaSuppressionMapWeightCurveBlitzenVersion1_1`, config vector 0x1018): knots (x, y) = (0, 0), (0.6, 0), (0.75, 0.2), (0.84, 1.0), x = clamp(mosaic x WB gain, 0, 1). So a pixel whose gained mosaic value is 0.84 or more is fully chroma suppressed; this is why the engine's constant photos are neutral from raw level about 950 (gained green 0.84). `DemosaicImageLF::processImage` carries no saturation mask (it only clamps negatives and optionally median filters the colour difference). On the engine's constant photos the luma per unit signal is flat (about 0.90 post matrix for every level from 700 to 1002, saturated 1.59), so the step at the mask is a luma gain of x1.77 on saturated pixels, applied after demosaic; the stage that does it is still unidentified (candidates: the luma path around `SharpenRecoverHighlights`/`BlendIlluminantSharpenGain`, whose constructors take the SaturationRecoveryType and the sensor CCM).
- Engine view images on the constant photos (hook dump `viewimg`, post matrix, tone and gamma, clamped 0..1): raw level 1000 -> 0.939 mean in all three channels (neutral, 0.81 at the vignetted edge, 0.95 in the centre), raw level 1015 (saturated) -> exactly 1.0 in every channel everywhere (also at the vignetted edge), 700 -> (0.966, 0.720, 0.963), 950 -> 0.923 neutral. G sites saturated alone -> G 1.0 with R and B negative (-0.51 / -0.11 minimum), R/B sites saturated alone -> R = B = 1.0, G 0.89. So a saturated mosaic pixel contributes the clamp level in the view domain regardless of the flat field, which is consistent with the engine setting masked pixels to a limit instead of scaling them. The magnitude above 1 cannot be read from these views (clamped); the final picture gives x1.77 over the unsaturated neutral level (post matrix 1.5931 against 0.9016 per unit signal). The AWB lens-centre colour image (hook dump `awb_pix`) shows no step between raw levels 1000 and 1015 (ratio 1.016), so the step does not exist in that path.
- Engine gains of the constant photos (b4-1 geometry): (1.268, 1, 1.353) against the camera's (1.274, 1, 1.341). The ratio of the engine's saturated level to our white-balanced white clip is about 1.71, close to gR x gB = 1.716 (not verified; a coincidence is possible).
- Windows build RTTI names that locate the stage classes (symbols are stripped, class names are not): BlendIlluminantTask, BlendIlluminantSharpenGain (vtable 0x1405ff9f0, slot 1 0x14029b4a0, 3992 bytes), BlendIlluminantYCbCrTask (slot 0 0x14029f420), ChromaSuppressionMapTask (slot 0 0x1402b5600, slot 2 0x1402b6110), SharpenRecoverGainTask (slot 0 0x14029a5e0: the YCbCr highlight sharpen followed by a colour transform and a uniform gain on R, G, B), SharpenRecoverHighlightsYCbCr*, ProcessRawImage. Decompiles of these are in the scratch folder; BlendIlluminantSharpenGain slot 1 has not been read yet and is the next candidate for the luma step.

## Saturation recovery is active (found with the hook dump of BlendIlluminantTask's input, Windows 0x140299bf0)
- Dumping the Color4 lightfield image that enters `BlendIlluminantTask::Run` on the constant raw photos (levels 1000 and 1015) showed that the x1.6 step is already in that image, i.e. before the chroma suppression, the highlight sharpen and the colour pipeline. Per unit signal the saturated image equals the unsaturated one at the rim of each lens disk (maxima 2.54 and 2.48) and is far higher at the disk centre (minima 1.54 / 1.23 / 1.69 against 0.88 / 0.68 / 0.93 for R / G / B): the demodulation gain (1 / modulation) is large at the rim and about 1 at the centre, and valleys are filled from the rim - exactly `SaturationRecoveryDiffusion` (20 in-place raster sweeps: masked pixel = max(own, mean of the 4 same colour neighbours)), run on the demodulated, white balanced mosaic. ILLUM's SaturationRecoveryType is 1, so it is on (an earlier note claiming type 2 was wrong).
- The mask is `raw / 1023 > 0.98` (raw 1003 up; 1002 / 1023 = 0.9795 is not masked), matching the step between 1002 and 1003 on the engine's constant photos.
- Port: `diffuseSaturation` in core/lytroedof.js (called by completePlane) on the CPU; on the GPU the sweeps are sequential, so `saturationOverride` computes the masked pixels' values on the CPU from a 9 x 9 box around the mask and the completing shader (`uSat`) takes them. `SPLAT.satBoost` (the fitted x1.4) is gone. Result on the constant photos (our central crop, linear): saturated / unsaturated(1000) per unit signal 1.84 against the engine's 1.77 (before: 1.0; with the fitted constant: n/a).
- Hook tooling: the Windows build keeps RTTI class names, so `hook.c` can hook any task class; `install_short` (11 displaced bytes) at 0x299bf0 and `install_inline` at 0x29a5e0 dump a 512 x 96 window of the Color4 image at entry (`bi_in_*`, `bi_gain_in_*`). The DLL builds with `clang --target=x86_64-pc-windows-msvc -O2 -fno-stack-protector -c hook.c` and `lld-link /dll /entry:DllMain /nodefaultlib /def:hook.def hook.obj kernel32.lib` (it needs its own memset).
- Whole library after the diffusion (own depth, default path, fitted MAE against Lytro Desktop's pre-adjust pictures; before in brackets, the last full run): 017c4fd7 0.42 (1.06), 09eba2d6 0.50 (1.38), 154bedc9 0.37 (0.88), 16d960f3 0.35 (0.62), 2bc3358c 0.36 (1.22), 57f2af75 0.57 (1.57), 5b8b8107 0.73 (1.91), aae68775 0.64 (1.02), b4-1 0.41 (1.04), b4-2 0.67 (1.03), b4-3 0.31 (0.68), b4-4 0.69 (1.24), d24cf288 0.50 (2.30), eba001cb 0.49 (1.33), f72b3923 0.58 (1.89). The fitted gain of the blown-window photo f72b3923 is now 1.334 like the others (1.087 before: the old fit was compensating the missing highlight lift) and the fitted scale is 1.000 everywhere (1.016 before), i.e. the diffusion also removed the global 1.6 % scale that had been compensating for it.

## Engine units and white balance after the saturation fix (15 library photos, camera-RGB pictures against the engine's pre-adjust EXRs)
- The scorer's "gain" (ratio of the overall means) is the engine's colour scale: gain x engineColorScale(G) = 0.93 .. 1.01 on all 15 photos (0.98 to 0.99 on 11 of them), e.g. 1.32 at the wide zoom (b4-1), 1.92 at 33 mm (16d960f3): the factor grows with focal length because the engine normalises the modulation by the whole-sensor mean while ours uses the lens centres, and `engineColorScale` already carries exactly that ratio. The earlier idea that an unexplained per-photo exposure factor exists is wrong.
- The camera RGB comparison also depends on the white balance gains: ours uses the file's, the engine's picture uses its own AWB2 gains. Per channel (midtones) ours / engine = (camera gain / engine gain) / engineScale, to within a smooth residual tilt that depends on the colour temperature (R, B relative to G): 2337 K (5b8b8107) R 0.985 B 1.028; 2612 K (b4-2) 0.976 / 1.022; 2786 K 0.985 / 1.020; 3039 K (16d960f3) 0.976 / 1.043; 3157 K 0.992 / 1.018; 3605 K 0.998 / 1.013; 3817 K (eba001cb) 0.999 / 1.036; 4052 K 1.005 / 1.014; 4791 K (b4-1) 0.999 / 1.002; 4800 K 0.996 / 1.002; 6013 K (f72b3923) 0.997 / 0.991. So after the gains and the units, the engine's picture has R about 1.5 % higher and B about 2 to 4 % lower than ours below 3500 K, vanishing at 4800 K. That tilt is the colour step still unexplained: candidates are the illuminant blend (`BlendIlluminant::Create` takes the matrix blended at the engine's temperature and a three value gain vector from the lightfield, cfg 0xac0 off) and the response normalisation of the sensor at the picture's temperature.
- The apply function of `BlendIlluminantYCbCr` (Windows 0x1402a0930) runs the blend task, then sets the image's colour space (2 or 3) and attaches the matrix blended at the temperature (the lightfield's transform), i.e. the camera to output matrix is carried with the image and applied later.
- The blend stage does not make the temperature dependent R/B tilt: the whole-image mean colour entering `BlendIlluminantTask` (hook dump, Windows 0x140299bf0) and the engine's pre-adjust picture differ by the same R/G x0.9927, B/G x0.9877 on b4-2 (2612 K) and on b4-1 (4791 K) (the lightfield mean and the refocused picture weight pixels differently, so a constant is expected). The tilt is therefore already in the lightfield colours before that stage, or in how the two sides weight pixels. The lens-centre colours agree (the AWB port, which reads them, reproduces the engine's gains within 0.3 %), so the difference is off-centre: candidates are the colour dependence of the vignetting normalisation (the photo carries its own modulation frame and `modulationExposureBias`; `AdjustModulationForIllumination` and `ComputeDiskCenterModulationValues` are empty in the 4D demodulation class) and the demosaic. Our lightfield mean (demosaiced corrected plane, engine gains) is R/G 1.024 B/G 0.993 against the engine's blend input 1.0735 / 0.952 on b4-2 and 1.010 / 1.008 against 1.023 / 1.009 on b4-1, but the two sides average different pixel sets (the engine's includes the whole standardized image), so this is not yet a like for like test. Next: hook the demodulation output (the image after `ProcessRawImage`) in the mosaic domain, where both sides have the same pixels.
- Pixel-level check of the colour tilt (hook dump of the blend task's input window on b4-2, 512 x 96 px at the sensor centre, same sensor grid as ours): our demosaiced corrected plane and the engine's image correlate at 0.995 (relative rms 10 %), so the stages line up. Per colour the engine / ours ratio, by distance from the lens centre (units of pitch): G/R 0.964 at r 0.03, 0.952 at 0.28, 0.930 at 0.47; B/R 0.984, 0.960, 0.908. Ruled out as the cause: the black level of the raw pixels (G/R does not move with it; B/R at the centre is matched by +3 but the radial fall stays), the black of the modulation frame (0 / 0.5 / 1.5 x: overall level only), smoothing the modulation frame over the disk (same colour Gaussian 1.5 .. 5 px: G/R and B/R unchanged), and a shared modulation profile for all colours (the frame's own G/R is flat inside r 0.4 and 0.92 at the rim, the observed drift starts at the centre). Windows classes for the bitmap demodulation (the ILLUM uses `DemodulationAlgorithmBitmapDatabase`; the 4D class is never called): `DemodulationBitmapDemodulateSubset` and `DemodulationBitmapReweightSubset` each run once for the whole image; their task objects hold pointers to a state object (vtable 0x1405f08a8), a second one (0x1405f0740) and parameter blocks (0x1404bf6f0 holds 1.0, 1.0; 0x1404ad2d0 holds 0.5); the reweight step (`Demodulation...ReweightSubset`, Mach-O `ApplyReweighting`) is the candidate for a colour dependent weight that depends on the position in the disk.

## The engine depth estimator on the GPU (gpu/enginecost.js, gpu/depthmatch.js engineSolveGpu)
- Timing of the CPU estimator on b4-1's 541 x 376 views with 64 labels: cost volume 12.3 s, cross aggregation 3.6 s, TRW-S 7.6 s, finish 0.05 s (23.6 s in all). Now all of it runs on the GPU when there is one; the CPU versions stay as the fallback (a `throw` in either GPU stage hands that stage back to the CPU) and as the reference.
- Cost volume: one draw per four labels, the bilinear taps by integer fetch with the engine's clamping, top four of eight by sorting. The engine floors `p + 1` on its own in float32, so for a tiny negative `p` (such as the ring view at lambda 0.25 x sin) the upper tap is 1 and not 0; using `floor(p) + 1` was wrong at the picture border and is not what the engine does. The two whole-pixel rules (any label blown out; flat cost curve) need every label of a pixel and run on the CPU after the read-back (about 0.1 s).
- Aggregation, smoothing and finish: the older GPU module's shaders implement the same rules as the engine's CPU stages (arm growth with the max norm, Sobel flatness, arm sums in alternating order, raw / aggregated blend, the scan order of the message passing), so `engineSolveGpu` reuses them with the engine's constants; two things were added: the flatness Gaussian with 5 taps and edges renormalised over the taps inside (`uTap`), and a finish shader with the engine's rule (first smallest belief, parabola kept when it moves less than one label, then the interior 3 x 3 median).
- Checked against the CPU on the engine's own views (b4-1, a 270 x 188 crop, 64 labels): cost volume identical, final depth identical (largest difference 0, 50 760 pixels). On a synthetic test (61 x 47, 12 labels, in `test/enginecost-gpu.test.mjs`) the cost volume is identical and the depth differs by at most 2e-4. Timing on a real GPU is not measured here (the software GL renderer is draw-call bound: the message passing is 20 passes x (w + h - 1) diagonals).

## Noise reduction on the GPU (gpu/enginenr.js)

`nrFilterGpu` runs the NILib port on the GPU: tiles of identical shape are batched into one R32F atlas per plane, every step (colour transform, sigma pyramids
through the 257-entry profile LUT, the 3-level pyramid, per-level directional box means, blend weights, M/I propagation, tile paste) is a fragment pass over the
whole atlas, and the digital lines are looked up from small tables (`al`, per-row records). Against the CPU port (`test/enginenr-gpu.test.mjs`): line filters
3e-5, whole filter worst 0.013 of 255 (chroma), mean 1e-5.

Two traps found on the way: (1) a sampler left at its default unit can alias the render target and make the draw fail with INVALID_OPERATION - every
declared sampler is now bound; (2) recycled textures can hold NaN/Inf, so accumulators are cleared with a constant, never `0 * v`. `worker.js` uses the GPU
path when a GPU is present (`__lytro.noGpuNr` forces the CPU), falling back to the CPU on any error.

The post-splat view blur (worker.js VIEW_KERNEL, `filterPremultiplied`) is a 3-tap separable filter on the engine's 541 x 376 raster: a few milliseconds
on the CPU, so it stays there. The two whole-pixel cost rules are 0.1 s and stay too. With the noise reduction ported, no step of the engine path that costs
more than a fraction of a second is left on the CPU.

## Colour tilt: it is the engine's modulation plane (found with a new hook dump)

Hook change (hook.c, class 13 = `DemodulationBitmapReweightSubset`): the task's state holds two full-sensor float planes (7728 x 5368): the engine's
normalised modulation plane (state member 0x10, header at +0xe8; mean about 1.0, range 0.2 .. 1.46) and the demodulated input (member 0x18, +0x20).
Dumped for batch4-2, batch4-1 and 5b8b8107 (`dd/rwm*`).

- Substituting the engine's plane for ours (modulation frame rebuilt as `E * mean_c + black`) removes the radial colour tilt in the pixel comparison:
  G/R 0.972 .. 0.979 and B/R 0.987 .. 1.004 flat over r = 0.03 .. 0.47 (was 0.964 -> 0.930 and 0.984 -> 0.908), correlation 0.9954 -> 0.9967,
  relative rms 10 % -> 8 %. So the tilt is entirely the modulation normalisation; demosaic and the rest line up.
- The engine's plane equals ours in the lens centre (within 0.2 %) and differs at the disc rim, more for B than G than R, more on the +u side (B up to
  +19 % at r 0.45 .. 0.5 on the +u side). Per colour it is close to linear in ours: E = 0.975 O + 0.027 (R), 0.913 O + 0.112 (G), 0.796 O + 0.259 (B)
  on b4-2; the same fit on b4-1 and 5b8b gives different constants (implied black 22/23/25 on b4-1; 60/-9/-94 on 5b8b), so the rule depends on the photo.
  The frame is not just (m - black) / mean.
- Ruled out: a weighted (m^2) demosaic (G/R still 0.93 at the rim), a sub-pixel shift, a pure spatial smoothing kernel (a 5 x 5 or 9 x 9 fit leaves 50 %
  of the difference), a blend with the per-lens template, a blend of the neighbouring calibration white images (MOD_0022 .. 0030), and
  `RemoveIlluminationVariation` (sigma 30 Gaussian high-pass per Bayer phase plane, floor 1/65536: locally an identity).
- Fit() order (Mach-O 100462990): InterpolateModulationBitmap -> (if cfg 0x2408 off) average the two green means -> correctAllHotPixelsInModulationImage
  (cfg 0x23f0) -> removeModulationImageOutliers (flag 0x2b6a) -> RemoveIlluminationVariation (flag 0x2b6b) -> floor -> divide by the per-colour mean ->
  floor. `PerformInitialDemodulation` (100465 3d0) calls `CompensateBitmap` once (flag 0x2b69, state +0xa0) before the demodulate tasks.
- Open lead: `CompensateBitmap` (1004642c0). Per colour it builds 8 x 8 block means of one image (x 1/16 for R and B, 1/32 for G), smooths them
  (SpatiallyFilterImage), fills a 30 x 30 table indexed by (block mean x 30, (1 / pixel of the other image) x 8.5714) with bilinear weights holding
  sum(1/pixel) and sum(pixel / mean), divides, and rewrites the second image as pixel x table(mean, 1/pixel). That is a photo-dependent, level-dependent,
  colour-dependent remap, which is what the data shows, but a first emulation (block means of the photo raw as A, our plane as B) anti-correlates with the
  engine, so the roles / scalings of the two images are not yet right. Next: hook CompensateBitmap's two image arguments (before / after) and read the
  config flags 0x2b69 / 0x2b6b for the ILLUM.

### Colour tilt, round 2 (hooking CompensateBitmap, curve of the plane)

- `CompensateBitmap` (tnt.exe RVA 0x1e3a70, hooked with a 15-byte displacement) is never called for b4-2: its config flag (0x2b69 in the Mach-O build) is
  off for the ILLUM, so that lead is closed. (Hook note: the Ghidra project `p160` is the Mach-O / Middleware image, whose offsets are not tnt.exe's; locate
  tnt.exe code by scanning for the constant's RIP-relative reference and the `.pdata` entry, as done here.)
- The engine's plane is a deterministic, smooth, curved function of the modulation value at the same pixel, per colour: for pixels with the same value
  (e.g. R = 300) E is identical (0.5710) except a few corrected pixels, and the curve is the same in the centre, edges and corners to about 0.01 (the small
  drift is RemoveIlluminationVariation's smooth shift). It is not linear: the slope of the green curve falls 20 % between 250 and 525 and rises again to
  750 (b4-2: G 250 -> 0.401, 400 -> 0.680, 600 -> 1.000, 750 -> 1.256). The curve differs per colour and per modulation frame (b4-1 and 5b8b have their own),
  so it is not a fixed camera curve either, and (m - b)^p / a m^p + c fits leave 1 - 3 % errors with no common p.
- Everything in Fit() that is pointwise (hot pixel fix, outlier replacement, floor, divide by the per-colour mean) is linear in the value, so the curve has
  to come from the accumulate / interpolate stage (InterpolateModulationBitmap: weighted sum of whole-image samples chosen by zoom / focus, with a black
  value returned by the sample selection and zeroed when its bool argument is false) or from the frame's own metadata (CompressionSimulation runs the
  lossy codec only when the compression config is on). Next: hook AccumulateModulationImages' arguments (black, weights, sample ids) and the sample list
  for b4-2 (zoom 80 / focus 650 is exactly calibration node MOD_0026) to see which frames and weights the engine used.

### Colour tilt, round 3 (accumulate hook, what the engine's plane is)

- `AccumulateModulationImages` (tnt.exe RVA 0x1e4fc0, hooked) runs once for b4-2 with ONE sample (weight 1.0, index 0) and a black argument of 4100.0 on
  the 16-bit scale = 64.0625 on the 10-bit scale (the modulation frame's metadata black is 64; ours used the photo's measured 66.39). So the plane is not
  a blend of several calibration whites. The photo is not at the frame's calibration node (b4-2: photo zoom 11 / focus 600, frame node zoom 80 / focus 650;
  b4-1: photo 471 / 1179 = node 33, 5b8b: 159 / 912); `modulationExposureBias` in the photo metadata is about -0.245 on all three.
- The engine plane E is, for the bulk of pixels, a deterministic smooth monotone function of the pixel's own modulation value per colour (residual
  0.008 .. 0.012 against 3 free curves, the noise floor of the corrected pixels). A common per-colour curve with a per-photo scale explains R and G to 1 %
  and B to 3 % across the three photos; in normalised units E - N (N = (m - 64.06) / mean) is +0.17 at N = 0.45 for B, +0.07 for G, +0.01 for R, falling to 0
  at N = 1.35 (b4-2, 5b8b). On b4-1, whose photo sits on a calibration node, the lift is 4 .. 5 times smaller. In count terms the curve equals
  (m - b'_c) / M_c with b' = 56 / 3 / -64 (R / G / B) on b4-2, 22 .. 25 on b4-1, 60 / -9 / -94 on 5b8b.
- Equivalent descriptions that fit about equally (rms against E, b4-2, central region): a per-colour radial scale about every lens centre (R 0.996, G 0.977,
  B 0.941; centre offsets under 0.05 px; b4-1: about 0.985 for all colours), or an additive position-in-lens profile per colour. The pointwise curve fits best.
  None of them is derived from a known quantity yet, so nothing was changed in the app. `ApplyDemodulation` is a plain per-pixel division by the plane, so
  the whole effect sits in how the plane is built from the frame (Interpolate / Accumulate / Fit).

- Correlates found (3 photos only): the big lift of the plane (E - N up to +0.17 for B) occurs on the two photos with analogGain 8 (b4-2, 5b8b; photo black 66,
  as-shot blue gain 1.78 / 1.92) and is 4 times smaller on b4-1 (analogGain 1, black 64, blue gain 1.34, photo on a calibration node). The mean of E over the
  sensor is not 1 per colour (b4-2: 1.002 / 1.022 / 1.049; b4-1: 1.010 / 1.007 / 1.009; 5b8b: 0.998 / 1.016 / 1.038), so the plane is changed after the
  mean normalisation (a lift of the dark rim), and the lift tracks the photo's analog gain / white balance, not the frame. Next: hook `Fit` after each of its
  stages (or read the pointwise curve on a photo with analogGain 1 and a non-node zoom, and one with gain 8 on a node) to separate the two causes.

### Colour tilt, round 4: the plane depends on the photo's white balance gains

Controlled series (photos taken at nearly the same zoom / focus, 479 / 1146 .. 1207, so the same calibration node, with analog gain 1, 2, 4, 8; hook dump of the
plane for each): the lift E - N of the engine's plane over ours changes with the photo, not with the frame. Per-colour linear fit of the median curve
(E = (m - b'_c) / M_c; m is the frame's pixel value):

| photo | analog gain | as-shot gains r / g / b | b'_R / b'_G / b'_B |
|---|---|---|---|
| 2bc3358c | 1 | 1.30 / 1.00 / 1.34 | 24 / 25 / 25 |
| 017c4fd7 | 2 | 1.34 / 1.00 / 1.28 | 24 / 23 / 8 |
| batch4-4 | 8 | 1.13 / 1.00 / 1.76 | 39 / 8 / -25 |
| 09eba2d6 | 4 | 1.10 / 1.00 / 1.85 | 42 / 4 / -35 |
| batch4-2 | 8 | 1.00 / 1.02 / 1.78 | 52 / -3 / -72 (far from its calibration node) |

For R, b' is about 145 - 93 w_R (24 .. 52 for w from 1.34 to 1.0); for B about 179 - 115 w_B for the photos on the node (the far-from-node photo goes lower
still). So the engine builds the modulation plane with something that depends on the as-shot white balance gains (and, a little, on the distance of the photo
from the frame's node), e.g. the plane is white balanced / clipped before the division, or a colour-dependent term enters the black. Our plane uses neither.
Next test: apply the as-shot gains to the frame (m * w_c - black) before the per-colour mean normalisation, and the radial / pointwise residual against the dumps
(`dd/ser_g1 .. g8`, `dd/rwm*`, frames via `extmod.mjs`) will say if that is the missing term.

## Colour tilt solved: the engine's demodulation plane (core/enginemod.js)

The radial colour tilt came from the plane the engine divides each photo by. It is not the white image over its mean; after the per-colour mean it runs a response correction that lifts the
dim rim of every lens disk (most for blue). Found by dumping the plane at every stage with hooks (tnt.exe, Fit at 0x1e6230 and the methods it calls), then decompiling the stages.

Stage by stage (all checked against the plane dumped from the running engine, same run):
1. `Accumulate` (0x1e4fc0): one sample, weight 1.0: `P = expand16(m) - 4100`, where `expand16(m) = m << 6 | m >> 4` (the 10 bit white image as a 16 bit sample) and 4100 = expand16(64), the white
   image's own black (its metadata `black.r`; the photo's black is not used).
2. Hot pixels (0x1e5f20): the photo's `hotPixelRef` list (HOTPIXEL.BIN, 401 976 pixels on b4-2) is replaced by the mean of the not listed, not negative neighbours in the radius 2 diamond (12 pixels),
   every neighbour scaled by `mean(target phase) / mean(its phase)`. Pixels within 3 of the border keep their value. **Format fix**: the column word of an entry is `(xB << 16) | xA`, the row word
   `(yB << 16) | yA`, i.e. the two pixels of an entry have their own columns (our parser used xA for both; the two readings differ at about 5000 entries).
3. Outlier removal (0x1e0670, flag 0x6632 on; values above 3.5 x the phase mean are replaced) did not change any pixel in the frames tested; not ported.
4. Division (0x1e08c0): `A = max(0.02, max(1e-6, P) / M)`, M the mean of P over the whole plane per Bayer phase, the two greens averaged. Then **stage 1** (0x2bc7c0): `S1 = A / max(A)`.
5. **Stage 2** (0x2b92a0, with 0x2bc0a0 and 0x2ba550): per phase, `norm` = the 0.998 quantile of S1, `tile` = the 100 x 100 grid of phase means (cell = floor(100 x / W), floor(100 y / H)) divided by
   its centre cell (50, 50); `S2 = S1 * curve[c][clamp(floor(4096 * S1 / (tile * norm)), 0, 4095)]`. The curve is the first entry (key 2300 K) of the 4-entry table at 0x1408a5e50
   (4 x 4096 floats, channel order R, Gr, B, Gb). The table is keyed by colour temperature and `FUN_1402baf30` should interpolate between neighbouring keys, but on all three photos
   tested (2610, 3821, 4803 K) the result equals the 2300 K entry exactly, so the port uses it alone (`enginemod-tables.js`).
6. Rescale (0x1e2610, the float argument is the photo's colour temperature, unused in the end): `E = S2 * D(A) / D(S2)`, D the mean over the central third of the lens centres of the colour at the
   lens centre, so the disk centres keep their level. Greens use the average of the two green phases.

Results: S1 reproduced to 1e-6 rms, S2 to 6e-5, the rescale to 0.05 %. Effect on the engine comparison of b4-2 (pixel level, blend input): the radial drift of G/R (0.964 -> 0.930) and B/R (0.984 -> 0.908)
is gone (0.973 .. 0.990 and 0.988 .. 1.028); correlation 0.9954 -> 0.9967. Whole picture against Lytro Desktop's render (b4-2): MAE 1.30 -> 0.95, fitted 1.14 -> 0.61, shift +2.7 / +1.7 px -> -0.1 / -0.6, scale 1.0183 -> 0.9999.
Everything about "photo dependent" was the frame's own statistics (tile means, quantile): the table is the same for every photo.

Ruled out on the way (see the round notes above): CompensateBitmap (never called), RemoveIlluminationVariation (flag off), the colour temperature interpolation, calibration whites.
Tooling notes: `hook.c` gained a vectored exception handler that single-steps writes to one page of a plane (tells which routine writes a pixel and the value after each writer), an aligned trampoline
for mid-function hooks (`align_mode`), and float argument capture (xmm0..3) in the short hook; `tnt.exe` is imported into Ghidra as project `ptw` (image base 0x140000000) for Windows decompiles.
The engine's runs differ slightly from run to run in the plane's rim (the quantile and the disk centre means are sums over threads); use planes from one run when comparing stages.

Library after the engine plane (own depth, default path, fitted MAE against Lytro Desktop's pre-adjust pictures; before in brackets = after the saturation diffusion): 017c4fd7 0.43 (0.42), 09eba2d6 0.49 (0.50),
154bedc9 0.36 (0.37), 16d960f3 0.32 (0.35), 2bc3358c 0.36 (0.36), 57f2af75 0.57 (0.57), 5b8b8107 0.71 (0.73), aae68775 0.63 (0.64), b4-1 0.41 (0.41), b4-2 0.61 (0.67), b4-3 0.32 (0.31), b4-4 0.68 (0.69),
d24cf288 0.50 (0.50), eba001cb 0.46 (0.49), f72b3923 0.56 (0.58). The unfitted MAE (the engine's own colour units) falls on most photos (09eba2d6 1.65 -> 0.68, 2bc3358c 1.41 -> 0.68, 57f2af75 2.15 -> 0.79,
5b8b8107 2.19 -> 0.92, b4-1 1.32 -> 0.72) and the shifts against the engine's picture are 0 .. -0.7 px (b4-2 was +2.7 / +1.7) with scale 0.9995 .. 1.0000. The setting `engineModulation: false`
(or `__lytro.rawModulation`) returns to the plain white image.

### AWB reads the plain modulation frame (regression from the engine plane, fixed)

The engine's white balance (`crgb2cct` at 0x16f5b0 in tnt.exe) was hooked on 017c4fd7 and 09eba2d6: it receives the gains (1.3013, 1, 1.6512) and (1.1171, 1, 1.8517). The port, once the demodulation plane
(`core/enginemod.js`) replaced the plain frame as the AWB image's divisor, gave (1.3164, 1, 1.6296) and (1.1447, 1, 1.8405) (1 to 2.5 % off, temperature 4151 K against 4052 K). With the plain frame
divided by its mean per colour (the image the engine's AWB uses) it gives (1.3022, 1, 1.6529) and (1.1181, 1, 1.8527), within 0.1 % of the engine. `loadModulation` keeps the frame on the plane (`.frame`)
and `computeEngineWb` uses it. The R +2.6 % / B -2 % offset found when comparing ours with the engine's picture per channel was this.
Note: `linscore.py` compares camera RGB before any gain, so it cannot see a white balance change; colour checks need the final picture or the hooked gains.

Check after the fix (017c4fd7, camera RGB before the blend stage, ours x engine colour scale x engine gains / camera gains, against Lytro Desktop's pre-adjust picture, box mean 9 px, by brightness):
at 0.02 .. 0.15 R 1.007, G 0.993, B 0.987; at 0.15 .. 0.4 R 1.001, G 0.987, B 0.993 (R/G +1.5 %, B/G about 0). The whole offset that was R +2.6 % / B -2 % is gone; what is left is about the constant
the blend stage is known to add (R/G 0.9927, B/G 0.9877). Above 0.4 the picture diverges (B/G 1.09) because the compared plane is before the chroma suppression and highlight stage (`bisgFilter`), which the engine's picture already includes.

Blend stage read again (Windows `tnt.exe`, 0x140299bf0 chroma suppression task, 0x14029f420 `BlendIlluminantYCbCrTask`, 0x1402a0680 its constructor, 0x1402a0930 apply). The constructor takes the
photo's colour matrix M (metadata +0xd0 .. 0xf0, blended at the engine's temperature), its inverse, the gain vector g and the target white vector, and stores the offsets `M.target - M.(1/g)` (luma at +0x10 / +0x14,
chroma at +0x18 .. , per row). The YCbCr task multiplies by g when bit 0 of its flags is set, computes a weight per pixel from the local neighbour differences (scaled by 1 / (+0x30)) clamped to 0 .. 1, and mixes the
pixel's Cb and Cr toward those offsets by that weight, times (weight + 1 + (+0x34)). The chroma suppression task (matrix at +0x50, inverse at +0x80, weight curve from the saturation map) is what `bisgFilter` ports.
Not yet checked against the engine pixel for pixel: the (weight + 1 + (+0x34)) factor of the YCbCr task and whether the ILLUM sets the gain flag; the R/G +1.5 % left in the midtones is the candidate effect.

### The blend stage's matrix is the file's lowest-temperature matrix (hooked)

Hook on the chroma suppression task (tnt.exe 0x299bf0, object dumped at entry, `bi_task10`): thresholds -0.8 / -0.3 / 4 / 6 (as in `bisgFilter`), forward matrix at +0x50 (columns Y, Cb, Cr; rows by input colour)
and back matrix at +0x80 (Y, Cb, Cr to XYZ, first column the D65 white). Multiplying them out and removing the XYZ of sRGB gives exactly the file's 2850 K matrix (2.0063 -0.5363 -0.4700 / -0.6019 1.8361 -0.2341 /
-0.8173 -1.6435 3.4608) on 017c4fd7 and the same bytes on 09eba2d6 (different as-shot matrices 2.3132 and 2.109, AWB temperatures 4052 K and 3157 K). So the stage is independent of the photo's colour:
`bisgMatrix` (lytroedof.js, also the GPU path) now takes the lowest temperature entry of `perCcm`; `__bisgAsShot` brings the old behaviour back. The YCbCr task (0x29f420) is never called with the ILLUM config
(hooked, no hit), which settles the open question about its gain flag and the (weight + 1 + offset) factor.
Effect on 017c4fd7 against the engine's picture is small (bright bin 0.4 .. 0.8 B/G 1.0945 -> 1.0924, midtones unchanged): the excess blue in bright pixels (B/G 1.09, 1.22 above 0.8) comes from elsewhere
(saturation recovery on the demosaiced image, not the matrix).

`SharpenRecoverGainTask` (0x29a5e0) object hooked on 017c4fd7: mode (+0x38) 1, sharpen amount (+0x40) 0.25, post gain (+0x48) 1.0. So the uniform gain at the end of that task is 1 and the highlight
threshold is -infinity (mode other than 2), as `bisgFilter` has it: nothing there explains the saturated / unsaturated ratio of 1.84 (ours) against 1.77 (engine). That ratio is left to the saturation
diffusion itself (`SaturationRecoveryDiffusion`: its sweep order and whether the GPU 9 x 9 box stands in for the 20 sequential sweeps faithfully).

### Response curve table: entry 0 at every temperature (dumped S2 on two more photos)

`FUN_1402baf30` reads like a linear blend of the table's entries (keys 2300 / 2800 / 4100 / 6500 K, which differ by up to 0.59) around the temperature it is given, and the hook shows the temperature really is
passed (stage 1, 0x2bc7c0, xmm1: 4053.9 K on 017c4fd7, 5984.8 K on f72b3923). Yet the engine's own plane (S2 dumped after the stage, whole frame) equals the port with entry 0 alone: rms 6.5e-5 on
017c4fd7 and 5.4e-5 on f72b3923, against 2.2e-2 and 3.6e-2 with the blended curve. With the earlier photos (2610, 3821, 4803 K) that is five temperatures from 2.6 to 6 kK: the entry 0 only rule stands,
whatever the selection code does with its argument (not understood; the decompile of the selection loops is not trusted). `val2.mjs`-style check: run the plane on the photo and compare E / ratio with the dump.

### Correction: the engine's blend matrix is not the default (regression on the blown-window photo)

Full library re-run after the matrix change (fitted MAE, before -> after): all photos within 0.01 except f72b3923, 0.56 -> 0.71. With the as-shot matrix it is 0.56 again. The hook on f72b3923 shows the engine
uses the same 2850 K matrix there too, so the engine's matrix is right and something else in our highlight path is tuned around the wrong one. Folding the engine / camera gain ratio into the matrix (the pixels
reach the engine's stage with its gains) does not help (0.70). `bisgMatrix` therefore defaults to the as-shot matrix; `__bisgEngineMatrix` selects the engine's. Open: what compensates (candidates: the
saturated pixel values after the diffusion, which are 18 .. 28 % low in G and B in the blown window, and the chroma-suppression map).

### Blown-window check at the blend stage's input (f72b3923, hooked window)

`hook.c` reads `win.txt` ("row col") for the window `dump_win` dumps (512 x 96, default the sensor centre). On f72b3923 the blown window is in the top-right corner (79 % saturated in the top-right eighth);
the window at row 772, col 6376 is 45 % saturated. The engine's Color4 image at the entry of the chroma suppression task there (mean 1.166 / 0.779 / 0.787, maximum 4.05) against ours at the same point
(`__dmDump` in `lytroSplat`: the demosaiced, saturation-recovered image, scaled by the engine colour scale and gains / camera gains): correlation 0.9967 / 0.9926 / 0.9931; ours / engine by engine level
< 0.5: 0.98 / 1.00 / 1.00, 0.5 .. 1: 0.975 each, 1 .. 2: 0.98 / 0.98 / 0.97, > 2: 0.993 / 0.995 / 0.987. So the saturation diffusion, the demodulation and the demosaic agree to about 2 % even in the blown part:
the G / B shortfall of the final picture (18 .. 28 % in the brightest areas) comes after this point (chroma suppression + highlight sharpen, or the ray splat of saturated values), and the
2 % overall deficit here is the colour scale / gain ratio. Next: the engine's output of the chroma suppression task (`bi_gain_in`, in the blend colour space) against `bisgFilter`'s.

### Chroma suppression verified exactly against the engine (f72b3923 blown window)

The hook dumps `bi_in` (the Color4 image entering the chroma suppression task) and `bi_gain_in` (its output, entering `SharpenRecoverGainTask`) for a chosen window (`win.txt`: "row col"; here 772, 6376, 45 % saturated), plus
the task object (`bi_task10`: matrices, thresholds) and its converter (`bi_conv10`: D65 normalisation 1/0.95047, 1, 1/1.08883, Lab constants 500 / 200). `bi_gain_in` is (Y, a, b): channel 0 is the XYZ luminance
of the suppressed colour, 1 and 2 are Lab a, b (500 (fx - fy), 200 (fy - fz)). Solving the suppression factor per pixel from `Y_xyz = Y*Mb10 + k (Mb11 Cb + Mb12 Cr)` and comparing with the model
k = 1 - map * w (w the hue weight from -0.8 / -0.3 and 4 / 6, map = curve(0.4 R + 0.4 G + 0.2 B) of the per-colour 3x3 maxima of the black-subtracted raw / 1023, no gains): MAE 0.0003, correlation 0.999 over 26 000
pixels. So `bisgFilter`'s suppression is exact; every variant I tried first (per-pixel map, gained map, other neighbourhoods) was worse, and the early ones were polluted by an off-by-one window offset in my test.
What is left of the 18 .. 28 % G / B shortfall in the blown window is therefore not here: the luminance step after it (`SharpenRecoverGain` IIR on Y, weight B3(2Y)), the colour matrix used when the Lab goes back to RGB
(the engine goes back through the converter's matrix at +0x60), or the ray splat of the saturated values.

## Photos 4 and 6 colour gap (open)

Photo 6 (eba001cb) recipe: viewWhiteBalance "as shot", viewTemperature 2850, viewTint -30, whiteBalanceMode 0. Against Lytro's page JPEG (central 80%, ours/Lytro): default [0.918 0.834 0.760]; tint -30 [0.863 0.844 0.733]; tint +30 and 2850 K + tint -30 [1.00 0.851 0.752]; engine AWB gains on the display [1.64 0.74 0.62]. By brightness band the green and blue gap is about 0.8 at mid and high tones whatever the white balance, so it is a tone/exposure difference, not a white balance one (photo 7: [1.02 0.99 0.95]). cct2crgb (0x182de0 in the Mach-O) returns gains normalised so the smallest is 1, like the camera gains, so it does not explain it. Still to find: the engine stage that makes "as shot" pictures about 20% brighter.

### Photos 4 and 6: the library edit is "as shot" (measured, 2nd pass)

`edof_preview.jpg` in each library folder equals Lytro's page picture (mean ratio 1.005), so it is the exact colour target. Fitting three channel gains (applied before our colour matrix and the engine tone spline) that bring our linear render onto that preview (`/tmp/claude-0/fitgain.py`, 200x140 box downsample):
- batch4-2 (cct 2984, AWB): gains [0.997 0.985 1.021], rms 0.023 -> 0.016: our default is already right.
- eba001cb (photo 6, cct 2850, "as shot", tint -30): [1.248 1.277 1.354], rms 0.060 -> 0.025.
- 017c4fd7 (photo 4, cct 2850, "as shot", tint -30): [1.250 1.288 1.344], rms 0.049 -> 0.018.
So both "as shot" photos need the same near-uniform x1.28 plus about +3 % G, +8 % B over R. It is not the demodulation scale f (photo 4 has the usual 0.8176; photo 6 has 0.645, but the fit does not follow f). Photos 4 and 6 are the only ones whose capture cct is the table minimum, 2850. The app default is Auto; Lytro renders these two from the "as shot" override (cct2crgb at 0x182de0, gains over the smallest, calibration table at config +0x19b0 not decoded), so the comparison is not like for like until that table is decoded. `__lytro.printColor` prints the matrix parts.

### The engine's gains calibration table (decoded, hooked at config +0x19b0 on eba001cb)

Six entries of (r, g, b gain, cct): (0.815, 1, 1.964, 2300) (0.964, 1, 1.821, 2800) (1.212, 1, 1.645, 3800) (1.363, 1, 1.667, 4200) (1.516, 1, 1.147, 6700) (1.659, 1, 0.920, 10640). `cct2crgb(cct, tint)` (Mach-O 0x182de0, PE 0x14016f9c0): u_i = ln(g^2 / (r b)), v_i = ln(r / b) per entry; v(cct) linear between entries (clamped); p = mean(u) - tint; r = exp(-(p - v(cct)) / 2), g = 1, b = exp(-(p + v(cct)) / 2); all divided by the smallest. At tint 0 and 2850 K this gives (1, 1.0166, 1.858) against the camera's (1, 1.0423, 1.858): the same blue/red.

### As-shot gains: hooked (eba001cb)

With a recipe of viewWhiteBalance "as shot", viewTemperature 2850, viewTint -30 the engine calls `cct2crgb` (0x16f9c0) with (2850, -0.05, 0.5): the tint is viewTint / 600. With the table above that gives p = mean(u) + 0.05, r = 0.959, g = 1, b = 1.783 before the smallest-gain division, i.e. (1, 1.0425, 1.859) = the camera's own gains (1, 1.0423, 1.858). So the as-shot gains are the camera's gains; they are not what is missing. (Auto mode on this photo: crgb2cct receives the AWB gains (1.2669, 1, 1.7096), cct 3789.)
Engine output on photo 6 against the library preview (mean over the frame, engine/preview): auto recipe [1.64 0.74 0.59], which our render reproduces when the engine AWB gains are applied to the display ([1.64 0.74 0.62]); as-shot recipe [1.17 1.00 0.94] (the recipe fields alone do not reproduce the preview exactly). Our default (camera gains) is [0.92 0.83 0.76] of the preview, i.e. uniformly about 0.81 of the engine's as-shot output. So auto mode is right, and the as-shot path of the engine is a uniform x1.24 brighter than the same gains in ours. Not yet located: it is not the gains, the matrix (as-shot matrix fits the same) or the demodulation scale. Next: dump the stages of the engine's as-shot run against its auto run. (hook.c fix: cct2crgb's output pointers were being redirected like crgb2cct's, which made the as-shot picture green; now only crgb2cct is redirected.)

### The engine's custom / "as shot" white balance, ported (core/enginewb.js `cct2crgb`, `customGains`)

When a temperature and tint are set (a recipe's viewTemperature and viewTint, whatever viewWhiteBalance says: the engine's output for "as shot" equals "custom" byte for byte), the engine's final gains are the table gains N = cct2crgb(T, tint/600) scaled up uniformly until they reach its own automatic gains A in every channel: N * max(A / N) (it states the gains relative to the automatic ones and normalises to the smallest). Found by fitting one scalar between our render (exact gains N) and the engine at custom 2850, 3300, 3805, 4300, 5200, 6500, 8000 K on photo 6 and 3300, 4982, 6500, 8000 K on photo 7: the scalar stays at 1.0..1.5, equals max(A/N) within 1..4 %, and the colour fits within 2 %.
Against Lytro's library preview, photos with an "as shot" recipe: 017c4fd7 (5500 K, tint -30) ours/preview [1.03 1.00 1.00]; d24cf288 (2850, -30) [1.04 1.03 0.98]; eba001cb (2850, -30) [1.26 0.99 0.93] (was [0.92 0.83 0.76]); the shadows of eba001cb are still 40..50 % too red (its demodulation scale f is the outlier, 0.645 against 0.818). The engine run with our recipe guess differs from the preview by the same kind of amount (as-shot recipe on 017c4fd7 [1.02 1.00 0.96], eba001cb [1.17 1.00 0.94]), so part of that remaining difference is in the recipe state, not in the port.

### Photo 6 red shadows (open, measured)

Our as-shot render (2850 K, tint -30) against the engine run with the same recipe (`as6_i.png`): [1.08 1.00 0.98] overall, R 1.18 in the darkest band (G, B within 2 %). Not the matrix temperature (ccm at 3200 / 3500 / the engine's 3800: R shadows 1.14 / 1.10 / 1.06 but highlights fall to 0.95 / 0.92 / 0.90), not noise reduction (on or off: same), not the perspective in the recipe (engine output unchanged). A per-channel offset in the camera-linear data of (-0.0038, -0.0020, -0.0018) (about 3.6 / 2 / 1 counts of black) brings every band within 3 % (rms 0.0234 -> 0.0211, bands [0.99 1.0 1.0]), and raising the R black alone by 2 counts fixes R but lifts G and B by 4..7 %, so it is a small black level difference in all three channels, not R only. The metadata gives 168 for all four colours at analog gain 2 on every photo; the engine's black table is read by gain only here. Against Lytro's library picture the same render is [1.26 0.99 0.93]: the engine run itself differs from that picture by [1.17 1.00 0.94] (photo 4: [1.02 1.00 0.96]), a cooler balance in Lytro's picture that no recipe field explains (checked temperatures 2300..2850, tints -60..30, perspective).

### Black level, read from the engine (Metadata::findBlackLevelFromLut 0x1002f8970, caller 0x1003679c0, InitializeBlackLevelOverridePointsBlitzenVersion1_1 0x1004ed830)

The table is a vector of (gain, exposure, black / 1023) triples: (1, 0.03299, 0.062630), (2, 0.03299, 0.063410), (4, 0.03299, 0.063630), (8, 0.03299, 0.064900) (floats 0x3f800000.., 0x3d072b02, 0x3d804908 / 0x3d81dde8 / 0x3d825e08 / 0x3d84e8e8). `findBlackLevelFromLut` groups the triples by their first value (gain) into one `SparseFunction` per gain over the exposure, adds them to a `SparseFunction2D` keyed by gain, and evaluates it at (GetSensorAnalogGainGr, GetSensorExposureDuration): linear between the two neighbouring gain lines (clamped outside), and each line has a single exposure point, so the exposure does not matter. The result is ONE scalar for all four colours (the caller keeps it in one float), handed to `OffsetScaleAndClampRawImage(black, clamp (1e6, 1e6, 1e6, 0), mosaic)`: value = clamp(raw - black, 0, 1e6) with the same black for every colour (the constructor stores -black at +0x54, scale 1.0 at +0x50). If the LUT config (cfg 0x40) is off or empty the RawInfo black (+0x3c) is used instead. eba001cb has analog gain 4 (sensor metadata gr 4.0, iso 320): 65.12 = our value; the metadata's own black is 65 for all four colours. So our black level is the engine's; it cannot be the source of photo 6's red shadows.
Hook on the engine's blend-stage input (`bi_in`, window 4000 / 4800 of eba001cb, as-shot recipe): engine / ours (our `__dmDump`, smoothed 9 x 9) is a constant per colour at every level, R 0.778, G 0.577, B 0.554 (no offset), i.e. the engine's gains up to this stage are the automatic ones (G-normalised 1.294, 1, 1.711 against the AWB's 1.267, 1, 1.710) times the engine's colour scale (0.642 for G; f = 0.637 is the engine's own value, not an outlier of ours). So black level, demodulation and the automatic gains agree with the engine to about 2 % (R/G 2.1 % high). The red shadow gap is therefore after the blend stage's input.
