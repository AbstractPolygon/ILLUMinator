# Hosted pages

The app test page and the plan are Artifact pages kept current by hand with every change. These scripts do the error-prone parts.

- `sync-test-page.mjs MIRROR_DIR`: copies what changed in `app/` into the test page's folder, rebuilds its `page.html`, and prints the changed paths as JSON. Publish `page.html`
  with `root` set to the folder and those paths as `files` and `overwrite_unread`.
- `plan-sync.mjs PLAN.html`: after editing the plan's visible text, rebuilds the JSON copy of it (`edit-src`) the page edits itself from. Then publish the file.

Both are safe to run again: they change nothing when nothing differs.
