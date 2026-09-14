'use strict';

// ==================== 本地音乐（本地文件夹）====================
// 路由归属：/api/music/*（与 routes/music.js 的 /api/search /api/play 等不冲突）
// 数据源：MUSIC_DIR（容器内默认 /app/music），递归扫描其中的音频文件。
// 播放复用既有的 /api/local-files/stream?path=<容器绝对路径>，前端歌曲对象带 plugin='local'。
//
// 提供接口：
//   GET  /api/music/songs    全部歌曲（含 filePath / 元数据）
//   GET  /api/music/artists  歌手聚合（含封面代表文件 coverPath）
//   GET  /api/music/albums   专辑聚合
//   GET  /api/music/folders  根目录结构（子文件夹 + 根目录歌曲）
//   GET  /api/music/folder?path=<相对目录>  指定目录结构（文件夹 tab 逐层浏览）
//   GET  /api/music/cover?relpath=<cover_relpath>  静态返回扫描期生成的 WebP 封面缓存（零图片运算）
//   GET  /api/music/cover?path=<文件路径>          按歌曲路径反查封面缓存；无缓存时兜底读文件内嵌（升级过渡期）
//   POST /api/music/rescan   强制重新扫描（全量重读文件）
// 封面/歌词处理原则：图片转码(sharp WebP)与歌词读取全部在扫描阶段完成并写入数据库；
// 用户音乐目录原始文件只读（从不写入/修改）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const NodeID3 = require('node-id3');
const { authMiddleware, adminMiddleware } = require('../lib/middleware');
const { ok, serverError } = require('../lib/respond');
const logger = require('../core/logger');
const { enrichLocalMusic, fetchArtistImage, fetchAlbumImage, extractAlbum, extractDuration, resolveConfiguredPlugins } = require('../lib/local-enrich');
// 封面 WebP 预处理（扫描阶段转码缓存；HTTP 接口只静态返回，零图片运算）
const coverCache = require('../lib/cover-cache');
// 歌词解析（原始文本 -> 结构化时间轴 JSON）
const lrcUtils = require('../lib/lrc-utils');
// 本地音乐库持久化（SQLite）：扫描结果落库，开机从数据库快速加载到内存，避免重启后全量读文件标签。
// 该模块在无 sqlite3 环境（冒烟测试）下会自动降级为空实现。
const localLibraryDb = require('../lib/local-library-db');
// 阶段化流水线编排（阶段1-3 + 状态机）；阶段0由本文件的扫描负责
const localPipeline = require('../lib/local-pipeline');
// 全局封面补全队列（单并发闸 + 限速）：歌手头像 / 专辑封面的即时补全与后台补全统一收敛于此
const coverFillQueue = require('../lib/cover-fill-queue');

const MUSIC_DIR = process.env.MUSIC_DIR || path.join(__dirname, '..', '..', 'music');

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus']);

// 各格式 MIME 类型（OpenSubsonic 流/下载需要）
const CONTENT_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg'
};

// 各格式默认码率（kbps），用于缺少真实码率时估算时长
const DEFAULT_BITRATE = {
  '.mp3': 128,
  '.m4a': 256,
  '.aac': 128,
  '.flac': 900,
  '.wav': 1411,
  '.ogg': 160,
  '.opus': 160
};

function md5(str) {
  return crypto.createHash('md5').update(String(str)).digest('hex');
}

// ---------------- 元数据来源标记 ----------------
// 便于排查「这条数据是哪来的」：id3=音频内嵌标签，path=目录路径解析，plugin=元数据插件，
// manual=用户手动编辑，mixed=三个核心字段来源不同（仅整体标记 metaSource 会出现）。
const META_SRC = {
  ID3: 'id3',
  PATH: 'path',
  PLUGIN: 'plugin',
  MANUAL: 'manual'
};
// 占位值一律视为「无有效值」（否则会误判核心字段已完整，导致跳过插件补空）
const PLACEHOLDER_ARTIST = new Set(['未知艺术家', '未知歌手', '未知']);
const PLACEHOLDER_ALBUM = new Set(['未知专辑', '未知']);

/** 有效值判定：非空且非占位值 */
function isRealValue(v, placeholders) {
  const s = (v == null ? '' : String(v).trim());
  if (!s) return false;
  return !(placeholders && placeholders.has(s));
}

/** 合并三个核心字段来源为整体来源标记 */
function combineMetaSource(a, b, c) {
  const uniq = Array.from(new Set([a, b, c].filter(Boolean)));
  if (!uniq.length) return 'none';
  return uniq.length === 1 ? uniq[0] : 'mixed';
}

/**
 * 目录路径解析（标准层级：音乐根目录 / 艺术家文件夹 / 专辑文件夹 / 媒体文件）
 *  - 三级及以上：艺术家 = 第一个文件夹（二级），专辑 = 第二个文件夹（三级）
 *    （更深层级的分碟目录 Disc1/CD2 不影响前两级取值）
 *  - 两级（缺艺术家层级）：专辑 = 文件直接所在文件夹，艺术家留空 → 交给插件补空
 *  - 一级（文件直接扔根目录）：艺术家、专辑均留空 → 交给插件补空
 *  - 专辑文件夹可带年份，如「口袋（2010）」「Greatest(1998)」：年份单独提出（19xx/20xx），
 *    专辑名剥离年份括号段后展示（避免聚合出「口袋（2010）」「口袋(2010)」等多个专辑名）
 * @param {string} rel 相对音乐根目录的路径（如 刘珂矣/半壶纱/01-半壶纱.mp3）
 * @returns {{artist:string, album:string, year:string}}
 */
function parsePathMeta(rel) {
  const parts = String(rel || '').split('/').filter(Boolean);
  // 三级及以上：艺术家 = 二级文件夹；两级（缺艺术家层级）留空交插件补空
  const artist = parts.length >= 3 ? parts[0] : '';
  let album = parts.length >= 3 ? parts[1] : (parts.length === 2 ? parts[0] : '');
  let year = '';
  const m = String(album).match(/[（(]\s*((?:19|20)\d{2})\s*[）)]/);
  if (m) {
    year = m[1];
    album = String(album)
      .replace(/[（(]\s*(?:19|20)\d{2}\s*[）)]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  return { artist, album, year };
}

/**
 * 文件名解析：开头数字为轨道号，分隔符之后为歌曲标题（艺术家一律由目录决定，不从文件名猜测）。
 * 兼容历史命名「歌名 - 歌手.ext」：无轨道号时取首个 " - " 之前的部分作为标题。
 * @returns {{title:string, track:number|null}}
 */
function parseFilename(fileName) {
  const ext = path.extname(fileName);
  let base = path.basename(fileName, ext).trim();
  let track = null;
  // 轨道号：1-3 位数字 + 分隔符（空格 . - _ – — ‐ ‑ 等）+ 标题
  const m = base.match(/^(\d{1,3})[\s.\-_–—‐-―、]+(.+)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    // 仅 1-999 记为轨道号；「00」等无效序号同样剥离数字前缀（否则污染标题）
    if (n > 0 && n < 1000 && String(m[2]).trim()) track = n;
    base = String(m[2]).trim();
  }
  // 旧命名兼容「歌名 - 歌手」：标题取首个 " - " 之前的部分（艺术家一律由目录决定）。
  // 对「01 - 歌名 - 歌手」剥离轨道号后同样适用；无轨道号的「歌名 - 歌手」不受影响。
  const idx = base.indexOf(' - ');
  if (idx > 0) base = base.slice(0, idx).trim();
  return { title: base, track };
}

function estimateDuration(size, suffix) {
  if (!size || size <= 0) return null;
  const kbps = DEFAULT_BITRATE[suffix] || 128;
  return Math.max(1, Math.round((size * 8) / (kbps * 1000)));
}

// ---------------- 内存状态 ----------------
const state = {
  songs: [],
  artists: [],
  albums: [],
  dirs: [],           // 所有子目录相对路径（含空目录，字母排序）
  folderMap: new Map(),   // 相对目录 -> { folders:Set<相对路径>, songs:[] }
  dir: null,
  sig: '',
  lastFreshCheckMs: 0,
  coverCache: new Map()   // filePath -> { mime, buffer } | null
};

// 扫描 / 补全进度（供 /api/music/scan-status 轮询）
// 任何触发源都会登记为一个 job：启动后台扫描(startup)、目录监听(monitor)、
// 定时任务(scheduled)、手动扫描(manual)、设置页补图(fill)。前端据此始终显示
// 顶栏进度圆圈，并允许「停止」。
const scanProgress = {
  scanning: false,
  phase: 'idle',          // 'scan' 文件扫描中 | 'backfill' 补全歌曲封面/专辑/时长中 | 'album' 补专辑封面中 | 'done' | 'cancelled' | 'error'
  total: 0,
  scanned: 0,
  error: null,
  jobId: 0,               // 当前任务序号（新任务开始即自增，过期任务不得覆盖状态）
  trigger: '',            // 触发源：startup / monitor / scheduled / manual / fill
  label: '',              // 展示用任务名（如「补全歌曲封面」）
  cancelRequested: false, // 是否已请求停止
  cancelable: false,      // 当前任务能否停止
  updatedAt: 0
};

// 触发源 → 展示名（顶栏进度圆圈用）
const TRIGGER_LABEL = {
  startup: '首次扫描音乐库',
  monitor: '扫描音乐（目录变更）',
  scheduled: '定时扫描音乐',
  manual: '扫描音乐',
  fill: '补全音乐资料'
};

// ---------------- 任务控制（进度上报 + 可停止） ----------------
let jobSeq = 0;
let activeJobId = 0;
let cancelRequested = false;

/** 登记一个新任务（扫描或补全），返回任务 id。phase 默认 'scan' */
function beginJob(trigger, label, phase) {
  jobSeq += 1;
  activeJobId = jobSeq;
  cancelRequested = false;
  scanProgress.scanning = true;
  scanProgress.phase = phase || 'scan';
  scanProgress.total = 0;
  scanProgress.scanned = 0;
  scanProgress.error = null;
  scanProgress.jobId = activeJobId;
  scanProgress.trigger = trigger || '';
  scanProgress.label = label || '';
  scanProgress.cancelRequested = false;
  scanProgress.cancelable = true;
  scanProgress.updatedAt = Date.now();
  return activeJobId;
}

/** 结束任务；过期任务（已被新任务取代）不得覆盖当前状态 */
function endJob(jobId, opts) {
  if (jobId && jobId !== activeJobId) return scanProgress;
  const o = opts || {};
  scanProgress.scanning = false;
  scanProgress.phase = o.cancelled ? 'cancelled' : (o.error ? 'error' : 'done');
  scanProgress.error = o.error || null;
  scanProgress.cancelRequested = false;
  scanProgress.cancelable = false;
  cancelRequested = false;
  scanProgress.updatedAt = Date.now();
  // 流水线状态归位：monitor 触发只跑阶段0（reportStage0 置 STAGE0_PARSING），任务结束若不清理，
  // 该状态会永久残留 → 前端把空闲误判为运行中（圆圈常驻/读到残留百分比）。此处归位为幂等操作。
  // 但仅当后台流水线（monitor fire-and-forget 的阶段1-8）不在跑时才归位——
  // 否则刚 beginRun 的 RUNNING 状态被立即抹成 IDLE：进度圈不可见、停滞看门狗失效、后续触发全被拒。
  if (!localPipeline.isRunning()) {
    localPipeline.setIdle();
  }
  return scanProgress;
}

/** 任务内循环用的停止检查 */
function isCancelRequested() {
  return cancelRequested;
}

/** 请求停止当前任务（没有运行中的任务时返回 false） */
function requestCancel() {
  if (!scanProgress.scanning) return false;
  cancelRequested = true;
  scanProgress.cancelRequested = true;
  scanProgress.updatedAt = Date.now();
  // 同步中断阶段化流水线（当前正在执行的任务允许跑完，不再生成新任务）
  localPipeline.requestAbort();
  return true;
}

// ---------------- 目录变化实时监听（OS fs.watch，非轮询） ----------------
let fsWatcher = null;
let fsWatchTimer = null;
const FS_WATCH_DEBOUNCE_MS = 2500; // 风险2：批量拷贝文件防抖 2.5s，文件写入稳定后再统一触发，避免事件风暴

/** 变更事件去抖后触发一次全量重扫（连续拷贝/批量改名会合并为一次） */
function scheduleFsRescan() {
  if (fsWatchTimer) return;
  fsWatchTimer = setTimeout(() => {
    fsWatchTimer = null;
    fsRescanNow();
  }, FS_WATCH_DEBOUNCE_MS);
}

function fsRescanNow() {
  if (scanProgress.scanning) {
    // 正在扫描中：标记稍后再扫一次，避免丢变更
    scheduleFsRescan();
    return;
  }
  const dir = (state.dir && fs.existsSync(state.dir)) ? state.dir : MUSIC_DIR;
  if (!dir || !fs.existsSync(dir)) return;
  try {
    logger.debug('API', 'local-music', 'Fs change detected, rescanning', { dir });
    scan(dir, 'monitor');
  } catch (e) {
    logger.warn('API', 'local-music', 'Auto rescan on fs change failed', { error: e && e.message });
  }
}

/** 启动 MUSIC_DIR 的系统级递归监听（幂等；失败时保留请求触发的指纹兜底） */
function startFsWatcher() {
  if (fsWatcher) return;
  if (!fs.existsSync(MUSIC_DIR)) return;
  try {
    const w = fs.watch(MUSIC_DIR, { recursive: true }, (eventType, filename) => {
      // 忽略歌词落盘 .lrc / 封面缓存等非媒体文件变更：不触发全量重扫
      const name = String(filename || '');
      if (name.toLowerCase().endsWith('.lrc')) return;
      scheduleFsRescan();
    });
    fsWatcher = w;
    w.on('error', (err) => {
      logger.warn('API', 'local-music', 'fs.watch error, watcher disabled', { error: err && err.message });
      try { w.close(); } catch { /* ignore */ }
      if (fsWatcher === w) fsWatcher = null;
    });
    logger.debug('API', 'local-music', 'OS-level watcher started', { dir: MUSIC_DIR });
  } catch (e) {
    fsWatcher = null;
    logger.warn('API', 'local-music', 'fs.watch(recursive) unavailable, fallback to lazy fingerprint check', { error: e && e.message });
  }
}

// ---------------- 递归扫描 ----------------

// 递归收集音频文件（含 .strm 文本指向文件）
function walkAudio(dir, out, rel) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const relPath = rel ? path.join(rel, e.name).replace(/\\/g, '/') : e.name;
    if (e.isDirectory()) {
      walkAudio(full, out, relPath);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (AUDIO_EXTS.has(ext)) {
        out.push({ full, rel: relPath, kind: 'audio' });
      } else if (ext === '.strm') {
        out.push({ full, rel: relPath, kind: 'strm' });
      }
    }
  }
}

// 递归收集所有子目录相对路径（含空目录）
function collectDirs(dir, out, rel) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    out.push(relPath);
    collectDirs(full, out, relPath);
  }
}

// 递归目录指纹（文件名:大小:修改时间），用于检测目录变化自动重扫
function computeSig(dir) {
  const parts = [];
  const walk = (d, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(full, relPath);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        // .strm 也计入指纹：否则 strm 新增/改动无法被自动感知，只能重启后端才入库
        if (AUDIO_EXTS.has(ext) || ext === '.strm') {
          let st;
          try { st = fs.statSync(full); } catch { continue; }
          parts.push(`${relPath}:${st.size}:${Math.round(st.mtimeMs)}`);
        }
      }
    }
  };
  walk(dir, '');
  return parts.sort().join('\n');
}

// 确保目录链上的每个层级都存在文件夹条目
function ensureFolder(folderMap, relDir) {
  const parts = relDir ? relDir.split('/') : [];
  let cur = '';
  for (let i = 0; i < parts.length; i++) {
    const child = cur ? `${cur}/${parts[i]}` : parts[i];
    if (!folderMap.has(cur)) folderMap.set(cur, { folders: new Set(), songs: [] });
    folderMap.get(cur).folders.add(child);
    cur = child;
  }
  if (!folderMap.has(cur)) folderMap.set(cur, { folders: new Set(), songs: [] });
  return cur;
}

/** 封面预处理成功后的写回：song 对象记录 cover_hash / cover_relpath / cover_source / has_cover */
function applyCoverToSong(song, proc, source) {
  if (proc && proc.ok && proc.relpath) {
    song.coverHash = proc.hash || null;
    song.coverRelpath = proc.relpath;
    song.coverSource = source || 'embedded';
    song.hasCover = true;
    song.artwork = coverArtUrl(song.coverRelpath, song.filePath);
  } else {
    song.hasCover = false;
    song.coverHash = null;
    song.coverRelpath = null;
    song.coverSource = 'none';
    song.artwork = null;
  }
}

/** 歌词写入写回：lyric_raw 原文 + lyric_struct 结构化 JSON + lyric_source */
function applyLyricsToSong(song, lyric) {
  song.lyricRaw = (lyric && lyric.raw) || null;
  song.lyricStruct = (lyric && lyric.struct) || null;
  song.lyricSource = (lyric && lyric.source) || 'none';
}

/** 歌曲封面 HTTP 完整 URL：优先磁盘 WebP 缓存（relpath），其次历史 path= 兜底 */
function coverArtUrl(coverRelpath, filePath) {
  if (coverRelpath) return `/api/music/cover?relpath=${encodeURIComponent(coverRelpath)}`;
  if (filePath) return `/api/music/cover?path=${encodeURIComponent(filePath)}`;
  return null;
}

// 纯内存方案：流水线把下载成功的封面/头像「本地 webp 路径」绑定到 local_songs 的
// album_cover_* / artist_cover_* 冗余列（与歌曲封面隔离）；列表接口在此按实体名
// 查询绑定路径（内存优先、DB 兜底），按键缓存避免每请求查库。
const entityCoverCache = new Map(); // key -> { rel: string|null, at: number }
// 负结果（尚未落盘，图片仍在后台 worker 下载）短 TTL 后重试；正结果长期有效
const ENTITY_COVER_NEG_TTL_MS = 30 * 1000;

