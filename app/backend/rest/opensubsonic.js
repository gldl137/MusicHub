'use strict';

/**
 * OpenSubsonic (Subsonic REST) API 服务器实现。
 *
 * 对外形态：/rest/<method>?u=..&p=..&(t=..&s=..)&v=1.16.1&c=..&f=json|xml
 * 支持 GET 与 POST (application/x-www-form-urlencoded / JSON) 传参。
 *
 * 媒体库数据源为本地音乐库（/app/music，routes/local-music.js）优先，
 * 本地库为空时回退下载目录库（rest/library.js）；流式播放走本地文件（原生支持 HTTP Range）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

const library = require('./library');
const localMusic = require('../routes/local-music'); // 本地音乐库（/app/music），下载/播放本地音乐
// 网络歌曲封面统一落盘 cover/<md5>.webp 缓存（与本地封面共享；含 URL 持久索引防重复下载）
const netCoverCache = require('../lib/net-cover-cache');
// 全局封面补全队列（单并发闸 + 限速）：本地歌手/专辑封面即时联网收敛于此，防并发打源
const coverFillQueue = require('../lib/cover-fill-queue');
// 本地音乐页同源的封面搜索（默认插件 + 24h 缓存）：专辑/歌手封面统一走这里，
// 保证本地音乐页与 OpenSubsonic 客户端（箭头等）拿到一致的封面，只维护一份。
const { fetchArtistImage, fetchAlbumImage, enrichLocalMusic } = require('../lib/local-enrich');
// 纯内存方案：本地歌曲封面/专辑封面/歌手头像的临时 URL 不落库，下载成功后业务表只绑本地 webp 路径
const localLibraryDb = require('../lib/local-library-db');
const coverCacheLib = require('../lib/cover-cache');
const xml = require('./xml');
const plaintextCache = require('./plaintext-cache');
// 音频代理（网络歌曲播放）与 SSRF 校验：纯 JS 模块，不依赖 sqlite3（保证可独立冒烟测试）
const { proxyAudioStream, isUnsafeProxyUrl, resolveProxyGuard } = require('./proxy-utils');
// 电台数据收集（OpenSubsonic getInternetRadioStations 数据源）
const radioLib = require('../lib/radio');
// 电台封面文件（CACHE_DIR/radio-covers/<电台名>.webp）：列表判定 coverArt + getCoverArt 直出
const radioCover = require('../routes/radio');
// 客户端 IP 私网判定（strm 内网/外网重定向用）
const ip = require('ip');
// 全局配置（读取 OpenList 内网/外网基地址）
const config = require('../lib/config');
// 模块级日志器（与 database.js 一致：debug/info/warn/error(module, reqId, msg, meta)）
const logger = require('../core/logger');

const VERSION = '1.16.1';
const MUSIC_FOLDER_ID = 1;

// 音频后缀 → MIME 类型（与 library.js 一致；download 补全 contentType 用）
const CONTENT_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg'
};

// serverVersion 取 package.json 版本号
const SERVER_VERSION = (() => {
  try {
    return require(path.join(__dirname, '..', 'package.json')).version || '1.0.0';
  } catch {
    return '1.0.0';
  }
})();

const TYPE = 'MusicHub';

// ---------------- 工具 ----------------

function intVal(value, def) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? def : n;
}

function toIsoDate(ms) {
  if (!ms) return null;
  return new Date(ms).toISOString();
}

// ---------------- 鉴权 ----------------

// 将 md5 小写 hex 还原为 16 字节 Buffer
function hexToBuffer(hex) {
  try {
    return Buffer.from(hex, 'hex');
  } catch {
    return null;
  }
}

function authError(code, message, helpUrl) {
  return { code, message, helpUrl };
}

// 生成指向服务器 Web 设置页的 helpUrl（规范 apiKeyAuthentication 扩展：建议在错误 41/42/43/44 中携带，
// 帮助客户端引导用户获取/管理 API 秘钥）。无请求头时返回 undefined（cleanNulls 会省略该字段）。
function apiKeyHelpUrl(req) {
  try {
    if (!req) return undefined;
    const proto = (req.protocol || (req.headers && (req.headers['x-forwarded-proto'] || 'http')) || 'http');
    const host = (req.headers && req.headers.host) || '';
    return host ? `${proto}://${host}/` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 校验 OpenSubsonic 鉴权。返回 { ok, user? } 或 { ok:false, error }。
 * 支持三种方式：
 *   p 明文密码 /
 *   p 十六进制（系统编码 UTF-8）编码密码 /
 *   t + s  token 鉴权（t = md5(password + salt)）
 */
async function authenticate(params, ctx, req) {
  const u = params.u;
  const p = params.p; // string | buffer（binary 参数时）
  const t = params.t;
  const s = params.s;
  // 规范 apiKeyAuthentication 扩展：apiKey 查询参数（兼容小写 apikey）
  const apiKey = params.apiKey !== undefined ? String(params.apiKey)
    : (params.apikey !== undefined ? String(params.apikey) : undefined);
  const helpUrl = apiKeyHelpUrl(req);

  // API 秘钥鉴权：apiKey 与 u/p/t/s 互斥
  if (apiKey !== undefined) {
    if (u !== undefined || p !== undefined || t !== undefined || s !== undefined) {
      return { ok: false, error: authError(43, 'Multiple conflicting authentication mechanisms provided.', helpUrl) };
    }
    return authenticateWithApiKey(apiKey, ctx, helpUrl);
  }

  if (!u) {
    return { ok: false, error: authError(10, 'Required parameter "u" (username) is missing.') };
  }
  if (p === undefined && t === undefined) {
    return { ok: false, error: authError(10, 'Authentication requires either "p" or "t"+"s".') };
  }

  // 冲突检测
  const hasToken = t !== undefined && s !== undefined;
  if (p !== undefined && hasToken) {
    return { ok: false, error: authError(43, 'Multiple conflicting authentication mechanisms provided.') };
  }

  let user = null;
  try {
    user = await ctx.database.getUserByUsername(u);
  } catch {
    user = null;
  }
  if (!user) {
    return { ok: false, error: authError(40, 'Wrong username or password.') };
  }
  if (user.is_active === 0) {
    return { ok: false, error: authError(50, 'User is not authorized for the given operation.') };
  }

  let passwordOk = false;

  if (p !== undefined) {
    const pStr = Buffer.isBuffer(p) ? p.toString('utf8') : String(p);

    // 1) 直接按明文比对
    try {
      passwordOk = await ctx.database.bcrypt.compare(pStr, user.password_hash);
    } catch {
      passwordOk = false;
    }
    if (passwordOk) {
      plaintextCache.set(u, pStr);
    } else {
      // 2) 兼容 hex 编码密码（每字节两个十六进制字符）
      if (pStr.length > 0 && pStr.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(pStr)) {
        const decoded = hexToBuffer(pStr);
        if (decoded) {
          const asText = decoded.toString('utf8');
          try {
            passwordOk = await ctx.database.bcrypt.compare(asText, user.password_hash);
          } catch {
            passwordOk = false;
          }
          if (passwordOk) plaintextCache.set(u, asText);
        }
      }
    }
  } else if (hasToken) {
    // token 鉴权：t = md5(password + salt)，依赖明文缓存
    const salt = String(s);
    const cachedPw = plaintextCache.get(u);
    if (cachedPw) {
      const expected = crypto.createHash('md5').update(cachedPw + salt).digest('hex');
      if (expected === String(t).toLowerCase()) {
        passwordOk = true;
      }
    }
  }

  if (!passwordOk) {
    return { ok: false, error: authError(40, 'Wrong username or password.') };
  }

  return { ok: true, user };
}

/**
 * 系统 API 秘钥鉴权（规范 apiKeyAuthentication 扩展）。
 * 秘钥通过 query 参数 apiKey 单独传递，映射到系统管理员用户（role=admin）。
 * 无效秘钥返回错误码 44（Invalid API key）。
 */
async function authenticateWithApiKey(apiKey, ctx, helpUrl) {
  let configured = '';
  try {
    configured = String(await ctx.database.getSetting('api_key', '')) || '';
  } catch {
    configured = '';
  }
  if (!configured || apiKey !== configured) {
    return { ok: false, error: authError(44, 'Invalid API key.', helpUrl) };
  }

  let adminUser = null;
  try {
    const users = await ctx.database.getAllUsers();
    adminUser = (users || []).find((u) => u.role === 'admin' && u.is_active === 1) || null;
  } catch {
    adminUser = null;
  }
  if (!adminUser) {
    return { ok: false, error: authError(50, 'User is not authorized for the given operation.') };
  }
  return { ok: true, user: adminUser };
}

// ---------------- 请求参数解析 ----------------

function getFormat(params) {
  const f = String(params.f || 'xml').toLowerCase();
  return f === 'json' ? 'json' : 'xml';
}

// ---------------- 响应包装 ----------------

function responseBase(status) {
  return {
    status,
    version: VERSION,
    type: TYPE,
    serverVersion: SERVER_VERSION,
    openSubsonic: true
  };
}

function success(params, key, value) {
  const res = responseBase('ok');
  if (key) res[key] = value;
  return res;
}

function failure(error) {
  const resp = responseBase('failed');
  resp.error = error;
  return resp;
}

// 递归剔除 null / undefined（规范要求实体字段无值时省略）。
// 注意：空字符串是合法值，不再剔除——否则 Lyrics.value 等必填字段会被错误丢弃。
function cleanNulls(value) {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const arr = value.map(cleanNulls).filter((v) => v !== undefined);
    return arr;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = cleanNulls(v);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return value;
}

// ==================== 列表类响应短缓存 ====================
// 箭头等客户端每次进页面会并发拉 getArtists / getAlbumList2 / getStarred2 /
// getPlaylists / search3(多种 order) 等，这些查询内容短时间内不变，却每次都要重跑
// runSearch + 序列化。命中缓存时直接复用序列化结果，连 handler 都不执行；客户端带
// If-None-Match 命中时直接 304，省掉整包传输。TTL 很短（默认 3s），实时性影响可忽略。
const restListCache = new Map();            // key -> { etag, body, ts }
const REST_LIST_TTL = Number(process.env.REST_LIST_TTL || 3000);
const REST_LIST_MAX_ENTRIES = 200;
// 列表分页上限：仅用于 getindexes/getalbumlist2 等非 search3 的分页列表接口。
// search3 为保持协议兼容已不做条数截断（改用软超时 + 大响应监控 + 日志告警防护）。
// 防止 songCount=10000 这类异常大请求撑爆内存与序列化开销；可通过 REST_LIST_PAGE_CAP 环境变量调整。
const REST_LIST_PAGE_CAP = parseInt(process.env.REST_LIST_PAGE_CAP, 10) || 500;
// search3 全库空查询（query 为空）软超时：内存遍历/排序 + 播放历史 DB 查询上限；超时返回标准错误。
// 注意：search3 已不做条数截断（协议兼容），此超时仅防止超大曲库把请求线程/序列化阻塞。
const SEARCH_FULL_LIBRARY_TIMEOUT_MS = parseInt(process.env.SEARCH_FULL_LIBRARY_TIMEOUT_MS, 10) || 2000;
// 列表类请求（非流媒体/封面）HTTP 处理超时：防止慢查询连接堆积（流媒体由客户端逐段读取，不设超时）
const REST_LIST_HTTP_TIMEOUT_MS = parseInt(process.env.REST_LIST_HTTP_TIMEOUT_MS, 10) || 15000;
// 对外响应是否携带 song.path（服务器文件系统绝对路径）。默认关闭：该字段既泄露宿主机目录结构
// （/app/music/...），又徒增体积；MusicHub 播放/封面/歌单均按 id 定位，标准客户端不需要它。
// 个别第三方客户端确需 path 时，设 REST_INCLUDE_PATH=1 重新开启。
const REST_INCLUDE_PATH = process.env.REST_INCLUDE_PATH === '1' || process.env.REST_INCLUDE_PATH === 'true';
const REST_LIST_CACHEABLE = new Set([
  'getindexes', 'getartists', 'getalbumlist2', 'getstarred2',
  'getplaylists', 'search3', 'getscanstatus', 'getgenres', 'getmusicfolders',
  'getinternetradiostations'
]);

function isCacheableList(method) {
  return REST_LIST_CACHEABLE.has(String(method || '').toLowerCase());
}

// 规范化缓存 key：方法 + 排序后的查询（去掉 c/v 等只影响协议包装、不影响内容的参数；
// 保留 u 以区分用户、f 以区分 json/xml 格式）
function listCacheKey(req, method) {
  const raw = req && (req.originalUrl || req.url) || '';
  const q = raw.split('?')[1] || '';
  const params = new URLSearchParams(q);
  ['c', 'v'].forEach((k) => params.delete(k));
  const canon = Array.from(params.entries()).sort().map(([k, v]) => `${k}=${v}`).join('&');
  return `${String(method || '').toLowerCase()}|${canon}`;
}

function pruneListCache(now = Date.now()) {
  for (const [k, v] of restListCache) {
    if (now - v.ts > REST_LIST_TTL) restListCache.delete(k);
  }
}

// 电台收藏变更后，使 getInternetRadioStations 的列表缓存整体失效（key 前缀一致）
function invalidateRadioStationCache() {
  for (const k of restListCache.keys()) {
    if (String(k).startsWith('getinternetradiostations')) restListCache.delete(k);
  }
}

// 收藏/播放统计变化后，使所有列表缓存失效（列表响应内的 song.starred/playCount 需要最新值）
function invalidateAllListCache() {
  restListCache.clear();
}

// 歌单歌曲变更后，使 getPlaylists 的列表缓存整体失效（否则卡片上的歌曲数量等仍显示旧值，
// 而详情 getPlaylist 不在列表缓存内因而实时正确，造成「卡片 N / 详情 N+1」的不一致）。
function invalidatePlaylistsListCache() {
  for (const k of restListCache.keys()) {
    if (String(k).startsWith('getplaylists')) restListCache.delete(k);
  }
}

// 弱 ETag（与 http-compression 中间件一致）：基于未压缩 body 的长度 + crc32
function listEtag(rawBody) {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(buf) : buf.length;
  return `W/"${buf.length.toString(16)}-${(crc >>> 0).toString(16)}"`;
}

function sendResponse(res, params, payload, ctx, method) {
  const format = getFormat(params);
  payload = cleanNulls(payload);
  const ct = format === 'json' ? 'application/json; charset=utf-8' : 'text/xml; charset=utf-8';
  res.set('Content-Type', ct);
  // 供请求摘要日志判定结果（ok / failed）
  try { res.locals = res.locals || {}; res.locals.restStatus = (payload && payload.status === 'ok') ? 'ok' : 'failed'; } catch { /* ignore */ }
  let rawBody = '';
  const alreadySent = res.headersSent;
  if (format === 'json') {
    const body = { 'subsonic-response': payload };
    rawBody = JSON.stringify(body);
    if (!alreadySent) res.json(body);
  } else {
    rawBody = xmlElement(payload);
    if (!alreadySent) res.send(rawBody);
  }
  // 请求后打印返回的原始数据（DEBUG 级别：LOG_LEVEL=info 时自动关闭，避免生产噪音）
  // 大响应（全量列表、长歌词）只记前 MAX_LOG_BODY 字符 + 总长度，避免日志文件/IO 被完整 body 撑爆
  if (ctx && ctx.logger && typeof ctx.logger.debug === 'function') {
    try {
      const MAX_LOG_BODY = 1024;
      const logged = rawBody.length > MAX_LOG_BODY
        ? `${rawBody.slice(0, MAX_LOG_BODY)}...[+${rawBody.length - MAX_LOG_BODY} chars, total ${rawBody.length}]`
        : rawBody;
      ctx.logger.debug('REST', 'opensubsonic', `raw response /rest/${method || '?'}`, { body: logged, bytes: rawBody.length });
      // 第三层防护：大 JSON 响应监控，识别超过 1MB 的响应（search3 空查询返回几千条 JSON 很容易突破）
      if (rawBody.length > 1024 * 1024) {
        ctx.logger.warn('REST', 'opensubsonic', `raw response 体积过大 (>1MB) /rest/${method || '?'}`, {
          bytes: rawBody.length, client: params && params.c
        });
      }
    } catch { /* 日志失败不影响响应 */ }
  }

  // 列表类成功响应写入短缓存，供后续相同请求（重进页面/刷新）复用，连 handler 都不必再执行
  if (params && params.user && method && isCacheableList(method) && payload && payload.status === 'ok' && params.__listKey) {
    try {
      restListCache.set(params.__listKey, { etag: listEtag(rawBody), body: rawBody, ts: Date.now() });
      if (restListCache.size > REST_LIST_MAX_ENTRIES) pruneListCache();
    } catch { /* 缓存失败不影响响应 */ }
  }
}

function xmlElement(payload) {
  // payload: { status, version, type, serverVersion, openSubsonic, ...extra }
  let children = '';
  for (const [k, v] of Object.entries(payload)) {
    if (['status', 'version', 'type', 'serverVersion', 'openSubsonic'].includes(k)) continue;
    if (v === null || v === undefined) continue;
    children += valueToXml(k, v);
  }
  return xml.element('subsonic-response', {
    status: payload.status,
    version: payload.version,
    type: payload.type,
    serverVersion: payload.serverVersion,
    openSubsonic: payload.openSubsonic
  }, children);
}

// 将 JSON 值渲染为 XML 片段（key 为元素名）
function valueToXml(key, value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') {
    return xml.element(key, {}, value ? 'true' : 'false');
  }
  if (typeof value === 'number') {
    return xml.element(key, {}, String(value));
  }
  if (typeof value === 'string') {
    // 字符串通常作为属性出现在实体内，但若是纯文本节点则按元素渲染
    return xml.element(key, {}, value);
  }
  if (Array.isArray(value)) {
    let out = '';
    for (const item of value) {
      out += valueToXml(key, item);
    }
    return out;
  }
  if (typeof value === 'object') {
    // 对象 → 元素：标量字段作为属性，数组/对象作为子元素
    const attrs = {};
    let children = '';
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
        attrs[k] = v;
      } else if (Array.isArray(v)) {
        children += valueToXml(k, v);
      } else if (typeof v === 'object') {
        children += valueToXml(k, v);
      }
    }
    return xml.element(key, attrs, children);
  }
  return '';
}

// ---------------- 实体渲染（JSON 形态） ----------------

function toArtistID3(artist) {
  const obj = { id: artist.id, name: artist.name };
  if (artist.coverArt) obj.coverArt = artist.coverArt;
  obj.albumCount = artist.albumIds ? artist.albumIds.size : 0;
  return obj;
}

function toArtist(artist) {
  // 旧版 Artist（getIndexes 使用）：规范字段仅 id/name 必填，其余可选
  return { id: artist.id, name: artist.name };
}

// 专辑 → Child 形态（getAlbumList 规范：albumList.album 是 Child 数组）
function toAlbumChild(album) {
  const obj = {
    id: album.id,
    parent: album.artistId,
    isDir: true,
    title: album.name
  };
  if (album.artist) obj.artist = album.artist;
  // 专辑封面统一用专辑自身 al- id 占位：客户端请求 getCoverArt(al-...) 时插件搜索封面
  // （不用内嵌封面，内嵌的是歌曲封面，与本地音乐页专辑封面逻辑一致）
  if (album.id && String(album.id).startsWith('al-')) obj.coverArt = album.id;
  else if (album.coverArt) obj.coverArt = album.coverArt;
  if (album.year) obj.year = album.year;
  if (album.genre) obj.genre = album.genre;
  obj.artistId = album.artistId;
  const dur = album.songIds.length ? sumDuration(album) : 0;
  if (dur) obj.duration = dur;
  obj.created = toIsoDate(album.created);
  return obj;
}

function toAlbumID3(album) {
  const obj = {
    id: album.id,
    name: album.name,
    artist: album.artist,
    artistId: album.artistId
  };
  // 专辑封面统一用专辑自身 al- id 占位：客户端请求 getCoverArt(al-...) 时插件搜索封面
  // （不用内嵌封面，内嵌的是歌曲封面，与本地音乐页专辑封面逻辑一致）
  if (album.id && String(album.id).startsWith('al-')) obj.coverArt = album.id;
  else if (album.coverArt) obj.coverArt = album.coverArt;
  // 私有扩展：若专辑对象携带真实封面 URL（如“最近播放”网络专辑），透传 coverUrl 供自家前端/Amcfy 加速；
  // 标准客户端忽略未知字段，不影响协议合规
  if (album.coverUrl) obj.coverUrl = album.coverUrl;
  obj.songCount = album.songIds.length;
  obj.duration = album.songIds.length ? sumDuration(album) : 0;
  obj.created = toIsoDate(album.created);
  if (album.year) obj.year = album.year;
  if (album.genre) obj.genre = album.genre;
  // 专辑级播放统计（AlbumID3 规范字段）：来自活动统计快照
  const _aAct = _songActivitySnapshot.albumMap.get(String(album.id));
  if (_aAct) {
    if (_aAct.playCount) obj.playCount = _aAct.playCount;
    if (_aAct.lastPlayed) obj.played = toIsoDate(_aAct.lastPlayed);
  }
  return obj;
}

function sumDuration(album) {
  let total = 0;
  for (const sid of album.songIds) {
    const song = getSourceSongById(sid);
    if (song && song.duration) total += song.duration;
  }
  return total;
}

/**
 * 将「数据库/网络歌单歌曲」解析回本地库歌曲（按 标题+艺术家 匹配）。
 * 本地库歌曲（已带 filePath）直接返回；匹配不到则返回原对象（无法播放，客户端端会跳过）。
 * 这是关键：播放列表返回的网络 music_id 无法定位本地文件，必须换成 tr- ID 才能 stream。
 */
function resolveLocalSong(song) {
  if (!song) return song;
  if (song.filePath && song.contentType) return song; // 已是本地库歌曲
  return getSourceSongByTitleArtist(song.title, song.artist) || song;
}

/**
 * 封面透传开关：默认开启（网络歌曲直接给外网原图 URL 作 coverUrl，客户端可用时直接加载，
 * 不再强制所有封面都经服务器 getCoverArt 代理下载）。本地歌曲/strm 一律不透传，
 * 仍走 getCoverArt 返回磁盘 WebP 缓存。需要关掉时置 ENABLE_COVER_URL_PASS_THROUGH=false。
 */
function coverUrlPassThroughEnabled() {
  const v = String(process.env.ENABLE_COVER_URL_PASS_THROUGH || '').trim().toLowerCase();
  return v !== 'false' && v !== '0';
}

/** COVER_DEBUG=true 时启用「封面透传排查」日志（限频，默认关闭，不会刷屏） */
function coverDebugEnabled() {
  return String(process.env.COVER_DEBUG || '').toLowerCase() === 'true';
}
const coverDebugState = { lastReset: 0, count: 0 };
function logCoverDebug(song, obj, remoteCover) {
  try {
    if (!coverDebugEnabled()) return;
    const now = Date.now();
    if (now - coverDebugState.lastReset > 60000) { coverDebugState.lastReset = now; coverDebugState.count = 0; }
    if (coverDebugState.count >= 10) return; // 每分钟最多 10 条
    coverDebugState.count++;
    logger.debug('REST', 'opensubsonic', '[cover-debug] toChild 完整song对象', {
      child: { id: obj.id, title: obj.title, coverArt: obj.coverArt || null, coverUrl: obj.coverUrl || null },
      song: typeof song === 'object' ? JSON.parse(JSON.stringify(song)) : song,
      passThrough: coverUrlPassThroughEnabled(),
      remoteCoverFound: remoteCover || null,
      isLocal: !!(song && (song.filePath || String(song.id || '').startsWith('tr-')))
    });
  } catch { /* 日志失败忽略 */ }
}

