'use strict';

// ==================== 网络歌曲字段补全 / 播放解析兜底 ====================
// 背景：老版本把榜单/歌单快照入库时丢弃了插件专有标识字段（如弥音QQ 需要 songmid、
// 酷狗需要 hash）。残缺数据交给插件解析时，要么失败、要么被第三方解析 API 用
// 「同一首兜底歌」顶替（实测 api.xunhuisi.store 对无效 mid 返回 code=200 + 固定歌曲地址），
// 表现为歌单里所有歌都播放同一个音频。
//
// 提供：
//   - lacksPluginIdentFields(music)   判定歌曲对象是否缺插件专有标识字段
//   - enrichNetworkMusic(music, p)    按歌名/歌手向插件 search 补全完整字段
//   - resolveWithEnrich(...)          解析 + 失败/缺字段时补全重试（绝不返回可疑兜底结果）

const ctx = require('./context');
const { logger, ResolverCore, runPlugin, PLUGINS_DIR, userConfigs } = ctx;

// 基础展示/通用字段白名单：歌曲对象去掉这些后若一无所有，即视为缺插件专有标识字段
const BASE_META_KEYS = new Set([
  'id', 'musicId', 'songId', 'title', 'name', 'artist', 'artists', 'singer', 'album', 'duration', 'interval',
  'cover', 'artwork', 'pic', 'image', 'coverImg', 'albumArt', 'coverUrl', 'cover_url', 'cover_art_url', 'coverArt',
  'url', '_url', 'playUrl', 'play_url', 'mediaUrl', 'token',
  'plugin', 'platform', 'source', 'virtualId', 'quality', 'filePath', 'isLive',
  'year', 'genre', 'lrc', 'rawLrc', 'rawLrcTxt', 'lyric', 'lyrics',
  'addedAt', 'sortOrder', 'rank', '_data', 'additional',
  'albumId', 'albummid', 'albumMid', 'albumMID', 'albumName'
]);

function lacksPluginIdentFields(music) {
  if (!music || typeof music !== 'object') return false;
  if (music.plugin === 'local' || music.platform === 'local' || music.filePath) return false;
  // LX（落雪）歌曲由自定义音源解析，其标识字段（songmid/hash/rid…）由音源自己识别，
  // 不参与 MusicFree 插件的「缺字段」判定
  if (/^lx:/i.test(String(music.plugin || '')) || /^lx:/i.test(String(music.platform || ''))) return false;
  return Object.keys(music).every((k) => BASE_META_KEYS.has(k));
}

// 按歌名（+歌手）向插件搜索，取一份完整的歌曲数据（优先 id 精确命中，其次首个结果）
async function enrichNetworkMusic(music, plugin) {
  if (!music || !music.title || typeof runPlugin !== 'function') return null;
  const userVars = (userConfigs && userConfigs.default) || {};
  const queries = [];
  if (music.artist) queries.push(String(music.artist) + ' ' + String(music.title));
  queries.push(String(music.title));
  const candidates = [...new Set([plugin, music.plugin, music.platform].filter(Boolean))];
  for (const p of candidates) {
    for (const q of queries) {
      try {
        const result = await runPlugin(p, 'search', [q, 1, 'music'], userVars, PLUGINS_DIR);
        const items = Array.isArray(result) ? result : (result && Array.isArray(result.data) ? result.data : null);
        if (!items || !items.length) continue;
        const hit = items.find((it) => it && String(it.id) === String(music.id)) || items[0];
        if (hit && typeof hit === 'object') return { ...music, ...hit, id: hit.id, plugin: p };
      } catch { /* 跳过不支持搜索或调用失败的插件 */ }
    }
  }
  return null;
}

// 解析 + 兜底：先按原始 music 解析；解析失败、或 music 缺插件专有标识字段（老快照数据，
// 直接解析会被第三方 API 的兜底歌顶替）时，按歌名/歌手补全字段后重试。
// 缺字段场景下若重试仍失败，宁可返回失败也绝不返回可疑的原始结果。
// 副作用面不变：播放历史仍由调用方按原始 music 记录。
async function resolveWithEnrich(music, plugin, quality, userVars, reqId) {
  // LX（落雪）专区歌曲：直接走落雪自定义音源，不做 MusicFree 插件搜索补全
  const lxPlugin = /^lx:/i.test(String(plugin || ''))
    ? plugin
    : (/^lx:/i.test(String((music && music.plugin) || '')) ? music.plugin : null);
  if (lxPlugin) return ResolverCore.resolve(music, lxPlugin, quality, userVars, reqId);

  let result = await ResolverCore.resolve(music, plugin, quality, userVars, reqId);
  const needEnrich = music && music.title && (!result.success || lacksPluginIdentFields(music));
  if (!needEnrich) return result;

  const enriched = await enrichNetworkMusic(music, plugin).catch(() => null);
  if (enriched && !lacksPluginIdentFields(enriched)) {
    try {
      const retry = await ResolverCore.resolve(enriched, plugin || enriched.plugin, quality, userVars, reqId);
      if (retry.success) {
        logger.debug('API', reqId, 'Resolve retry succeeded after enrich', { title: enriched.title, id: enriched.id });
        return retry;
      }
    } catch { /* 落入下方失败返回 */ }
  }

  if (!result.success) return result; // 本来就失败：保留原始失败信息
  return { success: false, error: '歌曲字段不完整且补全解析失败', status: 'failed' };
}

module.exports = { lacksPluginIdentFields, enrichNetworkMusic, resolveWithEnrich };
