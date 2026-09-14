'use strict';

/**
 * 脏数据清理调度器（文档四-4：脏数据清理）
 *
 * 清理歌单、收藏、播放历史、播放队列、下载记录中无效 song_id：
 *  - 本地歌曲引用（song_id LIKE 'tr-%'）在 local_songs 主表已不存在（磁盘文件已删/被清）→ 删除关联记录；
 *  - playlist_songs 指向已删除歌单的孤儿行 → 删除。
 * 网络歌曲（remote__ 虚拟 ID）的主表为业务表冗余 music_data / 内存缓存，不在此清理范围。
 * 默认每天 04:30 执行。
 */

const cron = require('node-cron');
const logger = require('../core/logger');

const MODULE = 'DIRTY-DATA';
const DEFAULT_CRON = '30 4 * * *';

let database = null;
let localLibraryDb = null;

function lazyLoad() {
  if (!database) database = require('../database');
  if (!localLibraryDb) localLibraryDb = require('../lib/local-library-db');
}

class DirtyDataScheduler {
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
          await this.runCleanup();
        } catch (e) {
          logger.warn(MODULE, 'cron', 'Scheduled dirty data cleanup failed', { error: e && e.message });
        }
      }, { scheduled: true, timezone: 'Asia/Shanghai' });
      logger.info(MODULE, 'init', 'Dirty data cleanup scheduler started', { cron: this.cronExpression });
    } catch (err) {
      logger.error(MODULE, 'init', 'Failed to start dirty data cleanup scheduler', { error: err.message });
    }
  }

  async runCleanup() {
    lazyLoad();
    const db = database.db;
    if (!db) return { skipped: true };

    // 确保 local_songs 主表存在（首次扫描前可能还没建表），避免子查询报错
    try {
      await localLibraryDb.ensureTables();
    } catch { /* 建表失败按无本地库处理，仅清孤儿歌单行 */ }

    const songRefTables = ['playlist_songs', 'favorites', 'play_history', 'play_queue', 'downloads'];
    const deleted = {};
    for (const table of songRefTables) {
      deleted[table] = await new Promise((resolve) => {
        db.run(
          `DELETE FROM ${table} WHERE song_id LIKE 'tr-%' AND song_id NOT IN (SELECT id FROM local_songs)`,
          function (err) {
            if (err) {
              logger.warn(MODULE, 'clean', 'Clean orphan local song refs failed', { table, error: err.message });
              resolve(0);
            } else {
              resolve(this.changes || 0);
            }
          }
        );
      });
    }

    const orphanPlaylistSongs = await new Promise((resolve) => {
      db.run(
        'DELETE FROM playlist_songs WHERE playlist_id NOT IN (SELECT id FROM playlists)',
        function (err) {
          if (err) {
            logger.warn(MODULE, 'clean', 'Clean orphan playlist_songs failed', { error: err.message });
            resolve(0);
          } else {
            resolve(this.changes || 0);
          }
        }
      );
    });

    const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0) + orphanPlaylistSongs;
    logger.info(MODULE, 'clean', 'Dirty data cleanup done', { deleted, orphanPlaylistSongs, totalDeleted });
    return { deleted, orphanPlaylistSongs, totalDeleted };
  }

  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info(MODULE, 'stop', 'Dirty data cleanup scheduler stopped');
    }
  }
}

module.exports = DirtyDataScheduler;
