# Getting Started

## Install

**Desktop app.** Download an installer from [Releases](https://github.com/AbstractPolygon/Illuminator/releases/latest):

- **Windows:** the `-x64.exe` for most PCs (Intel and AMD), the `-arm64.exe` for ARM PCs (such as Snapdragon). It installs into Program Files, adds Illuminator to the Start menu, and a page of the installer after the folder choice has an **Add to desktop** checkbox (ticked by default). The `.msi` (a Windows Installer package, for managed installs) has the same checkbox on a *Shortcuts* page before *Ready to install*; for a silent install it adds the shortcut unless you pass `ADDTODESKTOP=0` (`msiexec /i Illuminator-*.msi ADDTODESKTOP=0 /qn`).
- **macOS:** the `-arm64.dmg` for Apple Silicon, the `-x64.dmg` for Intel. The app is not code signed: right-click it and choose *Open* the first time.
- **Linux:** the `.deb` for Debian and Ubuntu (`sudo apt install ./Illuminator-*.deb`), or the `.AppImage` for other distributions (`chmod +x` it, then run it). The `.deb` adds Illuminator to the applications menu. The first time an AppImage runs it asks whether to add itself to the applications menu, with an **Add to desktop** checkbox (ticked by default); it only writes into your home folder.

Or run it from source (Node.js 20 or newer):

```
git clone https://github.com/AbstractPolygon/Illuminator.git
cd Illuminator
npm install
npm start
```

`npm run dist` builds an installer for your system (Windows, macOS, Linux).

**Browser.** Each release also has the web version, `Illuminator-<version>-web.zip`: unzip it and upload what is inside to any web server (served over HTTPS). Or serve the `app` folder of the source; nothing to install for the people who use it.

```
npm run web            # http://localhost:8080
npm run build:web      # a static copy in dist/web, for any web server
```

Illuminator needs a browser with WebGL 2 for fast rendering (any current Chrome, Edge, Firefox or Safari). Without it, everything still works on the CPU, more slowly.

## Open a photo

- Drag `.LFR` / `.LFP` files anywhere onto the window.
- **Settings <img src="images/settings.png" width="20" height="20" alt="Settings"> → Import Lytro Desktop library…** for your old Lytro Desktop library.

Every photo you open is added to your library, so it is there next time ([[Library and Albums]]).

## The window

- **Left sidebar:** the library: *All photos*, your albums and the photos in the selected album. Choosing an album shows its photos as a grid of thumbnails in the middle; click a photo to open it.
- **Middle:** the picture. Click to focus on that spot; drag to move the viewpoint. Above it, <img src="images/mode-camera.png" width="20" height="20" alt="Camera"> and <img src="images/mode-lenslets.png" width="20" height="20" alt="Lenslets"> switch between the picture and the raw microlens image, with the zoom controls on the right; below it, the animation controls.
- **Right sidebar:** the editing panels ([[Editing]]). Click a title to open or close it.
- **Top bar, right:**

<img src="images/fullscreen.png" width="20" height="20" alt="Full screen"> **Full screen** (click again or press Esc to leave)

<img src="images/about.png" width="20" height="20" alt="About"> **About**

<img src="images/settings.png" width="20" height="20" alt="Settings"> **Settings**


## Your edits are saved

Every change is saved with the photo as you make it; there is no Save button. Open the photo again and it looks as you left it. *Reset* buttons and double-clicking a slider put things back.

## Updates

The desktop app checks for a newer version when it starts, and again every few hours while it is open. *Help > Check for Updates…* checks right away and says so when you are up to date. If there is one, a popup lists that release's downloads (Windows, macOS and Linux, with this computer's first), each a direct link to the file. Install it over the current version; your library and edits stay as they are. *Don't remind me about this version* skips that release.
