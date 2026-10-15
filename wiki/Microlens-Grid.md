# Microlens Grid

In *Lenslets* mode, the raw sensor under the microlenses. **Scroll** to zoom (from the whole sensor down to single pixels, up to 3200%) and **drag** to move around it; the − / + buttons, the zoom label (whole sensor) and *1:1* (one screen pixel per sensor pixel) work too. The section sits under Optics; Process, Optics and the other editing sections are hidden in this mode.

The grid ILLUMinator uses to decode the light field is drawn on the lenses (their centers in amber) and can be measured again from the picture (*Recalibrate*) or reset to the camera's calibration (*Use metadata*). Brightness is scaled to the whole sensor's highlights, so it stays the same while you move around.

## Full Sensor Sampling

How a *Full sensor* render (see [[Render]]) uses the part of the sensor shown, at the *Scale* chosen under Render Settings → Quality:

- *Sampling circles* (blue): the pixels inside each circle are the ones the render uses from that lens; the dark edges outside are left out.
- *Coverage at the current focus*: how many samples land on each pixel of the render, at the focus set in the Camera view. Dark pixels get few samples and are filled in from the standard picture; at some focus depths the samples bunch up into a lattice, which is why those depths render softer and what *Detail recovery* helps with.
- *Last Full sensor render* (or *Camera view* before one is made): the same part of the picture, to compare with the raw pixels.

Both views follow what the main view shows at any zoom and keep their size; zoomed far out, the coverage is shown in blocks of render pixels.
