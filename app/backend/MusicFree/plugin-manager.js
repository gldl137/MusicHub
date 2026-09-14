'use strict';

// =============================================================
// MusicFree 插件管理核心
// 与 runner.js（插件沙箱）/ resolver-core.js（解析层）一起构成 MusicFree 专属层。
// 职责：插件枚举与定位、元信息解析、安装（文件 / URL）、删除、配置读写、批量更新。
//
// 依赖注入：本模块与 lib/context.js 之间不能互相 require（context.js 在末尾整体
// 替换 module.exports，循环 require 时对方拿到的是加载中途的空对象）。
// 因此可变/易成环的依赖（插件目录、通知、数据库、电台判定、cron 计算）统一由
// context.js 通过 init() 注入；无环的叶子模块（logger / config / proxy-utils / runner）直接 require。
// =============================================================

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const axios = require('axios');
const cron = require('node-cron');

const logger = require('../core/logger');
const frontendLogger = require('../core/frontend-logger');
const { loadPluginConfig, savePluginConfig } = require('../lib/config');
const { resolveProxyGuard } = require('../rest/proxy-utils');
const { loadPluginModule, _require, resolvePluginFilePath } = require('./runner');

// 日志用的请求标识：与 lib/middleware.js 的 createReqId 保持同样的用途，
// 这里本地生成以避免为一个纯字符串再引入一层依赖。
function createReqId() {
  try {
    return randomUUID().slice(0, 8);
  } catch {
    return String(Date.now().toString(36));
  }
}

// ---------------- 依赖注入 ----------------

const deps = {
  /** 插件根目录（动态读取，目录可被 server.js 在启动时确定） */
  getPluginsDir: () => './plugins',
  /** 读取/写入「插件自动更新」配置（database） */
  getAutoUpdateConfig: async () => ({ enabled: false, cronExpression: '' }),
  updateAutoUpdateConfig: async () => {},
  /** 由 lib/context.js 提供的 5 段式 cron 计算 */
  getNextCronTime: () => null,
  /** 通知发送（lib/notifications.sendMarkdownNotification），返回 { success, error } */
  notify: async () => ({ success: false, error: '通知模块未初始化' }),
  /** 电台插件判定（lib/radio.isStationPlugin） */
  isStationPlugin: () => false,
};

/**
 * 注入外部依赖。由 lib/context.js 在模块加载完成后调用一次。
 * @param {object} d 依赖集合，缺省项保持默认实现（便于单测 / 脚本单独使用）
 */
function init(d) {
  Object.assign(deps, d || {});
}

function pluginsDir() {
  return deps.getPluginsDir();
}

// ---------------- 枚举与定位 ----------------

/**
 * 枚举已安装的插件名，兼容不同磁盘布局：
 *   A) 旧平铺：<dir>/<name>.js
 *   B) 同名字目录：<dir>/<name>/<name>.js
 *   C) 别名子目录（文件夹名=插件别名，内部文件保留文件名）：<dir>/<别名>/<name>.js
 * 返回插件磁盘文件名（<name>.js），可直接传给 resolvePluginFilePath / loadPluginInfo / runPlugin。
 */
function listPluginNames(dir) {
  const names = [];
  // 同名 .js 可能同时出现在平铺层与多个别名子目录（互相遮蔽，resolvePluginFilePath 只认第一个候选）：
  // 首次出现即收录并去重，保证列表项与实际解析到的文件一致
  const seen = new Set();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (entry.name.includes('/') || entry.name.includes('\\') || entry.name.includes('..')) continue;
    if (entry.isFile()) {
      if (entry.name.endsWith('.js') && !seen.has(entry.name)) {
        seen.add(entry.name);
        names.push(entry.name);
      }
    } else if (entry.isDirectory()) {
      // 子目录内可能有多个文件，但每个插件目录只应包含一个插件文件；取其中的 .js 文件名
      let inner = [];
      try {
        inner = fs.readdirSync(path.join(dir, entry.name));
      } catch { /* 忽略不可读目录 */ }
      for (const f of inner) {
        if (f.endsWith('.js') && !f.includes('/') && !f.includes('\\') && !seen.has(f)) {
          seen.add(f);
          names.push(f);
        }
      }
    }
  }
  return names;
}

/**
 * 获取默认插件（按文件名排序的第一个插件，兼容新旧布局）
 */
function getDefaultPlugin(dir) {
  const files = listPluginNames(dir || pluginsDir());
  return files[0] || null;
}

// 校验可安全用作插件目录名的别名：不得包含路径分隔符或父目录引用
function isSafeAlias(name) {
  if (typeof name !== 'string' || !name.trim()) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  return true;
}

// 把任意来源的插件文件名约束为安全的单段文件名：拦截路径分隔符与父目录引用，
// 防止 install-from-url / 上传安装把文件写到插件目录之外（路径穿越）
function safePluginFileName(name) {
  const s = String(name || '');
  if (!s || s.includes('/') || s.includes('\\') || s.includes('..')) return '';
  return s;
}

/**
 * 修复安装时被转坏的中文插件文件名：
 * 1) URL 路径段通常是百分号编码（%E5%BC%A5...），先 decodeURIComponent
 * 2) multer 的 originalname 会把中文 utf8 字节按 latin1 解析成乱码（é\x85·æ...），
 *    若含扩展字符(>=U+0080)且能被 latin1->utf8 还原成合法 utf8，则还原
 */
function normalizePluginFileName(name) {
  if (!name) return name;
  let decoded;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    decoded = name;
  }
  if (/[\u0080-\u00FF]/.test(decoded)) {
    try {
      const fixed = Buffer.from(decoded, 'latin1').toString('utf8');
      if (!fixed.includes('\uFFFD') && fixed !== decoded) decoded = fixed;
    } catch {
      /* 保留原值 */
    }
  }
  return decoded;
}