/**
 * 解析实体的远程封面落盘路径（album / artist）。
 * @param {'album'|'artist'} kind
 * @param {string} name 专辑名或歌手名
 * @param {string} [artist] 专辑的歌手（kind='album' 时用于精确定位）
 * @returns {Promise<string|null>} webp relpath，未落盘返回 null
 */
async function resolveEntityCoverRelpath(kind, name, artist) {
  const key = md5(`${kind}\u0000${String(artist || '')}\u0000${String(name || '')}`);
  const now = Date.now();
  const hit = entityCoverCache.get(key);
  if (hit && (hit.rel || now - hit.at < ENTITY_COVER_NEG_TTL_MS)) return hit.rel;
  let rel = null;
  try {
    // 纯内存方案：直接读业务表绑定的本地 webp 路径（不再有 remote URL 间接层）
    rel = kind === 'artist'
      ? await localLibraryDb.getArtistCoverRelpath(name)
      : await localLibraryDb.getAlbumRealCoverRelpath(name, artist);
    if (rel) {
      const full = coverCache.resolveRelpath(rel);
      if (!full || !fs.existsSync(full)) rel = null; // 文件丢失：下次重扫重新搜索下载
    }
  } catch (e) { /* 查库失败按无封面处理，不影响列表返回 */ }
  entityCoverCache.set(key, { rel, at: now });
  return rel;
}

/** 扫描/重建专辑封面后清空解析缓存，保证列表能拿到最新的落盘 webp */
function invalidateEntityCoverCache() {
  entityCoverCache.clear();
}

/** 列表接口输出视图：剔除歌词原文/结构化 JSON 等大文本字段，避免整库 JSON 响应与前端负载膨胀。
 * 歌词始终以数据库为准，播放歌词接口单独按需读取。 */
function publicSongView(s) {
  if (!s) return s;
  const view = { ...s };
  delete view.lyricRaw;
  delete view.lyricStruct;
  return view;
}

/** 封面预处理：音频内嵌优先，其次目录 cover.jpg/folder.jpg；输出 WebP 磁盘缓存并写回 song */
async function processSongCover(song, full) {
  if (!song || !full) return;
  try {
    let buffer = null;
    let source = 'none';
    const embedded = await coverCache.extractEmbeddedPicture(full);
    if (embedded) {
      buffer = embedded.buffer;
      source = 'embedded';
    }
    if (!buffer) {
      const sc = coverCache.readSidecarCover(path.dirname(full));
      if (sc) {
        buffer = sc.buffer;
        source = 'filesidecar';
      }
    }
    if (buffer) {
      const proc = await coverCache.processCoverBuffer(buffer);
      applyCoverToSong(song, proc, source);
      if (!proc || !proc.ok) {
        // 封面处理失败（图片损坏等）：has_cover=0 标记无封面，不中断整体扫描
        logger.debug('API', 'local-music', 'cover process returned empty', { rel: song.folder && song.fileName });
      }
    } else {
      song.hasCover = false;
      song.coverSource = 'none';
    }
  } catch (err) {
    // 异常防御：单条封面解析失败只跳过本条，不影响整体扫描任务
    song.hasCover = false;
    song.coverSource = 'none';
    logger.warn('API', 'local-music', 'cover process failed, skip song cover', { full, error: err && err.message });
  }
}

/**
 * 把「插件补全搜到的远程封面」（strm / 无内嵌封面 / 无目录封面歌曲）下载后统一转成 WebP
 * 缓存文件并写回 song（cover_hash/cover_relpath/has_cover）。写一次即永久落库，
 * 之后 HTTP / getCoverArt 均静态返回缓存文件，不再依赖远程图。失败不影响整体补全。
 */
async function ensureRemoteCoverFile(song, remoteCoverUrl) {
  if (!song || !remoteCoverUrl || song.coverRelpath) return false;
  try {
    const buf = await coverCache.fetchRemoteImageBuffer(remoteCoverUrl);
    if (!buf) {
      logger.info('API', 'local-music', `【歌曲封面】《${song.title || '-'}》/《${song.artist || '-'}》 状态:搜到 地址:${remoteCoverUrl} → 下载:失败`);
      logger.debug('API', 'local-music', 'remote cover download failed (skip localize)', { rel: song.relPath || song.fileName, url: String(remoteCoverUrl).slice(0, 120) });
      return false;
    }
    const proc = await coverCache.processCoverBuffer(buf);
    if (!proc || !proc.ok) {
      logger.info('API', 'local-music', `【歌曲封面】《${song.title || '-'}》/《${song.artist || '-'}》 状态:搜到 地址:${remoteCoverUrl} → 下载:失败(转码失败)`);
      logger.warn('API', 'local-music', 'remote cover transcode failed (skip localize)', { rel: song.relPath || song.fileName });
      return false;
    }
    song.coverHash = proc.hash || null;
    song.coverRelpath = proc.relpath;
    song.coverSource = 'network'; // 来源：网络插件补全（已本地化为 WebP 缓存文件）
    song.hasCover = true;
    song.artwork = coverArtUrl(song.coverRelpath, song.filePath);
    if (song.coverUrl) {
      delete song.coverUrl; // 已本地化为缓存文件，不再保留远程 URL
    }
    logger.info('API', 'local-music', `【歌曲封面】《${song.title || '-'}》/《${song.artist || '-'}》 状态:搜到 地址:${remoteCoverUrl} → 下载:成功 入库:${proc.relpath}`);
    logger.debug('API', 'local-music', 'remote cover localized to webp cache', { rel: song.relPath || song.fileName, relpath: proc.relpath });
    return true;
  } catch (e) {
    logger.warn('API', 'local-music', 'remote cover localize exception', { rel: song.relPath || song.fileName, error: e && e.message });
    return false;
  }
}

// 处理单个音频文件：构建歌曲对象并更新歌手/专辑/目录聚合。
// 仅在文件 mtime 变化时被调用（增量扫描核心）：重新解析标签 + 封面 WebP 预处理 + 歌词读取；
// 未变化的文件在 performScan 中被整体复用，跳过元数据解析、封面提取，避免无谓 CPU 开销。
async function processFile(full, rel, songs, artistMap, albumMap, folderMap) {
  let stat;
  try { stat = fs.statSync(full); } catch { return null; }

  const suffix = path.extname(full).toLowerCase();
  let tags = {};
  try { tags = NodeID3.read(full) || {}; } catch { tags = {}; }

  // 元数据优先级：音频内嵌 ID3 标签 → 目录路径（仅补空）→ 元数据插件（阶段1按需，仅补空）
  // 目录由人工规整维护，可信度高；核心字段（艺术家/专辑/标题）阶段0 拿齐则阶段1 零插件请求。
  const dirOf = rel.indexOf('/') >= 0 ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const dirMeta = parsePathMeta(rel);
  const fnMeta = parseFilename(path.basename(full));
  const baseName = path.basename(full, suffix);

  const tagTitle = tags.title != null ? String(tags.title).trim() : '';
  const tagArtist = tags.artist != null ? String(tags.artist).trim() : '';
  const tagAlbum = tags.album != null ? String(tags.album).trim() : '';

  // 标题：ID3 → 文件名（剥离轨道号与后缀）
  let title = isRealValue(tagTitle) ? tagTitle : (fnMeta.title || baseName);
  const titleSource = isRealValue(tagTitle) ? META_SRC.ID3 : META_SRC.PATH;

  // 艺术家：ID3 → 目录二级文件夹；都没有则留空（不再填占位值），交由阶段1 插件补空
  let artist = isRealValue(tagArtist, PLACEHOLDER_ARTIST) ? tagArtist : (dirMeta.artist || '');
  const artistSource = isRealValue(tagArtist, PLACEHOLDER_ARTIST) ? META_SRC.ID3 : (dirMeta.artist ? META_SRC.PATH : '');
  if (artist) artist = artist.replace(/\/{2,}/g, '/');

  // 专辑：ID3 → 目录三级文件夹（文件直接所在文件夹）；都没有则留空
  let album = isRealValue(tagAlbum, PLACEHOLDER_ALBUM) ? tagAlbum : (dirMeta.album || '');
  const albumSource = isRealValue(tagAlbum, PLACEHOLDER_ALBUM) ? META_SRC.ID3 : (dirMeta.album ? META_SRC.PATH : '');

  // 轨道号：ID3 → 文件名开头数字（轨道号缺失不触发插件）
  let track = null;
  let trackSource = '';
  const tagTrack = tags.trackNumber !== undefined ? parseInt(String(tags.trackNumber), 10) || null : null;
  if (tagTrack && tagTrack > 0) {
    track = tagTrack;
    trackSource = META_SRC.ID3;
  } else if (fnMeta.track) {
    track = fnMeta.track;
    trackSource = META_SRC.PATH;
  }

  // 年份：ID3 → 专辑文件夹名（如「口袋（2010）」，仅补空）；仅接受合理的 4 位年份
  let yearStr = tags.year !== undefined ? String(tags.year).replace(/\D/g, '').slice(0, 4) : '';
  if (!/^(19|20)\d{2}$/.test(yearStr)) yearStr = '';
  const yearSource = yearStr ? META_SRC.ID3 : (dirMeta.year ? META_SRC.PATH : '');
  if (!yearStr) yearStr = dirMeta.year || '';

  const song = {
    id: 'tr-' + md5(rel),
    filePath: full.replace(/\\/g, '/'),
    relPath: rel,
    fileName: path.basename(full),
    title,
    artist,
    album,
    folder: dirOf,
    genre: tags.genre ? String(tags.genre).trim() : null,
    year: yearStr ? parseInt(yearStr, 10) : null,
    yearSource,
    // 元数据来源标记（排查用）：id3=内嵌标签，path=目录路径，plugin=插件补全，manual=手动编辑
    titleSource,
    artistSource,
    albumSource,
    trackSource,
    metaSource: combineMetaSource(titleSource, artistSource, albumSource),
    size: stat.size,
    suffix,
    duration: estimateDuration(stat.size, suffix),
    mtimeMs: Math.round(stat.mtimeMs),
    hasCover: false,
    artwork: null,
    coverHash: null,
    coverRelpath: null,
    coverSource: 'none',
    albumCoverHash: null,
    albumCoverRelpath: null,
    albumCoverSource: 'none',
    artistCoverHash: null,
    artistCoverRelpath: null,
    artistCoverSource: 'none',
    lyricRaw: null,
    lyricStruct: null,
    lyricSource: 'none',
    replayGain: null,
    // （已废弃）trackCoverRemote：纯内存方案不再存远程 URL，封面经绑定函数写 cover_relpath
    trackCoverRemote: null,
    // 阶段0解析完成 = raw_parsed；阶段1成功 = meta_filled；失败/无结果 = meta_failed
    scanStatus: 'raw_parsed',
    plugin: 'local'
  };

  // 封面预处理（扫描阶段完成转码，HTTP 接口只静态返回缓存）
  await processSongCover(song, full);

  // 歌词处理：优先同目录 .lrc，其次音频内嵌歌词；全部存入数据库（用户磁盘文件只读）
  const lyric = await lrcUtils.collectSongLyrics(full, false, tags);
  applyLyricsToSong(song, lyric);

  songs.push(song);

  aggregateSong(song, artistMap, albumMap, folderMap);
  return song;
}

// 处理单个 .strm 文本指向文件：文件内容是一行完整的内网 http 地址（如 OpenList 直链）。
// 元数据优先级：目录路径解析（人工整理目录是 strm 的权威数据源）→ 元数据插件（阶段1按需，仅补空）。
// 真实媒体地址存入 realMediaUri，并标记 isStrm=true，播放时由后端 302 重定向到该地址。
// strm 本体路径记录在 strmFilePath（独立于音乐库 rel_path 的容器完整路径）。
async function processStrmFile(full, rel, songs, artistMap, albumMap, folderMap) {
  let stat;
  try { stat = fs.statSync(full); } catch { return null; }

  let raw = '';
  try { raw = fs.readFileSync(full, 'utf8'); } catch { return null; }
  // 取首个非空行作为真实媒体地址（兼容文件末尾换行/注释）
  const url = String(raw || '').split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
  if (!url) return null;

  // 目录路径解析（权威）：艺术家 = 二级文件夹，专辑 = 三级文件夹；
  // 文件名解析：开头数字为轨道号，其后为歌曲标题。解析不到的字段留空，交由阶段1 插件补空。
  const dirMeta = parsePathMeta(rel);
  const fnMeta = parseFilename(path.basename(full)); // 自动剥离 .strm 后缀
  const title = fnMeta.title || path.basename(full, '.strm');
  const artist = dirMeta.artist || '';
  const album = dirMeta.album || '';
  const track = fnMeta.track;
  const titleSource = title ? META_SRC.PATH : '';
  const artistSource = dirMeta.artist ? META_SRC.PATH : '';
  const albumSource = dirMeta.album ? META_SRC.PATH : '';
  const trackSource = fnMeta.track ? META_SRC.PATH : '';

  const dirOf = rel.indexOf('/') >= 0 ? rel.slice(0, rel.lastIndexOf('/')) : '';

  // 从真实地址的文件后缀推断 MIME（如 .flac / .mp3），让客户端识别为正确音频类型
  let suffix = '';
  let contentType = 'application/octet-stream';
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (ext && CONTENT_TYPES[ext]) {
      suffix = ext;
      contentType = CONTENT_TYPES[ext];
    }
  } catch { /* 地址无法解析：保留默认 octet-stream + 空后缀 */ }

  const song = {
    id: 'tr-' + md5(rel),
    filePath: full.replace(/\\/g, '/'),
    relPath: rel,
    strmFilePath: full.replace(/\\/g, '/'),
    fileName: path.basename(full),
    title,
    artist,
    album,
    folder: dirOf,
    genre: null,
    year: dirMeta.year ? parseInt(dirMeta.year, 10) : null,
    track,
    // 元数据来源标记：strm 无内嵌标签，阶段0 全部来自目录路径；阶段1 补空后为 plugin
    titleSource,
    artistSource,
    albumSource,
    trackSource,
    metaSource: combineMetaSource(titleSource, artistSource, albumSource),
    size: 0,                 // strm 仅指向文件，无本地音频大小
    suffix,
    contentType,
    duration: null,          // 时长由客户端访问真实地址后获知
    mtimeMs: Math.round(stat.mtimeMs),
    hasCover: false,
    artwork: null,
    coverHash: null,
    coverRelpath: null,
    coverSource: 'none',
    albumCoverHash: null,
    albumCoverRelpath: null,
    albumCoverSource: 'none',
    artistCoverHash: null,
    artistCoverRelpath: null,
    artistCoverSource: 'none',
    lyricRaw: null,
    lyricStruct: null,
    lyricSource: 'none',
    replayGain: null,
    // （已废弃）trackCoverRemote：纯内存方案不再存远程 URL，封面经绑定函数写 cover_relpath
    trackCoverRemote: null,
    // 阶段0解析完成 = raw_parsed；阶段1成功 = meta_filled；失败/无结果 = meta_failed
    scanStatus: 'raw_parsed',
    plugin: 'local',
    isStrm: true,
    realMediaUri: url
  };

  // strm 无内嵌封面能力：仅使用目录 sidecar 封面（cover.jpg/folder.jpg）
  try {
    const sc = coverCache.readSidecarCover(path.dirname(full));
    if (sc) {
      const proc = await coverCache.processCoverBuffer(sc.buffer);
      applyCoverToSong(song, proc, 'filesidecar');
    }
  } catch (err) {
    song.hasCover = false;
    song.coverSource = 'none';
    logger.warn('API', 'local-music', 'strm sidecar cover process failed', { full, error: err && err.message });
  }

  // 歌词：strm 无内嵌能力，仅读取同目录同名 .lrc
  const lyric = await lrcUtils.collectSongLyrics(full, true, null);
  applyLyricsToSong(song, lyric);

  songs.push(song);

  aggregateSong(song, artistMap, albumMap, folderMap);
  return song;
}

// 用当前 state 的内存数据重建歌手/专辑/目录聚合索引（不联网、不重算磁盘指纹）。
// 供「播放时补全写回」后刷新视图使用：封面/专辑/时长仅在播放该曲时按需搜索并写入。
function rebuildStateIndexes() {
  const artistMap = new Map();
  const albumMap = new Map();
  const folderMap = new Map();
  for (const d of state.dirs || []) ensureFolder(folderMap, d);
  for (const s of state.songs || []) aggregateSong(s, artistMap, albumMap, folderMap);
  const artists = buildArtists(artistMap);
  const albums = buildAlbums(albumMap);
  for (const list of folderMap.values()) {
    list.songs.sort((a, b) => (a.fileName || '').localeCompare(b.fileName || '', 'zh'));
  }
  state.artists = artists;
  state.albums = albums;
  state.folderMap = folderMap;
}

