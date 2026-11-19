// The only bridge between the overlay page and the app. Nothing else from Node is exposed.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desk", {
  onCursor: (fn) => ipcRenderer.on("cursor", (_e, x, y) => fn(x, y)),
  onState: (fn) => ipcRenderer.on("state", (_e, s) => fn(s)),
  onPlay: (fn) => ipcRenderer.on("play", (_e, n) => fn(n)),
  interactive: (on) => ipcRenderer.send("interactive", on),
  acts: (list) => ipcRenderer.send("acts", list),
  act: (name) => ipcRenderer.send("act", name),
});
