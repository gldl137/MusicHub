/**
 * API 请求封装模块
 * 统一处理所有后端 API 调用
 */

const API = {
    baseURL: window.API_BASE,

    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        const method = options.method || 'GET';

        // 准备请求头，自动添加认证信息（如果用户已登录）
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers
        };

        // 如果存在 Auth 模块且用户已登录，添加 Authorization header
        if (typeof Auth !== 'undefined' && Auth.getToken) {
            const token = Auth.getToken();
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
        }

        const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        try {
            const response = await fetch(url, {
                headers,
                ...options
            });
            const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);

            let data = null;
            let parseOk = true;
            try {
                data = await response.json();
            } catch {
                parseOk = false;
            }

            const businessFail = !!(data && typeof data === 'object' && data.success === false);
            const ok = response.ok && parseOk && !businessFail;

            // 防御性检查：确保返回的数据是对象
            if (!parseOk || !data || typeof data !== 'object') {
                throw new Error(`Invalid response format: expected object, got ${typeof data}`);
            }
            // 业务失败也记录到 console（关键请求节点），便于排查
            if (businessFail && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
                console.warn(`[API] ${method} ${endpoint} failed: ${data.error || data.message || 'unknown'}`, { endpoint });
            }
            return data;
        } catch (error) {
            const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
            console.warn(`[API] request error: ${endpoint}`, { endpoint, message: error && error.message });
            throw error;
        }
    },

    get(endpoint) {
        return this.request(endpoint, { method: 'GET' });
    },

    post(endpoint, data) {
        return this.request(endpoint, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    },

    put(endpoint, data) {
        return this.request(endpoint, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    },

    delete(endpoint) {
        return this.request(endpoint, { method: 'DELETE' });
    }
};

// 音乐相关 API
API.music = {
    search(query, type = 'music', plugin, page = 1) {
        let url = `/api/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}&page=${page}`;
        if (plugin) url += `&plugin=${encodeURIComponent(plugin)}`;
        return API.get(url);
    },

    /**
     * 获取播放 URL（播放模式，会记录历史）
     * 只被 Resolver 在播放时调用
     */
    getUrl(music, plugin, quality) {
        return API.post(`/api/play?plugin=${encodeURIComponent(plugin)}&quality=${quality || 'standard'}`, { music });
    },

    /**
     * 纯解析 URL（无副作用，预加载用）
     * 只获取 URL，不记录历史
     */
    resolve(music, plugin, quality) {
        return API.post(`/api/resolve?plugin=${encodeURIComponent(plugin)}&quality=${quality || 'standard'}`, { music });
    },

    /**
     * 直接播放（仅供调试/特殊用途，正常播放请使用 playMusic()）
     * @deprecated 请使用 playMusic() 通过 Player 播放
     */
    play(music, plugin, quality) {
        console.error('❌ API.music.play 被调用（不应该），请使用 playMusic() 代替');
        console.trace('前端调用来源');
        return this.getUrl(music, plugin, quality);
    },

    getLyrics(music, plugin) {
        return API.post(`/api/lyrics?plugin=${encodeURIComponent(plugin)}`, { music });
    },

    getMusicInfo(music, plugin) {
        return API.post(`/api/music-info?plugin=${encodeURIComponent(plugin)}`, { music });
    },

    /**
     * 本地曲库匹配查询（切换音源弹窗用）：按歌名+歌手匹配 NAS 本地库
     */
    localMatch(music) {
        return API.post('/api/music/local-match', { music });
    },

    /**
     * 本地曲库批量匹配（歌单详情「本地 ✓」徽标用）：按序返回每首是否命中
     */
    localMatchBatch(songs) {
        return API.post('/api/music/local-match-batch', { songs: songs || [] });
    }
};

// 榜单相关 API
API.toplist = {
    getPlugins() {
        return API.get('/api/plugins/support/getTopLists');
    },

    getList(plugin) {
        return API.get(`/api/toplists?plugin=${encodeURIComponent(plugin)}`);
    },

    getDetail(id, plugin, page = 1) {
        return API.get(`/api/toplist/${encodeURIComponent(id)}?plugin=${encodeURIComponent(plugin)}&page=${page}`);
    }
};

// 热门歌单相关 API
API.recommend = {
    getPlugins() {
        return API.get('/api/plugins/support/getRecommendSheetTags');
    },

    getTags(plugin) {
        return API.get(`/api/recommend-tags?plugin=${encodeURIComponent(plugin)}`);
    },

    getSheets(plugin, tag, page = 1) {
        // 使用 GET 方法，只传递标签 id
        let url = `/api/recommend-sheets?plugin=${encodeURIComponent(plugin)}&page=${page}`;
        if (tag && tag.id !== undefined && tag.id !== null) {
            url += `&tag=${encodeURIComponent(tag.id)}`;
        }
        return API.get(url);
    },

    getSheetDetail(id, plugin, page = 1) {
        return API.get(`/api/sheet/${encodeURIComponent(id)}?plugin=${encodeURIComponent(plugin)}&page=${page}`);
    }
};

// 洛雪（LX）专区 API
API.lx = {
    // 支持的平台列表
    getPlatforms() {
        return API.get('/api/lx/platforms');
    },
    // 排行榜：榜单列表
    getBoards(source) {
        return API.get(`/api/lx/leaderboard/${encodeURIComponent(source)}`);
    },
    // 排行榜：榜单歌曲
    getBoardSongs(source, id, page = 1) {
        return API.get(`/api/lx/leaderboard/${encodeURIComponent(source)}/detail?id=${encodeURIComponent(id)}&page=${page}`);
    },
    // 热门歌单：标签
    getTags(source) {
        return API.get(`/api/lx/songlist/tags/${encodeURIComponent(source)}`);
    },
    // 热门歌单：歌单列表
    getSheets(source, sortId, tagId, page = 1) {
        let url = `/api/lx/songlist/${encodeURIComponent(source)}?page=${page}`;
        if (sortId) url += `&sortId=${encodeURIComponent(sortId)}`;
        if (tagId) url += `&tagId=${encodeURIComponent(tagId)}`;
        return API.get(url);
    },
    // 热门歌单：歌单详情（歌单内歌曲）
    getSheetDetail(source, id, page = 1) {
        return API.get(`/api/lx/songlist/detail/${encodeURIComponent(source)}?id=${encodeURIComponent(id)}&page=${page}`);
    },
    // 歌曲搜索（与 MF 搜索等价）
    search(source, keyword, page = 1) {
        return API.get(`/api/lx/search/${encodeURIComponent(source)}?keyword=${encodeURIComponent(keyword)}&page=${page}`);
    },
    // 歌单搜索
    searchSheets(source, keyword, page = 1) {
        return API.get(`/api/lx/songlist/search/${encodeURIComponent(source)}?keyword=${encodeURIComponent(keyword)}&page=${page}`);
    },
    // ===== 自定义音源管理（二期播放解析）=====
    getSources() {
        return API.get('/api/lx/sources');
    },
    getSource(file) {
        return API.get(`/api/lx/sources/${encodeURIComponent(file)}`);
    },
    // 导入：传 content（粘贴/本地文件）或 url（网络）
    addSource(payload) {
        return API.post('/api/lx/sources', payload);
    },
    removeSource(file) {
        return API.delete(`/api/lx/sources/${encodeURIComponent(file)}`);
    },
    setSourceEnabled(file, enabled) {
        return API.post(`/api/lx/sources/${encodeURIComponent(file)}/enabled`, { enabled });
    },
    reloadSource(file) {
        return API.post(`/api/lx/sources/${encodeURIComponent(file)}/reload`, {});
    },
    testSource(file, source, quality = 'standard') {
        return API.post(`/api/lx/sources/${encodeURIComponent(file)}/test`, { source, quality });
    }
};

// 电台相关 API
API.radio = {
    getStations() {
        return API.get('/api/radio/stations');
    },
    getFavorites() {
        return API.get('/api/radio/favorites');
    },
    addFavorite(station) {
        return API.post('/api/radio/favorites', { station });
    },
    removeFavorite(id) {
        return API.delete('/api/radio/favorites?id=' + encodeURIComponent(id));
    },
    // 收藏电台排序：ids 为新的完整 id 顺序
    reorderFavorites(ids) {
        return API.put('/api/radio/favorites/order', { ids });
    },
    createStation(data) {
        return API.post('/api/radio/stations', data);
    },
    updateStation(id, data) {
        return API.put('/api/radio/stations/' + encodeURIComponent(id), data);
    },
    deleteStation(id) {
        return API.delete('/api/radio/stations/' + encodeURIComponent(id));
    },
    // 重排某分组（维度 + 子项）内电台顺序：orderedIds 为该子项内电台的新 id 顺序
    reorderStations(dimension, subTitle, orderedIds) {
        return API.post('/api/radio/stations/reorder', { dimension, subTitle, orderedIds });
    },
    // 电台排序同步（跨设备）：分类顺序 subOrder + 插件来源电台的分组内顺序 stationOrder
    getOrders() {
        return API.get('/api/radio/orders');
    },
    saveOrders(subOrder, stationOrder) {
        return API.post('/api/radio/orders', { subOrder, stationOrder });
    },
    uploadCoverFromUrl(name, url) {
        return API.post('/api/radio/cover-from-url', { name, url });
    },
    // 导出全部电台为 M3U（返回 fetch Response，供前端下载）
    exportStations() {
        return Auth.authenticatedFetch(`${API.baseURL}/api/radio/stations/export`);
    },
    // 从 M3U 文件批量导入电台（管理员）
    importStations(file) {
        const fd = new FormData();
        fd.append('file', file);
        return Auth.authenticatedFetch(`${API.baseURL}/api/radio/stations/import`, { method: 'POST', body: fd });
    }
};

// 插件相关 API
API.plugins = {
    getInstalled() {
        return API.get('/api/plugins');
    },

    install(url) {
        return API.post('/api/plugins/install-from-url', { url });
    },

    installFromCode(code) {
        return API.post('/api/plugins/install-from-url', { code });
    },

    uninstall(name) {
        return API.delete(`/api/plugins/${encodeURIComponent(name)}`);
    },

    update(name) {
        return API.post('/api/plugins/' + encodeURIComponent(name) + '/update', {});
    }
};

// 收藏相关 API - 使用用户隔离端点
API.favorites = {
    getAll() {
        return Auth.authenticatedFetch(`${API.baseURL}/api/my/favorites`).then(r => r.json());
    },

    add(music) {
        const plugin = music.plugin || music.platform;
        return Auth.authenticatedFetch(`${API.baseURL}/api/my/favorites`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ music, plugin })
        }).then(r => r.json());
    },

    remove(id, platform) {
        let url = `${API.baseURL}/api/my/favorites/${encodeURIComponent(id)}`;
        if (platform) url += `?plugin=${encodeURIComponent(platform)}`;
        return Auth.authenticatedFetch(url, { method: 'DELETE' }).then(r => r.json());
    },

    check(id, platform) {
        let url = `${API.baseURL}/api/my/favorites/check?musicId=${encodeURIComponent(id)}`;
        if (platform) url += `&plugin=${encodeURIComponent(platform)}`;
        return Auth.authenticatedFetch(url).then(r => r.json());
    },

    checkBatch(items) {
        if (!Array.isArray(items) || !items.length) return Promise.resolve({ success: true, data: {} });
        return Auth.authenticatedFetch(`${API.baseURL}/api/my/favorites/check-batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items })
        }).then(r => r.json());
    }
};

// 别名，保持向后兼容
API.myFavorites = API.favorites;

// 最近播放 API - 使用用户隔离端点
const _recentAddLast = {};
API.recent = {
    getAll(limit = 100, offset = 0) {
        return Auth.authenticatedFetch(`${API.baseURL}/api/my/play-history?limit=${limit}&offset=${offset}`).then(r => r.json());
    },

    add(music, plugin, position = 0) {
        const mid = music && (music.id != null ? music.id : music.musicId);
        const key = `${plugin || (music && music.plugin) || ''}:${mid}`;
        const now = Date.now();
        if (key && _recentAddLast[key] && now - _recentAddLast[key] < 3000) {
            return Promise.resolve({ success: true, data: {}, deduplicated: true });
        }
        if (key) _recentAddLast[key] = now;
        return Auth.authenticatedFetch(`${API.baseURL}/api/my/play-history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ music, plugin, position })
        }).then(r => r.json());
    },

    clear() {
        return Auth.authenticatedFetch(`${API.baseURL}/api/my/play-history`, { method: 'DELETE' }).then(r => r.json());
    },

    // 删除单条播放记录（按 musicId + plugin）
    remove(musicId, plugin) {
        let url = `${API.baseURL}/api/my/play-history/item?musicId=${encodeURIComponent(musicId)}`;
        if (plugin) url += `&plugin=${encodeURIComponent(plugin)}`;
        return Auth.authenticatedFetch(url, { method: 'DELETE' }).then(r => r.json());
    }
};

