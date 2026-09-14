'use strict';

/**
 * 封面 WebP 预处理模块（扫描阶段执行，HTTP 接口不做图片运算）
 *
 * 设计（与《修改建议文档》一致）：
 *  - 扫描阶段从「音频内嵌图片 / 同目录 cover.jpg/folder.jpg」拿到原始图片 Buffer；
 *  - 计算 MD5 -> cover_hash，实现全局去重（相同封面多首歌共享一份磁盘缓存文件）；
 *  - 缓存根目录 = 容器内 /app/data/cache/cover（即 ctx.CACHE_DIR/cover），DB 只记录相对路径 cover_relpath
 *    （形如 cover/<hash>.webp），完整缓存路径 = CACHE_DIR + '/' + cover_relpath；
 *  - sharp 可用时输出 600px 有损 WebP(quality=78) 并删除 Exif；sharp 异常时逐级降级：
 *      JPEG(quality=80) -> 原图直存（仅兜底）；
 *  - 用户音乐目录原始文件只读：这里只读取，从不写入 / 修改。
 *
 * 该模块同时提供「启动自检」：确认 sharp WebP 编码器是否可用，便于排查部署问题。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../core/logger');

const MODULE = 'COVER-CACHE';

// 目录 sidecar 封面文件名（folder.jpg 为常见命名，兼容大小写与前/后置）
const SIDECAR_COVER_NAMES = ['cover.jpg', 'folder.jpg', 'folder.png', 'cover.png', 'Cover.jpg', 'Folder.jpg'];
// 封面（歌曲/专辑）缓存子目录
const COVER_SUBDIR = 'cover';
// 歌手头像独立缓存子目录（与封面分开清理/统计）
const ART_SUBDIR = 'art';
// 网络歌曲封面独立缓存子目录（收藏/播放历史/播放队列的实时封面）。
// 刻意独立于 cover/：cover/ 会被「本地封面孤儿清理」按 local_songs.cover_hash 比对删除，
// 而网络封面不在该引用集内，若混在 cover/ 会每天被误删。
const NET_COVER_SUBDIR = 'netcover';

let sharp = null;
let sharpLoaded = false;   // 是否加载成功（不代表能编码，见自检）
try {
  // eslint-disable-next-line global-require
  sharp = require('sharp');
  sharpLoaded = !!(sharp && typeof sharp === 'function');
} catch {
  sharp = null;
  sharpLoaded = false;
}

// ---------------- 缓存目录管理 ----------------

let rootDir = null; // 显式注入的缓存根（/app/data/cache），由 server.js 在初始化后 setRoot

/** server.js 初始化 CACHE_DIR 后调用，避免与 env 推导出现偏差 */
function setRoot(dir) {
  rootDir = dir || null;
}

/** 缓存根目录解析优先级：显式注入 > 环境变量 > 本地开发默认(backend/../data/cache) */
function getRoot() {
  if (rootDir) return rootDir;
  const envDir = process.env.CACHE_DIR;
  if (envDir) return envDir;
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  return path.join(dataDir, 'cache');
}

/** 按子目录名取缓存目录（自动创建；非法字符剔除） */
function getDir(subdir) {
  const name = String(subdir || COVER_SUBDIR).replace(/[^a-zA-Z0-9_-]/g, '') || COVER_SUBDIR;
  const dir = path.join(getRoot(), name);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    logger.warn(MODULE, 'system', 'Create cache subdir failed', { dir, error: e && e.message });
  }
  return dir;
}

/** 封面缓存子目录（自动创建） */
function getCoverDir() {
  return getDir(COVER_SUBDIR);
}

/** 歌手头像子目录 art/（自动创建） */
function getArtDir() {
  return getDir(ART_SUBDIR);
}

/** 网络歌曲封面子目录 netcover/（自动创建；独立于 cover/，避免被本地封面孤儿清理误删） */
function getNetCoverDir() {
  return getDir(NET_COVER_SUBDIR);
}

/** 由 cover_relpath（cover/xxx.webp）解析磁盘完整路径；防路径穿越 */
function resolveRelpath(relpath) {
  if (!relpath || typeof relpath !== 'string') return null;
  const normalized = relpath.replace(/\\/g, '/');
  const root = getRoot().replace(/\\/g, '/');
  const full = path.join(root, normalized.split('/').join(path.sep));
  const relCheck = path.relative(root, full);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return null; // 越界拒绝
  return full;
}

// ---------------- 工具 ----------------

