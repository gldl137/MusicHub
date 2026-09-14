'use strict';

// ==================== 用户数据隔离 API ====================
// 路由归属：/api/my/*（收藏 / 播放历史 / 播放队列 / 播放器状态 / 歌单）

const { logger, frontendLogger, authMiddleware, createReqId } = require('../lib/context');
const ctx = require('../lib/context');
const database = require('../database');
const { db, stripPlayUrlFromMusic } = database;
const { lacksPluginIdentFields, enrichNetworkMusic } = require('../lib/network-enrich');
const { ok, serverError } = require('../lib/respond');
// 网络封面统一落盘缓存（cover/<md5>.webp），与本地封面共享同一份磁盘缓存
const netCoverCache = require('../lib/net-cover-cache');
netCoverCache.useDb(database);
const {
  getUserFavorites, addUserFavorite, isUserFavorite, removeUserFavorite, filterUserFavorites,
  getSongCandidatesByRawId, fixPlayHistoryRow,
  getUserPlayHistory, getUserPlayHistoryTotal, addUserPlayHistory, clearUserPlayHistory, deletePlayHistory,
  refreshPlaylistListsCache,
  getUserPlayQueue, addToUserPlayQueue, saveUserPlayQueue, removeFromUserPlayQueue, clearUserPlayQueue,
  getUserPlayerState, saveUserPlayerState,
  createUserPlaylist, getUserPlaylists, getUserPlaylist, getPlaylistById, updateUserPlaylist, deleteUserPlaylist,
  addSongToUserPlaylist, removeSongFromUserPlaylist, getUserPlaylistSongs
} = database;

