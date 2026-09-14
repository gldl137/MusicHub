'use strict';

/**
 * 封面缓存垃圾清理调度器（文档四-3：封面缓存垃圾清理）
 *
 * 扫描 CACHE_DIR/cover 目录，删除数据库（local_songs.cover_hash）不再引用的 WebP 缓存文件，
 * 释放磁盘空间。文件名即 {md5}.webp（降级产物 {md5}.jpg / {md5}.png），按 md5 主键比对引用。
 * 默认每天 04:00 执行。
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const logger = require('../core/logger');
const { runCatchUpIfOverdue } = require('./catch-up');

const MODULE = 'COVER-CACHE-CLEAN';
const DEFAULT_CRON = '0 4 * * *';
// 启动补偿间隔：距上次清理超 12h 开机补跑（服务器可能夜间关机，04:00 cron 会错失）
const CATCHUP_KEY = 'coverCacheLastCleanup';
const CATCHUP_MIN_INTERVAL = 12 * 60 * 60 * 1000;

let coverCache = null;
let localLibraryDb = null;

function lazyLoad() {
  if (!coverCache) coverCache = require('../lib/cover-cache');
  if (!localLibraryDb) localLibraryDb = require('../lib/local-library-db');
}

class CoverCacheScheduler {
  constructor() {
    this.task = null;
    this.cronExpression = DEFAULT_CRON;
  }

  async init() {
    await this.startScheduler();
    // 启动补偿：不阻塞启动，超期即补跑（清理自带「无引用集不删」保护，幂等）
    const database = require('../database');
    runCatchUpIfOverdue(database, CATCHUP_KEY, CATCHUP_MIN_INTERVAL, () => this.runCleanup())
      .catch(() => {});
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
          await this.runCleanup();
        } catch (e) {
          logger.warn(MODULE, 'cron', 'Scheduled cover cache cleanup failed', { error: e && e.message });
        }
      }, { scheduled: true, timezone: 'Asia/Shanghai' });
      logger.info(MODULE, 'init', 'Cover cache cleanup scheduler started', { cron: this.cronExpression });
    } catch (err) {
      logger.error(MODULE, 'init', 'Failed to start cover cache cleanup scheduler', { error: err.message });
    }
  }

  /** 清理未被数据库引用的封面/歌手头像缓存文件（目录分开统计）：
   *  cover/ 按 cover_hash ∪ album_cover_hash 比对；art/ 按 artist_cover_hash 比对。 */
  async runCleanup() {
    lazyLoad();
    const allRows = await localLibraryDb.loadAllCoverHashes();
    const coverHashes = new Set((allRows || []).map((r) => r.hash).filter(Boolean));
    const artRows = await localLibraryDb.loadArtistCoverHashes();
    const artHashes = new Set((artRows || []).map((r) => r.hash).filter(Boolean));

    // 纯内存方案：流水线下载的封面/头像经绑定函数写入 local_songs 的
    // cover_hash / album_cover_hash / artist_cover_hash（md5 = webp 文件名 stem），
    // 上方引用集已覆盖全部绑定文件，不再需要额外账本比对。

    const result = {
      cover: { scanned: 0, removed: 0, size: 0 },
      artist: { scanned: 0, removed: 0, size: 0 }
    };
    const cleanDir = (files, dir, used, out) => {
      for (const f of files) {
        const dot = f.lastIndexOf('.');
        const stem = dot > 0 ? f.slice(0, dot) : f;
        if (!used.has(stem)) {
          try {
            const full = path.join(dir, f);
            const st = fs.statSync(full);
            fs.unlinkSync(full);
            out.removed += 1;
            out.size += st.size;
          } catch { /* 忽略单个删除失败 */ }
        }
      }
      out.scanned = files.length;
    };

    cleanDir(coverCache.listCoverFiles(), coverCache.getCoverDir(), coverHashes, result.cover);
    cleanDir(coverCache.listArtFiles(), coverCache.getArtDir(), artHashes, result.artist);

    // 数据库为空 / 尚未完成首次扫描时不清理，避免误删将要用到的缓存
    if (coverHashes.size === 0 && result.cover.scanned > 0) {
      logger.info(MODULE, 'cron', 'Cover cache cleanup skipped: no cover references yet', { files: result.cover.scanned });
      result.cover.removed = 0;
      result.cover.size = 0;
    }
    if (artHashes.size === 0 && result.artist.scanned > 0) {
      logger.info(MODULE, 'cron', 'Artist cache cleanup skipped: no artist cover references yet', { files: result.artist.scanned });
      result.artist.removed = 0;
      result.artist.size = 0;
    }

    logger.info(MODULE, 'cron', 'Cover/artist cache cleanup done', {
      cover: { scanned: result.cover.scanned, removed: result.cover.removed, freedBytes: result.cover.size },
      artist: { scanned: result.artist.scanned, removed: result.artist.removed, freedBytes: result.artist.size }
    });
    return result;
  }

  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info(MODULE, 'stop', 'Cover cache cleanup scheduler stopped');
    }
  }
}

module.exports = CoverCacheScheduler;
