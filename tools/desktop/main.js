// yamlover-desktop — Electron shell around the local yamlover server.
//
// It spawns the SAME server that ships to npm (tools/server) in production mode,
// bound to 127.0.0.1 (the launcher's default), then points a BrowserWindow at the
// URL the server prints. The server runs in Electron's bundled Node via
// `utilityProcess.fork`, so it gets `node:sqlite` (the engine's store) — which is
// why this app requires an Electron whose Node is ≥ 22.5 (see package.json). The
// web UI's live file-update flow (FS watcher → /api/events SSE → useDiffBump) works
// unchanged inside the window; no Vite is involved (we run the prebuilt dist).
const { app, BrowserWindow, dialog, utilityProcess, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

let serverProc = null;
let win = null;

const configPath = () => path.join(app.getPath("userData"), "config.json");

function loadLastRoot() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
    if (cfg.lastRoot && fs.existsSync(cfg.lastRoot)) return cfg.lastRoot;
  } catch {
    /* no/!invalid config — fall through */
  }
  return null;
}

function saveLastRoot(root) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify({ lastRoot: root }, null, 2));
  } catch {
    /* best effort */
  }
}

// The server's bin + built dist. Packaged: electron-builder copies tools/server's
// bin/, dist/ and package.json under resources/server (extraResources). Dev: use
// the sibling tools/server directly.
function serverDir() {
  const packaged = path.join(process.resourcesPath ?? "", "server");
  if (fs.existsSync(path.join(packaged, "bin", "yamlover.js"))) return packaged;
  return path.join(__dirname, "..", "server");
}

function pickRoot() {
  const res = dialog.showOpenDialogSync({
    title: "Choose a yamlover tree",
    properties: ["openDirectory", "createDirectory"],
  });
  return res && res[0];
}

function stopServer() {
  if (serverProc) {
    try {
      serverProc.kill();
    } catch {
      /* already gone */
    }
    serverProc = null;
  }
}

// Spawn the server and resolve with the URL it prints on stdout. We read the actual
// URL rather than assuming a port, so the launcher's port-in-use fallback is honored.
// `--prod` forces the prebuilt static path even in the repo checkout (no Vite).
function startServer(root) {
  stopServer();
  const bin = path.join(serverDir(), "bin", "yamlover.js");
  return new Promise((resolve, reject) => {
    const proc = utilityProcess.fork(bin, [root, "--prod"], { stdio: ["ignore", "pipe", "pipe"] });
    serverProc = proc;
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/http:\/\/[^\s/]+:(\d+)\//);
      if (m) {
        proc.stdout.off("data", onData);
        resolve(`http://127.0.0.1:${m[1]}/`);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", (d) => process.stderr.write(d));
    proc.on("exit", (code) => {
      serverProc = null;
      if (!win) reject(new Error(`server exited before it was ready (code ${code})`));
    });
  });
}

async function openRoot(root) {
  saveLastRoot(root);
  const url = await startServer(root);
  console.log(`yamlover-desktop  ${root} → ${url}`);
  if (!win) {
    win = new BrowserWindow({ width: 1280, height: 860, title: "yamlover" });
    win.on("closed", () => {
      win = null;
    });
    win.webContents.on("did-fail-load", (_e, code, desc) =>
      console.error(`yamlover-desktop  load failed (${code}): ${desc}`),
    );
  }
  win.loadURL(url);
}

async function chooseAndOpen() {
  const root = pickRoot();
  if (root) await openRoot(root);
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => chooseAndOpen() },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

app.whenReady().then(async () => {
  buildMenu();
  const root = loadLastRoot() || pickRoot();
  if (!root) {
    app.quit();
    return;
  }
  try {
    await openRoot(root);
  } catch (e) {
    dialog.showErrorBox("yamlover", `Failed to start the server:\n${e.message}`);
    app.quit();
  }
});

app.on("activate", async () => {
  // macOS: re-open from the dock after the window was closed.
  if (BrowserWindow.getAllWindows().length === 0) {
    const root = loadLastRoot();
    if (root) await openRoot(root);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    stopServer();
    app.quit();
  }
});

app.on("before-quit", stopServer);
