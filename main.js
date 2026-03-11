const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');
// Load asi-loader - must be in app.asar (files), not extraResources
const { injectAsi } = require('./asi-loader');

// Discord RPC
let RPC = null;
try {
  RPC = require('discord-rpc');
} catch (e) {
  console.warn('[Discord RPC] Failed to load discord-rpc:', e.message);
}

let mainWindow;
let tray = null;
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');


const UPDATE_BASE_URL = 'YOUR_LAUCNHER_URL';
let updateInfo = null; // { version, url, releaseDate, notes }
let downloadedUpdatePath = null;



function compareVersions(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

const API_HOST = 'API';
const API_PORT = PORT_API;

function ensureApiPort(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.hostname === API_HOST && (u.port === '3000' || u.port === '')) {
      u.port = String(API_PORT);
      return u.toString();
    }
    return urlStr;
  } catch {
    return urlStr;
  }
}

function resolveUrl(baseUrl, candidateUrl) {
  try {
    const resolved = new URL(candidateUrl, baseUrl).toString();
    return ensureApiPort(resolved);
  } catch {
    return candidateUrl;
  }
}

function fetchJson(url, redirectCount = 0) {
  if (redirectCount > 10) {
    return Promise.reject(new Error('Too many redirects'));
  }
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = resolveUrl(url, res.headers.location);
        res.resume();
        return fetchJson(redirectUrl, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Таймаут'));
    });
  });
}
async function checkForUpdates() {
  if (!UPDATE_BASE_URL || UPDATE_BASE_URL.includes('example.com')) return null;
  try {
    const baseUrl = UPDATE_BASE_URL.replace(/\/+$/, '');
    const manifestUrl = `${baseUrl}/latest.json`;
    const manifest = await fetchJson(manifestUrl);
    const remoteVersion = (manifest.version || '').trim();
    const currentVersion = (app.getVersion() || '0.0.0').trim();
    if (!remoteVersion || compareVersions(remoteVersion, currentVersion) <= 0) return null;
    const manifestDownloadUrl = typeof manifest.url === 'string' ? manifest.url.trim() : '';
    const fallbackDownloadUrl = `${baseUrl}/ALauncher-${remoteVersion}.exe`;
    updateInfo = {
      version: remoteVersion,
      url: manifestDownloadUrl ? resolveUrl(manifestUrl, manifestDownloadUrl) : fallbackDownloadUrl,
      releaseDate: manifest.releaseDate || '',
      notes: manifest.notes || '',
    };
    return updateInfo;
  } catch (e) {
    console.warn('[Update] Check failed:', e.message);
    return null;
  }
}
function downloadUpdateToTemp() {
  if (!updateInfo || !updateInfo.url) return Promise.reject(new Error('Нет информации об обновлении'));
  const tempPath = path.join(app.getPath('temp'), `ALauncher-${updateInfo.version}.exe`);
  const sendProgress = (percent, downloaded, total) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-progress', { percent, downloaded, total });
    }
  };
  const cleanupTempFile = () => {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
    }
  };

  const getCandidateUrls = () => {
    try {
      const base = new URL(UPDATE_BASE_URL.replace(/\/+$/, ''));
      const v = updateInfo.version;
      const basePath = base.pathname.replace(/\/+$/, '');
      return [
        `${base.origin}${basePath}/ALauncher-${v}.exe`,
        `${base.origin}/ALauncher/download/ALauncher-${v}.exe`,
        `${base.origin}/ALauncher-${v}.exe`,
        `${base.origin}/download/ALauncher-${v}.exe`,
        `${base.origin}/releases/ALauncher-${v}.exe`,
      ];
    } catch {
      return [];
    }
  };

  const downloadFromUrl = (requestUrl, redirectCount = 0, candidateIndex = -1) => {
    if (redirectCount > 10) {
      return Promise.reject(new Error('Too many redirects while downloading update'));
    }

    return new Promise((resolve, reject) => {
      const mod = requestUrl.startsWith('https') ? https : http;
      const req = mod.get(requestUrl, { headers: { 'User-Agent': 'AmazingLauncher/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = resolveUrl(requestUrl, res.headers.location);
          res.resume();
          return downloadFromUrl(redirectUrl, redirectCount + 1, candidateIndex).then(resolve).catch(reject);
        }

        if (res.statusCode === 404) {
          const candidates = getCandidateUrls();
          const next = candidateIndex + 1;
          if (next < candidates.length) {
            const altUrl = candidates[next];
            if (altUrl !== requestUrl) {
              res.resume();
              return downloadFromUrl(altUrl, 0, next).then(resolve).catch(reject);
            }
          }
        }

        if (res.statusCode !== 200) {
          cleanupTempFile();
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}. Убедитесь что ALauncher-${updateInfo.version}.exe загружен на сервер. Исправьте url в latest.json или положите файл в /ALauncher/`));
          return;
        }

        const file = fs.createWriteStream(tempPath);
        const total = parseInt(res.headers['content-length'], 10) || 0;
        let downloaded = 0;
        let lastPercent = -1;

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            const percent = Math.min(99, Math.floor((downloaded / total) * 100));
            if (percent !== lastPercent) {
              lastPercent = percent;
              sendProgress(percent, downloaded, total);
            }
          } else {
            sendProgress(-1, downloaded, 0);
          }
        });

        res.on('error', (err) => {
          cleanupTempFile();
          reject(err);
        });

        res.pipe(file);

        file.on('finish', () => {
          file.close(() => {
            downloadedUpdatePath = tempPath;
            updateInfo.url = requestUrl;
            sendProgress(100, total || downloaded, total || downloaded);
            resolve(tempPath);
          });
        });

        file.on('error', (err) => {
          cleanupTempFile();
          reject(err);
        });
      });

      req.on('error', (err) => {
        cleanupTempFile();
        reject(err);
      });

      req.setTimeout(60000, () => {
        req.destroy(new Error('Таймаут загрузки (60 сек)'));
      });
    });
  };

  cleanupTempFile();
  return downloadFromUrl(updateInfo.url);
}
function applyUpdateAndRestart() {
  if (!downloadedUpdatePath || !fs.existsSync(downloadedUpdatePath)) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-error', 'Файл обновления не найден');
    }
    return;
  }

  if (!app.isPackaged) {
    const child = spawn(downloadedUpdatePath, [], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }

  const oldExePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const oldDir = path.dirname(oldExePath);
  const newExeName = `ALauncher-${updateInfo.version}.exe`;
  const newExePath = path.join(oldDir, newExeName);
  const srcPath = downloadedUpdatePath;
  const srcEsc = srcPath.replace(/'/g, "''");
  const oldEsc = oldExePath.replace(/'/g, "''");
  const newEsc = newExePath.replace(/'/g, "''");
  const psScript = `
$ErrorActionPreference = 'Stop'
$src = '${srcEsc}'
$oldExe = '${oldEsc}'
$newExe = '${newEsc}'

for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $stream = [System.IO.File]::Open($oldExe, 'Open', 'ReadWrite', 'None')
    $stream.Close()
    break
  } catch {
    if ($i -eq 29) { exit 1 }
  }
}

Copy-Item -LiteralPath $src -Destination $newExe -Force

if ($oldExe -ne $newExe) {
  Remove-Item -LiteralPath $oldExe -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 500
Start-Process -FilePath $newExe

Start-Sleep -Seconds 2
Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue
`;
  const psPath = path.join(app.getPath('temp'), 'alauncher-updater.ps1');
  const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  const scriptBuf = Buffer.from(psScript.trim(), 'utf8');
  fs.writeFileSync(psPath, Buffer.concat([bom, scriptBuf]));

  const child = spawn('cmd.exe', [
    '/c', 'start', '', 'powershell.exe',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', psPath,
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  if (tray) {
    tray.destroy();
    tray = null;
  }
  app.isQuiting = true;
  app.quit();
}


const DISCORD_CLIENT_ID = '1480208684343759008'; 
let discordClient = null;
let discordStartTime = null;
let gameRpcWatcher = null;
let lastGameServer = '';
let lastGameNick = '';

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

      
      if (data.nicknames && !data.serverNicks) {
        data.serverNicks = {};
        const servers = ['RED','YELLOW','GREEN','AZURE','SILVER','ROSE','BLACK','SKY','TITAN','X','FIRE','LIME'];
        servers.forEach(s => {
          data.serverNicks[s] = {
            nicknames: [...data.nicknames],
            activeNick: data.activeNick || data.nicknames[0] || null,
          };
        });
      }

      return {
        serverNicks: data.serverNicks || {},
        gamePath: data.gamePath || '',
        asiLoader: data.asiLoader !== undefined ? data.asiLoader : false,
        installedSkinReplacements: data.installedSkinReplacements || [],
      };
    }
  } catch (e) {
    console.error('Config load error:', e);
  }
  return { serverNicks: {}, gamePath: '', asiLoader: false, installedSkinReplacements: [] };
}

function saveConfig(config) {
  try {
    const current = loadConfig();
    const merged = {
      serverNicks: config.serverNicks !== undefined ? config.serverNicks : current.serverNicks,
      gamePath: config.gamePath !== undefined ? config.gamePath : current.gamePath,
      asiLoader: config.asiLoader !== undefined ? config.asiLoader : current.asiLoader,
      installedSkinReplacements: config.installedSkinReplacements !== undefined ? config.installedSkinReplacements : current.installedSkinReplacements,
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  } catch (e) {
    console.error('Config save error:', e);
  }
}

function createTray() {
  const iconPath = getIconPath();
  if (!iconPath) return; 

  tray = new Tray(iconPath);
  const contextMenu = Menu.buildFromTemplate([
    {
            label: 'Открыть Amazing Launcher',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setToolTip('Amazing Launcher');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

function getIconPath() {
 
  let iconPath = path.join(__dirname, 'assets', 'icon.ico');
  if (fs.existsSync(iconPath)) return iconPath;
  
  
  if (process.resourcesPath) {
    iconPath = path.join(process.resourcesPath, 'assets', 'icon.ico');
    if (fs.existsSync(iconPath)) return iconPath;
  }
  
  
  iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
  return fs.existsSync(iconPath) ? iconPath : undefined;
}

function createWindow() {
  const iconPath = getIconPath();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    backgroundColor: '#0c0c0c',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: iconPath,
    show: false, 
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenu(null);

 
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

 
  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

// ===== DISCORD RICH PRESENCE =====
async function initDiscordRPC() {
  if (!RPC) return;

  try {
    discordClient = new RPC.Client({ transport: 'ipc' });

    discordClient.on('ready', () => {
      console.log('[Discord RPC] Connected');
      discordStartTime = Date.now();
      updateDiscordStatus('idle', {});
    });

    await discordClient.login({ clientId: DISCORD_CLIENT_ID });
  } catch (e) {
    console.warn('[Discord RPC] Connection error:', e.message);
    discordClient = null;
  }
}

async function updateDiscordStatus(status, data = {}) {
  if (!discordClient || !RPC) return;

  try {
    const server = data.serverName || lastGameServer || '';
    const nick = data.nickname || lastGameNick || '';
    const ts = discordStartTime || Date.now();

    const statuses = {
      idle: {
        details: 'В главном меню',
        state: 'Выбор сервера',
        largeImageKey: 'amazing_logo',
        largeImageText: 'Amazing RP Launcher',
        smallImageKey: 'idle',
        smallImageText: 'Ожидание',
      },
      server_selected: {
        details: `Сервер: Amazing ${server}`,
        state: nick ? `Ник: ${nick}` : 'Выбор ника',
        largeImageKey: 'amazing_logo',
        largeImageText: 'Amazing RP Launcher',
        smallImageKey: 'server',
        smallImageText: `Amazing ${server}`,
      },
      playing: {
        details: `Играет на Amazing ${server}`,
        state: nick ? `Ник: ${nick}` : 'В игре',
        largeImageKey: 'amazing_logo',
        largeImageText: 'Amazing RP',
        smallImageKey: 'playing',
        smallImageText: 'В игре',
        startTimestamp: ts,
      },
      on_foot: {
        details: `Amazing ${server} — Пешком`,
        state: nick ? `${nick} | HP: ${data.health || '?'} | ${data.weapon || ''}` : '',
        largeImageKey: 'amazing_logo',
        largeImageText: 'Amazing RP',
        smallImageKey: 'playing',
        smallImageText: 'Пешком',
        startTimestamp: ts,
      },
      driving: {
        details: `Amazing ${server} — За рулём`,
        state: nick ? `${nick} | ${data.vehicle || 'Авто'} — ${data.speed || 0} км/ч` : '',
        largeImageKey: 'amazing_logo',
        largeImageText: 'Amazing RP',
        smallImageKey: 'driving',
        smallImageText: data.vehicle || 'Транспорт',
        startTimestamp: ts,
      },
      passenger: {
        details: `Amazing ${server} — Пассажир`,
        state: nick ? `${nick} | ${data.vehicle || 'Авто'}` : '',
        largeImageKey: 'amazing_logo',
        largeImageText: 'Amazing RP',
        smallImageKey: 'passenger',
        smallImageText: data.vehicle || 'Транспорт',
        startTimestamp: ts,
      },
      armed: {
        details: `Amazing ${server} — Вооружён`,
        state: nick ? `${nick} | ${data.weapon || 'Оружие'} [${data.ammo || 0}]` : '',
        largeImageKey: 'amazing_logo',
        largeImageText: 'Amazing RP',
        smallImageKey: 'armed',
        smallImageText: data.weapon || 'Оружие',
        startTimestamp: ts,
      },
      wanted: {
        details: `Amazing ${server} — В розыске ⭐×${data.wantedLevel || '?'}`,
        state: nick ? `${nick} | Убегает от полиции` : '',
        largeImageKey: 'amazing_logo',
        largeImageText: 'Amazing RP',
        smallImageKey: 'wanted',
        smallImageText: `Розыск: ${data.wantedLevel || '?'} звёзд`,
        startTimestamp: ts,
      },
      jail: {
        details: `Amazing ${server} — В тюрьме`,
        state: nick ? `${nick} | Отбывает срок` : '',
        largeImageKey: 'amazing_logo',
        largeImageText: 'Amazing RP',
        smallImageKey: 'jail',
        smallImageText: 'Тюрьма',
        startTimestamp: ts,
      },
      wasted: {
        details: `Amazing ${server} — Убит`,
        state: nick ? `${nick} | Респавн...` : '',
        largeImageKey: 'amazing_logo',
        largeImageText: 'Amazing RP',
        smallImageKey: 'wasted',
        smallImageText: 'Wasted',
        startTimestamp: ts,
      },
      paused: {
        details: `Amazing ${server} — Пауза`,
        state: nick ? `${nick} | Меню` : '',
        largeImageKey: 'amazing_logo',
        largeImageText: 'Amazing RP',
        smallImageKey: 'paused',
        smallImageText: 'На паузе',
        startTimestamp: ts,
      },
      store: {
        details: 'Рыщет в магазине ASI',
        state: 'Просмотр плагинов',
        largeImageKey: 'amazing_logo',
        largeImageText: 'Amazing RP Launcher',
        smallImageKey: 'store',
        smallImageText: 'Магазин ASI',
      },
      loading: {
        details: 'Ожидание загрузки',
        state: data.message || 'Запуск игры...',
        largeImageKey: 'amazing_logo',
        largeImageText: 'Amazing RP Launcher',
        smallImageKey: 'loading',
        smallImageText: 'Загрузка',
      },
      afk: {
        details: 'АФК',
        state: 'Отошёл от компьютера',
        largeImageKey: 'amazing_logo',
        largeImageText: 'Amazing RP Launcher',
        smallImageKey: 'afk',
        smallImageText: 'АФК',
      },
    };

    const presence = statuses[status] || statuses.idle;
    await discordClient.setActivity(presence);
  } catch (e) {
    console.warn('[Discord RPC] Status update error:', e.message);
  }
}

const RPC_STATUS_FILE = path.join(app.getPath('temp'), 'amazing-rpc-status.json');

function startGameRpcWatcher() {
  if (gameRpcWatcher) return;
  gameRpcWatcher = setInterval(() => {
    try {
      if (!fs.existsSync(RPC_STATUS_FILE)) return;
      const raw = fs.readFileSync(RPC_STATUS_FILE, 'utf8');
      const status = JSON.parse(raw);
      const activity = status.activity || 'playing';
      updateDiscordStatus(activity, {
        serverName: lastGameServer,
        nickname: lastGameNick,
        health: Math.round(status.health || 0),
        armor: Math.round(status.armor || 0),
        weapon: status.weapon || '',
        ammo: status.ammo || 0,
        vehicle: status.vehicleName || '',
        speed: Math.round(status.speed || 0),
        wantedLevel: status.wantedLevel || 0,
        interior: status.interior || 0,
      });
    } catch {
    }
  }, 3000);
}

function stopGameRpcWatcher() {
  if (gameRpcWatcher) {
    clearInterval(gameRpcWatcher);
    gameRpcWatcher = null;
  }
  try {
    if (fs.existsSync(RPC_STATUS_FILE)) fs.unlinkSync(RPC_STATUS_FILE);
  } catch {}
}

app.whenReady().then(async () => {
  createWindow();
  createTray();
  await initDiscordRPC();
  setTimeout(() => {
    checkForUpdates().then((info) => {
      if (info && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-available', info);
      }
    }).catch((e) => {
      console.warn('[Update]', e.message);
    });
  }, 2500);
});

app.on('window-all-closed', () => {
  
  if (!tray) app.quit();
});

app.on('before-quit', async () => {
  app.isQuiting = true;
  stopGameRpcWatcher();
  if (discordClient) {
    try {
      await discordClient.destroy();
    } catch (e) {
      // Ignore
    }
    discordClient = null;
  }
});


ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-close', () => mainWindow.close());

ipcMain.handle('load-config', () => loadConfig());
ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('save-config', (_e, data) => {
  saveConfig(data);
  return true;
});


ipcMain.handle('select-game-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите папку с GTA San Andreas',
    properties: ['openDirectory'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const p = result.filePaths[0];
    const cfg = loadConfig();
    cfg.gamePath = p;
    saveConfig(cfg);
    return p;
  }
  return null;
});


ipcMain.handle('connect-to-server', async (_e, { ip, port, nickname, asiEnabled, serverName }) => {
  const cfg = loadConfig();
  if (!cfg.gamePath) return { success: false, error: 'Путь к игре не указан' };

  const aggstarterExe = path.join(cfg.gamePath, 'aggstarter.exe');
  if (!fs.existsSync(aggstarterExe)) {
    return { success: false, error: 'aggstarter.exe не найден в папке с игрой' };
  }

  lastGameServer = serverName || '';
  lastGameNick = nickname || '';
  updateDiscordStatus('playing', { serverName, nickname });
  startGameRpcWatcher();

  try {
    const cmd = `"${aggstarterExe}" -amazing -c -h ${ip} -p ${port} -n ${nickname} --launcher --stream`;
    console.log('[Launch]', cmd);

    const gameProcess = exec(cmd, { cwd: cfg.gamePath });
    gameProcess.on('exit', () => {
      stopGameRpcWatcher();
      updateDiscordStatus('idle', {});
    });


    if (asiEnabled) {

      updateDiscordStatus('loading', { message: 'Загрузка ASI плагинов...' });
      

      (async () => {
        try {
          const result = await injectAsi(cfg.gamePath, (msg) => {
            console.log(msg);

            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('asi-log', msg);
            }
          });
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('asi-done', {
              success: true,
              injected: result.injected,
              total: result.total,
              errors: result.errors,
            });
          }

          updateDiscordStatus('playing', { serverName, nickname });
        } catch (e) {
          console.error('[ASI Error]', e.message);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('asi-done', {
              success: false,
              error: e.message,
            });
          }
          updateDiscordStatus('playing', { serverName, nickname });
        }
      })();
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});


ipcMain.on('discord-status', (_e, { status, data }) => {
  updateDiscordStatus(status, data || {});
});


ipcMain.handle('fetch-skin-replacements', async (_e, storeUrl) => {
  if (!storeUrl) return { success: false, error: 'URL сервера не указан', replacements: [] };

  return new Promise((resolve) => {
    const url = storeUrl.replace(/\/+$/, '') + '/api/skin-replacements';
    const mod = url.startsWith('https') ? https : require('http');

    const req = mod.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) {
        resolve({ success: false, error: `HTTP ${res.statusCode}`, replacements: [] });
        return;
      }
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const rawList = JSON.parse(body);
          const base = storeUrl.replace(/\/+$/, '');
          // Make relative downloadUrl / previewUrl absolute
          const replacements = rawList.map(r => ({
            ...r,
            downloadUrl: r.downloadUrl && r.downloadUrl.startsWith('/') ? base + r.downloadUrl : (r.downloadUrl || ''),
            previewUrl: r.previewUrl && r.previewUrl.startsWith('/') ? base + r.previewUrl : (r.previewUrl || ''),
          }));
          resolve({ success: true, replacements });
        } catch (e) {
          resolve({ success: false, error: 'Ошибка парсинга ответа', replacements: [] });
        }
      });
    });

    req.on('error', (e) => resolve({ success: false, error: e.message, replacements: [] }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Таймаут подключения', replacements: [] });
    });
  });
});

ipcMain.handle('fetch-asi-catalog', async (_e, storeUrl) => {
  if (!storeUrl) return { success: false, error: 'URL сервера не указан' };

  return new Promise((resolve) => {
    const url = storeUrl.replace(/\/+$/, '') + '/api/plugins';
    const mod = url.startsWith('https') ? https : require('http');

    const req = mod.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) {
        resolve({ success: false, error: `HTTP ${res.statusCode}` });
        return;
      }
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const plugins = JSON.parse(body);
          resolve({ success: true, plugins });
        } catch (e) {
          resolve({ success: false, error: 'Ошибка парсинга ответа' });
        }
      });
    });

    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Таймаут подключения' });
    });
  });
});

// ===== ASI STORE =====

// Download file following redirects (Google Drive compatible)
function downloadFile(fileUrl, destPath, redirectCount = 0) {
  if (redirectCount > 10) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const mod = fileUrl.startsWith('https') ? https : http;
    const req = mod.get(fileUrl, { headers: { 'User-Agent': 'AmazingLauncher/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadFile(res.headers.location, destPath, redirectCount + 1).then(resolve).catch(reject);
      }

      if (res.headers['content-type'] && res.headers['content-type'].includes('text/html')) {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          const m1 = body.match(/href="(\/uc\?export=download[^"]+)"/);
          if (m1) {
            const u = 'https://drive.google.com' + m1[1].replace(/&amp;/g, '&');
            return downloadFile(u, destPath, redirectCount + 1).then(resolve).catch(reject);
          }
          const m2 = body.match(/id="download-form" action="([^"]+)"/);
          if (m2) {
            return downloadFile(m2[1].replace(/&amp;/g, '&'), destPath, redirectCount + 1).then(resolve).catch(reject);
          }
          const m3 = body.match(/confirm=([0-9A-Za-z_-]+)/);
          if (m3) {
            try {
              const driveId = new URL(fileUrl).searchParams.get('id');
              if (driveId) {
                const u = `https://drive.google.com/uc?export=download&confirm=${m3[1]}&id=${driveId}`;
                return downloadFile(u, destPath, redirectCount + 1).then(resolve).catch(reject);
              }
            } catch {}
          }
          reject(new Error('Failed to download from Google Drive'));
        });
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(); });
      fileStream.on('error', (err) => {
        try { fs.unlinkSync(destPath); } catch {}
        reject(err);
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Download timeout (30s)'));
    });
  });
}

