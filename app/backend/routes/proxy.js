'use strict';

// ==================== 代理路由（SSRF 防护） ====================
// 路由归属：/api/proxy/audio, /api/proxy/image
// isPrivateIp / isUnsafeProxyUrl / proxyAudioStream 抽取到 rest/proxy-utils（纯 JS，
// 不依赖 sqlite3），供 OpenSubsonic 网络歌曲播放复用。

const ctx = require('../lib/context');
const { logger, axios } = ctx;
const { authMiddleware } = require('../lib/middleware');
const { isPrivateIp, isUnsafeProxyUrl, proxyAudioStream, guardProxyTarget, pinnedAgent, refererForUrl } = require('../rest/proxy-utils');
const { createProxyToken, verifyProxyToken, DEFAULT_TTL, MAX_TTL } = require('../lib/proxy-token');

// ==================== HLS 代理工具 ====================
// 背景：hls.js 通过 XHR 拉流，浏览器强制校验 CORS；而多数电台源站只允许自家域名跨域
// （实测央广 Access-Control-Allow-Origin: http://app.cctv.com），直连必被拦截；
// 若页面为 HTTPS 而流为 HTTP，还会叠加混合内容拦截。故由后端代拉并重写播放列表。

// 分片扩展名：二进制直接透传（保留 Range，避免整段缓冲）
const HLS_SEGMENT_EXT = /\.(ts|m4s|m4v|aac|ac3|ec3|mp4|mp3|m4a|vtt|webvtt)(\?|$)/i;

// 部分 CDN 会拒绝默认 axios UA，统一伪装成浏览器
const HLS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function isSegmentUrl(url) {
  return HLS_SEGMENT_EXT.test(String(url));
}

/** 把相对/绝对 URI 解析为绝对地址（以源播放列表为 base） */
function resolveAbsolute(baseUrl, ref) {
  try { return new URL(String(ref), baseUrl).href; } catch { return String(ref); }
}

/**
 * 重写 HLS 播放列表：把分片/子播放列表/密钥等 URI 解析为绝对地址后再走代理。
 * 必须解析成绝对地址——源列表普遍用相对路径（如 15820887.ts），
 * 直接透传会让浏览器请求到本站错误路径。
 */
function rewriteHlsPlaylist(text, baseUrl) {
  return String(text).split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      // 标签内 URI="..."（EXT-X-KEY 密钥、EXT-X-MAP 初始化段、EXT-X-MEDIA 音轨等）
      return trimmed.replace(/URI="([^"]*)"/gi, (_m, uri) => `URI="${toProxyUrl(resolveAbsolute(baseUrl, uri))}"`);
    }
    return toProxyUrl(resolveAbsolute(baseUrl, trimmed));
  }).join('\n');
}

/** 包一层本代理，让浏览器侧始终同源拉取。改用签名 token，前端不再接触外部完整 URL。 */
function toProxyUrl(absolute) {
  return `/api/proxy/hls?token=${createProxyToken(absolute)}`;
}

/**
 * 从请求中恢复经签名的代理目标 URL：校验 token 签名与过期时间（fail-closed）。
 * 严禁再接受原始 url 参数——这是"前端不传完整外部 URL"的核心约束。
 * @returns {string|null} 成功返回目标 URL，失败已写响应并返回 null
 */
function resolveProxyUrlFromToken(req, res) {
  const token = req.query.token;
  if (!token) {
    res.status(400).json({ error: 'Missing token' });
    return null;
  }
  const v = verifyProxyToken(token);
  if (!v.ok) {
    logger.warn('API', req.reqId, `Proxy token rejected`, { reason: v.error });
    res.status(403).json({ error: 'Invalid or expired token' });
    return null;
  }
  return v.url;
}

/**
 * 手动流式转发并限制最大字节（防流量放大）：超限即销毁上游并关闭响应。
 * 比 pipe() 更可控，避免在已写出响应头后再尝试改状态码失败的问题。
 */
function pipeWithMax(stream, res, maxBytes) {
  let total = 0;
  let done = false;
  const abort = () => {
    if (done) return;
    done = true;
    try { stream.destroy(); } catch { /* ignore */ }
    try { res.end(); } catch { /* ignore */ }
  };
  stream.on('data', (c) => {
    if (done) return;
    total += c.length;
    if (total > maxBytes) {
      logger.warn('API', req.reqId, `Proxy payload exceeded maxBytes, aborted`, { maxBytes });
      abort();
      return;
    }
    res.write(c);
  });
  stream.on('end', () => { if (!done) { done = true; res.end(); } });
  stream.on('error', () => { if (!done) { done = true; try { res.end(); } catch { /* ignore */ } } });
}

