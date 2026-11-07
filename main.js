const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const DIR_FILE = () => path.join(app.getPath('userData'), 'server-dir.txt');
const PATHS_FILE = () => path.join(app.getPath('userData'), 'paths.json');
function loadPaths() { try { return JSON.parse(fs.readFileSync(PATHS_FILE(), 'utf8')); } catch { return {}; } }
function savePaths() { fs.writeFileSync(PATHS_FILE(), JSON.stringify({ server: SERVER_DIR, steamcmd: STEAMCMD_DIR })); }
function loadDir() {
  if (process.env.ENSHROUDED_DIR) return process.env.ENSHROUDED_DIR;
  if (loadPaths().server) return loadPaths().server;
  try { return fs.readFileSync(DIR_FILE(), 'utf8').trim(); } catch { return 'F:/enshrouded_server'; }
}
let SERVER_DIR = 'F:/enshrouded_server', STEAMCMD_DIR = '';
const APP_ID = '2278520'; // Enshrouded Dedicated Server
const EXE = () => path.join(SERVER_DIR, 'enshrouded_server.exe');
const CFG = () => path.join(SERVER_DIR, 'enshrouded_server.json');

let win, proc = null, state = 'stopped', installing = null;
let players = new Map(); // index -> name
let pendingIdx = null;

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }
function setState(s) { state = s; send('state', s); }
function pushPlayers() { send('players', [...players.values()]); }

function handleLine(line) {
  send('log', line);
  let m;
  if (/Switching state from LoadEcsScene to Run/.test(line)) { setState('running'); }
  else if (/Internal Error|Invalid Server Configuration/.test(line)) send('error', line);
  else if ((m = line.match(/Player '(\d+)\(\d+\)' logged in/))) pendingIdx = m[1];
  else if ((m = line.match(/Player '(.+)' logged in with Permissions/)) && pendingIdx !== null) {
    players.set(pendingIdx, m[1]); pendingIdx = null; pushPlayers();
  } else if ((m = line.match(/Player removed\. Player handle: (\d+)\(/))) {
    players.delete(m[1]); pushPlayers();
  }
}

function start() {
  if (proc || installing) return;
  if (!fs.existsSync(EXE())) return send('error', '找不到 ' + EXE() + '(請到「伺服器設定」選擇資料夾)');
  players.clear(); pushPlayers(); setState('starting');
  proc = spawn(EXE(), [], { cwd: SERVER_DIR, windowsHide: true });
  let buf = '';
  const onData = d => {
    buf += d.toString('utf8');
    const lines = buf.split(/\r?\n/); buf = lines.pop();
    lines.forEach(l => l.trim() && handleLine(l));
  };
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);
  proc.on('exit', () => { proc = null; players.clear(); pushPlayers(); setState('stopped'); });
}

function stop() {
  if (!proc) return;
  setState('stopping');
  const pid = proc.pid;
  // 一般 taskkill 對它無效;送 Ctrl+Break 才會觸發正常關閉並存檔(已實測)
  execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'ctrlc.ps1').replace('app.asar', 'app.asar.unpacked'), '-ProcId', String(pid)], { windowsHide: true }, () => {});
  setTimeout(() => {
    if (proc) execFile('taskkill', ['/PID', String(pid), '/F'], () => {});
  }, 30000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 980, height: 760, minWidth: 760, minHeight: 560, icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.setMenuBarVisibility(false);
  // 伺服器執行中或正在安裝時,關視窗會連帶中斷,先確認以防手滑
  win.on('close', e => {
    if (!proc && !installing) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['取消', '關閉'], defaultId: 0, cancelId: 0, title: '確認關閉',
      message: proc ? '伺服器還在執行,關閉視窗會一併關閉伺服器(會先存檔)。確定要關閉嗎?' : '正在安裝或更新,關閉視窗會中斷。確定要關閉嗎?'
    });
    if (r === 0) e.preventDefault();
  });
  win.loadFile('index.html');
}

