// ==================== 统一收藏状态管理器 ====================

/**
 * 收藏状态管理器
 * 统一管理所有页面的收藏状态同步
 */
const FavoriteManager = {
    // 订阅者映射：key -> Set<callback>
    // key 可以是：'player', 'detail', 'recent', 'download', 'recommend', 'toplist', 'favorites'
    subscribers: new Map(),

    // 初始化
    init() {
        // 订阅全局收藏变更事件
        if (typeof onFavoriteChange === 'function') {
            onFavoriteChange((event) => {
                this.handleFavoriteChange(event);
            });
        }
        console.log('[INFO] [] Initialized');
    },

    /**
     * 处理收藏状态变更
     */
    handleFavoriteChange(event) {
        const { musicId, platform, isFavorited, song } = event;
        console.log('[INFO] [] Favorite change:', { musicId, platform, isFavorited });

        // 标准化平台字段
        const normalizedPlatform = platform || '';

        // 同步到 StateManager（如果可用）
        if (window.StateManager) {
            StateManager.setFavoriteStatus(musicId, normalizedPlatform, isFavorited, true);
        }

        // 通知所有订阅者
        this.subscribers.forEach((callbacks, key) => {
            callbacks.forEach(callback => {
                try {
                    callback({ musicId, platform: normalizedPlatform, isFavorited, song });
                } catch (e) {
                    console.error(`[ERROR] [ERROR] [FavoriteManager] Error notifying ${key}:`, e);
                }
            });
        });
    },

    /**
     * 订阅收藏状态变化
     * @param {string} key - 订阅者标识（如 'player', 'detail', 'recent' 等）
     * @param {Function} callback - 回调函数
     */
    subscribe(key, callback) {
        if (!this.subscribers.has(key)) {
            this.subscribers.set(key, new Set());
        }
        this.subscribers.get(key).add(callback);
        console.log(`[INFO] [INFO] [FavoriteManager] ${key} subscribed`);
    },

    /**
     * 取消订阅
     * @param {string} key - 订阅者标识
     * @param {Function} callback - 回调函数
     */
    unsubscribe(key, callback) {
        if (this.subscribers.has(key)) {
            this.subscribers.get(key).delete(callback);
            if (this.subscribers.get(key).size === 0) {
                this.subscribers.delete(key);
            }
        }
    },

    /**
     * 获取歌曲的唯一标识 key
     * @param {Object} song - 歌曲对象
     * @returns {string} - 唯一标识
     */
    getSongKey(song) {
        if (!song || !song.id) return '';
        const platform = song.platform || song.plugin || '';
        return platform ? `${platform}:${song.id}` : song.id;
    },

    /**
     * 比较两首歌曲是否是同一首
     * @param {Object} song1 - 歌曲1
     * @param {Object} song2 - 歌曲2
     * @returns {boolean}
     */
    isSameSong(song1, song2) {
        if (!song1 || !song2) return false;
        if (song1.id !== song2.id) return false;
        const platform1 = song1.platform || song1.plugin || '';
        const platform2 = song2.platform || song2.plugin || '';
        return platform1 === platform2;
    },

    /**
     * 切换收藏状态（统一入口）
     * @param {Object} song - 歌曲对象
     * @returns {Promise<boolean>} - 新的收藏状态
     */
    async toggle(song) {
        if (!song || !song.id) {
            console.error('[ERROR] [] [] Invalid song:', song);
            return false;
        }

        const result = await toggleFavoriteSong(song);
        return result;
    },

    /**
     * 检查是否已收藏
     * @param {Object} song - 歌曲对象
     * @returns {Promise<boolean>}
     */
    async isFavorited(song) {
        if (!song || !song.id) return false;
        // 入库 plugin 优先（platform 可能是显示用平台名）
        return await isSongFavorited(song.id, song.plugin || song.platform);
    },

    /**
     * 同步检查是否已收藏（仅检查缓存）
     * @param {Object} song - 歌曲对象
     * @returns {boolean}
     */
    isFavoritedSync(song) {
        if (!song || !song.id) return false;
        // 入库 plugin 优先（platform 可能是显示用平台名）
        return isSongFavoritedSync(song.id, song.plugin || song.platform);
    },

    /**
     * 添加歌曲到收藏
     * @param {Object} song - 歌曲对象
     */
    async add(song) {
        if (!song || !song.id) {
            console.error('[FavoriteManager] Invalid song:', song);
            return false;
        }
        // 如果已收藏则跳过
        if (this.isFavoritedSync(song)) {
            return true;
        }
        // 调用全局的 toggleFavoriteSong 来添加收藏
        return await toggleFavoriteSong(song);
    },

    /**
     * 从收藏中移除歌曲
     * @param {Object} song - 歌曲对象
     */
    async remove(song) {
        if (!song || !song.id) {
            console.error('[FavoriteManager] Invalid song:', song);
            return false;
        }
        // 如果未收藏则跳过
        if (!this.isFavoritedSync(song)) {
            return true;
        }
        // 调用全局的 toggleFavoriteSong 来取消收藏
        return await toggleFavoriteSong(song);
    },

    // ==================== 各页面更新方法 ====================

    /**
     * 更新播放器收藏按钮
     */
    updatePlayerButton(isFavorited) {
        const btn = document.getElementById('player-like-btn');
        if (!btn) return;

        btn.classList.toggle('active', isFavorited);

        if (isFavorited) {
            btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
            btn.title = '取消收藏';
        } else {
            btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
            btn.title = '收藏';
        }
    },

    /**
     * 更新播放详情页收藏按钮
     */
    updateDetailButton(isFavorited) {
        const btn = document.getElementById('detail-like-btn');
        if (!btn) {
            console.log('[INFO] [] detail-like-btn not found');
            return;
        }

        console.log('[INFO] [] Updating detail button:', isFavorited, 'Current classes:', btn.classList.toString());

        if (isFavorited) {
            btn.classList.add('active');
            btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
            btn.title = '取消收藏';
        } else {
            btn.classList.remove('active');
            btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
            btn.title = '收藏';
        }

        console.log('[INFO] [] After update classes:', btn.classList.toString());
    },

    /**
     * 更新歌曲列表中的收藏按钮（通用）
     * @param {string} musicId - 歌曲ID
     * @param {string} platform - 平台
     * @param {boolean} isFavorited - 是否已收藏
     */
    updateListFavoriteButton(musicId, platform, isFavorited) {
        const normalizedPlatform = platform || '';

        // 更新所有页面中的收藏按钮
        document.querySelectorAll('.fav-btn[data-music-id]').forEach(btn => {
            const btnId = btn.dataset.musicId;
            const btnPlatform = btn.dataset.platform || '';

            if (btnId === musicId && btnPlatform === normalizedPlatform) {
                this.updateButtonVisual(btn, isFavorited);
            }
        });
    },

    /**
     * 更新按钮视觉效果
     */
    updateButtonVisual(btn, isFavorited) {
        if (isFavorited) {
            btn.classList.add('favorited', 'active');
            btn.style.color = '#ff4757';
            btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
            btn.title = '取消收藏';
        } else {
            btn.classList.remove('favorited', 'active');
            btn.style.color = '';
            btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
            btn.title = '收藏';
        }
    }
};

// 初始化
FavoriteManager.init();

// 导出到全局
window.FavoriteManager = FavoriteManager;