// 在插件配置表中按文件名/平台名匹配配置 key（兼容 kg.js / kg / 编码名）
function findConfigKey(configMap, pluginName) {
  const decoded = decodeURIComponent(pluginName);
  for (const key of Object.keys(configMap || {})) {
    const decodedKey = decodeURIComponent(key);
    if (decodedKey === pluginName || decodedKey.replace('.js', '') === pluginName || key === pluginName) {
      return key;
    }
  }
  return null;
}

// 解析插件磁盘路径（兼容 kg 与 kg.js 两种传入形式、新旧平铺/子目录布局）
// 同时做路径穿越防护：插件名不得包含路径分隔符或父目录引用
function resolvePluginPath(pluginName) {
  try {
    if (typeof pluginName !== 'string' || pluginName.length === 0) return null;
    if (pluginName.includes('/') || pluginName.includes('\\') || pluginName.includes('..')) return null;
    const base = pluginsDir();
    const resolved = resolvePluginFilePath(base, pluginName);
    const baseDir = path.resolve(base);
    if (resolved !== baseDir && resolved.startsWith(baseDir + path.sep) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------- 元信息解析 ----------------

// 推导插件支持的方法列表。
// 真实 MusicFree 插件往往不声明 supportedMethods 数组，
// 而是把 search/getMediaSource/getTopLists 等方法直接作为对象属性定义，
// 因此需要在缺少该字段时根据其实际存在的方法属性来推断。
const STANDARD_PLUGIN_METHODS = [
  'search', 'getMediaSource', 'getMusicInfo', 'getLyric', 'getAlbumInfo',
  'getArtistWorks', 'getTopLists', 'getTopListDetail',
  'getRecommendSheetTags', 'getRecommendSheetsByTag', 'getMusicSheetInfo',
  'importMusicSheet', 'getMusicSheetResponseById', 'getCommentList'
];
function deriveSupportedMethods(plugin) {
  if (Array.isArray(plugin.supportedMethods) && plugin.supportedMethods.length > 0) {
    return plugin.supportedMethods;
  }
  return STANDARD_PLUGIN_METHODS.filter(m => typeof plugin[m] === 'function');
}

// 插件信息缓存：key 为插件绝对路径，value 为 { mtime, info }
// 避免每次请求都重跑插件顶层代码并重建信息对象（runner 已缓存编译，此处再省去信息计算）
const pluginInfoCache = new Map();

/**
 * 读取插件在 config.json 中的配置对象（含用户变量等）。
 * 单独抽函数，便于缓存命中时也刷新「配置」部分。
 */
function loadPluginConfigEntry(pluginName) {
  try {
    const allConfig = loadPluginConfig();
    return allConfig[pluginName] || {};
  } catch (e) {
    logger.warn('PLUGIN', createReqId(), `Failed to load config for ${pluginName}`, { error: e.message });
    return {};
  }
}

/**
 * 加载插件信息（含版本、配置等）
 */
async function loadPluginInfo(pluginName) {
  try {
    if (typeof pluginName !== 'string' || pluginName.length === 0) return null;
    if (pluginName.includes('/') || pluginName.includes('\\') || pluginName.includes('..')) return null;
    const pluginPath = resolvePluginFilePath(pluginsDir(), pluginName);
    if (!pluginPath || !pluginPath.endsWith('.js')) {
      return null;
    }

    const stats = fs.statSync(pluginPath);
    if (!stats.isFile()) {
      return null;
    }
    const cached = pluginInfoCache.get(pluginPath);
    if (cached && cached.mtime === stats.mtimeMs) {
      // 插件文件未变但配置可能已变（如刚保存用户变量），始终刷新 config 再返回，
      // 否则前端保存后重开弹窗会读到旧值。
      cached.info.config = loadPluginConfigEntry(pluginName);
      return cached.info;
    }

    const plugin = loadPluginModule(pluginPath);
    if (!plugin || !plugin.platform) {
      return null;
    }

    const result = {
      name: pluginName,
      platform: plugin.platform,
      version: plugin.version || 'unknown',
      author: plugin.author || 'unknown',
      description: plugin.description || '',
      srcUrl: plugin.srcUrl || '',
      defaultConfig: {},
      config: {},
      hasGetMediaSource: typeof plugin.getMediaSource === 'function',
      hasSearch: typeof plugin.search === 'function',
      hasGetLyric: typeof plugin.getLyric === 'function',
      hasGetMusicInfo: typeof plugin.getMusicInfo === 'function',
      userVariables: plugin.userVariables || [],
      supportedMethods: deriveSupportedMethods(plugin),
      // 标记电台插件（supportedSearchType 含 'station'），用于菜单过滤：
      // 电台插件只在「电台」菜单展示，不进入排行榜/热门歌单等音乐菜单
      isStation: deps.isStationPlugin(plugin)
    };

    if (typeof plugin.getConfig === 'function') {
      result.defaultConfig = plugin.getConfig() || {};
    }

    result.config = loadPluginConfigEntry(pluginName);

    pluginInfoCache.set(pluginPath, { mtime: stats.mtimeMs, info: result });
    return result;
  } catch (err) {
    logger.error('PLUGIN', createReqId(), `Failed to load plugin info for ${pluginName}`, { error: logger.formatError(err) });
    return null;
  }
}

/**
 * 构建「文件 → 所属子目录名」映射，用于前端按物理目录分组（音源组名）。
 */
function buildFileToGroup(pluginRoot) {
  const map = new Map();
  try {
    const entries = fs.readdirSync(pluginRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        map.set(entry.name, ''); // 平铺在根目录 → 无分组名
      } else if (entry.isDirectory()) {
        let inner;
        try { inner = fs.readdirSync(path.join(pluginRoot, entry.name)); } catch { continue; }
        for (const f of inner) {
          if (f.endsWith('.js')) map.set(f, entry.name);
        }
      }
    }
  } catch { /* 忽略 */ }
  return map;
}

/**
 * 插件列表（GET /api/plugins 的数据体）：
 * 含分组名、顺序、启用状态，并把缺失的 group 字段回填到配置。
 */
async function getPluginList() {
  const pluginRoot = pluginsDir();
  const files = listPluginNames(pluginRoot);
  const allConfig = loadPluginConfig();
  const plugins = [];
  const fileToGroup = buildFileToGroup(pluginRoot);

  for (const file of files) {
    const pluginConfig = allConfig[file] || {};
    // 目录别名（音源组名）：优先级 group 配置 > 物理目录 > displayName，统一 trim + NFC 归一化
    const dirAlias = (pluginConfig.group || fileToGroup.get(file) || pluginConfig.displayName || '').toString().trim().normalize('NFC');
    let info = null;
    let loadError = '';
    try {
      info = await loadPluginInfo(file);
    } catch (e) {
      loadError = (e && e.message) ? e.message : String(e);
    }

    if (info) {
      plugins.push({
        ...info,
        displayName: pluginConfig.displayName || '',
        // 地址优先取安装时记录的 url，缺失时回溯插件代码自带的 srcUrl（保证一键更新有来源）
        url: pluginConfig.url || info.srcUrl || '',
        remark: pluginConfig.remark || '',
        enabled: pluginConfig.enabled !== false,
        groupName: dirAlias
      });
    } else {
      // 文件无法加载（语法错误/顶层重复声明等）：仍纳入列表并标记原因，
      // 避免「安装了却看不到、也无法删除」的盲区；分组按目录别名归入对应音源表格。
      plugins.push({
        name: file,
        platform: pluginConfig.displayName || dirAlias || file.replace(/\.js$/i, '') || '未知音源',
        displayName: pluginConfig.displayName || '',
        url: pluginConfig.url || '',
        remark: pluginConfig.remark || '',
        enabled: pluginConfig.enabled !== false,
        groupName: dirAlias,
        author: '—',
        version: '—',
        loadError: loadError || '插件文件无法加载'
      });
    }
  }

  // 按用户保存的顺序排序（__pluginOrder 存储配置 key 的有序数组），未在列表中的插件排在末尾
  const orderIndex = (Array.isArray(allConfig.__pluginOrder) ? allConfig.__pluginOrder : [])
    .reduce((m, k, i) => { m[k] = i; return m; }, {});
  plugins.sort((a, b) => {
    const ia = orderIndex[a.name] === undefined ? Number.MAX_SAFE_INTEGER : orderIndex[a.name];
    const ib = orderIndex[b.name] === undefined ? Number.MAX_SAFE_INTEGER : orderIndex[b.name];
    return ia - ib;
  });

  // 一次性迁移：为缺失/不一致的 group 字段按当前解析结果回填，保证已安装插件无需重装即可稳定分组
  let migrated = false;
  for (const p of plugins) {
    const cfg = allConfig[p.name] || (allConfig[p.name] = {});
    if (cfg.group !== p.groupName) {
      cfg.group = p.groupName;
      migrated = true;
    }
  }
  if (migrated) {
    try { savePluginConfig(allConfig); } catch { /* 忽略迁移失败 */ }
  }

  // [DEBUG] 打印分组字段，便于排查相同音源未聚合问题（降级为 debug：默认 info 不输出，调试时 LOG_LEVEL=debug 才可见）
  logger.debug('PLUGIN', createReqId(), '[DEBUG plugins] group diagnostics', {
    fileToGroup: Array.from(fileToGroup.entries()),
    plugins: plugins.map((p) => ({ name: p.name, groupName: p.groupName, platform: p.platform, displayName: p.displayName }))
  });

  return plugins;
}

/**
 * 支持指定方法的插件列表（GET /api/plugins/support/:method 的数据体）
 */
async function getSupportedPlugins(method) {
  const pluginRoot = pluginsDir();
  const files = listPluginNames(pluginRoot);
  const allConfig = loadPluginConfig();
  const supportedPlugins = [];
  // 构建文件→所属目录名的映射（与 getPluginList 一致），供前端标签栏按物理目录去重聚合
  const fileToGroup = buildFileToGroup(pluginRoot);

  for (const file of files) {
    try {
      const info = await loadPluginInfo(file);
      if (!info) continue;
      const pluginConfig = allConfig[file] || {};
      // 只返回启用且支持该方法的插件（与原 server.js 保持一致，返回完整插件信息对象）
      if (info.supportedMethods.includes(method) && pluginConfig.enabled !== false) {
        // 电台插件仅在「电台」菜单展示，不污染排行榜(getTopLists)/热门歌单(getRecommendSheetTags)等音乐菜单
        if (info.isStation && (method === 'getTopLists' || method === 'getRecommendSheetTags')) continue;
        // 工具插件（插件管理页标记 config.utility=true，如歌词/封面等辅助插件）：
        // 即使实现了榜单/歌单方法，也不作为音源进入任何能力型列表
        if (pluginConfig.utility === true) continue;
        supportedPlugins.push({
          ...info,
          displayName: pluginConfig.displayName || '',
          // 与 getPluginList 保持一致的音源组名（目录别名优先 > 物理目录 > 配置 displayName），统一 trim+NFC 归一化
          groupName: (pluginConfig.group || fileToGroup.get(file) || pluginConfig.displayName || '').toString().trim().normalize('NFC'),
          url: pluginConfig.url || '',
          remark: pluginConfig.remark || '',
          enabled: true
        });
      }
    } catch (e) { /* ignore */ }
  }

  return supportedPlugins;
}

/**
 * 插件详情（POST /api/plugins/info）
 */
async function loadPluginDetail(pluginName) {
  const pluginPath = resolvePluginPath(pluginName);
  if (!pluginPath) return null;
  return loadPluginInfo(path.basename(pluginPath));
}

// ---------------- 安装 ----------------

// 查找同音源（platform）已安装插件使用的目录别名（displayName），用于把同类型插件归入同一目录
async function findAliasForPlatform(platform) {
  try {
    const files = listPluginNames(pluginsDir());
    const allConfig = loadPluginConfig();
    for (const f of files) {
      const info = await loadPluginInfo(f);
      if (info && info.platform === platform) {
        const disp = allConfig[f] && allConfig[f].displayName;
        return disp || platform;
      }
    }
  } catch { /* 忽略异常 */ }
  return null;
}

// 统计同音源（platform）已安装的插件数量，用于限制每个音源最多 5 个源
async function countPluginsByPlatform(platform) {
  try {
    const files = listPluginNames(pluginsDir());
    let count = 0;
    for (const f of files) {
      const info = await loadPluginInfo(f);
      if (info && info.platform === platform) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

// 把别名（url 可选）写入插件配置：本地安装只记录别名，网络安装同时记录更新地址
function saveInstallConfig(pluginName, { displayName, url }) {
  try {
    const allConfig = loadPluginConfig();
    allConfig[pluginName] = {
      ...(allConfig[pluginName] || {}),
      displayName,
      url: url || '',
      group: displayName
    };
    savePluginConfig(allConfig);
  } catch (e) {
    logger.warn('PLUGIN', createReqId(), 'Failed to save displayName/url for installed plugin', { error: logger.formatError(e) });
  }
}

/**
 * 从上传的文件安装插件。
 * @param {{buffer: Buffer, originalname: string, targetPlatform?: string, displayName?: string}} payload
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
async function installPluginFromBuffer(payload) {
  const { buffer, originalname } = payload || {};
  try {
    if (!buffer) {
      return { success: false, error: '未找到上传的文件' };
    }

    const pluginRoot = pluginsDir();
    if (!fs.existsSync(pluginRoot)) {
      fs.mkdirSync(pluginRoot, { recursive: true });
    }

    // 同类型（指定音源组）本地安装：归入已有音源目录，最多 5 个源，无需填写别名
    const targetPlatform = (typeof payload.targetPlatform === 'string' ? payload.targetPlatform : '').trim();
    if (targetPlatform) {
      const existingCount = await countPluginsByPlatform(targetPlatform);
      if (existingCount >= 5) {
        return { success: false, error: `每个音源最多只能添加 5 个源，当前「${targetPlatform}」已达上限（${existingCount}/5）` };
      }
      const aliasName = (await findAliasForPlatform(targetPlatform)) || targetPlatform;
      if (!isSafeAlias(aliasName)) {
        return { success: false, error: '目标音源目录名不安全（含路径分隔符或父目录引用）' };
      }
      const pluginName = safePluginFileName(normalizePluginFileName(originalname)) || `plugin-${Date.now()}.js`;
      const pluginDir = path.join(pluginRoot, aliasName);
      fs.mkdirSync(pluginDir, { recursive: true });
      const targetPath = path.join(pluginDir, pluginName);
      fs.writeFileSync(targetPath, buffer);
      // 本地安装没有网络地址，仅记录别名（用于前端分组展示）
      saveInstallConfig(pluginName, { displayName: aliasName });
      logger.info('PLUGIN', createReqId(), 'Same-type plugin installed from file', { file: originalname, targetPath, targetPlatform });
      return { success: true, message: '插件安装成功' };
    }

    // 普通本地安装：别名(displayName)必填，作为安装目录名，防止重名覆盖
    const displayName = (typeof payload.displayName === 'string' ? payload.displayName : '').trim();
    if (!isSafeAlias(displayName)) {
      return { success: false, error: '缺少插件别名（将用作安装目录名）' };
    }

    // 安装到子目录：<pluginsDir>/<别名>/<原始文件名>.js
    const pluginName = safePluginFileName(normalizePluginFileName(originalname)) || `plugin-${Date.now()}.js`;
    const pluginDir = path.join(pluginRoot, displayName);
    const targetPath = path.join(pluginDir, pluginName);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(targetPath, buffer);

    // 把别名写入插件配置（本地安装没有网络地址，仅记录别名）
    saveInstallConfig(pluginName, { displayName });

    logger.info('PLUGIN', createReqId(), 'Plugin installed', { file: originalname, targetPath });
    return { success: true, message: '插件安装成功' };
  } catch (e) {
    logger.error('PLUGIN', createReqId(), 'Install plugin error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * 从 URL 安装插件（支持「按音源归类 + 同类型校验」）。
 * @param {{url: string, fileName?: string, displayName?: string, targetPlatform?: string}} payload
 * @param {string} [reqId] 调用方传入的请求标识，便于串联日志
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
async function installPluginFromUrl(payload, reqId) {
  const { url, fileName, displayName, targetPlatform } = payload || {};
  const rid = reqId || createReqId();

  logger.info('PLUGIN', rid, '[install-from-url] 收到安装请求', { url, fileName, displayName, targetPlatform });

  if (!url) {
    return { success: false, error: '缺少插件 URL' };
  }

  // 防御纵深（可选）：配置了 PLUGIN_ALLOWED_HOSTS 时仅允许白名单域名安装插件
  const allowedHosts = (process.env.PLUGIN_ALLOWED_HOSTS || '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allowedHosts.length) {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { /* 下面统一拦截 */ }
    if (!allowedHosts.some((h) => host === h || host.endsWith('.' + h))) {
      return { success: false, error: '插件来源域名不在白名单内' };
    }
  }

  try {
    const pluginRoot = pluginsDir();
    if (!fs.existsSync(pluginRoot)) {
      fs.mkdirSync(pluginRoot, { recursive: true });
    }

    // 普通安装（非同类型添加）必须提供别名（用于安装目录名）；同类型添加由目标音源目录决定
    if (!targetPlatform) {
      if (!isSafeAlias(displayName)) {
        return { success: false, error: '缺少插件别名（将用作安装目录名）' };
      }
    }

    const finalRawFileName = normalizePluginFileName(fileName || path.basename(new URL(url).pathname)) || '';

    // 0) 先决定落盘目录与最终路径（同类型归入已有音源目录，普通安装使用填写的别名），
    //    下载后先写入最终位置再校验，任何失败即删除，避免产生临时目录/文件（uploads）。
    const aliasName = targetPlatform ? ((await findAliasForPlatform(targetPlatform)) || targetPlatform) : String(displayName || '').trim();
    if (!isSafeAlias(aliasName)) {
      return { success: false, error: '安装目录名不安全（含路径分隔符或父目录引用）' };
    }
    const pluginDir = path.join(pluginRoot, aliasName);
    const finalFileName = safePluginFileName(finalRawFileName) || `plugin-${Date.now()}.js`;
    const targetPath = path.join(pluginDir, finalFileName);
    // 校验失败时清理已写入的目标文件
    const cleanupFailed = () => {
      try { if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath); } catch { /* 忽略 */ }
    };

    const guard = await resolveProxyGuard(url, rid);
    if (!guard.safe) {
      return { success: false, error: '插件来源地址被安全策略拒绝（SSRF 防护）' };
    }

    // 部分源站（GitHub raw / jsdelivr / 各类 CDN）会拦截默认 axios UA，
    // 要求带正常浏览器标识，否则返回 403。这里显式带上 UA / Accept / Referer。
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Referer': typeof url === 'string' ? new URL(url).origin : ''
    };
    logger.info('PLUGIN', rid, '[install-from-url] 开始下载插件源码', { url, targetPath, headers: reqHeaders });

    let response;
    try {
      response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 50 * 1024 * 1024, // 防超大文件/流量放大
        httpAgent: guard.agent,
        httpsAgent: guard.agent,
        headers: reqHeaders
      });
    } catch (downloadErr) {
      logger.error('PLUGIN', rid, '[install-from-url] 下载插件源码失败', {
        url,
        status: downloadErr.response ? downloadErr.response.status : undefined,
        statusText: downloadErr.response ? downloadErr.response.statusText : undefined,
        responseHeaders: downloadErr.response ? downloadErr.response.headers : undefined,
        code: downloadErr.code,
        message: downloadErr.message
      });
      return { success: false, error: '下载插件失败：' + (downloadErr.response ? `HTTP ${downloadErr.response.status} ` : '') + downloadErr.message };
    }

    const respData = Buffer.from(response.data);
    logger.info('PLUGIN', rid, '[install-from-url] 下载成功', {
      status: response.status,
      contentType: response.headers ? response.headers['content-type'] : undefined,
      contentLength: response.headers ? response.headers['content-length'] : undefined,
      actualBytes: respData.length,
      finalFileName
    });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(targetPath, respData);

    let plugin;
    try {
      plugin = loadPluginModule(targetPath);
      logger.info('PLUGIN', rid, '[install-from-url] 插件模块加载成功', {
        platform: plugin.platform,
        version: plugin.version,
        author: plugin.author,
        hasSearch: typeof plugin.search === 'function',
        hasUpdatePlugin: typeof plugin.updatePlugin === 'function'
      });
    } catch (e) {
      cleanupFailed();
      logger.error('PLUGIN', rid, '[install-from-url] 插件模块加载失败', {
        targetPath,
        error: e && e.message,
        stack: e && e.stack
      });
      return { success: false, error: '插件文件无效：' + e.message };
    }
    if (!plugin.platform) {
      cleanupFailed();
      logger.error('PLUGIN', rid, '[install-from-url] 插件缺少 platform 字段', { keys: plugin ? Object.keys(plugin) : null });
      return { success: false, error: '插件文件无效：缺少 platform 字段' };
    }

    // 2) 同类型添加：校验 platform 必须与目标音源一致，否则拒绝安装
    if (targetPlatform) {
      logger.info('PLUGIN', rid, '[install-from-url] 同类型校验', { pluginPlatform: plugin.platform, targetPlatform });
      // 同音源插件的 platform 字段写法不统一（如「酷我」/「kw」/「kuwo」），
      // 严格相等会误伤正常同音源插件。用户已明确选择目标音源组，故不再硬拒绝，
      // 仅在不一致时告警，仍归入目标音源目录。
      if (plugin.platform !== targetPlatform) {
        logger.warn('PLUGIN', rid, '[install-from-url] 插件 platform 与目标音源不一致，按用户选择归入该音源目录', { pluginPlatform: plugin.platform, targetPlatform });
      }
      // 每个音源最多允许添加 5 个源，超限则拒绝
      const existingCount = await countPluginsByPlatform(targetPlatform);
      if (existingCount >= 5) {
        cleanupFailed();
        return { success: false, error: `每个音源最多只能添加 5 个源，当前「${targetPlatform}」已达上限（${existingCount}/5）` };
      }
    }

    logger.info('PLUGIN', rid, 'Plugin installed from URL', { targetPath, source: targetPlatform ? `same-type(${targetPlatform})` : 'new' });

    // 4) 保存安装时的别名与网络地址到插件配置
    saveInstallConfig(finalFileName, { displayName: aliasName, url });

    return { success: true, message: '插件安装成功' };
  } catch (err) {
    logger.error('PLUGIN', rid, 'Install plugin from URL error', { error: logger.formatError(err) });
    return { success: false, error: err.message };
  }
}

