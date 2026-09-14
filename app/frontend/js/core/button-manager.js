/**
 * 按钮管理模块 (ButtonManager)
 * 统一处理下载和收藏按钮的 UI 更新
 * 配合 StateManager 使用，确保所有页面按钮状态同步
 * 
 * 性能优化特性：
 * - 批量更新队列，使用 requestAnimationFrame 合并 DOM 操作
 * - 防抖处理，避免频繁更新
 * - 动画过渡效果
 * - 增强的错误处理和调试日志
 */

const ButtonManager = {
    // ==================== 配置 ====================

    // 图标配置
    icons: {
        download: {
            normal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
            downloading: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>',
            downloaded: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>'
        },
        favorite: {
            normal: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
            favorited: '<svg width="20" height="20" viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
        }
    },

    // 大图标配置（播放器用）
    largeIcons: {
        download: {
            normal: '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
            downloading: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>',
            downloaded: '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>'
        },
        favorite: {
            normal: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
            favorited: '<svg width="24" height="24" viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
        }
    },

    // 动画配置
    animationConfig: {
        enable: true,
        duration: 200,
        easing: 'ease-in-out'
    },

    // 性能配置
    performanceConfig: {
        batchUpdate: true,
        batchDelay: 16, // ~60fps
        maxBatchSize: 100
    },

    // ==================== 状态 ====================

    initialized: false,

    // 批量更新队列
    updateQueue: {
        download: new Map(), // key: musicId_plugin, value: status
        favorite: new Map()  // key: musicId_plugin, value: isFavorited
    },

    // 是否正在处理队列
    isProcessingQueue: false,

    // RAF id
    rafId: null,

    // 调试模式
    debug: false,

    // ==================== 初始化 ====================

    /**
     * 初始化按钮管理器
     * 订阅 StateManager 的事件
     */
    init() {
        if (this.initialized) return;

        this._log('Initializing ButtonManager');

        // 订阅下载状态变化
        if (window.StateManager) {
            StateManager.subscribe('download', (detail) => {
                this._queueUpdate('download', detail.musicId, detail.plugin, detail.status);
            }, 'ButtonManager');

            StateManager.subscribe('favorite', (detail) => {
                this._queueUpdate('favorite', detail.musicId, detail.plugin, detail.status);
            }, 'ButtonManager');
        }

        // 监听批量变化事件
        window.addEventListener('download:batchChanged', (event) => {
            const { items } = event.detail;
            items.forEach(({ musicId, plugin, status }) => {
                this._queueUpdate('download', musicId, plugin, status);
            });
        });

        window.addEventListener('favorite:batchChanged', (event) => {
            const { items } = event.detail;
            items.forEach(({ musicId, plugin, status }) => {
                this._queueUpdate('favorite', musicId, plugin, status);
            });
        });

        // 添加 CSS 动画样式
        this._injectAnimationStyles();

        this.initialized = true;
        this._log('ButtonManager initialized');
    },

    /**
     * 注入动画样式
     */
    _injectAnimationStyles() {
        if (document.getElementById('button-manager-styles')) return;

        const style = document.createElement('style');
        style.id = 'button-manager-styles';
        style.textContent = `
            /* 按钮状态变化动画 */
            .download-btn, .fav-btn, .favorite-btn {
                transition: transform ${this.animationConfig.duration}ms ${this.animationConfig.easing},
                            color ${this.animationConfig.duration}ms ${this.animationConfig.easing},
                            background-color ${this.animationConfig.duration}ms ${this.animationConfig.easing},
                            box-shadow ${this.animationConfig.duration}ms ${this.animationConfig.easing};
            }

            .download-btn:active, .fav-btn:active, .favorite-btn:active {
                transform: scale(0.95);
            }

            /* 收藏按钮心形动画 */
            .fav-btn.favorited, .favorite-btn.favorited {
                animation: fav-pulse ${this.animationConfig.duration}ms ${this.animationConfig.easing};
            }

            @keyframes fav-pulse {
                0% { transform: scale(1); }
                50% { transform: scale(1.2); }
                100% { transform: scale(1); }
            }

            /* 下载完成动画 */
            .download-btn.downloaded {
                animation: download-complete ${this.animationConfig.duration * 1.5}ms ${this.animationConfig.easing};
            }

            @keyframes download-complete {
                0% { transform: scale(1); }
                25% { transform: scale(1.1); }
                50% { transform: scale(0.95); }
                100% { transform: scale(1); }
            }

            /* 状态指示器 */
            .btn-status-indicator {
                position: absolute;
                top: -2px;
                right: -2px;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #4CAF50;
                border: 2px solid white;
                opacity: 0;
                transition: opacity ${this.animationConfig.duration}ms ease;
            }

            .download-btn.downloaded .btn-status-indicator,
            .fav-btn.favorited .btn-status-indicator {
                opacity: 1;
            }
        `;
        document.head.appendChild(style);
    },

    // ==================== 日志 ====================

    /**
     * 日志输出
     */
    _log(...args) {
        if (this.debug) {
            console.log('[ButtonManager]', ...args);
        }
    },

    /**
     * 错误日志
     */
    _error(...args) {
        console.error('[ButtonManager]', ...args);
    },

    /**
     * 设置调试模式
     */
    setDebug(enabled) {
        this.debug = enabled;
    },

    // ==================== 批量更新队列 ====================

    /**
     * 将更新加入队列
     */
    _queueUpdate(type, musicId, plugin, status) {
        if (!this.performanceConfig.batchUpdate) {
            // 如果禁用批量更新，直接执行
            if (type === 'download') {
                this._updateDownloadButtonImmediate(musicId, plugin, status);
            } else {
                this._updateFavoriteButtonImmediate(musicId, plugin, status);
            }
            return;
        }

        const key = `${musicId}_${plugin || ''}`;
        this.updateQueue[type].set(key, { musicId, plugin, status });

        // 如果队列大小超过阈值，立即处理
        if (this.updateQueue[type].size >= this.performanceConfig.maxBatchSize) {
            this._processQueue();
            return;
        }

        // 使用 RAF 延迟处理
        if (!this.isProcessingQueue) {
            this._scheduleQueueProcessing();
        }
    },

    /**
     * 安排队列处理
     */
    _scheduleQueueProcessing() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
        }

        this.rafId = requestAnimationFrame(() => {
            this._processQueue();
        });
    },

    /**
     * 处理更新队列
     */
    _processQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        try {
            // 处理下载更新
            const downloadUpdates = Array.from(this.updateQueue.download.entries());
            this.updateQueue.download.clear();

            // 处理收藏更新
            const favoriteUpdates = Array.from(this.updateQueue.favorite.entries());
            this.updateQueue.favorite.clear();

            this._log(`Processing queue: ${downloadUpdates.length} download, ${favoriteUpdates.length} favorite`);

            // 批量执行 DOM 更新
            this._batchUpdateDOM(downloadUpdates, favoriteUpdates);

        } catch (error) {
            this._error('Error processing update queue:', error);
        } finally {
            this.isProcessingQueue = false;
            this.rafId = null;
        }
    },

    /**
     * 批量更新 DOM
     */
    _batchUpdateDOM(downloadUpdates, favoriteUpdates) {
        // 使用 DocumentFragment 优化性能（如果需要创建新元素）
        // 这里我们主要是更新现有元素

        // 批量更新下载按钮
        downloadUpdates.forEach(([key, { musicId, plugin, status }]) => {
            try {
                this._updateDownloadButtonImmediate(musicId, plugin, status);
            } catch (error) {
                this._error(`Failed to update download button for ${key}:`, error);
            }
        });

        // 批量更新收藏按钮
        favoriteUpdates.forEach(([key, { musicId, plugin, status }]) => {
            try {
                this._updateFavoriteButtonImmediate(musicId, plugin, status);
            } catch (error) {
                this._error(`Failed to update favorite button for ${key}:`, error);
            }
        });
    },

    // ==================== 下载按钮更新 ====================

    /**
     * 公开 API：更新下载按钮状态
     */
    updateDownloadButton(musicId, plugin, status) {
        this._queueUpdate('download', musicId, plugin, status);
    },

    /**
     * 立即更新下载按钮（内部使用）
     */
    _updateDownloadButtonImmediate(musicId, plugin, status) {
        if (!musicId) return;

        const normalizedPlugin = plugin || '';

        // 查找所有匹配的按钮
        const selectors = this._buildSelectors('download', musicId, normalizedPlugin);
        const buttons = document.querySelectorAll(selectors);

        buttons.forEach(btn => {
            try {
                this._updateDownloadButtonVisual(btn, status);
            } catch (error) {
                this._error('Failed to update download button visual:', error);
            }
        });

        // 更新播放器/详情页特定按钮
        this._updatePlayerDownloadButton(musicId, normalizedPlugin, status);
        this._updateDetailDownloadButton(musicId, normalizedPlugin, status);
    },

    /**
     * 构建选择器
     */
    _buildSelectors(type, musicId, plugin) {
        if (type === 'download') {
            return [
                `.download-btn[data-music-id="${musicId}"][data-platform="${plugin}"]`,
                `.download-btn[data-music-id="${musicId}"][data-plugin="${plugin}"]`,
                `.download-btn[data-music-id="${musicId}"]:not([data-platform]):not([data-plugin])`
            ].join(', ');
        } else {
            return [
                `.fav-btn[data-music-id="${musicId}"][data-platform="${plugin}"]`,
                `.fav-btn[data-music-id="${musicId}"][data-plugin="${plugin}"]`,
                `.favorite-btn[data-music-id="${musicId}"][data-platform="${plugin}"]`,
                `.favorite-btn[data-music-id="${musicId}"][data-plugin="${plugin}"]`,
                `.fav-btn[data-music-id="${musicId}"]:not([data-platform]):not([data-plugin])`,
                `.favorite-btn[data-music-id="${musicId}"]:not([data-platform]):not([data-plugin])`
            ].join(', ');
        }
    },

    /**
     * 更新下载按钮视觉效果
     */
    _updateDownloadButtonVisual(btn, status) {
        // 检查状态是否真的变化了
        const currentStatus = btn.classList.contains('downloaded') ? 'downloaded' :
                             btn.classList.contains('downloading') ? 'downloading' : 'normal';

        if (currentStatus === status) return;

        // 移除所有状态类
        btn.classList.remove('downloading', 'downloaded');

        // 判断按钮类型
        const isLargeBtn = btn.id === 'player-download-btn' ||
                          btn.id === 'detail-download-btn' ||
                          btn.classList.contains('btn-large');

        const icons = isLargeBtn ? this.largeIcons.download : this.icons.download;

        switch (status) {
            case 'downloading':
                btn.classList.add('downloading');
                btn.innerHTML = icons.downloading;
                btn.title = '下载中...';
                break;
            case 'downloaded':
                btn.classList.add('downloaded');
                btn.innerHTML = icons.downloaded;
                btn.title = '已下载';
                break;
            default:
                btn.innerHTML = icons.normal;
                btn.title = '下载';
        }
    },

    /**
     * 更新播放器下载按钮
     */
    _updatePlayerDownloadButton(musicId, plugin, status) {
        const btn = document.getElementById('player-download-btn');
        if (!btn) return;

        const currentMusicId = btn.dataset.musicId;
        const currentPlugin = btn.dataset.platform || btn.dataset.plugin || '';

        // 使用宽松相等，处理字符串和数字类型不匹配的问题
        if (currentMusicId == musicId && currentPlugin === plugin) {
            this._updateDownloadButtonVisual(btn, status);
        }
    },

    /**
     * 更新详情页下载按钮
     */
    _updateDetailDownloadButton(musicId, plugin, status) {
        const btn = document.getElementById('detail-download-btn');
        if (!btn) return;

        const currentMusicId = btn.dataset.musicId;
        const currentPlugin = btn.dataset.platform || btn.dataset.plugin || '';

        // 使用宽松相等，处理字符串和数字类型不匹配的问题
        if (currentMusicId == musicId && currentPlugin === plugin) {
            this._updateDownloadButtonVisual(btn, status);
        }
    },

    // ==================== 收藏按钮更新 ====================

    /**
     * 公开 API：更新收藏按钮状态
     */
    updateFavoriteButton(musicId, plugin, isFavorited) {
        this._queueUpdate('favorite', musicId, plugin, isFavorited);
    },

    /**
     * 立即更新收藏按钮（内部使用）
     */
    _updateFavoriteButtonImmediate(musicId, plugin, isFavorited) {
        if (!musicId) return;

        const normalizedPlugin = plugin || '';
        const selectors = this._buildSelectors('favorite', musicId, normalizedPlugin);
        const buttons = document.querySelectorAll(selectors);

        buttons.forEach(btn => {
            try {
                this._updateFavoriteButtonVisual(btn, isFavorited);
            } catch (error) {
                this._error('Failed to update favorite button visual:', error);
            }
        });

        this._updatePlayerFavoriteButton(musicId, normalizedPlugin, isFavorited);
        this._updateDetailFavoriteButton(musicId, normalizedPlugin, isFavorited);
    },

    /**
     * 更新收藏按钮视觉效果
     */
    _updateFavoriteButtonVisual(btn, isFavorited) {
        // 检查状态是否真的变化了
        const currentFavorited = btn.classList.contains('favorited') || btn.classList.contains('active');
        if (currentFavorited === isFavorited) return;

        const isLargeBtn = btn.id === 'player-like-btn' ||
                          btn.id === 'detail-like-btn' ||
                          btn.classList.contains('btn-large');

        const icons = isLargeBtn ? this.largeIcons.favorite : this.icons.favorite;

        if (isFavorited) {
            btn.classList.add('favorited', 'active');
            btn.style.color = '#ff4757';
            btn.innerHTML = icons.favorited;
            btn.title = '取消收藏';
        } else {
            btn.classList.remove('favorited', 'active');
            btn.style.color = '';
            btn.innerHTML = icons.normal;
            btn.title = '收藏';
        }
    },

    /**
     * 更新播放器收藏按钮
     */
    _updatePlayerFavoriteButton(musicId, plugin, isFavorited) {
        const btn = document.getElementById('player-like-btn');
        if (!btn) return;

        const currentMusicId = btn.dataset.musicId;
        const currentPlugin = btn.dataset.platform || btn.dataset.plugin || '';

        // 使用宽松相等，处理字符串和数字类型不匹配的问题
        if (currentMusicId == musicId && currentPlugin === plugin) {
            this._updateFavoriteButtonVisual(btn, isFavorited);
        }
    },

    /**
     * 更新详情页收藏按钮
     */
    _updateDetailFavoriteButton(musicId, plugin, isFavorited) {
        const btn = document.getElementById('detail-like-btn');
        if (!btn) return;

        const currentMusicId = btn.dataset.musicId;
        const currentPlugin = btn.dataset.platform || btn.dataset.plugin || '';

        // 使用宽松相等，处理字符串和数字类型不匹配的问题
        if (currentMusicId == musicId && currentPlugin === plugin) {
            this._updateFavoriteButtonVisual(btn, isFavorited);
        }
    },

    // ==================== 批量更新 API ====================

    /**
     * 批量更新歌曲列表的按钮状态
     * @param {Array} musicList - 歌曲列表
     * @param {string} type - 'download' | 'favorite' | 'both'
     */
    async updateMusicListButtons(musicList, type = 'both') {
        if (!Array.isArray(musicList) || !window.StateManager) return;

        this._log(`Queueing batch update for ${musicList.length} songs, type: ${type}`);

        // 收集所有需要更新的项
        const updates = [];

        // 收藏状态同步（同步获取）
        if (type === 'favorite' || type === 'both') {
            musicList.forEach(music => {
                const musicId = music.id;
                const plugin = music.plugin || music.platform;
                if (!musicId) return;
                const isFavorited = StateManager.getFavoriteStatus(musicId, plugin);
                if (isFavorited) {
                    updates.push({ type: 'favorite', musicId, plugin, status: isFavorited });
                }
            });
        }

        // 下载状态不再同步获取，改为点击时实时查询
        // 因为 getDownloadStatus 现在是异步的
        if (type === 'download' || type === 'both') {
            this._log('Download status will be checked on click, not synced');
        }

        // 批量加入队列
        updates.forEach(({ type, musicId, plugin, status }) => {
            this._queueUpdate(type, musicId, plugin, status);
        });

        this._log(`Queued ${updates.length} button updates`);
    },

    /**
     * 同步所有按钮（用于页面切换或初始化）
     * @param {HTMLElement} container - 容器元素 (可选)
     */
    syncAllButtons(container = document) {
        if (!window.StateManager) return;

        this._log('Syncing all buttons');

        const updates = [];

        // 下载状态不再同步获取，改为点击时实时查询
        // 因为 getDownloadStatus 现在是异步的
        this._log('Download status will be checked on click, not synced');

        // 收集所有收藏按钮的状态
        container.querySelectorAll('.fav-btn[data-music-id], .favorite-btn[data-music-id]').forEach(btn => {
            const musicId = btn.dataset.musicId;
            const plugin = btn.dataset.platform || btn.dataset.plugin;
            const isFavorited = StateManager.getFavoriteStatus(musicId, plugin);
            if (isFavorited) {
                updates.push({ type: 'favorite', musicId, plugin, status: isFavorited });
            }
        });

        // 批量加入队列
        updates.forEach(({ type, musicId, plugin, status }) => {
            this._queueUpdate(type, musicId, plugin, status);
        });

        this._log(`Queued ${updates.length} buttons for sync`);
    },

    // ==================== 页面特定更新 ====================

    /**
     * 更新播放器按钮（根据当前播放歌曲）
     */
    async updatePlayerButtons() {
        if (!window.currentMusic || !window.StateManager) return;

        const music = window.currentMusic;
        const musicId = music.id;
        // 统一使用 plugin 字段（插件文件名）
        const plugin = music.plugin || music.platform;

        this._log('Updating player buttons for:', musicId, plugin);

        // 更新下载按钮（异步查询）
        try {
            const downloadStatus = await StateManager.getDownloadStatus(musicId, plugin);
            this._queueUpdate('download', musicId, plugin, downloadStatus);
        } catch (e) {
            console.error('获取下载状态失败:', e);
        }

        // 更新收藏按钮
        const isFavorited = StateManager.getFavoriteStatus(musicId, plugin);
        this._queueUpdate('favorite', musicId, plugin, isFavorited);
    },

    /**
     * 更新详情页按钮
     * @param {Object} music - 歌曲对象
     */
    async updateDetailButtons(music) {
        if (!music || !window.StateManager) return;

        const musicId = music.id;
        // 统一使用 plugin 字段（插件文件名）
        const plugin = music.plugin || music.platform;

        this._log('Updating detail buttons for:', musicId, plugin);

        // 更新下载按钮（异步查询）
        try {
            const downloadStatus = await StateManager.getDownloadStatus(musicId, plugin);
            this._queueUpdate('download', musicId, plugin, downloadStatus);
        } catch (e) {
            console.error('获取下载状态失败:', e);
        }

        // 更新收藏按钮
        const isFavorited = StateManager.getFavoriteStatus(musicId, plugin);
        this._queueUpdate('favorite', musicId, plugin, isFavorited);
    },

    // ==================== 配置 API ====================

    /**
     * 设置动画配置
     */
    setAnimationConfig(config) {
        this.animationConfig = { ...this.animationConfig, ...config };
        this._injectAnimationStyles(); // 重新注入样式
    },

    /**
     * 设置性能配置
     */
    setPerformanceConfig(config) {
        this.performanceConfig = { ...this.performanceConfig, ...config };
    },

    /**
     * 强制立即处理所有队列
     */
    flush() {
        this._processQueue();
    }
};

// 自动初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ButtonManager.init());
} else {
    ButtonManager.init();
}

// 导出到全局
window.ButtonManager = ButtonManager;