// 流水线运行期间，后台下载回调会把「匹配到的专辑名 + 三类封面本地路径」直接写进 local_songs。
// 从 DB 把这些字段同步回内存歌曲（仅填空），并重建歌手/专辑聚合 + 专辑封面缓存，
// 使本次扫描结束后专辑/歌手列表立即可见（无需重启或再次扫描）。
async function syncCoversFromDb() {
  try {
    const rows = await localLibraryDb.loadCoverFieldsByRelPath();
    if (!rows || !rows.length || !state.songs) return;
    const byRel = new Map(rows.map((r) => [r.rel_path, r]));
    let changed = false;
    for (const s of state.songs) {
      if (!s) continue;
      const r = byRel.get(s.relPath);
      if (!r) continue;
      // 专辑名回填（仅填空/占位）
      if ((!s.album || s.album === '未知专辑' || s.album === '未知') &&
          r.album && r.album !== '未知专辑' && r.album !== '未知') {
        s.album = r.album;
        changed = true;
      }
      // 歌曲封面（仅填空）
      if (!s.coverRelpath && r.cover_relpath) {
        s.coverRelpath = r.cover_relpath;
        s.coverHash = r.cover_hash || null;
        s.coverSource = r.cover_source || 'plugin';
        s.hasCover = true;
        s.artwork = coverArtUrl(s.coverRelpath, s.filePath);
        changed = true;
      }
      // 专辑封面（仅填空）
      if (!s.albumCoverRelpath && r.album_cover_relpath) {
        s.albumCoverRelpath = r.album_cover_relpath;
        s.albumCoverHash = r.album_cover_hash || null;
        s.albumCoverSource = r.album_cover_source || 'album-real';
        changed = true;
      }
      // 歌手头像（仅填空）
      if (!s.artistCoverRelpath && r.artist_cover_relpath) {
        s.artistCoverRelpath = r.artist_cover_relpath;
        s.artistCoverHash = r.artist_cover_hash || null;
        s.artistCoverSource = r.artist_cover_source || 'artist-real';
        changed = true;
      }
    }
    if (changed) {
      rebuildStateIndexes();      // 重建歌手/专辑聚合（含 artistCoverRelpath）
      await rebuildAlbumCovers(); // 重建专辑封面聚合（album-real → al.coverRelpath）
    }
  } catch (e) {
    logger.warn('API', 'local-music', 'syncCoversFromDb failed', { error: e && e.message });
  }
}

/**
 * 把 DB 里阶段1（插件补空）/ 手动补全写入的核心元数据同步回内存歌曲，并重建歌手/专辑聚合。
 * 默认只填空（不覆盖阶段0 已解析出的 ID3/目录值）；overwrite=true（用户手动覆盖修正）时用 DB 值替换。
 * @param {boolean} [overwrite] 手动覆盖模式
 */
async function syncMetaFromDb(overwrite) {
  if (!state.songs || !state.songs.length) return 0;
  try {
    const rows = await localLibraryDb.loadMetaFieldsByRelPath();
    if (!rows || !rows.length) return 0;
    const byRel = new Map(rows.map((r) => [r.rel_path, r]));
    let changed = 0;
    for (const s of state.songs) {
      const r = byRel.get(s.relPath);
      if (!r) continue;
      const apply = (field, srcField, dbVal, dbSrc) => {
        const v = dbVal == null ? '' : String(dbVal).trim();
        if (!v) return false;
        const isPlaceholder = (field === 'artist' && PLACEHOLDER_ARTIST.has(v))
          || (field === 'album' && PLACEHOLDER_ALBUM.has(v));
        if (isPlaceholder) return false;
        if (!overwrite && s[field] && !(field === 'artist' && PLACEHOLDER_ARTIST.has(s[field]))) return false;
        s[field] = v;
        s[srcField] = dbSrc || META_SRC.PLUGIN;
        return true;
      };
      let hit = false;
      if (apply('title', 'titleSource', r.title, r.title_source)) hit = true;
      if (apply('artist', 'artistSource', r.artist, r.artist_source)) hit = true;
      if (apply('album', 'albumSource', r.album, r.album_source)) hit = true;
      if (hit) {
        s.metaSource = r.meta_source || combineMetaSource(s.titleSource, s.artistSource, s.albumSource);
        changed += 1;
      }
    }
    if (changed) rebuildStateIndexes();
    return changed;
  } catch (e) {
    logger.warn('API', 'local-music', 'syncMetaFromDb failed', { error: e && e.message });
    return 0;
  }
}

// 流水线运行期间，阶段1会把歌曲 scan_status 写入 DB（meta_filled / meta_failed），
// 但内存 state.songs 仍是阶段0的 raw_parsed。若不回写，下一次 monitor 增量扫描克隆到过期的
// raw_parsed → replaceSongs 把整库写回 raw_parsed → monitor 流水线（WHERE scan_status='raw_parsed'）
// 误把全部旧歌当新歌重跑。故流水线结束后把 DB 真实 scan_status 同步回内存。
async function syncScanStatusFromDb() {
  if (!state.songs || !state.songs.length) return;
  try {
    const m = await localLibraryDb.loadScanStatuses();
    if (!m || !m.size) return;
    let changed = 0;
    for (const s of state.songs) {
      if (!s || !s.relPath) continue;
      const st = m.get(s.relPath);
      if (st && st !== s.scanStatus) { s.scanStatus = st; changed += 1; }
    }
    if (changed) logger.debug('API', 'local-music', 'scan_status synced to memory', { changed });
  } catch (e) {
    logger.warn('API', 'local-music', 'syncScanStatusFromDb failed', { error: e && e.message });
  }
}

// 流水线阶段1.5会把插件补录的时长写入 DB（UPDATE duration ... WHERE duration IS NULL），
// 但内存 state.songs 仍是阶段0的空时长（strm 尤其明显：文件侧恒为 null）。此处把 DB 真实时长
// 同步回内存（仅填空，绝不覆盖播放时客户端写回的真实时长），使列表/歌手专辑聚合总时长当次可见。
async function syncDurationsFromDb() {
  if (!state.songs || !state.songs.length) return;
  try {
    const rows = await localLibraryDb.loadDurationsByRelPath();
    if (!rows || !rows.length) return;
    const byRel = new Map(rows.map((r) => [r.rel_path, Number(r.duration) || 0]));
    let changed = 0;
    for (const s of state.songs) {
      if (!s || !s.relPath) continue;
      const d = byRel.get(s.relPath);
      if (d > 0 && !(Number(s.duration) > 0)) { s.duration = d; changed += 1; }
    }
    if (changed) {
      rebuildStateIndexes(); // 重建歌手/专辑聚合（总时长依赖 song.duration）
      logger.debug('API', 'local-music', 'durations synced to memory', { changed });
    }
  } catch (e) {
    logger.warn('API', 'local-music', 'syncDurationsFromDb failed', { error: e && e.message });
  }
}

// 把一首歌曲对象聚合进歌手/专辑/目录索引（扫描与数据库加载共用）
function aggregateSong(song, artistMap, albumMap, folderMap) {
  const artist = song.artist || '未知艺术家';
  const album = song.album || '';
  const dirOf = song.folder || '';
  const dur = Number(song.duration) || 0;

  // 歌手聚合：统计歌曲数、专辑去重数、总时长
  let aObj = artistMap.get(artist);
  if (!aObj) {
    aObj = { id: 'ar-' + md5(artist), name: artist, count: 0, coverPath: null, artistCoverRelpath: null, folder: dirOf, albumSet: new Set(), duration: 0 };
    artistMap.set(artist, aObj);
  }
  aObj.count++;
  aObj.duration += dur;
  if (!aObj.coverPath && song.hasCover) aObj.coverPath = song.filePath;
  // 歌手真实头像（md5 落盘，source='artist-real'）优先记录；同一歌手歌曲行冗余同引用
  if (!aObj.artistCoverRelpath && song.artistCoverRelpath && song.artistCoverSource === 'artist-real') {
    aObj.artistCoverRelpath = song.artistCoverRelpath;
  }

  // 专辑聚合：仅当有真实专辑名时才聚合，无专辑的歌曲不生成占位专辑，等播放时搜索回填
  if (album) {
    const albumKey = `${artist}\u0000${album}`;
    let alObj = albumMap.get(albumKey);
    if (!alObj) {
      alObj = { id: 'al-' + md5(albumKey), name: album, artist, count: 0, coverPath: null, folder: dirOf, duration: 0 };
      albumMap.set(albumKey, alObj);
    }
    alObj.count++;
    alObj.duration += dur;
    if (!alObj.coverPath && song.hasCover) alObj.coverPath = song.filePath;
    // 歌手维度专辑去重计数（albumSet 在聚合收尾时转为 albumCount）
    if (aObj.albumSet) aObj.albumSet.add(albumKey);
  }

  // 目录归属
  const folderEntry = ensureFolder(folderMap, dirOf);
  folderMap.get(folderEntry).songs.push(song);
}

// 聚合收尾：Map → 有序数组。歌手的 albumSet（去重集合）在此转为 albumCount 并剔除（Set 不可 JSON 序列化）。
function buildArtists(artistMap) {
  return Array.from(artistMap.values())
    .map((a) => {
      const { albumSet, ...rest } = a;
      return { ...rest, albumCount: albumSet ? albumSet.size : 0 };
    })
    .sort((a, b) => langSort(a.name, b.name));
}

function buildAlbums(albumMap) {
  return Array.from(albumMap.values())
    .sort((a, b) => langSort(a.artist + a.name, b.artist + b.name));
}

// 名称首字符语言类别：0=中文（拼音，排最前），1=英文（字母，排中间），2=其他（数字/符号，排最后）
function langRank(str) {
  const c = str ? String(str).charAt(0) : '';
  if (!c) return 2;
  const cp = c.codePointAt(0);
  if (cp >= 0x4e00 && cp <= 0x9fff) return 0;
  if (/[a-zA-Z]/.test(c)) return 1;
  return 2;
}

// 排序：中文在前（拼音），英文在后（字母），其他最后；同类按名称（拼音）排序
function langSort(a, b) {
  const ra = langRank(a);
  const rb = langRank(b);
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b, 'zh');
}

// 完成扫描：排序 + 写入 state
function finalizeScan(dir, dirs, songs, artistMap, albumMap, folderMap) {
  // 排序
  songs.sort((a, b) => {
    const ad = a.album || '';
    const bd = b.album || '';
    if (ad !== bd) return ad.localeCompare(bd, 'zh');
    if ((a.track || 0) !== (b.track || 0)) return (a.track || 0) - (b.track || 0);
    return (a.fileName || '').localeCompare(b.fileName || '', 'zh');
  });

  // 歌手/专辑：中文在前（拼音首字母），英文在后，其他最后
  const artists = buildArtists(artistMap);
  const albums = buildAlbums(albumMap);

  for (const list of folderMap.values()) {
    list.songs.sort((a, b) => (a.fileName || '').localeCompare(b.fileName || '', 'zh'));
  }

  state.songs = songs;
  state.artists = artists;
  state.albums = albums;
  state.dirs = dirs.sort((a, b) => a.localeCompare(b, 'zh'));
  state.folderMap = folderMap;
  state.coverCache.clear();
  state.dir = dir;
  state.sig = computeSig(dir);
  state.lastModified = Date.now();
  return state;
}

// 扫描重建歌曲时，把内存（含 DB 已有补全）里的真实元数据（专辑/时长/封面）合并回去，
// 避免 strm 等无内嵌标签的文件把已补全的数据用空值覆盖。仅“填缺失”：
// 新扫描对象自身有值（来自文件标签）则保留文件值，新值为空才用已有值。
function mergeExistingMeta(songs) {
  if (!state.songs || !state.songs.length) return;
  const existing = new Map();
  for (const s of state.songs) {
    if (s && s.id) existing.set(s.id, s);
  }
  if (!existing.size) return;
  for (const s of songs) {
    const e = existing.get(s.id);
    if (!e) continue;
    // 核心元数据（阶段0 已按 ID3 → 目录路径解析，缺失的可能是插件/手动补全结果）：
    // 新值为空才继承已补全值，并同步继承来源标记。绝不覆盖阶段0 已解析出的有效值。
    if (!s.title && e.title) {
      s.title = e.title;
      s.titleSource = e.titleSource || META_SRC.PLUGIN;
    }
    if ((!s.artist || PLACEHOLDER_ARTIST.has(s.artist)) && e.artist && !PLACEHOLDER_ARTIST.has(e.artist)) {
      s.artist = e.artist;
      s.artistSource = e.artistSource || META_SRC.PLUGIN;
    }
    // 专辑：文件缺失（空/占位）时用已补全的真实专辑
    if ((!s.album || s.album === '未知专辑' || s.album === '未知') &&
        e.album && e.album !== '未知专辑' && e.album !== '未知') {
      s.album = e.album;
      s.albumSource = e.albumSource || META_SRC.PLUGIN;
    }
    if (!s.track && e.track) s.track = e.track;
    // 时长：文件缺失时用已补全时长
    if (!s.duration && e.duration) s.duration = e.duration;
    // 封面：文件缺失时用已补全的 WebP 缓存引用（coverRelpath）
    if (!s.hasCover && e.hasCover && e.coverRelpath) {
      s.hasCover = true;
      s.coverHash = e.coverHash || null;
      s.coverRelpath = e.coverRelpath;
      s.coverSource = e.coverSource || 'embedded';
      s.artwork = coverArtUrl(s.coverRelpath, s.filePath);
    }
    // 专辑封面：文件缺失时保留已补全的专辑封面引用（album_cover_relpath，含真实专辑封面 md5）
    if (!s.albumCoverRelpath && e.albumCoverRelpath) {
      s.albumCoverHash = e.albumCoverHash || null;
      s.albumCoverRelpath = e.albumCoverRelpath;
      s.albumCoverSource = e.albumCoverSource || 'album';
    }
    // 歌手头像：文件缺失时保留已落盘的真实歌手头像引用（artist_cover_relpath，md5 WebP）
    // 只接受 art/ 目录下的真歌手头像；cover/ 是歌曲封面，绝不能回流冒充歌手头像
    if (!s.artistCoverRelpath && e.artistCoverRelpath && String(e.artistCoverRelpath).startsWith('art/')) {
      s.artistCoverHash = e.artistCoverHash || null;
      s.artistCoverRelpath = e.artistCoverRelpath;
      s.artistCoverSource = e.artistCoverSource || 'none';
    }
    // 歌词：文件缺失时保留已补全歌词（DB 缓存优先）
    if (!s.lyricRaw && e.lyricRaw) {
      s.lyricRaw = e.lyricRaw;
      s.lyricStruct = e.lyricStruct || null;
      s.lyricSource = e.lyricSource || 'none';
    }
  }
}

/** 浅拷贝歌曲对象：增量复用历史对象时避免后续回填污染上一轮 state */
function cloneSong(s) {
  if (!s) return null;
  return { ...s };
}

// ---------------- 递归扫描（增量：mtime_ms 未变化即复用，跳过解析/封面/歌词） ----------------

let scanPromise = null;

/**
 * 触发一次异步全量/增量扫描（防并发）。返回 Promise<state>。
 * 增量语义：文件 mtime_ms 与 size 均未变化 → 直接复用上一轮对象，跳过元数据解析、封面提取、歌词读取。
 */
function scan(dir, trigger = 'scan') {
  if (scanPromise) return scanPromise;
  scanPromise = performScan(dir, trigger)
    .catch((e) => {
      logger.warn('API', 'local-music', 'Local music scan failed', { dir, trigger, error: e && e.message });
      // 任务状态由 performScan 内部的 endJob 统一收尾（带 jobId 校验，不误伤后续任务）
      return state;
    })
    .finally(() => {
      scanPromise = null;
    });
  return scanPromise;
}

/** 清空状态（目录不可用时的兜底） */
function emptyState(dir) {
  state.songs = [];
  state.artists = [];
  state.albums = [];
  state.dirs = [];
  state.folderMap = new Map();
  state.coverCache.clear();
  state.dir = dir;
  state.sig = dir ? computeSig(dir) : '';
  return state;
}

