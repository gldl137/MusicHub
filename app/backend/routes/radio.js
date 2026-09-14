'use strict';

/**
 * 电台封面（台标）的存储与读取路由。
 *
 * 设计要点（与「通用插件管理」解耦，且不再依赖插件名）：
 *   - 功能只服务于电台，因此路由挂在 /api/radio/* 下，而非 /api/plugins/*。
 *   - 封面图片存进与插件名无关的通用缓存目录：<CACHE_DIR>/radio-covers/
 *     （即容器内 /app/data/cache/radio-covers，随持久化缓存卷保存）。
 *   - 新产生的封面统一转换为 WebP 格式（<电台名>.webp）；历史迁移文件保留原格式仍可读取。
 *   - 文件名（去扩展名）等于电台 name，按电台名自动匹配。
 *   - 读取：GET  /api/radio/cover?name=<电台名>  -> 命中则返回图片，未命中 404。
 *   - 导入：POST /api/radio/cover（需管理员）      -> 表单字段 name + file，转 WebP 后存入。
 *   - 前端电台页负责展示与上传 UI，后端只提供存储与读取。
 */

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const ctx = require('../lib/context');
const { adminMiddleware } = require('../lib/middleware');

// 封面目录：放在与插件名无关的缓存目录下（app/data/cache/radio-covers）。
let sharp = null;
try {
  // eslint-disable-next-line global-require
  sharp = require('sharp');
} catch { /* sharp 不可用时降级为原图直存 */ }
const RADIO_COVER_DIR = path.join(ctx.CACHE_DIR, 'radio-covers');

/** 图片 Buffer 统一转 WebP（保持原尺寸，quality 80）；不可用/失败返回 null（由调用方决定降级直存） */
function toWebpBuffer(buf) {
  if (!sharp || !buf || !buf.length) return null;
  try {
    return sharp(buf).webp({ quality: 80, lossless: false }).toBuffer();
  } catch { /* 单次转换失败降级 */ }
  return null;
}

// 启动迁移 1：旧版本封面曾存于 <PLUGINS_DIR>/电台/covers/（与插件名耦合）。
// 若电台插件目录/文件名改名，旧目录里的封面会找不到。这里在启动时把旧封面迁移到新缓存目录。
function migrateLegacyRadioCovers() {
  try {
    const legacyDir = path.join(ctx.PLUGINS_DIR, '电台', 'covers');
    if (!fs.existsSync(legacyDir)) return;
    if (!fs.existsSync(RADIO_COVER_DIR)) fs.mkdirSync(RADIO_COVER_DIR, { recursive: true });
    for (const f of fs.readdirSync(legacyDir)) {
      const src = path.join(legacyDir, f);
      const dest = path.join(RADIO_COVER_DIR, f);
      if (fs.existsSync(dest)) continue; // 新目录已有同名封面，不覆盖
      try { fs.renameSync(src, dest); } catch (e) { /* 忽略单文件失败 */ }
    }
    // 旧目录已空则清理
    try { if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir); } catch (e) { /* ignore */ }
  } catch (e) { /* 忽略迁移失败，不影响新目录使用 */ }
}

// 启动迁移 2：封面目录从 <DATA_DIR>/radio-covers 迁移到 <CACHE_DIR>/radio-covers。
// 新产生封面一律为 .webp，旧文件原样搬移（读取仍兼容任意扩展名）。
function migrateRadioCoverDirToCache() {
  try {
    const legacyDir = path.join(ctx.DATA_DIR, 'radio-covers');
    if (!fs.existsSync(legacyDir)) return;
    if (!fs.existsSync(RADIO_COVER_DIR)) fs.mkdirSync(RADIO_COVER_DIR, { recursive: true });
    for (const f of fs.readdirSync(legacyDir)) {
      const src = path.join(legacyDir, f);
      const dest = path.join(RADIO_COVER_DIR, f);
      if (fs.existsSync(dest)) continue; // 缓存目录已有同名文件，不覆盖
      try { fs.renameSync(src, dest); } catch (e) { /* 忽略单文件失败 */ }
    }
    try { if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir); } catch (e) { /* ignore */ }
  } catch (e) { /* 忽略迁移失败 */ }
}
migrateLegacyRadioCovers();
migrateRadioCoverDirToCache();

