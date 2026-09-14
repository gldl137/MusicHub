'use strict';

const fs = require('fs');
const path = require('path');

// 日志文件：data/logs/app.log —— 全系统唯一的日志文件，文件名不带日期。
// 大小上限：超过即清空重写（不做多份轮转，只保留这一个文件）。
const _LOG_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const LOG_DIR = path.join(_LOG_DATA_DIR, 'logs');
const APP_LOG_FILE = path.join(LOG_DIR, 'app.log');
const APP_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB
let _logDirReady = false;
let appLogBytes = 0;
function ensureLogDir() {
    if (_logDirReady) return;
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); _logDirReady = true; } catch { /* 忽略 */ }
}
function initAppLogSize() {
    try { appLogBytes = fs.existsSync(APP_LOG_FILE) ? fs.statSync(APP_LOG_FILE).size : 0; } catch { appLogBytes = 0; }
}
function appendAppLog(line) {
    try {
        ensureLogDir();
        if (appLogBytes > APP_LOG_MAX_BYTES) {
            fs.writeFileSync(APP_LOG_FILE, '');
            appLogBytes = 0;
        }
        fs.appendFileSync(APP_LOG_FILE, line + '\n');
        appLogBytes += Buffer.byteLength(line) + 1;
    } catch { /* 落盘失败不影响主流程 */ }
}
function truncateAppLog() {
    try { ensureLogDir(); fs.writeFileSync(APP_LOG_FILE, ''); appLogBytes = 0; } catch { /* 忽略 */ }
}
initAppLogSize();

// ==================== 前台业务日志（人读，内存环形缓冲 + stdout + 唯一日志文件 app.log）====================
// 设计约定：
//  - 记录面向用户的业务节点（登录/播放/下载/歌单/订阅/定时任务等），
//    供设置页「日志查看」读取；同时保存在内存环形缓冲与 data/logs/app.log；
//  - stdout 同步输出原始消息（容器 / supervisord 采集）；
//  - 只记录 info 及以上级别；debug 直接丢弃（前端业务日志不需要内部细节）。

// 最大保存日志条数
const MAX_LOGS = 500;

// 内存中缓存的日志
let logsCache = [];

/**
 * 获取当天日期字符串（不再用于文件名，保留仅作无实际用途的兼容占位无需）
 */

/**
 * 格式化时间戳
 * @returns {string} HH:mm:ss
 */
function formatTime() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

/**
 * 日志消息中文映射表
 */
const MESSAGE_MAP = {
    // 用户相关
    'User logged in': '用户登录成功',
    'User logged out': '用户退出登录',
    'User created': '创建新用户',
    'User deleted': '删除用户',
    'User updated': '更新用户信息',
    'Password changed': '用户修改密码',
    'Login failed': '登录失败',

    // 播放相关
    'Playback started': '开始播放',
    'Playback paused': '暂停播放',
    'Playback resumed': '恢复播放',
    'Playback stopped': '停止播放',
    'Track changed': '切换歌曲',
    'Playlist cleared': '清空播放列表',
    'Next track': '播放下一首',
    'Previous track': '播放上一首',
    'Playback ended': '播放结束',
    'Playback error': '播放出错',
    'Playback skipped': '跳过歌曲',
    'Shuffle enabled': '开启随机播放',
    'Shuffle disabled': '关闭随机播放',
    'Repeat enabled': '开启循环播放',
    'Repeat disabled': '关闭循环播放',
    'Quality changed': '切换音质',
    'Mute enabled': '开启静音',
    'Mute disabled': '关闭静音',

    // 搜索相关
    'Search completed': '搜索完成',
    'Search failed': '搜索失败',

    // 下载相关
    'Download started': '开始下载',
    'Download completed': '下载完成',
    'Download failed': '下载失败',
    'Download cancelled': '下载已取消',
    'Download queued': '下载已排队',

    // 歌单相关
    'Playlist created': '创建歌单',
    'Playlist deleted': '删除歌单',
    'Playlist updated': '更新歌单',
    'Song added to playlist': '歌曲添加到歌单',
    'Song removed from playlist': '歌曲从歌单移除',
    'Playlist create failed': '歌单创建失败',
    'Playlist update failed': '歌单更新失败',
    'Playlist delete failed': '歌单删除失败',
    'Song add to playlist failed': '歌曲添加到歌单失败',
    'Song remove from playlist failed': '从歌单移除歌曲失败',

    // 订阅相关
    'Subscription created': '创建订阅',
    'Subscription deleted': '删除订阅',
    'Subscription updated': '更新订阅',
    'Subscription synced': '订阅已同步',

    // 系统相关
    'System started': '系统启动',
    'System shutdown': '系统关闭',
    'Settings updated': '更新系统设置',
    'Cache cleared': '清除缓存',
    'Import started': '开始导入',
    'Import completed': '导入完成',
    'Export completed': '导出完成',
    'Scheduler init failed': '调度器初始化失败',

    // 插件相关
    'Plugin installed': '安装插件',
    'Plugin uninstalled': '卸载插件',
    'Plugin enabled': '启用插件',
    'Plugin disabled': '禁用插件',
    'Plugin updated': '更新插件',
    'Plugin toggle failed': '插件切换状态失败',

    // 音乐源相关
    'Source added': '添加音乐源',
    'Source removed': '移除音乐源',
    'Source updated': '更新音乐源',
    'Source sync started': '开始同步音乐源',
    'Source sync completed': '音乐源同步完成',

    // 错误相关
    'Network error': '网络连接错误',
    'API request failed': 'API请求失败',
    'File not found': '文件未找到',
    'Permission denied': '权限不足',
    'Database error': '数据库错误',
    'Plugin error': '插件错误',
    'Source error': '音乐源错误',
    'Download error': '下载出错',
    'Sync error': '同步失败',
    'Import error': '导入失败',
    'Export error': '导出失败',

    // 警告相关
    'Low disk space': '磁盘空间不足',
    'Network unstable': '网络不稳定',
    'High memory usage': '内存使用过高',
    'Rate limit warning': '请求频率限制警告',
    'Session expiring': '会话即将过期',

    // 通知相关 - 统一格式：xxx任务通知已发送
    'Notification sent': '任务通知已发送',
    'Notification failed': '任务通知发送失败',

    // 定时任务相关
    'Scheduler started': '定时任务已启动',
    'Scheduler stopped': '定时任务已停止',
    'Task executed': '定时任务执行成功',
    'Task failed': '定时任务执行失败',
    'Sync task started': '同步任务开始',
    'Sync task completed': '同步任务完成',

    // 收藏相关
    'Favorite added': '添加收藏',
    'Favorite removed': '取消收藏',
    'Favorite updated': '更新收藏',
    'Favorites imported': '收藏导入成功',
    'Favorites exported': '收藏导出成功',

    // 同步相关
    'Sync started': '开始同步',
    'Sync completed': '同步完成',
    'Sync failed': '同步失败',
    'Library synced': '媒体库已同步',
    'Playlist synced': '歌单已同步',
    'Data synced': '数据已同步',

    // 默认
    'Unknown event': '未知事件'
};

