# Details

## Sharpening

*Amount*, *Radius*, *Detail* (lower holds back strong edges, for fewer halos) and *Masking* (sharpen only edges: 0 everywhere, 100 only the strongest edges).

## Noise Reduction

*Multi-view* averages the many viewpoints a light field holds (with *Blend*), then *Luminance* and *Color* noise reduction.

*Dust* fills small, faint dark spots left by dust on the sensor or lens; higher values remove larger spots. Strong dark detail, like eyes and lettering, is left alone. *Speckles* removes single pixels that stand out from all their neighbors, such as hot or dead pixels.
