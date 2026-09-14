/**
 * 用户认证模块
 * 管理用户登录状态、Token 和权限
 */

const Auth = {
    // Token 存储键名
    TOKEN_KEY: 'musichub_token',
    USER_KEY: 'musichub_user',
    PERMISSIONS_KEY: 'musichub_permissions',

    /**
     * 获取 API 基础 URL
     */
    getBaseURL() {
        return window.API_BASE || '';
    },

    /**
     * 获取当前 Token
     */
    getToken() {
        return localStorage.getItem(this.TOKEN_KEY);
    },

    /**
     * 获取当前用户信息
     */
    getUser() {
        const userStr = localStorage.getItem(this.USER_KEY);
        return userStr ? JSON.parse(userStr) : null;
    },

    /**
     * 获取用户权限
     */
    getPermissions() {
        const permStr = localStorage.getItem(this.PERMISSIONS_KEY);
        return permStr ? JSON.parse(permStr) : null;
    },

    /**
     * 是否已登录
     */
    isLoggedIn() {
        return !!this.getToken();
    },

    /**
     * 是否是管理员
     */
    isAdmin() {
        const user = this.getUser();
        return user && user.role === 'admin';
    },

    /**
     * 检查是否有某个权限
     */
    hasPermission(permission) {
        const permissions = this.getPermissions();
        if (!permissions) return false;
        // 管理员拥有所有权限
        if (this.isAdmin()) return true;
        return permissions[permission] === 1 || permissions[permission] === true;
    },

    /**
     * 登录
     */
    async login(username, password) {
        try {
            const response = await fetch(`${this.getBaseURL()}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const result = await response.json();

            if (result.success) {
                // 保存登录信息
                localStorage.setItem(this.TOKEN_KEY, result.data.token);
                localStorage.setItem(this.USER_KEY, JSON.stringify(result.data.user));
                localStorage.setItem(this.PERMISSIONS_KEY, JSON.stringify(result.data.permissions));

                // 触发登录成功事件
                window.dispatchEvent(new CustomEvent('auth:login', {
                    detail: result.data
                }));

                return { success: true, data: result.data };
            } else {
                return { success: false, error: result.error };
            }
        } catch (err) {
            return { success: false, error: err.message };
        }
    },

    /**
     * 登出
     */
    logout() {
        localStorage.removeItem(this.TOKEN_KEY);
        localStorage.removeItem(this.USER_KEY);
        localStorage.removeItem(this.PERMISSIONS_KEY);

        // 尽力通知后端清除 HttpOnly 会话 Cookie（媒体/代理请求鉴权用），失败不影响本地登出
        try {
            fetch(`${this.getBaseURL()}/api/auth/logout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }).catch(() => {});
        } catch { /* ignore */ }

        // 触发登出事件
        window.dispatchEvent(new CustomEvent('auth:logout'));
    },

    /**
     * 获取当前用户信息（从服务器刷新）
     */
    async refreshUserInfo() {
        try {
            const response = await this.authenticatedFetch(`${this.getBaseURL()}/api/auth/me`);
            const result = await response.json();

            if (result.success) {
                localStorage.setItem(this.USER_KEY, JSON.stringify(result.data.user));
                localStorage.setItem(this.PERMISSIONS_KEY, JSON.stringify(result.data.permissions));
                return { success: true, data: result.data };
            } else {
                // 如果刷新失败，可能是 Token 过期
                if (result.error === '登录已过期' || result.error === '未登录') {
                    this.logout();
                }
                return { success: false, error: result.error };
            }
        } catch (err) {
            return { success: false, error: err.message };
        }
    },

    /**
     * 修改密码（无需原密码）
     */
    async changePassword(newPassword) {
        try {
            const response = await this.authenticatedFetch(`${this.getBaseURL()}/api/auth/change-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ newPassword })
            });
            return await response.json();
        } catch (err) {
            return { success: false, error: err.message };
        }
    },

    /**
     * 带认证的 fetch 请求
     */
    async authenticatedFetch(url, options = {}) {
        const token = this.getToken();
        if (!token) {
            throw new Error('未登录');
        }

        // 如果 URL 是相对路径，添加 API_BASE
        const fullUrl = url.startsWith('http') ? url : `${this.getBaseURL()}${url}`;
        const method = options.method || 'GET';

        options.headers = {
            ...options.headers,
            'Authorization': `Bearer ${token}`
        };

        // 提取 endpoint（去掉 baseURL 前缀）用于日志展示
        const base = this.getBaseURL();
        const endpoint = url.startsWith('http')
            ? url
            : (url.startsWith(base) ? url.slice(base.length) : url);

        const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        try {
            const response = await fetch(fullUrl, options);
            const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
            // 记录客户端 → 后端请求的重要节点
            if (typeof API !== 'undefined' && typeof API.logClientRequest === 'function') {
                API.logClientRequest(method, endpoint, { status: response.status, ms, ok: response.ok, error: null });
            }
            return response;
        } catch (error) {
            const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
            if (typeof API !== 'undefined' && typeof API.logClientRequest === 'function') {
                API.logClientRequest(method, endpoint, { status: 0, ms, ok: false, error: error && error.message });
            }
            throw error;
        }
    },

    /**
     * 用户管理 API（需要管理员权限）
     */
    users: {
        /**
         * 获取所有用户
         */
        async getAll() {
            const response = await Auth.authenticatedFetch('/api/users');
            return response.json();
        },

        /**
         * 创建用户
         */
        async create(userData) {
            const response = await Auth.authenticatedFetch('/api/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(userData)
            });
            return response.json();
        },

        /**
         * 更新用户
         */
        async update(userId, updates) {
            const response = await Auth.authenticatedFetch(`/api/users/${userId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });
            return response.json();
        },

        /**
         * 删除用户
         */
        async delete(userId) {
            const response = await Auth.authenticatedFetch(`/api/users/${userId}`, {
                method: 'DELETE'
            });
            return response.json();
        },

        /**
         * 修改用户密码
         */
        async changePassword(userId, password) {
            const response = await Auth.authenticatedFetch(`/api/users/${userId}/change-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            return response.json();
        },

        /**
         * 获取用户权限
         */
        async getPermissions(userId) {
            const response = await Auth.authenticatedFetch(`/api/users/${userId}/permissions`);
            return response.json();
        },

        /**
         * 更新用户权限
         */
        async updatePermissions(userId, permissions) {
            const response = await Auth.authenticatedFetch(`/api/users/${userId}/permissions`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(permissions)
            });
            return response.json();
        }
    },

    /**
     * 用户歌单 API
     */
    playlists: {
        /**
         * 获取当前用户的歌单列表
         */
        async getAll() {
            const response = await Auth.authenticatedFetch(`${Auth.getBaseURL()}/api/my/playlists`);
            return response.json();
        },

        /**
         * 创建歌单
         */
        async create(name, description = '', cover = '') {
            const response = await Auth.authenticatedFetch(`${Auth.getBaseURL()}/api/my/playlists`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, description, cover })
            });
            return response.json();
        },

        /**
         * 获取歌单详情
         */
        async get(playlistId) {
            const response = await Auth.authenticatedFetch(`${Auth.getBaseURL()}/api/my/playlists/${playlistId}`);
            return response.json();
        },

        /**
         * 更新歌单
         */
        async update(playlistId, updates) {
            const response = await Auth.authenticatedFetch(`${Auth.getBaseURL()}/api/my/playlists/${playlistId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });
            return response.json();
        },

        /**
         * 删除歌单
         */
        async delete(playlistId) {
            const response = await Auth.authenticatedFetch(`${Auth.getBaseURL()}/api/my/playlists/${playlistId}`, {
                method: 'DELETE'
            });
            return response.json();
        },

        /**
         * 获取歌单歌曲（数据由后台“网络歌单定时刷新”保持最新）
         */
        async getSongs(playlistId) {
            const url = `${Auth.getBaseURL()}/api/my/playlists/${playlistId}/songs`;
            const response = await Auth.authenticatedFetch(url);
            return response.json();
        },

        /**
         * 补全歌单歌曲元数据（老快照数据缺插件专有字段，播放会被第三方解析 API 兜底歌顶替）
         */
        async refreshSongs(playlistId) {
            const response = await Auth.authenticatedFetch(`${Auth.getBaseURL()}/api/my/playlists/${playlistId}/refresh-songs`, {
                method: 'POST'
            });
            return response.json();
        },

        /**
         * 批量获取动态榜单歌单实时状态（更新中/正常/失败 + 实时封面 + 歌曲数）
         */
        async toplistStatus(ids) {
            const response = await Auth.authenticatedFetch(`${Auth.getBaseURL()}/api/my/playlists/toplist-status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids })
            });
            return response.json();
        },

        /**
         * 添加歌曲到歌单
         */
        async addSong(playlistId, music, plugin) {
            const response = await Auth.authenticatedFetch(`${Auth.getBaseURL()}/api/my/playlists/${playlistId}/songs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ music, plugin })
            });
            return response.json();
        },

        /**
         * 从歌单移除歌曲
         */
        async removeSong(playlistId, musicId, plugin) {
            const response = await Auth.authenticatedFetch(`${Auth.getBaseURL()}/api/my/playlists/${playlistId}/songs?musicId=${encodeURIComponent(musicId)}&plugin=${encodeURIComponent(plugin)}`, {
                method: 'DELETE'
            });
            return response.json();
        }
    }
};

// 全局暴露
window.Auth = Auth;
