# MatchTag (Electron) — v1 skeleton

A from-scratch Electron rebuild of MatchTag: load a match video, tag events
with timestamps as it plays, and export the tagged data.

## What this version can do

- Open a local video file and play/pause/scrub it
- Tag events with one click or a number-key shortcut (timestamp is stamped
  automatically at the current video position)
- Add your own custom tag buttons
- See a running, sortable event log — click a row to jump the video there,
  click the ✕ to delete it
- Save the whole session (video path + tags + events) to a `.json` file and
  reload it later
- Export the event log as a `.csv` file

## Requirements

You need **Node.js** installed once, on the machine you'll run this on.
Download the LTS installer from https://nodejs.org and run it — it installs
both `node` and `npm`. You only need to do this once, ever, not per project.

## Running it (development mode)

1. Unzip this folder somewhere, e.g. `C:\Projects\matchtag-electron`
2. Open Command Prompt (or PowerShell) in that folder
   - Easiest way: open the folder in File Explorer, click the address bar,
     type `cmd`, press Enter
3. Install dependencies (only needed once, or after this README changes):
   ```
   npm install
   ```
   This downloads Electron itself — it's a few hundred MB, so it'll take a
   minute depending on your connection.
4. Start the app:
   ```
   npm start
   ```

A window should open. If it doesn't, whatever error printed in the Command
Prompt is the thing to paste back to me — that's the "browser console"
equivalent for this kind of app.

## Packaging it as a real Windows .exe installer

Once you're happy with how it behaves in dev mode, this builds a proper
installer — the kind with a Setup wizard, a Start menu entry, and a desktop
shortcut, so you (or anyone else on the team) can install it without ever
touching Command Prompt:

```
npm run dist
```

First time you run this, it downloads Electron's Windows build and a code-
signing helper tool (a few hundred MB total), so it needs internet access
and can take a few minutes. The finished installer lands in:

```
release\MatchTag Setup <version>.exe
```

Double-click that to install MatchTag like any other Windows program. The
app icon (the red "MT" tile in `build\icon.ico`) is baked in automatically —
you don't need to do anything extra for that.

Once it's installed this way, running `npm start` from the project folder
still works too — that's for when you're actively changing the code and
want to test quickly without rebuilding the installer each time.

## Project structure

```
matchtag-electron/
├── package.json       — app manifest, scripts, build config
├── build/
│   └── icon.ico        — app icon, used for the .exe, installer, and taskbar
└── src/
    ├── main.js          — Electron's backend: window creation, file dialogs
    ├── preload.js       — safely exposes file operations to the UI
    ├── index.html       — the interface layout
    ├── styles.css       — visual design
    └── renderer.js      — all the tagging logic (buttons, log, export)
```

`main.js` is the only file that touches your file system directly — the
video player, buttons, and event log all live in `renderer.js` and talk to
`main.js` only through the narrow set of functions defined in `preload.js`.
That's the Electron-recommended way to keep the app secure, and it also
means: if you want to add a new file operation later (e.g. auto-saving),
that's the file to extend.

## Known limits of this v1 (by design, not bugs)

- No multi-angle video sync
- No auto-generated stats or charts (that's a separate, Python-side tool)
- No pitch-coordinate / tracking tagging
- Custom tags only support single-digit keys (0–9) for now