// ---------------- 更新 ----------------

/**
 * 更新所有插件（插件自带的 updatePlugin 方法，供 wecom 菜单与 /api/plugins/update-all 调用）
 */
async function updateAllPlugins() {
  try {
    const pluginFiles = listPluginNames(pluginsDir());
    let updatedCount = 0;
    let failedCount = 0;
    const errors = [];

    for (const pluginFile of pluginFiles) {
      try {
        const pluginPath = resolvePluginFilePath(pluginsDir(), pluginFile);
        const plugin = loadPluginModule(pluginPath);
        const pluginName = plugin.platform;

        if (!pluginName) {
          logger.warn('PLUGIN', createReqId(), `跳过无效插件: ${pluginFile} (缺少 platform)`);
          continue;
        }

        if (typeof plugin.updatePlugin !== 'function') {
          logger.info('PLUGIN', createReqId(), `插件 ${pluginName} 不支持更新，跳过`);
          continue;
        }

        const userConfig = loadPluginConfig()[pluginFile] || {};
        const globalConfig = userConfig._global || {};
        const result = await new Promise((resolve) => {
          plugin.updatePlugin(
            { ...globalConfig },
            {},
            resolve,
            { logger },
            { _require }
          );
        });

        if (result && result.status) {
          updatedCount++;
          logger.info('PLUGIN', createReqId(), `插件 ${pluginName} 更新成功`);
        } else {
          failedCount++;
          errors.push({ plugin: pluginName, error: (result && result.body) || '未知错误' });
          logger.error('PLUGIN', createReqId(), `插件 ${pluginName} 更新失败`, { result });
        }
      } catch (err) {
        failedCount++;
        const name = path.basename(pluginFile, '.js');
        errors.push({ plugin: name, error: err.message });
        logger.error('PLUGIN', createReqId(), `更新插件 ${name} 出错`, { error: logger.formatError(err) });
      }
    }

    logger.info('PLUGIN', createReqId(), 'All plugins update completed', { updatedCount, failedCount });
    return { success: true, updatedCount, failedCount, errors };
  } catch (err) {
    logger.error('PLUGIN', createReqId(), 'Failed to update all plugins', { error: logger.formatError(err) });
    return { success: false, error: err.message };
  }
}

