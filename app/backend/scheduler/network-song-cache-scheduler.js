'use strict';

/**
 * 网络歌曲缓存清理调度器
 *
 * 定时清理 songs 缓存表（仅存静态元数据，不存播放地址）：
 *  - TTL：超过 30 天未访问的条目删除；
 *  - 容量上限：超过上限时按 last_access_at 升序删最冷数据；
 *  - 已卸载音源：plugin/source 不在当前已安装插件列表的条目删除。
 *
 * 默认每天 03:00 执行（避开 02:00 的歌单刷新）。
 */

const cron = require('node-cron');
const { runCatchUpIfOverdue } = require('./catch-up');

const CACHE_MODULE = 'NETSONG-CACHE';
const DEFAULT_CRON = '0 3 * * *'; // 每天 03:00
// 启动补偿间隔：距上次清理超 12h 且从未在 cron 时段执行过时，开机补跑（服务器可能夜间关机）
const CATCHUP_KEY = 'netSongCacheLastCleanup';
const CATCHUP_MIN_INTERVAL = 12 * 60 * 60 * 1000;

class NetworkSongCacheScheduler {
  constructor(database, logger, ctx) {
    this.db = database;
    this.logger = logger;
    this.ctx = ctx;
    this.task = null;
    this.cronExpression = DEFAULT_CRON;
  }

  async init() {
    await this.startScheduler();
    // 启动补偿：不阻塞启动，超期即补跑（清理幂等且开销小）
    runCatchUpIfOverdue(this.db, CATCHUP_KEY, CATCHUP_MIN_INTERVAL, () => this.runCleanup())
      .catch(() => {});
  }

  async startScheduler() {
    this.stop();
    try {
      if (!cron.validate(this.cronExpression)) {
        this.logger.error(CACHE_MODULE, 'init', 'Invalid cron expression', { expression: this.cronExpression });
        return;
      }
      this.task = cron.schedule(this.cronExpression, async () => {
        await this.runCleanup();
      }, { scheduled: true, timezone: 'Asia/Shanghai' });
      this.logger.info(CACHE_MODULE, 'init', 'Network song cache cleanup scheduler started', { cron: this.cronExpression });
    } catch (err) {
      this.logger.error(CACHE_MODULE, 'init', 'Failed to start cleanup scheduler', { error: err.message });
    }
  }

  // 允许的音源 = 当前已安装插件文件名（songs.source / plugin 即插件文件名）
  _allowSources() {
    try {
      if (this.ctx && typeof this.ctx.listPluginNames === 'function') {
        return this.ctx.listPluginNames();
      }
    } catch { /* 忽略 */ }
    return [];
  }

  async runCleanup() {
    try {
      const allowSources = this._allowSources();
      const result = await this.db.cleanupNetworkSongCache({ allowSources });
      this.logger.info(CACHE_MODULE, 'cron', 'Network song cache cleanup done', result);
      return result;
    } catch (err) {
      this.logger.error(CACHE_MODULE, 'cron', 'Cleanup failed', { error: err.message });
      return null;
    }
  }

  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
      this.logger.info(CACHE_MODULE, 'stop', 'Cleanup scheduler stopped');
    }
  }
}

module.exports = NetworkSongCacheScheduler;
