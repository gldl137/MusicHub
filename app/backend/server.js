const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

const { ResolverCore, init: initResolverCore } = require('./MusicFree/resolver-core');
const { runPlugin } = require('./MusicFree/runner');
const config = require('./lib/config');
const { gzipResponseMiddleware } = require('./lib/http-compression');
const database = require('./database');
const SchedulerManager = require('./scheduler');
// 封面 WebP 预处理模块：启动自检 sharp 编码器（文档四-5）
const coverCache = require('./lib/cover-cache');
const wecomApp = require('./wecom-app');
const ctx = require('./lib/context');
const { logger, frontendLogger, createReqId, authMiddleware, adminMiddleware, verifyToken } = ctx;

// 全局进程级异常兜底：避免单个未捕获异常/未处理 Promise 拒绝导致整个 backend 进程退出
// （supervisord 重启期间所有请求会 ERR_CONNECTION_REFUSED）。记录后保持存活。
process.on('unhandledRejection', (reason) => {
  logger.error('SYSTEM', 'process', 'Unhandled promise rejection', { error: reason && reason.message, stack: reason && reason.stack });
});
process.on('uncaughtException', (err) => {
  logger.error('SYSTEM', 'process', 'Uncaught exception', { error: err && err.message, stack: err && err.stack });
});
const subscribeHelpers = require('./lib/subscribe-helpers');

const { getSetting } = database;

const app = express();
const PORT = process.env.PORT || 8000;

// 数据目录（用于 Docker 卷映射）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// 下载目录（用于 Docker 卷映射，放在项目根目录的 downloads 文件夹）
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, '..', 'downloads');

// 确保下载目录存在
if (!fs.existsSync(DOWNLOAD_DIR)) {
  try {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    logger.info('SYSTEM', 'init', `Created download directory: ${DOWNLOAD_DIR}`);
  } catch (err) {
    logger.error('SYSTEM', 'init', `Failed to create download directory`, { error: logger.formatError(err) });
  }
}

// 缓存目录
const CACHE_DIR = process.env.CACHE_DIR || path.join(DATA_DIR, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    logger.info('SYSTEM', 'init', `Created cache directory: ${CACHE_DIR}`);
  } catch (err) {
    logger.error('SYSTEM', 'init', `Failed to create cache directory`, { error: logger.formatError(err) });
  }
}

// 统一的配置文件（包含插件配置等）
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// 旧的配置文件路径（用于迁移）
const PLUGIN_CONFIG_FILE = path.join(DATA_DIR, 'plugin-config.json');
const CACHE_INDEX_FILE = path.join(CACHE_DIR, 'index.json');

// 前端静态资源路径
let frontendPath = path.join(__dirname, '..', 'frontend');
if (!fs.existsSync(frontendPath)) {
  frontendPath = '/app/frontend';
}

// 下载设置（注入 ctx 前先初始化默认值）
let downloadSettings = {
  downloadLyrics: false,
  quality: 'standard',
  qualityFallback: 'lower',
  excludeArtists: [],
  excludeLanguages: []
};

// 定期清理过期缓存
setInterval(() => {
  try { ResolverCore.cleanExpired(); } catch (e) { /* ignore */ }
}, 5 * 60 * 1000);

// 迁移旧配置到新的统一配置
function migrateOldConfigs() {
  if (fs.existsSync(CONFIG_FILE)) {
    return;
  }

  const cfg = { plugins: {} };
  let hasMigrated = false;

  if (fs.existsSync(PLUGIN_CONFIG_FILE)) {
    try {
      const oldPluginConfig = JSON.parse(fs.readFileSync(PLUGIN_CONFIG_FILE, 'utf8'));
      cfg.plugins = oldPluginConfig;
      logger.info('SYSTEM', 'config', 'Migrated plugin config to config.json');
      hasMigrated = true;
    } catch (e) {
      logger.error('SYSTEM', 'config', 'Failed to migrate plugin config', { error: logger.formatError(e) });
    }
  }

  if (hasMigrated) {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      logger.info('SYSTEM', 'config', 'Config migration completed');
    } catch (e) {
      logger.error('SYSTEM', 'config', 'Failed to save migrated config', { error: logger.formatError(e) });
    }
  }
}

// 执行迁移
migrateOldConfigs();

