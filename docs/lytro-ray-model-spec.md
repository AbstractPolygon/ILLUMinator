# Zoom / focus / main-lens dependence of the engine's ray model (tnt Mach-O, x86-64)

All addresses are Mach-O VAs in `tnt/tnt_macho` (symbols from `tnt/syms.txt`). Decompiles of this pass are in
`zg/dec_a.c` ... `zg/dec_i.c` (Ghidra headless, same project `gh/ptnt`), full disassembly in `zg/tnt_full.asm`
(index helper `zg/fn.py`), probe scripts `zg/grid.mjs rw.mjs mean.mjs gshift.mjs gq.mjs frame.mjs` (run the app worker
in node, read-only). Nothing in the repository was changed.

## 0. Short answers

1. The engine's ray model has NO dependence on focalLength, zoomStep, focusStep or opticalCenterOffset. Everything that
   changes with zoom reaches it through numbers that are already in the photo's metadata (they are the values of the
   nearest calibration sample, not interpolated) plus the photo's own ray table (aberrationCorrectionRef) and GCT
   (geometryCorrectionRef).
2. lambda -> displacement is exactly "1 px per px of the pixel's offset from its disc centre" (`HexLightfieldGeometry::Project`);
   `LAMBDA_TO_ALPHA` is therefore a pure output-grid constant (1 / output unit), not derived from focal length,
   infinityLambda or the exit pupil. infinityLambda only sets the depth label range.
3. The (dy, dx) = (+2.4, +1.3) output-px offset at lambda 0 on b4-2 is, for the most part, NOT engine geometry: it is the
   quantisation of the port's own output frame (lens index range), see section 5.1. It is predicted to within 0.1 px in x.
4. The depth proportional part (about 0.1 px/lambda in y, -0.076 in x) is not explained by anything in the decompile
   (section 5.4 lists what was ruled out and the experiments that would bisect it).

## 1. What the metadata feeds (formulas with constants)

`Metadata::GetCameraModel` (0x1002f2930, `zg`/`gh/tdec_l10.c`) reads, with unit conversions (constants checked in the binary:
0x1007e9788 = 1e6, 0x1007e9790 = 1000, 0x1007ea2dc = 1000):

| field (key) | unit in model | used by |
|---|---|---|
| mla.lensPitch | um (x1e6) | HexMicrolensArrayModel +8 |
| mla.scaleFactor.x/.y | none | +0x18 / +0x1c |
| mla.sensorOffset.x/.y/.z | um | +0xc,+0x10 (x,y) ; +0x14 (z) |
| mla.rotation | rad | +0x20 |
| fNumberMicrolens | sensorOffset.z / lensPitch | +0x24 (ctor 0x10022a500) |
| sensor.pixelPitch | um | SensorModel +0x18 |
| sensor.pixelWidth/pixelHeight | int px | SensorModel +0,+4 (= image size, CameraModel +0x100/+0x104) |
| image margins / originOnSensor | int | SensorModel +8..+0x14 (stored, not used by the lattice) |
| lens.exitPupilOffset.z | mm (x1000) | MainLensModel SparseFunction (see below) |
| lens.opticalCenterOffset.x/.y | um (x1e6) | MainLensModel +0xb0/+0xb4, copied to CameraModel +0xf8 (0x1002f8d89) |

Not read by `GetCameraModel`: focalLength, zoomStep, focusStep, infinityLambda, fNumber.

### 1.1 Exit pupil (MainLensModel)
`MainLensModel` (vtable 0x100a105a0) holds a `SparseFunction` (0x1003bd030 operator(), 0x1003bccd0 Add) plus the two optical-centre floats.
`GetCameraModel` builds it with ONE sample: `Add(x = 0, y = exitPupilOffset.z * 1000)` (0x1002f3155). `SparseFunction::operator()` returns
`y[0]` when the function has a single point (`iVar1 == 1` branch), so the "exit pupil as a function of focal length" is the constant
`E = exitPupilOffset.z[mm]` whatever float is passed. That float is `Metadata::GetMainLensFocalLength()*1000` (0x1002f5cc0), which is
the extra argument of `HexDiskArrayModel(CameraModel const&, float)` (0x100206e80, called from every `HexLightfield(Metadata)` ctor,
e.g. 0x100207d20). It only ever goes into the SparseFunction call, so it is dead. The sparse function is read at exactly five places
(HexMicrolensArrayModel::diskPitch/DiskCenter/DiskPitch/DiskMaxPitch, SharpenFilter, a few filter designers) - checked with `tnt/callers.py 1003bd030`.

