#!/usr/bin/env python3
"""Reference for app/js/core/dmresampler.js (test only): the line-by-line Python port of LFE::DmResampler
(tnt Mach-O, 0x1003ab290..0x1003b3f90) made earlier, with FIVE engine-fidelity patches (marked PATCH) where the
original port computed in float64 or deviated from the Ghidra decompile / disassembly:
  PATCH 1 similarity mask: |a-b| is a float32 difference compared with float32(thr)      (calcSimilarityMap)
  PATCH 2 line intersection in float32 (every operation rounded)                           (linesIntersectAntonioModified)
  PATCH 3 sub pixel weights stored as float32, blend accumulated/quantised in float32     (calcSubpixelWeights, calcBlendedSampleResult)
  PATCH 4 populateAmbiguousPixels: the first diagonal averaging to the sentinel (-100) goes straight to the
          min-of-neighbours fallback (the port tried the second diagonal)                  (populateAmbiguousPixels)
  PATCH 5 float32 arithmetic in populateAmbiguousPixels (|a-b| < thr, (a+b)*0.5)
CLI: python3 -I dmresampler_ref.py < request.json   with {"cases":[{"w":..,"h":..,"data":[..],"thr":0.8,"blend":true}]}
prints a JSON list of flat float lists (the x5 maps).
Conventions: depth image D[y][x] (lens grid), threshold thr (0.8), blend flag, X=Y=5 upscale.
Cell (lx,ly) spans [lx,lx+1]x[ly,ly+1] in "lens corner" coordinates; its lens centre is (lx+.5,ly+.5).
"""
import math, sys
from collections import deque
import numpy as np

f32 = np.float32

# ---- tables (Mach-O data, dumped with rd.py) --------------------------------------------------
DX = [-1, 0, 1, -1, 1, -1, 0, 1, 0]            # kDmUpscalePixNeighborDelta @0x10086b150 (x)
DY = [-1, -1, -1, 0, 0, 1, 1, 1, 0]            #                                         (y)
CVPOS = [(0.5, 0.0), (0.75, -0.25), (0.75, 0.25), (1.0, 0.0), (1.25, 0.25), (1.0, 0.5), (1.25, 0.75), (0.75, 0.75),
         (1.0, 1.0), (0.75, 1.25), (0.5, 1.0), (0.25, 1.25), (0.25, 0.75), (0.0, 1.0), (-0.25, 0.75), (0.0, 0.5),
         (-0.25, 0.25), (0.25, 0.25), (0.0, 0.0), (0.25, -0.25)]   # kDmUpscaleSubpixCvPos @0x10086b1a0
CONN = [  # kDmUpscaleSubpixNeighborConnectivity @0x10086b240 [neighbour][point] (-1 = 0xff)
    [-1]*16 + [9, -1, 8, 6],
    [10, 7, 9, 8] + [-1]*13 + [11, 13, 12],
    [-1, 14, -1, 13, 11] + [-1]*15,
    [-1]*12 + [6, 8, 7, 5, 2, 4, 3, -1],
    [-1, -1, 16, 18, 17, 15, 12, 14, 13] + [-1]*11,
    [-1]*11 + [4, -1, 3, 1] + [-1]*5,
    [-1]*7 + [1, 3, 2, 0, 17, 19, 18] + [-1]*6,
    [-1]*6 + [19, -1, 18, 16] + [-1]*10]
DIAG = {1: [2, 2, 2, 7, 7, 7, 7, 7, 5, 5, 5, 5, 5, 0, 0, 0, 0, 0, 2, 2],     # ...IdxIncr (forward)
        0: [0, 0, 0, 0, 2, 2, 2, 2, 2, 7, 7, 7, 7, 7, 5, 5, 5, 5, 5, 0]}     # ...IdxDecr (backward)
SIDE = {1: [4, 4, 4, 4, 6, 6, 6, 6, 6, 3, 3, 3, 3, 3, 1, 1, 1, 1, 1, 4],
        0: [3, 3, 3, 1, 1, 1, 1, 1, 4, 4, 4, 4, 4, 6, 6, 6, 6, 6, 3, 3]}
STEP = {1: [1, 2, -1, 4, 4, 4, 7, -1, 6, 6, 6, 5, -1, 3, 3, 3, 0, -1, 1, 1],  # kDmUpscaleLocalStepBoundaryTestIncr
        0: [1, 1, -1, 1, 2, 4, 4, -1, 4, 7, 6, 6, -1, 6, 5, 3, 3, -1, 3, 0]}  # ...Decr
