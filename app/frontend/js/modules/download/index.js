/**
 * 下载管理模块
 * 功能：加载下载任务、渲染列表、管理下载、下载状态同步
 */

// ==================== 下载管理器 ====================

const DownloadManager = {
    // 已下载的歌曲ID缓存 (songId_plugin -> true)
    downloadedCache: new Set(),

    // 正在下载的歌曲ID缓存 (songId_plugin -> true)
    downloadingCache: new Set(),

    // 下载任务队列
    taskQueue: [],

    // 是否正在处理队列
    isProcessing: false,

    // 当前选中的标签页
    currentTab: 'downloaded',

    /**
     * 初始化下载管理器
     */
    async init() {
        // 清除缓存，确保从数据库实时获取状态
        this.downloadedCache.clear();
        this.downloadingCache.clear();

        // 不再批量加载下载状态，改为点击时实时查询
        // await this.loadDownloadedSongs();
        this.updateAllDownloadButtons();

        // 监听下载状态变化事件（来自其他页面）
        window.addEventListener('download:statusChanged', (event) => {
            const { musicId, plugin, status } = event.detail;
            if (musicId && plugin && status) {
                this.updateDownloadButtonByKey(musicId, plugin, status);
            }
        });

        // 页面可见性变化时更新按钮状态（从其他页面返回时同步）
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                this.updateAllDownloadButtons();
            }
        });

        // 同步状态到 StateManager（如果可用）
        this.syncToStateManager();
    },

    /**
     * 同步缓存状态到 StateManager
     * @param {boolean} broadcast - 是否广播变化事件
     */
    syncToStateManager(broadcast = false) {
        if (!window.StateManager) return;

        // 同步已下载状态
        this.downloadedCache.forEach(key => {
            const [musicId, plugin] = key.split('_');
            StateManager.setDownloadStatus(musicId, plugin, 'downloaded', broadcast);
        });

        // 同步下载中状态
        this.downloadingCache.forEach(key => {
            const [musicId, plugin] = key.split('_');
            StateManager.setDownloadStatus(musicId, plugin, 'downloading', broadcast);
        });

    },

    /**
     * 加载已下载的歌曲列表到缓存（已弃用，下载状态改为点击时实时查询）
     */
    async loadDownloadedSongs() {
        // 下载状态不再批量加载到缓存，改为点击时实时查询
        return;

        /*
        try {
            const response = await fetch(`${API_BASE}/api/downloads?status=completed`);
            const result = await response.json();

            if (result.success && result.data) {
                this.downloadedCache.clear();
                result.data.forEach(item => {
                    // 使用 songId 或 id 作为歌曲ID
                    const songId = item.songId || item.id;
                    if (songId && item.plugin) {
                        const key = `${songId}_${item.plugin}`;
                        this.downloadedCache.add(key);
                    }
                });
            }
        } catch (error) {
        }
        */
    },

    /**
     * 检查歌曲是否已下载（使用 StateManager 实时查询数据库）
     * @param {Object} music
     * @param {string} plugin
     * @returns {Promise<boolean>}
     */
    async checkIsDownloaded(music, plugin) {
        if (!music || !music.id || !plugin) return false;
        // 使用 StateManager 实时查询数据库
        if (window.StateManager?.isDownloaded) {
            return await window.StateManager.isDownloaded(music.id, plugin);
        }
        // 降级到本地缓存
        const key = `${music.id}_${plugin}`;
        return this.downloadedCache.has(key);
    },

    /**
     * 检查歌曲是否正在下载
     * @param {Object} music
     * @param {string} plugin
     * @returns {boolean}
     */
    checkIsDownloading(music, plugin) {
        if (!music || !music.id || !plugin) return false;
        const key = `${music.id}_${plugin}`;
        return this.downloadingCache.has(key);
    },

    /**
     * 从服务器检查歌曲是否已下载（已弃用，使用 checkIsDownloaded 替代）
     * @param {Object} music
     * @param {string} plugin
     * @returns {Promise<boolean>}
     */
    async checkIsDownloadedFromServer(music, plugin) {
        // 直接调用 checkIsDownloaded，统一使用 StateManager
        return this.checkIsDownloaded(music, plugin);
    },

    /**
     * 下载单个歌曲（简化接口，供 MusicList 等组件调用）
     * @param {Object} music - 歌曲对象
     */
    async download(music) {
        if (!music || !music.id) {
            showToast('无效的歌曲信息', 'error');
            return;
        }

        const plugin = music.plugin || music.platform;
        if (!plugin) {
            showToast('无法确定歌曲来源', 'error');
            return;
        }

        // 本地音乐不需要下载
        if (plugin === 'local') {
            showToast('本地音乐无需下载', 'info');
            return;
        }

        const source = typeof getMusicSourceText === 'function' ? getMusicSourceText(music) : plugin;
        await this.addDownloadTask(music, plugin, source, 'standard');
    },

    /**
     * 添加下载任务
     * @param {Object} music
     * @param {string} plugin
     * @param {string} source
     * @param {string} quality
     */
    async addDownloadTask(music, plugin, source, quality = 'standard') {
        if (!music || !music.id || !plugin) {
            showToast('无效的歌曲信息', 'error');
            return;
        }

        // 检查是否已下载（异步查询数据库）
        const isDownloaded = await this.checkIsDownloaded(music, plugin);
        if (isDownloaded) {
            showToast('该歌曲已下载', 'info');
            return;
        }

        // 检查是否正在下载
        if (this.checkIsDownloading(music, plugin)) {
            showToast('该歌曲正在下载中', 'info');
            return;
        }

        // 添加到下载队列
        this.taskQueue.push({ music, plugin, source, quality });

        // 标记为正在下载
        const key = `${music.id}_${plugin}`;
        this.downloadingCache.add(key);

        // 更新按钮状态为下载中
        this.updateDownloadButton(music, plugin, 'downloading');

        showToast(`已添加 "${music.title}" 到下载队列`, 'success');

        // 开始处理队列
        if (!this.isProcessing) {
            this.processQueue();
        }
    },

    /**
     * 处理下载队列
     */
    async processQueue() {
        if (this.isProcessing || this.taskQueue.length === 0) return;

        this.isProcessing = true;

        while (this.taskQueue.length > 0) {
            const task = this.taskQueue.shift();
            await this.downloadSong(task.music, task.plugin, task.quality);
        }

        this.isProcessing = false;
    },

    /**
     * 下载单个歌曲
     * @param {Object} music
     * @param {string} plugin
     * @param {string} quality
     */
    async downloadSong(music, plugin, quality) {
        const key = `${music.id}_${plugin}`;

        try {
            // 更新按钮状态为下载中
            this.updateDownloadButton(music, plugin, 'downloading');

            // 记录前台日志 - 开始下载
            if (typeof API !== 'undefined' && API.logs && API.logs.add) {
                API.logs.add('info', 'DOWNLOAD', 'Download started', {
                    title: music.title,
                    artist: music.artist,
                    plugin: plugin,
                    quality: quality
                }).catch(() => {});
            }

            // 使用 DownloadCore 下载
            if (window.DownloadCore) {
                const result = await DownloadCore.download({
                    id: music.id,
                    title: music.title,
                    artist: music.artist,
                    plugin: plugin,
                    quality: quality,
                    artwork: music.artwork,
                    album: music.album
                });

                if (result.status === 'already_downloaded') {
                    this.downloadedCache.add(key);
                    this.downloadingCache.delete(key);
                    this.updateDownloadButton(music, plugin, 'downloaded');
                    showToast('该歌曲已下载', 'info');
                } else if (result.success) {
                    showToast(`"${music.title}" 下载完成`, 'success');

                    // 记录前台日志 - 下载完成
                    if (typeof API !== 'undefined' && API.logs && API.logs.add) {
                        API.logs.add('info', 'DOWNLOAD', 'Download completed', {
                            title: music.title,
                            artist: music.artist,
                            plugin: plugin
                        }).catch(() => {});
                    }
                } else {
                    throw new Error(result.error || '下载失败');
                }
            } else {
                // 兼容旧逻辑
                await this.downloadFile(music, plugin);
            }

        } catch (error) {
            showToast(`下载失败: ${error.message}`, 'error');

            // 记录前台日志 - 下载失败
            if (typeof API !== 'undefined' && API.logs && API.logs.add) {
                API.logs.add('error', 'DOWNLOAD', 'Download failed', {
                    title: music.title,
                    artist: music.artist,
                    plugin: plugin,
                    error: error.message
                }).catch(() => {});
            }

            this.downloadingCache.delete(key);
            this.updateDownloadButton(music, plugin, 'normal');
        }
    },

    /**
     * 获取音乐URL
     * @param {Object} music
     * @param {string} plugin
     * @param {string} quality
     * @returns {Promise<Object|null>}
     */
    async fetchMusicUrl(music, plugin, quality) {
        try {
            if (typeof API !== 'undefined' && API.music && API.music.getUrl) {
                const result = await API.music.getUrl(music, plugin, quality);
                if (result.success && result.data) {
                    return result.data;
                }
            }

            // 备用方案：直接请求
            const response = await fetch(`${API_BASE}/api/music/url`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    music: music,
                    plugin: plugin,
                    quality: quality
                })
            });

            const result = await response.json();
            if (result.success && result.data) {
                return result.data;
            }

            return null;
        } catch (error) {
            return null;
        }
    },

    /**
     * 下载文件（调用后端API下载到服务器目录）
     * 后端会自动 resolve URL，支持重试和 URL 过期自动重新 resolve
     * @param {Object} music
     * @param {string} plugin
     */
    async downloadFile(music, plugin) {
        const key = `${music.id}_${plugin}`;

        try {
            // 获取用户设置的下载音质
            const settings = JSON.parse(localStorage.getItem('download_settings') || '{}');
            const quality = settings.quality || 'standard';

            // 调用后端API开始下载（后端统一使用 ResolverCore 获取 URL）
            // 发送完整的音乐数据，确保插件能正确解析
            const response = await fetch(`${API_BASE}/api/downloads/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    musicId: music.id,
                    plugin: plugin,
                    quality: quality,
                    music: music,
                    source: '下载管理'
                })
            });

            const result = await response.json();

            if (!result.success) {
                if (result.data && result.data.skipped) {
                    // 文件已存在，跳过下载
                    this.downloadingCache.delete(key);
                    this.downloadedCache.add(key);
                    this.updateDownloadButton(music, plugin, 'downloaded');
                    showToast('该歌曲已存在，已跳过', 'info');
                    return;
                }
                throw new Error(result.error || '启动下载失败');
            }

            // 检查是否直接跳过
            if (result.data && result.data.skipped) {
                this.downloadingCache.delete(key);
                this.downloadedCache.add(key);
                this.updateDownloadButton(music, plugin, 'downloaded');
                showToast('该歌曲已存在，已跳过', 'info');
                return;
            }

            showToast(`"${music.title}" 开始下载到服务器`, 'success');

            // 开始轮询下载进度
            this.pollDownloadProgress(music, plugin);

        } catch (error) {
            this.downloadingCache.delete(key);
            this.updateDownloadButton(music, plugin, 'normal');

            throw error;
        }
    },

    /**
     * 轮询下载进度
     * @param {Object} music
     * @param {string} plugin
     */
    async pollDownloadProgress(music, plugin) {
        const key = `${music.id}_${plugin}`;
        const maxAttempts = 300; // 最多轮询300次（10分钟）
        let attempts = 0;

        const checkProgress = async () => {
            attempts++;

            try {
                // 获取下载状态
                const response = await fetch(`${API_BASE}/api/downloads/check?musicId=${music.id}&plugin=${plugin}`);
                const result = await response.json();

                if (result.success && result.data) {
                    const downloadInfo = result.data.info;
                    const isDownloaded = result.data.downloaded;

                    // 如果已下载标记为 true，视为完成
                    if (isDownloaded) {
                        this.downloadingCache.delete(key);
                        this.downloadedCache.add(key);
                        this.updateDownloadButton(music, plugin, 'downloaded');
                        showToast(`"${music.title}" 下载完成`, 'success');

                        // 刷新下载列表
                        if (typeof refreshDownloadLists === 'function') {
                            refreshDownloadLists();
                        }
                        return;
                    }

                    if (downloadInfo) {
                        if (downloadInfo.status === 'completed') {
                            // 下载完成
                            this.downloadingCache.delete(key);
                            this.downloadedCache.add(key);
                            this.updateDownloadButton(music, plugin, 'downloaded');
                            showToast(`"${music.title}" 下载完成`, 'success');

                            // 刷新下载列表
                            if (typeof refreshDownloadLists === 'function') {
                                refreshDownloadLists();
                            }
                            return;
                        } else if (downloadInfo.status === 'failed') {
                            // 下载失败
                            this.downloadingCache.delete(key);
                            this.updateDownloadButton(music, plugin, 'normal');
                            showToast(`"${music.title}" 下载失败`, 'error');
                            return;
                        } else if (downloadInfo.status === 'downloading') {
                            // 更新进度
                            const progress = downloadInfo.progress || 0;
                            this.updateDownloadButtonProgress(music, plugin, progress);
                        }
                    }
                }

                // 继续轮询
                if (attempts < maxAttempts && this.downloadingCache.has(key)) {
                    setTimeout(checkProgress, 2000); // 每2秒检查一次
                }
            } catch (error) {
                if (attempts < maxAttempts && this.downloadingCache.has(key)) {
                    setTimeout(checkProgress, 5000); // 出错后5秒再试
                }
            }
        };

        // 开始轮询
        setTimeout(checkProgress, 1000);
    },

    /**
     * 更新下载按钮进度
     * @param {Object} music
     * @param {string} plugin
     * @param {number} progress
     */
    updateDownloadButtonProgress(music, plugin, progress) {
        if (!music || !music.id || !plugin) return;

        const buttons = document.querySelectorAll(`[data-music-id="${music.id}"][data-platform="${plugin}"].download-btn, [data-music-id="${music.id}"][data-plugin="${plugin}"].download-btn`);

        buttons.forEach(btn => {
            btn.classList.add('downloading');
            // 显示进度百分比
            btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg><span style="font-size:10px;margin-left:2px;">${progress}%</span>`;
            btn.title = `下载中 ${progress}%`;
        });
    },

    /**
     * 生成文件名
     * @param {Object} music
     * @returns {string}
     */
    generateFileName(music) {
        const artist = music.artist || '未知艺术家';
        const title = music.title || '未知歌曲';
        // 清理文件名中的非法字符
        const cleanName = `${artist} - ${title}`.replace(/[<>:"\/\\|?*]/g, '_');
        return `${cleanName}.mp3`;
    },

    /**
     * 更新下载状态到服务器
     * @param {string} musicId
     * @param {string} plugin
     * @param {string} status
     * @param {number} progress
     * @param {string} filePath
     * @param {number} fileSize
     * @param {string} errorMsg
     */
    async updateDownloadStatus(musicId, plugin, status, progress, filePath, fileSize, errorMsg) {
        try {
            await fetch(`${API_BASE}/api/downloads/${musicId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    plugin: plugin,
                    status: status,
                    progress: progress,
                    filePath: filePath,
                    fileSize: fileSize,
                    errorMsg: errorMsg
                })
            });
        } catch (error) {
            // 忽略错误
        }
    },

    /**
     * 更新下载按钮状态
     * @param {Object} music
     * @param {string} plugin
     * @param {string} status - 'normal' | 'downloading' | 'downloaded'
     * @param {boolean} broadcast - 是否广播事件给其他页面（默认 true）
     */
    updateDownloadButton(music, plugin, status, broadcast = true) {
        if (!music || !music.id || !plugin) return;

        const buttons = document.querySelectorAll(`[data-music-id="${music.id}"][data-platform="${plugin}"].download-btn, [data-music-id="${music.id}"][data-plugin="${plugin}"].download-btn`);

        buttons.forEach(btn => {
            // 移除所有状态类
            btn.classList.remove('downloading', 'downloaded');

            switch (status) {
                case 'downloading':
                    btn.classList.add('downloading');
                    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>`;
                    btn.title = '下载中...';
                    break;
                case 'downloaded':
                    btn.classList.add('downloaded');
                    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;
                    btn.title = '已下载';
                    break;
                default:
                    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;
                    btn.title = '下载';
            }
        });

        // 同步到 StateManager（如果可用）
        if (window.StateManager) {
            StateManager.setDownloadStatus(music.id, plugin, status, broadcast);
        }

        // 广播事件给其他页面同步更新
        if (broadcast) {
            window.dispatchEvent(new CustomEvent('download:statusChanged', {
                detail: { musicId: music.id, plugin, status }
            }));
        }
    },

    /**
     * 根据 key 更新下载按钮状态（用于接收广播事件）
     * @param {string} musicId
     * @param {string} plugin
     * @param {string} status
     */
    updateDownloadButtonByKey(musicId, plugin, status) {
        if (!musicId || !plugin) return;

        const key = `${musicId}_${plugin}`;

        // 更新缓存状态
        if (status === 'downloaded') {
            this.downloadedCache.add(key);
            this.downloadingCache.delete(key);
        } else if (status === 'downloading') {
            this.downloadingCache.add(key);
            this.downloadedCache.delete(key);
        } else {
            this.downloadedCache.delete(key);
            this.downloadingCache.delete(key);
        }

        // 更新按钮 UI（不广播，避免循环）
        const buttons = document.querySelectorAll(`[data-music-id="${musicId}"][data-platform="${plugin}"].download-btn, [data-music-id="${musicId}"][data-plugin="${plugin}"].download-btn`);

        buttons.forEach(btn => {
            btn.classList.remove('downloading', 'downloaded');

            // 判断按钮类型，使用不同大小的图标
            const isPlayerBtn = btn.id === 'player-download-btn' || btn.id === 'detail-download-btn';
            const iconSize = isPlayerBtn ? 24 : 16;

            switch (status) {
                case 'downloading':
                    btn.classList.add('downloading');
                    btn.innerHTML = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>`;
                    btn.title = '下载中...';
                    break;
                case 'downloaded':
                    btn.classList.add('downloaded');
                    btn.innerHTML = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;
                    btn.title = '已下载';
                    break;
                default:
                    btn.innerHTML = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;
                    btn.title = '下载';
            }
        });
    },

    /**
     * 更新所有下载按钮状态
     */
    updateAllDownloadButtons() {
        // 更新已下载的按钮
        this.downloadedCache.forEach(key => {
            const [musicId, plugin] = key.split('_');
            const buttons = document.querySelectorAll(`[data-music-id="${musicId}"][data-platform="${plugin}"].download-btn, [data-music-id="${musicId}"][data-plugin="${plugin}"].download-btn`);
            buttons.forEach(btn => {
                btn.classList.add('downloaded');
                const isPlayerBtn = btn.id === 'player-download-btn' || btn.id === 'detail-download-btn';
                const iconSize = isPlayerBtn ? 24 : 16;
                btn.innerHTML = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;
                btn.title = '已下载';
            });
        });

        // 更新正在下载的按钮
        this.downloadingCache.forEach(key => {
            const [musicId, plugin] = key.split('_');
            const buttons = document.querySelectorAll(`[data-music-id="${musicId}"][data-platform="${plugin}"].download-btn, [data-music-id="${musicId}"][data-plugin="${plugin}"].download-btn`);
            buttons.forEach(btn => {
                btn.classList.add('downloading');
                const isPlayerBtn = btn.id === 'player-download-btn' || btn.id === 'detail-download-btn';
                const iconSize = isPlayerBtn ? 24 : 16;
                btn.innerHTML = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>`;
                btn.title = '下载中...';
            });
        });
    },

    /**
     * 检查下载进度
     */
    async checkProgress() {
        // 如果有正在下载的任务，刷新列表
        if (this.downloadingCache.size > 0) {
            if (typeof refreshDownloadLists === 'function') {
                await refreshDownloadLists();
            }
        }
    }
};

