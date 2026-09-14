'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../core/logger');

// 与 server.js 保持一致：server.js 在 backend/ 下用 __dirname/../data => /app/data
// 本文件位于 backend/lib/，故需向上两级（lib -> backend -> app）再到 data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
// 旧企业微信应用配置文件路径（仅用于迁移到 config.json）
const WECOM_APP_CONFIG_FILE = path.join(DATA_DIR, 'wecom-app.json');

// ==================== 全局配置层 ====================

// 内存缓存：避免每次读取都全量 fs.readFileSync + JSON.parse 整个 config.json
// （很多热路径都会读取插件/通知配置）。以文件 mtime 为准做失效，
// 外部手动修改 config.json 后也能在下次读取时自动重新加载。
let _configCache = undefined;
let _configCacheMtime = -1;

function loadGlobalConfig() {
  try {
    const st = fs.statSync(CONFIG_FILE);
    if (_configCache !== undefined && st.mtimeMs === _configCacheMtime) {
      // 命中缓存：返回独立副本，保持与「每次重新解析」一致的隔离语义
      return structuredClone(_configCache);
    }
    let config = { plugins: {}, notification: {} };
    if (st.isFile()) {
      try {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      } catch (e) {
        logger.error('SYSTEM', 'config', `Error loading config, backing up corrupt file`, { error: logger.formatError(e) });
        // JSON 损坏时不直接丢弃：先把原文件备份成 config.json.corrupt.<时间戳>，保留证据，
        // 再回退默认配置继续启动（避免后续保存把损坏文件覆盖、丢失可恢复信息）。
        try {
          const corruptPath = CONFIG_FILE + '.corrupt.' + Date.now();
          fs.renameSync(CONFIG_FILE, corruptPath);
          logger.error('SYSTEM', 'config', `Corrupt config backed up to ${corruptPath}`);
        } catch (e2) { /* 重命名失败不阻塞启动 */ }
      }
    }
    _configCache = config;
    _configCacheMtime = st.mtimeMs;
    return structuredClone(_configCache);
  } catch (e) {
    // 文件不存在等情况：回退到默认配置（仍缓存，避免反复抛错）
    if (_configCache === undefined) _configCache = { plugins: {}, notification: {} };
    return structuredClone(_configCache);
  }
}

// 加载通知配置（从全局配置中读取）
function loadNotificationConfig() {
  const config = loadGlobalConfig();
  return config.notification || {};
}

// 保存通知配置（保存到全局配置）
function saveNotificationConfig(notificationConfig) {
  const config = loadGlobalConfig();
  config.notification = { ...config.notification, ...notificationConfig };
  saveGlobalConfig(config);
  logger.info('SYSTEM', 'config', 'Notification config saved');
}

// 保存全局配置
function saveGlobalConfig(config) {
  try {
    // 确保数据目录存在（避免 DATA_DIR 不存在时报 ENOENT）
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    // 先更新缓存再落盘，并通过文件 mtime 保持缓存与磁盘一致
    _configCache = config;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    _configCacheMtime = fs.statSync(CONFIG_FILE).mtimeMs;
    // config.json 现含敏感字段（corpsecret / api_key 等），限制为仅属主可读写
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (e) { /* Windows 下权限位被忽略 */ }
  } catch (e) {
    logger.error('SYSTEM', 'config', `Error saving config`, { error: logger.formatError(e) });
    throw e;
  }
}

// 加载插件配置（从全局配置中读取）
function loadPluginConfig() {
  const config = loadGlobalConfig();
  return config.plugins || {};
}

// 保存插件配置（保存到全局配置）
function savePluginConfig(pluginsConfig) {
  const config = loadGlobalConfig();
  config.plugins = pluginsConfig;
  saveGlobalConfig(config);
}

// ==================== LX（落雪）自定义音源配置 ====================
// 存 config.json 的 lxSources 字段：{ [文件名]: { enabled, name, author, version, description, ... } }
// 脚本本体放在 data/plugins/LX/ 下，便于直接拷入/查看。
function loadLxSourceConfig() {
  const config = loadGlobalConfig();
  const v = config.lxSources;
  return (v && typeof v === 'object') ? v : {};
}

