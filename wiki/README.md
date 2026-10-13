# Wiki sources

The pages of the [ILLUMinator wiki](https://github.com/AbstractPolygon/ILLUMinator/wiki). They publish themselves: when a change to this folder reaches `main`, the *Publish wiki* workflow (`.github/workflows/wiki.yml`) copies the pages to the wiki. It can also be run by hand from the repository's Actions tab.

Each `.md` file here is one wiki page (`Home.md` is the front page; `_Footer.md` appears on every page, and the sidebar is GitHub's default list of pages). `{{version}}` in a page is replaced with the app's version from `package.json` (the workflow also runs when that changes). This README is not published. Pages that exist only in the wiki are left alone (except a sidebar or footer removed here, which is removed there too), so a page renamed or removed here has to be deleted in the wiki by hand.