/** 从歌曲对象里取第一个可用的外网封面原图 URL（http/https），本地路径/data: 一律忽略 */
function remoteCoverUrlOf(song) {
  if (!song) return null;
  const candidates = [song.coverUrl, song.cover_art_url, song.artwork, song.cover, song.pic, song.image];
  for (const v of candidates) {
    const s = String(v || '').trim();
    if (/^https?:\/\//i.test(s)) return s;
  }
  return null;
}

// ---------------- 歌曲活动统计快照（playCount/played/starred/bookmarkPosition 接入 toChild） ----------------
// 懒加载 + 60s TTL；scrobble/star/unstar/bookmark 写操作后置脏，下一次请求重建。
let _songActivitySnapshot = { map: new Map(), starred: new Map(), bookmarks: new Map(), loadedAt: 0, userId: null };
const SONG_ACTIVITY_TTL = 60 * 1000;

async function ensureSongActivitySnapshot(ctx, userId) {
  const uid = String(userId == null ? 0 : userId);
  if (_songActivitySnapshot.userId === uid && Date.now() - _songActivitySnapshot.loadedAt < SONG_ACTIVITY_TTL) return;
  try {
    const [act, starred, albumAct] = await Promise.all([
      loadSongActivity(ctx, uid),
      loadStarredSongs(ctx, uid),
      loadAlbumActivity(ctx, uid)
    ]);
    const bmap = loadBookmarks()[uid] || {};
    _songActivitySnapshot = {
      map: act,
      starred,
      albumMap: albumAct,
      bookmarks: new Map(Object.entries(bmap).map(([id, b]) => [id, Number(b && b.position) || 0])),
      loadedAt: Date.now(),
      userId: uid
    };
  } catch { /* 加载失败保持旧快照 */ }
}

function toChild(song, opts = {}) {
  song = resolveLocalSong(song);
  const obj = {
    id: song.id,
    parent: song.albumId,
    isDir: false,
    title: song.title
  };
  if (song.album) obj.album = song.album;
  if (song.artist) obj.artist = song.artist;
  if (song.track) obj.track = song.track;
  // 歌单序号：在 resolveLocalSong 之后强制写入，避免被本地库歌曲对象覆盖丢失
  if (opts.track != null) obj.track = opts.track;
  if (song.year) obj.year = song.year;
  if (song.genre) obj.genre = song.genre;
  if (song.coverArt) obj.coverArt = song.coverArt;
  // 本地歌：仅当确有封面（内嵌 hasCover 或已落盘 coverRelpath）时才用自身 tr- id 作封面 id，
  // 否则不广告 coverArt，避免 getCoverArt(tr-...) 因无封面而 404（Subsonic 规范：无封面即不返回 coverArt）。
  else if (song.filePath && (song.hasCover || song.coverRelpath)) obj.coverArt = song.id;
  // 网络歌曲（数据库无封面字段但有外网封面）：用自身 id 作为封面 id，走 getCoverArt 网络代理
  else if (song.artwork || song.cover || song.pic || song.image || song.coverUrl) obj.coverArt = song.id;
  // 兜底：纯插件网络歌曲（无 filePath、非 tr-）统一用自身 id 作封面占位，
  // 让 getCoverArt(id) 走插件/网络回退（与封面透传 coverUrl 互补，部分客户端只认 coverArt id）
  else if (!song.filePath && !String(song.id || '').startsWith('tr-')) obj.coverArt = song.id;
  // 封面透传已关闭：列表/歌单/单曲接口一律只输出虚拟封面 ID（coverArt），
  // 真实封面由客户端统一经 /rest/getCoverArt 实时向插件获取，绝不把时效性外网地址写进 JSON。
  let passCover = null;
  // 排查：COVER_DEBUG=true 时打印完整 song 对象 + 是否输出 coverUrl（限频 10 条/分钟）
  logCoverDebug(song, obj, passCover);
  // 用户评分（ratings 表，keyed by 对外 id）
  if (opts.ratings && opts.ratings.has(obj.id)) obj.userRating = opts.ratings.get(obj.id);
  if (song.size) obj.size = song.size;
  if (song.suffix) obj.suffix = song.suffix;
  if (song.contentType) obj.contentType = song.contentType;
  if (song.duration) obj.duration = Number(song.duration);
  if (song.bitRate) obj.bitRate = song.bitRate;
  if (REST_INCLUDE_PATH && song.filePath) obj.path = song.filePath;
  // 播放统计 / 收藏时间 / 书签位置：来自活动统计快照（ensureSongActivitySnapshot 预加载）
  const _snap = _songActivitySnapshot;
  const _act = _snap.map.get(String(song.id));
  if (_act) {
    if (_act.playCount) obj.playCount = _act.playCount;
    if (_act.lastPlayed) obj.played = toIsoDate(_act.lastPlayed);
  }
  const _starredAt = _snap.starred.get(String(song.id));
  if (_starredAt) obj.starred = toIsoDate(_starredAt);
  const _bmPos = _snap.bookmarks.get(String(song.id));
  if (_bmPos) obj.bookmarkPosition = _bmPos;
  // ReplayGain 轨道增益（dB）：本地歌曲 enrich 时从音频标签读取（有标签才有值）
  if (song.replayGain != null) obj.replayGain = Number(song.replayGain);
  if (obj.userRating) obj.averageRating = obj.userRating;
  obj.mediaType = 'song';
  obj.albumId = song.albumId;
  obj.artistId = song.artistId;
  // 插件网络音源：本地库/业务表常缺 albumId/artistId，按适配器既有约定合成虚拟 id
  // （ar-<md5(歌手)> / al-<md5(歌手|专辑)>），保证客户端可跳转专辑/歌手页（与收藏/最近播放一致）。
  const isNetworkSong = !song.filePath && !String(song.id || '').startsWith('tr-');
  if (isNetworkSong) {
    if (!obj.artistId && song.artist) obj.artistId = 'ar-' + md5Hex(song.artist);
    if (!obj.albumId && song.album && song.artist) obj.albumId = 'al-' + md5Hex(song.artist + '|' + song.album);
    // 音频格式信息：网络歌曲经 307 直连第三方音源（mp3），本地库无元数据。
    // 不补默认值会导致 Subsonic 客户端（音流等）显示音频格式 unknown。
    if (!obj.contentType) obj.contentType = 'audio/mpeg';
    if (!obj.suffix) obj.suffix = 'mp3';
    if (!obj.bitRate) obj.bitRate = 320;
  }
  obj.type = 'music';
  obj.isVideo = false;
  if (song.mtimeMs) obj.created = toIsoDate(song.mtimeMs);
  return obj;
}

// ---------------- 专辑列表核心 ----------------

/**
 * 统计当前用户播放历史（按本地专辑聚合）。
 * 返回 Map<albumId, { playCount, lastPlayed }>；数据库不可用时返回空 Map。
 */
async function loadAlbumActivity(ctx, userId) {
  const stats = new Map();
  if (!ctx || !ctx.database) return stats;
  let plays = [];
  try {
    plays = await ctx.database.getUserPlayHistory(userId, 100000, 0);
  } catch {
    plays = [];
  }
  for (const row of plays) {
    const song = getSourceSongByTitleArtist(row.title, row.artist);
    if (!song) continue;
    const st = stats.get(song.albumId) || { playCount: 0, lastPlayed: 0 };
    st.playCount += Number(row.playCount) || 1;
    const at = Number(row.playedAt) || 0;
    if (at > st.lastPlayed) st.lastPlayed = at;
    stats.set(song.albumId, st);
  }
  return stats;
}

/**
 * 统计当前用户收藏（按本地专辑聚合，取最近收藏时间）。
 * 返回 Map<albumId, starredAt>；数据库不可用时返回空 Map。
 */
async function loadStarredAlbums(ctx, userId) {
  const starred = new Map();
  if (!ctx || !ctx.database) return starred;
  let favs = [];
  try {
    favs = await ctx.database.getUserFavorites(userId);
  } catch {
    favs = [];
  }
  for (const row of favs) {
    const song = getSourceSongByTitleArtist(row.title, row.artist);
    if (!song) continue;
    const at = Number(row.addedAt) || 0;
    if (!starred.has(song.albumId) || at > starred.get(song.albumId)) starred.set(song.albumId, at);
  }
  return starred;
}

// ---------------- 歌曲级活动统计（search order/by 用） ----------------

// 歌曲级播放统计：Map<songId, { playCount, lastPlayed }>；数据库不可用时返回空 Map
async function loadSongActivity(ctx, userId) {
  const stats = new Map();
  if (!ctx || !ctx.database) return stats;
  let plays = [];
  try {
    plays = await ctx.database.getUserPlayHistory(userId, 100000, 0);
  } catch {
    plays = [];
  }
  const merge = (key, pc, at) => {
    const st = stats.get(key) || { playCount: 0, lastPlayed: 0 };
    st.playCount += pc;
    if (at > st.lastPlayed) st.lastPlayed = at;
    stats.set(key, st);
  };
  for (const row of plays) {
    if (!row || !row.id) continue;
    const at = Number(row.playedAt) || 0;
    const pc = Number(row.playCount) || 1;
    // 键 1：播放记录自身的 music_id —— search3 最近播放（playDate）按记录 id 排序必须命中；
    // 否则网络歌曲（非本地库，title/artist 查不到源歌曲）会被当成 lastPlayed=0 排到列表末尾。
    merge(row.id, pc, at);
    // 键 2：本地库源歌曲 id —— search2 / topSongs 按本地歌曲（tr- 源 id）排序时命中
    const src = getSourceSongByTitleArtist(row.title, row.artist);
    if (src && src.id && src.id !== row.id) merge(src.id, pc, at);
    // 键 3：收藏/歌单侧的虚拟 ID（row.musicId，如 tr-<md5>）—— 列表 song.id 用该形态时必须命中
    if (row.musicId && String(row.musicId) !== String(row.id)) merge(row.musicId, pc, at);
  }
  return stats;
}

// 歌曲级收藏统计：Map<songId, starredAt>；数据库不可用时返回空 Map
async function loadStarredSongs(ctx, userId) {
  const starred = new Map();
  if (!ctx || !ctx.database) return starred;
  let favs = [];
  try {
    favs = await ctx.database.getUserFavorites(userId);
  } catch {
    favs = [];
  }
  for (const row of favs) {
    const at = Number(row.addedAt) || 0;
    // ① 标题+歌手匹配内存源歌曲（本地库聚合键）
    const song = getSourceSongByTitleArtist(row.title, row.artist);
    if (song) {
      if (!starred.has(song.id) || at > starred.get(song.id)) starred.set(song.id, at);
    }
    // ② 直接用收藏记录自身的音乐 ID（favorites.song_id：本地 tr-<md5> / 网络 musicId）。
    //    标题清洗差异（括号/后缀/大小写）会导致①匹配失败 → 红心字段丢失（客户端不显示红星）。
    const directId = (row.id != null && row.id !== '') ? String(row.id) : null;
    if (directId && (!starred.has(directId) || at > starred.get(directId))) starred.set(directId, at);
  }
  return starred;
}

// 加载用户评分：Map<mediaId, rating>；数据库不可用时返回空 Map
async function loadUserRatings(ctx, userId) {
  const map = new Map();
  if (!ctx || !ctx.database) return map;
  try {
    return await ctx.database.getUserRatings(userId) || map;
  } catch {
    return map;
  }
}

// 将 OpenSubsonic 歌曲 id 解析为数据库歌曲对象（{id:music_id, title, artist, plugin, ...}）；
// 解析不到返回 null。tr- 本地 id 按标题/艺术家回退查网络记录。
async function dbSongForId(ctx, id) {
  const str = String(id || '');
  if (!str) return null;
  if (!ctx || !ctx.database) return null;
  if (str.startsWith('tr-')) {
    // 本地歌曲：直接以本地对象入库，保证以 tr- 本地 id 存储并可走本地播放。
    // 解析顺序：① 内存本地库（OpenSubsonic 索引）② 持久化 local_songs 表兜底
    // （覆盖 REST 进程本地库尚未扫描 / 重扫导致内存库缺失，但服务端曾给出该 tr- id 的场景）。
    let local = getSourceSongById(str);
    if (!local || !local.title) {
      try { local = await localMusic.getLocalSongByIdResolved(str); } catch { local = null; }
    }
    logger.debug('REST', 'opensubsonic', '[add-debug] tr 解析', { str, found: !!local, hasTitle: !!(local && local.title), filePath: local && local.filePath });
    if (local && local.title) {
      // OpenSubsonic 索引的本地歌曲对象可能不带 plugin，补 'local' 避免入库时被误判为网络虚拟 ID
      return local.plugin ? local : { ...local, plugin: 'local' };
    }
    return null;
  }
  try {
    // 同一 raw id 在 songs 缓存可能有多行（旧插件名残留）：优先取「插件当前真实存在」的行，
    // 否则 scrobble/stream 会把已卸载插件名写进播放历史，web 播放时报「缺少 platform 字段」
    let validator;
    try {
      if (typeof ctx.listPluginNames === 'function') {
        const names = new Set(ctx.listPluginNames());
        validator = (p) => names.has(String(p)) || names.has(String(p).replace(/\.js$/i, ''));
      }
    } catch { validator = undefined; }
    const dbSong = await ctx.database.getSongByMusicIdAny(str, validator ? { isPluginValid: validator } : undefined);
    if (dbSong) return dbSong;
  } catch { /* ignore */ }
  // 动态歌单（实时榜单/热门歌单）的歌曲不入库：从实时拉取的内存索引兜底
  return livePlaylistSongIndex.get(str) || null;
}

// 按 order/by 排序歌曲。order 支持：playDate/played、playCount/frequent、starred、random、
// album、artist、year、duration、lastModified/created；未指定或未知 order 保持原始顺序。
function sortSongs(songs, order, by, songActivity, starredSongs) {
  const dir = String(by || 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
  const list = songs.slice();
  switch (String(order || '').toLowerCase()) {
    case 'playdate':
    case 'played':
      list.sort((a, b) => dir * (((songActivity.get(a.id) || {}).lastPlayed || 0) - ((songActivity.get(b.id) || {}).lastPlayed || 0)));
      break;
    case 'playcount':
    case 'frequent':
      list.sort((a, b) => dir * (((songActivity.get(a.id) || {}).playCount || 0) - ((songActivity.get(b.id) || {}).playCount || 0)));
      break;
    case 'starred':
      list.sort((a, b) => dir * (((starredSongs.get(a.id)) || 0) - ((starredSongs.get(b.id)) || 0)));
      break;
    case 'random':
      list.sort(() => Math.random() - 0.5);
      break;
    case 'album':
      list.sort((a, b) => dir * (a.album || '').localeCompare(b.album || '', 'zh-Hans-CN'));
      break;
    case 'artist':
      list.sort((a, b) => dir * (a.artist || '').localeCompare(b.artist || '', 'zh-Hans-CN'));
      break;
    case 'year':
      list.sort((a, b) => dir * ((a.year || 0) - (b.year || 0)));
      break;
    case 'duration':
      list.sort((a, b) => dir * ((a.duration || 0) - (b.duration || 0)));
      break;
    case 'lastmodified':
    case 'created':
      list.sort((a, b) => dir * ((a.mtimeMs || 0) - (b.mtimeMs || 0)));
      break;
    default:
      // 未指定/未知 order：保持原始顺序
      break;
  }
  return list;
}

async function buildAlbumList(params, allAlbums, ctx, userId) {
  const size = intVal(params.size, 10);
  const offset = intVal(params.offset, 0);
  const type = String(params.type || 'random');
  let albums = allAlbums;

  switch (type) {
    case 'newest':
      // 全部 created 相同时（本地扫描统一写入 Date.now()）按 中文歌手在前/英文在后 兜底排序
      albums = albums.slice().sort((a, b) => (b.created || 0) - (a.created || 0) || langSortAlbums(a, b));
      break;
    case 'alphabeticalByName':
      albums = albums.slice().sort((a, b) => {
        const ra = langRank(a.name || '');
        const rb = langRank(b.name || '');
        return (ra - rb) || (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN');
      });
      break;
    case 'alphabeticalByArtist':
      albums = albums.slice().sort(langSortAlbums);
      break;
    case 'starred': {
      // 星标：专辑内任一歌曲被收藏，按最近收藏时间倒序
      const starred = await loadStarredAlbums(ctx, userId);
      albums = albums.filter((a) => starred.has(a.id))
        .sort((a, b) => (starred.get(b.id) || 0) - (starred.get(a.id) || 0));
      break;
    }
    case 'frequent':
    case 'highest': {
      // 经常播放：专辑内歌曲累计播放次数倒序；评分最高：项目无评分，按播放次数代理
      const stats = await loadAlbumActivity(ctx, userId);
      albums = albums.filter((a) => stats.has(a.id))
        .sort((a, b) => (stats.get(b.id).playCount || 0) - (stats.get(a.id).playCount || 0));
      break;
    }
    case 'recent': {
      // 最新播放：基于播放历史，聚合最近播放的专辑（本地库 + 网络歌曲专辑）
      albums = await getRecentlyPlayedAlbums(ctx, userId);
      break;
    }
    case 'byYear': {
      const fromYear = intVal(params.fromYear, 0);
      const toYear = intVal(params.toYear, 3000);
      const reversed = fromYear > toYear;
      const lo = Math.min(fromYear, toYear);
      const hi = Math.max(fromYear, toYear);
      albums = albums.filter((a) => a.year && a.year >= lo && a.year <= hi)
        .sort((a, b) => (a.year || 0) - (b.year || 0));
      if (reversed) albums.reverse();
      break;
    }
    case 'byGenre': {
      const mg = params.genre ? String(params.genre) : '';
      albums = albums.filter((a) => a.genre && a.genre.toLowerCase() === mg.toLowerCase());
      break;
    }
    case 'random':
    default:
      albums = albums.slice().sort(() => Math.random() - 0.5);
      break;
  }

  return albums.slice(offset, offset + size);
}

function albumWithSongs(album, ratings) {
  const obj = toAlbumID3(album);
  obj.song = album.songIds.map((sid) => {
    const s = getSourceSongById(sid);
    return s ? toChild(s, { ratings }) : null;
  }).filter(Boolean);
  return obj;
}

// ---------------- 播放列表核心 ----------------

function toPlaylist(pl) {
  const obj = {
    id: String(pl.id),
    name: pl.name,
    owner: pl.owner || 'admin',
    public: pl.isPublic ? true : false
  };
  if (pl.comment) obj.comment = pl.comment;
  obj.songCount = pl.songs ? Number(pl.songs.length) : 0;
  obj.duration = pl.songs ? pl.songs.reduce((acc, s) => acc + (Number(s.duration) || 0), 0) : 0;
  // 兼容数据库 camelCase / snake_case 两种字段名；Playlist 规范要求 created/changed 必填，
  // 数据库缺值时兜底为当前时间，避免响应缺失必填字段
  const fallbackTs = Date.now();
  const created = toIsoDate(pl.created || pl.created_at || pl.createdAt) || toIsoDate(fallbackTs);
  const changed = toIsoDate(pl.changed || pl.updated_at || pl.updatedAt || pl.created_at || pl.createdAt) || created;
  obj.created = created;
  obj.changed = changed;
  // 规范 Playlist.coverArt 为封面 ID；歌单存有封面 URL 时用自身 id 作为 coverArt，
  // 客户端通过 getCoverArt?id=<playlistId> 拉取（后端按歌单封面 URL 代理）
  if (pl.cover) obj.coverArt = String(pl.id);
  return obj;
}

//====================================================================
// 端点处理
//====================================================================

async function handlePing(params, _ctx) {
  return success(params, null, null);
}

// getLicense：本项目无授权限制，始终返回有效许可证（客户端登录时常校验）
async function handleGetLicense(params, _ctx) {
  return success(params, 'license', { valid: true, email: (params.user && params.user.username) || '' });
}

async function handleGetMusicFolders(params, _ctx) {
  return success(params, 'musicFolders', {
    musicFolder: [{ id: MUSIC_FOLDER_ID, name: 'Music' }]
  });
}

// getArtists / getIndexes 预计算缓存：
// 扫描完成后一次性生成完整的歌手分组 index 存内存，后续所有请求直接返回，避免每次请求
// 遍历全部歌手做拼音分组（ICU localeCompare 开销大）。仅当来源元数据变化（重扫）时重建。
// getIndexes 使用 legacy 序列化（index[].artist 为旧版 Artist，仅 id/name），兼容老客户端。
let artistsIndexCache = null;
let artistsIndexSig = null; // 缓存的来源签名

// 来源签名：当前激活的数据源（本地音乐 / 下载目录库）+ 歌手数 + 最近扫描时间。
// 任何元数据变更（含重扫、开机数据库加载）都会更新 lastModified，从而失效缓存。
function artistsSourceSig() {
  let name = 'lib';
  let lastModified = library.getLastModified();
  if (localMusic && typeof localMusic.getOpenSubsonicLibrary === 'function') {
    try {
      const lib = localMusic.getOpenSubsonicLibrary();
      if (lib && lib.songs && lib.songs.length) {
        name = 'local';
        lastModified = localMusic.getLastModified();
      }
    } catch { /* 本地音乐不可用则回退下载目录库 */ }
  }
  return `${name}:${sourceArtists().length}:${lastModified}`;
}

function getCachedArtistsIndexes() {
  const sig = artistsSourceSig();
  if (artistsIndexCache && artistsIndexSig === sig) return artistsIndexCache;
  const artists = sourceArtists();
  artistsIndexCache = {
    // getArtists：歌手封面统一走插件搜索，coverArt 用 ar- id 占位
    modern: groupArtists(artists.map((a) => ({ ...a, coverArt: a.id })), false),
    // getIndexes：legacy 序列化（toArtist）
    legacy: groupArtists(artists, true)
  };
  artistsIndexSig = sig;
  return artistsIndexCache;
}

async function handleGetIndexes(params, _ctx) {
  const indexes = getCachedArtistsIndexes().legacy;
  return success(params, 'indexes', {
    ignoredArticles: 'The El La Los Las Le Les Os As O A',
    lastModified: (localMusic && typeof localMusic.getLastModified === 'function')
      ? localMusic.getLastModified()
      : library.getLastModified(),
    index: indexes
  });
}

// 读取用户收藏（favorites 表），兼容 admin(0) 兜底
async function loadFavorites(ctx, userId) {
  let favorites = [];
  try { favorites = await ctx.database.getUserFavorites(userId); } catch { favorites = []; }
  if (favorites.length === 0 && userId !== 0) {
    try { favorites = await ctx.database.getUserFavorites(0); } catch { favorites = []; }
  }
  return favorites;
}

function md5Hex(str) {
  return crypto.createHash('md5').update(String(str)).digest('hex');
}

// 清洗封面/图片 URL：去掉包裹的反引号与首尾空白，返回合法 http(s) URL 或 null。
// 插件数据/存储的历史脏数据里封面 URL 可能被反引号包住，导致客户端无法使用、代理 404。
function cleanCoverUrl(u) {
  if (!u) return null;
  const s = String(u).replace(/^`+|`+$/g, '').trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

// 通用：把歌曲列表按歌手名分组为艺术家实体（本地库优先，网络歌手合成 ar-<md5>）
function groupArtistsFromSongs(songs) {
  const map = new Map(); // artistName -> { id, name, albumIds, albums }
  for (const song of songs) {
    const artistName = String(song.artist || '未知歌手');
    let entry = map.get(artistName);
    if (!entry) {
      const local = sourceArtists().find((a) => a.name === artistName);
      entry = {
        id: local ? local.id : 'ar-' + md5Hex(artistName),
        name: artistName,
        albumIds: new Set(),
        albums: new Map(), // albumName -> { id, name, artist, artistId, cover, favs: [] }
        coverArt: null,
        _fallbackCover: null, // 无歌手头像时的兜底封面（取首个歌曲封面）
        _plugin: null // 来源插件（用于插件搜索歌手头像）
      };
      // 封面策略：本地歌手有内嵌封面用本地封面（ca- 走本地库）；否则用 ar-<md5> 让 getCoverArt 走插件头像
      if (local && local.coverArt) entry.coverArt = local.coverArt;
      else entry.coverArt = entry.id;
      map.set(artistName, entry);
    }
    if (!entry._plugin && (song.plugin || song.platform || song.source)) {
      entry._plugin = song.plugin || song.platform || song.source;
    }
    if (!entry._fallbackCover) {
      entry._fallbackCover = cleanCoverUrl(song.artwork || song.cover || song.pic);
    }
    const albumName = String(song.album || '');
    if (!entry.albums.has(albumName)) {
      entry.albums.set(albumName, {
        id: 'al-' + md5Hex(artistName + '|' + albumName),
        name: albumName,
        artist: artistName,
        artistId: entry.id,
        cover: cleanCoverUrl(song.artwork || song.cover || song.pic),
        favs: []
      });
    }
    entry.albums.get(albumName).favs.push(song);
    entry.albumIds.add(albumName);
  }
  return Array.from(map.values());
}

// 从收藏（favorites 表）反推收藏的艺术家
async function getFavoritedArtists(ctx, userId) {
  const favorites = await loadFavorites(ctx, userId);
  return groupArtistsFromSongs(favorites);
}

// 从播放历史（play_history）反推最近播放的艺术家
async function getRecentlyPlayedArtists(ctx, userId) {
  let history = [];
  try { history = await ctx.database.getUserPlayHistory(userId, 500, 0); } catch { history = []; }
  if (history.length === 0 && userId !== 0) {
    try { history = await ctx.database.getUserPlayHistory(0, 500, 0); } catch { history = []; }
  }
  return groupArtistsFromSongs(history);
}

// 从播放历史（play_history）聚合最近播放的专辑：
// 本地库专辑用真实 al- ID（songCount/duration 取本地专辑全量），网络歌曲专辑用合成 al-<md5(歌手|专辑)>。
// 按最近播放时间倒序，供 getAlbumList2 type=recent 使用（与 getArtists 同源的播放历史）。
async function getRecentlyPlayedAlbums(ctx, userId) {
  const map = new Map();
  let history = [];
  try { history = await ctx.database.getUserPlayHistory(userId, 500, 0); } catch { history = []; }
  if (history.length === 0 && userId !== 0) {
    try { history = await ctx.database.getUserPlayHistory(0, 500, 0); } catch { history = []; }
  }
  const allAlbums = sourceAlbums();
  for (const song of history) {
    const artistName = String(song.artist || '未知歌手');
    const albumName = String(song.album || '');
    const local = getSourceSongByTitleArtist(song.title, song.artist);
    const localAlbum = local
      ? allAlbums.find((a) => a.id === local.albumId || a.songIds.includes(local.id))
      : null;
    const key = localAlbum ? localAlbum.id : 'al-' + md5Hex(artistName + '|' + albumName);
    let entry = map.get(key);
    if (!entry) {
      entry = {
        id: key,
        name: localAlbum ? localAlbum.name : albumName,
        artist: localAlbum ? localAlbum.artist : artistName,
        artistId: localAlbum ? localAlbum.artistId : 'ar-' + md5Hex(artistName),
        songIds: localAlbum ? localAlbum.songIds.slice() : [],
        year: localAlbum ? localAlbum.year : 0,
        genre: localAlbum ? localAlbum.genre : '',
        coverArt: null,
        created: 0,
        _lastPlayed: 0
      };
      // coverArt 严格只放虚拟 ID（al-xxx），符合 OpenSubsonic 协议，绝不把真实 URL 写进标准字段；
      // 真实图片 URL 放到私有 coverUrl，自家前端/Amcfy 优先读加速，其他标准客户端自动忽略
      entry.coverArt = key;
      const realCover = cleanCoverUrl(song.artwork || song.cover || song.pic);
      if (realCover) entry.coverUrl = realCover;
      map.set(key, entry);
    }
    const at = Number(song.playedAt) || 0;
    if (at > entry._lastPlayed) entry._lastPlayed = at;
    if (at > (Number(entry.created) || 0)) entry.created = at;
  }
  return Array.from(map.values()).sort((a, b) => b._lastPlayed - a._lastPlayed);
}

async function handleGetArtists(params, ctx) {
  // 返回本地音乐（/app/music）中的歌手；最近播放/收藏分别由
  // getAlbumList2 type=recent 与 getStarred2.artist 提供。
  // 歌手封面统一走插件搜索（与本地音乐页一致，不用内嵌封面）：
  // coverArt 用 ar- id 作为占位，客户端请求 getCoverArt(ar-...) 时插件搜索头像。
  // 完整分组 index 已预计算并缓存（见 getCachedArtistsIndexes），此处直接返回，不做实时遍历组装。
  return success(params, 'artists', { index: getCachedArtistsIndexes().modern });
}

// 封面搜索结果缓存 TTL（6h）
const ARTIST_AVATAR_TTL = 6 * 60 * 60 * 1000;

// 从插件 search(type=song) 结果中提取封面 URL（歌曲封面字段优先 artwork/pic，兼容对象形态）
function extractSongCover(result) {
  try {
    let list = result;
    if (result && Array.isArray(result.data)) list = result.data;
    else if (result && result.body && Array.isArray(result.body.data)) list = result.body.data;
    else if (!Array.isArray(list)) return null;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      for (const f of ['artwork', 'pic', 'coverArt', 'cover', 'coverUrl', 'image', 'img', 'albumArt']) {
        const v = item[f];
        if (typeof v === 'string' && (/^https?:\/\//i.test(v) || /^data:image\//i.test(v))) return v;
        if (typeof v === 'object' && v && typeof v.url === 'string' && /^https?:\/\//i.test(v.url)) return v.url;
      }
    }
    return null;
  } catch { /* ignore */ }
  return null;
}

// 构建插件候选列表（去重）：来源插件 → 默认插件 → 全部已装插件
function collectPluginCandidates(ctx, pluginHint) {
  const tried = new Set();
  const files = [];
  const push = (name) => {
    if (!name) return;
    name = String(name);
    if (tried.has(name) || tried.has(name.replace(/\.js$/, ''))) return;
    tried.add(name);
    files.push(name);
  };
  push(pluginHint);
  if (typeof ctx.getDefaultPlugin === 'function') {
    try { push(ctx.getDefaultPlugin()); } catch { /* ignore */ }
  }
  if (ctx.PLUGINS_DIR && fs.existsSync(ctx.PLUGINS_DIR)) {
    const names = typeof ctx.listPluginNames === 'function'
      ? ctx.listPluginNames(ctx.PLUGINS_DIR)
      : fs.readdirSync(ctx.PLUGINS_DIR).filter((n) => n.endsWith('.js'));
    for (const n of names) push(n);
  }
  return files;
}

// 歌曲封面缓存（6h）：artistName|title -> { url, ts }
// 上限 2000：key 由歌曲内容驱动无界增长，此前只判读 TTL 从不删除，长期运行条目不可控
const songCoverCache = new Map();
const SONG_COVER_CACHE_MAX = 2000;

/** 写入 songCoverCache 并维护容量：超限按 ts 淘汰最旧，顺手清掉已过期条目 */
function setSongCoverCache(key, value) {
  songCoverCache.set(key, value);
  const now = Date.now();
  for (const [k, v] of songCoverCache) {
    if (now - v.ts >= ARTIST_AVATAR_TTL) songCoverCache.delete(k);
  }
  while (songCoverCache.size > SONG_COVER_CACHE_MAX) {
    let oldestKey = null, oldestTs = Infinity;
    for (const [k, v] of songCoverCache) { if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; } }
    if (oldestKey == null) break;
    songCoverCache.delete(oldestKey);
  }
}

/** 读取已配置的「歌词/封面」搜索插件列表（按设置顺序，最多 3 个）；未配置返回空数组 */
function configuredSearchPlugins(listKey, legacyKey) {
  try {
    const arr = config.getConfigSetting(listKey);
    if (Array.isArray(arr)) return arr.map((p) => String(p).trim()).filter(Boolean).slice(0, 3);
    if (legacyKey) {
      const legacy = String(config.getConfigSetting(legacyKey) || '').trim();
      if (legacy) return [legacy];
    }
  } catch { /* 配置读取失败按未配置处理 */ }
  return [];
}

// 用插件搜索歌曲获取封面（带 6h 缓存）。查询串优先「歌手 歌名」，失败再退「歌名」。
// 搜索类型：先 song，多数插件仅支持 music 时回落（与本地音乐页 searchMatch 一致）。
// 候选插件：只允许「封面搜索插件」配置里的插件；未配置 → 不搜索（绝不遍历全部插件）。
async function fetchSongCoverByPlugin(ctx, title, artist) {
  if (!ctx || typeof ctx.runPlugin !== 'function' || !title) return null;
  const key = String(artist || '') + '|' + String(title);
  const cached = songCoverCache.get(key);
  if (cached && Date.now() - cached.ts < ARTIST_AVATAR_TTL) return cached.url;
  const userVars = (ctx.userConfigs && ctx.userConfigs.default) || {};
  const cfgCovers = configuredSearchPlugins('cover_plugins', '');
  if (!cfgCovers.length) return null; // 未配置封面插件：停止搜索
  const candidates = cfgCovers;
  const queries = [];
  if (artist) queries.push(String(artist) + ' ' + String(title));
  queries.push(String(title));
  for (const type of ['song', 'music']) {
    for (const p of candidates) {
      for (const q of queries) {
        try {
          const result = await ctx.runPlugin(p, 'search', [q, 1, type], userVars, ctx.PLUGINS_DIR);
          const url = extractSongCover(result);
          if (url) {
            setSongCoverCache(key, { url, ts: Date.now() });
            return url;
          }
        } catch { /* 跳过不支持歌曲搜索或调用失败的插件 */ }
      }
    }
  }
  return null;
}

// 补全网络歌曲信息：DB 记录字段不完整（如弥音QQ 缺 songmid）导致播放解析失败时，
// 用插件 search 按歌名/歌手重新取一份完整歌曲数据，用于重试 getMediaSource。
// 优先 id 精确匹配，其次取首个结果；来源插件 → 默认插件 → 全部已装插件依次尝试。
async function enrichNetworkSongByPlugin(ctx, song) {
  if (!ctx || typeof ctx.runPlugin !== 'function' || !song || !song.title) return null;
  const userVars = (ctx.userConfigs && ctx.userConfigs.default) || {};
  const queries = [];
  if (song.artist) queries.push(String(song.artist) + ' ' + String(song.title));
  queries.push(String(song.title));
  for (const p of collectPluginCandidates(ctx, song.plugin || song.platform || song.source)) {
    for (const q of queries) {
      try {
        const result = await ctx.runPlugin(p, 'search', [q, 1, 'music'], userVars, ctx.PLUGINS_DIR);
        const items = Array.isArray(result) ? result : (result && Array.isArray(result.data) ? result.data : null);
        if (!items || !items.length) continue;
        let hit = items.find((it) => it && String(it.id) === String(song.id)) || items[0];
        if (!hit || typeof hit !== 'object') continue;
        return { ...song, ...hit, id: hit.id, plugin: p };
      } catch { /* 跳过不支持搜索或调用失败的插件 */ }
    }
  }
  return null;
}

// getSong 网络歌曲补全结果缓存 + 超时保护（稳定性隐性风险：第三方插件慢/限流会拖垮 getSong）。
// 缓存命中直接返回，避免每次 getSong 都打插件；插件调用加 5s 超时，超时即放弃补全（不影响播放返回）。
const songEnrichCache = new Map();
const SONG_ENRICH_TTL = 30 * 60 * 1000; // 30 分钟
const SONG_ENRICH_TIMEOUT = 5000;        // 插件补全最多 5s

async function enrichWithTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('enrich timeout')), ms);
  });
  if (typeof timeout.unref === 'function') timeout.unref();
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function enrichNetworkSongByPluginCached(ctx, song) {
  if (!ctx || !song || !song.id) return null;
  const cacheKey = `${String(song.plugin || song.platform || song.source || '')}:${String(song.id)}`;
  const cached = songEnrichCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SONG_ENRICH_TTL) {
    return cached.value;
  }
  let result = null;
  try {
    result = await enrichWithTimeout(enrichNetworkSongByPlugin(ctx, song), SONG_ENRICH_TIMEOUT);
  } catch {
    result = null; // 超时/异常：放弃补全，不影响 getSong 返回
  }
  songEnrichCache.set(cacheKey, { value: result, ts: Date.now() });
  // 防内存无限膨胀：超阈值时清理已过期条目
  if (songEnrichCache.size > 2000) {
    const now = Date.now();
    for (const [k, v] of songEnrichCache) {
      if (now - v.ts >= SONG_ENRICH_TTL) songEnrichCache.delete(k);
    }
  }
  return result;
}

