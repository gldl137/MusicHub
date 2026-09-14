'use strict';

// ==================== 缓存 API ====================
// 路由归属：/api/cache/*, /cache/*, /api/local-files/stream
// 忠实搬运自 server.js（4373-4757）。clearAllCacheWithNotify 供 wecom 复用。

const ctx = require('../lib/context');
const { logger, axios, notifications, authMiddleware } = ctx;
const fs = ctx.fs;
const path = ctx.path;
const CACHE_DIR = ctx.CACHE_DIR;
const CACHE_INDEX_FILE = ctx.CACHE_INDEX_FILE;
// strm 文件播放用：客户端真实 IP 判定 + OpenList 内网/外网基地址
const ip = require('ip');
const config = require('../lib/config');

/**
 * 删除历史遗留的缓存索引文件 index.json（幂等）。自 v-后续版本起缓存索引改为
 * 浏览器 localStorage 持久化，后端不再产生/维护该文件。
 */
function removeLegacyIndexFile() {
  try {
    if (fs.existsSync(CACHE_INDEX_FILE)) {
      fs.unlinkSync(CACHE_INDEX_FILE);
      logger.info('CACHE', 'system', 'Legacy cache index file removed (index.json no longer used)', { file: CACHE_INDEX_FILE });
    }
  } catch (e) {
    logger.warn('CACHE', 'system', 'Failed to remove legacy cache index file', { file: CACHE_INDEX_FILE, error: e && e.message });
  }
}

/**
 * 清空缓存目录（仅清理 audio/artwork/lyrics 三类，与原 server.js 行为一致）。
 * 不再生成/保留 index.json（缓存索引已改为浏览器本地持久化）。
 */
// 逻辑缓存类型 -> 实际磁盘目录
// 注意：封面真实目录为 cover/（由 lib/cover-cache 写入），artwork/ 为旧逻辑目录，一并归入「封面」清理；
// 歌手头像独立 art/（cover-cache 写入），单独归为 artist 类型；电台封面在 radio-covers/，归 radio 类型。
// lyrics 目录仍保留映射（兼容旧调用），但前端清理面板不再展示歌词项。
const TYPE_DIRS = {
  artwork: ['cover', 'artwork'],
  artist: ['art'],
  radio: ['radio-covers'],
  lyrics: ['lyrics']
};

function clearAllCache(types) {
  let totalDeleted = 0;
  let totalSize = 0;

  const allTypes = Object.keys(TYPE_DIRS);
  const targetTypes = Array.isArray(types) && types.length
    ? types.filter(t => allTypes.includes(t))
    : allTypes;

  const dirSet = new Set();
  for (const t of targetTypes) {
    for (const d of TYPE_DIRS[t]) dirSet.add(d);
  }

  for (const dirName of dirSet) {
    const dir = path.join(CACHE_DIR, dirName);
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
          totalSize += stats.size;
          fs.unlinkSync(filePath);
          totalDeleted++;
        }
      }
    }
  }

  removeLegacyIndexFile(); // 清缓存时顺带删除历史遗留 index.json（如有）

  // 清掉封面(cover/)/歌手头像(art/)文件后，对应专辑/歌手的「搜过未命中」状态同步重置，
  // 否则持久化的 24h 窗口会把「用户想立刻重试补图」挡掉。
  resetCoverFillMissForTypes(targetTypes);

  logger.info('CACHE', 'clear', `Cleared cache`, { types: targetTypes, deleted: totalDeleted, size: totalSize });
  return { deleted: totalDeleted, size: totalSize, types: targetTypes };
}

/**
 * 清缓存后重置「封面补全未命中」持久化记录（fire-and-forget）：
 *  - artist 类型（删 art/）→ 清空 artist| 前缀 miss，歌手头像可立即重新搜索；
 *  - artwork 类型（删 cover/）→ 清空 album| 前缀 miss，专辑真实封面可立即重新搜索。
 * （未命中表由 lib/cover-fill-queue.js 维护，键形如 'artist|歌手名'、'album|歌手\0专辑名'。）
 */
