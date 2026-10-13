# Troubleshooting

**The picture is slow to appear or to change.** The first open of a photo measures its depth, which takes a few seconds. Lower *Rendering → Resolution* to 1× for speed. Without WebGL 2 everything runs on the CPU, which is much slower.

**Photos are gone after closing the browser.** Some browsers (or private windows) do not let sites store files. Settings → Library location says *Not available* then. Use another browser, a normal window, or the desktop app.

**The camera is not found (desktop app).** Connect it with its USB cable and switch it on; it should appear as a drive with a `DCIM` folder. In a browser, choose the drive yourself when asked.

**Lytro Desktop edits were not applied.** They are used only for photos that have no ILLUMinator edits yet. Open the picture's `raw.lfp` together with its `stack.view.lfp` (importing a Lytro Desktop library does this for you). The note over the picture lists edits that are not supported yet.

**Report a problem:** [GitHub issues](https://github.com/AbstractPolygon/ILLUMinator/issues).