// 艺术家名首字符的语言类别：0=中文（拼音首字母，排最前），1=英文（字母，排中间），2=其他（数字/符号，排最后）
function langRank(name) {
  const c = name ? name.charAt(0) : '';
  if (!c) return 2;
  const cp = c.codePointAt(0);
  if (cp >= 0x4e00 && cp <= 0x9fff) return 0;
  if (/[a-zA-Z]/.test(c)) return 1;
  return 2;
}

// 专辑排序：中文歌手专辑在前（拼音），英文歌手在后（字母），其他最后；同类按 歌手+专辑 拼音排序
function langSortAlbums(a, b) {
  const ka = (a.artist || '') + (a.name || '');
  const kb = (b.artist || '') + (b.name || '');
  const ra = langRank(ka);
  const rb = langRank(kb);
  if (ra !== rb) return ra - rb;
  return ka.localeCompare(kb, 'zh-Hans-CN');
}

function groupArtists(artists, legacy = false) {
  // 排序：中文歌手（拼音首字母 A-Z）在最前，英文歌手（字母 A-Z）随后，#（其他）最后。
  // 中英文各自独立成组，避免同一字母内中英文混排；同一字母可能同时出现中文组与英文组。
  const buckets = [new Map(), new Map(), new Map()]; // [中文, 英文, 其他]
  for (const a of artists) {
    const r = langRank(a.name);
    const key = r === 2 ? '#' : indexChar(a.name);
    const m = buckets[r];
    if (!m.has(key)) m.set(key, { name: key, list: [] });
    m.get(key).list.push(a);
  }
  const result = [];
  for (let r = 0; r < 3; r++) {
    const keys = Array.from(buckets[r].keys()).sort((x, y) => (x === '#' ? 1 : y === '#' ? -1 : x.localeCompare(y)));
    for (const key of keys) {
      const g = buckets[r].get(key);
      g.list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      result.push({ name: g.name, artist: g.list.map((a) => (legacy ? toArtist(a) : toArtistID3(a))) });
    }
  }
  return result;
}

function indexChar(name) {
  if (!name) return '#';
  const c = name.charAt(0);
  if (/[a-zA-Z]/.test(c)) return c.toUpperCase();
  if (c.codePointAt(0) >= 0x4e00 && c.codePointAt(0) <= 0x9fff) {
    // 中文按拼音首字母分组（A-Z），利用 ICU zh-Hans-CN 排序与边界汉字表确定首字母；
    // 多音字（如 长/行）按 ICU 默认读音归类，属已知可接受误差。
    const letters = 'ABCDEFGHJKLMNOPQRSTWXYZ'.split('');
    const zh = '阿八嚓哒妸发旮哈讥咔垃妈拏噢妑七然撒他穵夕丫帀'.split('');
    for (let i = 0; i < letters.length; i++) {
      if (c.localeCompare(zh[i], 'zh-Hans-CN') >= 0 &&
          (i === letters.length - 1 || c.localeCompare(zh[i + 1], 'zh-Hans-CN') < 0)) {
        return letters[i];
      }
    }
  }
  return '#';
}

async function handleGetArtist(params, ctx) {
  const id = String(params.id || '');
  const userId = params.user ? params.user.id : 0;
  const local = getSourceArtistById(id);
  if (local) {
    const albums = getSourceArtistAlbums(local.id);
    const obj = toArtistID3(local);
    // 歌手封面统一插件搜索（与 getArtists 一致，不用内嵌封面）
    obj.coverArt = local.id;
    obj.album = albums.map((al) => toAlbumID3(al));
    return success(params, 'artist', obj);
  }
  // 网络收藏/最近播放 艺术家（ar-<md5>）：专辑/歌曲由收藏或播放历史数据支撑
  let entry = (await getFavoritedArtists(ctx, userId)).find((a) => a.id === id);
  if (!entry) entry = (await getRecentlyPlayedArtists(ctx, userId)).find((a) => a.id === id);
  if (!entry) {
    return { ok: false, error: authError(70, 'Artist not found.') };
  }
  const obj = toArtistID3(entry);
  obj.album = Array.from(entry.albums.values()).map((al) => {
    const meta = { id: al.id, name: al.name, artist: al.artist, artistId: al.artistId, songIds: al.favs.map((f) => f.id), created: Date.now() };
    if (al.cover) meta.coverArt = al.id;
    return toAlbumID3(meta);
  });
  return success(params, 'artist', obj);
}

async function handleGetAlbum(params, ctx) {
  const id = String(params.id || '');
  const album = getSourceAlbumById(id);
  if (album) {
    const userId = params.user ? params.user.id : 0;
    const ratings = await loadUserRatings(ctx, userId);
    return success(params, 'album', albumWithSongs(album, ratings));
  }
  // 网络收藏/最近播放 专辑（al-<md5>）：歌曲由收藏或播放历史数据支撑
  const userId = params.user ? params.user.id : 0;
  let target = null;
  const favArtists = await getFavoritedArtists(ctx, userId);
  const recentArtists = await getRecentlyPlayedArtists(ctx, userId);
  for (const entry of favArtists.concat(recentArtists)) {
    for (const al of entry.albums.values()) {
      if (al.id === id) { target = al; break; }
    }
    if (target) break;
  }
  if (!target) {
    return { ok: false, error: authError(70, 'Album not found.') };
  }
  const ratings = await loadUserRatings(ctx, userId);
  const meta = { id: target.id, name: target.name, artist: target.artist, artistId: target.artistId, songIds: target.favs.map((f) => f.id), created: Date.now() };
  if (target.cover) meta.coverArt = target.id;
  const obj = toAlbumID3(meta);
  obj.song = target.favs.map((f) => toChild(f, { ratings })).filter(Boolean);
  return success(params, 'album', obj);
}

async function handleGetSong(params, ctx) {
  const id = String(params.id || '');
  // 客户端开始播放一首歌时会拉取歌曲信息：作为"真实播放信号"，用于区分预缓存
  markPlaySignal(params, id);
  let song = getSourceSongById(id);
  // 网络歌曲：按 music_id 从数据库取元数据返回（动态歌单歌曲走内存索引兜底）
  if (!song && ctx && ctx.database) {
    try {
      const dbSong = await dbSongForId(ctx, id);
      if (dbSong) {
        const local = getSourceSongByTitleArtist(dbSong.title, dbSong.artist);
        song = local || { ...dbSong, albumId: null };
      }
    } catch { /* ignore */ }
  }
  if (!song) {
    return { ok: false, error: authError(70, 'Song not found.') };
  }
  // 插件网络音源：本地库/业务表常缺 duration/cover/album 等字段，按需用插件补全，
  // 让 getSong 返回完整 Subsonic song 结构（进度条/封面/专辑歌手跳转依赖这些字段）。
  // 补全失败不影响播放；强制保留原 id，避免插件命中其他同源条目导致客户端引用错乱。
  const isNetwork = !song.filePath && !String(song.id || '').startsWith('tr-');
  // LX（落雪）专区歌曲不参与此补全：enrichNetworkSongByPlugin 会遍历全部 MF 插件，
  // 一旦命中会把 plugin 改写为 MF 源（即「LX/MF 串台」），严格禁止；LX 元数据缺失保持原样返回。
  if (isNetwork && !isLxPluginName(song.plugin) && (!song.duration || song.albumId == null || song.artistId == null || !song.coverArt)) {
    try {
      const enriched = await enrichNetworkSongByPluginCached(ctx, song);
      if (enriched) { enriched.id = song.id; song = enriched; }
    } catch { /* 补全失败不影响播放 */ }
  }
  const userId = params.user ? params.user.id : 0;
  const ratings = await loadUserRatings(ctx, userId);
  return success(params, 'song', toChild(song, { ratings }));
}

async function handleGetMusicDirectory(params, ctx) {
  const id = String(params.id || '');
  // 支持：根目录(1) / 艺术家(ar-) / 专辑(al-) / 歌曲(tr-) 作为目录视图
  let name = 'Music';
  let parent = null;
  let children = [];

  if (id === String(MUSIC_FOLDER_ID)) {
    name = 'Music';
    // 歌手封面统一用自身 ar- id 占位（getCoverArt 插件搜索头像，不用内嵌封面）
    children = sourceArtists().map((a) => toDirChild(a.id, a.name, id, a.id));
  } else if (id.startsWith('ar-')) {
    const artist = getSourceArtistById(id);
    if (!artist) return { ok: false, error: authError(70, 'Directory not found.') };
    name = artist.name;
    parent = String(MUSIC_FOLDER_ID);
    // 专辑封面统一用自身 al- id 占位（getCoverArt 插件搜索封面，不用内嵌封面）
    children = getSourceArtistAlbums(id).map((al) => toDirChild(al.id, al.name, id, al.id, al.artist));
  } else if (id.startsWith('al-')) {
    const album = getSourceAlbumById(id);
    if (!album) return { ok: false, error: authError(70, 'Directory not found.') };
    name = album.name;
    parent = album.artistId;
    children = getSourceAlbumSongs(id);
  } else if (id.startsWith('tr-')) {
    const song = getSourceSongById(id);
    if (!song) return { ok: false, error: authError(70, 'Directory not found.') };
    name = song.title;
    parent = song.albumId;
    children = [song];
  } else {
    return { ok: false, error: authError(70, 'Directory not found.') };
  }

  const userId = params.user ? params.user.id : 0;
  const ratings = await loadUserRatings(ctx, userId);
  // 目录子项：已是 Child 形态（isDir 目录）的直接返回，否则转成歌曲 Child
  const child = children.map((c) => (c && typeof c.isDir === 'boolean' ? c : toChild(c, { ratings }))).filter(Boolean);
  const dir = { id, name, child };
  if (parent) dir.parent = parent;
  return success(params, 'directory', dir);
}

// 目录子项：专辑/艺术家以 isDir 目录形式呈现
function toDirChild(id, title, parent, coverArt, artist) {
  const obj = {
    id,
    parent: String(parent),
    isDir: true,
    title
  };
  if (artist) obj.artist = artist;
  if (coverArt) obj.coverArt = coverArt;
  return obj;
}

// 获取搜索数据源：本地音乐（/app/music）优先；无本地音乐时回退下载目录库
function getSearchSource() {
  if (localMusic && typeof localMusic.getOpenSubsonicLibrary === 'function') {
    try {
      const lib = localMusic.getOpenSubsonicLibrary();
      if (lib && lib.songs && lib.songs.length) {
        return { songs: lib.songs, artists: lib.artists, albums: lib.albums };
      }
    } catch { /* 本地音乐不可用则回退下载目录库 */ }
  }
  return { songs: library.getSongs(), artists: library.getArtists(), albums: library.getAlbums() };
}

// ---- 本地文件源访问（本地音乐 /app/music 优先，downloads 兜底）----
function sourceSongs() { return getSearchSource().songs; }
function sourceArtists() { return getSearchSource().artists; }
function sourceAlbums() { return getSearchSource().albums; }

// 按 id 找歌曲：本地音乐优先，downloads 兜底（兼容 library.getSongById 签名）
function getSourceSongById(id) {
  const s = sourceSongs().find((x) => x.id === id);
  return s || library.getSongById(id);
}

// 按 id 找艺术家：本地音乐优先，downloads 兜底
function getSourceArtistById(id) {
  const s = sourceArtists().find((x) => x.id === id);
  return s || library.getArtists().find((x) => x.id === id);
}

// 按 id 找专辑：本地音乐优先，downloads 兜底
function getSourceAlbumById(id) {
  const s = sourceAlbums().find((x) => x.id === id);
  return s || library.getAlbums().find((x) => x.id === id);
}

// 艺术家的专辑：本地音乐优先，downloads 兜底
function getSourceArtistAlbums(artistId) {
  const list = sourceAlbums().filter((a) => a.artistId === artistId);
  if (list.length) return list;
  return library.getArtistAlbums(artistId);
}

// 专辑的歌曲：本地音乐优先，downloads 兜底
function getSourceAlbumSongs(albumId) {
  const album = sourceAlbums().find((a) => a.id === albumId);
  if (album) {
    return album.songIds.map((sid) => sourceSongs().find((x) => x.id === sid)).filter(Boolean);
  }
  return library.getAlbumSongs(albumId);
}

// 按 标题+歌手 找歌曲：本地音乐优先，downloads 兜底
function getSourceSongByTitleArtist(title, artist) {
  if (!title || !artist) return null;
  const s = sourceSongs().find((x) => x.title === title && x.artist === artist);
  return s || library.findSongByTitleArtist(title, artist);
}

/**
 * 按 id 去重（保留首次出现，即最近播放里最新的一条 / 搜索里优先级最高的一条）。
 * 防御性兜底：即使底层数据源存在同 id 多行（历史遗留/多端重复上报），
 * 最终输出到客户端的 song 数组也不会出现一模一样的两条。
 */
function dedupeSongsById(list) {
  const out = [];
  const seen = new Set();
  for (const s of list) {
    if (!s) continue;
    const k = (s.id != null && s.id !== '') ? String(s.id) : String(s.virtualId || '');
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// 全库空查询软超时：包裹一个 Promise，超时（默认 2s）直接 reject，由调用方返回标准 subsonic 错误。
// 用于 search3 空查询（= 全库扫描），避免超大曲库内存遍历/排序 + 播放历史 DB 查询阻塞请求线程。
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout:' + label)), ms);
    Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(t));
  });
}

// 搜索核心：返回 { artist, album, song } 结果对象（search / search2 / search3 共用）
async function runSearch(params, ctx) {
  const query = String(params.query || '').trim().toLowerCase();
  // 协议兼容：不拦截、不修改 songCount/albumCount/artistCount，客户端请求多少、条件匹配多少就返回多少。
  const artistCount = intVal(params.artistCount, 20);
  const artistOffset = intVal(params.artistOffset, 0);
  const albumCount = intVal(params.albumCount, 20);
  const albumOffset = intVal(params.albumOffset, 0);
  const songCount = intVal(params.songCount, 20);
  const songOffset = intVal(params.songOffset, 0);

  const userId = params.user ? params.user.id : 0;
  const [songActivity, starredSongs, ratings] = await Promise.all([
    loadSongActivity(ctx, userId),
    loadStarredSongs(ctx, userId),
    loadUserRatings(ctx, userId)
  ]);

  const src = getSearchSource();
  const matchedArtists = query
    ? src.artists.filter((a) => (a.name || '').toLowerCase().includes(query))
    : src.artists;
  const matchedAlbums = query
    ? src.albums.filter((a) =>
        (a.name || '').toLowerCase().includes(query) || (a.artist || '').toLowerCase().includes(query))
    : src.albums;
  const orderKey = String(params.order || '').toLowerCase();
  let matchedSongs = query
    ? src.songs.filter((s) =>
        (s.title || '').toLowerCase().includes(query) ||
        (s.artist || '').toLowerCase().includes(query) ||
        (s.album || '').toLowerCase().includes(query))
    : (orderKey === 'playdate' || orderKey === 'played')
        // 最近播放：返回项目侧边菜单的最近播放（含本地和网络歌曲）
        ? await loadPlayHistorySongs(ctx, userId)
        // 其它空查询：始终返回本地文件（本地音乐优先，downloads 兜底）
        : src.songs;

  // 非空查询：本地已有匹配（歌手/专辑/歌曲任一）时只返回本地结果，不再搜索网络歌曲
  const hasLocalMatch = !!(matchedArtists.length || matchedAlbums.length || matchedSongs.length);
  if (query && !hasLocalMatch) {
    // 本地无匹配才回退网络：先查播放历史中的网络歌曲（最近播放的网络歌手歌曲可被检索到）
    const network = await loadNetworkSongsByQuery(ctx, userId, query);
    if (network.length) matchedSongs = matchedSongs.concat(network);
    // 对接插件搜索接口：实时搜索网络歌曲（按标题/歌手/专辑过滤后入库，保证可播放）
    const netSongs = await searchNetworkSongs(ctx, query, Math.max(songCount, 20));
    if (netSongs.length) {
      const seen = new Set(matchedSongs.map((s) => String(s.title || '') + '|' + String(s.artist || '')));
      for (const s of netSongs) {
        const key = String(s.title || '') + '|' + String(s.artist || '');
        if (seen.has(key)) continue;
        seen.add(key);
        matchedSongs.push(s);
      }
    }
  }

  const orderedSongs = dedupeSongsById(sortSongs(matchedSongs, params.order, params.by, songActivity, starredSongs));

  const result = {};
  if (matchedArtists.length) {
    result.artist = matchedArtists.slice(artistOffset, artistOffset + artistCount).map((a) => toArtistID3(a));
  }
  if (matchedAlbums.length) {
    result.album = matchedAlbums.slice(albumOffset, albumOffset + albumCount).map((a) => toAlbumID3(a));
  }
  if (orderedSongs.length) {
    result.song = orderedSongs.slice(songOffset, songOffset + songCount).map((s) => toChild(s, { ratings }));
  }
  return result;
}

// 最近播放来源：返回数据库 play_history 记录（与前端"最近播放"页一致，按 played_at DESC）。
// 数据库不可用/无记录时回退到本地文件源。
async function loadPlayHistorySongs(ctx, userId) {
  if (ctx && ctx.database && typeof ctx.database.getUserPlayHistory === 'function') {
    try {
      const records = await ctx.database.getUserPlayHistory(userId, 100000, 0);
      if (Array.isArray(records) && records.length) return records;
    } catch { /* 回退到本地库 */ }
  }
  return sourceSongs();
}

// 歌曲是否命中查询词（标题/歌手/专辑任一包含）
function matchesQuery(song, query) {
  if (!query) return false;
  return ((song.title || '').toLowerCase().includes(query) ||
    (song.artist || '').toLowerCase().includes(query) ||
    (song.album || '').toLowerCase().includes(query));
}

