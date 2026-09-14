/**
 * EventBus 事件总线模块
 * 提供发布/订阅模式的事件系统，支持命名空间、一次性事件和优先级
 * 
 * 特性：
 * - 支持命名空间（如 'player:play', 'player:pause'）
 * - 支持一次性事件订阅
 * - 支持订阅优先级
 * - 支持异步事件处理
 * - 完善的错误处理和调试
 */

class EventBus {
    constructor() {
        this.events = new Map();
        this.wildcardEvents = new Map(); // 通配符事件订阅
        this.onceEvents = new Set();
        this.debug = false;
        this.maxListeners = 100; // 每个事件的最大监听器数
        
        // 性能统计
        this.stats = {
            emitted: 0,
            handled: 0,
            errors: 0
        };
    }

    // ==================== 日志系统 ====================

    _log(...args) {
        if (this.debug) {
            console.log('[EventBus]', ...args);
        }
    }

    _warn(...args) {
        console.warn('[EventBus]', ...args);
    }

    _error(...args) {
        console.error('[EventBus]', ...args);
    }

    setDebug(enabled) {
        this.debug = enabled;
    }

    // ==================== 核心 API ====================

    /**
     * 订阅事件
     * @param {string} eventName - 事件名称（支持命名空间，如 'player:play'）
     * @param {Function} callback - 回调函数
     * @param {Object} options - 选项
     *   @param {number} options.priority - 优先级（数字越大优先级越高，默认 0）
     *   @param {boolean} options.once - 是否只执行一次
     *   @param {string} options.namespace - 监听器命名空间（用于批量取消订阅）
     * @returns {Function} - 取消订阅函数
     */
    on(eventName, callback, options = {}) {
        if (typeof callback !== 'function') {
            this._error('Callback must be a function');
            return () => {};
        }

        const { priority = 0, once = false, namespace = 'default' } = options;

        // 检查通配符
        if (eventName.includes('*')) {
            return this._onWildcard(eventName, callback, options);
        }

        // 获取或创建事件监听列表
        if (!this.events.has(eventName)) {
            this.events.set(eventName, []);
        }

        const listeners = this.events.get(eventName);

        // 检查监听器数量限制
        if (listeners.length >= this.maxListeners) {
            this._warn(`Max listeners (${this.maxListeners}) reached for event "${eventName}"`);
        }

        const listener = {
            callback,
            priority,
            once,
            namespace,
            id: this._generateId()
        };

        // 按优先级插入
        const index = listeners.findIndex(l => l.priority < priority);
        if (index === -1) {
            listeners.push(listener);
        } else {
            listeners.splice(index, 0, listener);
        }

        if (once) {
            this.onceEvents.add(listener.id);
        }

        this._log(`Subscribed to "${eventName}" (namespace: ${namespace}, priority: ${priority})`);

        // 返回取消订阅函数
        return () => this.off(eventName, listener.id);
    }

    /**
     * 订阅一次性事件
     */
    once(eventName, callback, options = {}) {
        return this.on(eventName, callback, { ...options, once: true });
    }

    /**
     * 取消订阅
     */
    off(eventName, listenerId) {
        const listeners = this.events.get(eventName);
        if (!listeners) return false;

        const index = listeners.findIndex(l => l.id === listenerId);
        if (index > -1) {
            listeners.splice(index, 1);
            this.onceEvents.delete(listenerId);
            this._log(`Unsubscribed from "${eventName}"`);
            return true;
        }

        return false;
    }

    /**
     * 取消命名空间下的所有订阅
     */
    offNamespace(namespace) {
        let removedCount = 0;

        this.events.forEach((listeners) => {
            for (let i = listeners.length - 1; i >= 0; i--) {
                if (listeners[i].namespace === namespace) {
                    this.onceEvents.delete(listeners[i].id);
                    listeners.splice(i, 1);
                    removedCount++;
                }
            }
        });

        this.wildcardEvents.forEach((listeners) => {
            for (let i = listeners.length - 1; i >= 0; i--) {
                if (listeners[i].namespace === namespace) {
                    listeners.splice(i, 1);
                    removedCount++;
                }
            }
        });

        this._log(`Removed ${removedCount} listeners in namespace "${namespace}"`);
        return removedCount;
    }

    /**
     * 触发事件
     * @param {string} eventName - 事件名称
     * @param {*} data - 事件数据
     * @param {Object} options - 选项
     *   @param {boolean} options.async - 是否异步执行
     *   @param {boolean} options.propagate - 是否传播到通配符监听器
     */
    emit(eventName, data, options = {}) {
        const { async = false, propagate = true } = options;

        this.stats.emitted++;
        this._log(`Emitting "${eventName}"`, data);

        // 收集所有要执行的监听器
        const listenersToExecute = [];

        // 精确匹配
        const exactListeners = this.events.get(eventName);
        if (exactListeners) {
            listenersToExecute.push(...exactListeners);
        }

        // 通配符匹配
        if (propagate) {
            this.wildcardEvents.forEach((listeners, pattern) => {
                if (this._matchWildcard(eventName, pattern)) {
                    listenersToExecute.push(...listeners);
                }
            });
        }

        if (listenersToExecute.length === 0) {
            return Promise.resolve([]);
        }

        // 按优先级排序
        listenersToExecute.sort((a, b) => b.priority - a.priority);

        // 执行监听器
        if (async) {
            return this._executeAsync(listenersToExecute, eventName, data);
        } else {
            return Promise.resolve(this._executeSync(listenersToExecute, eventName, data));
        }
    }