function saveLxSourceConfig(lxSourcesConfig) {
  const config = loadGlobalConfig();
  config.lxSources = lxSourcesConfig || {};
  saveGlobalConfig(config);
}

// ==================== OpenList / strm 配置 ====================
// strm 文件播放用的内网（直连）与外网穿透（拼接 pathname）基地址。
// 优先级：环境变量 OPENLIST_LOCAL_BASE_URL / OPENLIST_PUBLIC_BASE_URL > config.json 对应字段。
// 兼容旧名 ALIST_LOCAL_BASE_URL / ALIST_PUBLIC_BASE_URL / alistLocalBaseUrl / alistPublicBaseUrl（同时读取）。
function loadOpenlistConfig() {
  const config = loadGlobalConfig();
  const localBaseUrl = process.env.OPENLIST_LOCAL_BASE_URL
    || process.env.ALIST_LOCAL_BASE_URL          // 兼容旧环境变量
    || config.openlistLocalBaseUrl
    || config.alistLocalBaseUrl                  // 兼容旧字段
    || '';
  const publicBaseUrl = process.env.OPENLIST_PUBLIC_BASE_URL
    || process.env.ALIST_PUBLIC_BASE_URL         // 兼容旧环境变量
    || config.openlistPublicBaseUrl
    || config.alistPublicBaseUrl                 // 兼容旧字段
    || '';
  return {
    localBaseUrl: String(localBaseUrl || '').trim(),
    publicBaseUrl: String(publicBaseUrl || '').trim()
  };
}

// 保存 OpenList 配置（写入全局 config.json 顶层字段，持久化供后端读取）。
// 同时把旧字段也镜像保留一份，避免外部脚本/旧版本读取时丢值。
function saveOpenlistConfig(openlistConfig) {
  const config = loadGlobalConfig();
  const localBaseUrl = String((openlistConfig && openlistConfig.openlistLocalBaseUrl) || '').trim();
  const publicBaseUrl = String((openlistConfig && openlistConfig.openlistPublicBaseUrl) || '').trim();
  config.openlistLocalBaseUrl = localBaseUrl;
  config.openlistPublicBaseUrl = publicBaseUrl;
  config.alistLocalBaseUrl = localBaseUrl;        // 兼容镜像
  config.alistPublicBaseUrl = publicBaseUrl;      // 兼容镜像
  saveGlobalConfig(config);
  logger.info('SYSTEM', 'config', 'OpenList (strm) config saved', {
    localBaseUrl,
    publicBaseUrl
  });
}

// ==================== 系统设置（原 SQLite settings 表） ====================
// 为把分散的配置统一进 config.json，系统设置（主题/音质/下载路径/API 秘钥等）
// 改存到 config.json 的 settings 字段，便于备份与迁移，避免配置散落多处。
// 其余运行时 KV（如 playlist_refresh_*、downloadQuality）仍留在 SQLite。

/**
 * 读取系统设置（来自 config.json 的 settings 字段）
 * @param {string} key
 * @param {any} defaultValue
 * @returns {any}
 */
function getConfigSetting(key, defaultValue = null) {
  const config = loadGlobalConfig();
  if (config.settings && typeof config.settings === 'object' && Object.prototype.hasOwnProperty.call(config.settings, key)) {
    return config.settings[key];
  }
  return defaultValue;
}

/**
 * 写入系统设置（写入 config.json 的 settings 字段）
 * @param {string} key
 * @param {any} value
 */
function setConfigSetting(key, value) {
  const config = loadGlobalConfig();
  if (!config.settings || typeof config.settings !== 'object') config.settings = {};
  config.settings[key] = value;
  saveGlobalConfig(config);
  return value;
}

// ==================== 企业微信应用配置（原 wecom-app.json） ====================
// 并入 config.json 的 wecomApp 字段，与系统设置/插件配置统一管理。
const WECOM_APP_DEFAULT = {
  enabled: false,
  corpid: '',
  corpsecret: '',
  agentid: '',
  token: '',            // 回调 Token
  encodingAESKey: '',   // 回调 EncodingAESKey
  touser: '@all',       // 应用消息接收人
  menuEnabled: false,
  callbackUrl: ''       // 回调 URL
};

