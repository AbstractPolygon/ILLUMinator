# Splitting main.js

`app/js/main.js` was one file of 7,700 lines. Sections that stand on their own now live under `app/js/ui/` (updates, number fields, tone curve, color matrix, white balance
picker, LUT, frame rate, 3D, local adjustments, living filters), about 760 lines. The rest is held together by shared variables, so it cannot be cut apart by moving code alone.

## How a section moves

`node scripts/extract-section.mjs "<section name>" ui/<name>.js init<Name>` moves the lines between two `// ------ name` markers into a module:

```js
export function initThing({ $, state, scheduleSave }) { ...the section's code...; return { whatTheRestUses }; }
```

and main.js calls it where the section was: `const { whatTheRestUses } = initThing({ $, state, scheduleSave: (...a) => scheduleSave(...a) });`.
Functions are handed over as wrappers, so a function defined later in main.js is looked up when it is called, not when the section starts.

Afterwards: `npm run lint` (a name the section needs but was not handed over is a `no-undef` error), `node scripts/smoke-page.mjs PLAYWRIGHT_PATH` (the page loads without errors and the
controls it handles react) and `node scripts/capture-settings.mjs OUT.json PLAYWRIGHT_PATH` followed by `cmp OUT.json test/fixtures/settings-golden.json`.

## What stops the rest

The tool refuses a section when it shares a `let` variable with the rest of the page, since a copy handed to the new module would silently go out of step:

| Variable | Used by | Needed to move |
|---|---|---|
| `anim`, `keySel` (keyframes) | keyframes (1,200 lines), curves view (600), export, undo | one `keyframes` state object that every reader goes through |
| `upscaleShown`, `rememberedFailed`, `webUsb*` | export, camera import, camera section | getters and setters, or a small state object per area |

A section that assigns a shared variable itself (the frame rate section sets `KEY_FPS`) needs a getter and setter handed over; `ui/framerate.js` shows how.
Done this way already: the selected mask was `let maskSel`; it is now `state.maskSel` (a field of the page's `state` object, which every module is handed), which is what freed local adjustments
and living filters. The same step for `anim` and `keySel` is next: put them on one `keyframes` state object, change every `anim` to `state.keyframes.anim` (note `anim` is assigned
whole in `loadAnimation`, so it becomes a field), and the keyframes (1,200 lines) and curves view (600) can move, then export, then the camera sections.

A section that only reads a shared object's fields can be handed a getter instead (`getAnim: () => anim`), as `ui/localadjust.js` is for the keyframes it clears.
The tool ends a section at the next `// ------` header or at the `// name: ui/file.js` line left where an earlier section was moved.
