'use strict';

/**
 * 网络歌曲封面统一落盘缓存（OpenSubsonic getCoverArt 网络代理路径使用）
 *
 * 目标：
 *  - 首次为某远程封面执行代理时，把图片转成 WebP 存 CACHE_DIR/netcover/{图片MD5}.webp
 *    （文件名 = 图片内容 MD5；独立 netcover/ 子目录，避免被本地封面孤儿清理误删）；
 *  - 建立「远程 URL / data-URI -> cover_relpath」持久索引（存 settings 表），
 *    进程重启后同一 URL 直接命中磁盘文件，不再重复下载/转码；
 *  - HTTP 层只做静态 sendFile，不反复实时下载远程图。
 *
 * 注意：本模块不含任何业务路由，仅由 rest/opensubsonic.js 的 getCoverArt 网络分支使用。
 */

const fs = require('fs');
const coverCache = require('./cover-cache');

let database = null;
let loaded = false;
let loading = null;
let dirty = false;
let saveTimer = null;

// 远程 URL -> cover_relpath（cover/xxx.webp）
const urlIndex = new Map();
const INDEX_KEY = 'netcover_url_index';
const MAX_ENTRIES = 5000;

/** 绑定数据库（提供 getSetting/saveSetting），由调用方注入 ctx.database */
function useDb(db) {
  if (db) database = db;
}

/** 首次使用时从 settings 加载持久索引（幂等） */
function ensureLoaded() {
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  if (!database) return Promise.resolve();
  loading = database.getSetting(INDEX_KEY, '{}')
    .then((raw) => {
      try {
        const obj = JSON.parse(String(raw == null ? '{}' : raw));
        if (obj && typeof obj === 'object') {
          for (const k of Object.keys(obj)) {
            if (urlIndex.size >= MAX_ENTRIES) break;
            urlIndex.set(k, String(obj[k]));
          }
        }
      } catch { /* 索引损坏忽略 */ }
    })
    .catch(() => { /* 数据库不可用忽略 */ })
    .finally(() => { loaded = true; loading = null; });
  return loading;
}

function relpathFor(url) {
  return url ? (urlIndex.get(String(url)) || null) : null;
}

function scheduleSave() {
  if (!database || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 5000);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

function flush() {
  if (!dirty || !database) return;
  dirty = false;
  database.saveSetting(INDEX_KEY, JSON.stringify(Object.fromEntries(urlIndex)))
    .catch(() => { /* 保存失败下次再写 */ });
}

async function remember(url, relpath) {
  if (!url || !relpath) return;
  await ensureLoaded();
  const key = String(url);
  // 超长键（如超大 data: URI）不持久化索引，仅落盘文件（下次由文件 hash 命中复用磁盘）
  if (key.length <= 768 && urlIndex.size < MAX_ENTRIES) {
    urlIndex.set(key, relpath);
    dirty = true;
    scheduleSave();
  }
}

/** 磁盘缓存文件是否真实存在 */
function diskFileFor(relpath) {
  if (!relpath) return null;
  const full = coverCache.resolveRelpath(relpath);
  if (full && fs.existsSync(full)) return full;
  return null;
}

/**
 * 按远程 URL 取磁盘缓存并返回 { full, relpath, mime }；无缓存/文件缺失返回 null。
 */
async function cachedForUrl(url) {
  await ensureLoaded();
  const rel = relpathFor(url);
  if (!rel) return null;
  const full = diskFileFor(rel);
  if (!full) {
    urlIndex.delete(String(url)); // 文件已不在：清掉失效索引
    return null;
  }
  return { full, relpath: rel, mime: coverCache.mimeOf(full) };
}

/**
 * 下载远程封面并统一转 WebP 落盘（先查磁盘缓存，命中则不再下载）。
 * @returns {Promise<{full:string, relpath:string, mime:string}|null>}
 */
async function fetchAndLocalize(url) {
  const u = String(url || '').trim();
  if (!u || !/^https?:\/\//i.test(u)) return null;
  const cached = await cachedForUrl(u);
  if (cached) return cached;
  const buf = await coverCache.fetchRemoteImageBuffer(u);
  if (!buf) return null;
  // 固定落 netcover/：独立于 cover/，防止被「本地封面孤儿清理」按 local_songs 引用集删除
  return localizeBytes(u, buf, 'netcover');
}

/**
 * 用已取得的图片字节落盘（避免重复下载）：转 WebP 存 {subdir}/{md5}.webp，并登记索引。
 * @param {string} url 远程 URL（作持久索引 key）
 * @param {Buffer} buf 图片字节
 * @param {string} [subdir] 缓存子目录：cover（默认，歌曲/专辑封面）或 art（歌手头像）
 */
async function localizeBytes(url, buf, subdir) {
  if (!url || !buf || !buf.length) return null;
  const safeSub = String(subdir || 'cover').replace(/[^a-zA-Z0-9_-]/g, '') || 'cover';
  const proc = await coverCache.processCoverBuffer(buf, safeSub);
  if (!proc || !proc.ok) return null;
  await remember(String(url), proc.relpath);
  const full = diskFileFor(proc.relpath);
  return full ? { full, relpath: proc.relpath, mime: proc.mime } : null;
}

/**
 * 按远程 URL 删除封面缓存：磁盘文件 + 持久索引一并清掉。
 * 网络歌曲缓存记录被淘汰时调用，避免封面文件在磁盘上无限累积。
 * 注意：文件名 = 图片内容 MD5，多 URL 可能共享同一文件——调用方应先做引用检查
 * （见 database.js cleanupNetCoverCacheForSongs）；误删也无数据损失，下次访问会重新下载落盘。
 * @param {string} url 远程封面 URL（持久索引 key）
 * @returns {Promise<boolean>} 是否实际删除了磁盘文件
 */
async function deleteCoverByUrl(url) {
  const u = String(url || '').trim();
  if (!u) return false;
  await ensureLoaded();
  const rel = urlIndex.get(u);
  if (!rel) return false;
  urlIndex.delete(u);
  dirty = true;
  scheduleSave();
  let removed = false;
  const full = coverCache.resolveRelpath(rel);
  if (full && fs.existsSync(full)) {
    try { fs.unlinkSync(full); removed = true; } catch { /* 文件占用等忽略 */ }
  }
  return removed;
}

module.exports = {
  useDb,
  ensureLoaded,
  cachedForUrl,
  fetchAndLocalize,
  localizeBytes,
  diskFileFor,
  deleteCoverByUrl
};
