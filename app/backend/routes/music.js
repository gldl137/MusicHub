'use strict';

// ==================== 音乐相关 API（搜索/播放/解析/歌曲信息/歌词/歌单/排行榜/推荐/歌单详情）====================
// 路由归属：/api/search /api/play /api/resolve /api/music-info /api/lyrics
//           /api/toplists /api/toplist/:id
//           /api/recommend-tags /api/recommend-sheets /api/sheet/:id
//
// 注意：本文件忠实地复刻了原 server.js 中对应路由的实现（含参数形状、方法名、数据库函数名），
// 仅将共享依赖（runPlugin / ResolverCore / getDefaultPlugin / userConfigs / verifyToken 等）改为从 ctx 获取，
// 数据库函数改为从 ../database 获取，PLUGINS_DIR 改为 ctx.PLUGINS_DIR。

const ctx = require('../lib/context');
const {
  logger,
  frontendLogger,
  authMiddleware,
  createReqId,
  runPlugin,
  ResolverCore,
  getDefaultPlugin,
  userConfigs,
  verifyToken,
} = ctx;
const database = require('../database');
const { enrichLocalMusic } = require('../lib/local-enrich');
const {
  getUserPlaylists,
  createUserPlaylist,
  getUserPlaylist,
  getUserPlaylistSongs,
  updateUserPlaylist,
  deleteUserPlaylist,
  updatePlaylistOrder,
  addSongToUserPlaylist,
  removeSongFromUserPlaylist,
  clearUserPlaylistSongs,
  addUserPlayHistory,
} = database;

// 排行榜缓存（与原 server.js 保持一致）
const topListsCache = new Map();
const TOPLIST_CACHE_TTL = 10 * 60 * 1000;

// 归一化插件名：前端的某些调用会把未定义的 plugin 拼成字符串 "undefined"，
// 该字符串是 truthy 会导致 `plugin || getDefaultPlugin()` 不回落默认插件，
// 最终 runPlugin 拼出 /app/data/plugins/undefined 而报 "Plugin file not found"。
function normalizePlugin(plugin) {
  if (plugin && plugin !== 'undefined' && plugin !== 'null') {
    return plugin;
  }
  return getDefaultPlugin();
}

// 网络歌曲字段补全 / 解析兜底（老快照数据缺插件专有字段，直接解析会被第三方 API 兜底歌顶替）
const { resolveWithEnrich } = require('../lib/network-enrich');

// 提取歌手文本：不同插件歌手字段名不一（artist / singer / artists 数组），统一取一份字符串
function extractArtistText(m) {
  if (!m) return '';
  if (m.artist) return Array.isArray(m.artist) ? m.artist.join('/') : String(m.artist);
  if (m.singer) return Array.isArray(m.singer) ? m.singer.join('/') : String(m.singer);
  if (Array.isArray(m.artists)) return m.artists.join('/');
  return m.artists ? String(m.artists) : '';
}

// 本地曲库优先播放：开关开启且为插件（网络）音源时，先用 歌名+歌手 在 NAS 本地库做精确匹配，
// 命中直接返回本地流结果（跳过网络解析——播放始终从本地音源开始）；未命中 / 缺字段 / 超时 / 异常
// → 返回 null，调用方继续走插件网络解析（兜底，绝不中断播放）。本地音源 / 直播流不受开关影响。
async function tryLocalLibraryFirst(music, reqId) {
  try {
    const enabled = ctx.config.getConfigSetting('localLibraryPriority', false);
    if (!enabled) return null;
    if (!music || music.plugin === 'local' || music.platform === 'local' || music.filePath || music.isLive) return null;
    const title = music.title;
    const artist = extractArtistText(music);
    const duration = music.duration;
    if (!title) return null; // 缺歌名 → 插件网络解析（歌手可缺，匹配层按时长兜底）
    const match = await database.matchLocalLibraryForPlay(title, artist, duration);
    if (!match) return null; // 本地没有 → 插件网络解析
    logger.debug('API', reqId, 'Local library priority HIT (local-first)', { title, artist, localId: match.id });
    return {
      success: true,
      isLocal: true,
      data: {
        url: match.url,
        isLocal: true,
        localFilePath: match.filePath,
        source: 'local',
        title,
        artist,
        duration: duration != null ? duration : match.duration
      }
    };
  } catch (e) {
    logger.warn('API', reqId, 'Local library priority error, fallback to network', { error: e && e.message });
    return null;
  }
}

