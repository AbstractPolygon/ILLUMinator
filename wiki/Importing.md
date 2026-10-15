# Importing

## From Lytro Desktop

*+ Import Lytro library…* in the left sidebar (under *+ New album*), or **Settings → Import Lytro Desktop library…**, then choose your Lytro Desktop library folder. This needs the desktop app; in the browser version the button explains this and links to the download. The folder is usually:

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
- *Depth map:* the depth map Lytro Desktop computed (in `stack.lfp`) is kept with the photo and used for blur and depth masks; one edited in Lytro Desktop (`stack.userdepthmap.png`) is kept too and used first. *Lytro Desktop depth map* under [[Camera]] → Depth turns it off.

Some things have no equivalent yet and are listed in the note: animated sharpening, noise reduction, defringe radius and 3D (they keep their starting value), the 3D pivot, the Glass, Line Art and 8-Track filters, and effects that shift hues, fill with a color, insert an image or combine a place and a depth mask (these keep the place). Depth ranges of effects are matched to a typical picture's depth, so check them on photos with a very deep or very shallow scene.

Importing the same library again replaces the photos already imported from it (matched by name) with the new files: their Lytro Desktop edits apply again and changes made in ILLUMinator start over. They keep their place in albums.

Lytro Desktop keeps its albums in a database ILLUMinator does not read, so they are not imported; the album named after the folder holds everything instead.

## From another ILLUMinator library

An album exported with *Export album…* (see [[Library and Albums]]) is a `.zip`. Drop it on the window: its photos join the library with their edits, and the album is made again (or joined, if one has its name). A photo already in the library is not copied twice, and its edits there are kept. This is how to move photos from the browser version to the desktop app.

## From files

Drag files onto the window (in the desktop app, also *File → Import Lytro File…*). To bring Lytro Desktop's edits for a single picture, open its `raw.lfp` together with its `stack.view.lfp`; an exported `IMG_0001.LFP` opened with `IMG_0001.LFR` works the same way.

## Camera calibration

Every camera is calibrated at the factory, and the data is specific to that camera: a list of defective pixels, the lens grid at each zoom and focus setting, and white images. Open **Settings** (the gear at the top right) and use **Camera calibration** to add it, either from the camera's backup (a `.tar` file) or from its unpacked folder. Backups are over a gigabyte, so the app reads the file in place and keeps only the small files: the tables and the hot pixel list. The big white images stay where they are.

The calibration is kept in your library and applies to every photo taken with the same camera, matched by the serial number stored in the photo. Photos open with it the next time they are opened. **Remove** in the same place deletes it.

The camera's hot pixel list is used together with the search that *Remove hot pixels* does. The white images (one for each zoom and focus setting, 34 in an ILLUM backup) are measured while the backup is added, which takes a minute or so: each shows where every lens really sits, and only those centers are kept, a few hundred kilobytes per image. A photo made with one of them uses its lens centers directly, so it skips the measuring step it otherwise needs at its first full-resolution render. Lens grid tables and focus tables are added next.
