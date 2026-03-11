// ===== SERVERS =====
const SERVERS = [
  { name: 'RED',    ip: '80.66.82.192', port: '7777', cover: 'assets/red.png' },
  { name: 'YELLOW', ip: '80.66.82.193', port: '7777', cover: 'assets/yellow.png' },
  { name: 'GREEN',  ip: '80.66.82.194', port: '7777', cover: 'assets/green.png' },
  { name: 'AZURE',  ip: '80.66.82.195', port: '7777', cover: 'assets/azure.png' },
  { name: 'SILVER', ip: '80.66.82.196', port: '7777', cover: 'assets/silver.png' },
  { name: 'ROSE',   ip: '80.66.71.6',   port: '7777', cover: 'assets/rose.png' },
  { name: 'BLACK',  ip: '80.66.82.40',  port: '7777', cover: 'assets/black.png' },
  { name: 'SKY',    ip: '80.66.82.41',  port: '7777', cover: 'assets/sky.png' },
  { name: 'TITAN',  ip: '80.66.82.165', port: '7777', cover: 'assets/titan.png' },
  { name: 'X',      ip: '80.66.82.185', port: '7777', cover: 'assets/x.png' },
  { name: 'FIRE',   ip: '80.66.82.163', port: '7777', cover: 'assets/fire.png' },
  { name: 'LIME',   ip: '80.66.82.189', port: '7777', cover: 'assets/lime.png' },
];

// ===== ASI STORE CATALOG (loaded from remote server) =====
const STORE_URL = 'YOUR_API_LOADER';
let ASI_CATALOG = [];

// ===== SKIN REPLACEMENTS =====
let REPLACEMENTS_CATALOG = [];

// ===== LIKES =====
let likedReplacements = new Set(JSON.parse(localStorage.getItem('liked-replacements') || '[]'));

// ===== STATE =====
let selectedServer = null;
let config = {
  serverNicks: {},
  gamePath: '',
  asiLoader: false,
};
let storeInstalled = {};

// ===== DOM =====
const $ = (s) => document.querySelector(s);
const nickList = $('#nick-list');
const nickEmpty = $('#nick-empty');
const nickInput = $('#nick-input');
const nickAddBtn = $('#nick-add-btn');
const nickError = $('#nick-error');
const nickServerLabel = $('#nick-server-label');
const gamePath = $('#game-path');
const btnBrowse = $('#btn-browse');
const btnPlay = $('#btn-play');
const serversGrid = $('#servers-grid');
const statusText = $('#status-text');
const toastContainer = $('#toast-container');
const asiToggle = $('#asi-toggle');
const btnStore = $('#btn-store');
const storeOverlay = $('#store-overlay');
const storeClose = $('#store-close');
const storeList = $('#store-list');
const btnCredits = $('#btn-credits');
const creditsOverlay = $('#credits-overlay');
const creditsClose = $('#credits-close');
const asiDetailOverlay = $('#asi-detail-overlay');
const asiDetailClose = $('#asi-detail-close');
const asiDetailInstall = $('#asi-detail-install');
const asiDetailRemove = $('#asi-detail-remove');
const asiDetailInstalled = $('#asi-detail-installed');
let currentDetailAsi = null;

// Replacements tab
const tabMain = $('#tab-main');
const tabReplacements = $('#tab-replacements');
const skinsList = $('#skins-list');
const replacementsGrid = $('#replacements-grid');
const replacementsEmpty = $('#replacements-empty');
const replacementsSkinName = $('#replacements-skin-name');
const replacementsBack = $('#replacements-back');
let selectedSkin = null;
let replacementsInstalled = {};

// Update banner
const updateBanner = $('#update-banner');
const updateVersion = $('#update-version');
const updateDownloadBtn = $('#update-download-btn');
const updateRestartBtn = $('#update-restart-btn');
const updateDismissBtn = $('#update-dismiss-btn');
const updateProgressWrap = $('#update-progress-wrap');
const updateProgressFill = $('#update-progress-fill');
const updateProgressText = $('#update-progress-text');
const creditsCheckUpdate = $('#credits-check-update');
let updateDismissed = false;

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
}

// ===== HELPERS =====
function getServerNicks(serverName) {
  if (!serverName) return { nicknames: [], activeNick: null };
  if (!config.serverNicks[serverName]) {
    config.serverNicks[serverName] = { nicknames: [], activeNick: null };
  }
  return config.serverNicks[serverName];
}

function getActiveNickname() {
  if (!selectedServer) return null;
  return getServerNicks(selectedServer.name).activeNick;
}