function _loadWecomAppRaw() {
  const config = loadGlobalConfig();
  return (config.wecomApp && typeof config.wecomApp === 'object') ? config.wecomApp : null;
}

/**
 * 读取企业微信应用配置。
 * 首次读取时若 config.json 尚无 wecomApp，则尝试把旧独立 wecom-app.json 迁移进来；
 * 否则返回默认值（含默认字段）。
 */
function getWecomAppConfig() {
  const raw = _loadWecomAppRaw();
  if (raw) {
    const merged = Object.assign({}, WECOM_APP_DEFAULT, raw);
    // 已并入 config.json：若旧独立 wecom-app.json 仍存在，则清理冗余旧文件
    if (fs.existsSync(WECOM_APP_CONFIG_FILE)) {
      const isDefault = Object.keys(WECOM_APP_DEFAULT).every(k => merged[k] === WECOM_APP_DEFAULT[k]);
      if (!isDefault) {
        // config 中已有真实配置，删除冗余旧文件即可
        try { fs.unlinkSync(WECOM_APP_CONFIG_FILE); } catch (e) { /* 删除失败不影响配置 */ }
      } else {
        // config 中仅为默认值，旧文件可能才是真实来源：合并之并删除旧文件
        try {
          const migrated = JSON.parse(fs.readFileSync(WECOM_APP_CONFIG_FILE, 'utf8'));
          const realMerged = Object.assign({}, WECOM_APP_DEFAULT, migrated);
          saveWecomAppConfig(realMerged);
          try { fs.unlinkSync(WECOM_APP_CONFIG_FILE); } catch (e) { /* 删除失败不影响配置 */ }
          return realMerged;
        } catch (e) { /* ignore */ }
      }
    }
    return merged;
  }
  // 旧独立文件迁移（合并进 config.json）
  try {
    if (fs.existsSync(WECOM_APP_CONFIG_FILE)) {
      const migrated = JSON.parse(fs.readFileSync(WECOM_APP_CONFIG_FILE, 'utf8'));
      const merged = Object.assign({}, WECOM_APP_DEFAULT, migrated);
      saveWecomAppConfig(merged);
      logger.info('SYSTEM', 'config', 'Migrated legacy wecom-app.json into config.json');
      // 已成功合并进 config.json 后，删除旧独立文件，避免配置分散/重复
      try { fs.unlinkSync(WECOM_APP_CONFIG_FILE); } catch (e) { /* 删除失败不影响配置 */ }
      return merged;
    }
  } catch (e) {
    logger.error('SYSTEM', 'config', 'Failed to migrate wecom-app.json', { error: logger.formatError(e) });
  }
  return Object.assign({}, WECOM_APP_DEFAULT);
}

function saveWecomAppConfig(cfg) {
  const config = loadGlobalConfig();
  config.wecomApp = Object.assign({}, config.wecomApp || {}, cfg);
  saveGlobalConfig(config);
  return config.wecomApp;
}

function hasWecomApp() {
  return !!_loadWecomAppRaw();
}

module.exports = {
  DATA_DIR,
  CONFIG_FILE,
  loadGlobalConfig,
  saveGlobalConfig,
  loadNotificationConfig,
  saveNotificationConfig,
  loadPluginConfig,
  savePluginConfig,
  // LX（落雪）自定义音源配置
  loadLxSourceConfig,
  saveLxSourceConfig,
  loadOpenlistConfig,
  saveOpenlistConfig,
  // 系统设置（原 SQLite settings 表）→ config.json.settings
  getConfigSetting,
  setConfigSetting,
  // 企业微信应用配置（原 wecom-app.json）→ config.json.wecomApp
  WECOM_APP_DEFAULT,
  getWecomAppConfig,
  saveWecomAppConfig,
  hasWecomApp,
  // 旧名向后兼容别名（内部调用已统一改为 OpenList 名，导出别名仅供外部脚本/旧调用使用）
  loadAlistConfig: loadOpenlistConfig,
  saveAlistConfig: saveOpenlistConfig
};