// 别名，保持向后兼容
API.myRecent = API.recent;

// 下载相关 API - 使用全局共享端点（所有用户共用，避免重复下载）
API.download = {
    getAll() {
        return API.get('/api/downloads');
    },

    addTask(music, plugin, quality) {
        return API.post('/api/downloads', { music, plugin, quality });
    },

    checkStatus(musicId, plugin) {
        return API.get(`/api/downloads/check?id=${encodeURIComponent(musicId)}&plugin=${encodeURIComponent(plugin)}`);
    }
};

// 歌单相关 API（用户隔离）
API.playlists = {
    getAll() {
        return Auth.playlists.getAll();
    },

    get(playlistId) {
        return Auth.playlists.get(playlistId);
    },

    create(name, description = '', cover = '') {
        return Auth.playlists.create(name, description, cover);
    },

    update(playlistId, updates) {
        return Auth.playlists.update(playlistId, updates);
    },

    delete(id) {
        return Auth.playlists.delete(id);
    },

    addSong(playlistId, music, plugin) {
        return Auth.playlists.addSong(playlistId, music, plugin);
    },

    removeSong(playlistId, musicId, plugin) {
        return Auth.playlists.removeSong(playlistId, musicId, plugin);
    },

    getSongs(playlistId) {
        return Auth.playlists.getSongs(playlistId);
    },

    refreshSongs(playlistId) {
        return Auth.playlists.refreshSongs(playlistId);
    },

    toplistStatus(ids) {
        return Auth.playlists.toplistStatus(ids);
    }
};