// 从"播放历史"中查找与查询词匹配的网络歌曲（用于 search3 检索最近播放的网络歌手歌曲）。
// 已存在于本地库的歌曲跳过（由本地库搜索处理），按出现顺序去重。
async function loadNetworkSongsByQuery(ctx, userId, query) {
  const out = [];
  const seen = new Set();
  const push = (songs) => {
    for (const s of songs || []) {
      if (!matchesQuery(s, query)) continue;
      if (getSourceSongByTitleArtist(s.title, s.artist)) continue; // 本地库已有，跳过
      const key = String(s.title || '') + '|' + String(s.artist || '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  };
  if (!ctx || !ctx.database) return out;
  try {
    let history = await ctx.database.getUserPlayHistory(userId, 5000, 0);
    if (!history.length && userId !== 0) history = await ctx.database.getUserPlayHistory(0, 5000, 0);
    push(history);
  } catch { /* ignore */ }
  return out;
}

// 网络歌曲搜索：遍历插件搜索接口（默认插件 → 全部已装插件），汇总可播放的网络歌曲。
// 结果入库（saveSong）确保 /rest/stream 可按 music_id 实时解析播放。
async function searchNetworkSongs(ctx, query, limit) {
  if (!ctx || typeof ctx.runPlugin !== 'function' || !query || !limit) return [];
  const userVars = (ctx.userConfigs && ctx.userConfigs.default) || {};
  const out = [];
  const seen = new Set();
  for (const p of collectPluginCandidates(ctx, null)) {
    if (out.length >= limit) break;
    try {
      const result = await ctx.runPlugin(p, 'search', [query, 1, 'music'], userVars, ctx.PLUGINS_DIR);
      const items = Array.isArray(result) ? result : (result && Array.isArray(result.data) ? result.data : null);
      if (!items || !items.length) continue;
      for (const it of items) {
        if (out.length >= limit) break;
        if (!it || typeof it !== 'object' || it.id == null) continue;
        const title = it.title || it.songname || it.name;
        if (!title) continue;
        const key = String(it.id) + '|' + p;
        if (seen.has(key)) continue;
        seen.add(key);
        const artist = Array.isArray(it.artist)
          ? it.artist.map((a) => (a && a.name) || a || '').join(', ')
          : (it.artist || it.singer || '');
        const song = {
          ...it,
          id: String(it.id),
          title,
          artist,
          album: it.album || it.albumName || '',
          artwork: cleanCoverUrl(it.artwork || it.pic || it.cover || it.image),
          duration: Number(it.duration) || 0,
          plugin: p,
          platform: it.platform || p,
          source: it.source || p
        };
        // 入库：保证 stream 可按 music_id 解析该网络歌曲
        if (ctx.database && typeof ctx.database.saveSong === 'function') {
          try { await ctx.database.saveSong(song, p); } catch { /* 忽略入库失败 */ }
        }
        out.push(song);
      }
    } catch { /* 跳过不支持搜索或调用失败的插件 */ }
  }
  return out;
}

async function handleSearch3(params, ctx) {
  // 规范兼容：支持空查询（返回全部数据），order/by 支持按最近播放等排序（Amcfy 等客户端用）。
  // 协议返回保持兼容：不拦截、不修改 songCount，客户端请求多少、条件匹配多少就返回多少（不做条数截断）。
  // 但空查询 = 全库扫描，用「软超时 + 大响应监控 + 日志告警」三层防护，避免一次性全量拉取打崩服务。
  // 运维提示：第三方客户端一次性传 songCount=8000 拉全量会带来内存/序列化压力，建议改用分页
  // （songOffset/songCount 翻页）或指定 query 缩小范围。
  const query = String(params.query || '').trim();
  const reqSongCount = intVal(params.songCount, 20);
  if (reqSongCount > 2000) {
    ctx.logger.warn('REST', 'opensubsonic', 'search3 大 songCount 请求（全量拉取风险）', {
      client: params.c, songCount: reqSongCount, query, order: params.order, by: params.by
    });
  }
  if (!query) {
    try {
      const result = await withTimeout(runSearch(params, ctx), SEARCH_FULL_LIBRARY_TIMEOUT_MS, 'search3-empty-query');
      return success(params, 'searchResult3', result);
    } catch (e) {
      ctx.logger.error('REST', 'opensubsonic', 'search3 全库查询超时', {
        client: params.c, ms: SEARCH_FULL_LIBRARY_TIMEOUT_MS, error: String(e && e.message)
      });
      return failure({ code: 0, message: `search3 全库查询超时（>${SEARCH_FULL_LIBRARY_TIMEOUT_MS}ms）。请使用分页参数 songOffset/songCount 或指定 query 缩小范围。` });
    }
  }
  return success(params, 'searchResult3', await runSearch(params, ctx));
}

// search（旧版）：响应键为 searchResult，结构与 search3 相同
async function handleSearch(params, ctx) {
  return success(params, 'searchResult', await runSearch(params, ctx));
}

async function handleSearch2(params, ctx) {
  const query = String(params.query || '').trim().toLowerCase();
  const count = intVal(params.count, 20);
  const offset = intVal(params.offset, 0);

  const userId = params.user ? params.user.id : 0;
  const [songActivity, starredSongs, ratings] = await Promise.all([
    loadSongActivity(ctx, userId),
    loadStarredSongs(ctx, userId),
    loadUserRatings(ctx, userId)
  ]);

  const src = getSearchSource();
  const matchedSongs = query
    ? src.songs.filter((s) =>
        (s.title || '').toLowerCase().includes(query) ||
        (s.artist || '').toLowerCase().includes(query))
    : src.songs;
  // 本地已有匹配时只返回本地结果；仅本地无匹配才回退网络搜索（入库保证可播放）
  if (query && !matchedSongs.length) {
    const netSongs = await searchNetworkSongs(ctx, query, Math.max(count, 20));
    if (netSongs.length) {
      const seen = new Set(matchedSongs.map((s) => String(s.title || '') + '|' + String(s.artist || '')));
      for (const s of netSongs) {
        const key = String(s.title || '') + '|' + String(s.artist || '');
        if (seen.has(key)) continue;
        seen.add(key);
        matchedSongs.push(s);
      }
    }
  }
  const orderedSongs = dedupeSongsById(sortSongs(matchedSongs, params.order, params.by, songActivity, starredSongs));

  return success(params, 'searchResult2', {
    artist: [],
    album: [],
    song: orderedSongs.slice(offset, offset + count).map((s) => toChild(s, { ratings }))
  });
}

async function handleGetAlbumList(params, ctx) {
  // getAlbumList（旧版）：albumList.album 是 Child 数组（规范 AlbumList）
  const userId = params.user ? params.user.id : 0;
  const obj = (await buildAlbumList(params, sourceAlbums(), ctx, userId)).map((a) => toAlbumChild(a));
  return success(params, 'albumList', { album: obj });
}

async function handleGetAlbumList2(params, ctx) {
  // getAlbumList2：albumList2.album 是 AlbumID3 数组（规范 AlbumList2）
  const userId = params.user ? params.user.id : 0;
  const obj = (await buildAlbumList(params, sourceAlbums(), ctx, userId)).map((a) => toAlbumID3(a));
  return success(params, 'albumList2', { album: obj });
}

async function handleGetRandomSongs(params, ctx) {
  const size = intVal(params.size, 10);
  const genre = params.genre ? String(params.genre) : '';
  let songs = sourceSongs();
  if (genre) songs = songs.filter((s) => s.genre && s.genre.toLowerCase() === genre.toLowerCase());
  songs = songs.slice().sort(() => Math.random() - 0.5).slice(0, size);
  const userId = params.user ? params.user.id : 0;
  const ratings = await loadUserRatings(ctx, userId);
  return success(params, 'randomSongs', { song: songs.map((s) => toChild(s, { ratings })) });
}

async function handleGetScanStatus(params, _ctx) {
  return success(params, 'scanStatus', {
    scanning: _ctx.restScanning === true,
    count: sourceSongs().length
  });
}

async function handleStartScan(params, _ctx) {
  _ctx.restScanning = true;
  try {
    // 触发本地音乐库（/app/music）重新扫描（自动感知目录变化）
    if (localMusic && typeof localMusic.rescanNow === 'function') localMusic.rescanNow();
    else sourceSongs();
  } finally {
    _ctx.restScanning = false;
  }
  return success(params, 'scanStatus', {
    scanning: false,
    count: sourceSongs().length
  });
}

// ==================== 动态歌单（实时榜单/实时热门歌单） ====================
// 歌单被打上 source_type（toplist/playlist）+ source_platform + source_toplist_id 后，
// playlist_songs 表为空，歌曲需实时向插件拉取（与 routes/my.js 的 fetchLiveSourceSongs 同款调用）。
// 这里加 60s 内存缓存：箭头音乐等客户端进详情页会连续并发多次 getPlaylist，避免重复打插件。

const livePlaylistCache = new Map(); // playlistId -> { ts, songs }
const LIVE_PLAYLIST_TTL = Number(process.env.LIVE_PLAYLIST_TTL || 60000);
// 容量上限：每条缓存最多 100 首完整歌曲对象，条目此前只判读 TTL 从不删除，会随动态歌单数累积
const LIVE_PLAYLIST_MAX_ENTRIES = 50;
// 动态歌单实时歌曲索引：songId -> song（不入库，供 stream/封面/播放记录等按 id 兜底解析）
// 无界增长会随浏览的歌单数累积完整歌曲对象，加上限（Map 迭代序=插入序，超限删最旧）
const livePlaylistSongIndex = new Map();
const LIVE_SONG_INDEX_MAX = 5000;

function isDynamicPlaylist(pl) {
  if (!pl) return false;
  const t = pl.sourceType || pl.source_type;
  const p = pl.sourcePlatform || pl.source_platform;
  const sid = pl.sourceToplistId || pl.source_toplist_id;
  return (t === 'toplist' || t === 'playlist') && !!p && sid != null && sid !== '';
}

/**
 * 同音源兜底：主插件拉取失败时，尝试同一音源目录下的其他插件文件
 * （如 QQ音乐/QQ_猫.js ↔ 弥音QQ.js）。同音源插件共用同一套数据源 id 体系，
 * 可直接用相同 id + 相同方法重试；绝不跨到其他音源。
 * @returns {Promise<Array|null>} 备用插件返回的 musicList（未规范化），全部失败返回 null
 */
async function trySameGroupFallback(ctx, platform, isPlaylist, sourceToplistId, userVars) {
  let siblings = [];
  try {
    const path = require('path');
    const dir = path.dirname(path.join(ctx.PLUGINS_DIR, platform));
    if (fs.existsSync(dir)) {
      siblings = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== platform);
    }
  } catch { return null; }
  for (const p of siblings.slice(0, 3)) {
    try {
      let musicList = null;
      if (isPlaylist) {
        const result = await ctx.runPlugin(p, 'getMusicSheetInfo', [{ id: sourceToplistId }, 1], userVars, ctx.PLUGINS_DIR, 'rest-live-playlist', false, 30000);
        musicList = result && Array.isArray(result.musicList) ? result.musicList : null;
      } else {
        // 榜单详情同样先 getTopLists 补全榜单项（period 等）
        let topListItem = { id: sourceToplistId, title: '' };
        try {
          const lists = await ctx.runPlugin(p, 'getTopLists', [], userVars, ctx.PLUGINS_DIR, 'rest-live-playlist', false, 0);
          const groups = Array.isArray(lists) ? lists : (lists && Array.isArray(lists.data) ? [lists] : []);
          for (const g of groups) {
            const found = (g && Array.isArray(g.data) ? g.data : []).find((t) => t && String(t.id) === sourceToplistId);
            if (found) { topListItem = found; break; }
          }
        } catch { /* 该插件失败，尝试下一个 */ }
        const result = await ctx.runPlugin(p, 'getTopListDetail', [topListItem, 1], userVars, ctx.PLUGINS_DIR, 'rest-live-playlist', false, 0);
        musicList = result && Array.isArray(result.musicList) ? result.musicList : null;
      }
      if (musicList && musicList.length > 0) {
        logger.warn('REST', 'opensubsonic', '动态歌单主插件失败，已切换同音源备用插件', { fallbackPlugin: p, songs: musicList.length });
        return { plugin: p, musicList };
      }
    } catch { /* 该插件失败，尝试下一个 */ }
  }
  return null;
}

async function fetchLiveSourceSongsREST(ctx, pl) {
  const sourceType = pl.sourceType || pl.source_type;
  const sourcePlatform = pl.sourcePlatform || pl.source_platform;
  const sourceToplistId = String(pl.sourceToplistId || pl.source_toplist_id);
  const key = String(pl.id);
  const hit = livePlaylistCache.get(key);
  if (hit && (Date.now() - hit.ts) < LIVE_PLAYLIST_TTL) return hit.songs;

  const register = (songs) => {
    livePlaylistCache.set(key, { ts: Date.now(), songs });
    // 淘汰维护：删过期条目 + 超限删最旧（此前条目永不删除）
    for (const [k, v] of livePlaylistCache) {
      if (Date.now() - v.ts >= LIVE_PLAYLIST_TTL) livePlaylistCache.delete(k);
    }
    while (livePlaylistCache.size > LIVE_PLAYLIST_MAX_ENTRIES) {
      let oldestKey = null, oldestTs = Infinity;
      for (const [k, v] of livePlaylistCache) { if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; } }
      if (oldestKey == null) break;
      livePlaylistCache.delete(oldestKey);
    }
    // 注册进 id → 歌曲索引：动态歌单歌曲不入库，stream/封面/播放记录按 id 兜底解析用
    for (const s of songs) {
      if (s && s.id != null) livePlaylistSongIndex.set(String(s.id), s);
    }
    while (livePlaylistSongIndex.size > LIVE_SONG_INDEX_MAX) {
      const oldest = livePlaylistSongIndex.keys().next().value;
      if (oldest === undefined) break;
      livePlaylistSongIndex.delete(oldest);
    }
    // 缓存歌曲数供 getPlaylists 卡片显示，并失效列表缓存
    try {
      ctx.database.db.run('UPDATE playlists SET cached_song_count = ? WHERE id = ?', [songs.length, parseInt(key, 10)], () => {});
      if (typeof ctx.database.refreshPlaylistListsCache === 'function') {
        ctx.database.refreshPlaylistListsCache(Number(pl.userId) || 0);
      }
    } catch { /* 计数缓存失败不影响返回 */ }
    invalidatePlaylistsListCache();
  };

  const mapSongs = (list, p) => list.slice(0, 100).map((s) => {
    // 剥离插件原始的专辑/歌手 id 与 parent（如酷我的数字专辑 id）：
    // REST 客户端会拿这些 id 请求 getAlbum/getArtist，MusicHub 无法解析导致整个列表渲染失败；
    // 剥离后由 toChild 统一合成 al-/ar- 虚拟 id（与全站网络歌曲一致）
    const { albumId: _stripAl, artistId: _stripAr, parent: _stripP, ...rest } = s || {};
    return {
      ...rest,
      // Subsonic 规范：id 必须为字符串（QQ 插件返回数字 id）；时长缺失补 0 避免客户端渲染异常
      id: String(rest.id ?? ''),
      duration: Number(rest.duration) || 0,
      plugin: rest.plugin || rest.platform || p,
      platform: rest.platform || rest.plugin || p
    };
  });

  let songs = null;
  try {
    const userVars = (ctx.userConfigs && ctx.userConfigs.default) || {};
    const isPlaylist = sourceType === 'playlist';
    // 落雪（LX）实时歌单：platform 形如 lx:kg，走 lxmusic 内置 SDK（与 LX 专区/我的歌单同款调用）；
    // LX 无「插件」概念，同音源插件兜底不适用
    const isLxSource = /^lx:/i.test(String(sourcePlatform || ''));
    if (isLxSource) {
      const lx = require('../lxmusic');
      const lxSource = String(sourcePlatform).slice(3);
      const r = isPlaylist
        ? await lx.getSongListDetail(lxSource, sourceToplistId, 1)
        : await lx.getBoardSongs(lxSource, sourceToplistId, 1);
      if (r && Array.isArray(r.list) && r.list.length > 0) {
        songs = mapSongs(r.list, sourcePlatform);
      }
    } else if (isPlaylist) {
      const result = await ctx.runPlugin(sourcePlatform, 'getMusicSheetInfo', [{ id: sourceToplistId }, 1], userVars, ctx.PLUGINS_DIR, 'rest-live-playlist', false, 30000);
      if (result && Array.isArray(result.musicList) && result.musicList.length > 0) {
        songs = mapSongs(result.musicList, sourcePlatform);
      }
    } else {
      // 榜单详情需要完整榜单项（QQ 等插件的接口依赖 period 周期字段，只传 id 会返回空列表）：
      // 先 getTopLists 找回 id 匹配的完整对象，找不到再用 {id, title:''} 兜底
      let topListItem = { id: sourceToplistId, title: '' };
      try {
        const lists = await ctx.runPlugin(sourcePlatform, 'getTopLists', [], userVars, ctx.PLUGINS_DIR, 'rest-live-playlist', false, 0);
        const groups = Array.isArray(lists) ? lists : (lists && Array.isArray(lists.data) ? [lists] : []);
        for (const g of groups) {
          const found = (g && Array.isArray(g.data) ? g.data : []).find((t) => t && String(t.id) === sourceToplistId);
          if (found) { topListItem = found; break; }
        }
      } catch (e) {
        logger.warn('REST', 'opensubsonic', '动态歌单 getTopLists 预取失败', { sourcePlatform, sourceToplistId, error: e && e.message });
      }
      const result = await ctx.runPlugin(sourcePlatform, 'getTopListDetail', [topListItem, 1], userVars, ctx.PLUGINS_DIR, 'rest-live-playlist', false, 0);
      if (result && Array.isArray(result.musicList) && result.musicList.length > 0) {
        songs = mapSongs(result.musicList, sourcePlatform);
      }
    }
    // 主插件失败：同音源兜底——只尝试同一音源目录下的其他插件（id 体系一致），
    // 数据仍来自同一音源（QQ 只从 QQ、酷狗只从酷狗），绝不跨音源
    if (!songs && !isLxSource) {
      const fb = await trySameGroupFallback(ctx, sourcePlatform, isPlaylist, sourceToplistId, userVars);
      if (fb && fb.musicList && fb.musicList.length) {
        songs = mapSongs(fb.musicList, fb.plugin);
      }
    }
  } catch (e) {
    logger.warn('REST', 'opensubsonic', '动态歌单实时拉取失败', { sourceType, sourcePlatform, sourceToplistId, error: e.message });
  }

  if (songs && songs.length) {
    register(songs);
    return songs;
  }
  logger.warn('REST', 'opensubsonic', '动态歌单实时拉取为空（含跨源兜底）', { sourceType, sourcePlatform, sourceToplistId });
  return null;
}

async function handleGetPlaylists(params, _ctx) {
  const userId = params.user.id;
  let playlists = [];
  try {
    playlists = await _ctx.database.getUserPlaylists(userId);
  } catch {
    playlists = [];
  }
  const result = [];
  for (const pl of playlists) {
    // 公开歌单的歌曲归属于创建者（user_id），需用 owner 的 userId 读取；
    // 当前用户自己的歌单 pl.userId === userId，等价且无副作用
    const ownerId = pl.userId;
    let songs = [];
    try {
      songs = await _ctx.database.getUserPlaylistSongs(ownerId, pl.id);
    } catch {
      songs = [];
    }
    const obj = toPlaylist({ ...pl, songs, owner: pl.ownerUsername || params.user.username });
    // 动态歌单：playlist_songs 为空，卡片 songCount 用最近一次实时拉取的缓存数兜底
    if (isDynamicPlaylist(pl) && !obj.songCount) {
      const cached = pl.cachedSongCount != null ? pl.cachedSongCount : pl.cached_song_count;
      if (cached != null && Number(cached) > 0) obj.songCount = Number(cached);
    }
    result.push(obj);
  }
  return success(params, 'playlists', { playlist: result });
}

async function handleGetPlaylist(params, ctx) {
  const id = parseInt(params.id, 10);
  const userId = params.user.id;
  let pl = null;
  try {
    pl = await ctx.database.getUserPlaylist(userId, id);
  } catch {
    pl = null;
  }
  if (!pl) {
    return { ok: false, error: authError(70, 'Playlist not found.') };
  }
  // 公开歌单的歌曲归属于创建者（user_id），需用 owner 的 userId 读取
  const ownerId = pl.userId;
  // 注意：进入详情页不再触发插件刷新（数据由后台“网络歌单定时刷新”保持最新）
  // 动态歌单（实时榜单/实时热门歌单）：playlist_songs 为空，实时向插件拉取（带短缓存）
  let songs = [];
  if (isDynamicPlaylist(pl)) {
    songs = (await fetchLiveSourceSongsREST(ctx, pl)) || [];
  } else {
    try {
      songs = await ctx.database.getUserPlaylistSongs(ownerId, id);
    } catch {
      songs = [];
    }
  }
  const ratings = await loadUserRatings(ctx, userId);
  const ownerName = pl.ownerUsername || params.user.username;
  const obj = toPlaylist({ ...pl, songs, owner: ownerName, chOwner: ownerName });
  // 下发 track 序号（按歌单内排列位置 1 起），供客户端按编号显示/排序
  obj.entry = songs.map((s, i) => toChild(s, { fromQueue: true, ratings, track: i + 1 })).filter(Boolean);
  return success(params, 'playlist', obj);
}

// OpenSubsonic 播放队列内存存储（keyed by username，与前端播放队列隔离）
const restQueues = new Map(); // username -> { entries: [childId], current, position, changed }

function getRestQueue(username) {
  if (!restQueues.has(username)) {
    restQueues.set(username, { entries: [], current: null, position: 0, changed: Date.now() });
  }
  return restQueues.get(username);
}

async function handleGetPlayQueue(params, ctx) {
  const username = params.user.username;
  const queue = getRestQueue(username);
  const userId = params.user ? params.user.id : 0;
  const ratings = await loadUserRatings(ctx, userId);
  const entries = queue.entries
    .map((id) => getSourceSongById(String(id)))
    .filter(Boolean)
    .map((s) => toChild(s, { ratings }));

  const obj = {
    username,
    changed: toIsoDate(queue.changed),
    changedBy: String(params.c || 'client'),
    entry: entries
  };
  if (entries.length > 0) {
    if (queue.current) {
      obj.current = String(queue.current);
    }
    if (queue.position) {
      obj.position = Math.round(queue.position * 1000);
    }
  }
  return success(params, 'playQueue', obj);
}

async function handleSavePlayQueue(params, _ctx) {
  const username = params.user.username;
  const queue = getRestQueue(username);
  const ids = params.id === undefined ? [] : (Array.isArray(params.id) ? params.id : [params.id]);
  queue.entries = ids.map((id) => String(id)).filter((id) => getSourceSongById(id));
  queue.current = params.current ? String(params.current) : (queue.entries[0] || null);
  queue.position = (intVal(params.position, 0) || 0) / 1000;
  queue.changed = Date.now();
  return success(params, null, null);
}

async function handleGetStarred2(params, ctx) {
  // 返回项目"我的收藏"（favorites 表）数据；order=favorites 时按收藏时间排序（Amcfy「最近喜爱」用）
  const userId = params.user ? params.user.id : 0;
  let favorites = [];
  try {
    favorites = await ctx.database.getUserFavorites(userId);
  } catch {
    favorites = [];
  }
  if (favorites.length === 0 && userId !== 0) {
    try { favorites = await ctx.database.getUserFavorites(0); } catch { favorites = []; }
  }

  const by = String(params.by || 'DESC').toUpperCase();
  const dir = by === 'ASC' ? 1 : -1;
  const ordered = favorites.slice().sort((a, b) => {
    const na = Number(a.addedAt) || 0;
    const nb = Number(b.addedAt) || 0;
    return dir * (na - nb);
  });

  const songCount = Math.min(intVal(params.songCount, 50), REST_LIST_PAGE_CAP);
  const songOffset = intVal(params.songOffset, 0);
  const ratings = await loadUserRatings(ctx, userId);
  const song = ordered.slice(songOffset, songOffset + songCount).map((s) => toChild(s, { ratings }));
  const artist = (await getFavoritedArtists(ctx, userId)).map((a) => toArtistID3(a));
  return success(params, 'starred2', { artist, album: [], song });
}

// ---------------- getStarred（旧版收藏：含艺术家/专辑/歌曲） ----------------

async function handleGetStarred(params, ctx) {
  const userId = params.user ? params.user.id : 0;
  let favorites = [];
  try { favorites = await ctx.database.getUserFavorites(userId); } catch { favorites = []; }
  if (favorites.length === 0 && userId !== 0) {
    try { favorites = await ctx.database.getUserFavorites(0); } catch { favorites = []; }
  }
  const ratings = await loadUserRatings(ctx, userId);
  const songIds = new Set();
  const albumIds = new Set();
  const artistIds = new Set();
  for (const fav of favorites) {
    const s = getSourceSongByTitleArtist(fav.title, fav.artist);
    if (!s) continue;
    songIds.add(s.id);
    if (s.albumId) albumIds.add(s.albumId);
    if (s.artistId) artistIds.add(s.artistId);
  }
  // 规范 Starred.album 为 Child 形态（isDir 目录）
  const song = Array.from(songIds).map((sid) => getSourceSongById(sid)).filter(Boolean).map((s) => toChild(s, { ratings }));
  const album = Array.from(albumIds).map((aid) => sourceAlbums().find((a) => a.id === aid)).filter(Boolean).map((a) => toAlbumChild(a));
  const artist = Array.from(artistIds).map((aid) => sourceArtists().find((a) => a.id === aid)).filter(Boolean).map((a) => toArtistID3(a));
  return success(params, 'starred', { artist, album, song });
}

// ---------------- getSongsByGenre / getTopSongs / getSimilarSongs2 ----------------

async function handleGetSongsByGenre(params, ctx) {
  const genre = params.genre !== undefined ? String(params.genre) : '';
  if (!genre) {
    return { ok: false, error: authError(10, 'Required parameter "genre" is missing.') };
  }
  const count = intVal(params.count, 10);
  const offset = intVal(params.offset, 0);
  const songs = sourceSongs().filter((s) => s.genre && s.genre.toLowerCase() === genre.toLowerCase());
  const userId = params.user ? params.user.id : 0;
  const ratings = await loadUserRatings(ctx, userId);
  return success(params, 'songsByGenre', { song: songs.slice(offset, offset + count).map((s) => toChild(s, { ratings })) });
}

async function handleGetTopSongs(params, ctx) {
  const artist = String(params.artist || '').trim();
  const count = intVal(params.count, 10);
  if (!artist) {
    return { ok: false, error: authError(10, 'Required parameter "artist" is missing.') };
  }
  const a = sourceArtists().find((x) => (x.name || '').toLowerCase() === artist.toLowerCase());
  const userId = params.user ? params.user.id : 0;
  const [songActivity, ratings] = await Promise.all([
    loadSongActivity(ctx, userId),
    loadUserRatings(ctx, userId)
  ]);
  let songs = [];
  if (a) {
    for (const al of getSourceArtistAlbums(a.id)) songs.push(...getSourceAlbumSongs(al.id));
  }
  // 热门排序：播放次数降序（无播放记录时保持原顺序）
  songs = songs.slice().sort((x, y) =>
    ((songActivity.get(y.id) || {}).playCount || 0) - ((songActivity.get(x.id) || {}).playCount || 0));
  return success(params, 'topSongs', { song: songs.slice(0, count).map((s) => toChild(s, { ratings })) });
}

async function handleGetSimilarSongs2(params, ctx) {
  const id = String(params.id || '');
  const count = intVal(params.count, 50);
  const song = getSourceSongById(id);
  if (!song) {
    return { ok: false, error: authError(70, 'Song not found.') };
  }
  const userId = params.user ? params.user.id : 0;
  const ratings = await loadUserRatings(ctx, userId);
  // 相似度评分：同艺术家 > 同专辑 > 同流派；并列时按码率降序
  const score = (s) => {
    let sc = 0;
    if (s.artist && s.artist === song.artist) sc += 3;
    if (s.albumId && s.albumId === song.albumId) sc += 2;
    if (s.genre && song.genre && s.genre === song.genre) sc += 1;
    return sc;
  };
  const similar = sourceSongs()
    .filter((s) => s.id !== song.id && score(s) > 0)
    .sort((a, b) => (score(b) - score(a)) || ((b.bitRate || 0) - (a.bitRate || 0)))
    .slice(0, count);
  return success(params, 'similarSongs2', { song: similar.map((s) => toChild(s, { ratings })) });
}

// ---------------- getAlbumInfo2 / getArtistInfo2（无外部元数据源，返回精简信息） ----------------

async function handleGetAlbumInfo2(params, ctx) {
  const id = String(params.id || '');
  const album = getSourceAlbumById(id);
  const info = {};
  if (album && album.name) info.notes = album.name + (album.artist ? ` - ${album.artist}` : '');
  return success(params, 'albumInfo', info);
}

async function handleGetArtistInfo2(params, ctx) {
  const id = String(params.id || '');
  const artist = getSourceArtistById(id);
  const info = {};
  if (artist) {
    const targetGenres = new Set();
    for (const al of getSourceArtistAlbums(artist.id)) if (al.genre) targetGenres.add(al.genre.toLowerCase());
    // 相似艺术家：共享同一流派的其它艺术家
    const similar = sourceArtists()
      .filter((a) => a.id !== artist.id &&
        getSourceArtistAlbums(a.id).some((al) => al.genre && targetGenres.has(al.genre.toLowerCase())))
      .slice(0, 6);
    if (similar.length) info.similarArtist = similar.map((a) => toArtistID3(a));
  }
  return success(params, 'artistInfo', info);
}

// ---------------- star / unstar（收藏写入） ----------------

async function handleStar(params, ctx) {
  return await starOrUnstar(params, ctx, true);
}

async function handleUnstar(params, ctx) {
  return await starOrUnstar(params, ctx, false);
}

async function starOrUnstar(params, ctx, star) {
  const userId = params.user ? params.user.id : 0;
  const ids = collectStarIds(params);
  for (const id of ids) {
    if (star) await starEntity(ctx, userId, id);
    else await unstarEntity(ctx, userId, id);
  }
  _songActivitySnapshot.loadedAt = 0; // 收藏变化：活动快照置脏
  invalidateAllListCache(); // 列表缓存中的 starred 字段须反映最新收藏
  return success(params, null, null);
}

// 收集 id / albumId / artistId（支持数组与单值）
function collectStarIds(params) {
  const list = [];
  for (const key of ['id', 'albumId', 'artistId']) {
    const v = params[key];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) list.push(...v);
    else list.push(v);
  }
  return list.map((s) => String(s)).filter(Boolean);
}

// 收藏实体：艺术家 → 其专辑歌曲；专辑 → 其歌曲；歌曲 → 单曲
async function starEntity(ctx, userId, id) {
  if (id.startsWith('ar-')) {
    for (const al of getSourceArtistAlbums(id)) {
      for (const s of getSourceAlbumSongs(al.id)) await starSong(ctx, userId, s);
    }
  } else if (id.startsWith('al-')) {
    for (const s of getSourceAlbumSongs(id)) await starSong(ctx, userId, s);
  } else {
    await starSong(ctx, userId, id);
  }
}

