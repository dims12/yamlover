# yamlover-desktop

An Electron shell around the yamlover server. It spawns the **same** server that
ships to npm (`tools/server`) in production mode, bound to `127.0.0.1`, and opens a
window at it. No Vite at runtime — it serves the prebuilt `dist/`. The web UI's live
file-update flow (FS watcher → `/api/events` SSE) works unchanged inside the window.

## How it works

- `main.js` builds the server (`vite build` + esbuild → `tools/server/dist`), then
  `utilityProcess.fork`s `tools/server/bin/yamlover.js <root> --prod`. The server is
  run in **Electron's bundled Node**, which is why this app requires an Electron
  whose Node is **≥ 22.5** (the engine's store uses `node:sqlite`). Electron 35+
  ships Node 22.x — see the version floor in `package.json`.
- The launcher prints its URL on stdout; `main.js` reads it and `loadURL`s the
  window, so the port-in-use fallback is honored automatically.
- The chosen folder is remembered in `userData/config.json`; **File → Open Folder…**
  (⌘/Ctrl-O) switches trees.

## Run in dev

From this directory:

```
npm install        # electron + electron-builder
npm start          # builds tools/server, then launches the window
```

(`npm start` runs `build:server` first, so `tools/server/dist` is always fresh.)

## Build installers

```
npm run dist       # current OS: .dmg (mac) / .nsis (win) / .AppImage (linux)
npm run dist:dir   # unpacked app dir only (faster, for smoke-testing)
```

`electron-builder` copies `tools/server`'s `bin/`, `dist/` and `package.json` into
the app under `resources/server` (the `package.json` is needed so Node treats the
ESM `bin`/`dist` as modules). Cross-OS builds follow electron-builder's usual rules
(build each target on its own OS, or via CI; mac/win signing is configured there).

## TODO

- App icon: add `build/icon.png` (512×512) — currently the default Electron icon.
- CI: extend the version-bump workflow with a 3-OS `electron-builder` matrix.