// ===== INIT =====
async function init() {
  try {
    const loaded = await window.electronAPI.loadConfig();
    if (loaded.serverNicks) config.serverNicks = loaded.serverNicks;
    if (loaded.gamePath) config.gamePath = loaded.gamePath;
    if (loaded.asiLoader !== undefined) config.asiLoader = loaded.asiLoader;
  } catch (e) {
    console.error('[Init] Config load error:', e);
  }

  try {
    if (asiToggle) asiToggle.checked = config.asiLoader;
  } catch (e) {
    console.error('[Init] ASI toggle error:', e);
  }

  try {
    renderNicknames();
    renderServers();
    updatePath();
    setupEvents();
    updatePlayButton();
  } catch (e) {
    console.error('[Init] Render error:', e);
  }
  
  // Pre-fetch catalog from server (non-blocking)
  fetchCatalogFromServer(STORE_URL, true).catch(err => {
    console.error('[Store] Failed to fetch catalog:', err);
  });

  // Pre-fetch replacements (non-blocking)
  fetchReplacementsFromServer(STORE_URL).catch(err => {
    console.error('[Replacements] Failed to fetch:', err);
  });
  

  // ASI loader events from main process
  try {
    window.electronAPI.onAsiLog((msg) => {
      if (statusText) statusText.textContent = msg;
    });

    window.electronAPI.onAsiDone((result) => {
      if (result.success) {
        toast('success', `ASI: загружено ${result.injected}/${result.total}`);
        if (result.errors.length > 0) {
          result.errors.forEach((err) => toast('error', err));
        }
        // Update Discord status to playing after ASI injection
        if (selectedServer) {
          const activeNick = getActiveNickname();
          window.electronAPI.updateDiscordStatus('playing', {
            serverName: selectedServer.name,
            nickname: activeNick,
          });
        }
      } else {
        toast('error', `ASI: ${result.error}`);
      }
      setTimeout(() => updatePlayButton(), 500);
    });
  } catch (e) {
    console.error('[Init] ASI events error:', e);
  }


  // Loading screen - always hide after timeout (guaranteed)
  const hideLoadingScreen = () => {
    try {
      const ls = $('#loading-screen');
      const app = $('#app');
      if (ls && !ls.classList.contains('hidden')) {
        ls.classList.add('fade-out');
        setTimeout(() => {
          if (ls) ls.classList.add('hidden');
          if (app) app.classList.remove('hidden');
          
          // Set initial Discord status
          try {
            if (window.electronAPI && window.electronAPI.updateDiscordStatus) {
              window.electronAPI.updateDiscordStatus('idle', {});
            }
          } catch (e) {
            console.error('[Init] Discord RPC error:', e);
          }
        }, 500);
      } else if (app) {
        // If loading screen doesn't exist or already hidden, just show app
        app.classList.remove('hidden');
      }
    } catch (e) {
      console.error('[Init] Loading screen error:', e);
      // Force show app if loading screen fails
      try {
        const app = $('#app');
        if (app) app.classList.remove('hidden');
      } catch (e2) {
        console.error('[Init] Failed to show app:', e2);
      }
    }
  };
  
  // Hide loading screen after 2 seconds (or immediately if everything is ready)
  setTimeout(hideLoadingScreen, 2000);
  
  // Also hide if window is ready (fallback)
  if (document.readyState === 'complete') {
    setTimeout(hideLoadingScreen, 100);
  } else {
    window.addEventListener('load', () => {
      setTimeout(hideLoadingScreen, 100);
    });
  }
  
  // Update events
  try {
    if (window.electronAPI.onUpdateAvailable) {
      window.electronAPI.onUpdateAvailable((info) => {
        if (updateDismissed || !updateBanner) return;
        if (updateVersion) updateVersion.textContent = info.version;
        if (updateDownloadBtn) {
          updateDownloadBtn.classList.remove('hidden');
          updateDownloadBtn.disabled = false;
          updateDownloadBtn.innerHTML = '<span class="material-icons-round">download</span> Скачать';
        }
        if (updateRestartBtn) updateRestartBtn.classList.add('hidden');
        if (updateProgressWrap) updateProgressWrap.classList.add('hidden');
        if (updateBanner) updateBanner.classList.remove('hidden');
      });
    }
    if (window.electronAPI.onUpdateDownloaded) {
      window.electronAPI.onUpdateDownloaded(() => {
        if (!updateBanner) return;
        if (updateDownloadBtn) updateDownloadBtn.classList.add('hidden');
        if (updateProgressWrap) updateProgressWrap.classList.add('hidden');
        if (updateRestartBtn) {
          updateRestartBtn.classList.remove('hidden');
          updateRestartBtn.innerHTML = '<span class="material-icons-round">refresh</span> Перезапустить';
        }
        toast('success', 'Обновление скачано. Нажмите «Перезапустить»');
      });
    }
    if (window.electronAPI.onUpdateError) {
      window.electronAPI.onUpdateError((msg) => {
        toast('error', `Ошибка обновления: ${msg}`);
        if (updateDownloadBtn) {
          updateDownloadBtn.classList.remove('hidden');
          updateDownloadBtn.disabled = false;
          updateDownloadBtn.innerHTML = '<span class="material-icons-round">download</span> Скачать';
        }
        if (updateProgressWrap) updateProgressWrap.classList.add('hidden');
      });
    }
    if (window.electronAPI.onUpdateProgress) {
      window.electronAPI.onUpdateProgress(({ percent, downloaded, total }) => {
        if (!updateProgressWrap || !updateProgressFill || !updateProgressText) return;
        updateProgressWrap.classList.remove('hidden');
        if (percent >= 0) {
          updateProgressFill.style.width = percent + '%';
          updateProgressFill.classList.remove('indeterminate');
          updateProgressText.textContent = `Загрузка... ${percent}%`;
          if (total > 0) {
            updateProgressText.textContent = `Загрузка... ${percent}% (${formatBytes(downloaded)} / ${formatBytes(total)})`;
          }
        } else {
          updateProgressFill.classList.add('indeterminate');
          updateProgressText.textContent = `Загрузка... ${formatBytes(downloaded)}`;
        }
      });
    }
  } catch (e) {
    console.error('[Init] Update events error:', e);
  }

  // Handle window focus/blur for AFK status
  let afkTimeout = null;
  window.addEventListener('blur', () => {
    afkTimeout = setTimeout(() => {
      window.electronAPI.updateDiscordStatus('afk', {});
    }, 30000); // 30 seconds
  });
  
  window.addEventListener('focus', () => {
    if (afkTimeout) {
      clearTimeout(afkTimeout);
      afkTimeout = null;
    }
    // Restore previous status
    if (selectedServer) {
      const activeNick = getActiveNickname();
      window.electronAPI.updateDiscordStatus('server_selected', {
        serverName: selectedServer.name,
        nickname: activeNick,
      });
    } else {
      window.electronAPI.updateDiscordStatus('idle', {});
    }
  });
}

