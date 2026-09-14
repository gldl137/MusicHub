/**
 * Resolver 模块
 * 职责：负责解析获取歌曲播放 URL
 * - 管理 URL 缓存
 * - 调用插件获取播放地址
 * - 处理不同插件的差异
 */

const Resolver = {
    // URL 缓存: key = id::plugin::quality, value = { url, ts }
    cache: new Map(),

    // URL 缓存有效期：与后端解析短缓存(60s)对齐。签名地址（酷狗/酷我等）
    // 几分钟即失效，命中过期缓存会让播放直接 403/404，超时一律重新实时解析
    CACHE_TTL: 60 * 1000,

    // 正在加载的请求锁，防止重复请求
    loading: new Set(),

    // 当前播放请求的 token，用于取消旧请求
    currentPlayToken: null,

    /**
     * 检查 token 是否有效（当前请求未被新请求覆盖）
     * @param {number} token - 请求 token
     * @returns {boolean}
     */
    isTokenValid(token) {
        if (!token) return true; // 没有 token 的请求总是有效
        return token === this.currentPlayToken;
    },

    /**
     * 设置当前播放 token
     * @param {number} token - 新 token
     */
    setCurrentPlayToken(token) {
        this.currentPlayToken = token;
    },

    /**
     * 规范化歌曲对象，确保 id 为字符串类型
     * @param {Object} song - 歌曲对象
     * @returns {Object} 规范化后的歌曲对象
     */
    normalizeSong(song) {
        if (!song) return null;
        return {
            ...song,
            id: String(song.id)
        };
    },

    /**
     * 生成缓存 key
     * @param {string} id - 歌曲ID（已规范化为字符串）
     * @param {string} plugin - 插件名
     * @param {string} quality - 音质
     * @returns {string} 缓存key
     */
    getCacheKey(id, plugin, quality) {
        return `${id}::${plugin}::${quality}`;
    },

    /**
     * 取未过期的缓存 URL（带 TTL：签名 URL 几分钟即过期，过期视为未命中）
     * @param {string} cacheKey
     * @returns {string|null} 未过期的播放 URL，过期/不存在返回 null
     */
    getCached(cacheKey) {
        const cached = this.cache.get(cacheKey);
        if (!cached) return null;
        const url = (cached && typeof cached === 'object') ? cached.url : cached;
        const ts = (cached && typeof cached === 'object') ? cached.ts : 0;
        if (!url) return null;
        if (Date.now() - ts > this.CACHE_TTL) {
            // 过期缓存：清除，让调用方走实时解析拿新鲜地址
            this.cache.delete(cacheKey);
            return null;
        }
        return url;
    },

    /**
     * 解析获取歌曲播放 URL（播放模式）
     * 使用 /api/play，会记录播放历史
     * @param {Object} song - 歌曲对象
     * @param {string} quality - 音质 (standard/high/lossless)
     * @param {number} token - 播放 token（可选）
     * @returns {Promise<string>} 播放 URL
     */
    async resolve(song, quality = 'standard', token = null) {
        // 设置当前播放 token，这会取消之前的请求
        if (token) {
            this.setCurrentPlayToken(token);
        }
        return this._doResolve(song, quality, { token, mode: 'play' });
    },

    /**
     * 预加载歌曲 URL（只缓存，不播放）
     * 使用 /api/resolve，无副作用
     * @param {Object} song - 歌曲对象
     * @param {string} quality - 音质
     * @returns {Promise<void>}
     */
    async preload(song, quality = 'standard') {
        if (!song || !song.id) return;

        // 规范化歌曲对象
        const normalizedSong = this.normalizeSong(song);
        const pluginName = normalizedSong.plugin || normalizedSong.platform;
        if (!pluginName) return;

        const cacheKey = this.getCacheKey(normalizedSong.id, pluginName, quality);

        // 如果已有未过期缓存或正在加载，跳过
        if (this.getCached(cacheKey) || this.loading.has(cacheKey)) {
            return;
        }

        if (typeof log === 'function') {
            log('DEBUG', 'Preload', `Next: ${normalizedSong.title}`);
        }

        try {
            // 预加载模式：使用 /api/resolve，无副作用
            await this._doResolve(song, quality, { mode: 'preload' });
        } catch (error) {
            // 预加载失败不报错，静默处理
        }
    },

    /**
     * 内部解析方法
     * @param {Object} song - 歌曲对象
     * @param {string} quality - 音质
     * @param {Object} options - 选项 { token, mode }
     * @returns {Promise<string>} 播放 URL
     */
    async _doResolve(song, quality = 'standard', options = {}) {
        const { token, mode = 'play' } = options;
        const isPreload = mode === 'preload';

        if (!song || !song.id) {
            throw new Error('Invalid song data');
        }

        // 规范化歌曲对象（确保 id 为字符串）
        const normalizedSong = this.normalizeSong(song);

        // 确保有 plugin 字段
        const pluginName = normalizedSong.plugin || normalizedSong.platform;
        if (!pluginName) {
            throw new Error('No plugin specified for song');
        }

        // 本地音乐特殊处理：直接返回本地文件路径
        if (pluginName === 'local') {
            if (!normalizedSong.filePath) {
                throw new Error('Local music missing filePath');
            }
            // 本地音乐不通过 API 获取，直接使用 filePath
            const localUrl = `/api/local-files/stream?path=${encodeURIComponent(normalizedSong.filePath)}`;
            window.currentMusicSource = 'local-file';
            return localUrl;
        }

        const cacheKey = this.getCacheKey(normalizedSong.id, pluginName, quality);
        const meta = token ? { token } : { preload: isPreload };

        // 1. 检查缓存（带 TTL，过期视为未命中重新实时解析）
        // 说明：音频不再落盘缓存，一律按 URL 流式播放（插件/本地均如此），避免音频文件堆积。
        const cachedUrl = this.getCached(cacheKey);
        if (cachedUrl) {
            if (typeof log === 'function') {
                log('DEBUG', 'Resolver', `Cache HIT key=${cacheKey.substring(0, 20)}...`, meta);
            }

            // 播放模式：即使有缓存也要异步调用 /api/play 记录播放历史（不阻塞播放）
            if (!isPreload) {
                this._recordPlayHistory(normalizedSong, pluginName, quality);
            }

            window.currentMusicSource = 'remote';
            return cachedUrl;
        }

        // 2. 检查是否正在加载（防重复请求）
        if (this.loading.has(cacheKey)) {
            // 等待正在进行的请求完成，传递参数以便失败时重试
            return this.waitForLoading(cacheKey, normalizedSong, quality, options);
        }

        // 3. 标记为正在加载
        this.loading.add(cacheKey);

        try {
            // 检查 token 是否已被新请求覆盖
            if (!this.isTokenValid(token)) {
                throw new Error('Request cancelled by new play');
            }

            // 根据模式选择接口
            // play 模式: /api/play (有副作用，记录历史)
            // preload 模式: /api/resolve (无副作用)
            const result = isPreload
                ? await API.music.resolve(normalizedSong, pluginName, quality)
                : await API.music.getUrl(normalizedSong, pluginName, quality);

            // 再次检查 token（请求完成后）
            if (!this.isTokenValid(token)) {
                throw new Error('Request cancelled by new play');
            }

            // 防御性检查：确保 result 存在且格式正确
            if (!result || typeof result !== 'object') {
                throw new Error('Invalid response from API: result is not an object');
            }

            if (!result.success || !result.data?.url) {
                throw new Error(result.error || 'Failed to get URL');
            }

            // 防御性检查：确保 result.data 存在
            if (!result.data || typeof result.data !== 'object') {
                throw new Error('Invalid response from API: result.data is not an object');
            }

            const url = result.data.url;

            // 落雪（LX）：记录「实际解析成功的音源脚本」（可能与配置的优先源不同——
            // 优先源失败时会自动回退），供播放器底栏/详情页如实显示当前用的是哪个源
            if (result.data.sourceFile) song.lxResolvedFile = result.data.sourceFile;

            // 存入缓存（记录时间戳供 TTL 判断）
            this.cache.set(cacheKey, { url, ts: Date.now() });

            window.currentMusicSource = 'remote';
            return url;

        } finally {
            // 移除加载标记
            this.loading.delete(cacheKey);
        }
    },

    /**
     * 等待正在进行的加载请求
     * @param {string} cacheKey - 缓存键
     * @param {Object} song - 歌曲对象（用于失败时重新请求）
     * @param {string} quality - 音质（用于失败时重新请求）
     * @param {Object} options - 选项（用于失败时重新请求）
     * @returns {Promise<string>}
     */
    waitForLoading(cacheKey, song, quality, options) {
        return new Promise((resolve, reject) => {
            let checkCount = 0;
            const checkInterval = setInterval(async () => {
                checkCount++;
                if (!this.loading.has(cacheKey)) {
                    clearInterval(checkInterval);
                    const pendingUrl = this.getCached(cacheKey);
                    if (pendingUrl) {
                        resolve(pendingUrl);
                    } else {
                        // 之前的请求可能失败了，尝试重新发起请求
                        if (checkCount < 50 && song) { // 最多等待5秒后重试
                            try {
                                const result = await this._doResolve(song, quality, options);
                                resolve(result);
                            } catch (error) {
                                reject(error);
                            }
                        } else {
                            reject(new Error('Loading failed'));
                        }
                    }
                }
            }, 100);

            // 超时处理
            setTimeout(() => {
                clearInterval(checkInterval);
                reject(new Error('Wait for loading timeout'));
            }, 10000);
        });
    },

    /**
     * 异步记录播放历史（不阻塞播放）
     * 当缓存命中时调用，确保播放历史被记录
     * @param {Object} song - 歌曲对象
     * @param {string} plugin - 插件名称
     * @param {string} quality - 音质
     */
    _recordPlayHistory(song, plugin, quality) {
        // 异步调用 /api/play 只用于记录历史，不关心返回结果
        if (typeof API !== 'undefined' && API.music && API.music.getUrl) {
            if (typeof log === 'function') {
                log('DEBUG', 'Resolver', 'Recording play history (async, cache hit)', { songId: song.id, title: song.title, plugin });
            }
            API.music.getUrl(song, plugin, quality).then(result => {
                if (typeof log === 'function') {
                    log('DEBUG', 'Resolver', 'Play history recorded (async)', { songId: song.id, title: song.title, success: result.success });
                }
            }).catch(err => {
                // 记录历史失败不应该影响播放
                if (typeof log === 'function') {
                    log('WARN', 'Resolver', 'Failed to record play history (async)', { error: err.message, songId: song.id });
                }
            });
        } else {
            if (typeof log === 'function') {
                log('WARN', 'Resolver', 'Cannot record play history: API not available', { hasAPI: typeof API !== 'undefined' });
            }
        }
    },

    /**
     * 清除缓存
     * @param {string} key - 指定 key 清除，不传则清除全部
     */
    clearCache(key) {
        if (key) {
            this.cache.delete(key);
        } else {
            this.cache.clear();
        }
    },

    /**
     * 获取缓存大小
     * @returns {number}
     */
    getCacheSize() {
        return this.cache.size;
    }
};

// 导出到全局
window.Resolver = Resolver;
