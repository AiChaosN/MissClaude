'use strict';
// MissClaude main process: one transparent, frameless, always-on-top window that
// follows the pet around the screen. The renderer owns behaviour and physics and
// tells us where the pet's feet are; we place the window, run menus/tray, and host
// the module interface (core/controller.js) with its localhost HTTP API.

const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, net, protocol, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PetController } = require('./core/controller');
const { createApiServer } = require('./core/server');

const CHARACTERS = path.join(__dirname, 'characters'); // one pack per folder, see characters/README.md
const DEFAULTS = {
  character: 'claude', size: 'medium', quiet: false, wander: true, onTop: true, foot: null,
  // outside Windows' dynamic range and WSL's mirrored-networking ephemeral range
  // (44620-48715 here), both of which refuse a bind from a Windows process
  apiPort: 27826, webhooks: [],
  // other machines: apiHost "0.0.0.0" (or a LAN address) plus a secret apiToken that
  // remote callers send as "Authorization: Bearer <token>"; without a token the API
  // stays local whatever apiHost says
  apiHost: '127.0.0.1', apiToken: '',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// a second launch only pokes the running pet (see 'second-instance') and exits
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) app.exit(0);

let win = null;
let tray = null;
let settings = { ...DEFAULTS };
let character = null; // the active pack's character.json
let controller = null;
let foot = null; // pet's ground point in screen DIP, as last reported by the renderer
let saveTimer = null;
let rulesError = null;

// errors also go to %APPDATA%\MissClaude\main.log (there is no console when launched normally)
function logError(...args) {
  console.error(...args);
  try {
    const line = `[${new Date().toISOString()}] ${args.map((a) => (a && a.stack) || String(a)).join(' ')}\n`;
    fs.appendFileSync(path.join(app.getPath('userData'), 'main.log'), line);
  } catch { /* nowhere left to report */ }
}
process.on('uncaughtException', (err) => logError('uncaught:', err));

const send = (cmd) => {
  if (win && !win.isDestroyed()) win.webContents.send('pet:command', cmd);
};

// ---------- character packs ----------

function characterNames() {
  try {
    return fs.readdirSync(CHARACTERS).filter((n) => fs.existsSync(path.join(CHARACTERS, n, 'character.json'))).sort();
  } catch {
    return [];
  }
}

function loadCharacter() {
  if (!characterNames().includes(settings.character)) {
    logError(`character "${settings.character}" not found; using ${DEFAULTS.character}`);
    settings.character = DEFAULTS.character;
  }
  character = JSON.parse(fs.readFileSync(path.join(CHARACTERS, settings.character, 'character.json'), 'utf8'));
}

const characterAsset = (name) => path.join(CHARACTERS, settings.character, 'assets', name);

// ---------- settings & rules files ----------

const userFile = (name) => path.join(app.getPath('userData'), name);

function loadSettings() {
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(userFile('settings.json'), 'utf8')) };
  } catch {
    settings = { ...DEFAULTS };
  }
}

function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      // store only what differs from the defaults, so changed defaults reach old installs
      const changed = Object.fromEntries(Object.entries(settings)
        .filter(([k, v]) => k !== 'foot' && JSON.stringify(v) !== JSON.stringify(DEFAULTS[k])));
      fs.writeFileSync(userFile('settings.json'), JSON.stringify({ ...changed, foot }, null, 2));
    } catch (err) {
      logError('saving settings failed:', err);
    }
  }, 800);
}

// rules.json in userData is the source of truth; edits to it are picked up live
function loadRules() {
  const file = userFile('rules.json');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'core', 'default-rules.json'), file);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    controller.setRules(Array.isArray(parsed) ? parsed : parsed.rules);
    rulesError = null;
  } catch (err) {
    rulesError = `${file}: ${err.message}`;
    logError('rules not loaded:', rulesError);
  }
}

function watchRules() {
  fs.watchFile(userFile('rules.json'), { interval: 1500 }, loadRules);
}

function saveRules(rules) {
  fs.writeFileSync(userFile('rules.json'), JSON.stringify(rules, null, 2));
}

// ---------- geometry ----------

function petHeight() {
  return character.sizes[settings.size] || character.sizes.medium;
}

