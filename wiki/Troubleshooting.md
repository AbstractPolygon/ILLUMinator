# Troubleshooting

**The picture is slow to appear or to change.** The first open of a photo measures its depth, which takes a few seconds. Lower *Render → Resolution* to 1× for speed. Info shows the renderer in use: *CPU* means WebGL 2 is not available, which is much slower; on a laptop, check that the browser may use the faster graphics chip. *GPU time* in Info shows how long each view takes on the GPU.

**The picture looks rougher while dragging.** Strong depth of field blur is drawn as a quicker draft while a slider or the picture is dragged; the finished picture follows on release.

**Photos are gone after closing the browser.** Some browsers (or private windows) do not let sites store files. Settings → Library location says *Not available* then. Use another browser, a normal window, or the desktop app.

**Lytro Desktop edits were not applied.** They are used only for photos that have no ILLUMinator edits yet. Open the picture's `raw.lfp` together with its `stack.view.lfp` (importing a Lytro Desktop library does this for you). The note over the picture lists edits that are not supported yet.

**Report a problem:** [GitHub issues](https://github.com/AbstractPolygon/ILLUMinator/issues).
