const { app, BrowserWindow, ipcMain, net, shell, safeStorage } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const http = require("http");

let whitelabelConfig = null;
try {
  const wlPath = app.isPackaged
    ? path.join(process.resourcesPath, "whitelabel.json")
    : path.join(__dirname, "..", "whitelabel.dev.json");
  if (fs.existsSync(wlPath)) whitelabelConfig = JSON.parse(fs.readFileSync(wlPath, "utf8"));
} catch {
  whitelabelConfig = null;
}

const SETTINGS_FILE = () =>
  path.join(app.getPath("userData"), "isle-voip-overlay.settings.json");

const defaultSettings = {
  showHideHotkey: "Shift+H",
  micDeviceId: null,
  outputDeviceId: null,
  serverHash: "",
  apiBaseUrl: "https://voip.islepilot.eu",
  centralUrl: "wss://voip.islepilot.eu",
  steamId: null,
  steamToken: null,
  inputMode: "open",
  pttKey: "CapsLock",
  pushToMuteKey: "",
  toggleMuteKey: "",
  micGainDb: 0,
  outputVolume: 1,
  inputVolume: 1,
  noiseSuppression: false,
  autoGainControl: false,
  selfMonitor: false,
  vadThreshold: 0.012
};

const asStringOrNull = (v) => (typeof v === "string" && v.length > 0 ? v : null);
const asString = (v, fallback) =>
  typeof v === "string" && v.trim() ? v.trim() : fallback;

const normalizeSettings = (raw) => {
  const s = raw && typeof raw === "object" ? raw : {};
  const steamIdRaw = typeof s.steamId === "string" ? s.steamId.trim() : "";
  const mode = ["open", "vad", "ptt"].includes(s.inputMode) ? s.inputMode : defaultSettings.inputMode;
  return {
    showHideHotkey: asString(s.showHideHotkey, defaultSettings.showHideHotkey),
    micDeviceId: asStringOrNull(s.micDeviceId),
    outputDeviceId: asStringOrNull(s.outputDeviceId),
    serverHash: typeof s.serverHash === "string" ? s.serverHash.trim().toLowerCase() : defaultSettings.serverHash,
    apiBaseUrl: (() => {
      const v = asString(s.apiBaseUrl, defaultSettings.apiBaseUrl);
      return /isle-voip\.com/i.test(v) ? defaultSettings.apiBaseUrl : v;
    })(),
    centralUrl: (() => {
      const c = asString(s.centralUrl, defaultSettings.centralUrl);
      return /109\.71\.254\.131|isle-voip\.com/i.test(c) ? defaultSettings.centralUrl : c;
    })(),
    steamId: /^\d{17}$/.test(steamIdRaw) ? steamIdRaw : null,
    steamToken: asStringOrNull(s.steamToken),
    inputMode: mode,
    pttKey: asString(s.pttKey, defaultSettings.pttKey),
    pushToMuteKey: typeof s.pushToMuteKey === "string" ? s.pushToMuteKey.trim() : "",
    toggleMuteKey: typeof s.toggleMuteKey === "string" ? s.toggleMuteKey.trim() : "",
    micGainDb: typeof s.micGainDb === "number" && Number.isFinite(s.micGainDb) ? s.micGainDb : 0,
    outputVolume:
      typeof s.outputVolume === "number" && Number.isFinite(s.outputVolume)
        ? Math.max(0, Math.min(1.5, s.outputVolume))
        : 1,
    inputVolume:
      typeof s.inputVolume === "number" && Number.isFinite(s.inputVolume)
        ? Math.max(0, Math.min(3, s.inputVolume))
        : 1,
    noiseSuppression: typeof s.noiseSuppression === "boolean" ? s.noiseSuppression : false,
    autoGainControl: typeof s.autoGainControl === "boolean" ? s.autoGainControl : false,
    selfMonitor: typeof s.selfMonitor === "boolean" ? s.selfMonitor : false,
    vadThreshold:
      typeof s.vadThreshold === "number" && Number.isFinite(s.vadThreshold)
        ? Math.max(0.001, Math.min(0.1, s.vadThreshold))
        : 0.012
  };
};

const encryptToken = (plain) => {
  if (!plain) return null;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return "enc1:" + safeStorage.encryptString(plain).toString("base64");
    }
  } catch {}
  return plain;
};
const decryptToken = (stored) => {
  if (!stored) return null;
  if (typeof stored === "string" && stored.startsWith("enc1:")) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(5), "base64"));
    } catch {
      return null;
    }
  }
  return stored;
};