// the window is shaped by the pack: wide enough for its poses, feet a little above the bottom
function layout() {
  const h = petHeight();
  const { aspect = [1.8, 1.75], footY = 0.16 } = character.window || {};
  const width = Math.round(h * aspect[0]);
  const height = Math.round(h * aspect[1]);
  return { petHeight: h, width, height, footX: width / 2, footY: height - Math.round(h * footY) };
}

function displays() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => ({
    id: d.id, primary: d.id === primary, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor,
  }));
}

function defaultFoot() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - layout().width * 0.7, y: wa.y + wa.height };
}

function footIsOnScreen(f) {
  return f && displays().some(({ workArea: a }) =>
    f.x >= a.x && f.x <= a.x + a.width && f.y >= a.y && f.y <= a.y + a.height + 2);
}

function windowBoundsFor(f) {
  const l = layout();
  return { x: Math.round(f.x - l.footX), y: Math.round(f.y - l.footY), width: l.width, height: l.height };
}

// ---------- window ----------

function createWindow() {
  foot = footIsOnScreen(settings.foot) ? settings.foot : defaultFoot();
  win = new BrowserWindow({
    ...windowBoundsFor(foot),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: settings.onTop,
    show: false,
    title: 'MissClaude',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  // transparent pixels pass clicks through; the renderer turns this off while
  // the cursor is over the pet itself
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL(`app://pet/index.html?character=${encodeURIComponent(settings.character)}`);
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => { win = null; });
  // renderer warnings/errors and crashes end up in main.log too
  win.webContents.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error') logError(`renderer ${e.level}:`, e.message);
  });
  win.webContents.on('render-process-gone', (_e, d) => logError('renderer gone:', d.reason));
}

function moveWindow(f) {
  if (!win || win.isDestroyed()) return;
  foot = f;
  // always pass the size too: setPosition alone can grow the window by a pixel
  // per call under fractional display scaling
  win.setBounds(windowBoundsFor(f));
}

function setSize(size) {
  settings.size = size;
  saveSettings();
  if (win && foot) win.setBounds(windowBoundsFor(foot));
  send({ type: 'layout', layout: layout() });
  refreshMenus();
}

function updateSetting(key, value) {
  settings[key] = value;
  saveSettings();
  send({ type: 'settings', settings: rendererSettings() });
  refreshMenus();
}

// ---------- menus ----------

function menuTemplate() {
  // every choice is also published as a "menu" output event
  const item = (label, id, fn, extra = {}) => ({
    label, ...extra, click: (menuItem) => { controller.publish('menu', { item: id }); fn(menuItem); },
  });
  const sizeItem = (label, size) => item(label, `size:${size}`, () => setSize(size),
    { type: 'radio', checked: settings.size === size });
  const names = characterNames();
  const characterItem = (name) => item(name, `character:${name}`, () => setCharacter(name),
    { type: 'radio', checked: settings.character === name });
  return [
    // the pack's own menu: its actions by their names
    ...(character.menu || []).map((m) => item(m.label, m.action, () => send({ type: 'act', action: m.action }))),
    { type: 'separator' },
    ...(names.length > 1 ? [{ label: '角色', submenu: names.map(characterItem) }] : []),
    item('到处走走', 'wander', (m) => updateSetting('wander', m.checked), { type: 'checkbox', checked: settings.wander }),
    item('安静模式', 'quiet', (m) => updateSetting('quiet', m.checked), { type: 'checkbox', checked: settings.quiet }),
    { label: '大小', submenu: [sizeItem('小', 'small'), sizeItem('中', 'medium'), sizeItem('大', 'large')] },
    item('总在最前', 'onTop', (m) => { updateSetting('onTop', m.checked); win?.setAlwaysOnTop(m.checked); },
      { type: 'checkbox', checked: settings.onTop }),
    item('开机自启动', 'autostart', (m) => app.setLoginItemSettings({ openAtLogin: m.checked }),
      { type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin }),
    { type: 'separator' },
    item('回到桌面右下角', 'home', () => send({ type: 'home', foot: defaultFoot() })),
    item('重启（加载更新）', 'restart', restart),
    item('隐藏', 'hide', () => win?.hide()),
    item('退出', 'quit', () => app.quit()),
  ];
}