async function unstarEntity(ctx, userId, id) {
  if (id.startsWith('ar-')) {
    for (const al of getSourceArtistAlbums(id)) {
      for (const s of getSourceAlbumSongs(al.id)) await unstarSong(ctx, userId, s);
    }
  } else if (id.startsWith('al-')) {
    for (const s of getSourceAlbumSongs(id)) await unstarSong(ctx, userId, s);
  } else {
    await unstarSong(ctx, userId, id);
  }
}

async function starSong(ctx, userId, idOrSong) {
  const id = typeof idOrSong === 'string' ? idOrSong : (idOrSong && idOrSong.id);
  const dbSong = await dbSongForId(ctx, id);
  if (!dbSong) return;
  const plugin = dbSong.plugin || dbSong.source || dbSong.platform || 'unknown';
  try { await ctx.database.addUserFavorite(userId, dbSong, plugin); } catch { /* 忽略收藏失败 */ }
}

async function unstarSong(ctx, userId, idOrSong) {
  const id = typeof idOrSong === 'string' ? idOrSong : (idOrSong && idOrSong.id);
  const dbSong = await dbSongForId(ctx, id);
  if (!dbSong) return;
  const plugin = dbSong.plugin || dbSong.source || dbSong.platform || 'unknown';
  try { await ctx.database.removeUserFavorite(userId, dbSong.id, plugin); } catch { /* 忽略取消收藏失败 */ }
}

// ---------------- setRating（评分写入） ----------------

async function handleSetRating(params, ctx) {
  const id = String(params.id || '');
  const rating = parseInt(params.rating, 10);
  if (!id || Number.isNaN(rating)) {
    return { ok: false, error: authError(10, 'Required parameter "id" or "rating" is missing.') };
  }
  const userId = params.user ? params.user.id : 0;
  try { await ctx.database.setUserRating(userId, id, rating); } catch { /* 忽略评分失败 */ }
  return success(params, null, null);
}

// ---------------- 播放列表写入（create/update/delete） ----------------

// 将 OpenSubsonic 歌曲 id 解析为数据库歌曲对象并加入歌单；解析不到则跳过
async function addSongToUserPlaylistSafe(ctx, userId, playlistId, sid) {
  const dbSong = await dbSongForId(ctx, sid);
  if (!dbSong) {
    logger.debug('REST', 'opensubsonic', '[add-debug] 解析失败，跳过', { sid, userId, playlistId });
    return;
  }
  const plugin = dbSong.plugin || dbSong.source || dbSong.platform || 'unknown';
  try {
    const r = await ctx.database.addSongToUserPlaylist(userId, playlistId, dbSong, plugin);
    logger.debug('REST', 'opensubsonic', '[add-debug] 添加成功', { sid, userId, playlistId, plugin, musicId: r && r.musicId });
  } catch (e) {
    logger.debug('REST', 'opensubsonic', '[add-debug] 添加异常', { sid, userId, playlistId, plugin, error: e && e.message });
  }
}

async function buildPlaylistResponse(params, ctx, userId, playlist) {
  let songs = [];
  try { songs = await ctx.database.getUserPlaylistSongs(userId, playlist.id); } catch { songs = []; }
  const ratings = await loadUserRatings(ctx, userId);
  const obj = toPlaylist({ ...playlist, songs, owner: playlist.ownerUsername || params.user.username });
  obj.entry = songs.map((s) => toChild(s, { fromQueue: true, ratings })).filter(Boolean);
  return success(params, 'playlist', obj);
}

async function handleCreatePlaylist(params, ctx) {
  const userId = params.user ? params.user.id : 0;
  const playlistIdParam = params.playlistId;
  const name = params.name ? String(params.name) : '';
  const songIds = params.songId === undefined ? [] : (Array.isArray(params.songId) ? params.songId : [params.songId]);

  if (playlistIdParam) {
    // 更新已有歌单（重命名 + 重置歌曲）
    const id = parseInt(playlistIdParam, 10);
    let playlist = null;
    try { playlist = await ctx.database.getUserPlaylist(userId, id); } catch { playlist = null; }
    if (!playlist) {
      return { ok: false, error: authError(70, 'Playlist not found.') };
    }
    if (name) {
      try { await ctx.database.updateUserPlaylist(userId, id, { name }); } catch { /* 忽略 */ }
    }
    try { await ctx.database.clearUserPlaylistSongs(userId, id); } catch { /* 忽略 */ }
    for (const sid of songIds) await addSongToUserPlaylistSafe(ctx, userId, id, sid);
    invalidatePlaylistsListCache(); // 重建后卡片数量须反映最新歌曲数
    return await buildPlaylistResponse(params, ctx, userId, playlist);
  }

  // 新建歌单
  if (!name) {
    return { ok: false, error: authError(10, 'Required parameter "name" is missing.') };
  }
  let playlist = null;
  try { playlist = await ctx.database.createUserPlaylist(userId, name); } catch { playlist = null; }
  if (!playlist) {
    return { ok: false, error: authError(0, 'Failed to create playlist.') };
  }
  for (const sid of songIds) await addSongToUserPlaylistSafe(ctx, userId, playlist.id, sid);
  invalidatePlaylistsListCache(); // 新建歌单后立即让列表缓存失效，避免卡片漏显新歌单
  return await buildPlaylistResponse(params, ctx, userId, playlist);
}

async function handleUpdatePlaylist(params, ctx) {
  const userId = params.user ? params.user.id : 0;
  const id = parseInt(params.playlistId, 10);
  if (!id) {
    return { ok: false, error: authError(10, 'Required parameter "playlistId" is missing.') };
  }
  let pl = null;
  try { pl = await ctx.database.getUserPlaylist(userId, id); } catch { pl = null; }
  if (!pl) {
    return { ok: false, error: authError(70, 'Playlist not found.') };
  }

  const isOwner = pl.userId === userId;
  const isPublic = !!pl.isPublic;

  // 元数据修改（名称/简介/公开状态）：仅歌单拥有者可操作
  const hasMetaChange = params.name !== undefined || params.comment !== undefined || params.public !== undefined;
  if (hasMetaChange && isOwner) {
    const updates = {};
    if (params.name !== undefined) updates.name = String(params.name);
    if (params.comment !== undefined) updates.description = String(params.comment);
    if (params.public !== undefined) updates.isPublic = (params.public === true || params.public === 'true' || params.public === '1');
    try { await ctx.database.updateUserPlaylist(userId, id, updates); } catch { /* 忽略 */ }
  }

  // 添加歌曲：拥有者可添加；公开歌单任何登录用户均可添加
  // （歌曲归属歌单所有者，与 /api/my/playlists 一致，保证非拥有者也能在歌单中看到）
  const toAdd = params.songIdToAdd === undefined ? [] : (Array.isArray(params.songIdToAdd) ? params.songIdToAdd : [params.songIdToAdd]);
  if (toAdd.length) {
    if (!isOwner && !isPublic) {
      return { ok: false, error: authError(50, 'Permission denied.') };
    }
    const effectiveUserId = isPublic ? pl.userId : userId;
    for (const sid of toAdd) await addSongToUserPlaylistSafe(ctx, effectiveUserId, id, sid);
    invalidatePlaylistsListCache(); // 卡片数量依赖 getPlaylists 列表缓存，须失效以反映最新歌曲数
  }

  // 移除歌曲：仅拥有者可操作
  const toRemove = params.songIndexToRemove === undefined ? [] : (Array.isArray(params.songIndexToRemove) ? params.songIndexToRemove : [params.songIndexToRemove]);
  if (toRemove.length) {
    if (!isOwner) {
      return { ok: false, error: authError(50, 'Permission denied.') };
    }
    let songs = [];
    try { songs = await ctx.database.getUserPlaylistSongs(userId, id); } catch { songs = []; }
    // 索引降序移除，避免位移
    const idxs = toRemove.map((i) => parseInt(i, 10)).filter((i) => !Number.isNaN(i)).sort((a, b) => b - a);
    for (const idx of idxs) {
      const song = songs[idx];
      if (!song) continue;
      const plugin = song.plugin || song.source || song.platform || 'unknown';
      try { await ctx.database.removeSongFromUserPlaylist(userId, id, song.id, plugin); } catch { /* 忽略 */ }
    }
    invalidatePlaylistsListCache(); // 同上：移除后失效 getPlaylists 列表缓存
  }
  return success(params, null, null);
}

async function handleDeletePlaylist(params, ctx) {
  const userId = params.user ? params.user.id : 0;
  const id = parseInt(params.id, 10);
  if (!id) {
    return { ok: false, error: authError(10, 'Required parameter "id" is missing.') };
  }
  try { await ctx.database.deleteUserPlaylist(userId, id); } catch { /* 忽略 */ }
  invalidatePlaylistsListCache(); // 删除歌单后让列表缓存失效，避免卡片仍显示已删歌单
  return success(params, null, null);
}

// scrobble：submission=true 时记录播放历史（供 getNowPlaying / 客户端"最近播放"使用）
async function handleScrobble(params, ctx) {
  const id = params.id;
  if (id && String(params.submission) === 'true' && ctx.database) {
    try {
      const userId = params.user ? params.user.id : 0;
      let music = null;
      try { music = await dbSongForId(ctx, id); } catch { music = null; }
      // tr- 本地 id：按标题/艺术家回退查数据库记录
      if (!music && String(id).startsWith('tr-')) {
        const local = getSourceSongById(id);
        if (local && local.title) {
          try { music = await ctx.database.findSongByTitleArtist(local.title, local.artist); } catch { music = null; }
        }
      }
      if (music) {
        const plugin = music.platform || music.source || music.plugin || 'unknown';
        await ctx.database.addUserPlayHistory(userId, music, plugin, { position: intVal(params.position, 0) });
        _songActivitySnapshot.loadedAt = 0; // 播放统计变化：活动快照置脏
      }
    } catch { /* 记录失败不影响 scrobble 响应 */ }
  }
  return success(params, null, null);
}

// savePlayPosition：保存播放进度（毫秒），本地/网络歌曲统一写入 play_history（文档六-5）。
async function handleSavePlayPosition(params, ctx) {
  const id = String(params.id || '');
  const position = intVal(params.position, 0);
  const userId = params.user ? params.user.id : 0;
  const player = String(params.player || params.playerName || params.client || '').trim();
  if (id && position >= 0 && ctx.database) {
    try {
      // 本地歌曲（tr-）：直接按已存 song_id（播放历史由 stream/scrobble 写入）更新进度，
      // 不触发网络歌曲误匹配，避免产生重复的网络播放记录。
      if (String(id).startsWith('tr-')) {
        await ctx.database.setPlaybackPositionBySongId(userId, id, position);
      } else {
        // 网络歌曲：按 musicId 解析歌曲元数据（本地无法解析则仅按已存 song_id 更新）
        let music = null;
        try { music = await dbSongForId(ctx, id); } catch { music = null; }
        if (music) {
          const plugin = music.platform || music.source || music.plugin || 'unknown';
          await ctx.database.savePlaybackPosition(userId, music, plugin, { position, device: player || null });
        } else {
          await ctx.database.setPlaybackPositionBySongId(userId, id, position);
        }
      }
      if (ctx.logger && typeof ctx.logger.debug === 'function') {
        ctx.logger.debug('REST', 'opensubsonic', 'savePlayPosition saved', { id, position, userId });
      }
    } catch { /* 保存失败不影响响应 */ }
  }
  return success(params, null, null);
}

// getNowPlaying：最近播放（基于 play_history 记录）
async function handleGetNowPlaying(params, ctx) {
  const userId = params.user ? params.user.id : 0;
  let rows = [];
  try {
    rows = await ctx.database.getRecentPlays(10, 0, userId);
  } catch {
    rows = [];
  }
  if (rows.length === 0 && userId !== 0) {
    try { rows = await ctx.database.getRecentPlays(10, 0, 0); } catch { rows = []; }
  }
  const now = Date.now();
  const ratings = await loadUserRatings(ctx, userId);
  const entries = rows.map((r, i) => {
    const child = toChild(r, { ratings });
    const entry = {
      ...child,
      username: (params.user && params.user.username) || 'admin',
      minutesAgo: r.playedAt ? Math.max(0, Math.floor((now - Number(r.playedAt)) / 60000)) : 0,
      playerId: i + 1,
      playerName: r.playbackDevice || 'MusicHub'
    };
    if (r.playbackPosition) entry.positionMs = Number(r.playbackPosition);
    return entry;
  });
  return success(params, 'nowPlaying', { entry: entries });
}

// 歌词（规范 songLyrics 扩展 v1/v2）：
// 数据源优先级：内存缓存 → 测试注入口(ctx._lyricsMap) → 服务器歌词缓存文件 → 插件 getLyric 实时获取。
// v1 返回结构化行级歌词；enhanced=true 时返回 v2 逐词 cueLine（含 UTF-8 byteStart/byteEnd 偏移）。
const lyricsMemoryCache = new Map(); // songId -> { text, ts }
const LYRICS_CACHE_TTL = 6 * 60 * 60 * 1000;

// 解析 LRC 文本。返回 { synced, lines:[{start(ms)|null, value}], lang, displayArtist, displayTitle }
function parseLrc(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const lines = [];
  let offset = 0;
  let lang = 'und';
  let displayArtist = '';
  let displayTitle = '';
  let anySynced = false;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // 元数据标签：[ti:/ar:/al:/offset:/language:]
    const meta = line.match(/^\[(ti|title|ar|artist|al|offset|language|lang)\s*:\s*(.*)\]$/i);
    if (meta) {
      const key = meta[1].toLowerCase();
      const val = meta[2].trim();
      if (key === 'offset') offset = parseInt(val, 10) || 0;
      else if (key === 'language' || key === 'lang') { if (val) lang = val; }
      else if (key === 'ti' || key === 'title') displayTitle = val;
      else if (key === 'ar' || key === 'artist') displayArtist = val;
      continue;
    }
    // 时间标签：[mm:ss.xx] / [mm:ss.xxx]（可多个）
    const times = [];
    const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const fracRaw = m[3] || '';
      let ms = min * 60000 + sec * 1000;
      if (fracRaw) ms += fracRaw.length === 3 ? parseInt(fracRaw, 10) : parseInt(fracRaw, 10) * 10;
      times.push(ms);
    }
    const value = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!value) continue;
    if (times.length) {
      anySynced = true;
      for (const start of times) lines.push({ start: start + offset, value });
    } else {
      lines.push({ start: null, value });
    }
  }
  return { synced: anySynced, lines, lang, displayArtist, displayTitle };
}

// 将一行按 CJK 字符 / 空白单词切分为 token（含原串中的字符区间）
function tokenizeLyrics(value) {
  const tokens = [];
  const re = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]|\S+/g;
  let m;
  while ((m = re.exec(value)) !== null) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

// 生成 v2 逐词 cueLine：将每行时间区间在词/字间均匀分配，byteStart/byteEnd 为对 value 的 UTF-8 字节偏移
function buildCueLines(parsed) {
  const lines = parsed.lines;
  const cueLines = [];
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    const ln = lines[i];
    if (ln.start == null || !ln.value) continue;
    const nextStart = (i + 1 < n && lines[i + 1].start != null) ? lines[i + 1].start : (ln.start + 4000);
    const tokens = tokenizeLyrics(ln.value);
    if (!tokens.length) continue;
    const span = Math.max(1, nextStart - ln.start);
    const cue = tokens.map((tok, k) => ({
      start: Math.round(ln.start + (span * k) / tokens.length),
      value: tok.text,
      byteStart: Buffer.byteLength(ln.value.slice(0, tok.start), 'utf8'),
      byteEnd: Buffer.byteLength(ln.value.slice(0, tok.end), 'utf8') - 1
    }));
    cueLines.push({ index: i, start: ln.start, value: ln.value, cue });
  }
  return cueLines;
}

// 构建单个 structuredLyrics 条目（v1 基础；enhanced=true 时附加 v2 kind/cueLine）
function buildStructuredLyrics(_song, lrcText, enhanced) {
  const parsed = parseLrc(lrcText);
  const entry = {
    lang: parsed.lang,
    synced: parsed.synced,
    line: parsed.lines.map((l) => (l.start == null ? { value: l.value } : { value: l.value, start: l.start }))
  };
  if (parsed.displayArtist) entry.displayArtist = parsed.displayArtist;
  if (parsed.displayTitle) entry.displayTitle = parsed.displayTitle;
  if (enhanced) {
    entry.kind = 'main';
    if (parsed.synced) {
      const cueLines = buildCueLines(parsed);
      if (cueLines.length) entry.cueLine = cueLines;
    }
  }
  return entry;
}

// 从插件返回结果中提取 LRC 文本
function extractLrcText(result) {
  if (!result) return null;
  if (typeof result === 'string') return result.trim() ? result : null;
  if (typeof result === 'object') {
    for (const k of ['rawLrc', 'lyrics', 'lrc', 'value']) {
      if (typeof result[k] === 'string' && result[k].trim()) return result[k];
    }
    if (result.data) return extractLrcText(result.data);
  }
  return null;
}

// 判断歌词文本是否为占位/无意义内容（如"暂无歌词"、"纯音乐"等）。
// 去掉时间/元数据标签后无实际内容，或整段只是常见占位短语 → 视为无效，继续尝试其他插件。
function isPlaceholderLyrics(text) {
  if (!text) return true;
  const content = String(text)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[^\]]*\]/g, '').trim())
    .filter(Boolean)
    .join('')
    .replace(/[\s\u3000]/g, '');
  if (!content) return true; // 全是标签，无实际歌词内容
  const placeholders = new Set([
    '暂无歌词', '暂无', '无歌词', '纯音乐', '纯音乐请欣赏',
    '此歌曲为没有填词的纯音乐', '歌词加载中', '加载歌词失败', '暂无歌词请稍后'
  ]);
  if (placeholders.has(content)) return true;
  if (/^纯音乐[，,]?\s*请欣赏?$/.test(content)) return true;
  return false;
}

function sanitizeCacheName(str) {
  return String(str || '').replace(/[\\/:*?"<>|]/g, '_').trim() || '未知歌曲';
}

// 插件实时获取歌词（尽力而为，失败返回 null）
// 候选规则：只允许「歌词搜索插件」配置里的插件，按配置顺序搜索；
// 未配置 → 直接停止搜索，绝不遍历全部插件。
async function fetchLyricsByPlugin(ctx, song) {
  try {
    if (!ctx || typeof ctx.runPlugin !== 'function' || !song) return null;
    const userVars = (ctx.userConfigs && ctx.userConfigs.default) || {};

    // 构建候选插件列表（去重）
    const tried = new Set();
    const pluginFiles = [];
    const pushPlugin = (name) => {
      if (!name) return;
      name = String(name);
      if (tried.has(name) || tried.has(name.replace(/\.js$/, ''))) return;
      tried.add(name);
      pluginFiles.push(name);
    };

    const cfgLyrics = configuredSearchPlugins('lyric_plugins', 'lyric_plugin');
    // 歌曲来源插件优先：其 getLyric 与歌曲同源最准确（如 QQ/酷我插件自带歌词接口），
    // 动态歌单等未入库歌曲也能直接取词。仅此一个精确来源，不算“遍历全部插件”。
    pushPlugin(song.plugin || song.platform || song.source);
    if (!cfgLyrics.length) {
      // 未配置歌词插件：只用来源插件，不遍历全部插件
      if (!pluginFiles.length) return null;
    } else {
      // 用户已配置：严格按配置顺序搜索，不追加默认/全部插件
      for (const p of cfgLyrics) pushPlugin(p);
    }

    for (const p of pluginFiles) {
      try {
        const result = await ctx.runPlugin(p, 'getLyric', [song], userVars, ctx.PLUGINS_DIR);
        const text = extractLrcText(result);
        // 过滤"暂无歌词/纯音乐"等占位文本，继续尝试下一个插件
        if (text && !isPlaceholderLyrics(text)) return text;
      } catch { /* 跳过无 getLyric 或调用失败的插件 */ }
    }

    // 以上直连 getLyric 全失败时（典型：本地/strm 歌曲无源 ID），
    // 走 enrichLocalMusic 的“搜索取词”路径：按设置插件搜索→优先用 search 内嵌歌词/getLyric
    try {
      const enriched = await enrichLocalMusic(song, { includeLyrics: true, trigger: 'play' });
      if (enriched && enriched.lyrics && !isPlaceholderLyrics(String(enriched.lyrics))) {
        return String(enriched.lyrics);
      }
    } catch { /* 忽略 */ }
    return null;
  } catch {
    return null;
  }
}

async function getLyricsText(ctx, song) {
  if (!song || !song.title) return null;
  const cached = lyricsMemoryCache.get(song.id);
  if (cached && Date.now() - cached.ts < LYRICS_CACHE_TTL) return cached.text;

  // 本地歌曲（tr- / 带 filePath）：优先直接读数据库 lyric_raw / lyric_struct（文档：getLyrics 直接读库，
  // 歌词全部保存在数据库，不读写用户磁盘 .lrc），命中即返回，不触发插件实时获取。
  const isLocalSong = song && (String(song.id || '').startsWith('tr-') || song.filePath);
  if (isLocalSong && localMusic && typeof localMusic.fetchLocalLyric === 'function') {
    try {
      const localLyric = await localMusic.fetchLocalLyric(String(song.id));
      if (localLyric && localLyric.raw && String(localLyric.raw).trim()) {
        lyricsMemoryCache.set(song.id, { text: String(localLyric.raw), ts: Date.now() });
        return String(localLyric.raw);
      }
    } catch { /* 数据库不可用则走网络兜底 */ }
  }

  // 网络歌曲歌词同样落库（songs.lyric_raw / lyric_struct），先查数据库，命中即返回不触发插件。
  const isNetDbable = !isLocalSong && ctx && ctx.database && song && song.id;
  const netPlugin = song ? (song.plugin || song.platform || song.source || '') : '';

  let text = null;
  if (isNetDbable) {
    try {
      const row = await ctx.database.loadNetworkSongLyric(song, netPlugin);
      if (row && row.lyric_raw && !isPlaceholderLyrics(String(row.lyric_raw))) {
        text = String(row.lyric_raw);
      }
    } catch { /* 数据库不可用忽略 */ }
  }
  if (!text) text = (ctx && ctx._lyricsMap && ctx._lyricsMap.has(song.id)) ? ctx._lyricsMap.get(song.id) : null;
  if (text && isPlaceholderLyrics(text)) text = null;
  if (!text) {
    text = await fetchLyricsByPlugin(ctx, song);
    if (text) {
      // 歌词只入数据库（不写 CACHE_DIR/lyrics/*.lrc 文件，避免磁盘冗余缓存）
      if (isNetDbable) {
        try { await ctx.database.saveNetworkSongLyric(song, netPlugin, text); } catch { /* 写库失败忽略 */ }
      }
    }
  }
  if (text) lyricsMemoryCache.set(song.id, { text, ts: Date.now() });
  return text || null;
}

// getLyrics（旧版，按 artist+title）：规范要求 Lyrics.value 必填，无歌词返回空字符串
async function handleGetLyrics(params, ctx) {
  const artist = String(params.artist || '');
  const title = String(params.title || '');
  let value = '';
  if (title) {
    const song = { id: String(params.id || title), title, artist };
    const text = await getLyricsText(ctx, song);
    if (text) value = text;
  }
  return success(params, 'lyrics', { value });
}

async function handleGetLyricsBySongId(params, ctx) {
  // 规范（songLyrics 扩展 + GetLyricsBySongIdSuccessResponse）要求顶层键为 lyricsList
  const id = String(params.id || '');
  // 客户端开始播放一首歌时会拉取歌词：作为"真实播放信号"，用于区分预缓存
  markPlaySignal(params, id);
  const enhanced = String(params.enhanced || '') === 'true';
  // 先查本地库（tr-），再查数据库（网络歌曲 music_id，如 Amcfy 播放的 C33EF...）
  let song = getSourceSongById(id);
  if (!song && ctx && ctx.database) song = await dbSongForId(ctx, id);
  let structured = [];
  if (song && song.title) {
    const lrcText = await getLyricsText(ctx, song);
    if (lrcText) structured = [buildStructuredLyrics(song, lrcText, enhanced)];
  }
  const payload = structured.length ? { structuredLyrics: structured } : {};
  return success(params, 'lyricsList', payload);
}

async function handleGetGenres(params, _ctx) {
  const map = new Map();
  for (const s of sourceSongs()) {
    if (!s.genre) continue;
    map.set(s.genre, (map.get(s.genre) || 0) + 1);
  }
  const genres = Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({
      value: name,
      songCount: count,
      albumCount: sourceAlbums().filter((al) => al.genre === name).length
    }));
  return success(params, 'genres', { genre: genres });
}

// tokenInfo：规范 apiKeyAuthentication 扩展，返回当前 apiKey 关联的用户名
async function handleTokenInfo(params, _ctx) {
  const username = (params.user && params.user.username) || '';
  return success(params, 'tokenInfo', { username });
}

// getOpenSubsonicExtensions：声明服务器支持的 OpenSubsonic 扩展
async function handleGetOpenSubsonicExtensions(params, _ctx) {
  const extensions = [
    { name: 'apiKeyAuthentication', versions: [1] },
    { name: 'songLyrics', versions: [1, 2] }
  ];
  return success(params, 'openSubsonicExtensions', extensions);
}

// getInternetRadioStations：返回所有电台插件合并后的电台列表（OpenSubsonic 标准字段）
// 支持可选 offset / limit / sort(name|added_at|id) / order(asc|desc) 分页与排序
async function handleGetInternetRadioStations(params, _ctx) {
  let list = await radioLib.getInternetRadioStations(params.user ? params.user.id : 0);
  if (!Array.isArray(list)) list = [];

  const sort = String(params.sort || '').toLowerCase();
  const order = String(params.order || 'asc').toLowerCase() === 'desc' ? -1 : 1;
  if (sort === 'name') {
    list = [...list].sort((a, b) => order * String(a.name).localeCompare(String(b.name)));
  } else if (sort === 'added_at' || sort === 'id') {
    list = [...list].sort((a, b) => order * String(a.id).localeCompare(String(b.id)));
  }

  const offset = parseInt(params.offset, 10) || 0;
  // Subsonic 规范默认每页 20，但电台列表通常需一次性全量返回；未显式传 limit 时返回全部
  const limit = params.limit !== undefined ? (parseInt(params.limit, 10) || 20) : 5000;
  if (offset > 0 || limit < 5000) {
    list = list.slice(offset, offset + limit);
  }

  // 电台封面：输出 OpenSubsonic 标准的 coverArt（值形如 ra-<id>），客户端据此请求 getCoverArt 取图。
  // 前缀采用 ra-<id>：与 Navidrome（箭头音乐等客户端适配最好的服务器）的电台 artwork id 约定一致，
  // 部分客户端会自行拼 ra-<stationId> 取图；服务端同时兼容本服务早期约定的 radio-<id>。
  // 这里对所有电台一律输出 coverArt（不因「本地未导入封面」而省略）：未导入封面时 getCoverArt 会返回
  // 内置的默认电台封面（PNG，非 1x1 透明图），保证客户端列表每一行都有台标、不出现空白。
  const mapped = list.map((s) => ({
    id: String(s.id),
    name: s.name,
    streamUrl: s.streamUrl,
    homepageUrl: s.homepageUrl || undefined,
    // OpenSubsonic 标准字段：封面 ID，客户端用 getCoverArt?id=<coverArt> 取图（ra-<id>，同 Navidrome 约定）
    coverArt: 'ra-' + s.id,
    // 非标准扩展字段：供自定义客户端按维度/分组展示（标准客户端忽略）
    dimension: s.dimension || undefined,
    group: s.group || undefined
  }));
  return success(params, 'internetRadioStations', { internetRadioStation: mapped });
}

// createInternetRadioStation：仅接收 name + streamUrl，电台加入「未分类」（province/category/network 皆空）
async function handleCreateInternetRadioStation(params, _ctx) {
  const name = String(params.name || '').trim();
  const streamUrl = String(params.streamUrl || params.url || '').trim();
  if (!name || !streamUrl) {
    return failure({ code: 10, message: 'name and streamUrl are required', helpUrl: null });
  }
  const created = await radioLib.createInternetRadioStation(params.user ? params.user.id : 0, { name, streamUrl });
  if (!created || !created.id) {
    return failure({ code: 0, message: 'Failed to create internet radio station', helpUrl: null });
  }
  invalidateRadioStationCache();
  return success(params, 'createInternetRadioStationResponse', { id: String(created.id) });
}

// deleteInternetRadioStation：按库真实 radio.id 删除电台
async function handleDeleteInternetRadioStation(params, _ctx) {
  const id = String(params.id || '').trim();
  if (!id) {
    return failure({ code: 10, message: 'id is required', helpUrl: null });
  }
  const ok = await radioLib.deleteInternetRadioStation(params.user ? params.user.id : 0, id);
  if (!ok) {
    return failure({ code: 0, message: 'Failed to delete internet radio station', helpUrl: null });
  }
  invalidateRadioStationCache();
  return success(params, 'deleteInternetRadioStationResponse', {});
}

// updateInternetRadioStation：仅支持修改 name 与 streamUrl，其余字段（分类等）保持不动
async function handleUpdateInternetRadioStation(params, _ctx) {
  const id = String(params.id || '').trim();
  if (!id) {
    return failure({ code: 10, message: 'id is required', helpUrl: null });
  }
  const name = params.name !== undefined ? String(params.name).trim() : undefined;
  const streamUrl = params.streamUrl !== undefined ? String(params.streamUrl).trim() : undefined;
  if (name === undefined && streamUrl === undefined) {
    return failure({ code: 10, message: 'name or streamUrl is required', helpUrl: null });
  }
  const updated = await radioLib.updateInternetRadioStation(params.user ? params.user.id : 0, id, { name, streamUrl });
  if (!updated) {
    return failure({ code: 0, message: 'Failed to update internet radio station', helpUrl: null });
  }
  invalidateRadioStationCache();
  return success(params, 'updateInternetRadioStationResponse', { id: String(updated.id) });
}

// ---------------- getUser / getUsers（Subsonic 协议适配） ----------------
// 不接入真实用户业务，仅返回当前登录用户的基本信息，用于满足第三方客户端
// （如 Amcfy Music）获取权限角色/设置项的需求，避免其因缺少该接口而循环重试刷屏。
function buildSubsonicUser(u) {
  const isAdmin = !!(u && u.role === 'admin');
  return {
    username: (u && u.username) || 'user',
    email: (u && u.email) || '',
    scrobblingEnabled: true,
    adminRole: isAdmin,
    settingsRole: true,
    downloadRole: true,
    uploadRole: isAdmin,
    playlistRole: true,
    coverArtRole: true,
    commentRole: true,
    podcastRole: false,
    streamRole: true,
    shareRole: isAdmin,
    videoConversionRole: false,
    jukeboxRole: isAdmin
  };
}

function handleGetUser(params) {
  return success(params, 'user', buildSubsonicUser(params.user));
}

function handleGetUsers(params) {
  return success(params, 'users', { user: [buildSubsonicUser(params.user)] });
}

// ---------------- v1 兼容别名（老客户端请求 v1 端点） ----------------

// getSimilarSongs(v1)：复用 v2 逻辑，仅外层 key 不同
async function handleGetSimilarSongs(params, ctx) {
  const payload = await handleGetSimilarSongs2(params, ctx);
  if (payload && payload.similarSongs2) {
    payload.similarSongs = payload.similarSongs2;
    delete payload.similarSongs2;
  }
  return payload;
}

// ---------------- 空数据端点（无对应内容域，返回合法空集防客户端报错） ----------------

async function handleGetVideos(params) {
  return success(params, 'videos', {});
}

async function handleGetChatMessages(params) {
  return success(params, 'chatMessages', { chatMessage: [] });
}

async function handleAddChatMessage(params) {
  return success(params, null, {});
}

async function handleGetPodcasts(params) {
  return success(params, 'podcasts', { channel: [] });
}

async function handleGetNewestPodcasts(params) {
  return success(params, 'newestPodcasts', { channel: [] });
}

async function handleRefreshPodcasts(params) {
  return success(params, null, {});
}

async function handleJukeboxControl(params) {
  return success(params, 'jukeboxStatus', {
    jukeboxStatus: { enabled: false, currentIndex: 0, playing: false, gain: 1, position: 0, entry: [] }
  });
}

// ---------------- 书签（按歌曲记忆播放位置；持久化到 data/opensubsonic-bookmarks.json） ----------------

const BOOKMARKS_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'opensubsonic-bookmarks.json');
let bookmarksCache = null;