N2ON = [[8, 4, -1, 6, -1, -1, -1, -1, 7], [3, 8, 4, 5, 7, -1, -1, -1, 6], [-1, 3, 8, -1, 6, -1, -1, -1, 5],
        [1, 2, -1, 8, -1, 6, 7, -1, 4], [-1, 0, 1, -1, 8, -1, 5, 6, 3], [-1, -1, -1, 1, -1, 8, 4, -1, 2],
        [-1, -1, -1, 0, 2, 3, 8, 4, 1], [-1, -1, -1, -1, 5, -1, 3, 8, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8]]
QUAD = [[0, 1, 3, 8], [1, 2, 4, 8], [4, 7, 6, 8], [6, 5, 3, 8]]               # quadrantMembers @0x10086af80
SIDEBITS = [2, 16, 64, 8]                                                     # @0x10086af70 (T,R,B,L)
CORNER_ORDER = [1, 4, 128, 32]; NBR_DELTA = [-1, 1, 1, -1]; COMPL = [4, 1, 32, 128]
CORNERS = [18, 3, 8, 13]; MIDPOINTS = [0, 5, 10, 15]; COLLAPSED = [17, 2, 7, 12]
EXT = [(16, 19), (1, 4), (6, 9), (11, 14)]
SAMPLE = [(0.0, 0.0), (-1/3, 0.0), (1/3, 0.0), (0.0, -1/3), (0.0, 1/3)]       # sampleTable (float32 +-0.33333334)
CONNECTED = {'h': {-1: 3, 1: 4}, 'v': {-1: 1, 1: 6}}                           # connectedTable
DEG = 2          # DmResampler+0x0c (constructor default, never overwritten)
SPS = 3          # DmResampler+0x10 (samples per unit, constructor default)
WALK_MAX = DEG + 1   # iVar12 = this[0xc]+1 passed as walkBoundary max step count
OCC = -100.0         # populateUpscaledRegion marker for ambiguous sub pixels (0xc2c80000)


# ---- similarity masks -------------------------------------------------------------------------
def calc_similarity_map(D, thr):
    h, w = D.shape
    M = np.zeros((h, w), np.uint8)
    for y in range(h):
        for x in range(w):
            m = 0
            for k in range(8):
                xn, yn = x + DX[k], y + DY[k]
                if not (0 <= xn < w and 0 <= yn < h):
                    continue
                if thr != 0.0:
                    # bit cleared when thr <= |d - dk| (NaN keeps the bit); PATCH 1: float32 difference and threshold
                    if not (f32(thr) <= abs(f32(D[y, x]) - f32(D[yn, xn]))):
                        m |= 1 << k
                else:
                    if D[y, x] == D[yn, xn]:
                        m |= 1 << k
            M[y, x] = m
    return M


def remove_diagonals_on_full_2x2(M, D):          # 0x1003ad320
    h, w = M.shape
    for y in range(h - 1):
        for x in range(w - 1):
            A, B, C, Dd = int(M[y, x]), int(M[y, x + 1]), int(M[y + 1, x]), int(M[y + 1, x + 1])
            if (A & 0x80) and (B & 0x20):
                if (A & 0x10) == 0:
                    if D[y, x + 1] <= D[y, x]:          # B nearer or equal: drop A-D, keep B-C
                        A &= 0x7F; Dd &= 0xFE
                    else:                                # drop B-C, keep A-D
                        B &= 0xDF; C &= 0xFB
                else:                                    # A-B linked: drop both diagonals
                    B &= 0xDF; C &= 0xFB; A &= 0x7F; Dd &= 0xFE
                M[y, x], M[y, x + 1], M[y + 1, x], M[y + 1, x + 1] = A, B, C, Dd


# ---- per cell Voronoi point flags -------------------------------------------------------------
def voronoi_labels(M, x, y):                      # 0x1003ad6c0 calcPixelVoronoiType
    h, w = M.shape
    m = int(M[y, x])
    lab = [0, 0, 0, 0]
    for k in range(4):
        if CORNER_ORDER[k] & m:
            lab[k] = 1
        else:
            xn = x + NBR_DELTA[k]
            if 0 <= xn < w:
                lab[k] = 2 if (COMPL[k] & int(M[y, xn])) else 0
    return lab