// 迁移插件目录布局：旧版 MF 插件平铺在 data/plugins/<音源>/<file>.js，
// 旧版 LX 音源平铺在 data/lx-sources/<file>.js；
// 统一收敛为 data/plugins/MF/<音源>/<file>.js 与 data/plugins/LX/<file>.js，
// 仅移动文件、不改文件名，故 config.json 内以文件名为 key 的配置依然有效。
function migratePluginDirs() {
  try {
    const pluginsRoot = path.join(DATA_DIR, 'plugins');
    const mfDir = path.join(pluginsRoot, 'MF');
    const lxDir = path.join(pluginsRoot, 'LX');
    fs.mkdirSync(mfDir, { recursive: true });

    // 1) 旧 MF 布局：data/plugins 下除 MF/LX 外的所有内容，搬入 data/plugins/MF
    if (fs.existsSync(pluginsRoot)) {
      for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
        if (entry.name === 'MF' || entry.name === 'LX') continue;
        const src = path.join(pluginsRoot, entry.name);
        if (entry.isFile()) {
          // 顶层遗留的 .js / .bak 文件直接移入 MF
          if (/\.(js|bak)$/i.test(entry.name)) {
            try { fs.renameSync(src, path.join(mfDir, entry.name)); } catch { /* 忽略 */ }
          }
        } else if (entry.isDirectory()) {
          fs.mkdirSync(path.join(mfDir, entry.name), { recursive: true });
          for (const f of fs.readdirSync(src)) {
            const fp = path.join(src, f);
            try {
              if (fs.statSync(fp).isFile()) fs.renameSync(fp, path.join(mfDir, entry.name, f));
            } catch { /* 忽略 */ }
          }
          try { fs.rmdirSync(src); } catch { /* 目录非空则保留 */ }
        }
      }
    }

    // 2) 旧 LX 布局：data/lx-sources/*.js 搬入 data/plugins/LX
    const oldLx = path.join(DATA_DIR, 'lx-sources');
    if (fs.existsSync(oldLx)) {
      fs.mkdirSync(lxDir, { recursive: true });
      for (const f of fs.readdirSync(oldLx)) {
        const fp = path.join(oldLx, f);
        try {
          if (fs.statSync(fp).isFile()) fs.renameSync(fp, path.join(lxDir, f));
        } catch { /* 忽略 */ }
      }
      try { fs.rmdirSync(oldLx); } catch { /* 目录非空则保留 */ }
    }
  } catch (e) {
    logger.warn('SYSTEM', 'init', 'Plugin dir migration skipped', { error: e.message });
  }
}

// 插件目录：统一收敛到 data/plugins 下，用 MF / LX 子目录区分两类来源
//   - MF：MusicFree 插件（原 data/plugins 下的各音源子目录）
//   - LX：落雪音源脚本（原 data/lx-sources 下的脚本）
// 环境变量 PLUGINS_DIR 仍可被外部覆盖（应指向 .../plugins/MF）。
let PLUGINS_DIR = process.env.PLUGINS_DIR;
if (!PLUGINS_DIR) {
  PLUGINS_DIR = path.join(DATA_DIR, 'plugins', 'MF');
} else {
  // 兼容历史部署：环境变量若指向 plugins 根目录（MF/LX 的父级），自动校正到 MF 子目录，
  // 否则插件扫描器会把 LX/ 里的落雪音源脚本当成 MusicFree 插件加载而全部报错
  try {
    const mfSub = path.join(PLUGINS_DIR, 'MF');
    if (path.resolve(PLUGINS_DIR) === path.resolve(DATA_DIR, 'plugins') && fs.existsSync(mfSub)) {
      logger.info('SYSTEM', 'init', `PLUGINS_DIR points at plugins root, auto-corrected to MF subdirectory: ${mfSub}`);
      PLUGINS_DIR = mfSub;
    }
  } catch { /* 校验失败保持原值 */ }
}

// 一次性目录迁移：把历史布局搬进新的 MF / LX 子目录（文件名保持不变，配置 key 不失效）
migratePluginDirs();

// 确保插件目录存在
if (!fs.existsSync(PLUGINS_DIR)) {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  logger.info('SYSTEM', 'init', `Created plugins directory: ${PLUGINS_DIR}`);
}

// 确保播放列表目录存在
const PLAYLISTS_DIR = path.join(__dirname, '..', 'playlists');
if (!fs.existsSync(PLAYLISTS_DIR)) {
  fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });
  logger.info('SYSTEM', 'init', `Created playlists directory: ${PLAYLISTS_DIR}`);
}

