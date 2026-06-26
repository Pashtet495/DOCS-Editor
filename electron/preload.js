/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("electron", {
  platform: process.platform,
  isElectron: true,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
});
