/**
 * 订阅定时同步下载调度器
 * 直接调用与手动按钮相同的 API 逻辑
 */

const cron = require('node-cron');
const frontendLogger = require('../core/frontend-logger');

const SCHEDULER_MODULE = 'SUB_SCHEDULER';
const CONFIG_KEY = 'subscription_auto_update_config';

class SubscriptionScheduler {
    constructor(database, logger, config) {
        this.db = database;
        this.logger = logger;
        this.config = config;
        this.task = null;
        this.isInitialized = false;

        this.defaultConfig = {
            enabled: false,
            cronExpression: '0 0 * * *',
            lastUpdateTime: null
        };
    }

    async init() {
        if (this.isInitialized) return;

        try {
            const config = await this.getConfig();
            if (config.enabled) await this.startScheduler();
            this.isInitialized = true;
            this.logger.info(SCHEDULER_MODULE, 'init', { enabled: config.enabled });
        } catch (err) {
            this.logger.error(SCHEDULER_MODULE, 'init', { error: err.message });
            throw err;
        }
    }

    async getConfig() {
        try {
            const config = await this.db.getSetting(CONFIG_KEY, null);
            return config ? { ...this.defaultConfig, ...config } : { ...this.defaultConfig };
        } catch (_err) {
            return { ...this.defaultConfig };
        }
    }

    async saveConfig(config) {
        await this.db.saveSetting(CONFIG_KEY, JSON.stringify(config));
    }

    async startScheduler() {
        this.stop();

        const config = await this.getConfig();
        if (!config.enabled || !cron.validate(config.cronExpression)) {
            return false;
        }

        this.task = cron.schedule(config.cronExpression, async () => {
            try {
                await this.runSyncDownload();
            } catch (err) {
                this.logger.error(SCHEDULER_MODULE, 'cron', { error: err.message });
            }
        }, { scheduled: true, timezone: 'Asia/Shanghai' });

        this.logger.info(SCHEDULER_MODULE, 'start', { cron: config.cronExpression });
        return true;
    }

    stop() {
        if (this.task) {
            this.task.stop();
            this.task = null;
        }
    }