// 加载下载设置（从数据库覆盖默认值）
function toExcludeArray(val) {
  if (Array.isArray(val)) return val.map(a => String(a).trim()).filter(Boolean);
  if (typeof val === 'string') return val.split(',').map(a => a.trim()).filter(Boolean);
  return [];
}
function loadDownloadSettings(settings) {
  try {
    const quality = getSetting('downloadQuality', 'standard');
    const qualityFallback = getSetting('qualityFallback', 'lower');
    const downloadLyrics = getSetting('downloadLyrics', false);
    const excludeArtists = getSetting('excludeArtists', []);
    const excludeLanguages = getSetting('excludeLanguages', []);

    settings.quality = quality;
    settings.qualityFallback = qualityFallback;
    settings.downloadLyrics = Boolean(downloadLyrics);
    settings.excludeArtists = toExcludeArray(excludeArtists);
    settings.excludeLanguages = toExcludeArray(excludeLanguages);

    logger.info('DOWNLOAD', 'settings', 'Loaded download settings from database');
  } catch (err) {
    logger.error('DOWNLOAD', 'settings', `Failed to load download settings: ${err.message}`);
  }
}
loadDownloadSettings(downloadSettings);

// 用户配置存储（全局单例，供 runPlugin 使用）
const userConfigs = {};

// 初始化调度器管理器
const schedulerManager = new SchedulerManager(
  {
    getSetting,
    saveSetting: database.saveSetting,
    getEnabledSubscribedToplists: database.getEnabledSubscribedToplists,
    saveSubscribedToplistSongs: database.saveSubscribedToplistSongs,
    updateSubscribedToplistConfig: database.updateSubscribedToplistConfig,
    getAutoUpdateConfig: database.getAutoUpdateConfig,
    updateAutoUpdateConfig: database.updateAutoUpdateConfig
  },
  logger,
  { run: runPlugin },
  { pluginsDir: PLUGINS_DIR, loadPluginConfig: config.loadPluginConfig },
  ctx
);

// ==================== 注入共享单例到上下文 ====================
// 下载服务单例：routes/download.js 的 /api/downloads/start 通过 ctx.downloadService.downloadSong
// 执行实际下载。若缺失会导致未捕获异常使 backend 进程崩溃（supervisord 重启期间所有请求 ERR_CONNECTION_REFUSED）。
const downloadService = new ctx.DownloadService({
  logger: ctx.logger,
  downloadSettings,
  userVars: () => userConfigs.default || {}
});

ctx.setSingletons({
  schedulerManager,
  downloadSettings,
  userConfigs,
  DATA_DIR,
  DOWNLOAD_DIR,
  CONFIG_FILE,
  PLUGIN_CONFIG_FILE,
  PLAYLISTS_DIR,
  CACHE_DIR,
  CACHE_INDEX_FILE,
  PLUGINS_DIR,
  downloadService
});

// 初始化解析核心（插件加载）
initResolverCore({ pluginsDir: ctx.PLUGINS_DIR, getDefaultPlugin: ctx.getDefaultPlugin, logger: ctx.logger });

// ==================== 中间件 ====================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 响应 gzip 压缩（零依赖，基于内置 zlib）：OpenSubsonic 客户端频繁拉取的
// 全量列表（getIndexes/getArtists/search3/getAlbumList2）都是明文 JSON，压缩后体积仅为 10%~20%。
// 音频流、下载、封面等二进制响应自动跳过。可用 GZIP_ENABLED=false 关闭。
app.use(gzipResponseMiddleware);

// 降噪规则 - 静态资源路径和频繁请求
const IGNORE_LOG_PATH = ['/css', '/js', '/favicon.ico', '/assets', '/img', '/images', '/api/player-state', '/api/my/player-state', '/api/downloads/check', '/api/downloads/status'];

