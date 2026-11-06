"""Energy in the lens-lattice band of a render, as a fraction of a reference render's.

The lens lattice shows up as a ring of spikes in the picture's spectrum: at about 0.25-0.29 cycles per pixel at 3x, 0.19-0.24 at 4x (none at 2x). This measures how much
of the ring is left after a filter, and how much of the band below it (picture detail) the filter touched.

  python3 lattice-band.py WIDTH HEIGHT LO HI reference.bin filtered.bin [more.bin ...]

The files are linear RGB, float32, WIDTH x HEIGHT x 3 (what tile-filter.mjs writes). LO and HI are the ring's radii in cycles per pixel (3x: 0.19 0.34; 4x: 0.17 0.27).
Prints, per file, the ring energy and the lower band's (0.03 .. LO - 0.02) as a fraction of the first file's.
"""
import sys

import numpy as np

W, H = int(sys.argv[1]), int(sys.argv[2])
LO, HI = float(sys.argv[3]), float(sys.argv[4])
files = sys.argv[5:]
N = 512


def luminance(path):
    a = np.fromfile(path, dtype=np.float32).reshape(H, W, 3)
    return np.sqrt(np.clip(0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2], 0, None))


def bands(path):
    y = luminance(path)[H // 4:H // 4 + N, W // 4:W // 4 + N]
    y = y - y.mean()
    spectrum = np.abs(np.fft.fftshift(np.fft.fft2(y * np.outer(np.hanning(N), np.hanning(N))))) ** 2
    fy, fx = np.meshgrid(np.fft.fftshift(np.fft.fftfreq(N)), np.fft.fftshift(np.fft.fftfreq(N)), indexing='ij')
    r = np.hypot(fx, fy)
    return spectrum[(r > LO) & (r < HI)].sum(), spectrum[(r > 0.03) & (r < LO - 0.02)].sum()


base = bands(files[0])
for f in files:
    b = bands(f)
    print(f'{f}: lattice band {b[0] / base[0]:.3f}  lower band {b[1] / base[1]:.3f}')