function loadBookmarks() {
  if (bookmarksCache) return bookmarksCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf8'));
    bookmarksCache = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    bookmarksCache = {};
  }
  return bookmarksCache;
}

function persistBookmarks() {
  try {
    fs.mkdirSync(path.dirname(BOOKMARKS_FILE), { recursive: true });
    fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(bookmarksCache, null, 2));
  } catch { /* 写失败忽略，仅影响持久化 */ }
}

function userBookmarkMap(params) {
  const uid = String(params.user ? params.user.id : 0);
  const all = loadBookmarks();
  if (!all[uid] || typeof all[uid] !== 'object') all[uid] = {};
  return all[uid];
}

async function handleGetBookmarks(params, ctx) {
  const uid = String(params.user ? params.user.id : 0);
  const map = loadBookmarks()[uid] || {};
  const bookmark = Object.entries(map).map(([id, b]) => ({
    position: Number(b.position) || 0,
    username: b.username || '',
    created: b.created || toIsoDate(Date.now()),
    changed: b.changed || toIsoDate(Date.now()),
    entry: b.entry
  }));
  return success(params, 'bookmarks', { bookmark });
}

async function handleCreateBookmark(params, ctx) {
  const id = String(params.id || '');
  const position = intVal(params.position, 0);
  if (!id) {
    return { ok: false, error: authError(10, 'Required parameter "id" is missing.') };
  }
  let song = getSourceSongById(id);
  if (!song) {
    try { song = await dbSongForId(ctx, id); } catch { song = null; }
  }
  if (!song) {
    return { ok: false, error: authError(70, 'Song not found.') };
  }
  const now = toIsoDate(Date.now());
  const map = userBookmarkMap(params);
  map[id] = {
    position,
    username: params.user ? params.user.username : '',
    created: now,
    changed: now,
    entry: toChild(song)
  };
  persistBookmarks();
  _songActivitySnapshot.loadedAt = 0; // 书签变化：活动快照置脏
  return success(params, null, {});
}

async function handleDeleteBookmark(params, ctx) {
  const id = String(params.id || '');
  if (!id) {
    return { ok: false, error: authError(10, 'Required parameter "id" is missing.') };
  }
  const map = userBookmarkMap(params);
  delete map[id];
  persistBookmarks();
  _songActivitySnapshot.loadedAt = 0; // 书签变化：活动快照置脏
  return success(params, null, {});
}

const HANDLERS = {
  ping: handlePing,
  getlicense: handleGetLicense,
  getmusicfolders: handleGetMusicFolders,
  getindexes: handleGetIndexes,
  getartists: handleGetArtists,
  getartist: handleGetArtist,
  getalbum: handleGetAlbum,
  getsong: handleGetSong,
  getmusicdirectory: handleGetMusicDirectory,
  search: handleSearch,
  search2: handleSearch2,
  search3: handleSearch3,
  getalbumlist: handleGetAlbumList,
  getalbumlist2: handleGetAlbumList2,
  getrandomsongs: handleGetRandomSongs,
  getsongsbygenre: handleGetSongsByGenre,
  gettopsongs: handleGetTopSongs,
  getsimilarsongs2: handleGetSimilarSongs2,
  getalbuminfo2: handleGetAlbumInfo2,
  getartistinfo2: handleGetArtistInfo2,
  getscanstatus: handleGetScanStatus,
  startscan: handleStartScan,
  getplaylists: handleGetPlaylists,
  getplaylist: handleGetPlaylist,
  getplayqueue: handleGetPlayQueue,
  saveplayqueue: handleSavePlayQueue,
  getstarred: handleGetStarred,
  getstarred2: handleGetStarred2,
  star: handleStar,
  unstar: handleUnstar,
  setrating: handleSetRating,
  createplaylist: handleCreatePlaylist,
  updateplaylist: handleUpdatePlaylist,
  deleteplaylist: handleDeletePlaylist,
  scrobble: handleScrobble,
  saveplayposition: handleSavePlayPosition,
  getnowplaying: handleGetNowPlaying,
  getlyrics: handleGetLyrics,
  getlyricsbysongid: handleGetLyricsBySongId,
  getgenres: handleGetGenres,
  tokeninfo: handleTokenInfo,
  getopensubsonicextensions: handleGetOpenSubsonicExtensions,
  getinternetradiostations: handleGetInternetRadioStations,
  createinternetradiostation: handleCreateInternetRadioStation,
  deleteinternetradiostation: handleDeleteInternetRadioStation,
  updateinternetradiostation: handleUpdateInternetRadioStation,
  getuser: handleGetUser,
  getusers: handleGetUsers,
  // v1 兼容别名
  getartistinfo: handleGetArtistInfo2,
  getalbuminfo: handleGetAlbumInfo2,
  getsimilarsongs: handleGetSimilarSongs,
  // 空数据端点（无对应内容域）
  getvideos: handleGetVideos,
  getchatmessages: handleGetChatMessages,
  addchatmessage: handleAddChatMessage,
  getpodcasts: handleGetPodcasts,
  getnewestpodcasts: handleGetNewestPodcasts,
  refreshpodcasts: handleRefreshPodcasts,
  jukeboxcontrol: handleJukeboxControl,
  // 书签（按歌曲记忆播放位置）
  getbookmarks: handleGetBookmarks,
  createbookmark: handleCreateBookmark,
  deletebookmark: handleDeleteBookmark
};

// ---------------- stream / coverArt（返回字节流） ----------------

// 解析 HTTP Range: bytes=start-end / bytes=start- / bytes=-suffix
function parseRange(rangeHeader, fileSize) {
  if (!rangeHeader) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader).trim());
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);

  if (start === null) {
    // 后缀范围 bytes=-N：返回最后 N 字节
    const suffix = end;
    if (suffix <= 0) return null;
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else {
    if (start >= fileSize) return { invalid: true };
    if (end === null || end >= fileSize) end = fileSize - 1;
    if (end < start) return null;
  }
  return { start, end, invalid: false };
}

// 改为异步 stat：原 fs.statSync 会在每次本地文件播放时阻塞事件循环，
// 高并发或大盘曲库下影响整体吞吐。文件不存在时返回 404 而非抛错崩溃。
async function streamFile(req, res, filePath, mime) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    res.status(404).end();
    return;
  }
  const total = stat.size;
  const range = parseRange(req.headers && req.headers.range, total);

  if (range && range.invalid) {
    res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
    return;
  }

  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=86400');

  if (range) {
    const { start, end } = range;
    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', chunkSize);
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', total);
    fs.createReadStream(filePath).pipe(res);
  }
}

// RFC 5987 编码 Content-Disposition 文件名：避免中文/全角/括号等字符在 HTTP 头里被客户端按错误编码
// 解读成乱码（Windows 客户端尤甚）。filename* 为权威的 UTF-8 百分编码值，filename 给老客户端做 ASCII 兜底。
function dispositionHeader(title, suffix) {
  const base = (title && String(title).trim()) ? String(title).trim() : 'download';
  const ext = suffix ? (String(suffix).startsWith('.') ? suffix : '.' + suffix) : '.mp3';
  const ascii = base.replace(/[^\x21-\x7e]/g, '_'); // 非 ASCII 字符用下划线兜底
  const encoded = encodeURIComponent(base + ext)
    .replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
  return `attachment; filename="${ascii + ext}"; filename*=UTF-8''${encoded}`;
}

// ---------------- strm 文件：302 重定向（音频流量不走后端代理） ----------------
// 模仿 kg 酷狗插件模式：仅返回 Location，客户端直连 OpenList，Node 服务不代理音频流。

// 取客户端真实 IP：优先 X-Forwarded-For / X-Real-IP（反向代理/穿透场景），
// 否则回退 Express req.ip / 直接连接地址。
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

// 是否为内网/私有 IP（兼容 IPv4 映射的 IPv6 地址 ::ffff:1.2.3.4）
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

// strm 播放：根据客户端 IP 决定 302 跳转到内网直链还是外网穿透地址。
// 仅做重定向，不代理流；URL 解析异常返回 400。
// 注意：HEAD 探测不要跳转 OpenList —— OpenList 对 HEAD 常返回 403，会让箭头音乐等客户端弹「403」错误；
// 改为直接返回 200 表示可用，真正的取流由随后的 GET 302 完成。
function serveStrmStream(req, res, song, params, ctx) {
  const uri = song.realMediaUri;
  if (!uri) {
    res.status(404).send('Not found');
    return;
  }

  // HEAD 探测：不重定向到 OpenList，直接 200 让客户端认为源可用（避免 OpenList 403 弹窗）。
  if (String((req && req.method) || 'GET').toUpperCase() === 'HEAD') {
    res.status(200)
      .setHeader('Content-Type', 'audio/mpeg')
      .setHeader('Accept-Ranges', 'bytes')
      .end();
    return;
  }

  // 解析真实地址（内网/外网分支都要先校验地址合法性，失败直接 400）
  let parsed;
  try {
    parsed = new URL(uri);
  } catch (e) {
    if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('REST', 'opensubsonic', 'strm: invalid media URL', { id: song.id, error: e && e.message });
    }
    res.status(400).send('Bad request: invalid strm media URL');
    return;
  }

  // 仅允许 http/https 协议，拒绝 file://、ftp:// 等危险协议（防开放重定向/协议注入）
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.status(400).send('Bad request: unsupported strm media URL scheme');
    return;
  }

  const clientIp = getClientRealIp(req);
  const privateClient = isPrivateClient(clientIp);
  let target;

  if (privateClient) {
    // 内网客户端：直接 302 到 strm 原始内网地址（OpenList 内网直连）
    target = uri;
  } else {
    // 外网客户端：取出 pathname+search 拼接到外网穿透基地址，避免双斜杠
    const openlist = config.loadOpenlistConfig();
    const base = (openlist.publicBaseUrl || '').replace(/\/+$/, '');
    if (!base) {
      if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('REST', 'opensubsonic', 'strm: external client but openlistPublicBaseUrl not configured', { id: song.id, clientIp });
      }
      res.status(404).send('Not found');
      return;
    }
    target = base + parsed.pathname + (parsed.search || '');
  }

  if (ctx && ctx.logger && typeof ctx.logger.debug === 'function') {
    ctx.logger.debug('REST', 'opensubsonic', 'strm: redirect', {
      mode: privateClient ? 'local' : 'public',
      id: song.id,
      clientIp,
      target
    });
  }
  // HEAD 探测与 GET 取流都返回 302；音频流由客户端直连，后端不代理。
  res.redirect(302, target);
}

function serveStream(req, res, song, params) {
  if (!song || !fs.existsSync(song.filePath)) {
    res.status(404).send('Not found');
    return;
  }
  const format = params.format;
  const maxBitRate = intVal(params.maxBitRate, 0);

  // 转码参数：若请求恢复原始格式或 maxBitRate=0 且格式匹配，直接回原始文件
  const wantTranscode = format && String(format).toLowerCase() !== 'raw';
  const suffixWanted = format ? '.' + String(format).toLowerCase().replace(/^\./, '') : '';
  const sameFormat = !suffixWanted || suffixWanted === song.suffix;

  if (!wantTranscode || sameFormat) {
    streamFile(req, res, song.filePath, song.contentType);
    return;
  }

  // 尝试 ffmpeg 转码（若系统可用）
  try {
    const ffmpeg = spawn('ffmpeg', [
      '-i', song.filePath,
      '-acodec', 'libmp3lame',
      '-b:a', maxBitRate > 0 ? `${maxBitRate}k` : '192k',
      '-f', 'mp3',
      '-'
    ]);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.on('close', () => { try { ffmpeg.kill(); } catch { /* ignore */ } });
    res.on('error', () => { try { ffmpeg.kill(); } catch { /* ignore */ } });
    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.resume();
    ffmpeg.on('error', (err) => {
      if (err.code === 'ENOENT') {
        // 无 ffmpeg，退化回原始文件（尚未写入任何字节，可直接重置响应头）
        try { res.removeHeader('Content-Type'); } catch { /* ignore */ }
        streamFile(req, res, song.filePath, song.contentType);
      }
    });
  } catch {
    streamFile(req, res, song.filePath, song.contentType);
  }
}

// 最近播放记录去重：key(`${userId}|${musicId}`) -> 上次记录时间戳。
// 客户端在同一次播放里常会先 HEAD 探测再 GET 取流（或重试、分段续传），
// 若不去重，同一首歌会在"最近播放"里重复出现。
const playHistoryDedup = new Map();
// 去重窗口：同一用户同一首歌在该窗口内只记录一次
const PLAY_HISTORY_DEDUP_TTL = 60 * 1000;

/** 清理过期的去重记录，避免 Map 无限增长 */
function prunePlayHistoryDedup(now = Date.now()) {
  for (const [key, ts] of playHistoryDedup) {
    if (now - ts > PLAY_HISTORY_DEDUP_TTL) playHistoryDedup.delete(key);
  }
}

// ==================== 真实播放信号（区分"预缓存下一首"与"真的在播"）====================
// 部分客户端（如 Amcfy Music）会在当前歌曲播放期间提前请求下一首的 /rest/stream 做缓冲，
// 此时用户并没有听过这首歌，不该进"最近播放"。
// 判据：这类客户端在开始真正播放一首歌时，紧接着会请求该歌曲的 getSong / getLyricsBySongId；
// 而预缓存请求不会伴随这些元信息请求。
// 因此：已观察到客户端具备该行为时，stream 记录会延后一小段时间确认，
// 确认真有播放信号才写入 play_history；从未观察到该行为的客户端保持原逻辑（立即记录）。
const playSignalByKey = new Map();   // key(`${userId}|${musicId}`) -> 最近一次播放信号时间戳
const playSignalClients = new Set(); // 已观察到"开始播放会拉元信息"的客户端标识
const PLAY_SIGNAL_TTL = 15 * 1000;   // 播放信号有效期（stream 与元信息请求的先后顺序都能覆盖）
const STREAM_CONFIRM_DELAY = 5000;   // stream 后等待确认的时长（客户端取元信息通常在同一秒内）
const pendingStreamConfirms = new Map(); // key -> setTimeout 句柄，避免同一首歌重复排队

function playSignalKeyFor(params, id) {
  const userId = params && params.user ? params.user.id : 0;
  return `${userId}|${id}`;
}

/** 客户端标识：按 Subsonic 的 c（客户端名）区分，避免一个客户端的行为影响其它客户端 */
function clientTagOf(params) {
  const c = params && params.c ? String(params.c).trim() : '';
  const u = params && params.u ? String(params.u).trim() : '';
  const userId = params && params.user ? params.user.id : 0;
  return c || u || `user:${userId}`;
}

/** 记录一次"客户端正在播放这首歌曲"的信号（getSong / getLyricsBySongId） */
function markPlaySignal(params, id) {
  if (!id) return;
  playSignalClients.add(clientTagOf(params));
  const key = playSignalKeyFor(params, id);
  const now = Date.now();
  playSignalByKey.set(key, now);
  if (playSignalByKey.size > 500) {
    for (const [k, ts] of playSignalByKey) {
      if (now - ts > PLAY_SIGNAL_TTL) playSignalByKey.delete(k);
    }
  }
}

/** 该歌曲最近是否出现过播放信号 */
function hasRecentPlaySignal(key, now = Date.now()) {
  const ts = playSignalByKey.get(key);
  return !!(ts && now - ts < PLAY_SIGNAL_TTL);
}

/**
 * 记录 OpenSubsonic 客户端播放：/rest/stream 计入"最近播放"（play_history）。
 * 本地文件与网络歌曲均适用；记录失败不影响播放。
 *
 * 以下请求不计入播放：
 * 1) HEAD 请求：客户端只是探测资源（是否可播、是否为下一首预缓存），没有实际播放音频；
 * 2) 去重窗口内的重复请求：同一次播放的 HEAD+GET、重试、分段续传只记一次；
 * 3) 预缓存请求：客户端会带播放信号（getSong/getLyricsBySongId）时，
 *    没有伴随播放信号的 stream 视为"提前缓存下一首"，延迟确认后再决定。
 */
async function recordRestStreamPlay(req, params, ctx, music) {
  if (!music || !music.id || !ctx || !ctx.database) return;

  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method === 'HEAD') {
    if (ctx.logger && typeof ctx.logger.debug === 'function') {
      ctx.logger.debug('REST', 'opensubsonic', 'stream: skip play history (HEAD probe/pre-cache)', { title: music.title, id: music.id });
    }
    return;
  }

  const key = playSignalKeyFor(params, music.id);
  // 客户端具备"开始播放即拉元信息"的行为，且本次 stream 尚无任何播放信号 → 延后确认，
  // 确认期间若真的开始播放（出现 getSong/getLyricsBySongId）再写入，否则视为预缓存丢弃
  if (playSignalClients.has(clientTagOf(params)) && !hasRecentPlaySignal(key)) {
    scheduleStreamPlayConfirm(key, params, ctx, music);
    return;
  }

  await writeRestPlayHistory(params, ctx, music, method);

  // 本地歌（tr-）真实播放：缺封面/专辑/时长时按需联网补全并写库（DB-first + 仅配置插件，fire-and-forget 不阻塞）
  if (music && music.filePath && String(music.id || '').startsWith('tr-')) {
    try {
      if (localMusic && typeof localMusic.enrichLocalSongOnPlay === 'function') {
        localMusic.enrichLocalSongOnPlay(music).catch(() => {});
      }
    } catch { /* 补全失败不影响播放 */ }
  }
}

/** 延迟确认：等待播放信号出现后再写入播放历史 */
function scheduleStreamPlayConfirm(key, params, ctx, music) {
  if (pendingStreamConfirms.has(key)) return;
  const timer = setTimeout(async () => {
    pendingStreamConfirms.delete(key);
    if (hasRecentPlaySignal(key)) {
      await writeRestPlayHistory(params, ctx, music, 'GET (confirmed)');
      return;
    }
    if (ctx.logger && typeof ctx.logger.debug === 'function') {
      ctx.logger.debug('REST', 'opensubsonic', 'stream: skip play history (pre-cache, no play signal)', { title: music.title, id: music.id });
    }
  }, STREAM_CONFIRM_DELAY);
  // 不阻止进程退出
  if (typeof timer.unref === 'function') timer.unref();
  pendingStreamConfirms.set(key, timer);
}

/** 写入播放历史（含去重） */
async function writeRestPlayHistory(params, ctx, music, method) {
  const userId = params && params.user ? params.user.id : 0;
  const key = playSignalKeyFor(params, music.id);
  const now = Date.now();
  const last = playHistoryDedup.get(key);
  if (last && now - last < PLAY_HISTORY_DEDUP_TTL) {
    if (ctx.logger && typeof ctx.logger.debug === 'function') {
      ctx.logger.debug('REST', 'opensubsonic', 'stream: skip play history (dedup)', { title: music.title, id: music.id, sinceMsAgo: now - last });
    }
    return;
  }
  if (playHistoryDedup.size > 500) prunePlayHistoryDedup(now);
  playHistoryDedup.set(key, now);

  try {
    const plugin = music.platform || music.source || music.plugin || 'local';
    await ctx.database.addUserPlayHistory(userId, music, plugin, {
      position: intVal(params && params.position, 0)
    });
    if (ctx.logger && typeof ctx.logger.debug === 'function') {
      ctx.logger.debug('REST', 'opensubsonic', 'stream: record play history', { title: music.title, artist: music.artist, id: music.id, plugin, method });
    }
  } catch { /* 记录失败不影响播放 */ }
}

//====================================================================
// 路由注册
//====================================================================

function methodHasRawHandler(method) {
  return ['stream', 'download', 'getcoverart'].includes(method);
}

//====================================================================
// 网络歌曲播放（OpenSubsonic 客户端直接播放未下载的网络歌曲）
//====================================================================

// 从解析出的 URL 中剥离 _setHeaders 代理标记，返回 { cleanUrl, headers }
function stripProxyMarker(url) {
  if (!url || typeof url !== 'string') return { cleanUrl: url, headers: null };
  try {
    const u = new URL(url);
    const marker = u.searchParams.get('_setHeaders');
    if (marker) {
      u.searchParams.delete('_setHeaders');
      let headers = null;
      try { headers = JSON.parse(decodeURIComponent(marker)); } catch { headers = null; }
      return { cleanUrl: u.toString(), headers };
    }
  } catch { /* ignore */ }
  return { cleanUrl: url, headers: null };
}

// 音质映射：maxBitRate(kbps) → 插件音质档位
function pickQuality(maxBitRate) {
  if (maxBitRate >= 320) return 'high';
  if (maxBitRate >= 192) return 'high';
  if (maxBitRate > 0) return 'standard';
  return 'high';
}

// 网络封面内存缓存（key: music_id），避免每次播放重复拉取 CDN
const coverCache = new Map();
const COVER_TTL = 6 * 3600 * 1000; // 6 小时
// 内存封面缓存上限：超出按最久未访问（ts 最小）淘汰，避免长期运行无界增长占用内存。
const COVER_CACHE_MAX = 2000;
function setCoverCache(id, entry) {
  if (coverCache.size >= COVER_CACHE_MAX) {
    let oldestKey = null, oldestTs = Infinity;
    for (const [k, v] of coverCache) {
      if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
    }
    if (oldestKey != null) coverCache.delete(oldestKey);
  }
  coverCache.set(id, entry);
}

// 网络歌曲封面 URL 短时内存缓存（key: 源 song_id）：列表大量并发渲染时，
// 短时间内重复请求直接复用上次 getMusicInfo 拿到的封面 URL，避免高频调用插件。
// TTL 取几十分钟，平衡「链接过期」与「性能」。
const coverUrlCache = new Map();
const COVER_URL_TTL = 30 * 60 * 1000; // 30 分钟

// 内置默认封面占位图（1x1 浅灰 PNG，base64）：网络歌曲封面获取失败时代替 404，
// 避免客户端封面空白/报错（Subsonic 规范下 404 会被部分客户端当作「无封面」丢弃）。
const DEFAULT_COVER_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function sendDefaultCover(res, ctx) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger.debug === 'function') {
      ctx.logger.debug('REST', 'opensubsonic', 'cover: 返回内置默认占位封面（插件/图源获取失败）');
    }
  } catch { /* ignore */ }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(DEFAULT_COVER_PNG);
}