    /**
     * 同步执行监听器
     */
    _executeSync(listeners, eventName, data) {
        const results = [];
        const toRemove = [];

        for (const listener of listeners) {
            try {
                const result = listener.callback(data, { eventName, listener });
                results.push({ listener: listener.id, result });
                this.stats.handled++;

                if (listener.once || this.onceEvents.has(listener.id)) {
                    toRemove.push({ eventName, id: listener.id });
                }
            } catch (error) {
                this.stats.errors++;
                this._error(`Error in listener for "${eventName}":`, error);
                results.push({ listener: listener.id, error: error.message });
            }
        }

        // 移除一次性监听器
        toRemove.forEach(({ eventName, id }) => this.off(eventName, id));

        return results;
    }

    /**
     * 异步执行监听器
     */
    async _executeAsync(listeners, eventName, data) {
        const results = [];
        const toRemove = [];

        for (const listener of listeners) {
            try {
                const result = await listener.callback(data, { eventName, listener });
                results.push({ listener: listener.id, result });
                this.stats.handled++;

                if (listener.once || this.onceEvents.has(listener.id)) {
                    toRemove.push({ eventName, id: listener.id });
                }
            } catch (error) {
                this.stats.errors++;
                this._error(`Error in async listener for "${eventName}":`, error);
                results.push({ listener: listener.id, error: error.message });
            }
        }

        // 移除一次性监听器
        toRemove.forEach(({ eventName, id }) => this.off(eventName, id));

        return results;
    }

    // ==================== 通配符支持 ====================

    /**
     * 订阅通配符事件
     */
    _onWildcard(pattern, callback, options) {
        if (!this.wildcardEvents.has(pattern)) {
            this.wildcardEvents.set(pattern, []);
        }

        const listener = {
            callback,
            priority: options.priority || 0,
            once: options.once || false,
            namespace: options.namespace || 'default',
            id: this._generateId()
        };

        const listeners = this.wildcardEvents.get(pattern);
        const index = listeners.findIndex(l => l.priority < listener.priority);
        
        if (index === -1) {
            listeners.push(listener);
        } else {
            listeners.splice(index, 0, listener);
        }

        this._log(`Subscribed to wildcard "${pattern}"`);

        return () => {
            const idx = listeners.findIndex(l => l.id === listener.id);
            if (idx > -1) listeners.splice(idx, 1);
        };
    }

    /**
     * 通配符匹配
     * 支持 * 匹配任意字符，** 匹配任意层级
     */
    _matchWildcard(eventName, pattern) {
        const regex = pattern
            .replace(/\*\*/g, '{{WILDCARD_MULTI}}')
            .replace(/\*/g, '{{WILDCARD_SINGLE}}')
            .replace(/\{\{WILDCARD_MULTI\}\}/g, '.*')
            .replace(/\{\{WILDCARD_SINGLE\}\}/g, '[^:]*');
        
        return new RegExp(`^${regex}$`).test(eventName);
    }

    // ==================== 工具方法 ====================

    _generateId() {
        return Math.random().toString(36).substring(2, 15);
    }

    /**
     * 获取事件统计
     */
    getStats() {
        const eventCounts = {};
        this.events.forEach((listeners, name) => {
            eventCounts[name] = listeners.length;
        });

        return {
            ...this.stats,
            eventCounts,
            wildcardPatterns: this.wildcardEvents.size,
            totalListeners: Array.from(this.events.values()).reduce((sum, l) => sum + l.length, 0)
        };
    }

    /**
     * 获取所有事件名称
     */
    getEventNames() {
        return Array.from(this.events.keys());
    }

    /**
     * 清除所有事件
     */
    clear() {
        this.events.clear();
        this.wildcardEvents.clear();
        this.onceEvents.clear();
        this.stats = { emitted: 0, handled: 0, errors: 0 };
        this._log('All events cleared');
    }

    /**
     * 检查是否有监听器
     */
    hasListeners(eventName) {
        return this.events.has(eventName) && this.events.get(eventName).length > 0;
    }

    /**
     * 获取监听器数量
     */
    listenerCount(eventName) {
        const listeners = this.events.get(eventName);
        return listeners ? listeners.length : 0;
    }

    // ==================== 快捷方法 ====================

    /**
     * 监听所有状态变化事件
     */
    onStatusChange(callback, options = {}) {
        return this.on('*:statusChanged', callback, options);
    }

    /**
     * 监听所有批量变化事件
     */
    onBatchChange(callback, options = {}) {
        return this.on('*:batchChanged', callback, options);
    }
}

// 创建全局单例
const eventBus = new EventBus();

// 导出到全局
window.EventBus = eventBus;