def label_flags(lab):                             # 0x1003ad490 voronoiLabel2PointFlags
    f = 0x8421
    for k in range(4):
        prev_mid = MIDPOINTS[(k + 3) % 4]
        if lab[k] == 2:
            f |= 1 << COLLAPSED[k]; f &= ~(1 << prev_mid); f &= ~(1 << MIDPOINTS[k])
        elif lab[k] == 1:
            f |= (1 << EXT[k][0]) | (1 << EXT[k][1]); f &= ~(1 << prev_mid); f &= ~(1 << MIDPOINTS[k])
        else:
            f |= 1 << CORNERS[k]
    if lab[0] == 0 and lab[1] == 0: f &= ~(1 << 0)
    if lab[1] == 0 and lab[2] == 0: f &= ~(1 << 5)
    if lab[2] == 0 and lab[3] == 0: f &= ~(1 << 10)
    if lab[3] == 0 and lab[0] == 0: f &= ~(1 << 15)
    return f


def calc_flags(M):                                # 0x1003addb0
    h, w = M.shape
    F = [0] * (w * h)
    for y in range(h):
        for x in range(w):
            F[y * w + x] = label_flags(voronoi_labels(M, x, y))
    return F


# ---- boundary chains --------------------------------------------------------------------------
def at_intersection(M, x, y, p):                  # 0x1003adc60
    h, w = M.shape
    if p == 3: ox, oy = 0, -1
    elif p == 8: ox, oy = 0, 0
    elif p == 13: ox, oy = -1, 0
    elif p == 18: ox, oy = -1, -1
    else: return False
    ms = []
    for (cx, cy) in ((0, 0), (1, 0), (0, 1), (1, 1)):
        xx, yy = x + cx + ox, y + cy + oy
        if xx < 0 or xx >= w or yy < 0 or yy >= h:
            return True
        ms.append(int(M[yy, xx]))
    a, b, c, d = ms
    if a & 0x80: return False
    if b & 0x20: return False
    n = (1 - ((c >> 4) & 1)) + (1 - ((b >> 6) & 1)) + (1 - ((a >> 4) & 1)) + (1 - ((a >> 6) & 1))
    # thr > 0 branch (always the case for ILLUM 0.8)
    n += (0 if ((a >> 7) | (1 if (a & 0x50) == 0 else 0)) else 1)
    n += 1 if (c & 0x50) != 0 else 0
    return n > 2


class Chain:
    def __init__(self, x, y):
        self.ox, self.oy = x, y
        self.e = deque()          # entries (idx, relx, rely, atInter)


def walk_jump(M, chain, nb, cx, cy, p, fwd):      # 0x1003ae4f0
    conn = CONN[nb][p]
    if conn < 0:
        return False
    inter = at_intersection(M, cx + DX[nb], cy + DY[nb], conn)
    _, rx, ry, _ = chain.e[-1] if fwd else chain.e[0]
    ent = (conn, rx + DX[nb], ry + DY[nb], inter)
    (chain.e.append if fwd else chain.e.appendleft)(ent)
    return True


def walk_boundary(M, F, chain, fwd, budget, maxcount):   # 0x1003adf90 (control flow from the disassembly)
    h, w = M.shape
    idx0, relx, rely, _ = chain.e[-1] if fwd else chain.e[0]
    cx, cy = chain.ox + relx, chain.oy + rely
    if not (0 <= cx <= w - 1 and 0 <= cy <= h - 1):
        return
    seed = idx0
    p = seed
    same_start = (relx | rely) == 0
    close = DEG
    Fl = 0
    can_jump = True
    cont = True
    d = 1 if fwd else 0
    while cont:
        if not (F[cy * w + cx] >> p) & 1:
            break
        t = STEP[d][p]
        m = int(M[cy, cx])
        if t >= 0 and (m >> t) & 1 and can_jump:
            nb = -1; conn = -1
            for c in (DIAG[d][p], SIDE[d][p]):
                if CONN[c][p] >= 0 and (m >> c) & 1:
                    nb = c; conn = CONN[c][p]; break
            if nb != -1 and walk_jump(M, chain, nb, cx, cy, p, fwd):
                cx += DX[nb]; cy += DY[nb]; relx += DX[nb]; rely += DY[nb]
                p = conn
                can_jump = False
                budget = max(budget - 1, 0)
                same_start = False
                continue
        # ring step to the next active point
        r = p + (21 if fwd else 19)
        q = r % 20
        for _ in range(19):
            q = r % 20
            if (F[cy * w + cx] >> q) & 1:
                break
            r += 1 if fwd else -1
        inter = at_intersection(M, cx, cy, q)
        ent = (q, relx, rely, inter)
        (chain.e.append if fwd else chain.e.appendleft)(ent)
        newF = 1 if q == seed else Fl
        close = close - (Fl & 1)
        maxcount = maxcount - (1 if budget == 0 else 0)
        if same_start:
            cont = (close > 0) and not (newF & 1)
        else:
            cont = maxcount > 0
            same_start = False
        Fl = newF
        p = q
        can_jump = True


