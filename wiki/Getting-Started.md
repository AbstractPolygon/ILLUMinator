# Getting Started

## Install

**Desktop app.** Download an installer from [Releases](https://github.com/AbstractPolygon/ILLUMinator/releases/latest):

- **Windows:** the `.exe` installs into Program Files.
- **macOS:** the `-arm64.dmg` for Apple Silicon, the `-x64.dmg` for Intel. The app is not code signed: right-click it and choose *Open* the first time.
- **Linux:** the `.deb` for Debian and Ubuntu (`sudo apt install ./ILLUMinator-*.deb`), or the `.AppImage` for other distributions (`chmod +x` it, then run it).

Or run it from source (Node.js 20 or newer):

```
git clone https://github.com/AbstractPolygon/ILLUMinator.git
cd ILLUMinator
npm install
npm start
```

`npm run dist` builds an installer for your system (Windows, macOS, Linux).

**Browser.** Each release also has the web version, `ILLUMinator-<version>-web.zip`: unzip it and upload what is inside to any web server (served over HTTPS). Or serve the `app` folder of the source; nothing to install for the people who use it.

```
npm run web            # http://localhost:8080
npm run build:web      # a static copy in dist/web, for any web server
```

ILLUMinator needs a browser with WebGL 2 for fast rendering (any current Chrome, Edge, Firefox or Safari). Without it, everything still works on the CPU, more slowly.

## Open a photo

- **Open…** in the top bar, or drag `.LFR` / `.LFP` files anywhere onto the window.
- **Import from camera…** for photos still on the camera ([[Importing]]).
- **Settings (gear) → Import Lytro Desktop library…** for your old Lytro Desktop library.

Every photo you open is added to your library, so it is there next time ([[Library and Albums]]).

## The window

- **Left sidebar:** the library: *All photos*, your albums and the photos in the selected album. Choosing an album shows its photos as a grid of thumbnails in the middle; click a photo to open it.
- **Middle:** the picture. Click to focus on that spot; drag to move the viewpoint. Below it, *Camera* / *Lenslets* switch between the picture and the raw microlens image, and the animation and zoom controls.
- **Right sidebar:** the editing panels ([[Editing]]). Click a title to open or close it.
- **Top bar, right:** Full screen (the four corners; click again or press Esc to leave), About (ⓘ) and Settings (gear).

## Your edits are saved

Every change is saved with the photo as you make it; there is no Save button. Open the photo again and it looks as you left it. *Reset* buttons and double-clicking a slider put things back.