/**
 * 更新单个插件（插件自带的 updatePlugin 方法）
 */
async function updateSinglePlugin(pluginName) {
  try {
    const pluginPath = resolvePluginPath(pluginName);
    if (!pluginPath) {
      return { success: false, error: '插件不存在' };
    }

    const plugin = loadPluginModule(pluginPath);
    if (typeof plugin.updatePlugin !== 'function') {
      return { success: false, error: '该插件不支持更新' };
    }

    const allConfig = loadPluginConfig();
    const configKey = findConfigKey(allConfig, pluginName) || path.basename(pluginPath);
    const userConfig = allConfig[configKey] || {};
    const globalConfig = userConfig._global || {};

    const result = await new Promise((resolve, reject) => {
      try {
        plugin.updatePlugin(
          { ...globalConfig },
          {},
          resolve,
          { logger },
          { _require }
        );
      } catch (e) {
        reject(e);
      }
    });

    if (result && result.status) {
      return { success: true, data: result };
    }
    return { success: false, error: (result && result.body) || '更新失败' };
  } catch (err) {
    logger.error('PLUGIN', createReqId(), `Update plugin ${pluginName} error`, { error: logger.formatError(err) });
    return { success: false, error: err.message };
  }
}

/**
 * 批量「按安装地址」更新插件（定时任务与手动触发共用的唯一实现）。
 * 三处保证：
 *   1) 用 listPluginNames 枚举，兼容 <dir>/<别名>/<name>.js 子目录布局（旧实现只认平铺 .js，导致定时更新空转）
 *   2) 更新地址优先取安装时记录的配置 url，缺失时回溯插件自带的 srcUrl
 *   3) 回抓前做 SSRF 防护 + DNS 固定（更新后的内容会被直接执行，等同于远程代码执行）
 * @param {{sendNotification?: boolean}} [options] sendNotification 为 false 时不发外部通知
 */
