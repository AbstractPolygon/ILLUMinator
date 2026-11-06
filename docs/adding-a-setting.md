# Adding a setting

A slider, checkbox or menu that changes the picture touches four places. Two tests fail if one is missed.

1. **The control** in `app/index.html`, with an `id` (and `data-default` for a slider, so Reset works).
2. **Saved with the photo:** add the id to its panel's list in `EDIT_GROUPS` in `app/js/edits.js`. Without this the setting resets every time the photo is opened
   (`test/settings-saved.test.mjs` fails for a control with a default that is not listed).
3. **Sent to the engine:** add one row to `COLOR_SETTINGS` or `RENDER_SETTINGS` in `app/js/settingsmap.js`: `[path in the settings object, control id, how to read it]`
   (`num`, `pct` for percent to 0..1, `gain`, `bool`, `str`, or a function). A setting built from several controls is written out below the tables in that file.
4. **Used by the worker:** read `state.settings.<path>` in `app/js/worker.js`.

Then, if the page's output changed on purpose, record the new reference:
`node scripts/capture-settings.mjs test/fixtures/settings-golden.json PATH_TO_PLAYWRIGHT` (it needs Playwright, which the project does not depend on) and check that the diff is only your setting.
`test/settings.test.mjs` replays recorded states of the controls through `settingsmap.js` and compares with what the page sent.
