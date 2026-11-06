# Code signing

The installers are not signed, so Windows shows SmartScreen ("More info > Run anyway") and macOS asks for right-click > Open the first time. Signing needs certificates that cost money
and secrets that only the project owner can create, so it is not set up. This is what each platform needs and the change to make once they exist.

## Windows
1. A code signing certificate. A standard (OV) certificate removes the "unknown publisher" name but SmartScreen still warns until the certificate earns a reputation; an EV certificate
   or Azure Trusted Signing is accepted by SmartScreen at once. Export a standard certificate as a `.pfx`.
2. In the repository's secrets: `WIN_CSC_LINK` (the `.pfx` encoded with base64) and `WIN_CSC_KEY_PASSWORD`.
3. In `.github/workflows/desktop.yml`, the Build step: remove `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` and add `CSC_LINK: ${{ secrets.WIN_CSC_LINK }}` and
   `CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}` for the Windows job. electron-builder then signs the .exe, and the .msi if it is given the same certificate.

## macOS
1. An Apple Developer Program membership and a "Developer ID Application" certificate (exported as `.p12`).
2. Secrets: `MAC_CSC_LINK` (base64 of the `.p12`), `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
3. In the workflow, for the macOS jobs: the same `CSC_LINK` / `CSC_KEY_PASSWORD` from the Mac secrets, plus the three `APPLE_*` values, and `"notarize": true` under `build.mac` in `package.json`.

## Linux
Nothing is needed; `.deb` and AppImage are not signed by convention.

## After it works
Test an installer from a fresh download on a clean machine (SmartScreen and Gatekeeper behave differently with a file that came from a browser), then drop the "More info > Run anyway"
and "right-click > Open" lines from the release notes (`.github/workflows/desktop.yml`, the notes block) and from the wiki's Getting Started page.
