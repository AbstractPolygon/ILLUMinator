# tnt depth engine (DepthMapAlgorithmSimple) - cost volume and pipeline spec

Sources: `L<n>` = line n of `gh/tdec_d1.c` (the Ghidra C file). `ASM <addr>` = x86-64 disassembly of
`tnt/tnt_macho` (objdump -D -b binary --adjust-vma=0x100000000; Mach-O file offset = VA - 0x100000000) used where the C file has no
body. Constants were read from the Mach-O (`tnt/rd.py`). ILLUM config values are from `gh/illum_cfg.json` (offset -> value dump of
InitializeScalarParametersBlitzenVersion1_1, 1004e2bf0).

## 0. Two object layouts (needed to read offsets)

- `DepthMapAlgorithmSimple` (call it S) is built by the ctor at L4473-4634. S+0xe0 holds a copy of the whole ConfigurationParameters
  (CreateSubApertureImages gets `param_1 + 0x38` as `undefined4*` = S+0xe0, L4840). So a config offset `c` read through S is `S+0xe0+c`
  (e.g. S+0x1a38 = cfg+0x1958, S+0x1728 = cfg+0x1648).
- In the ctor, `param_2 + N` with `undefined4*` param_2 means cfg byte offset 4*N.
- `DepthMapState` (D): +0x08 labels vector<float>; +0x20 width, +0x24 height, +0x28 label count, +0x2c first label, +0x30 last label,
  +0x34 SizeF (sx, sy) pixel shift scale, +0x3c reference view index, +0x40 vector of views (stride 0xf8), +0x58 shared_ptr<DataCost>.
  Ctor: ASM 1001f80e0 (labels at 0x2c/0x30 L: ASM 1001f81d2-1001f81f8; SizeF store ASM 1001f8205; SetCenterIndex ASM 1001f85e0).
- View record (0xf8 bytes): +0x00 Vector2F (u, v); +0x08 Image<Color4f> sub-aperture image; +0x30 prefiltered copy; +0x58 spline-prefiltered
  copy; +0x80 Image<Color1f> depth (lambda); +0xa8 Image<Color1f> confidence; +0xd0 Image<Color1f> importance. (L2884-2937, L5081-5111, L6471-6497)

## 1. S member map with ILLUM values (member <- cfg offset : value)