async function runAutoUpdatePlugins(options = {}) {
  const { sendNotification } = options;
  const pluginRoot = pluginsDir();
  logger.info('SYSTEM', 'auto-update', 'Starting auto update plugins...', { sendNotification });

  const pluginConfig = loadPluginConfig();
  const results = {
    success: [],
    failed: [],
    skipped: []
  };

  const files = listPluginNames(pluginRoot);
  frontendLogger.info('SCHEDULER', `插件更新任务开始执行：共 ${files.length} 个插件（${files.join('、')}）`, {
    type: '插件更新',
    total: files.length,
    plugins: files
  });

  for (const fileName of files) {
    const pc = pluginConfig[fileName] || {};

    // 更新地址：优先取配置里安装时记录的 url，缺失时回溯插件代码自带的 srcUrl
    let updateUrl = pc.url;
    if (!updateUrl) {
      try {
        const mod = loadPluginModule(resolvePluginFilePath(pluginRoot, fileName));
        updateUrl = (mod && mod.srcUrl) || '';
      } catch { /* 忽略加载失败 */ }
    }

    if (!updateUrl) {
      results.skipped.push({ name: fileName, reason: '没有配置更新URL' });
      continue;
    }

    try {
      logger.info('SYSTEM', 'auto-update', 'Updating plugin', { fileName });

      // SSRF 防护 + DNS 固定：更新源同样可能是恶意地址（安装时存入，可被诱导），
      // 必须把关后才能回抓并覆盖插件文件，否则等同远程代码执行。
      const guard = await resolveProxyGuard(updateUrl, 'AUTO_UPDATE');
      if (!guard.safe) {
        results.failed.push({ name: fileName, reason: '更新地址被安全策略拒绝（SSRF 防护）' });
        logger.warn('SYSTEM', 'auto-update', 'Update URL rejected by security policy', { fileName, url: updateUrl });
        continue;
      }

      const response = await axios.get(updateUrl, {
        timeout: 30000,
        responseType: 'arraybuffer',
        maxContentLength: 50 * 1024 * 1024, // 防超大文件/流量放大
        httpAgent: guard.agent,
        httpsAgent: guard.agent
      });
      const existing = resolvePluginFilePath(pluginRoot, fileName);
      // 优先写回原布局（兼容新子目录布局 <dir>/<name>/<name>），否则按新布局建目录写入
      const filePath = (existing && fs.existsSync(existing) && fs.statSync(existing).isFile())
        ? existing
        : path.join(pluginRoot, fileName, fileName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, response.data);
      logger.info('SYSTEM', 'auto-update', 'Plugin updated', { fileName });
      results.success.push({ name: fileName, size: response.data.length });
    } catch (err) {
      logger.error('SYSTEM', 'auto-update', 'Failed to update plugin', { fileName, error: logger.formatError(err) });
      results.failed.push({ name: fileName, error: err.message });
    }
  }

  const total = results.success.length + results.failed.length;
  try {
    await deps.updateAutoUpdateConfig({
      lastUpdateTime: Date.now(),
      lastUpdateTotal: total,
      lastUpdateSuccess: results.success.length,
      lastUpdateFailed: results.failed.length
    });
  } catch (e) {
    logger.warn('SYSTEM', 'auto-update', 'Failed to persist auto-update stats', { error: e && e.message });
  }

  logger.info('SYSTEM', 'auto-update', 'Completed', {
    success: results.success.length,
    failed: results.failed.length,
    skipped: results.skipped.length
  });

  // 应用内「日志」面板可见的汇总
  const doneMessage = `插件更新完成：成功 ${results.success.length} 个`
    + (results.success.length ? `，分别是 ${results.success.map((s) => s.name).join('、')}` : '')
    + (results.skipped.length ? `，跳过 ${results.skipped.length} 个` : '');
  if (results.failed.length === 0) {
    frontendLogger.info('SCHEDULER', doneMessage, {
      type: '插件更新',
      success: results.success.length,
      skipped: results.skipped.length,
      total,
      details: results.success.map((s) => s.name)
    });
  } else {
    frontendLogger.warn('SCHEDULER', `${doneMessage}，失败 ${results.failed.length} 个（${results.failed.map((f) => f.name).join('、')}）`, {
      type: '插件更新',
      success: results.success.length,
      failed: results.failed.length,
      skipped: results.skipped.length,
      total
    });
  }

  if (sendNotification !== false) {
    try {
      const successDetails = results.success.length > 0
        ? results.success.map(p => `  ✓ ${p.name}`).join('\n')
        : '';
      const failedDetails = results.failed.length > 0
        ? '\n**更新失败:**\n' + results.failed.map(p => `  ✗ ${p.name}: ${p.error || p.reason || ''}`).join('\n')
        : '';

      const notifyResult = await deps.notify(
        `**🔌 MusicHub - 插件自动更新完成**\n\n` +
        `📊 **更新统计**\n` +
        `• 成功: ${results.success.length} 个\n` +
        `• 失败: ${results.failed.length} 个\n` +
        `• 跳过: ${results.skipped.length} 个\n` +
        `• 时间: ${new Date().toLocaleString('zh-CN')}\n` +
        (successDetails ? `\n**更新成功:**\n${successDetails}` : '') +
        failedDetails
      );

      if (!notifyResult || !notifyResult.success) {
        logger.warn('SYSTEM', 'auto-update', 'Notification not sent', { reason: notifyResult && notifyResult.error });
      } else {
        logger.info('SYSTEM', 'auto-update', 'Notification sent successfully');
      }
    } catch (notifyErr) {
      logger.warn('SYSTEM', 'auto-update', 'Failed to send notification', { error: notifyErr.message });
    }
  } else {
    logger.info('SYSTEM', 'auto-update', 'Notification skipped (disabled by user)');
  }

  return results;
}