    /**
     * 执行同步下载任务 - 直接调用与按钮相同的 API 逻辑
     * @param {Object} options - 选项
     * @param {boolean} options.sendNotification - 是否发送通知
     */
    async runSyncDownload(options = {}) {
        const subs = await this.db.getEnabledSubscribedToplists();
        if (!subs?.length) {
            frontendLogger.info('SCHEDULER', '订阅同步任务开始执行：没有启用的订阅', { type: '订阅同步', enabled: 0 });
            return { success: 0, failed: 0, total: 0 };
        }

        // 记录前台日志 - 任务开始
        const subNames = subs.map(s => s.title).join('、');
        frontendLogger.info('SCHEDULER', `订阅同步任务开始执行：共 ${subs.length} 个订阅（${subNames}）`, {
            type: '订阅同步',
            total: subs.length,
            subscriptions: subs.map(s => s.title)
        });

        let success = 0, failed = 0;
        const results = [];

        for (const sub of subs) {
            try {
                // ========== 第一步：同步（调用与手动同步按钮相同的逻辑）==========
                const syncResult = await this._runSyncForSubscription(sub);
                
                // ========== 第二步：下载（调用与手动下载按钮相同的逻辑）==========
                const downloadResult = await this._runDownloadForSubscription(sub);

                success++;
                results.push({
                    subscriptionId: sub.id,
                    title: sub.title,
                    platform: sub.platform,
                    cover: sub.cover || sub.cover_url || '',
                    sync: syncResult,
                    download: downloadResult
                });

                // 单条简洁日志
                this.logger.info(SCHEDULER_MODULE, 'process', {
                    title: sub.title,
                    songs: syncResult?.totalSongs || 0,
                    match: syncResult?.matchedCount || 0,
                    dl: downloadResult?.downloaded || 0,
                    skip: downloadResult?.skipped || 0
                });

            } catch (err) {
                failed++;
                results.push({ title: sub.title, error: err.message });
                this.logger.error(SCHEDULER_MODULE, 'process', { title: sub.title, error: err.message });
            }
        }

        // 更新最后执行时间
        const config = await this.getConfig();
        config.lastUpdateTime = Date.now();
        await this.saveConfig(config);

        // 汇总日志
        const totalDownloaded = results.reduce((s, r) => s + (r.download?.downloaded || 0), 0);
        const totalSkipped = results.reduce((s, r) => s + (r.download?.skipped || 0), 0);
        this.logger.info(SCHEDULER_MODULE, 'done', { ok: success, fail: failed, dl: totalDownloaded, skip: totalSkipped });

        // 构建详细的成功订阅列表（显示标题和匹配数）
        const successSubs = results.filter(r => !r.error).map(r => {
            const match = r.sync?.matchedCount || 0;
            const total = r.sync?.totalSongs || 0;
            return `${r.title} ${match}/${total}`;
        }).join('、');

        // 构建失败的订阅列表
        const failedSubs = results.filter(r => r.error).map(r => r.title).join('、');

        // 记录前台日志 - 定时任务执行完成
        let logMessage = `订阅同步完成：成功 ${success} 个订阅`;
        if (successSubs) {
            logMessage += `，分别是 ${successSubs}`;
        }
        if (totalDownloaded > 0) {
            logMessage += `，下载 ${totalDownloaded} 首歌曲`;
        }

        if (failed === 0) {
            frontendLogger.info('SCHEDULER', logMessage, {
                type: '订阅同步',
                success,
                total: subs.length,
                downloaded: totalDownloaded,
                skipped: totalSkipped,
                details: results.filter(r => !r.error).map(r => ({
                    title: r.title,
                    matched: r.sync?.matchedCount || 0,
                    total: r.sync?.totalSongs || 0,
                    downloaded: r.download?.downloaded || 0
                }))
            });
        } else {
            let warnMessage = `订阅同步完成：成功 ${success} 个，失败 ${failed} 个`;
            if (successSubs) {
                warnMessage += `，成功：${successSubs}`;
            }
            if (failedSubs) {
                warnMessage += `，失败：${failedSubs}`;
            }
            frontendLogger.warn('SCHEDULER', warnMessage, {
                type: '订阅同步',
                success,
                failed,
                total: subs.length,
                downloaded: totalDownloaded
            });
        }

        // 发送通知（仅在未禁用通知时发送）
        if (options.sendNotification !== false) {
            await this.sendNotification(results, success, failed);
        } else {
            this.logger.info(SCHEDULER_MODULE, 'runSyncDownload', 'Notification skipped (disabled by user)');
        }

        return { success, failed, total: subs.length, results };
    }

    /**
     * 同步单个订阅 - 直接调用 server.js 中的 syncSubscriptionInternal 函数
     * 与 /api/subscribed-toplists/run 接口使用完全相同的逻辑
     */
    async _runSyncForSubscription(sub) {
        try {
            // 直接调用 server.js 导出的同步函数（与API端点完全一致）
            const serverModule = require('../server');
            const result = await serverModule.syncSubscriptionInternal(sub, sub.user_id);

            return result;

        } catch (err) {
            this.logger.error(SCHEDULER_MODULE, 'sync', 'Sync error', {
                subscriptionId: sub.id, error: err.message
            });
            throw err;
        }
    }

    /**
     * 下载单个订阅 - 直接调用 server.js 中的 downloadSubscriptionInternal 函数
     * 与 /api/subscribed-toplists/:id/download 接口使用完全相同的逻辑
     */
    async _runDownloadForSubscription(sub) {
        try {
            // 直接调用 server.js 导出的下载函数（与API端点完全一致）
            const serverModule = require('../server');
            const result = await serverModule.downloadSubscriptionInternal(sub, { delay: 3000, force: false });

            return result;

        } catch (err) {
            this.logger.error(SCHEDULER_MODULE, 'download', 'Download error', {
                subscriptionId: sub.id, error: err.message
            });
            throw err;
        }
    }