// ===== NICKNAMES =====
function renderNicknames() {
  if (!nickList) {
    console.error('[Render] nickList not found');
    return;
  }
  nickList.querySelectorAll('.nick-item').forEach((el) => el.remove());

  if (!selectedServer) {
    if (nickEmpty) nickEmpty.textContent = 'Сначала выберите сервер';
    if (nickEmpty) nickEmpty.style.display = '';
    if (nickServerLabel) nickServerLabel.textContent = '';
    if (nickInput) nickInput.disabled = true;
    if (nickAddBtn) nickAddBtn.disabled = true;
    return;
  }

  nickInput.disabled = false;
  nickAddBtn.disabled = false;
  nickServerLabel.textContent = selectedServer.name;

  const data = getServerNicks(selectedServer.name);

  if (data.nicknames.length === 0) {
    nickEmpty.textContent = 'Нет ников на этом сервере';
    nickEmpty.style.display = '';
  } else {
    nickEmpty.style.display = 'none';

    if (!data.nicknames.includes(data.activeNick)) {
      data.activeNick = data.nicknames[0];
    }

    data.nicknames.forEach((nick) => {
      const item = document.createElement('div');
      item.className = 'nick-item' + (nick === data.activeNick ? ' active' : '');

      const name = document.createElement('div');
      name.className = 'nick-name';
      name.textContent = nick;

      const del = document.createElement('button');
      del.className = 'nick-delete';
      del.innerHTML = '<span class="material-icons-round">close</span>';
      del.title = 'Удалить';

      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeNickname(nick);
      });

      item.addEventListener('click', () => selectNickname(nick));

      item.appendChild(name);
      item.appendChild(del);
      nickList.insertBefore(item, nickEmpty);
    });
  }
}

function selectNickname(nick) {
  if (!selectedServer) return;
  getServerNicks(selectedServer.name).activeNick = nick;
  saveConfig();
  renderNicknames();
  updatePlayButton();
  
  // Update Discord status
  window.electronAPI.updateDiscordStatus('server_selected', {
    serverName: selectedServer.name,
    nickname: nick,
  });
}

function addNickname() {
  if (!selectedServer) {
    showNickError('Сначала выберите сервер');
    return;
  }

  const value = nickInput.value.trim();
  if (!value) {
    showNickError('Введите никнейм');
    return;
  }

  const regex = /^[A-Z][a-z]+_[A-Z][a-z]+$/;
  if (!regex.test(value)) {
    nickInput.classList.add('error');
    if (!value.includes('_')) showNickError('Формат: Имя_Фамилия');
    else {
      const parts = value.split('_');
      if (parts.length !== 2) showNickError('Только один символ "_"');
      else if (!/^[A-Z]/.test(parts[0])) showNickError('Имя с заглавной буквы');
      else if (!/^[A-Z]/.test(parts[1])) showNickError('Фамилия с заглавной буквы');
      else if (/[^a-zA-Z_]/.test(value)) showNickError('Только латиница и "_"');
      else showNickError('Формат: Имя_Фамилия');
    }
    return;
  }

  const data = getServerNicks(selectedServer.name);
  if (data.nicknames.includes(value)) {
    showNickError('Этот ник уже добавлен');
    return;
  }

  data.nicknames.push(value);
  if (!data.activeNick) data.activeNick = value;
  saveConfig();
  renderNicknames();
  updatePlayButton();

  nickInput.value = '';
  nickInput.classList.remove('error');
  nickError.textContent = '';
  toast('success', `${value} → ${selectedServer.name}`);
}

function removeNickname(nick) {
  if (!selectedServer) return;
  const data = getServerNicks(selectedServer.name);
  data.nicknames = data.nicknames.filter((n) => n !== nick);
  if (data.activeNick === nick) data.activeNick = data.nicknames[0] || null;
  saveConfig();
  renderNicknames();
  updatePlayButton();
  toast('success', `${nick} удалён`);
}

function showNickError(msg) {
  nickError.textContent = msg;
  nickInput.classList.add('error');
  setTimeout(() => {
    nickError.textContent = '';
    nickInput.classList.remove('error');
  }, 3000);
}

// ===== SERVERS =====
function renderServers() {
  if (!serversGrid) {
    console.error('[Render] serversGrid not found');
    return;
  }
  serversGrid.innerHTML = '';
  SERVERS.forEach((srv, i) => {
    const data = getServerNicks(srv.name);
    const count = data.nicknames.length;

    const card = document.createElement('div');
    card.className = 'server-card';
    card.setAttribute('data-server', srv.name);
    card.style.animationDelay = `${i * 0.03}s`;

    card.innerHTML = `
      ${srv.cover ? `<div class="server-cover" style="background-image: url('${srv.cover}');"></div>` : ''}
      <div class="server-top">
        <div class="server-name">${srv.name}</div>
        ${count > 0 ? `<div class="server-nick-count">${count}</div>` : ''}
      </div>
      <div class="server-bottom">
        <div class="server-ip">${srv.ip}:${srv.port}</div>
      </div>
    `;
    card.addEventListener('click', () => selectServer(srv, card));
    serversGrid.appendChild(card);
  });
}



function selectServer(srv, card) {
  serversGrid.querySelectorAll('.server-card.selected').forEach((c) => c.classList.remove('selected'));
  card.classList.add('selected');
  selectedServer = srv;
  statusText.textContent = `Сервер: Amazing ${srv.name}`;
  renderNicknames();
  updatePlayButton();
  
  // Update Discord status
  const activeNick = getActiveNickname();
  window.electronAPI.updateDiscordStatus('server_selected', {
    serverName: srv.name,
    nickname: activeNick,
  });
}