/**
 * 下次插件自动更新时间（真实按 cron 表达式计算，禁用或表达式非法时返回 null）
 */
async function getNextPluginUpdateTime() {
  try {
    const cfg = await deps.getAutoUpdateConfig();
    if (cfg && cfg.enabled && cfg.cronExpression && cron.validate(cfg.cronExpression)) {
      return deps.getNextCronTime(cfg.cronExpression);
    }
  } catch { /* 忽略读取失败 */ }
  return null;
}

// ---------------- 删除 / 配置 ----------------

/**
 * 删除插件（连同配置记录与排序项；所在音源目录为空时一并移除）
 */
async function deletePlugin(pluginName) {
  try {
    const pluginRoot = pluginsDir();
    const pluginPath = resolvePluginFilePath(pluginRoot, pluginName);
    if (!pluginPath) {
      return { success: false, error: '插件不存在' };
    }
    // 删除插件文件本身：只删除当前这个插件，不影响同音源目录下的其它插件源
    fs.unlinkSync(pluginPath);
    logger.info('PLUGIN', createReqId(), `Plugin deleted: ${pluginName}`, { path: pluginPath });

    // 若该插件位于子目录（音源组目录），删除后目录已空则连同目录一并移除，
    // 前端刷新后该音源的整个表格随之消失；目录里仍存有其它插件文件时则保留目录。
    const baseDir = path.resolve(pluginRoot);
    const parentDir = path.dirname(pluginPath);
    const inSubdir = parentDir !== baseDir && parentDir.startsWith(baseDir + path.sep);
    if (inSubdir) {
      try {
        fs.rmdirSync(parentDir); // 非递归：目录非空会抛 ENOTEMPTY，视为仍有其它插件而跳过
        logger.info('PLUGIN', createReqId(), `Empty plugin folder removed: ${pluginName}`, { dir: parentDir });
      } catch (e) {
        // 目录中仍有其它插件文件（或暂不可删），保留目录，不影响已删除的插件
      }
    }

    // 清理该插件在配置中的记录，并从已保存的顺序中移除
    try {
      const allConfig = loadPluginConfig();
      let changed = false;
      if (allConfig && allConfig[pluginName]) {
        delete allConfig[pluginName];
        changed = true;
      }
      if (Array.isArray(allConfig.__pluginOrder)) {
        const nextOrder = allConfig.__pluginOrder.filter((k) => k !== pluginName);
        if (nextOrder.length !== allConfig.__pluginOrder.length) {
          allConfig.__pluginOrder = nextOrder;
          changed = true;
        }
      }
      if (changed) savePluginConfig(allConfig);
    } catch (e) {
      logger.warn('PLUGIN', createReqId(), `Failed to update plugin config on delete: ${pluginName}`, { error: logger.formatError(e) });
    }

    return { success: true, message: '插件已删除' };
  } catch (err) {
    logger.error('PLUGIN', createReqId(), `Delete plugin ${pluginName} error`, { error: logger.formatError(err) });
    return { success: false, error: err.message };
  }
}

