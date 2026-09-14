'use strict';

const path = require('path');
const logger = require('../core/logger');
const frontendLogger = require('../core/frontend-logger');
const { getSetting, saveSetting, clearAllUsersPlayHistory, clearAllUsersPlayQueue } = require('../database');
const { loadNotificationConfig, saveNotificationConfig, loadOpenlistConfig, saveOpenlistConfig, setConfigSetting, getConfigSetting } = require('../lib/config');
const { authMiddleware, adminMiddleware } = require('../lib/middleware');
const { sendMarkdownNotification } = require('../lib/notifications');

/**
 * 启动迁移：把 SQLite 中已存在的插件类系统设置同步进 config.json。
 * 历史原因这些设置只写进了 SQLite，而读取端（getConfigSetting）从 config.json 读取，
 * 导致 cover_plugins / artist_image_plugins / lyric_plugins 等“保存成功却读不到”。
 * 仅在 config.json 缺失该键时才从 SQLite 补写，避免覆盖用户在 config.json 的显式值。
 */
async function syncPluginSettingsToConfig() {
  try {
    const keys = ['lyric_plugin', 'lyric_plugins', 'cover_plugins', 'artist_image_plugins'];
    for (const k of keys) {
      if (getConfigSetting(k, undefined) === undefined) {
        const dbVal = await getSetting(k, undefined);
        if (dbVal !== undefined) {
          setConfigSetting(k, dbVal);
          logger.info('API', 'system', 'Migrated plugin setting SQLite→config.json', { key: k });
        }
      }
    }
  } catch (e) {
    logger.warn('API', 'system', 'syncPluginSettingsToConfig failed', { error: e.message });
  }
}

/**
 * 注册系统相关路由：健康检查 / 通用设置 / 企业微信通知测试 / 系统日志
 * @param {import('express').Express} app
 */
