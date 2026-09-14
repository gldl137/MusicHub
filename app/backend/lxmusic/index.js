'use strict';

/**
 * 洛雪（LX）专区 - 后端门面
 * ================================================================
 * 基于打包后的落雪内置音源 SDK（./musicSdk.cjs），对上层提供干净的
 * 「平台 / 排行榜 / 热门歌单」数据接口，并把落雪歌曲对象转换为
 * MusicHub 通用的 musicItem（title/artist/album/duration/artwork/plugin）。
 *
 * 排行榜分类来自**各平台官方数据**（见 ./official-categories.js），不自行编造。
 *
 * 一期只做「浏览」，不含播放解析（getMusicUrl 依赖自定义源，二期接入）。
 * 歌曲来源标记：plugin = `lx:<source>`（如 lx:kw），便于与 MF 插件区分。
 */

const logger = require('../core/logger');
const sdk = require('./musicSdk.cjs');
const { getOfficialGroups } = require('./official-categories');

// 支持的平台（与落雪内置音源一致；xm 已下线、bd 未启用）
const PLATFORMS = [
  { id: 'kw', name: '酷我音乐' },
  { id: 'kg', name: '酷狗音乐' },
  { id: 'tx', name: 'QQ音乐' },
  { id: 'wy', name: '网易云音乐' },
  { id: 'mg', name: '咪咕音乐' },
];

function isPlatform(source) {
  return PLATFORMS.some((p) => p.id === source);
}

function lb(source) {
  const m = sdk[source + 'Leaderboard'];
  if (!m) throw new Error(`不支持的平台：${source}`);
  return m;
}

function sl(source) {
  const m = sdk[source + 'SongList'];
  if (!m) throw new Error(`不支持的平台：${source}`);
  return m;
}

function ms(source) {
  const m = sdk[source + 'MusicSearch'];
  if (!m) throw new Error(`该平台不支持搜索：${source}`);
  return m;
}

/** 'mm:ss' → 秒 */
function intervalToSec(interval) {
  if (typeof interval === 'number') return interval;
  if (!interval || typeof interval !== 'string') return 0;
  const parts = interval.split(':').map((n) => parseInt(n, 10) || 0);
  let sec = 0;
  for (const n of parts) sec = sec * 60 + n;
  return sec;
}

/** 取平台原始歌曲 id（用于构造唯一 music id，二期解析也依赖这些字段） */
function pickPlatformId(song) {
  return song.songmid || song.hash || song.rid || song.copyrightId || song.songId || song.id || '';
}

/**
 * 落雪歌曲 → MusicHub musicItem
 * 保留全部原始字段（供二期播放解析使用），仅补充规范化字段。
 */
function toMusicItem(song, source) {
  if (!song || typeof song !== 'object') return null;
  const platformId = pickPlatformId(song);
  const id = song.id != null && String(song.id).startsWith('lx_')
    ? String(song.id)
    : `lx_${source}_${platformId || Math.random().toString(36).slice(2, 10)}`;

  return {
    ...song,
    id,
    title: song.name || song.title || '',
    artist: song.singer || song.artist || '',
    album: song.albumName || song.album || '',
    duration: intervalToSec(song.interval),
    artwork: song.img || song.pic || song.artwork || '',
    plugin: `lx:${source}`,
    lxSource: source,
    source: song.source || source,
  };
}

/** 批量转换 */
function mapMusicList(list, source) {
  if (!Array.isArray(list)) return [];
  return list.map((s) => toMusicItem(s, source)).filter(Boolean);
}