function resetCoverFillMissForTypes(types) {
  const prefixes = [];
  const list = Array.isArray(types) ? types : [];
  if (list.includes('artist')) prefixes.push('artist|');
  if (list.includes('artwork')) prefixes.push('album|');
  if (!prefixes.length) return;
  try {
    // eslint-disable-next-line global-require
    const localLibraryDb = require('../lib/local-library-db');
    localLibraryDb.loadCoverFillMiss().then((saved) => {
      if (!saved || typeof saved !== 'object') return;
      let changed = false;
      for (const k of Object.keys(saved)) {
        if (prefixes.some((p) => k.indexOf(p) === 0)) {
          delete saved[k];
          changed = true;
        }
      }
      if (changed) return localLibraryDb.saveCoverFillMiss(saved).catch(() => {});
    }).catch(() => {});
  } catch (e) { /* 忽略 */ }
}

/**
 * 清空缓存并发送通知（供 wecom 菜单调用）
 */
async function clearAllCacheWithNotify(types) {
  const result = clearAllCache(types);
  const clearedTypes = result.types || ['audio', 'artwork', 'lyrics'];
  const typeNames = { artwork: '封面', artist: '歌手头像', radio: '电台封面', lyrics: '歌词' };
  const names = clearedTypes.map(t => typeNames[t] || t).join('、');
  const msg = `**🧹 MusicHub - 缓存清理完成**\n\n` +
    `• 清理类型: ${names}\n` +
    `• 删除文件: ${result.deleted} 个\n` +
    `• 释放空间: ${(result.size / 1024 / 1024).toFixed(2)} MB\n` +
    `• 时间: ${new Date().toLocaleString('zh-CN')}`;
  try {
    await notifications.sendMarkdownNotification(msg);
  } catch (e) {
    logger.warn('CACHE', 'clear', 'Failed to send cache-clear notification', { error: e.message });
  }
  return result;
}