// Check which ASI files are installed
ipcMain.handle('check-asi-installed', async (_e, fileNames) => {
  const cfg = loadConfig();
  if (!cfg.gamePath) return {};

  const asiDir = path.join(cfg.gamePath, 'asi');
  const result = {};

  for (const name of fileNames) {
    result[name] = fs.existsSync(path.join(asiDir, name));
  }
  return result;
});

// Download ASI from Google Drive
ipcMain.handle('download-asi', async (_e, { fileId, fileName }) => {
  const cfg = loadConfig();
  if (!cfg.gamePath) return { success: false, error: 'Путь к игре не указан' };

  const asiDir = path.join(cfg.gamePath, 'asi');

  // Create asi folder if not exists
  if (!fs.existsSync(asiDir)) {
    fs.mkdirSync(asiDir, { recursive: true });
  }

  const destPath = path.join(asiDir, fileName);
  const url = `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`;

  try {
    console.log(`[Store] Downloading ${fileName}...`);
    await downloadFile(url, destPath);
    console.log(`[Store] Downloaded: ${destPath}`);
    return { success: true };
  } catch (e) {
    console.error(`[Store] Download error:`, e.message);
    return { success: false, error: e.message };
  }
});

// Download skin replacement to models/assets/skins (zip — распаковывается)
ipcMain.handle('download-skin-replacement', async (_e, { fileId, fileName, id: replacementId, downloadUrl }) => {
  const cfg = loadConfig();
  if (!cfg.gamePath) return { success: false, error: 'Путь к игре не указан' };

  const skinsDir = path.join(cfg.gamePath, 'models', 'assets', 'skins');
  if (!fs.existsSync(skinsDir)) {
    fs.mkdirSync(skinsDir, { recursive: true });
  }

  // Use direct downloadUrl if available, otherwise fall back to Google Drive
  const url = (downloadUrl && downloadUrl.startsWith('http'))
    ? downloadUrl
    : `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`;
  const isZip = fileName.toLowerCase().endsWith('.zip');

  try {
    if (isZip) {
      const tempZip = path.join(app.getPath('temp'), `skin-${Date.now()}-${fileName}`);
      console.log(`[Replacements] Downloading zip ${fileName}...`);
      await downloadFile(url, tempZip);
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(tempZip);
      zip.extractAllTo(skinsDir, true);
      try { fs.unlinkSync(tempZip); } catch {}
      if (replacementId) {
        const cfg2 = loadConfig();
        const list = cfg2.installedSkinReplacements || [];
        if (!list.includes(replacementId)) list.push(replacementId);
        saveConfig({ ...cfg2, installedSkinReplacements: list });
      }
      console.log(`[Replacements] Extracted to ${skinsDir}`);
    } else {
      const destPath = path.join(skinsDir, fileName);
      console.log(`[Replacements] Downloading ${fileName}...`);
      await downloadFile(url, destPath);
      console.log(`[Replacements] Downloaded: ${destPath}`);
    }
    return { success: true };
  } catch (e) {
    console.error(`[Replacements] Download error:`, e.message);
    return { success: false, error: e.message };
  }
});