// ===== PATH =====
function updatePath() {
  if (config.gamePath) {
    gamePath.textContent = config.gamePath;
    gamePath.classList.add('set');
  } else {
    gamePath.textContent = 'Не указан';
    gamePath.classList.remove('set');
  }
}

// ===== PLAY BUTTON =====
function updatePlayButton() {
  const ok = selectedServer && getActiveNickname() && config.gamePath;
  btnPlay.disabled = !ok;
}

// ===== FETCH CATALOG FROM REMOTE SERVER =====
async function fetchCatalogFromServer(url, silent = false) {
  try {
    const result = await window.electronAPI.fetchAsiCatalog(url);
    if (result.success) {
      ASI_CATALOG = result.plugins;
    }
  } catch (e) {
    // Silent fail
  }
}

// ===== ASI STORE =====
async function openStore() {
  if (!config.gamePath) {
    toast('error', 'Сначала укажите путь к игре');
    return;
  }

  storeOverlay.classList.remove('hidden');
  
  // Update Discord status
  window.electronAPI.updateDiscordStatus('store', {});

  // Refresh catalog from server
  await fetchCatalogFromServer(STORE_URL, true);

  // Check installed state
  const fileNames = ASI_CATALOG.map((a) => a.fileName);
  try {
    storeInstalled = await window.electronAPI.checkAsiInstalled(fileNames);
  } catch (e) {
    storeInstalled = {};
  }

  renderStore();
}

function closeStore() {
  storeOverlay.classList.add('hidden');
  
  // Update Discord status back to previous state
  if (selectedServer) {
    const activeNick = getActiveNickname();
    window.electronAPI.updateDiscordStatus('server_selected', {
      serverName: selectedServer.name,
      nickname: activeNick,
    });
  } else {
    window.electronAPI.updateDiscordStatus('idle', {});
  }
}

function closeCredits() {
  creditsOverlay.classList.add('hidden');
}

function renderStore() {
  storeList.innerHTML = '';

  if (ASI_CATALOG.length === 0) {
    storeList.style.gridTemplateColumns = '1fr';
    storeList.innerHTML = `
      <div style="text-align:center;padding:60px 20px;color:var(--text-3);font-size:13px;grid-column:1/-1;">
        <span class="material-icons-round" style="font-size:48px;display:block;margin-bottom:12px;opacity:.3;">extension_off</span>
        Нет доступных плагинов
      </div>
    `;
    return;
  }

  ASI_CATALOG.forEach((asi) => {
    const installed = storeInstalled[asi.fileName] === true;

    const card = document.createElement('div');
    card.className = 'store-card';
    card.innerHTML = `
      <div class="store-card-header">
        <div class="store-icon">
          <span class="material-icons-round">${asi.icon || 'extension'}</span>
        </div>
        <div class="store-info">
          <div class="store-name">${asi.name}</div>
          <div class="store-desc">${asi.description || 'Без описания'}</div>
        </div>
      </div>
      <div class="store-file">${asi.fileName}</div>
    `;

    // Card click handler - open detail modal
    card.addEventListener('click', () => {
      openAsiDetail(asi);
    });

    storeList.appendChild(card);
  });
}

function openAsiDetail(asi) {
  if (!asi) return;
  
  try {
    currentDetailAsi = asi;
    const installed = storeInstalled[asi.fileName] === true;

    const iconEl = $('#asi-detail-icon');
    const titleEl = $('#asi-detail-title');
    const iconLargeEl = $('#asi-detail-icon-large');
    const nameEl = $('#asi-detail-name');
    const versionEl = $('#asi-detail-version');
    const descEl = $('#asi-detail-description');
    const fileEl = $('#asi-detail-file');

    if (iconEl) iconEl.textContent = asi.icon || 'extension';
    if (iconLargeEl) iconLargeEl.textContent = asi.icon || 'extension';
    if (titleEl) titleEl.textContent = asi.name;
    if (nameEl) nameEl.textContent = asi.name;
    if (versionEl) versionEl.textContent = asi.version ? `v${asi.version}` : '';
    if (descEl) descEl.textContent = asi.description || 'Описание отсутствует';
    if (fileEl) fileEl.textContent = asi.fileName;

    // Сброс состояния кнопок (на случай если осталось «Загрузка...» от предыдущей установки)
    if (asiDetailInstall) {
      asiDetailInstall.disabled = false;
      asiDetailInstall.innerHTML = '<span class="material-icons-round">download</span> Установить';
    }
    if (asiDetailRemove) {
      asiDetailRemove.disabled = false;
      asiDetailRemove.innerHTML = '<span class="material-icons-round">delete</span> Удалить';
    }
    // Update buttons visibility
    if (installed) {
      if (asiDetailInstall) asiDetailInstall.classList.add('hidden');
      if (asiDetailRemove) asiDetailRemove.classList.remove('hidden');
      if (asiDetailInstalled) asiDetailInstalled.classList.remove('hidden');
    } else {
      if (asiDetailInstall) asiDetailInstall.classList.remove('hidden');
      if (asiDetailRemove) asiDetailRemove.classList.add('hidden');
      if (asiDetailInstalled) asiDetailInstalled.classList.add('hidden');
    }

    if (asiDetailOverlay) asiDetailOverlay.classList.remove('hidden');
    if (storeOverlay) storeOverlay.style.pointerEvents = 'none';
  } catch (e) {
    console.error('[Store] Error opening ASI detail:', e);
  }
}

function closeAsiDetail() {
  try {
    if (asiDetailOverlay) asiDetailOverlay.classList.add('hidden');
    if (storeOverlay) storeOverlay.style.pointerEvents = '';
    currentDetailAsi = null;
  } catch (e) {
    console.error('[Store] Error closing ASI detail:', e);
  }
}