try {
  if (!fs.existsSync(RADIO_COVER_DIR)) fs.mkdirSync(RADIO_COVER_DIR, { recursive: true });
} catch (e) {
  if (ctx.logger && typeof ctx.logger.warn === 'function') {
    ctx.logger.warn('RADIO', 'cover', 'ensure radio cover dir failed', { error: e && e.message });
  }
}

// 封面图片上传（内存接收，限制 8MB；不产生临时目录/文件）
const coverUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// 清洗可用作封面文件名的字符串（保留中文，去除路径/非法字符与控制字符）
function sanitizeCoverName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
}

// 归一化封面匹配键：全角转半角、空白统一为单个半角空格、去除非法文件名字符。
// 这样「看起来相同」的名字（如全角空格 vs 半角空格、全角冒号 vs 半角冒号）也能匹配上。
function normalizeCoverKey(name) {
  let s = String(name || '');
  s = s.replace(/　/g, ' ');                                  // 全角空格（U+3000）转半角
  s = s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); // 全角标点转半角
  s = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '');             // 去除非法文件名字符
  s = s.replace(/\s+/g, ' ');                                  // 多个空白合并为一个半角空格
  return s.trim();
}

// 按电台 name 查找已导入的封面文件（文件名不含扩展名等于归一化后的 name）
// 同时兼容旧版 sanitizeCoverName 命名，避免历史封面失效
function findRadioCoverFile(name) {
  if (!name) return null;
  const keys = new Set([normalizeCoverKey(name), sanitizeCoverName(name)]);
  try {
    const files = fs.readdirSync(RADIO_COVER_DIR);
    for (const f of files) {
      if (keys.has(path.parse(f).name)) return path.join(RADIO_COVER_DIR, f);
    }
  } catch (e) { /* ignore */ }
  return null;
}

// 按电台名直接输出本地封面文件（与网页端 GET /api/radio/cover 同一份文件）；
// 命中返回 true，未命中返回 false（由调用方决定兜底占位图）。
function sendRadioCover(res, name) {
  const file = findRadioCoverFile(name);
  if (!file) return false;
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(file);
  return true;
}

// 把远程图片下载到内存 Buffer（自动跟随最多 5 次重定向，限制体积与超时）
function downloadCoverToBuffer(rawUrl, maxBytes) {
  return new Promise((resolve, reject) => {
    let lib;
    try {
      lib = rawUrl.startsWith('https:') ? require('https') : require('http');
    } catch (e) { return reject(e); }
    const doReq = (u, left) => {
      let settled = false;
      const finish = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
      try {
        const req = lib.get(u, (resp) => {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            resp.resume();
            if (left <= 0) return finish(reject, new Error('重定向次数过多'));
            let next;
            try { next = new URL(resp.headers.location, u).toString(); } catch (e) { return finish(reject, new Error('重定向地址无效')); }
            return doReq(next, left - 1);
          }
          if (resp.statusCode !== 200) { resp.resume(); return finish(reject, new Error('HTTP ' + resp.statusCode)); }
          const chunks = [];
          let total = 0;
          resp.on('data', (c) => {
            total += c.length;
            if (total > maxBytes) { resp.destroy(); return finish(reject, new Error('图片超过 ' + maxBytes + ' 字节')); }
            chunks.push(c);
          });
          resp.on('end', () => {
            const ct = String(resp.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            finish(resolve, { data: Buffer.concat(chunks), contentType: ct });
          });
          resp.on('error', (e) => finish(reject, e));
        });
        req.on('error', (e) => finish(reject, e));
        req.setTimeout(15000, () => { req.destroy(new Error('下载超时')); });
      } catch (e) { finish(reject, e); }
    };
    doReq(rawUrl, 5);
  });
}

