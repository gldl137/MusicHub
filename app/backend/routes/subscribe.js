'use strict';

// ==================== 用户订阅榜单 路由 ====================
// 路由归属：/api/subscribed-toplists/*
// 复用的内部函数见 lib/subscribe-helpers.js

const ctx = require('../lib/context');
const { logger, frontendLogger, authMiddleware, createReqId, sendNewsNotification, loadNotificationConfig } = ctx;
const database = ctx.database;
const { db } = database;
const { loadPluginConfig } = require('../lib/config');
const wecomApp = require('../wecom-app');
const { ok, badRequest, serverError } = require('../lib/respond');
const {
  getUserSubscribedToplists, addUserSubscribedToplist,
  removeUserSubscribedToplist, removeUserSubscribedToplistById, isUserSubscribedToplist,
  updateSubscribedToplistConfig, saveSubscribedToplistSongs, getSubscribedToplistSongs,
  getUserSubscribedToplistById, getSetting
} = database;
const {
  syncSubscriptionInternal, downloadSubscriptionInternal
} = require('../lib/subscribe-helpers');

module.exports = function (app) {

  // 根据插件文件名（platform）解析其别名(displayName)，用于给订阅榜单名加前缀，如“QQ音乐-飙升榜”
  function resolvePluginAlias(platform) {
    if (!platform) return '';
    let decoded;
    try {
      decoded = decodeURIComponent(platform);
    } catch {
      decoded = platform;
    }
    const pluginConfig = loadPluginConfig() || {};
    for (const key of Object.keys(pluginConfig)) {
      let dk = key;
      try { dk = decodeURIComponent(key); } catch { /* 保留原值 */ }
      if (dk === decoded || dk.replace('.js', '') === decoded || key === platform) {
        const alias = pluginConfig[key] && pluginConfig[key].displayName;
        return (typeof alias === 'string' && alias.trim()) ? alias.trim() : '';
      }
    }
    return '';
  }

  // 获取用户的所有订阅榜单
  app.get('/api/subscribed-toplists', authMiddleware, async (req, res) => {
    try {
      const subscriptions = await getUserSubscribedToplists(req.user.userId);
      res.json({ success: true, data: subscriptions });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 添加订阅榜单
  app.post('/api/subscribed-toplists', authMiddleware, async (req, res) => {
    const { platform, toplistId, title, cover, sourceType, source_type, description, downloadQuality, isEnabled, totalSongs } = req.body;
    if (!platform || !toplistId) {
      return res.json({ success: false, error: '参数错误：缺少platform或toplistId' });
    }
    try {
      const existing = await isUserSubscribedToplist(req.user.userId, platform, toplistId);
      if (existing) {
        return res.json({ success: false, error: '已订阅该榜单' });
      }
      // 榜单名加上插件别名前缀，如“QQ音乐-飙升榜”；已有前缀则不再重复拼接
      const baseTitle = title || toplistId || '';
      const alias = resolvePluginAlias(platform);
      const finalTitle = (alias && baseTitle && !baseTitle.startsWith(`${alias}-`))
        ? `${alias}-${baseTitle}`
        : baseTitle;
      const result = await addUserSubscribedToplist(req.user.userId, {
        platform,
        toplistId,
        title: finalTitle,
        description: description || '',
        cover,
        sourceType: sourceType || source_type,
        downloadQuality: downloadQuality || 'standard',
        isEnabled: isEnabled !== undefined ? isEnabled : 0,
        totalSongs: totalSongs || 0
      });

      frontendLogger.info('SUBSCRIBE', 'Subscribed', { platform, toplistId, title: finalTitle });

      res.json({ success: true, data: result });
    } catch (err) {
      frontendLogger.error('SUBSCRIBE', 'Subscribe failed', { platform, toplistId, error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 获取单个订阅详情
  app.get('/api/subscribed-toplists/:id', authMiddleware, async (req, res) => {
    const subscriptionId = parseInt(req.params.id);
    if (!subscriptionId) {
      return res.json({ success: false, error: '参数错误：缺少订阅ID' });
    }
    try {
      const subscription = await getUserSubscribedToplistById(req.user.userId, subscriptionId);
      if (!subscription) {
        return res.status(404).json({ success: false, error: '订阅不存在' });
      }
      res.json({ success: true, data: subscription });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 更新订阅（支持按 DB id 或 platform+toplistId 定位；前端走 body 参数）
  app.put('/api/subscribed-toplists/:id?', authMiddleware, async (req, res) => {
    const subscriptionId = req.params.id ? parseInt(req.params.id) : null;
    const { platform, toplistId, title, cover, enabled, exclude_enabled, download_enabled, isEnabled, isExcludeEnabled } = req.body;
    if (!subscriptionId && (!platform || !toplistId)) {
      return res.json({ success: false, error: '参数错误：缺少订阅ID或platform/toplistId' });
    }
    try {
      let pf = platform;
      let tl = toplistId;
      if (subscriptionId && (!pf || !tl)) {
        const sub = await getUserSubscribedToplistById(req.user.userId, subscriptionId);
        if (!sub) {
          return res.status(404).json({ success: false, error: '订阅不存在' });
        }
        pf = sub.platform;
        tl = sub.toplist_id;
      }
      const cfg = {};
      if (title !== undefined) cfg.title = title;
      if (cover !== undefined) cfg.cover = cover;
      const en = enabled !== undefined ? enabled : isEnabled;
      if (en !== undefined) cfg.isEnabled = en ? 1 : 0;
      const ex = exclude_enabled !== undefined ? exclude_enabled : isExcludeEnabled;
      if (ex !== undefined) cfg.excludeEnabled = ex ? 1 : 0;
      if (download_enabled !== undefined) cfg.downloadQuality = download_enabled;
      const result = await updateSubscribedToplistConfig(req.user.userId, pf, tl, cfg);
      frontendLogger.info('SUBSCRIBE', 'Subscription updated', { subscriptionId, pf, tl });
      res.json({ success: true, data: result });
    } catch (err) {
      frontendLogger.error('SUBSCRIBE', 'Subscription update failed', { subscriptionId, platform, toplistId, error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 删除订阅（支持按 DB id 或 platform+toplistId 定位；前端走 query 参数）
  app.delete('/api/subscribed-toplists/:id?', authMiddleware, async (req, res) => {
    const subscriptionId = req.params.id ? parseInt(req.params.id) : null;
    const platform = req.query.platform || req.body.platform;
    const toplistId = req.query.toplistId || req.body.toplistId;
    if (!subscriptionId && (!platform || !toplistId)) {
      return res.json({ success: false, error: '参数错误：缺少订阅ID或platform/toplistId' });
    }
    try {
      let result;
      if (subscriptionId) {
        const subscription = await getUserSubscribedToplistById(req.user.userId, subscriptionId);
        if (!subscription) {
          return res.status(404).json({ success: false, error: '订阅不存在' });
        }
        result = await removeUserSubscribedToplistById(req.user.userId, subscriptionId);
      } else {
        result = await removeUserSubscribedToplist(req.user.userId, platform, toplistId);
      }
      frontendLogger.info('SUBSCRIBE', 'Subscription removed', { subscriptionId, platform, toplistId });
      res.json({ success: true, data: result });
    } catch (err) {
      frontendLogger.error('SUBSCRIBE', 'Subscription remove failed', { subscriptionId, error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 切换订阅启用状态
  app.post('/api/subscribed-toplists/:id/toggle', authMiddleware, async (req, res) => {
    const subscriptionId = parseInt(req.params.id);
    const { enabled } = req.body;
    if (!subscriptionId) {
      return res.json({ success: false, error: '参数错误：缺少订阅ID' });
    }
    try {
      const sub = await getUserSubscribedToplistById(req.user.userId, subscriptionId);
      if (!sub) {
        return res.status(404).json({ success: false, error: '订阅不存在' });
      }
      const result = await updateSubscribedToplistConfig(req.user.userId, sub.platform, sub.toplist_id, {
        enabled: enabled ? 1 : 0
      });
      frontendLogger.info('SUBSCRIBE', 'Subscription toggled', { subscriptionId, enabled });
      res.json({ success: true, data: result });
    } catch (err) {
      frontendLogger.error('SUBSCRIBE', 'Subscription toggle failed', { subscriptionId, error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 手动运行订阅同步
  app.post('/api/subscribed-toplists/run', authMiddleware, async (req, res) => {
    const { platform, toplistId } = req.body;
    if (!platform || !toplistId) {
      return res.json({ success: false, error: '参数错误：缺少platform或toplistId' });
    }
    try {
      const subscription = await new Promise((resolve, reject) => {
        db.get(
          'SELECT * FROM user_subscribed_toplists WHERE user_id = ? AND platform = ? AND toplist_id = ?',
          [req.user.userId, platform, toplistId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row || null);
          }
        );
      });
      if (!subscription) {
        return res.json({ success: false, error: '订阅不存在' });
      }
      const result = await syncSubscriptionInternal(subscription, req.user.userId);
      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('SUBSCRIBE', createReqId(), 'Run subscription sync error', { error: logger.formatError(err), userId: req.user.userId, platform, toplistId });
      res.json({ success: false, error: err.message });
    }
  });

  // 下载单个订阅的歌曲
  app.post('/api/subscribed-toplists/:id/download', authMiddleware, async (req, res) => {
    const subscriptionId = parseInt(req.params.id);
    if (!subscriptionId) {
      return res.json({ success: false, error: '参数错误：缺少订阅ID' });
    }
    try {
      const subscription = await new Promise((resolve, reject) => {
        db.get(
          'SELECT * FROM user_subscribed_toplists WHERE id = ? AND user_id = ?',
          [subscriptionId, req.user.userId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row || null);
          }
        );
      });
      if (!subscription) {
        return res.json({ success: false, error: '订阅不存在' });
      }
      const force = req.body && req.body.force === true;
      const result = await downloadSubscriptionInternal(subscription, { delay: 3000, force });
      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('SUBSCRIBE', createReqId(), 'Error downloading subscription', { error: logger.formatError(err), subscriptionId });
      res.status(500).json({ success: false, error: err.message });
    }
  });


  // 获取订阅榜单的歌曲列表
  app.get('/api/subscribed-toplists/:id/songs', authMiddleware, async (req, res) => {
    const subscriptionId = parseInt(req.params.id);
    if (!subscriptionId) {
      return badRequest(res, '参数错误：缺少订阅ID');
    }
    try {
      const songs = await getSubscribedToplistSongs(req.user.userId, subscriptionId);
      logger.info('SUBSCRIBE', createReqId(), 'Get subscription songs', {
        subscriptionId,
        total: songs.length
      });
      ok(res, songs, { total: songs.length });
    } catch (err) {
      logger.error('SUBSCRIBE', createReqId(), 'Get subscription songs error', { error: logger.formatError(err), userId: req.user.userId, subscriptionId });
      serverError(res, err.message);
    }
  });


  // ==================== 订阅定时下载配置（定时任务卡片） ====================
  // 获取订阅定时下载配置（开关状态、Cron 规则、上次执行时间）
  app.get('/api/subscribed-toplists/auto-update/config', authMiddleware, async (_req, res) => {
    try {
      const config = await ctx.schedulerManager.getSubscriptionUpdateConfig();
      res.json({ success: true, data: config });
    } catch (err) {
      logger.error('SUBSCRIBE', 'getAutoUpdateConfig failed', { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 保存订阅定时下载配置（启用/禁用/规则），保存后重启调度器使 enabled 立即生效
  app.post('/api/subscribed-toplists/auto-update/config', authMiddleware, async (req, res) => {
    try {
      const { enabled, cronExpression } = req.body;
      const config = await ctx.schedulerManager.updateSubscriptionUpdateConfig({ enabled, cronExpression });
      res.json({ success: true, data: config });
    } catch (err) {
      logger.error('SUBSCRIBE', 'saveAutoUpdateConfig failed', { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 立即执行订阅下载（定时任务卡片"立即下载"按钮）
  app.post('/api/subscribed-toplists/auto-update/trigger', authMiddleware, async (req, res) => {
    try {
      const { sendNotification } = req.body || {};
      const result = await ctx.schedulerManager.runSubscriptionUpdate({ sendNotification });
      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('SUBSCRIBE', 'triggerAutoUpdate failed', { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 发送订阅下载通知
  app.post('/api/subscribed-toplists/notify', authMiddleware, async (req, res) => {
    const { type, results } = req.body;
    const reqId = createReqId();
    try {
      logger.info('SUBSCRIBE', reqId, 'Sending subscription notification', { type, resultsCount: results?.length });

      const notificationEnabled = await getSetting('notification_enabled', false);
      let appEnabled = false;
      try {
        const cfg = await wecomApp.getWecomAppConfig();
        appEnabled = !!(cfg && cfg.enabled);
      } catch (e) { /* 应用模块不可用则忽略 */ }
      logger.info('SUBSCRIBE', reqId, 'Notification setting', { notificationEnabled, appEnabled });
      if (!notificationEnabled && !appEnabled) {
        logger.info('SUBSCRIBE', reqId, 'Notification disabled (both channels)');
        return res.json({ success: false, error: '通知未启用' });
      }

      logger.info('SUBSCRIBE', reqId, 'Checking sendNewsNotification', { exists: !!sendNewsNotification });
      if (!sendNewsNotification) {
        logger.error('SUBSCRIBE', reqId, 'sendNewsNotification not found');
        return res.json({ success: false, error: '通知功能不可用' });
      }

      const notificationConfig = loadNotificationConfig();
      const appUrl = process.env.APP_URL || 'http://localhost:8000';
      const notificationUrl = notificationConfig.url || '';
      const clickUrl = notificationUrl || `${appUrl}/#/subscribe`;

      const articles = [];

      const totalDownloaded = results.reduce((sum, r) => sum + (r.downloaded || 0), 0);
      const totalSkipped = results.reduce((sum, r) => sum + (r.skipped || 0), 0);
      const totalFailed = results.reduce((sum, r) => sum + (r.failed || 0), 0);

      const successCount = results.filter(r => !r.error && r.failed === 0).length;
      const failCount = results.filter(r => r.error || r.failed > 0).length;
      articles.push({
        title: `⬇️ 订阅下载(${successCount}/${failCount})`,
        description: `下载: ${totalDownloaded}\n跳过: ${totalSkipped}\n失败: ${totalFailed}\n时间: ${new Date().toLocaleString('zh-CN')}`,
        url: clickUrl,
        picurl: results[0]?.cover || ''
      });

      for (const sub of results.slice(0, 7)) {
        const stats = sub.error
          ? `失败: ${sub.error}`
          : `${sub.totalSongs || 0}首 下${sub.downloaded || 0}/跳${sub.skipped || 0}/败${sub.failed || 0}`;
        articles.push({
          title: `${sub.title} (${stats})`,
          description: '',
          url: clickUrl,
          picurl: sub.cover || ''
        });
      }

      logger.info('SUBSCRIBE', reqId, 'Calling sendNewsNotification', { articleCount: articles.length });
      const notifyResult = await sendNewsNotification(articles);
      if (notifyResult.success) {
        logger.info('SUBSCRIBE', reqId, 'Notification sent');
        res.json({ success: true });
      } else {
        logger.warn('SUBSCRIBE', reqId, 'Notification failed', { error: notifyResult.error });
        res.json({ success: false, error: notifyResult.error });
      }
    } catch (err) {
      logger.error('SUBSCRIBE', reqId, 'Failed to send notification', { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

};