/**
 * 保存插件配置（PUT /api/plugins/:pluginName/config）
 * 别名(displayName)与地址(url)安装后不可修改，避免与文件名/更新来源脱钩。
 */
async function savePluginConfigEntry(pluginName, body) {
  const { config: pluginConfig, globalConfig, displayName, url, remark, enabled } = body || {};
  try {
    const allConfig = loadPluginConfig();
    const configKey = findConfigKey(allConfig, pluginName) || (pluginName.endsWith('.js') ? pluginName : `${pluginName}.js`);
    const existingConfig = allConfig[configKey] || {};
    const newConfig = {
      ...existingConfig,
      ...(pluginConfig || {})
    };
    // 别名(displayName)由安装时确定，一旦安装不可修改：拒绝变更请求，保持原有别名不变
    if (displayName !== undefined && String(displayName).trim() !== String(existingConfig.displayName || '').trim()) {
      return { success: false, error: '插件的别名不能修改' };
    }
    // 地址(url)由安装时确定，且与插件文件名对应的更新来源绑定，一旦安装不可修改：
    // 若允许修改，改后与文件名不匹配会导致一键更新失败
    if (url !== undefined && String(url).trim() !== String(existingConfig.url || '').trim()) {
      return { success: false, error: '插件的地址不能修改' };
    }
    // 插件卡片内联编辑的字段（备注/启用状态）直接位于顶层，需要单独落库
    if (remark !== undefined) newConfig.remark = remark;
    if (enabled !== undefined) newConfig.enabled = enabled;
    if (globalConfig !== undefined) {
      newConfig._global = globalConfig;
    }
    allConfig[configKey] = newConfig;
    savePluginConfig(allConfig);

    logger.info('PLUGIN', createReqId(), `Plugin config saved: ${pluginName}`, { config: newConfig });
    return { success: true, message: '配置已保存' };
  } catch (err) {
    logger.error('PLUGIN', createReqId(), `Save plugin config error for ${pluginName}`, { error: logger.formatError(err) });
    return { success: false, error: err.message };
  }
}