// 高频但仍需记录的请求 → 降级为 DEBUG 级别（不影响正常 INFO 日志）
// - /rest/*：OpenSubsonic 客户端每请求都带摘要日志（列表类为 DEBUG、业务类为 INFO），访问行无需重复 INFO；
// - /api/proxy/*：播放/封面代理分片高频，已内置错误告警，访问行降为 DEBUG；
// - /api/my/favorites/check：播放器轮询，已降级；
// - 本地播放链路各请求（/api/local-files/stream、/api/music/cover、/api/music/enrich、
//   /api/my/play-history、/api/logs）：一次播放会触发多条，内部已有业务日志，访问行降为 DEBUG。
const DEBUG_LOG_PATH = ['/rest/', '/api/proxy/', '/api/my/favorites/check', '/api/music/cover', '/api/music/enrich', '/api/local-files/stream', '/api/my/play-history', '/api/logs'];

// 极高频且无业务价值的轮询 → 降级为 TRACE，仅在 LOG_LEVEL=trace 时可见，避免污染 info/debug 输出。
// - /api/music/scan-status：前端常驻轮询（数秒一次），访问行对排查无帮助。
const TRACE_LOG_PATH = ['/api/music/scan-status'];

function shouldLogRequest(url) {
  return !IGNORE_LOG_PATH.some(p => url.startsWith(p));
}

// requestId 中间件
app.use((req, _res, next) => {
  req.reqId = createReqId();
  const decodedUrl = decodeURIComponent(req.url);
  const isTraceLog = TRACE_LOG_PATH.some(p => req.url.startsWith(p));
  const isDebugLog = DEBUG_LOG_PATH.some(p => req.url.startsWith(p));
  if (isTraceLog) {
    logger.trace('API', req.reqId, `${req.method} ${decodedUrl}`);
  } else if (shouldLogRequest(req.url) && !isDebugLog) {
    logger.info('API', req.reqId, `${req.method} ${decodedUrl}`);
  } else if (isDebugLog) {
    logger.debug('API', req.reqId, `${req.method} ${decodedUrl}`);
  }
  next();
});

// ==================== 注册路由模块（全量拆分） ====================
const systemRoutes = require('./routes/system');
const authRoutes = require('./routes/auth');
const myRoutes = require('./routes/my');
const subscribeRoutes = require('./routes/subscribe');
const pluginsRoutes = require('./routes/plugins');
const musicRoutes = require('./routes/music');
const localMusicRoutes = require('./routes/local-music');
const downloadRoutes = require('./routes/download');
const proxyRoutes = require('./routes/proxy');
const cacheRoutes = require('./routes/cache');
const restRoutes = require('./routes/rest');
const radioRoutes = require('./routes/radio');
const lxRoutes = require('./routes/lx');

systemRoutes(app);
authRoutes(app);
myRoutes(app);
subscribeRoutes(app);
pluginsRoutes(app);
musicRoutes(app);
localMusicRoutes(app);
downloadRoutes(app);
proxyRoutes(app);
cacheRoutes(app);
restRoutes(app);
radioRoutes.registerRadioRoutes(app);
lxRoutes(app);

// ==================== 静态文件 ====================

// 提供下载文件的静态访问（使用虚拟路径 /downloads）
// 加 authMiddleware：下载文件含用户落盘音乐，禁止未登录直接枚举/下载（浏览器 <audio> 自动携带会话 Cookie，登录用户无感）
app.use('/downloads', authMiddleware, express.static(DOWNLOAD_DIR, {
  dotfiles: 'ignore',
  etag: true,
  extensions: ['mp3', 'flac', 'wav', 'm4a'],
  index: false,
  maxAge: '1d',
  redirect: false,
  setHeaders: function (res, _path) {
    res.set('x-timestamp', Date.now());
    res.set('Accept-Ranges', 'bytes');
  }
}));

if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
  // 这个路由放在最后，处理所有非 API 请求，返回前端页面
  // API 请求需要在它之前定义
}

// ==================== 企业微信自建应用：注入依赖并注册路由 ====================
// 回调路由（/api/wecom-app/callback）不挂鉴权，必须公网可达
wecomApp.initWecomApp({
  schedulerManager,
  clearCache: cacheRoutes.clearAllCacheWithNotify,
  updatePlugins: pluginsRoutes.updateAllPlugins
});
wecomApp.registerWecomAppRoutes(app, authMiddleware);

// ==================== 全局错误处理中间件 ====================
// 捕获各路由中漏写的异常，统一返回 500，避免请求挂死或进程异常。
// 必须注册在所有路由之后（Express 按注册顺序匹配 4 参错误中间件）。
app.use((err, _req, res, _next) => {
  logger.error('SYSTEM', 'error-handler', 'Request error', { error: err && err.message, stack: err && err.stack });
  if (!res.headersSent) {
    res.status(500).json({ success: false, error: '服务器内部错误' });
  } else {
    res.end();
  }
});