async function performScan(dir, trigger = 'scan') {
  if (!dir || !fs.existsSync(dir)) {
    return emptyState(dir);
  }

  startFsWatcher(); // 目录已存在则确保 OS 级监听已启动（幂等）
  // 登记任务：启动/监听/定时/手动等所有来源都会上报进度，前端顶栏圆圈可见、可停止
  const jobId = beginJob(trigger, TRIGGER_LABEL[trigger] || '扫描音乐');

  const files = [];
  walkAudio(dir, files, '');

  const dirs = [];
  collectDirs(dir, dirs, '');

  // 上一轮内存结果（含 DB 已补全数据）作为增量基准
  const existingById = new Map((state.songs || []).map((s) => (s && s.id ? [s.id, s] : null)).filter(Boolean));

  const songs = [];
  const artistMap = new Map();
  const albumMap = new Map();
  const folderMap = new Map();

  // 先为所有真实目录建节点（含空目录），保证无音乐文件夹也出现在目录树中
  for (const d of dirs) ensureFolder(folderMap, d);

  scanProgress.total = files.length;
  scanProgress.scanned = 0;

  let changed = 0;
  const changedRelPaths = []; // 本轮扫描判定为「新增/修改」的歌曲 rel_path，供 monitor 自动入库仅处理这些
  try {
    for (let i = 0; i < files.length; i++) {
      // 用户点了「停止」：立即中断，且绝不写入半量结果（否则会丢歌）
      if (isCancelRequested()) {
        logger.info('API', 'local-music', 'Local music scan cancelled by user', {
          dir, processed: i, total: files.length
        });
        endJob(jobId, { cancelled: true });
        return state;
      }
      const { full, rel, kind } = files[i];
      const id = 'tr-' + md5(rel);
      let st = null;
      try { st = fs.statSync(full); } catch { continue; }
      const mtimeMs = Math.round(st.mtimeMs);
      const size = st.size;

      const prev = existingById.get(id);
      // .strm 在 processStrmFile 中 size 固定存 0（仅指向远程地址，无本地音频大小），
      // 故其变更判定不能用 size（否则每次扫描 0 !== 真实文本大小 → 永远判为 changed → 反复重扫）。
      // 对 strm 仅比对 mtime；普通音频则 mtime + size 双重比对。
      // prev 为 undefined（新增文件）时不能解引用，直接视为「有变化」
      const sizeUnchanged = kind === 'strm' ? true : ((prev && prev.size) || 0) === size;
      if (prev && prev.mtimeMs === mtimeMs && sizeUnchanged) {
        const clone = cloneSong(prev);
        if (clone) {
          songs.push(clone);
          aggregateSong(clone, artistMap, albumMap, folderMap);
        }
      } else {
        changed += 1;
        changedRelPaths.push(rel);
        try {
          if (kind === 'strm') {
            await processStrmFile(full, rel, songs, artistMap, albumMap, folderMap);
          } else {
            await processFile(full, rel, songs, artistMap, albumMap, folderMap);
          }
        } catch (err) {
          // 单条解析失败（标签损坏等）只跳过本条，不能导致整个扫描进程崩溃
          logger.warn('API', 'local-music', 'process local file failed, skip', { full, error: err && err.message });
        }
      }
      scanProgress.scanned = i + 1;
      localPipeline.reportStage0(i + 1, files.length);
    }

    // 合并已有真实元数据，避免用文件空值覆盖已补全的专辑/时长/封面
    mergeExistingMeta(songs);

    finalizeScan(dir, dirs, songs, artistMap, albumMap, folderMap);
    // mergeExistingMeta 在聚合之后才把历史补全的专辑名回填到歌曲，因此必须基于
    // 已 merge 的 state.songs 再聚合一次歌手/专辑；否则 backfill 跳过时专辑会留在空聚合结果。
    rebuildStateIndexes();
    // 落库失败不应中断后续元数据采集：即使 persistScan 异常（如旧库迁移字段缺失），
    // 仍要继续跑阶段1-3（专辑/歌手封面搜索），否则「首次扫描没搜索专辑」。
    try {
      // 必须 await：monitor 流水线只认 scan_status='raw_parsed'，而 raw_parsed 正由本次 persistScan 写入。
      // 若不等提交就跑流水线，会读到 0 行 →「待处理约 0 首」→ 专辑封面等全部不处理。
      await persistScan();
    } catch (pe) {
      logger.warn('API', 'local-music', 'persistScan failed, continue meta pipeline', { error: pe && pe.message });
    }
    // 阶段化流水线：阶段0（本地解析）已完成（上方循环已置 scan_status='raw_parsed'）。
    // 仅 monitor 触发只做阶段0（新增/修改文件置 raw_parsed，避免网络风暴，由用户手动启动完整扫描处理）；
    // startup / manual / fill 跑阶段1-2（歌曲/专辑封面 / 歌手头像），但【库为空（songs.length===0）时跳过】，
    // 避免空库开机空跑流水线；即便文件无变化（changed===0，例如库已从 DB 载入但阶段1尚未执行）也强制跑。
    if (!isCancelRequested() && songs.length > 0 && (changed > 0 || trigger === 'startup' || trigger === 'fill' || trigger === 'manual')) {
      // 自动入库(monitor) 同样执行补全流水线：内部只取 raw_parsed 的新歌，旧歌全部跳过（增量，不全库扫）。
      // 其余来源（startup/manual/fill）走「只补缺失」筛选。
      const pipeTrigger = trigger === 'monitor' ? 'monitor' : (trigger === 'fill' ? 'fill' : 'manual');
      logger.info('API', 'local-music', `Scan changed=${changed} trigger=${trigger} → running meta pipeline (step1-8)`, { trigger, pipeTrigger });
      // 阶段1回填的专辑名/封面绑定同步进内存聚合，列表当次扫描结束即可见
      const runPipe = () => localPipeline.runMetaStages({ trigger: pipeTrigger, only: 'all', changedRelPaths })
        .then(() => syncMetaFromDb())      // 阶段1 补空的艺术家/专辑回写内存（仅填空）
        .then(() => syncCoversFromDb())
        .then(() => syncDurationsFromDb())
        .then(() => syncScanStatusFromDb())
        .catch((e) => logger.warn('API', 'local-music', 'meta pipeline failed', { error: e && e.message }));
      // monitor 自动入库为后台增量任务：不阻塞扫描 HTTP 响应（否则 3000 首规模下扫描请求挂起数分钟，
      // 表现为「后面阶段卡主、没下一步」）。进度经 /api/music/pipeline-status 轮询可见。
      // 其余来源（startup/manual/fill）仍等待流水线结束，便于当次扫描即同步封面到内存聚合。
      if (pipeTrigger === 'monitor') runPipe();
      else await runPipe();
    } else {
      logger.debug('API', 'local-music', 'Scan: skip meta pipeline', { trigger, changed, songs: songs.length });
    }
    endJob(jobId, { cancelled: isCancelRequested() });
    logger.info('API', 'local-music', 'Local music scan finished', { dir, diskTotalFiles: files.length, changed, unchanged: files.length - changed, saved: songs.length });
    return state;
  } catch (e) {
    endJob(jobId, { error: e && e.message });
    throw e;
  }
}

// 把扫描结果持久化到 SQLite（歌曲元数据 + 库指纹 + 库结构版本），仅作"开机快速加载"缓存

/**
 * 刷新专辑封面到聚合对象（单表模型，专辑封面存于 local_songs.album_cover_*）。
 * 专辑封面必须是「真实专辑封面」：仅接受 album_cover_source='album-real'
 * （由 backfill 用专辑名搜索插件获取并落库）。旧数据 source='album' 且与单曲封面
 * relpath 相同的，其实是早期「复制歌曲封面」产生的错误数据，这里一律视为无专辑封面，
 * 置空交给后续真实专辑搜索替换——绝不拿歌曲封面（cover_relpath）冒充。
 */
async function rebuildAlbumCovers() {
  if (!state.albums || !state.albums.length) return;
  // 专辑聚合已重建：清掉远程封面解析缓存，让列表接口拿到最新落盘的 webp
  invalidateEntityCoverCache();
  // 每个专辑收集第一首「真实专辑封面」（source='album-real'）的歌曲。
  const albumArtByKey = new Map();
  for (const s of state.songs || []) {
    if (!s.album || !s.albumCoverRelpath) continue;
    if (s.albumCoverSource !== 'album-real') continue; // 旧的复制数据不算真实专辑封面
    const key = md5(`${s.artist || ''}\u0000${s.album}`);
    if (!albumArtByKey.has(key)) albumArtByKey.set(key, s);
  }
  const records = [];
  for (const al of state.albums) {
    const rep = albumArtByKey.get(md5(`${al.artist || ''}\u0000${al.name || ''}`));
    const artFileOk = rep && rep.albumCoverRelpath ? coverCache.resolveRelpath(rep.albumCoverRelpath) : null;
    if (!artFileOk || !fs.existsSync(artFileOk)) {
      // 无真实专辑封面：置空等待专辑搜索落库（不拿歌曲封面凑数）
      al.coverRelpath = null;
      al.coverHash = null;
      al.coverSource = 'none';
    } else {
      al.coverRelpath = rep.albumCoverRelpath;
      al.coverHash = rep.albumCoverHash || null;
      al.coverSource = 'album-real';
    }
    records.push({
      album: al.name, artist: al.artist,
      coverRelpath: al.coverRelpath, coverHash: al.coverHash, coverSource: al.coverSource
    });
  }
  if (records.length) {
    try { await localLibraryDb.replaceAlbumCovers(records); } catch (e) { /* 落库失败不影响内存封面引用 */ }
  }
}

/** 把远程专辑封面 URL 下载并转成 WebP 缓存（与歌曲封面同目录去重）；失败返回 null */
async function localizeRemoteAlbumCover(url) {
  try {
    const buf = await coverCache.fetchRemoteImageBuffer(url);
    if (!buf) return null;
    const proc = await coverCache.processCoverBuffer(buf);
    return proc && proc.ok ? proc : null;
  } catch {
    return null;
  }
}

/** 把远程歌手头像 URL 下载并转成 WebP，独立存 art/ 目录（与封面 cover/ 分开）；失败返回 null */
async function localizeRemoteArtistCover(url) {
  try {
    const buf = await coverCache.fetchRemoteImageBuffer(url);
    if (!buf) return null;
    const proc = await coverCache.processArtistBuffer(buf);
    return proc && proc.ok ? proc : null;
  } catch {
    return null;
  }
}

/**
 * 为一张专辑搜索并落库「真实专辑封面」：
 * 用配置的封面插件按专辑名搜索（type='album'）取封面 URL，下载转 WebP 后写入
 * 该专辑所有歌曲行的 album_cover_*（含 md5，source 标记 'album-real' 与旧复制数据区分）。
 * 状态：filled=写入真实封面；cleared=搜索失败（清空 album_cover_*，专辑图显示无）；
 * skipped=无需处理（已有真实封面或非有效专辑）。
 * @returns {Promise<'filled'|'cleared'|'skipped'>}
 */
async function ensureRealAlbumCover(album, artist, opts = {}) {
  const name = String(album || '').trim();
  if (!name || !artist) return 'skipped';
  const ALBUM_REAL = 'album-real';
  // 已存在真实专辑封面（source=album-real 且缓存文件在）→ 跳过联网搜索
  const realExists = (state.songs || []).find(
    (s) => s.album === name && s.artist === artist
      && s.albumCoverSource === ALBUM_REAL && s.albumCoverRelpath
      && fs.existsSync(coverCache.resolveRelpath(s.albumCoverRelpath) || '')
  );
  if (realExists) {
    logger.info('API', 'local-music', `【专辑封面】《${name}》/《${artist}》 状态:已存在 → 跳过 入库:${realExists.albumCoverRelpath}`);
    return 'skipped';
  }

  let relpath = null;
  let hash = null;
  let source = 'none'; // 找不到真实专辑封面 → 置空（显示无，不拿歌曲封面凑数）
  let searchUrl = null;
  const usedPlugins = resolveConfiguredPlugins('cover_plugins', '');
  try {
    // 调用方已搜索到 URL（如 /api/music/album-image）则直接复用，避免二次联网搜索
    const url = (opts && opts.url) ? String(opts.url).trim()
      : await fetchAlbumImage(name, artist, { forcePlugins: opts.forcePlugins });
    searchUrl = url;
    if (url) {
      const proc = await localizeRemoteAlbumCover(url);
      if (proc && proc.relpath) {
        relpath = proc.relpath;
        hash = proc.hash || null;
        source = ALBUM_REAL;
      }
    }
  } catch (e) {
    logger.warn('API', 'local-music', 'Real album cover search failed', { album: name, artist, error: e && e.message });
  }

  // 更新内存歌曲行（同专辑冗余同一引用）；找不到时置空并抹掉旧的“复制歌曲封面”数据
  for (const s of state.songs || []) {
    if (s.album === name && s.artist === artist) {
      s.albumCoverRelpath = relpath;
      s.albumCoverHash = hash;
      s.albumCoverSource = source;
    }
  }
  // 写库：同步该专辑所有歌曲行
  try {
    await localLibraryDb.replaceAlbumCovers([{ album: name, artist, coverRelpath: relpath, coverHash: hash, coverSource: source }]);
  } catch (e) {
    logger.warn('API', 'local-music', 'Save real album cover failed', { album: name, artist, error: e && e.message });
  }
  // 同步专辑聚合对象（列表接口即刻返回本地真实专辑封面）
  if (source === ALBUM_REAL) {
    const alObj = (state.albums || []).find((a) => String(a.name || '') === name && String(a.artist || '') === artist);
    if (alObj) {
      alObj.coverRelpath = relpath;
      alObj.coverHash = hash;
      alObj.coverSource = ALBUM_REAL;
    }
  }
  if (source === ALBUM_REAL) {
    logger.info('API', 'local-music', `【专辑封面】《${name}》/《${artist}》 状态:搜到 地址:${searchUrl} → 下载:成功 入库:${relpath} | 使用插件:[${usedPlugins.join(',') || '无'}]`);
    logger.debug('API', 'local-music', 'Real album cover saved (search by album)', { album: name, artist, relpath, updatedAt: Date.now() });
    return 'filled';
  }
  if (searchUrl) {
    // 搜到图片但下载/转码失败：单独计为 failed，与「未搜到」区分
    logger.info('API', 'local-music', `【专辑封面】《${name}》/《${artist}》 状态:搜到 地址:${searchUrl} → 下载:失败 | 使用插件:[${usedPlugins.join(',') || '无'}]`);
    return 'failed';
  }
  logger.info('API', 'local-music', `【专辑封面】《${name}》/《${artist}》 状态:未搜到 | 使用插件:[${usedPlugins.join(',') || '无'}]`);
  logger.debug('API', 'local-music', 'Real album cover not found, cleared', { album: name, artist });
  return 'cleared';
}

/** 专辑是否已有真实专辑封面（source=album-real 且缓存文件在） */
function albumHasRealCover(name, artist) {
  return !!(state.songs || []).find(
    (s) => s.album === name && s.artist === artist
      && s.albumCoverSource === 'album-real' && s.albumCoverRelpath
      && fs.existsSync(coverCache.resolveRelpath(s.albumCoverRelpath) || '')
  );
}

// 专辑封面补全并发保护：同一时间只跑一轮，避免启动 warm 与 backfill 同时搜索同一专辑
let albumArtFillRunning = false;

/**
 * 对「尚无真实专辑封面（source!=album-real）」的专辑逐个执行真实专辑封面补全：
 * 用专辑名+歌手做 type=album 专辑搜索 → 下载本地化 → 落库（source=album-real），
 * 覆盖/清空旧代码从歌曲封面复制的 album_cover 数据。返回统计。
 * @param {boolean} report 是否把本轮作为独立任务上报进度（设置页手动补专辑封面时为 true；
 *                         作为 backfill 的一个阶段被调用时为 false，避免覆盖歌曲级进度）
 */
async function fillMissingAlbumRealCovers(report = false) {
  if (albumArtFillRunning) return { total: 0, filled: 0, cleared: 0 };
  albumArtFillRunning = true;
  try {
    const albums = state.albums || [];
    // 处理所有「尚无真实专辑封面（source!=album-real）」的专辑：
    // - 旧代码复制歌曲封面的数据（relpath 非空但非 album-real）→ 用真实专辑搜索替换；
    // - 尚未尝试过的 → 直接搜索；找不到会清空（置空显示无），下次扫描再试。
    const need = albums.filter((a) => a.name && !albumHasRealCover(a.name, a.artist));
    let filled = 0;
    let cleared = 0;
    let failed = 0;
    let dirty = false;
    if (report) {
      scanProgress.phase = 'album';
      scanProgress.total = need.length;
      scanProgress.scanned = 0;
    }
    for (const al of need) {
      if (isCancelRequested()) break; // 用户点了「停止」
      try {
        const st = await ensureRealAlbumCover(al.name, al.artist);
        if (st === 'filled') { filled += 1; dirty = true; }
        else if (st === 'failed') { failed += 1; dirty = true; }
        else if (st === 'cleared') { cleared += 1; dirty = true; }
      } catch (e) {
        logger.warn('API', 'local-music', 'Real album cover fill failed', { album: al.name, artist: al.artist, error: e && e.message });
      }
      if (report) scanProgress.scanned += 1;
      await new Promise((resolve) => setImmediate(resolve)); // 让出事件循环
    }
    if (dirty) {
      rebuildStateIndexes();
      await persistScan(); // 重新落库并刷新聚合封面的 coverRelpath
    }
    logger.info('API', 'local-music', `【下载完毕】专辑封面 需补:${need.length} 成功:${filled} 失败:${failed} 未搜到:${cleared}（成功=已入库 WebP）`);
    logger.debug('API', 'local-music', 'Album real cover fill finished', { total: albums.length, need: need.length, filled, failed, cleared });
    return { total: albums.length, filled, failed, cleared };
  } finally {
    albumArtFillRunning = false;
  }
}

/** 歌手是否已有真实头像（source='artist-real' 且缓存文件在 art/ 目录） */
function artistHasRealCover(name) {
  return !!(state.songs || []).find(
    (s) => String(s.artist || '') === String(name)
      && s.artistCoverSource === 'artist-real' && s.artistCoverRelpath
      // 真歌手头像必须落在 art/ 目录；cover/ 是歌曲封面，绝不能用来冒充歌手头像
      && String(s.artistCoverRelpath).startsWith('art/')
      && fs.existsSync(coverCache.resolveRelpath(s.artistCoverRelpath) || '')
  );
}

// 注册单个抓取 handler 到全局封面补全队列：歌手/专辑封面统一单并发闸 + 限速
coverFillQueue.register('artist', (name) => ensureArtistCover(name));
coverFillQueue.register('album', (name, artist) => ensureRealAlbumCover(name, artist));

// 跨重启防风暴：把「搜过未命中」的歌手/专辑持久化到库。
// 重启后 24h 内不再整库联网重试（避免每次重启几百个搜不到的歌手又全量搜一遍），
// 只有文件/引用被清掉（如清理缓存重置 miss 后）才会重新补。
coverFillQueue.setStore({
  load: () => localLibraryDb.loadCoverFillMiss().catch(() => ({})),
  save: (data) => localLibraryDb.saveCoverFillMiss(data).catch(() => {})
});
coverFillQueue.prime();

/**
 * 把库内所有「尚无真实歌手头像」的歌手加入后台补全队列（非阻塞；专辑封面仍由
 * backfill 的同步 fillMissingAlbumRealCovers 处理）。返回入队数。
 */
function queueCoverBackfill() {
  let enq = 0;
  for (const a of (state.artists || [])) {
    if (a && a.name && !artistHasRealCover(a.name) && coverFillQueue.enqueue('artist', a.name)) enq++;
  }
  if (enq) logger.debug('API', 'local-music', 'Artist cover backfill queued', { enqueued: enq });
  return enq;
}

/** 手动补歌手头像（设置→歌词封面→补全歌手头像）：无视持久化未命中窗口，强制重新入队
 * 所有缺真实头像的歌手，由后台单并发队列立即执行（已补过的会快速跳过，不重复下载）。 */
function forceQueueArtistBackfill() {
  let enq = 0;
  for (const a of (state.artists || [])) {
    if (a && a.name && !artistHasRealCover(a.name)
      && coverFillQueue.enqueue('artist', a.name, null, { force: true })) enq++;
  }
  logger.debug('API', 'local-music', 'Manual artist-cover backfill forced', { enqueued: enq });
  return enq;
}