// 播放列表体积上限：播放列表必须整份读入才能重写 URI，用上限兜住内存。
// 正常直播列表只有几百字节～几十 KB，超过即视为异常。
const HLS_PLAYLIST_MAX_BYTES = Number(process.env.HLS_PLAYLIST_MAX_BYTES || 1024 * 1024);

// 播放列表短缓存：hls.js 会周期性刷新同一份直播列表（实测约 5s 一次），
// 秒级缓存可显著减少重复回源。分片(ts)一律不进缓存——直播分片转瞬即逝，缓存毫无意义。
const HLS_PLAYLIST_CACHE_TTL = Number(process.env.HLS_PLAYLIST_CACHE_TTL || 2000);
const HLS_PLAYLIST_CACHE_MAX = Number(process.env.HLS_PLAYLIST_CACHE_MAX || 200);
const hlsPlaylistCache = new Map();   // 上游 url -> { body, ts }

/** 清理过期条目；仍超上限时按插入顺序淘汰最旧的 */
function pruneHlsPlaylistCache(now = Date.now()) {
  for (const [k, v] of hlsPlaylistCache) {
    if (now - v.ts > HLS_PLAYLIST_CACHE_TTL) hlsPlaylistCache.delete(k);
  }
  while (hlsPlaylistCache.size > HLS_PLAYLIST_CACHE_MAX) {
    const oldest = hlsPlaylistCache.keys().next().value;
    if (oldest === undefined) break;
    hlsPlaylistCache.delete(oldest);
  }
}

/**
 * 带体积上限地把流读成 Buffer。
 * 仅用于播放列表——必须拿到整份文本才能重写 URI；超过上限立即失败，避免内存被撑爆。
 */
function readStreamCapped(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; stream.destroy(); reject(err); } };
    stream.on('data', (c) => {
      if (settled) return;
      if (total + c.length > maxBytes) {
        return fail(new Error(`Playlist exceeds size limit (${maxBytes} bytes)`));
      }
      chunks.push(c);
      total += c.length;
    });
    stream.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    stream.on('error', fail);
  });
}

/** 是否应按播放列表处理（依 Content-Type 或 URL 扩展名判断） */
function looksLikePlaylist(url, contentType) {
  const ct = String(contentType || '').toLowerCase();
  return /mpegurl|x-mpegurl/.test(ct) || /\.(m3u8|m3u)(\?|$)/i.test(String(url));
}

/**
 * CORS 收紧：不再使用通配符 `*`。
 * - 同源请求（与服务器同 host）一律允许（媒体元素本就同源，无需跨域）；
 * - 跨域仅在显式配置 CORS_ALLOW_ORIGIN（逗号分隔）且命中时才回显 Origin；
 * - 不设置 Access-Control-Allow-Credentials: true，避免与凭据共用产生跨域漏洞。
 */
function applyCors(res, req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = (process.env.CORS_ALLOW_ORIGIN || '')
    .split(',').map((o) => o.trim()).filter(Boolean);
  const serverOrigin = `${req.protocol}://${req.get('host')}`;
  if (origin === serverOrigin || allowed.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  }
}