// 按平台设置 Referer，绕过 CDN 防盗链
function platformReferer(platform) {
  const p = String(platform || '').toLowerCase();
  if (p.includes('netease') || p.includes('163')) return 'https://music.163.com/';
  if (p.includes('qq') || p.includes('yqq') || p.includes('y.qq')) return 'https://y.qq.com/';
  if (p.includes('kugou') || p.includes('kg')) return 'https://www.kugou.com/';
  if (p.includes('kuwo')) return 'https://www.kuwo.cn/';
  if (p.includes('douyin') || p.includes('douyinmusic') || p.includes('douban')) return 'https://music.douyin.com/';
  if (p.includes('migu') || p.includes('咪咕')) return 'https://music.migu.cn/';
  if (p.includes('bilibili') || p.includes('bili') || p.includes('bilisound')) return 'https://www.bilibili.com/';
  return null;
}

// 平台名缺失时，按图片 URL 域名推断 Referer（本地歌走到代理分支时往往没有平台字段）。
// 否则 kuwo 等站点会因缺 Referer 触发防盗链，代理下载失败导致封面 404。
function refererForUrl(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('kuwo')) return 'https://www.kuwo.cn/';
  if (u.includes('kugou')) return 'https://www.kugou.com/';
  if (u.includes('y.qq') || u.includes('yqq') || u.includes('qq.com')) return 'https://y.qq.com/';
  if (u.includes('163') || u.includes('music.126') || u.includes('netease')) return 'https://music.163.com/';
  if (u.includes('migu') || u.includes('咪咕') || u.includes('music.migu')) return 'https://music.migu.cn/';
  if (u.includes('douyin') || u.includes('douyinmusic') || u.includes('douban')) return 'https://music.douyin.com/';
  if (u.includes('bilibili') || u.includes('bili') || u.includes('bilisound')) return 'https://www.bilibili.com/';
  return null;
}

// 已知存在防盗链（需带 Referer 才能取图）的图床：这些域名绝不能 307 直链给客户端，
// 必须由服务器代理下载（代理会按域名带上对应 Referer），否则客户端直连会被防盗链拦截 → 封面空白。
function isHotlinkProtectedImage(url) {
  const u = String(url || '').toLowerCase();
  return /(kuwo|kugou|\.kg|\.qq\.com|y\.qq|yqq|163\.com|netease|migu|咪咕|douyin|douban|bilibili|bili)/.test(u);
}

/**
 * 直连开关统一读取：优先「常规设置」里保存的值（config.json.settings），
 * 未设置时回退环境变量（兼容旧部署，无需重启即可生效）。
 */
async function redirectModeEnabled(ctx, settingKey, envName) {
  try {
    const db = ctx && ctx.database;
    if (db && typeof db.getSetting === 'function') {
      const v = await db.getSetting(settingKey, undefined);
      if (v !== undefined && v !== null) return !!v;
    }
  } catch { /* 读取失败则回退环境变量 */ }
  return String(process.env[envName] || '').toLowerCase() === 'true';
}

/** 播放直连 307：常规设置「播放直连」开关（true=307；false=代理），未设置时回退 ENABLE_STREAM_REDIRECT */
async function streamRedirectEnabled(ctx) {
  return redirectModeEnabled(ctx, 'streamRedirectEnabled', 'ENABLE_STREAM_REDIRECT');
}

/** 封面直连 307：常规设置「封面直连」开关且为 Amcfy 客户端（true=307；false=代理），未设置时回退 ENABLE_COVER_REDIRECT */
async function coverRedirectEnabled(ctx, clientParam) {
  if (!isAmcfyClient(clientParam)) return false;
  return redirectModeEnabled(ctx, 'coverRedirectEnabled', 'ENABLE_COVER_REDIRECT');
}

/** 是否箭头音乐客户端（c 参数，容错常见写法） */
function isAmcfyClient(clientParam) {
  const s = String(clientParam || '').trim().toLowerCase();
  return s === 'amcfy music' || s === 'amcfy' || s === 'amcfy_music' || s === '箭头音乐';
}

/**
 * 箭头音乐专属：GET / HEAD /rest/stream → HTTP 307 到插件实时 CDN 音频 url（客户端直连，省后端带宽）。
 * 仅在「常规设置→播放直连（307）」开启时生效；关闭时由上层以 forceProxy 强制服务器代理。
 * 规则（严格）：
 *  - 仅 GET / HEAD（307 保持原方法：HEAD 不会被部分客户端降级成 GET 预下载整曲）；
 *  - 仅 c=Amcfy 系列客户端；其他客户端不走 307（走原代理/302 链路）；
 *  - 仅网络歌曲（Amcfy 常用源哈希 id，如 3194D1AA…，并不总是 remote__ 虚拟 id）；本地文件/tr- 不在此列；
 *  - 解析失败 / 需自定义请求头 / 不安全 URL → 返回 false，保留完整代理降级路径。
 * @returns {Promise<boolean>} true=已 307；false=未处理，调用方走原逻辑
 */
async function serveAmcfyStreamRedirect(req, res, id, params, ctx) {
  if (!(await streamRedirectEnabled(ctx))) return false;
  const httpMethod = String((req && req.method) || '').toUpperCase();
  if (httpMethod !== 'GET' && httpMethod !== 'HEAD') return false;
  if (!id) return false;
  // 排除本地音乐 REST id（tr-/ca-/al- 前缀）与本地库可命中的歌曲；其余 id 交给 DB 解析为网络歌曲后放行
  if (String(id).startsWith('tr-') || String(id).startsWith('ca-') || String(id).startsWith('al-')) return false;
  if (getSourceSongById(id)) return false; // 本地文件仍走本地播放逻辑
  if (!isAmcfyClient(params && params.c)) return false;
  if (!ctx || !ctx.database || !ctx.ResolverCore || !ctx.PLUGINS_DIR) return false;

  let dbSong = null;
  try { dbSong = await dbSongForId(ctx, id); } catch { dbSong = null; }
  if (!dbSong || !dbSong.plugin || !dbSong.id) return false;
  const pluginName = String(dbSong.plugin || '').toLowerCase();
  if (pluginName === 'local' || pluginName === '') return false; // 本地歌曲不走网络 307

  const userVars = (ctx.userConfigs && ctx.userConfigs.default) || {};
  const quality = pickQuality(intVal(params.maxBitRate, 0));
  const fallbackMode = (ctx.downloadSettings && ctx.downloadSettings.qualityFallback) || 'lower';
  let result = null;
  try {
    result = await ctx.ResolverCore.resolveVerified(dbSong, dbSong.plugin, quality, userVars, 'REST-stream', fallbackMode);
  } catch { result = null; }
  if (!result || !result.success || !result.data || !result.data.url) {
    // 兜底：DB 记录字段不完整时按歌名/歌手插件补全一次（与 serveNetworkStream 一致）。
    // LX 专区歌曲跳过：enrichNetworkSongByPlugin 会遍历全部 MF 插件，补全后重新解析即变成
    // 「LX 失败换 MF 源播放」的串台行为，严格禁止（LX 解析失败只应停留在落雪音源内）。
    if (!isLxPluginName(dbSong.plugin)) {
      const enriched = await enrichNetworkSongByPlugin(ctx, dbSong).catch(() => null);
      if (enriched && enriched.plugin) {
        try {
          result = await ctx.ResolverCore.resolveVerified(enriched, enriched.plugin, quality, userVars, 'REST-stream', fallbackMode);
        } catch { result = null; }
      }
    }
  }
  if (!result || !result.success || !result.data || !result.data.url) return false;

  const { cleanUrl, headers } = stripProxyMarker(result.data.url);
  if (!cleanUrl) return false;
  if (headers) return false; // 需要自定义请求头的 URL：只能服务器代理，不 307

  // 真实播放信号 → 计入最近播放（与代理模式一致）
  try { await recordRestStreamPlay(req, params, ctx, dbSong); } catch { /* 忽略 */ }

  // SSRF 防护：不安全 URL 不重定向（交给原链路 404/代理处理）
  if (await isUnsafeProxyUrl(cleanUrl)) return false;

  if (ctx.logger && typeof ctx.logger.debug === 'function') {
    ctx.logger.debug('REST', 'opensubsonic', 'stream: 307（直连）', { id, url: cleanUrl });
  }
  res.redirect(307, cleanUrl);
  return true;
}

/**
 * 网络歌曲实时解析并播放。
 * @param {object} [options] - { forceProxy: true } 时即使 URL 无需自定义请求头也走服务器代理（直连开关关闭场景）
 * @returns {Promise<boolean>} 是否已处理响应（true=已发送响应；false=解析失败/未处理）
 */
// 本地曲库优先播放：开关开启且为插件（网络）音源时，用 歌名+歌手 匹配本地库，
// 命中则直接以本地文件响应（支持 Range 断点续传），否则返回 false 走原网络逻辑。
// 缺字段 / 超时 / 异常 → 返回 false（回退网络，绝不中断播放）。本地音源本身不受影响。
async function tryServeLocalPriority(req, res, dbSong, ctx) {
  try {
    const enabled = ctx.config.getConfigSetting('localLibraryPriority', false);
    if (!enabled) return false;
    if (dbSong.plugin === 'local' || dbSong.platform === 'local' || dbSong.filePath) return false;
    const title = dbSong.title, artist = dbSong.artist, duration = dbSong.duration;
    if (!title || !artist) return false; // 缺必要字段 → 回退网络
    const match = await ctx.database.matchLocalLibraryForPlay(title, artist, duration);
    if (!match) return false; // 未命中 → 网络
    logger.debug('REST', 'opensubsonic', 'stream: 本地曲库优先命中', { title, artist, localId: match.id });
    pipeLocalFile(req, res, match.filePath);
    return true;
  } catch (e) {
    logger.warn('REST', 'opensubsonic', '本地曲库优先异常，回退网络', { error: e && e.message });
    return false;
  }
}

// 直接以本地文件响应（支持 Range），复用 /api/local-files/stream 的语义，避免 307 跨重定向的鉴权问题。
function pipeLocalFile(req, res, filePath) {
  try {
    if (!fs.existsSync(filePath)) { res.status(404).send('Not found'); return; }
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'audio/mpeg'
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'audio/mpeg' });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (e) {
    logger.warn('REST', 'opensubsonic', 'pipeLocalFile error', { error: e && e.message });
    if (!res.headersSent) res.status(500).send('Local stream error');
  }
}

// 是否为落雪（LX）专区音源：plugin 形如 `lx:kg`。
// LX 歌曲由落雪自定义音源解析（ResolverCore._resolveLx 已遍历全部已启用音源），
// 与 MusicFree 插件体系完全隔离，绝不能跨到 MF 插件去补全/播放（即 LX/MF「串台」）。
function isLxPluginName(p) {
  return /^lx:/i.test(String(p || ''));
}

async function serveNetworkStream(req, res, musicId, params, ctx, options) {
  if (!ctx.database || !ctx.ResolverCore || !ctx.PLUGINS_DIR || !musicId) return false;

  let dbSong = null;
  try { dbSong = await dbSongForId(ctx, musicId); } catch { dbSong = null; }
  if (!dbSong || !dbSong.plugin || !dbSong.id) return false;

  // 本地曲库优先播放：开关开启且为插件音源时，命中本地则直接以本地文件响应
  if (await tryServeLocalPriority(req, res, dbSong, ctx)) return true;

  // 解析真实音频 URL（带可达性探测：地址不可达时自动换同组备用音源）
  const userVars = (ctx.userConfigs && ctx.userConfigs.default) || {};
  const quality = pickQuality(intVal(params.maxBitRate, 0));
  const fallbackMode = (ctx.downloadSettings && ctx.downloadSettings.qualityFallback) || 'lower';
  let result;
  try {
    result = await ctx.ResolverCore.resolveVerified(dbSong, dbSong.plugin, quality, userVars, 'REST-stream', fallbackMode);
  } catch { result = null; }
  if (!result || !result.success || !result.data || !result.data.url) {
    // 兜底：DB 记录字段不完整（如弥音QQ 缺 songmid）导致解析失败时，
    // 用插件 search 按歌名/歌手补全歌曲信息后重试一次。
    // 注意：LX 专区歌曲跳过此跨源兜底——enrichNetworkSongByPlugin 会遍历全部 MF 插件，
    // 一旦用 MF 插件补全并重新解析就变成「LX 失败换 MF 源播放」的串台行为，严格禁止。
    if (!isLxPluginName(dbSong.plugin)) {
      const enriched = await enrichNetworkSongByPlugin(ctx, dbSong);
      if (enriched && enriched.plugin) {
        try {
          result = await ctx.ResolverCore.resolveVerified(enriched, enriched.plugin, quality, userVars, 'REST-stream', fallbackMode);
        } catch { result = null; }
      }
    }
  }
  if (!result || !result.success || !result.data || !result.data.url) {
    return false;
  }

  const { cleanUrl, headers } = stripProxyMarker(result.data.url);
  if (!cleanUrl) return false;

  // 网络歌曲播放成功 → 计入"最近播放"（OpenSubsonic 客户端）
  await recordRestStreamPlay(req, params, ctx, dbSong);

  // 代理条件：URL 需要自定义请求头（汽水/QQ 等 CDN），或直连开关关闭时强制代理
  const needProxy = Boolean(headers) || !!(options && options.forceProxy);
  if (needProxy) {
    if (await isUnsafeProxyUrl(cleanUrl)) {
      res.status(404).send('Not found');
      return true;
    }
    if (ctx && ctx.logger && typeof ctx.logger.debug === 'function') {
      ctx.logger.debug('REST', 'opensubsonic', 'stream: 代理（服务器转发）', { title: dbSong.title, artist: dbSong.artist, plugin: dbSong.plugin, id: musicId, url: cleanUrl });
    }
    await proxyAudioStream(req, res, cleanUrl, headers || {}, 'REST-stream');
    return true;
  }

  // 普通 CDN 直链 → 307 重定向（省服务器带宽；307 保持原方法/Range，
  // 避免部分客户端把 HEAD 探测降级成 GET 预下载整曲）
  // SSRF 防护：外网客户端不应被 307 到内网/回环/元数据地址，违规则直接 404
  if (await isUnsafeProxyUrl(cleanUrl)) {
    res.status(404).send('Not found');
    return true;
  }
  if (ctx && ctx.logger && typeof ctx.logger.debug === 'function') {
    ctx.logger.debug('REST', 'opensubsonic', 'stream: 307（直连）', { title: dbSong.title, artist: dbSong.artist, plugin: dbSong.plugin, id: musicId, url: cleanUrl });
  }
  res.redirect(307, cleanUrl);
  return true;
}

/** 本地歌曲封面：直接静态返回扫描期已生成的 WebP 缓存文件（cover_relpath → CACHE_DIR），零图片运算。
 * 命中返回 true（响应已发送）。 */
function sendCachedLocalWebp(res, coverRelpath) {
  if (!coverRelpath) return false;
  try {
    const coverCache = require('../lib/cover-cache');
    const full = coverCache.resolveRelpath(coverRelpath);
    if (full && fs.existsSync(full)) {
      res.setHeader('Content-Type', coverCache.mimeOf(full));
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(full);
      return true;
    }
  } catch { /* 忽略 */ }
  return false;
}

/**
 * （已废弃）旧「remote_url → remote_image_cache」取图：纯内存方案下业务表不再存远程 URL，
 * 歌曲封面统一走 cover_relpath 本地路径 / 内嵌封面兜底。函数保留占位仅防遗留引用误用。
 */

