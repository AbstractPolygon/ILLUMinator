# Troubleshooting

**The picture is slow to appear or to change.** The first open of a photo measures its depth, which takes a few seconds. Lower *Render → Resolution* to 1× for speed. Info shows the renderer in use: *CPU* means WebGL 2 is not available, which is much slower; on a laptop, check that the browser may use the faster graphics chip. *GPU time* in Info shows how long each view takes on the GPU.

**The picture looks rougher while dragging.** Strong depth of field blur is drawn as a quicker draft while a slider or the picture is dragged; the finished picture follows on release.

**Photos are gone after closing the browser.** Some browsers (or private windows) do not let sites store files. Settings → Library location says *Not available* then. Use another browser, a normal window, or the desktop app.

**Lytro Desktop edits were not applied.** They are used only for photos that have no Illuminator edits yet. Open the picture's `raw.lfp` together with its `stack.view.lfp` (importing a Lytro Desktop library does this for you). The note over the picture lists edits that are not supported yet.

**Report a problem:** [GitHub issues](https://github.com/AbstractPolygon/Illuminator/issues).

**The first generation camera does not show (Windows).** It is read through its disk, which needs the camera switched on and its USB cable connected; the *Import from camera…* dialog's diagnostics list the disks it saw. If its thumbnails look like colour noise, send the camera log, which says how the thumbnail files are stored.

**Depth measuring is slow.** With a real graphics card the depth is measured on it; when a step falls back to the processor, or only a software renderer is found, a note appears over the picture. Choosing *Depth method → Illuminator* is the quickest measurement.

**Limiting the memory the app uses.** In the desktop app, Settings > Memory has two sliders: the most RAM and the most video memory (VRAM) the app may plan to use, each from 1 GB up to what the computer has less what is left for the system (4 GB of RAM, 512 MB of video memory; the video memory is read from the graphics card; a card that shares the computer's memory counts as half of it). They start at the top. Lower them to keep the app out of the way of other programs: a full sensor render, a 16-bit export or an upscaling model that would need more than the limit is not started, and the notice says what to lower. The limits also cap the app's JavaScript memory and the video memory its browser engine plans for, which applies the next time the app starts.