# ---- NURBS (clamped uniform quadratic B spline), LFENurbs::nurbsCurveEval ---------------------
def bspline_eval(t, P, knots, deg):
    n = len(P)
    # find span
    k = deg
    for i in range(deg, n):
        if knots[i] <= t < knots[i + 1]:
            k = i; break
    else:
        k = n - 1
    d = [np.array(P[j + k - deg], dtype=np.float64) for j in range(deg + 1)]
    for r in range(1, deg + 1):
        for j in range(deg, r - 1, -1):
            den = knots[j + 1 + k - r] - knots[j + k - deg]
            a = (t - knots[j + k - deg]) / den if den != 0 else 0.0
            d[j] = (1 - a) * d[j - 1] + a * d[j]
    return d[deg]


def append_line_segments(chain, segs):            # 0x1003ae700
    pts = []
    prev = None
    for i, (idx, rx, ry, inter) in enumerate(chain.e):
        if i >= 1:
            if not (rx == chain.e[i - 1][1] and ry == chain.e[i - 1][2]):
                continue                           # jump duplicate
        reps = DEG if inter else 1
        px = float(f32(rx) + f32(chain.ox) + f32(CVPOS[idx][0]))
        py = float(f32(ry) + f32(chain.oy) + f32(CVPOS[idx][1]))
        for _ in range(reps):
            pts.append((px, py))
    n = len(pts)
    m = n + DEG + 1
    knots = [0.0] * m
    for l in range(m):
        if l < DEG + 1:
            knots[l] = 0.0
        else:
            knots[l] = knots[l - 1] + (1.0 if l <= n else 0.0)
    if n < DEG + 2:
        segs.append([])                            # count <= 0 chains still push their count
        segs[-1] = (None, 0)
        return
    t0 = knots[DEG + 1]
    span = knots[n - 1] - t0
    cnt = int(float(SPS) * span)
    out = []
    for i in range(cnt):
        t = i * (span / cnt) + t0
        out.append(tuple(bspline_eval(t, pts, knots, DEG)))
    segs.append((out, cnt))


def extract_boundaries_of_pixel(M, F, x, y):      # 0x1003af270
    h, w = M.shape
    m = int(M[y, x])
    segs = []
    if (m & 0x5A) != 0x5A:
        for k in range(4):
            if (SIDEBITS[k] & m) == 0:
                r = 21 + 5 * k
                q = r % 20
                for _ in range(19):
                    q = r % 20
                    if (F[y * w + x] >> q) & 1:
                        break
                    r += 1
                assert (F[y * w + x] >> q) & 1, 'Non-active seed point'
                ch = Chain(x, y)
                ch.e.append((q, 0, 0, at_intersection(M, x, y, q)))
                walk_boundary(M, F, ch, True, 1, WALK_MAX)
                walk_boundary(M, F, ch, False, 1, WALK_MAX)
                append_line_segments(ch, segs)
    return segs


# ---- membership of the sub pixels of one cell -------------------------------------------------
def seg_isect(x1, y1, x2, y2, x3, y3, x4, y4):    # linesIntersectAntonioModified; PATCH 2: float32 operations
    x1, y1, x2, y2, x3, y3, x4, y4 = [f32(v) for v in (x1, y1, x2, y2, x3, y3, x4, y4)]
    ax = x2 - x1; bx = x3 - x4
    lo, hi = (x1, x2) if ax >= 0 else (x2, x1)
    if bx <= 0:
        if hi < x3 or x4 < lo: return False
    else:
        if hi < x4 or x3 < lo: return False
    ay = y2 - y1; by = y3 - y4
    lo, hi = (y1, y2) if ay >= 0 else (y2, y1)
    if by <= 0:
        if hi < y3 or y4 < lo: return False
    else:
        if hi < y4 or y3 < lo: return False
    cx = x1 - x3; cy = y1 - y3
    alpha = by * cx - bx * cy
    den = bx * ay - by * ax
    if den > 0:
        if alpha < 0 or alpha > den: return False
        beta = ax * cy - ay * cx
        if beta < 0 or beta > den: return False
    else:
        if alpha > 0 or alpha < den: return False
        beta = ax * cy - ay * cx
        if beta > 0 or beta < den: return False
    return bool(den != 0)