| S+ | cfg off | ILLUM | meaning (as used) |
|---|---|---|---|
| 0x00 | 0x15d0 | -35.0 | first label (min lambda) |
| 0x04 | 0x15e8 | 100.0 | max lambda cap |
| 0x08 | 0x1600 | 1.0 | label step (also SubPixelEstimate step) |
| 0x0c | 0x17b0 | 1.0 | resolution scale; also SizeF (sx,sy) of D+0x34 |
| 0x10 | 0x17c8 | [0.25] | sub-aperture radii (vector) |
| 0x28 | 0x17f0 | [45] | sub-aperture angular steps in degrees (vector) |
| 0x48 | 0x1890 | 0 | MRF solver 0=TRW-S 1=BP-M 2=HBP (L5563-5716) |
| 0x50 | 0x1720 | 2.0 | max data cost per pixel (see 4.3) |
| 0x54 | 0x1738 | 10.0 | data cost scale (see 4.3) |
| 0x58 | 0x18b0 | true | TRW-S ctor flag |
| 0x5c | 0x18c8 | 10 | MRF iterations |
| 0x60 | 0x1768 | 0.5 | noisy-entry rule: median fraction and factor (see 5) |
| 0x64 | 0x1780 | 0.15 | noisy-entry rule: flat level |
| 0x68 | 0x1750 | 0.95 | blown-out level |
| 0x6c | 0x1630 | **false** | true = Birchfield-Tomasi cost, false = plain SAD (L6664 / L6752) |
| 0x6d | 0x1660 | **true** | true = cross-based aggregation inside createDataCostVolume (before the MRF); false = after (L4971, L5168) |
| 0x70..0x88 | 0x1678.. | 0.04, 0.025, 34, 17, 4, 1.0, 1.5 | CrossBasedDataCostAggregation(float,float,int,int,int,float,float) ctor args in this order (ASM 1003011b0 stores them at +0,+4,+8,+0xc,+0x10,+0x14,+0x18) |
| 0x8c | 0x1818 | 6.0 | smoothness truncation, divided by step in ctor (L4631) |
| 0x90 | 0x1830 | 0.1 | smoothness slope, multiplied by step (L4632) |
| 0x94 | 0x1848 | true | edge-adaptive smoothness weights |
| 0x98 / 0x9c | 0x1860 / 0x1878 | 0.2 / 0.5 | edge colour threshold / low weight |
| 0xa0 | 0x18e0 | true | 3x3 median on the final depth |
| 0xa1 | 0x1910 | true | run SubPixelEstimate |
| 0xa2 | 0x1bd8 | **false** | plane fitting OFF (so 0xa4..0xbc are unused) |
| 0xc0 | 0x1b30 | true | AdjustImportanceByImageContent |
| 0xc1 | 0x1b00 | **false** | DecreaseDepthEdgeImportance OFF |
| 0xc4 | 0x1b18 | 0.7 | (unused: edge importance factor) |
| 0xc8.. | 0x1b60.. | 0.1, 3.0, 0.5, 5 | DataCostAnalysisParameters (unused) |
| 0xd8 | 0x1b48 | **false** | ConfidenceByDataCostAnalysis OFF |
| 0xd9 | 0x1bc0 | true | DepthMapState::RemoveTemporaryData at the end |
| 0xdc | 0x1ea8 | 3.0 | label range extension past infinity (see 3) |
| other | 0x1618 | 25 | tiles per side for GetFocusImportanceFunction (not part of depth) |
| other | 0x1798 | true | MatchColor on |
| other | 0x1958 | 0.0 | view prefilter sigma (>0 would blur views): OFF |
| other | 0x1648 | false | spline-prefilter views: OFF |

Corrections to docs/lytro-re-notes.md: "+0x6d" is true in ILLUM and means aggregation BEFORE the MRF (the note had it inverted);
confidence (0xd8) and plane fitting (0xa2) and DecreaseDepthEdgeImportance (0xc1) are all OFF for ILLUM, so those rows need no reading.

## 2. Sub-aperture images

### 2.1 Which views (S::subApertures, L4854-4943)
```
views = []
for i in 0..len(radii)-1:                    # ILLUM: i = 0 only, r = 0.25, step = 45
    n = ceil(360 / step[i])                  # 8   (constants: 360.0 at VA 10086d060, pi 3.14159274, 180.0)
    for k in 0..n-1:
        a = k * step[i] * pi / 180
        views.append( (r*cos a, r*sin a) )
views.append( (0, 0) )                       # always appended last (L4926-4935)
```
=> 9 views: indices 0..7 on a ring of radius 0.25 at 0,45,...,315 degrees, index 8 = centre. Reference = first view with u,v ~ 0 =
DepthMapState::SetCenterIndex -> index 8 (ASM 1001f85e0). Ring order is the order the cost loop visits (list of non-ref views = 0..7).

### 2.2 How they are rendered (CreateSubApertureImages, L2814-3220)
- View count = vector bytes / 0xf8 (L2876). Size of every view = state size (W,H) (L2872: `param_3+0x20`).
- Each view i gets `ShiftedAperture(CircularAperture(0.12), u_i, v_i, CircularAperture(1.0))` (L2884-2891; radius constants: 0.12 at VA
  1006ca838, 1.0 at 1006beea0; signature from syms: ShiftedAperture(IAperture const&, float u, float v, IAperture const&)). I.e. a disc of radius 0.12
  (aperture units where the full lens is 1.0) centred at (u,v), clipped by the unit disc. Assumed argument roles (a=disc 0.12, b=unit disc);
  the clip role of b is inferred from the name/order, not from the body.