const ND = 1e9 * 60; // 奈秒/分
function validate(c) {
  const errs = [];
  if (!c.name || !String(c.name).trim()) errs.push('伺服器名稱不能空白');
  if (!(c.slotCount >= 1 && c.slotCount <= 16)) errs.push('人數必須是 1~16');
  // 以下兩條是伺服器啟動時實際會報錯的規則(Internal Error 輸出)
  const groups = c.userGroups || [];
  if (!groups.length) errs.push('至少要有一個身分組');
  const names = groups.map(g => String(g.name || '').trim());
  if (names.some(n => !n)) errs.push('身分組名稱不能空白');
  if (new Set(names).size !== names.length) errs.push('身分組名稱不能重複');
  const filled = groups.map(g => g.password || '').filter(Boolean);
  if (new Set(filled).size !== filled.length) errs.push('各群組的密碼不能重複');
  if (groups.length - filled.length > 1) errs.push('最多只能有一個群組不設密碼');
  if ((c.bannedAccounts || []).some(b => !String(b.accountIDHash || '').trim())) errs.push('黑名單項目的帳號雜湊不能空白');
  for (const [k, v] of Object.entries(c.gameSettings || {}))
    if (typeof v === 'number' && !(v >= 0)) errs.push(k + ' 不能是負數');
  return errs;
}
const PERMS = ['canKickBan', 'canAccessInventories', 'canEditWorld', 'canEditBase', 'canExtendBase'];
// 「沒密碼的群組權限不能比有密碼的高」:精確比較方式未知,所以只警告、不擋存檔
function warnings(c) {
  const groups = c.userGroups || [];
  const open = groups.find(g => !g.password);
  if (!open) return [];
  const w = [];
  for (const g of groups.filter(x => x.password)) {
    const extra = PERMS.filter(p => open[p] && !g[p]);
    if (extra.length) w.push('「' + open.name + '」沒有密碼,但權限比有密碼的「' + g.name + '」多,伺服器可能拒絕啟動');
  }
  return w;
}
let loadedMtime = 0; // 載入時檔案的修改時間,存檔前比對以偵測外部修改
const mtimeOf = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
ipcMain.handle('get-config', () => {
  try {
    const config = JSON.parse(fs.readFileSync(CFG(), 'utf8').replace(/^﻿/, ''));
    loadedMtime = mtimeOf(CFG());
    return { ok: true, dir: SERVER_DIR, config, running: !!proc };
  } catch (e) { return { ok: false, dir: SERVER_DIR, error: '讀取設定檔失敗:' + e.message }; }
});
function backup(file) {
  const dir = path.join(SERVER_DIR, 'config-backups');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  fs.copyFileSync(file, path.join(dir, 'enshrouded_server-' + ts + '.json'));
  fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse().slice(20)
    .forEach(f => fs.unlinkSync(path.join(dir, f)));
}
ipcMain.handle('save-config', (_e, { config: c, force }) => {
  if (proc) return { ok: false, errors: ['伺服器執行中不能存設定(關閉時會被覆蓋),請先關閉伺服器'] };
  const errs = validate(c);
  if (errs.length) return { ok: false, errors: errs };
  const file = CFG(), tmp = file + '.tmp';
  if (!force && mtimeOf(file) !== loadedMtime) return { ok: false, conflict: true };
  try {
    if (fs.existsSync(file)) backup(file);
    fs.writeFileSync(tmp, JSON.stringify(c, null, '	'), { encoding: 'utf8' }); // UTF-8 無 BOM
    JSON.parse(fs.readFileSync(tmp, 'utf8')); // 重新解析驗證
    fs.renameSync(tmp, file); // 先寫暫存檔再改名,原檔不會寫到一半
    loadedMtime = mtimeOf(file);
    return { ok: true, warnings: warnings(c) };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, errors: ['儲存失敗,原設定檔未變動:' + e.message] };
  }
});
ipcMain.handle('get-paths', () => ({ server: SERVER_DIR, steamcmd: STEAMCMD_DIR, installed: fs.existsSync(EXE()), installing: !!installing }));
async function pick(title) {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title });
  return r.canceled ? null : r.filePaths[0];
}
ipcMain.handle('choose-dir', async () => {
  if (proc || installing) return { ok: false };
  const d = await pick('選擇遊戲伺服器要放的資料夾');
  if (!d) return { ok: false };
  SERVER_DIR = d; savePaths();
  return { ok: true };
});
ipcMain.handle('choose-steamcmd', async () => {
  if (installing) return { ok: false };
  const d = await pick('選擇 SteamCMD 所在的資料夾');
  if (!d) return { ok: false };
  if (!fs.existsSync(path.join(d, 'steamcmd.exe'))) return { ok: false, error: '該資料夾內沒有 steamcmd.exe' };
  STEAMCMD_DIR = d; savePaths();
  return { ok: true };
});
// 安裝與更新用同一條指令:app_update 會補齊缺的檔案、更新到最新版,不動存檔與設定檔
ipcMain.handle('install-server', () => {
  if (proc || installing) return { ok: false, error: '伺服器執行中或正在安裝' };
  const exe = path.join(STEAMCMD_DIR, 'steamcmd.exe');
  if (!STEAMCMD_DIR || !fs.existsSync(exe)) return { ok: false, error: '請先選擇 SteamCMD 資料夾' };
  fs.mkdirSync(SERVER_DIR, { recursive: true });
  installing = spawn(exe, ['+force_install_dir', SERVER_DIR, '+login', 'anonymous', '+app_update', APP_ID, 'validate', '+quit'], { cwd: STEAMCMD_DIR, windowsHide: true });
  send('installing', true);
  const onData = d => d.toString('utf8').split(/[\r\n]+/).filter(l => l.trim()).forEach(l => send('log', l));
  installing.stdout.on('data', onData); installing.stderr.on('data', onData);
  installing.on('error', e => { send('log', '無法執行 SteamCMD:' + e.message); });
  installing.on('exit', code => { installing = null; send('log', 'SteamCMD 結束,代碼 ' + code + (code === 0 ? '(完成)' : '(失敗;第一次執行常會先自我更新,可再按一次)')); send('installing', false); });
  return { ok: true };
});

