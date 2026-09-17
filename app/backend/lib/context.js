'use strict';

// =============================================================
// 应用上下文（共享层）
// 作为 server.js 与各 routes/* 模块之间的"单例容器 + helper + 纯模块 re-export"。
// 可变单例（downloadSettings / userConfigs / schedulerManager /
// downloadService / upload / 路径常量等）由 server.js 在初始化完成后通过
// setSingletons() 注入，避免循环依赖，并保证各模块拿到同一引用。
// =============================================================

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cron = require('node-cron');
const multer = require('multer');
const { randomUUID } = require('crypto');

// 核心模块
const logger = require('../core/logger');
const frontendLogger = require('../core/frontend-logger');
const { runPlugin, _require, loadPluginModule, resolvePluginFilePath } = require('../MusicFree/runner');
const { ResolverCore, init: initResolverCore } = require('../MusicFree/resolver-core');
// MusicFree 插件管理核心（枚举/安装/更新/删除/配置）：实现在 MusicFree 专属目录内，
// 本模块只做「注入依赖 + 同名转出」，供 server.js 与各 routes 继续通过 ctx 使用。
const pluginManager = require('../MusicFree/plugin-manager');
const DownloadManager = require('./download-manager');
const SchedulerManager = require('../scheduler');
const DownloadService = require('../services/download-service');

// 配置层 / 通知层
const config = require('./config');
const notifications = require('./notifications');

// 数据库层（导出全部函数，供 routes 直接使用）
const database = require('../database');

// 鉴权中间件
const { generateToken, verifyToken, authMiddleware, adminMiddleware, createReqId } = require('./middleware');

// ---------------- 单例容器 ----------------

const singletons = {};

function setSingletons(obj) {
  Object.assign(singletons, obj);
}

// ---------------- 共享 helper 函数 ----------------

/**
 * 将绝对路径转换为 Docker 容器内的显示路径
 */
function toDockerPath(absolutePath) {
  const DOWNLOAD_DIR = singletons.DOWNLOAD_DIR;
  if (!absolutePath) return absolutePath;
  try {
    const relativePath = path.relative(DOWNLOAD_DIR, absolutePath);
    if (relativePath.startsWith('..')) {
      return absolutePath;
    }
    return '/downloads/' + relativePath.replace(/\\/g, '/');
  } catch {
    return absolutePath;
  }
}

/**
 * 安全的文件名处理
 */
function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') {
    return 'unknown';
  }

  let safe = filename.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  safe = safe.replace(/[<>:"/\\|?*]/g, '_');
  safe = safe.replace(/\.{2,}/g, '_');
  safe = safe.trim().replace(/^[\s.]+|[\s.]+$/g, '');

  const maxLength = 200;
  if (safe.length > maxLength) {
    const ext = path.extname(safe);
    const name = path.basename(safe, ext);
    safe = name.substring(0, maxLength - ext.length) + ext;
  }

  if (!safe || safe === '.' || safe === '..') {
    safe = 'unknown_file';
  }

  return safe;
}

/**
 * 生成下载文件路径（歌名 - 歌手.扩展名）
 */
function generateDownloadFilePath(music, extension = '.mp3') {
  const artist = sanitizeFilename(music.artist) || '未知艺术家';
  const title = sanitizeFilename(music.title) || '未知歌曲';

  const ext = extension.startsWith('.') ? extension : '.' + extension;
  const fileName = `${title} - ${artist}${ext}`;

  return fileName;
}

/**
 * 带重试的下载启动函数
 */
async function startDownloadWithRetry(music, plugin, quality, initialFilePath, musicId, reqId, maxRetries = 3, source = 'download-btn') {
  const downloadService = singletons.downloadService;
  const result = await downloadService.downloadSong({
    music,
    plugin,
    quality,
    filePath: initialFilePath,
    reqId,
    maxRetries,
    source,
    updateStatus: (updates) => {
      database.updateDownloadStatus(musicId, plugin, updates);
    }
  });

  return result;
}

/**
 * 枚举已安装的插件名（实现见 MusicFree/plugin-manager.js，此处保留同名导出）
 * 兼容布局：平铺 <dir>/<name>.js、同名字目录 <dir>/<name>/<name>.js、别名子目录 <dir>/<别名>/<name>.js
 */
function listPluginNames(pluginsDir) {
  return pluginManager.listPluginNames(pluginsDir || singletons.PLUGINS_DIR);
}

/**
 * 获取默认插件（按文件名排序的第一个插件，兼容新旧布局）
 */
function getDefaultPlugin() {
  return pluginManager.getDefaultPlugin(singletons.PLUGINS_DIR);
}

/**
 * 计算下次 Cron 执行时间
 */
function getNextCronTime(cronExpression) {
  try {
    const parts = cronExpression.split(' ');
    if (parts.length !== 5) return null;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const now = new Date();
    const next = new Date(now);

    if (minute === '*' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
      next.setMinutes(next.getMinutes() + 1);
      next.setSeconds(0);
      next.setMilliseconds(0);
      return next.getTime();
    }

    if (minute !== '*' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
      const targetMinute = parseInt(minute) || 0;
      next.setMinutes(targetMinute);
      next.setSeconds(0);
      next.setMilliseconds(0);
      if (next <= now) {
        next.setHours(next.getHours() + 1);
      }
      return next.getTime();
    }

    if (minute !== '*' && hour !== '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
      const targetHour = parseInt(hour) || 0;
      const targetMinute = parseInt(minute) || 0;
      next.setHours(targetHour);
      next.setMinutes(targetMinute);
      next.setSeconds(0);
      next.setMilliseconds(0);
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }
      return next.getTime();
    }

    if (dayOfMonth !== '*') {
      const targetDay = parseInt(dayOfMonth) || 1;
      const targetHour = parseInt(hour) || 0;
      const targetMinute = parseInt(minute) || 0;
      next.setDate(targetDay);
      next.setHours(targetHour);
      next.setMinutes(targetMinute);
      next.setSeconds(0);
      next.setMilliseconds(0);
      if (next <= now) {
        next.setMonth(next.getMonth() + 1);
      }
      return next.getTime();
    }

    if (dayOfWeek !== '*') {
      const targetDayOfWeek = parseInt(dayOfWeek) || 0;
      const targetHour = parseInt(hour) || 0;
      const targetMinute = parseInt(minute) || 0;
      const currentDayOfWeek = next.getDay();
      const daysUntilTarget = (targetDayOfWeek - currentDayOfWeek + 7) % 7;
      next.setDate(next.getDate() + daysUntilTarget);
      next.setHours(targetHour);
      next.setMinutes(targetMinute);
      next.setSeconds(0);
      next.setMilliseconds(0);
      if (daysUntilTarget === 0 && next <= now) {
        next.setDate(next.getDate() + 7);
      }
      return next.getTime();
    }

    return now.getTime() + 24 * 60 * 60 * 1000;
  } catch (err) {
    logger.error('SYSTEM', 'cron', `Error calculating next cron time`, { error: logger.formatError(err) });
    return null;
  }
}