- Rendering = `RefocusSimpleMultiAperture(CircularAperture(1.0), apertures, 0, 0, config, SubsamplingPattern 0, 0)` then `operator()(lightfield, size,
  ImageSet out, noiseProfile, pool, status)` (L2943-2947; ctor/operator addresses 100339cd0 / 10033a650 in syms). So: refocus at lambda 0 (both float args 0), one
  RGBA float image per aperture, colour (RGB, alpha ignored later), full colour not gray.
- The `config` is NOT the user config: `GenerateSubApertureConfig` (L1876-1999) copies it and forces: cfg+0x740 false, +0x890 false (if orig +0x740 false;
  else +0x740 true, +0x758 false, +0x890 false; ILLUM orig +0x740=false, +0x890 was true -> forced false), +0x100=0, ParamVsGain(+0x598)=[{0,0}],
  +0x130=0, +0x118/+0x148/+0x160=1.0, +0x2398=false, +0x2380=false, GammaFunctionType(+0x178)=0 unless orig +0x18f8 true -> 3 (ILLUM orig +0x18f8 = true,
  so type 3), +0x24a0=false, ColorSpace(+0x26f0)=0, +0x2710=+0x2728=+0x2740=0, +0x2758=+0x2770=1.0, +0x2788=false, +0x2500/+0x2518/+0x2548/+0x2530=0, +0x2ae8=false.
  (These look like: sharpening/denoise/tone/colour/white-balance stages neutralised. I could not name each parameter.)
- Noise profile: `INoiseProfileProvider` is only forwarded into RefocusSimpleMultiAperture::operator() (L2947, L4840). It is not used anywhere in the
  cost code. How the renderer uses it is not visible here.
- Post steps (all on the 9 images):
  1. Reference stats (L2972-3031): Welford over every pixel of the reference view per channel (RGBA lanes): n+=1; d=x-m; m+=d/n; M2+=(x-m)*d;
     var = M2/(n-1) (the -1.0 const at VA 1006beea4), each lane floored at 1e-6 (VA 1006ca83c).
  2. If cfg+0x1798 (ILLUM true): MatchColor on every view except the reference (L3049-3083). MatchColor::Run (ASM 1001ff6e0) computes the same Welford mean/var
     of the view, then per pixel: `out.rgb = (in.rgb - mean_view) * sqrt(var_ref / max(var_view, 1e-6)) + mean_ref`; alpha lane gain = 1.0.
  3. If cfg+0x1958 > 0: Gaussian PrefilterImage (sigma = that value) -> view+0x30 (L3084-3146). ILLUM: 0 => off. The cost then reads view+0x08
     (raw) because `fVar99 = S+0x1a38 = 0` (L6486-6495).
  4. If cfg+0x1648: spline prefilter -> view+0x58 (L3147-3191). ILLUM: off.

### 2.3 State size (S::ComputeDepthMapState, ASM 1003a6bd0-1003a6d0a; L4801-4851)
`(W0,H0) = size at lightfieldLogic+8` (ASM call 100207a00), `b` = second component of a SizeF obtained from `logic.Model()` (1002c02b0 -> 100207a20).
height = (int)(H0/b + 0.5), width = (int)(W0/b + 0.5), then both multiplied by S+0x0c (1.0) and truncated. With the 7574 x 5264 standardized image this
matches ~541 x 376, i.e. b is probably the lens pitch (~14); I did not verify which field b is.

