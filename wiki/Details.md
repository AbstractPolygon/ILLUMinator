# Details

## Sharpening

*Amount*, *Radius*, *Detail* (lower holds back strong edges, for fewer halos) and *Masking* (sharpen only edges: 0 everywhere, 100 only the strongest edges).

## Noise Reduction

*Multi-view* averages the many viewpoints a light field holds (with *Blend*), then *Luminance* and *Color* noise reduction.

*Dust* fills small, faint dark spots left by dust on the sensor or lens; higher values remove larger spots. Strong dark detail, like eyes and lettering, is left alone. *Despeckle* removes small bright or dark specks, filling them from the surroundings; *Speck size* sets the largest speck removed (1 to 5 pixels across). Larger spots, lines and edges are kept. *Remove hot pixels* (on by default) finds hot, warm and dead pixels on the sensor and fills them from their neighbors before the picture is made; the photo's Info shows how many were fixed.
