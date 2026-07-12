// ============================================================================
// DOCS Editor — Electron main process.
// ============================================================================
/* eslint-disable @typescript-eslint/no-require-imports */

const { app, BrowserWindow, Menu, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");

const NEXT_URL = "http://localhost:3000";
const isDev = !app.isPackaged;

let mainWindow = null;
let nextProcess = null;

function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        if (res.statusCode && res.statusCode < 500) resolve();
        else if (Date.now() - start > timeoutMs) reject(new Error("timeout"));
        else setTimeout(check, 1000);
        res.resume();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error("timeout"));
        else setTimeout(check, 1000);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    check();
  });
}

function startNextDev() {
  // Use shell:false to avoid DEP0190 deprecation warning and security issues.
  // On Windows, bun.cmd needs shell:true, so we use a different approach:
  // spawn bun directly (not bun.cmd) if it exists, otherwise fall back.
  const projectRoot = path.join(__dirname, "..");
  const isWin = process.platform === "win32";

  // Try to find bun executable path
  const bunPath = isWin
    ? (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".bun", "bin", "bun.exe") : "bun")
    : "bun";

  const spawnOpts = {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development" },
  };

  // On Windows, we need shell:true for .cmd files, but we can avoid the
  // deprecation warning by using { shell: true } only when necessary.
  if (isWin) {
    // Use exec() instead of spawn() with shell:true to avoid the warning
    const { exec } = require("child_process");
    nextProcess = exec("bun run dev", spawnOpts);
  } else {
    nextProcess = spawn("bun", ["run", "dev"], spawnOpts);
  }

  nextProcess.on("error", (err) => {
    console.error("[next] failed to start:", err.message);
  });
  return nextProcess;
}

function getStaticExportPath() {
  // In production (packaged), the static export is in extraResources.
  // electron-builder copies `out/` to `resources/out/` and `public/` to
  // `resources/public/`. The app code (electron/main.js) is in
  // `resources/app/electron/main.js`, so we go up two levels to reach
  // `resources/`, then into `out/`.
  //
  // Layout in the packaged app (win-unpacked):
  //   DOCS Editor.exe
  //   resources/
  //     app/                    ← our code (electron/, package.json)
  //       electron/main.js      ← __dirname points here
  //     out/                    ← Next.js static export (index.html, _next/)
  //     public/                 ← public assets (libs/, samples/, etc.)

  // Dev mode: out/ is in the project root.
  if (isDev) {
    const devOut = path.join(__dirname, "..", "out");
    if (fs.existsSync(path.join(devOut, "index.html"))) {
      return devOut;
    }
    return null;
  }

  // Production: resources/out/ (extraResources destination).
  // __dirname = .../resources/app/electron
  // resources/ = __dirname/../../
  const resourcesDir = path.join(__dirname, "..", "..");
  const prodOut = path.join(resourcesDir, "out");
  if (fs.existsSync(path.join(prodOut, "index.html"))) {
    return prodOut;
  }

  // Fallback: try app.asar.unpacked/out (legacy layout).
  const unpacked = path.join(resourcesDir, "app.asar.unpacked", "out");
  if (fs.existsSync(path.join(unpacked, "index.html"))) {
    return unpacked;
  }

  return null;
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 700,
    backgroundColor: "#828282", title: "DOCS Editor",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  Menu.setApplicationMenu(null);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.loadURL(url);
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    if (isDev) {
      // DEV MODE: start Next.js dev server with HMR
      // First check if the server is already running (e.g. from a previous
      // crashed Electron instance). If so, just connect to it.
      console.log("[electron] dev mode — checking for existing server...");
      let serverAlreadyRunning = false;
      try {
        await waitForServer(NEXT_URL, 3000);
        serverAlreadyRunning = true;
        console.log("[electron] server already running — connecting to it.");
      } catch {
        console.log("[electron] no existing server found — starting Next.js dev server...");
        startNextDev();
        await waitForServer(NEXT_URL);
      }
      console.log("[electron] server ready, opening window...");
      createWindow(NEXT_URL);
    } else {
      // PRODUCTION MODE: load static export (no server needed!)
      console.log("[electron] production mode — loading static export...");
      const staticPath = getStaticExportPath();
      if (staticPath) {
        console.log("[electron] static export found:", staticPath);
        createWindow(`file://${path.join(staticPath, "index.html")}`);
      } else {
        // Fallback: try to start standalone server (backwards compat)
        console.log("[electron] static export not found, falling back to standalone server...");
        const standaloneRoot = path.join(__dirname, "..", "..", "app.asar.unpacked", ".next", "standalone");
        const serverJs = path.join(standaloneRoot, "server.js");
        if (fs.existsSync(serverJs)) {
          const nodeCmd = process.platform === "win32" ? "node.exe" : "node";
          nextProcess = spawn(nodeCmd, [serverJs], {
            cwd: standaloneRoot, shell: false, stdio: "pipe", windowsHide: true,
            env: { ...process.env, NODE_ENV: "production", PORT: "3000", HOSTNAME: "0.0.0.0" },
          });
          nextProcess.stdout?.on("data", (d) => console.log("[server]", d.toString().trim()));
          nextProcess.stderr?.on("data", (d) => console.error("[server]", d.toString().trim()));
          await waitForServer(NEXT_URL);
          createWindow(NEXT_URL);
        } else {
          console.error("[electron] No static export or standalone server found!");
        }
      }
    }
  } catch (e) {
    console.error("[electron] failed:", e.message);
  }
});

app.on("window-all-closed", () => {
  if (nextProcess) { try { nextProcess.kill(); } catch {} }
  app.quit();
});

app.on("before-quit", () => {
  if (nextProcess) { try { nextProcess.kill(); } catch {} }
});

app.on("web-contents-created", (event, contents) => {
  contents.on("before-input-event", (event, input) => {
    if (input.key === "Alt" && input.type === "keyDown") event.preventDefault();
  });
});
