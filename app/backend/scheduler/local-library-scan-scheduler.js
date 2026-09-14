'use strict';

/**
 * 本地音乐增量扫描调度器（文档四-1：音乐增量/全量扫描）
 *
 * 后台定时触发本地库（/app/music）扫描，不阻塞 HTTP 请求：
 *  - performScan 依据文件 mtime_ms 判断变更：未变化直接复用，跳过元数据解析、封面提取；
 *  - 磁盘文件已删除：全表重建时自然清理对应数据库记录。
 * 默认每天 03:30 执行（避开 03:00 网络歌曲缓存清理、02:00 歌单刷新）。
 */

const fs = require('fs');
const cron = require('node-cron');
const logger = require('../core/logger');

const MODULE = 'LOCAL-LIBRARY-SCAN';
const DEFAULT_CRON = '30 3 * * *';

// 延迟 require：routes/local-music 由 server.js 注册路由时已加载，这里复用同一实例
let localMusic = null;
let localLibraryDb = null;

function lazyLoad() {
  if (!localMusic) {
    // eslint-disable-next-line global-require
    localMusic = require('../routes/local-music');
  }
  if (!localLibraryDb) {
    // eslint-disable-next-line global-require
    localLibraryDb = require('../lib/local-library-db');
  }
}

class LocalLibraryScanScheduler {
  constructor() {
    this.task = null;
    this.cronExpression = DEFAULT_CRON;
  }

  async init() {
    await this.startScheduler();
  }

  async startScheduler() {
    this.stop();
    try {
      if (!cron.validate(this.cronExpression)) {
        logger.error(MODULE, 'init', 'Invalid cron expression', { expression: this.cronExpression });
        return;
      }
      this.task = cron.schedule(this.cronExpression, async () => {
        try {
          await this.runScan();
        } catch (e) {
          logger.warn(MODULE, 'cron', 'Scheduled local library scan failed', { error: e && e.message });
        }
      }, { scheduled: true, timezone: 'Asia/Shanghai' });
      logger.info(MODULE, 'init', 'Local library scan scheduler started', { cron: this.cronExpression });
    } catch (err) {
      logger.error(MODULE, 'init', 'Failed to start local library scan scheduler', { error: err.message });
    }
  }

  /** 执行一次增量扫描（mtime 增量；单曲封面/标签异常只跳过该曲，不中断整体） */
  async runScan() {
    lazyLoad();
    const musicDir = process.env.MUSIC_DIR || require('path').join(__dirname, '..', '..', 'music');
    if (!fs.existsSync(musicDir)) {
      logger.debug(MODULE, 'cron', 'Music dir not exists, skip scan', { musicDir });
      return null;
    }
    await localLibraryDb.ensureTables();
    const st = await localMusic.scanLibraryNow();
    logger.info(MODULE, 'cron', 'Local library incremental scan done', { count: st && st.songs ? st.songs.length : 0 });
    return st;
  }

  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info(MODULE, 'stop', 'Local library scan scheduler stopped');
    }
  }
}

module.exports = LocalLibraryScanScheduler;
