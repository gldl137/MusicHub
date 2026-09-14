/**
 * CacheManager 模块
 * 职责：管理音频、封面、歌词的本地文件缓存
 * - LRU 淘汰策略
 * - 容量限制管理
 * - 后台下载缓存
 * - 缓存索引持久化（存浏览器 localStorage；服务器不再生成 index.json）
 */

// 缓存索引在浏览器的 localStorage 键名（服务器不再生成/维护 index.json）
const INDEX_STORAGE_KEY = 'musichub_cache_index_v1';

const CacheManager = {
    // 配置
    config: {
        maxSize: 1000 * 1024 * 1024,  // 默认 1GB
        artworkMaxSize: 150 * 1024 * 1024, // 封面占75%（音频不再缓存，预算归封面/歌词）
        lyricsMaxSize: 50 * 1024 * 1024,  // 歌词占25%
        cacheDir: '/data/cache',
        // 注意：不使用过期时间，只使用大小限制
        apiBase: window.API_BASE || ''
    },

    // 内存缓存索引
    index: {
        items: {},      // 缓存项 {hash: {size, mtime, accessTime, type, musicId, plugin, quality, title, artist}}
        totalSize: 0,
        version: 1
    },

    // 正在下载的请求锁
    downloading: new Set(),

    // 是否已初始化
    initialized: false,

    /**
     * 初始化缓存管理器
     */
    async init() {
        if (this.initialized) return;

        // 加载用户设置的缓存上限
        this.loadConfig();

        // 从服务器加载缓存索引
        await this.loadIndex();

        // 注意：不使用过期时间清理，只使用大小限制（LRU）
        // await this.cleanExpired();

        this.initialized = true;
        console.log('[INFO] [CacheManager] Initialized, total cache size:', this.formatSize(this.index.totalSize));
    },

    /**
     * 加载配置
     */
    loadConfig() {
        const savedLimit = localStorage.getItem('cache_limit_mb');
        if (savedLimit) {
            const mb = parseInt(savedLimit, 10);
            if (mb > 0) {
                this.config.maxSize = mb * 1024 * 1024;
                // 音频不再缓存，预算归封面与歌词（封面 75% / 歌词 25%）
                this.config.artworkMaxSize = Math.floor(this.config.maxSize * 0.75);
                this.config.lyricsMaxSize = Math.floor(this.config.maxSize * 0.25);
            }
        }
    },

    /**
     * 生成缓存 hash
     */
    getHash(musicId, plugin, quality = '') {
        const str = `${musicId}_${plugin}_${quality}`;
        return this.simpleHash(str);
    },

    /**
     * 简单哈希函数
     */
    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(16).padStart(8, '0');
    },

    /**
     * 生成安全的文件名
     * @param {string} title - 歌曲名
     * @param {string} artist - 艺术家
     * @param {string} quality - 音质（仅音频需要）
     * @returns {string} 安全的文件名
     */
    getSafeFileName(title, artist, quality) {
        // 清理非法字符
        const sanitize = (str) => {
            if (!str) return '';
            return str.replace(/[\\/:*?"<>|]/g, '_').trim();
        };

        const safeTitle = sanitize(title) || '未知歌曲';
        const safeArtist = sanitize(artist) || '未知艺术家';

        // 格式：歌名-歌手_音质
        let fileName;
        if (quality) {
            fileName = `${safeTitle}-${safeArtist}_${quality}`;
        } else {
            fileName = `${safeTitle}-${safeArtist}`;
        }

        // 限制长度，避免路径过长
        if (fileName.length > 100) {
            fileName = fileName.substring(0, 100);
        }

        return fileName;
    },

    /**
     * 获取封面缓存
     */
    async getArtwork(music, plugin) {
        if (!music || !plugin) return null;

        await this.init();

        const artworkUrl = music.artwork || music.coverImg || music.cover || music.pic;
        if (!artworkUrl) return null;

        // 使用歌曲名作为文件名（歌名-歌手）
        const fileName = this.getSafeFileName(music.title, music.artist);
        const hash = this.simpleHash(artworkUrl);

        // 查找索引（先按文件名查找，再按hash查找兼容旧缓存）
        let item = Object.values(this.index.items).find(
            i => i.type === 'artwork' && i.fileName === fileName
        );
        if (!item) {
            item = this.index.items[hash];
        }

        if (item && item.type === 'artwork') {
            item.accessTime = Date.now();
            this.saveIndexDebounced();
            const returnName = item.fileName || hash;
            return `/cache/artwork/${encodeURIComponent(returnName)}`;
        }

        // 后台缓存封面
        this.addToCache(artworkUrl, hash, 'artwork', {
            musicId: music.id,
            plugin,
            title: music.title,
            artist: music.artist
        }).catch(() => {});

        return null;
    },

    /**
     * 获取歌词缓存
     */
    async getLyrics(music, plugin) {
        if (!music || !music.id || !plugin) return null;

        await this.init();

        // 使用歌曲名作为文件名（歌名-歌手）
        const fileName = this.getSafeFileName(music.title, music.artist);
        const hash = this.getHash(music.id, plugin, 'lyrics');

        // 查找索引（先按文件名查找，再按hash查找兼容旧缓存）
        let item = Object.values(this.index.items).find(
            i => i.type === 'lyrics' && i.fileName === fileName
        );
        if (!item) {
            item = this.index.items[hash];
        }

        if (item && item.type === 'lyrics') {
            item.accessTime = Date.now();
            this.saveIndexDebounced();
            const returnName = item.fileName || hash;
            return `/cache/lyrics/${encodeURIComponent(returnName)}`;
        }

        return null;
    },

    /**
     * 添加资源到缓存
     * @param {string} url - 资源URL
     * @param {string} hash - 哈希值
     * @param {string} type - 类型 (audio/artwork/lyrics)
     * @param {Object} metadata - 元数据
     */
    async addToCache(url, hash, type, metadata = {}) {
        if (!url || this.downloading.has(hash)) return;

        // 检查是否已存在
        if (this.index.items[hash]) return;

        // 检查容量限制
        const maxSize = this.getMaxSizeForType(type);
        const currentSize = this.getCurrentSizeForType(type);

        this.downloading.add(hash);

        // 生成文件名（使用歌曲名-歌手格式）
        let fileName = hash;
        if (metadata.title) {
            // 封面和歌词使用 歌名-歌手 格式（不含音质后缀）
            fileName = this.getSafeFileName(metadata.title, metadata.artist);
        }

        try {
            const response = await fetch(`${this.config.apiBase}/api/cache/download`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url,
                    hash,
                    fileName,
                    type,
                    maxSize: maxSize - currentSize
                })
            });

            const result = await response.json();

            if (result.success && result.data) {
                const { size } = result.data;

                // 最小体积校验：音源故障时 /api/cache/download 可能把错误页/占位响应
                // 存成音频（实测出现过 83 字节文件）。过小的"音频"不入索引，并删掉垃圾文件。
                const minBytes = { audio: 10 * 1024, artwork: 512, lyrics: 16 }[type] || 0;
                if (size < minBytes) {
                    console.warn('[WARN] [CacheManager] Cached file too small, discarded:', type, hash, size);
                    fetch(`${this.config.apiBase}/api/cache/delete/${encodeURIComponent(fileName)}?type=${type}`, { method: 'DELETE' }).catch(() => {});
                    return;
                }

                // 清理空间
                await this.evictIfNeeded(size, type);

                // 添加到索引
                this.index.items[hash] = {
                    hash,
                    type,
                    size,
                    fileName,  // 保存文件名
                    mtime: Date.now(),
                    accessTime: Date.now(),
                    ...metadata
                };
                this.index.totalSize += size;

                this.saveIndexDebounced();
                console.log('[INFO] [CacheManager] Cached:', type, hash, this.formatSize(size));
            }
        } catch (error) {
            console.error('[ERROR] [CacheManager] Failed to cache:', error.message);
        } finally {
            this.downloading.delete(hash);
        }
    },

    /**
     * 保存歌词到缓存（直接保存文本内容）
     * @param {string} lyricsText - 歌词文本内容
     * @param {string} hash - 哈希值
     * @param {Object} metadata - 元数据（title, artist, plugin, musicId）
     */
    async saveLyrics(lyricsText, hash, metadata = {}) {
        if (!lyricsText || !hash || this.downloading.has(hash)) return;

        // 检查是否已存在
        if (this.index.items[hash]) return;

        this.downloading.add(hash);

        // 生成文件名
        let fileName = hash;
        if (metadata.title) {
            fileName = this.getSafeFileName(metadata.title, metadata.artist);
        }

        try {
            const response = await fetch(`${this.config.apiBase}/api/cache/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: lyricsText,
                    hash,
                    fileName,
                    type: 'lyrics'
                })
            });

            const result = await response.json();

            if (result.success && result.data) {
                const { size } = result.data;

                // 清理空间
                await this.evictIfNeeded(size, 'lyrics');

                // 添加到索引
                this.index.items[hash] = {
                    hash,
                    type: 'lyrics',
                    size,
                    fileName,
                    mtime: Date.now(),
                    accessTime: Date.now(),
                    ...metadata
                };
                this.index.totalSize += size;

                this.saveIndexDebounced();
                console.log('[INFO] [CacheManager] Saved lyrics:', hash, this.formatSize(size));
            }
        } catch (error) {
            console.error('[ERROR] [CacheManager] Failed to save lyrics:', error.message);
        } finally {
            this.downloading.delete(hash);
        }
    },

    /**
     * 获取某类型的最大容量
     */
    getMaxSizeForType(type) {
        switch (type) {
            case 'artwork': return this.config.artworkMaxSize;
            case 'lyrics': return this.config.lyricsMaxSize;
            default: return this.config.maxSize;
        }
    },

    /**
     * 获取某类型当前已用容量
     */
    getCurrentSizeForType(type) {
        return Object.values(this.index.items)
            .filter(item => item.type === type)
            .reduce((sum, item) => sum + item.size, 0);
    },

    /**
     * LRU 清理
     */
    async evictIfNeeded(requiredSpace, type) {
        const maxSize = this.getMaxSizeForType(type);
        const currentSize = this.getCurrentSizeForType(type);

        if (currentSize + requiredSpace <= maxSize) return;

        // 获取该类型的所有缓存项，按访问时间排序
        const items = Object.values(this.index.items)
            .filter(item => item.type === type)
            .sort((a, b) => a.accessTime - b.accessTime);

        const targetSize = maxSize * 0.9; // 清理到90%以下

        for (const item of items) {
            if (currentSize - this.getCurrentSizeForType(type) + requiredSpace <= targetSize) break;
            await this.removeItem(item.hash);
        }
    },

    /**
     * 移除单个缓存项
     */
    async removeItem(hash) {
        const item = this.index.items[hash];
        if (!item) return;

        try {
            // 使用文件名或 hash 删除
            const fileName = item.fileName || hash;
            await fetch(`${this.config.apiBase}/api/cache/delete/${encodeURIComponent(fileName)}?type=${item.type}`, {
                method: 'DELETE'
            });

            this.index.totalSize -= item.size;
            delete this.index.items[hash];
        } catch (error) {
            console.error('[ERROR] [CacheManager] Failed to remove item:', hash);
        }
    },

    /**
     * 清理过期缓存（已禁用，只使用大小限制）
     */
    async cleanExpired() {
        // 不使用过期时间，只使用大小限制（LRU）
        return;
    },

    /**
     * 获取某类型的过期时间（已禁用）
     */
    getMaxAgeForType(_type) {
        // 返回一个很大的值，相当于不过期
        return Number.MAX_SAFE_INTEGER;
    },

    /**
     * 清理所有缓存
     */
    async clearAll() {
        try {
            const response = await fetch(`${this.config.apiBase}/api/cache/clear`, {
                method: 'POST'
            });

            const result = await response.json();

            if (result.success) {
                this.index.items = {};
                this.index.totalSize = 0;
                this.saveIndexDebounced();
            }

            return result;
        } catch (error) {
            console.error('[ERROR] [CacheManager] Failed to clear cache:', error);
            return { success: false, error: error.message };
        }
    },

    /**
     * 清理指定类型的缓存（按类型清理：audio/artwork/artist/radio/lyrics；artist=art/、radio=radio-covers/）
     * @param {string[]} types - 要清理的类型数组，为空或缺失表示全部
     */
    async clearTypes(types) {
        try {
            const valid = ['artwork', 'artist', 'radio', 'lyrics'];
            const cleared = (Array.isArray(types) && types.length)
                ? types.filter(t => valid.includes(t))
                : valid;

            const response = await fetch(`${this.config.apiBase}/api/cache/clear`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ types: cleared })
            });

            const result = await response.json();

            if (result.success) {
                // 仅从索引移除被清理的类型，保留其它类型
                for (const key of Object.keys(this.index.items)) {
                    const item = this.index.items[key];
                    if (item && cleared.includes(item.type)) {
                        this.index.totalSize -= item.size || 0;
                        delete this.index.items[key];
                    }
                }
                this.saveIndexDebounced();
            }

            return result;
        } catch (error) {
            console.error('[ERROR] [CacheManager] Failed to clear cache types:', error);
            return { success: false, error: error.message };
        }
    },

    /**
     * 获取缓存状态
     */
    getStatus() {
        const artworkSize = this.getCurrentSizeForType('artwork');
        const lyricsSize = this.getCurrentSizeForType('lyrics');

        return {
            totalSize: this.index.totalSize,
            maxSize: this.config.maxSize,
            artworkSize,
            lyricsSize,
            itemCount: Object.keys(this.index.items).length,
            artworkCount: Object.values(this.index.items).filter(i => i.type === 'artwork').length,
            lyricsCount: Object.values(this.index.items).filter(i => i.type === 'lyrics').length
        };
    },

    /**
     * 格式化大小
     */
    formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },

    /**
     * 加载缓存索引：优先读浏览器 localStorage（不再依赖服务器 index.json）
     */
    async loadIndex() {
        try {
            const saved = localStorage.getItem(INDEX_STORAGE_KEY);
            if (saved) {
                const data = JSON.parse(saved);
                if (data && data.items) {
                    this.index = data;
                    return;
                }
            }
            // 无本地索引：从空索引开始
            this.index = { items: {}, totalSize: 0, version: 1 };
        } catch (error) {
            console.error('[ERROR] [CacheManager] Failed to load index:', error);
        }
    },

    /**
     * 保存缓存索引（防抖）
     */
    saveIndexDebounced: (function() {
        let timeout;
        return function() {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                this.saveIndex();
            }, 1000);
        };
    })(),

    /**
     * 保存缓存索引：写入浏览器 localStorage（服务器不再生成 index.json）
     */
    async saveIndex() {
        try {
            localStorage.setItem(INDEX_STORAGE_KEY, JSON.stringify(this.index));
        } catch (error) {
            console.error('[ERROR] [CacheManager] Failed to persist index:', error);
        }
    },

    /**
     * 设置缓存上限
     */
    setMaxSize(mb) {
        this.config.maxSize = mb * 1024 * 1024;
        // 音频不再缓存，预算归封面与歌词（封面 75% / 歌词 25%）
        this.config.artworkMaxSize = Math.floor(this.config.maxSize * 0.75);
        this.config.lyricsMaxSize = Math.floor(this.config.maxSize * 0.25);

        localStorage.setItem('cache_limit_mb', mb.toString());

        // 触发清理
        this.evictIfNeeded(0, 'artwork');
        this.evictIfNeeded(0, 'lyrics');
    }
};

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    CacheManager.init();
});