// 导出到全局
window.DownloadManager = DownloadManager;

// ==================== 下载管理 ====================

// 当前选中的标签页
let _currentDownloadTab = 'downloaded';

// 定时刷新定时器
let downloadRefreshInterval = null;

// 文件存在性检查缓存（避免频繁检查）
let fileExistenceCache = new Map();
let lastFileCheckTime = 0;
const FILE_CHECK_INTERVAL = 60000; // 每60秒才检查一次文件存在性
// 已下载列表数据指纹：5s 定时刷新时内容无变化则跳过表格重建（否则勾选/滚动位置反复丢失）
let lastCompletedFingerprint = '';

/**
 * 启动定时刷新
 */
function startDownloadRefreshInterval() {
    // 清除已有的定时器
    if (downloadRefreshInterval) {
        clearInterval(downloadRefreshInterval);
    }
    // 每5秒刷新一次下载列表，以显示订阅下载等后端任务的进度
    downloadRefreshInterval = setInterval(async () => {
        const container = document.getElementById('page-download');
        // 只在下载页面可见时刷新
        if (container && container.closest('.page.active')) {
            await refreshDownloadLists();
        }
    }, 5000);
}

/**
 * 停止定时刷新
 */
function stopDownloadRefreshInterval() {
    if (downloadRefreshInterval) {
        clearInterval(downloadRefreshInterval);
        downloadRefreshInterval = null;
    }
}

