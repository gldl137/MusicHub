/**
 * 歌曲列表表格组件
 * 所有页面显示歌曲列表的统一组件
 */

const MusicTable = {
    // 收藏变更订阅回调
    _favoriteChangeCallback: null,

    /**
     * 渲染歌曲列表表格
     * @param {Array} musicList - 歌曲列表
     * @param {Object} options - 配置选项
     * @param {HTMLElement} container - 容器元素
     * @param {boolean} options.append - 是否追加模式
     * @param {string} options.pluginName - 当前插件名
     * @param {Function} options.onPlay - 播放回调
     * @param {Function} options.onFavorite - 收藏回调
     * @param {Function} options.onDownload - 下载回调
     */
    async render(musicList, container, options = {}) {
        const {
            append = false,
            pluginName = null,
            onPlay = null,
            onFavorite = null,
            onDownload = null
        } = options;

        const currentPluginFileName = pluginName ||
            (currentPage === 'toplist' ? currentTopListPlugin : null) ||
            (currentPage === 'recommend' ? currentRecommendPlugin : null);

        let actualPluginFileName;
        if (currentPage === 'toplist') {
            actualPluginFileName = currentTopListPlugin;
        } else if (currentPage === 'recommend') {
            actualPluginFileName = currentRecommendPlugin;
        } else {
            actualPluginFileName = currentTopListPlugin || currentRecommendPlugin;
        }

        // 先给歌曲添加 plugin 字段（如果需要）
        let processedMusicList = musicList.map(item => ({...item}));
        if (currentPage !== 'recent') {
            processedMusicList.forEach(item => {
                if (actualPluginFileName && !item.plugin && !item.platform) {
                    item.plugin = actualPluginFileName;
                }
            });
        }

        // 设置当前页面歌曲列表（会在内部规范化 ID）
        if (!append) {
            setCurrentPageMusicList(processedMusicList);
        } else {
            setCurrentPageMusicList([...getCurrentPageMusicList(), ...processedMusicList]);
        }

        const tableHtml = this.generateHTML(processedMusicList, currentPluginFileName);

        if (append) {
            const tbody = container.querySelector('tbody');
            if (tbody) {
                tbody.insertAdjacentHTML('beforeend', tableHtml.replace(/<table[^>]*>[\s\S]*?<tbody>/, '').replace(/<\/tbody>.*$/, ''));
            } else {
                container.innerHTML += tableHtml;
            }
        } else {
            container.innerHTML = tableHtml;
        }

        this.bindEvents(container, onPlay, onFavorite, onDownload);

        // 「本地 ✓」徽标：批量匹配本地曲库并标注来源列
        if (window.LocalBadge) window.LocalBadge.apply(container, processedMusicList).catch(() => {});

        // 订阅收藏状态变更
        this.subscribeToFavoriteChanges();

        // 异步检查和更新下载按钮状态
        this.syncDownloadButtons(processedMusicList);
    },

    /**
     * 同步下载按钮状态（已弃用，下载状态改为点击时实时查询）
     * @param {Array} musicList - 歌曲列表
     */
    async syncDownloadButtons(_musicList) {
        // 下载状态不再在渲染时批量同步，改为点击时实时查询
        return;

        /*
        // 优先使用新的 ButtonManager
        if (window.ButtonManager) {
            ButtonManager.updateMusicListButtons(musicList, 'download');
            return;
        }

        // 兼容旧代码
        if (!window.DownloadManager) return;

        // 先尝试从服务器加载已下载列表
        await DownloadManager.loadDownloadedSongs();

        // 更新每个歌曲的下载按钮状态
        for (const music of musicList) {
            const plugin = music.platform || music.plugin;
            if (!plugin) continue;

            const key = `${music.id}_${plugin}`;
            const isDownloaded = DownloadManager.downloadedCache.has(key);
            const isDownloading = DownloadManager.downloadingCache.has(key);

            if (isDownloaded) {
                DownloadManager.updateDownloadButtonByKey(music.id, plugin, 'downloaded');
            } else if (isDownloading) {
                DownloadManager.updateDownloadButtonByKey(music.id, plugin, 'downloading');
            }
        }
        */
    },

    /**
     * 订阅收藏状态变更
     */
    subscribeToFavoriteChanges() {
        // 优先使用 StateManager
        if (window.StateManager) {
            // 取消之前的订阅
            if (this._unsubscribeFavorite) {
                this._unsubscribeFavorite();
            }

            // 订阅收藏状态变化
            this._unsubscribeFavorite = StateManager.subscribe('favorite', ({ musicId, plugin, status }) => {
                this.syncFavoriteButtons(musicId, plugin, status);
            }, 'music-table');

            return;
        }

        // 兼容旧代码：使用 FavoriteManager 订阅
        if (window.FavoriteManager) {
            // 取消之前的订阅
            if (this._unsubscribeFavorite) {
                this._unsubscribeFavorite();
            }

            // 创建订阅回调
            this._favoriteChangeCallback = ({ musicId, platform, isFavorited }) => {
                this.syncFavoriteButtons(musicId, platform, isFavorited);
            };

            // 订阅
            FavoriteManager.subscribe('music-table', this._favoriteChangeCallback);

            // 保存取消订阅函数
            this._unsubscribeFavorite = () => {
                FavoriteManager.unsubscribe('music-table', this._favoriteChangeCallback);
            };
        }
    },

    generateHTML(musicList, currentPluginFileName) {
        return `
        <table class="music-table">
            <thead>
                <tr>
                    <th class="col-checkbox"><input type="checkbox" id="select-all" onclick="MusicTable.toggleSelectAll()"></th>
                    <th class="col-action"></th>
                    <th class="col-action"></th>
                    <th class="col-index">#</th>
                    <th class="col-title">标题</th>
                    <th class="col-artist">作者</th>
                    <th class="col-album">专辑</th>
                    <th class="col-duration">时长</th>
                    <th class="col-source">来源</th>
                </tr>
            </thead>
            <tbody>
                ${musicList.map((item, index) => this.generateRowHTML(item, index, currentPluginFileName)).join('')}
            </tbody>
        </table>
        `;
    },

    generateRowHTML(item, index, currentPluginFileName) {
        // 在收藏页面固定显示红心，其他页面检查收藏状态
        const isFav = window.currentPage === 'favorites' ? true : (window.FavoriteManager
            ? FavoriteManager.isFavoritedSync(item)
            : isSongFavoritedSync(item.id, item.platform || item.plugin));
        const favBtnClass = isFav ? 'favorited' : '';
        const favIcon = isFav
            ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
            : '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

        // 检查下载状态
        const plugin = item.platform || item.plugin || '';
        const key = `${item.id}_${plugin}`;
        let downloadBtnClass = '';
        let downloadIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
        let downloadTitle = '下载';

        if (window.DownloadCore) {
            if (window.DownloadCore.downloadedCache && window.DownloadCore.downloadedCache.has(key)) {
                downloadBtnClass = 'downloaded';
                downloadIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
                downloadTitle = '已下载';
            } else if (window.DownloadCore.downloadingCache && window.DownloadCore.downloadingCache.has(key)) {
                downloadBtnClass = 'downloading';
                downloadIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>';
                downloadTitle = '下载中...';
            }
        }

        return `
        <tr class="music-row ${currentMusic && currentMusic.id === item.id ? 'playing' : ''} ${index % 2 === 1 ? 'even' : ''}"
            data-music-id="${escapeHtml(item.id)}"
            data-platform="${escapeHtml(item.platform || item.plugin || '')}"
            data-index="${index}">
            <td class="col-checkbox" onclick="event.stopPropagation();">
                <input type="checkbox" class="row-checkbox" data-index="${index}" data-id="${escapeHtml(item.id)}">
            </td>
            <td class="col-action">
                <button class="detail-extra-btn music-row-btn fav-btn ${favBtnClass}"
                        data-music-id="${escapeHtml(item.id)}"
                        data-platform="${escapeHtml(item.platform || item.plugin || '')}"
                        data-index="${index}"
                        onclick="event.stopPropagation();"
                        title="${isFav ? '取消收藏' : '收藏'}">
                    ${favIcon}
                </button>
            </td>
            <td class="col-action">
                <button class="detail-extra-btn music-row-btn download-btn ${downloadBtnClass}"
                        data-music-id="${escapeHtml(item.id)}"
                        data-platform="${escapeHtml(item.platform || item.plugin || '')}"
                        data-index="${index}"
                        onclick="event.stopPropagation();"
                        title="${downloadTitle}">
                    ${downloadIcon}
                </button>
            </td>
            <td class="col-index">${index + 1}</td>
            <td class="col-title">
                <div class="music-title-cell">
                    <span class="music-title-text">${escapeHtml(item.title)}</span>
                </div>
            </td>
            <td class="col-artist">${escapeHtml(item.artist || '未知艺术家')}</td>
            <td class="col-album">${escapeHtml(item.album || '未知专辑')}</td>
            <td class="col-duration">${formatDuration(item.duration)}</td>
            <td class="col-source">
                <span class="source-tag" title="${escapeHtml(getDisplaySource(item) || getMusicSourceText(item.platform || item.plugin || currentPluginFileName))}">${escapeHtml(getDisplaySource(item) || getMusicSourceText(item.platform || item.plugin || currentPluginFileName))}</span>
            </td>
        </tr>
        `;
    },

    bindEvents(container, onPlay, onFavorite, onDownload) {
        const rows = container.querySelectorAll('.music-row');
        rows.forEach(row => {
            row.addEventListener('click', () => {
                const index = parseInt(row.dataset.index);
                if (onPlay) {
                    onPlay(index);
                } else {
                    playMusic(index);
                }
            });
        });

        const favBtns = container.querySelectorAll('.fav-btn');
        favBtns.forEach(btn => {
            btn.addEventListener('click', async () => {
                const index = parseInt(btn.dataset.index);
                if (onFavorite) {
                    await onFavorite(index, btn);
                } else {
                    await this.handleToggleFavorite(btn, index);
                }
            });
        });

        const downloadBtns = container.querySelectorAll('.download-btn');
        downloadBtns.forEach(btn => {
            btn.addEventListener('click', async () => {
                const index = parseInt(btn.dataset.index);
                if (onDownload) {
                    await onDownload(index);
                } else {
                    await this.handleDownload(index);
                }
            });
        });
    },

    toggleSelectAll() {
        const selectAllCheckbox = document.getElementById('select-all');
        const rowCheckboxes = document.querySelectorAll('.row-checkbox');
        rowCheckboxes.forEach(checkbox => {
            checkbox.checked = selectAllCheckbox.checked;
        });
    },

    async handleToggleFavorite(btn, index) {
        const musicList = getCurrentPageMusicList();
        const music = musicList[index];
        if (!music) return;

        const isFav = await toggleFavoriteSong(music);
        this.updateFavoriteButton(btn, isFav);
        showToast(isFav ? '已添加到收藏' : '已取消收藏', 'success');

        if (currentPage === 'favorites') {
            loadFavorites();
        }
    },

    async handleDownload(index) {
        const musicList = getCurrentPageMusicList();
        const music = musicList[index];
        if (!music) return;

        const plugin = music.platform || music.plugin;
        if (!plugin) {
            showToast('无法确定歌曲来源', 'error');
            return;
        }

        // 实时查询数据库检查是否已下载
        try {
            if (window.StateManager?.isDownloaded) {
                const isDownloaded = await window.StateManager.isDownloaded(music.id, plugin);
                if (isDownloaded) {
                    showToast('该歌曲已下载', 'info');
                    return;
                }
            }
        } catch (e) {
            console.error('检查下载状态失败:', e);
        }

        if (window.DownloadCore) {
            await window.DownloadCore.startBackendDownload(music, 'music-table-下载');
        }
    },

    async handleAddToPlaylist(index) {
        const musicList = getCurrentPageMusicList();
        const music = musicList[index];
        if (!music) return;

        // 添加到播放列表
        addToPlaylist([music]);
        showToast(`已添加 "${music.title}" 到播放列表`, 'success');
    },

    updateFavoriteButton(btn, isFav) {
        if (!btn) return;

        if (isFav) {
            btn.classList.add('favorited');
            btn.title = '取消收藏';
            btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
        } else {
            btn.classList.remove('favorited');
            btn.title = '收藏';
            btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
        }
    },

    syncFavoriteButtons(musicId, platform, isFav) {
        document.querySelectorAll(`.fav-btn[data-music-id="${CSS.escape(musicId)}"]`).forEach(btn => {
            this.updateFavoriteButton(btn, isFav);
        });

        const playerLikeBtn = document.getElementById('player-like-btn');
        if (playerLikeBtn && window.currentMusic && window.currentMusic.id === musicId) {
            this.updatePlayerLikeButton(isFav);
        }
    },

    updatePlayerLikeButton(isFav) {
        const likeBtn = document.getElementById('player-like-btn');
        if (!likeBtn) return;

        if (isFav) {
            likeBtn.classList.add('active');
            likeBtn.style.color = '#ff4757';
        } else {
            likeBtn.classList.remove('active');
            likeBtn.style.color = '';
        }
    },

    /**
     * 获取当前选中的歌曲
     * @returns {Array} 选中的歌曲列表
     */
    getSelectedSongs() {
        const selectedCheckboxes = document.querySelectorAll('.row-checkbox:checked');
        const selectedSongs = [];

        selectedCheckboxes.forEach(checkbox => {
            const index = parseInt(checkbox.dataset.index);
            const songs = getCurrentPageMusicList();
            if (songs && songs[index]) {
                selectedSongs.push(songs[index]);
            }
        });

        return selectedSongs;
    },

    /**
     * 获取当前页面显示的所有歌曲
     * @returns {Array} 所有歌曲列表
     */
    getCurrentSongs() {
        return getCurrentPageMusicList() || [];
    },

    /**
     * 清空选中状态
     */
    clearSelection() {
        const checkboxes = document.querySelectorAll('.row-checkbox');
        checkboxes.forEach(checkbox => {
            checkbox.checked = false;
        });
        const selectAllCheckbox = document.getElementById('select-all');
        if (selectAllCheckbox) {
            selectAllCheckbox.checked = false;
        }
    }
};

window.MusicTable = MusicTable;