async function downloadStoreAsi(asi) {
  if (!config.gamePath) {
    toast('error', 'Сначала укажите путь к GTA San Andreas');
    return;
  }
  if (!asi.fileId) {
    toast('error', 'Ошибка: плагин не имеет ссылки на скачивание');
    return;
  }
  const detailBtn = asiDetailInstall;
  
  if (detailBtn && !detailBtn.classList.contains('hidden')) {
    detailBtn.disabled = true;
    detailBtn.innerHTML = '<span class="material-icons-round">hourglass_empty</span> Загрузка...';
  }

  try {
    const result = await window.electronAPI.downloadAsi({
      fileId: asi.fileId,
      fileName: asi.fileName,
    });

    if (result.success) {
      toast('success', `${asi.name} установлен`);
      storeInstalled[asi.fileName] = true;
      renderStore();
      
      // Update detail modal if open
      if (currentDetailAsi && currentDetailAsi.id === asi.id) {
        openAsiDetail(asi);
      }
    } else {
      toast('error', result.error || 'Ошибка загрузки');
      if (detailBtn) {
        detailBtn.disabled = false;
        detailBtn.innerHTML = `<span class="material-icons-round">download</span> Установить`;
      }
    }
  } catch (e) {
    toast('error', 'Ошибка загрузки');
    if (detailBtn) {
      detailBtn.disabled = false;
      detailBtn.innerHTML = `<span class="material-icons-round">download</span> Установить`;
    }
  }
}

async function removeStoreAsi(asi) {
  if (!config.gamePath) {
    toast('error', 'Сначала укажите путь к GTA San Andreas');
    return;
  }
  const detailBtn = asiDetailRemove;

  if (detailBtn && !detailBtn.classList.contains('hidden')) {
    detailBtn.disabled = true;
    detailBtn.innerHTML = '<span class="material-icons-round">hourglass_empty</span> Удаление...';
  }

  try {
    const result = await window.electronAPI.removeAsi({ fileName: asi.fileName });
    if (result.success) {
      toast('success', `${asi.name} удалён`);
      storeInstalled[asi.fileName] = false;
      renderStore();
      
      // Update detail modal if open
      if (currentDetailAsi && currentDetailAsi.id === asi.id) {
        openAsiDetail(asi);
      }
    } else {
      toast('error', result.error || 'Ошибка удаления');
      if (detailBtn) {
        detailBtn.disabled = false;
        detailBtn.innerHTML = `<span class="material-icons-round">delete</span> Удалить`;
      }
    }
  } catch (e) {
    toast('error', 'Ошибка удаления');
    if (detailBtn) {
      detailBtn.disabled = false;
      detailBtn.innerHTML = `<span class="material-icons-round">delete</span> Удалить`;
    }
  }
}

// ===== REPLACEMENTS TAB =====
async function fetchReplacementsFromServer(url) {
  try {
    const result = await window.electronAPI.fetchSkinReplacements(url);
    if (result.success && result.replacements) {
      REPLACEMENTS_CATALOG = result.replacements;
      if (selectedSkin !== null) renderReplacementsForSkin(selectedSkin);
      else renderSkinsList();
    }
  } catch (e) {
    console.error('[Replacements] Fetch error:', e);
  }
}

function getSkinsWithReplacements() {
  const bySkin = {};
  REPLACEMENTS_CATALOG.forEach((r) => {
    const skin = (r.baseSkin || '').toUpperCase();
    if (!skin) return;
    if (!bySkin[skin]) bySkin[skin] = [];
    bySkin[skin].push(r);
  });
  return Object.entries(bySkin).map(([name, list]) => ({ name, list }));
}

const LAUNCHER_SKIN_CATEGORIES = {
  KM:    { label: 'КМ', title: 'Кавказская мафия' },
  PM:    { label: 'РМ', title: 'Русская мафия' },
  OTHER: { label: '—',  title: 'Другие' },
};

function renderSkinsList() {
  if (!skinsList) return;
  skinsList.innerHTML = '';

  const skins = getSkinsWithReplacements();
  if (skins.length === 0) {
    skinsList.innerHTML = `
      <div style="padding:20px;text-align:center;color:var(--text-3);font-size:12px;">
        <span class="material-icons-round" style="font-size:32px;opacity:0.3;display:block;margin-bottom:8px;">face</span>
        Нет заменок. Добавьте в asi-admin.
      </div>
    `;
    return;
  }

  // Group by category; anything unknown → OTHER
  const byCategory = {};
  skins.forEach(({ name, list }) => {
    let cat = (list[0]?.category || '').toUpperCase();
    if (!LAUNCHER_SKIN_CATEGORIES[cat]) cat = 'OTHER';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push({ name, list });
  });

  const catOrder = Object.keys(LAUNCHER_SKIN_CATEGORIES).filter(c => byCategory[c]);
  const rest = [];

  [...catOrder, ...rest].forEach(cat => {
    const catInfo = LAUNCHER_SKIN_CATEGORIES[cat];
    const header = document.createElement('div');
    header.className = 'skins-category-header';
    const badgeClass = cat === 'OTHER' ? 'skins-cat-badge--other' : `skins-cat-badge--${cat.toLowerCase()}`;
    header.innerHTML = catInfo
      ? `<span class="skins-cat-badge ${badgeClass}">${catInfo.label}</span><span class="skins-cat-title">${catInfo.title}</span>`
      : `<span class="skins-cat-badge">${cat}</span>`;
    skinsList.appendChild(header);

    byCategory[cat].forEach(({ name, list }) => {
      const item = document.createElement('div');
      item.className = 'skin-item' + (selectedSkin === name ? ' selected' : '');
      item.setAttribute('data-skin', name);
      item.innerHTML = `
        <div class="skin-icon"><span class="material-icons-round">face</span></div>
        <div class="skin-name">${escapeHtml(name)}</div>
        <div class="skin-count">${list.length}</div>
      `;
      item.addEventListener('click', () => selectSkin(name));
      skinsList.appendChild(item);
    });
  });
}

