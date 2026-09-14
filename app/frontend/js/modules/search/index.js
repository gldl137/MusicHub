/**
 * 搜索模块
 * 处理音乐搜索功能
 */

const SearchModule = {
    /**
     * 获取默认搜索插件
     */
    getDefaultPlugin() {
        if (typeof installedPlugins !== 'undefined' && installedPlugins.length > 0) {
            // 工具插件（utility，如封面获取）不作为默认搜索音源
            const playable = installedPlugins.find(p => !(p.config && p.config.utility === true));
            return (playable || installedPlugins[0]).name;
        }
        return null;
    },

    /**
     * 执行搜索
     */
    async search() {
        const query = document.getElementById('search-input')?.value.trim();
        if (!query) {
            showToast('请输入搜索关键词', 'error');
            return;
        }

        // 获取搜索使用的插件
        const searchPlugin = this.getDefaultPlugin();
        if (!searchPlugin) {
            showToast('没有可用的插件', 'error');
            return;
        }

        const resultsContainer = document.getElementById('search-results');
        resultsContainer.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

        try {
            const result = await API.music.search(query, 'music', searchPlugin);

            if (!result.success) {
                resultsContainer.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-icon">❌</div>
                        <div class="empty-text">搜索失败: ${escapeHtml(result.error || '未知错误')}</div>
                    </div>
                `;
                return;
            }

            let musicList = result.data?.data || [];

            // 为每首歌曲添加 plugin 和 platform 字段
            musicList = musicList.map(song => {
                // 优先使用歌曲自身的 plugin/platform
                if (!song.plugin) {
                    song.plugin = song.platform || searchPlugin;
                }
                if (!song.platform) {
                    song.platform = song.plugin || searchPlugin;
                }
                return song;
            });

            // 保存到全局变量供播放使用
            window.searchMusicList = musicList;

            if (musicList.length === 0) {
                resultsContainer.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-icon">🎵</div>
                        <div class="empty-text">未找到相关音乐</div>
                    </div>
                `;
                return;
            }

            // 使用 SongTable 渲染
            const render = (slice) => {
            SongTable.render({
                container: resultsContainer,
                pageId: 'search',
                title: `"${escapeHtml(query)}" 的搜索结果`,
                subtitle: `${musicList.length} 首歌曲`,
                songs: slice,
                showHeader: true,
                columns: ['checkbox', 'favorite', 'download', 'index', 'title', 'artist', 'album', 'duration', 'source'],
                actions: typeof ButtonActions !== 'undefined'
                    ? [
                        ButtonActions.createPlayButtonWithUnifiedLogic({ pageId: 'search', songs: musicList }),
                        ButtonActions.createAddButtonWithUnifiedLogic({ pageId: 'search', songs: musicList, sourceName: '搜索结果' }),
                        ButtonActions.createDownloadButtonWithUnifiedLogic({ pageId: 'search', songs: musicList, source: '搜索-下载' })
                      ]
                    : [
                        { id: 'play', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>', text: '播放', primary: false, onClick: () => ButtonActions.handlePlay('search', musicList) },
                        { id: 'add', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>', text: '添加', onClick: () => ButtonActions.handleAdd('search', musicList, '搜索结果') },
                        { id: 'download', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>', text: '下载', onClick: () => ButtonActions.handleDownload('search', musicList) }
                    ],
                events: {
                    onPlay: (song, index) => SearchModule.playByIndex(index),
                    onFavorite: (song, index) => SearchModule.toggleFavorite(index),
                    onDownload: (song, index) => SearchModule.downloadByIndex(index)
                }
            });
            };
            // 懒加载：只渲染当前可见歌曲，滚动到底追加下一批
            SongListLazy.register('search', musicList, resultsContainer, render, { batch: 50, initial: 60 });
        } catch (error) {
            resultsContainer.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">❌</div>
                    <div class="empty-text">搜索出错: ${escapeHtml(error.message)}</div>
                </div>
            `;
        }
    },

    /**
     * 播放全部
     */
    playAll() {
        const songs = SongTable.getSelectedSongs('search');
        if (songs.length === 0) {
            showToast('请先选择歌曲', 'warning');
            return;
        }
        // 播放逻辑
        console.log('播放全部', songs);
    },

    /**
     * 添加到播放列表
     */
    addAllToPlaylist() {
        const songs = SongTable.getSelectedSongs('search');
        if (songs.length === 0) {
            showToast('请先选择歌曲', 'warning');
            return;
        }
        // 添加逻辑
        console.log('添加到播放列表', songs);
    },

    /**
     * 下载全部
     */
    downloadAll() {
        const songs = SongTable.getSelectedSongs('search');
        if (songs.length === 0) {
            showToast('请先选择歌曲', 'warning');
            return;
        }
        // 下载逻辑
        console.log('下载全部', songs);
    },

    /**
     * 播放指定索引
     */
    playByIndex(index) {
        const songs = window.searchMusicList || [];
        const song = songs[index];
        if (!song) {
            showToast('歌曲不存在', 'error');
            return;
        }

        // 确保歌曲有 plugin/platform 字段
        if (!song.plugin) {
            song.plugin = song.platform || this.getDefaultPlugin();
        }
        if (!song.platform) {
            song.platform = song.plugin || this.getDefaultPlugin();
        }

        // 检查歌曲是否有 plugin
        if (!song.plugin) {
            showToast('无法确定歌曲来源插件', 'error');
            return;
        }

        // 检查歌曲是否有播放所需信息
        const canPlay = song.url || song.id;
        if (!canPlay) {
            showToast('歌曲信息不完整，无法播放', 'error');
            return;
        }

        // 更新数组中的歌曲对象
        songs[index] = song;
        window.searchMusicList = songs;

        // 设置当前页面列表为搜索列表
        setCurrentPageMusicList(songs);

        // 播放歌曲
        playMusic(index);
    },

    /**
     * 切换收藏
     */
    async toggleFavorite(index) {
        const songs = window.searchMusicList || [];
        const song = songs[index];
        if (!song) {
            showToast('歌曲不存在', 'error');
            return;
        }

        // 确保歌曲有 plugin 字段
        if (!song.plugin && song.platform) {
            song.plugin = song.platform;
        }

        // 调用全局 toggleFavoriteSong
        if (typeof toggleFavoriteSong === 'function') {
            await toggleFavoriteSong(song);
        }
    },

    /**
     * 下载指定索引
     */
    async downloadByIndex(index) {
        const songs = window.searchMusicList || [];
        const song = songs[index];
        if (!song) return;

        // 入库 plugin 优先（platform 可能是显示用平台名）
        const plugin = song.plugin || song.platform;
        if (!plugin) {
            showToast('无法确定歌曲来源', 'error');
            return;
        }

        // 实时查询数据库检查是否已下载
        try {
            if (window.StateManager?.isDownloaded) {
                const isDownloaded = await window.StateManager.isDownloaded(song.id, plugin);
                if (isDownloaded) {
                    // 已下载，显示确认弹窗
                    this.showReDownloadConfirm(song);
                    return;
                }
            }
        } catch (e) {
            console.error('检查下载状态失败:', e);
        }

        if (window.DownloadCore) {
            await DownloadCore.startBackendDownload(song, '搜索-下载');
        }
    },

    /**
     * 显示重新下载确认弹窗
     * @param {Object} song - 歌曲对象
     */
    showReDownloadConfirm(song) {
        if (typeof showConfirmModal === 'function') {
            showConfirmModal({
                title: '重新下载',
                message: `「${song.title}」已下载，需要重新下载吗？`,
                confirmText: '重新下载',
                cancelText: '取消',
                onConfirm: () => {
                    this.reDownloadSong(song);
                }
            });
        } else if (confirm(`「${song.title}」已下载，需要重新下载吗？`)) {
            this.reDownloadSong(song);
        }
    },

    /**
     * 强制重新下载歌曲
     * @param {Object} song - 歌曲对象
     */
    async reDownloadSong(song) {
        if (!song || !song.id || !song.plugin) {
            showToast('歌曲信息不完整，无法重新下载', 'error');
            return;
        }

        try {
            showToast(`正在重新下载「${song.title}」...`, 'info');

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
                    source: 'search-retry',
                    force: true
                })
            });

            const result = await response.json();

            if (result.success) {
                showToast(`「${song.title}」重新下载任务已添加`, 'success');
            } else {
                showToast(result.error || '重新下载失败', 'error');
            }
        } catch (error) {
            console.error('重新下载失败:', error);
            showToast(`重新下载失败: ${error.message}`, 'error');
        }
    },

    /**
     * 在指定插件中搜索
     */
    async searchInPlugin(query, type, plugin) {
        if (!query) {
            showToast('请输入搜索关键词', 'warning');
            return;
        }

        if (!plugin) {
            showToast('没有可用的插件', 'warning');
            return;
        }

        showToast('正在搜索...');

        try {
            const result = await API.music.search(query, type, plugin);

            if (result.success && result.data?.data) {
                const searchResults = result.data.data;

                if (searchResults.length === 0) {
                    showToast('未找到相关结果', 'warning');
                    return null;
                }

                return searchResults;
            } else {
                showToast('搜索失败', 'error');
                return null;
            }
        } catch (error) {
            console.error('搜索失败:', error);
            showToast('搜索失败: ' + error.message, 'error');
            return null;
        }
    }
};

// 导出到全局作用域
window.SearchModule = SearchModule;
window.searchMusic = () => SearchModule.search();