### 1.2 Disk lattice (HexMicrolensArrayModel, 0x10022a7b0 / 0x10022aac0 / 0x10022aaa0 / 0x10022a7f0)
```
dp      = (sensorOffset.z[um] / 1000 + E[mm]) * lensPitch[um] / E[mm]          // um, diskPitch
pitch   = ( sx * dp / pp , sy * dp / pp )                                      // DiskPitch(), px (x, y) -- no sqrt(3)/2 here
cx0 = W*pp*0.5 + sensorOffset.x ; cy0 = H*pp*0.5 + sensorOffset.y             // um
rowIdx  = floor( cy0 / (dp * (sqrt3/2) * sy) )                                  // unrotated y
x9      = cx0*cos(th) + cy0*sin(th) + (rowIdx odd ? 0.5*dp*sx : 0)
disk (0,0) = the disk that contains (cx0,cy0); DiskCenter(i,j) = rotate_by(+th)( x'(i,j), y'(j) )
   x'(i,j) = pitch.x*(i + j/2) + (x9 - floor(x9/(sx*dp))*sx*dp)/pp ;  y'(j) = (sqrt3/2)*pitch.y*j + ...
```
`HexDiskArrayModel(CameraModel)` (0x100206e80) stores DiskPitch (+8), OriginDisk (+0x10), rotation (+0x18), the two lattice steps
measured from DiskCenter(1,0)-(0,0) and (0,1)-(0,0) (+0x1c, +0x24), fNumberMicrolens (+0x2c), image size (+0x30).
`core/lytroedof.js engineGrid` reproduces this exactly (checked line by line against the decompile). Values:

| photo | E (mm) | sy | rotation | engine pitch / rowStep | app grid (pitch / rowStep / rot / ox / oy) |
|---|---|---|---|---|---|
| b4-1 | 126.967 | 1.0000476 | -0.00106676 | 14.289878 / 12.375986 | 14.285714 / 12.372838 / -0.00106676 / 3860.228 / 2688.991 (nominal) |
| b4-2 | 128.384 | 1.0002046 | -0.00108066 | 14.289832 / 12.377889 | 14.291005 / 12.376384 / -0.00106585 / 3860.143 / 2688.982 (fitted) |
Engine lattice anchored near the app's: b4-1 (3860.571, 2689.077); b4-2 (3860.887, 2688.969). The two lattices agree to
< 1.1 px over the whole sensor on both photos (Delta origin b4-2 = -0.74, +0.01 px). A contrast score of the raw
image (`measureGrid`, zg/gq.mjs) prefers the b4-2 engine lattice shifted by -0.5 px in x (0.4617 vs 0.4499 at 0, app 0.4618), i.e. by about the
GCT mean (see 3.3). So the lattice does not explain any large offset.

### 1.3 Projection (HexLightfieldGeometry, 0x100228920 Project, 0x100228680 Trace, 0x10022a240 SensorAlignedRefocusingEquationRatios)
`Project(LightfieldPoint {i,j at +0x10/+0x14 ints ; u,v at +0x18/+0x1c floats}, lambda)` (verified in assembly):
```
X = pitch.x * ( i + 0.5*j - lambda*u )          Y = pitch.y * ( (sqrt3/2)*j - lambda*v )
P = origin + R(theta) * (X, Y)         ->  NormPoint2F( P.x / W + c, P.y / H + c )   c = DAT_1007e9bbc = -0.5
```
u, v are in units of the disk pitch (pitch.x resp. pitch.y). So the displacement of a ray is `lambda * (pixel offset in px)` with
coefficient exactly 1; `SensorAlignedRefocusingEquationRatios` = `((cos*pitch.x - sin*pitch.y)/W, (cos*pitch.y + sin*pitch.x)/H)`
(the normalised displacement per unit lambda and unit u, v used by the march and by `GeometryErrorRowRasterizedEntry::NextDeltas`, 0x1001ba9a0).
No focal length, zoom or exit-pupil factor besides pitch (which carries the (E+z)/E factor, 1.0003) appears. `Trace` returns the ray
{origin (x,y,0), direction (x2,y2,1)} from the same two normalised points (lambda 0 and 1). `LightfieldLogic::PushLambda` (0x1002c1e30) only
replaces |lambda| < 2.0 (DAT_10086cb44) by a signed constant from a 2 entry table at 0x1007e93b0 (used by filter designers, not by the projection).
Consequence: the exact output conversion is alpha = lambda / (px of the output unit), 1/rowStep for the port's unit; 0.0814 is a depth fit constant,
0.7 % above 1/12.3728 = 0.08082. It is not photo dependent (rowStep differs by < 0.03 % between b4-1 and b4-2).

