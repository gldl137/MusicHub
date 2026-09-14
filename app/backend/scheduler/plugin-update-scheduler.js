/**
 * 插件自动更新调度器
 * 管理插件的定时自动更新。
 *
 * 实际更新逻辑统一在 MusicFree/plugin-manager.js 的 runAutoUpdatePlugins()：
 * 兼容 <别名> 子目录插件布局、更新前做 SSRF 防护、更新地址缺失时回溯插件自带 srcUrl。
 * 本调度器只负责「按 cron 触发」与「查询下次触发时间」。
 */

const cron = require('node-cron');
const pluginManager = require('../MusicFree/plugin-manager');

const AUTO_UPDATE_MODULE = 'AUTO_UPDATE';

class PluginUpdateScheduler {
    constructor(database, logger, config) {
        this.db = database;
        this.logger = logger;
        this.config = config;
        // 当前定时任务
        this.task = null;
    }

    /**
     * 初始化调度器
     */
    async init() {
        await this.startScheduler();
        // 启动补偿：服务器常在深夜关机导致 cron 整晚错失；已启用且距上次更新超过 24h 时开机补跑（不阻塞启动）
        this.runCatchUpIfNeeded().catch(() => {});
    }

    /**
     * 启动补偿：已启用自动更新、但距上次执行超过 24h（夜间关机错过 cron）时，开机补跑一次。
     * runUpdate 完成后会写回 lastUpdateTime，24h 内反复重启不会重复补跑。
     */
    async runCatchUpIfNeeded() {
        try {
            const config = await this.db.getAutoUpdateConfig();
            if (!config || !config.enabled) return false;
            const last = Number(config.lastUpdateTime) || 0;
            if (last && Date.now() - last < 24 * 60 * 60 * 1000) return false;
            this.logger.info(AUTO_UPDATE_MODULE, 'catch-up', 'Missed scheduled update, running catch-up at startup', {
                lastRun: last ? new Date(last).toISOString() : 'never'
            });
            await this.runUpdate();
            return true;
        } catch (e) {
            this.logger.warn(AUTO_UPDATE_MODULE, 'catch-up', 'Startup catch-up update failed', { error: e && e.message });
            return false;
        }
    }

    /**
     * 启动调度器
     */
    async startScheduler() {
        // 停止现有任务
        this.stop();

        try {
            const config = await this.db.getAutoUpdateConfig();
            this.logger.debug(AUTO_UPDATE_MODULE, 'init', `Config loaded`, { config });

            if (config.enabled && config.cronExpression) {
                // 验证 cron 表达式
                if (!cron.validate(config.cronExpression)) {
                    this.logger.error(AUTO_UPDATE_MODULE, 'init', `Invalid cron expression`, { expression: config.cronExpression });
                    return;
                }

                // 创建定时任务
                this.task = cron.schedule(config.cronExpression, async () => {
                    this.logger.info(AUTO_UPDATE_MODULE, 'cron', `Cron job triggered`, { time: new Date().toISOString() });
                    await this.runUpdate();
                }, {
                    scheduled: true,
                    timezone: 'Asia/Shanghai'
                });

                this.logger.info(AUTO_UPDATE_MODULE, 'init', `Scheduler started`, { cron: config.cronExpression });
            } else {
                this.logger.info(AUTO_UPDATE_MODULE, 'init', 'Scheduler disabled');
            }
        } catch (err) {
            this.logger.error(AUTO_UPDATE_MODULE, 'init', `Error initializing scheduler`, { error: err.message });
        }
    }

    /**
     * 停止调度器
     */
    stop() {
        if (this.task) {
            this.task.stop();
            this.task = null;
            this.logger.info(AUTO_UPDATE_MODULE, 'stop', 'Scheduler stopped');
        }
    }

    /**
     * 执行插件更新（委托 MusicFree/plugin-manager 的统一实现）
     * 默认（定时任务）不额外推送外部通知；调用方显式传 sendNotification 时以调用方为准。
     */
    async runUpdate(options = {}) {
        this.logger.info(AUTO_UPDATE_MODULE, 'run', 'Starting auto update plugins...');
        const results = await pluginManager.runAutoUpdatePlugins({ sendNotification: false, ...options });
        this.logger.info(AUTO_UPDATE_MODULE, 'run', 'Completed', {
            success: results.success.length,
            failed: results.failed.length,
            skipped: results.skipped.length
        });
        return results;
    }

    /**
     * 获取下次更新时间：按 cron 表达式真实计算（未启用或表达式非法时返回 null）
     */
    async getNextUpdateTime() {
        return pluginManager.getNextPluginUpdateTime();
    }
}

module.exports = PluginUpdateScheduler;