def eval_membership(chains, lx, ly, X, Y):        # 0x1003b3770
    xs = []; ys = []; counts = []
    for item in chains:
        out, cnt = item
        counts.append(cnt)
        if out:
            for (a, b) in out:
                xs.append(a); ys.append(b)
    A = []; B = []
    idx = 0
    for c in counts:
        if idx >= len(xs):
            break
        px = float(f32(xs[idx] - lx)); py = float(f32(ys[idx] - ly))
        if c < 2:
            idx += 1
            continue
        idx += 2; i = 2
        while True:
            if idx - 1 >= len(xs):
                break
            cx = float(f32(xs[idx - 1] - lx)); cy = float(f32(ys[idx - 1] - ly))
            if min(px, cx) <= 1.5 and min(py, cy) <= 1.5 and max(px, cx) >= -0.5 and max(py, cy) >= -0.5:
                A.append((px, py)); B.append((cx, cy))
            px, py = cx, cy
            if c <= i:
                break
            i += 1; idx += 1
    mem = [-1] * (X * Y)
    sx = f32(1) / f32(X + 1); sy = f32(1) / f32(Y + 1)
    hstep = f32(0.5) * sx
    k = 0
    for iy in range(1, Y + 1):
        ypos = f32(iy) * sy
        vdir = -1 if f32(0.5) > ypos else 1
        for ix in range(1, X + 1):
            xpos = f32(ix) * sx
            hdir = -1 if f32(0.5) > xpos else 1
            hits = [False] * 5
            go_neighbour = False
            if not A:
                pass
            else:
                for s in range(5):
                    px = f32(SAMPLE[s][0]) * hstep + xpos
                    py = f32(SAMPLE[s][1]) * hstep + ypos
                    hit = any(seg_isect(a[0], a[1], b[0], b[1], 0.5, 0.5, px, py) for a, b in zip(A, B))
                    hits[s] = hit
                    if hit and s == 0:
                        go_neighbour = True
                        break
            if not go_neighbour and hits[1] == hits[2] and hits[3] == hits[4]:
                mem[k] = 8
            else:
                cand = [CONNECTED['h'][hdir], CONNECTED['v'][vdir]]
                for r in range(2):
                    p3 = (hdir + 0.5, 0.5) if r == 0 else (0.5, vdir + 0.5)
                    blocked = any(seg_isect(a[0], a[1], b[0], b[1], p3[0], p3[1], xpos, ypos) for a, b in zip(A, B))
                    if not blocked:
                        mem[k] = cand[r]
                        break
                # else stays -1 (ambiguous)
            k += 1
    return mem


# ---- sub pixel weights and blend --------------------------------------------------------------
def sub_weights(X, Y):                            # 0x1003af820 calcSubpixelWeights; PATCH 3: stored as float32
    W = np.zeros((X * Y, 9), np.float32)
    for iy in range(1, Y + 1):
        for ix in range(1, X + 1):
            for m in range(9):
                fx = f32(DX[m]) + f32(0.5) - f32(ix) / f32(X + 1)
                fy = f32(DY[m]) + f32(0.5) - f32(iy) / f32(Y + 1)
                d2 = fy * fy + fx * fx
                W[(iy - 1) * X + (ix - 1), m] = 1.0 / math.sqrt(float(d2) if f32(0.01) <= d2 else 0.01)
    return W


def blended(D, M, W, X, Y, lx, ly, sub, owner):   # 0x1003af9b0; PATCH 3: float32 accumulation and quantisation
    row = int(f32(sub) * (f32(1) / f32(X)))
    col = sub - row * X
    right = (X + 0.5) * 0.5 <= col
    bottom = (Y + 0.5) * 0.5 <= row
    q = (1 + (1 if bottom else 0)) if right else (3 if bottom else 0)
    if owner == -1:
        members = list(QUAD[q])
    else:
        own = int(M[ly + DY[owner], lx + DX[owner]])
        members = []
        for m in QUAD[q]:
            if m == owner:
                members.append(m)
            else:
                b = N2ON[owner][m]
                if b != -1 and (own >> b) & 1:
                    members.append(m)
    num = f32(0); den = f32(0)
    for m in members:
        wgt = W[sub, m]
        if wgt > 0:
            den = den + wgt
            num = num + wgt * D[ly + DY[m], lx + DX[m]]
    if not den > 0:
        num = D[ly, lx]; den = f32(1)
    v = np.floor((num / den) * f32(10000) + f32(0.5)) / f32(10000)
    return v