module.exports = function (app) {

  // 音频代理路由 - 处理带有 _setHeaders 的请求
  // 鉴权：同源媒体请求由浏览器自动携带会话 Cookie（HttpOnly），已登录用户方可使用，
  // 避免成为无需登录即可滥用的开放代理（SSRF 防护仍由下方 isUnsafeProxyUrl / guardProxyTarget 兜底）。
  app.get('/api/proxy/audio', authMiddleware, async (req, res) => {
    const { _setHeaders } = req.query;
    const url = resolveProxyUrlFromToken(req, res);
    if (!url) return;

    if (await isUnsafeProxyUrl(url)) {
      logger.warn('API', req.reqId, `Audio proxy blocked unsafe URL`, { url: url.substring(0, 60) });
      return res.status(400).json({ error: 'Disallowed or invalid URL' });
    }

    logger.debug('API', req.reqId, `Audio proxy request`, { url: url.substring(0, 60) });

    // 限制单次下载字节（防流量放大）；默认 200MB
    const maxBytes = Number(process.env.PROXY_MAX_BYTES || 200 * 1024 * 1024);
    await proxyAudioStream(req, res, url, _setHeaders, req.reqId, maxBytes);
  });

  // HLS 代理路由 - 代拉 .m3u8 播放列表与 .ts 分片，解决 CORS / 混合内容拦截
  app.get('/api/proxy/hls', authMiddleware, async (req, res) => {
    const url = resolveProxyUrlFromToken(req, res);
    if (!url) return;

    if (await isUnsafeProxyUrl(url)) {
      logger.warn('API', req.reqId, `HLS proxy blocked unsafe URL`, { url: String(url).substring(0, 60) });
      return res.status(400).json({ error: 'Disallowed or invalid URL' });
    }

    // ---- 1) 分片（ts/m4s…）：流式 pipe 转发，绝不整段读入内存，且绝不缓存 ----
    // 直播分片转瞬即逝，缓存毫无意义。交成熟音频代理处理，保留 Range 支持。
    if (isSegmentUrl(url)) {
      res.set('Cache-Control', 'no-store');
      const maxBytes = Number(process.env.PROXY_MAX_BYTES || 200 * 1024 * 1024);
      // 直播分片持续高频请求：silent=true 跳过逐条成功日志，仅保留错误/拦截告警
      await proxyAudioStream(req, res, url, { 'User-Agent': HLS_UA }, req.reqId, maxBytes, true);
      return;
    }

    // ---- 2) 播放列表：命中秒级缓存直接复用，减少重复回源（缓存 key 用真实目标 URL） ----
    const now = Date.now();
    const cached = hlsPlaylistCache.get(url);
    if (cached && now - cached.ts < HLS_PLAYLIST_CACHE_TTL) {
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      applyCors(res, req);
      res.set('Cache-Control', 'no-cache');
      res.set('X-HLS-Cache', 'hit');
      return res.send(cached.body);
    }
    if (cached) hlsPlaylistCache.delete(url);

    const guard = await guardProxyTarget(url);
    if (!guard.safe) {
      logger.warn('API', req.reqId, `HLS proxy blocked unsafe URL`, { url: String(url).substring(0, 60) });
      return res.status(400).json({ error: 'Disallowed or invalid URL' });
    }
    const agent = pinnedAgent(guard.ip, guard.family, guard.parsed.protocol);

    try {
      // 统一以 stream 方式取回：非播放列表直接 pipe，避免整段驻留内存
      const response = await axios({
        method: 'get',
        url,
        httpAgent: agent,
        httpsAgent: agent,
        responseType: 'stream',
        timeout: 15000,
        headers: { 'User-Agent': HLS_UA }
      });

      const upstreamCt = response.headers['content-type'];

      // 非播放列表（分片等二进制）：流式转发 + 字节上限，不做任何整体缓存
      if (!looksLikePlaylist(url, upstreamCt)) {
        res.status(response.status);
        if (upstreamCt) res.set('Content-Type', upstreamCt);
        if (response.headers['content-length']) res.set('Content-Length', response.headers['content-length']);
        applyCors(res, req);
        res.set('Cache-Control', 'no-store');
        // 上游流出错时收尾，避免挂起的响应与未捕获的 error 事件
        response.data.on('error', () => { try { res.end(); } catch { /* ignore */ } });
        const maxBytes = Number(process.env.PROXY_MAX_BYTES || 200 * 1024 * 1024);
        pipeWithMax(response.data, res, maxBytes);
        return;
      }

      // 播放列表：必须整份读入才能重写 URI（体积受上限保护）
      const buf = await readStreamCapped(response.data, HLS_PLAYLIST_MAX_BYTES);
      const head = buf.subarray(0, 64).toString('utf8');

      // 兜底：内容并非播放列表，原样回传已读字节（体积受上限保护）
      if (!/^\s*#EXTM3U/.test(head)) {
        res.set('Content-Type', upstreamCt || 'application/octet-stream');
        applyCors(res, req);
        res.set('Cache-Control', 'no-store');
        return res.send(buf);
      }

      const rewritten = rewriteHlsPlaylist(buf.toString('utf8'), url);

      // 仅播放列表入缓存（分片永远不进这里）
      hlsPlaylistCache.set(url, { body: rewritten, ts: Date.now() });
      pruneHlsPlaylistCache();

      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      applyCors(res, req);
      res.set('Cache-Control', 'no-cache');
      res.set('X-HLS-Cache', 'miss');
      res.send(rewritten);
      // 播放列表成功拉取不逐条记录：电台播放期间 hls.js 每 2~5s 刷新一次列表，
      // 逐条日志会刷屏；错误/超时/拦截已由上方 warn/error 单独记录。
    } catch (error) {
      logger.error('API', req.reqId, `HLS proxy error`, { error: error.message, url: String(url).substring(0, 60) });
      res.status(500).json({ error: 'Failed to proxy HLS', message: error.message });
    }
  });

  // 图片代理路由 - 用于封面颜色提取（解决 CORS 问题）
  app.get('/api/proxy/image', authMiddleware, async (req, res) => {
    const url = resolveProxyUrlFromToken(req, res);
    if (!url) return;

    if (await isUnsafeProxyUrl(url)) {
      logger.warn('API', req.reqId, `Image proxy blocked unsafe URL`, { url: url.substring(0, 60) });
      return res.status(400).json({ error: 'Disallowed or invalid URL' });
    }

    // 不记录封面等图片的具体地址（避免日志里出现大量图片 URL）
    logger.debug('API', req.reqId, 'Image proxy request');

    const guard = await guardProxyTarget(url);
    if (!guard.safe) {
      logger.warn('API', req.reqId, `Image proxy blocked unsafe URL`, { url: url.substring(0, 60) });
      return res.status(400).json({ error: 'Disallowed or invalid URL' });
    }
    const agent = pinnedAgent(guard.ip, guard.family, guard.parsed.protocol);
    try {
      const response = await axios({
        method: 'GET',
        url: url,
        httpAgent: agent,
        httpsAgent: agent,
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          // 防盗链：图床要求带主站 Referer，仅用图片 CDN 自身 origin 会被 403（导致歌单封面全部空白）。
          // refererForUrl 按域名推断正确 Referer，与 getCoverArt 的封面代理逻辑一致。
          'Referer': refererForUrl(url) || new URL(url).origin
        }
      });

      // 封面图硬上限：默认 20MB，超出直接拒绝
      const maxBytes = Number(process.env.PROXY_IMAGE_MAX_BYTES || 20 * 1024 * 1024);
      const cl = Number(response.headers['content-length'] || 0);
      if (cl > maxBytes) {
        logger.warn('API', req.reqId, `Image proxy too large, rejected`, { contentLength: cl });
        return res.status(413).json({ error: 'Image too large' });
      }

      applyCors(res, req);
      res.set('Access-Control-Allow-Methods', 'GET');
      res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=3600');

      res.send(Buffer.from(response.data));
    } catch (error) {
      logger.error('API', req.reqId, `Image proxy error`, { error: error.message, url: url.substring(0, 60) });
      res.status(500).json({ error: 'Failed to proxy image', message: error.message });
    }
  });

  // 封面实时获取端点（需登录）：网页前端用 coverArt 虚拟 ID 经此拿封面，
  // 复用 OpenSubsonic 的 getCoverArt 逻辑（运行时向插件实时获取，不暴露时效性外网地址）。
  // 与 Subsonic 客户端走同一套封面逻辑，保证网页/APP 行为统一。
  app.get('/api/cover', authMiddleware, async (req, res) => {
    const id = String(req.query.id || '').trim();
    const rel = String(req.query.rel || '').trim();
    // 直接静态返回已落盘的网络封面：rel = cover/<md5>.webp（由 net-cover-cache 写入），
    // 由收藏/播放历史列表 fillCovers 生成；resolveRelpath 自带路径穿越防护，安全。
    if (rel) {
      try {
        const coverCacheLib = require('../lib/cover-cache');
        const fs = require('fs');
        const full = coverCacheLib.resolveRelpath(rel);
        if (full && fs.existsSync(full)) {
          res.setHeader('Content-Type', coverCacheLib.mimeOf(full));
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.sendFile(full);
          return;
        }
      } catch (e) {
        logger.warn('API', req.reqId, 'cover rel serve failed, fallback to id', { error: e && e.message, rel });
      }
    }
    if (!id) {
      res.status(400).send('missing id');
      return;
    }
    const params = { id, user: { id: req.user.id, role: req.user.role } };
    try {
      const openSubsonic = require('../rest/opensubsonic');
      await openSubsonic.handleRaw(req, res, params, 'getcoverart', null, ctx);
    } catch (err) {
      logger.error('API', req.reqId, 'cover route failed', { error: err && err.message, id });
      if (!res.headersSent) res.status(500).send('cover error');
    }
  });

  // 代理签名签发端点（需登录）：前端先拿外部 URL 来此换取短期 token，
  // 之后只携带 token 访问 /api/proxy/*，绝不再把外部完整 URL 暴露在请求参数里。
  // 服务端在签发前先用 guardProxyTarget 校验目标（SSRF + 域名白名单），仅安全目标才签发。
  app.post('/api/proxy/sign', authMiddleware, async (req, res) => {
    const target = req.body && req.body.url;
    if (!target || typeof target !== 'string') {
      return res.status(400).json({ success: false, error: '缺少 url' });
    }
    const guard = await guardProxyTarget(target);
    if (!guard.safe) {
      logger.warn('API', req.reqId, `Proxy sign blocked unsafe URL`, { url: target.substring(0, 60) });
      return res.status(403).json({ success: false, error: '目标地址不允许代理' });
    }
    const ttl = Math.min(Math.max(1, parseInt(req.body.ttl, 10) || DEFAULT_TTL), MAX_TTL);
    const token = createProxyToken(target, ttl);
    res.json({
      success: true,
      data: { token, ttl, exp: Math.floor(Date.now() / 1000) + ttl }
    });
  });
};

// 供 OpenSubsonic 等模块复用（保持兼容导出）
module.exports.isPrivateIp = isPrivateIp;
module.exports.isUnsafeProxyUrl = isUnsafeProxyUrl;
module.exports.proxyAudioStream = proxyAudioStream;
