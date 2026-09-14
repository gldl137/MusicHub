/**
 * 音乐列表组件
 * 通用音乐列表渲染，支持收藏、最近播放等页面复用
 */

const MusicList = {
    // 收藏变更订阅回调
    _favoriteChangeCallback: null,

    /**
     * 渲染音乐列表
     * @param {Array} songs - 歌曲数组
     * @param {HTMLElement} container - 容器元素
     * @param {Object} options - 配置选项
     * @param {string} options.pageId - 页面ID (如 'recent', 'favorites')
     * @param {boolean} options.showFavorite - 是否显示收藏按钮
     * @param {boolean} options.showDownload - 是否显示下载按钮
     * @param {boolean} options.allFavorited - 是否全部已收藏（收藏页面用）
     * @param {Array} options.actions - 顶部操作按钮配置
     */
    render(songs, container, options = {}) {
        const {
            pageId = 'music-list',
            showFavorite = true,
            showDownload = true,
            allFavorited = false,
            actions = []
        } = options;

        // 构建操作按钮HTML
        const actionsHtml = actions.map(btn => {
            const bgStyle = btn.primary
                ? 'background: var(--primary-color); color: white; border: none;'
                : 'background: var(--surface-color); color: var(--text-color); border: 1px solid var(--border-color);';
            return `
            <button class="btn ${btn.primary ? 'btn-primary' : 'btn-secondary'}" onclick="${btn.onclick}" title="${btn.title}" style="display: flex; align-items: center; gap: 4px; padding: 3px 14px; border-radius: 16px; font-size: 12px; ${bgStyle} cursor: pointer;">
                <span style="display: flex; align-items: center;">${btn.icon}</span> ${btn.text}
            </button>
        `}).join('');

        // 构建一个完整的表格（表头 + 数据）
        let html = `
            <div class="music-list-wrapper" style="display: flex; flex-direction: column; height: 100%;">
                <div class="toplist-actions" style="display: flex; gap: 12px; margin-bottom: 16px; padding: 0 4px; flex-shrink: 0;">
                    ${actionsHtml}
                </div>
                <div class="music-list-body" style="overflow-y: auto; flex: 1; min-height: 0;">
                    <table class="music-table" style="width: 100%;">
                        <thead>
                            <tr>
                                <th class="col-checkbox"><input type="checkbox" id="select-all" onclick="MusicList.toggleSelectAll('${pageId}')"></th>
                                ${showFavorite ? '<th class="col-action"></th>' : ''}
                                ${showDownload ? '<th class="col-action"></th>' : ''}
                                <th class="col-index">#</th>
                                <th class="col-title">标题</th>
                                <th class="col-artist">作者</th>
                                <th class="col-album">专辑</th>
                                <th class="col-duration">时长</th>
                                <th class="col-source">来源</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        // 渲染歌曲列表
        songs.forEach((item, index) => {
            // 来源名统一走取名逻辑：落雪（lx:xx）等非 MusicFree 插件来源也能正确显示
            const sourceText = (typeof getMusicSourceText === 'function')
                ? (getMusicSourceText(item) || '-')
                : (item.plugin === 'radio' ? '电台' : (item.plugin || '-'));
            const isPlaying = currentMusic && currentMusic.id === item.id;
            const rowClass = isPlaying ? 'playing' : '';
            const evenClass = index % 2 === 1 ? 'even' : '';
            
            // 收藏状态
            let favIcon = '';
            let favClass = '';
            if (showFavorite) {
                // 使用 FavoriteManager 检查收藏状态（优先使用缓存）
                const isFavorited = allFavorited || (window.FavoriteManager
                    ? FavoriteManager.isFavoritedSync(item)
                    : isSongFavoritedSync(item.id, item.plugin || item.platform));
                favIcon = isFavorited
                    ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
                    : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
                favClass = isFavorited ? 'favorited' : '';
            }

            // 检查下载状态
            let downloadBtnClass = '';
            let downloadIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
            let downloadTitle = '下载';

            // 统一使用 plugin 字段（插件文件名），而不是 platform（平台名称）
            const itemPlugin = item.plugin || item.platform || '';

            if (showDownload && window.DownloadCore) {
                const key = `${item.id}_${itemPlugin}`;
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

            html += `
                <tr class="music-row ${rowClass} ${evenClass}" data-music-id="${escapeHtml(item.id)}" data-platform="${escapeHtml(itemPlugin)}">
                    <td class="col-checkbox" onclick="event.stopPropagation();">
                        <input type="checkbox" class="row-checkbox" data-index="${index}" data-id="${escapeHtml(item.id)}">
                    </td>
                    ${showFavorite ? `
                        <td class="col-action">
                            <button class="detail-extra-btn music-row-btn fav-btn ${favClass}" onclick="event.stopPropagation(); MusicList.toggleFavorite('${pageId}', ${index})" title="${favClass ? '取消收藏' : '收藏'}">
                                ${favIcon}
                            </button>
                        </td>
                    ` : ''}
                    ${showDownload ? `
                        <td class="col-action">
                            <button class="detail-extra-btn music-row-btn download-btn ${downloadBtnClass}"
                                    data-music-id="${escapeHtml(item.id)}"
                                    data-platform="${escapeHtml(itemPlugin)}"
                                    onclick="event.stopPropagation(); MusicList.download('${pageId}', ${index})"
                                    title="${downloadTitle}">
                                ${downloadIcon}
                            </button>
                        </td>
                    ` : ''}
                    <td class="col-index" onclick="MusicList.play('${pageId}', ${index})">${index + 1}</td>
                    <td class="col-title" onclick="MusicList.play('${pageId}', ${index})">
                        <div class="music-title-cell">
                            <span class="music-title-text">${escapeHtml(item.title)}</span>
                        </div>
                    </td>
                    <td class="col-artist" onclick="MusicList.play('${pageId}', ${index})">${escapeHtml(item.artist || '未知艺术家')}</td>
                    <td class="col-album" onclick="MusicList.play('${pageId}', ${index})">${escapeHtml(item.album || '未知专辑')}</td>
                    <td class="col-duration" onclick="MusicList.play('${pageId}', ${index})">${formatDuration(item.duration)}</td>
                    <td class="col-source" onclick="MusicList.play('${pageId}', ${index})">
                        <span class="source-tag" title="${escapeHtml(sourceText)}">${escapeHtml(sourceText)}</span>
                    </td>
                </tr>
            `;
        });

        html += '</tbody></table></div></div>';
        container.innerHTML = html;

        // 「本地 ✓」徽标：批量匹配本地曲库并标注来源列
        if (window.LocalBadge) window.LocalBadge.apply(container, songs).catch(() => {});

        // 订阅收藏状态变化
        this.subscribeToFavoriteChanges(pageId);

        // 异步检查和更新下载按钮状态
        this.syncDownloadButtons(songs);
    },

    /**
     * 同步下载按钮状态（已弃用，下载状态改为点击时实时查询）
     * @param {Array} songs - 歌曲列表
     */
    async syncDownloadButtons(_songs) {
        // 下载状态不再在渲染时批量同步，改为点击时实时查询
        return;

        /*
        // 优先使用新的 ButtonManager
        if (window.ButtonManager) {
            ButtonManager.updateMusicListButtons(songs, 'download');
            return;
        }

        // 兼容旧代码
        if (!window.DownloadManager) return;

        // 先尝试从服务器加载已下载列表
        await DownloadManager.loadDownloadedSongs();

        // 更新每个歌曲的下载按钮状态
        for (const music of songs) {
            // 统一使用 plugin 字段（插件文件名）
            const plugin = music.plugin || music.platform;
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
     * 播放指定索引的歌单
     * @param {string} pageId - 页面ID
     * @param {number} index - 歌曲索引
     */
    play(pageId, index) {
        // 根据页面ID调用对应的播放函数
        if (pageId === 'recent') {
            if (typeof playRecentByIndex === 'function') playRecentByIndex(index);
        } else if (pageId === 'favorites') {
            if (typeof playFavoriteByIndex === 'function') playFavoriteByIndex(index);
        } else if (pageId === 'toplist') {
            // 排行榜页面播放
            const songs = window.currentTopListMusicList || [];
            const song = songs[index];
            if (song && typeof playMusic === 'function') {
                // 设置当前播放列表
                window.currentPageMusicList = songs;
                playMusic(index);
            }
        } else if (pageId === 'recommend') {
            // 热门歌单页面播放
            const songs = window.currentRecommendMusicList || [];
            const song = songs[index];
            if (song && typeof playMusic === 'function') {
                // 设置当前播放列表
                window.currentPageMusicList = songs;
                playMusic(index);
            }
        } else if (pageId === 'playlist') {
            // 歌单详情页面播放
            if (typeof playMusicFromPlaylist === 'function') {
                playMusicFromPlaylist(index);
            } else {
                // 降级处理：直接使用 playMusic
                const songs = window.currentPlaylistDetailSongs || [];
                const song = songs[index];
                if (song && typeof playMusic === 'function') {
                    window.currentPageMusicList = songs;
                    playMusic(index);
                }
            }
        } else if (pageId === 'download') {
            // 下载管理页面播放
            if (typeof playDownloadedByIndex === 'function') {
                playDownloadedByIndex(index);
            } else {
                // 降级处理：直接使用 playMusic
                const songs = window.currentDownloadedList || [];
                const song = songs[index];
                if (song && typeof playMusic === 'function') {
                    window.currentPageMusicList = songs;
                    playMusic(index);
                }
            }
        }
    },

    /**
     * 添加指定索引的歌曲到播放列表
     * @param {string} pageId - 页面ID
     * @param {number} index - 歌曲索引
     */
    addToPlaylist(pageId, index) {
        let songs = [];
        if (pageId === 'recent') {
            songs = window.currentRecentList || [];
        } else if (pageId === 'favorites') {
            songs = window.currentFavoritesList || [];
        } else if (pageId === 'toplist') {
            songs = window.currentTopListMusicList || [];
        } else if (pageId === 'recommend') {
            songs = window.currentRecommendMusicList || [];
        } else if (pageId === 'playlist') {
            songs = window.currentPlaylistDetailSongs || [];
        } else if (pageId === 'download') {
            songs = window.currentDownloadedList || [];
        }

        const song = songs[index];
        if (!song) return;

        // 使用全局 addToPlaylist 函数
        if (typeof addToPlaylist === 'function') {
            addToPlaylist([song]);
            showToast(`已添加 "${song.title}" 到播放列表`, 'success');
        }
    },

    /**
     * 切换收藏状态
     * @param {string} pageId - 页面ID
     * @param {number} index - 歌曲索引
     */
    toggleFavorite(pageId, index) {
        if (pageId === 'recent') {
            if (typeof toggleFavoriteRecent === 'function') toggleFavoriteRecent(index);
        } else if (pageId === 'favorites') {
            if (typeof toggleFavoriteByIndex === 'function') toggleFavoriteByIndex(index);
        } else {
            // 通用收藏功能（排行榜、热门歌单、歌单详情、下载管理等）
            let songs = [];
            if (pageId === 'toplist') {
                songs = window.currentTopListMusicList || [];
            } else if (pageId === 'recommend') {
                songs = window.currentRecommendMusicList || [];
            } else if (pageId === 'playlist') {
                songs = window.currentPlaylistDetailSongs || [];
            } else if (pageId === 'download') {
                songs = window.currentDownloadedList || [];
            }

            const song = songs[index];
            if (!song || !window.FavoriteManager) return;

            const isFavorited = FavoriteManager.isFavoritedSync(song);
            if (isFavorited) {
                FavoriteManager.remove(song);
                showToast(`已取消收藏 "${song.title}"`, 'info');
            } else {
                FavoriteManager.add(song);
                showToast(`已收藏 "${song.title}"`, 'success');
            }

            // 更新按钮状态
            this.updateFavoriteButton(pageId, song.id, song.platform || song.plugin, !isFavorited);
        }
    },

    /**
     * 订阅收藏状态变化
     * @param {string} pageId - 页面ID
     */
    subscribeToFavoriteChanges(pageId) {
        // 优先使用 StateManager
        if (window.StateManager) {
            // 取消之前的订阅
            if (this._unsubscribeFavorite) {
                this._unsubscribeFavorite();
            }

            // 订阅收藏状态变化
            this._unsubscribeFavorite = StateManager.subscribe('favorite', ({ musicId, plugin, status }) => {
                this.updateFavoriteButton(pageId, musicId, plugin, status);
            }, `music-list-${pageId}`);

            return;
        }

        // 兼容旧代码：使用 FavoriteManager 订阅
        if (window.FavoriteManager) {
            // 取消之前的订阅
            if (this._unsubscribeFavorite) {
                this._unsubscribeFavorite();
            }

            // 创建新的订阅回调
            this._favoriteChangeCallback = ({ musicId, platform, isFavorited }) => {
                this.updateFavoriteButton(pageId, musicId, platform, isFavorited);
            };

            // 订阅
            const key = `music-list-${pageId}`;
            FavoriteManager.subscribe(key, this._favoriteChangeCallback);

            // 保存取消订阅函数
            this._unsubscribeFavorite = () => {
                FavoriteManager.unsubscribe(key, this._favoriteChangeCallback);
            };
        }
    },

    /**
     * 更新收藏按钮状态
     * @param {string} pageId - 页面ID
     * @param {string} musicId - 音乐ID
     * @param {string} platform - 平台
     * @param {boolean} isFavorited - 是否已收藏
     */
    updateFavoriteButton(pageId, musicId, platform, isFavorited) {
        const container = document.getElementById(`page-${pageId}`);
        if (!container) {
            console.log(`[INFO] [INFO] [MusicList] Container not found for page: ${pageId}`);
            return;
        }

        console.log(`[INFO] [INFO] [MusicList] Updating favorite button:`, { pageId, musicId, platform, isFavorited });

        const rows = container.querySelectorAll('.music-row');
        let found = false;
        rows.forEach(row => {
            const rowId = row.dataset.musicId;
            const rowPlatform = row.dataset.platform;
            console.log(`[INFO] [INFO] [MusicList] Checking row:`, { rowId, rowPlatform, match: rowId === musicId && rowPlatform === platform });
            if (rowId === musicId && rowPlatform === platform) {
                found = true;
                const favBtn = row.querySelector('.fav-btn');
                if (favBtn) {
                    favBtn.classList.toggle('favorited', isFavorited);
                    const iconHtml = isFavorited
                        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
                        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
                    favBtn.innerHTML = iconHtml;
                    favBtn.title = isFavorited ? '取消收藏' : '收藏';
                    console.log(`[INFO] [INFO] [MusicList] Button updated for row:`, { rowId, rowPlatform });
                }
            }
        });
        if (!found) {
            console.log(`[INFO] [INFO] [MusicList] No matching row found for:`, { musicId, platform });
        }
    },

    /**
     * 下载指定索引的歌单
     * @param {string} pageId - 页面ID
     * @param {number} index - 歌曲索引
     */
    async download(pageId, index) {
        if (pageId === 'recent') {
            if (typeof downloadRecentByIndex === 'function') await downloadRecentByIndex(index);
        } else if (pageId === 'favorites') {
            if (typeof downloadFavoriteByIndex === 'function') await downloadFavoriteByIndex(index);
        } else {
            // 通用下载功能（排行榜、热门歌单、歌单详情、下载管理等）
            let songs = [];
            if (pageId === 'toplist') {
                songs = window.currentTopListMusicList || [];
            } else if (pageId === 'recommend') {
                songs = window.currentRecommendMusicList || [];
            } else if (pageId === 'playlist') {
                songs = window.currentPlaylistDetailSongs || [];
            } else if (pageId === 'download') {
                songs = window.currentDownloadedList || [];
            }

            const song = songs[index];
            if (!song) return;

            // 使用 DownloadCore 下载
            if (window.DownloadCore) {
                await window.DownloadCore.startBackendDownload(song, 'music-list-下载');
            } else {
                showToast('下载功能未加载', 'error');
            }
        }
    },

    /**
     * 全选/取消全选
     * @param {string} pageId - 页面ID
     */
    toggleSelectAll(pageId) {
        const selectAll = document.getElementById('select-all');
        const checkboxes = document.querySelectorAll(`#page-${pageId} .row-checkbox`);
        checkboxes.forEach(cb => cb.checked = selectAll.checked);
    },

    /**
     * 获取选中的歌曲
     * @param {string} pageId - 页面ID
     * @returns {Array} 选中的歌曲列表
     */
    getSelectedSongs(pageId) {
        const selector = `#page-${pageId} .row-checkbox:checked`;
        const checkboxes = document.querySelectorAll(selector);

        const songs = [];

        // 获取当前页面的歌曲列表
        let currentSongs = [];
        if (pageId === 'recent') {
            currentSongs = window.currentRecentList || [];
        } else if (pageId === 'favorites') {
            currentSongs = window.currentFavoritesList || [];
        } else if (pageId === 'toplist') {
            currentSongs = window.currentTopListMusicList || [];
        } else if (pageId === 'recommend') {
            currentSongs = window.currentRecommendMusicList || [];
        } else if (pageId === 'download') {
            currentSongs = window.currentDownloadedList || [];
        } else if (pageId === 'playlist') {
            currentSongs = window.currentPlaylistDetailSongs || [];
        }

        checkboxes.forEach(cb => {
            const index = parseInt(cb.dataset.index);
            if (currentSongs[index]) {
                songs.push(currentSongs[index]);
            }
        });

        return songs;
    },

    /**
     * 获取当前页面的所有歌曲
     * @param {string} pageId - 页面ID
     * @returns {Array} 所有歌曲列表
     */
    getCurrentSongs(pageId) {
        if (pageId === 'recent') {
            return window.currentRecentList || [];
        } else if (pageId === 'favorites') {
            return window.currentFavoritesList || [];
        } else if (pageId === 'toplist') {
            return window.currentTopListMusicList || [];
        } else if (pageId === 'recommend') {
            return window.currentRecommendMusicList || [];
        } else if (pageId === 'download') {
            return window.currentDownloadedList || [];
        } else if (pageId === 'playlist') {
            return window.currentPlaylistDetailSongs || [];
        }
        return [];
    },

    /**
     * 播放全部歌曲（优先播放选中的）
     * @param {string} pageId - 页面ID
     */
    playAll(pageId) {
        // 先检查是否有选中的歌曲
        const selectedSongs = this.getSelectedSongs(pageId);

        // 如果有选中歌曲，播放选中的；否则播放全部
        const songs = selectedSongs.length > 0 ? selectedSongs : this.getCurrentSongs(pageId);

        if (!songs || songs.length === 0) {
            showToast('没有可播放的歌曲', 'warning');
            return;
        }

        // 设置当前播放列表
        window.currentPageMusicList = [...songs];

        // 播放第一首
        if (typeof playMusic === 'function') {
            playMusic(0);
            const msg = selectedSongs.length > 0
                ? `开始播放选中的 ${songs.length} 首歌曲`
                : `开始播放 ${songs.length} 首歌曲`;
            showToast(msg);
        }
    },

    /**
     * 添加歌曲到歌单（支持选中歌曲或全部歌曲）
     * 无论是否选中歌曲，都弹出歌单选择弹窗
     * @param {string} pageId - 页面ID
     */
    addAllToPlaylist(pageId) {
        const selectedSongs = this.getSelectedSongs(pageId);
        const currentSongs = this.getCurrentSongs(pageId);

        // 没有歌曲可添加
        if (!currentSongs || currentSongs.length === 0) {
            showToast('当前列表没有歌曲', 'warning');
            return;
        }

        // 有选中歌曲时用选中的，否则用全部歌曲
        const songsToAdd = selectedSongs.length > 0 ? selectedSongs : currentSongs;

        // 显示添加到歌单弹窗
        if (typeof showAddToPlaylistModal === 'function') {
            // 获取当前页面名称作为来源标识
            let sourceName = '';
            if (pageId === 'toplist' && window.currentTopListTitle) {
                sourceName = window.currentTopListTitle;
            } else if (pageId === 'recommend' && window.currentSheetTitle) {
                sourceName = window.currentSheetTitle;
            } else if (pageId === 'recent') {
                sourceName = '最近播放';
            } else if (pageId === 'favorites') {
                sourceName = '我的收藏';
            } else if (pageId === 'download') {
                sourceName = '下载管理';
            }
            showAddToPlaylistModal(songsToAdd, sourceName);
        } else {
            showToast('添加歌单功能未加载', 'error');
        }
    },

    /**
     * 下载全部歌曲
     * @param {string} pageId - 页面ID
     */
    async downloadAll(pageId) {
        const songs = this.getCurrentSongs(pageId);
        if (!songs || songs.length === 0) {
            showToast('没有可下载的歌曲', 'warning');
            return;
        }

        // 使用 DownloadCore 下载
        if (window.DownloadCore && typeof window.DownloadCore.downloadBatch === 'function') {
            const downloadParams = songs.map(song => ({
                id: song.id,
                title: song.title,
                artist: song.artist,
                plugin: song.plugin || song.platform || 'default',
                quality: 'standard',
                ...song
            }));
            await window.DownloadCore.downloadBatch(downloadParams, { delay: 500 }, 'music-list-批量下载');
            showToast(`已开始下载 ${songs.length} 首歌曲`);
        } else if (window.DownloadCore) {
            songs.forEach((song, index) => {
                setTimeout(() => {
                    window.DownloadCore.startBackendDownload(song, 'music-list-下载');
                }, index * 500);
            });
            showToast(`已开始下载 ${songs.length} 首歌曲`);
        } else {
            showToast('下载功能未加载', 'error');
        }
    }
};

// 导出到全局
window.MusicList = MusicList;
console.log('[INFO] [] Component loaded');