module.exports = function (app) {

  // 缓存与本地文件流接口均需登录：避免成为无需鉴权即可读取/删除缓存、串流本地曲库的开放接口
  app.use(['/api/cache', '/cache', '/api/local-files'], authMiddleware);

  // 保存缓存文件（文本类，如歌词）：按类型落盘到对应目录，返回体积供前端更新索引
  app.post('/api/cache/save', async (req, res) => {
    try {
      const { content, fileName, type = 'lyrics' } = req.body;

      if (content == null || !fileName) {
        return res.json({ success: false, error: 'Invalid cache file data' });
      }

      const typeDir = path.join(CACHE_DIR, type);
      if (!fs.existsSync(typeDir)) {
        fs.mkdirSync(typeDir, { recursive: true });
      }

      const exts = { artwork: '.jpg', lyrics: '.lrc' };
      const ext = exts[type] || '.txt';
      const safeName = String(fileName).replace(/[\\/:*?"<>|]/g, '_');
      const cacheFilePath = path.join(typeDir, `${safeName}${ext}`);

      const buf = Buffer.from(String(content), 'utf8');
      fs.writeFileSync(cacheFilePath, buf);

      res.json({ success: true, data: { size: buf.length, fileName: safeName } });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 下载并缓存媒体文件：按类型落盘到 audio/artwork/lyrics 目录，返回体积供前端更新索引
  app.post('/api/cache/download', async (req, res) => {
    try {
      const { url, fileName, type = 'lyrics', pluginName = 'default' } = req.body;

      // 仅支持封面 / 歌词缓存（音频不再缓存）
      if (!['artwork', 'lyrics'].includes(type)) {
        return res.json({ success: false, error: 'Unsupported cache type' });
      }

      if (!url || !fileName) {
        return res.json({ success: false, error: 'Missing url or fileName' });
      }

      const typeDir = path.join(CACHE_DIR, type);
      if (!fs.existsSync(typeDir)) {
        fs.mkdirSync(typeDir, { recursive: true });
      }

      const exts = { artwork: '.jpg', lyrics: '.lrc' };
      const ext = exts[type] || '.dat';
      const safeName = String(fileName).replace(/[\\/:*?"<>|]/g, '_');
      const cacheFilePath = path.join(typeDir, `${safeName}${ext}`);

      const response = await axios({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': url }
      });

      const buffer = Buffer.from(response.data);
      fs.writeFileSync(cacheFilePath, buffer);
      const size = buffer.length;

      res.json({ success: true, data: { size, fileName: safeName, path: cacheFilePath } });
    } catch (err) {
      res.json({ success: false, error: err.message, detail: err.response?.data || null });
    }
  });

  // 删除缓存文件（按类型目录，兼容旧结构）
  app.delete('/api/cache/delete/:name', async (req, res) => {
    try {
      const cacheName = req.params.name;
      const type = req.query.type || 'lyrics';
      const safeName = String(cacheName).replace(/[\\/:*?"<>|]/g, '_');

      const exts = { artwork: '.jpg', lyrics: '.lrc' };
      const ext = exts[type] || '';
      let deleted = false;

      // 新结构：CACHE_DIR/<type>/<safeName>.<ext>
      if (ext) {
        const cacheFilePath = path.join(CACHE_DIR, type, `${safeName}${ext}`);
        if (fs.existsSync(cacheFilePath)) {
          fs.unlinkSync(cacheFilePath);
          deleted = true;
        }
      }

      // 兼容旧结构：pluginName 子目录 或 .json 文件
      const legacyDir = path.join(CACHE_DIR, safeName);
      if (fs.existsSync(legacyDir)) {
        fs.rmSync(legacyDir, { recursive: true, force: true });
        deleted = true;
      }
      const legacyFile = path.join(CACHE_DIR, `${safeName}.json`);
      if (fs.existsSync(legacyFile)) {
        fs.unlinkSync(legacyFile);
        deleted = true;
      }

      res.json({ success: true, message: deleted ? 'Cache deleted successfully' : 'No cache file found' });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 清空缓存（可指定类型：body.types = ['audio','artwork','lyrics']；不传则全清）
  app.post('/api/cache/clear', async (req, res) => {
    try {
      const types = req.body && req.body.types;
      const data = await clearAllCacheWithNotify(types);
      res.json({ success: true, data });
    } catch (error) {
      logger.error('CACHE', 'clear', 'Failed to clear cache', { error: error.message });
      res.json({ success: false, error: error.message });
    }
  });

  // 缓存统计：扫描实际磁盘目录，返回各类型文件数与体积（准确反映磁盘实际缓存）
  app.get('/api/cache/stats', async (_req, res) => {
    try {
      const data = {
        totalSize: 0,
        itemCount: 0,
        artwork: { count: 0, size: 0 },
        artist: { count: 0, size: 0 },
        radio: { count: 0, size: 0 },
        lyrics: { count: 0, size: 0 }
      };
      for (const type of Object.keys(TYPE_DIRS)) {
        let count = 0, size = 0;
        for (const dirName of TYPE_DIRS[type]) {
          const dir = path.join(CACHE_DIR, dirName);
          if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            for (const file of files) {
              const fp = path.join(dir, file);
              try {
                const st = fs.statSync(fp);
                if (st.isFile()) { count++; size += st.size; }
              } catch (e) { /* ignore */ }
            }
          }
        }
        data[type] = { count, size };
        data.totalSize += size;
        data.itemCount += count;
      }
      res.json({ success: true, data });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 提供缓存文件服务（仅封面 / 歌词；音频不再缓存）
  app.get('/cache/:type/:name', (req, res) => {
    const { type } = req.params;
    const name = decodeURIComponent(req.params.name);

    if (!['artwork', 'lyrics'].includes(type)) {
      return res.status(404).send('Not found');
    }

    const exts = { artwork: '.jpg', lyrics: '.lrc' };
    const contentTypes = { artwork: 'image/jpeg', lyrics: 'text/plain' };

    const dirPath = path.join(CACHE_DIR, type);
    let filePath = path.join(dirPath, name + exts[type]);

    if (!fs.existsSync(filePath)) {
      if (fs.existsSync(dirPath)) {
        const files = fs.readdirSync(dirPath);
        const matchedFile = files.find(f => {
          const ext = exts[type];
          return f === name + ext || (f.startsWith(name) && f.endsWith(ext));
        });
        if (matchedFile) {
          filePath = path.join(dirPath, matchedFile);
        }
      }
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).send('Not found');
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader('Content-Type', contentTypes[type]);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.setHeader('Accept-Ranges', 'bytes');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;

      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunksize);
      res.status(206);

      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.setHeader('Content-Length', fileSize);
      fs.createReadStream(filePath).pipe(res);
    }
  });

  // 本地文件流（用于本地音乐播放）
  app.get('/api/local-files/stream', async (req, res) => {
    try {
      const { path: filePath } = req.query;
      if (!filePath) {
        return res.status(400).json({ error: 'Missing path parameter' });
      }

      const decodedPath = decodeURIComponent(filePath);
      logger.debug('API', req.reqId || 'local', `Local file stream request`, { path: decodedPath });

      if (!fs.existsSync(decodedPath)) {
        return res.status(404).json({ error: 'File not found' });
      }

      // strm 文件：不读取文件本体，302 重定向到内网/外网真实地址（与 /rest/stream 一致）。
      // 浏览器 <audio> 元素跟随 302 直连 OpenList，服务端不代理音频流，追求最高性能。
      if (path.extname(decodedPath).toLowerCase() === '.strm') {
        return serveStrmByRedirect(req, res, decodedPath);
      }

      const stat = fs.statSync(decodedPath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(decodedPath, { start, end });
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'audio/mpeg'
        });
        file.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'audio/mpeg'
        });
        const file = fs.createReadStream(decodedPath);
        file.pipe(res);
      }
    } catch (error) {
      logger.error('API', req.reqId || 'local', `Local file stream error`, { error: error.message });
      res.status(500).json({ error: 'Failed to stream local file', message: error.message });
    }
  });
};

// ---------------- strm 文件：302 重定向（浏览器本地音乐播放） ----------------
// 仅返回 Location，浏览器 <audio> 直连 OpenList，Node 不代理音频流。
// 与 rest/opensubsonic.js 的 serveStrmStream 逻辑一致：内网 IP 用原始地址，外网 IP 拼接 pathname+search。
function getClientRealIp(req) {
  const headers = req && req.headers ? req.headers : {};
  const xff = headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  const xReal = headers['x-real-ip'];
  if (xReal) {
    const v = String(xReal).split(',')[0].trim();
    if (v) return v;
  }
  return (req && req.ip) || (req && req.socket && req.socket.remoteAddress) || '';
}

function isPrivateClient(ipStr) {
  if (!ipStr) return false;
  let s = String(ipStr).trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  try {
    return ip.isPrivate(s);
  } catch {
    return false;
  }
}

// 读取 .strm 文本首行（忽略空行/注释行）作为真实内网地址，按客户端 IP 302 重定向。
function serveStrmByRedirect(req, res, strmPath) {
  let raw = '';
  try {
    raw = fs.readFileSync(strmPath, 'utf8');
  } catch (e) {
    return res.status(404).json({ error: 'strm file unreadable' });
  }
  const url = String(raw || '').split(/\r?\n/).map((s) => s.trim())
    .find((s) => s && !s.startsWith('#'));
  if (!url) {
    return res.status(400).json({ error: 'strm media url is empty' });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    logger.warn('API', req.reqId || 'local', 'strm: invalid media URL', { path: strmPath, error: e && e.message });
    return res.status(400).json({ error: 'invalid strm media url' });
  }

  // 仅允许 http/https 协议，拒绝 file:// 等危险协议（防开放重定向/协议注入）
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ error: 'unsupported strm media url scheme' });
  }

  // HEAD 探测：不重定向到 OpenList（避免 OpenList 对 HEAD 返回 403 弹窗），直接 200 表示可用。
  if (String((req && req.method) || 'GET').toUpperCase() === 'HEAD') {
    res.status(200)
      .setHeader('Content-Type', 'audio/mpeg')
      .setHeader('Accept-Ranges', 'bytes')
      .end();
    return;
  }

  const clientIp = getClientRealIp(req);
  const privateClient = isPrivateClient(clientIp);
  let target;
  if (privateClient) {
    target = url; // 内网客户端直连 OpenList 内网地址
  } else {
    const base = (config.loadOpenlistConfig().publicBaseUrl || '').replace(/\/+$/, '');
    if (!base) {
      logger.warn('API', req.reqId || 'local', 'strm: external client but openlistPublicBaseUrl not configured', { clientIp });
      return res.status(404).json({ error: 'openlist public base url not configured' });
    }
    target = base + parsed.pathname + (parsed.search || '');
  }

  logger.debug('API', req.reqId || 'local', 'strm: redirect', {
    mode: privateClient ? 'local' : 'public',
    clientIp,
    target
  });
  res.redirect(302, target);
}

module.exports.clearAllCacheWithNotify = clearAllCacheWithNotify;
