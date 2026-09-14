'use strict';

/**
 * 启动补偿（catch-up）：服务器可能常在深夜关机，凌晨 cron 会整晚错失。
 * 各维护调度器在 init 时调用本 helper：距上次执行超过 minIntervalMs 就立即补跑一次，
 * 使清理/更新不再依赖「凌晨恰好在线」。cron 保留：服务器夜间在线时照常按点执行。
 *
 * 上次执行时间存 settings 表（key 由调用方传入）；先写时间戳再执行任务，
 * 防止启动阶段崩溃/反复重启导致无限重复补跑（代价是极少数补跑失败要等下个周期）。
 */

const logger = require('../core/logger');

const MODULE = 'SCHED-CATCHUP';

/**
 * @param {Object} database database 模块（需导出 getSetting/saveSetting）
 * @param {string} key settings 键，如 'netSongCacheLastCleanup'
 * @param {number} minIntervalMs 距上次执行至少间隔多久才补跑
 * @param {Function} runFn 补跑的任务（async）
 * @returns {Promise<boolean>} 是否实际执行了补跑
 */
async function runCatchUpIfOverdue(database, key, minIntervalMs, runFn) {
  try {
    if (!database || typeof database.getSetting !== 'function' || typeof database.saveSetting !== 'function') {
      return false;
    }
    const raw = await database.getSetting(key, 0);
    const last = parseInt(String(raw == null ? 0 : raw), 10) || 0;
    if (last && Date.now() - last < minIntervalMs) return false;
    await database.saveSetting(key, Date.now());
    logger.info(MODULE, 'catch-up', `Missed scheduled task, running catch-up at startup`, { key, lastRun: last ? new Date(last).toISOString() : 'never' });
    await runFn();
    logger.info(MODULE, 'catch-up', `Catch-up completed`, { key });
    return true;
  } catch (e) {
    logger.warn(MODULE, 'catch-up', `Startup catch-up failed`, { key, error: e && e.message });
    return false;
  }
}

module.exports = { runCatchUpIfOverdue };
