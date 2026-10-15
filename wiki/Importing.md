# Importing

## From Lytro Desktop

**Settings → Import Lytro Desktop library…**, then choose your Lytro Desktop library folder. It is usually:

- macOS: `Pictures/Lytro Desktop/Libraries/Lytro Library.lytrolibrary`
- Windows: `Pictures\Lytro Desktop\Libraries\Lytro Library.lytrolibrary`

Every picture in it (and in all its subfolders) is added to the library, in a new album named after the folder. The same works for any folder of Lytro photos, such as a copy of a camera card.

The edits you made in Lytro Desktop come along: when a picture is first opened, ILLUMinator applies them and says so in a note over the picture. Edits it does not support yet are listed in that note. Once you change something, ILLUMinator saves the edits in its format and uses them from then on.

What carries over from Lytro Desktop:

- *Camera:* focus, focus point, aperture, focus spread, tilt, viewpoint and perspective pivot.
- *Process:* exposure, white balance, contrast, highlights, shadows, whites, blacks, saturation, vibrance, per-color saturation, the tone curve (its points and its Highlights, Lights, Darks and Shadows) and a custom color matrix.
- *Details and Optics:* sharpening (amount, radius, detail, edge masking), noise reduction, defringe and reduce flare.
- *Crop:* crop, straighten and orientation.
- *Animation:* every animated setting becomes keyframes, curves included, with Keyframe animation turned on: focus, focus point, aperture, focus spread, tilt, viewpoint, pivot, zoom, pan, exposure, white balance, the tone sliders, saturation and defringe threshold. Zoom and pan carry over when they are not animated too.
- *Effects:* each of Lytro Desktop's effect layers becomes a local adjustment, named *Lytro effect 1*, *2* and so on: its ellipse or depth range as the mask, and its exposure, contrast, brightness, saturation and black and white as the effects. Lytro's living filters Film Noir, Carnival, Mosaic, Crayon, Blur+ and Pop become ILLUMinator's filters of the same kind.
- *3D:* the stereo baseline.

Some things have no equivalent yet and are listed in the note: animated sharpening, noise reduction, defringe radius and 3D (they keep their starting value), the 3D pivot, the Glass, Line Art and 8-Track filters, and effects that shift hues, fill with a color, insert an image or combine a place and a depth mask (these keep the place). Depth ranges of effects are matched to a typical picture's depth, so check them on photos with a very deep or very shallow scene.

Importing the same library again replaces the photos already imported from it (matched by name) with the new files: their Lytro Desktop edits apply again and changes made in ILLUMinator start over. They keep their place in albums.

Lytro Desktop keeps its albums in a database ILLUMinator does not read, so they are not imported; the album named after the folder holds everything instead.

## From another ILLUMinator library

An album exported with *Export album…* (see [[Library and Albums]]) is a `.zip`. Open it with the **Open** icon in the top bar or drop it on the window: its photos join the library with their edits, and the album is made again (or joined, if one has its name). A photo already in the library is not copied twice, and its edits there are kept. This is how to move photos from the browser version to the desktop app.

## From files

The **Open** icon (a folder) in the top bar, or drag files onto the window. To bring Lytro Desktop's edits for a single picture, open its `raw.lfp` together with its `stack.view.lfp`; an exported `IMG_0001.LFP` opened with `IMG_0001.LFR` works the same way.