    async sendNotification(results, successCount, failedCount) {
        try {
            let notificationEnabled = await this.db.getSetting('notification_enabled', false);
            // 处理字符串类型的布尔值（数据库可能存储为字符串）
            if (typeof notificationEnabled === 'string') {
                notificationEnabled = notificationEnabled === 'true';
            }
            // 企业微信应用开关（独立于群机器人，开启则也会广播应用通知）
            let appEnabled = false;
            try {
                const wecomAppMod = require('../wecom-app');
                const appCfg = await wecomAppMod.getWecomAppConfig();
                appEnabled = !!(appCfg && appCfg.enabled);
            } catch (e) { /* 应用模块不可用则忽略 */ }
            this.logger.debug(SCHEDULER_MODULE, 'sendNotification', 'Checking notification setting', { notificationEnabled, appEnabled });
            // 群机器人 与 企业微信应用 任一开启即发送；各渠道在发送函数内按自身开关独立判断
            if (!notificationEnabled && !appEnabled) {
                this.logger.info(SCHEDULER_MODULE, 'sendNotification', 'All notification channels disabled, skipping');
                return;
            }

            let sendNewsNotification;
            try {
                const serverModule = require('../server');
                sendNewsNotification = serverModule.sendNewsNotification;
            } catch (_err) { return; }

            if (!sendNewsNotification) return;

            // 获取通知跳转链接设置，从 config.json 读取
            const serverModule = require('../server');
            const notificationConfig = serverModule.loadNotificationConfig ? serverModule.loadNotificationConfig() : {};
            const appUrl = process.env.APP_URL || 'http://localhost:8000';
            const notificationUrl = notificationConfig.url || '';
            const clickUrl = notificationUrl || `${appUrl}/#/subscribe`; // 如果没设置使用默认地址

            const totalDownloaded = results.reduce((s, r) => s + (r.download?.downloaded || 0), 0);
            const totalSkipped = results.reduce((s, r) => s + (r.download?.skipped || 0), 0);
            const totalSongs = results.reduce((s, r) => s + (r.sync?.totalSongs || 0), 0);
            const totalMatched = results.reduce((s, r) => s + (r.sync?.matchedCount || 0), 0);

            const DEFAULT_COVER = 'https://raw.giteeusercontent.com/gldl137/wechat-work-bot/raw/master/images/MusicHubdy.png';

            const articles = [{
                title: `🔄 订阅(${successCount}/${failedCount})`,
                description: `歌曲${totalMatched}/${totalSongs} 下${totalDownloaded}/跳${totalSkipped}`,
                url: clickUrl,
                picurl: DEFAULT_COVER
            }];

            for (const sub of results.slice(0, 7)) {
                const stats = sub.error
                    ? `失败:${sub.error.slice(0, 20)}`
                    : `${sub.sync?.matchedCount || 0}/${sub.sync?.totalSongs || 0} 下${sub.download?.downloaded || 0}/跳${sub.download?.skipped || 0}`;
                articles.push({
                    title: `${sub.title.slice(0, 15)} ${stats}`,
                    url: clickUrl,
                    picurl: sub.cover || DEFAULT_COVER
                });
            }

            const notifyResult = await sendNewsNotification(articles);
            if (notifyResult && notifyResult.success) {
                // 记录前台日志 - 通知已发送
                frontendLogger.info('NOTIFICATION', `订阅同步任务通知已发送`, {
                    type: '订阅同步',
                    success: successCount,
                    failed: failedCount,
                    downloaded: totalDownloaded
                });
            }
        } catch (_err) {
            // 忽略通知错误
        }
    }

    async getNextUpdateTime() {
        const config = await this.getConfig();
        if (!config.enabled || !config.cronExpression) return null;
        try {
            const interval = require('cron-parser').parseExpression(config.cronExpression, { tz: 'Asia/Shanghai' });
            return interval.next().toDate();
        } catch (_err) {
            return null;
        }
    }

    async runSyncDownloadManual(options = {}) {
        return this.runSyncDownload(options);
    }

    /**
     * 更新配置并重启调度器
     */
    async updateConfig(newConfig) {
        const config = await this.getConfig();

        if (newConfig.enabled !== undefined) config.enabled = newConfig.enabled;
        if (newConfig.cronExpression !== undefined) config.cronExpression = newConfig.cronExpression;

        await this.saveConfig(config);

        // 重启调度器
        if (config.enabled) {
            await this.startScheduler();
        } else {
            this.stop();
        }

        return config;
    }
}

module.exports = SubscriptionScheduler;
