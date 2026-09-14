'use strict';

// ==================== 日志核心（仅 stdout/stderr，backend 日志不落盘）====================
// 设计约定：
//  - backend 运行日志只输出到 stdout/stderr（容器 / supervisord / docker logs 采集），不写任何日志文件；
//  - 唯一的日志文件是前台日志 data/logs/app.log（见 core/frontend-logger.js）；
//  - 默认级别 info：平时只显示 INFO / WARN / ERROR 关键节点；
//    需要排查细节时置 LOG_LEVEL=debug 或在设置里开「调试日志」；
//  - 分级原则：error=出错，warn=可恢复异常/降级，info=关键业务节点，debug=内部细节/每请求每轮。
//  - 默认级别 info：平时只显示 INFO / WARN / ERROR 关键节点；
//    需要排查细节时置 LOG_LEVEL=debug 或在设置里开「调试日志」；
//  - 分级原则：error=出错，warn=可恢复异常/降级，info=关键业务节点，debug=内部细节/每请求每轮。
const LEVEL_PRIORITY = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    trace: 4
};

// 当前日志级别（运行时可通过 setLevel 动态调整，默认取环境变量；未配置时为 info）
let currentLevel = process.env.LOG_LEVEL || 'info';

const MAX_LEVEL_LENGTH = 5; // ERROR, WARN, INFO, DEBUG

function shouldLog(level) {
    return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[currentLevel];
}

/**
 * 运行时切换日志级别（仅接受合法级别）
 * @param {string} level - error / warn / info / debug
 */
function setLevel(level) {
    if (level && LEVEL_PRIORITY[level] !== undefined) {
        currentLevel = level;
    }
}

/**
 * 获取当前日志级别
 * @returns {string}
 */
function getLevel() {
    return currentLevel;
}

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

function format(level, module, reqId, msg) {
    const time = formatTime();
    // 对齐日志级别，统一宽度
    const paddedLevel = level.toUpperCase().padEnd(MAX_LEVEL_LENGTH);
    return `${time} [${paddedLevel}][${module}][${reqId}] ${msg}`;
}

function log(level, module, reqId, msg, meta) {
    if (!shouldLog(level)) return;

    let out = format(level, module, reqId, msg);

    if (meta !== undefined && meta !== null) {
        try {
            out += ' | ' + JSON.stringify(meta);
        } catch { /* 序列化失败不影响输出 */ }
    }

    // 统一输出到 stdout（INFO/DEBUG）或 stderr（WARN/ERROR）；backend 日志不落盘
    if (level === 'error') {
        console.error(out);
    } else if (level === 'warn') {
        console.warn(out);
    } else {
        console.log(out);
    }
}

/**
 * 格式化错误对象
 * 默认只返回 message，DEBUG 模式下包含 stack
 * @param {Error} err - 错误对象
 * @returns {Object} 格式化后的错误信息
 */
function formatError(err) {
    if (!err || typeof err !== 'object') {
        return { message: String(err) };
    }

    const result = {
        message: err.message || 'Unknown error'
    };

    // 仅在 DEBUG 模式下包含 stack
    if (currentLevel === 'debug' && err.stack) {
        // 压缩 stack，只保留关键行（第一行是错误信息，第二行是位置）
        const stackLines = err.stack.split('\n');
        if (stackLines.length > 1) {
            const shortStack = stackLines[1]?.trim();
            if (shortStack) {
                result.stack = shortStack;
            }
        }
    }

    return result;
}

module.exports = {
    info: (m, r, msg, meta) => log('info', m, r, msg, meta),
    warn: (m, r, msg, meta) => log('warn', m, r, msg, meta),
    error: (m, r, msg, meta) => log('error', m, r, msg, meta),
    debug: (m, r, msg, meta) => log('debug', m, r, msg, meta),
    trace: (m, r, msg, meta) => log('trace', m, r, msg, meta),
    setLevel,
    getLevel,
    formatError
};