// 播放器状态 API（用户隔离）
let _playerStateLastSig = '';
let _playerStateLastAt = 0;
API.playerState = {
    get() {
        return Auth.authenticatedFetch(`${API.baseURL}/api/my/player-state`).then(r => r.json());
    },
    save(state) {
        try {
            const sig = JSON.stringify(state);
            const now = Date.now();
            if (sig === _playerStateLastSig && now - _playerStateLastAt < 1500) {
                return Promise.resolve({ success: true, data: {}, deduplicated: true });
            }
            _playerStateLastSig = sig;
            _playerStateLastAt = now;
        } catch { /* 状态序列化失败不拦截 */ }
        return Auth.authenticatedFetch(`${API.baseURL}/api/my/player-state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state)
        }).then(r => r.json());
    }
};

// 设置相关 API
API.settings = {
    getAll() {
        return API.get('/api/settings');
    },

    save(settings) {
        return API.post('/api/settings', settings);
    },

    getWebDAV() {
        return API.get('/api/settings/webdav');
    },

    saveWebDAV(settings) {
        return API.post('/api/settings/webdav', settings);
    }
};

// ==================== 客户端请求日志 ====================
// 统一记录前端 → 后端的重要请求节点（方法、状态码、耗时、失败原因）。
// 仅在「重要节点」记录，避免刷屏：非 GET 请求、或 GET 但失败/慢(>=800ms) 的请求。
// 自动跳过 /api/logs 自身，避免日志 POST 触发无限递归。
API.logClientRequest = function(method, endpoint, opts = {}) {
    try {
        if (!endpoint || String(endpoint).includes('/api/logs')) return;
        const { status, ms, ok, error } = opts;
        const slow = typeof ms === 'number' && ms >= 800;
        let level = 'info';
        if (ok === false || (typeof status === 'number' && status >= 400)) level = 'error';
        else if (slow) level = 'warn';
        const isGet = String(method || 'GET').toUpperCase() === 'GET';
        if (isGet && level === 'info') return; // 普通 GET 成功不记录，避免刷屏
        const msg = `${method} ${endpoint} → ${ok === false ? 'FAIL' : (status || '?')} (${ms}ms)`;
        const meta = { method, endpoint, status: status || null, ms: ms || null };
        if (error) meta.error = String(error);
        if (typeof API !== 'undefined' && API.logs && API.logs.add) {
            API.logs.add(level, 'CLIENT', msg, meta);
        }
    } catch (_) { /* 日志失败不影响正常业务 */ }
};

// 日志相关 API
API.logs = {
    // 获取日志（管理员）
    get() {
        return API.get('/api/logs');
    },

    // 添加日志
    add(level, module, message, meta = null) {
        return API.post('/api/logs', { level, module, message, meta });
    }
};

// 全局 fetch 认证拦截器：为指向本应用 API 的请求自动附加 Bearer token。
// 兜底遗留的裸 fetch 调用（如插件/订阅/歌单/自动更新页面），
// 避免因缺少 Authorization 头被后端 authMiddleware 拦截（401）导致界面数据为空。
// 覆盖范围：同源请求，以及指向 window.API_BASE 的请求（含 file:// 打开页面、
// 前后端分离/反代等跨域部署场景）。与 API.request / Auth.authenticatedFetch 行为一致。
(function installAuthFetchInterceptor() {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    const nativeFetch = window.fetch.bind(window);

    function resolveUrl(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.url === 'string') return input.url;
        return '';
    }

    function targetsApi(input) {
        const url = resolveUrl(input);
        if (!url) return true; // 无法判定时保守附加
        if (url.startsWith('/')) return true; // 相对路径视为同源
        try {
            if (new URL(url, window.location.origin).origin === window.location.origin) return true; // 同源
        } catch { /* ignore */ }
        const apiBase = window.API_BASE || '';
        if (apiBase && url.startsWith(apiBase)) return true; // 指向本应用 API（跨域部署）
        return false;
    }

    window.fetch = function (input, init) {
        init = init || {};
        const isApi = targetsApi(input);
        if (isApi) {
            const token = (typeof Auth !== 'undefined' && Auth.getToken) ? Auth.getToken() : null;
            if (token) {
                const headers = new Headers(init.headers || {});
                headers.set('Authorization', 'Bearer ' + token);
                init = Object.assign({}, init, { headers });
            }
        }

        // 统一记录「客户端请求」日志：覆盖 API.request / Auth.authenticatedFetch / 裸 fetch 的全部本应用请求，
        // 旧实现仅在 API.request 内部触发，漏掉了走 authenticatedFetch 的大多数业务请求。
        // 第三方外部请求（targetsApi=false）不记录，避免把插件/外部调用混入业务日志。
        if (isApi && typeof API !== 'undefined' && typeof API.logClientRequest === 'function') {
            const method = (init && init.method) || 'GET';
            const m = String(method).toUpperCase();
            const endpoint = resolveUrl(input);
            const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            return nativeFetch(input, init).then(
                async (resp) => {
                    const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
                    // GET/HEAD/OPTIONS 成功：不读 body（HEAD 定义上无 body；音频流等大响应 clone().json() 纯浪费），
                    // 成功即 ok。此前对 HEAD 也探测 JSON，空 body 解析抛错 → 正常 200 被误标 ERROR「响应非 JSON」。
                    if ((m === 'GET' || m === 'HEAD' || m === 'OPTIONS') && resp.ok) {
                        API.logClientRequest(method, endpoint, { status: resp.status, ms, ok: true, error: null });
                        return resp;
                    }
                    // 非 JSON 响应（音频/图片/octet-stream 等二进制）成功时不判失败：
                    // 仅当 content-type 声明为 JSON 才解析业务语义，避免把正常二进制 2xx 误报 ERROR。
                    const ctype = (resp.headers && resp.headers.get) ? (resp.headers.get('content-type') || '') : '';
                    const looksJson = ctype.toLowerCase().includes('json');
                    let data = null, parseOk = true;
                    if (looksJson) {
                        try { data = await resp.clone().json(); } catch { parseOk = false; }
                    }
                    const businessFail = !!(data && typeof data === 'object' && data.success === false);
                    const ok = resp.ok && parseOk && !businessFail;
                    API.logClientRequest(method, endpoint, {
                        status: resp.status,
                        ms,
                        ok,
                        // 成功响应只上报业务错误字段（data.error），绝不把 data.message 当错误展示
                        // （如 fill-images 成功返回 message:「补全已启动」曾被误标成「错误:…」红字）；
                        // 失败响应才回退到 message / 非 JSON 提示
                        error: (data && data.error)
                            || (resp.ok ? null : ((data && data.message) || (parseOk ? null : '响应非 JSON')))
                    });
                    return resp;
                },
                (err) => {
                    const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
                    API.logClientRequest(method, endpoint, { status: 0, ms, ok: false, error: err && err.message });
                    throw err;
                }
            );
        }

        return nativeFetch(input, init);
    };
})();

// 导出 API
window.API = API;
