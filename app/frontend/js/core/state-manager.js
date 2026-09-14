/**
 * 统一状态管理模块 (StateManager)
 * 负责集中管理下载和收藏按钮的状态
 * 使用事件驱动机制确保多个页面/组件间状态同步
 * 
 * 特性：
 * - 支持 localStorage 和 IndexedDB 双存储
 * - 完善的事件系统（CustomEvent + EventBus）
 * - 批量操作优化
 * - 状态验证和清理
 * - 增强的错误处理和调试日志
 */

class StateManagerCore {
    constructor() {
        // ==================== 状态存储 ====================
        this.downloadStatus = new Map();
        this.favoriteStatus = new Map();

        // ==================== 配置 ====================
        this.config = {
            storageKey: 'musichub_state_manager_v3', // v3: 下载状态不存储在本地，只从数据库获取
            dbName: 'MusicHubStateDB',
            dbVersion: 3, // 更新版本以清除旧缓存
            storeName: 'buttonStates',
            maxStorageSize: 5 * 1024 * 1024, // 5MB
            debug: false,
            useIndexedDB: false, // 默认使用 localStorage 避免异步问题
            autoClean: true, // 自动清理过期状态
            cleanThreshold: 10000 // 最多保存 10000 条记录
        };

        // ==================== 状态 ====================
        this.initialized = false;
        this.db = null;
        this.storageMode = 'localStorage';
        this.eventListeners = new Map();

        // ==================== 初始化 Promise ====================
        this._readyPromise = null;
        this._readyResolve = null;
        this._readyPromise = new Promise(resolve => {
            this._readyResolve = resolve;
        });

        // ==================== 同步初始化 ====================
        this._initSync();

        // ==================== 异步初始化（后台执行）====================
        this._initAsync();
    }

    // ==================== 同步初始化 ====================

    _initSync() {
        // 清除可能存在的旧下载状态缓存（确保从数据库实时获取）
        this._clearOldDownloadCache();

        // 立即从 localStorage 加载数据（同步）
        this._loadFromLocalStorage();
        this._log('StateManager initialized (sync)');
    }

    /**
     * 清除旧的下载状态缓存
     */
    _clearOldDownloadCache() {
        try {
            // 清除所有可能包含下载状态的旧存储键
            const keysToRemove = [
                'musichub_download_status',
                'musichub_downloaded_songs',
                'musichub_state_manager',
                'musichub_state_manager_v2'
            ];

            keysToRemove.forEach(key => {
                if (localStorage.getItem(key)) {
                    localStorage.removeItem(key);
                    this._log(`Cleared old cache: ${key}`);
                }
            });

            // 清除当前存储键中的下载状态（保留收藏状态）
            const stored = localStorage.getItem(this.config.storageKey);
            if (stored) {
                const data = JSON.parse(stored);
                if (data.downloadStatus) {
                    delete data.downloadStatus;
                    localStorage.setItem(this.config.storageKey, JSON.stringify(data));
                    this._log('Cleared download status from current storage');
                }
            }
        } catch (error) {
            this._warn('Failed to clear old download cache:', error);
        }
    }

    // ==================== 异步初始化 ====================

    async _initAsync() {
        try {
            // 尝试初始化 IndexedDB（后台）
            if (this.config.useIndexedDB && 'indexedDB' in window) {
                await this._initIndexedDB();
                // 清除 IndexedDB 中的下载状态
                await this._clearIndexedDBDownloadCache();
                // 从 IndexedDB 加载（只加载收藏状态）
                await this._loadFromIndexedDB();
            }
        } catch (error) {
            this._warn('IndexedDB initialization failed:', error);
        }

        this.initialized = true;
        this._log(`StateManager fully initialized with ${this.storageMode}`);

        // 启动自动清理
        if (this.config.autoClean) {
            this._scheduleAutoClean();
        }

        // 通知已就绪
        if (this._readyResolve) {
            this._readyResolve();
        }
    }