const readSettings = () => {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), "utf8");
    const s = normalizeSettings(JSON.parse(raw));
    s.steamToken = decryptToken(s.steamToken);
    return s;
  } catch {
    return { ...defaultSettings };
  }
};

const writeSettings = (patch) => {
  const current = readSettings();
  const merged = normalizeSettings({
    ...current,
    ...(patch && typeof patch === "object" ? patch : {})
  });
  const onDisk = { ...merged, steamToken: encryptToken(merged.steamToken) };
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(onDisk, null, 2), "utf8");
  return merged;
};

let mainWindow = null;
let lastUpdaterState = { state: "idle" };
let globalKeysActive = false;

const KEY_SPECIAL = {
  Ctrl: "ControlLeft",
  CtrlRight: "ControlRight",
  Alt: "AltLeft",
  AltRight: "AltRight",
  Shift: "ShiftLeft",
  ShiftRight: "ShiftRight",
  Meta: "MetaLeft",
  MetaRight: "MetaRight"
};
const uiohookNameToCode = (name) => {
  if (/^[0-9]$/.test(name)) return "Digit" + name;
  if (/^[A-Z]$/.test(name)) return "Key" + name;
  return KEY_SPECIAL[name] || name;
};

function startGlobalKeys() {
  try {
    const { uIOhook, UiohookKey } = require("uiohook-napi");
    const codeByKeycode = new Map();
    for (const [name, code] of Object.entries(UiohookKey)) {
      const mapped = uiohookNameToCode(name);
      if (mapped && !codeByKeycode.has(code)) codeByKeycode.set(code, mapped);
    }
    const send = (type) => (e) => {
      const code = codeByKeycode.get(e.keycode);
      if (code && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("global-key", { type, code });
      }
    };
    uIOhook.on("keydown", send("down"));
    uIOhook.on("keyup", send("up"));
    const MOUSE_BUTTON_CODE = { 3: "Mouse3", 4: "Mouse4", 5: "Mouse5" };
    const sendMouse = (type) => (e) => {
      const code = MOUSE_BUTTON_CODE[e.button];
      if (code && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("global-key", { type, code });
      }
    };
    uIOhook.on("mousedown", sendMouse("down"));
    uIOhook.on("mouseup", sendMouse("up"));
    uIOhook.start();
    globalKeysActive = true;
    app.on("will-quit", () => {
      try {
        uIOhook.stop();
      } catch {
      }
    });
  } catch {
    globalKeysActive = false;
  }
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#151515",
    frame: false,
    title: whitelabelConfig?.appName || "IsleVOIP",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    const key = String(input.key || "").toLowerCase();
    const ctrlOrCmd = Boolean(input.control || input.meta);
    if (key === "f12" || (ctrlOrCmd && input.shift && (key === "i" || key === "j" || key === "c"))) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on("devtools-opened", () => {
    mainWindow.webContents.closeDevTools();
  });

  mainWindow.setMenuBarVisibility(false);

  const distIndex = path.join(__dirname, "..", "dist", "index.html");
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (!app.isPackaged && devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(distIndex);
  }

  mainWindow.webContents.on("did-fail-load", (_e, _code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || !mainWindow) return;
    if (fs.existsSync(distIndex)) void mainWindow.loadFile(distIndex);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};

const BACKUP_ENDPOINT = { apiBaseUrl: "https://backupvoip.islepilot.eu", centralUrl: "wss://backupvoip.islepilot.eu" };
let endpointOverride = null;
let endpointsReadyPromise = null;

function baseApi() {
  const s = readSettings();
  return (endpointOverride?.apiBaseUrl || s.apiBaseUrl || defaultSettings.apiBaseUrl).replace(/\/+$/, "");
}
function baseCentral() {
  const s = readSettings();
  return endpointOverride?.centralUrl || s.centralUrl || defaultSettings.centralUrl;
}

async function probeApi(base) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    const res = await net.fetch(`${base.replace(/\/+$/, "")}/api/servers`, { signal: ctrl.signal });
    clearTimeout(to);
    return res.ok;
  } catch {
    return false;
  }
}

async function resolveEndpoints() {
  const s = readSettings();
  const primary = (s.apiBaseUrl || defaultSettings.apiBaseUrl).replace(/\/+$/, "");
  if (await probeApi(primary)) {
    endpointOverride = null;
    return;
  }
  if (await probeApi(BACKUP_ENDPOINT.apiBaseUrl)) {
    endpointOverride = BACKUP_ENDPOINT;
    logUpdate("endpoint", "primary unreachable, using backup");
  }
}

