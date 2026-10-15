# Process

## LUT

A color lookup table applied as the last step of the look, after every other adjustment.

*Film look* chooses one of 296 film emulation LUTs that come with ILLUMinator, grouped as color negative, color slide, black and white, print film, instant film and Fujifilm X-Trans III looks. They are from the [G'MIC Film LUTs Collection](https://github.com/YahiaAngelo/Film-Luts) (MIT License). *Import LUT…* reads a 3D LUT in `.cube` format, as made by DaVinci Resolve, Premiere and most LUT packs (up to 65 × 65 × 65). The LUT is saved with the photo's edits, so it travels with the photo. *Amount* blends between the picture without the LUT (0%) and with it (100%); the trash button <img src="images/delete.png" width="20" height="20" alt="Remove LUT"> removes it.

## White Balance

*Auto*, or *Temperature* (kelvin) and *Tint*. The eyedropper <img src="images/wb-pick.png" width="20" height="20" alt="Pick white balance"> picks the white balance from something in the photo that should be neutral (click it; Esc cancels).

## Tone

*Look* sets how the picture starts out, before the other sliders:

- *Lytro Desktop* (the starting choice): the camera's exposure with Lytro Desktop's contrast and color, so raw photos open looking as they do in Lytro Desktop, with deep shadows and rich color. Measured against Lytro Desktop's own pictures of the same photos.
- *Flat:* an exposure picked for each photo (its brightest parts just below white) and no curve. A neutral start that keeps the most shadow detail, for grading from scratch.

Exported pictures that Lytro Desktop finished already (`.LFP` files without a light field) keep their look.

*Exposure* (EV), *Contrast*, *Highlights*, *Shadows*, *Whites* and *Blacks*.

Blown-out highlights keep more detail than the sensor's middle pixels hold: the edge of each microlens image is darker (vignetting), so it often still holds a bright area the middle lost, and raw photos take those areas from there. Lower *Exposure* or *Highlights* to bring that detail into view.

## Tone Curve

A curve over brightness, from black (left) to white (right): click to add a point, drag it, double-click to remove it. The curve never reverses, so tones keep their order. Below it, *Highlights*, *Lights*, *Darks* and *Shadows* lift or lower each quarter of the range. *Reset curve* straightens it.

## Color

*Saturation*, *Vibrance* (boosts muted colors more than strong ones), and saturation for *Red*, *Yellow*, *Green*, *Cyan*, *Blue* and *Magenta*.

## Color Matrix

How the camera's colors become screen colors: *Camera* (the matrix the camera recorded), *None* (the sensor's colors as they are) or *Custom*, an editable 3 × 3 matrix that starts from the camera's (rows are output red, green and blue; columns camera red, green and blue).
