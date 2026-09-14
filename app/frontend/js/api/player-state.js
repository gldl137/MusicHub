/**
 * 播放器状态 API 模块
 * 与后端同步播放器状态 - 用户隔离版本
 */

const PlayerStateAPI = {
    /**
     * 获取播放器状态（用户隔离）
     * @returns {Promise<Object>} 播放器状态
     */
    async getState() {
        try {
            const response = await Auth.authenticatedFetch(`${window.API_BASE || ''}/api/my/player-state`);
            const result = await response.json();
            if (result.success) {
                return result.data;
            }
            throw new Error(result.error || '获取播放器状态失败');
        } catch (err) {
            console.error('[PlayerStateAPI] 获取播放器状态失败:', err);
            throw err;
        }
    },

    /**
     * 保存播放器状态（用户隔离）
     * @param {Object} state - 播放器状态
     * @returns {Promise<Object|null>} - 成功返回数据，失败返回null（静默处理）
     */
    async saveState(state) {
        // 检查网络是否在线
        if (!navigator.onLine) {
            return null;
        }

        // 检查是否已登录
        if (typeof Auth === 'undefined' || !Auth.isLoggedIn || !Auth.isLoggedIn()) {
            return null;
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时

            const response = await Auth.authenticatedFetch(`${window.API_BASE || ''}/api/my/player-state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(state),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            const result = await response.json();
            if (result.success) {
                return result.data;
            }
            throw new Error(result.error || '保存播放器状态失败');
        } catch (err) {
            // 忽略特定错误类型，不打印错误日志
            if (err.name === 'AbortError') {
                // 请求超时，静默处理
                return null;
            }
            if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
                // 网络错误或服务器不可用，静默处理
                return null;
            }
            // 其他错误才打印日志
            console.error('[PlayerStateAPI] 保存播放器状态失败:', err);
            throw err;
        }
    }
};

// 导出到全局作用域
window.PlayerStateAPI = PlayerStateAPI;
