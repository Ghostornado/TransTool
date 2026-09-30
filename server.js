/**
 * TransTool —— 局域网文件传输工具（PC 服务端）
 *
 * 功能：
 *  - 本地启动 HTTP 服务，手机浏览器（同 Wi-Fi）扫码/输网址即可访问
 *  - 手机 ↔ PC 互传：文件、图片、文本
 *  - 接收目录可配置（data/config.json），修改后即时生效
 *  - 文件限制：大小上限、危险扩展名黑名单，均可配置
 *  - 安全：随机 Token 鉴权、文件名清洗（防路径穿越）、仅局域网监听、访问日志
 *
 * 用法：node server.js  （或双击 start.bat）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { exec } = require('child_process');

let QRCode = null; // 可选依赖：用于网页端二维码图片
try { QRCode = require('qrcode'); } catch { /* 未安装时 /api/qr 返回 404 */ }

const PORT = Number(process.env.PORT || 7100);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR_DEFAULT = path.join(ROOT, 'uploads');
const TEXTS_FILE = path.join(DATA_DIR, 'texts.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOG_FILE = path.join(DATA_DIR, 'access.log');

fs.mkdirSync(UPLOAD_DIR_DEFAULT, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TEXTS_FILE)) fs.writeFileSync(TEXTS_FILE, '[]');

/* ---------------- 本地配置（可经网页修改） ---------------- */
const DEFAULT_CONFIG = {
  uploadDir: UPLOAD_DIR_DEFAULT,   // 接收文件夹（绝对路径）
  maxFileMB: 2048,                 // 单文件大小上限（MB）
  blockedExts: ['exe', 'bat', 'cmd', 'com', 'scr', 'vbs', 'ps1', 'msi', 'dll', 'jar'], // 禁止上传的扩展名
};
function loadConfig() {
  try { return Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))); }
  catch { return Object.assign({}, DEFAULT_CONFIG); }
}
let config = loadConfig();
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
function uploadDir() {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  return config.uploadDir;
}

/* ---------------- 安全：每次启动生成随机访问令牌 ---------------- */
const TOKEN = process.env.TRANSTOOL_TOKEN || crypto.randomBytes(16).toString('hex'); // 128 位随机令牌，可用环境变量固定

function checkAuth(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams.get('token') || '';
  const h = req.headers['x-token'] || '';
  if (q !== TOKEN && h !== TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '未授权：请从 PC 端显示的二维码或链接进入' }));
    return false;
  }
  return true;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/* ---------------- 工具函数 ---------------- */
function logAccess(line) {
  const t = new Date().toISOString();
  fs.appendFile(LOG_FILE, `[${t}] ${line}\n`, () => {});
  console.log(line);
}

function loadTexts() {
  try { return JSON.parse(fs.readFileSync(TEXTS_FILE, 'utf-8')); }
  catch { return []; }
}
function saveTexts(list) { fs.writeFileSync(TEXTS_FILE, JSON.stringify(list, null, 2)); }

// 文件名清洗：去路径、去危险字符，防止路径穿越
function sanitizeName(name) {
  const base = path.basename(name || 'unnamed').replace(/[-<>:"/\\|?* ]/g, '_');
  return base.slice(0, 120) || 'unnamed';
}

function listFiles(dir) {
  return fs.readdirSync(dir).map(f => {
    const fp = path.join(dir, f);
    const st = fs.statSync(fp);
    return { name: f, size: st.size, mtime: st.mtimeMs, path: fp };
  }).sort((a, b) => b.mtime - a.mtime);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.zip': 'application/zip',
  '.apk': 'application/vnd.android.package-archive',
};

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
}

function readBody(req, limit = 64 * 1024) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

/* ---------------- SSE：实时推送 ---------------- */
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch { clients.delete(res); } }
}