// 按 URL 下载封面并按电台 name 重命名存入 CACHE_DIR/radio-covers，统一转 WebP；返回可访问的封面地址；失败抛错。
// 供 POST /api/radio/cover-from-url 与 M3U 批量导入复用。
async function saveRadioCoverFromUrl(rawName, rawUrl) {
  const name = normalizeCoverKey(rawName);
  const url = String(rawUrl || '').trim();
  if (!name) throw new Error('电台名称非法');
  if (!/^https?:\/\//i.test(url)) throw new Error('封面地址需为 http(s)://');

  const max = 8 * 1024 * 1024;
  const buf = await downloadCoverToBuffer(url, max);

  // 统一转 WebP（新产生的电台封面一律 .webp）；转换失败才按原格式直存兜底
  let dest;
  let outData;
  const webpBuf = await toWebpBuffer(buf.data);
  if (webpBuf) {
    dest = path.join(RADIO_COVER_DIR, name + '.webp');
    outData = webpBuf;
  } else {
    const extByMime = {
      'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpeg',
      'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp'
    };
    let ext = extByMime[buf.contentType] || '';
    if (!ext) {
      try {
        const m = new URL(url).pathname.match(/\.(png|jpg|jpeg|gif|webp|bmp|svg)(\?|$)/i);
        if (m) ext = '.' + m[1].toLowerCase();
      } catch (e) { /* ignore */ }
    }
    if (!ext) ext = '.png';
    if (ext === '.jpeg') ext = '.jpg';
    dest = path.join(RADIO_COVER_DIR, name + ext);
    outData = buf.data;
  }

  const old = findRadioCoverFile(name);
  if (old && old !== dest) { try { fs.unlinkSync(old); } catch (e) { /* ignore */ } }
  fs.writeFileSync(dest, outData);

  return `/api/radio/cover?name=${encodeURIComponent(name)}`;
}

// 电台默认封面：电台没有导入封面时返回这张图。
// 用 SVG 绘制（不依赖字体/网络资源），保证卡片、播放条、播放详情页都不会出现空白封面。
const DEFAULT_RADIO_COVER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#33333f"/>
      <stop offset="100%" stop-color="#1b1b23"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <rect x="96" y="184" width="320" height="192" rx="22" fill="#3d3d4d"/>
  <circle cx="180" cy="280" r="46" fill="#5a5a72"/>
  <circle cx="180" cy="280" r="15" fill="#3d3d4d"/>
  <rect x="252" y="222" width="132" height="68" rx="10" fill="#1db954" opacity="0.9"/>
  <circle cx="276" cy="326" r="13" fill="#1db954"/>
  <circle cx="348" cy="326" r="13" fill="#8c8ca6"/>
  <path d="M366 184 L432 104" stroke="#8c8ca6" stroke-width="12" stroke-linecap="round"/>
  <circle cx="434" cy="100" r="12" fill="#8c8ca6"/>
</svg>`;

// 默认电台封面的 PNG 版本（惰性光栅化一次并常驻内存）：
// OpenSubsonic getCoverArt 面向第三方客户端，部分客户端（Flutter/原生）无法解码 SVG，
// 直接返回 PNG 可保证「没有导入封面的电台」在客户端列表里也能显示台标而不是空白。
// sharp 不可用或光栅化失败时返回 false，由调用方回退到内置 1x1 占位图。
let defaultRadioCoverPng;
let defaultRadioCoverPngTried = false;
async function sendDefaultRadioCover(res) {
  if (!defaultRadioCoverPngTried) {
    defaultRadioCoverPngTried = true;
    try {
      if (sharp) defaultRadioCoverPng = await sharp(Buffer.from(DEFAULT_RADIO_COVER_SVG)).png().toBuffer();
    } catch (e) { defaultRadioCoverPng = null; }
  }
  if (!defaultRadioCoverPng) return false;
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(defaultRadioCoverPng);
  return true;
}

function registerRadioRoutes(app) {
  // 电台封面：按电台 name 获取（图片文件名（不含扩展名）与 name 一致即命中）
  app.get('/api/radio/cover', (req, res) => {
    const name = req.query.name ? normalizeCoverKey(req.query.name) : '';
    const file = findRadioCoverFile(name);
    if (!file) {
      // 无封面：返回内置默认封面 SVG（200），避免前端 <img> 触发 404 控制台报错。
      // 注意：此前返回的是 1x1 透明图，虽不报错，但 <img> 视为加载成功、onerror 兜底不触发，
      // 播放器（播放条/详情页）又没有卡片那层垫底 emoji，结果就是封面一片空白。
      // 改为直接返回一张默认电台封面，所有展示位置都不会留空。
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.status(200).send(DEFAULT_RADIO_COVER_SVG);
    }
    return res.sendFile(file);
  });

  // 电台封面：导入（表单字段 name + file），图片统一转 WebP 后按 name 存入 CACHE_DIR/radio-covers
  app.post('/api/radio/cover', adminMiddleware, coverUpload.single('file'), async (req, res) => {
    try {
      const name = normalizeCoverKey((req.body && req.body.name) || '');
      if (!name) return res.status(400).json({ success: false, error: '电台名称非法' });
      const file = req.file;
      if (!file) return res.status(400).json({ success: false, error: '未收到图片' });

      // multer 内存接收：直接使用 req.file.buffer，无磁盘临时文件
      const rawBuf = file.buffer;
      // 统一转 WebP；sharp 不可用/转换失败才按原格式直存兜底
      let dest;
      let outData;
      const webpBuf = await toWebpBuffer(rawBuf);
      if (webpBuf) {
        dest = path.join(RADIO_COVER_DIR, name + '.webp');
        outData = webpBuf;
      } else {
        const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
        const ext = (path.extname(file.originalname) || '').toLowerCase();
        const extByMime = {
          'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpeg',
          'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg'
        };
        const finalExt = allowed.includes(ext) ? ext : (extByMime[file.mimetype] || '.png');
        dest = path.join(RADIO_COVER_DIR, name + finalExt);
        outData = rawBuf;
      }

      // 删除同名旧封面（不同扩展名）
      const old = findRadioCoverFile(name);
      if (old && old !== dest) { try { fs.unlinkSync(old); } catch (e) { /* ignore */ } }

      fs.writeFileSync(dest, outData);

      const url = `/api/radio/cover?name=${encodeURIComponent(name)}`;
      res.json({ success: true, url, path: dest });
    } catch (e) {
      if (ctx.logger && typeof ctx.logger.error === 'function') {
        ctx.logger.error('RADIO', 'cover', 'import radio cover failed', { error: e && e.message });
      }
      res.status(500).json({ success: false, error: e && e.message });
    }
  });

  // 电台封面：按 URL 自动下载并按电台名称重命名存入 radio-covers（管理员）
  app.post('/api/radio/cover-from-url', adminMiddleware, async (req, res) => {
    try {
      const coverUrl = await saveRadioCoverFromUrl((req.body && req.body.name) || '', (req.body && req.body.url) || '');
      res.json({ success: true, url: coverUrl });
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const status = /名称非法|http\(s\)/.test(msg) ? 400 : 500;
      if (status === 500 && ctx.logger && typeof ctx.logger.error === 'function') {
        ctx.logger.error('RADIO', 'cover', 'download radio cover failed', { error: msg });
      }
      res.status(status).json({ success: false, error: msg });
    }
  });
}

module.exports = {
  registerRadioRoutes,
  saveRadioCoverFromUrl,
  // OpenSubsonic 电台封面复用：按电台名直出已导入的封面文件 / 无封面时的默认电台封面（PNG）
  sendRadioCover,
  sendDefaultRadioCover
};
