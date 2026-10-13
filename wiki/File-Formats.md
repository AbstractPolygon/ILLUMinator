# File Formats

## The library: `library.json`

```json
{
  "format": "illuminator-library", "version": 1,
  "photos": [
    { "id": "IMG_0001", "name": "IMG_0001.LFR", "file": "IMG_0001.LFR", "sidecar": null,
      "thumb": "thumb.jpg", "size": 53012345, "photoId": "sha1-…", "added": "2026-10-13T12:00:00Z" }
  ],
  "albums": [ { "id": "album-1", "name": "Trips", "photos": ["IMG_0001"] } ]
}
```

A photo's `id` is its folder name under `Photos/`. `sidecar` is the Lytro Desktop edits file kept with it. `photoId` identifies the picture by its content (the sha1 of its raw data), so the same photo is not added twice.

## Edits: `edits.illuminator.json`

Kept in each photo's folder. Every control in the editing panels, grouped by panel, plus the viewpoint and the focus point:

```json
{
  "format": "illuminator-edits", "version": 1, "modified": "…",
  "photo": { "id": "…", "name": "…" },
  "process": { "ev": 0.5, "wb-temperature": 5200, "curve-points": "0,0;0.5,0.6;1,1", … },
  "camera": { "fstop": 6, "focus": -0.3, … },
  "details": { … }, "defringe": { … }, "animation": { … }, "rendering": { … },
  "geometry": { "orientation": 1, "straighten": 0, "crop-x": 0, "crop-y": 0, "crop-w": 1, "crop-h": 1, … },
  "view": { "u": 0, "v": 0 },
  "focusPoint": { "x": 0.5, "y": 0.5 }
}
```

Values missing from a file keep their defaults, so older edits files keep working as controls are added. A LUT (Process › LUT) is stored in the file too, so the edits do not depend on the `.cube` file it came from.

## Album archives: `<album>.illuminator-album.zip`

Made by *Export album…*. A standard zip (stored, not compressed; Zip64 past 4 GB) of:

```
album.json                    { "format": "illuminator-album", "version": 1, "name": "…",
                                "photos": [{ "folder", "name", "file", "sidecar", "thumb", "edits" }] }
Photos/<folder>/<photo file>
Photos/<folder>/stack.view.lfp           (Lytro Desktop edits, if any)
Photos/<folder>/thumb.jpg
Photos/<folder>/edits.illuminator.json
```

## Lytro files

`.LFR` and `.LFP` files are containers of sections: a table of contents (JSON), metadata, the raw sensor image, thumbnails and, in processed files, pictures and depth maps. ILLUMinator reads first generation (`picture.frameArray`) and second generation (ILLUM, `frames` and `views`) layouts. Lytro Desktop's edits are the `recipe` in a picture's views (`stack.view.lfp`).