## 3. Labels (CreateLambdaSample, ASM 1001fd520)
```
lmax_eff = min( floor(logic.f48) + S.f3_0xdc(3.0), S.max(100) )       # logic.f48: LightfieldLogic ctor 5th arg (float) at +0x48, ASM 1002c0285; probably infinityLambda (unverified)
start    = S.min(-35)  if S.min < lmax_eff  else  lmax_eff - 1
labels   = [start, start+step, ... , <= lmax_eff]                       # step = S+0x08 = 1.0
while len(labels) % 4 != 0: labels.append(labels[-1] + step)           # padded to a multiple of 4
```
(floorf identified from the lazy-bind table.) Label l is an absolute lambda value (not an index). D+0x2c = labels[0], D+0x30 = labels[-1].
The padded labels are processed like all others by the cost loop (they have real costs).

## 4. Data cost (DepthMapCreateDataCostSimpleSubset::Run, L6164-7325)

### 4.1 Setup
- Strips of 0x28 = 40 rows are queued by createDataCostVolumePixelWise (ASM 1003aa3f0; the dispatch loop is visible in L6414-6453).
- `nViews-1 = 8` non-reference views; `invN = 10 / 8 = 1.25` (L6478: `fVar121 = S+0x54 / (n-1)`); `T = (S+0x50/(n-1)) / invN = (2/8)/1.25 = 0.2` (L6479).
- Per (label l, view v) shift table (L6578-6609): with `d = uv[v] - uv[ref]`,
  `shift_y = lambda_l * d.y * sy`, `shift_x = lambda_l * d.x * sx`, where (sx,sy) = D+0x34 = (S+0x0c, S+0x0c) = (1.0, 1.0) (SizeF built from one float,
  ASM 1003a6cef pshufd). Stored as Color2 (shift_y, shift_x) (store order: element[0] = y, element[1] = x; L6593-6594, used L6654-6655).
  (Also stored: shift +/- 0.5*unit(d)*(sx,sy), only used by the BT variant.)
- Sampled position in view v for pixel (y,x): `(y + shift_y, x + shift_x)` in pixel-index units (integer pixel = sample position, no +0.5).
  Sign: +lambda * (view - ref). Which image axis is u and which is v is decided by the renderer (I could not see that); u is added to x, v to y here.

### 4.2 Per pixel, per label (ILLUM path = S+0x6c false, S+0x1728(cfg 0x1648) false -> bilinear; L6664-6750)
```
R = ref[y][x].rgb                                   # RGBA from the reference view image (centre view)
acc = 0; sumc = (0,0,0)
for v in non_ref_views (0..7):
    p  = (y + lambda*dv_y, x + lambda*dv_x)         # dv = uv[v]-uv[ref]
    c  = bilinear(view_v, p)                        # floor, clamp-to-edge on both corners to [0,h-1],[0,w-1]; weights (1-fx)(1-fy), fx(1-fy), (1-fx)fy, fx fy
    sad = |c.r-R.r| + |c.g-R.g| + |c.b-R.b|         # mask const 0x7fffffff x3 at VA 10086acc0 (abs), alpha ignored (lane 3 not summed)
    acc  += min(sad, T)                             # T = 0.2   (L6745-6750)
    sumc += c.rgb
cost[y][x][l] = acc * 1.25                          # = (10/8) * sum_v min(SAD_v, 0.2)   (L7236); range [0, 2.0]
flag_sat |= ( max(sumc.r, sumc.g, sumc.b) > 8 * 0.95 )   # L7226-7235: mean view colour (any channel) above 0.95 at ANY label
after all labels:
if flag_sat: cost[y][x][0..L-1] = 0                 # bzero of the whole label vector (L7240-7242)
```
Layout: `cost[((row*W + col) * nLabels + l)]` floats, contiguous labels per pixel, rows from DataCost::Ptr(0,0,0) (L6470, L7236-7237).
No gradient and no census term in the ILLUM path. Comparison is only between each of the 8 ring views (at the shifted position) and the centre
view's pixel, over a 1x1 window (the window comes later from cross-based aggregation).

### 4.3 What the config constants mean
Per-view truncation 0.2 = (S+0x50 / (n-1)) / (S+0x54/(n-1)) = S+0x50 / S+0x54 -> **T = 2.0/10.0 = 0.2**, and the overall scale is 10/8 per summed view,
so total cost max = 8*0.2*1.25 = 2.0 = S+0x50. (Both depend on n-1 = 8; for another view count only the ratio stays at 0.2.)