// ---------- 地圖備份 ----------
const SAVE = () => path.join(SERVER_DIR, 'savegame');
const BAK = () => path.join(SERVER_DIR, 'world-backups');
const bakPath = n => path.join(BAK(), path.basename(n)); // basename 防止路徑跳脫
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); };
function dirSize(d) { return fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0); }
const busy = () => proc || installing ? { ok: false, error: '伺服器執行中或正在安裝,請先關閉' } : null;
ipcMain.handle('backup-list', () => {
  try {
    return { ok: true, items: fs.readdirSync(BAK(), { withFileTypes: true }).filter(e => e.isDirectory())
      .map(e => { const p = path.join(BAK(), e.name); return { name: e.name, time: fs.statSync(p).mtimeMs, size: dirSize(p) }; })
      .sort((a, b) => b.time - a.time) };
  } catch { return { ok: true, items: [] }; }
});
ipcMain.handle('backup-create', () => {
  if (busy()) return busy();
  if (!fs.existsSync(SAVE())) return { ok: false, error: '找不到存檔資料夾:' + SAVE() };
  try { fs.cpSync(SAVE(), path.join(BAK(), stamp()), { recursive: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: '備份失敗:' + e.message }; }
});
ipcMain.handle('backup-restore', (_e, name) => {
  if (busy()) return busy();
  const src = bakPath(name);
  if (!fs.existsSync(src)) return { ok: false, error: '找不到這份備份' };
  try {
    if (fs.existsSync(SAVE())) fs.cpSync(SAVE(), path.join(BAK(), stamp() + '-還原前自動備份'), { recursive: true }); // 還原會蓋掉現有存檔,先留一份
    fs.rmSync(SAVE(), { recursive: true, force: true });
    fs.cpSync(src, SAVE(), { recursive: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: '還原失敗:' + e.message }; }
});
ipcMain.handle('backup-delete', (_e, name) => {
  try { fs.rmSync(bakPath(name), { recursive: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: '刪除失敗:' + e.message }; }
});
// ---------- 連線資訊與防火牆 ----------
const RULE = 'Enshrouded Server Tool';
function queryPort() {
  try { return JSON.parse(fs.readFileSync(CFG(), 'utf8').replace(/^﻿/, '')).queryPort || 15637; } catch { return 15637; }
}
// 已放行 = 有本工具建的規則、針對 enshrouded_server.exe 的入站規則,或放行這個連接埠的入站 UDP 規則(最後一項很慢,放最後)
const fwOpen = port => new Promise(res => execFile('powershell', ['-NoProfile', '-Command',
  `$p='${port}'; if(Get-NetFirewallRule -DisplayName '${RULE}' -ErrorAction SilentlyContinue){1;exit}; $r=Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow; $ok=$r|%{$_.Name}; if(@(Get-NetFirewallApplicationFilter -All|?{$_.Program -like '*enshrouded_server.exe' -and $ok -contains $_.InstanceID}).Count){1;exit}; @($r|Get-NetFirewallPortFilter|?{$_.Protocol -in 'UDP','Any' -and $_.LocalPort -contains $p}).Count`],
  { windowsHide: true }, (e, out) => res(!e && +out.trim() > 0)));
// 遊戲內「搜尋 IPv4」可用的位址:本機、區網、Radmin 等虛擬網路(公網 IP 實測搜不到,所以不列)
ipcMain.handle('get-net', () => {
  const port = queryPort(), list = [{ label: '本機', addr: '127.0.0.1:' + port }];
  for (const [name, ifs] of Object.entries(require('os').networkInterfaces()))
    for (const i of ifs) if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
      list.push({ label: /radmin/i.test(name) ? 'Radmin VPN' : /tailscale/i.test(name) ? 'Tailscale' : '區網', addr: i.address + ':' + port });
  return list;
});
ipcMain.handle('check-firewall', () => fwOpen(queryPort()));
// 建立規則需要系統管理員權限,會跳出 UAC 視窗
ipcMain.handle('add-firewall', async () => {
  const port = queryPort();
  const inner = `New-NetFirewallRule -DisplayName '${RULE}' -Direction Inbound -Protocol UDP -LocalPort ${port} -Action Allow`;
  const enc = Buffer.from(inner, 'utf16le').toString('base64');
  await new Promise(res => execFile('powershell', ['-NoProfile', '-Command',
    `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${enc}'`], { windowsHide: true }, () => res()));
  return { ok: await fwOpen(port) };
});

ipcMain.on('start', start);
ipcMain.on('stop', stop);
ipcMain.handle('get-state', () => ({ state, players: [...players.values()] }));

app.whenReady().then(() => {
  SERVER_DIR = loadDir(); STEAMCMD_DIR = loadPaths().steamcmd || '';
  createWindow();
  if (process.argv.includes('--autostart')) win.webContents.once('did-finish-load', start);
});
app.on('before-quit', () => { if (installing) installing.kill(); });
app.on('before-quit', e => { if (proc) { e.preventDefault(); stop(); proc.once('exit', () => app.quit()); } });
app.on('window-all-closed', () => app.quit());
