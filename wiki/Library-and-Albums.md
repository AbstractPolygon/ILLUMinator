# Library and Albums

## The library

Every photo you open, drop or import is copied into the library, each in a separate folder with its edits next to it. Your original files are never changed.

- **Desktop app:** the library is a folder, `Pictures/ILLUMinator` by default. Change it in **Settings → Library location → Choose folder…**.
- **Browser:** the library is kept in the browser's private storage for the site. If the browser cannot store files (some private windows), photos are kept until the page is closed, and the sidebar says so.

The library folder looks like this:

```
library.json                        the list of photos and albums
Photos/IMG_0001/IMG_0001.LFR        the photo
               /edits.illuminator.json   its edits
               /thumb.jpg           its thumbnail
Photos/Beach/raw.lfp                imported from Lytro Desktop
            /stack.view.lfp         with Lytro Desktop's edits
```

The folders are the truth: copy a photo folder into `Photos/` and it appears in the library the next time it opens; delete one and it disappears. The same photo is never added twice (photos are recognized by their content, not their name).

## Albums

Albums are listed at the top of the left sidebar.

- **New album:** *+ New album*, type a name, Enter.
- **Add photos:** drag photos from the list or the grid onto an album, or use **•••** on a photo and tick albums.
- **Remove from an album:** **•••** on the photo, untick the album.
- **Rename or delete an album:** **•••** next to the album. Deleting an album keeps its photos in the library.
- **Export an album:** **•••** next to the album → *Export album…* saves one `.zip` with the album's original photos, their edits, Lytro Desktop edits and thumbnails. Import that file (the *Import* button, or drop it on the window) in another library, such as the desktop app's after using the browser version, and the photos join that library with their edits and the album is made again.
- **Delete a photo:** **•••** on the photo → *Delete from library…*. In the desktop app its folder goes to the trash.

Photos you open while an album is selected are added to that album too.

## Thumbnail grid

Choosing *All photos* or an album shows its photos as a grid in the middle of the window. Make the thumbnails bigger or smaller with the slider and buttons above the grid, or the **+** and **−** keys. Click a thumbnail (or select it and press Enter) to open the photo.
