# Splitting main.js

`app/js/main.js` was one file of 7,700 lines. Sections that stand on their own now live under `app/js/ui/` (updates, number fields, tone curve, color matrix, white balance
picker, LUT, frame rate, 3D, local adjustments, living filters, keyframes, curves view, export, camera import, camera section), about 3,500 lines (it is now about 4,250). The rest is held together by shared variables, so it cannot be cut apart by moving code alone.

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

The tool refuses a section when it shares a `let` variable with the rest of the page, since a copy handed to the new module would silently go out of step. Each such variable has been
put on the page's `state` object instead (`state.maskSel`, `state.anim`, `state.keySel`, `state.fps`, `state.upscaleShown`, `state.lib`, `state.cameraSection`, `state.rememberedFailed`, `state.webUsb*`, `state.askCameraPermission`), which every module is handed:

1. Find what still blocks: `node scripts/extract-section.mjs "<section>" x y --dry` lists the `let` variables the section shares.
2. For each, check it is declared once at the top level (no local variable of the same name), then rename every use to `state.<name>` and give it its starting value in the `state` literal at
   the top of main.js (the renames were made with a parser, not a text search, so a property or a string with the same name is left alone).
3. If the variable turns out to always equal another field (`KEY_FPS` was always `state.fps`), use that field.
4. Move the section, then lint, `node scripts/smoke-page.mjs`, and the settings check above.

Nothing that blocks a section is left. What remains in main.js (about 4,250 lines) is the page's core, which everything else calls: the camera view and its settings, drawing, pointer
handling, zoom, crop, the edits and undo machinery, opening photos, menus, the library and its grid. Splitting those further would mean choosing seams that do not exist yet (for example a
`view` module that owns drawing and zoom), which is a design question rather than a move; do it when a feature needs one of them changed.

A section that only reads a shared object's fields can be handed a getter instead (`getAnim: () => anim`), and a section that assigns a shared variable needs a getter and a setter.
The tool ends a section at the next `// ------` header or at the `// name: ui/file.js` line left where an earlier section was moved.
