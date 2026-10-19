# Working preferences (standing, from the project owner)

- **Website artifact: update it immediately.** After every change to the website, publish
  https://claude.ai/artifact/FTjsgXaBg9a4fpYdC5BC8N *first*, then update the repo (`site/`). Do not wait for other
  pending changes or batch them. The artifact is the source of truth for the page's copy (the owner edits text in
  the page itself): read the newest version and merge before publishing (a publish is refused when a newer one
  exists). In the repo, gallery images live in `site/gallery/` (the artifact embeds them as data URIs) and the
  version number is the `{{version}}` placeholder (the artifact shows the latest released number).
- **Other hosted pages, kept current with every change:** the app test page
  https://claude.ai/artifact/7iMs8Ui6dosv8Ao9CRk7iG and the plan https://claude.ai/artifact/GrYsxNJiktg2vkgxsg5zWK.
- **Releases:** deploy the web app (pages.yml) before the desktop builds (desktop.yml).
- **Do not revert or change a default the owner asked for without their permission** (the combined depth is the
  default depth style).
- **Comparison images** (website gallery, comparison page) are rendered with the app's defaults, so multi-view noise
  reduction stays on.
- When the stop hook reports uncommitted changes, commit and push to `main`.
