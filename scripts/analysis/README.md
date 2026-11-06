# Analysis scripts

Tools used to tune the lattice filter (the diamond pattern full sensor renders can show at 3x and 4x). They work on linear RGB float32 files (`WIDTH x HEIGHT x 3`), which a render
can be dumped to; see the comments at the top of each file.

- `find-peaks.mjs`: the periodic peaks in a render and how prominent they are. Where the lattice's peaks sit, and that 2x has none.
- `tile-filter.mjs`: the filter at a given strength and detection, written to a new file.
- `lattice-band.py`: how much of the lattice band, and of the picture detail below it, a filtered file keeps. Needs numpy.

Measured with the defaults (detection 50, strength 75) on IMG_2797: 3x keeps about 14% of the band, 4x about 1.1%, with 99% of the band below untouched; at 2x the filter would remove
detail, so it is not run there.