/**
 * 加载下载任务列表
 */
async function loadDownloads() {
    const container = document.getElementById('page-download');
    if (!container) return;

    // 启动定时刷新（以捕获订阅下载等后端任务）
    startDownloadRefreshInterval();

    // 如果已经渲染了标签页结构，只刷新列表内容
    if (container.querySelector('.downloads-tabs')) {
        await refreshDownloadLists();
        return;
    }

    // 首次加载，渲染完整结构
    container.innerHTML = `
        <div class="downloads-header">
            <div class="downloads-tabs">
                <button class="tab-btn active" data-tab="downloaded" onclick="switchDownloadTab('downloaded')">已下载</button>
                <button class="tab-btn" data-tab="recent" onclick="switchDownloadTab('recent')">刚完成</button>
                <button class="tab-btn" data-tab="downloading" onclick="switchDownloadTab('downloading')">下载中</button>
            </div>
            <div class="downloads-actions">
                <button class="action-btn" id="download-pause-btn" onclick="togglePauseAllDownloads()" style="display: none;">暂停全部</button>
                <button class="action-btn clear-btn" id="clear-downloading-btn" onclick="clearDownloadingList()" title="清空任务" style="display: none;">清空</button>
                <button class="action-btn clear-btn" id="clear-downloaded-btn" onclick="clearDownloadedRecordsAll()" title="清空记录" style="display: none;">清空</button>
            </div>
        </div>
        <div class="downloads-content">
            <div class="tab-content active" id="downloaded-tab">
                <div id="downloaded-list" class="downloads-list">
                    <div class="loading"><div class="spinner"></div></div>
                </div>
            </div>
            <div class="tab-content" id="recent-tab">
                <div id="recent-list" class="downloads-list">
                    <div class="loading"><div class="spinner"></div></div>
                </div>
            </div>
            <div class="tab-content" id="downloading-tab">
                <div id="downloading-list" class="downloads-list">
                    <div class="loading"><div class="spinner"></div></div>
                </div>
            </div>
        </div>
    `;

    await refreshDownloadLists();
}