function md5Hex(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

/** 从 Buffer 首字节猜测图片扩展名（用于 sharp 降级时原图直存） */
function guessImageExt(buf) {
  if (!buf || buf.length < 12) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return '.gif';
  // RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return '.webp';
  return '.jpg';
}

const EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

function mimeOf(filePath) {
  return EXT_MIME[path.extname(filePath).toLowerCase()] || 'image/jpeg';
}

// ---------------- 启动自检（文档四-5：服务启动自检 sharp WebP 编码器） ----------------

/**
 * 测试 sharp 是否可正常加载并完成一次 WebP 编码，返回 { ok, webp, error }。
 * 供服务启动时调用，失败打印部署警告（不影响启动，运行期有降级路径）。
 */
async function selfCheckSharp() {
  if (!sharpLoaded || !sharp) {
    const msg = 'sharp 未加载成功：封面 WebP 缓存不可用，将降级为 JPEG/原图缓存。' +
      '请确认依赖已安装（npm install sharp）且平台二进制匹配（Linux Docker 建议 node:22-bookworm）。';
    logger.warn(MODULE, 'self-check', msg);
    return { ok: false, webp: false, error: msg };
  }
  try {
    // 1x1 PNG → WebP 编码探针
    const probe = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const out = await sharp(probe).webp({ quality: 78 }).toBuffer();
    const webp = !!(out && out.length > 0 && out.slice(0, 4).toString('ascii') === 'RIFF');
    if (webp) {
      logger.info(MODULE, 'self-check', 'sharp WebP encoder OK');
    } else {
      logger.warn(MODULE, 'self-check', 'sharp 已加载但 WebP 编码探针输出异常');
    }
    return { ok: webp, webp, error: webp ? null : 'sharp WebP probe failed' };
  } catch (e) {
    const msg = `sharp WebP 编码测试失败：${e && e.message}`;
    logger.warn(MODULE, 'self-check', msg);
    return { ok: false, webp: false, error: msg };
  }
}

// ---------------- 图片来源读取（只读用户文件） ----------------

/**
 * 读取音频内嵌封面：优先 music-metadata（mp3/flac/m4a/ogg 全格式），
 * 失败时退回 node-id3（仅 mp3）。返回 { buffer, mime } 或 null。永不修改源文件。
 */
async function extractEmbeddedPicture(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    // eslint-disable-next-line global-require
    const mm = require('music-metadata');
    const meta = await mm.parseFile(filePath, { duration: false, skipCovers: false });
    const pics = meta && meta.common && meta.common.picture;
    if (Array.isArray(pics) && pics.length && pics[0] && pics[0].data && pics[0].data.length) {
      return { buffer: pics[0].data, mime: pics[0].format || 'image/jpeg' };
    }
  } catch { /* 非可解析格式或无内嵌封面：走下一层 */ }
  try {
    // eslint-disable-next-line global-require
    const NodeID3 = require('node-id3');
    const tags = NodeID3.read(filePath);
    if (tags && tags.image && tags.image.imageBuffer) {
      return {
        buffer: tags.image.imageBuffer,
        mime: tags.image.mime || tags.image.format || 'image/jpeg'
      };
    }
  } catch { /* 忽略 */ }
  return null;
}

/**
 * 读取同目录 sidecar 封面（cover.jpg / folder.jpg / folder.png / cover.png）。
 * 返回 { buffer, source: 'filesidecar' } 或 null。
 */
function readSidecarCover(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  for (const name of SIDECAR_COVER_NAMES) {
    const filePath = path.join(dir, name);
    if (!fs.existsSync(filePath)) continue;
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile() || st.size <= 0) continue;
      const buffer = fs.readFileSync(filePath);
      if (buffer && buffer.length > 0) {
        return { buffer, source: 'filesidecar' };
      }
    } catch { /* 单个文件失败继续尝试下一个 */ }
  }
  return null;
}

// ---------------- 核心：转码 / 缓存 ----------------

/**
 * 封面转 WebP 主流程（如文档示意 convertCoverToWebp）：
 * 等比缩放最大 600px、小图不放大；有损 WebP quality=78；删除 Exif；写入 toFile。
 */
async function convertCoverToWebp(imageBuf, outputPath) {
  // sharp 输出默认剥离元数据（不保留 Exif，除非显式 keepExif/withExif），体积更小
  await sharp(imageBuf)
    .resize({
      width: 600,
      height: 600,
      fit: 'inside',             // 等比缩放，不拉伸
      withoutEnlargement: true   // 小图不要强行放大
    })
    .webp({
      quality: 78,
      lossless: false
    })
    .toFile(outputPath);
}