/**
 * 执行插件自动更新（实现见 MusicFree/plugin-manager.js）
 * 定时与手动共用同一实现：兼容 <别名> 子目录布局、更新前做 SSRF 防护、
 * 更新地址缺失时回溯插件自带 srcUrl。
 * @param {{sendNotification?: boolean}} options sendNotification 为 false 时不发外部通知
 */
async function runAutoUpdatePlugins(options = {}) {
  return pluginManager.runAutoUpdatePlugins(options);
}

// ---------------- MusicFree 插件管理层依赖注入 ----------------
// plugin-manager 不能反向 require 本模块（本文件末尾整体替换 module.exports，
// 循环 require 时对方只会拿到加载中途的空对象），故统一在此注入所需资源。
pluginManager.init({
  getPluginsDir: () => singletons.PLUGINS_DIR,
  getAutoUpdateConfig: (...args) => database.getAutoUpdateConfig(...args),
  updateAutoUpdateConfig: (...args) => database.updateAutoUpdateConfig(...args),
  getNextCronTime,
  notify: (...args) => notifications.sendMarkdownNotification(...args),
  // 延迟 require：lib/radio.js 依赖本模块，顶层 require 会形成循环依赖
  isStationPlugin: (plugin) => {
    try { return require('./radio').isStationPlugin(plugin); } catch { return false; }
  }
});

// DNS 解析（代理路由使用）
const proxyDns = require('dns').promises;

// ==================== 导出 ====================

module.exports = {
  // 第三方依赖
  path, fs, axios, cron, multer, randomUUID, proxyDns,

  // 核心模块
  logger, frontendLogger, runPlugin, _require, loadPluginModule, resolvePluginFilePath, ResolverCore, initResolverCore,
  DownloadManager, SchedulerManager, DownloadService,

  // 配置层 / 通知层
  config, notifications,

  // 数据库层
  database,

  // 鉴权中间件
  generateToken, verifyToken, authMiddleware, adminMiddleware, createReqId,

  // 单例注册
  setSingletons,

  // 单例访问器（延迟读取，确保加载顺序无关）
  get downloadSettings() { return singletons.downloadSettings; },
  get userConfigs() { return singletons.userConfigs; },
  get schedulerManager() { return singletons.schedulerManager; },
  get downloadService() { return singletons.downloadService; },
  get DATA_DIR() { return singletons.DATA_DIR; },
  get DOWNLOAD_DIR() { return singletons.DOWNLOAD_DIR; },
  get CONFIG_FILE() { return singletons.CONFIG_FILE; },
  get PLUGIN_CONFIG_FILE() { return singletons.PLUGIN_CONFIG_FILE; },
  get CACHE_DIR() { return singletons.CACHE_DIR; },
  get CACHE_INDEX_FILE() { return singletons.CACHE_INDEX_FILE; },
  get PLUGINS_DIR() { return singletons.PLUGINS_DIR; },
  get frontendPath() { return singletons.frontendPath; },
  get topListsCache() { return singletons.topListsCache; },
  get TOPLIST_CACHE_TTL() { return singletons.TOPLIST_CACHE_TTL; },

  // helper
  toDockerPath, sanitizeFilename, generateDownloadFilePath, startDownloadWithRetry,
  getNextCronTime, runAutoUpdatePlugins, getDefaultPlugin, listPluginNames
};
