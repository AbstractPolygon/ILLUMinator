# Editing

The editing panels are in the right sidebar. Each slider shows its value; double-click a slider to reset it. Everything you change is saved with the photo.

## In the picture

- **Click** to focus on that spot. With a small aperture the click also opens it up to f/2.8, so the change shows.
- **Drag** to move the viewpoint, like grabbing the scene and turning it.
- **Shift-drag**, or drag when zoomed in on the lenslet view, to pan. Zoom with the − / + buttons below the picture, *Fit* and *1:1*.

## Histogram, Info

The histogram of the picture as shown, and the camera, lens and file details.

## Crop

- **Rotate left / right** and **Flip** (mirror).
- **Straighten:** up to ±45°; the picture is trimmed so no corner is empty.
- **Aspect ratio:** Free, Original, 1:1, 5:4, 4:3, 3:2, 16:9.
- **Crop:** shows a frame on the picture. Drag inside it to move it, drag its corners and edges to resize it, or drag on the picture to draw a new one. **Enter** (or *Done*) applies it, **Esc** cancels. Choosing an aspect ratio opens the frame too.
- **Reset:** back to the whole picture.

Focus clicks, the white balance picker, exports and animations all follow the crop.

## Process

**White Balance.** *Auto*, or *Temperature* (kelvin) and *Tint*. The eyedropper picks the white balance from something in the photo that should be neutral (click it; Esc cancels).

**Tone.** *Exposure* (EV), *Contrast*, *Highlights*, *Shadows*, *Whites*, *Blacks*.

**Tone Curve.** A curve over brightness, from black (left) to white (right): click to add a point, drag it, double-click to remove it. The curve never reverses, so tones keep their order. Below it, *Highlights*, *Lights*, *Darks* and *Shadows* lift or lower each quarter of the range. *Reset curve* straightens it.

**Color.** *Saturation*, *Vibrance* (boosts muted colors more than strong ones), and saturation for *Red*, *Yellow*, *Green*, *Cyan*, *Blue* and *Magenta*.

**Color Matrix.** How the camera's colors become screen colors: *Camera* (the matrix the camera recorded), *None* (the sensor's colors as they are) or *Custom*, an editable 3 × 3 matrix that starts from the camera's (rows are output red, green and blue; columns camera red, green and blue).

## Local Adjustments

Up to four masks, each with its own effect: *Exposure*, *Contrast*, *Saturation*, *Temperature* and *Tint*.

- **+ Radial:** an ellipse (*Center X/Y*, *Width*, *Height*), full effect inside and fading out over *Feather*.
- **+ Gradient:** a graduated filter: full effect on one side of a line through *Center X/Y* at an *Angle*, fading to none over *Fade*.
- **+ Depth:** uses the light field's depth: full effect between a *Near* and a *Far* depth (negative is nearer than the camera's focus), fading over *Feather*. Brighten a subject, darken or desaturate the background, and so on.

Click a mask in the list to edit it, × to delete it. *Enabled* turns it off without losing it, *Invert* swaps inside and outside, and *Show mask* tints what it covers red while you adjust it.

## Camera

The light field controls.

**Depth.**
- *Aperture:* f/22 to f/0.5. Small apertures keep everything sharp; wide ones blur what is away from the focus (click the picture to choose what is in focus). Beyond the camera's own f/2 the blur is synthetic, using the depth map.
- *Depth:* how quickly things blur away from the focus.
- *Smoothing:* smooths the depth map, following the picture's edges.
- *Show depth map.*

**Focus Spread.**
- *Focus Point:* where you last clicked; spread and tilt are centered there.
- *Spread:* a range of depth kept sharp on each side of the focus.
- *Smoothing:* softens the edges of that range, so blur builds up gradually.
- *Show spread:* tints what lies outside it, blue nearer and orange farther.

**Tilt.** Tilts the plane of focus, like a tilt-shift lens: *Tilt* is the amount, *Rotation* the direction.

**Perspective.** Moving the viewpoint shifts every depth but one, the focus plane (or the camera's own focus with the aperture closed). *Custom pivot* and *Pivot depth* choose another depth to stay still.

**Bokeh.** The shape of out-of-focus highlights: *Natural*, *Optical (softer)*, *Circle* or *Hexagon*, and *Highlights* to make bright points glow into bokeh balls.

## Details

**Sharpening.** *Amount*, *Radius*, *Detail* (lower holds back strong edges, for fewer halos) and *Masking* (sharpen only edges: 0 everywhere, 100 only the strongest edges).

**Noise Reduction.** *Multi-view* averages the many viewpoints a light field holds (with *Blend*), then *Luminance* and *Color* noise reduction.

## Optics

**Chromatic Aberration.** Removes colored fringes along high-contrast edges. *Enabled*, *Auto* (finds the fringe colors itself), *Radius*, *Threshold*, and amount and hue for purple, green, red and blue fringes.

**Lens Correction.**
- *Distortion:* negative straightens barrel distortion (lines bowing outward), positive pincushion. The picture is enlarged just enough that no edge shows.
- *Vignetting:* brightens (or darkens) the corners; *Midpoint* sets how far from the middle it starts.

**Flare.** *Reduce flare* removes the haze that light scattered in the lens lays over the picture; *Amount* sets how much.

## Animation

*Enabled* turns on playing, scrubbing and video export.

- *Animate: Viewpoint* moves the viewpoint along a *Path* (circle, left–right, up–down, figure eight, diagonal) by an *Amount*, in a number of *Frames*.
- *Animate: Focus sweep* refocuses from *Near* to *Far* in a number of *Steps*.

Play with the button below the picture (or Space) and scrub with the slider.

## Rendering

- *Resolution:* the picture's resolution while editing, 1× (fast), 1.5× or 2×.
- *Full resolution* (F): renders a high resolution still from every pixel of the sensor. *Scale* sets its size (2×, 3× or 4× the lens grid) and *Detail recovery* adds passes that bring back more fine detail (slower). *Render* starts it.

## Microlens grid

In *Lenslets* mode, the raw image under the microlenses. The grid ILLUMinator uses to decode the light field is shown and can be measured again from the picture (*Recalibrate*) or reset to the camera's calibration (*Use metadata*); *X* and *Y* move around the sensor.
