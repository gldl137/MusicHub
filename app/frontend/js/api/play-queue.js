/**
 * 播放队列 API 模块
 * 与后端同步播放列表数据 - 用户隔离版本
 */

const PlayQueueAPI = {
    /**
     * 获取播放队列（用户隔离）
     * @returns {Promise<Array>} 歌曲列表
     */
    async getQueue() {
        try {
            const response = await Auth.authenticatedFetch(`${window.API_BASE || ''}/api/my/play-queue`);
            const result = await response.json();
            if (result.success) {
                return result.data;
            }
            throw new Error(result.error || '获取播放队列失败');
        } catch (err) {
            console.error('[PlayQueueAPI] 获取播放队列失败:', err);
            throw err;
        }
    },

    /**
     * 添加歌曲到播放队列（用户隔离）
     * @param {Object} music - 歌曲对象
     * @param {string} plugin - 插件名称
     * @returns {Promise<Object>}
     */
    async add(music, plugin) {
        try {
            const response = await Auth.authenticatedFetch(`${window.API_BASE || ''}/api/my/play-queue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ music, plugin })
            });
            const result = await response.json();
            if (result.success) {
                return result.data;
            }
            throw new Error(result.error || '添加到播放队列失败');
        } catch (err) {
            console.error('[PlayQueueAPI] 添加到播放队列失败:', err);
            throw err;
        }
    },

    /**
     * 保存整个播放队列（替换，用户隔离）
     * @param {Array} songs - 歌曲列表
     * @returns {Promise<Object>}
     */
    async saveQueue(songs) {
        try {
            const response = await Auth.authenticatedFetch(`${window.API_BASE || ''}/api/my/play-queue`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ songs })
            });
            const result = await response.json();
            if (result.success) {
                return result.data;
            }
            throw new Error(result.error || '保存播放队列失败');
        } catch (err) {
            console.error('[PlayQueueAPI] 保存播放队列失败:', err);
            throw err;
        }
    },

    /**
     * 从播放队列中移除歌曲（用户隔离）
     * @param {string} musicId - 歌曲ID
     * @param {string} plugin - 插件名称
     * @returns {Promise<Object>}
     */
    async remove(musicId, plugin) {
        try {
            const response = await Auth.authenticatedFetch(
                `${window.API_BASE || ''}/api/my/play-queue?musicId=${encodeURIComponent(musicId)}&plugin=${encodeURIComponent(plugin)}`,
                { method: 'DELETE' }
            );
            const result = await response.json();
            if (result.success) {
                return result.data;
            }
            throw new Error(result.error || '从播放队列移除失败');
        } catch (err) {
            console.error('[PlayQueueAPI] 从播放队列移除失败:', err);
            throw err;
        }
    },

    /**
     * 清空播放队列（用户隔离）
     * @returns {Promise<Object>}
     */
    async clear() {
        try {
            const response = await Auth.authenticatedFetch(`${window.API_BASE || ''}/api/my/play-queue/all`, {
                method: 'DELETE'
            });
            const result = await response.json();
            if (result.success) {
                return result.data;
            }
            throw new Error(result.error || '清空播放队列失败');
        } catch (err) {
            console.error('[PlayQueueAPI] 清空播放队列失败:', err);
            throw err;
        }
    }
};

// 导出到全局
window.PlayQueueAPI = PlayQueueAPI;