function registerSystemRoutes(app) {
  // 通用设置 / OpenList(Alist) 配置读写均需登录：避免未授权读取或修改含凭据的配置
  // 系统设置 / OpenList 配置属敏感写操作：auth + admin 双校验，避免普通登录用户越权改全站配置
  app.use(['/api/settings', '/api/openlist-config'], authMiddleware, adminMiddleware);

  // ==================== 健康检查 ====================
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      plugin_runner: 'ok',
      timestamp: new Date().toISOString()
    });
  });

  // ==================== 通用设置 API ====================
  app.get('/api/settings', async (req, res) => {
    try {
      const notificationConfig = loadNotificationConfig();
      const notificationEnabled = await getSetting('notification_enabled', false);
      logger.info('API', req.reqId, 'Get settings - notificationEnabled', { notificationEnabled, type: typeof notificationEnabled });
      const settings = {
        theme: await getSetting('theme', 'dark'),
        primaryColor: await getSetting('primary_color', 'green'),
        audioQuality: await getSetting('audio_quality', 'standard'),
        downloadPath: await getSetting('download_path', ''),
        apiKey: await getSetting('api_key', ''),
        notificationEnabled: notificationEnabled,
        wecomUrl: await getSetting('wecom_url', ''),
        notificationUrl: notificationConfig.url || '',
        debugLogEnabled: await getSetting('debug_log_enabled', logger.getLevel() === 'debug'),
        lyricPlugin: await getSetting('lyric_plugin', ''),
        lyricPlugins: await getSetting('lyric_plugins', []),
        coverPlugins: await getSetting('cover_plugins', []),
        artistImagePlugins: await getSetting('artist_image_plugins', []),
        maxNetSongCache: await getSetting('maxNetSongCache', 3000),
        maxRecentPlay: await getSetting('maxRecentPlay', 100),
        // OpenSubsonic 直连开关：设置值优先，未设置回退环境变量（兼容旧部署）
        streamRedirect: await getSetting('streamRedirectEnabled', process.env.ENABLE_STREAM_REDIRECT === 'true'),
        coverRedirect: await getSetting('coverRedirectEnabled', process.env.ENABLE_COVER_REDIRECT === 'true'),
        // 本地曲库优先播放：默认关闭，仅对插件（网络）音源生效
        localLibraryPriority: await getSetting('localLibraryPriority', false),
      };
      res.json({ success: true, data: settings });
    } catch (err) {
      logger.error('API', req.reqId, 'Failed to get settings', { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  app.post('/api/settings', async (req, res) => {
    try {
      const { theme, primaryColor, audioQuality, downloadPath, apiKey, notificationEnabled, wecomUrl, notificationUrl, debugLogEnabled, lyricPlugin, lyricPlugins, coverPlugins, artistImagePlugins, maxNetSongCache, maxRecentPlay, streamRedirect, coverRedirect, localLibraryPriority } = req.body;
      logger.info('API', req.reqId, 'Received settings update request', { body: req.body });
      if (theme !== undefined) await saveSetting('theme', theme);
      if (primaryColor !== undefined) await saveSetting('primary_color', primaryColor);
      if (audioQuality !== undefined) await saveSetting('audio_quality', audioQuality);
      if (downloadPath !== undefined) await saveSetting('download_path', downloadPath);
      if (apiKey !== undefined) await saveSetting('api_key', apiKey);
      if (notificationEnabled !== undefined) {
        await saveSetting('notification_enabled', notificationEnabled);
        logger.info('API', req.reqId, 'Notification setting saved', { notificationEnabled, type: typeof notificationEnabled });
      }
      if (wecomUrl !== undefined) await saveSetting('wecom_url', wecomUrl);
      if (notificationUrl !== undefined) saveNotificationConfig({ url: notificationUrl });
      if (debugLogEnabled !== undefined) {
        await saveSetting('debug_log_enabled', !!debugLogEnabled);
        logger.setLevel(debugLogEnabled ? 'debug' : 'info');
        logger.info('API', req.reqId, 'Debug log level updated', { debugLogEnabled: !!debugLogEnabled, level: logger.getLevel() });
      }
      if (lyricPlugin !== undefined) {
        const v = String(lyricPlugin || '');
        await saveSetting('lyric_plugin', v);
        setConfigSetting('lyric_plugin', v);
        logger.info('API', req.reqId, 'Lyric plugin setting saved', { lyricPlugin: v });
      }
      if (lyricPlugins !== undefined) {
        const list = (Array.isArray(lyricPlugins) ? lyricPlugins : []).map((p) => String(p)).filter(Boolean).slice(0, 3);
        await saveSetting('lyric_plugins', list);
        setConfigSetting('lyric_plugins', list);
        logger.info('API', req.reqId, 'Lyric plugins setting saved', { list });
      }
      if (coverPlugins !== undefined) {
        const list = (Array.isArray(coverPlugins) ? coverPlugins : []).map((p) => String(p)).filter(Boolean).slice(0, 3);
        await saveSetting('cover_plugins', list);
        setConfigSetting('cover_plugins', list);
        logger.info('API', req.reqId, 'Cover plugins setting saved', { list });
      }
      if (artistImagePlugins !== undefined) {
        const list = (Array.isArray(artistImagePlugins) ? artistImagePlugins : []).map((p) => String(p)).filter(Boolean).slice(0, 3);
        await saveSetting('artist_image_plugins', list);
        setConfigSetting('artist_image_plugins', list);
        logger.info('API', req.reqId, 'Artist image plugins setting saved', { list });
      }
      if (maxNetSongCache !== undefined) {
        // 网络歌曲（songs 表 remote__*）缓存上限，默认 1000 条；本地歌曲不受此限制
        const n = parseInt(String(maxNetSongCache).trim(), 10);
        const v = Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 100), 20000) : 1000;
        await saveSetting('maxNetSongCache', v);
        logger.info('API', req.reqId, 'Net song cache max setting saved', { maxNetSongCache: v });
      }
      if (maxRecentPlay !== undefined) {
        // 最近播放数据库上限，默认 100 首
        const n = parseInt(String(maxRecentPlay).trim(), 10);
        const v = Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 10), 5000) : 100;
        await saveSetting('maxRecentPlay', v);
        logger.info('API', req.reqId, 'Recent play max setting saved', { maxRecentPlay: v });
      }
      if (streamRedirect !== undefined) {
        // 播放直连 307 开关：true=307 直链，false=服务器代理
        await saveSetting('streamRedirectEnabled', !!streamRedirect);
        logger.info('API', req.reqId, 'Stream redirect mode saved', { streamRedirect: !!streamRedirect });
      }
      if (coverRedirect !== undefined) {
        // 封面直连 307 开关：true=307 直链，false=服务器代理
        await saveSetting('coverRedirectEnabled', !!coverRedirect);
        logger.info('API', req.reqId, 'Cover redirect mode saved', { coverRedirect: !!coverRedirect });
      }
      if (localLibraryPriority !== undefined) {
        // 本地曲库优先播放：true=播放插件歌曲时优先匹配 NAS 本地库并改播本地文件
        await saveSetting('localLibraryPriority', !!localLibraryPriority);
        logger.info('API', req.reqId, 'Local library priority saved', { localLibraryPriority: !!localLibraryPriority });
      }
      frontendLogger.info('SYSTEM', 'Settings updated', { changed: Object.keys(req.body) });
      res.json({ success: true, message: 'Settings saved' });
    } catch (err) {
      logger.error('API', req.reqId, 'Failed to save settings', { error: err.message });
      frontendLogger.error('SYSTEM', 'Settings update failed', { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // ==================== OpenList（strm 播放）配置 ====================
  // strm 文件播放用的内网直连基地址与外网穿透基地址。
  // 兼容：POST body 同时支持新字段（openlistLocalBaseUrl / openlistPublicBaseUrl）与旧字段（alistLocalBaseUrl / alistPublicBaseUrl），
  // GET 响应字段固定为 { localBaseUrl, publicBaseUrl }，与旧版一致。
  function getOpenlistConfig(req, res) {
    try {
      res.json({ success: true, data: loadOpenlistConfig() });
    } catch (err) {
      logger.error('API', req.reqId, 'Failed to get OpenList config', { error: err.message });
      res.json({ success: false, error: err.message });
    }
  }

  async function postOpenlistConfig(req, res) {
    try {
      const body = req.body || {};
      // 新字段优先，旧字段作为兼容兜底
      const localBaseUrl = body.openlistLocalBaseUrl !== undefined ? body.openlistLocalBaseUrl : body.alistLocalBaseUrl;
      const publicBaseUrl = body.openlistPublicBaseUrl !== undefined ? body.openlistPublicBaseUrl : body.alistPublicBaseUrl;
      saveOpenlistConfig({
        openlistLocalBaseUrl: localBaseUrl === undefined ? '' : String(localBaseUrl),
        openlistPublicBaseUrl: publicBaseUrl === undefined ? '' : String(publicBaseUrl)
      });
      res.json({ success: true, message: 'OpenList config saved', data: loadOpenlistConfig() });
    } catch (err) {
      logger.error('API', req.reqId, 'Failed to save OpenList config', { error: err.message });
      res.json({ success: false, error: err.message });
    }
  }

  // 新路由（OpenList 品牌）
  app.get('/api/openlist-config', getOpenlistConfig);
  app.post('/api/openlist-config', postOpenlistConfig);

  // 启动迁移：将 SQLite 中已存的插件类设置同步进 config.json，使读取端能取到（无需用户重新保存）
  syncPluginSettingsToConfig().catch(() => {});

  // ==================== 企业微信通知测试 ====================
  app.post('/api/settings/notification/test', authMiddleware, async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.json({ success: false, error: 'Webhook URL is required' });
      if (!/^https?:\/\//.test(url)) return res.json({ success: false, error: 'Invalid WeChat Work webhook URL' });
      const testMessage = `🎵 **MusicHub 测试通知**\n\n` +
        `✅ 您的企业微信通知配置正确！\n` +
        `⏰ 时间: ${new Date().toLocaleString('zh-CN')}\n` +
        `📱 发送者: ${req.user?.username || '未知用户'}`;
      const result = await sendMarkdownNotification(testMessage, url);
      if (result.success) {
        frontendLogger.info('NOTIFICATION', `测试通知任务通知已发送`, { type: '测试通知', recipient: req.user?.username });
        res.json({ success: true, message: 'Test notification sent successfully' });
      } else {
        frontendLogger.error('NOTIFICATION', `测试通知任务通知发送失败：${result.error}`, { type: '测试通知', error: result.error });
        res.json({ success: false, error: result.error || 'Failed to send notification' });
      }
    } catch (err) {
      logger.error('API', req.reqId, 'Failed to send test notification', { error: err.message });
      frontendLogger.error('NOTIFICATION', `测试通知任务通知发送失败：${err.message}`, { type: '测试通知', error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // ==================== 清空所有用户的播放数据（管理员）====================
  // 设置页「清零数据 → 播放数据（所有用户）」：设置页仅管理员可进，且本路由在 /api/settings
  // 前缀下已挂 auth + admin 双校验。清空全部用户的播放历史（含播放进度）与播放队列。
  app.post('/api/settings/clear-play-data', async (req, res) => {
    try {
      const [history, queue] = await Promise.all([
        clearAllUsersPlayHistory(),
        clearAllUsersPlayQueue()
      ]);
      logger.info('API', req.reqId, 'All users play data cleared', {
        historyDeleted: history.deleted, queueDeleted: queue.deleted, by: req.user?.username
      });
      frontendLogger.info('SYSTEM', 'All users play data cleared', {
        historyDeleted: history.deleted, queueDeleted: queue.deleted, by: req.user?.username
      });
      res.json({ success: true, data: { historyDeleted: history.deleted, queueDeleted: queue.deleted } });
    } catch (err) {
      logger.error('API', req.reqId, 'Failed to clear all users play data', { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // ==================== 系统日志 API ====================
  app.get('/api/logs', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 50;
      const level = req.query.level || 'all';
      let logs = frontendLogger.getLogs();
      if (level !== 'all') logs = logs.filter(log => log.level === level);
      logs = logs.reverse();
      const total = logs.length;
      const totalPages = Math.ceil(total / pageSize);
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const paginatedLogs = logs.slice(start, end);
      res.json({
        success: true,
        data: {
          logs: paginatedLogs,
          // 界面数据来自内存环形缓冲；磁盘持久化在 data/logs/app.log（getLogFilePath()）
          file: frontendLogger.getLogFilePath(),
          total: total,
          page: page,
          pageSize: pageSize,
          totalPages: totalPages
        }
      });
    } catch (err) {
      logger.error('API', req.reqId, 'Failed to read frontend logs', { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  app.post('/api/logs', authMiddleware, async (req, res) => {
    try {
      const { level, module, message, meta } = req.body;
      if (!level || !module || !message) return res.json({ success: false, error: 'Missing required fields' });
      if (level === 'error') frontendLogger.error(module, message, meta);
      else if (level === 'warn') frontendLogger.warn(module, message, meta);
      else frontendLogger.info(module, message, meta);
      res.json({ success: true });
    } catch (err) {
      logger.error('API', req.reqId, 'Failed to add frontend log', { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  app.delete('/api/logs', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      frontendLogger.clearLogs();
      logger.info('API', req.reqId, 'Frontend logs cleared', { by: req.user?.username });
      res.json({ success: true, message: '日志已清除' });
    } catch (err) {
      logger.error('API', req.reqId, 'Failed to clear frontend logs', { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });
}

module.exports = registerSystemRoutes;