module.exports = function (app) {

  // 搜索/播放/解析/歌词/排行榜/推荐等接口均需登录（与 /api/my/playlists 一致），避免未授权调用插件与外部源
  app.use(['/api/search', '/api/play', '/api/resolve', '/api/music-info', '/api/lyrics',
    '/api/music/local-match', '/api/music/local-match-batch',
    '/api/toplists', '/api/toplist', '/api/recommend-tags', '/api/recommend-sheets', '/api/sheet'], authMiddleware);

  // ==================== 搜索 ====================
  app.get('/api/search', async (req, res) => {
    const { q, page = 1, type = 'music', plugin } = req.query;
    const targetPlugin = normalizePlugin(plugin);

    if (!targetPlugin) {
      return res.json({ success: false, error: 'No plugin installed' });
    }

    // 本地音乐不支持插件式搜索：直接返回空结果，避免 runPlugin 抛错 + 前端请求风暴
    const rawPlugin = (plugin || '').toString().toLowerCase();
    if (rawPlugin === 'local' || targetPlugin === 'local') {
      return res.json({ success: true, data: { data: [] } });
    }

    try {
      const userVars = userConfigs.default || {};
      const result = await runPlugin(targetPlugin, 'search', [q, parseInt(page), type], userVars, ctx.PLUGINS_DIR);

      // 记录前台日志 - 搜索歌曲
      if (result && result.data && result.data.length > 0) {
        frontendLogger.info('SEARCH', 'Search completed', { keyword: q, type, results: result.data.length });
      }

      res.json({ success: true, data: result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ==================== 播放接口：获取 URL + 记录播放历史（有副作用）====================
  app.post('/api/play', async (req, res) => {
    const { quality = 'standard' } = req.query;
    const plugin = normalizePlugin(req.query.plugin);
    const { music } = req.body;

    const userVars = userConfigs.default || {};
    // 本地曲库优先：开关开启时播放始终先试本地，本地没有才解析插件网络地址
    let result = await tryLocalLibraryFirst(music, req.reqId);
    if (!result) {
      result = await resolveWithEnrich(music, plugin, quality, userVars, req.reqId);
    }

    if (result.success) {
      const resolverStatus = result.data?.status || 'success';
      const stage = result.data?.source || 'unknown';
      const duration = result.data?.duration;
      logger.debug('API', req.reqId, `Play success`, { status: `${stage}_${resolverStatus}`, stage, duration, plugin: plugin || getDefaultPlugin(), title: music?.title, id: music?.id });

      // 注意：前台日志由前端 playMusic 函数记录，避免重复

      // 记录播放历史（如果用户已登录）- 从 Authorization header 解析用户信息
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const decoded = verifyToken(token);
        if (decoded && decoded.userId && music) {
          try {
            await addUserPlayHistory(decoded.userId, music, plugin || music.plugin || music.platform);
            logger.debug('API', req.reqId, `Play history recorded for user ${decoded.userId}`, { musicId: music.id, title: music?.title });
          } catch (err) {
            // 记录播放历史失败不应该影响播放功能
            logger.error('API', req.reqId, `Failed to record play history`, { error: err.message, userId: decoded.userId });
          }
        } else {
          logger.warn('API', req.reqId, `Token decoded but no valid user`, { hasDecoded: !!decoded, hasUserId: !!decoded?.userId, hasMusic: !!music });
        }
      } else {
        logger.warn('API', req.reqId, `No Authorization header or invalid format`, { hasAuth: !!authHeader });
      }
    } else {
      logger.error('API', req.reqId, `Play error`, { status: 'failed', title: music?.title, id: music?.id, error: result.error });
    }

    res.json(result);
  });

  // ==================== 纯解析接口：只获取 URL，无副作用（预加载用）====================
  app.post('/api/resolve', async (req, res) => {
    const { quality = 'standard' } = req.query;
    const plugin = normalizePlugin(req.query.plugin);
    const { music } = req.body;

    const userVars = userConfigs.default || {};
    // 本地曲库优先：预加载同样先试本地
    let result = await tryLocalLibraryFirst(music, req.reqId);
    if (!result) {
      result = await resolveWithEnrich(music, plugin, quality, userVars, req.reqId);
    }

    if (result.success) {
      logger.debug('API', req.reqId, `Resolve success`, { title: music?.title, id: music?.id });
    } else {
      logger.error('API', req.reqId, `Resolve error`, { title: music?.title, id: music?.id, error: result.error });
    }

    res.json(result);
  });

  // ==================== 获取歌曲详细信息（包括封面）====================
  app.post('/api/music-info', async (req, res) => {
    const { plugin } = req.query;
    const { music } = req.body;
    const targetPlugin = normalizePlugin(plugin);

    if (!targetPlugin) {
      return res.json({ success: false, error: 'No plugin installed' });
    }

    // 本地音乐不支持插件式信息补全：直接返回空，避免 runPlugin 抛 "Local music does not support plugin operations" + 前端请求风暴
    const rawPlugin = (plugin || '').toString().toLowerCase();
    if (rawPlugin === 'local' || targetPlugin === 'local') {
      return res.json({ success: true, data: null, unsupported: true });
    }

    try {
      const userVars = userConfigs.default || {};
      let result = null;
      try {
        result = await runPlugin(targetPlugin, 'getMusicInfo', [music], userVars, ctx.PLUGINS_DIR);
      } catch (err) {
        // 插件未实现 getMusicInfo：MusicFree 该方法为可选，视为无额外信息，正常返回而非报错
        // 与 playlist-refresh.js 的处理保持一致，避免把「不支持」当成失败刷屏日志
        if (/not found in plugin/i.test((err && err.message) || '')) {
          return res.json({ success: true, data: null, unsupported: true });
        }
        throw err;
      }
      res.json({ success: true, data: result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ==================== 本地曲库匹配查询（切换音源弹窗用）====================
  // 按歌名+歌手（可选时长）在 NAS 本地库做精确匹配，返回可直连的本地流地址；未命中返回 success:false
  app.post('/api/music/local-match', async (req, res) => {
    const { music } = req.body || {};
    try {
      if (!music || !music.title) {
        return res.json({ success: false, error: '缺少歌名' });
      }
      const match = await database.matchLocalLibraryForPlay(music.title, extractArtistText(music), music.duration);
      if (!match) {
        return res.json({ success: false, error: '本地曲库未找到匹配歌曲' });
      }
      res.json({ success: true, data: match });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ==================== 本地曲库批量匹配（歌单详情「本地 ✓」徽标用）====================
  // 传入歌曲数组，按序返回每首是否命中本地库（精确 歌名+歌手，含时长过滤，排除 strm）
  app.post('/api/music/local-match-batch', async (req, res) => {
    const { songs } = req.body || {};
    try {
      if (!Array.isArray(songs)) {
        return res.json({ success: false, error: 'songs must be array' });
      }
      const list = songs.slice(0, 200); // 单次批量上限，防御超大请求
      const results = await Promise.all(list.map(async (s) => {
        try {
          if (!s || !s.title) return false;
          const m = await database.findLocalSongByMeta(s.title, extractArtistText(s), s.duration);
          return !!m;
        } catch { return false; }
      }));
      res.json({ success: true, data: results });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ==================== 清空网络歌曲缓存（songs 表 remote__* 记录）====================
  app.post('/api/music/clear-network-songs', async (req, res) => {
    try {
      const deleted = await database.clearNetworkSongCache();
      res.json({ success: true, deleted });
    } catch (err) {
      logger.error('MUSIC', createReqId(), 'Clear network song cache failed', { error: logger.formatError(err) });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 统计网络歌曲缓存条数（songs 表 remote__* 记录）
  app.get('/api/music/network-song-count', async (req, res) => {
    try {
      const count = await database.getNetworkSongCount();
      res.json({ success: true, data: { count } });
    } catch (err) {
      logger.error('MUSIC', createReqId(), 'Get network song count failed', { error: logger.formatError(err) });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== 获取歌词 ====================
  app.post('/api/lyrics', async (req, res) => {
    const { plugin } = req.query;
    const { music } = req.body;
    const targetPlugin = normalizePlugin(plugin);

    // 本地音乐：无独立歌词，通过插件搜索网络版本获取歌词（enrichLocalMusic 已内置 DB-first，
    // 之前补全落库的 local_songs.lyric_raw 命中时不会联网）
    if (targetPlugin === 'local' || (music && (music.plugin === 'local' || music.filePath))) {
      try {
        const result = await enrichLocalMusic(music, { trigger: 'play' });
        if (result && result.lyrics) {
          return res.json({ success: true, data: { rawLrc: result.lyrics } });
        }
        return res.json({ success: false, error: 'No lyrics found' });
      } catch (err) {
        return res.json({ success: false, error: err.message });
      }
    }

    // 网络歌曲歌词 DB 优先：之前播放/补全已写入 songs.lyric_raw → 直接返回，不再联网拉取/搜索
    if (music && music.id) {
      try {
        const netPlugin = String(music.plugin || music.platform || '').trim() !== 'local'
          ? (music.plugin || music.platform || targetPlugin)
          : targetPlugin;
        const dbRow = await database.loadNetworkSongLyric(music, netPlugin);
        if (dbRow && dbRow.lyric_raw && String(dbRow.lyric_raw).trim()) {
          return res.json({ success: true, data: { rawLrc: String(dbRow.lyric_raw) } });
        }
      } catch { /* 数据库不可用则走在线获取 */ }
    }

    if (!targetPlugin) {
      return res.json({ success: false, error: 'No plugin installed' });
    }

    const extractLyricText = (payload) => {
      if (!payload) return '';
      if (typeof payload === 'string') return payload;
      if (payload && payload.success === false) return '';
      const d = (payload && payload.data !== undefined) ? payload.data : payload;
      if (typeof d === 'string') return d;
      return (d && (d.rawLrc || d.lyrics || d.lrc)) || '';
    };

    let lyricText = '';
    // 落雪（LX）歌曲：plugin 形如 `lx:kg`，不属于 MusicFree 插件体系，
    // 自定义音源只提供播放地址（musicUrl）不含歌词；直接跳过插件取词，
    // 交给下面的歌词插件兜底（按歌名+歌手搜索），不做注定失败的插件调用。
    const isLxSource = /^lx:/i.test(String(targetPlugin || ''));
    if (isLxSource) {
      logger.debug('API', req.reqId, 'LX 歌曲歌词：跳过来源插件，走歌词插件兜底', { plugin: targetPlugin });
    }

    // 1. 先用歌曲来源插件取词（可能因源站接口异常返回 null / 抛错）
    if (!isLxSource) {
      try {
        const userVars = userConfigs.default || {};
        const result = await runPlugin(targetPlugin, 'getLyric', [music], userVars, ctx.PLUGINS_DIR);
        lyricText = extractLyricText(result);
      } catch (err) {
        logger.warn('API', req.reqId, 'getLyric by source plugin failed, fallback to lyric plugins', { plugin: targetPlugin, error: err.message });
      }
    }

    // 2. 源插件取不到时：按「歌词封面」设置的歌词插件列表兜底（本地补全链路，按歌名+歌手搜索取词）
    if (!lyricText || !String(lyricText).trim()) {
      try {
        const enriched = await enrichLocalMusic(music, { includeLyrics: true, trigger: 'play' });
        if (enriched && enriched.lyrics && String(enriched.lyrics).trim()) {
          lyricText = enriched.lyrics;
          logger.info('API', req.reqId, 'Lyrics fallback ok', { plugin: targetPlugin, length: String(enriched.lyrics).length });
        }
      } catch (err2) {
        logger.warn('API', req.reqId, 'Lyrics fallback failed', { error: err2 && err2.message });
      }
    }

    if (lyricText && String(lyricText).trim()) {
      // 网络歌曲歌词落库：songs.lyric_raw / lyric_struct（只在成功取到有效歌词时写入）
      if (music && music.id && !music.filePath && String(music.plugin) !== 'local') {
        try {
          const netPlugin = (music.plugin && String(music.plugin) !== 'local') ? music.plugin : targetPlugin;
          await database.saveNetworkSongLyric(music, netPlugin, String(lyricText));
        } catch (e) { /* 歌词落库失败不影响返回 */ }
      }
      return res.json({ success: true, data: { rawLrc: String(lyricText) } });
    }
    return res.json({ success: false, error: 'No lyrics found' });
  });


  // ==================== 排行榜 ====================

  app.get('/api/toplists', async (req, res) => {
    const { plugin } = req.query;
    const targetPlugin = normalizePlugin(plugin);

    if (!targetPlugin) {
      return res.json({ success: false, error: 'No plugin installed' });
    }

    try {
      const userVars = userConfigs.default || {};
      // 榜单列表 10 分钟缓存（topListsCache 此前声明未接线，每次进排行榜页都打插件）：
      // 榜单列表一天只变几次，短缓存对用户无感
      const ck = `toplists:${targetPlugin}`;
      const hit = topListsCache.get(ck);
      if (hit && Date.now() - hit.ts < TOPLIST_CACHE_TTL) {
        return res.json({ success: true, data: hit.data });
      }
      const result = await runPlugin(targetPlugin, 'getTopLists', [], userVars, ctx.PLUGINS_DIR);
      topListsCache.set(ck, { ts: Date.now(), data: result });
      res.json({ success: true, data: result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  app.get('/api/toplist/:toplistId', async (req, res) => {
    const { toplistId } = req.params;
    const { page = 1, plugin, sourceType = 'toplist' } = req.query;
    const targetPlugin = normalizePlugin(plugin);

    if (!targetPlugin) {
      return res.json({ success: false, error: 'No plugin installed' });
    }

    try {
      const userVars = userConfigs.default || {};
      // 根据 sourceType 选择正确的方法：toplist 使用 getTopListDetail，playlist 使用 getMusicSheetInfo
      const isPlaylist = sourceType === 'playlist';
      const method = isPlaylist ? 'getMusicSheetInfo' : 'getTopListDetail';
      let methodArgs;
      if (isPlaylist) {
        methodArgs = [{ id: toplistId }, parseInt(page)];
      } else {
        // 榜单详情需要完整榜单项：bilibili（id 即接口子路径）、QQ（依赖 period 周期字段）等插件的
        // getTopListDetail 依赖 getTopLists 返回的完整对象字段，只传 {id,title} 会 404/空列表。
        // 先从 getTopLists（带缓存）找回 id 匹配的完整对象，找不到再用 {id, title} 兜底。
        let topListItem = { id: toplistId, title: toplistId };
        try {
          const ck = `toplists:${targetPlugin}`;
          const cached = topListsCache.get(ck);
          let lists;
          if (cached && Date.now() - cached.ts < TOPLIST_CACHE_TTL) {
            lists = cached.data;
          } else {
            lists = await runPlugin(targetPlugin, 'getTopLists', [], userVars, ctx.PLUGINS_DIR);
            topListsCache.set(ck, { ts: Date.now(), data: lists });
          }
          const groups = Array.isArray(lists) ? lists : (lists && Array.isArray(lists.data) ? [lists] : []);
          for (const g of groups) {
            const found = (g && Array.isArray(g.data) ? g.data : []).find((t) => t && String(t.id) === toplistId);
            if (found) { topListItem = found; break; }
          }
        } catch (e) {
          logger.warn('MUSIC', req.reqId, '榜单详情 getTopLists 预取失败', { plugin: targetPlugin, toplistId, error: e && e.message });
        }
        methodArgs = [topListItem, parseInt(page)];
      }
      const result = await runPlugin(targetPlugin, method, methodArgs, userVars, ctx.PLUGINS_DIR);
      res.json({ success: true, data: result });
    } catch (err) {
      // 诊断：打印实际传给插件的榜单项与上游请求详情（status/url），便于定位 404 类失败
      logger.warn('MUSIC', req.reqId, '榜单详情失败', {
        plugin: targetPlugin,
        toplistId,
        item: JSON.stringify(methodArgs[0]).slice(0, 200),
        status: err.response && err.response.status,
        url: err.config && err.config.url,
        error: err.message
      });
      res.json({ success: false, error: err.message });
    }
  });

  // ==================== 热门歌单 ====================

  // 获取热门歌单标签
  app.get('/api/recommend-tags', async (req, res) => {
    const { plugin } = req.query;
    const targetPlugin = normalizePlugin(plugin);

    if (!targetPlugin) {
      return res.json({ success: false, error: 'No plugin installed' });
    }

    try {
      const userVars = userConfigs.default || {};
      const result = await runPlugin(targetPlugin, 'getRecommendSheetTags', [], userVars, ctx.PLUGINS_DIR);

      res.json({ success: true, data: result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 获取热门歌单列表（支持 GET 和 POST）
  async function handleRecommendSheets(req, res) {
    // 从查询参数或请求体中获取参数
    const page = req.body?.page || req.query.page || 1;
    const plugin = req.body?.plugin || req.query.plugin;
    const tagFromQuery = req.query.tag;
    const tagFromBody = req.body?.tag;
    const targetPlugin = normalizePlugin(plugin);

    if (!targetPlugin) {
      return res.json({ success: false, error: 'No plugin installed' });
    }

    try {
      const userVars = userConfigs.default || {};
      // 优先使用请求体中的完整标签对象
      // 注意：当 id 是空字符串时，也应该传递，因为插件需要知道这是"默认"标签
      let tagObj;
      if (tagFromBody) {
        tagObj = tagFromBody;
      } else if (tagFromQuery !== undefined) {
        // 从查询参数获取标签 id，实时获取标签列表
        try {
          const tagsResult = await runPlugin(targetPlugin, 'getRecommendSheetTags', [], userVars, ctx.PLUGINS_DIR);
          if (tagsResult && typeof tagsResult === 'object') {
            // 在 pinned 标签中查找
            if (tagsResult.pinned && Array.isArray(tagsResult.pinned)) {
              const found = tagsResult.pinned.find(t => t.id === tagFromQuery);
              if (found) {
                tagObj = found;
              }
            }
            // 在 data 分组标签中查找
            if (!tagObj && tagsResult.data && Array.isArray(tagsResult.data)) {
              for (const group of tagsResult.data) {
                if (group.data && Array.isArray(group.data)) {
                  const found = group.data.find(t => t.id === tagFromQuery);
                  if (found) {
                    tagObj = found;
                    break;
                  }
                }
              }
            }
          }
          // 如果没找到，使用 id 创建一个基本标签对象
          if (!tagObj) {
            tagObj = { id: tagFromQuery };
          }
        } catch {
          tagObj = { id: tagFromQuery };
        }
      }

      // 如果没有提供任何标签（既不是空字符串也不是具体标签），才获取默认标签
      if (tagObj === undefined) {
        try {
          // 实时获取标签列表
          const tagsResult = await runPlugin(targetPlugin, 'getRecommendSheetTags', [], userVars, ctx.PLUGINS_DIR);
          // 处理标准格式 { pinned: [], data: [] }
          if (tagsResult && typeof tagsResult === 'object') {
            let tagsData = tagsResult;
            // 如果存在 data 字段，使用 data
            if (tagsResult.data && Array.isArray(tagsResult.data)) {
              tagsData = tagsResult.data;
            }

            // 尝试从 pinned 或 data 中获取第一个标签
            if (tagsResult.pinned && Array.isArray(tagsResult.pinned) && tagsResult.pinned.length > 0) {
              tagObj = tagsResult.pinned[0];
            } else if (Array.isArray(tagsData) && tagsData.length > 0) {
              const firstGroup = tagsData[0];
              if (firstGroup && Array.isArray(firstGroup.data) && firstGroup.data.length > 0) {
                tagObj = firstGroup.data[0];
              } else if (firstGroup && firstGroup.id) {
                tagObj = firstGroup;
              }
            }
          }
        } catch { /* Ignore tag error */ }
      }
      const result = await runPlugin(targetPlugin, 'getRecommendSheetsByTag', [tagObj, parseInt(page)], userVars, ctx.PLUGINS_DIR, req.reqId);
      // 确保返回的数据格式正确
      if (!result) {
        return res.json({ success: true, data: { isEnd: true, data: [] } });
      }
      if (result.isEnd !== false) {
        result.isEnd = true;
      }
      if (!result.data) {
        result.data = [];
      }

      res.json({ success: true, data: result });
    } catch {
      // 插件调用失败时返回空数据，参考源码处理方式
      res.json({ success: true, data: { isEnd: true, data: [] } });
    }
  }

  app.get('/api/recommend-sheets', handleRecommendSheets);
  app.post('/api/recommend-sheets', handleRecommendSheets);

  // 获取歌单详情
  app.get('/api/sheet/:sheetId', async (req, res) => {
    const { sheetId } = req.params;
    const { page = 1, plugin } = req.query;
    const targetPlugin = normalizePlugin(plugin);

    if (!targetPlugin) {
      return res.json({ success: false, error: 'No plugin installed' });
    }

    try {
      const userVars = userConfigs.default || {};
      const result = await runPlugin(targetPlugin, 'getMusicSheetInfo', [{ id: sheetId }, parseInt(page)], userVars, ctx.PLUGINS_DIR, req.reqId);

      // 检查返回的数据是否为空
      const musicList = result?.musicList || result?.songs || result?.tracks || [];
      if (musicList.length === 0) {
        return res.json({ success: true, data: result, isEmpty: true, message: '该歌单暂无歌曲' });
      }

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('API', req.reqId, `Sheet error`, { plugin: targetPlugin, sheetId, error: logger.formatError(error) });
      // 提供更友好的错误信息
      let errorMessage = error.message;
      if (error.message.includes('Cannot read properties of undefined') || error.message.includes('Cannot read property')) {
        errorMessage = '什么都没有';
      }
      res.json({ success: false, error: errorMessage, originalError: error.message });
    }
  });
};
