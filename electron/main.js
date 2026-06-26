// ============================================================================
// DOCS Editor — Electron main process.
// ============================================================================
/* eslint-disable @typescript-eslint/no-require-imports */

const { app, BrowserWindow, Menu, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const NEXT_URL = "http://localhost:3000";
const isDev = !app.isPackaged;

// In production (packaged), files are inside app.asar.
// asarUnpack moves .next/standalone to app.asar.unpacked/.next/standalone
// __dirname = .../resources/app.asar/electron (in asar, but electron files work from asar)
// For standalone server we need the unpacked path.
const PROJECT_ROOT = isDev
  ? path.join(__dirname, "..")
  : path.join(__dirname, "..");

// In production, .next/standalone is unpacked to app.asar.unpacked
const STANDALONE_ROOT = isDev
  ? path.join(PROJECT_ROOT, ".next", "standalone")
  : path.join(PROJECT_ROOT, "..", "app.asar.unpacked", ".next", "standalone");

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
  const cmd = process.platform === "win32" ? "bun.cmd" : "bun";
  // In dev mode, show the terminal window so the user can see server logs.
  nextProcess = spawn(cmd, ["run", "dev"], {
    cwd: PROJECT_ROOT, shell: true, stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development" },
  });
  nextProcess.on("error", (err) => {
    console.error("[next] failed to start:", err.message);
  });
  return nextProcess;
}

function startNextProd() {
  // In production, use node directly to run the standalone server.
  // HIDE the console window — use windowsHide + pipe stdio (not inherit).
  const serverJs = path.join(STANDALONE_ROOT, "server.js");
  console.log("[electron] standalone server path:", serverJs);

  const nodeCmd = process.platform === "win32" ? "node.exe" : "node";
  nextProcess = spawn(nodeCmd, [serverJs], {
    cwd: STANDALONE_ROOT,
    shell: false,           // no shell = no cmd window
    stdio: "pipe",          // pipe instead of inherit = no visible output
    windowsHide: true,      // hide any console window on Windows
    env: { ...process.env, NODE_ENV: "production", PORT: "3000", HOSTNAME: "0.0.0.0" },
  });

  // Log server output to electron's console (visible in DevTools, not a separate window).
  nextProcess.stdout?.on("data", (data) => {
    console.log("[next-server]", data.toString().trim());
  });
  nextProcess.stderr?.on("data", (data) => {
    console.error("[next-server]", data.toString().trim());
  });

  nextProcess.on("error", (err) => {
    console.error("[next] production server failed:", err.message);
  });
  return nextProcess;
}

function createWindow() {
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
  mainWindow.loadURL(NEXT_URL);
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    if (isDev) {
      console.log("[electron] dev mode — starting Next.js dev server...");
      startNextDev();
    } else {
      console.log("[electron] production mode — starting Next.js standalone server...");
      startNextProd();
    }
    await waitForServer(NEXT_URL);
    console.log("[electron] server ready, opening window...");
    createWindow();
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