// Check if skin replacement is installed
ipcMain.handle('check-skin-replacement-installed', async (_e, { baseSkin, fileName, id: replacementId }) => {
  const cfg = loadConfig();
  if (!cfg.gamePath) return false;

  const skinsDir = path.join(cfg.gamePath, 'models', 'assets', 'skins');
  if (!fs.existsSync(skinsDir)) return false;

  const isZip = fileName.toLowerCase().endsWith('.zip');
  if (isZip && replacementId) {
    const cfg2 = loadConfig();
    const list = cfg2.installedSkinReplacements || [];
    if (list.includes(replacementId)) return true;
    const markerPath = path.join(skinsDir, `.skin-replacement-${replacementId}`);
    if (fs.existsSync(markerPath)) {
      try { fs.unlinkSync(markerPath); } catch {}
      const newList = [...list, replacementId];
      saveConfig({ ...cfg2, installedSkinReplacements: newList });
      return true;
    }
    return false;
  }
  return fs.existsSync(path.join(skinsDir, fileName));
});

// Remove ASI file
ipcMain.handle('remove-asi', async (_e, { fileName }) => {
  const cfg = loadConfig();
  if (!cfg.gamePath) return { success: false, error: 'Путь к игре не указан' };

  const filePath = path.join(cfg.gamePath, 'asi', fileName);

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('open-external', async (_e, url) => {
  const { shell } = require('electron');
  await shell.openExternal(url);
  return true;
});

// ===== PORTABLE AUTO-UPDATE IPC =====
ipcMain.handle('update-check', async () => {
  const info = await checkForUpdates();
  if (info && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-available', info);
  }
  return info;
});

ipcMain.handle('update-download', async () => {
  try {
    await downloadUpdateToTemp();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-downloaded', { version: updateInfo?.version });
    }
    return { success: true };
  } catch (e) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-error', e.message);
    }
    return { success: false, error: e.message };
  }
});

ipcMain.on('update-apply', () => {
  applyUpdateAndRestart();
});