/**
 * 确保页头控件存在（自愈：页头由旧版代码生成时补齐「暂停全部」按钮与「⋯」菜单）
 */
function ensureDownloadHeaderControls() {
    const actions = document.querySelector('.downloads-actions');
    if (!actions) return;
    // 「暂停全部」按钮
    if (!document.getElementById('download-pause-btn')) {
        const btn = document.createElement('button');
        btn.id = 'download-pause-btn';
        btn.className = 'action-btn';
        btn.textContent = '暂停全部';
        btn.style.display = 'none';
        btn.addEventListener('click', togglePauseAllDownloads);
        actions.insertBefore(btn, actions.firstChild);
    }
    // 「清空记录」按钮（仅已下载标签用）
    if (!document.getElementById('clear-downloaded-btn')) {
        const btn = document.createElement('button');
        btn.id = 'clear-downloaded-btn';
        btn.className = 'action-btn clear-btn';
        btn.title = '清空记录';
        btn.textContent = '清空';
        btn.style.display = 'none';
        btn.addEventListener('click', clearDownloadedRecordsAll);
        actions.appendChild(btn);
    }
}

/**
 * 刷新下载列表
 */
async function refreshDownloadLists(_immediate = false) {
    try {
        // 自愈：补齐可能缺失的页头控件（暂停/清空按钮）
        ensureDownloadHeaderControls();
        const response = await fetch(`${API_BASE}/api/downloads`);
        const result = await response.json();

        const downloadedList = document.getElementById('downloaded-list');
        const downloadingList = document.getElementById('downloading-list');
        const recentList = document.getElementById('recent-list');

        // 渲染最近完成任务（不管服务端返回什么）
        if (recentList) {
            renderRecentDownloads(recentList);
        }

        if (result.success && result.data) {
            const completedDownloads = result.data.filter(item => item.status === 'completed');
            const activeDownloads = result.data.filter(item => item.status !== 'completed');

            // 保存到全局供播放使用
            window.currentDownloadedList = completedDownloads.map(item => {
                return {
                    ...item,
                    id: String(item.id),
                    platform: item.plugin,
                    plugin: item.plugin,
                    filePath: item.filePath  // 确保 filePath 被保留
                };
            });

            // ⚠️ 顺序很重要：必须先渲染「下载中」，再渲染「已下载」。
            // 「已下载」要逐条 HEAD 校验文件是否存在（网络 IO，见 renderDownloadedSongs → markFileStatus），
            // 一旦某次请求长时间不返回，后面的代码就永远轮不到执行——「下载中」会一直停在初始 loading
            // 转圈（订阅批量下载的任务就是这样看不到的）。
            if (downloadingList) {
                if (activeDownloads.length > 0) {
                    renderDownloadItems(activeDownloads, downloadingList);
                } else {
                    downloadingList.innerHTML = `
                        <div class="empty-state">
                            <div class="empty-icon">⏳</div>
                            <div class="empty-text">暂无下载任务</div>
                            <div class="empty-subtext">当前没有正在下载的歌曲</div>
                        </div>
                    `;
                    updatePauseAllButton([]);
                }
            }

            if (downloadedList) {
                // 指纹去重：已完成列表内容无变化时跳过重渲染（5s 定时刷新不再反复重建表格）
                const completedFp = completedDownloads.map(item => `${item.id}:${item.status}`).join('|');
                if (completedDownloads.length > 0) {
                    if (completedFp !== lastCompletedFingerprint || !downloadedList.querySelector('table')) {
                        lastCompletedFingerprint = completedFp;
                        await renderDownloadedSongs(completedDownloads, downloadedList);
                    }
                } else {
                    lastCompletedFingerprint = '';
                    downloadedList.innerHTML = `
                        <div class="empty-state">
                            <div class="empty-icon">⬇️</div>
                            <div class="empty-text">暂无已下载歌曲</div>
                            <div class="empty-subtext">您下载的歌曲将显示在这里</div>
                        </div>
                    `;
                }
            }
        } else {
            if (downloadedList) {
                downloadedList.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-icon">⬇️</div>
                        <div class="empty-text">暂无已下载歌曲</div>
                        <div class="empty-subtext">您下载的歌曲将显示在这里</div>
                    </div>
                `;
            }
            if (downloadingList) {
                downloadingList.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-icon">⏳</div>
                        <div class="empty-text">暂无下载任务</div>
                        <div class="empty-subtext">当前没有正在下载的歌曲</div>
                    </div>
                `;
            }
        }
    } catch (error) {
        const downloadedList = document.getElementById('downloaded-list');
        const downloadingList = document.getElementById('downloading-list');
        const errorHtml = `
            <div class="empty-state">
                <div class="empty-icon">❌</div>
                <div class="empty-text">加载失败</div>
                <div class="empty-subtext">${escapeHtml(error.message)}</div>
            </div>
        `;
        if (downloadedList) downloadedList.innerHTML = errorHtml;
        if (downloadingList) downloadingList.innerHTML = errorHtml;
    }
}

/**
 * 检查下载文件是否存在
 * @param {string} filePath - 文件路径
 * @returns {Promise<boolean>}
 */
