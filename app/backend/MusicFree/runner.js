const path = require('path');
const fs = require('fs');
const logger = require('../core/logger');
const { loadPluginConfig } = require('../lib/config');

// 插件请求节流控制 - 避免批量请求导致风控
const pluginLastRequestTime = new Map();
const PLUGIN_MIN_INTERVAL = 1000; // 同一插件最小请求间隔1秒（平衡速度和风控）

// 模拟 MusicFree 环境的 require
const axios = require('axios');
const CryptoJs = require('crypto-js');
const cheerio = require('cheerio');
const dayjs = require('dayjs');
const bigInt = require('big-integer');
const qs = require('qs');
const he = require('he');
const webdav = require('webdav');

// 插件请求超时（毫秒），可通过环境变量 PLUGIN_TIMEOUT 调整，默认 15 秒
// 之前硬编码 5000ms 在国内波动网络/容器出网慢时容易触发 timeout of 5000ms exceeded
const PLUGIN_TIMEOUT = parseInt(process.env.PLUGIN_TIMEOUT, 10) || 15000;

// 创建 axios 实例并添加拦截器，自动编码 URL 中的中文字符
const axiosInstance = axios.create({
  timeout: PLUGIN_TIMEOUT,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});
axiosInstance.interceptors.request.use((config) => {
  // 插件数据里 URL 可能被反引号包裹（如弥音QQ 的封面/接口地址），请求前统一去除
  if (config.url) {
    config.url = String(config.url).replace(/^`+|`+$/g, '').trim();
  }
  // 对 URL 进行编码，处理中文字符
  if (config.url) {
    try {
      const url = new URL(config.url);
      // 对 pathname 进行编码（处理路径中的中文）
      url.pathname = encodeURI(url.pathname);
      config.url = url.toString();
    } catch (_e) {
      // 如果 URL 解析失败，尝试直接编码
      config.url = config.url.replace(/[^\x00-\x7F]/g, (char) => encodeURIComponent(char));
    }
  }
  // header 值（如 referer）也可能被反引号包裹，一并去除
  if (config.headers) {
    const h = config.headers;
    const setH = (typeof h.set === 'function') ? (k, v) => h.set(k, v) : (k, v) => { h[k] = v; };
    for (const k of Object.keys(h)) {
      const v = h[k];
      if (typeof v === 'string' && v.includes('`')) {
        setH(k, v.replace(/`/g, '').trim());
      }
    }
  }
  return config;
});

const packages = {
  axios: axiosInstance,
  'crypto-js': CryptoJs,
  cheerio,
  dayjs,
  'big-integer': bigInt,
  qs,
  he,
  webdav,
};

// 按插件隔离的 storage 实现（防止不同插件互相覆盖键），并限制总量防止内存无限增长。
// 说明：currentStorageNs 在 runPlugin 执行期间按当前插件名设置；在插件 API 不变的前提下
// 无法做到严格的按用户隔离（插件在加载时即捕获了共享的 storage 引用），此处为插件级隔离，
// 相比原全局共享已能避免插件间键冲突，并通过 LRU 上限防止内存只增不减。
const pluginStorageStore = new Map();
const PLUGIN_STORAGE_MAX = 2000;
let currentStorageNs = 'global';
function pluginStorageKey(key) {
  return currentStorageNs + '|' + key;
}
const pluginStorage = {
  getItem: async (key) => {
    const v = pluginStorageStore.get(pluginStorageKey(key));
    return v === undefined ? null : v;
  },
  setItem: async (key, value) => {
    pluginStorageStore.set(pluginStorageKey(key), value);
    if (pluginStorageStore.size > PLUGIN_STORAGE_MAX) {
      pluginStorageStore.delete(pluginStorageStore.keys().next().value);
    }
  },
  removeItem: async (key) => {
    pluginStorageStore.delete(pluginStorageKey(key));
  }
};
packages['musicfree/storage'] = pluginStorage;

const _require = (packageName) => {
  const pkg = packages[packageName];
  if (pkg) {
    pkg.default = pkg;
    return pkg;
  }
  throw new Error(`Package ${packageName} not found`);
};

// 解析插件磁盘文件路径，同时兼容多种布局：
//   A) 旧平铺：<dir>/<name>.js
//   B) 同名字目录：<dir>/<name>/<name>.js
//   C) 别名子目录（文件夹名=插件别名，内部文件保持原文件名）：<dir>/<别名>/<name>.js
// 返回的是插件磁盘文件上的 <name>.js 的绝对路径。
function resolvePluginFilePath(pluginDir, pluginName) {
  if (typeof pluginName !== 'string' || pluginName.length === 0) return null;
  if (pluginName.includes('/') || pluginName.includes('\\') || pluginName.includes('..')) return null;
  const baseDir = path.resolve(pluginDir);
  const candidates = [
    path.resolve(pluginDir, pluginName),
    path.resolve(pluginDir, pluginName, pluginName)
  ];
  for (const resolved of candidates) {
    if (resolved !== baseDir && resolved.startsWith(baseDir + path.sep)) {
      try {
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
      } catch { /* 忽略 stat 异常 */ }
    }
  }
  // 别名子目录布局：<dir>/<别名>/<name>.js，文件夹名是别名、与文件名不同，
  // 需要遍历各子目录按文件名查找插件的磁盘文件
  try {
    for (const sub of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      if (sub.name.includes('/') || sub.name.includes('\\') || sub.name.includes('..')) continue;
      const resolved = path.resolve(baseDir, sub.name, pluginName);
      if (resolved.startsWith(baseDir + path.sep) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return resolved;
      }
    }
  } catch { /* 忽略 readdir 异常 */ }
  return candidates[0];
}

// 安全地解析插件路径：拒绝路径分隔符与父目录引用，确保只能加载插件目录内的文件，
// 防止 pluginName 传入 ../../xxx 逃逸出插件目录、把任意 JS 当插件加载执行（路径穿越）
function resolveSafePluginPath(pluginDir, pluginName) {
  if (typeof pluginName !== 'string' || pluginName.length === 0) {
    throw new Error('Invalid plugin name');
  }
  if (pluginName.includes('/') || pluginName.includes('\\') || pluginName.includes('..')) {
    throw new Error(`Invalid plugin name: ${pluginName}`);
  }
  const resolved = resolvePluginFilePath(pluginDir, pluginName);
  const baseDir = path.resolve(pluginDir);
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
    throw new Error(`Plugin path escapes plugins directory: ${pluginName}`);
  }
  return resolved;
}

/**
 * 读取为插件单独配置的用户变量（插件管理页「用户变量」按钮设置）。
 * 调用方传入的 userVars 仍可覆盖插件级配置，保证向后兼容。
 */
function getPluginUserVars(pluginName) {
  try {
    const allConfig = loadPluginConfig();
    const cfg = allConfig[pluginName] || {};
    return cfg.userVars && typeof cfg.userVars === 'object' ? cfg.userVars : {};
  } catch (e) {
    logger.warn('PLUGIN', 'runner', `Failed to load userVars for ${pluginName}`, { error: e.message });
    return {};
  }
}

// 「尽力而为」型调用的 reqId 标签：这些链路有各自的兜底（如封面占位图），
// 插件失败属预期行为，异常日志降级为 debug
const QUIET_PLUGIN_ERROR_TAGS = new Set(['my-list-cover']);

// getMusicInfo 连续失败退避阈值与时长（见 runPlugin 内注释）
const PLUGIN_METHOD_BACKOFF_THRESHOLD = 3;
const PLUGIN_METHOD_BACKOFF_MS = 10 * 60 * 1000;
const pluginMethodFailures = new Map(); // `${plugin}|getMusicInfo` -> { count, until }

async function runPlugin(pluginName, method, args, userVars, pluginsDir, reqId = 'system', enableThrottle = false, timeoutMs = 0) {
  // 本地音乐特殊处理：不走插件系统
  if (pluginName === 'local') {
    throw new Error('Local music does not support plugin operations');
  }

  // 请求节流控制 - 仅下载操作启用（避免风控）
  if (enableThrottle) {
    const now = Date.now();
    const lastRequest = pluginLastRequestTime.get(pluginName) || 0;
    const timeSinceLastRequest = now - lastRequest;
    
    if (timeSinceLastRequest < PLUGIN_MIN_INTERVAL) {
      const waitTime = PLUGIN_MIN_INTERVAL - timeSinceLastRequest;
      logger.debug(`PLUGIN:${pluginName}`, reqId, `Rate limit: waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    pluginLastRequestTime.set(pluginName, Date.now());
    if (pluginLastRequestTime.size > 512) {
      pluginLastRequestTime.delete(pluginLastRequestTime.keys().next().value);
    }
  }

  // getMusicInfo 连续失败退避：同一插件该方法连续失败 ≥3 次（如封面相关接口失效），
  // 10 分钟内不再真正执行、直接快速失败，由各调用方的兜底链路（辅助封面插件 / 搜索）接管。
  // 仅限 getMusicInfo——播放解析（getMediaSource）等关键方法不做退避，避免瞬态故障影响播放。
  // 检查放在最前（插件加载/编译之前），退避期内零开销。
  const backoffKey = method === 'getMusicInfo' ? `${pluginName}|${method}` : null;
  if (backoffKey) {
    const st = pluginMethodFailures.get(backoffKey);
    if (st && st.until) {
      if (Date.now() < st.until) {
        const err = new Error(`Plugin ${method} temporarily skipped (backoff)`);
        err.skippedByBackoff = true;
        throw err;
      }
      // 退避窗口已过期：清空状态，重新计数（插件修复后首次成功即正常）
      pluginMethodFailures.delete(backoffKey);
    }
  }

  const pluginDir = pluginsDir || path.join(__dirname, '..', '..', 'plugins');
  const pluginPath = resolveSafePluginPath(pluginDir, pluginName);

  // 检查文件是否存在
  if (!fs.existsSync(pluginPath)) {
    throw new Error(`Plugin file not found: ${pluginPath}`);
  }

  // 获取（带 mtime 缓存的）已编译插件函数：避免每次请求都重读文件并重编译，
  // 仍通过文件 mtime 检测插件变更以支持热更新（原 delete require.cache 对 new Function 路径无效）
  const pluginFunc = compilePlugin(pluginPath);
  currentStorageNs = pluginName;

  // 注入 env（模拟 MusicFree）
  // 改为局部变量，避免进程级 global.env 在并发请求间互相覆盖/串用用户变量
  // 优先合并插件级用户变量（插件管理页设置），调用方传入的 userVars 可覆盖
  const effectiveUserVars = { ...getPluginUserVars(pluginName), ...(userVars || {}) };
  const env = {
    getUserVariables: () => effectiveUserVars,
    os: 'linux',
    appVersion: '1.0.4',
    lang: 'zh-CN',
  };

  // 确保 URL 和 URLSearchParams 可用
  if (!global.URL) {
    global.URL = URL;
  }
  if (!global.URLSearchParams) {
    global.URLSearchParams = URLSearchParams;
  }

  // 确保 atob 和 btoa 可用
  if (!global.atob) {
    global.atob = (str) => Buffer.from(str, 'base64').toString('binary');
  }
  if (!global.btoa) {
    global.btoa = (str) => Buffer.from(str, 'binary').toString('base64');
  }

  // 创建模块对象
  const _module = { exports: {}, loaded: false };

  // 模拟 ensurePluginInitialized
  let loadResolveCallback = null;
  const ensurePluginInitialized = new Promise((resolve) => {
    loadResolveCallback = resolve;
  });

  const _process = {
    platform: 'linux',
    version: '1.0.0',
    env: env,
    ensurePluginInitialized,
  };

  // 使用与 MusicFree 桌面版类似的方式执行插件
  try {
    pluginFunc(
      _require,
      _require,
      _module,
      _module.exports,
      console,
      env,
      _process,
    );

    // 标记插件已初始化
    loadResolveCallback?.();
  } catch (e) {
    throw e;
  }

  _module.loaded = true;

  // 获取插件实例
  const plugin = _module.exports.default || _module.exports;

  if (!plugin[method]) {
    throw new Error(`Method ${method} not found in plugin`);
  }

  // 超时控制 - 比 axios 超时(PLUGIN_TIMEOUT)再多 2 秒缓冲，避免比 axios 先触发；
  // 调用方可通过 timeoutMs 覆盖（如热门歌单全量导入曲目较多，需要更长超时）
  const execTimeout = timeoutMs || (PLUGIN_TIMEOUT + 2000);
  let timeoutTimer = null;
  const timeout = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new Error('Plugin execution timeout')), execTimeout);
  });

  try {
    const result = await Promise.race([plugin[method](...args), timeout]);
    // 成功即清除失败计数（插件修复后自动恢复直调）
    if (backoffKey) pluginMethodFailures.delete(backoffKey);
    return result;
  } catch (err) {
    // 退避期的快速失败：不记日志（避免刷屏），直接抛给调用方走兜底
    if (!err.skippedByBackoff) {
      // 「尽力而为」型后台调用（失败属预期、调用方自行兜底）：降级为 debug，避免批量失败刷屏 ERROR
      if (QUIET_PLUGIN_ERROR_TAGS.has(reqId)) {
        logger.debug(`PLUGIN:${pluginName}`, reqId, `error (best-effort) | ${method} | ${err.message}`);
      } else {
        logger.error(`PLUGIN:${pluginName}`, reqId, `ERROR | ${method} | ${err.message}`);
      }
      if (backoffKey) {
        const st = pluginMethodFailures.get(backoffKey) || { count: 0, until: 0 };
        st.count++;
        if (st.count >= PLUGIN_METHOD_BACKOFF_THRESHOLD) {
          st.until = Date.now() + PLUGIN_METHOD_BACKOFF_MS;
          st.count = 0;
          logger.warn(`PLUGIN:${pluginName}`, reqId, `${method} failed ${PLUGIN_METHOD_BACKOFF_THRESHOLD}x consecutively, backing off 10min (callers will use fallbacks)`);
        }
        pluginMethodFailures.set(backoffKey, st);
      }
    }
    throw err;
  } finally {
    // 执行结束（无论成败）清理超时定时器，避免长会话下堆积挂起 timer
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

// 插件编译缓存：key 为插件路径，value 为 { mtime, size, func }
// 通过文件 mtime 判断插件是否变更，从而在支持热更新的同时避免每次请求都重新编译插件代码。
// 同时比对文件 size：部分文件系统（如 Samba/NAS 挂载）可能保留 mtime，仅 mtime 判断会漏掉热更新。
const pluginCompileCache = new Map();

function compilePlugin(pluginPath) {
  let stat;
  try {
    stat = fs.statSync(pluginPath);
  } catch (e) {
    throw new Error(`Plugin file not found: ${pluginPath}`);
  }
  const cached = pluginCompileCache.get(pluginPath);
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
    return cached.func;
  }
  const pluginCode = fs.readFileSync(pluginPath, 'utf-8');
  const func = Function(`
    'use strict';
    return function(require, __musicfree_require, module, exports, console, env, process) {
      ${pluginCode}
    }
  `)();
  pluginCompileCache.set(pluginPath, { mtime: stat.mtimeMs, size: stat.size, func });
  return func;
}

/**
 * 仅编译并执行插件模块，返回其导出的 platform 对象。
 * 用于插件列表/信息读取，不执行业务方法，无超时控制。
 * 与 runPlugin 共用 compilePlugin 沙箱，保证加载逻辑一致。
 */
function loadPluginModule(pluginPath) {
  if (!fs.existsSync(pluginPath)) {
    return null;
  }
  const pluginFunc = compilePlugin(pluginPath);
  const _module = { exports: {}, loaded: false };
  const env = {
    getUserVariables: () => ({}),
    os: 'linux',
    appVersion: '1.0.4',
    lang: 'zh-CN',
  };
  const _process = { platform: 'linux', version: '1.0.0', env };
  if (!global.URL) global.URL = URL;
  if (!global.URLSearchParams) global.URLSearchParams = URLSearchParams;
  if (!global.atob) global.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  if (!global.btoa) global.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  pluginFunc(_require, _require, _module, _module.exports, console, env, _process);
  _module.loaded = true;
  return _module.exports.default || _module.exports;
}

module.exports = { runPlugin, _require, loadPluginModule, resolvePluginFilePath };