// 歌手头像补全并发保护：同一时间只跑一轮
let artistCoverFillRunning = false;
// 歌手头像未命中(miss)的短重试窗口：避免「搜不到/未配置插件」的歌手在每次扫描都被全量重试
const artistCoverMissTs = new Map();
const ARTIST_COVER_MISS_RETRY_MS = 10 * 60 * 1000;

/**
 * 为一个本地歌手搜索并落盘「真实歌手头像」：用配置的封面插件按歌手搜索（type='artist'，
 * 找不到回退歌曲封面），下载转 WebP 后更新该歌手所有歌曲行内存 artist_cover_*（source='artist-real'）。
 * 状态：filled=写入；cleared=搜索失败（清空）；skipped=已有真实头像或空歌手。
 * @returns {Promise<'filled'|'cleared'|'skipped'>}
 */
async function ensureArtistCover(artist, opts = {}) {
  const name = String(artist || '').trim();
  if (!name) return 'skipped';
  if (artistHasRealCover(name)) {
    const owned = (state.songs || []).find((s) => String(s.artist || '') === String(name) && s.artistCoverRelpath);
    logger.info('API', 'local-music', `【歌手头像】《${name}》 状态:已存在 → 跳过 入库:${owned ? owned.artistCoverRelpath : '-'}`);
    return 'skipped';
  }
  let relpath = null;
  let hash = null;
  let source = 'none';
  let searchUrl = null;
  const usedPlugins = resolveConfiguredPlugins('artist_image_plugins', '');
  try {
    // 调用方已搜索到 URL（如 /api/music/artist-image）则直接复用，避免二次联网搜索；否则自己搜一次
    const url = (opts && opts.url) ? String(opts.url).trim()
      : (await fetchArtistImage(name)) || null;
    searchUrl = url;
    if (url) {
      const proc = await localizeRemoteArtistCover(url);
      if (proc && proc.relpath) {
        relpath = proc.relpath;
        hash = proc.hash || null;
        source = 'artist-real';
      }
    }
  } catch (e) {
    logger.warn('API', 'local-music', 'Artist avatar search failed', { artist: name, error: e && e.message });
  }
  // 更新内存歌曲行（同一歌手冗余同一引用）
  for (const s of state.songs || []) {
    if (String(s.artist || '') === name) {
      s.artistCoverRelpath = relpath;
      s.artistCoverHash = hash;
      s.artistCoverSource = source;
    }
  }
  // 同步歌手聚合对象（真实头像 md5 落盘后列表接口即刻返回本地封面）
  if (source === 'artist-real') {
    const aObj = (state.artists || []).find((a) => String(a.name || '') === name);
    if (aObj) aObj.artistCoverRelpath = relpath;
  }
  // 落库（命中写 relpath；未命中置空待下次补全）。
  // 接口/单点触发需立即持久化（查询到即落库）；fill 批量走 deferPersist，
  // 由 fill 结束后统一一次 persistScan 写库，避免数百次小事务长时间占用 sqlite
  if (!opts.deferPersist) {
    try {
      await localLibraryDb.replaceArtistCovers([{ artist: name, coverRelpath: relpath, coverHash: hash, coverSource: source }]);
    } catch (e) {
      logger.warn('API', 'local-music', 'Save artist avatar failed', { artist: name, error: e && e.message });
    }
  }
  if (source === 'artist-real') {
    artistCoverMissTs.delete(name);
    logger.info('API', 'local-music', `【歌手头像】《${name}》 状态:搜到 地址:${searchUrl} → 下载:成功 入库:${relpath} | 使用插件:[${usedPlugins.join(',') || '无'}]`);
    logger.debug('API', 'local-music', 'Artist avatar saved (md5 localized)', { artist: name, relpath, updatedAt: Date.now() });
    return 'filled';
  }
  artistCoverMissTs.set(name, Date.now()); // 记录 miss，fill 短窗口内不再重试该歌手
  if (searchUrl) {
    // 搜到图片但下载/转码失败：单独计为 failed，与「未搜到」区分
    logger.info('API', 'local-music', `【歌手头像】《${name}》 状态:搜到 地址:${searchUrl} → 下载:失败 | 使用插件:[${usedPlugins.join(',') || '无'}]`);
    return 'failed';
  }
  logger.info('API', 'local-music', `【歌手头像】《${name}》 状态:未搜到 | 使用插件:[${usedPlugins.join(',') || '无'}]`);
  logger.debug('API', 'local-music', 'Artist avatar not found, cleared', { artist: name });
  return 'cleared';
}

/**
 * 对「尚无真实歌手头像」的本地歌手逐个执行头像补全：歌手搜索 → 下载本地化
 * → 写库（source='artist-real'）。返回统计。
 */
async function fillMissingArtistCovers() {
  if (artistCoverFillRunning) return { total: 0, filled: 0, cleared: 0 };
  artistCoverFillRunning = true;
  try {
    const artists = state.artists || [];
    const nowTs = Date.now();
    // 跳过 10 分钟内刚尝试且未搜到头像的歌手，避免每次扫描全量重试联网/写库
    const need = artists.filter((a) => a.name && !artistHasRealCover(a.name)
      && (!artistCoverMissTs.has(a.name) || nowTs - artistCoverMissTs.get(a.name) > ARTIST_COVER_MISS_RETRY_MS));
    let filled = 0;
    let cleared = 0;
    let failed = 0;
    let dirty = false;
    for (const ar of need) {
      try {
        // deferPersist：不逐歌手写库，fill 结束统一一次 persistScan，减少 sqlite 长锁
        const st = await ensureArtistCover(ar.name, { deferPersist: true });
        if (st === 'filled') { filled += 1; dirty = true; }
        else if (st === 'failed') { failed += 1; dirty = true; }
        else if (st === 'cleared') { cleared += 1; dirty = true; }
      } catch (e) {
        logger.warn('API', 'local-music', 'Artist avatar fill failed', { artist: ar.name, error: e && e.message });
      }
      await new Promise((resolve) => setImmediate(resolve)); // 让出事件循环
    }
    if (dirty) {
      rebuildStateIndexes();
      await persistScan(); // 落库（replaceSongs 含 artist_cover_*）
    }
    logger.info('API', 'local-music', `【下载完毕】歌手头像 需补:${need.length} 成功:${filled} 失败:${failed} 未搜到:${cleared}（成功=已入库 art/ WebP）`);
    logger.debug('API', 'local-music', 'Artist avatar fill finished', { total: artists.length, need: need.length, filled, failed, cleared });
    return { total: artists.length, filled, failed, cleared };
  } finally {
    artistCoverFillRunning = false;
  }
}

function persistScan() {
  // 关键：replaceSongs 是「内存整表覆盖」。播放时 /api/lyrics 补全的歌词（以及外部按 rel_path
  // 写回的数据）只进了数据库、未同步内存（state.songs 的 lyricRaw 仍为空），若直接覆盖会把 DB
  // 里刚写的歌词清空。因此在覆盖前先把数据库中已有的歌词字段按 id 读回并合并进内存对象。
  return localLibraryDb.loadLyricFields()
    .then((rows) => {
      if (rows && rows.length && state.songs && state.songs.length) {
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const s of state.songs) {
          if (!s || s.lyricRaw) continue; // 内存已有歌词（扫描/快载）以内存为准
          const dbRow = byId.get(s.id);
          if (dbRow && dbRow.lyric_raw) {
            s.lyricRaw = dbRow.lyric_raw;
            s.lyricStruct = dbRow.lyric_struct || null;
            s.lyricSource = dbRow.lyric_source || 'network';
          }
        }
      }
      return localLibraryDb.replaceSongs(state.songs);
    })
    .then(() => rebuildAlbumCovers()) // 歌曲封面落盘后，同步重建专辑独立封面缓存
    .then(() => localLibraryDb.setMeta('library_sig', state.sig))
    .then(() => localLibraryDb.setMeta('library_schema', localLibraryDb.SCHEMA_VERSION))
    .then(() => logger.debug('API', 'local-music', 'Local songs persisted', { count: state.songs.length }))
    .catch((err) => logger.warn('API', 'local-music', 'Persist local songs failed', { error: err.message }));
}

/** 由 rel_path（歌手/专辑/歌曲.flac）拼接容器可访问完整路径：MUSIC_DIR + '/' + rel_path */
function relToFullPath(relPath) {
  if (!relPath) return null;
  const rel = String(relPath).replace(/\\/g, '/');
  const base = String(MUSIC_DIR).replace(/\\/g, '/').replace(/\/+$/, '');
  return rel ? `${base}/${rel}` : base;
}

/** 由 local_songs 行重建内存歌曲对象（普通音频用 rel_path 拼接；strm 用 strm_file_path） */
function songFromDbRow(r) {
  const isStrm = !!r.is_strm;
  // 普通音频不存绝对路径，运行时拼接；.strm 本体路径独立存于 strm_file_path
  const filePath = isStrm && r.strm_file_path ? String(r.strm_file_path).replace(/\\/g, '/')
    : relToFullPath(r.rel_path);
  const hasCover = !!(r.cover_relpath || r.has_cover);
  return {
    id: r.id,
    filePath,
    relPath: r.rel_path || null,
    fileName: r.file_name,
    title: r.title,
    artist: r.artist,
    album: (r.album && r.album !== '未知专辑' && r.album !== '未知') ? r.album : '',
    folder: r.folder || '',
    // 元数据来源标记（id3 / path / plugin / manual / mixed），排查数据从哪来
    titleSource: r.title_source || null,
    artistSource: r.artist_source || null,
    albumSource: r.album_source || null,
    trackSource: null,
    metaSource: r.meta_source || 'none',
    genre: r.genre,
    year: r.year,
    track: r.track,
    size: r.size || 0,
    suffix: r.suffix,
    duration: r.duration,
    mtimeMs: r.mtime_ms,
    hasCover,
    artwork: r.cover_relpath ? coverArtUrl(r.cover_relpath, filePath) : null,
    coverHash: r.cover_hash || null,
    coverRelpath: r.cover_relpath || null,
    coverSource: r.cover_source || 'none',
    albumCoverHash: r.album_cover_hash || null,
    albumCoverRelpath: r.album_cover_relpath || null,
    albumCoverSource: r.album_cover_source || 'none',
    artistCoverHash: r.artist_cover_hash || null,
    artistCoverRelpath: r.artist_cover_relpath || null,
    artistCoverSource: r.artist_cover_source || 'none',
    lyricRaw: r.lyric_raw || null,
    lyricStruct: r.lyric_struct || null,
    lyricSource: r.lyric_source || 'none',
    // 必须带出 DB 真实 scan_status：否则启动加载后内存 scanStatus 为 undefined，
    // 下次 monitor 增量扫描克隆到过期的 raw_parsed → replaceSongs 把整库写回 raw_parsed
    // → monitor 流水线（WHERE scan_status='raw_parsed'）误把整库旧歌当新歌重跑。
    scanStatus: r.scan_status || 'raw_parsed',
    plugin: 'local',
    isStrm,
    strmFilePath: r.strm_file_path || null,
    realMediaUri: r.real_media_uri || null,
    replayGain: (r.replay_gain == null ? null : Number(r.replay_gain))
  };
}

// 仅把 DB 中已补全的歌曲载入内存，作为后续扫描 merge 的基准（不设置 state.dir/sig，
// 因此即使目录指纹已变化，也不会阻止全量重扫；同时避免重扫时把 DB 已补全的
// 专辑/时长/封面/歌词用空值覆盖）。
function primeSongsBaselineFromRows(rows) {
  state.songs = rows.map(songFromDbRow);
}

// 从数据库行重建内存状态（开机快速加载；目录树仍需走一次磁盘 readdir，但不读文件标签）
function buildStateFromDbRows(dir, rows) {
  const dirs = [];
  collectDirs(dir, dirs, '');

  const songs = rows.map(songFromDbRow);

  const artistMap = new Map();
  const albumMap = new Map();
  const folderMap = new Map();
  for (const d of dirs) ensureFolder(folderMap, d);
  for (const s of songs) aggregateSong(s, artistMap, albumMap, folderMap);

  return finalizeScan(dir, dirs, songs, artistMap, albumMap, folderMap);
}

// 开机快速加载：数据库里已有扫描结果、磁盘指纹一致且库结构版本匹配时，直接加载到内存，
// 避免重启后全量读文件标签。schema 版本不匹配（本次升级迁移过表结构）时忽略 DB，走全量扫描重建。
// 注意：启动路径【只读数据库、不联网搜索】。缺失数据仅在「文件首次入库 / 手动扫描 / 播放」时补全。
let warmLocalPromise = null; // warm 完成（成功加载或决定需重建）后置为完成，供 ensureScanned 等待
// 等待 system settings 表可用（主库 database.js 在异步连接回调里建表；local_songs 由本模块建，
// 两者完成时机不同）。settings 未就绪时 getMeta 会失败，需轮询等待，避免 warm 误判“库空”而全扫。
async function waitForSettingsTable() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const probe = await localLibraryDb.getMeta('__warm_probe__');
      if (probe === null || probe !== undefined) return true; // 表已存在（查询不抛错即认为可用）
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}
function warmLocalLibraryFromDb() {
  if (warmLocalPromise) return warmLocalPromise;
  warmLocalPromise = (async () => {
    try {
      if (state.dir !== null) return; // 已被扫描
      if (!fs.existsSync(MUSIC_DIR)) return;
      await localLibraryDb.ensureTables();
      // 主库 settings 表就绪前，getMeta 会抛 “no such table”，等待其创建完成（幂等，最长 6s）
      await waitForSettingsTable();
      // 清理历史遗留的“未知专辑”占位：播放到该歌曲时若仍是空专辑会重新搜索回填
      await localLibraryDb.sanitizeUnknownAlbumPlaceholders();
      const currentSig = computeSig(MUSIC_DIR);
      const [rows, storedSig, schemaVersion] = await Promise.all([
        localLibraryDb.loadSongs(),
        localLibraryDb.getMeta('library_sig'),
        localLibraryDb.getMeta('library_schema')
      ]);
      if (state.dir !== null) return; // 等待期间已被全量扫描，放弃
      if (rows && rows.length && schemaVersion === localLibraryDb.SCHEMA_VERSION) {
        // 始终把 DB 已补全的专辑/时长/封面/歌词作为基准载入内存：即使目录指纹已变化
        // （新增/删除文件），后续重扫时 mergeExistingMeta 也能保留这些补全值，不会
        // 因指纹变化跳过 DB 加载而把已有数据覆盖成空。
        primeSongsBaselineFromRows(rows);
        if (storedSig === currentSig) {
          buildStateFromDbRows(MUSIC_DIR, rows);
          // 冷启动：先载入已持久化在 local_songs 歌曲行里的专辑封面引用（歌曲封面文件可能已丢失，DB 里仍有引用）
          try {
            const albumCovers = await localLibraryDb.loadAlbumCovers();
            if (albumCovers && albumCovers.length) {
              const byKey = new Map(albumCovers.map((c) => [md5(`${(c.artist || '')}\u0000${(c.album || '')}`), c]));
              for (const al of state.albums) {
                const key = md5(`${al.artist || ''}\u0000${al.name || ''}`);
                const c = byKey.get(key);
                if (c && c.cover_relpath) {
                  al.coverRelpath = c.cover_relpath;
                  al.coverHash = c.cover_hash || null;
                  al.coverSource = c.cover_source || 'album';
                }
              }
            }
          } catch (e) { /* 专辑封面加载失败不影响歌曲载入 */ }
          // 用当前歌曲封面刷新专辑封面聚合（纯内存 + 本地库同步，不联网）
          await rebuildAlbumCovers().catch(() => {});
          logger.info('API', 'local-music', 'Local music library loaded from DB', { dir: state.dir, count: state.songs.length, albums: state.albums.length });
        } else {
          logger.info('API', 'local-music', 'Local music sig changed, baseline from DB, will incremental rescan', { dir: MUSIC_DIR, count: rows.length });
        }
      } else if (!(rows && rows.length)) {
        logger.info('API', 'local-music', 'Local library DB empty, will full scan on first access', { dir: MUSIC_DIR });
      }
      if (schemaVersion !== localLibraryDb.SCHEMA_VERSION) {
        logger.info('API', 'local-music', 'Local library schema upgraded, full rescan scheduled', { old: schemaVersion, cur: localLibraryDb.SCHEMA_VERSION });
      }
    } catch (err) {
      // 数据库不可用/无数据：保持空状态，首次请求走全量扫描
      logger.debug('API', 'local-music', 'Warm load from DB skipped', { error: err && err.message });
    }
  })();
  return warmLocalPromise;
}

// 模块加载（服务启动）时尝试从数据库快速加载本地音乐元数据
warmLocalLibraryFromDb();
// 启动 OS 级目录监听：新增/修改/删除文件（含 .strm）实时触发重扫，无需轮询或重启
startFsWatcher();

// 【已删除】旧版 runBackfill / backfillMetadataOnScan 补全实现：无任何调用方，
// 且内部引用未定义变量（files）；补全统一由 localPipeline.runMetaStages（Step1-8）负责。
let backfillRunning = false; // 仅供 fill-images 路由的忙碌检查引用（旧实现已删，恒为 false）

/**
 * 启动手动全量重扫，与增量扫描共享并发保护（scanPromise）。
 * 已有扫描在跑（含后台首次扫描）时返回 false，避免两轮扫描同时写 state。
 */
function startManualScan(dir) {
  if (scanPromise) return false;
  scanPromise = scanAsync(dir)
    .then(() => logger.info('API', 'local-music', 'Manual rescan done', { dir, count: state.songs.length }))
    .catch((e) => logger.error('API', 'local-music', 'Manual rescan failed', { error: e && e.message }))
    .finally(() => {
      scanPromise = null;
    });
  return true;
}

