'use strict';

// ==================== 本地音乐补全（封面 + 歌词）====================
// 本地音乐补全顺序：优先读取本地文件标签（内嵌封面 / ID3 USLT 歌词 / 同目录 .lrc），
// 本地标签缺失时才通过默认插件搜索匹配的网络版本获取封面与歌词。
// 结果按「标题|歌手」缓存：匹配成功 24 小时，未匹配 10 分钟。
//
// 被 local-music.js（/api/music/enrich）与 music.js（/api/lyrics）共同使用。

const fs = require('fs');
const path = require('path');
const NodeID3 = require('node-id3');
const ctx = require('./context');
const { getConfigSetting } = require('./config');
const { runPlugin, userConfigs, logger, createReqId } = ctx;
// 新阶段懒加载：把播放时补全结果落库为 track_cover_remote / 专辑封面。
// 图片下载改为「单歌曲流水线内部就地消费」（见 downloadAndBind，直接用 coverCache 下载转码），
// 不再投递全局内存队列（风险6：避免重启丢失悬空任务、避免 3000 首批量跑时内存堆积）。
const coverCache = require('./cover-cache');

// LOCAL-ENRICH 日志分两级：
//  - logSearch()：仅关键结论（最终结果 / 封面缓存命中），在播放按需补全与连通性测试
//    （trigger=play/test）时以 info 打印，其余场景为 debug，用于排查“为什么没补到封面/歌词”；
//  - 其余大量中间过程（逐插件命中、DB/缓存命中等）一律 logger.debug，避免刷屏。
// 全量/批量扫描回填（monitor/scan/manual 重扫）即使走 logSearch 也保持 debug。
const verboseReqIds = new Set();
function logSearch(reqId, msg, data) {
  if (verboseReqIds.has(reqId)) logger.info('LOCAL-ENRICH', reqId, msg, data || {});
  else logger.debug('LOCAL-ENRICH', reqId, msg, data || {});
}
function markVerboseReq(reqId, trigger) {
  const verbose = ['play', 'test'].includes(String(trigger || ''));
  if (verbose) {
    verboseReqIds.add(reqId);
    // 请求结束后延迟清理，避免 Set 无限膨胀（日志点都是同一次 reqId）
    const timer = setTimeout(() => verboseReqIds.delete(reqId), 5 * 60 * 1000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
}

// 已安装「歌词目录」插件名缓存（设置里可选择作为固定歌词搜索插件）
let lyricPluginNamesCache = null;
function lyricPluginNames() {
  if (lyricPluginNamesCache) return lyricPluginNamesCache;
  const set = new Set();
  try {
    const entries = fs.readdirSync(ctx.PLUGINS_DIR, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name !== '歌词') continue;
      let inner;
      try { inner = fs.readdirSync(path.join(ctx.PLUGINS_DIR, ent.name)); } catch { continue; }
      for (const f of inner) if (f.endsWith('.js')) set.add(f);
    }
  } catch { /* 忽略 */ }
  lyricPluginNamesCache = set;
  return set;
}

/** 按用户配置的顺序依次用指定插件搜索，返回首个命中 { plugin, matched } 或 null */
async function enrichWithConfiguredPlugins(pluginList, title, artist, reqId, includeLyrics) {
  const rid = reqId || createReqId();
  let bestMatched = null;
  let bestPlugin = null;
  let cover = null;
  let lyrics = null;
  for (const plugin of pluginList) {
    const isLyric = lyricPluginNames().has(plugin);
    const types = isLyric ? ['lyric', 'music'] : ['music', 'lyric'];
    let m = null;
    for (const type of types) {
      m = await searchMatchBy(plugin, title, artist, type, reqId, includeLyrics);
      if (m) break;
    }
    if (!m) continue;
    bestPlugin = plugin;
    bestMatched = m;
    if (!cover) {
      const c = extractCover(m);
      if (c) cover = c;
    }
    if (!includeLyrics) {
      // 封面模式：匹配到封面即停；只有匹配无封面则继续下一个插件找封面
      if (cover) break;
      continue;
    }
    // 歌词模式：该插件匹配成功后尝试取词；取到词即停，取不到则继续下一个配置的插件
    const l = await fetchLyrics(plugin, m, reqId);
    if (l && String(l).trim()) { lyrics = l; break; }
    logger.debug('LOCAL-ENRICH', rid, 'configured plugin matched but no lyrics, try next', { plugin });
  }
  return { matched: bestMatched, plugin: bestPlugin, cover, lyrics };
}

/** 读取“歌词/封面”插件配置列表：优先新数组键，兼容旧的单值键，最多 3 个 */
function resolveConfiguredPlugins(listKey, legacyKey) {
  let arr = getConfigSetting(listKey);
  if (!Array.isArray(arr)) arr = [];
  const list = arr.map((p) => String(p).trim()).filter(Boolean);
  if (!list.length && legacyKey) {
    const legacy = String(getConfigSetting(legacyKey) || '').trim();
    if (legacy) list.push(legacy);
  }
  return list.slice(0, 3);
}
// 本地封面持久化（SQLite）：插件搜索结果落库，重启后直接返回数据库里的封面，无需重复搜索。
// 该模块在无 sqlite3 环境（冒烟测试）下会自动降级为空实现。
const localLibraryDb = require('./local-library-db');
// LRC 歌词解析：插件补到的歌词写入数据库 lyric_raw/lyric_struct（用户磁盘源文件只读）
const lrcUtils = require('./lrc-utils');

// 结果缓存：key = title|artist -> { cover, lyrics, matched, ts }
const cache = new Map();
const TTL = 24 * 60 * 60 * 1000;
// 未匹配到（search 失败/无插件）时仅缓存 10 分钟，避免瞬时失败阻塞封面/歌词一整天
const MISS_TTL = 10 * 60 * 1000;
// 歌词「已尝试但未取到」的重试间隔：封面缓存不会阻塞歌词重试
const LYRIC_RETRY_MS = 10 * 60 * 1000;
// 封面「未取到」的短缓存：封面低频请求，空结果 2 分钟即可重试
const COVER_MISS_TTL = 2 * 60 * 1000;
// 搜索匹配最低分：低于该值视为“搜到的不是同一首歌”，继续试下一个插件，避免错误歌曲占位
const MIN_MATCH_SCORE = 20;

/** 从本地文件读取内嵌标签（封面 + ID3 USLT 歌词），并尝试同目录 .lrc 文件 */
function readLocalTags(filePath) {
  if (!filePath || typeof filePath !== 'string') return { cover: null, lyrics: null };
  let cover = null;
  let lyrics = null;
  try {
    const tags = NodeID3.read(filePath);
    if (tags) {
      if (tags.image && tags.image.imageBuffer) {
        const mime = tags.image.mime || tags.image.format || 'image/jpeg';
        cover = `data:${mime};base64,${tags.image.imageBuffer.toString('base64')}`;
      }
      const uslt = tags.unsynchronisedLyrics || tags.lyrics;
      if (uslt) {
        const items = Array.isArray(uslt) ? uslt : [uslt];
        for (const item of items) {
          const text = item && (item.text || item.lyrics);
          if (text) { lyrics = text; break; }
        }
      }
    }
  } catch {
    // 标签读取失败忽略
  }
  // 无内嵌歌词时尝试同目录 .lrc 文件
  if (!lyrics) {
    try {
      const lrcPath = filePath.replace(/\.[^.\\/]+$/, '') + '.lrc';
      if (fs.existsSync(lrcPath)) {
        lyrics = fs.readFileSync(lrcPath, 'utf8');
      }
    } catch {
      // 忽略
    }
  }
  return { cover, lyrics };
}

/** 由完整路径计算 rel_path（MUSIC_DIR 前缀裁掉）；不在音乐库内则返回 null */
function relPathFromFull(filePath) {
  if (!filePath) return null;
  const base = String(process.env.MUSIC_DIR || path.join(__dirname, '..', '..', 'music'))
    .replace(/\\/g, '/').replace(/\/+$/, '');
  const fp = String(filePath).replace(/\\/g, '/');
  if (fp.startsWith(base + '/')) return fp.slice(base.length + 1);
  return null;
}

/** 歌词持久化（数据库）：
 * 文档红线「用户原始文件只读」——程序不再往用户音乐目录写 .lrc，
 * 改为把插件补到的歌词写入 local_songs.lyric_raw / lyric_struct / lyric_source('network')。
 * 失败仅告警不影响本次返回。 */
function persistLocalLrc(filePath, lyrics, reqId) {
  if (!filePath || !lyrics) return;
  const relPath = relPathFromFull(filePath);
  if (!relPath) {
    logger.debug('LOCAL-ENRICH', reqId || 'local', 'skip lyric persist: file not under music root', { filePath });
    return;
  }
  const raw = String(lyrics);
  localLibraryDb.updateLyricsForRelPath(relPath, {
    raw,
    struct: JSON.stringify(lrcUtils.parseLrcStruct(raw)),
    source: 'network'
  }).catch((err) => {
    logger.warn('LOCAL-ENRICH', reqId || 'local', 'persist lyric to DB failed', { relPath, error: err && err.message });
  });
  logger.debug('LOCAL-ENRICH', reqId || 'local', 'lyrics saved to database', { relPath, length: raw.length });
}

/** 从搜索结果中提取歌手名（兼容字符串与数组） */
function extractArtist(song) {
  if (!song) return '';
  if (Array.isArray(song.artist)) {
    return song.artist.map((a) => (a && a.name) || a || '').join(', ');
  }
  return song.artist || song.singer || '';
}

/** 从搜索结果中提取封面 URL（清洗反引号，仅保留 http 链接） */
function extractCover(song) {
  if (!song) return null;
  for (const key of ['artwork', 'albumCover', 'cover', 'coverUrl', 'picUrl', 'pic', 'albumArt', 'image']) {
    const v = song[key];
    if (v && typeof v === 'string' && /^https?:\/\//.test(v)) {
      const cleaned = v.replace(/`/g, '').trim();
      if (cleaned) return cleaned;
    }
  }
  return null;
}

/** 从插件 getLyric 返回值中提取纯歌词文本 */
function extractLyrics(data) {
  if (!data) return null;
  if (typeof data === 'string') return data;
  return data.rawLrc || data.lyrics || data.lrc || null;
}

/** 从搜索结果条目提取“搜索阶段已内嵌的歌词”（碳酸歌词酷狗源会把整首 LRC 放进 rawLrcTxt） */
function extractEmbeddedLyrics(item) {
  if (!item) return '';
  const raw = typeof item === 'string' ? item : (item.rawLrcTxt || item.rawLrc || item.lyrics || item.lrc);
  return (raw && typeof raw === 'string' && raw.trim()) ? raw : '';
}

/** 从搜索结果中提取时长（秒；兼容 durationMs / 数字字符串，非法返回 0） */
function extractDuration(song) {
  if (!song) return 0;
  let sec = 0;
  if (typeof song.duration === 'number') sec = song.duration;
  else if (typeof song.duration === 'string' && song.duration.trim()) sec = parseFloat(song.duration);
  else if (typeof song.durationMs === 'number') sec = song.durationMs / 1000;
  if (!sec || !isFinite(sec) || sec <= 0) return 0;
  return Math.max(1, Math.round(sec));
}

/** 从搜索结果中提取专辑名（兼容各插件字段名；"未知专辑"等占位视为无） */
function extractAlbum(song) {
  if (!song) return '';
  const candidates = ['album', 'albumName', 'albumname', 'albumTitle', 'album_name', 'album_id', 'albumId', 'from'];
  for (const key of candidates) {
    const v = song[key];
    if (typeof v === 'string') {
      const t = v.trim();
      if (t && t !== '未知专辑' && t !== '未知') return t;
    }
  }
  return '';
}

/** 匹配得分：标题相同 +30，歌手相同 +20，近似匹配降级 */
function matchScore(candidate, title, artist) {
  let score = 0;
  const cTitle = String(candidate.title || candidate.songname || candidate.name || '').trim().toLowerCase();
  const t = title.toLowerCase();
  const cArtist = extractArtist(candidate).toLowerCase();
  const a = (artist || '').toLowerCase();

  if (cTitle && (cTitle === t || cTitle === t.replace(/\s+/g, ''))) score += 30;
  else if (cTitle && (cTitle.includes(t) || t.includes(cTitle))) score += 10;

  if (a && cArtist) {
    if (cArtist === a || cArtist.replace(/\s+/g, '') === a.replace(/\s+/g, '')) score += 20;
    else if (cArtist.includes(a) || a.includes(cArtist)) score += 8;
    else {
      // 用户输入了歌手，但候选歌手与其完全不相关：视为不匹配（返回 0），
      // 避免「歌名相同但歌手错误」的误命中（如「安妮 王杰」匹配到麻园诗人的《安妮》）。
      return 0;
    }
  }
  return score;
}

/** 通过指定插件搜索，返回最佳匹配的网络歌曲（未匹配到返回 null） */
async function searchMatchBy(plugin, title, artist, type, reqId, includeLyrics) {
  if (!plugin) return null;
  // 日志前缀：仅识别歌曲（拿封面/专辑/时长，includeLyrics=false）时不应写成“歌词搜索”，
  // 避免误以为在抓词；真正取词时（includeLyrics=true）才用“歌词搜索”。
  const tag = includeLyrics ? '歌词搜索' : '歌曲识别';
  const rid = reqId || createReqId();
  const userVars = userConfigs.default || {};
  // 多歌手常用 _ 分隔，转空格提高召回（如 "范文芳_张信哲" → "范文芳 张信哲"）
  const query = `${title} ${artist}`.trim().replace(/_/g, ' ') || title;
  try {
    const result = await runPlugin(plugin, 'search', [query, 1, type], userVars, ctx.PLUGINS_DIR);
    const list = Array.isArray(result) ? result : (result && Array.isArray(result.data) ? result.data : []);
    if (!list.length) {
      logger.debug('LOCAL-ENRICH', rid, `${tag}无结果`, { plugin, query, results: 0 });
      return null;
    }
    let best = null;
    let bestScore = 0;
    for (const item of list) {
      if (!item || typeof item !== 'object' || item.id == null) continue;
      const score = matchScore(item, title, artist);
      // 同分时优先选择“搜索阶段已内嵌歌词”的条目（如碳酸歌词酷狗源），提高直接取词命中
      const better = score > bestScore
        || (score === bestScore && best && extractEmbeddedLyrics(item) && !extractEmbeddedLyrics(best));
      if (better) {
        bestScore = score;
        best = item;
      }
    }
    if (best && bestScore >= MIN_MATCH_SCORE) {
      logger.debug('LOCAL-ENRICH', rid, `${tag}命中`, {
        plugin, query, score: bestScore,
        hit: { title: best.title || best.songname || '', artist: extractArtist(best), album: extractAlbum(best) }
      });
      return best;
    }
    logger.debug('LOCAL-ENRICH', rid, `${tag}匹配分不足，继续下一插件`, { plugin, query, topScore: bestScore, results: list.length });
    return null;
  } catch (err) {
    logger.warn('LOCAL-ENRICH', rid, `${tag}失败`, { plugin, query, error: err.message });
    return null;
  }
}

/** 获取匹配歌曲的歌词 */
async function fetchLyrics(plugin, song, reqId) {
  if (!plugin || !song) return null;
  const rid = reqId || createReqId();
  const songName = String(song.title || song.songname || '');
  const artistName = extractArtist(song);

  // 优先使用搜索结果条目里“已内嵌的歌词”（碳酸歌词的酷狗源在 search 阶段就下载好整首 LRC，
  // 直接取，无需再发 getLyric 网络请求，也避免 getLyric 平台接口故障导致丢失歌词）
  const embedded = extractEmbeddedLyrics(song);
  if (embedded) {
    logger.debug('LOCAL-ENRICH', rid, `歌词 | 歌名《${songName}》 歌手《${artistName}》 | 插件：${plugin} | 已获取（search 内嵌 ${embedded.length} 字）`);
    return embedded;
  }

  const userVars = userConfigs.default || {};
  try {
    const result = await runPlugin(plugin, 'getLyric', [song], userVars, ctx.PLUGINS_DIR);
    const lyrics = (result && result.success !== false) ? extractLyrics(result.data) : null;
    logger.debug('LOCAL-ENRICH', rid, `歌词 | 歌名《${songName}》 歌手《${artistName}》 | 插件：${plugin} | ${lyrics ? `已获取（${lyrics.length} 字）` : '未收到'}`);
    return lyrics;
  } catch (err) {
    logger.warn('LOCAL-ENRICH', rid, `歌词 | 歌名《${songName}》 歌手《${artistName}》 | 插件：${plugin} | 获取异常`, { error: err.message });
    return null;
  }
}

/**
 * 为本地音乐补全封面与歌词
 * @param {Object} music 本地歌曲（至少含 title）
 * @param {Object} [opts] 选项：includeLyrics=false 时跳过歌词抓取（如扫描期只需封面/专辑）
 * @returns {Promise<{cover: string|null, lyrics: string|null, matched: Object|null}>}
 */
async function enrichLocalMusic(music, opts = {}) {
  const includeLyrics = opts.includeLyrics !== false; // 默认抓取歌词
  const title = String((music && music.title) || '').trim();
  if (!title) return { cover: null, lyrics: null, matched: null };
  const artist = String((music && music.artist) || '').trim();
  const filePath = music && music.filePath ? String(music.filePath) : null;
  const reqId = createReqId();
  markVerboseReq(reqId, opts.trigger);

  // 新阶段懒加载兜底：本地歌曲在播放/补全命中 raw_parsed / meta_failed（批量扫描未覆盖到）时，
  // 异步补写 track_cover_remote + 专辑封面并投递 remote_image_cache worker；与批量阶段1行为一致，
  // 带负缓存防切歌轰炸插件。fire-and-forget，绝不阻塞音频（用户看到的是旧兜底封面，后台静默补全）。
  if (music && (music.relPath || (music.id && String(music.id).startsWith('tr-'))) && opts.trigger !== 'bulk') {
    const lazyRel = music.relPath ? String(music.relPath) : (music.filePath ? relPathFromFull(music.filePath) : null);
    if (lazyRel) lazyFillTrackMeta(lazyRel).catch(() => {});
  }

  // 1. 优先读取本地文件标签（内嵌封面 / ID3 USLT 歌词 / 同目录 .lrc），避免走插件搜索。
  //    注意：请求歌词（includeLyrics=true）时只有真正拿到本地歌词才算命中；
  //    仅内嵌封面存在不能拦住歌词搜索（否则"有封面无歌词"的文件永远不会搜索到歌词）。
  if (filePath) {
    const localTags = readLocalTags(filePath);
    const localReady = includeLyrics ? !!localTags.lyrics : !!localTags.cover;
    if (localReady) {
      logger.debug('LOCAL-ENRICH', reqId, 'local file tags found, skip plugin search', {
        title, artist, filePath,
        hasCover: !!localTags.cover,
        hasLyrics: !!localTags.lyrics
      });
      return { cover: localTags.cover, lyrics: localTags.lyrics, matched: null, fromLocal: true };
    }
    logger.debug('LOCAL-ENRICH', reqId, 'no local file tags, fallback to plugin search', { title, artist, filePath });
  }

  // 1.5 数据库已持久化内容命中：之前补全的歌词/封面已写入 local_songs，
  //     重启后内存缓存虽空也不应重复联网搜索。命中即返回。
  if (filePath || (music && music.id && String(music.id).startsWith('tr-'))) {
    try {
      const relPath = filePath ? relPathFromFull(filePath) : null;
      let row = null;
      if (relPath) {
        row = await localLibraryDb.loadLocalSongByRelPath(relPath);
      } else if (music && music.id) {
        row = await localLibraryDb.loadLyricForId(String(music.id));
      }
      if (row) {
        const dbLyric = (row.lyric_raw && String(row.lyric_raw).trim()) ? String(row.lyric_raw) : null;
        if (includeLyrics && dbLyric) {
          logger.debug('LOCAL-ENRICH', reqId, 'db lyric hit, skip plugin search', { title, artist, relPath });
          return { cover: null, lyrics: dbLyric, matched: null, fromLocal: true };
        }
        const hasRowAlbum = !!String(row.album || '').trim();
        const rowDur = Number(row.duration) > 0;
        if (!includeLyrics && row.cover_relpath && hasRowAlbum && rowDur) {
          // 封面 WebP / 专辑 / 时长均已持久化：无需再联网（URL 由调用方按 coverRelpath 静态提供）
          logger.debug('LOCAL-ENRICH', reqId, 'db cover hit, skip plugin search', { title, artist, relPath });
          return { cover: null, lyrics: null, matched: null, fromLocal: true };
        }
      }
    } catch { /* 数据库不可用则忽略，继续走插件逻辑 */ }
  }

  // 2. 插件搜索补全
  //    封面/匹配结果可长缓存；歌词单独跟踪“尝试时间”，没取到词会定期重试。
  //    缓存附带“本次所用插件配置”：换插件（含测试强制指定不同插件）即视为不同请求，
  //    立即用新插件重搜，不再被旧的 miss 缓存/10 分钟重试窗挡住。
  const forced = Array.isArray(opts.forcePlugins)
    ? opts.forcePlugins.map((p) => String(p).trim()).filter(Boolean).slice(0, 3)
    : [];
  const lyricPlugins = forced.length ? forced : resolveConfiguredPlugins('lyric_plugins', 'lyric_plugin');
  const coverPlugins = forced.length ? forced : resolveConfiguredPlugins('cover_plugins', '');
  // 严格分离：封面/专辑只用「封面搜索插件」(cover_plugins)，歌词只用「歌词搜索插件」(lyric_plugins)，
  // 两类互不回退、也不借用默认插件。未配置对应插件则不搜索该部分（绝不遍历全部插件）。
  const cfgKey = `cover=${coverPlugins.join('|')}|lyric=${lyricPlugins.join('|')}`;

  const key = `${title.toLowerCase()}|${artist.toLowerCase()}`;
  const nowTs = Date.now();
  // 连通性测试（trigger:'test'）绕过缓存，强制真实走一遍插件，验证当前是否可用；
  // 否则会直接命中上次缓存，看不到真实的插件调用与结果。
  let cached = cache.get(key);
  if (opts.ignoreCache) cached = null;
  const cfgChanged = cached && cached.cfgKey !== undefined && cached.cfgKey !== cfgKey;
  const fresh = cached && !cfgChanged && (nowTs - cached.ts < (cached.ttl || MISS_TTL));

  if (!includeLyrics) {
    if (fresh) {
      logSearch(reqId, 'cache hit (cover)', { title, artist, cfgKey, hasCover: !!cached.cover });
      return { cover: cached.cover, lyrics: null, matched: cached.matched };
    }
    if (cfgChanged) {
      logger.debug('LOCAL-ENRICH', reqId, 'cover cache ignored, plugin config changed', { title, artist, old: cached && cached.cfgKey, cur: cfgKey });
    }
  } else if (fresh && cached.lyrics) {
    logger.debug('LOCAL-ENRICH', reqId, 'cache hit (lyrics)', { title, artist, cfgKey, hasCover: !!cached.cover, hasLyrics: true });
    // 缓存命中且有本地文件路径时也把歌词写入数据库（用户磁盘源文件只读，不再补写 .lrc）
    if (filePath) persistLocalLrc(filePath, cached.lyrics, reqId);
    return { cover: cached.cover, lyrics: cached.lyrics, matched: cached.matched };
  } else {
    // 手动指定插件（测试工具）时不受重试窗限制，方便反复对比
    const recentlyTried = !cfgChanged && !forced.length && cached && cached.lyricTriedAt && (nowTs - cached.lyricTriedAt < LYRIC_RETRY_MS);
    if (recentlyTried) {
      logger.debug('LOCAL-ENRICH', reqId, 'lyrics recent miss, skip retry', { title, artist, cfgKey, hasCover: !!cached.cover, hasLyrics: false });
      return { cover: cached.cover, lyrics: null, matched: cached.matched };
    }
    if (cfgChanged) {
      logger.debug('LOCAL-ENRICH', reqId, 'lyrics cache ignored, plugin config changed, retry current plugins', { title, artist, old: cached && cached.cfgKey, cur: cfgKey });
    } else if (fresh) {
      logger.debug('LOCAL-ENRICH', reqId, 'cover cached, retrying lyrics', { title, artist, hasCover: !!cached.cover });
    }
  }
  // 严格分离搜索：封面/专辑走 coverPlugins（专辑名/封面），歌词走 lyricPlugins，各自独立互不干扰。
  let coverMatched = null, coverPlugin = null, preCover = null;
  let lyricMatched = null, lyricPlugin = null, preLyrics = null;

  if (coverPlugins.length) {
    const res = await enrichWithConfiguredPlugins(coverPlugins, title, artist, reqId, false);
    preCover = res.cover;
    coverMatched = res.matched;
    coverPlugin = res.plugin;
    // 注：不再做「去掉歌手只用歌名重试」的兜底。用户输入了歌手就严格按歌手匹配，
    // 匹配不到（或歌手不符）即视为无封面，避免退回纯歌名误命中「歌名相同但歌手错误」的版本。
  } else {
    logger.debug('LOCAL-ENRICH', reqId, 'no cover plugin configured, skip cover search', { title, artist });
  }

  if (includeLyrics) {
    if (lyricPlugins.length) {
      const res = await enrichWithConfiguredPlugins(lyricPlugins, title, artist, reqId, true);
      preLyrics = res.lyrics;
      lyricMatched = res.matched;
      lyricPlugin = res.plugin;
    } else {
      logger.debug('LOCAL-ENRICH', reqId, 'no lyric plugin configured, skip lyric search', { title, artist });
    }
  }

  const matched = coverMatched || lyricMatched || null;
  const cover = preCover !== null ? preCover : (coverMatched ? extractCover(coverMatched) : null);
  const lyrics = preLyrics; // 未配置歌词搜索插件则为 null（严格不回退到封面/默认插件）
  const matchedAlbum = matched ? extractAlbum(matched) : '';
  const coverState = cover
    ? `搜到 ${cover}`
    : (coverPlugins.length ? '未搜到' : '未配置封面插件，跳过');
  const lyricState = !includeLyrics
    ? '本阶段不抓取（播放时按需补全）'
    : (lyrics ? '搜到' : (lyricPlugins.length ? '未搜到' : '未配置歌词插件，跳过'));
  logger.debug('LOCAL-ENRICH', reqId, `【搜索阶段】歌曲《${title}》歌手《${artist || '-'}》→ 专辑《${matchedAlbum || '-'}》 | 封面:${coverState} | 歌词:${lyricState} | 使用插件 封面:[${coverPlugins.join(',') || '无'}] 歌词:[${includeLyrics ? (lyricPlugins.join(',') || '无') : '-'}]`, {
    trigger: opts.trigger || 'unknown',
    title, artist,
    coverPluginsTried: coverPlugins.length ? coverPlugins : [],
    lyricPluginsTried: (includeLyrics && lyricPlugins.length) ? lyricPlugins : [],
    coverPluginUsed: coverPlugin || (coverPlugins.length ? null : 'NONE (未配置封面搜索插件)'),
    lyricPluginUsed: lyricPlugin || (lyricPlugins.length ? null : (includeLyrics ? 'NONE (未配置歌词搜索插件)' : null)),
    matchedHit: matched ? {
      title: matched.title || matched.songname || '',
      artist: extractArtist(matched),
      album: extractAlbum(matched)
    } : null,
    result: {
      matched: !!matched,
      hasCover: !!cover,
      hasLyrics: !!lyrics,
      coverSource: cover ? 'remote' : null,
      lyricSource: lyrics ? 'remote' : null
    }
  });

  // 落缓存：封面信息按 TTL 长存，无词但尝试过会按 LYRIC_RETRY_MS 定时重试。
  // 配置变化时不再回填旧配置的结果，确保新配置立即生效。
  const mergedCover = cover || (!cfgChanged && cached && cached.cover) || null;
  const mergedMatched = matched || (!cfgChanged && cached && cached.matched) || null;
  const mergedLyrics = lyrics || (!cfgChanged && cached && cached.lyrics) || null;
  const ttl = (mergedCover || mergedLyrics)
    ? TTL
    : (includeLyrics ? MISS_TTL : COVER_MISS_TTL);
  cache.set(key, {
    cfgKey,
    cover: mergedCover,
    matched: mergedMatched,
    plugin: coverPlugin || lyricPlugin || (!cfgChanged && cached && cached.plugin) || null,
    lyrics: mergedLyrics,
    lyricTriedAt: includeLyrics ? nowTs : (!cfgChanged && cached && cached.lyricTriedAt) || 0,
    ttl,
    ts: nowTs
  });
  // 防内存膨胀：清理过期项
  if (cache.size > 200) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.ts > (v.ttl || MISS_TTL)) cache.delete(k);
    }
  }

  // 本地音乐：本次从插件搜索到歌词（且非本地内嵌标签来源）时写入数据库 lyric_raw/lyric_struct，
  // 下次播放/OpenSubsonic getLyrics 直接读库（strm 无内嵌能力，靠 DB 落地；用户磁盘源文件只读）。
  if (includeLyrics && filePath && mergedLyrics) {
    persistLocalLrc(filePath, mergedLyrics, reqId);
  }

  return { cover: mergedCover, lyrics: mergedLyrics, matched: mergedMatched };
}

// ==================== 歌手/专辑图片搜索 ====================

// 图片结果缓存：key -> { url, ts }
const artistImageCache = new Map();
const albumImageCache = new Map();

/** 从搜索结果对象中提取图片 URL（兼容字符串与 {url} 对象，清洗反引号） */
function extractImage(obj) {
  if (!obj) return null;
  for (const key of ['artistPic', 'avatar', 'picUrl', 'pic', 'cover', 'coverUrl', 'artwork', 'image', 'img', 'albumArt']) {
    const v = obj[key];
    if (!v) continue;
    if (typeof v === 'string' && /^https?:\/\//.test(v)) {
      const cleaned = v.replace(/`/g, '').trim();
      if (cleaned) return cleaned;
    } else if (typeof v === 'object' && v.url && typeof v.url === 'string' && /^https?:\/\//.test(v.url)) {
      const cleaned = v.url.replace(/`/g, '').trim();
      if (cleaned) return cleaned;
    }
  }
  return null;
}

/** 执行一次插件搜索并返回结果数组（默认严格使用「封面搜索插件」配置；可显式指定插件列表）
 * @param {string} [pluginsArg] 可选：传入数组则只用这些插件（连通性测试指定单插件时使用） */
async function searchList(query, type, pluginsArg) {
  const forced = Array.isArray(pluginsArg) && pluginsArg.length ? pluginsArg : null;
  let plugins;
  if (forced) {
    plugins = forced;
  } else if (type === 'artist') {
    // 歌手头像严格使用「歌手头像搜索插件」配置；未配置则不搜（空白），不复用封面搜索插件。
    const artistCfg = resolveConfiguredPlugins('artist_image_plugins', '');
    plugins = artistCfg;
    logger.debug('LOCAL-ENRICH', 'artist-img', 'artist image plugins resolved', {
      source: forced ? 'forced' : (artistCfg.length ? 'artist_image_plugins' : 'none'),
      plugins: plugins.join(',') || '(none)',
      query
    });
  } else {
    // 封面/专辑图严格使用「封面搜索插件」配置。
    plugins = resolveConfiguredPlugins('cover_plugins', '');
  }
  if (!plugins.length || !query) return [];
  const userVars = userConfigs.default || {};
  for (const plugin of plugins) {
    try {
      const result = await runPlugin(plugin, 'search', [query, 1, type], userVars, ctx.PLUGINS_DIR);
      const list = Array.isArray(result) ? result : (result && Array.isArray(result.data) ? result.data : []);
      const filtered = list.filter((it) => it && typeof it === 'object').map((it) => ({ ...it, _plugin: plugin }));
      if (filtered.length) {
        logger.debug('LOCAL-ENRICH', createReqId(), '搜索命中', { type, plugin, query, results: filtered.length });
        return filtered;
      }
    } catch (err) {
      logger.warn('LOCAL-ENRICH', createReqId(), `${type} search failed`, { plugin, error: err.message, query });
    }
  }
  return [];
}

/**
 * 获取歌手图片（只用品歌手名搜索歌手实体 type='artist'，绝不回退到歌曲封面）
 * @param {string} name 歌手名
 * @param {Object} [opts] { forcePlugins?: string[], ignoreCache?: boolean } —— 连通性测试支持指定单插件 + 绕过缓存
 * @returns {Promise<string|null>}
 */
async function fetchArtistImage(name, opts = {}) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  const forced = Array.isArray(opts.forcePlugins) && opts.forcePlugins.length ? opts.forcePlugins : null;
  // 缓存键区分指定插件与默认配置（歌手头像优先 artist_image_plugins，未配置则不搜、不留 cover 回退键），
  // 避免测试命中污染常规使用的主缓存，也保证切换配置后重新搜索。
  let cfgSlot = '';
  if (forced) cfgSlot = forced.join(',');
  else {
    const aCfg = resolveConfiguredPlugins('artist_image_plugins', '');
    cfgSlot = aCfg.length ? aCfg.join(',') : '(none)';
  }
  const cacheKey = key + (cfgSlot ? '@' + cfgSlot : '');
  if (!opts.ignoreCache) {
    const cached = artistImageCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < TTL) return cached.url;
  }

  // 注：封面不再单独建表持久化，仅运行时内存缓存 + 插件搜索（重启后首查会重新搜索）
  let url = null;
  let usedPlugin = null;
  // 只用品歌手名搜索歌手实体（type='artist'）；不加入歌名/专辑，避免用歌曲封面冒充头像
  const artistList = await searchList(name, 'artist', forced);
  for (const it of artistList) {
    const img = extractImage(it);
    if (img) { url = img; usedPlugin = it._plugin || null; break; }
  }
  logger.debug('LOCAL-ENRICH', createReqId(), `歌手头像 | 歌手《${name}》 | 插件：${usedPlugin || cfgSlot || '未收到'} | 头像地址：${url || '未收到'}`);

  artistImageCache.set(cacheKey, { url, ts: Date.now() });
  return url;
}

/**
 * 搜索专辑条目并返回其真实封面 URL（search type='album'）。
 * 与 fetchArtistImage 同源策略：默认用「封面搜索插件」配置；未配置时退回默认插件。
 * 专辑搜索通常返回 { title(专辑名), artist, artwork/pic/cover } 形态条目，
 * 取「专辑名与目标相近且带封面图」的第一条，避免拿错别专辑的封面。
 * @param {string} album 专辑名
 * @param {string} [artist] 歌手名（帮助定位同名专辑）
 * @param {Object} [opts] { forcePlugins?: string[] }
 * @returns {Promise<string|null>} 专辑封面 http(s) URL 或 null
 */
async function searchAlbumCover(album, artist, opts = {}) {
  const name = String(album || '').trim();
  if (!name) return { url: null, plugin: null, plugins: [] };
  const nameL = name.toLowerCase();
  const queries = [];
  const withArtist = `${name} ${artist || ''}`.trim().replace(/_/g, ' ');
  if (withArtist && withArtist !== name) queries.push(withArtist);
  queries.push(name);
  const forced = Array.isArray(opts.forcePlugins)
    ? opts.forcePlugins.map((p) => String(p).trim()).filter(Boolean).slice(0, 3)
    : [];
  const plugins = forced.length ? forced : resolveConfiguredPlugins('cover_plugins', '');
  if (!plugins.length) return { url: null, plugin: null, plugins }; // 未配置封面搜索插件则不搜（严格不回退默认插件）
  const userVars = userConfigs.default || {};

  for (const query of queries) {
    for (const plugin of plugins) {
      let list = [];
      try {
        const result = await runPlugin(plugin, 'search', [query, 1, 'album'], userVars, ctx.PLUGINS_DIR);
        list = Array.isArray(result) ? result : (result && Array.isArray(result.data) ? result.data : []);
      } catch (err) {
        logger.warn('LOCAL-ENRICH', createReqId(), `album search failed`, { plugin, query, error: err.message });
        continue;
      }
      if (!list.length) continue;
      // 优先专辑名相近的条目；都没有明显相近时取第一条有封面的
      let fallback = null;
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const img = extractImage(item) || extractCover(item);
        if (!img) continue;
        if (!fallback) fallback = img;
        const title = String(item.title || item.name || '').trim().toLowerCase();
        if (title && (title === nameL || title.includes(nameL) || nameL.includes(title))) {
          logger.debug('LOCAL-ENRICH', createReqId(), '专辑封面搜索命中', { plugin, query, albumCoverUrl: img });
          return { url: img, plugin, plugins };
        }
      }
      if (fallback) {
        logger.debug('LOCAL-ENRICH', createReqId(), '专辑封面搜索命中（无相近条目，取首个有图项）', { plugin, query, albumCoverUrl: fallback });
        return { url: fallback, plugin, plugins };
      }
    }
  }
  logger.debug('LOCAL-ENRICH', createReqId(), '专辑封面搜索无结果', { album: name, artist: artist || null });
  return { url: null, plugin: null, plugins };
}

/**
 * 获取专辑封面图片：优先本地已持久化缓存命中则返回；否则用配置的封面插件做一次
 * 「专辑搜索（type='album'）」拿真实专辑封面，结果仅内存缓存（24h），不落库。
 * @param {string} name 专辑名
 * @param {string} [artist] 歌手名
 * @param {Object} [opts] { forcePlugins?: string[], ignoreCache?: boolean }
 * @returns {Promise<string|null>}
 */
async function fetchAlbumImage(name, artist, opts = {}) {
  const key = `${String(name || '').trim().toLowerCase()}|${String(artist || '').trim().toLowerCase()}`;
  if (!key) return null;
  const cached = albumImageCache.get(key);
  if (!opts.ignoreCache && cached && Date.now() - cached.ts < (cached.ttl || TTL)) return cached.url;

  const res = await searchAlbumCover(name, artist, { forcePlugins: opts.forcePlugins });
  const url = (res && res.url) || null;
  // 命中时 24h 缓存；未命中短缓存（2 分钟），避免空结果把“该专辑搜不到封面”记一天
  albumImageCache.set(key, { url, ts: Date.now(), ttl: url ? TTL : COVER_MISS_TTL });
  return url;
}

/**
 * 从搜索结果中提取「专辑封面」URL（兼容多种插件返回格式；取不到返回 null）。
 * 优先从嵌套 album 对象取，其次从 albumCover/albumArt/album_cover 等扁平字段取。
 * 兜底：插件未提供独立专辑封面字段时，取同一匹配条目的歌曲封面——酷我/QQ/咪咕等源的
 * 封面本就是该歌曲所属专辑的封面（同一实体，非「拿别的歌的封面冒充」，不违反隔离原则）。
 * 若无此兜底，这类源的专辑封面恒为 null → local_albums.album_cover_remote 全空、专辑列表空白。
 * @param {Object} song 歌曲搜索结果条目
 * @returns {string|null}
 */
function extractAlbumCover(song) {
  if (!song) return null;
  const al = (song.album && typeof song.album === 'object') ? song.album : null;
  if (al) {
    const c = extractCover(al)
      || (al.cover ? extractCover({ cover: al.cover }) : null)
      || (typeof al.picUrl === 'string' ? al.picUrl : null)
      || (typeof al.coverUrl === 'string' ? al.coverUrl : null);
    if (c && /^https?:\/\//.test(c)) return c.replace(/`/g, '').trim();
  }
  for (const key of ['albumCover', 'albumCoverUrl', 'albumArt', 'album_cover', 'albumPic', 'albumcover']) {
    const v = song[key];
    if (!v) continue;
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v.replace(/`/g, '').trim();
    if (typeof v === 'object' && v.url && /^https?:\/\//.test(v.url)) return String(v.url).replace(/`/g, '').trim();
  }
  // 禁令：绝不 fallback 到单曲封面（extractCover）冒充专辑封面。
  // 插件未提供独立专辑封面字段时一律返回 null，专辑封面只能由 Step3 用「歌手+专辑名」搜 type='album' 获得。
  return null;
}

/**
 * 阶段1（歌曲元采集）：仅调用一次「歌曲搜索插件链」，同时返回歌曲封面与专辑封面远程 URL。
 * 不再单独调用专辑搜索接口（取消独立专辑搜索调用）。
 * 取不到值直接置 null（业务约束：插件返回 null 就存 null，绝不编造 / 绝不拿歌曲封面顶替专辑）。
 * @param {string} title 歌曲名
 * @param {string} [artist] 歌手名（提高召回与匹配精度）
 * @returns {Promise<{trackCoverRemote:string|null, albumCoverRemote:string|null, matched:Object|null}>}
 */
async function fetchTrackMeta(title, artist) {
  const t = String(title || '').trim();
  const a = String(artist || '').trim();
  if (!t) return { trackCoverRemote: null, albumName: null, matched: null, plugin: null, plugins: [] };
  const coverPlugins = resolveConfiguredPlugins('cover_plugins', '');
  if (!coverPlugins.length) {
    logger.debug('LOCAL-ENRICH', 'track-meta', 'no cover plugin configured, skip', { title: t, artist: a });
    return { trackCoverRemote: null, albumName: null, matched: null, plugin: null, plugins: [] };
  }
  const rid = createReqId();
  for (const plugin of coverPlugins) {
    const m = await searchMatchBy(plugin, t, a, 'music', rid, false);
    if (m) {
      const trackCoverUrl = extractCover(m);
      const albumName = extractAlbum(m);
      // 禁令：这里只取「单曲封面」与「专辑名」，绝不再提取/返回 albumCoverRemote。
      // 专辑封面必须由 Step3 用「歌手+专辑名」搜 type='album' 独立获得，拿单曲封面冒充是明令禁止的。
      logger.debug('LOCAL-ENRICH', rid, '链接提取：单曲封面（专辑封面由独立接口按歌手+专辑名搜索）', {
        plugin, plugins: coverPlugins.join(','), title: t, artist: a,
        trackCoverUrl: trackCoverUrl || null,
        albumName: albumName || null
      });
      return {
        trackCoverRemote: trackCoverUrl,
        albumName,
        matched: m,
        plugin,
        plugins: coverPlugins
      };
    }
  }
  logger.debug('LOCAL-ENRICH', rid, '歌曲识别无结果（全部插件未命中）', { title: t, artist: a, plugins: coverPlugins.join(',') });
  return { trackCoverRemote: null, albumName: null, matched: null, plugin: null, plugins: coverPlugins };
}

/**
 * 下载远程图片并就地绑定到业务表（风险6：单歌曲流水线内部就地消费，无全局内存队列）。
 * 直接在本地下载 → 计算 content_md5 → 转 WebP 落盘（cover/ 或 art/），成功后回调绑定。
 * 整条链路由单曲流水线的并发（上限 3）自然限流，图片任务不会在跨歌曲全局缓冲区堆积。
 * @param {string} url 远程图片 URL（临时链接）
 * @param {'cover'|'artist'} kind 决定落盘子目录（cover/ 或 art/）
 * @param {(relpath:string, hash:string)=>Promise<void>} bind 成功后的落库绑定（自带仅填空守卫）
 */
async function downloadAndBind(url, kind, bind) {
  if (!url || typeof bind !== 'function') return;
  try {
    const buf = await coverCache.fetchRemoteImageBuffer(url);
    if (!buf || !buf.length) {
      logger.warn('LOCAL-ENRICH', 'bind', '图片下载失败：内容为空', { kind, url });
      return;
    }
    // kind 决定落盘子目录：artist → art/，其余 → cover/（歌手头像展示链路按 art/ 前缀过滤）
    const proc = await coverCache.processCoverBuffer(buf, kind === 'artist' ? 'art' : 'cover');
    if (!proc || !proc.ok) {
      logger.warn('LOCAL-ENRICH', 'bind', '图片下载失败：转码异常', { kind, url });
      return;
    }
    await bind(proc.relpath, proc.hash);
  } catch (e) {
    logger.warn('LOCAL-ENRICH', 'bind', 'download bind failed', { url, error: e && e.message });
  }
}

/**
 * 播放时懒加载兜底（批量扫描的兜底，不替代批量流水线）：
 * 本地歌曲在播放/补全命中 raw_parsed / meta_failed 且未「not_found 负缓存」时，异步搜索
 * 插件 → 直接投递下载并把本地路径绑定到歌曲封面/专辑封面（纯内存方案，URL 不落业务表）。
 * 带负缓存（meta_lazy_status / meta_lazy_retry_at）防切歌轰炸插件。
 * 全程不抛出、不阻塞音频（由调用方 fire-and-forget）。
 * @param {string} relPath 歌曲相对路径（local_songs.rel_path）
 */
const LAZY_RETRY_MS = 60 * 60 * 1000; // 懒加载未命中负缓存窗口：1 小时
async function lazyFillTrackMeta(relPath) {
  if (!relPath) return;
  const rp = String(relPath);
  let state;
  try { state = await localLibraryDb.getLazyMetaState(rp); } catch { return; }
  if (!state) return;
  if (state.scan_status === 'meta_filled') return; // 批量/此前已补全，无需再搜
  const now = Date.now();
  if (state.meta_lazy_status === 'not_found' && state.meta_lazy_retry_at && now < Number(state.meta_lazy_retry_at)) {
    return; // 负缓存：插件此前无结果且未到重试时间，避免反复轰炸插件
  }
  const title = String(state.title || '').trim();
  const artist = String(state.artist || '').trim();
  if (!title) return;
  try {
    const meta = await fetchTrackMeta(title, artist);
    const filled = !!(meta && meta.matched);
    // scan_status 照常标记（驱动懒加载/批量阶段1的准入），不再写任何远程 URL
    await localLibraryDb.setTrackMeta(rp, null, filled ? 'meta_filled' : 'meta_failed');
    if (filled) {
      // 专辑名：文件标签优先，缺失时用匹配结果回填（否则无专辑实体可挂封面）
      const albumName = (state.album && String(state.album).trim()) || extractAlbum(meta.matched);
      if (albumName && albumName !== '未知专辑') {
        if (!state.album) await localLibraryDb.updateSongAlbumIfEmpty(rp, albumName);
      }
      // 注：专辑封面不再从这里绑定（旧逻辑用单曲搜索结果冒充）。
      // 统一交给 Step3：用「歌手+专辑名」搜 type='album' 得到真实专辑封面后绑定。
      // 歌曲封面：仅当本地无封面时绑定（bindSongCover 内部仅填空，绝不覆盖内嵌封面）
      if (meta.trackCoverRemote) {
        downloadAndBind(meta.trackCoverRemote, 'cover', (rel, hash) =>
          localLibraryDb.bindSongCover(rp, rel, hash));
      }
    }
    // 负缓存：命中=found（retry_at 清空）；未命中=not_found（1 小时内不再重试）
    await localLibraryDb.setLazyMeta(rp, {
      lazyStatus: filled ? 'found' : 'not_found',
      lazyRetryAt: filled ? null : now + LAZY_RETRY_MS
    });
  } catch (e) {
    logger.warn('LOCAL-ENRICH', 'lazy', 'lazyFillTrackMeta failed', { relPath: rp, error: e && e.message });
    // 失败不写 not_found，允许下次播放重试（避免永久卡死）
  }
}

// ==================== Step1-5 独立搜索接口（严格分离，各自只读对应插件配置）====================
// 统一返回 { url/lyrics/album, plugin, plugins }：plugin=本次命中的插件，plugins=配置的插件列表，
// 便于流水线每一步在日志里打印「使用了哪些插件、哪个插件命中」。

/** Step1 专辑名补全：歌名+歌手，cover_plugins，仅取匹配歌曲的专辑名（无结果返回 null）。
 * 受配置开关 allow_album_name_fill 控制（默认允许；设为 false 则跳过联网补专辑名，避免大批量网络请求）。 */
async function searchAlbumName(title, artist) {
  const cfgAllow = getConfigSetting('allow_album_name_fill');
  if (cfgAllow === false || cfgAllow === 'false' || cfgAllow === 0 || cfgAllow === '0') {
    logger.debug('LOCAL-ENRICH', 'album-name', '按配置跳过联网补专辑名（allow_album_name_fill=false）', { title, artist });
    return { album: null, plugin: null, plugins: [] };
  }
  const plugins = resolveConfiguredPlugins('cover_plugins', '');
  const t = String(title || '').trim();
  const a = String(artist || '').trim();
  if (!t || !plugins.length) return { album: null, plugin: null, plugins };
  const rid = createReqId();
  for (const plugin of plugins) {
    const m = await searchMatchBy(plugin, t, a, 'music', rid, false);
    if (!m) continue;
    const album = extractAlbum(m);
    if (album) {
      logger.debug('LOCAL-ENRICH', rid, '专辑名补全命中', { plugin, plugins: plugins.join(','), title: t, artist: a, album });
      // 一并回传 matched：供 Step1.5 直接复用该匹配结果取时长，避免同一首歌重复联网搜索
      return { album, plugin, plugins, matched: m };
    }
  }
  logger.debug('LOCAL-ENRICH', rid, '专辑名补全无结果', { plugins: plugins.join(','), title: t, artist: a });
  return { album: null, plugin: null, plugins, matched: null };
}

/** Step1.5 时长补录：歌名+歌手，cover_plugins，取第一个「带时长」的匹配结果（秒）。
 *
 *  关键：部分插件的搜索结果【没有 duration 字段】（实测酷我_念心.js / 弥音QQ.js 均无），
 *  只有部分插件（实测 Migu.js、腾讯音乐.js、喜马拉雅_竹侣.js）返回时长。
 *  因此绝不能「命中第一个插件就返回」——那样在插件列表把无时长插件排在前面时（本项目默认
 *  酷我_念心 → 弥音QQ → Migu）永远取不到时长。必须逐个插件继续搜，直到取到时长为止。
 *  strm 文件本体是文本流容器、ffmpeg 读不到时长，完全依赖本接口补录。
 *
 * @param {string} title 歌名
 * @param {string} [artist] 歌手名
 * @param {Object[]} [preMatched] 本次流水线已搜到过的匹配对象，优先从中取时长（零额外网络请求）
 * @returns {Promise<{duration:number, plugin:string|null, plugins:string[], matched:Object|null}>}
 */
async function searchTrackDuration(title, artist, preMatched) {
  const t = String(title || '').trim();
  const a = String(artist || '').trim();
  const plugins = resolveConfiguredPlugins('cover_plugins', '');
  if (!t || !plugins.length) return { duration: 0, plugin: null, plugins, matched: null };
  // 先用已有的匹配结果取时长：本次流水线（如 Step1 专辑名搜索）已联网搜到过，无需再发请求
  for (const m of preMatched || []) {
    const d = extractDuration(m);
    if (d > 0 && d < 24 * 3600) {
      logger.debug('LOCAL-ENRICH', 'track-duration', '时长补录命中（复用已有匹配结果，未发新请求）', { title: t, artist: a, duration: d });
      return { duration: d, plugin: null, plugins, matched: m };
    }
  }
  const rid = createReqId();
  for (const plugin of plugins) {
    const m = await searchMatchBy(plugin, t, a, 'music', rid, false);
    if (!m) continue;
    const d = extractDuration(m);
    if (d > 0 && d < 24 * 3600) {
      logger.debug('LOCAL-ENRICH', rid, '时长补录命中', { plugin, plugins: plugins.join(','), title: t, artist: a, duration: d });
      return { duration: d, plugin, plugins, matched: m };
    }
    // 匹配成功但该插件结果无时长字段 → 继续下一个插件（不能就此放弃）
    logger.debug('LOCAL-ENRICH', rid, '该插件匹配成功但结果无时长字段，继续下一个插件', { plugin, title: t, artist: a });
  }
  logger.debug('LOCAL-ENRICH', rid, '时长补录无结果（全部插件均未返回时长）', { plugins: plugins.join(','), title: t, artist: a });
  return { duration: 0, plugin: null, plugins, matched: null };
}

/** Step2 单曲封面：歌名+歌手，cover_plugins，type='music' */
async function searchTrackCover(title, artist) {
  const plugins = resolveConfiguredPlugins('cover_plugins', '');
  const t = String(title || '').trim();
  const a = String(artist || '').trim();
  if (!t || !plugins.length) return { url: null, plugin: null, plugins };
  const rid = createReqId();
  for (const plugin of plugins) {
    const m = await searchMatchBy(plugin, t, a, 'music', rid, false);
    if (!m) continue;
    const url = extractCover(m);
    if (url) {
      logger.debug('LOCAL-ENRICH', rid, '单曲封面搜索命中', { plugin, plugins: plugins.join(','), title: t, artist: a, url });
      return { url, plugin, plugins, matched: m };
    }
  }
  logger.debug('LOCAL-ENRICH', rid, '单曲封面搜索无结果', { plugins: plugins.join(','), title: t, artist: a });
  return { url: null, plugin: null, plugins };
}

/** Step3 专辑封面：歌手+专辑名，cover_plugins，type='album'。无结果返回 null，绝不拿单曲封面兜底 */
async function searchAlbumCoverByAlbum(album, artist) {
  const name = String(album || '').trim();
  if (!name) return { url: null, plugin: null, plugins: [] };
  const res = await searchAlbumCover(name, artist);
  const plugins = (res && res.plugins) || [];
  logger.debug('LOCAL-ENRICH', 'album-cover', '专辑封面搜索结束', {
    album: name, artist: artist || null,
    plugins: plugins.join(',') || '无', plugin: (res && res.plugin) || null, url: (res && res.url) || null
  });
  return { url: (res && res.url) || null, plugin: (res && res.plugin) || null, plugins };
}

/** Step4 歌手头像：仅歌手名，artist_image_plugins，type='artist'（绝不回退封面插件） */
async function searchArtistAvatar(name) {
  const plugins = resolveConfiguredPlugins('artist_image_plugins', '');
  const n = String(name || '').trim();
  if (!n || !plugins.length) return { url: null, plugin: null, plugins };
  const userVars = userConfigs.default || {};
  const rid = createReqId();
  for (const plugin of plugins) {
    try {
      const result = await runPlugin(plugin, 'search', [n, 1, 'artist'], userVars, ctx.PLUGINS_DIR);
      const list = Array.isArray(result) ? result : (result && Array.isArray(result.data) ? result.data : []);
      const filtered = list.filter((it) => it && typeof it === 'object');
      if (!filtered.length) continue;
      for (const it of filtered) {
        const img = extractImage(it);
        if (img) {
          logger.debug('LOCAL-ENRICH', rid, '歌手头像搜索命中', { plugin, plugins: plugins.join(','), artist: n, url: img });
          return { url: img, plugin, plugins };
        }
      }
    } catch (err) {
      logger.warn('LOCAL-ENRICH', rid, '歌手头像搜索失败', { plugin, artist: n, error: err.message });
    }
  }
  logger.debug('LOCAL-ENRICH', rid, '歌手头像搜索无结果', { plugins: plugins.join(','), artist: n });
  return { url: null, plugin: null, plugins };
}

/** Step5 歌词：歌名+歌手，lyric_plugins（绝不回退封面插件） */
async function searchSongLyrics(title, artist) {
  const plugins = resolveConfiguredPlugins('lyric_plugins', 'lyric_plugin');
  const t = String(title || '').trim();
  const a = String(artist || '').trim();
  if (!t || !plugins.length) return { lyrics: null, plugin: null, plugins };
  const rid = createReqId();
  for (const plugin of plugins) {
    const m = await searchMatchBy(plugin, t, a, 'lyric', rid, true);
    if (!m) continue;
    // 优先使用搜索结果里已内嵌的歌词（如碳酸歌词酷狗源），避免再发一次 getLyric 请求
    const embedded = extractEmbeddedLyrics(m);
    if (embedded) {
      logger.debug('LOCAL-ENRICH', rid, '歌词搜索命中（search 内嵌）', { plugin, plugins: plugins.join(','), title: t, artist: a });
      return { lyrics: embedded, plugin, plugins };
    }
    const l = await fetchLyrics(plugin, m, rid);
    if (l && String(l).trim()) {
      logger.debug('LOCAL-ENRICH', rid, '歌词搜索命中', { plugin, plugins: plugins.join(','), title: t, artist: a });
      return { lyrics: l, plugin, plugins };
    }
  }
  logger.debug('LOCAL-ENRICH', rid, '歌词搜索无结果', { plugins: plugins.join(','), title: t, artist: a });
  return { lyrics: null, plugin: null, plugins };
}

/**
 * 从插件搜索结果中提取歌曲标题（多插件字段名不一致，逐个候选）
 * @param {Object} song 插件搜索结果条目
 * @returns {string}
 */
function extractTitle(song) {
  if (!song) return '';
  for (const key of ['title', 'name', 'songName', 'songname', 'song', 'musicName', 'musicname']) {
    const v = song[key];
    if (typeof v === 'string') {
      const t = v.trim();
      if (t && t !== '未知') return t;
    }
  }
  return '';
}

/**
 * Step1 元数据补空（核心字段：艺术家 / 专辑 / 歌曲标题）。
 *
 * 调用前提：调用方已判定核心字段存在空缺（全部非空时应直接跳过，不发起任何插件请求）。
 * 一次检索尽量取回 title / artist / album（同一命中对象零额外请求），但【只返回缺失字段】：
 * 自动扫描模式下插件永远只填空，绝不覆盖已有有效值；overwrite=true（用户手动补全）时才全量返回。
 *
 * 受配置开关 allow_metadata_fill 控制（默认允许；设为 false 则完全不联网补元数据）。
 *
 * @param {string} title 歌曲标题（检索主 key，为空则直接返回）
 * @param {string} [artist] 歌手（可为空，缺失时也用标题单独检索）
 * @param {string[]} missing 缺失字段名（'title' | 'artist' | 'album'）
 * @param {boolean} [overwrite] 用户手动补全：允许覆盖已有值
 * @returns {Promise<{title:string|null, artist:string|null, album:string|null, matched:Object|null, plugin:string|null, plugins:string[]}>}
 */
async function searchMissingMeta(title, artist, missing, overwrite) {
  const plugins = resolveConfiguredPlugins('cover_plugins', '');
  const t = String(title || '').trim();
  const a = String(artist || '').trim();
  const empty = { title: null, artist: null, album: null, matched: null, plugin: null, plugins };
  const cfgAllow = getConfigSetting('allow_metadata_fill', true);
  if (cfgAllow === false || cfgAllow === 'false' || cfgAllow === 0 || cfgAllow === '0') {
    logger.debug('LOCAL-ENRICH', 'meta-fill', '按配置跳过联网补元数据（allow_metadata_fill=false）', { title: t, artist: a });
    return empty;
  }
  if (!t || !plugins.length) return empty;
  const need = new Set(Array.isArray(missing) ? missing : []);
  const rid = createReqId();
  for (const plugin of plugins) {
    const m = await searchMatchBy(plugin, t, a, 'music', rid, false);
    if (!m) continue;
    const out = { title: null, artist: null, album: null, matched: m, plugin, plugins };
    const mTitle = extractTitle(m);
    const mArtist = Array.isArray(m.artist)
      ? extractArtist(m)
      : String(extractArtist(m) || '').trim();
    const mAlbum = String(extractAlbum(m) || '').trim();
    // 只取缺失字段；overwrite（手动补全）时三个字段全取，由调用方执行覆盖写入
    if ((need.has('title') || overwrite) && mTitle) out.title = mTitle;
    if ((need.has('artist') || overwrite) && mArtist && mArtist !== '未知艺术家' && mArtist !== '未知') out.artist = mArtist;
    if ((need.has('album') || overwrite) && mAlbum) out.album = mAlbum;
    if (out.title || out.artist || out.album) {
      logger.debug('LOCAL-ENRICH', rid, '元数据补空命中', {
        plugin, plugins: plugins.join(','), title: t, artist: a,
        missing: Array.from(need).join(',') || '无', overwrite: !!overwrite,
        fillTitle: out.title || null, fillArtist: out.artist || null, fillAlbum: out.album || null
      });
      return out;
    }
    // 该插件没补到任何目标字段 → 继续下一个插件
  }
  logger.debug('LOCAL-ENRICH', rid, '元数据补空无结果', { plugins: plugins.join(','), title: t, artist: a, missing: Array.from(need).join(',') || '无' });
  return empty;
}

module.exports = {
  enrichLocalMusic,
  fetchArtistImage,
  fetchAlbumImage,
  extractAlbum,
  extractTitle,
  extractDuration,
  resolveConfiguredPlugins,
  fetchTrackMeta,
  extractAlbumCover,
  lazyFillTrackMeta,
  downloadAndBind,
  // Step1-5 独立搜索接口
  searchAlbumName,
  searchMissingMeta,
  searchTrackDuration,
  searchTrackCover,
  searchAlbumCoverByAlbum,
  searchArtistAvatar,
  searchSongLyrics
};