# Importing

## From the camera

**Import from camera…** in the top bar.

- **Desktop app:** connect the ILLUM with its USB cable and switch it on; it appears as a drive and ILLUMinator finds it by itself (the top bar shows *Lytro camera connected*). Cameras with USB debugging enabled are also found if `adb` is installed. Pick the photos and *Import selected*; they are copied into your library.
- **Browser:** the camera appears as a removable drive. Choose the drive (or its `DCIM` folder) when asked.

## From Lytro Desktop

**Settings → Import Lytro Desktop library…**, then choose your Lytro Desktop library folder. It is usually:

- macOS: `Pictures/Lytro Desktop/Libraries/Lytro Library.lytrolibrary`
- Windows: `Pictures\Lytro Desktop\Libraries\Lytro Library.lytrolibrary`

Every picture in it (and in all its subfolders) is added to the library, in a new album named after the folder. The same works for any folder of Lytro photos, such as a copy of a camera card.

The edits you made in Lytro Desktop come along: when a picture is first opened, ILLUMinator applies them and says so in a note over the picture. Edits it does not support yet are listed in that note. Once you change something, ILLUMinator saves the edits in its format and uses them from then on.

What carries over from Lytro Desktop: focus, aperture, focus spread, tilt, viewpoint, perspective pivot, exposure, white balance, contrast, highlights, shadows, whites, blacks, saturation, vibrance, per-color saturation, sharpening (amount, radius, detail, edge masking), noise reduction, defringe, reduce flare, crop, straighten and orientation.

Lytro Desktop keeps its albums in a database ILLUMinator does not read, so they are not imported; the album named after the folder holds everything instead.

## From another ILLUMinator library

An album exported with *Export album…* (see [[Library and Albums]]) is a `.zip`. Open it with **Open…** or drop it on the window: its photos join the library with their edits, and the album is made again (or joined, if one has its name). A photo already in the library is not copied twice, and its edits there are kept. This is how to move photos from the browser version to the desktop app.

## From files

**Open…** or drag files onto the window. To bring Lytro Desktop's edits for a single picture, open its `raw.lfp` together with its `stack.view.lfp`; an exported `IMG_0001.LFP` opened with `IMG_0001.LFR` works the same way.