/**
 * 模块名称中文映射表
 */
const MODULE_MAP = {
    'AUTH': '用户认证',
    'USER': '用户管理',
    'PLAYBACK': '播放控制',
    'SEARCH': '搜索',
    'DOWNLOAD': '下载',
    'PLAYLIST': '歌单',
    'SUBSCRIPTION': '订阅',
    'SYSTEM': '系统管理',
    'PLUGIN': '插件管理',
    'SOURCE': '音乐源',
    'IMPORT': '导入导出',
    'NETWORK': '网络通信',
    'DATABASE': '数据库',
    'API': '接口服务',
    'FAVORITE': '收藏管理',
    'NOTIFICATION': '通知服务',
    'SCHEDULER': '定时任务',
    'SYNC': '数据同步',
    'ERROR': '错误处理',
    'WARNING': '警告信息'
};

/**
 * 转换为中文消息
 * @param {string} message - 英文消息
 * @returns {string} 中文消息
 */
function toChineseMessage(message) {
    // 尝试完全匹配
    if (MESSAGE_MAP[message]) {
        return MESSAGE_MAP[message];
    }

    // 尝试部分匹配
    for (const [key, value] of Object.entries(MESSAGE_MAP)) {
        if (message.includes(key)) {
            return value;
        }
    }

    // 返回原消息
    return message;
}

/**
 * 转换为中文模块名
 * @param {string} module - 英文模块名
 * @returns {string} 中文模块名
 */
function toChineseModule(module) {
    return MODULE_MAP[module] || module;
}

/**
 * 添加前台日志
 * @param {string} level - 日志级别: error, warn, info
 * @param {string} module - 模块名
 * @param {string} message - 日志消息
 * @param {object} meta - 额外元数据（可选）
 */
function log(level, module, message, meta = null) {
    // 只过滤 debug 级别，保留 info 及以上级别
    if (level === 'debug') return;

    const logEntry = {
        time: formatTime(),
        level: level.toLowerCase(),
        module: toChineseModule(module),
        message: toChineseMessage(message),
        meta: meta,
        timestamp: Date.now()
    };

    // 添加到缓存（保持最多 MAX_LOGS 条）
    logsCache.push(logEntry);
    if (logsCache.length > MAX_LOGS) {
        logsCache.shift();
    }

    // 输出到 stdout（info→console.log，warn→console.warn，error→console.error）
    const metaStr = meta ? ` | ${JSON.stringify(meta)}` : '';
    const out = `[前台日志][${level.toUpperCase()}][${module}] ${message}${metaStr}`;
    if (level === 'error') {
        console.error(out);
    } else if (level === 'warn') {
        console.warn(out);
    } else {
        console.log(out);
    }

    // 追加写入唯一日志文件 data/logs/app.log（超过大小上限自动清空重写）
    appendAppLog(out);
}

/**
 * 获取所有日志（用于API返回）
 * @returns {Array} 日志数组
 */
function getLogs() {
    return [...logsCache];
}

/**
 * 清空日志（内存缓冲 + 唯一日志文件 app.log 一并清空）
 */
function clearLogs() {
    logsCache = [];
    truncateAppLog();
}

/**
 * 获取日志文件路径（唯一日志文件 data/logs/app.log）
 * @returns {string}
 */
function getLogFilePath() {
    return APP_LOG_FILE;
}

module.exports = {
    info: (module, message, meta) => log('info', module, message, meta),
    warn: (module, message, meta) => log('warn', module, message, meta),
    error: (module, message, meta) => log('error', module, message, meta),
    getLogs,
    clearLogs,
    getLogFilePath
};