/** 榜单去重（按 id） */
function dedupeBoards(list) {
  const seen = new Set();
  const out = [];
  for (const b of list || []) {
    if (!b || b.id == null) continue;
    const k = String(b.id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

module.exports = {
  PLATFORMS,
  isPlatform,
  toMusicItem,
  mapMusicList,
  intervalToSec,

  getPlatforms() {
    return PLATFORMS.map((p) => ({ ...p }));
  },

  /**
   * 排行榜列表：优先使用各平台**官方分类**，失败时回退到落雪 SDK 的扁平列表。
   * 返回 { source, list（扁平，供按 id 查名）, groups:[{title,data:[{id,name,bangid}]}] }
   */
  async getBoards(source) {
    if (!isPlatform(source)) throw new Error(`不支持的平台：${source}`);

    let groups = [];
    try {
      groups = await getOfficialGroups(source, sdk);
    } catch (e) {
      logger.warn('LX', 'lx-index', `获取官方榜单分类失败(${source})，回退扁平列表`, { error: e.message });
    }

    if (!groups || !groups.length) {
      const res = await lb(source).getBoards();
      const flat = ((res && res.list) || []).map((b) => ({ id: b.id, name: b.name, bangid: b.bangid }));
      groups = flat.length ? [{ title: '', data: flat }] : [];
    }

    const list = dedupeBoards(groups.flatMap((g) => (g && g.data) || []));
    return { source, list, groups };
  },

  /** 排行榜详情（榜单歌曲） */
  async getBoardSongs(source, bangId, page = 1) {
    if (!isPlatform(source)) throw new Error(`不支持的平台：${source}`);
    // 兼容调用方传入完整 id（如 kw__16）或纯 bangid（16）：统一剥离「<source>__」前缀
    const id = String(bangId).replace(new RegExp('^' + source + '__'), '');
    const res = await lb(source).getList(id, Number(page) || 1);
    return {
      success: true,
      source,
      total: (res && res.total) || 0,
      limit: (res && res.limit) || 0,
      page: (res && res.page) || Number(page) || 1,
      list: mapMusicList(res && res.list, source),
    };
  },

  /**
   * 歌曲搜索（各平台内置 musicSearch，与落雪客户端一致）。
   * 返回与榜单/歌单一致的 musicItem 列表，便于前端直接复用 MF 的表格/搜索视图。
   */
  async search(source, keyword, page = 1) {
    if (!isPlatform(source)) throw new Error(`不支持的平台：${source}`);
    const kwd = String(keyword == null ? '' : keyword).trim();
    if (!kwd) throw new Error('搜索关键词不能为空');
    const mod = ms(source);
    const res = await mod.search(kwd, Number(page) || 1);
    const list = (res && res.list) || [];
    return {
      source,
      keyword: kwd,
      page: (res && res.page) || Number(page) || 1,
      limit: (res && res.limit) || 0,
      total: (res && res.total) || list.length,
      allPage: (res && res.allPage) || 1,
      list: mapMusicList(list, source),
    };
  },

  /** 歌单搜索（各平台内置 songList.search，返回字段与歌单列表一致） */
  async searchSongLists(source, keyword, page = 1) {
    if (!isPlatform(source)) throw new Error(`不支持的平台：${source}`);
    const kwd = String(keyword == null ? '' : keyword).trim();
    if (!kwd) throw new Error('搜索关键词不能为空');
    const mod = sl(source);
    if (typeof mod.search !== 'function') throw new Error(`该平台不支持歌单搜索：${source}`);
    const res = await mod.search(kwd, Number(page) || 1);
    const list = (res && res.list) || [];
    return {
      source,
      keyword: kwd,
      page: Number(page) || 1,
      limit: (res && res.limit) || list.length,
      total: (res && res.total) || list.length,
      list,
    };
  },

  /** 热门歌单标签 */
  async getSongListTags(source) {
    if (!isPlatform(source)) throw new Error(`不支持的平台：${source}`);
    const mod = sl(source);
    if (typeof mod.getTags !== 'function') {
      return { source, tags: [], hotTag: [], sortList: mod.sortList || [] };
    }
    const res = await mod.getTags();
    return {
      source,
      tags: (res && res.tags) || [],
      hotTag: (res && res.hotTag) || [],
      sortList: mod.sortList || [],
    };
  },

  /** 热门歌单列表 */
  async getSongLists(source, sortId, tagId, page = 1) {
    if (!isPlatform(source)) throw new Error(`不支持的平台：${source}`);
    const res = await sl(source).getList(sortId, tagId, Number(page) || 1);
    const list = (res && res.list) || [];
    return {
      source,
      total: (res && res.total) || 0,
      limit: (res && res.limit) || 0,
      page: (res && res.page) || Number(page) || 1,
      list,
    };
  },

  /** 歌单详情（歌单内歌曲） */
  async getSongListDetail(source, id, page = 1) {
    if (!isPlatform(source)) throw new Error(`不支持的平台：${source}`);
    const res = await sl(source).getListDetail(String(id), Number(page) || 1);
    return {
      source,
      info: (res && res.info) || {},
      total: (res && res.total) || 0,
      limit: (res && res.limit) || 0,
      page: (res && res.page) || Number(page) || 1,
      list: mapMusicList(res && res.list, source),
    };
  },
};

// 加载时打印一次，便于确认打包产物可用
try {
  logger.info('LX', 'lx-index', 'LX 音源 SDK 已加载', { exports: Object.keys(sdk) });
} catch { /* 忽略日志异常 */ }