/**
 * 启用/禁用插件
 */
async function togglePlugin(pluginName, enabled) {
  try {
    const allConfig = loadPluginConfig();
    const configKey = findConfigKey(allConfig, pluginName) || (pluginName.endsWith('.js') ? pluginName : `${pluginName}.js`);
    const existingConfig = allConfig[configKey] || {};
    existingConfig.enabled = enabled !== false;
    allConfig[configKey] = existingConfig;
    savePluginConfig(allConfig);
    logger.info('PLUGIN', createReqId(), `Plugin ${pluginName} ${enabled !== false ? 'enabled' : 'disabled'}`);
    return {
      success: true,
      message: enabled !== false ? '插件已启用' : '插件已禁用',
      enabled: existingConfig.enabled
    };
  } catch (err) {
    logger.error('PLUGIN', createReqId(), `Toggle plugin ${pluginName} error`, { error: logger.formatError(err) });
    return { success: false, error: err.message };
  }
}

/**
 * 调整插件顺序：order = [pluginName, ...]
 */
async function reorderPlugins(order) {
  if (!Array.isArray(order)) {
    return { success: false, error: '参数错误：order 必须是数组' };
  }
  try {
    // 仅保留合法的插件配置 key（文件名形式），过滤掉路径穿越/分隔符
    const cleanOrder = order
      .filter((name) => typeof name === 'string' && name.length > 0
        && !name.includes('/') && !name.includes('\\') && !name.includes('..'));
    const allConfig = loadPluginConfig();
    allConfig.__pluginOrder = cleanOrder;
    savePluginConfig(allConfig);
    logger.info('PLUGIN', createReqId(), 'Plugin order updated', { count: cleanOrder.length });
    return { success: true, message: '插件顺序已保存' };
  } catch (err) {
    logger.error('PLUGIN', createReqId(), 'Reorder plugins error', { error: logger.formatError(err) });
    return { success: false, error: err.message };
  }
}

module.exports = {
  init,

  // 枚举与定位
  listPluginNames,
  getDefaultPlugin,
  isSafeAlias,
  normalizePluginFileName,
  findConfigKey,
  resolvePluginPath,

  // 元信息
  STANDARD_PLUGIN_METHODS,
  deriveSupportedMethods,
  loadPluginInfo,
  loadPluginDetail,
  getPluginList,
  getSupportedPlugins,

  // 安装 / 更新
  installPluginFromBuffer,
  installPluginFromUrl,
  countPluginsByPlatform,
  findAliasForPlatform,
  updateAllPlugins,
  updateSinglePlugin,
  runAutoUpdatePlugins,
  getNextPluginUpdateTime,

  // 删除 / 配置
  deletePlugin,
  savePluginConfigEntry,
  togglePlugin,
  reorderPlugins
};