async function checkDownloadFileExists(filePath) {
    if (!filePath) return false;
    let timer = null;
    try {
        const fullUrl = filePath.startsWith('http') ? filePath : `${API_BASE}${filePath}`;
        // 必须带超时：本函数在「已下载」渲染里逐条串行调用，某次请求悬挂会拖死整轮刷新
        // （「下载中」列表会因此一直转圈）
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(fullUrl, { method: 'HEAD', signal: controller.signal });
        return response.ok;
    } catch (error) {
        return false;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * 检查下载文件状态（仅标记，不删除数据库记录，带缓存）
 * @param {Array} songs - 歌曲列表
 * @returns {Promise<Array>} 处理后的歌曲列表
 */
async function markFileStatus(songs) {
    const now = Date.now();
    const shouldCheckFiles = now - lastFileCheckTime > FILE_CHECK_INTERVAL;

    for (const song of songs) {
        if (song.filePath) {
            const cacheKey = song.filePath;
            // 如果在缓存有效期内，使用缓存结果
            if (!shouldCheckFiles && fileExistenceCache.has(cacheKey)) {
                song.fileExists = fileExistenceCache.get(cacheKey);
            } else {
                // 否则重新检查并更新缓存
                song.fileExists = await checkDownloadFileExists(song.filePath);
                fileExistenceCache.set(cacheKey, song.fileExists);
            }
        } else {
            song.fileExists = false;
        }
    }

    if (shouldCheckFiles) {
        lastFileCheckTime = now;
    }

    return songs;
}

// 分页状态：当前页（1 起）；每页条数用全局偏好（song-table.js 的 getSongTablePageSize）
let downloadPage = 1;

/**
 * 渲染已下载歌曲列表（使用 SongTable 组件）
 * @param {Array} songs - 已下载的歌曲列表
 * @param {HTMLElement} container
 */
async function renderDownloadedSongs(songs, container) {
    if (typeof SongTable === 'undefined') {
        return;
    }

    // 标记文件状态（不删除数据库记录）
    const songsWithStatus = await markFileStatus(songs);

    // 转换数据格式
    const tableSongs = songsWithStatus.map((item, index) => {
        const id = item.songId && item.songId !== 'undefined' ? item.songId :
                   (item.id && item.id !== 'undefined' ? item.id : null);
        return {
            ...item,
            id: id,
            platform: item.plugin,
            plugin: item.plugin,
            _downloadIndex: index
        };
    });

    // 存储到全局
    window.currentDownloadedList = tableSongs;
    const hasSongs = tableSongs && tableSongs.length > 0;
    downloadLastRaw = songs;

    // 与本地音乐单曲视图一致：无按钮条、无分页；操作收进页头「⋯」菜单；
    // 管理模式（页头「⋯」→「管理」）出现勾选列与操作条
    const manage = downloadManageMode;
    let renderContainer = container;
    if (manage) {
        const n = (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs)
            ? (SongTable.getSelectedSongs('download') || []).length : 0;
        container.innerHTML = `
            <div class="media-card-toolbar">
                <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                    <span style="font-size: 13px; color: var(--text-secondary);"><span style="margin-right: 8px;">💡</span>勾选歌曲后点右侧按钮</span>
                </div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                    <button class="btn btn-secondary btn-sm" onclick="downloadManageAdd()">歌单${n ? ` (${n})` : ''}</button>
                    <button class="btn btn-danger btn-sm" onclick="downloadManageClear()">清空记录${n ? ` (${n})` : ''}</button>
                    <button class="btn btn-secondary btn-sm" onclick="toggleDownloadManageMode()">完成</button>
                </div>
            </div>
            <div id="download-manage-table"></div>`;
        renderContainer = document.getElementById('download-manage-table') || container;
    }

    SongTable.render({
        container: renderContainer,
        pageId: 'download',
        title: '',
        subtitle: '',
        songs: tableSongs,
        indexOffset: 0,
        showHeader: false,
        // 纯展示列表：无封面、无行尾「⋯」菜单、无「本地 ✓」徽标；管理模式在行首出现勾选列
        columns: manage
            ? ['checkbox', 'index', 'title', 'artist', 'album', 'duration', 'source']
            : ['index', 'title', 'artist', 'album', 'duration', 'source'],
        showLocalBadge: false,
        actions: [],
        events: {
            onPlay: (song, index) => playDownloadedByIndex(index),
            onSelectChange: (selectedIndices) => {
                const el = document.querySelector('[data-page-id="download"]');
                if (el) {
                    el.querySelectorAll('tbody tr').forEach((row, idx) => {
                        row.classList.toggle('selected', selectedIndices.includes(idx));
                    });
                }
            }
        }
    });
}

/**
 * 更新「暂停全部/恢复全部」按钮文字（根据当前任务状态）
 * @param {Array} activeDownloads - 进行中的下载任务
 */
function updatePauseAllButton(activeDownloads) {
    const btn = document.getElementById('download-pause-btn');
    if (!btn) return;
    const hasQueued = (activeDownloads || []).some(d => d.status === 'queued');
    const hasPaused = (activeDownloads || []).some(d => d.status === 'paused');
    btn.textContent = hasQueued ? '暂停全部' : (hasPaused ? '恢复全部' : '暂停全部');
}

/**
 * 暂停全部 / 恢复全部下载任务：
 * 有排队中任务 → 全部标记 paused；否则把 paused 任务恢复为 queued
 */
async function togglePauseAllDownloads() {
    try {
        const resp = await fetch(`${API_BASE}/api/downloads`);
        const result = await resp.json();
        if (!result.success || !result.data) {
            showToast('获取下载任务失败', 'error');
            return;
        }
        const active = result.data.filter(item => item.status !== 'completed');
        const target = active.some(d => d.status === 'queued') ? 'paused' : 'queued';
        const list = active.filter(d => d.status === 'queued' || d.status === 'paused');
        if (!list.length) {
            showToast('没有可暂停/恢复的任务', 'warning');
            return;
        }
        let ok = 0;
        for (const d of list) {
            const musicId = d.songId || d.id;
            if (!musicId || !d.plugin) continue;
            try {
                const r2 = await fetch(`${API_BASE}/api/downloads/${encodeURIComponent(musicId)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ plugin: d.plugin, status: target })
                });
                const j = await r2.json();
                if (j && j.success) ok++;
            } catch (e) { /* 单条失败继续 */ }
        }
        showToast(target === 'paused' ? `已暂停 ${ok} 个下载任务` : `已恢复 ${ok} 个下载任务`, ok ? 'success' : 'warning');
        await refreshDownloadLists();
    } catch (e) {
        showToast('操作失败: ' + (e && e.message), 'error');
    }
}

// ==================== 下载页管理模式与页头「⋯」菜单 ====================

// 已下载列表管理模式（页头「⋯」→「管理」）
let downloadManageMode = false;
// 最近一次原始下载数据（切换管理模式重渲染用）
let downloadLastRaw = null;

/** 切换已下载列表管理模式（出现勾选列与操作条） */
function toggleDownloadManageMode() {
    downloadManageMode = !downloadManageMode;
    if (downloadLastRaw) {
        const listEl = document.getElementById('downloaded-list');
        if (listEl) renderDownloadedSongs(downloadLastRaw, listEl);
    }
}

/** 已下载歌曲加入歌单（优先勾选，未勾选时全部） */
function downloadManageAdd() {
    const sel = (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs)
        ? (SongTable.getSelectedSongs('download') || []) : [];
    const list = sel.length ? sel : (window.currentDownloadedList || []);
    if (!list.length) {
        showToast('当前列表没有歌曲', 'warning');
        return;
    }
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal(list, '下载记录');
    } else {
        showToast('添加歌单功能未加载', 'error');
    }
}

/** 清空全部下载记录（带确认；仅清记录不删文件） */
function clearDownloadedRecordsAll() {
    if (!window.confirm('确定清空所有下载记录吗？（仅清除记录，不会删除已下载的文件）')) return;
    clearDownloadedList();
}

/** 清除勾选的下载记录（带确认；记录与本地文件一并删除） */
function downloadManageClear() {
    const sel = (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs)
        ? (SongTable.getSelectedSongs('download') || []) : [];
    if (!sel.length) {
        showToast('请先勾选要清除的歌曲', 'warning');
        return;
    }
    if (!window.confirm(`确定清除选中的 ${sel.length} 条下载记录吗？\n对应本地文件也将一并删除且不可恢复。`)) return;
    clearDownloadedList(sel);
}

/**
 * 强制重新下载歌曲
 * @param {Object} song - 歌曲对象
 */
async function reDownloadSong(song) {
    if (!song || !song.id || !song.plugin) {
        showToast('歌曲信息不完整，无法重新下载', 'error');
        return;
    }

    try {
        showToast(`正在重新下载「${song.title}」...`, 'info');

        // 调用后端 API 强制重新下载
        const response = await fetch(`${API_BASE}/api/downloads/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                musicId: song.id,
                plugin: song.plugin,
                quality: song.quality || 'standard',
                music: {
                    id: song.id,
                    title: song.title,
                    artist: song.artist,
                    album: song.album,
                    artwork: song.artwork
                },
                source: 'download-retry',
                force: true  // 强制重新下载
            })
        });

        const result = await response.json();

        if (result.success) {
            showToast(`「${song.title}」重新下载任务已添加`, 'success');
            // 刷新下载列表
            refreshDownloadLists();
        } else {
            showToast(result.error || '重新下载失败', 'error');
        }
    } catch (error) {
        showToast(`重新下载失败: ${error.message}`, 'error');
    }
}

/**
 * 生成下载文件路径（根据歌曲信息动态生成）
 * @param {Object} song - 歌曲对象
 * @returns {string} 文件路径
 */
function generateDownloadFilePath(song) {
    if (!song || !song.title) return null;
    const fileName = `${song.title} - ${song.artist || 'Unknown'}.mp3`.replace(/[\\/:*?"<>|]/g, '_');
    return `/downloads/${fileName}`;
}

/**
 * 播放指定索引的已下载歌曲
 * @param {number} index - 歌曲索引
 */
async function playDownloadedByIndex(index) {
    const songs = window.currentDownloadedList || [];
    const song = songs[index];
    if (!song) return;

    // 确保歌曲有 plugin 字段
    if (!song.plugin && song.platform) {
        song.plugin = song.platform;
    }

    // 如果没有 filePath，动态生成
    if (!song.filePath) {
        song.filePath = generateDownloadFilePath(song);
    }

    // 检查歌曲是否有播放所需信息（下载的歌曲需要 filePath 或 id）
    const canPlay = song.filePath || song.id;

    if (!canPlay) {
        showToast('歌曲信息不完整，无法播放', 'error');
        return;
    }

    // 设置当前页面列表为已下载列表
    setCurrentPageMusicList(songs);

    // 播放歌曲
    playMusic(index);
}

/**
 * 播放所有已下载歌曲（无选中则播放全部）
 */
function playAllDownloaded() {
    const allSongs = window.currentDownloadedList || [];

    if (allSongs.length === 0) {
        showToast('没有可播放的歌曲', 'warning');
        return;
    }

    // 使用 MusicList.getSelectedSongs 获取选中的歌曲（如果可用）
    let songs = [];
    if (typeof MusicList !== 'undefined' && MusicList.getSelectedSongs) {
        songs = MusicList.getSelectedSongs('download');
    }

    // 没有选中时播放全部
    if (songs.length === 0) {
        songs = allSongs;
    }

    if (songs.length === 0) {
        showToast('没有可播放的歌曲', 'warning');
        return;
    }

    // 为所有歌曲生成 filePath（如果没有）
    allSongs.forEach(song => {
        if (!song.filePath) {
            song.filePath = generateDownloadFilePath(song);
        }
    });

    // 设置当前页面列表为已下载列表（使用 setCurrentPageMusicList 确保正确引用）
    setCurrentPageMusicList(allSongs);

    // 播放第一首
    playMusic(0);

    const msg = (typeof MusicList !== 'undefined' && MusicList.getSelectedSongs && MusicList.getSelectedSongs('download').length > 0)
        ? `开始播放选中的 ${songs.length} 首歌曲`
        : `开始播放 ${songs.length} 首歌曲`;
    showToast(msg, 'success');
}

/**
 * 获取选中的歌曲
 * @returns {Array} 选中的歌曲列表
 */
function getDownloadSelectedSongs() {
    // 优先使用 MusicList 组件的获取选中歌曲方法
    if (typeof MusicList !== 'undefined' && MusicList.getSelectedSongs) {
        return MusicList.getSelectedSongs('download');
    }
    // 兼容旧版 MusicTable
    if (typeof MusicTable !== 'undefined' && MusicTable.getSelectedSongs) {
        return MusicTable.getSelectedSongs();
    }
    return [];
}

/**
 * 获取当前页面显示的所有歌曲
 * @returns {Array} 所有歌曲列表
 */
function getDownloadCurrentSongs() {
    return window.currentDownloadedList || [];
}

/**
 * 添加选中的歌曲到歌单
 * 无论是否选中歌曲，都弹出歌单选择弹窗
 */
async function _addAllDownloadedToPlaylist() {
    const selectedSongs = getDownloadSelectedSongs();
    const currentSongs = getDownloadCurrentSongs();

    // 检查是否有歌曲
    if (!currentSongs || currentSongs.length === 0) {
        showToast('当前列表没有歌曲', 'warning');
        return;
    }

    // 有选中歌曲时用选中的，否则用全部歌曲
    const songsToAdd = selectedSongs.length > 0 ? selectedSongs : currentSongs;

    // 显示添加到歌单弹窗
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal(songsToAdd, '下载管理');
    } else {
        showToast('添加歌单功能未加载', 'error');
    }
}

/**
 * 渲染下载中列表（与其他列表同款 SongTable 表格；状态/进度显示在专辑列，重试/删除收进行内「⋯」）
 * @param {Array} downloads
 * @param {HTMLElement} container
 */
function renderDownloadItems(downloads, container) {
    if (typeof SongTable === 'undefined' || !container) return;
    const tableSongs = downloads.map(item => {
        const progress = item.progress || 0;
        const statusText = getDownloadStatusText(item.status);
        return {
            ...item,
            id: item.songId || item.id,
            plugin: item.plugin,
            // 专辑列展示状态与进度（下载中项无专辑数据）
            album: `${statusText}${item.status === 'downloading' ? ` · ${progress}%` : ''}`
        };
    });
    // SongTable.render 是 async 且此处不 await：必须挂上 catch，否则渲染异常会变成
    // 「未捕获的 promise rejection」——列表会永远停在 loading 转圈，既不报错也看不到原因
    const rendering = SongTable.render({
        container,
        pageId: 'download-progress',
        title: '',
        showHeader: false,
        songs: tableSongs,
        columns: ['index', 'title', 'artist', 'album', 'source'],
        showLocalBadge: false,
        actions: [],
        rowMenu: [
            {
                label: (song) => (song && song.status === 'failed' ? '重试' : ''),
                onClick: (index) => {
                    const s = tableSongs[index];
                    if (s && s.status === 'failed') retryDownload(s.songId || s.id, s.plugin);
                }
            },
            {
                label: '删除',
                onClick: (index) => {
                    const s = tableSongs[index];
                    if (s) removeDownload(s.downloadId, s.plugin, s.songId || s.id);
                }
            }
        ],
        actions: [],
        events: {}
    });
    if (rendering && typeof rendering.catch === 'function') {
        rendering.catch((err) => {
            console.error('[download] 渲染「下载中」列表失败:', err);
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">❌</div>
                    <div class="empty-text">任务列表渲染失败</div>
                    <div class="empty-subtext">${escapeHtml((err && err.message) || '未知错误')}</div>
                </div>
            `;
        });
    }
    updatePauseAllButton(downloads);
}

/**
 * 渲染最近完成的下载任务
 * @param {HTMLElement} container - 容器元素
 */
function renderRecentDownloads(container) {
    const recentDownloads = window.recentCompletedDownloads || [];
    
    // 清理过期任务
    const now = Date.now();
    const validDownloads = recentDownloads.filter(item => now - item.completedAt < 30000);
    
    if (validDownloads.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">✨</div>
                <div class="empty-text">暂无最近完成的任务</div>
                <div class="empty-subtext">刚下载完成的歌曲会在这里显示30秒</div>
            </div>
        `;
        return;
    }
    
    container.innerHTML = validDownloads.map(item => {
        const elapsed = Math.floor((now - item.completedAt) / 1000);
        const timeText = elapsed < 5 ? '刚刚' : `${elapsed}秒前`;
        
        return `
            <div class="download-item recent-item" style="display: flex; align-items: center; gap: 12px; padding: 12px; background: var(--success-light, rgba(76, 175, 80, 0.1)); border-radius: var(--radius-md); margin-bottom: 8px; border-left: 3px solid var(--success-color, #4caf50);">
                <div class="download-icon" style="font-size: 24px;">✅</div>
                <div class="download-info" style="flex: 1; min-width: 0;">
                    <div class="download-title" style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(item.title || '未知歌曲')}</div>
                    <div class="download-artist" style="font-size: 12px; color: var(--text-tertiary);">${escapeHtml(item.artist || '未知艺术家')}</div>
                    <div style="font-size: 11px; color: var(--success-color, #4caf50); margin-top: 4px;">✓ 下载完成 · ${timeText}</div>
                </div>
                <div class="download-actions" style="display: flex; gap: 8px;">
                    <button class="action-btn btn-secondary" onclick="playDownloadedSong('${item.id}', '${item.plugin}')" title="播放" style="padding: 4px 12px; font-size: 12px;">播放</button>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * 切换下载标签页
 * @param {string} tab - 'downloaded' 或 'downloading'
 */
function switchDownloadTab(tab) {
    _currentDownloadTab = tab;

    // 更新标签按钮状态
    document.querySelectorAll('.downloads-tabs .tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // 更新内容显示
    document.querySelectorAll('.downloads-content .tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `${tab}-tab`);
    });

    // 切到「下载中」立刻刷新一次：定时刷新里「已下载」要逐条 HEAD 校验文件，可能较慢，
    // 用户点进来时先拿到一次最新任务列表，不等后续慢操作
    if (tab === 'downloading') {
        refreshDownloadLists(true);
    }

    // 切换标签页时退出管理模式
    if (tab !== 'downloaded' && downloadManageMode) {
        toggleDownloadManageMode();
    }

    // 更新按钮显示：「清空记录」仅「已下载」标签；「清空任务/暂停全部」仅「下载中」标签
    const clearDownloadedBtn = document.getElementById('clear-downloaded-btn');
    const clearDownloadingBtn = document.getElementById('clear-downloading-btn');
    if (clearDownloadedBtn) clearDownloadedBtn.style.display = tab === 'downloaded' ? 'block' : 'none';
    if (clearDownloadingBtn) clearDownloadingBtn.style.display = tab === 'downloading' ? 'block' : 'none';
    const pauseBtn = document.getElementById('download-pause-btn');
    if (pauseBtn) pauseBtn.style.display = tab === 'downloading' ? 'block' : 'none';
}

/**
 * 清空已下载列表
 */
async function clearDownloadedList(selectedSongs) {
    try {
        // 勾选语义（与 recent 页一致）：传入选中歌曲 → 只清空这批（逐条 DELETE，连同本地文件）
        if (Array.isArray(selectedSongs) && selectedSongs.length > 0) {
            let deleted = 0;
            for (const song of selectedSongs) {
                // 优先用 downloadId（数据库主键）精确删除；缓存清理仍用歌曲标识
                const delId = (song.downloadId != null) ? song.downloadId : ((song.songId && song.songId !== 'undefined') ? song.songId : song.id);
                const cacheMusicId = (song.songId && song.songId !== 'undefined') ? song.songId : song.id;
                const plugin = song.plugin || song.platform;
                if (!delId || !plugin) continue;
                try {
                    const resp = await fetch(`${API_BASE}/api/downloads/${encodeURIComponent(delId)}?plugin=${encodeURIComponent(plugin)}`, { method: 'DELETE' });
                    const r = await resp.json();
                    if (r && r.success) {
                        deleted++;
                        if (window.StateManager) StateManager.setDownloadStatus(cacheMusicId, plugin, 'normal', true);
                    }
                } catch (e) {
                    console.warn('删除下载记录失败:', delId, e);
                }
            }
            showToast(`已清空 ${deleted} 条下载记录`, 'success');
            DownloadManager.updateAllDownloadButtons();
            await refreshDownloadLists();
            return;
        }

        // 获取当前已下载列表，用于后续广播状态变化
        const downloadedKeys = Array.from(DownloadManager.downloadedCache);

        const response = await fetch(`${API_BASE}/api/downloads/clear-completed`, {
            method: 'POST'
        });

        const result = await response.json();

        if (result.success) {
            showToast('已清空已下载列表', 'success');

            // 广播状态变化为 'normal'
            if (window.StateManager) {
                downloadedKeys.forEach(key => {
                    const parts = key.split('_');
                    const plugin = parts.pop(); // 最后一个元素是 plugin
                    const musicId = parts.join('_'); // 其余的是 musicId（可能包含下划线）
                    if (musicId && plugin) {
                        StateManager.setDownloadStatus(musicId, plugin, 'normal', true);
                    }
                });
            }

            // 刷新列表
            // await DownloadManager.loadDownloadedSongs(); // 不再批量加载
            DownloadManager.updateAllDownloadButtons();
            await refreshDownloadLists();
        } else {
            showToast('清空失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('清空失败: ' + error.message, 'error');
    }
}

/**
 * 清空下载中列表
 */
async function clearDownloadingList() {
    try {
        // 获取当前下载中列表，用于后续广播状态变化
        const downloadingKeys = Array.from(DownloadManager.downloadingCache);

        const response = await fetch(`${API_BASE}/api/downloads/clear-active`, {
            method: 'POST'
        });

        const result = await response.json();

        if (result.success) {
            showToast('已清空下载任务', 'success');

            // 广播状态变化为 'normal'
            if (window.StateManager) {
                downloadingKeys.forEach(key => {
                    const [musicId, plugin] = key.split('_');
                    StateManager.setDownloadStatus(musicId, plugin, 'normal', true);
                });
            }

            // 清空下载中缓存
            DownloadManager.downloadingCache.clear();
            DownloadManager.updateAllDownloadButtons();
            await refreshDownloadLists();
        } else {
            showToast('清空失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('清空失败: ' + error.message, 'error');
    }
}

/**
 * 获取下载状态文本
 * @param {string} status
 * @returns {string}
 */
function getDownloadStatusText(status) {
    const statusMap = {
        'pending': '等待中',
        'downloading': '下载中',
        'completed': '已完成',
        'failed': '失败',
        'paused': '已暂停'
    };
    return statusMap[status] || status;
}

/**
 * 删除下载任务
 * @param {string} musicId
 * @param {string} plugin
 */
async function removeDownload(musicId, plugin, songId) {
    // musicId 实际为列表项的 downloadId（数据库主键），用于精确删除记录；
    // songId 为歌曲标识（musicData.id），用于清理前端下载状态缓存
    const delId = musicId;
    const cacheKey = `${songId != null ? songId : musicId}_${plugin}`;
    try {
        const response = await fetch(`${API_BASE}/api/downloads/${delId}?plugin=${plugin}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (result.success) {
            showToast('任务已删除', 'success');
            // 从缓存中移除
            DownloadManager.downloadedCache.delete(cacheKey);
            DownloadManager.downloadingCache.delete(cacheKey);

            // 同步到 StateManager 并广播状态变化
            if (window.StateManager) {
                StateManager.setDownloadStatus(songId != null ? songId : musicId, plugin, 'normal', true);
            }

            DownloadManager.updateAllDownloadButtons();
            await refreshDownloadLists();
        } else {
            showToast('删除失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('删除失败: ' + error.message, 'error');
    }
}

/**
 * 重新下载失败的歌曲
 * @param {string} musicId - 歌曲ID
 * @param {string} plugin - 插件名称
 */
async function retryDownload(musicId, plugin) {
    try {
        // 先从当前列表中获取歌曲信息
        const response = await fetch(`${API_BASE}/api/downloads`);
        const result = await response.json();
        
        if (!result.success || !result.data) {
            showToast('获取下载列表失败', 'error');
            return;
        }

        // 找到对应的下载项
        const downloadItem = result.data.find(item => String(item.id) === String(musicId) && item.plugin === plugin);
        if (!downloadItem) {
            showToast('未找到下载记录', 'error');
            return;
        }

        // 先删除失败的记录
        const deleteResponse = await fetch(`${API_BASE}/api/downloads/${musicId}?plugin=${plugin}`, {
            method: 'DELETE'
        });
        const deleteResult = await deleteResponse.json();

        if (!deleteResponse.ok || !deleteResult.success) {
            showToast('删除失败记录失败: ' + (deleteResult.error || '未知错误'), 'error');
            return;
        }

        // 从缓存中移除
        const key = `${musicId}_${plugin}`;
        DownloadManager.downloadedCache.delete(key);
        DownloadManager.downloadingCache.delete(key);

        // 同步到 StateManager 并广播状态变化
        if (window.StateManager) {
            StateManager.setDownloadStatus(musicId, plugin, 'normal', true);
        }

        // 刷新列表
        await refreshDownloadLists();

        // 使用下载记录中的信息重新下载
        if (window.DownloadCore && typeof window.DownloadCore.download === 'function') {
            window.DownloadCore.download({
                id: downloadItem.id,
                title: downloadItem.title,
                artist: downloadItem.artist,
                plugin: plugin,
                quality: downloadItem.quality || 'standard'
            }, (status, data) => {
                console.log('[Retry Download]', status, data);
            }, 'retry-download');
            showToast('已开始重新下载: ' + downloadItem.title, 'success');
        } else {
            showToast('下载组件未就绪', 'error');
        }
    } catch (error) {
        showToast('重试下载失败: ' + error.message, 'error');
    }
}

/**
 * 清除已完成的下载
 */
async function clearCompletedDownloads() {
    await clearDownloadedList();
}

/**
 * 打开下载目录
 */
async function openDownloadFolder() {
    showToast('下载目录功能开发中', 'info');
}

/**
 * 显示确认弹窗
 * @param {Object} options - 配置选项
 */
function showConfirmModal(options) {
    const existingModal = document.getElementById('confirm-modal');
    if (existingModal) {
        existingModal.remove();
    }

    const modal = document.createElement('div');
    modal.id = 'confirm-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content" style="width: 360px; max-width: 90%;">
            <div class="modal-header">
                <h3 class="modal-title">${escapeHtml(options.title)}</h3>
                <button class="modal-close" onclick="closeConfirmModal()">&times;</button>
            </div>
            <div class="modal-body">
                <p style="margin: 0; color: var(--text-secondary);">${escapeHtml(options.message)}</p>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeConfirmModal()">${options.cancelText || '取消'}</button>
                <button class="btn ${options.confirmClass || 'btn-primary'}" onclick="handleConfirmModal()">${escapeHtml(options.confirmText)}</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // 定义全局处理函数
    window.handleConfirmModal = () => {
        closeConfirmModal();
        if (options.onConfirm) {
            options.onConfirm();
        }
    };

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeConfirmModal();
        }
    });
}

/**
 * 关闭确认弹窗
 */
function closeConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    if (modal) {
        modal.remove();
    }
    // 清理全局函数
    delete window.handleConfirmModal;
}

/**
 * 播放已下载的歌曲
 * @param {string} musicId - 歌曲ID
 * @param {string} plugin - 插件名称
 */
async function playDownloadedSong(musicId, plugin) {
    try {
        if (!window.currentDownloadedList) {
            showToast('歌曲列表未加载', 'error');
            return;
        }
        
        const song = window.currentDownloadedList.find(s => String(s.id) === String(musicId) && s.plugin === plugin);
        if (!song) {
            showToast('歌曲未找到', 'error');
            return;
        }
        
        // 触发播放
        if (window.PlayerCore && window.PlayerCore.play) {
            await window.PlayerCore.play(song);
            showToast(`开始播放: ${song.title}`, 'success');
        } else {
            showToast('播放器未就绪', 'error');
        }
    } catch (error) {
        showToast('播放失败: ' + error.message, 'error');
    }
}

// 监听下载列表更新事件（实时同步）
window.addEventListener('download:listUpdated', (_event) => {
    // 立即刷新列表（乐观更新）
    const recentList = document.getElementById('recent-list');
    if (recentList) {
        renderRecentDownloads(recentList);
    }
    
    // 如果在下载中标签页，也刷新下载中列表
    const downloadingList = document.getElementById('downloading-list');
    if (downloadingList && downloadingList.closest('.tab-content.active')) {
        refreshDownloadLists(true);
    }
});

// 定时清理最近完成任务列表（每5秒；页面在后台时跳过，避免后台标签页持续渲染/请求）
setInterval(() => {
    if (document.hidden) return;
    const recentList = document.getElementById('recent-list');
    if (recentList && recentList.closest('.tab-content.active')) {
        renderRecentDownloads(recentList);
    }
}, 5000);

// 导出函数到全局作用域
window.loadDownloads = loadDownloads;
window.refreshDownloadLists = refreshDownloadLists;
window.renderDownloadItems = renderDownloadItems;
window.togglePauseAllDownloads = togglePauseAllDownloads;
window.renderRecentDownloads = renderRecentDownloads;
window.switchDownloadTab = switchDownloadTab;
window.playDownloadedSong = playDownloadedSong;
window.clearDownloadedList = clearDownloadedList;
window.clearDownloadingList = clearDownloadingList;
window.getDownloadStatusText = getDownloadStatusText;
window.removeDownload = removeDownload;
window.retryDownload = retryDownload;
window.clearCompletedDownloads = clearCompletedDownloads;
window.startDownloadRefreshInterval = startDownloadRefreshInterval;
window.stopDownloadRefreshInterval = stopDownloadRefreshInterval;
window.openDownloadFolder = openDownloadFolder;
window.showConfirmModal = showConfirmModal;
window.closeConfirmModal = closeConfirmModal;

// 页面加载时初始化下载管理器
document.addEventListener('DOMContentLoaded', () => {
    DownloadManager.init();
});