function selectSkin(skinName) {
  selectedSkin = skinName;
  renderSkinsList();

  if (replacementsEmpty) replacementsEmpty.classList.add('hidden');
  if (replacementsSkinName) replacementsSkinName.textContent = skinName;
  if (replacementsBack) replacementsBack.classList.remove('hidden');

  renderReplacementsForSkin(skinName);
}

function escapeHtml(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

async function renderReplacementsForSkin(skinName) {
  if (!replacementsGrid) return;

  const skinData = getSkinsWithReplacements().find((s) => s.name === skinName);
  if (!skinData) {
    replacementsGrid.innerHTML = '';
    return;
  }

  const list = skinData.list;

  // Check installed state
  const fileNames = list.map((r) => r.fileName);
  try {
    const cfg = await window.electronAPI.loadConfig();
    if (cfg.gamePath) {
      for (const r of list) {
        replacementsInstalled[r.id] = await window.electronAPI.checkSkinReplacementInstalled({
          baseSkin: r.baseSkin,
          fileName: r.fileName,
          id: r.id,
        });
      }
    }
  } catch (e) {
    replacementsInstalled = {};
  }

  replacementsGrid.innerHTML = '';

  list.forEach((r) => {
    const installed = replacementsInstalled[r.id] === true;
    const previewUrl = r.previewUrl || '';
    const previewHtml = previewUrl
      ? `<div class="replacement-preview"><img src="${escapeHtml(previewUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><span class="replacement-preview-fallback" style="display:none"><span class="material-icons-round">face</span></span></div>`
      : `<div class="replacement-preview no-image"><span class="material-icons-round">face</span></div>`;
    const isLiked = likedReplacements.has(r.id);
    const likesCount = r.likes || 0;

    const card = document.createElement('div');
    card.className = 'replacement-card';
    card.innerHTML = `
      ${previewHtml}
      <div class="replacement-info">
        <div class="replacement-name">${escapeHtml(r.name)}</div>
        ${r.authorship ? (r.authorshipLink ? `<a class="replacement-author replacement-author-link" href="#" data-href="${escapeHtml(r.authorshipLink)}">${escapeHtml(r.authorship)}</a>` : `<div class="replacement-author">${escapeHtml(r.authorship)}</div>`) : ''}
        <div class="replacement-actions-row">
          ${installed
            ? '<div class="replacement-installed"><span class="material-icons-round">check_circle</span> Установлено</div>'
            : `<button class="btn-replacement-install" data-id="${r.id}"><span class="material-icons-round">download</span> Установить</button>`}
          <button class="btn-like ${isLiked ? 'liked' : ''}" data-id="${r.id}" title="${isLiked ? 'Убрать лайк' : 'Нравится'}">
            <span class="material-icons-round">${isLiked ? 'favorite' : 'favorite_border'}</span>
            <span class="like-count">${likesCount > 0 ? likesCount : ''}</span>
          </button>
        </div>
      </div>
    `;

    if (!installed) {
      const btn = card.querySelector('.btn-replacement-install');
      btn.addEventListener('click', (e) => { e.stopPropagation(); installReplacement(r, card); });
    }

    card.querySelector('.btn-like').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleLike(r.id, card);
    });

    const authorLink = card.querySelector('.replacement-author-link');
    if (authorLink) {
      authorLink.addEventListener('click', (e) => {
        e.preventDefault();
        const url = authorLink.dataset.href;
        if (url) window.electronAPI.openExternal(url);
      });
    }

    replacementsGrid.appendChild(card);
  });
}

async function toggleLike(id, cardEl) {
  const btn = cardEl.querySelector('.btn-like');
  if (!btn || btn.disabled) return;
  btn.disabled = true;

  const wasLiked = likedReplacements.has(id);
  const method = wasLiked ? 'DELETE' : 'POST';

  try {
    const res = await fetch(`${STORE_URL}/api/skin-replacements/${id}/like`, { method });
    if (res.ok) {
      const data = await res.json();
      if (wasLiked) {
        likedReplacements.delete(id);
        btn.classList.remove('liked');
        btn.querySelector('.material-icons-round').textContent = 'favorite_border';
      } else {
        likedReplacements.add(id);
        btn.classList.add('liked');
        btn.querySelector('.material-icons-round').textContent = 'favorite';
        btn.classList.add('like-pop');
        setTimeout(() => btn.classList.remove('like-pop'), 400);
      }
      const countEl = btn.querySelector('.like-count');
      if (countEl) countEl.textContent = data.likes > 0 ? data.likes : '';
      localStorage.setItem('liked-replacements', JSON.stringify([...likedReplacements]));
    }
  } catch (e) {
    console.error('[Like] Error:', e);
  } finally {
    btn.disabled = false;
  }
}

async function installReplacement(r, cardEl) {
  const cfg = await window.electronAPI.loadConfig();
  if (!cfg.gamePath) {
    toast('error', 'Сначала укажите путь к игре');
    return;
  }

  const btn = cardEl.querySelector('.btn-replacement-install');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-icons-round">hourglass_empty</span> Загрузка...';
  }

  try {
    const result = await window.electronAPI.downloadSkinReplacement({
      fileId: r.fileId,
      fileName: r.fileName,
      id: r.id,
      downloadUrl: r.downloadUrl || '',
    });

    if (result.success) {
      toast('success', `${r.name} установлен`);
      replacementsInstalled[r.id] = true;
      if (btn) btn.remove();
      const installedEl = document.createElement('div');
      installedEl.className = 'replacement-installed';
      installedEl.innerHTML = '<span class="material-icons-round">check_circle</span> Установлено';
      cardEl.appendChild(installedEl);
    } else {
      toast('error', result.error || 'Ошибка загрузки');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span class="material-icons-round">download</span> Установить';
      }
    }
  } catch (e) {
    toast('error', 'Ошибка загрузки');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-icons-round">download</span> Установить';
    }
  }
}

