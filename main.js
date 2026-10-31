const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const DIR_FILE = () => path.join(app.getPath('userData'), 'server-dir.txt');
function loadDir() {
  if (process.env.ENSHROUDED_DIR) return process.env.ENSHROUDED_DIR;
  try { return fs.readFileSync(DIR_FILE(), 'utf8').trim(); } catch { return 'F:/enshrouded_server'; }
}
let SERVER_DIR = 'F:/enshrouded_server';
const EXE = () => path.join(SERVER_DIR, 'enshrouded_server.exe');
const CFG = () => path.join(SERVER_DIR, 'enshrouded_server.json');

let win, proc = null, state = 'stopped';
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
  if (proc) return;
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
ipcMain.handle('choose-dir', async () => {
  if (proc) return { ok: false };
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '選擇 enshrouded_server 資料夾' });
  if (r.canceled) return { ok: false };
  if (!fs.existsSync(path.join(r.filePaths[0], 'enshrouded_server.exe'))) return { ok: false, error: '該資料夾內沒有 enshrouded_server.exe' };
  SERVER_DIR = r.filePaths[0];
  fs.writeFileSync(DIR_FILE(), SERVER_DIR);
  return { ok: true, dir: SERVER_DIR };
});
ipcMain.on('start', start);
ipcMain.on('stop', stop);
ipcMain.handle('get-state', () => ({ state, players: [...players.values()] }));

app.whenReady().then(() => {
  SERVER_DIR = loadDir();
  createWindow();
  if (process.argv.includes('--autostart')) win.webContents.once('did-finish-load', start);
});
app.on('before-quit', e => { if (proc) { e.preventDefault(); stop(); proc.once('exit', () => app.quit()); } });
app.on('window-all-closed', () => app.quit());