### 1.4 LightfieldLogic ctor (0x1002c0230) - the "last float"
Signature `LightfieldLogic(HexDiskArrayModel const&, ProductID const&, float, int, float)`. Verified at the call (0x100207f25 and the
`HexLightfield(Metadata)` ctors, tdec_l42): arguments are `(model, productID (Metadata 0x2f00b0), GetMainLensFNumber(), GetImageInfo()+0x30 = ISO,
GetImageInfo()+0x38 = infinityLambda)`. `GetImageInfo` (0x1002f05e0) fills +0x30 from `image.iso`, +0x34 macro flag, +0x38 from
`devices.lens.infinityLambda.target,...`. Stored at +0x40 (fNumber), +0x44 (ISO), +0x48 (infinityLambda), +0x58 (ProductID type).
Readers of +0x48: only `DepthMapAlgorithm::CreateLambdaSample` (0x1001fd520): `hi = min(floor(infinityLambda) + margin, cap)`, labels from
lambdaMin in steps of `step` up to `hi` (this is the "floor(infinityLambda)+3 rounded up to 4" label count in the notes). It is not read in
the projection/EDOF path. Readers of +0x40: `NominalApertureFraction` (0x1002c0640).

### 1.5 Aperture - the one geometry-like quantity that follows the main lens
`NominalApertureFraction = min( clamp(fMLA / fMain, 0, 1), clamp( 2.0 - fMLA/fMain - k / DiskMaxPitch, 0, 1) )`,
fMLA = FNumberMicrolens (= sensorOffset.z/lensPitch = 1.85), fMain = lens.fNumber, k = 2.0 for ProductID 2 (ILLUM; 4.0 for ID 1, 1.0 otherwise;
constants 0x10086cb44 = 2.0, 0x10086cb40 = 4.0). b4-1: 1.85/2.0499 = 0.9025; b4-2: 1.85/2.1021 = 0.8801 (second term 0.98, inactive).
So the aperture is 2.5 % smaller on b4-2 (flat sides at 0.5*value of the unit hex, see notes).

