# Local Adjustments

Masks that change part of the picture. A photo can have up to 16. The buttons need an open photo.

## Masks

- **Radial:** an ellipse (*Center X/Y*, *Width*, *Height*), full effect inside, fading out over *Feather*.
- **Gradient:** a graduated filter: full effect on one side of a line through *Center X/Y* at an *Angle*, fading to none over *Width*.
- **Depth:** uses the light field's depth: full effect between a *Near* and a *Far* depth (negative is nearer than the camera's focus), fading over *Feather*. *Follow focus* moves the range with the focus, so it keeps the same distance from it, also when the focus is animated.

Click a mask in the list to edit it, the pencil (or a double-click on its name) to rename it, and the trash button to delete it (you are asked first). A mask's name is also the name of its group in the keyframe editor.

- *Enabled* turns a mask off without losing it. A disabled mask shows only *Enabled* and *Delete mask*, and its keyframes are hidden in the keyframe editor.
- *Invert* swaps inside and outside.
- *Show mask* tints what the mask covers red while you adjust it.
- *Strength* scales the whole effect, from 0 to 100%.

## Effect

*Exposure*, *Contrast*, *Saturation*, *Temperature* and *Tint*, plus three effects that work on the area around each pixel:

- *Blur* softens what the mask covers.
- *Pixelate* breaks it into square tiles.
- *Sketch* turns it into a colored-pencil drawing.

## Filters

The *Filters* menu adds ready-made looks built from masks around the current focus. Once added, they are ordinary masks to adjust, named after the filter. The depth-based ones follow the focus.

| Filter | Look |
| --- | --- |
| Color pop | Only what is in focus keeps its color |
| Spotlight | Darker away from the focus point |
| Depth haze | Farther away is paler and softer, like air |
| Dreamy | What is not in focus glows a little |
| Film noir | Hard black and white, the subject lit a little brighter |
| Melancholy | Everything but the subject turns muted and blue |
| Carnival | The background turns bright and festive |
| Pinhole | A deep vignette that shifts with the viewpoint |
| Golden hour | Warm, glowing light on the far background |
| Blur+ | What is out of focus turns softer still |
| Mosaic | What is out of focus breaks into tiles |
| Crayon | What is out of focus turns into a colored-pencil drawing |

Every setting of a mask, filters included, can be animated: the ◀ ◆ ▶ at the right of each of the selected mask's settings adds or removes its keyframes and moves between them. See [[Animation]].