module.exports = function (app) {

  /**
   * 动态歌单：实时向插件拉取最新内容（榜单 getTopListDetail / 热门歌单 getMusicSheetInfo，
   * 与排行榜、热门歌单详情页同款调用）。
   * 纯实时、无快照回退：失败返回 null，由调用方按失败处理。
   */
  /**
   * 同音源兜底：主插件拉取失败时，尝试同一音源目录下的其他插件文件
   * （如 QQ音乐/QQ_猫.js ↔ 弥音QQ.js）。同音源插件共用同一套数据源 id 体系，
   * 直接用相同 id + 相同方法重试；绝不跨到其他音源。
   * @returns {Promise<{plugin: string, musicList: Array}|null>}
   */
  async function trySameGroupFallback(ctx, platform, isPlaylist, sourceToplistId, userVars) {
    let siblings = [];
    try {
      const path = require('path');
      const fs = require('fs');
      const dir = path.dirname(path.join(ctx.PLUGINS_DIR, platform));
      if (fs.existsSync(dir)) {
        siblings = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== platform);
      }
    } catch { return null; }
    for (const p of siblings.slice(0, 3)) {
      try {
        let musicList = null;
        if (isPlaylist) {
          const result = await ctx.runPlugin(p, 'getMusicSheetInfo', [{ id: sourceToplistId }, 1], userVars, ctx.PLUGINS_DIR, 'playlist-live-source', false, 30000);
          musicList = result && Array.isArray(result.musicList) ? result.musicList : null;
        } else {
          let topListItem = { id: sourceToplistId, title: '' };
          try {
            const lists = await ctx.runPlugin(p, 'getTopLists', [], userVars, ctx.PLUGINS_DIR, 'playlist-live-source', false, 0);
            const groups = Array.isArray(lists) ? lists : (lists && Array.isArray(lists.data) ? [lists] : []);
            for (const g of groups) {
              const found = (g && Array.isArray(g.data) ? g.data : []).find((t) => t && String(t.id) === sourceToplistId);
              if (found) { topListItem = found; break; }
            }
          } catch { /* 该插件失败，尝试下一个 */ }
          const result = await ctx.runPlugin(p, 'getTopListDetail', [topListItem, 1], userVars, ctx.PLUGINS_DIR, 'playlist-live-source', false, 0);
          musicList = result && Array.isArray(result.musicList) ? result.musicList : null;
        }
        if (musicList && musicList.length > 0) {
          logger.warn('PLAYLIST', createReqId(), '动态歌单主插件失败，已切换同音源备用插件', { fallbackPlugin: p, songs: musicList.length });
          return { plugin: p, musicList };
        }
      } catch { /* 该插件失败，尝试下一个 */ }
    }
    return null;
  }

  // 动态歌单实时拉取短缓存（与 REST 侧 opensubsonic.livePlaylistCache 同语义）：
  // 网页打开动态歌单、翻返回重进、toplist-status 与详情先后请求，60s 内不再重复打插件
  const liveSourceCache = new Map(); // `${type}|${platform}|${id}` -> { ts, songs }
  const LIVE_SOURCE_TTL = 60 * 1000;
  const LIVE_SOURCE_MAX = 50;

  function liveSourceCacheGet(ck) {
    const hit = liveSourceCache.get(ck);
    if (hit && Date.now() - hit.ts < LIVE_SOURCE_TTL) return hit.songs;
    if (hit) liveSourceCache.delete(ck);
    return null;
  }

  function liveSourceCacheSet(ck, songs) {
    liveSourceCache.set(ck, { ts: Date.now(), songs });
    for (const [k, v] of liveSourceCache) {
      if (Date.now() - v.ts >= LIVE_SOURCE_TTL) liveSourceCache.delete(k);
    }
    while (liveSourceCache.size > LIVE_SOURCE_MAX) {
      let oldestKey = null, oldestTs = Infinity;
      for (const [k, v] of liveSourceCache) { if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; } }
      if (oldestKey == null) break;
      liveSourceCache.delete(oldestKey);
    }
  }

  /**
   * 动态歌单：实时向插件拉取最新内容（榜单 getTopListDetail / 热门歌单 getMusicSheetInfo，
   * 与排行榜、热门歌单详情页同款调用）。命中 60s 缓存直接返回。
   * 纯实时、无快照回退：失败返回 null，由调用方按失败处理。
   * 主插件失败时自动切换**同音源**的其他插件兜底（数据仍来自同一音源，绝不跨音源）。
   */
  async function fetchLiveSourceSongs(sourceType, sourcePlatform, sourceToplistId) {
    const ck = `${sourceType}|${sourcePlatform}|${sourceToplistId}`;
    const cached = liveSourceCacheGet(ck);
    if (cached) return cached;
    let songs = null;
    let usedPlugin = sourcePlatform;
    try {
      const userVars = (ctx.userConfigs && ctx.userConfigs.default) || {};
      const isPlaylist = sourceType === 'playlist';
      // 落雪（LX）实时歌单：platform 形如 lx:kg，走 lxmusic 内置 SDK（与 LX 专区详情页同款调用）；
      // LX 无「插件」概念，同音源兜底不适用
      const isLxSource = /^lx:/i.test(String(sourcePlatform || ''));
      if (isLxSource) {
        const lxSource = String(sourcePlatform).slice(3);
        const lx = require('../lxmusic');
        const r = isPlaylist
          ? await lx.getSongListDetail(lxSource, sourceToplistId, 1)
          : await lx.getBoardSongs(lxSource, sourceToplistId, 1);
        if (r && Array.isArray(r.list) && r.list.length > 0) {
          songs = r.list;
        }
      } else if (isPlaylist) {
        const result = await ctx.runPlugin(sourcePlatform, 'getMusicSheetInfo', [{ id: sourceToplistId }, 1], userVars, ctx.PLUGINS_DIR, 'playlist-live-source', false, 30000);
        if (result && Array.isArray(result.musicList) && result.musicList.length > 0) {
          songs = result.musicList;
        }
      } else {
        // 榜单详情需要完整榜单项（QQ 等插件接口依赖 period 周期字段，只传 id 会返回空列表）：
        // 先 getTopLists 找回 id 匹配的完整对象，找不到再用 {id, title:''} 兜底
        let topListItem = { id: sourceToplistId, title: '' };
        try {
          const lists = await ctx.runPlugin(sourcePlatform, 'getTopLists', [], userVars, ctx.PLUGINS_DIR, 'playlist-live-source', false, 0);
          const groups = Array.isArray(lists) ? lists : (lists && Array.isArray(lists.data) ? [lists] : []);
          for (const g of groups) {
            const found = (g && Array.isArray(g.data) ? g.data : []).find((t) => t && String(t.id) === sourceToplistId);
            if (found) { topListItem = found; break; }
          }
        } catch (e) {
          logger.warn('PLAYLIST', createReqId(), '动态歌单 getTopLists 预取失败', { sourcePlatform, sourceToplistId, error: e && e.message });
        }
        const result = await ctx.runPlugin(sourcePlatform, 'getTopListDetail', [topListItem, 1], userVars, ctx.PLUGINS_DIR, 'playlist-live-source', false, 0);
        if (result && Array.isArray(result.musicList) && result.musicList.length > 0) {
          songs = result.musicList;
        }
      }
      // 主插件失败：同音源兜底——只尝试同一音源目录下的其他插件（id 体系一致），
      // 数据仍来自同一音源（QQ 只从 QQ、酷狗只从酷狗），绝不跨音源
      if (!songs && !isLxSource) {
        const fb = await trySameGroupFallback(ctx, sourcePlatform, isPlaylist, sourceToplistId, userVars);
        if (fb && fb.musicList && fb.musicList.length) {
          songs = fb.musicList;
          usedPlugin = fb.plugin;
        }
      }
      if (songs && Array.isArray(songs) && songs.length > 0) {
        // 统一限制：动态歌单最多展示前 100 首
        // 剥离插件原始的专辑/歌手 id 与 parent（REST/前端无法解析外站原始 id），由 toChild 合成虚拟 id
        const normalized = songs.slice(0, 100).map((s) => {
          const { albumId: _stripAl, artistId: _stripAr, parent: _stripP, ...rest } = s || {};
          return {
            ...rest,
            // id 规范化为字符串（QQ 插件返回数字 id）；时长缺失补 0
            id: String(rest.id ?? ''),
            duration: Number(rest.duration) || 0,
            plugin: rest.plugin || rest.platform || usedPlugin,
            platform: rest.platform || rest.plugin || usedPlugin
          };
        });
        liveSourceCacheSet(ck, normalized);
        return normalized;
      }
      logger.warn('PLAYLIST', createReqId(), '动态歌单实时拉取为空（含同音源兜底）', { sourceType, sourcePlatform, sourceToplistId });
    } catch (e) {
      logger.warn('PLAYLIST', createReqId(), '动态歌单实时拉取失败', { error: e.message, sourceType, sourcePlatform, sourceToplistId });
    }
    return null;
  }

  /**
   * 歌单无自带封面时，用歌单内第一首歌的封面作为兜底。
   * 优先用歌曲直接的封面 URL/路径；网络歌曲只有虚拟封面 ID（coverArt），
   * 需经 /api/cover?id=<coverArt> 在同端点实时解析（不暴露时效性外网地址）。
   * @param {number} ownerId 歌单归属者 userId（公开歌单须用 owner，否则按 viewer 查不到歌曲）
   * @param {number} playlistId
   * @returns {Promise<string>} 封面 URL，拿不到则返回 ''
   */
  async function resolvePlaylistCoverUrl(ownerId, playlistId) {
    try {
      const songs = await getUserPlaylistSongs(ownerId, playlistId);
      if (Array.isArray(songs) && songs.length > 0) {
        const s = songs[0];
        const direct = String(s.cover || s.artwork || s.pic || '').trim();
        if (direct && (/^https?:\/\//i.test(direct) || direct.startsWith('/'))) return direct;
        const coverArt = String(s.coverArt || '').trim();
        if (coverArt) return `/api/cover?id=${encodeURIComponent(coverArt)}`;
      }
    } catch (e) { /* 忽略：兜底失败则上层回退默认占位图 */ }
    return '';
  }

  // ==================== 列表封面落盘缓存 ====================
  // 收藏 / 播放历史 / 播放队列入库时都被 stripPlayUrlFromMusic 剥掉了时效性封面地址
  // （artwork/cover/pic 全删），这里把封面下载并转 WebP 落到磁盘
  // （cache/netcover/<图片MD5>.webp，独立子目录，不会被本地封面孤儿清理误删），
  // 只把「本地静态地址」写进响应（绝不落库，避免 URL 过期 403）。
  //
  // 关键修复：旧条件 `!s.artwork && !s.cover && !s.coverArt` 恒为假——DB 映射永远会带
  // coverArt（coverArt: row.song_id），导致这段落盘缓存代码从未生效，前端只能每次经
  // /api/cover?id= 实时向插件取封面（慢的根源）。现在改为对封面一律尝试落盘。
  //
  // 策略：命中「歌曲→磁盘 rel」缓存直接返回本地静态地址；未命中则排入后台补（不阻塞本次响应）。
  // 于是首屏永不被 N 次插件调用/下载拖慢，而封面会越用越全、再次进入即秒开。
  const COVER_FILL_CONCURRENCY = 4;            // 后台补封面并发
  const COVER_FILL_TTL = 30 * 60 * 1000;       // 插件封面 URL 缓存
  const COVER_FILL_MISS_TTL = 30 * 60 * 1000; // 失败冷却加长：批量失败（如插件接口异常）时不反复重试刷日志
  const COVER_LOCAL_TTL = 24 * 60 * 60 * 1000; // 歌曲→磁盘 rel 复用窗口
  const coverFillCache = new Map();            // `${plugin}|${id}` -> { url, ts }
  const coverLocalCache = new Map();           // `${plugin}|${id}` -> { rel, ts }
  const coverWarmQueue = [];
  const coverWarmInflight = new Set();
  const coverWarmQueued = new Set();
  let coverWarmRunning = false;
  const COVER_SYNC_WARM = 12;            // 首屏前 N 张同步落盘，保证响应即带本地地址（浏览器可缓存）
  const COVER_MISS_TTL = 10 * 60 * 1000; // 落盘失败 URL 的冷却窗口，避免每次请求都重试下载
  const coverMissCache = new Map();      // url -> ts（落盘失败短暂跳过）
  // 封面辅助插件（酷我封面专用）：本插件 getMusicInfo 拿不到封面时按「标题+歌手」搜索补全
  const AUX_COVER_PLUGIN = '酷我封面获取.js';

  /** 稳定标识：非本地歌曲的 `${plugin}|${id}`；不满足返回 null */
  function coverKey(song) {
    const plugin = song.plugin || song.source || song.platform;
    const id = song.id;
    return (plugin && plugin !== 'local' && id) ? `${plugin}|${id}` : null;
  }

  // 库里留存的「直链封面字段」：不受 lx:xx 影响、无需联网即可拿到 URL 落盘。
  // 注意 stripPlayUrlFromMusic 只删了 artwork/cover/pic/image/coverUrl 等，img / coverImg 仍保留：
  //   - 落雪（LX）歌曲：直链留在 img（如 http://img1.kuwo.cn/...、https://y.gtimg.cn/...）
  //   - MF 插件歌曲：直链常留在 coverImg
  const COVER_URL_KEYS = ['img', 'coverImg', 'artwork', 'cover', 'pic', 'image', 'coverUrl', 'cover_url', 'albumPic'];
  function storedCoverUrl(song) {
    if (!song) return '';
    for (const k of COVER_URL_KEYS) {
      const v = song[k];
      if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) return v.trim();
    }
    return '';
  }

  /** 插件兜底：向插件 getMusicInfo 取封面 URL（仅 MF 插件有效；lx:xx 无此能力返回 null） */
  async function fetchCoverUrl(song) {
    const plugin = song.plugin || song.source || song.platform;
    const id = song.id;
    if (!plugin || plugin === 'local' || !id) return null;
    const key = `${plugin}|${id}`;
    const cached = coverFillCache.get(key);
    if (cached && Date.now() - cached.ts < (cached.url ? COVER_FILL_TTL : COVER_FILL_MISS_TTL)) {
      return cached.url;
    }
    let url = null;
    try {
      const userVars = (ctx.userConfigs && ctx.userConfigs.default) || {};
      const info = await ctx.runPlugin(
        plugin,
        'getMusicInfo',
        [{ ...song, id }],
        userVars,
        ctx.PLUGINS_DIR,
        'my-list-cover',
        false,
        8000
      );
      const u = info && (info.artwork || info.pic || info.cover || info.image);
      if (u && /^https?:\/\//i.test(String(u))) url = String(u);
    } catch (e) { url = null; }
    // 辅助兜底：本插件没有返回封面（如部分酷我插件版本不返回封面字段）时，
    // 用「酷我封面获取」辅助插件按「标题+歌手」搜索酷我补全；结果同样进 coverFillCache 缓存
    if (!url && plugin !== AUX_COVER_PLUGIN) {
      try {
        const { resolvePluginFilePath } = require('../MusicFree/runner');
        const auxPath = resolvePluginFilePath(ctx.PLUGINS_DIR, AUX_COVER_PLUGIN);
        // resolvePluginFilePath 找不到文件时也会兜底返回首个候选路径，需 existsSync 双重确认
        if (auxPath && require('fs').existsSync(auxPath)) {
          const userVars = (ctx.userConfigs && ctx.userConfigs.default) || {};
          const info = await ctx.runPlugin(
            AUX_COVER_PLUGIN,
            'getMusicInfo',
            [{ ...song, id }],
            userVars,
            ctx.PLUGINS_DIR,
            'my-list-cover',
            false,
            8000
          );
          const u = info && (info.artwork || info.pic || info.cover || info.image);
          if (u && /^https?:\/\//i.test(String(u))) url = String(u);
        }
      } catch (e) { /* 辅助插件失败不影响主链路 */ }
    }
    coverFillCache.set(key, { url, ts: Date.now() });
    return url;
  }

  /** 命中「歌曲→磁盘缓存」且文件仍在时，返回本地静态封面地址；否则 null 并清理失效项 */
  function localCoverUrl(song) {
    const key = coverKey(song);
    if (!key) return null;
    const hit = coverLocalCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.ts > COVER_LOCAL_TTL || !netCoverCache.diskFileFor(hit.rel)) {
      coverLocalCache.delete(key);
      return null;
    }
    return `/api/cover?rel=${encodeURIComponent(hit.rel)}`;
  }

  /** 下载一张远程封面并转 WebP 落盘；成功则记入内存 rel 缓存并返回本地地址，失败记冷却返回 null */
  async function localizeToDisk(song, url) {
    const key = coverKey(song);
    if (!key || !url) return null;
    const localized = await netCoverCache.fetchAndLocalize(url);
    if (!localized) {
      coverMissCache.set(url, Date.now());
      return null;
    }
    coverMissCache.delete(url);
    coverLocalCache.set(key, { rel: localized.relpath, ts: Date.now() });
    return `/api/cover?rel=${encodeURIComponent(localized.relpath)}`;
  }

  /** 后台补一张封面：优先用传入直链（song._coverUrl），否则向插件取 URL */
  async function warmCover(song) {
    const key = coverKey(song);
    if (!key || coverWarmInflight.has(key)) return;
    coverWarmInflight.add(key);
    try {
      const url = song._coverUrl || await fetchCoverUrl(song);
      if (!url) return;
      await localizeToDisk(song, url);
    } catch { /* 单张失败忽略 */ } finally {
      coverWarmInflight.delete(key);
    }
  }

  /** 后台限并发泵：逐个处理待补封面，绝不阻塞请求 */
  async function pumpCoverWarm() {
    if (coverWarmRunning) return;
    coverWarmRunning = true;
    try {
      const workers = Array.from({ length: COVER_FILL_CONCURRENCY }, async () => {
        for (;;) {
          const item = coverWarmQueue.shift();
          if (!item) return;
          coverWarmQueued.delete(item.key);
          await warmCover(item.song);
        }
      });
      await Promise.all(workers);
    } finally { coverWarmRunning = false; }
  }

  function enqueueCoverWarm(song) {
    const key = coverKey(song);
    if (!key || coverWarmInflight.has(key) || coverWarmQueued.has(key)) return;
    if (localCoverUrl(song)) return; // 已有磁盘缓存，无需再补
    coverWarmQueued.add(key);
    coverWarmQueue.push({ key, song });
    pumpCoverWarm();
  }

  /**
   * 列表封面：让「我的播放 / 我的收藏 / 播放队列 / 歌单」的封面全部落到磁盘缓存
   * （cache/netcover/<md5>.webp），响应直接返回本地静态地址 /api/cover?rel=...，
   * 浏览器据此长期缓存，之后打开列表不再重新拉图。
   *
   * 逐首处理顺序：
   *   1) 内存已有 rel 且文件仍在 → 直接返回（零 IO，最快）；
   *   2) 库里有直链封面字段（img / coverImg…）→ 查磁盘索引（零联网）命中即返回；
   *   3) 首屏前 COVER_SYNC_WARM 张（有直链的）→ 同步下载转码落盘，保证本次响应就带本地地址；
   *   4) 其余全部排入后台补（有直链用直链，没有则插件 getMusicInfo 兜底）。
   * @param {Array} songs
   * @returns {Promise<Array>}
   */
  async function fillCovers(songs) {
    if (!Array.isArray(songs) || !songs.length) return songs;
    // 复制数组再改：database 层用 memGetOrLoad 缓存了同一个数组/对象，直接写会污染缓存
    const out = songs.slice();
    const pending = []; // { i, song, url }
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      if (!s || !coverKey(s)) continue;
      const cur = String(s.artwork || s.cover || '');
      if (cur.includes('/api/cover?rel=')) continue; // 已是磁盘缓存地址

      const local = localCoverUrl(s);
      if (local) {
        out[i] = { ...s, artwork: local, cover: local };
        continue;
      }

      const url = storedCoverUrl(s);
      if (url) {
        try {
          const cached = await netCoverCache.cachedForUrl(url); // 持久索引：文件已在磁盘则零联网命中
          if (cached) {
            coverLocalCache.set(coverKey(s), { rel: cached.relpath, ts: Date.now() });
            const u = `/api/cover?rel=${encodeURIComponent(cached.relpath)}`;
            out[i] = { ...s, artwork: u, cover: u };
            continue;
          }
        } catch { /* 索引读取失败则退回后台补 */ }
      }
      pending.push({ i, song: s, url });
    }

    if (pending.length) {
      // 步骤 3：首屏前若干张同步落盘（仅取有直链且未处于失败冷却的），让本次响应即带本地地址
      const syncList = pending
        .filter((p) => p.url && !coverMissCache.has(p.url))
        .slice(0, COVER_SYNC_WARM);
      if (syncList.length) {
        let cursor = 0;
        const workers = Array.from({ length: Math.min(COVER_FILL_CONCURRENCY, syncList.length) }, async () => {
          for (;;) {
            const k = cursor++;
            if (k >= syncList.length) return;
            const p = syncList[k];
            let u = null;
            try { u = await localizeToDisk(p.song, p.url); } catch { u = null; }
            if (u) out[p.i] = { ...out[p.i], artwork: u, cover: u };
          }
        });
        await Promise.all(workers);
      }
      // 其余封面不批量后台预热：仅按需落盘——前端只对可视区行请求 /api/cover，
      // 后端在单曲请求路径上实时取封面并落盘，避免一次拉取整张列表的封面（流量/请求量浪费）
    }
    return out;
  }

  /** 加入收藏 / 记录播放历史 / 入播放队列时提前预热，下次进列表即可命中磁盘缓存 */
  function warmCoverFor(song, plugin) {
    if (!song || !plugin || plugin === 'local') return;
    const merged = { ...song, plugin, id: song.id || song.musicId };
    const url = storedCoverUrl(song); // 加入时插件刚返回的直链通常就在这些字段里
    enqueueCoverWarm(url ? { ...merged, _coverUrl: url } : merged);
  }

  // 获取当前用户的收藏
  app.get('/api/my/favorites', authMiddleware, async (req, res) => {
    try {
      const favorites = await fillCovers(await getUserFavorites(req.user.userId));
      res.json({ success: true, data: favorites });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 添加收藏
  app.post('/api/my/favorites', authMiddleware, async (req, res) => {
    const { music, plugin } = req.body;
    if (!music || !plugin) {
      return res.json({ success: false, error: '参数错误' });
    }
    try {
      const result = await addUserFavorite(req.user.userId, music, plugin);
      warmCoverFor(music, plugin); // 提前预热封面，收藏列表再次进入秒开

      // 记录前台日志 - 添加收藏
      frontendLogger.info('FAVORITE', 'Favorite added', { title: music?.title, artist: music?.artist, plugin });

      res.json({ success: true, data: result });
    } catch (err) {
      frontendLogger.error('FAVORITE', 'Favorite add failed', { title: music?.title, error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 检查是否已收藏
  app.get('/api/my/favorites/check', authMiddleware, async (req, res) => {
    const { musicId, plugin } = req.query;
    if (!musicId || !plugin) {
      return res.json({ success: false, error: '参数错误' });
    }
    try {
      const isFav = await isUserFavorite(req.user.userId, musicId, plugin);
      res.json({ success: true, data: { isFavorite: isFav } });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 批量收藏状态检查：歌单/列表场景一次返回所有歌曲收藏状态，避免前端逐首发起 N 条 GET 抢占连接池。
  // 后端侧再合并：N 条逐条查询 → 一条 OR 合并 SQL + 少量兜底（filterUserFavorites）
  app.post('/api/my/favorites/check-batch', authMiddleware, async (req, res) => {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    const data = {};
    if (!items.length) {
      return res.json({ success: true, data });
    }
    try {
      const favMap = await filterUserFavorites(req.user.userId, items);
      favMap.forEach((v, k) => { data[k] = v; });
      res.json({ success: true, data });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 取消收藏
  app.delete('/api/my/favorites/:musicId', authMiddleware, async (req, res) => {
    const { musicId } = req.params;
    const { plugin } = req.query;
    if (!plugin) {
      return res.json({ success: false, error: '参数错误' });
    }
    try {
      const result = await removeUserFavorite(req.user.userId, musicId, plugin);

      // 记录前台日志 - 取消收藏
      frontendLogger.info('FAVORITE', 'Favorite removed', { musicId, plugin });

      res.json({ success: true, data: result });
    } catch (err) {
      frontendLogger.error('FAVORITE', 'Favorite remove failed', { musicId, error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 获取当前用户的播放历史（分页：?limit=&offset=；返回 total 供前端分页）
  app.get('/api/my/play-history', authMiddleware, async (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    try {
      const [rawHistory, total] = await Promise.all([
        getUserPlayHistory(req.user.userId, limit, offset),
        getUserPlayHistoryTotal(req.user.userId)
      ]);

      // 规范化插件字段（存量坏记录修复）：REST 客户端（箭头等）记录的历史可能带已卸载/改名的
      // 旧插件名（songs 缓存同 raw id 多行时命中旧行），web 播放会报「无法识别音源（缺少 platform 字段）」。
      // 这里把无效 plugin 的歌曲改指到同 raw id 下「当前已安装」的插件行（同一音源的现行插件）。
      try {
        const installed = new Set(ctx.listPluginNames());
        const isValidPlugin = (p) => installed.has(String(p)) || installed.has(String(p).replace(/\.js$/i, ''));
        for (let i = 0; i < rawHistory.length; i++) {
          const s = rawHistory[i];
          if (!s || !s.plugin || s.plugin === 'local' || s.plugin === 'radio') continue;
          if (/^lx:/i.test(String(s.plugin))) continue; // LX 歌曲不在 MF 插件列表，原样保留
          if (isValidPlugin(s.plugin)) continue;
          const cands = await getSongCandidatesByRawId(s.id != null ? String(s.id) : '');
          const valid = cands.find((c) => isValidPlugin(c.plugin));
          if (valid) {
            rawHistory[i] = {
              ...valid,
              playedAt: s.playedAt,
              playbackPosition: s.playbackPosition,
              playbackDevice: s.playbackDevice,
              playCount: s.playCount,
              coverArt: valid.coverArt || valid.virtualId || s.coverArt
            };
            // 就地回写历史行（旧插件名 → 现役插件）：此后该行与正常播放记录一致，
            // 再次播放时 upsert 命中同一行，不会在「最近播放」里产生重复条目
            if (s._histId) {
              fixPlayHistoryRow(req.user.userId, s._histId, valid, valid.plugin).catch(() => {});
            }
          }
        }
      } catch (e) {
        logger.warn('PLAYLIST', createReqId(), 'play-history plugin normalization failed', { error: e && e.message });
      }

      const history = await fillCovers(rawHistory);
      ok(res, history, { total });
    } catch (err) {
      serverError(res, err.message);
    }
  });

  // 添加播放历史
  app.post('/api/my/play-history', authMiddleware, async (req, res) => {
    const { music, plugin, position } = req.body;
    if (!music || !plugin) {
      return res.json({ success: false, error: '参数错误' });
    }
    try {
      const result = await addUserPlayHistory(req.user.userId, music, plugin, { position });
      warmCoverFor(music, plugin); // 提前预热封面，播放历史再次进入秒开
      res.json({ success: true, data: result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 清除播放历史
  app.delete('/api/my/play-history', authMiddleware, async (req, res) => {
    try {
      const result = await clearUserPlayHistory(req.user.userId);
      res.json({ success: true, data: result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 删除单条播放历史（按 musicId + plugin 删除当前用户的一条记录）
  app.delete('/api/my/play-history/item', authMiddleware, async (req, res) => {
    const { musicId, plugin } = req.query;
    if (!musicId || !plugin) {
      return res.json({ success: false, error: '参数错误' });
    }
    try {
      const result = await deletePlayHistory(musicId, plugin, req.user.userId);
      res.json({ success: true, data: result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ==================== 用户隔离播放队列 API ====================

  // 获取当前用户的播放队列（封面命中磁盘缓存直接返回本地地址，见 fillCovers 说明）
  app.get('/api/my/play-queue', authMiddleware, async (req, res) => {
    try {
      const queue = await fillCovers(await getUserPlayQueue(req.user.userId));
      res.json({ success: true, data: queue });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 添加歌曲到播放队列
  app.post('/api/my/play-queue', authMiddleware, async (req, res) => {
    const { music, plugin } = req.body;
    if (!music || !plugin) {
      return res.json({ success: false, error: '参数错误' });
    }
    try {
      const result = await addToUserPlayQueue(req.user.userId, music, plugin);
      warmCoverFor(music, plugin); // 提前预热封面
      res.json({ success: true, data: result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 保存整个播放队列（替换）
  app.put('/api/my/play-queue', authMiddleware, async (req, res) => {
    const { songs } = req.body;
    if (!Array.isArray(songs)) {
      return res.json({ success: false, error: '参数错误：songs必须是数组' });
    }
    try {
      const result = await saveUserPlayQueue(req.user.userId, songs);
      res.json({ success: true, data: result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 从播放队列中移除歌曲
  app.delete('/api/my/play-queue', authMiddleware, async (req, res) => {
    const { musicId, plugin } = req.query;
    if (!musicId || !plugin) {
      return res.json({ success: false, error: '参数错误' });
    }
    try {
      const result = await removeFromUserPlayQueue(req.user.userId, musicId, plugin);
      res.json({ success: true, data: result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 清空播放队列
  app.delete('/api/my/play-queue/all', authMiddleware, async (req, res) => {
    try {
      const result = await clearUserPlayQueue(req.user.userId);
      res.json({ success: true, data: result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ==================== 用户隔离播放器状态 API ====================

  // 获取播放器状态
  app.get('/api/my/player-state', authMiddleware, async (req, res) => {
    try {
      const state = await getUserPlayerState(req.user.userId);
      res.json({ success: true, data: state });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 保存播放器状态：秒级去抖落库。
  // 前端进度上报频率较高（数秒一次 + 换歌触发），每笔都 UPSERT fsync 写库开销大；
  // 同用户 1s 内的多笔合并为最后一笔（播放器状态是续播便利数据，丢最近 1s 无实质影响）
  const playerStatePending = new Map(); // userId -> { state, timer }
  const PLAYER_STATE_DEBOUNCE_MS = 1000;
  app.post('/api/my/player-state', authMiddleware, async (req, res) => {
    const state = req.body;
    const uid = req.user.userId;
    try {
      const pending = playerStatePending.get(uid);
      if (pending) {
        pending.state = state; // 只保留最新状态
      } else {
        const entry = {
          state,
          timer: setTimeout(async () => {
            const cur = playerStatePending.get(uid);
            playerStatePending.delete(uid);
            if (!cur) return;
            try {
              await saveUserPlayerState(uid, cur.state);
            } catch (e) {
              logger.warn('PLAYER', createReqId(), 'player-state deferred save failed', { error: e && e.message });
            }
          }, PLAYER_STATE_DEBOUNCE_MS),
        };
        if (typeof entry.timer.unref === 'function') entry.timer.unref();
        playerStatePending.set(uid, entry);
      }
      res.json({ success: true, data: null });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ==================== 用户隔离歌单 API ====================

  // 获取当前用户的歌单列表
  app.get('/api/my/playlists', authMiddleware, async (req, res) => {
    try {
      const playlists = await getUserPlaylists(req.user.userId);
      // 无自带封面的歌单，兜底用歌单内第一首歌的封面（不修改持久 cover，仅在返回时附加）
      const data = await Promise.all(playlists.map(async (pl) => {
        const out = { ...pl };
        if (!out.cover) {
          const ownerId = out.userId || req.user.userId;
          const cover = await resolvePlaylistCoverUrl(ownerId, out.id);
          if (cover) out.cover = cover;
        }
        return out;
      }));
      res.json({ success: true, data });
    } catch (err) {
      logger.error('PLAYLIST', createReqId(), 'Get user playlists error', { error: logger.formatError(err), userId: req.user.userId });
      res.json({ success: false, error: err.message });
    }
  });

  // 创建歌单
  app.post('/api/my/playlists', authMiddleware, async (req, res) => {
    const { name, description, cover, source } = req.body;
    if (!name) {
      return res.json({ success: false, error: '歌单名称不能为空' });
    }
    try {
      // source = { type:'toplist', platform, toplistId } 时为动态榜单歌单：
      // 只保存榜单地址，不逐首入库；进入歌单时实时向插件拉取最新榜单
      const playlist = await createUserPlaylist(req.user.userId, name, description, cover, false, source);
      logger.info('PLAYLIST', createReqId(), 'User playlist created', { userId: req.user.userId, playlistId: playlist.id, name });

      // 记录前台日志 - 创建歌单
      frontendLogger.info('PLAYLIST', 'Playlist created', { name });

      res.json({ success: true, data: playlist });
    } catch (err) {
      logger.error('PLAYLIST', createReqId(), 'Create user playlist error', { error: logger.formatError(err), userId: req.user.userId });
      frontendLogger.error('PLAYLIST', 'Playlist create failed', { name, error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 获取歌单详情
  app.get('/api/my/playlists/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
      const playlist = await getPlaylistById(parseInt(id));
      if (!playlist) {
        return res.status(404).json({ success: false, error: '歌单不存在' });
      }
      // 本人、公开歌单、或管理员均可查看
      const isAdmin = req.user.role === 'admin';
      if (playlist.userId !== req.user.userId && !playlist.isPublic && !isAdmin) {
        return res.status(404).json({ success: false, error: '歌单不存在或无权限' });
      }
      // 无自带封面时，兜底用歌单内第一首歌的封面（不修改持久 cover）
      const out = { ...playlist };
      if (!out.cover) {
        const ownerId = out.userId || req.user.userId;
        const cover = await resolvePlaylistCoverUrl(ownerId, out.id);
        if (cover) out.cover = cover;
      }
      res.json({ success: true, data: out });
    } catch (err) {
      logger.error('PLAYLIST', createReqId(), 'Get user playlist error', { error: logger.formatError(err), userId: req.user.userId, playlistId: id });
      res.json({ success: false, error: err.message });
    }
  });

  // 更新歌单
  app.put('/api/my/playlists/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { name, description, cover, sortOrder, public: isPublicPayload, isPublic } = req.body;
    const updates = { name, description, cover, sortOrder };
    if (isPublicPayload !== undefined) updates.isPublic = !!isPublicPayload;
    else if (isPublic !== undefined) updates.isPublic = !!isPublic;
    const isAdmin = req.user.role === 'admin';
    try {
      // 管理员可更新任意歌单；普通用户仅可更新自己的歌单
      const playlist = await getPlaylistById(parseInt(id));
      if (!playlist) {
        return res.status(404).json({ success: false, error: '歌单不存在' });
      }
      const isOwner = playlist.userId === req.user.userId;
      if (!isOwner && !isAdmin) {
        return res.status(404).json({ success: false, error: '歌单不存在或无权限' });
      }
      const result = await updateUserPlaylist(req.user.userId, parseInt(id), updates, !isOwner, playlist.userId, playlist.isPublic);
      if (result.updated === 0) {
        return res.status(404).json({ success: false, error: '歌单不存在或无权限' });
      }
      const byAdmin = isAdmin && !isOwner;
      logger.info('PLAYLIST', createReqId(), 'User playlist updated', { userId: req.user.userId, playlistId: id, byAdmin });

      // 记录前台日志 - 更新歌单
      frontendLogger.info('PLAYLIST', 'Playlist updated', { playlistId: id, name, byAdmin });

      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('PLAYLIST', createReqId(), 'Update user playlist error', { error: logger.formatError(err), userId: req.user.userId, playlistId: id });
      frontendLogger.error('PLAYLIST', 'Playlist update failed', { playlistId: id, error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 删除歌单
  app.delete('/api/my/playlists/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const playlistId = parseInt(id);
    const isAdmin = req.user.role === 'admin';
    try {
      // 先取歌单以确认存在并拿到实际所有者（用于管理员删他人歌单时正确失效缓存）
      const playlist = await getPlaylistById(playlistId);
      if (!playlist) {
        return res.status(404).json({ success: false, error: '歌单不存在' });
      }
      // 本人可删除；管理员拥有完整权限，可删除任意歌单（含他人的共享歌单）
      const isOwner = playlist.userId === req.user.userId;
      if (!isOwner && !isAdmin) {
        return res.status(404).json({ success: false, error: '歌单不存在或无权限' });
      }
      const result = await deleteUserPlaylist(req.user.userId, playlistId, !isOwner, playlist.userId, playlist.isPublic);
      if (result.deleted === 0) {
        return res.status(404).json({ success: false, error: '歌单不存在或无权限' });
      }
      const byAdmin = isAdmin && !isOwner;
      logger.info('PLAYLIST', createReqId(), 'User playlist deleted', { userId: req.user.userId, playlistId, byAdmin });

      // 记录前台日志 - 删除歌单
      frontendLogger.info('PLAYLIST', 'Playlist deleted', { playlistId, byAdmin });

      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('PLAYLIST', createReqId(), 'Delete user playlist error', { error: logger.formatError(err), userId: req.user.userId, playlistId: id });
      frontendLogger.error('PLAYLIST', 'Playlist delete failed', { playlistId: id, error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 获取歌单歌曲（数据由后台“网络歌单定时刷新”保持最新，进入详情页不再触发插件刷新）
  app.get('/api/my/playlists/:id/songs', authMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
      const playlist = await getPlaylistById(parseInt(id));
      if (!playlist) {
        return res.status(404).json({ success: false, error: '歌单不存在' });
      }
      // 本人、公开歌单、或管理员均可查看歌曲
      const isAdmin = req.user.role === 'admin';
      if (playlist.userId !== req.user.userId && !playlist.isPublic && !isAdmin) {
        return res.status(404).json({ success: false, error: '歌单不存在或无权限' });
      }
      // 歌曲归属于创建者（user_id），需用 owner 的 userId 读取（与 OpenSubsonic 路径一致）
      const ownerId = playlist.userId;
      const updatedAt = playlist.updatedAt || playlist.updated_at || null;

      // 动态歌单（实时榜单/实时热门歌单）：只走实时拉取（无快照回退），失败即失败，前端提示后不可进入
      if ((playlist.sourceType === 'toplist' || playlist.sourceType === 'playlist') && playlist.sourcePlatform && playlist.sourceToplistId) {
        const songs = await fetchLiveSourceSongs(playlist.sourceType, playlist.sourcePlatform, playlist.sourceToplistId);
        if (!songs) {
          return res.json({ success: false, error: '实时榜单拉取失败，请稍后重试' });
        }
        // 缓存本次拉取的歌曲数，供列表卡片预取显示（不用为取数量而全量导入）；
        // 顺带刷新歌单列表内存缓存——REST 客户端（箭头等）的 getPlaylists 歌曲数读这里，
        // 不刷新会一直显示 0（网页端走 toplist-status 实时预取所以看不出）
        try {
          await new Promise((resolve, reject) => {
            db.run('UPDATE playlists SET cached_song_count = ? WHERE id = ?', [songs.length, parseInt(id)], (e) => (e ? reject(e) : resolve()));
          });
          refreshPlaylistListsCache(playlist.userId || req.user.userId);
        } catch { /* 计数缓存失败不影响返回 */ }
        return res.json({ success: true, data: songs, source: 'live-toplist', updatedAt: Date.now() });
      }

      const songs = await fillCovers(await getUserPlaylistSongs(ownerId, parseInt(id)));
      res.json({ success: true, data: songs, updatedAt });
    } catch (err) {
      logger.error('PLAYLIST', createReqId(), 'Get user playlist songs error', { error: logger.formatError(err), userId: req.user.userId, playlistId: id });
      res.json({ success: false, error: err.message });
    }
  });

  // 补全歌单歌曲元数据（前端进入歌单详情时自动调用）：
  // 老版本把榜单/歌单快照入库时丢弃了插件专有字段（如弥音QQ 需要 songmid、酷狗需要 hash），
  // 这类歌曲播放会被第三方解析 API 用「同一首兜底歌」顶替（所有歌播同一个音频）。
  // 这里对缺字段歌曲按歌名/歌手向插件 search 补全并更新入库；随后前端重新拉取歌曲列表。
  app.post('/api/my/playlists/:id/refresh-songs', authMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
      const playlist = await getPlaylistById(parseInt(id));
      if (!playlist) {
        return res.status(404).json({ success: false, error: '歌单不存在' });
      }
      const isAdmin = req.user.role === 'admin';
      if (playlist.userId !== req.user.userId && !playlist.isPublic && !isAdmin) {
        return res.status(404).json({ success: false, error: '歌单不存在或无权限' });
      }

      // 动态歌单无需补全：进入时实时向插件拉取，字段天然完整
      if (playlist.sourceType) {
        return res.json({ success: true, data: { total: 0, enriched: 0, failed: 0, skipped: 0, live: true } });
      }

      // 直接查库拿原始行（含 playlist_songs.id 主键，供精准 UPDATE）
      const rows = await new Promise((resolve, reject) => {
        db.all(
          'SELECT id, song_id, plugin, music_data FROM playlist_songs WHERE user_id = ? AND playlist_id = ?',
          [playlist.userId, parseInt(id)],
          (err, r) => (err ? reject(err) : resolve(r || []))
        );
      });

      let enriched = 0, failed = 0, skipped = 0;
      for (const row of rows) {
        let md = {};
        try { md = JSON.parse(row.music_data || '{}'); } catch { /* 忽略坏 JSON */ }
        if (!lacksPluginIdentFields(md)) { skipped++; continue; }
        const full = await enrichNetworkMusic(md, row.plugin).catch(() => null);
        if (!full || lacksPluginIdentFields(full)) { failed++; continue; }
        try {
          await new Promise((resolve, reject) => {
            db.run(
              'UPDATE playlist_songs SET music_data = ? WHERE id = ?',
              [JSON.stringify(stripPlayUrlFromMusic(full)), row.id],
              (err) => (err ? reject(err) : resolve())
            );
          });
          enriched++;
        } catch { failed++; }
      }

      if (enriched > 0) {
        // 刷新歌单歌曲内存缓存，保证随后重拉列表拿到补全后的数据
        database.refreshPlaylistSongsCache(playlist.userId, parseInt(id));
      }
      res.json({ success: true, data: { total: rows.length, enriched, failed, skipped } });
    } catch (err) {
      logger.error('PLAYLIST', createReqId(), 'Refresh playlist songs error', { error: err.message, playlistId: id });
      res.json({ success: false, error: err.message });
    }
  });

  // 动态榜单歌单实时状态（打开「我的歌单」时前端批量预取）：
  // 返回每个动态榜单的实时可用性 / 歌曲数 / 实时封面；封面成功时写回歌单，卡片与榜单保持一致。
  // 拉取失败的榜单标记 status=failed，前端显示「失败」且不可进入（与排行榜报错一致）。
  // 热门歌单状态短时内存缓存：同一歌单短期内重复查询（切回列表/刷新）直接返回，避免重复打插件
  const toplistStatusCache = new Map();
  const TOPLIST_STATUS_TTL = 60 * 1000;

  app.post('/api/my/playlists/toplist-status', authMiddleware, async (req, res) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) {
      return res.json({ success: true, data: {} });
    }
    try {
      const userVars = (ctx.userConfigs && ctx.userConfigs.default) || {};
      const entries = await Promise.all(ids.map(async (pid) => {
        const ck = `${req.user.userId}:${pid}`;
        const cached = toplistStatusCache.get(ck);
        if (cached && Date.now() - cached.ts < TOPLIST_STATUS_TTL) {
          return [pid, cached.st];
        }
        try {
          const playlist = await getPlaylistById(pid);
          if (!playlist || (playlist.sourceType !== 'toplist' && playlist.sourceType !== 'playlist') || !playlist.sourcePlatform || !playlist.sourceToplistId) {
            return [pid, null];
          }
          if (playlist.userId !== req.user.userId && !playlist.isPublic && req.user.role !== 'admin') {
            return [pid, null];
          }
          // 热门歌单（playlist）需要向插件全量导入曲目（可能几十秒），预取不做实时校验：
          // 乐观标记可进入（songCount 空，卡片显示「打开查看」），点进去时再完整拉取（90s 超时，
          // 失败时详情页会报错且不渲染）。排行榜（toplist）拉取快，照常实时校验可用性。
          if (playlist.sourceType === 'playlist') {
            // 数量用上次实时拉取的缓存（没进过则显示「打开查看」）
            const st = { status: 'ok', songCount: (playlist.cachedSongCount != null ? playlist.cachedSongCount : null), cover: playlist.cover, pending: true };
            toplistStatusCache.set(ck, { st, ts: Date.now() });
            return [pid, st];
          }
          const isLxSource = /^lx:/i.test(String(playlist.sourcePlatform || ''));
          let musicList = [];
          let cover = playlist.cover || '';
          if (isLxSource) {
            // 落雪（LX）榜单：lxmusic 内置 SDK 实时拉取；榜单无独立封面字段，沿用保存时的封面
            const lx = require('../lxmusic');
            const r = await lx.getBoardSongs(String(playlist.sourcePlatform).slice(3), playlist.sourceToplistId, 1);
            musicList = (r && Array.isArray(r.list)) ? r.list : [];
          } else {
            const method = 'getTopListDetail';
            const methodArgs = [{ id: playlist.sourceToplistId, title: playlist.name || '' }, 1];
            const result = await ctx.runPlugin(
              playlist.sourcePlatform,
              method,
              methodArgs,
              userVars,
              ctx.PLUGINS_DIR,
              'playlist-toplist-status'
            );
            musicList = (result && Array.isArray(result.musicList)) ? result.musicList : [];
            cover = (result && (result.cover || result.artwork || result.coverImg || result.pic)) || playlist.cover || '';
          }
          if (!musicList.length) {
            const st = { status: 'failed' };
            toplistStatusCache.set(ck, { st, ts: Date.now() });
            return [pid, st];
          }
          if (cover && cover !== playlist.cover) {
            // 实时封面写回歌单：下次打开列表未预取完成前也能显示最新封面
            try {
              await new Promise((resolve, reject) => {
                db.run('UPDATE playlists SET cover = ?, updated_at = ? WHERE id = ?', [cover, Date.now(), pid], (e) => (e ? reject(e) : resolve()));
              });
            } catch { /* 封面写回失败不影响状态 */ }
          }
          // 与动态歌单展示限制一致：最多前 100 首
          const st = { status: 'ok', songCount: Math.min(musicList.length, 100), cover };
          toplistStatusCache.set(ck, { st, ts: Date.now() });
          return [pid, st];
        } catch (e) {
          const st = { status: 'failed', error: e.message };
          toplistStatusCache.set(ck, { st, ts: Date.now() });
          return [pid, st];
        }
      }));
      const data = {};
      entries.forEach(([pid, st]) => { if (st) data[pid] = st; });
      res.json({ success: true, data });
    } catch (err) {
      logger.error('PLAYLIST', createReqId(), 'Toplist status error', { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 添加歌曲到歌单
  app.post('/api/my/playlists/:id/songs', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { music, plugin } = req.body;
    if (!music || !plugin) {
      return res.json({ success: false, error: '参数错误' });
    }
    try {
      // 公开歌单：任何登录用户都能添加歌曲；管理员可添加到任意歌单；
      // 歌曲按歌单所有者归属存储
      const targetPlaylist = await getPlaylistById(parseInt(id));
      if (!targetPlaylist) {
        return res.status(404).json({ success: false, error: '歌单不存在' });
      }
      const isAdmin = req.user.role === 'admin';
      if (targetPlaylist.userId !== req.user.userId && !targetPlaylist.isPublic && !isAdmin) {
        return res.status(404).json({ success: false, error: '歌单不存在或无权限' });
      }
      // 非本人时歌曲归属歌单所有者（管理员操作他人歌单同样归属其所有者）
      const effectiveUserId = targetPlaylist.userId === req.user.userId ? req.user.userId : targetPlaylist.userId;
      const result = await addSongToUserPlaylist(effectiveUserId, parseInt(id), music, plugin);
      logger.info('PLAYLIST', createReqId(), 'Song added to user playlist', { userId: req.user.userId, ownerId: effectiveUserId, playlistId: id, musicId: music.id });

      // 记录前台日志 - 添加歌曲到歌单
      frontendLogger.info('PLAYLIST', 'Song added to playlist', { playlistId: id, title: music?.title, artist: music?.artist });

      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('PLAYLIST', createReqId(), 'Add song to user playlist error', { error: logger.formatError(err), userId: req.user.userId, playlistId: id });
      frontendLogger.error('PLAYLIST', 'Song add to playlist failed', { playlistId: id, title: music?.title, error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 从歌单移除歌曲
  app.delete('/api/my/playlists/:id/songs', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { musicId, plugin } = req.query;
    if (!musicId || !plugin) {
      return res.json({ success: false, error: '参数错误' });
    }
    const isAdmin = req.user.role === 'admin';
    try {
      // 校验权限：本人、或管理员可移除任意歌单歌曲；歌曲按歌单所有者归属存储
      const targetPlaylist = await getPlaylistById(parseInt(id));
      if (!targetPlaylist) {
        return res.status(404).json({ success: false, error: '歌单不存在' });
      }
      if (targetPlaylist.userId !== req.user.userId && !isAdmin) {
        return res.status(404).json({ success: false, error: '歌单不存在或无权限' });
      }
      const effectiveUserId = targetPlaylist.userId === req.user.userId ? req.user.userId : targetPlaylist.userId;
      const result = await removeSongFromUserPlaylist(effectiveUserId, parseInt(id), musicId, plugin);
      logger.info('PLAYLIST', createReqId(), 'Song removed from user playlist', { userId: req.user.userId, ownerId: effectiveUserId, playlistId: id, musicId });

      // 记录前台日志 - 从歌单移除歌曲
      frontendLogger.info('PLAYLIST', 'Song removed from playlist', { playlistId: id, musicId });

      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('PLAYLIST', createReqId(), 'Remove song from user playlist error', { error: logger.formatError(err), userId: req.user.userId, playlistId: id });
      frontendLogger.error('PLAYLIST', 'Song remove from playlist failed', { playlistId: id, musicId, error: err.message });
      res.json({ success: false, error: err.message });
    }
  });
};
