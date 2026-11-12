// Answers whether a quit clears sessionStorage, which is where the renderer remembers the open thread
// (apps/web/src/lib/open-thread-memory.ts). Like the main window, it uses the default session and loads a file:// page.
// Usage: electron session-storage-probe.cjs write <userDataDir>, then electron session-storage-probe.cjs read <userDataDir>
const { app, BrowserWindow } = require("electron");
const NodeFS = require("node:fs");
const NodePath = require("node:path");

const [mode, userData] = process.argv.slice(-2);
if (!["write", "read"].includes(mode)) throw new Error("Pass write or read, then a user data directory");
app.setPath("userData", NodePath.resolve(userData));

const script = mode === "write"
  ? `sessionStorage.setItem("probe", "kept"); localStorage.setItem("probe", "kept"); "written"`
  : `JSON.stringify({ sessionStorage: sessionStorage.getItem("probe"), localStorage: localStorage.getItem("probe") })`;

app.whenReady().then(async () => {
  const page = NodePath.join(app.getPath("userData"), "probe.html");
  NodeFS.writeFileSync(page, "<!doctype html><title>probe</title>");
  const window = new BrowserWindow({ show: false });
  await window.loadFile(page);
  console.log(`${mode}: ${await window.webContents.executeJavaScript(script)}`);
  app.quit();
});