async function handleRaw(req, res, params, method, _, ctx) {
  // 第三层防护：列表类请求（非流媒体/封面）设 HTTP 处理超时，防止慢查询连接堆积。
  // 流媒体（stream/download）由客户端逐段读取不设超时；封面（getcoverart）可能拉外网亦不设。
  if (method !== 'stream' && method !== 'download' && method !== 'getcoverart') {
    res.setTimeout(REST_LIST_HTTP_TIMEOUT_MS, () => {
      if (!res.headersSent) {
        try { res.json(failure({ code: 0, message: 'request timeout' })); } catch { /* 已关闭则忽略 */ }
      }
    });
  }
  if (method === 'stream' || method === 'download') {
    const id = String(params.id || '');
    const t = String(params.title || '').trim();
    const ar = String(params.artist || '').trim();

    // 第二阶段：箭头音乐 GET/HEAD stream → 307 CDN 直链（仅 GET/HEAD + c=Amcfy + remote__ 网络歌曲；
    // 其他客户端/本地文件一律不走这里，保持原有代理/302 链路）
    if (method === 'stream') {
      const amcfyHandled = await serveAmcfyStreamRedirect(req, res, id, params, ctx);
      if (amcfyHandled) return;
    }

    // 查找本地文件：本地音乐（/app/music）优先，其次下载目录库
    let song = getSourceSongById(id);
    if (!song && t && ar) song = getSourceSongByTitleArtist(t, ar);

    // download 全改为本地音乐：按 id 查库拿歌名/歌手，再到本地音乐库匹配本地文件（不回落网络下载）
    if (!song && method === 'download' && ctx && ctx.database) {
      try {
        const dbSong = await dbSongForId(ctx, id);
        if (dbSong && dbSong.title && localMusic && typeof localMusic.findLocalSongByTitleArtist === 'function') {
          song = localMusic.findLocalSongByTitleArtist(dbSong.title, dbSong.artist);
          if (song && !song.contentType) {
            song.contentType = CONTENT_TYPES[song.suffix] || 'application/octet-stream';
          }
        }
      } catch { /* 忽略 */ }
    }

    if (!song) {
      // download：本地无匹配文件则返回 404（不进行网络下载）
      if (method === 'download') {
        res.status(404).send('Not found');
        return;
      }
      // stream：本地无文件时，尝试用歌曲的插件信息实时解析网络 URL 播放。
      // 播放直连开关关闭（=代理模式）时，Amcfy 的网络歌曲强制服务器代理转发（日志显示"代理"）。
      const forceProxy = !(await streamRedirectEnabled(ctx)) &&
        (req.method === 'GET' || req.method === 'HEAD') &&
        isAmcfyClient(params && params.c);
      const handled = await serveNetworkStream(req, res, id, params, ctx, { forceProxy });
      if (handled) return;
      res.status(404).send('Not found');
      return;
    }
    // strm 文件：仅 302 重定向到内网/外网地址，音频流量不走后端代理（模仿 kg 插件模式）。
    // stream / download 都走重定向，避免把 .strm 文本本体当成音频返回。
    if (song.isStrm) {
      await recordRestStreamPlay(req, params, ctx, song);
      serveStrmStream(req, res, song, params, ctx);
      return;
    }
    // download 以附件形式下载（不转码）
    if (method === 'download') {
      res.setHeader('Content-Disposition', dispositionHeader(song.title, song.suffix));
      streamFile(req, res, song.filePath, song.contentType);
      return;
    }
    // stream：本地文件播放即计入"最近播放"
    await recordRestStreamPlay(req, params, ctx, song);
    serveStream(req, res, song, params);
    return;
  }
  if (method === 'getcoverart') {
    const id = String(params.id || '');
    // 电台封面：ra-<stationId>（Navidrome 约定，客户端可能自行拼接）或 radio-<stationId>（本服务早期约定）
    //   1) 电台库里已导入的本地封面文件（CACHE_DIR/radio-covers/<电台名>，与网页端 /api/radio/cover 同一份）
    //   2) 电台行 / 收藏记录里的远程封面地址（后端代理）
    //   均未命中的场景见下方 sendDefaultCover 兜底。
    const radioStationId = id.startsWith('radio-') ? id.slice('radio-'.length)
      : (id.startsWith('ra-') ? id.slice('ra-'.length) : null);
    if (radioStationId != null) {
      const stationId = radioStationId;
      const logCover = (msg) => {
        try {
          if (ctx && ctx.logger && typeof ctx.logger.debug === 'function') {
            ctx.logger.debug('REST', 'opensubsonic', msg, { id });
          }
        } catch { /* 日志失败不影响响应 */ }
      };
      let stationName = '';
      try {
        // 1) 真实电台行（收藏与列表都用真实 radio.id）
        const station = await radioLib.getRadioStationById(stationId);
        // 2) 兼容旧收藏 id（非真实 id）：从收藏记录里回取 name / 远程封面
        let favStation = null;
        if (!station) {
          try {
            const favs = await radioLib.getRadioFavorites(params.user ? params.user.id : 0) || [];
            favStation = favs.find((s) => String(s.id) === stationId) || null;
          } catch { favStation = null; }
        }
        stationName = (station && station.name) || (favStation && favStation.name) || '';
        // a) 本地已导入封面文件：直接静态返回（命中即 return true）
        if (stationName) {
          try {
            if (radioCover.sendRadioCover(res, stationName)) {
              logCover(`cover: 电台封面 ${id} → 已导入封面文件（${stationName}）`);
              return;
            }
          } catch { /* 发送失败落到远程/默认 */ }
        }
        // b) 远程封面地址（电台行 cover_url 优先，其次收藏自带的 logo/artwork）
        const logo = (station && station.cover_url)
          || (favStation && (favStation.logo || favStation.artwork || favStation.coverUrl))
          || '';
        const radioGuard = await resolveProxyGuard(logo);
        if (logo && /^https?:\/\//i.test(String(logo)) && radioGuard.safe) {
          // 流式代理远程封面：不把整张图读进内存
          try {
            const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
            const resp = await ctx.axios.get(logo, { responseType: 'stream', timeout: 10000, headers, httpAgent: radioGuard.agent, httpsAgent: radioGuard.agent });
            res.setHeader('Content-Type', resp.headers['content-type'] || 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            resp.data.pipe(res);
            resp.data.on('error', () => { try { res.destroy(); } catch { /* 忽略 */ } });
            return;
          } catch {
            // 代理失败：回退 302 让客户端直连（仅公网安全 URL 才会走到这里）
            res.redirect(302, logo);
            return;
          }
        }
      } catch { /* 忽略 */ }
      // 无封面或取封面失败：先返回内置默认电台封面（PNG；SVG 部分客户端无法解码，故用光栅化版本），
      // 保证客户端列表/播放器至少有台标；再兜底 1x1 占位图（禁止 404，避免客户端封面空白/重试日志）
      try {
        if (await radioCover.sendDefaultRadioCover(res)) {
          logCover(`cover: 电台封面 ${id} → 内置默认电台台标（未导入封面${stationName ? '：' + stationName : ''}）`);
          return;
        }
      } catch { /* 落到 1x1 占位图 */ }
      sendDefaultCover(res, ctx);
      return;
    }
    let cover = library.getCover(id);

    // 本地音乐封面：downloads 库找不到时，先返回本地音乐库扫描期生成的 WebP 磁盘缓存
    // （文档：getCoverArt 直接静态返回缓存文件，禁止请求时实时解码音频）；无缓存才兜底读内嵌。
    if (!cover && localMusic && String(id).startsWith('tr-')) {
      try {
        const song = (typeof localMusic.getLocalSongById === 'function') ? localMusic.getLocalSongById(id) : null;
        // 纯内存方案：歌曲封面 = 本地绑定的 cover_relpath（下载成功后写入）/ 内嵌封面兜底
        if (song && song.coverRelpath && sendCachedLocalWebp(res, song.coverRelpath)) {
          return;
        }
        if (song && song.filePath && localMusic && typeof localMusic.getEmbeddedCover === 'function') {
          const ec = localMusic.getEmbeddedCover(song.filePath);
          if (ec) {
            res.setHeader('Content-Type', ec.mime);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.send(ec.buffer);
            return;
          }
        }
      } catch { /* 忽略 */ }
    }
    if (!cover && localMusic && typeof localMusic.getOpenSubsonicLibrary === 'function' && String(id).startsWith('ca-')) {
      try {
        const lib = localMusic.getOpenSubsonicLibrary();
        const song = (lib && lib.songs) ? lib.songs.find((s) => s.coverArt === id) : null;
        // 纯内存方案：歌曲封面 = 本地绑定的 cover_relpath（下载成功后写入）/ 内嵌封面兜底
        if (song && song.coverRelpath && sendCachedLocalWebp(res, song.coverRelpath)) {
          return;
        }
        if (song && song.filePath && typeof localMusic.getEmbeddedCover === 'function') {
          const ec = localMusic.getEmbeddedCover(song.filePath);
          if (ec) {
            res.setHeader('Content-Type', ec.mime);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.send(ec.buffer);
            return;
          }
        }
      } catch { /* 忽略 */ }
    }

    // 封面非本地（ca-<md5>）：可能请求的是 歌曲(网络id)/歌单/艺术家封面。
    if (!cover && !String(id).startsWith('ca-')) {
      const pid = parseInt(id, 10);
      if (!Number.isNaN(pid) && ctx.database && params.user) {
        // 1) 歌单自身存有封面 URL（如榜单/热门歌单创建的歌单）→ 代理该封面
        let pl = null;
        let plCover = null;
        try {
          pl = await ctx.database.getUserPlaylist(params.user.id, pid);
          plCover = pl && (pl.cover || pl.artwork);
        } catch { /* 忽略歌单查询失败 */ }
        if (plCover && /^https?:\/\//i.test(String(plCover))) {
          const aStr = String(plCover);
          const coverGuard = await resolveProxyGuard(aStr);
          const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
          const ref = platformReferer(pl.platform || pl.plugin) || refererForUrl(aStr);
          if (ref) headers['Referer'] = ref;
          if (coverGuard.safe) {
            try {
              const resp = await ctx.axios.get(aStr, { responseType: 'arraybuffer', timeout: 10000, headers, maxContentLength: 20 * 1024 * 1024, httpAgent: coverGuard.agent, httpsAgent: coverGuard.agent });
              const buf = Buffer.from(resp.data, 'binary');
              const mime = resp.headers['content-type'] || 'image/jpeg';
              setCoverCache(id, { mime, buffer: buf, ts: Date.now() });
              res.setHeader('Content-Type', mime);
              res.setHeader('Cache-Control', 'public, max-age=86400');
              res.send(buf);
              return;
            } catch {
              // 代理失败：普通场景回退 302 让客户端直连；
              // 歌单场景（type=playlist）则继续走下方「用歌单内第一首歌封面」兜底，
              // 避免榜单歌单存的旧封面 URL 失效/被防盗链后永远显示占位图。
              if (String(params.type).toLowerCase() !== 'playlist') {
                res.redirect(302, aStr);
                return;
              }
              // 继续执行下方 playlist 兜底
            }
          }
        }
        // 2) 客户端带 type=playlist：歌单自身无封面 URL 时，兜底用歌单内第一首歌的封面
        //    （本地 ca-/tr- 与网络 remote__ 均覆盖）。递归复用统一 getcoverart 封面解析逻辑，
        //    与「点进该歌曲看到的封面」完全一致。取歌单歌曲用归属者（owner）userId，
        //    否则公开歌单（归属他人）按查看者查会拿不到歌曲，兜底永远失败。
        if (String(params.type).toLowerCase() === 'playlist') {
          try {
            const ownerId = (pl && pl.userId) || (params.user && params.user.id);
            if (ownerId != null) {
              const pSongs = await ctx.database.getUserPlaylistSongs(ownerId, pid);
              for (const ps of pSongs) {
                const coverId = ps.coverArt || ps.artwork || ps.cover || ps.pic || ps.id;
                if (!coverId) continue;
                // 递归走统一封面解析（本地/网络全兼容）；成功则直接响应并返回，
                // 失败（该歌曲也无封面）则继续尝试下一首，全部失败最终回退默认占位图
                if (ctx && ctx.logger && typeof ctx.logger.debug === 'function') {
                  ctx.logger.debug('REST', 'opensubsonic', 'cover: 歌单无封面，兜底用首歌封面', { playlistId: pid, coverId });
                }
                return await handleRaw(req, res, { ...params, id: String(coverId), type: undefined, coverUrl: undefined }, 'getcoverart', null, ctx);
              }
            }
          } catch { /* 忽略歌单封面解析失败，最终回退默认占位图 */ }
        }
      }
    }

    // 网络歌曲封面：按 music_id 查数据库拿 pic/artwork 并代理（带缓存与防盗链 Referer）
    if (!cover && !String(id).startsWith('ca-') && ctx.database) {
      // 缓存命中直接返回
      const cached = coverCache.get(id);
      if (cached && Date.now() - cached.ts < COVER_TTL) {
        res.setHeader('Content-Type', cached.mime);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(cached.buffer);
        return;
      }

      let dbSong = null;
      try { dbSong = await dbSongForId(ctx, id); } catch { dbSong = null; }
      // 本地 tr- 歌曲（无内嵌封面）：按标题/艺术家回退查数据库的网络 pic
      if (!dbSong && String(id).startsWith('tr-')) {
        const local = getSourceSongById(id);
        if (local && local.title) {
          try { dbSong = await ctx.database.findSongByTitleArtist(local.title, local.artist); } catch { dbSong = null; }
        }
      }
      // 专辑封面：al-<md5> 统一用插件搜索（不用内嵌封面，内嵌的是歌曲封面，与本地音乐页一致）。
      // 1) 本地专辑：按 al- id 取专辑名/歌手名插件搜索专辑封面；
      // 2) 网络收藏/最近播放 专辑：从收藏/播放历史反推专辑名插件搜索，存储封面 URL 仅作兜底。
      if (!dbSong && String(id).startsWith('al-') && params.user) {
        try {
          const localAlbum = getSourceAlbumById(id);
          if (localAlbum) {
            // 纯内存方案：专辑封面 = local_songs.album_cover_* 绑定的本地 webp（首选；严格隔离，绝不回退歌曲封面）
            try {
              const albumRel = await localLibraryDb.getAlbumRealCoverRelpath(localAlbum.name, localAlbum.artist);
              if (albumRel && sendCachedLocalWebp(res, albumRel)) return;
            } catch { /* 忽略 */ }
            // 本地专辑封面 = 该专辑歌曲的封面 WebP（扫描/补全期按封面 hash 落盘，同专辑同 hash 共用一份）。
            // 直接静态返回，不再依赖插件联网搜索专辑封面。
            try {
              const albumSongs = getSourceAlbumSongs(id) || [];
              for (const s of albumSongs) {
                if (!s || !s.id) continue;
                let albumRel = null, coverRel = null;
                try {
                  const song = (localMusic && typeof localMusic.getLocalSongById === 'function')
                    ? localMusic.getLocalSongById(String(s.id))
                    : null;
                  // 真实专辑封面优先：album_cover_relpath（album-real，扫描/补全期按专辑名搜索
                  // 后落库的 md5 WebP）。数据库已写入专辑封面时直接静态返回，避免再回源插件搜索。
                  albumRel = (song && song.albumCoverRelpath) || s.albumCoverRelpath || null;
                  coverRel = (song && song.coverRelpath) || s.coverRelpath || null;
                } catch {
                  albumRel = s.albumCoverRelpath || null;
                  coverRel = s.coverRelpath || null;
                }
                if (albumRel && sendCachedLocalWebp(res, albumRel)) return;
              }
            } catch { /* 忽略专辑封面缓存读取失败 */ }
          }
          if (localAlbum && localAlbum.name) {
            try {
              // 单并发补全：闸空闲才联网抓取并落库（source='album-real'），命中后静态返回歌曲行的真实专辑封面
              const done = await coverFillQueue.fetchImmediate('album', localAlbum.name, localAlbum.artist);
              if (done) {
                const albumSongs2 = getSourceAlbumSongs(id) || [];
                for (const s2 of albumSongs2) {
                  if (!s2 || !s2.id) continue;
                  let rel = null;
                  try {
                    const song = (localMusic && typeof localMusic.getLocalSongById === 'function') ? localMusic.getLocalSongById(String(s2.id)) : null;
                    rel = (song && song.albumCoverRelpath) || s2.albumCoverRelpath || null;
                  } catch { rel = s2.albumCoverRelpath || null; }
                  if (rel && sendCachedLocalWebp(res, rel)) return;
                }
              }
              if (ctx && ctx.logger && typeof ctx.logger.debug === 'function') {
                ctx.logger.debug('REST', 'opensubsonic', 'cover: al- local album via queue', { id, album: localAlbum.name, artist: localAlbum.artist, done: !!done });
              }
            } catch { /* 忽略 */ }
          }
          if (!dbSong) {
            const favArtists = await getFavoritedArtists(ctx, params.user.id);
            const recentArtists = await getRecentlyPlayedArtists(ctx, params.user.id);
            let albumName = '', artistName = '';
            for (const entry of favArtists.concat(recentArtists)) {
              let found = false;
              for (const al of entry.albums.values()) {
                if (al.id === id) {
                  albumName = al.name;
                  artistName = al.artist;
                  found = true;
                  break;
                }
              }
              if (found) break;
            }
            if (albumName) {
              // 与本地音乐页同一封面源；存储封面 URL 仅作兜底
              const url = await fetchAlbumImage(albumName, artistName);
              if (url) dbSong = { pic: url, plugin: null, platform: null };
            }
          }
        } catch { dbSong = null; }
      }
      // 歌手头像：ar-<md5> → 统一插件搜索歌手头像（与本地音乐页一致，歌手不用内嵌封面）
      if (!dbSong && String(id).startsWith('ar-') && params.user) {
        try {
          const localArtist = getSourceArtistById(id);
          // 1) 本地歌手：优先用该歌手本地歌曲已入库的封面 WebP（md5 落盘）静态返回，
          //    数据库里已有封面时不再回源插件搜索；没有落盘封面才走插件歌手头像（含歌曲封面兜底）
          if (!dbSong && localArtist && localArtist.name) {
            try {
              const artistName = localArtist.name;
              // 纯内存方案：歌手头像 = local_songs.artist_cover_* 绑定的本地 webp（首选）
              const avatarRel = await localLibraryDb.getArtistCoverRelpath(artistName);
              if (avatarRel && sendCachedLocalWebp(res, avatarRel)) return;
              const artistSongs = sourceSongs().filter((x) => String(x.artist || '') === String(artistName));
              for (const s of artistSongs) {
                if (!s || !s.id) continue;
                let artRel = null, coverRel = null;
                try {
                  const song = (localMusic && typeof localMusic.getLocalSongById === 'function')
                    ? localMusic.getLocalSongById(String(s.id))
                    : null;
                  // 歌手真实头像优先（artist_cover_relpath，md5 落盘 source='artist-real'），
                  // 没有再回退该歌手歌曲封面；都没有才走插件搜索
                  artRel = (song && song.artistCoverRelpath) || s.artistCoverRelpath || null;
                  coverRel = (song && song.coverRelpath) || s.coverRelpath || null;
                } catch {
                  artRel = s.artistCoverRelpath || null;
                  coverRel = s.coverRelpath || null;
                }
                if (artRel && sendCachedLocalWebp(res, artRel)) return;
              }
              // 单并发补全：闸空闲才联网抓取并落库（artist-real），命中后静态返回该歌手某首歌的头像引用
              const artDone = await coverFillQueue.fetchImmediate('artist', artistName);
              if (artDone) {
                const aSongs2 = sourceSongs().filter((x) => String(x.artist || '') === String(artistName));
                for (const s2 of aSongs2) {
                  if (!s2 || !s2.id) continue;
                  let rel = null;
                  try {
                    const song = (localMusic && typeof localMusic.getLocalSongById === 'function') ? localMusic.getLocalSongById(String(s2.id)) : null;
                    rel = (song && song.artistCoverRelpath) || s2.artistCoverRelpath || null;
                  } catch { rel = s2.artistCoverRelpath || null; }
                  if (rel && sendCachedLocalWebp(res, rel)) return;
                }
              }
              if (ctx && ctx.logger && typeof ctx.logger.debug === 'function') {
                ctx.logger.debug('REST', 'opensubsonic', 'cover: ar- local artist via queue', { id, artist: artistName, done: !!artDone });
              }
            } catch { /* 忽略 */ }
          }
          // 2) 网络歌手：收藏/最近播放里的头像（插件搜索）
          if (!dbSong) {
            const favArtists = await getFavoritedArtists(ctx, params.user.id);
            const recentArtists = await getRecentlyPlayedArtists(ctx, params.user.id);
            let entry = null;
            for (const e of favArtists.concat(recentArtists)) {
              if (e.id === id) { entry = e; break; }
            }
            if (entry) {
              const avatar = await fetchArtistImage(entry.name);
              const url = avatar;
              if (ctx && ctx.logger && typeof ctx.logger.debug === 'function') {
                ctx.logger.debug('REST', 'opensubsonic', 'cover: ar- history/fav entry', { id, entry: entry.name, avatar: url || null });
              }
              if (url) dbSong = { pic: url, plugin: null, platform: null };
            }
          }
          if (!dbSong && ctx && ctx.logger && typeof ctx.logger.debug === 'function') {
            ctx.logger.debug('REST', 'opensubsonic', 'cover: ar- no source found', { id, localArtist: localArtist ? localArtist.name : null });
          }
        } catch { dbSong = null; }
      }
      // 封面地址不持久化（playlist_songs.music_data 已剥离），此处运行时实时向插件获取最新封面 URL。
      // 优先命中 30 分钟内存缓存（key=源 song_id），未命中再调用 getMusicInfo 实时解析并回填缓存。
      let artwork = dbSong && (dbSong.pic || dbSong.artwork || dbSong.cover || dbSong.image);
      if (!artwork && dbSong && dbSong.plugin && dbSong.id && typeof ctx.runPlugin === 'function') {
        const cacheKey = String(dbSong.id);
        const cachedEntry = coverUrlCache.get(cacheKey);
        if (cachedEntry && Date.now() - cachedEntry.ts < COVER_URL_TTL) {
          artwork = cachedEntry.url;
        } else {
          try {
            const userVars = (ctx.userConfigs && ctx.userConfigs.default) || {};
            const info = await ctx.runPlugin(dbSong.plugin, 'getMusicInfo', [{ id: dbSong.id }], userVars, ctx.PLUGINS_DIR);
            const u = info && (info.artwork || info.pic || info.cover || info.image);
            if (u) {
              artwork = u;
              coverUrlCache.set(cacheKey, { url: u, ts: Date.now() });
              // 防内存无限膨胀：超阈值时清理已过期条目
              if (coverUrlCache.size > 1500) {
                const now = Date.now();
                for (const [k, v] of coverUrlCache) {
                  if (now - v.ts >= COVER_URL_TTL) coverUrlCache.delete(k);
                }
              }
            }
          } catch { artwork = null; }
        }
      }
      // 网络歌曲：getMusicInfo 未取到封面时，复用来源插件按「标题+歌手」搜索补全，
      // 与前端播放器 enrichCoverIfNeeded 行为一致。酷我等 getMusicInfo 不返回封面的插件，
      // 在「我的播放 / 我的收藏」列表（只持虚拟封面 ID、运行时经 /api/cover 解析）就不会再空白。
      if (!artwork && dbSong && dbSong.plugin && (dbSong.title || dbSong.artist) && typeof ctx.runPlugin === 'function') {
        try {
          const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
          const qTitle = norm(dbSong.title);
          const qArtist = norm(dbSong.artist);
          const query = `${dbSong.title || ''} ${dbSong.artist || ''}`.trim();
          const userVars = (ctx.userConfigs && ctx.userConfigs.default) || {};
          const sres = await ctx.runPlugin(dbSong.plugin, 'search', [query, 1, 'music'], userVars, ctx.PLUGINS_DIR);
          const list = Array.isArray(sres) ? sres : (sres && Array.isArray(sres.data) ? sres.data : null);
          if (Array.isArray(list) && list.length) {
            let best = null, bestScore = 0;
            for (const item of list) {
              const c = item && (item.artwork || item.cover || item.pic || item.image || item.coverUrl);
              if (!c) continue;
              const it = norm(item.title);
              const ia = norm(item.artist);
              let score = 0;
              if (it && qTitle && (it === qTitle || it.includes(qTitle) || qTitle.includes(it))) score += 2;
              if (qArtist && ia && (ia === qArtist || ia.includes(qArtist) || qArtist.includes(ia))) score += 1;
              if (score > bestScore) { bestScore = score; best = c; }
            }
            if (best) {
              artwork = best;
              coverUrlCache.set(String(dbSong.id), { url: best, ts: Date.now() });
            }
          }
        } catch { /* 搜索失败则维持原逻辑（最终回退默认占位图） */ }
      }
      // 动态歌单/未入库网络歌曲：来源插件 getMusicInfo + 搜索都拿不到封面时，
      // 回退「设置 → 封面查询插件」按「标题+歌手」搜索（fetchSongCoverByPlugin 内带 30 分钟缓存）
      if (!artwork && dbSong && (dbSong.title || dbSong.artist) && typeof fetchSongCoverByPlugin === 'function') {
        try {
          const url = await fetchSongCoverByPlugin(ctx, dbSong.title, dbSong.artist);
          if (url) {
            artwork = url;
            if (dbSong.id != null) coverUrlCache.set(String(dbSong.id), { url, ts: Date.now() });
          }
        } catch { /* 封面查询插件失败则回退默认占位图 */ }
      }
      // 本地 tr- 歌曲无封面：优先用扫描时已存库的封面 URL（箭头音乐可即时获取，无需每次插件搜索）；
      // 未存库时再回退到插件搜索歌曲封面（带 6h 缓存）。
      if (!artwork && String(id).startsWith('tr-') && typeof ctx.runPlugin === 'function') {
        const local = getSourceSongById(id);
        if (local && local.title) {
          const storedCover = local.coverUrl || local.artwork;
          if (storedCover && /^https?:\/\//i.test(String(storedCover))) {
            artwork = storedCover;
          } else {
            try {
              const url = await fetchSongCoverByPlugin(ctx, local.title, local.artist);
              if (url) artwork = url;
            } catch { artwork = null; }
          }
        }
      }
      if (artwork) {
        // 清洗存储/插件返回的脏封面 URL（去除包裹的反引号与首尾空白）
        const aStr = String(artwork).replace(/^`+|`+$/g, '').trim();
        // 仅「纯网络歌曲封面」（id 非 ca-/tr-/al-/ar-/radio-/ra-）采用惰性策略：需要代理时才经服务器拉一次，
        // 且只存内存缓存，不写 CACHE_DIR/cover、不建 URL 持久索引。本地歌/专辑/歌手/电台封面保持原磁盘缓存逻辑。
        const plainNetworkCover = !/^(ca-|tr-|al-|ar-|radio-|ra-)/.test(String(id || ''));
        if (aStr && ctx && ctx.database) netCoverCache.useDb(ctx.database);

        // 封面 307 直链（可选，与音频同策略）：ENABLE_COVER_REDIRECT=true + GET + Amcfy + 安全的公网 http(s) 图片
        // → 直接 307 到外网图片，客户端自行直连；服务器不再逐张下载转码。
        // 注意：已知防盗链图床（kuwo 等）必须走下方服务器代理（带上 Referer 才能取图），绝不 307 直链，
        // 否则客户端直连会被防盗链拦截 → 封面空白。
        // forceProxy=1（或 proxy=1）：显式强制服务器代理，跳过 307 直链（前端代理兜底/客户端"一直用代理"时使用）。
        const forceProxyCover = String(params.forceProxy || params.proxy || '') === '1';
        if (!forceProxyCover && await coverRedirectEnabled(ctx, params && params.c) && req.method === 'GET' && /^https?:\/\//i.test(aStr) && !isHotlinkProtectedImage(aStr)) {
          const cg = await resolveProxyGuard(aStr);
          if (cg.safe) {
            if (ctx && ctx.logger && typeof ctx.logger.debug === 'function') {
              ctx.logger.debug('REST', 'opensubsonic', 'cover: 307（直连）', { id, url: aStr });
            }
            res.redirect(307, aStr);
            return;
          }
        }

        // 网络封面统一落盘缓存优先：命中 CACHE_DIR/cover/<md5>.webp（与本地封面同目录同 hash），直接静态返回
        const cachedWebp = await netCoverCache.cachedForUrl(aStr);
        if (cachedWebp) {
          res.setHeader('Content-Type', cachedWebp.mime);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.sendFile(cachedWebp.full);
          return;
        }

        // data: URI（base64）：纯网络歌曲封面只进内存缓存（不落盘），其余类型转 WebP 落盘后静态返回
        const dataMatch = aStr.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
        if (dataMatch) {
          const buf = Buffer.from(dataMatch[2], 'base64');
          const mime = `image/${dataMatch[1].toLowerCase()}`;
          // 歌手头像(ar-)落独立 art/ 目录，其余封面仍走 cover/
          const cacheSub = /^ar-/.test(String(id || '')) ? 'art' : 'cover';
          if (!plainNetworkCover) {
            const localized = await netCoverCache.localizeBytes(aStr, buf, cacheSub);
            if (localized) {
              res.setHeader('Content-Type', localized.mime);
              res.setHeader('Cache-Control', 'public, max-age=86400');
              res.sendFile(localized.full);
              return;
            }
          }
          coverCache.set(id, { mime, buffer: buf, ts: Date.now() });
          res.setHeader('Content-Type', mime);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.send(buf);
          return;
        }

        if (/^https?:\/\//i.test(aStr)) {
          const songGuard = await resolveProxyGuard(aStr);
          const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
          const ref = platformReferer(dbSong && (dbSong.platform || dbSong.plugin)) || refererForUrl(aStr);
          if (ref) headers['Referer'] = ref;
          if (songGuard.safe) {
            if (ctx && ctx.logger && typeof ctx.logger.debug === 'function') {
              ctx.logger.debug('REST', 'opensubsonic', plainNetworkCover ? 'cover: 代理（按需下载，仅内存缓存）' : 'cover: 代理（服务器下载+缓存）', { id, url: aStr });
            }
            try {
              const resp = await ctx.axios.get(aStr, { responseType: 'arraybuffer', timeout: 10000, headers, maxContentLength: 20 * 1024 * 1024, httpAgent: songGuard.agent, httpsAgent: songGuard.agent });
              const buf = Buffer.from(resp.data, 'binary');
              const mime = resp.headers['content-type'] || 'image/jpeg';
              // 纯网络歌曲封面：惰性下载、仅存内存缓存（coverCache 6h），不写 CACHE_DIR/cover、不建 URL 索引；
              // 本地/专辑/歌手封面保持原磁盘 WebP 缓存逻辑（重启后直接复用，避免重复下载）。
              // 歌手头像(ar-)落独立 art/ 目录，其余封面仍走 cover/
              const cacheSub = /^ar-/.test(String(id || '')) ? 'art' : 'cover';
              if (!plainNetworkCover) {
                const localized = await netCoverCache.localizeBytes(aStr, buf, cacheSub);
                if (localized) {
                  res.setHeader('Content-Type', localized.mime);
                  res.setHeader('Cache-Control', 'public, max-age=86400');
                  res.sendFile(localized.full);
                  return;
                }
              }
              setCoverCache(id, { mime, buffer: buf, ts: Date.now() });
              res.setHeader('Content-Type', mime);
              res.setHeader('Cache-Control', 'public, max-age=86400');
              res.send(buf);
              return;
            } catch {
              // 代理失败：纯网络歌曲封面返回内置默认占位图（禁止 404）；其余类型回退 302 直连
              if (plainNetworkCover) { sendDefaultCover(res, ctx); return; }
              res.redirect(302, aStr);
              return;
            }
          }
        }
      }
    }

    if (!cover) {
      // 所有无法解析的封面（含本地/虚拟 ID 缺失、格式无法识别）统一返回内置默认占位图，
      // 避免客户端因 404 触发大量重试日志/封面空白（仅完全非法格式才 404，此处一律占位图）
      sendDefaultCover(res, ctx);
      return;
    }
    res.setHeader('Content-Type', cover.mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(cover.buffer);
  }
}

/**
 * 统一的 REST 调度器。解析鉴权参数后分发给指定方法。
 */
// 管理类 Subsonic 方法：仅管理员可写（防越权写电台等）。与私有 /api/radio/stations 的
// adminMiddleware 对齐，补齐 Subsonic 协议侧同等权限校验（第三方客户端走 Subsonic 协议时也受约束）。
const SUBSONIC_ADMIN_METHODS = new Set([
  'createinternetradiostation',
  'updateinternetradiostation',
  'deleteinternetradiostation'
]);

async function dispatch(req, res, rawMethod, ctx) {
  const method = String(rawMethod || '').toLowerCase();
  const handler = HANDLERS[method];

  // 参数获取（GET query 与 POST body 合并）
  const merged = { ...(req.query || {}) };
  const body = req.body || {};
  if (typeof body === 'object' && !Buffer.isBuffer(body)) {
    for (const [k, v] of Object.entries(body)) merged[k] = v;
  }
  const _params = merged;

  const format = getFormat(_params);
  const version = String(_params.v || VERSION);

  // 版本兼容：仅接受客户端版本不早于 1.0.0
  if (parseFloat(version) < 1.0) {
    sendResponse(res, _params, failure({ code: 30, message: 'Incompatible Subsonic REST protocol version. Server must upgrade.', helpUrl: null }));
    return;
  }

  // 校验鉴权
  const auth = await authenticate(_params, ctx, req);
  if (!auth.ok) {
    if (methodHasRawHandler(method)) {
      // raw 端点鉴权失败：404 而非 JSON/XML
      res.status(404).send('Not found');
      return;
    }
    sendResponse(res, _params, { ...responseBase('failed'), error: auth.error }, ctx, method);
    return;
  }
  // 保存当前用户供后续 handler 使用（挂在每个请求独立的 params 上，避免并发覆盖）
  _params.user = auth.user;

  // 歌曲活动统计快照（playCount/played/starred/bookmarkPosition）：懒加载 + 60s TTL，非首次近乎零开销
  try { await ensureSongActivitySnapshot(ctx, auth.user.id); } catch { /* 统计缺失不影响主流程 */ }

  // 管理类方法越权防护：仅管理员可写电台（auth.user.role 来自数据库用户记录）
  if (SUBSONIC_ADMIN_METHODS.has(method) && auth.user.role !== 'admin') {
    sendResponse(res, _params, failure({ code: 50, message: 'User is not authorized for the given operation.' }), ctx, method);
    return;
  }

  // 列表类响应短缓存：GET 且方法可缓存时，尝试命中（命中则连 handler 都不执行，直接复用序列化结果）
  if (req.method === 'GET' && isCacheableList(method)) {
    const lk = listCacheKey(req, method);
    _params.__listKey = lk;
    const hit = restListCache.get(lk);
    if (hit && Date.now() - hit.ts < REST_LIST_TTL) {
      const ct = format === 'json' ? 'application/json; charset=utf-8' : 'text/xml; charset=utf-8';
      res.set('Content-Type', ct);
      res.set('ETag', hit.etag);
      res.set('Vary', 'Accept-Encoding');
      try { res.locals = res.locals || {}; res.locals.restStatus = 'ok'; } catch { /* ignore */ }
      if (ctx && ctx.logger && typeof ctx.logger.debug === 'function') {
        ctx.logger.debug('REST', 'opensubsonic', `list cache hit /rest/${method}`, { key: lk });
      }
      if (req.headers['if-none-match'] === hit.etag) {
        res.status(304).end();
        return;
      }
      res.send(hit.body);
      return;
    }
  }

  // 目录变化自动感知（节流）：本地音乐库（/app/music）文件被删除/新增后无需重启即可自动重扫
  try {
    if (typeof localMusic.ensureScanned === 'function') localMusic.ensureScanned();
    if (typeof localMusic.ensureFresh === 'function') localMusic.ensureFresh();
  } catch { /* 忽略目录检测失败 */ }

  // 初始化本地音乐库（懒加载）：warm 已尝试从 DB 快速加载；若数据库为空/重建后才由 ensureScanned
  // 触发一次 startup 扫描。首个 OpenSubsonic 请求不主动触发 rescanNow，避免重启后无条件全量扫描。
  try {
    if (typeof localMusic.awaitWarmLoaded === 'function') await localMusic.awaitWarmLoaded();
  } catch { /* 忽略 */ }

  // raw 二进制端点
  if (methodHasRawHandler(method)) {
    await handleRaw(req, res, _params, method, handler, ctx);
    return;
  }

  // 未知方法
  if (!handler) {
    sendResponse(res, _params, failure({ code: 10, message: 'No such Subsonic Server-side method: ' + method, helpUrl: null }));
    return;
  }

  let payload;
  try {
    payload = await handler(_params, ctx);
  } catch (err) {
    const logger = ctx.logger || console;
    logger && logger.error('REST', 'opensubsonic', `Unhandled error in /rest/${method}`, { error: err && err.message });
    sendResponse(res, _params, failure({ code: 0, message: 'Generic error', helpUrl: null }), ctx, method);
    return;
  }

  if (payload && payload.ok === false) {
    sendResponse(res, _params, { ...responseBase('failed'), error: payload.error }, ctx, method);
    return;
  }

  sendResponse(res, _params, payload, ctx, method);
}

function register(app, ctx) {
  // 注册 catch-all 路由：/rest/:method（大小写不敏感，兼容 camelCase / lowercase）
  const wrap = (fn) => (req, res) => {
    const startedAt = Date.now();
    const method = String(req.params.method || '').toLowerCase();
    // 请求完成（含成功/失败）后打一行摘要：方法 + 客户端 + 耗时 + 结果。
    // GET 列表类短缓存请求为高频轮询，降为 DEBUG；其余为 INFO 关键节点。
    res.on('finish', () => {
      try {
        const level = (req.method === 'GET' && isCacheableList(method)) ? 'debug' : 'info';
        const client = String(req.query.c || req.query.client || '').slice(0, 40);
        const result = (res.locals && res.locals.restStatus)
          ? res.locals.restStatus
          : (res.statusCode >= 400 ? 'failed' : 'ok');
        ctx.logger[level]('REST', 'opensubsonic', `REST /rest/${method}`, {
          client: client || null, result, ms: Date.now() - startedAt, http: res.statusCode
        });
      } catch { /* 日志失败不影响响应 */ }
    });
    Promise.resolve(fn(req, res)).catch(() => {
      try { res.status(500).send('Internal Server Error'); } catch { /* ignore */ }
    });
  };

  app.get('/rest/:method', wrap((req, res) => dispatch(req, res, req.params.method, ctx)));
  app.post('/rest/:method', wrap((req, res) => dispatch(req, res, req.params.method, ctx)));
}

module.exports = { register, dispatch, handleRaw, invalidateRadioStationCache, _internals: { parseLrc, buildCueLines, buildStructuredLyrics, extractLrcText, sanitizeCacheName } };