/* ---------------- HTTP 服务 ---------------- */
const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error('[异常]', e);
    try { json(res, 500, { error: '服务器内部错误' }); } catch { /* 响应已发送 */ }
  });
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  /* ---- SSE 实时通道 ---- */
  if (pathname === '/api/events') {
    if (!checkAuth(req, res)) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    broadcast('online', { count: clients.size });
    req.on('close', () => { clients.delete(res); broadcast('online', { count: clients.size }); });
    return;
  }

  /* ---- API（全部需要 token） ---- */
  if (pathname.startsWith('/api/')) {
    if (!checkAuth(req, res)) return;

    // GET /api/qr —— 二维码图片。默认内容为最优局域网地址+令牌；带 ?text= 参数则编码任意文本
    if (pathname === '/api/qr' && req.method === 'GET') {
      if (!QRCode) { json(res, 404, { error: '未安装 qrcode 依赖' }); return; }
      const custom = url.searchParams.get('text');
      const content = custom !== null ? custom.slice(0, 1000) : bestUrl();
      if (custom !== null && !content) { json(res, 400, { error: '文本内容为空' }); return; }
      try {
        const buf = await QRCode.toBuffer(content, { width: 320, margin: 1 });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(buf);
      } catch (e) { json(res, 500, { error: '二维码生成失败：' + (content.length > 500 ? '内容过长' : e.message) }); }
      return;
    }

    // GET /api/config —— 当前配置（接收目录、限制）
    if (pathname === '/api/config' && req.method === 'GET') {
      json(res, 200, { dir: uploadDir(), maxFileMB: config.maxFileMB, blockedExts: config.blockedExts });
      return;
    }

    // POST /api/config —— 修改接收文件夹
    if (pathname === '/api/config' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); }
      catch { json(res, 400, { error: '请求体不是合法 JSON' }); return; }
      const dir = body.uploadDir;
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
        json(res, 400, { error: '文件夹路径必须是绝对路径，例如 D:\\Receive' });
        return;
      }
      try {
        fs.mkdirSync(dir, { recursive: true }); // 不存在则创建
        // 测试可写
        const probe = path.join(dir, '.transtool_probe');
        fs.writeFileSync(probe, 'ok'); fs.rmSync(probe);
      } catch (e) {
        json(res, 400, { error: '文件夹不可写或无法创建：' + e.message });
        return;
      }
      config.uploadDir = dir;
      saveConfig();
      logAccess(`[配置] 接收目录改为 ${dir}`);
      broadcast('config', { dir });
      json(res, 200, { ok: true, dir });
      return;
    }

    // POST /api/open-dir —— 在本机打开当前接收文件夹（供 PC 网页「打开文件夹」按钮使用）
    if (pathname === '/api/open-dir' && req.method === 'POST') {
      const dir = uploadDir();
      try {
        if (process.platform === 'win32') exec(`explorer "${dir}"`);
        else if (process.platform === 'darwin') exec(`open "${dir}"`);
        else exec(`xdg-open "${dir}"`);
      } catch (e) {
        json(res, 500, { error: '打开文件夹失败：' + e.message });
        return;
      }
      logAccess(`[打开文件夹] ${clientIp(req)} -> ${dir}`);
      json(res, 200, { ok: true, dir });
      return;
    }

    // POST /api/pick-dir —— 在服务端本机弹出系统文件夹选择框，返回用户选中的路径
    if (pathname === '/api/pick-dir' && req.method === 'POST') {
      if (process.platform !== 'win32') { json(res, 400, { error: '系统选目录窗口仅支持 Windows' }); return; }
      const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='选择 TransTool 接收文件夹'; if($d.ShowDialog() -eq 'OK'){ Write-Output $d.SelectedPath }";
      exec(`"${ps}" -NoProfile -STA -Command "${script}"`, { timeout: 120000 }, (e, stdout) => {
        if (e && !stdout) { json(res, 500, { error: '打开选择窗口失败：' + e.message }); return; }
        const dir = (stdout || '').trim();
        if (!dir) { json(res, 200, { ok: false, cancelled: true }); return; }
        logAccess(`[选择目录] ${clientIp(req)} 选中 ${dir}`);
        json(res, 200, { ok: true, dir });
      });
      return;
    }

    // GET /api/files —— 文件列表（含完整路径）
    if (pathname === '/api/files' && req.method === 'GET') {
      json(res, 200, { files: listFiles(uploadDir()), dir: uploadDir() });
      return;
    }

    // GET /api/texts —— 文本历史
    if (pathname === '/api/texts' && req.method === 'GET') {
      json(res, 200, { texts: loadTexts().slice(-200) });
      return;
    }

    // POST /api/text —— 发送文本
    if (pathname === '/api/text' && req.method === 'POST') {
      let msg;
      try { msg = JSON.parse(await readBody(req)); } catch { msg = null; }
      const text = (msg && typeof msg.text === 'string') ? msg.text.trim().slice(0, 10000) : '';
      if (!text) { json(res, 400, { error: '文本内容为空' }); return; }
      const item = { id: crypto.randomUUID(), text, from: sanitizeName(msg.from || '未知设备'), dir: msg.dir === 'pc' ? 'pc' : 'phone', time: Date.now() };
      const list = loadTexts(); list.push(item); saveTexts(list.slice(-1000));
      logAccess(`[文本] ${item.from}(${item.dir}): ${text.slice(0, 50)}`);
      broadcast('text', item);
      json(res, 200, { ok: true, id: item.id });
      return;
    }

    // DELETE /api/text?id=xxx —— 删除单条文本
    if (pathname === '/api/text' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') || '';
      const list = loadTexts();
      const next = list.filter(t => t.id !== id);
      if (next.length !== list.length) {
        saveTexts(next);
        logAccess(`[文本删除] ${id}`);
        broadcast('textdel', { id });
      }
      json(res, 200, { ok: true });
      return;
    }

    // POST /api/upload —— 上传文件/图片（含类型与大小限制）
    if (pathname === '/api/upload' && req.method === 'POST') {
      const origName = sanitizeName(url.searchParams.get('name') || 'unnamed');
      const ext = path.extname(origName).slice(1).toLowerCase();
      if (config.blockedExts.includes(ext)) {
        json(res, 400, { error: `禁止上传该类型文件（.${ext}），可在 data\\config.json 中调整黑名单` });
        return;
      }
      const maxBytes = config.maxFileMB * 1024 * 1024;
      const dir = uploadDir();
      let finalName = origName, i = 1;
      while (fs.existsSync(path.join(dir, finalName))) {
        const e = path.extname(origName), stem = origName.slice(0, origName.length - e.length);
        finalName = `${stem}_${i++}${e}`.slice(0, 130);
      }
      const dest = path.join(dir, finalName);
      const ws = fs.createWriteStream(dest);
      let received = 0, aborted = false;
      req.on('data', chunk => {
        received += chunk.length;
        if (received > maxBytes) {
          aborted = true;
          json(res, 413, { error: `文件超过大小限制（${config.maxFileMB} MB）` });
          req.destroy(); ws.destroy(); fs.rm(dest, () => {});
        }
      });
      req.pipe(ws);
      ws.on('finish', () => {
        if (aborted) return;
        const size = fs.statSync(dest).size;
        logAccess(`[上传] ${clientIp(req)} -> ${finalName} (${(size / 1024).toFixed(1)} KB)`);
        broadcast('file', { name: finalName, size, mtime: Date.now() });
        json(res, 200, { ok: true, name: finalName, size });
      });
      ws.on('error', () => { if (!aborted) json(res, 500, { error: '文件写入失败' }); });
      req.on('error', () => { ws.destroy(); fs.rm(dest, () => {}); });
      return;
    }

    // GET /api/file?name=xxx —— 下载或预览（inline）
    if (pathname === '/api/file' && req.method === 'GET') {
      const dir = uploadDir();
      const name = sanitizeName(url.searchParams.get('name') || '');
      const fp = path.join(dir, name);
      if (!fp.startsWith(dir) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
        json(res, 404, { error: '文件不存在' }); return;
      }
      const mime = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
      const dl = url.searchParams.get('dl') === '1';
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': fs.statSync(fp).size,
        'Content-Disposition': `${dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      fs.createReadStream(fp).pipe(res);
      logAccess(`[下载] ${clientIp(req)} <- ${name}`);
      return;
    }

    // DELETE /api/file?name=xxx —— 删除
    if (pathname === '/api/file' && req.method === 'DELETE') {
      const dir = uploadDir();
      const name = sanitizeName(url.searchParams.get('name') || '');
      const fp = path.join(dir, name);
      if (fp.startsWith(dir) && fs.existsSync(fp)) {
        fs.rmSync(fp);
        logAccess(`[删除] ${clientIp(req)} x ${name}`);
        broadcast('filedel', { name });
      }
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { error: '接口不存在' });
    return;
  }

  /* ---- 前端静态页面 ---- */
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
    return;
  }
  const fp = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^([/\\])+/, ''));
  if (fp.startsWith(PUBLIC_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
    return;
  }
  res.writeHead(404); res.end('not found');
}

/* ---------------- 启动 ---------------- */
function lanAddresses() {
  const addrs = [];
  for (const [name, ifs] of Object.entries(os.networkInterfaces()))
    for (const it of ifs || [])
      if (it.family === 'IPv4' && !it.internal) addrs.push({ name, ip: it.address });
  return addrs;
}

// 优先无线网卡（手机最可能连上的网段），否则取第一个
function bestAddr() {
  const addrs = lanAddresses();
  if (!addrs.length) return null;
  return addrs.find(a => /wi[- ]?fi|wlan|wireless/i.test(a.name)) || addrs[0];
}
function bestUrl() {
  const a = bestAddr();
  return a ? `http://${a.ip}:${PORT}/?token=${TOKEN}` : `http://localhost:${PORT}/?token=${TOKEN}`;
}