/**
 * 扫描阶段封面预处理：
 *  1) 计算图片 MD5（cover_hash）
 *  2) 缓存已存在 {hash}.webp -> 直接复用，跳过转码
 *  3) 否则 sharp 转码写缓存（失败逐级降级：JPEG q80 -> 原图直存）
 * @param {Buffer} imageBuf 原始图片 Buffer
 * @returns {Promise<{ok:boolean, hash:string, relpath:string|null, fileName:string|null,
 *                    cover_source:string, mime:string|null, reused:boolean}>}
 */
async function processCoverBuffer(imageBuf, subdirArg) {
  // 子目录：cover（默认，歌曲/专辑封面）或 art（歌手头像）
  const sub = String(subdirArg || COVER_SUBDIR).replace(/[^a-zA-Z0-9_-]/g, '') || COVER_SUBDIR;
  const empty = { ok: false, hash: '', relpath: null, fileName: null, mime: null, reused: false };
  if (!imageBuf || !imageBuf.length) return empty;

  const hash = md5Hex(imageBuf);
  const dir = getDir(sub);
  const base = path.join(dir, hash);
  let relpath = null;
  let fileName = null;
  let mime = null;
  let reused = false;

  // 尝试复用三种历史/降级扩展缓存（webp 优先，其次 jpg/原图）
  for (const ext of ['.webp', '.jpg', guessImageExt(imageBuf)]) {
    const f = `${hash}${ext}`;
    if (fs.existsSync(path.join(dir, f))) {
      relpath = `${sub}/${f}`;
      fileName = f;
      mime = EXT_MIME[ext] || 'image/jpeg';
      reused = true;
      break;
    }
  }
  if (relpath) return { ok: true, hash, relpath, fileName, mime, cover_source: '', reused };

  try {
    if (sharpLoaded && sharp) {
      await convertCoverToWebp(imageBuf, `${base}.webp`);
      relpath = `${sub}/${hash}.webp`;
      fileName = `${hash}.webp`;
      mime = 'image/webp';
    } else {
      throw new Error('sharp unavailable');
    }
  } catch (err) {
    // 降级 1：sharp 异常 -> JPEG quality 80（仍尝试缩放，但不可用时直接进入下一级）
    try {
      if (sharpLoaded && sharp) {
        await sharp(imageBuf)
          .resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toFile(`${base}.jpg`);
        relpath = `${sub}/${hash}.jpg`;
        fileName = `${hash}.jpg`;
        mime = 'image/jpeg';
      } else {
        throw err;
      }
    } catch (err2) {
      // 降级 2：直接保存原图 buffer（仅兜底，保证有封面可用）
      try {
        const ext = guessImageExt(imageBuf);
        fs.writeFileSync(`${base}${ext}`, imageBuf);
        relpath = `${sub}/${hash}${ext}`;
        fileName = `${hash}${ext}`;
        mime = EXT_MIME[ext] || 'image/jpeg';
      } catch (err3) {
        logger.warn(MODULE, 'cover', 'Save fallback cover failed', { error: err3 && err3.message });
        return empty;
      }
      logger.warn(MODULE, 'cover', 'Cover fallback to raw file (sharp failed)', { error: err2 && err2.message, fileName });
    }
    if (!relpath) return empty;
  }

  return { ok: true, hash, relpath, fileName, mime, reused: false };
}

/** 歌手头像：独立写入 art/ 目录（<内容MD5>.webp），与封面 cover/ 分开管理 */
async function processArtistBuffer(imageBuf) {
  return processCoverBuffer(imageBuf, ART_SUBDIR);
}

/**
 * 按指定文件名写入一张封面 WebP（不按图片内容算 hash，文件名由调用方决定）。
 * 用于「专辑封面」等需要稳定文件名（如 al-<md5(artist\u0000album)>.webp）的缓存，
 * 内容通常复制自该专辑代表歌曲的封面图。返回 { ok, relpath, hash }。
 */