### 1.6 RefocusEdof f1..f4 (0x100327970 ctor; tnt caller `TNT::basicPipeline::refocus` 0x10000d8d0 at 0x10000dd8d..0x10000ddc5)
`RefocusEdof(IAperture, cfg, f1, f2, f3, bool, bool, filterBank, Image, f4)`: f1, f2 = `ReorientObject::Transform(NormPoint2F(viewPerspectiveU, viewPerspectiveV))`
(a sign flip / 90 degree turn only, 0x100343a60), f3 = zero-parallax pivot lambda (`viewPivot`; the value -9999 (0x1006bee8c) means "compute
`Parallax::ComputeZeroParallaxLambda(depth)`"), f4 = `kMaxAbsLambdaForBorder` = 30.0 (0x1007ea484; kLambdaStep = 0.25 at 0x1007ea480).
Stored at +0x2c90, +0x2c94, +0x2c8c, +0x2c88. Default recipe (`rec_edof_raw.json`): viewPerspectiveU/V = 0, viewPivot = 0, so f1 = f2 = 0:
no view offset; with a (0,0) perspective the pivot has no effect. (`createEDOFImage` 0x1002bcb40 passes 0, 0, 0, kMaxAbsLambdaForBorder.)

## 2. Calibration-sample selection (the real zoom/focus dependence)

* `CalibrationDataManager::GetNearestSample(zoom, focus)` (0x10019d7b0): nearest zoom (|dz| minimum), then among samples with exactly that
  zoom the nearest focus (ties: larger exposure). Used by `Basic/BoostCalibrationDataManager` (`Initialize` 0x1000e7d60 builds the lists from
  `GetMainLensZoomPosition` 0x1002f5e40 / `FocusPosition` 0x1002f5ef0 keys `devices.lens.motorPosition.zoom,...zoomStep` / `...focusStep`)
  to pick the modulation image and the GCT. No interpolation for the GCT or for the lens/mla numbers.
* `zg/cal` (caldata tar): samples MOD_0000..0033 hold zoom {-1040,-1000,-920,-780,-560,-340,-120,80,280,470} and 3-4 focus
  positions each. The photo metadata values are exactly those of the nearest sample's capture:
  b4-1 / b4-3 (zoom 471 / 444, focus 1179) = MOD_0033 (zoom 470, focus 1180): E = 0.126967, sy = 1.0000475645, rot = -0.0010667616;
  b4-2 (zoom 11, focus 600) = MOD_0026 (zoom 80, focus 650): E = 0.128384, sy = 1.0002045631, rot = -0.0010806635.
  The photos' geometryCorrectionRef equals MOD_0033.GCT (sha1 bd7bb106...) for b4-1 and b4-3 and MOD_0026.GCT (660cf2e9...) for b4-2.
  (The photo is NOT at the sample's zoom: focalLength 15.83 mm vs the sample's 14.80 mm; the engine does not care.)
* `unitdata/mla_calibration.json` (exitPupilDistanceMilli, xDiskStepPixelsX, yMlaScale, ...) and `unit_info.json`'s opticalCenterOffset are not
  read by tnt (no such strings in the binary); they are what produced the per-photo metadata.
* Other zoom/focus consumers (not ray geometry): `BoostAberrationCorrectionManager::AddSample/GetAberrationCorrection` (0x1000eaf80/0x1000eb3b0, uses
  focal length + zoom + focus when the aberration table comes from a calibration directory; with tnt and a Lytro Desktop photo the table is the photo's
  own: `LfpAberrationCorrectionManager::GetAberrationCorrection` 0x100128820, which only checks that image size/serial agree), `BoostReconstructionFilterManager`
  (filter bank), `Defringe::getDefringeMap`, `CorrectChromaticAberrationImage` (built-in table `blitzen_info`, 10804 entries of {zoom, focus, object
  distance, 9 floats}, nearest zoom then nearest focus; the 9 floats are R,G,B at three field radii: b4-1 R/G = 1.0017, B/G = 0.9988; b4-2 1.0004,
  1.0003; it scales colour channels against each other, not the lens geometry), `DemodulationAlgorithm4DDerived::GenerateGeometryCorrectionTable`.

## 3. The ray table and the GCT as the engine applies them

### 3.1 Ray table lookup (AberrationCorrectionCompact, 0x100377d40 Delta(SensorAlignedLightfieldPoint), 0x100377df0 Delta(i,j))
`Delta(p) = LightfieldTable<Color4>::LookupQuadrilinear(p)` (0x100478950): `(sum k_i V_i + bias) / sum k_i W_i` when the weight sum is > 0, else the
unnormalised sum; bias (+0xd0) is 0 (ctor 0x100476b40). Geometry A (calibration, built from `aberrationCorrectionMetadataRef`) is stored but never used at
lookup time; Delta uses only the photo's own geometry (+0x60) for `Transform(Point2I)`. So there is no calibration-geometry to photo-geometry conversion.
`Deserialize` (0x100379400, tdec_l38) order: polar tables -> Cartesian (`ComputeOpticsCoordinateTables` 0x1003774c0 scales x by W/diag, y by H/diag)
-> `RemoveChiefRayAngle` if cfg 0x2690 == false -> `ScaleSpatialCoordinate(flag = cfg 0x26a8)` -> `OffsetFocusPlane` only if cfg 0x26c0. The scale is
`1/min( (0.5+dx(0.5,0,0,0)) - (-0.5+dx(-0.5,0,0,0)), (0.5+dy(0,0.5,0,0)) - (-0.5+dy(0,-0.5,0,0)) )` (coordinates at 0x1007e9bbc/0x1007eb800.., identical to
raywarp.js). Results of the port's evaluator on the three photos: s = 0.96871 (b4-1), 1.02520 (b4-2), 0.97464 (b4-3).
The tables differ in kind: b4-1/b4-3: du = -0.034*u (direction scale, dx independent of u); b4-2: du = -0.005*u and **dx = +25.2 px per lens pitch of u**
(0.00098 of the width at u = 0.3, same for dy against v): a position-type tilt (an effective lambda offset of -1.77), not present on the other two.

### 3.2 GCT (CorrectLightfieldPoint 0x1001ba1a0; template version 0x1001c0c40 is what robustProjection calls, 0x100488110)
cell = (clamp floor(w*(x+0.5)+0.5), clamp floor(h*(y+0.5)+0.5)) from the point's (x, y); the cell's (u, v) is subtracted from the point's lens-array-axes
direction (`dirMla` at +0x18); then `CorrectDiskForPoint(MLA aligned)` (0x100229000) re-assigns the ray to a hexagonal neighbour lens when the shifted
(u, v) falls outside the unit hexagon (|u| > 0.5 or |v| > (1-|u|)/sqrt3), `RealignLightfieldPoint` (0x100228df0) rebuilds (x, y) from `DiskCenter(i, j)` and
rotates the direction back. The fast path (`GeometryErrorRowRasterizedEntry`, 0x100493d30 / `NextDeltas` 0x1001ba9a0) applies the same cell values incrementally:
direction += R * dcell, position += lambda * ratios * R * dcell.
**Order in robustProjection:** pixel -> Transform -> CorrectLightfieldPoint (GCT) -> (ray table lookup on the GCT-corrected point) -> Project(lambda).
The port looks the ray table up at the raw (u, v) and adds the GCT mean afterwards. For b4-1 this is invisible (dx has no u dependence); for b4-2 the
mean GCT (-0.0375, +0.0026 lens) times the dx slope moves the mean position at the picture centre by (+1.36, -0.10) px (zg/gshift.mjs; b4-1: 0.04, 0.02),
i.e. 0.33 output px. Small but b4-2 specific.

### 3.3 GCT numbers (60x60 cells, lens pitches)
Mean (u, v): MOD_0033 (-0.0191, -0.0060) = (-0.273, -0.086) px (the "0.273, 0.086" of b4-1); MOD_0026 (-0.0375, +0.0026) = (-0.536, +0.037) px (the
"0.536, -0.037" of b4-2, sign as in the notes). Spatial variation: MOD_0026 is nearly a constant (plane fit coefficients over the full picture: u: +0.38 px in x,
-0.13 px in y; v: +0.10, -0.39 px; residual std 0.05 px), MOD_0033 tilts by -2.5 px (u over x) and -1.5 px (v over y).

## 4. Things that are NOT used by the ray model (so cannot explain b4-2)
* focalLength, zoomStep, focusStep (only for sample selection and the chromatic aberration table), opticalCenterOffset (stored in MainLensModel/CameraModel,
  no reader anywhere in tnt: the only access to CameraModel +0xf8 is the copy at 0x1002f8d89; `MainLensModel::Clone` 0x1002fa790 does not even copy it),
  infinityLambda (label range only), the sensor margins in SensorModel.
* `HexMicrolensArrayModel` chief ray direction: there is no "(lens position - optical centre)/exit pupil" term. The chief ray is handled entirely by
  the disk lattice (disk pitch scaled by (E+z)/E, i.e. disks are the images of the lenses through the pupil centre) and by `RemoveChiefRayAngle` on the table.

## 5. What actually differs on b4-2 (measured in this pass)

### 5.1 The port's output frame is lattice-quantised (explains the lambda-0 offset)
`render.js samplerExtent`: xMin = (c0 + 2)*pitch, xMax = (c1 - 2)*pitch, yMin = (r0 + 1)*rowStep, yMax = (r1 - 2)*rowStep in lens-grid coordinates
(c0, c1, r0, r1 = first/last lens column/row that fits the sensor). The output image is that rectangle at `rowStep/detail` per pixel; the engine's frame
is the whole corrected picture. Frame centre in sensor px (zg/frame.mjs), image centre = (3864, 2684):

| photo | lens range r0..r1 / c0..c1 | out size | frame centre | offset from image centre |
|---|---|---|---|---|
| b4-1 | -215..215 / -268..269 | 615 x 427 | (3864.87, 2682.80) | (+0.87, -1.20) px |
| b4-3 | -215..215 / -268..269 | 615 x 427 | (3864.90, 2682.80) | (+0.90, -1.20) |
| b4-2 | -215..214 / -268..268 | 614 x 426 | (3858.27, 2676.61) | (-5.73, -7.39) |

b4-2 loses one column and one row at the far side, which moves the frame centre by half a lens column / row. `scripts/re/score_gt.py` registers the port render against the engine with a
centre-to-centre affine fit; the expected registration shift is `(c_image - c_frame) * 3 / rowStep` port px. Predicted vs fitted (score_gt on
`d112/out/b4-2/edofap4.rgba` vs `tntrun/gtraw_b42.png`, `d112/out/b4-3/edofc3a.rgba` vs `gtraw_b43.png`):

| photo | predicted (dx, dy) | fitted (dx, dy) | fitted scale |
|---|---|---|---|
| b4-3 | (-0.22, +0.29) | (-0.23, +0.55) | 1.0157 (expected 1.0156 from the size ratio) |
| b4-2 | (+1.39, +1.79) | (+1.51, +2.59) | 1.0179 (expected 1.0170) |

x agrees to 0.01 and 0.12 px; y leaves +0.26 (b4-3) and +0.8 px (b4-2) unexplained (the engine output is also anisotropic: 2022 x 1404 for a 7574 x 5264
standardised image = 3.7457 vs 3.7493 std px per output px, 0.096 %; and the engine's standardised image is scaled 0.98007 in x but 0.98063 in y while
`ResizeGeometry` (0x100207ad0) multiplies the geometry by one factor 14/14.2898 = 0.97972, so the engine itself carries a 0.04 % / 0.09 % magnification
mismatch between image and model, 1.4 / 2.5 px at the lattice origin). Constant-depth oracle numbers (2.4, 1.3) at lambda 0 minus the predicted frame offset
(1.79, 1.39) leave (0.6, -0.1) out px, about what b4-3 shows (0.26). So: define the output frame from the picture (pixel (X, Y) <-> normalised
((X+0.5)/W, (Y+0.5)/H) of the corrected ray position, with the engine's output size) instead of from the lens index range, and the photo dependence disappears.

### 5.2 Table lookup point (3.2): +1.36 px in x at the centre on b4-2, none on b4-1/b4-3.

### 5.3 Lattice / GCT mean
App lattice origin minus engine lattice origin = (-0.34, -0.09) px on b4-1 and (-0.74, +0.01) px on b4-2; the GCT means are (-0.27, -0.09) and (-0.54, +0.04) px: the
two track each other (the app's fitted centres sit at "model + GCT" in both photos). Pitch drift of the b4-2 fit (14.291005 vs engine 14.289832) is 0.3 px at the picture edge.
None of these exceeds ~1 px.

### 5.4 Depth proportional shift: not found
Observed (b4-2): about (-0.31, +0.41) sensor px per lambda (= the "ruOff/rvOff (-0.32, +0.42)" of the notes) of mean ray-direction difference. Ruled out in the decompile:
focal length / zoom / infinityLambda / opticalCenterOffset (unused); lambda conversion (1 px/px); aberration table geometry A (unused); GCT order is the only structural
difference found and it is a position effect, not a direction mean. Checked numerically with the port's evaluator (zg/mean.mjs): the aperture-averaged ray direction at the picture
centre is 0 for both photos with or without chief removal at (0,0); off centre chief removal matters a lot (b4-2 at (0.3, 0.2): 10 px at lambda 25 without it) but it is on in the port.
Candidates that remain (untested):
 (a) the aperture window: the engine's hex test is on the GCT-corrected direction (window centred at p = c_model + G), the port's on the raw offset from the fitted centre
     (its direction origin then gets `rayShift` afterwards). Window shift = G = (0.54, -0.04) px on b4-2 (0.27, 0.09 on b4-1) changes which rays are averaged;
 (b) per-lens GCT instead of its mean (plane tilt of MOD_0026 is only +-0.2 px, so small);
 (c) the engine's image/model magnification mismatch (5.1): a position error proportional to the distance from the lattice origin, not to lambda;
 (d) fitted per-photo lattice rotation/pitch of the app (b4-2 only) vs metadata (rotation differs by 1.5e-5 rad, pitch by 8e-5 relative).
Bisection with the engine (cheap, decisive): patch the LFP (`scripts/re/patchraw.mjs` style, metadata and sections are plain JSON/blobs) and run `--depth-in` constants:
 1. b4-2 with the GCT section zeroed, then replaced by MOD_0033's;
 2. b4-2 with E, sy, rotation, sensorOffset replaced by b4-1's values (one field at a time);
 3. b4-2 with b4-1's ray table (aberrationCorrectionRef section) and, separately, only its tilt-free half;
 4. b4-1 with b4-2's table.
 The field whose change moves the engine render by ~0.4 px/lambda is the cause; fields that do nothing confirm sections 1 and 4.

## 6. What I could not determine
* The origin of the depth proportional shift on b4-2 (5.4).
* The exact effect of `CorrectDiskForPoint` re-assignment on edge rays (a fraction of rays within |G| of the hex border switch lens; estimated below 1 % of rays).
* How `DiskMaxPitch` (0x100207a30) is formed (only enters the aperture's second term, inactive for both photos).
* `Trace`'s consumer set (it is only the straight-line form of Project; not needed for the port).
* Whether tnt's `--calibration-in` directory is also consulted for modulation / GCT when the LFP carries its refs (the cal dir used in the repo has only the 7 GCT files
  for the photos, so the refs are what is used).