function showReplacementsTab() {
  if (tabMain) tabMain.classList.add('hidden');
  if (tabReplacements) tabReplacements.classList.remove('hidden');
  document.querySelectorAll('.content-tab').forEach((b) => b.classList.remove('active'));
  const tabBtn = document.querySelector('.content-tab[data-tab="replacements"]');
  if (tabBtn) tabBtn.classList.add('active');
  renderSkinsList();
  if (selectedSkin) {
    renderReplacementsForSkin(selectedSkin);
    if (replacementsEmpty) replacementsEmpty.classList.add('hidden');
    if (replacementsSkinName) replacementsSkinName.textContent = selectedSkin;
    if (replacementsBack) replacementsBack.classList.remove('hidden');
  } else {
    replacementsGrid.innerHTML = '';
    if (replacementsEmpty) replacementsEmpty.classList.remove('hidden');
    if (replacementsSkinName) replacementsSkinName.textContent = '—';
    if (replacementsBack) replacementsBack.classList.add('hidden');
  }
}

function showMainTab() {
  if (tabReplacements) tabReplacements.classList.add('hidden');
  if (tabMain) tabMain.classList.remove('hidden');
  document.querySelectorAll('.content-tab').forEach((b) => b.classList.remove('active'));
  const tabBtn = document.querySelector('.content-tab[data-tab="main"]');
  if (tabBtn) tabBtn.classList.add('active');
}

function goBackToSkins() {
  selectedSkin = null;
  renderSkinsList();
  replacementsGrid.innerHTML = '';
  if (replacementsEmpty) replacementsEmpty.classList.remove('hidden');
  if (replacementsSkinName) replacementsSkinName.textContent = '—';
  if (replacementsBack) replacementsBack.classList.add('hidden');
}

