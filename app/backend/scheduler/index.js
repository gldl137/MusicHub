/**
 * 调度器入口模块
 * 统一管理所有定时任务调度器
 */

const PluginUpdateScheduler = require('./plugin-update-scheduler');
const SubscriptionScheduler = require('./subscription-scheduler');
const NetworkSongCacheScheduler = require('./network-song-cache-scheduler');
const LocalLibraryScanScheduler = require('./local-library-scan-scheduler');
const CoverCacheScheduler = require('./cover-cache-scheduler');
const DirtyDataScheduler = require('./dirty-data-scheduler');

const SCHEDULER_MODULE = 'SCHEDULER_MANAGER';

class SchedulerManager {
    constructor(database, logger, runner, config, ctx) {
        this.db = database;
        this.logger = logger;
        this.runner = runner;
        this.config = config;
        this.ctx = ctx;

        // 初始化各个调度器
        this.pluginUpdateScheduler = new PluginUpdateScheduler(database, logger, config);
        this.subscriptionScheduler = new SubscriptionScheduler(database, logger, { ...config, runner, pluginsDir: config.pluginsDir });
        this.networkSongCacheScheduler = new NetworkSongCacheScheduler(database, logger, ctx);
        this.localLibraryScanScheduler = new LocalLibraryScanScheduler();
        this.coverCacheScheduler = new CoverCacheScheduler();
        this.dirtyDataScheduler = new DirtyDataScheduler();

        this.isInitialized = false;
    }

    /**
     * 初始化所有调度器
     */
    async init() {
        if (this.isInitialized) {
            this.logger.warn(SCHEDULER_MODULE, 'init', 'Scheduler manager already initialized');
            return;
        }

        this.logger.info(SCHEDULER_MODULE, 'init', 'Initializing all schedulers...');

        try {
            // 初始化插件更新调度器
            await this.pluginUpdateScheduler.init();

            // 初始化订阅更新调度器
            await this.subscriptionScheduler.init();

            // 初始化网络歌曲缓存清理调度器
            await this.networkSongCacheScheduler.init();

            // 初始化本地音乐定时扫描调度器（mtime 增量）
            await this.localLibraryScanScheduler.init();

            // 初始化封面缓存垃圾清理调度器
            await this.coverCacheScheduler.init();

            // 初始化脏数据清理调度器
            await this.dirtyDataScheduler.init();

            this.isInitialized = true;
            this.logger.info(SCHEDULER_MODULE, 'init', 'All schedulers initialized successfully');
        } catch (err) {
            this.logger.error(SCHEDULER_MODULE, 'init', 'Failed to initialize schedulers', { error: err.message });
            throw err;
        }
    }

    /**
     * 停止所有调度器
     */
    async stop() {
        this.logger.info(SCHEDULER_MODULE, 'stop', 'Stopping all schedulers...');

        try {
            // 停止插件更新调度器
            this.pluginUpdateScheduler.stop();

            // 停止订阅更新调度器
            this.subscriptionScheduler.stop();

            // 停止网络歌曲缓存清理调度器
            this.networkSongCacheScheduler.stop();

            // 停止本地音乐定时扫描调度器
            this.localLibraryScanScheduler.stop();

            // 停止封面缓存垃圾清理调度器
            this.coverCacheScheduler.stop();

            // 停止脏数据清理调度器
            this.dirtyDataScheduler.stop();

            this.isInitialized = false;
            this.logger.info(SCHEDULER_MODULE, 'stop', 'All schedulers stopped');
        } catch (err) {
            this.logger.error(SCHEDULER_MODULE, 'stop', 'Error stopping schedulers', { error: err.message });
        }
    }

    /**
     * 重启所有调度器
     */
    async restart() {
        this.logger.info(SCHEDULER_MODULE, 'restart', 'Restarting all schedulers...');
        await this.stop();
        await this.init();
    }

    // ==================== 插件更新调度器代理方法 ====================

    /**
     * 启动插件更新调度器
     */
    async startPluginUpdateScheduler() {
        return this.pluginUpdateScheduler.startScheduler();
    }

    /**
     * 执行插件更新
     * @param {Object} options - 选项
     * @param {boolean} options.sendNotification - 是否发送通知
     */
    async runPluginUpdate(options = {}) {
        return this.pluginUpdateScheduler.runUpdate(options);
    }

    /**
     * 获取插件更新状态
     */
    async getPluginUpdateStatus() {
        return this.pluginUpdateScheduler.getNextUpdateTime();
    }

    // ==================== 订阅更新调度器代理方法 ====================

    /**
     * 获取订阅更新配置
     */
    async getSubscriptionUpdateConfig() {
        return this.subscriptionScheduler.getConfig();
    }

    /**
     * 更新订阅更新配置
     */
    async updateSubscriptionUpdateConfig(config) {
        return this.subscriptionScheduler.updateConfig(config);
    }

    /**
     * 执行订阅同步下载（手动触发）
     * @param {Object} options - 选项
     * @param {boolean} options.sendNotification - 是否发送通知
     */
    async runSubscriptionUpdate(options = {}) {
        return this.subscriptionScheduler.runSyncDownloadManual(options);
    }

    /**
     * 获取订阅下次更新时间
     */
    async getSubscriptionNextUpdateTime() {
        return this.subscriptionScheduler.getNextUpdateTime();
    }

    // ==================== 网络歌曲缓存清理调度器代理方法 ====================

    /**
     * 立即执行一次网络歌曲缓存清理（手动触发）
     */
    async runNetworkSongCacheCleanup() {
        return this.networkSongCacheScheduler.runCleanup();
    }
}

module.exports = SchedulerManager;
