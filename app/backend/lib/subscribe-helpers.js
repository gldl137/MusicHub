'use strict';

// ==================== 订阅/榜单 复用内部函数 ====================
// 抽离自 server.js，供 routes/subscribe.js 与订阅调度器（scheduler/subscription-scheduler.js）复用。
// 单例通过 ctx 延迟访问。

const ctx = require('./context');
const { logger, runPlugin } = ctx;
const database = ctx.database;
const { db } = database;
const {
  updateSubscribedToplistStats, updateSubscribedToplistConfig, saveSubscribedToplistSongs,
  addDownload, updateDownloadStatus, getDownload, getSetting, getSubscribedToplistSongs
} = database;

// ---------------- 标题/歌手归一化 helper ----------------

function normalizeSongTitle(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .trim()
    .replace(/[\u00B7\u2022]/g, '.')
    .replace(/\s*[\(\[【].*?[\)\]】]\s*$/g, '')
    .replace(/[\s\-_，,、；;：:!！?？""''《》<>]/g, '')
    .replace(/(official|mv|musicvideo|video|audio|lyrics?|hd|hq|4k|1080p|720p)/gi, '');
}

function normalizeArtistToSet(artist) {
  if (!artist) return new Set();
  const artists = artist
    .toLowerCase()
    .trim()
    .replace(/[\u3001&\/]/g, ',')
    .split(',')
    .map(a => a.trim())
    .filter(a => a.length > 0);
  return new Set(artists);
}

function hasCommonChar(str1, str2) {
  if (!str1 || !str2) return false;
  const set1 = new Set(str1.split(''));
  for (const char of str2) {
    if (set1.has(char)) {
      return true;
    }
  }
  return false;
}


// ---------------- 同步单个订阅 ----------------

async function syncSubscriptionInternal(subscription, userId) {
  const { platform, toplist_id: toplistId, title, source_type } = subscription;

  let songs = [];
  try {
    const userVars = {};
    const isPlaylist = source_type === 'playlist';
    const method = isPlaylist ? 'getMusicSheetInfo' : 'getTopListDetail';
    const methodArgs = isPlaylist
      ? [{ id: toplistId }, 1]
      : [{ id: toplistId, title }, 1];
    const result = await runPlugin(platform, method, methodArgs, userVars, ctx.PLUGINS_DIR, 'run-sync');
    if (result && result.musicList) {
      // 展开插件返回的完整字段（songmid/hash/artwork 等专有标识必须保留）：
      // 只存 id/title/artist 等展示字段会导致播放解析缺参（如弥音QQ 需要 songmid），
      // 进而被第三方解析 API 用「同一首兜底歌」顶替（歌单里所有歌播同一个音频）
      songs = result.musicList.map((item, index) => ({
        ...item,
        id: String(item.id),
        musicId: String(item.id),
        title: item.title,
        artist: item.artist,
        album: item.album,
        rank: index
      }));
    }
  } catch (err) {
    logger.warn('SUBSCRIBE', 'run-sync', 'Failed to get toplist detail', { error: err.message, platform, toplistId });
    await updateSubscribedToplistConfig(userId, platform, toplistId, { lastRunAt: Date.now() });
    return { totalSongs: 0, matchedCount: 0, subscriptionId: subscription.id, warning: '获取歌曲失败: ' + err.message };
  }

  const saveResult = await saveSubscribedToplistSongs(userId, subscription.id, songs);
  await updateSubscribedToplistConfig(userId, platform, toplistId, { totalSongs: songs.length, lastRunAt: Date.now() });

  return { totalSongs: songs.length, matchedCount: 0, subscriptionId: subscription.id };
}

// ---------------- 下载单个订阅 ----------------

async function downloadSubscriptionInternal(subscription, options = {}) {
  const SubscriptionDownloadService = require('../services/subscription-download');
  const downloadService = new SubscriptionDownloadService(
    {
      getSubscribedToplistSongs,
      getDownload,
      getSetting,
      addDownload,
      updateDownloadStatus
    },
    logger,
    { pluginsDir: ctx.PLUGINS_DIR, userVars: ctx.userConfigs.default || {} }
  );

  const excludeEnabled = subscription.exclude_enabled !== 0;

  // 统计回写（按主键 id 更新，更可靠）：每完成一首调用一次，前端卡片进度实时增长；
  // 同时写 last_run_at —— 下载也算一次运行，否则卡片「更新」永远显示「从未运行」。
  const writeStats = async (snapshot) => {
    await updateSubscribedToplistStats(
      subscription.id,
      {
        downloadedCount: snapshot.downloaded,
        totalSongs: snapshot.totalSongs || subscription.total_songs || 0,
        failedCount: snapshot.failed,
        lastRunAt: Date.now()
      },
      subscription.user_id
    );
  };

  const result = await downloadService.downloadSubscription(subscription, {
    ...options,
    excludeArtists: excludeEnabled ? (ctx.downloadSettings.excludeArtists || []) : [],
    excludeLanguages: excludeEnabled ? (ctx.downloadSettings.excludeLanguages || []) : [],
    onSongComplete: async (snapshot) => {
      try {
        await writeStats(snapshot);
      } catch (e) {
        logger.warn('subscribe-helpers', 'downloadSubscription', '更新订阅下载统计失败', { error: e.message, subscriptionId: subscription.id });
      }
    }
  });

  // 收尾：写最终统计（「本次 0 首可下」也要刷新 last_run_at）
  try {
    await writeStats({
      downloaded: result.alreadyDownloaded + result.downloaded,
      totalSongs: result.totalSongs,
      failed: result.failed
    });
  } catch (e) {
    logger.warn('subscribe-helpers', 'downloadSubscription', '更新订阅下载统计失败', { error: e.message, subscriptionId: subscription.id });
  }

  return {
    subscriptionId: subscription.id,
    title: subscription.title,
    ...result
  };
}


module.exports = {
  syncSubscriptionInternal,
  downloadSubscriptionInternal,
  normalizeSongTitle,
  normalizeArtistToSet,
  hasCommonChar
};