### 4.4 Birchfield-Tomasi variant (S+0x6c true; NOT used by ILLUM; L6752-7210)
For reference completeness: samples view v at the shifted position P0 and at P0 +/- 0.5*unit(d)*(sx,sy) (P+, P-), the reference at (y,x) and at (y,x) +/- the same
half step (R+, R-); d1 = max(R0 - max(P0,P+,P-), min(P0,P+,P-) - R0, 0) per channel, d2 = same with roles swapped; cost_v = min(sum_rgb min(d1,d2), T).
Spline sampling (S+0x1728 true) replaces the bilinear sample in the plain path only (L6735-6744).

## 5. removeNoisyDataCostEntries (S, ASM 1003aa510; RNDCET::Run ASM 1003aa940) - runs when S+0x64 (0.15) > 0 (L7348-7349)
```
k   = (int) ceil((L-1) * 0.5)               # S+0x60 = 0.5 ; ceilf identified from the lazy-bind table
thr = 0.5 * 0.15 = 0.075                    # S+0x60 * S+0x64
for each pixel:
    v = copy(cost[y][x][0..L-1]); mn = min(v), mx = max(v)
    kth = nth_element(v, k) if k < L-1 else mx
    if kth - mn < thr: cost[y][x][*] = 0    # flat cost curve (median label cost within 0.075 of the best) -> no information
```
So pixels whose cost curve is nearly flat (textureless) get an all-zero data term.
(Task fields: y0 at +8, y1 at +0xc, S+0x64 at +0x10, S+0x60 at +0x14: L7359-7366; the use of +0x10/+0x14 and the
min/max/nth_element/bzero logic are from ASM 1003aa95e-1003aabdf; moderately confident.)

## 6. Aggregation (CrossBasedDataCostAggregation, ILLUM: ON, before the MRF)
createDataCostVolume (L4946-4994): DataCost.Reset -> pixelwise cost (4.2) -> removeNoisy (5) -> if S+0x6d: CrossBasedDataCostAggregation(0.04, 0.025, 34, 17, 4, 1.0, 1.5)
applied to the volume with the reference sub-aperture image (GetReferenceImage = view+0x08 of the centre view, L4989) as guide.
I did not decode the body (operator() ASM 1002ff370 for Color4 guide; helpers extractDataCostSlice / filterOneSlice(Image<Color4<int>> arms) / computeBlendMap
(uses ctor args 1.0 and 1.5) / insertDataCostSlice). It is the Zhang cross-based method: per pixel four arm lengths (left,right,up,down; max 34 px, relaxed
threshold beyond 17 px) from reference colour similarity (0.04 / 0.025 look like the two colour thresholds), each label slice averaged over the cross-shaped support,
and the integer 4 (probably iteration or arm-quantisation count) and 1.0 / 1.5 form a blend map between raw and aggregated cost. Treat this paragraph as
inference from names/signatures, not from code.

## 7. Confidence / importance (all after the cost volume)
computeDepthmap (S, L4997-5207), in order:
1. D.view[ref]+0xd0 (importance) and +0xa8 (confidence) are (re)sized and filled with 1.0 (L5081-5111).
2. S+0xd8 (OFF in ILLUM): ConfidenceByDataCostAnalysis(dataCost, S+0xc8 params, +0xa8) - skipped. (Dispatch in L3996-4051; body CBCDCATask::Run ASM 1001ff080 not read.)
3. S+0xc0 (ON): AdjustImportanceByImageContent(refImage, +0xd0 importance): importance *= SaliencyMapAlgorithm(refImage) pixel by pixel (L5857-5943,
   ASM 1003a7253-1003a7269). The saliency map body (ASM 1004c1b00) was not read.
   **Neither image is passed to the MRF** (4 below). +0xd0 is consumed later by GetFocusImportanceFunction (L3223-3375: per 25x25 tile histogram of depth
   weighted by int(importance*100), bins = int(4*(lmax-lmin)); not part of depth estimation) and +0xa8 is only size-checked in MRFSolver::Solution (ASM 1002fbe1e-1002fbe4b).