// ===== EVENTS =====
function setupEvents() {
  try {
    const btnMinimize = $('#btn-minimize');
    const btnClose = $('#btn-close');
    if (btnMinimize) btnMinimize.addEventListener('click', () => window.electronAPI.minimize());
    if (btnClose) btnClose.addEventListener('click', () => window.electronAPI.close());
  } catch (e) {
    console.error('[Events] Titlebar buttons error:', e);
  }

  // Content tabs
  document.querySelectorAll('.content-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === 'replacements') showReplacementsTab();
      else showMainTab();
    });
  });

  // Replacements back button
  if (replacementsBack) {
    replacementsBack.addEventListener('click', goBackToSkins);
  }

  // Nickname
  try {
    if (nickAddBtn) nickAddBtn.addEventListener('click', addNickname);
    if (nickInput) {
      nickInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addNickname();
      });
      nickInput.addEventListener('keypress', (e) => {
        if (!/[a-zA-Z_]/.test(e.key)) e.preventDefault();
      });
    }
  } catch (e) {
    console.error('[Events] Nickname inputs error:', e);
  }

  // Browse
  try {
    if (btnBrowse) {
      btnBrowse.addEventListener('click', async () => {
        const p = await window.electronAPI.selectGamePath();
        if (p) {
          config.gamePath = p;
          updatePath();
          updatePlayButton();
          toast('success', 'Путь сохранён');
        }
      });
    }
  } catch (e) {
    console.error('[Events] Browse button error:', e);
  }

  // ASI toggle
  try {
    if (asiToggle) {
      asiToggle.addEventListener('change', () => {
        config.asiLoader = asiToggle.checked;
        saveConfig();
      });
    }
  } catch (e) {
    console.error('[Events] ASI toggle error:', e);
  }

  // Store
  try {
    if (btnStore) btnStore.addEventListener('click', openStore);
    if (storeClose) storeClose.addEventListener('click', closeStore);
    if (storeOverlay) {
      storeOverlay.addEventListener('click', (e) => {
        if (e.target === storeOverlay) closeStore();
      });
    }
  } catch (e) {
    console.error('[Events] Store buttons error:', e);
  }

  // ASI Detail — прямые обработчики на кнопках (надёжнее при двух overlay)
  try {
    if (asiDetailClose) asiDetailClose.addEventListener('click', closeAsiDetail);
    if (asiDetailInstall) {
      asiDetailInstall.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (asiDetailInstall.classList.contains('hidden') || asiDetailInstall.disabled || !currentDetailAsi) return;
        await downloadStoreAsi(currentDetailAsi);
        openAsiDetail(currentDetailAsi);
      });
    }
    if (asiDetailRemove) {
      asiDetailRemove.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (asiDetailRemove.classList.contains('hidden') || asiDetailRemove.disabled || !currentDetailAsi) return;
        await removeStoreAsi(currentDetailAsi);
        openAsiDetail(currentDetailAsi);
      });
    }
    if (asiDetailOverlay) {
      asiDetailOverlay.addEventListener('click', (e) => {
        if (e.target === asiDetailOverlay) closeAsiDetail();
      });
    }
  } catch (e) {
    console.error('[Events] ASI Detail buttons error:', e);
  }

  // Keyboard shortcuts
  try {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (asiDetailOverlay && !asiDetailOverlay.classList.contains('hidden')) closeAsiDetail();
        else if (storeOverlay && !storeOverlay.classList.contains('hidden')) closeStore();
        if (creditsOverlay && !creditsOverlay.classList.contains('hidden')) closeCredits();
      }
    });
  } catch (e) {
    console.error('[Events] Keyboard shortcuts error:', e);
  }

  // Update banner
  try {
    if (updateDownloadBtn) {
      updateDownloadBtn.addEventListener('click', async () => {
        updateDownloadBtn.disabled = true;
        updateDownloadBtn.classList.add('hidden');
        if (updateProgressWrap) {
          updateProgressWrap.classList.remove('hidden');
          if (updateProgressFill) {
            updateProgressFill.style.width = '0%';
            updateProgressFill.classList.add('indeterminate');
          }
          if (updateProgressText) updateProgressText.textContent = 'Подготовка...';
        }
        await window.electronAPI.updateDownload();
      });
    }
    if (updateRestartBtn) {
      updateRestartBtn.addEventListener('click', () => {
        window.electronAPI.updateApply();
      });
    }
    if (updateDismissBtn) {
      updateDismissBtn.addEventListener('click', () => {
        updateDismissed = true;
        if (updateBanner) updateBanner.classList.add('hidden');
      });
    }
  } catch (e) {
    console.error('[Events] Update buttons error:', e);
  }

  // Credits + manual update check
  try {
    if (btnCredits) {
      btnCredits.addEventListener('click', () => {
        if (creditsOverlay) creditsOverlay.classList.remove('hidden');
      });
    }
    if (creditsCheckUpdate) {
      creditsCheckUpdate.addEventListener('click', async () => {
        creditsCheckUpdate.disabled = true;
        creditsCheckUpdate.innerHTML = '<span class="material-icons-round">hourglass_empty</span> Проверка...';
        try {
          const info = await window.electronAPI.updateCheck();
          if (info) {
            updateDismissed = false;
            if (updateVersion) updateVersion.textContent = info.version;
            if (updateDownloadBtn) {
              updateDownloadBtn.classList.remove('hidden');
              updateDownloadBtn.disabled = false;
              updateDownloadBtn.innerHTML = '<span class="material-icons-round">download</span> Скачать';
            }
            if (updateRestartBtn) updateRestartBtn.classList.add('hidden');
            if (updateProgressWrap) updateProgressWrap.classList.add('hidden');
            if (updateBanner) updateBanner.classList.remove('hidden');
            toast('success', `Доступна версия v${info.version}`);
          } else {
            toast('success', 'Установлена последняя версия');
          }
        } catch (e) {
          toast('error', 'Ошибка проверки: ' + (e.message || 'неизвестно'));
        }
        creditsCheckUpdate.disabled = false;
        creditsCheckUpdate.innerHTML = '<span class="material-icons-round">system_update</span> Проверить обновления';
      });
    }
    if (creditsClose) creditsClose.addEventListener('click', closeCredits);
    if (creditsOverlay) {
      creditsOverlay.addEventListener('click', (e) => {
        if (e.target === creditsOverlay) closeCredits();
      });
    }
  } catch (e) {
    console.error('[Events] Credits buttons error:', e);
  }

  // Play
  try {
    if (btnPlay) {
      btnPlay.addEventListener('click', async () => {
        if (btnPlay.disabled) return;
        const nick = getActiveNickname();
        if (!nick) return;

        btnPlay.disabled = true;
        if (statusText) statusText.textContent = `Запуск Amazing ${selectedServer.name}...`;
        
        // Update Discord status to loading
        try {
          window.electronAPI.updateDiscordStatus('loading', {
            message: 'Запуск игры...',
          });
        } catch (e) {
          console.error('[Events] Discord RPC error:', e);
        }

        try {
          const result = await window.electronAPI.connectToServer({
            ip: selectedServer.ip,
            port: selectedServer.port,
            nickname: nick,
            asiEnabled: config.asiLoader,
            serverName: selectedServer.name,
          });

          if (result.success) {
            toast('success', `${nick} → Amazing ${selectedServer.name}`);
            if (config.asiLoader) {
              if (statusText) statusText.textContent = 'Ожидание gta_sa.exe для подгрузки ASI...';
              try {
                window.electronAPI.updateDiscordStatus('loading', {
                  message: 'Загрузка ASI плагинов...',
                });
              } catch (e) {
                console.error('[Events] Discord RPC error:', e);
              }
            } else {
              if (statusText) statusText.textContent = `Запущено: Amazing ${selectedServer.name}`;
            }
          } else {
            toast('error', result.error || 'Ошибка');
            if (statusText) statusText.textContent = 'Ошибка';
            // Revert Discord status
            try {
              window.electronAPI.updateDiscordStatus('server_selected', {
                serverName: selectedServer.name,
                nickname: nick,
              });
            } catch (e) {
              console.error('[Events] Discord RPC error:', e);
            }
          }
        } catch (err) {
          console.error('[Events] Connect error:', err);
          toast('error', 'Не удалось запустить');
          if (statusText) statusText.textContent = 'Ошибка запуска';
          // Revert Discord status
          try {
            window.electronAPI.updateDiscordStatus('server_selected', {
              serverName: selectedServer.name,
              nickname: nick,
            });
          } catch (e) {
            console.error('[Events] Discord RPC error:', e);
          }
        }
        setTimeout(() => updatePlayButton(), 2000);
      });
    }
  } catch (e) {
    console.error('[Events] Play button setup error:', e);
  }
}

// ===== CONFIG =====
function saveConfig() {
  window.electronAPI.saveConfig({
    serverNicks: config.serverNicks,
    gamePath: config.gamePath,
    asiLoader: config.asiLoader,
  });
}

// ===== TOAST =====
function toast(type, msg) {
  const icons = { success: 'check_circle', error: 'error' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="material-icons-round">${icons[type]}</span><span>${msg}</span>`;
  toastContainer.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  }, 2500);
}

// ===== START =====
document.addEventListener('DOMContentLoaded', init);