// ==================== 模块导出（供其他模块复用） ====================
module.exports = {
  sendWecomNotification: ctx.notifications.sendWecomNotification,
  sendTextNotification: ctx.notifications.sendTextNotification,
  sendMarkdownNotification: ctx.notifications.sendMarkdownNotification,
  sendNewsNotification: ctx.notifications.sendNewsNotification,
  sendTemplateCardNotification: ctx.notifications.sendTemplateCardNotification,
  loadNotificationConfig: ctx.notifications.loadNotificationConfig,
  saveNotificationConfig: ctx.notifications.saveNotificationConfig,
  ResolverCore,
  downloadSubscriptionInternal: subscribeHelpers.downloadSubscriptionInternal,
  syncSubscriptionInternal: subscribeHelpers.syncSubscriptionInternal,
  generateAllM3UInternal: subscribeHelpers.generateAllM3UInternal,
  generateM3UForSubscription: subscribeHelpers.generateM3UForSubscription
};

// ==================== 启动服务器 ====================
app.listen(PORT, async () => {
  // 启动时把旧 SQLite 系统设置合并进 config.json（幂等，仅在 config 缺该键时写入）
  try {
    await database.migrateSystemSettingsToConfig();
  } catch (e) {
    logger.error('SYSTEM', 'config', 'System settings migration failed', { error: e.message });
  }
  // 启动时把旧 local_meta 表合并进 settings 表（幂等：迁移后删表，可重复调用）
  try {
    await database.migrateLocalMetaToSettings();
  } catch (e) {
    logger.error('SYSTEM', 'config', 'local_meta migration failed', { error: e.message });
  }
  // 启动时清空已停用的 songs 表历史数据（保留表结构，幂等，仅执行一次）
  try {
    await database.clearSongsTableData();
  } catch (e) {
    logger.error('SYSTEM', 'config', 'songs data clear failed', { error: e.message });
  }
  // 启动时把旧独立 wecom-app.json 合并进 config.json（幂等，仅在 config 缺 wecomApp 时写入）
  try {
    config.getWecomAppConfig();
  } catch (e) {
    logger.error('SYSTEM', 'config', 'WeCom app config migration failed', { error: e.message });
  }
  // 启动时应用持久化的调试日志开关（未设置则保持环境变量/默认值）
  try {
    const savedDebugLog = await getSetting('debug_log_enabled', null);
    if (savedDebugLog !== null) {
      logger.setLevel(savedDebugLog ? 'debug' : 'info');
    }
  } catch (_e) { /* 忽略，保持默认级别 */ }
  logger.info('SYSTEM', 'startup', '=================================');
  logger.info('SYSTEM', 'startup', '   MusicHub Server');
  logger.info('SYSTEM', 'startup', '=================================');
  logger.info('SYSTEM', 'startup', `Server running on port ${PORT}`);
  logger.info('SYSTEM', 'startup', `API: http://localhost:${PORT}`);
  logger.info('SYSTEM', 'startup', '=================================');

  // 记录前台日志 - 系统启动
  frontendLogger.info('SYSTEM', 'System started', { port: PORT });

  // 封面缓存根目录注入 + sharp WebP 编码器启动自检（文档四-5；不可用则扫描期封面自动降级）
  try {
    coverCache.setRoot(CACHE_DIR);
    const selfCheck = await coverCache.selfCheckSharp();
    if (!selfCheck.ok) {
      logger.warn('SYSTEM', 'startup', 'sharp self-check failed, cover cache will fallback to jpeg/raw', { error: selfCheck.error });
    }
  } catch (e) {
    logger.warn('SYSTEM', 'startup', 'sharp self-check threw', { error: e && e.message });
  }

  // 初始化调度器管理器
  try {
    await schedulerManager.init();
    logger.info('SYSTEM', 'startup', 'Scheduler manager initialized');
  } catch (err) {
    logger.error('SYSTEM', 'startup', 'Failed to initialize scheduler manager', { error: err.message });
    frontendLogger.error('SYSTEM', 'Scheduler init failed', { error: err.message });
  }

  // 插件定时更新已由 schedulerManager.init() 统一注册，避免重复调度
});