function restart() {
  app.relaunch();
  app.exit(0);
}

// another pack: everything (window, art, API capabilities) is built for one, so relaunch
function setCharacter(name) {
  if (name === settings.character) return;
  settings.character = name;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const changed = Object.fromEntries(Object.entries(settings)
      .filter(([k, v]) => k !== 'foot' && JSON.stringify(v) !== JSON.stringify(DEFAULTS[k])));
    fs.writeFileSync(userFile('settings.json'), JSON.stringify({ ...changed, foot }, null, 2));
  } catch (err) {
    logError('saving settings failed:', err);
  }
  restart();
}

function refreshMenus() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function createTray() {
  const img = nativeImage.createFromPath(characterAsset('tray.png'));
  img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(characterAsset('tray@2x.png')) });
  tray = new Tray(img);
  tray.setToolTip(character.title || 'MissClaude');
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.showInactive();
  });
  refreshMenus();
}

// ---------- outputs: webhooks ----------

// settings.webhooks: [{ "url": "http://127.0.0.1:9000/pet", "types": ["click", "pet"] }]
function startWebhooks() {
  controller.subscribe((ev) => {
    for (const hook of settings.webhooks || []) {
      if (!hook || !hook.url || (hook.types && !hook.types.includes(ev.type))) continue;
      fetch(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ev),
        signal: AbortSignal.timeout(2000),
      }).catch(() => {});
    }
  });
}

// ---------- IPC ----------

// the renderer gets the settings it acts on, not the API secret
const rendererSettings = () => ({ ...settings, apiToken: undefined });

ipcMain.handle('pet:init', () => ({ layout: layout(), foot, displays: displays(), settings: rendererSettings() }));
ipcMain.handle('pet:cursor', () => screen.getCursorScreenPoint());
ipcMain.on('pet:move', (_e, x, y) => {
  if (Number.isFinite(x) && Number.isFinite(y)) moveWindow({ x, y });
});
ipcMain.on('pet:rest', () => saveSettings()); // pet settled somewhere: remember it
ipcMain.on('pet:ignore-mouse', (_e, ignore) => {
  win?.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
});
ipcMain.on('pet:menu', () => {
  if (win) Menu.buildFromTemplate(menuTemplate()).popup({ window: win });
});
ipcMain.on('pet:event', (_e, type, data) => controller.fromRenderer(String(type), data || {}));

// ---------- app ----------

app.on('second-instance', () => win?.showInactive());
app.on('child-process-gone', (_e, d) => logError(`child process gone: ${d.type} ${d.reason}`));
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  if (!isPrimary) return;
  loadSettings();
  loadCharacter();
  controller = new PetController({ send, character });
  loadRules();
  watchRules();
  const root = path.resolve(__dirname);
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  // the API comes up first so other modules can connect even if UI pieces fail
  let apiHost = settings.apiHost || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(apiHost) && !settings.apiToken) {
    logError(`apiHost ${apiHost} needs an apiToken in settings.json; listening on 127.0.0.1 only`);
    apiHost = '127.0.0.1';
  }
  const api = createApiServer(controller, {
    port: settings.apiPort,
    host: apiHost,
    token: settings.apiToken || '',
    extraState: () => ({
      visible: Boolean(win && win.isVisible()),
      character: settings.character,
      api: { host: apiHost, port: settings.apiPort, tokenRequired: Boolean(settings.apiToken) },
      foot,
      size: settings.size,
      quiet: settings.quiet,
      rulesError,
    }),
    onRulesChanged: saveRules,
    restart,
    capture: async () => {
      if (!win) return { ok: false, error: 'no window' };
      const file = userFile('capture.png');
      fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
      return { ok: true, file };
    },
  });
  api.on('fatal', (err) => logError(`api server not started on port ${settings.apiPort}:`, err));
  controller.startClock();
  startWebhooks();
  createWindow();
  try {
    createTray();
  } catch (err) {
    logError('tray unavailable:', err); // e.g. no shell/taskbar in this session
  }
  const pushDisplays = () => send({ type: 'displays', displays: displays() });
  screen.on('display-added', pushDisplays);
  screen.on('display-removed', pushDisplays);
  screen.on('display-metrics-changed', pushDisplays);
});