async function writeNamedCoverWebp(imageBuf, name) {
  if (!imageBuf || !imageBuf.length || !name) return { ok: false, relpath: null, hash: null };
  const safeName = String(name).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeName) return { ok: false, relpath: null, hash: null };
  const dir = getCoverDir();
  const outPath = path.join(dir, `${safeName}.webp`);
  try {
    if (sharpLoaded && sharp) {
      await convertCoverToWebp(imageBuf, outPath);
    } else {
      fs.writeFileSync(outPath, imageBuf); // 兜底：sharp 不可用时原图直存（仍用 .webp 名）
    }
    return { ok: true, relpath: `${COVER_SUBDIR}/${safeName}.webp`, hash: md5Hex(imageBuf) };
  } catch (e) {
    logger.warn(MODULE, 'cover', 'writeNamedCoverWebp failed', { name: safeName, error: e && e.message });
    return { ok: false, relpath: null, hash: null };
  }
}

/** 按图片 URL 主机启发式取 Referer（绕过酷狗/网易/QQ 等 CDN 防盗链）；未知主机回退同源 */
function guessImageReferer(url) {
  try {
    const u = new URL(url);
    const host = String(u.host || '').toLowerCase();
    if (host.includes('kugou') || host.includes('kgimg')) return 'https://www.kugou.com/';
    if (host.includes('kuwo')) return 'https://www.kuwo.cn/';
    if (host.includes('music.163.com') || host.includes('126.net') || host.includes('netease')) return 'https://music.163.com/';
    if (host.includes('y.qq.com') || host.includes('yqq') || host.includes('gtimg')) return 'https://y.qq.com/';
    if (host.includes('douyin') || host.includes('douyinpic')) return 'https://music.douyin.com/';
    if (host.includes('migu') || host.includes('miguimg')) return 'https://music.migu.cn/';
    if (host.includes('bilibili') || host.includes('bili')) return 'https://www.bilibili.com/';
    return u.origin ? `${u.origin}/` : null; // 未知 CDN：回退同源 Referer
  } catch { /* 解析失败 */ return null; }
}

/**
 * 下载远程封面图（http/https）为 Buffer，供「播放补全搜到的远程封面」统一转成 WebP 缓存落库。
 * - 自动附加 UA + 主机启发式 Referer（防盗链），失败返回 null（含 403/超时/非图片/超 25MB）。
 * - 支持 data:image URI 直接解析；不抛异常。
 */
async function fetchRemoteImageBuffer(url) {
  if (!url) return null;
  const u = String(url).trim();
  const dataMatch = u.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (dataMatch) {
    const buf = Buffer.from(dataMatch[2], 'base64');
    return buf && buf.length ? buf : null;
  }
  if (!/^https?:\/\//i.test(u)) return null;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: guessImageReferer(u) || ''
  };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 15000) : null;
  try {
    const resp = await fetch(u, { headers, redirect: 'follow', signal: controller ? controller.signal : undefined });
    if (!resp || !resp.ok) return null;
    const ct = String(resp.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.startsWith('image/')) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf || !buf.length || buf.length > 25 * 1024 * 1024) return null;
    return buf;
  } catch { /* 网络失败/超时/解析失败 */ return null; }
  finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------- 封面缓存清理辅助（供定时任务使用） ----------------

/** 列出指定缓存子目录下全部文件名 */
function listDirFiles(subdir) {
  const dir = getDir(subdir);
  try {
    return fs.readdirSync(dir).filter((f) => {
      try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
    });
  } catch {
    return [];
  }
}

/** 列出封面缓存目录（cover/）下全部文件名（兼容旧调用） */
function listCoverFiles() {
  return listDirFiles(COVER_SUBDIR);
}

/** 列出歌手头像目录（art/）下全部文件名 */
function listArtFiles() {
  return listDirFiles(ART_SUBDIR);
}

/** 由 cover_relpath 得到缓存文件名（cover/abc.webp -> abc.webp） */
function fileNameFromRelpath(relpath) {
  if (!relpath) return null;
  const n = String(relpath).replace(/\\/g, '/');
  return n.slice(n.lastIndexOf('/') + 1);
}

module.exports = {
  setRoot,
  getRoot,
  getDir,
  getCoverDir,
  getArtDir,
  resolveRelpath,
  md5Hex,
  mimeOf,
  guessImageExt,
  selfCheckSharp,
  extractEmbeddedPicture,
  readSidecarCover,
  convertCoverToWebp,
  processCoverBuffer,
  processArtistBuffer,
  writeNamedCoverWebp,
  fetchRemoteImageBuffer,
  listDirFiles,
  listCoverFiles,
  listArtFiles,
  fileNameFromRelpath,
  COVER_SUBDIR,
  NET_COVER_SUBDIR,
  getNetCoverDir
};