function ensureEndpoints() {
  if (!endpointsReadyPromise) endpointsReadyPromise = resolveEndpoints();
  return endpointsReadyPromise;
}

async function apiGetJson(pathname, retried) {
  await ensureEndpoints();
  const base = baseApi();
  try {
    const res = await net.fetch(`${base}${pathname}`, { credentials: "include" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { error: `HTTP ${res.status}`, ...json, status: res.status };
    return json;
  } catch (err) {
    if (!retried && !endpointOverride) {
      endpointsReadyPromise = null;
      await ensureEndpoints();
      if (endpointOverride) return apiGetJson(pathname, true);
    }
    return { error: String(err && err.message ? err.message : err) };
  }
}

let loopbackAuthServer = null;
function startLoopbackAuthServer() {
  return new Promise((resolve, reject) => {
    if (loopbackAuthServer) {
      try { loopbackAuthServer.close(); } catch {}
      loopbackAuthServer = null;
    }
    const server = http.createServer((req, res) => {
      let hit = false;
      try {
        const u = new URL(req.url || "/", "http://127.0.0.1");
        if (u.pathname !== "/cb") {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        hit = true;
        const sid = u.searchParams.get("sid");
        const token = u.searchParams.get("token");
        const err = u.searchParams.get("error");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        if (!err && sid && /^\d{17}$/.test(sid)) {
          const saved = writeSettings({ steamId: sid, steamToken: token || null });
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("auth:changed", { steamId: saved.steamId });
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
          }
          res.end('<!doctype html><meta charset="utf-8"><title>IsleVOIP</title><body style="font-family:system-ui,Segoe UI,sans-serif;background:#151515;color:#fff;display:grid;place-items:center;height:100vh;margin:0;text-align:center"><div><h2 style="margin:0 0 8px">Steam login complete</h2><p style="opacity:.6">You can close this tab and return to IsleVOIP.</p></div></body>');
        } else {
          res.end('<!doctype html><meta charset="utf-8"><title>IsleVOIP</title><body style="font-family:system-ui,Segoe UI,sans-serif;background:#151515;color:#fff;display:grid;place-items:center;height:100vh;margin:0">Login failed. Please try again.</body>');
        }
      } catch {
        try { res.statusCode = 500; res.end("error"); } catch {}
      } finally {
        if (hit) {
          setTimeout(() => {
            try { server.close(); } catch {}
            if (loopbackAuthServer === server) loopbackAuthServer = null;
          }, 1500);
        }
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      loopbackAuthServer = server;
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      if (!port) {
        reject(new Error("no port"));
        return;
      }
      setTimeout(() => {
        if (loopbackAuthServer === server) {
          try { server.close(); } catch {}
          loopbackAuthServer = null;
        }
      }, 300000);
      resolve(port);
    });
  });
}

ipcMain.handle("auth:steamLogin", async () => {
  await ensureEndpoints();

  try {
    const port = await startLoopbackAuthServer();
    void shell.openExternal(`${baseApi()}/api/auth/steam?client=app&port=${port}`);
  } catch {
    void shell.openExternal(`${baseApi()}/api/auth/steam?client=app`);
  }
  return { pending: true };
});

ipcMain.handle("auth:getAuth", async () => {
  const s = readSettings();
  return { steamId: s.steamId };
});

ipcMain.handle("auth:logout", async () => {
  writeSettings({ steamId: null, steamToken: null });
});

ipcMain.handle("overlay:getSettings", async () => {
  await ensureEndpoints();
  return { ...readSettings(), apiBaseUrl: baseApi(), centralUrl: baseCentral() };
});

ipcMain.handle("overlay:setSettings", async (_evt, next) => writeSettings(next));

ipcMain.handle("voice:getTicket", async () => {
  const s = readSettings();
  const params = new URLSearchParams();
  if (s.steamToken) params.set("token", s.steamToken);
  else if (s.steamId) params.set("sid", s.steamId);
  const qs = params.toString();
  const ticket = await apiGetJson(`/api/voice/ticket${qs ? `?${qs}` : ""}`);
  if (ticket.status === 401 && s.steamId) {
    writeSettings({ steamId: null, steamToken: null });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("auth:changed", { steamId: null });
  }
  return ticket;
});

ipcMain.handle("servers:list", async () => apiGetJson("/api/servers"));

ipcMain.handle("servers:linked", async (_evt, hash) =>
  apiGetJson(`/api/servers/${encodeURIComponent(String(hash || ""))}/linked`),
);

ipcMain.handle("groups:list", async (_evt, hash) => {
  await ensureEndpoints();
  const httpBase = baseCentral().replace(/^ws/i, "http").replace(/\/+$/, "");
  try {
    const res = await net.fetch(`${httpBase}/groups/${hash}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { groups: [], error: `HTTP ${res.status}` };
    return json;
  } catch (err) {
    return { groups: [], error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle("keys:globalActive", async () => globalKeysActive);
ipcMain.handle("app:getWhitelabel", () => whitelabelConfig);
ipcMain.handle("updater:restart", () => {
  if (!app.isPackaged) return false;
  try {
    autoUpdater.quitAndInstall(false, true);
    return true;
  } catch (e) {
    logUpdate("restart-error", String(e));
    return false;
  }
});
ipcMain.handle("updater:check", () => {
  if (!app.isPackaged) return false;
  autoUpdater.checkForUpdates().catch((e) => logUpdate("check-error", String(e)));
  return true;
});
ipcMain.handle("updater:getState", () => lastUpdaterState);

ipcMain.handle("window:minimize", () => mainWindow && mainWindow.minimize());
ipcMain.handle("window:maximizeToggle", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle("window:close", () => mainWindow && mainWindow.close());
ipcMain.handle("window:openExternal", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    void shell.openExternal(url);
  }
});

const AUTH_PROTOCOL = "isle-voip";
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(AUTH_PROTOCOL);
}

function handleDeepLink(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.indexOf(`${AUTH_PROTOCOL}://`) !== 0) return;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  const sid = parsed.searchParams.get("sid");
  const token = parsed.searchParams.get("token");
  if (!sid || !/^\d{17}$/.test(sid)) return;
  const saved = writeSettings({ steamId: sid, steamToken: token || null });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("auth:changed", { steamId: saved.steamId });
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const url = argv.find((a) => typeof a === "string" && a.indexOf(`${AUTH_PROTOCOL}://`) === 0);
    if (url) handleDeepLink(url);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on("open-url", (_e, url) => handleDeepLink(url));

  app.whenReady().then(() => {
    createWindow();
    startGlobalKeys();
    initAutoUpdate();
    void ensureEndpoints();
    const startUrl = process.argv.find((a) => typeof a === "string" && a.indexOf(`${AUTH_PROTOCOL}://`) === 0);
    if (startUrl) handleDeepLink(startUrl);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function logUpdate(kind, msg) {
  try {
    fs.appendFileSync(
      path.join(app.getPath("userData"), "update.log"),
      `${new Date().toISOString()} ${kind} ${msg ?? ""}\n`,
    );
  } catch {
  }
}

function initAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null);
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    const sendUpdaterEvent = (payload) => {
      lastUpdaterState = payload;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("updater:event", payload);
      }
    };
    autoUpdater.on("checking-for-update", () => logUpdate("checking", ""));
    autoUpdater.on("update-available", (i) => {
      logUpdate("available", i && i.version);
      sendUpdaterEvent({ state: "available", version: i && i.version });
    });
    autoUpdater.on("update-not-available", (i) => {
      logUpdate("not-available", i && i.version);
      sendUpdaterEvent({ state: "none" });
    });
    autoUpdater.on("download-progress", (p) => {
      logUpdate("progress", p && Math.round(p.percent) + "%");
      sendUpdaterEvent({ state: "downloading", percent: p ? Math.round(p.percent) : 0 });
    });
    autoUpdater.on("update-downloaded", (i) => {
      logUpdate("downloaded", i && i.version);
      sendUpdaterEvent({ state: "downloaded", version: i && i.version });
    });
    autoUpdater.on("error", (e) => {
      logUpdate("error", e && (e.stack || e.message || String(e)));
      sendUpdaterEvent({ state: "error", message: e && (e.message || String(e)) });
    });
    autoUpdater.checkForUpdatesAndNotify().catch((e) => logUpdate("check-error", String(e)));
    setInterval(() => {
      autoUpdater.checkForUpdatesAndNotify().catch((e) => logUpdate("check-error", String(e)));
    }, 10 * 60 * 1000);
  } catch (e) {
    logUpdate("init-error", String(e));
  }
}