def resample(D, thr=0.8, blend=True, X=5, Y=5, return_mem=False):
    D = np.asarray(D, np.float32)
    h, w = D.shape
    M = calc_similarity_map(D, thr)
    Meq = calc_similarity_map(D, 0.0) if (thr > 0 and blend) else None
    remove_diagonals_on_full_2x2(M, D)
    F = calc_flags(M)
    Wt = sub_weights(X, Y) if (thr > 0 and blend) else None
    out = np.zeros((h * Y, w * X), np.float32)
    memmap = np.full((h * Y, w * X), -2, np.int8)
    amb = []
    for ly in range(h):
        for lx in range(w):
            m = int(M[ly, lx])
            if (m & 0x5A) == 0x5A:                 # populateNonBoundaryRegion
                use_blend = thr > 0 and blend and int(Meq[ly, lx]) != 0xFF
                for sub in range(X * Y):
                    v = blended(D, M, Wt, X, Y, lx, ly, sub, 8) if use_blend else float(D[ly, lx])
                    out[ly * Y + sub // X, lx * X + sub % X] = v
                    memmap[ly * Y + sub // X, lx * X + sub % X] = 9
                continue
            segs = extract_boundaries_of_pixel(M, F, lx, ly)
            mem = eval_membership(segs, lx, ly, X, Y)
            for sub, v in enumerate(mem):
                oy, ox = ly * Y + sub // X, lx * X + sub % X
                memmap[oy, ox] = v
                if v < 0:
                    amb.append((ox, oy)); out[oy, ox] = OCC
                else:
                    if thr <= 0 or not blend:
                        out[oy, ox] = D[ly + DY[v], lx + DX[v]]
                    else:
                        out[oy, ox] = blended(D, M, Wt, X, Y, lx, ly, sub, v)
    populate_ambiguous(out, amb, thr)
    return (out, memmap) if return_mem else out


def populate_ambiguous(out, amb, thr):            # 0x1003b0830; PATCH 4 and 5
    H, Wd = out.shape
    thr32 = f32(thr)
    for (x, y) in amb:
        done = False
        for k in range(2):
            ys = 1 if k == 0 else -1
            def scan(dx, dy):
                xx, yy = x, y
                v = OCC
                while True:
                    xx += dx; yy += dy
                    if xx < 0 or xx >= Wd or yy < 0:
                        break
                    if yy < H:
                        v = out[yy, xx]
                    if v != OCC or yy >= H:
                        break
                return f32(v)
            a = scan(1, ys); b = scan(-1, -ys)
            if abs(a - b) < thr32:
                m = (a + b) * f32(0.5)
                if m != OCC:
                    out[y, x] = m; done = True
                break                              # PATCH 4: a sentinel average ends the diagonal loop
        if done:
            continue
        # fall back: minimum of the valid 4 neighbours (the engine does not bounds check this; we do)
        best = None
        for dx, dy in ((0, -1), (0, 1), (-1, 0), (1, 0)):
            xx, yy = x + dx, y + dy
            if 0 <= xx < Wd and 0 <= yy < H and out[yy, xx] != OCC:
                best = out[yy, xx] if best is None else min(best, out[yy, xx])
        if best is None:
            raise AssertionError('hadValid')
        out[y, x] = best


def show(out, near_thresh, title):
    print(title)
    for r in out:
        print(''.join('#' if v < near_thresh else '.' for v in r))
    print()


if __name__ == '__main__':
    import json
    req = json.load(sys.stdin)
    res = []
    for c in req['cases']:
        D = np.array(c['data'], np.float32).reshape(c['h'], c['w'])
        try:
            o = resample(D, c.get('thr', 0.8), c.get('blend', True), c.get('x', 5), c.get('x', 5))
            res.append({'data': [float(v) for v in o.ravel()]})
        except Exception as e:                       # report (IndexError of an out of image owner etc.)
            res.append({'error': repr(e)})
    json.dump(res, sys.stdout)