4. Post: S+0xc1 (OFF) DecreaseDepthEdgeImportance (L5946-6003: where |d(x,y)-d(x+1,y)| > 1 or |d(x,y)-d(x,y+1)| > 1, multiply the 2x2 block of importance by S+0xc4).

## 8. MRF (S::Optimization, L5466-5834)
```
(hCue, vCue) = S+0x94 ? BuildEdgeAdaptiveSmoothnessCost(S+0x98=0.2, S+0x9c=0.5, refImage = centre view+0x08) : all 1.0     # L5544-5557
smooth = { slope = S+0x90 (0.1*step), trunc = S+0x8c (6.0/step), 0 }                                              # L5558-5560 (order of fields in SmoothnessCost unverified)
solver = TRWS(flag S+0x58) | BPM | HBP  by S+0x48                                                                  # L5563-5716
solver.Solve(dataCost, smooth, hCue, vCue, iterations = S+0x5c = 10, pool, status)                                 # vtable+0x10  (L5727)
solver.Solution(dataCost, smooth, hCue, vCue, labels(by value), out depth = view+0x80, out conf = view+0xa8, pool, status)   # vtable+0x18 (L5759)
```
What the solver receives is exactly: the (aggregated, noisy-entry-zeroed) data cost volume W x H x L float, the two cue images, slope/trunc, the iteration count and the label
value vector. Energy (computeEnergyFunction L6006-6161): E = sum_p data[p][label_p] + sum_(p,q) min(|l_p-l_q|*slope, trunc*slope) * cue (cue = hCue for horizontal pairs, vCue for vertical,
left/up pixel's weight). The base `Solution` (ASM 1002fbdf0) takes, per pixel, argmin over labels of the sum of the 5 buffers (data + 4 messages) and writes `labels[argmin]` (lambda value) into the depth image.
After the MRF (L5139-5166): plane fitting skipped (S+0xa2 false); S+0xa1 true: [aggregation again only if S+0x6d false] then SubPixelEstimate; then median; then RemoveTemporaryData (S+0xd9).

SubPixelEstimate(D+0x2c = labels[0], S+0x08 = step, dataCost, depth) (L2574-2633): idx = (int)((depth - labels[0]) / step); if 0 < idx < L-1:
`den = c[idx-1] - 2*c[idx] + c[idx+1]` (const -2.0 at VA 100871484); if |den| > 0: `delta = ((c[idx+1]-c[idx-1]) / (2*den)) * step`; if |delta| < step: depth -= delta.
Uses the data cost volume (aggregated), not MRF messages.
MedianFilter (L2636-2811): plain 3x3 median of the interior (border pixels untouched), result written over the depth (in place copy).

## 9. Things I could not determine
- Which image axis the renderer treats as u/v and the sign convention of lambda in the refocus (affects the sign/orientation of shift in 4.1). Calibrate empirically.
- The meaning of `LightfieldLogic+0x48` (label upper limit) and of the SizeF in 2.3 (b); the GammaFunctionType value 3 (ILLUM view rendering); what each forced
  parameter in GenerateSubApertureConfig is; the exact semantics of ShiftedAperture's second aperture.
- The bodies of CrossBasedDataCostAggregation, SaliencyMapAlgorithm, BuildEdgeAdaptiveSmoothnessCost (only the notes' description was used), the TRW-S message update (MRFSolverTRWS::Solve ASM 1002fe040),
  and the layout (field order) of SmoothnessCost.
- Whether a cue weight uses the left/up or right/down pixel (computeEnergyFunction pairs use cue at the first pixel of the pair).