// 异步扫描（手动重扫用）：全量重新解析每个文件并更新进度（与增量不同，手动重扫会重新读取
// 标签/封面/歌词，用于修正磁盘侧新增的 sidecar 封面或 .lrc），期间让出事件循环以便轮询进度接口
async function scanAsync(dir) {
  const files = [];
  walkAudio(dir, files, '');

  const dirs = [];
  collectDirs(dir, dirs, '');

  const songs = [];
  const artistMap = new Map();
  const albumMap = new Map();
  const folderMap = new Map();

  for (const d of dirs) ensureFolder(folderMap, d);

  const total = files.length;
  const jobId = beginJob('manual', '扫描音乐');
  scanProgress.total = total;
  scanProgress.scanned = 0;

  try {
    for (let i = 0; i < files.length; i++) {
      // 用户点了「停止」：立即中断，且不写入半量结果（否则会丢歌）
      if (isCancelRequested()) {
        logger.info('API', 'local-music', 'Manual rescan cancelled by user', { processed: i, total });
        endJob(jobId, { cancelled: true });
        return;
      }
      const { full, rel, kind } = files[i];
      try {
        if (kind === 'strm') {
          await processStrmFile(full, rel, songs, artistMap, albumMap, folderMap);
        } else {
          await processFile(full, rel, songs, artistMap, albumMap, folderMap);
        }
      } catch (err) {
        // 单条解析失败不影响整体
        logger.warn('API', 'local-music', 'process local file failed, skip', { full, error: err && err.message });
      }
      scanProgress.scanned = i + 1;
      localPipeline.reportStage0(i + 1, files.length);
      // 每处理 5 个文件让出事件循环，保证 scan-status 轮询能被响应
      if ((i + 1) % 5 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    // 合并已有真实元数据，避免用文件空值覆盖已补全的专辑/时长/封面
    mergeExistingMeta(songs);

    finalizeScan(dir, dirs, songs, artistMap, albumMap, folderMap);
    // mergeExistingMeta 在聚合之后才把历史补全的专辑名回填到歌曲，必须基于已 merge 的
    // state.songs 再聚合一次；否则本次 backfill 若跳过（无缺失数据），专辑会停在空聚合结果。
    rebuildStateIndexes();
    await persistScan(); // 必须 await：保证扫描解析结果（含 scan_status/album）落库提交后，流水线才能读到待处理记录
    // 手动全量重扫：所有歌曲在上方解析时已置 scan_status='raw_parsed'，
    // 这里执行阶段1-2（歌曲/专辑封面 / 歌手头像）；空库（0 文件）跳过，避免空跑。
    if (!isCancelRequested() && songs.length > 0) {
      await localPipeline.runMetaStages({ trigger: 'manual', only: 'all' });
      // 流水线回填的专辑名/封面绑定同步进内存聚合，列表当次扫描结束即可见
      await syncCoversFromDb();
      // 补录的时长同步回内存（strm 尤其依赖：文件侧无时长，靠插件搜索补录）
      await syncDurationsFromDb();
      // 同步 scan_status 回内存：否则之后 monitor 增量扫描会克隆到过期的 raw_parsed 而误把整库当新歌重跑
      await syncScanStatusFromDb();
    }
    endJob(jobId, { cancelled: isCancelRequested() });
  } catch (e) {
    endJob(jobId, { error: e && e.message });
    throw e;
  }
}

// 目录变化自动感知：节流检测指纹，变化则重扫
const FRESH_CHECK_INTERVAL = 5000;

function ensureFresh() {
  // 有 OS 级 inotify 监听时绝不触碰磁盘：避免全目录 stat 唤醒休眠硬盘，
  // 变更完全由 fs.watch 事件驱动重扫（后端内存自动保持最新）。
  if (fsWatcher) return;

  // 仅当 fs.watch 不可用（异常挂载/平台限制）时才退化为请求时指纹比对（节流）
  const now = Date.now();
  if (now - state.lastFreshCheckMs < FRESH_CHECK_INTERVAL) return;
  state.lastFreshCheckMs = now;
  let sig = '';
  try { sig = computeSig(state.dir); } catch { sig = ''; }
  if (sig !== state.sig) {
    scan(state.dir, 'monitor');
  }
}

// 每进程只自动调度一次：本地库就绪后，增量处理此前已标记 raw_parsed 的「新歌」
// （含本次启动前已落库但未补全的，如服务器宕机期间新增的歌曲；文件监听只对「之后的变化」生效，不会重触发）。
// 走 monitor 增量流水线（feeder 仅取 raw_parsed，不重扫整库旧歌），符合「只处理新增的歌曲」的诉求；
// 旧歌全量补图不再开机自动跑，改由用户手动点「完整扫描 / 补全图片」触发，避免占用唯一流水线槽位挡住新歌。
let bootIncrementalScheduled = false;
function maybeScheduleCoverBackfill() {
  if (bootIncrementalScheduled) return;
  bootIncrementalScheduled = true;
  logger.info('API', 'local-music', '启动增量处理待补全的新歌（仅 raw_parsed，不重扫旧歌）');
  localPipeline.runMetaStages({ trigger: 'monitor', only: 'all' })
    .then(() => syncCoversFromDb())
    .then(() => syncDurationsFromDb())
    .catch((e) => logger.warn('API', 'local-music', 'boot incremental pipeline failed', { error: e && e.message }));
}

function ensureScanned() {
  startFsWatcher(); // 目录不存在被创建的场景下补一次启动
  if (state.dir !== null) {
    maybeScheduleCoverBackfill(); // 库已就绪（warm/扫描完成）：自动补一次缺真实头像的歌手
    return;
  }
  // 尚未就绪：等待 warm（从数据库快速加载）完成后，若仍无数据（首启/空库/升级重建）才启动扫描，
  // 避免与 warm 抢跑导致「每次重启都全量扫描 + 联网补全」。
  const warm = warmLocalPromise || Promise.resolve();
  warm.then(() => {
    if (state.dir !== null) {
      maybeScheduleCoverBackfill();
      return;
    }
    if (scanPromise) return; // 已在扫描（backfill 完成时会入队）
    if (!fs.existsSync(MUSIC_DIR)) {
      try { fs.mkdirSync(MUSIC_DIR, { recursive: true }); } catch { /* 忽略 */ }
    }
    state.dir = MUSIC_DIR; // 占位：目录列表由后台扫描异步填充
    scan(MUSIC_DIR, 'startup')
      .then(() => logger.info('API', 'local-music', 'Local music library scanned', { dir: state.dir, count: state.songs.length }))
      .catch(() => {});
  }).catch(() => {});
}

// 指定目录的浏览视图
function folderView(relDir) {
  const key = relDir || '';
  const entry = state.folderMap.get(key);
  if (!entry) return { folders: [], songs: [] };
  const folders = Array.from(entry.folders).map((fp) => ({
    name: fp.slice(fp.lastIndexOf('/') + 1),
    path: fp
  }));
  folders.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { folders, songs: entry.songs };
}

function coverUrl(filePath) {
  return filePath ? `/api/music/cover?path=${encodeURIComponent(filePath)}` : null;
}

/**
 * 把插件补全结果合并进歌曲对象（模块级：扫描回填与 /api/music/enrich 共用）。
 * 注意：hasCover / coverRelpath 代表「本地文件 WebP 缓存」，仅由封面本地化写入；
 * 插件返回的远程封面 URL（result.cover）只是无本地封面时的会话级展示兜底，不改变 hasCover、不落库。
 */
function mergeEnrichIntoSong(song, result) {
  if (!song || !result) return false;
  let changed = false;
  if (result.cover && !song.coverRelpath) {
    song.coverUrl = result.cover;
    song.artwork = result.cover;
    changed = true;
  }
  const album = result.matched ? extractAlbum(result.matched) : '';
  // 歌曲原本专辑为空（历史数据可能是'未知专辑'占位）时，用搜索结果里的真实专辑回填
  if (album && (!song.album || song.album === '未知专辑')) {
    song.album = album;
    changed = true;
  }
  const dur = result.matched ? extractDuration(result.matched) : 0;
  if (dur > 0 && !song.duration) {
    song.duration = dur;
    changed = true;
  }
  return changed;
}

/**
 * 播放/补全命中后：把该曲所在的「专辑封面 + 歌手头像」交给后台单并发队列自动补全并落库。
 * 已补过（source=album-real / artist-real 且文件在）的会跳过，不会重复联网；非阻塞。
 */
function enqueueSongCovers(song) {
  if (!song) return;
  const artist = String(song.artist || '').trim();
  const album = String(song.album || '').trim();
  if (artist && artist !== '未知艺术家' && artist !== '未知' && !artistHasRealCover(artist)) {
    coverFillQueue.enqueue('artist', artist);
  }
  if (album && album !== '未知专辑' && album !== '未知' && artist && !albumHasRealCover(album, artist)) {
    coverFillQueue.enqueue('album', album, artist);
  }
}

// ---------------- ReplayGain 轨道增益读取（音频标签 ReplayGain_Track_Gain，dB） ----------------
// 会话内缓存（relPath -> gain|null），避免重复 parseFile；无标签缓存 null 且不写库。
const _rgCache = new Map();

/**
 * 懒读取歌曲的 ReplayGain 标签（播放/列表首次触发时一次 parseFile），
 * 读到则回填内存 song 对象并落库（local_songs.replay_gain），供 OpenSubsonic 输出。
 */
async function readReplayGainForSong(song) {
  try {
    if (!song || !song.id || !song.relPath || song.replayGain != null) return;
    if (_rgCache.has(song.relPath)) {
      const cached = _rgCache.get(song.relPath);
      if (cached != null) song.replayGain = cached;
      return;
    }
    const full = path.join(MUSIC_DIR, song.relPath);
    if (!fs.existsSync(full)) return;
    const mm = require('music-metadata');
    const meta = await mm.parseFile(full, { duration: false, skipCovers: true });
    const rg = meta && meta.common && meta.common.replaygain_track_gain;
    // music-metadata 各版本兼容：{ dB } 对象或直接数值
    const val = (rg && typeof rg === 'object' && typeof rg.dB === 'number') ? rg.dB
      : (typeof rg === 'number' ? rg : null);
    _rgCache.set(song.relPath, val);
    if (val != null) {
      song.replayGain = val;
      await localLibraryDb.updateReplayGainForId(song.id, val);
    }
  } catch { /* 标签读取失败静默：无 RG 数据不影响主流程 */ }
}

/**
 * 播放本地歌时的按需补全：仅当该曲缺封面 / 专辑 / 时长之一才联网搜索并落库。
 * 供 OpenSubsonic / Web 等任意播放入口调用；DB-first + 配置插件约束由 enrichLocalMusic 保证。
 * fire-and-forget 调用方无需 await。
 */
async function enrichLocalSongOnPlay(song) {
  try {
    if (!song || !song.id || !song.filePath) return;
    readReplayGainForSong(song).catch(() => {}); // fire-and-forget：读 RG 标签回填（不阻塞）
    const target = (Array.isArray(state.songs) && state.songs.find((x) => x.id === song.id)) || song;
    if (target.hasCover && target.album && target.duration) {
      enqueueSongCovers(target); // 曲目无缺失；所在专辑封面/歌手头像仍可能缺 → 后台队列补齐落库
      return;
    }
    const result = await enrichLocalMusic(
      {
        id: target.id,
        title: target.title,
        artist: target.artist,
        album: target.album,
        filePath: target.filePath,
        plugin: 'local'
      },
      { includeLyrics: false, preferMusic: true, trigger: 'play' }
    );
    if (!result) return;
    let touched = false;
    if (result.cover && !target.coverRelpath) {
      touched = await ensureRemoteCoverFile(target, result.cover); // 下载 → WebP(MD5) 落盘
    }
    if (mergeEnrichIntoSong(target, result)) touched = true; // 回填专辑/时长/会话封面
    if (touched) {
      rebuildStateIndexes();
      persistScan(); // 写库，重启后可复用
      logger.info('API', 'local-music', 'local song metadata enriched on play', {
        id: target.id, title: target.title, album: target.album || null,
        hasCover: target.hasCover, duration: target.duration || null
      });
      enqueueSongCovers(target); // 补完曲目后，顺带把所在专辑封面/歌手头像送入后台队列自动落库
    }
  } catch (e) {
    logger.warn('API', 'local-music', 'enrich local song on play failed', { error: e && e.message });
  }
}

module.exports = function (app) {

  // 本地曲库浏览与扫描接口均需登录：避免未授权枚举整库、触发扫描
  app.use('/api/music', authMiddleware);

  // 全部歌曲（支持分页：?limit=&offset=；不传 limit 返回全量，向后兼容）
  app.get('/api/music/songs', async (req, res) => {
    try {
      ensureScanned();
      ensureFresh();
      // 过滤：artist/album/folder 用于详情/目录视图的精准过滤，q 用于搜索（模糊匹配 歌名/歌手/专辑）
      let base = state.songs;
      const q = (req.query.q || '').toString().trim();
      const artist = (req.query.artist || '').toString().trim();
      const album = (req.query.album || '').toString().trim();
      const folder = (req.query.folder || '').toString().trim();
      let filtered = base;
      if (artist) {
        filtered = filtered.filter(s => (s.artist || '') === artist);
      } else if (album) {
        filtered = filtered.filter(s => (s.album || '') === album);
      } else if (folder) {
        filtered = filtered.filter(s => {
          const f = (s.folder || '').replace(/\\/g, '/');
          return f === folder || f.startsWith(folder + '/');
        });
      }
      if (q) {
        const kw = q.toLowerCase();
        filtered = filtered.filter(s => `${s.title || ''} ${s.artist || ''} ${s.album || ''}`.toLowerCase().includes(kw));
      }
      const all = filtered.map(publicSongView);
      const limit = parseInt(req.query.limit);
      const offset = parseInt(req.query.offset) || 0;
      const page = (Number.isFinite(limit) && limit > 0) ? all.slice(offset, offset + limit) : all;
      ok(res, page, { total: all.length, dir: state.dir });
    } catch (e) {
      serverError(res, e.message);
    }
  });

  // 歌手聚合：封面优先「真实歌手头像」（artist-real，md5 落盘），没有才回退代表歌曲封面
  app.get('/api/music/artists', async (req, res) => {
    try {
      ensureScanned();
      ensureFresh();
      // 歌手头像：内存聚合的真实头像（artist-real 绑定）优先；否则回落 DB 绑定路径查询。
      const data = [];
      for (const a of state.artists) {
        const rel = a.artistCoverRelpath || await resolveEntityCoverRelpath('artist', a.name, null);
        data.push({
          ...a,
          artwork: rel ? coverArtUrl(rel, null) : coverUrl(a.coverPath)
        });
      }
      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 专辑聚合
  app.get('/api/music/albums', async (req, res) => {
    try {
      ensureScanned();
      ensureFresh();
      // 专辑封面：内存聚合的真实专辑封面（album-real 绑定）优先；否则回落 DB 绑定路径查询。
      // 注意：绝不回退到歌曲文件封面（coverPath），避免专辑图与单曲封面显示成同一张。
      const data = [];
      for (const a of state.albums) {
        const rel = a.coverRelpath || await resolveEntityCoverRelpath('album', a.name, a.artist);
        data.push({ ...a, artwork: rel ? coverArtUrl(rel, null) : null });
      }
      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 封面链路诊断（临时）：返回专辑绑定路径、内存聚合与磁盘文件存在性
  app.get('/api/music/cover-debug', async (req, res) => {
    try {
      ensureScanned();
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const albums = [];
      for (const a of state.albums.slice(0, limit)) {
        const rel = await localLibraryDb.getAlbumRealCoverRelpath(a.name, a.artist);
        const full = rel ? coverCache.resolveRelpath(rel) : null;
        albums.push({
          name: a.name,
          artist: a.artist,
          albumCoverRelpath: rel || null,
          memoryCoverRelpath: a.coverRelpath || null,
          fileExists: full ? fs.existsSync(full) : false
        });
      }
      res.json({ success: true, albumCount: state.albums.length, albums });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 根目录结构（文件夹 tab）
  app.get('/api/music/folders', async (req, res) => {
    try {
      ensureScanned();
      ensureFresh();
      const view = folderView('');
      res.json({ success: true, data: { folders: view.folders, songs: view.songs.map(publicSongView) } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 完整目录列表（含空目录，字母排序）
  app.get('/api/music/tree', async (req, res) => {
    try {
      ensureScanned();
      ensureFresh();
      res.json({ success: true, data: state.dirs });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 指定目录结构（文件夹 tab 逐层浏览）
  app.get('/api/music/folder', async (req, res) => {
    try {
      ensureScanned();
      ensureFresh();
      const rel = String(req.query.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const view = folderView(rel);
      res.json({ success: true, data: { folders: view.folders, songs: view.songs.map(publicSongView) } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 歌曲封面：扫描期已把内嵌/sidecar 封面统一预处理为 WebP 缓存到磁盘。
  // 本接口只静态返回缓存文件（零图片运算），仅在缓存缺失时兜底读取一次文件内嵌封面（兼容旧库）。
  app.get('/api/music/cover', async (req, res) => {
    // 静态优先：relpath=cover_relpath 直接 sendFile（getCoverArt 同源缓存）
    const relpath = String(req.query.relpath || '');
    if (relpath) {
      const cacheFull = coverCache.resolveRelpath(relpath);
      if (cacheFull && fs.existsSync(cacheFull)) {
        res.setHeader('Content-Type', coverCache.mimeOf(cacheFull));
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(cacheFull);
      }
      return res.status(404).json({ error: 'No cover' });
    }

    const filePath = String(req.query.path || '');
    if (!filePath) {
      return res.status(400).json({ error: 'Missing path' });
    }
    // 由 path 反查歌曲 → 命中已生成的 WebP 缓存则静态返回
    const song = findSongByFilePath(filePath);
    if (song && song.coverRelpath) {
      const cacheFull = coverCache.resolveRelpath(song.coverRelpath);
      if (cacheFull && fs.existsSync(cacheFull)) {
        res.setHeader('Content-Type', coverCache.mimeOf(cacheFull));
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(cacheFull);
      }
    }
    // 兜底：无缓存时读取文件内嵌封面（仅 mp3 等 node-id3 可读；仅供升级过渡期，之后由扫描补齐）
    let entry = state.coverCache.get(filePath);
    if (entry === undefined) {
      entry = null;
      try {
        const tags = NodeID3.read(filePath);
        const img = tags && tags.image;
        if (img && img.imageBuffer) {
          entry = { mime: img.mime || 'image/jpeg', buffer: img.imageBuffer };
        }
      } catch { entry = null; }
      state.coverCache.set(filePath, entry);
    }
    if (!entry) {
      return res.status(404).json({ error: 'No cover' });
    }
    res.setHeader('Content-Type', entry.mime);
    res.setHeader('Cache-Control', 'max-age=3600');
    res.send(entry.buffer);
  });

  // 手动补全缺失图片（设置→歌词封面→补全封面 / 歌手头像 / 专辑封面）：
  // 后台逐项搜索并下载转 WebP 落库；只补缺失项，已补过的快速跳过，不重复下载。
  app.post('/api/music/fill-images', async (req, res) => {
    try {
      const type = String((req.body || {}).type || '').trim();
      const labelMap = { cover: '歌曲封面', artist: '歌手头像', album: '专辑封面' };
      const label = labelMap[type];
      if (!label) {
        return res.status(400).json({ success: false, error: 'type 须为 cover / artist / album' });
      }
      ensureScanned();
      ensureFresh();
      // 已有扫描 / 歌曲专辑回填 / 阶段流水线在跑时，避免手动补图与其并发联网；歌手头像走队列不受影响
      if (type !== 'artist' && (backfillRunning || albumArtFillRunning || scanProgress.scanning || localPipeline.isRunning())) {
        return res.json({ success: true, message: '已有扫描/补全任务进行中，请稍后再试', busy: true });
      }
      let extra = null;
      // 手动补全统一走 Step1-8 流水线（trigger='fill'）：只补缺失，绝不覆盖已有数据。
      // 三类（歌曲封面 / 歌手头像 / 专辑封面）同属图片，过滤参数统一为 only='image'，
      // 流水线内部按各字段缺失情况逐项补齐，已补过的直接跳过。
      const jobId = beginJob('fill', `补全${label}`, 'pipeline');
      localPipeline.runMetaStages({ trigger: 'fill', only: 'image' })
        .then(() => endJob(jobId, {}))
        .catch((e) => {
          endJob(jobId, { error: e && e.message });
          logger.warn('API', 'local-music', 'manual fill-images failed', { type, error: e && e.message });
        });
      res.json({ success: true, type, label, message: `${label}补全已启动（后台执行中）`, ...(extra || {}) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 手动元数据补全（艺术家 / 专辑 / 标题）：
  // 自动扫描阶段「核心字段完整就跳过插件」，个别异常歌曲交给用户手动点这里修复。
  //  - overwrite=false（默认）：只补缺失字段，不覆盖已有有效值；
  //  - overwrite=true：允许插件完整覆盖现有元数据（用于目录/标签都错乱的个别歌曲）；
  //  - 传 ids 时只处理指定歌曲（前端对选中歌曲点「补全元数据」）。
  // 只跑元数据，不搜封面/头像/歌词（那些由「缺失图片一键补全」负责）。
  app.post('/api/music/fill-metadata', async (req, res) => {
    try {
      const { ids, overwrite } = req.body || {};
      const doOverwrite = overwrite === true || overwrite === 'true';
      let relPaths = [];
      if (Array.isArray(ids) && ids.length) {
        const idSet = new Set(ids.map((x) => String(x)));
        relPaths = (state.songs || [])
          .filter((s) => s && s.relPath && idSet.has(String(s.id)))
          .map((s) => s.relPath);
        if (!relPaths.length) {
          return res.status(404).json({ success: false, error: '未找到指定歌曲（请确认歌曲已在本地曲库中）' });
        }
      }
      // 覆盖模式必须显式指定歌曲：不带 ids 时 metaFillWhere 退化为全库条件，
      // 一次误触就会把整库元数据交给插件覆盖（matchScore 误配风险大）
      if (doOverwrite && !relPaths.length) {
        return res.status(400).json({ success: false, error: '覆盖修正模式必须先勾选要修正的歌曲（ids）' });
      }
      ensureScanned();
      ensureFresh();
      if (scanProgress.scanning || localPipeline.isRunning()) {
        return res.json({ success: true, busy: true, message: '已有扫描/补全任务进行中，请稍后再试' });
      }
      const label = doOverwrite ? '覆盖修正元数据' : '补全缺失元数据';
      const jobId = beginJob('fill', label, 'pipeline');
      localPipeline.runMetaStages({ trigger: 'fill', only: 'meta', overwrite: doOverwrite, relPaths })
        .then(() => syncMetaFromDb(doOverwrite))
        .then(() => syncCoversFromDb())
        .then(() => endJob(jobId, {}))
        .catch((e) => {
          endJob(jobId, { error: e && e.message });
          logger.warn('API', 'local-music', 'manual fill-metadata failed', { error: e && e.message });
        });
      res.json({
        success: true,
        overwrite: doOverwrite,
        count: relPaths.length,
        message: relPaths.length
          ? `${label}已启动（${relPaths.length} 首，后台执行中）`
          : `${label}已启动（后台执行中）`
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 用户手动编辑元数据（优先级最高）：写入后来源标记为 manual，
  // 后续自动扫描/插件补全（含手动覆盖模式）都不会再改动这些字段。
  app.post('/api/music/update-meta', async (req, res) => {
    try {
      const { id, title, artist, album } = req.body || {};
      if (!id) return res.status(400).json({ success: false, error: '缺少歌曲 id' });
      const song = (state.songs || []).find((s) => s && s.id === String(id));
      if (!song || !song.relPath) return res.status(404).json({ success: false, error: '歌曲不存在' });
      const fields = {};
      if (title !== undefined && String(title).trim()) fields.title = String(title).trim();
      if (artist !== undefined && String(artist).trim()) fields.artist = String(artist).trim();
      if (album !== undefined && String(album).trim()) fields.album = String(album).trim();
      if (!Object.keys(fields).length) {
        return res.status(400).json({ success: false, error: '没有需要更新的字段' });
      }
      await localLibraryDb.updateSongMetaFields(song.relPath, fields, true, META_SRC.MANUAL, true);
      // 同步内存（手动编辑直接覆盖当前值）
      if (fields.title) { song.title = fields.title; song.titleSource = META_SRC.MANUAL; }
      if (fields.artist) { song.artist = fields.artist; song.artistSource = META_SRC.MANUAL; }
      if (fields.album) { song.album = fields.album; song.albumSource = META_SRC.MANUAL; }
      song.metaSource = combineMetaSource(song.titleSource, song.artistSource, song.albumSource);
      rebuildStateIndexes();
      res.json({ success: true, id: song.id, song: publicSongView(song) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 强制重扫（异步执行，通过 scan-status 查询进度）
  app.post('/api/music/rescan', async (req, res) => {
    try {
      ensureScanned();
      if (scanProgress.scanning || scanPromise) {
        // 已有任务在跑（含后台首次扫描 / 目录变更扫描 / 补全）：不重复启动，前端直接显示其进度
        return res.json({ success: true, scanning: true, busy: true, message: '正在扫描/补全中' });
      }
      const dir = (state.dir && fs.existsSync(state.dir)) ? state.dir : MUSIC_DIR;
      if (!startManualScan(dir)) {
        return res.json({ success: true, scanning: true, busy: true, message: '正在扫描/补全中' });
      }
      res.json({ success: true, scanning: true, count: state.songs.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 停止正在进行的扫描 / 补全（顶栏进度圆圈 → 停止按钮）
  app.post('/api/music/cancel-scan', async (req, res) => {
    try {
      const cancelled = requestCancel();
      res.json({
        success: true,
        cancelled,
        message: cancelled ? '已请求停止，正在中断…' : '当前没有正在运行的扫描/补全任务'
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 删除本地歌曲文件，并同步清理数据库（应用内删除：删文件 + 删同名 .lrc + 内存移除 + 落库覆盖）
  // 高危：删除本地歌曲文件 + 落库，仅管理员可执行
  app.post('/api/music/delete', adminMiddleware, async (req, res) => {
    try {
      const { id, ids } = req.body || {};
      const targetIds = Array.isArray(ids) ? ids : (id ? [id] : []);
      if (!targetIds.length) {
        return res.status(400).json({ success: false, error: '缺少歌曲 id' });
      }
      let deleted = 0;
      for (const tid of targetIds) {
        const song = state.songs.find((s) => s.id === tid);
        if (!song) continue;
        const fp = song.filePath;
        // 删除磁盘上的歌曲文件（普通音频或 .strm）
        if (fp && fs.existsSync(fp)) {
          try { fs.unlinkSync(fp); } catch (e) { logger.warn('API', 'local-music', 'delete file failed', { fp, error: e && e.message }); }
        }
        // 删除同目录同名 .lrc（歌词落盘文件，无内嵌能力时靠它加载）
        if (fp) {
          try {
            const lrc = path.join(path.dirname(fp), path.basename(fp, path.extname(fp)) + '.lrc');
            if (fs.existsSync(lrc)) fs.unlinkSync(lrc);
          } catch (e) { /* 忽略 */ }
        }
        state.songs = state.songs.filter((s) => s.id !== tid);
        deleted++;
      }
      if (deleted) {
        rebuildStateIndexes();
        persistScan(); // replaceSongs 全表覆盖，数据库同步删除这些歌曲
      }
      res.json({ success: true, deleted });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 本地音乐库数据库统计（歌曲条数 / 封面缓存条数），供缓存管理页展示
  app.get('/api/music/local-stats', async (req, res) => {
    try {
      const stats = await localLibraryDb.getStats();
      res.json({ success: true, data: stats });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 清理本地音乐库数据库数据（local_songs 及 settings 中 local_meta: 前缀的键值），并重置内存库以便按磁盘重建
  // 高危：清空本地音乐库数据库，仅管理员可执行
  app.post('/api/music/clear-local-data', adminMiddleware, async (req, res) => {
    try {
      await localLibraryDb.clearLocalData();
      // 重置内存工作集，下次访问本地音乐时按磁盘重新扫描（不再带旧补全数据）
      state.songs = [];
      state.artists = [];
      state.albums = [];
      state.dirs = [];
      state.folderMap = new Map();
      state.coverCache.clear();
      state.dir = null;
      logger.info('API', 'local-music', 'Local library data cleared, will rescan on next access');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 扫描 / 补全进度（前端常驻轮询：任何来源的任务都会在这里上报）
  app.get('/api/music/scan-status', async (req, res) => {
    try {
      // 首启（DB 为空 / 结构升级）时由轮询顺带触发后台首次扫描，
      // 使「首次后台扫描」的进度也能实时显示；已就绪时此调用为空操作。
      ensureScanned();
      // 合并阶段化流水线状态（Step1-8 进度：触发来源 / 当前歌曲 / 当前步骤 / 已完成·总数·排队数）
      // 注意：用嵌套 pipeline 字段传递，避免流水线的 total 覆盖 scanProgress 的文件总数。
      res.json({ success: true, ...scanProgress, pipeline: localPipeline.getStatus(), count: state.songs.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 阶段化流水线全局状态（UI 右上角圆圈进度专用，返回 scanGlobalState 等）
  app.get('/api/music/pipeline-status', async (req, res) => {
    try {
      res.json({ success: true, ...localPipeline.getStatus() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 启动完整扫描流水线（处理 monitor 阶段0后产生的 raw_parsed 记录：阶段1-3）。
  // 不重新解析文件，只跑元数据采集/歌手头像/图片下载。并发受流水线内部控制。
  app.post('/api/music/run-pipeline', async (req, res) => {
    try {
      if (localPipeline.isRunning()) {
        return res.json({ success: false, running: true, message: '流水线已在运行中' });
      }
      // 异步执行，立即返回；进度由 /api/music/pipeline-status 轮询。
      localPipeline.runMetaStages({ reset: false, trigger: 'manual', only: 'all' })
        .then(() => syncCoversFromDb())
        .then(() => syncDurationsFromDb())
        .then(() => syncScanStatusFromDb())
        .catch((e) => {
          logger.error('API', 'local-music', 'run-pipeline failed', { error: e && e.message });
        });
      res.json({ success: true, message: '已启动完整扫描流水线' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 本地歌曲补全（无本地封面/专辑/时长时，通过插件搜索网络版本补封面 + 专辑 + 时长）
  // 把 enrich 结果合并进内存歌曲对象（仅填充缺失字段，不覆盖已有真实数据）。返回是否发生变更。
  /**
   * 播放触发补缺失：仅针对「当前正在播放的这一首」。
   * 存在缺失项（单曲封面 / 专辑封面 / 歌手头像 / 歌词）时以【高优先级】插入 Step1-8 流水线队列，
   * 不批量处理其他歌曲；专辑封面与歌手头像由流水线 Step3 / Step4 一并补齐。
   */
  async function enqueuePlayFill(song) {
    try {
      if (!song || !song.relPath) return;
      const missing = !song.coverRelpath || !song.albumCoverRelpath
        || !song.artistCoverRelpath || !song.lyricRaw;
      if (!missing) return;
      // 风险4：冷却期内（24h 内失败过）的歌曲，播放触发也跳过，避免重复无效联网
      if (await localLibraryDb.isInEnrichCooldown(song.relPath)) {
        logger.debug('API', 'local-music', '[播放触发补缺失] 冷却期内跳过', { relPath: song.relPath });
        return;
      }
      localPipeline.enqueueSong({
        rel_path: song.relPath,
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        cover_relpath: song.coverRelpath,
        album_cover_relpath: song.albumCoverRelpath,
        artist_cover_relpath: song.artistCoverRelpath,
        lyric_raw: song.lyricRaw,
        // 时长/is_strm 必须带上：否则流水线 Step1.5 无法判定「已有真实时长」，
        // 会对已有时长的歌（含播放时客户端写回的真实时长）再发一次无谓的时长搜索。
        duration: song.duration,
        is_strm: song.isStrm ? 1 : 0
      }, 'play', true);
      logger.info('API', 'local-music', '[播放触发补缺失] 已插入高优先级队列', { title: song.title, artist: song.artist });
    } catch (e) {
      logger.warn('API', 'local-music', 'play-trigger enqueue failed', { error: e && e.message });
    }
  }

  // 供 /api/music/enrich（播放时）与手动扫描的批量补全阶段共用，保证回填规则一致。
  app.post('/api/music/enrich', async (req, res) => {
    try {
      const { music } = req.body || {};
      // 播放时按需补全：只搜封面/专辑/时长（includeLyrics=false），
      // 歌词由播放器的 /api/lyrics 走完整歌词链路单独获取，避免重复联网
      const result = await enrichLocalMusic(music, { includeLyrics: false, preferMusic: true, trigger: 'play' });

      // 搜索结果写回内存歌曲并落库（专辑/时长真实元数据持久化）。
      // strm / 无本地封面歌曲：把补全搜到的远程封面下载后统一转成 WebP 缓存文件并落库，
      // 之后 /api/music/cover 与 OpenSubsonic getCoverArt 均静态返回该缓存，重启不丢失。
      try {
        const song = music && music.id ? state.songs.find((s) => s.id === music.id) : null;
        if (song && result) {
          let touched = false;
          // strm/无本地封面：远程封面下载并本地化为 WebP 缓存（只发生一次，成功后 coverRelpath 已存在）
          if (result.cover && !song.coverRelpath) {
            touched = await ensureRemoteCoverFile(song, result.cover);
          }
          if (mergeEnrichIntoSong(song, result)) touched = true;
          // 仅在确有新增数据时才整表落库，避免同曲重复播放触发无意义的全量写
          if (touched) {
            rebuildStateIndexes();
            persistScan(); // 后台落库（replaceSongs 全表覆盖，重启后可复用封面缓存引用/专辑/时长）
          }
          // 播放触发补缺失：仅当前这一首，缺失项高优先级插入 Step1-8 流水线（不批量处理其他歌曲）
          enqueuePlayFill(song);
        }
      } catch (e) {
        logger.warn('API', 'local-music', 'enrich writeback failed', { error: e && e.message });
      }

      // 返回的 matched.album/duration 做清洗：album 去掉"未知专辑"等占位；
      // duration 统一转成秒，前端据此把真实专辑与时长写回当前歌曲/播放列表
      const cleanMatched = result.matched
        ? { ...result.matched, album: extractAlbum(result.matched), duration: extractDuration(result.matched) }
        : null;
      res.json({
        success: true,
        cover: result.cover,
        lyrics: result.lyrics,
        matched: cleanMatched
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 歌词/封面/专辑图 检索测试（设置→歌词封面→插件连通性测试）
  // 按当前配置的歌词/封面插件列表真实跑一遍检索，返回命中的内容供判断插件是否正常。
  // kind: 'lyric' 测歌词；'cover' 测单曲封面 + 专辑图（同一歌名+歌手搜索拿到匹配歌曲及其封面，
  //   再从匹配歌曲的 album 字段自动算出专辑名，按「专辑名+歌手」再搜一次得到专辑图，两张图分开展示）。
  app.post('/api/music/test-enrich', async (req, res) => {
    try {
      const { title, artist, album, kind, plugin } = req.body || {};
      const qTitle = String(title || '').trim();
      const qArtist = String(artist || '').trim();
      const qAlbum = String(album || '').trim();
      const wantLyric = kind === 'lyric';
      const wantAlbum = kind === 'album';
      const wantArtist = kind === 'artist';
      if (!qTitle && !qAlbum && !wantArtist) return res.json({ success: false, error: '请输入歌名或专辑名或歌手' });
      if (wantArtist && !qArtist) return res.json({ success: false, error: '测试歌手头像请输入歌手名' });
      // ignoreCache: 连通性测试必须绕过缓存，强制真实走一次插件，才能验证插件当前是否可用
      const optsBase = { includeLyrics: wantLyric, preferMusic: !wantLyric && !wantArtist, trigger: 'test', ignoreCache: true };
      if (plugin && String(plugin).trim()) {
        optsBase.forcePlugins = [String(plugin).trim()]; // 测试时单独指定插件，忽略当前配置列表
      }
      let result = { cover: null, lyrics: null, matched: null };
      let matchedAlbum = null;
      let matchedInfo = null;
      let realArtist = qArtist;
      if (wantArtist) {
        // 测试歌手封面：不走歌曲匹配，直接用输入的歌手（或歌名兜底）搜索头像
        realArtist = qArtist;
      } else {
        // 1) 封面/歌词：按 歌名+歌手 搜索
        const searchTitle = wantAlbum ? (qAlbum || qTitle) : qTitle;
        result = await enrichLocalMusic(
          { title: searchTitle, artist: qArtist },
          optsBase
        );
        const m = result.matched || null;
        matchedAlbum = m ? extractAlbum(m) : null;
        matchedInfo = m ? {
          title: m.title || m.songname || m.name || '',
          artist: Array.isArray(m.artist) ? m.artist.map((a) => (a && (a.name || a)) || '').join(' / ') : (m.artist || ''),
          album: matchedAlbum
        } : null;
        // 用匹配歌曲的真实歌手辅助定位专辑/头像；匹配不到歌手时退回用户输入的歌手
        realArtist = m
          ? (Array.isArray(m.artist) ? (m.artist[0] && (m.artist[0].name || m.artist[0])) || '' : m.artist || '')
          : qArtist;
      }
      const forcePlugins = (plugin && String(plugin).trim()) ? [String(plugin).trim()] : undefined;
      // 2) 歌手头像：仅「测试歌手封面」时搜索；「测试封面/专辑」只展示封面+专辑图，不搜头像（节省请求）
      let artistArt = null;
      if (wantArtist) {
        const name = (realArtist || qArtist).trim();
        if (name) {
          const artistCfg = resolveConfiguredPlugins('artist_image_plugins', '');
          // effective 仅用于日志展示，须与真实搜索一致：未配置 artist_image_plugins 即不搜，不复用封面插件
          const effective = forcePlugins ? forcePlugins : artistCfg;
          logger.info('LOCAL-ENRICH', req.reqId || 'test-enrich', 'test artist image plugin source', {
            selectedTestPlugin: plugin || '(auto)',
            forced: !!forcePlugins,
            artistImagePluginsConfig: artistCfg,
            effectivePlugins: effective,
            searchName: name
          });
          artistArt = await fetchArtistImage(name, { forcePlugins, ignoreCache: true });
        }
      }
      // 3) 专辑图：用命中歌曲「实际的 album 字段」按「专辑名」做一次真实的专辑搜索
      //    （search type='album'，返回该专辑本身的封面，不复用单曲封面）。
      //    仅当专辑名为空/"0"/null 时才视为无专辑，显示「无」。
      let albumArt = null;
      // 专辑图严格用「专辑名」搜索，绝不用歌名：
      //  - kind='album'（专辑测试）：直接用用户输入的专辑名 qAlbum；
      //  - kind='cover'（单曲封面测试）：用匹配歌曲的真实专辑名 matchedAlbum。
      const albumNameForSearch = (wantAlbum && qAlbum)
        ? qAlbum
        : ((!wantArtist && matchedAlbum && !/^(0|null|none)$/i.test(String(matchedAlbum).trim()))
          ? String(matchedAlbum).trim()
          : null);
      if (!wantLyric && !wantArtist && albumNameForSearch) {
        albumArt = await fetchAlbumImage(albumNameForSearch, realArtist || qArtist, {
          forcePlugins,
          ignoreCache: true
        });
      }

      res.json({
        success: true,
        kind: wantLyric ? 'lyric' : (wantAlbum ? 'album' : (wantArtist ? 'artist' : 'cover')),
        pluginUsed: (plugin && String(plugin).trim()) ? String(plugin).trim() : null,
        query: { title: qTitle, artist: qArtist, album: qAlbum },
        searchBy: wantAlbum ? (qAlbum ? 'album' : 'song') : 'song',
        matched: matchedInfo || (wantArtist ? { artist: (realArtist || qArtist || qTitle).trim() } : null),
        // 封面：歌名+歌手搜索的结果
        hasCover: !!result.cover,
        cover: result.cover || null,
        // 歌手头像：真实歌手搜索的结果（搜不到则为 null）
        hasArtistArt: !!artistArt,
        artistArt: artistArt || null,
        // 专辑图：专辑名+歌手搜索的结果（无专辑名或搜不到则为 null）
        hasAlbumArt: !!albumArt,
        albumArt: albumArt || null,
        album: qAlbum || albumNameForSearch || null,
        hasLyrics: !!(result.lyrics && String(result.lyrics).trim()),
        rawLrc: (result.lyrics && String(result.lyrics).trim()) ? String(result.lyrics) : ''
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e && e.message });
    }
  });

  // 歌手图片：优先数据库已落盘真实歌手头像；未落盘则插件搜索 → 查到立即转 WebP(md5) 落库 → 返回本地静态 URL
  app.get('/api/music/artist-image', async (req, res) => {
    try {
      const name = String(req.query.name || '').trim();
      if (!name) return res.json({ success: true, image: null });
      // 1) 数据库已落盘且缓存文件在：直接返回本地封面
      const rel = await localLibraryDb.getArtistCoverRelpath(name);
      if (rel && fs.existsSync(coverCache.resolveRelpath(rel) || '')) {
        return res.json({ success: true, image: `/api/music/cover?relpath=${encodeURIComponent(rel)}` });
      }
      // 2) 未落库：交给全局单并发补全队列即时补一个（闸空闲才真正抓取下载/转码，绝不并发打源）。
      //    队列忙 / 未命中 → 返回占位 null，封面由后台队列渐进补齐
      const done = await coverFillQueue.fetchImmediate('artist', name);
      const rel2 = await localLibraryDb.getArtistCoverRelpath(name);
      if (done && rel2 && fs.existsSync(coverCache.resolveRelpath(rel2) || '')) {
        return res.json({ success: true, image: `/api/music/cover?relpath=${encodeURIComponent(rel2)}` });
      }
      res.json({ success: true, image: null });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 专辑图片：优先数据库已落盘真实专辑封面；未落盘则插件搜索 → 查到立即转 WebP(md5) 落库 → 返回本地静态 URL
  app.get('/api/music/album-image', async (req, res) => {
    try {
      const name = String(req.query.name || '').trim();
      const artist = String(req.query.artist || '').trim();
      if (!name) return res.json({ success: true, image: null });
      // 1) 数据库/内存已落盘且缓存文件在：直接返回本地封面
      const alObj = (state.albums || []).find((a) => String(a.name || '') === name && String(a.artist || '') === artist);
      if (alObj && alObj.coverRelpath && fs.existsSync(coverCache.resolveRelpath(alObj.coverRelpath) || '')) {
        return res.json({ success: true, image: `/api/music/cover?relpath=${encodeURIComponent(alObj.coverRelpath)}` });
      }
      // 2) 未落库：交给全局单并发补全队列即时补一个（闸空闲才真正抓取下载/转码，绝不并发打源）。
      //    队列忙 / 未命中 → 返回占位 null，封面由后台队列渐进补齐
      const done = await coverFillQueue.fetchImmediate('album', name, artist);
      const alObj2 = (state.albums || []).find((a) => String(a.name || '') === name && String(a.artist || '') === artist);
      if (done && alObj2 && alObj2.coverRelpath && fs.existsSync(coverCache.resolveRelpath(alObj2.coverRelpath) || '')) {
        return res.json({ success: true, image: `/api/music/cover?relpath=${encodeURIComponent(alObj2.coverRelpath)}` });
      }
      res.json({ success: true, image: null });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
};

// ==================== OpenSubsonic 集成：下载/播放本地音乐 ====================

/** 按 id 查找本地音乐歌曲（id = 'tr-' + md5(相对路径)），补全 contentType */
function getLocalSongById(id) {
  ensureScanned();
  const song = state.songs.find((s) => s.id === id);
  if (!song) return null;
  return { ...song, contentType: CONTENT_TYPES[song.suffix] || 'application/octet-stream' };
}

/**
 * 按 id 解析本地歌曲：内存库优先；未命中时回查持久化 local_songs 表。
 * 覆盖 REST 进程本地库尚未扫描 / 重扫导致内存库缺失，但服务端曾给出该 tr- id 的场景
 * （如箭头音乐从本地音乐浏览拿到 id、在另一请求里加入歌单时内存库未命中）。
 * @returns {Promise<Object|null>}
 */
async function getLocalSongByIdResolved(id) {
  if (!id || !String(id).startsWith('tr-')) return null;
  const mem = getLocalSongById(id);
  if (mem) return mem;
  try {
    const row = await localLibraryDb.loadLocalSongById(id);
    if (!row) return null;
    const song = songFromDbRow(row);
    song.plugin = 'local';
    song.contentType = CONTENT_TYPES[song.suffix] || 'application/octet-stream';
    return song;
  } catch {
    return null;
  }
}

/** 按标题/歌手在本地音乐库（/app/music）中匹配歌曲 */
function findLocalSongByTitleArtist(title, artist) {
  if (!title) return null;
  ensureScanned();
  const titleLower = String(title).toLowerCase();
  if (artist) {
    const artistLower = String(artist).toLowerCase();
    const exact = state.songs.find((s) =>
      s && s.title && s.artist &&
      titleLower === s.title.toLowerCase() &&
      (artistLower === s.artist.toLowerCase() ||
        artistLower.includes(s.artist.toLowerCase()) ||
        s.artist.toLowerCase().includes(artistLower))
    );
    if (exact) return { ...exact, contentType: CONTENT_TYPES[exact.suffix] || 'application/octet-stream' };
  }
  const matches = state.songs.filter((s) => s && s.title && titleLower === s.title.toLowerCase());
  if (matches.length === 1) {
    return { ...matches[0], contentType: CONTENT_TYPES[matches[0].suffix] || 'application/octet-stream' };
  }
  return null;
}

/** 由 filePath 反查歌曲对象（path → rel_path → tr-id），供封面 /api/music/cover?path= 反查缓存 */
function findSongByFilePath(filePath) {
  if (!filePath) return null;
  const fp = String(filePath).replace(/\\/g, '/');
  const base = String(MUSIC_DIR).replace(/\\/g, '/').replace(/\/+$/, '');
  let rel = '';
  if (fp.startsWith(base + '/')) rel = fp.slice(base.length + 1);
  else if (fp.startsWith('/')) rel = fp.replace(/^\/+/, '');
  else rel = fp;
  if (!rel) return null;
  const id = 'tr-' + md5(rel);
  return state.songs.find((s) => s.id === id) || null;
}

module.exports.getLocalSongById = getLocalSongById;
module.exports.getLocalSongByIdResolved = getLocalSongByIdResolved;
module.exports.findLocalSongByTitleArtist = findLocalSongByTitleArtist;
module.exports.findSongByFilePath = findSongByFilePath;
module.exports.enrichLocalSongOnPlay = enrichLocalSongOnPlay;

// ==================== OpenSubsonic 兼容：本地音乐三级索引 ====================

// OpenSubsonic 索引缓存（目录指纹不变则复用）
let subIndexCache = null;
let subIndexSig = '';

/** 读取文件内嵌封面（复用 coverCache），供 OpenSubsonic getCoverArt 使用 */
function getEmbeddedCover(filePath) {
  if (!filePath) return null;
  let entry = state.coverCache.get(filePath);
  if (entry === undefined) {
    entry = null;
    try {
      const tags = NodeID3.read(filePath);
      const img = tags && tags.image;
      if (img && img.imageBuffer) {
        entry = { mime: img.mime || 'image/jpeg', buffer: img.imageBuffer };
      }
    } catch { entry = null; }
    state.coverCache.set(filePath, entry);
  }
  return entry;
}

/** 构建 library 兼容的 songs/artists/albums（数据源：/app/music 本地音乐） */
function buildSubsonicIndex() {
  ensureScanned();
  const songs = state.songs.map((s) => {
    const artist = s.artist || '未知艺术家';
    const album = s.album || '';
    const artistId = 'ar-' + md5(artist);
    const albumId = 'al-' + md5(`${artist}\u0000${album}`);
    return {
      id: s.id,                       // tr-<md5(相对路径)>
      filePath: s.filePath,
      fileName: s.fileName,
      title: s.title,
      artist,
      album,
      genre: s.genre || null,
      year: s.year || null,
      track: s.track || null,
      size: s.size || 0,
      suffix: s.suffix,
      contentType: CONTENT_TYPES[s.suffix] || 'application/octet-stream',
      bitRate: DEFAULT_BITRATE[s.suffix] || 128,
      duration: s.duration || 0,
      artistId,
      albumId,
      coverArt: s.hasCover ? 'ca-' + md5(s.filePath) : null,
      hasCover: !!s.hasCover,
      coverRelpath: s.coverRelpath || null,
      coverHash: s.coverHash || null,
      coverSource: s.coverSource || 'none',
      lyricRaw: s.lyricRaw || null,
      lyricStruct: s.lyricStruct || null,
      lyricSource: s.lyricSource || 'none',
      strmFilePath: s.strmFilePath || null,
      folder: s.folder,
      isStrm: !!s.isStrm,
      realMediaUri: s.realMediaUri || null
    };
  });

  const artists = new Map();
  const albums = new Map();
  for (const song of songs) {
    let ar = artists.get(song.artist);
    if (!ar) {
      ar = { id: song.artistId, name: song.artist, albumIds: new Set(), coverArt: null };
      artists.set(song.artist, ar);
    }
    ar.albumIds.add(song.albumId);
    if (!ar.coverArt && song.coverArt) ar.coverArt = song.coverArt;

    const albumKey = `${song.artistId}::${song.album}`;
    let al = albums.get(albumKey);
    if (!al) {
      al = {
        id: song.albumId,
        name: song.album,
        artist: song.artist,
        artistId: song.artistId,
        year: song.year,
        genre: song.genre,
        coverArt: song.coverArt || null,
        songIds: [],
        created: Date.now()
      };
      albums.set(albumKey, al);
    }
    if (!al.coverArt && song.coverArt) al.coverArt = song.coverArt;
    if (!al.year && song.year) al.year = song.year;
    if (!al.genre && song.genre) al.genre = song.genre;
    al.songIds.push(song.id);
  }

  return {
    songs,
    artists: Array.from(artists.values()),
    albums: Array.from(albums.values())
  };
}

/** 获取本地音乐的 OpenSubsonic 索引（缓存：目录指纹变化时重建；扫描进行中不缓存空结果） */
function getOpenSubsonicLibrary() {
  if (scanProgress.scanning || state.dir === null) {
    return buildSubsonicIndex(); // 扫描中：直接构建（不命中缓存），避免把空列表缓存住
  }
  const sig = `${state.songs.length}:${state.dir || ''}:${state.sig}`;
  if (subIndexCache && sig === subIndexSig) return subIndexCache;
  subIndexCache = buildSubsonicIndex();
  subIndexSig = sig;
  return subIndexCache;
}

module.exports.getOpenSubsonicLibrary = getOpenSubsonicLibrary;
module.exports.getEmbeddedCover = getEmbeddedCover;

/** 同步触发本地音乐库（/app/music）重扫，并失效 OpenSubsonic 索引缓存（OpenSubsonic startScan 用） */
function rescanNow() {
  if (!fs.existsSync(MUSIC_DIR)) {
    try { fs.mkdirSync(MUSIC_DIR, { recursive: true }); } catch { /* 忽略 */ }
  }
  scan(MUSIC_DIR, 'manual');
  subIndexCache = null;
  return state;
}
module.exports.rescanNow = rescanNow;

/** 供后台定时任务使用的可等待扫描：触发一次增量扫描并等待完成（文档四-1 定时音乐扫描） */
async function scanLibraryNow() {
  if (!fs.existsSync(MUSIC_DIR)) {
    try { fs.mkdirSync(MUSIC_DIR, { recursive: true }); } catch { /* 忽略 */ }
  }
  await scan(MUSIC_DIR, 'scheduled');
  subIndexCache = null;
  return state;
}
module.exports.scanLibraryNow = scanLibraryNow;

// OpenSubsonic 请求分发用：懒加载扫描 / 目录变化自动感知（节流）
module.exports.ensureScanned = ensureScanned;
module.exports.ensureFresh = ensureFresh;
/** 等待开机 warm（DB 快载）完成后返回；随后首个请求若仍无数据再由 ensureScanned 触发 startup 扫描 */
module.exports.awaitWarmLoaded = function awaitWarmLoaded() {
  return warmLocalPromise || Promise.resolve();
};

// OpenSubsonic getIndexes 用：最近一次扫描时间
module.exports.getLastModified = () => state.lastModified;

/** OpenSubsonic getLyrics 数据库优先读取：先查内存（含扫描已入库数据），再回查数据库 */
async function fetchLocalLyric(id) {
  const song = (id && state.songs) ? state.songs.find((s) => s.id === id) : null;
  if (song && song.lyricRaw) {
    return { raw: song.lyricRaw, struct: song.lyricStruct || null, source: song.lyricSource || 'none' };
  }
  try {
    const row = await localLibraryDb.loadLyricForId(id);
    if (row && row.lyric_raw) {
      if (song) {
        song.lyricRaw = row.lyric_raw;
        song.lyricStruct = row.lyric_struct || null;
        song.lyricSource = row.lyric_source || 'none';
      }
      return { raw: row.lyric_raw, struct: row.lyric_struct || null, source: row.lyric_source || 'none' };
    }
  } catch { /* 数据库不可用忽略 */ }
  return null;
}
module.exports.fetchLocalLyric = fetchLocalLyric;