    /**
     * 清除 IndexedDB 中的下载状态缓存
     */
    async _clearIndexedDBDownloadCache() {
        if (!this.db) return;

        try {
            const transaction = this.db.transaction([this.config.storeName], 'readwrite');
            const store = transaction.objectStore(this.config.storeName);
            const index = store.index('type');

            // 获取所有下载类型的记录
            const request = index.getAll('download');

            await new Promise((resolve, reject) => {
                request.onsuccess = () => {
                    const records = request.result;
                    records.forEach(record => {
                        store.delete(record.key);
                    });
                    this._log(`Cleared ${records.length} download records from IndexedDB`);
                    resolve();
                };
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            this._warn('Failed to clear IndexedDB download cache:', error);
        }
    }

    async _initIndexedDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.config.dbName, this.config.dbVersion);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                this.storageMode = 'indexedDB';
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.config.storeName)) {
                    const store = db.createObjectStore(this.config.storeName, { keyPath: 'key' });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                    store.createIndex('type', 'type', { unique: false });
                }
            };
        });
    }

    /**
     * 等待初始化完成
     */
    ready() {
        return this._readyPromise;
    }

    // ==================== 日志系统 ====================

    _log(...args) {
        if (this.config.debug) {
            console.log('[StateManager]', ...args);
        }
    }

    _warn(...args) {
        console.warn('[StateManager]', ...args);
    }

    _error(...args) {
        console.error('[StateManager]', ...args);
    }

    setDebug(enabled) {
        this.config.debug = enabled;
    }

    // ==================== 存储操作 ====================

    async loadFromStorage() {
        // 已经同步加载过了，这里不需要重复
        return Promise.resolve();
    }

    _loadFromLocalStorage() {
        try {
            const stored = localStorage.getItem(this.config.storageKey);
            if (stored) {
                const data = JSON.parse(stored);
                // 下载状态不从 localStorage 加载，只从数据库获取
                // if (data.downloadStatus) {
                //     this.downloadStatus = new Map(Object.entries(data.downloadStatus));
                // }
                if (data.favoriteStatus) {
                    this.favoriteStatus = new Map(Object.entries(data.favoriteStatus));
                }
                this._log(`Loaded ${this.favoriteStatus.size} favorite from localStorage (download status not persisted)`);
            }
        } catch (error) {
            this._error('Failed to load from localStorage:', error);
        }
    }

    async _loadFromIndexedDB() {
        if (!this.db) return;
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.config.storeName], 'readonly');
            const store = transaction.objectStore(this.config.storeName);
            const request = store.getAll();

            request.onsuccess = () => {
                const records = request.result;
                // 合并 IndexedDB 数据到现有数据（下载状态不从 IndexedDB 加载）
                records.forEach(record => {
                    // 下载状态不从 IndexedDB 加载，只从数据库获取
                    // if (record.type === 'download') {
                    //     this.downloadStatus.set(record.key, record.status);
                    // } else 
                    if (record.type === 'favorite') {
                        this.favoriteStatus.set(record.key, record.status);
                    }
                });
                this._log(`Merged ${records.length} records from IndexedDB (download status not loaded)`);
                resolve();
            };

            request.onerror = () => reject(request.error);
        });
    }

    saveToStorage() {
        // 同步保存到 localStorage
        this._saveToLocalStorage();
        
        // 异步保存到 IndexedDB（如果可用）
        if (this.storageMode === 'indexedDB' && this.db) {
            this._saveToIndexedDB().catch(err => {
                this._warn('Failed to save to IndexedDB:', err);
            });
        }
    }

    _saveToLocalStorage() {
        try {
            // 下载状态不保存到 localStorage，只保存收藏状态
            const data = {
                // downloadStatus: Object.fromEntries(this.downloadStatus), // 不保存下载状态
                favoriteStatus: Object.fromEntries(this.favoriteStatus),
                timestamp: Date.now(),
                version: 1
            };
            const json = JSON.stringify(data);
            
            // 检查存储大小
            if (json.length > this.config.maxStorageSize) {
                this._warn('Data size exceeds limit, cleaning old entries...');
                this._cleanOldEntries();
                const cleanedData = {
                    // downloadStatus: Object.fromEntries(this.downloadStatus), // 不保存下载状态
                    favoriteStatus: Object.fromEntries(this.favoriteStatus),
                    timestamp: Date.now(),
                    version: 1
                };
                localStorage.setItem(this.config.storageKey, JSON.stringify(cleanedData));
            } else {
                localStorage.setItem(this.config.storageKey, json);
            }
        } catch (error) {
            if (error.name === 'QuotaExceededError') {
                this._warn('localStorage quota exceeded, cleaning old entries...');
                this._cleanOldEntries();
                this._saveToLocalStorage();
            } else {
                this._error('Failed to save to localStorage:', error);
            }
        }
    }

    async _saveToIndexedDB() {
        if (!this.db) return;
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.config.storeName], 'readwrite');
            const store = transaction.objectStore(this.config.storeName);
            const timestamp = Date.now();

            // 下载状态不保存到 IndexedDB，只保存收藏状态
            // this.downloadStatus.forEach((status, key) => {
            //     store.put({
            //         key,
            //         type: 'download',
            //         status,
            //         timestamp
            //     });
            // });

            // 保存收藏状态
            this.favoriteStatus.forEach((status, key) => {
                store.put({
                    key,
                    type: 'favorite',
                    status,
                    timestamp
                });
            });

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }

    // ==================== 清理机制 ====================

    _cleanOldEntries() {
        const totalSize = this.downloadStatus.size + this.favoriteStatus.size;
        if (totalSize <= this.config.cleanThreshold) return;

        this._log(`Cleaning old entries. Current size: ${totalSize}`);

        // 优先清理下载状态（可重新获取）
        const entriesToDelete = totalSize - this.config.cleanThreshold;
        let deleted = 0;

        // 删除旧的下载状态（保留已下载的）
        for (const [key, status] of this.downloadStatus) {
            if (status !== 'downloaded' && deleted < entriesToDelete / 2) {
                this.downloadStatus.delete(key);
                deleted++;
            }
        }

        this._log(`Cleaned ${deleted} old entries`);
    }

    _scheduleAutoClean() {
        // 每 24 小时清理一次
        setInterval(() => {
            this._cleanOldEntries();
            this.saveToStorage();
        }, 24 * 60 * 60 * 1000);
    }

    // ==================== 辅助方法 ====================

    _getKey(musicId, plugin) {
        const p = plugin || '';
        return p ? `${musicId}_${p}` : musicId;
    }

    _validateMusicId(musicId) {
        if (!musicId) {
            this._warn('Invalid musicId:', musicId);
            return false;
        }
        return true;
    }

    // ==================== 下载状态管理 ====================
    // 注意：下载状态只从数据库获取，不存储在内存或本地

    /**
     * 从数据库获取下载状态（实时查询）
     * @param {string} musicId - 歌曲ID
     * @param {string} plugin - 插件名称
     * @returns {Promise<string>} - 返回状态: 'pending', 'downloading', 'downloaded', 'error'
     */
    async getDownloadStatus(musicId, plugin) {
        if (!this._validateMusicId(musicId)) return 'pending';
        
        try {
            const url = `${API_BASE}/api/downloads/check?musicId=${encodeURIComponent(musicId)}&plugin=${encodeURIComponent(plugin)}`;
            const response = await fetch(url);
            const result = await response.json();
            
            if (result.success && result.data) {
                const status = result.data.downloaded ? 'downloaded' : 'pending';
                this._log(`[DEBUG] Returning status: ${status}`);
                return status;
            }
            return 'pending';
        } catch (error) {
            this._error('Failed to get download status from server:', error);
            return 'pending';
        }
    }

    /**
     * 设置下载状态（仅用于临时状态更新，不持久化到本地存储）
     * @param {string} musicId - 歌曲ID
     * @param {string} plugin - 插件名称
     * @param {string} status - 状态
     * @param {boolean} broadcast - 是否广播事件
     */
    setDownloadStatus(musicId, plugin, status, broadcast = true) {
        if (!this._validateMusicId(musicId)) {
            return;
        }

        // 只广播事件，不存储到内存或本地
        if (broadcast) {
            this._broadcastStatusChange(musicId, plugin, 'download', status);
        }
    }

    /**
     * 批量设置下载状态（仅广播事件）
     * @param {Array} items - 状态项数组
     * @param {boolean} broadcast - 是否广播
     */
    setDownloadStatusBatch(items, broadcast = true) {
        if (broadcast) {
            this._broadcastBatchChange('download', items);
        }
        return items.length;
    }

    /**
     * 检查歌曲是否已下载（实时查询数据库）
     * @param {string} musicId - 歌曲ID
     * @param {string} plugin - 插件名称
     * @returns {Promise<boolean>} - 是否已下载
     */
    async isDownloaded(musicId, plugin) {
        const status = await this.getDownloadStatus(musicId, plugin);
        return status === 'downloaded';
    }

    isDownloading(musicId, plugin) {
        return this.getDownloadStatus(musicId, plugin) === 'downloading';
    }

    // ==================== 收藏状态管理 ====================

    getFavoriteStatus(musicId, plugin) {
        if (!this._validateMusicId(musicId)) return false;
        const key = this._getKey(musicId, plugin);
        return this.favoriteStatus.get(key) || false;
    }

    setFavoriteStatus(musicId, plugin, status, broadcast = true) {
        if (!this._validateMusicId(musicId)) return;

        const key = this._getKey(musicId, plugin);
        const oldStatus = this.favoriteStatus.get(key);

        if (oldStatus === status) return;

        this.favoriteStatus.set(key, status);
        this.saveToStorage();

        this._log('Favorite status changed:', { musicId, plugin, status });

        if (broadcast) {
            this._broadcastStatusChange(musicId, plugin, 'favorite', status);
        }
    }

    toggleFavoriteStatus(musicId, plugin, broadcast = true) {
        const currentStatus = this.getFavoriteStatus(musicId, plugin);
        const newStatus = !currentStatus;
        this.setFavoriteStatus(musicId, plugin, newStatus, broadcast);
        return newStatus;
    }

    setFavoriteStatusBatch(items, broadcast = true) {
        const changed = [];

        items.forEach(({ musicId, plugin, status }) => {
            if (!this._validateMusicId(musicId)) return;
            const key = this._getKey(musicId, plugin);
            if (this.favoriteStatus.get(key) !== status) {
                this.favoriteStatus.set(key, status);
                changed.push({ musicId, plugin, status });
            }
        });

        if (changed.length > 0) {
            this.saveToStorage();
            if (broadcast) {
                this._broadcastBatchChange('favorite', changed);
            }
        }

        return changed.length;
    }

    // ==================== 事件系统 ====================

    _broadcastStatusChange(musicId, plugin, type, status) {
        const eventName = `${type}:statusChanged`;
        const detail = { 
            musicId, 
            plugin, 
            status, 
            timestamp: Date.now(),
            source: 'StateManager'
        };

        // CustomEvent
        window.dispatchEvent(new CustomEvent(eventName, { detail }));

        // EventBus
        if (window.EventBus && typeof window.EventBus.emit === 'function') {
            window.EventBus.emit(eventName, detail);
        }
    }

    _broadcastBatchChange(type, items) {
        const eventName = `${type}:batchChanged`;
        const detail = { 
            items, 
            timestamp: Date.now(),
            source: 'StateManager',
            count: items.length
        };

        window.dispatchEvent(new CustomEvent(eventName, { detail }));

        if (window.EventBus && typeof window.EventBus.emit === 'function') {
            window.EventBus.emit(eventName, detail);
        }

        this._log('Broadcast batch:', eventName, `(${items.length} items)`);
    }

    // ==================== 订阅系统 ====================

    subscribe(type, callback, subscriberId = 'anonymous') {
        const eventName = `${type}:statusChanged`;
        
        const handler = (event) => {
            try {
                callback(event.detail);
            } catch (error) {
                this._error(`Error in subscriber ${subscriberId}:`, error);
            }
        };

        window.addEventListener(eventName, handler);

        // 跟踪监听器
        if (!this.eventListeners.has(subscriberId)) {
            this.eventListeners.set(subscriberId, []);
        }
        this.eventListeners.get(subscriberId).push({ eventName, handler });

        this._log(`${subscriberId} subscribed to ${eventName}`);

        return () => {
            window.removeEventListener(eventName, handler);
            const listeners = this.eventListeners.get(subscriberId);
            if (listeners) {
                const index = listeners.findIndex(l => l.handler === handler);
                if (index > -1) listeners.splice(index, 1);
            }
            this._log(`${subscriberId} unsubscribed from ${eventName}`);
        };
    }

    subscribeBatch(type, callback, subscriberId = 'anonymous') {
        const eventName = `${type}:batchChanged`;
        
        const handler = (event) => {
            try {
                callback(event.detail);
            } catch (error) {
                this._error(`Error in batch subscriber ${subscriberId}:`, error);
            }
        };

        window.addEventListener(eventName, handler);

        if (!this.eventListeners.has(subscriberId)) {
            this.eventListeners.set(subscriberId, []);
        }
        this.eventListeners.get(subscriberId).push({ eventName, handler });

        return () => {
            window.removeEventListener(eventName, handler);
            const listeners = this.eventListeners.get(subscriberId);
            if (listeners) {
                const index = listeners.findIndex(l => l.handler === handler);
                if (index > -1) listeners.splice(index, 1);
            }
        };
    }

    unsubscribeAll(subscriberId) {
        const listeners = this.eventListeners.get(subscriberId);
        if (listeners) {
            listeners.forEach(({ eventName, handler }) => {
                window.removeEventListener(eventName, handler);
            });
            this.eventListeners.delete(subscriberId);
            this._log(`Unsubscribed all for ${subscriberId}`);
        }
    }

    // ==================== 批量操作 ====================

    syncMusicList(musicList, type = 'both') {
        if (!Array.isArray(musicList)) return { download: 0, favorite: 0 };

        const downloadItems = [];
        const favoriteItems = [];

        musicList.forEach(music => {
            const musicId = music.id;
            const plugin = music.platform || music.plugin;

            if (!musicId) return;

            if (type === 'download' || type === 'both') {
                const status = this.getDownloadStatus(musicId, plugin);
                if (status !== 'pending') {
                    downloadItems.push({ musicId, plugin, status });
                }
            }

            if (type === 'favorite' || type === 'both') {
                const status = this.getFavoriteStatus(musicId, plugin);
                if (status) {
                    favoriteItems.push({ musicId, plugin, status });
                }
            }
        });

        if (downloadItems.length > 0) {
            this._broadcastBatchChange('download', downloadItems);
        }
        if (favoriteItems.length > 0) {
            this._broadcastBatchChange('favorite', favoriteItems);
        }

        return { download: downloadItems.length, favorite: favoriteItems.length };
    }

    // ==================== 统计与信息 ====================

    getStats() {
        return {
            downloadCount: this.downloadStatus.size,
            favoriteCount: this.favoriteStatus.size,
            totalCount: this.downloadStatus.size + this.favoriteStatus.size,
            storageMode: this.storageMode,
            initialized: this.initialized
        };
    }

    exportData() {
        return {
            downloadStatus: Object.fromEntries(this.downloadStatus),
            favoriteStatus: Object.fromEntries(this.favoriteStatus),
            timestamp: Date.now(),
            version: 1
        };
    }

    importData(data) {
        if (!data || typeof data !== 'object') {
            this._error('Invalid data for import');
            return false;
        }

        try {
            if (data.downloadStatus) {
                Object.entries(data.downloadStatus).forEach(([key, status]) => {
                    this.downloadStatus.set(key, status);
                });
            }
            if (data.favoriteStatus) {
                Object.entries(data.favoriteStatus).forEach(([key, status]) => {
                    this.favoriteStatus.set(key, status);
                });
            }
            this.saveToStorage();
            this._log('Data imported successfully');
            return true;
        } catch (error) {
            this._error('Failed to import data:', error);
            return false;
        }
    }

    // ==================== 清除/重置 ====================

    clearAll() {
        this.downloadStatus.clear();
        this.favoriteStatus.clear();
        this.saveToStorage();
        this._log('All states cleared');
    }

    clear(type = 'both') {
        if (type === 'download' || type === 'both') {
            this.downloadStatus.clear();
        }
        if (type === 'favorite' || type === 'both') {
            this.favoriteStatus.clear();
        }
        this.saveToStorage();
        this._log(`Cleared ${type} states`);
    }

    // ==================== 高级功能 ====================

    async migrateStorage(targetMode) {
        if (targetMode === this.storageMode) return;

        this._log(`Migrating storage from ${this.storageMode} to ${targetMode}`);
        
        const data = this.exportData();
        this.storageMode = targetMode;
        
        if (targetMode === 'indexedDB') {
            await this._initIndexedDB();
        }
        
        this.importData(data);
        this._log('Migration complete');
    }
}

// 创建单例
const stateManager = new StateManagerCore();

// 导出到全局
window.StateManager = stateManager;