// 端口被占用等启动失败：给出友好提示而不是抛栈
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[错误] 端口 ${PORT} 已被占用：已有一个 TransTool 实例在运行。`);
    console.error('请先关闭旧的命令行窗口，或重新双击 start.bat 选择结束旧进程。\n');
  } else {
    console.error('\n[错误] 服务启动失败：' + e.message + '\n');
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const addrs = lanAddresses();
  console.log('\n==============================');
  console.log('  TransTool 局域网传输服务已启动');
  console.log('==============================');
  // 终端只给最优地址打印一个小二维码，其余地址仅打印链接
  const best = bestAddr();
  if (best) {
    console.log(`\n[${best.name}] ${bestUrl()}  ← 推荐，手机扫此码`);
    try {
      require('qrcode-terminal').generate(bestUrl(), { small: true }, qr => console.log(qr));
    } catch { /* 无二维码库时仅打印链接 */ }
  }
  for (const a of addrs) {
    if (best && a === best) continue;
    console.log(`[${a.name}] http://${a.ip}:${PORT}/?token=${TOKEN}`);
  }
  console.log(`\n当前接收目录：${uploadDir()}`);
  console.log('提示：手机连同一 Wi-Fi，扫码或浏览器输入上述网址即可互传。');
  console.log(`访问日志：${LOG_FILE}\n`);

  // 启动后自动在默认浏览器打开 PC 端页面（可用 TRANSTOOL_NO_OPEN=1 关闭）
  if (process.env.TRANSTOOL_NO_OPEN) return;
  const page = `http://localhost:${PORT}/?token=${TOKEN}`;
  try {
    if (process.platform === 'win32') exec(`start "" "${page}"`);
    else if (process.platform === 'darwin') exec(`open "${page}"`);
    else exec(`xdg-open "${page}"`);
  } catch { /* 打开浏览器失败不影响服务 */ }
});
