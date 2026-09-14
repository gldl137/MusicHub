/**
 * 日志过滤器
 * 在最早阶段加载，拦截并过滤所有 console 输出
 */

// 保存原始方法
const originalLog = console.log;
const originalInfo = console.info;
const originalWarn = console.warn;
const originalError = console.error;

// 检查是否应该过滤该日志
function shouldFilter(args) {
    if (args.length === 0) return false;
    
    const firstArg = args[0];
    if (typeof firstArg !== 'string') return false;
    
    // 检查是否包含 [INFO] 标签
    if (firstArg.includes('[INFO]')) return true;
    
    // 检查是否包含 [DEBUG] 标签
    if (firstArg.includes('[DEBUG]')) return true;
    
    return false;
}

// 重写 console 方法
console.log = function(...args) {
    if (!shouldFilter(args)) {
        originalLog.apply(console, args);
    }
};

console.info = function(...args) {
    if (!shouldFilter(args)) {
        originalInfo.apply(console, args);
    }
};

console.debug = function(..._args) {
    // 始终过滤 debug 日志
    // 如果需要调试，可以临时注释掉这一行
    return;
};

// 保留原始错误输出
console.error = originalError;
console.warn = originalWarn;
