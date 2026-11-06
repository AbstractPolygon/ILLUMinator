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
- **American spelling in all text** (UI labels, tooltips, wiki, website, plan pages): center, color, gray, behavior, and so on.
- **Release notices include a short summary of what's new.** Whenever a user is told about a new release (the app's update pop-up, a message to the owner, the website), add 3–5 one-line bullets in plain language: the benefit first (a bold lead, then one simple sentence), only changes a person would notice, no internal terms. The summary lives in `docs/release-notes/<version>.md`; the release workflow puts it under "What's new" in the GitHub release and the app's update pop-up shows it. Write it for every release before running the desktop build.
- **Don't use the word "own" in text** (UI labels, tooltips, wiki, website, plan pages, release notes, messages) when it adds nothing: "its own settings" is "its settings", "your own LUTs" is "your LUTs". Keep it only where the meaning needs it (such as "owner").
- **Hosted pages: use the scripts in `scripts/pages/`** (`sync-test-page.mjs` for the test page, `plan-sync.mjs` after editing the plan's text); don't hand-copy files or rebuild the plan's `edit-src` by hand.
