/**
 * 播放详情模块
 * 负责播放详情页的显示、歌词、播放列表等
 */

const PlayerDetail = {
    // 状态
    isOpen: false,
    currentLyrics: [],
    currentLyricIndex: -1,
    isLyricsPanelOpen: true,
    isPlaylistPanelOpen: false,
    isDraggingProgress: false,
    eventsBound: false,  // 标记是否已经绑定全局事件
    _isTogglingFavorite: false,  // 标记是否正在进行收藏操作
    _isSubscribed: false,  // 标记是否已经订阅收藏状态变化
    _isDownloadSubscribed: false,  // 标记是否已经订阅下载状态变化

    /**
     * 初始化
     */
    init() {
        this.bindEvents();
        this.subscribeToFavoriteChanges();
        this.subscribeToDownloadChanges();
        console.log('[INFO] [] Module initialized');
    },

    /**
     * 订阅收藏状态变化
     */
    subscribeToFavoriteChanges() {
        // 避免重复订阅
        if (this._isSubscribed) {
            return;
        }

        // 使用 FavoriteManager 订阅
        if (window.FavoriteManager) {
            FavoriteManager.subscribe('detail', ({ musicId, platform, isFavorited }) => {
                console.log('[INFO] [] Received favorite change:', { musicId, platform, isFavorited });
                console.log('[INFO] [] Current music:', window.currentMusic?.id, window.currentMusic?.title);

                // 更新播放列表中的收藏按钮（无论当前是否有歌曲播放）
                this.updatePlaylistFavoriteButton(musicId, platform, isFavorited);

                // 如果当前播放的歌曲收藏状态发生变化，更新按钮
                if (window.currentMusic && window.currentMusic.id === musicId) {
                    const currentPlatform = window.currentMusic.platform || window.currentMusic.plugin || '';
                    const eventPlatform = platform || '';
                    console.log('[INFO] [] Platform check:', { currentPlatform, eventPlatform, match: currentPlatform === eventPlatform });

                    if (currentPlatform === eventPlatform) {
                        window.isCurrentMusicLiked = isFavorited;
                        window.currentMusic._isLiked = isFavorited;
                        console.log('[INFO] [] Calling updateDetailButton with:', isFavorited);
                        FavoriteManager.updateDetailButton(isFavorited);
                    }
                }
            });
            this._isSubscribed = true;
            console.log('[INFO] [] Subscribed to favorite changes');
        }
    },

    /**
     * 订阅下载状态变化
     */
    subscribeToDownloadChanges() {
        // 避免重复订阅
        if (this._isDownloadSubscribed) return;

        // 使用 StateManager 订阅
        if (window.StateManager && typeof StateManager.subscribe === 'function') {
            try {
                StateManager.subscribe('download', ({ musicId, plugin, status }) => {
                    // 如果当前播放的歌曲下载状态发生变化，更新按钮
                    if (window.currentMusic) {
                        const currentId = String(window.currentMusic.id);
                        const currentPlatform = window.currentMusic.platform || window.currentMusic.plugin || '';
                        const eventId = String(musicId);
                        const eventPlatform = plugin || '';

                        if (currentId == eventId && currentPlatform === eventPlatform) {
                            this.updateDownloadButton(status);
                        }
                    }
                }, 'detail');

                this._isDownloadSubscribed = true;
            } catch (error) {
                console.error('[ERROR] [PlayerDetail] Failed to subscribe:', error);
            }
        }
    },

    /**
     * 更新播放列表中的收藏按钮
     */
    updatePlaylistFavoriteButton(musicId, platform, isFavorited) {
        const playlistContainer = document.getElementById('detail-playlist-container');
        if (!playlistContainer) return;

        const rows = playlistContainer.querySelectorAll('.playlist-row');
        rows.forEach(row => {
            const rowId = row.dataset.musicId;
            const rowPlatform = row.dataset.platform;
            if (rowId === musicId && rowPlatform === platform) {
                const favBtn = row.querySelector('.fav-btn');
                if (favBtn) {
                    favBtn.classList.toggle('favorited', isFavorited);
                    favBtn.innerHTML = isFavorited
                        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
                        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
                    favBtn.title = isFavorited ? '取消收藏' : '收藏';
                }
            }
        });
    },

    /**
     * 绑定事件
     */
    bindEvents() {
        // 键盘快捷键（仅 ESC 键，其他快捷键由 PlayerModule 全局处理）
        document.addEventListener('keydown', (e) => {
            // 如果正在输入框中，不处理快捷键
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
                return;
            }

            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        });

        // 全局鼠标事件（用于进度拖动）
        document.addEventListener('mousemove', (e) => {
            if (this.isDraggingProgress) {
                e.preventDefault();
                this.seek(e);
            }
        });

        document.addEventListener('mouseup', () => {
            if (this.isDraggingProgress) {
                this.isDraggingProgress = false;
                // 移除 dragging 类，恢复 transition
                const progressFill = document.getElementById('detail-progress-fill');
                if (progressFill) {
                    progressFill.classList.remove('dragging');
                }
            }
        });

        // 全局触摸事件（移动端进度拖动）
        document.addEventListener('touchmove', (e) => {
            if (this.isDraggingProgress) {
                e.preventDefault();
                this.seek(e.touches[0]);
            }
        }, { passive: false });

        document.addEventListener('touchend', () => {
            if (this.isDraggingProgress) {
                this.isDraggingProgress = false;
                // 移除 dragging 类，恢复 transition
                const progressFill = document.getElementById('detail-progress-fill');
                if (progressFill) {
                    progressFill.classList.remove('dragging');
                }
            }
        });

    },

    /**
     * 打开播放详情页
     */
    async open() {
        if (!window.currentMusic) {
            Notification.toast('没有正在播放的歌单', 'warning');
            return;
        }

        // 确保已订阅收藏状态变化（因为 init() 被注释掉了）
        this.subscribeToFavoriteChanges();
        this.subscribeToDownloadChanges();

        // 绑定全局事件（只绑定一次）
        if (!this.eventsBound) {
            this.bindEvents();
            this.eventsBound = true;
        }

        await this.updateInfo();
        this.loadLyrics();
        this.initControls();
        this.initProgressDrag();
        this.renderPlaylist();

        // 绑定关闭按钮事件（每次打开时重新绑定）
        const closeBtn = document.getElementById('detail-panel-close');
        if (closeBtn) {
            closeBtn.onclick = () => {
                this.hideLyricsPanel();
                this.hidePlaylistPanel();
            };
        }

        // 仅「手机」（竖屏且宽度<=768）默认只显示封面；
        // 平板（含 iPad 横竖屏）与桌面默认歌词与播放区并排显示。
        const isLandscape = window.innerWidth > window.innerHeight;
        const isPhone = window.innerWidth <= 768 && !isLandscape;

        if (isPhone) {
            // 移动端：显示封面，隐藏歌词面板，不选中任何按钮，隐藏关闭按钮
            const rightSection = document.querySelector('.detail-right');
            const coverSection = document.querySelector('.detail-cover');
            const lyricsBtn = document.getElementById('lyrics-toggle-btn');
            const playlistBtn = document.getElementById('playlist-toggle-btn');
            const lyricsContainer = document.getElementById('detail-lyrics');
            const playlistContainer = document.getElementById('detail-playlist');
            // 显示封面，隐藏歌词面板
            if (coverSection) coverSection.classList.remove('hidden');
            if (rightSection) {
                rightSection.classList.remove('active');
                rightSection.classList.remove('mobile-panel-open');
            }
            if (lyricsBtn) lyricsBtn.classList.remove('active');
            if (playlistBtn) playlistBtn.classList.remove('active');
            // 确保歌词和播放列表容器正确设置
            if (lyricsContainer) lyricsContainer.style.display = 'none';
            if (playlistContainer) playlistContainer.style.display = 'none';
            // 隐藏关闭按钮（封面状态不显示）
            const closeBtn = document.getElementById('detail-panel-close');
            if (closeBtn) closeBtn.style.display = 'none';
            this.isLyricsPanelOpen = false;
            this.isPlaylistPanelOpen = false;
            window.isPlaylistOpen = false;
        } else {
            // 桌面端和窄屏：默认显示歌词，显示关闭按钮
            this.showLyricsPanel();
        }

        // 打开时检查并更新下载按钮状态
        this.updateDownloadButtonState();

        // 显示详情页
        const overlay = document.getElementById('player-detail-overlay');
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.classList.add('active');
            overlay.style.position = 'fixed';
            overlay.style.top = '0';
            overlay.style.left = '0';
            overlay.style.right = '0';
            overlay.style.bottom = '0';
            overlay.style.zIndex = '99999';
            this.isOpen = true;

            // 移动端：点击遮罩层关闭面板
            overlay.onclick = (e) => {
                if (window.innerWidth <= 768 && e.target === overlay) {
                    // 如果面板是打开的，先关闭面板
                    const rightSection = document.querySelector('.detail-right');
                    if (rightSection && (rightSection.classList.contains('mobile-panel-open') || rightSection.classList.contains('active'))) {
                        this.hideLyricsPanel();
                        this.hidePlaylistPanel();
                    } else {
                        // 否则关闭详情页
                        this.close();
                    }
                }
            };
        }
    },

    /**
     * 关闭播放详情页
     */
    close() {
        // 关闭音质弹窗
        if (typeof closeQualityDropdown === 'function') {
            closeQualityDropdown();
        }

        const overlay = document.getElementById('player-detail-overlay');
        if (overlay) {
            overlay.style.display = 'none';
            overlay.classList.remove('active');
            overlay.classList.remove('mobile-panel-open');
            this.isOpen = false;
        }

        // 清理移动端面板状态
        const rightSection = document.querySelector('.detail-right');
        const leftSection = document.querySelector('.detail-left');
        const coverSection = document.querySelector('.detail-cover');
        const lyricsContainer = document.getElementById('detail-lyrics');
        const playlistContainer = document.getElementById('detail-playlist');
        if (rightSection) {
            rightSection.classList.remove('mobile-panel-open');
            rightSection.classList.remove('active');
            rightSection.style.display = 'none';
        }
        // 重置显示状态：显示左侧和封面，隐藏歌词/播放列表面板
        if (leftSection) leftSection.classList.remove('hidden');
        if (coverSection) coverSection.classList.remove('hidden');
        if (lyricsContainer) lyricsContainer.style.display = 'none';
        if (playlistContainer) playlistContainer.style.display = 'none';
        // 隐藏关闭按钮
        const closeBtn = document.getElementById('detail-panel-close');
        if (closeBtn) closeBtn.style.display = 'none';
        this.isLyricsPanelOpen = false;
        this.isPlaylistPanelOpen = false;
        window.isPlaylistOpen = false;
    },

    /**
     * 停止播放并关闭详情页
     */
    stopAndClose() {
        // 真正停止播放：复用 PlayerModule.stopPlayback 的健壮逻辑。
        // 它会销毁 HLS 直播流实例（电台残留流会继续占用媒体元素）并标记用户主动停止，
        // 避免清空音频源触发的 error 事件进入自动切歌逻辑——否则电台会跳到下一台。
        if (typeof PlayerModule !== 'undefined' && typeof PlayerModule.stopPlayback === 'function') {
            PlayerModule.stopPlayback();
        } else {
            const player = document.getElementById('audio-player');
            if (player) {
                player.pause();
                player.removeAttribute('src');
                player.load();
            }
            window.isPlaying = false;
        }
        window.isPlaying = false;

        // 更新播放器按钮状态
        if (typeof PlayerModule !== 'undefined') {
            PlayerModule.updateExternalPlayButton(false);
        }
        if (typeof updatePlayingRow === 'function') updatePlayingRow();

        this.close();
    },

    /**
     * 更新详情页信息
     */
    async updateInfo() {
        if (!window.currentMusic) return;

        const music = window.currentMusic;

        // 更新基本信息
        const detailTitle = document.getElementById('detail-title');
        const detailArtist = document.getElementById('detail-artist');
        const detailAlbum = document.getElementById('detail-album');
        const detailSourceType = document.getElementById('detail-source-type');
        const detailSourceName = document.getElementById('detail-source-name');

        if (detailTitle) detailTitle.textContent = music.title;
        if (detailArtist) detailArtist.textContent = music.artist || '未知艺术家';
        if (detailAlbum) detailAlbum.textContent = music.album || '';

        // 处理专辑显示：如果没有专辑，隐藏分隔符
        const metaRow = detailArtist?.parentElement;
        const metaSeparator = metaRow?.querySelector('.detail-meta-separator');
        if (metaSeparator) {
            metaSeparator.style.display = music.album ? 'inline' : 'none';
        }

        // 来源分两行：
        //   第一行 = 来源类型：网络.LX / 网络.MF / 本地 / 电台 / STRM
        //   第二行 = 直接来源名（落雪音源名 / MF插件名 / STRM）；本地与电台第二行留空
        if (detailSourceType && typeof getSourceTypeLine === 'function') {
            detailSourceType.textContent = getSourceTypeLine(music) || '未知来源';
            detailSourceType.style.display = '';
        }
        if (detailSourceName && typeof getSourceNameLine === 'function') {
            const name = getSourceNameLine(music);
            detailSourceName.textContent = name || '';
            detailSourceName.style.display = name ? '' : 'none';
        }

        // 检查音频实际来源（优先使用 window.currentMusicSource，否则检查音频 src）
        let source = window.currentMusicSource || 'remote';
        const audioElement = document.getElementById('audio-player');
        if (audioElement && audioElement.src) {
            const src = audioElement.src;
            if (src.includes('/api/local-files/stream')) {
                source = 'local-file';
            }
        }

        // 更新封面（异步，不阻塞）
        this.updateCover(music).catch(() => {});

        // 更新背景（等待完成，确保背景正确更新）
        try {
            await this.updateBackground(music);
        } catch (e) {
            /* 背景更新失败静默 */
        }

        // 更新播放按钮状态
        this.updatePlayButton(window.isPlaying);

        // 更新收藏按钮状态
        this.updateLikeButton();

        // 更新下载按钮状态
        this.updateDownloadButtonState();

        // 更新播放模式按钮
        this.updateModeButtons();
    },

    /**
     * 根据当前歌曲更新下载按钮状态
     */
    updateDownloadButtonState() {
        if (!window.currentMusic) return;

        const music = window.currentMusic;
        const plugin = music.platform || music.plugin;
        if (!plugin) return;

        // 更新按钮的 data 属性，以便能被 ButtonManager 找到
        const downloadBtn = document.getElementById('detail-download-btn');
        if (downloadBtn) {
            downloadBtn.dataset.musicId = String(music.id);
            downloadBtn.dataset.platform = plugin;
        }

        // 优先使用新的 StateManager + ButtonManager（异步查询数据库）
        if (window.StateManager && window.ButtonManager) {
            (async () => {
                try {
                    const status = await StateManager.getDownloadStatus(music.id, plugin);
                    ButtonManager.updateDownloadButton(music.id, plugin, status);
                } catch (e) {
                    console.error('获取下载状态失败:', e);
                }
            })();
            return;
        }

        // 使用 DownloadCore
        if (!window.DownloadCore) return;

        const key = `${music.id}_${plugin}`;
        if (window.DownloadCore.downloadedCache && window.DownloadCore.downloadedCache.has(key)) {
            this.updateDownloadButton('downloaded');
        } else if (window.DownloadCore.downloadingCache && window.DownloadCore.downloadingCache.has(key)) {
            this.updateDownloadButton('downloading');
        } else {
            this.updateDownloadButton('normal');
        }
    },

    /**
     * 获取封面 URL（优先使用缓存）
     */
    async getCoverUrl(music) {
        const originalUrl = music.artwork || music.coverImg || music.cover || music.pic || music.albumArt;
        const isLocal = music.platform === 'local' || music.plugin === 'local' || !!music.filePath;

        // 本地文件：优先内嵌封面（含按 filePath 构造的 URL），无内嵌封面时用插件搜索补全
        if (isLocal) {
            const embeddedUrl = originalUrl || (music.filePath
                ? `${window.API_BASE || ''}/api/music/cover?path=${encodeURIComponent(String(music.filePath).replace(/\\/g, '/'))}`
                : null);
            if (embeddedUrl) {
                // 非原始 URL（对象缺 artwork 字段）时，后台尝试网络补全并刷新当前封面
                if (!originalUrl && typeof window.fetchLocalEnrichCover === 'function') {
                    window.fetchLocalEnrichCover(music).then((cover) => {
                        if (cover && music.artwork !== cover) {
                            music.artwork = cover;
                            const isCurrent = window.currentMusic && window.currentMusic.id === music.id;
                            const dc = document.getElementById('detail-cover');
                            if (dc && isCurrent) {
                                dc.innerHTML = createImageWithFallback(cover, 'cover', '') + "<div style='font-size:80px;color:rgba(255,255,255,0.3);display:none'>🎵</div>";
                            }
                            const pc = document.getElementById('player-cover');
                            if (pc && isCurrent) {
                                pc.innerHTML = createImageWithFallback(cover, 'cover', '') + "<div style='font-size:24px;color:var(--text-tertiary);display:none'>🎵</div>";
                            }
                        }
                    }).catch(() => {});
                }
                return embeddedUrl;
            }
            try {
                if (typeof window.fetchLocalEnrichCover === 'function') {
                    const cover = await window.fetchLocalEnrichCover(music);
                    if (cover) {
                        music.artwork = cover;
                        return cover;
                    }
                }
            } catch (e) {
                // 补全失败，使用占位图
            }
            return null;
        }

        if (!originalUrl) {
          // 远程封面地址不再持久化入库：改用 coverArt 虚拟 ID 经 /api/cover 实时向插件获取，
          // 与 Subsonic 客户端走同一套封面逻辑，避免 JSON 里泄漏时效性外网地址。
          const coverId = music.coverArt || music.virtualId || (typeof music.id === 'string' ? music.id : null);
          if (coverId) {
            return `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(coverId)}`;
          }
          return null;
        }

        // 网络歌曲封面：直接使用插件返回的远程封面 URL（浏览器 <img> 加载外链无需 CORS）。
        // 不写入 /api/cache/download 的 artwork 目录（避免服务器磁盘产生冗余封面文件）；
        // 取主色等需要 CORS 的场景走 /api/proxy/sign + /api/proxy/image 即时代理，同样不落盘。
        return originalUrl;
    },

    /**
     * 更新封面
     */
    async updateCover(music) {
        const detailCover = document.getElementById('detail-cover');
        if (!detailCover) return;

        const coverUrl = await this.getCoverUrl(music);

        if (coverUrl) {
            detailCover.innerHTML = createImageWithFallback(coverUrl, 'cover', '') + "<div style='font-size:80px;color:rgba(255,255,255,0.3);display:none'>🎵</div>";
        } else {
            detailCover.innerHTML = '<div style="font-size: 80px; color: rgba(255,255,255,0.3);">🎵</div>';
        }
        // 背景跟随封面：优先采样已渲染的封面图，失败则用歌名兜底色（换歌必变色）
        this.applyCoverGradient(coverUrl, music);
    },

    /**
     * 播放详情页背景跟随封面：取封面主色生成三段渐变，写入详情页的背景变量
     * 三级策略，保证「换歌必变色」：
     *   1) 直接用页面上已渲染的封面图采样（已缓存 → 零延迟）
     *   2) 图未加载完 → 监听其 load 后再采样（封面一出来立刻上色）
     *   3) 采样失败/跨域 → 走 /api/proxy 代理取色；仍失败则用歌名哈希兜底色
     */
    async applyCoverGradient(coverUrl, music) {
        const overlay = document.getElementById('player-detail-overlay');
        if (!overlay) return;

        // 换歌去重：同一首歌只染色一次
        const seed = (music && (music.id || music.name)) || coverUrl || '';
        this._gradientSeed = this._gradientSeed || '';
        const musicKey = `${seed}|${coverUrl || ''}`;
        if (this._gradientKey === musicKey) return;
        this._gradientKey = musicKey;

        // 无封面：直接用兜底色，保证背景仍然跟着歌变化
        if (!coverUrl) {
            const seedRgb = this._seedColor(`${(music && music.name) || ''}${(music && music.artist) || ''}`);
            this._paintCoverGradient(seedRgb[0], seedRgb[1], seedRgb[2]);
            return;
        }

        const coverImg = document.querySelector('#detail-cover img');
        const trySample = (el) => {
            if (!el || !el.complete || !el.naturalWidth) return null;
            try {
                if (typeof SongTable !== 'undefined' && SongTable._sampleImageColor) {
                    return SongTable._sampleImageColor(el);
                }
            } catch (e) { /* 跨域污染，走代理 */ }
            return null;
        };

        // 1) 已渲染的封面图（通常已命中缓存，立即出结果）
        let rgb = trySample(coverImg);
        if (rgb) { this._paintCoverGradient(rgb[0], rgb[1], rgb[2]); return; }

        // 2) 图还没加载完：等它 load 后立刻采样（不额外下载）
        if (coverImg && !coverImg.complete) {
            coverImg.addEventListener('load', () => {
                const c = trySample(coverImg);
                if (c) this._paintCoverGradient(c[0], c[1], c[2]);
            }, { once: true });
        }

        // 3) 兜底：先上歌名哈希色（立刻有变化），再尝试代理取色覆盖为真实封面色
        const seedRgb = this._seedColor(`${(music && music.name) || ''}${(music && music.artist) || ''}`);
        if (!rgb) this._paintCoverGradient(seedRgb[0], seedRgb[1], seedRgb[2]);

        try {
            const loadImg = (url) => (typeof SongTable !== 'undefined' && SongTable._loadImage
                ? SongTable._loadImage(url)
                : new Promise((resolve, reject) => {
                    const im = new Image();
                    im.crossOrigin = 'anonymous';
                    im.onload = () => resolve(im);
                    im.onerror = reject;
                    im.src = url;
                }));

            let img;
            if (coverUrl.startsWith('/') || coverUrl.startsWith(window.location.origin + '/')) {
                img = await loadImg(coverUrl);
            } else {
                // 走带缓存的统一签名入口：同一封面的签名与封面加载共享 token，不再每次取色都 POST 一次
                const proxyUrl = await signProxyUrl(coverUrl, 'image');
                img = await loadImg(proxyUrl);
            }
            rgb = (typeof SongTable !== 'undefined' && SongTable._sampleImageColor)
                ? SongTable._sampleImageColor(img) : null;
            if (rgb) this._paintCoverGradient(rgb[0], rgb[1], rgb[2]);
        } catch (e) {
            // 取色失败：已用兜底色，无需处理
        }
    },

    /** 歌名/歌手生成稳定的兜底色（封面不可用时背景仍跟着歌变化） */
    _seedColor(seedStr) {
        let h = 0;
        const s = String(seedStr || 'musichub');
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        const hue = (Math.abs(h) % 360) / 360;
        return this._hslToRgb(hue, 0.3, 0.42);
    },

    _hslToRgb(h, s, l) {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        const f = (t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };
        return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
    },

    /**
     * 用主色生成背景渐变（深浅主题分别处理，保证文字可读）
     */
    _paintCoverGradient(r, g, b) {
        const overlay = document.getElementById('player-detail-overlay');
        if (!overlay) return;

        const themeAttr = document.documentElement.getAttribute('data-theme') || '';
        const isLight = themeAttr === 'light'
            || ((themeAttr === 'auto' || !themeAttr) && window.matchMedia('(prefers-color-scheme: light)').matches);
        // 深色主题：主色压暗；浅色主题：主色向白靠拢
        const shade = (f) => isLight
            ? `rgb(${Math.round(255 - (255 - r) * f)}, ${Math.round(255 - (255 - g) * f)}, ${Math.round(255 - (255 - b) * f)})`
            : `rgb(${Math.round(r * f)}, ${Math.round(g * f)}, ${Math.round(b * f)})`;

        const start = isLight ? shade(0.32) : shade(0.58);
        const mid = isLight ? shade(0.18) : shade(0.3);
        const end = isLight ? shade(0.1) : shade(0.15);

        overlay.style.setProperty('--player-gradient-start', start);
        overlay.style.setProperty('--player-gradient-mid', mid);
        overlay.style.setProperty('--player-gradient-end', end);
        overlay.style.setProperty('--player-gradient', `linear-gradient(180deg, ${start} 0%, ${mid} 50%, ${end} 100%)`);
    },

    /** 恢复默认背景（关闭详情页 / 无封面时） */
    resetCoverGradient() {
        const overlay = document.getElementById('player-detail-overlay');
        if (!overlay) return;
        overlay.style.removeProperty('--player-gradient');
        overlay.style.removeProperty('--player-gradient-start');
        overlay.style.removeProperty('--player-gradient-mid');
        overlay.style.removeProperty('--player-gradient-end');
    },

    /**
     * 提取图片主色调（改进算法）
     * 排除黑白灰像素，提取最鲜艳的颜色
     * 使用后端代理解决 CORS 问题
     */
    async extractDominantColor(imageUrl) {
        if (!imageUrl || !imageUrl.startsWith('http')) {
            return null; // 本地图片无需代理
        }
        // 外部图片：先到后端换短期签名 token，再以 /api/proxy/image?token=xxx 访问，
        // 前端不再暴露外部完整 URL。
        let proxyUrl = imageUrl;
        try {
            proxyUrl = await signProxyUrl(imageUrl, 'image');
        } catch (e) {
            return null;
        }

        return new Promise((resolve) => {
            // 设置超时，防止图片加载卡住
            const timeout = setTimeout(() => {
                resolve(null);
            }, 5000);

            const img = new Image();

            img.onload = () => {
                clearTimeout(timeout);
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    canvas.width = 100;
                    canvas.height = 100;
                    ctx.drawImage(img, 0, 0, 100, 100);

                    const imageData = ctx.getImageData(0, 0, 100, 100).data;
                    const colorMap = new Map();

                    // 采样像素，排除黑白灰，按饱和度加权
                    for (let i = 0; i < imageData.length; i += 4) {
                        const r = imageData[i];
                        const g = imageData[i + 1];
                        const b = imageData[i + 2];

                        // 计算亮度（排除过暗和过亮的像素）
                        const brightness = (r + g + b) / 3;
                        if (brightness < 30 || brightness > 240) continue;

                        // 计算饱和度
                        const max = Math.max(r, g, b);
                        const min = Math.min(r, g, b);
                        const saturation = max === 0 ? 0 : (max - min) / max;

                        // 排除接近灰色的像素（饱和度太低）
                        if (saturation < 0.15) continue;

                        // 量化颜色（减少颜色数量，便于统计）
                        const quantizedR = Math.round(r / 16) * 16;
                        const quantizedG = Math.round(g / 16) * 16;
                        const quantizedB = Math.round(b / 16) * 16;
                        const key = `${quantizedR},${quantizedG},${quantizedB}`;

                        // 按饱和度加权
                        const weight = saturation * saturation + 0.1;

                        if (colorMap.has(key)) {
                            colorMap.set(key, colorMap.get(key) + weight);
                        } else {
                            colorMap.set(key, weight);
                        }
                    }

                    // 如果没有有效颜色，使用平均值
                    if (colorMap.size === 0) {
                        let r = 0, g = 0, b = 0, count = 0;
                        for (let i = 0; i < imageData.length; i += 4) {
                            r += imageData[i];
                            g += imageData[i + 1];
                            b += imageData[i + 2];
                            count++;
                        }
                        resolve({
                            r: Math.round(r / count),
                            g: Math.round(g / count),
                            b: Math.round(b / count)
                        });
                        return;
                    }

                    // 找出权重最高的颜色
                    let maxWeight = 0;
                    let dominantColor = null;
                    for (const [key, weight] of colorMap) {
                        if (weight > maxWeight) {
                            maxWeight = weight;
                            const [r, g, b] = key.split(',').map(Number);
                            dominantColor = { r, g, b };
                        }
                    }

                    // 增强饱和度
                    const enhanceSaturation = (color) => {
                        const { r, g, b } = color;
                        const max = Math.max(r, g, b);
                        const min = Math.min(r, g, b);
                        const saturation = max === 0 ? 0 : (max - min) / max;

                        // 如果饱和度不够，增强它
                        if (saturation < 0.5) {
                            const factor = 1.3;
                            const avg = (r + g + b) / 3;
                            return {
                                r: Math.min(255, Math.round(avg + (r - avg) * factor)),
                                g: Math.min(255, Math.round(avg + (g - avg) * factor)),
                                b: Math.min(255, Math.round(avg + (b - avg) * factor))
                            };
                        }
                        return color;
                    };

                    resolve(enhanceSaturation(dominantColor));
                } catch (err) {
                    resolve(null);
                }
            };

            img.onerror = () => {
                clearTimeout(timeout);
                resolve(null);
            };

            img.src = proxyUrl;
        });
    },

    /**
     * 生成匹配封面主色调的渐变背景
     */
    async updateBackground(music) {
        const detailBackground = document.getElementById('detail-background');
        if (!detailBackground) {
            return;
        }

        const coverUrl = await this.getCoverUrl(music);

        // 清除历史内联背景：背景层回落为 CSS 的 var(--player-gradient)，
        // 由 applyCoverGradient 统一控制颜色（封面采样 → 兜底色 / 代理取色），
        // 避免内联样式覆盖掉染色结果（此前换歌不变色的原因）
        detailBackground.style.backgroundImage = '';
        detailBackground.style.background = '';

        // 主色渐变染色（作底层兜底：封面未出来时背景已是对应色调）
        try {
            await this.applyCoverGradient(coverUrl, music);
        } catch (e) {
            /* 染色失败静默 */
        }

        // 模糊封面背景：把封面图作为背景层（模糊 + 压暗），渐变染色留作兜底
        // 换歌时先淡出旧图 → 预加载新封面 → 加载完成后再换图淡入，避免闪烁
        if (coverUrl) {
            const hadCover = detailBackground.classList.contains('cover-blur');
            const sameCover = this._bgCoverUrl === coverUrl;
            this._bgCoverUrl = coverUrl;
            if (sameCover) return;
            if (hadCover) detailBackground.classList.add('cover-switching');

            const applyImg = () => {
                detailBackground.style.setProperty('--detail-cover-img', `url("${coverUrl}")`);
                detailBackground.classList.add('cover-blur');
                requestAnimationFrame(() => detailBackground.classList.remove('cover-switching'));
            };

            if (hadCover) {
                // 已有背景：等新封面解码完成再换，避免中间出现空白/跳变
                const pre = new Image();
                pre.onload = () => applyImg();
                pre.onerror = () => { detailBackground.classList.remove('cover-switching'); };
                pre.src = coverUrl;
            } else {
                applyImg();
            }
        } else {
            this._bgCoverUrl = '';
            detailBackground.style.removeProperty('--detail-cover-img');
            detailBackground.classList.remove('cover-blur');
            detailBackground.classList.remove('cover-switching');
        }
    },

    /**
     * 加载歌词
     */
    async loadLyrics() {
        if (!window.currentMusic) return;

        const lyricsContainer = document.getElementById('detail-lyrics');
        if (!lyricsContainer) return;

        // 清空当前歌词
        this.currentLyrics = [];
        this.currentLyricIndex = -1;

        lyricsContainer.innerHTML = '<div class="lyrics-placeholder">加载歌词...</div>';

        try {
            // 落雪（LX）歌曲：如实带上自己的标识（lx:xx），后端据此跳过 MusicFree 插件取词、
            // 直接走歌词插件兜底；不能借 getPluginForMusic 回退到某个 MF 插件（那是"用 MF 去包含 LX"）
            const songPlugin = window.currentMusic.plugin || window.currentMusic.platform;
            const pluginName = (typeof isLxPlugin === 'function' && isLxPlugin(songPlugin))
                ? songPlugin
                : (typeof getPluginForMusic === 'function'
                    ? getPluginForMusic(window.currentMusic, 'url')
                    : window.currentMusic.plugin);

            if (!pluginName) {
                lyricsContainer.innerHTML = '<div class="lyrics-placeholder">暂无歌词</div>';
                return;
            }

            let lyricsText = null;
            let lyricsSource = 'api';

            // 歌词统一通过 /api/lyrics 获取（数据库优先：网络歌曲 songs.lyric_raw / 本地歌曲
            // local_songs.lyric_raw，未命中才联网搜索并写库）。不读写本地 .lrc 缓存文件。
            const response = await fetch(`${API_BASE}/api/lyrics?plugin=${encodeURIComponent(pluginName)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ music: window.currentMusic })
            });

            const result = await response.json();

            if (result.success && result.data) {
                lyricsText = result.data.rawLrc || result.data.lyrics || result.data.lrc || result.data;
            }

            // 4. 解析和显示歌词
            if (lyricsText && typeof lyricsText === 'string') {
                this.currentLyrics = this.parseLyrics(lyricsText);

                if (this.currentLyrics.length > 0) {
                    this.renderLyrics();
                    console.log(`[INFO] [PlayerDetail] Lyrics loaded from ${lyricsSource}, ${this.currentLyrics.length} lines`);
                } else {
                    lyricsContainer.innerHTML = '<div class="lyrics-placeholder">暂无歌词</div>';
                }
            } else {
                lyricsContainer.innerHTML = '<div class="lyrics-placeholder">暂无歌词</div>';
            }
        } catch (error) {
            console.warn('[WARN] [] [] 加载歌词失败:', error);
            lyricsContainer.innerHTML = '<div class="lyrics-placeholder">暂无歌词</div>';
        }
    },

    /**
     * 解析歌词
     * 支持标准 LRC 格式 [mm:ss.xx] 和酷我格式 [s.ms]
     */
    parseLyrics(lyricsText) {
        if (!lyricsText) return [];

        const lines = lyricsText.split('\n');
        const lyrics = [];

        // 支持两种格式：
        // 1. 标准 LRC: [mm:ss.xx] 或 [mm:ss.xxx]
        // 2. 酷我格式: [s.ms] (如 [0.0], [3.79])
        const timeRegex = /\[(\d{1,3}):(\d{2})\.(\d{2,3})\](.*)/;
        const kwTimeRegex = /\[(\d+\.\d+)\](.*)/;

        for (const line of lines) {
            let match = line.match(timeRegex);
            let time = null;
            let text = null;

            if (match) {
                // 标准 LRC 格式 [mm:ss.xx]
                const minutes = parseInt(match[1]);
                const seconds = parseInt(match[2]);
                const milliseconds = parseInt(match[3].padEnd(3, '0'));
                time = minutes * 60 + seconds + milliseconds / 1000;
                text = match[4].trim();
            } else {
                // 尝试酷我格式 [s.ms]
                match = line.match(kwTimeRegex);
                if (match) {
                    time = parseFloat(match[1]);
                    text = match[2].trim();
                }
            }

            if (time !== null && text) {
                lyrics.push({ time, text });
            }
        }

        return lyrics.sort((a, b) => a.time - b.time);
    },

    /**
     * 渲染歌词
     */
    renderLyrics() {
        const lyricsContainer = document.getElementById('detail-lyrics');
        if (!lyricsContainer) return;

        if (this.currentLyrics.length === 0) {
            lyricsContainer.innerHTML = '<div class="lyrics-placeholder">暂无歌词</div>';
            return;
        }

        // 每行按字符拆分（先拆字再转义，避免破坏 HTML 实体），供逐字点亮效果使用
        // 末尾占位块：歌词滚到底部时与面板底边保留 20px 间距
        lyricsContainer.innerHTML = this.currentLyrics.map((item, index) => {
            const charsHtml = Array.from(String(item.text || '')).map((ch) => {
                if (ch === ' ') return '<span class="lyrics-char">&nbsp;</span>';
                return `<span class="lyrics-char">${escapeHtml(ch)}</span>`;
            }).join('');
            return `<div class="lyrics-line ${index === 0 ? 'active' : ''}" data-index="${index}" data-time="${item.time}">${charsHtml}</div>`;
        }).join('') + '<div class="lyrics-bottom-gap" style="height: 20px; flex-shrink: 0;"></div>';
    },

    /**
     * 逐字效果：按当前播放进度点亮当前行已唱过的字（模拟逐字，无逐字时间戳）
     * 进度按「当前行 → 下一行」的时间跨度换算，暂停/跳转自动同步
     */
    _updateCharProgress(index, currentTime) {
        if (index < 0) return;
        const container = document.getElementById('detail-lyrics');
        if (!container) return;

        const line = container.querySelector(`.lyrics-line[data-index="${index}"]`);
        if (!line) return;
        const chars = line.querySelectorAll('.lyrics-char');
        if (!chars.length) return;

        const cur = this.currentLyrics[index];
        const next = this.currentLyrics[index + 1];
        const elapsed = Math.max(0, currentTime - (cur.time || 0));
        // 行时长：优先用下一行时间差；没有下一行时按字数估算（每字约 0.08s，最短 1.4s）
        // 乘 0.45：逐字在行时长的 45% 内走完（推进更快，剩余时间留给停顿与下一行衔接）
        const rawDur = (next && next.time > cur.time)
            ? (next.time - cur.time)
            : Math.max(1.4, chars.length * 0.08);
        const lineDur = rawDur * 0.45;

        const ratio = Math.max(0, Math.min(1, elapsed / lineDur));
        const litCount = Math.round(ratio * chars.length);
        chars.forEach((ch, i) => ch.classList.toggle('lit', i < litCount));
    },

    /**
     * 更新歌词高亮
     */
    updateLyricHighlight(currentTime) {
        if (!this.currentLyrics.length) return;

        let newIndex = -1;
        for (let i = 0; i < this.currentLyrics.length; i++) {
            if (this.currentLyrics[i].time <= currentTime) {
                newIndex = i;
            } else {
                break;
            }
        }

        if (newIndex !== this.currentLyricIndex && newIndex >= 0) {
            this.currentLyricIndex = newIndex;

            const lyricsContainer = document.getElementById('detail-lyrics');
            if (lyricsContainer) {
                const lines = lyricsContainer.querySelectorAll('.lyrics-line');
                let activeLine = null;

                lines.forEach((line, index) => {
                    if (index === newIndex) {
                        line.classList.add('active');
                        activeLine = line;
                    } else {
                        line.classList.remove('active');
                        // 非当前行：清空逐字点亮状态
                        line.querySelectorAll('.lyrics-char.lit').forEach((ch) => ch.classList.remove('lit'));
                    }
                });

                // 滚动到中间 - 使用 requestAnimationFrame 避免强制重排
                if (activeLine) {
                    requestAnimationFrame(() => {
                        const containerHeight = lyricsContainer.clientHeight;
                        const lineHeight = activeLine.clientHeight;
                        const lineTop = activeLine.offsetTop;
                        const scrollTop = lineTop - containerHeight / 2 + lineHeight / 2;
                        lyricsContainer.scrollTo({ top: scrollTop, behavior: 'smooth' });
                    });
                }
            }
        }

        // 逐字效果：每次进度更新都刷新当前行点亮进度（暂停/跳转自动同步）
        this._updateCharProgress(newIndex, currentTime);
    },

    /**
     * 初始化控制按钮
     * 使用 PlayerUI 组件
     */
    initControls() {
        const container = document.getElementById('detail-controls-container');
        if (!container) {
            console.warn('[WARN] [] [] Controls container not found');
            return;
        }

        // 检查是否是新的播放会话
        const currentPlaylistId = window.currentPlaylist ? window.currentPlaylist.map(m => m.id).join(',') : '';
        const isNewSession = !window.lastPlaylistId || window.lastPlaylistId !== currentPlaylistId;

        if (isNewSession) {
            // 新播放会话：重建随机播放列表副本。
            // 随机/循环开关属于用户偏好，不随会话重置（否则底部播放器与详情页状态不同步）
            window.repeatMode = 'off';
            window.shuffledPlaylist = null;
            if (window.isShuffleMode && window.currentPlaylist && window.currentPlaylist.length > 0) {
                window.shuffledPlaylist = this.shuffleArray([...window.currentPlaylist]);
            }
        }
        window.lastPlaylistId = currentPlaylistId;

        // 清空容器
        container.innerHTML = '';

        // 使用 PlayerUI 创建主控制按钮组（如果可用）
        if (typeof PlayerUI !== 'undefined') {
            const controls = PlayerUI.createDetailControls({
                onPrev: () => this.playPrev(),
                onPlay: () => this.togglePlay(),
                onStop: () => this.stopAndClose(),
                onNext: () => this.playNext()
            });
            container.appendChild(controls);

            // 更新播放按钮状态
            PlayerUI.updateDetailPlayButton(window.isPlaying || false);

            // 创建音量控制 - 放在主控制按钮之后，额外功能按钮之前
            const player = document.getElementById('audio-player');
            const currentVolume = player ? player.volume : 0.7;
            const isMuted = player ? player.muted : false;

            const volumeControl = PlayerUI.createVolumeControl({
                volume: currentVolume,
                isMuted: isMuted,
                onMuteToggle: () => this.syncExternalPlayerVolume(),
                onVolumeChange: (_volume) => {
                    // 同步外部播放器音量UI
                    this.syncExternalPlayerVolume();
                }
            });
            container.appendChild(volumeControl);

            // 创建额外功能按钮
            const extraControls = PlayerUI.createDetailExtraControls({
                onLyrics: () => this.toggleLyricsPanel(),
                onPlaylist: () => this.togglePlaylistPanel(),
                onShuffle: () => this.toggleShuffleMode(),
                onRepeat: () => this.toggleRepeatMode(),
                onLike: () => this.toggleLike(),
                onDownload: () => this.downloadCurrent(),
                onQuality: () => this.toggleQuality()
            }, {
                lyricsActive: this.isLyricsPanelOpen,
                playlistActive: this.isPlaylistPanelOpen,
                shuffleActive: window.isShuffleMode,
                repeatActive: window.repeatMode !== 'off',
                likeActive: window.isCurrentMusicLiked
            });
            container.appendChild(extraControls);
        } else {
            // 降级方案：使用简单的 HTML 结构
            this.initControlsFallback(container);
        }

        // 更新所有按钮状态
        this.updateModeButtons();
        this.updateLikeButton();
        this.updateQualityButton();
    },

    /**
     * 初始化控制按钮降级方案
     */
    initControlsFallback(container) {
        container.innerHTML = `
            <div class="detail-controls">
                <button id="detail-prev-btn" class="detail-control-btn" title="上一首">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="4" y="6" width="3" height="12" rx="1.5"/><path d="M9 12l8.5-6v12z"/>
                    </svg>
                </button>
                <button id="detail-play-btn" class="detail-control-btn detail-play-btn" title="播放/暂停">
                    ${window.isPlaying
                        ? '<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
                        : '<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
                    }
                </button>
                <button id="detail-stop-btn" class="detail-control-btn" title="停止">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="5" y="5" width="14" height="14" rx="3"/>
                    </svg>
                </button>
                <button id="detail-next-btn" class="detail-control-btn" title="下一首">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 6v12l8.5-6z"/><rect x="17" y="6" width="3" height="12" rx="1.5"/>
                    </svg>
                </button>
            </div>
            <div class="detail-volume-section">
                <span class="detail-volume-icon detail-volume-min" id="detail-volume-min" title="静音">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                    </svg>
                </span>
                <div class="detail-volume-bar" id="detail-volume-bar">
                    <div class="detail-volume-fill" id="detail-volume-fill" style="width: 70%">
                        <div class="detail-volume-thumb"></div>
                    </div>
                </div>
                <span class="detail-volume-icon detail-volume-max" id="detail-volume-max" title="最大音量">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                    </svg>
                </span>
            </div>
            <div class="detail-extra-controls">
                <button id="lyrics-toggle-btn" class="detail-extra-btn active" title="歌词">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-2 16H8v-2h4v2zm4-4H8v-2h8v2zm0-4H8V8h8v2zm-3-5V3.5L18.5 9H13z"/>
                    </svg>
                </button>
                <button id="playlist-toggle-btn" class="detail-extra-btn" title="播放列表">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/>
                    </svg>
                </button>
                <button id="detail-shuffle-btn" class="detail-extra-btn" title="随机播放">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
                    </svg>
                </button>
                <button id="detail-repeat-btn" class="detail-extra-btn" title="循环播放">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
                    </svg>
                </button>
                <button id="detail-like-btn" class="detail-extra-btn" title="收藏">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                    </svg>
                </button>
                <button id="detail-download-btn" class="detail-extra-btn download-btn" title="下载">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                    </svg>
                </button>
                <button id="detail-source-switch-btn" class="detail-extra-btn" title="切换音源" onclick="window.openSourceSwitch && window.openSourceSwitch()">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M7 16V4M7 4 3 8M7 4l4 4"/><path d="M17 8v12M17 20l4-4M17 20l-4-4"/>
                    </svg>
                </button>
                <button id="quality-btn" class="detail-extra-btn quality-btn" title="音质">
                    <span id="quality-text">标</span>
                </button>
            </div>
        `;

        // 初始化音量控制
        this.initVolumeControl();

        // 监听下载状态变化事件
        this.initDownloadStatusListener();

        // 绑定事件
        const playBtn = document.getElementById('detail-play-btn');
        if (playBtn) playBtn.onclick = () => this.togglePlay();

        const prevBtn = document.getElementById('detail-prev-btn');
        if (prevBtn) prevBtn.onclick = () => this.playPrev();

        const nextBtn = document.getElementById('detail-next-btn');
        if (nextBtn) nextBtn.onclick = () => this.playNext();

        const stopBtn = document.getElementById('detail-stop-btn');
        if (stopBtn) stopBtn.onclick = () => this.stopAndClose();

        const shuffleBtn = document.getElementById('detail-shuffle-btn');
        if (shuffleBtn) shuffleBtn.onclick = () => this.toggleShuffleMode();

        const repeatBtn = document.getElementById('detail-repeat-btn');
        if (repeatBtn) repeatBtn.onclick = () => this.toggleRepeatMode();

        const likeBtn = document.getElementById('detail-like-btn');
        if (likeBtn) likeBtn.onclick = () => this.toggleLike();

        const downloadBtn = document.getElementById('detail-download-btn');
        if (downloadBtn) downloadBtn.onclick = () => this.downloadCurrent();

        const lyricsBtn = document.getElementById('lyrics-toggle-btn');
        if (lyricsBtn) lyricsBtn.onclick = () => this.toggleLyricsPanel();

        const playlistBtn = document.getElementById('playlist-toggle-btn');
        if (playlistBtn) playlistBtn.onclick = () => this.togglePlaylistPanel();

        const qualityBtn = document.getElementById('quality-btn');
        if (qualityBtn) qualityBtn.onclick = () => {
            if (typeof openQualityDropdown === 'function') {
                openQualityDropdown(qualityBtn);
            }
        };

        // 更多按钮点击事件
        const moreBtn = document.getElementById('detail-title-more');
        if (moreBtn) {
            moreBtn.onclick = () => {
                // 触发底部功能区的显示或显示更多选项
                const extraControls = document.querySelector('.detail-extra-controls');
                if (extraControls) {
                    extraControls.scrollIntoView({ behavior: 'smooth' });
                }
            };
        }
    },

    /**
     * 播放上一首
     */
    playPrev() {
        if (typeof window.playPrev === 'function') {
            window.playPrev();
        }
    },

    /**
     * 播放下一首
     */
    playNext() {
        if (typeof window.playNext === 'function') {
            window.playNext();
        }
    },

    /**
     * 切换播放
     */
    togglePlay() {
        if (typeof PlayerModule !== 'undefined') {
            PlayerModule.togglePlay();
        } else if (typeof togglePlay === 'function') {
            togglePlay();
        }
    },

    /**
     * 切换音质
     */
    toggleQuality() {
        if (typeof PlayerModule !== 'undefined') {
            PlayerModule.toggleQuality();
        } else if (typeof toggleQuality === 'function') {
            toggleQuality();
        }
    },

    /**
     * 同步外部播放器音量UI
     */
    initVolumeControl() {
        const player = document.getElementById('audio-player');
        const volumeBar = document.getElementById('detail-volume-bar');
        const volumeFill = document.getElementById('detail-volume-fill');
        const volumeMin = document.getElementById('detail-volume-min');
        const volumeMax = document.getElementById('detail-volume-max');

        if (!player || !volumeBar) return;

        // 初始化 previousVolume
        const savedPreviousVolume = localStorage.getItem('previousVolume');
        if (savedPreviousVolume !== null) {
            window.previousVolume = parseFloat(savedPreviousVolume);
        } else if (typeof window.previousVolume === 'undefined') {
            window.previousVolume = 0.7;
        }

        // 初始化音量显示 - 使用播放器实际音量
        const currentVolume = player.volume;
        if (volumeFill) {
            volumeFill.style.width = `${currentVolume * 100}%`;
        }
        this.updateVolumeIcon(currentVolume, player.muted);

        // 音量条拖动
        let isDragging = false;
        let volumeRect = null;

        const updateVolumeFromEvent = (e) => {
            // 缓存 rect 避免拖拽过程中重复计算
            if (!volumeRect) {
                volumeRect = volumeBar.getBoundingClientRect();
            }
            const percent = Math.max(0, Math.min(1, (e.clientX - volumeRect.left) / volumeRect.width));

            player.volume = percent;
            player.muted = percent === 0;

            if (volumeFill) {
                volumeFill.style.width = `${percent * 100}%`;
            }

            // 保存音量到 localStorage
            localStorage.setItem('playerVolume', percent);

            // 更新图标
            this.updateVolumeIcon(percent, percent === 0);

            // 同步外部播放器音量UI
            this.syncExternalPlayerVolume();
        };

        volumeBar.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isDragging = true;
            volumeRect = volumeBar.getBoundingClientRect(); // 开始拖拽时缓存位置
            updateVolumeFromEvent(e);
            volumeBar.classList.add('active');
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            updateVolumeFromEvent(e);
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                volumeRect = null; // 清除缓存
                volumeBar.classList.remove('active');
            }
        });

        // 触摸事件（移动端音量拖动）
        volumeBar.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isDragging = true;
            updateVolumeFromEvent(e.touches[0]);
            volumeBar.classList.add('active');
        }, { passive: false });

        document.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            updateVolumeFromEvent(e.touches[0]);
        }, { passive: false });

        document.addEventListener('touchend', () => {
            if (isDragging) {
                isDragging = false;
                volumeBar.classList.remove('active');
            }
        });

        volumeBar.addEventListener('click', (e) => {
            e.stopPropagation();
            updateVolumeFromEvent(e);
        });

        // 静音按钮
        if (volumeMin) {
            volumeMin.onclick = () => {
                const isMuted = player.volume === 0 || player.muted;

                if (isMuted) {
                    // 恢复音量
                    const previousVolume = window.previousVolume || 0.7;
                    player.volume = previousVolume;
                    player.muted = false;
                    localStorage.setItem('playerVolume', previousVolume);
                    if (volumeFill) volumeFill.style.width = `${previousVolume * 100}%`;
                    this.updateVolumeIcon(previousVolume, false);
                } else {
                    // 保存当前音量并静音
                    window.previousVolume = player.volume;
                    localStorage.setItem('previousVolume', player.volume);
                    player.volume = 0;
                    player.muted = true;
                    localStorage.setItem('playerVolume', 0);
                    if (volumeFill) volumeFill.style.width = '0%';
                    this.updateVolumeIcon(0, true);
                }

                // 同步外部播放器音量UI
                this.syncExternalPlayerVolume();
            };
        }

        // 最大音量按钮
        if (volumeMax) {
            volumeMax.onclick = () => {
                player.volume = 1;
                player.muted = false;
                localStorage.setItem('playerVolume', 1);
                if (volumeFill) volumeFill.style.width = '100%';
                this.updateVolumeIcon(1, false);

                // 同步外部播放器音量UI
                this.syncExternalPlayerVolume();
            };
        }
    },

    /**
     * 同步外部播放器音量UI
     */
    syncExternalPlayerVolume() {
        const player = document.getElementById('audio-player');
        if (!player) return;

        // 调用外部播放器的音量更新函数
        if (typeof updatePlayerVolumeUI === 'function') {
            updatePlayerVolumeUI();
        }
        if (typeof updateExternalVolumeButton === 'function') {
            updateExternalVolumeButton(player.muted || player.volume === 0);
        }
    },

    /**
     * 更新音量图标
     */
    updateVolumeIcon(volume, isMuted) {
        const volumeMin = document.getElementById('detail-volume-min');
        const volumeMax = document.getElementById('detail-volume-max');

        if (!volumeMin || !volumeMax) return;

        // 静音图标
        const muteIcon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
        // 低音量图标
        const lowIcon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg>';
        // 高音量图标
        const highIcon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';

        if (isMuted || volume === 0) {
            volumeMin.innerHTML = muteIcon;
            volumeMax.innerHTML = muteIcon;
        } else if (volume < 0.5) {
            volumeMin.innerHTML = lowIcon;
            volumeMax.innerHTML = lowIcon;
        } else {
            volumeMin.innerHTML = highIcon;
            volumeMax.innerHTML = highIcon;
        }
    },

    /**
     * 更新播放按钮状态
     */
    updatePlayButton(isPlaying) {
        const playBtn = document.getElementById('detail-play-btn');
        if (!playBtn) return;

        playBtn.innerHTML = isPlaying
            ? '<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
            : '<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    },

    /**
     * 更新播放模式按钮
     */
    updateModeButtons() {
        // 更新循环按钮状态和图标（使用全局函数）
        if (typeof updateRepeatButtonIcon === 'function') {
            updateRepeatButtonIcon();
        }

        // 更新播放详情页随机播放按钮
        const shuffleBtn = document.getElementById('detail-shuffle-btn');
        if (shuffleBtn) {
            shuffleBtn.classList.toggle('active', window.isShuffleMode);
        }

        // 更新底部播放器随机播放按钮
        const playerShuffleBtn = document.getElementById('player-shuffle-btn');
        if (playerShuffleBtn) {
            playerShuffleBtn.classList.toggle('active', window.isShuffleMode);
        }
    },

    /**
     * 切换随机播放模式
     */
    toggleShuffleMode() {
        window.isShuffleMode = !window.isShuffleMode;

        if (window.isShuffleMode) {
            Notification.toast('随机播放：开关', 'success');
            // 创建随机播放列表副本
            if (window.currentPlaylist && window.currentPlaylist.length > 0) {
                window.shuffledPlaylist = [...window.currentPlaylist];
                this.shuffleArray(window.shuffledPlaylist);
            }
            // 如果激活了随机播放，取消循环播放
            if (window.repeatMode && window.repeatMode !== 'off') {
                window.repeatMode = 'off';
                Notification.toast('循环播放：关闭', 'info');
            }
        } else {
            Notification.toast('随机播放：关闭', 'info');
            window.shuffledPlaylist = null;
        }

        this.updateModeButtons();
    },

    /**
     * 切换循环播放模式
     */
    toggleRepeatMode() {
        const modes = ['off', 'single', 'list'];
        const modeNames = { off: '循环', list: '列表循环', single: '单曲循环' };

        const currentIndex = modes.indexOf(window.repeatMode || 'off');
        window.repeatMode = modes[(currentIndex + 1) % modes.length];

        Notification.toast(modeNames[window.repeatMode], 'info');

        // 如果激活了循环模式，取消随机播放
        if (window.repeatMode !== 'off' && window.isShuffleMode) {
            window.isShuffleMode = false;
            window.shuffledPlaylist = null;
            Notification.toast('随机播放：关闭', 'info');
        }

        // 更新循环按钮图标
        if (typeof updateRepeatButtonIcon === 'function') {
            updateRepeatButtonIcon();
        }

        this.updateModeButtons();
    },

    /**
     * 随机打乱数组（Fisher-Yates算法）
     */
    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    },

    /**
     * 更新收藏按钮
     */
    async updateLikeButton() {
        const likeBtn = document.getElementById('detail-like-btn');
        if (!likeBtn || !window.currentMusic) return;

        const music = window.currentMusic;
        const plugin = music.platform || music.plugin;

        // 设置 dataset 属性以便 ButtonManager 识别
        likeBtn.dataset.musicId = music.id;
        likeBtn.dataset.platform = plugin || '';

        // 优先使用新的 StateManager + ButtonManager
        if (window.StateManager && window.ButtonManager) {
            // 如果正在进行收藏操作，跳过
            if (this._isTogglingFavorite) {
                console.log('[INFO] [] Skipping async favorite check during toggle');
                return;
            }

            // 如果当前在收藏页面，强制显示为已收藏（因为从收藏菜单播放的歌曲一定是已收藏的）
            const isLiked = window.currentPage === 'favorites' ? true : StateManager.getFavoriteStatus(music.id, plugin);
            ButtonManager.updateFavoriteButton(music.id, plugin, isLiked);

            // 异步更新精确状态
            const actualLiked = await FavoriteManager.isFavorited(music);

            if (this._isTogglingFavorite) {
                console.log('[INFO] [] Skipping favorite update after async check, toggle in progress');
                return;
            }

            window.isCurrentMusicLiked = actualLiked;
            music._isLiked = actualLiked;
            StateManager.setFavoriteStatus(music.id, plugin, actualLiked);
            return;
        }

        // 兼容旧代码
        if (window.FavoriteManager) {
            const isLiked = FavoriteManager.isFavoritedSync(music);
            FavoriteManager.updateDetailButton(isLiked);

            // 如果正在进行收藏操作，跳过异步查询，避免覆盖事件处理的结果
            if (this._isTogglingFavorite) {
                console.log('[INFO] [] Skipping async favorite check during toggle');
                return;
            }

            // 异步更新精确状态
            const actualLiked = await FavoriteManager.isFavorited(music);

            // 再次检查标志，因为异步操作期间可能已经开始新的收藏操作
            if (this._isTogglingFavorite) {
                console.log('[INFO] [] Skipping favorite update after async check, toggle in progress');
                return;
            }

            window.isCurrentMusicLiked = actualLiked;
            music._isLiked = actualLiked;
            if (actualLiked !== isLiked) {
                FavoriteManager.updateDetailButton(actualLiked);
            }
        }
    },

    /**
     * 更新音质按钮
     */
    updateQualityButton() {
        const currentQuality = window.currentQuality || 'standard';

        // 使用 PlayerModule 的方法同时更新两个地方
        if (typeof PlayerModule !== 'undefined' && PlayerModule.updateQualityButton) {
            PlayerModule.updateQualityButton(currentQuality);
        } else {
            // 降级方案：只更新播放详情页
            const qualityText = document.getElementById('quality-text');
            const qualityBtn = document.getElementById('quality-btn');
            const config = window.QUALITY_CONFIG || {};

            if (qualityText && config[currentQuality]) {
                qualityText.textContent = config[currentQuality].abbr;
            }
            if (qualityBtn && config[currentQuality]) {
                qualityBtn.title = config[currentQuality].name;
            }
        }
    },

    /**
     * 检查是否已收藏
     */
    async checkIsLiked() {
        if (!window.currentMusic) return false;

        try {
            if (typeof isSongFavorited === 'function') {
                return await isSongFavorited(
                    window.currentMusic.id,
                    window.currentMusic.platform || window.currentMusic.plugin
                );
            }

            const result = await API.favorites.check(
                window.currentMusic.id,
                window.currentMusic.platform || window.currentMusic.plugin
            );
            return result.success && result.data?.isFavorited;
        } catch (error) {
            return false;
        }
    },

    /**
     * 切换收藏状态
     */
    async toggleLike() {
        if (!window.currentMusic) {
            Notification.toast('没有正在播放的歌单', 'warning');
            return;
        }

        // 设置标志，防止 updateLikeButton 的异步查询覆盖结果
        this._isTogglingFavorite = true;

        try {
            if (typeof toggleFavoriteSong === 'function') {
                // toggleFavoriteSong 会触发 emitFavoriteChange 事件
                // 所有订阅者（包括本组件）会自动更新 UI
                const isLiked = await toggleFavoriteSong(window.currentMusic);

                // toggleFavoriteSong 已经更新了全局状态和触发了事件
                // 不需要再手动调用 updateLikeButton，避免异步查询覆盖状态

                Notification.toast(isLiked ? '已添加到收藏' : '已取消收藏', 'success');
            } else {
                // 使用 API 直接操作
                const isLiked = await this.checkIsLiked();

                if (isLiked) {
                    await API.favorites.remove(
                        window.currentMusic.id,
                        window.currentMusic.platform || window.currentMusic.plugin
                    );
                    Notification.toast('已取消收藏', 'info');
                } else {
                    await API.favorites.add(window.currentMusic);
                    Notification.toast('已添加到收藏', 'success');
                }

                this.updateLikeButton();
            }
        } catch (error) {
            console.error('[ERROR] [] [] 收藏操作失败:', error);
            Notification.toast('操作失败', 'error');
        } finally {
            // 清除标志
            this._isTogglingFavorite = false;
        }
    },

    /**
     * 下载当前歌曲
     */
    async downloadCurrent() {
        if (!window.currentMusic) {
            Notification.toast('没有正在播放的歌曲', 'warning');
            return;
        }

        const plugin = window.currentMusic.platform || window.currentMusic.plugin;
        if (!plugin) {
            Notification.toast('无法确定歌曲来源', 'error');
            return;
        }

        // 实时查询数据库检查是否已下载
        try {
            if (window.StateManager?.isDownloaded) {
                const isDownloaded = await window.StateManager.isDownloaded(window.currentMusic.id, plugin);
                if (isDownloaded) {
                    // 已下载，显示确认弹窗
                    this.showReDownloadConfirm(window.currentMusic);
                    return;
                }
            }
        } catch (e) {
            console.error('检查下载状态失败:', e);
        }

        if (window.DownloadCore) {
            await window.DownloadCore.startBackendDownload(window.currentMusic, '播放详情-下载');
        } else {
            Notification.toast('下载功能未加载', 'error');
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
            Notification.toast('歌曲信息不完整，无法重新下载', 'error');
            return;
        }

        try {
            Notification.toast(`正在重新下载「${song.title}」...`, 'info');

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
                    source: 'player-detail-retry',
                    force: true
                })
            });

            const result = await response.json();

            if (result.success) {
                Notification.toast(`「${song.title}」重新下载任务已添加`, 'success');
            } else {
                Notification.toast(result.error || '重新下载失败', 'error');
            }
        } catch (error) {
            console.error('重新下载失败:', error);
            Notification.toast(`重新下载失败: ${error.message}`, 'error');
        }
    },

    /**
     * 初始化下载状态监听器
     */
    initDownloadStatusListener() {
        // 监听下载状态变化事件
        window.addEventListener('download:statusChanged', (event) => {
            const { musicId, plugin, status } = event.detail;
            if (!window.currentMusic) return;

            const currentId = String(window.currentMusic.id);
            const currentPlugin = window.currentMusic.platform || window.currentMusic.plugin;

            // 检查是否是当前播放的歌曲
            if (musicId === currentId && plugin === currentPlugin) {
                this.updateDownloadButton(status);
            }
        });
    },

    /**
     * 更新下载按钮状态
     * @param {string} status - 'normal' | 'downloading' | 'downloaded'
     */
    updateDownloadButton(status) {
        const downloadBtn = document.getElementById('detail-download-btn');
        if (!downloadBtn) return;

        // 移除所有状态类
        downloadBtn.classList.remove('downloading', 'downloaded');

        // 判断按钮类型，使用不同大小的图标
        const iconSize = 24;

        switch (status) {
            case 'downloading':
                downloadBtn.classList.add('downloading');
                downloadBtn.innerHTML = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>`;
                downloadBtn.title = '下载中...';
                break;
            case 'downloaded':
                downloadBtn.classList.add('downloaded');
                downloadBtn.innerHTML = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;
                downloadBtn.title = '已下载';
                break;
            default:
                downloadBtn.innerHTML = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;
                downloadBtn.title = '下载';
        }
    },

    /**
     * 初始化进度条拖动
     */
    initProgressDrag() {
        const progressBar = document.getElementById('detail-progress-bar');
        const progressThumb = document.querySelector('.detail-progress-thumb');

        if (progressBar) {
            // 鼠标事件
            progressBar.addEventListener('mousedown', (e) => {
                this.isDraggingProgress = true;
                // 添加 dragging 类禁用 transition，使拖动更流畅
                const progressFill = document.getElementById('detail-progress-fill');
                if (progressFill) {
                    progressFill.classList.add('dragging');
                }
                this.seek(e);
            });
            // 触摸事件（移动端）
            progressBar.addEventListener('touchstart', (e) => {
                this.isDraggingProgress = true;
                const progressFill = document.getElementById('detail-progress-fill');
                if (progressFill) {
                    progressFill.classList.add('dragging');
                }
                this.seek(e.touches[0]);
            }, { passive: false });
        }

        if (progressThumb) {
            // 鼠标事件
            progressThumb.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.isDraggingProgress = true;
                // 添加 dragging 类禁用 transition
                const progressFill = document.getElementById('detail-progress-fill');
                if (progressFill) {
                    progressFill.classList.add('dragging');
                }
            });
            // 触摸事件（移动端）
            progressThumb.addEventListener('touchstart', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.isDraggingProgress = true;
                const progressFill = document.getElementById('detail-progress-fill');
                if (progressFill) {
                    progressFill.classList.add('dragging');
                }
            }, { passive: false });
        }
    },

    /**
     * 跳转进度
     */
    seek(event) {
        const player = document.getElementById('audio-player');
        const progressBar = document.getElementById('detail-progress-bar');

        if (!player || !player.duration || !progressBar) return;

        // 使用 requestAnimationFrame 避免强制重排
        requestAnimationFrame(() => {
            const rect = progressBar.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
            player.currentTime = percent * player.duration;

            // 更新进度条显示
            const progressFill = document.getElementById('detail-progress-fill');
            if (progressFill) {
                progressFill.style.width = (percent * 100) + '%';
            }
        });
    },

    /**
     * 显示歌词面板
     */
    toggleLyricsPanel() {
        const lyricsContainer = document.getElementById('detail-lyrics');
        const playlistContainer = document.getElementById('detail-playlist');
        const rightSection = document.querySelector('.detail-right');
        const leftSection = document.querySelector('.detail-left');
        const overlay = document.getElementById('player-detail-overlay');
        const lyricsBtn = document.getElementById('lyrics-toggle-btn');
        const playlistBtn = document.getElementById('playlist-toggle-btn');

        if (!lyricsContainer || !rightSection || !leftSection) return;

        // 仅手机使用全屏覆盖式面板
        const isPhone = window.innerWidth <= 768 && !(window.innerWidth > window.innerHeight);

        // 切换显示状态（初始没有 display 样式时也认为是隐藏的）
        const lyricsDisplay = lyricsContainer.style ? lyricsContainer.style.display : 'none';
        const isLyricsHidden = !lyricsDisplay || lyricsDisplay === 'none';
        if (isLyricsHidden || (isPhone && !this.isLyricsPanelOpen)) {
            // 显示歌词，隐藏播放列表
            lyricsContainer.style.display = 'block';
            if (playlistContainer) playlistContainer.style.display = 'none';
            this.isLyricsPanelOpen = true;
            this.isPlaylistPanelOpen = false;
            window.isPlaylistOpen = false;

            // 更新按钮状态
            if (lyricsBtn) lyricsBtn.classList.add('active');
            if (playlistBtn) playlistBtn.classList.remove('active');

            // 显示关闭按钮
            const closeBtn = document.getElementById('detail-panel-close');
            if (closeBtn) closeBtn.style.display = 'flex';

            if (isPhone) {
                // 手机：隐藏左侧，全屏显示歌词
                leftSection.classList.add('hidden');
                rightSection.style.display = 'flex';
                rightSection.classList.add('active');
                if (overlay) overlay.classList.add('mobile-panel-open');
            } else {
                // 平板/桌面：歌词与播放区并排显示
                rightSection.style.display = 'flex';
                rightSection.classList.add('active');
                rightSection.style.position = '';
                rightSection.style.left = '';
                rightSection.style.top = '';
                rightSection.style.width = '';
                rightSection.style.height = '';
                rightSection.style.zIndex = '';
                const content = leftSection.parentElement;
                if (content) content.style.justifyContent = 'flex-start';
            }

            // 滚动到当前歌词 - 使用 requestAnimationFrame 避免强制重排
            if (this.currentLyrics.length > 0 && this.currentLyricIndex >= 0) {
                setTimeout(() => {
                    const lyricsContainer = document.getElementById('detail-lyrics');
                    if (lyricsContainer) {
                        const lines = lyricsContainer.querySelectorAll('.lyrics-line');
                        const activeLine = lines[this.currentLyricIndex];
                        if (activeLine) {
                            requestAnimationFrame(() => {
                                const containerHeight = lyricsContainer.clientHeight;
                                const lineHeight = activeLine.clientHeight;
                                const lineTop = activeLine.offsetTop;
                                const scrollTop = lineTop - containerHeight / 2 + lineHeight / 2;
                                lyricsContainer.scrollTo({ top: scrollTop, behavior: 'smooth' });
                            });
                        }
                    }
                }, 100);
            }
        } else {
            // 已显示歌词，再次点击
            if (isPhone) {
                // 手机：切换到播放列表（左侧保持隐藏）
                if (playlistContainer) {
                    lyricsContainer.style.display = 'none';
                    playlistContainer.style.display = 'flex';
                    this.isLyricsPanelOpen = false;
                    this.isPlaylistPanelOpen = true;
                    window.isPlaylistOpen = true;
                    if (lyricsBtn) lyricsBtn.classList.remove('active');
                    if (playlistBtn) playlistBtn.classList.add('active');
                }
            } else {
                // 平板/桌面：关闭歌词，左侧居中
                lyricsContainer.style.display = 'none';
                rightSection.style.display = 'none';
                rightSection.classList.remove('active');
                const content = leftSection.parentElement;
                if (content) content.style.justifyContent = 'center';
                this.isLyricsPanelOpen = false;
                if (lyricsBtn) lyricsBtn.classList.remove('active');
            }
        }

        // 更新播放器上的按钮状态
        if (typeof updatePlayerExtraButtons === 'function') {
            updatePlayerExtraButtons();
        }
    },

    showLyricsPanel() {
        // 强制显示歌词面板（用于初始打开时）
        const lyricsContainer = document.getElementById('detail-lyrics');
        const playlistContainer = document.getElementById('detail-playlist');
        const rightSection = document.querySelector('.detail-right');
        const leftSection = document.querySelector('.detail-left');
        const lyricsBtn = document.getElementById('lyrics-toggle-btn');
        const playlistBtn = document.getElementById('playlist-toggle-btn');

        if (!lyricsContainer || !rightSection || !leftSection) return;

        // 显示歌词，隐藏播放列表
        lyricsContainer.style.display = 'block';
        if (playlistContainer) playlistContainer.style.display = 'none';

        // 仅手机（竖屏且宽度<=768）全屏显示歌词；平板/桌面与播放区并排
        const isPhone = window.innerWidth <= 768 && !(window.innerWidth > window.innerHeight);

        if (isPhone) {
            // 手机：隐藏左侧，全屏显示歌词
            leftSection.classList.add('hidden');
            rightSection.style.display = 'flex';
            rightSection.classList.add('active');
        } else {
            // 宽屏桌面端：右侧显示，左侧左对齐
            rightSection.style.display = 'flex';
            rightSection.classList.add('active');
            rightSection.style.position = '';
            rightSection.style.left = '';
            rightSection.style.top = '';
            rightSection.style.width = '';
            rightSection.style.height = '';
            rightSection.style.zIndex = '';
            const content = leftSection.parentElement;
            if (content) content.style.justifyContent = 'flex-start';
        }

        this.isLyricsPanelOpen = true;
        this.isPlaylistPanelOpen = false;
        window.isPlaylistOpen = false;

        // 更新按钮状态
        if (lyricsBtn) lyricsBtn.classList.add('active');
        if (playlistBtn) playlistBtn.classList.remove('active');

        // 显示关闭按钮
        const closeBtn = document.getElementById('detail-panel-close');
        if (closeBtn) closeBtn.style.display = 'flex';

        // 滚动到当前歌单 - 使用 requestAnimationFrame 避免强制重排
        if (this.currentLyrics.length > 0 && this.currentLyricIndex >= 0) {
            setTimeout(() => {
                const lyricsContainer = document.getElementById('detail-lyrics');
                if (lyricsContainer) {
                    const lines = lyricsContainer.querySelectorAll('.lyrics-line');
                    const activeLine = lines[this.currentLyricIndex];
                    if (activeLine) {
                        requestAnimationFrame(() => {
                            const containerHeight = lyricsContainer.clientHeight;
                            const lineHeight = activeLine.clientHeight;
                            const lineTop = activeLine.offsetTop;
                            const scrollTop = lineTop - containerHeight / 2 + lineHeight / 2;
                            lyricsContainer.scrollTo({ top: scrollTop, behavior: 'smooth' });
                        });
                    }
                }
            }, 100);
        }

        // 更新播放器上的按钮状态
        if (typeof updatePlayerExtraButtons === 'function') {
            updatePlayerExtraButtons();
        }
    },

    /**
     * 隐藏歌词面板
     */
    hideLyricsPanel() {
        const lyricsContainer = document.getElementById('detail-lyrics');
        const rightSection = document.querySelector('.detail-right');
        const leftSection = document.querySelector('.detail-left');
        const overlay = document.getElementById('player-detail-overlay');
        const lyricsBtn = document.getElementById('lyrics-toggle-btn');
        const playlistBtn = document.getElementById('playlist-toggle-btn');

        if (!lyricsContainer || !rightSection || !leftSection) return;

        const isPhone = window.innerWidth <= 768 && !(window.innerWidth > window.innerHeight);

        if (isPhone) {
            // 手机：隐藏歌词，显示左侧，隐藏右侧
            lyricsContainer.style.display = 'none';
            rightSection.style.display = 'none';
            rightSection.classList.remove('active');
            leftSection.classList.remove('hidden');
            if (overlay) overlay.classList.remove('mobile-panel-open');
            Notification.toast('歌词已隐藏', 'info');
        } else {
            // 平板/桌面：隐藏歌词，左侧居中
            lyricsContainer.style.display = 'none';
            rightSection.style.display = 'none';
            rightSection.classList.remove('active');
            const content = leftSection.parentElement;
            if (content) content.style.justifyContent = 'center';
            Notification.toast('歌词已隐藏', 'info');
        }

        this.isLyricsPanelOpen = false;

        // 更新按钮状态
        if (lyricsBtn) lyricsBtn.classList.remove('active');
        if (playlistBtn) playlistBtn.classList.remove('active');

        // 隐藏关闭按钮
        const closeBtn = document.getElementById('detail-panel-close');
        if (closeBtn) closeBtn.style.display = 'none';

        // 更新播放器上的按钮状态
        if (typeof updatePlayerExtraButtons === 'function') {
            updatePlayerExtraButtons();
        }
    },

    /**
     * 隐藏播放列表面板
     */
    hidePlaylistPanel() {
        const playlistContainer = document.getElementById('detail-playlist');
        const rightSection = document.querySelector('.detail-right');
        const leftSection = document.querySelector('.detail-left');
        const overlay = document.getElementById('player-detail-overlay');
        const lyricsBtn = document.getElementById('lyrics-toggle-btn');
        const playlistBtn = document.getElementById('playlist-toggle-btn');

        if (!rightSection || !leftSection) return;

        const isPhone = window.innerWidth <= 768 && !(window.innerWidth > window.innerHeight);

        if (isPhone) {
            // 手机：隐藏播放列表，显示左侧，隐藏右侧
            if (playlistContainer) playlistContainer.style.display = 'none';
            rightSection.style.display = 'none';
            rightSection.classList.remove('active');
            leftSection.classList.remove('hidden');
            if (overlay) overlay.classList.remove('mobile-panel-open');
        } else {
            // 平板/桌面：隐藏播放列表，左侧居中
            if (playlistContainer) playlistContainer.style.display = 'none';
            rightSection.style.display = 'none';
            rightSection.classList.remove('active');
            const content = leftSection.parentElement;
            if (content) content.style.justifyContent = 'center';
        }

        this.isLyricsPanelOpen = false;
        this.isPlaylistPanelOpen = false;
        window.isPlaylistOpen = false;

        // 更新按钮状态
        if (lyricsBtn) lyricsBtn.classList.remove('active');
        if (playlistBtn) playlistBtn.classList.remove('active');

        // 隐藏关闭按钮
        const closeBtn = document.getElementById('detail-panel-close');
        if (closeBtn) closeBtn.style.display = 'none';

        // 更新播放器上的按钮状态
        if (typeof updatePlayerExtraButtons === 'function') {
            updatePlayerExtraButtons();
        }
    },

    /**
     * 显示播放列表面板
     */
    togglePlaylistPanel() {
        const lyricsContainer = document.getElementById('detail-lyrics');
        const playlistContainer = document.getElementById('detail-playlist');
        const rightSection = document.querySelector('.detail-right');
        const leftSection = document.querySelector('.detail-left');
        const overlay = document.getElementById('player-detail-overlay');
        const lyricsBtn = document.getElementById('lyrics-toggle-btn');
        const playlistBtn = document.getElementById('playlist-toggle-btn');

        if (!rightSection || !leftSection) return;

        // 仅手机使用全屏覆盖式面板
        const isPhone = window.innerWidth <= 768 && !(window.innerWidth > window.innerHeight);

        // 如果播放列表已打开，则切回封面
        if (this.isPlaylistPanelOpen || window.isPlaylistOpen) {
            if (isPhone) {
                // 手机：切换到歌词（左侧保持隐藏）
                if (playlistContainer) {
                    playlistContainer.style.display = 'none';
                    lyricsContainer.style.display = 'block';
                    this.isLyricsPanelOpen = true;
                    this.isPlaylistPanelOpen = false;
                    window.isPlaylistOpen = false;
                    if (lyricsBtn) lyricsBtn.classList.add('active');
                    if (playlistBtn) playlistBtn.classList.remove('active');
                }
            } else {
                // 平板/桌面：关闭播放列表，左侧居中
                if (playlistContainer) playlistContainer.style.display = 'none';
                rightSection.style.display = 'none';
                rightSection.classList.remove('active');
                const content = leftSection.parentElement;
                if (content) content.style.justifyContent = 'center';
            }
            this.isLyricsPanelOpen = false;
            this.isPlaylistPanelOpen = false;
            window.isPlaylistOpen = false;
            if (lyricsBtn) lyricsBtn.classList.remove('active');
            if (playlistBtn) playlistBtn.classList.remove('active');
            // 更新播放器上的按钮状态
            if (typeof updatePlayerExtraButtons === 'function') {
                updatePlayerExtraButtons();
            }
            return;
        }

        // 检查是否有播放列表
        if (!window.currentPlaylist || window.currentPlaylist.length === 0) {
            Notification.toast('播放列表为空', 'warning');
            return;
        }

        // 显示播放列表面板
        if (lyricsContainer) lyricsContainer.style.display = 'none';
        if (playlistContainer) playlistContainer.style.display = 'flex';

        this.isLyricsPanelOpen = false;
        this.isPlaylistPanelOpen = true;
        window.isPlaylistOpen = true;

        if (lyricsBtn) lyricsBtn.classList.remove('active');
        if (playlistBtn) playlistBtn.classList.add('active');

        // 显示关闭按钮
        const closeBtn = document.getElementById('detail-panel-close');
        if (closeBtn) closeBtn.style.display = 'flex';

        if (isPhone) {
            // 手机：隐藏左侧，全屏显示播放列表
            leftSection.classList.add('hidden');
            rightSection.style.display = 'flex';
            rightSection.classList.add('active');
            if (overlay) overlay.classList.add('mobile-panel-open');
            Notification.toast('已切换到播放列表', 'info');
        } else {
            // 宽屏桌面端：右侧显示，左侧左对齐
            rightSection.style.display = 'flex';
            rightSection.classList.add('active');
            // 恢复默认样式
            rightSection.style.position = '';
            rightSection.style.left = '';
            rightSection.style.top = '';
            rightSection.style.width = '';
            rightSection.style.height = '';
            rightSection.style.zIndex = '';
            const content = leftSection.parentElement;
            if (content) content.style.justifyContent = 'flex-start';
            Notification.toast('已切换到播放列表', 'info');
        }

        this.renderPlaylist();

        // 滚动到当前歌曲
        setTimeout(() => {
            const playlistContent = document.getElementById('playlist-content');
            if (playlistContent) {
                const currentItem = playlistContent.querySelector('.playlist-item.playing');
                if (currentItem) {
                    currentItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }, 100);

        // 更新播放器上的按钮状态
        if (typeof updatePlayerExtraButtons === 'function') {
            updatePlayerExtraButtons();
        }
    },

    showPlaylistPanel() {
        // 强制显示播放列表面板
        const lyricsContainer = document.getElementById('detail-lyrics');
        const playlistContainer = document.getElementById('detail-playlist');
        const rightSection = document.querySelector('.detail-right');
        const leftSection = document.querySelector('.detail-left');
        const lyricsBtn = document.getElementById('lyrics-toggle-btn');
        const playlistBtn = document.getElementById('playlist-toggle-btn');

        if (!rightSection || !leftSection) return;

        // 检查是否有播放列表
        if (!window.currentPlaylist || window.currentPlaylist.length === 0) {
            Notification.toast('播放列表为空', 'warning');
            return;
        }

        // 隐藏歌词，显示播放列表
        if (lyricsContainer) lyricsContainer.style.display = 'none';
        if (playlistContainer) playlistContainer.style.display = 'flex';

        const isPhone = window.innerWidth <= 768 && !(window.innerWidth > window.innerHeight);

        if (isPhone) {
            // 手机：隐藏左侧，全屏显示播放列表
            leftSection.classList.add('hidden');
            rightSection.style.display = 'flex';
            rightSection.classList.add('active');
        } else {
            // 宽屏桌面端：右侧显示，左侧左对齐
            rightSection.style.display = 'flex';
            rightSection.classList.add('active');
            rightSection.style.position = '';
            rightSection.style.left = '';
            rightSection.style.top = '';
            rightSection.style.width = '';
            rightSection.style.height = '';
            rightSection.style.zIndex = '';
            const content = leftSection.parentElement;
            if (content) content.style.justifyContent = 'flex-start';
        }

        this.isLyricsPanelOpen = false;
        this.isPlaylistPanelOpen = true;
        window.isPlaylistOpen = true;

        // 更新按钮状态
        if (lyricsBtn) lyricsBtn.classList.remove('active');
        if (playlistBtn) playlistBtn.classList.add('active');

        // 显示关闭按钮
        const closeBtn = document.getElementById('detail-panel-close');
        if (closeBtn) closeBtn.style.display = 'flex';

        this.renderPlaylist();

        // 滚动到当前歌单
        setTimeout(() => {
            const playlistContent = document.getElementById('playlist-content');
            if (playlistContent) {
                const currentItem = playlistContent.querySelector('.playlist-item.playing');
                if (currentItem) {
                    currentItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }, 100);

        // 更新播放器上的按钮状态
        if (typeof updatePlayerExtraButtons === 'function') {
            updatePlayerExtraButtons();
        }
    },

    /**
     * 渲染播放列表
     */
    renderPlaylist() {
        const playlistContent = document.getElementById('playlist-content');
        if (!playlistContent) return;

        const playlist = window.currentPlaylist || [];

        // 更新顶部“播放列表 (N)”数量
        const countEl = document.getElementById('detail-playlist-count');
        if (countEl) countEl.textContent = `(${playlist.length})`;

        if (playlist.length === 0) {
            playlistContent.innerHTML = '<div class="playlist-empty">播放列表为空</div>';
            this._playlistRenderSig = '';
            return;
        }

        // 队列未变时只更新高亮行（切歌/开面板是高频路径，避免每次整段 innerHTML 重建上千行）。
        // 指纹覆盖 id/音源脚本/插件来源/标题/封面直链——换源、music-info 补全等元数据变化都会触发全量重渲染。
        const sig = playlist.map((s) => {
            if (!s) return '';
            const coverId = s.coverArt || s.virtualId || (typeof s.id === 'string' ? s.id : null);
            const coverUrl = s.artwork || s.cover || s.coverImg || s.pic
                || (coverId ? `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(coverId)}` : '');
            return `${s.id}|${s.lxSourceFile || s.lxResolvedFile || ''}|${s.sourcePlugin || s.plugin || s.platform || ''}|${s.title || ''}|${coverUrl}`;
        }).join('\u0001');
        if (this._playlistRenderSig === sig && playlistContent.childElementCount === playlist.length) {
            this.updatePlaylistHighlight();
            return;
        }
        this._playlistRenderSig = sig;

        playlistContent.innerHTML = playlist.map((song, index) => {
            const isPlaying = index === window.currentIndex;
            const coverId = song.coverArt || song.virtualId || (typeof song.id === 'string' ? song.id : null);
            const coverUrl = song.artwork || song.cover || song.coverImg || song.pic
                || (coverId ? `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(coverId)}` : null);
            const durationValue = song.duration || song.dt || song.time;
            const duration = durationValue ? formatDuration(durationValue) : '--:--';

            // 来源名统一走取名逻辑（落雪 lx:xx 也能正确显示，不再借 MF 插件名）；
            // 标签位置窄，用短名，完整名放 title
            const source = (typeof getDisplaySource === 'function')
                ? getDisplaySource(song, { short: true })
                : (song.sourcePlugin || song.plugin || song.platform || '-');
            const sourceFull = (typeof getDisplaySource === 'function') ? getDisplaySource(song) : source;

            const indexDisplay = isPlaying ? '▶' : (index + 1);

            return `
                <div class="playlist-item ${isPlaying ? 'playing' : ''}" data-index="${index}">
                    <div class="playlist-item-index">${indexDisplay}</div>
                    <div class="playlist-item-cover">
                        ${coverUrl
                            ? `<img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(song.title)}" loading="lazy" decoding="async" data-raw="${escapeHtml(coverUrl)}" onerror="window.__coverImgOnError(this)">`
                            : ''
                        }
                        <div class="default-cover" style="${coverUrl ? 'display: none;' : 'display: flex;'}">🎵</div>
                    </div>
                    <div class="playlist-item-info">
                        <div class="playlist-item-row1">
                            <span class="playlist-item-title">${escapeHtml(song.title)}</span>
                            <div class="playlist-item-row1-right">
                                <span class="playlist-item-duration">${duration}</span>
                                ${source ? `<span class="playlist-item-source" title="${escapeHtml(sourceFull)}">${escapeHtml(source)}</span>` : ''}
                            </div>
                        </div>
                        <div class="playlist-item-row2">
                            <div class="playlist-item-row2-left">
                                <span class="playlist-item-artist">${escapeHtml(song.artist || '未知歌手')}</span>
                                ${song.album ? `<span class="playlist-item-separator">·</span><span class="playlist-item-album">${escapeHtml(song.album)}</span>` : ''}
                            </div>
                            <button class="playlist-item-remove" onclick="PlayerDetail.removeFromPlaylist(${index}); event.stopPropagation();" title="移除">×</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        // 添加点击事件
        playlistContent.querySelectorAll('.playlist-item').forEach((item) => {
            item.addEventListener('click', async () => {
                const index = parseInt(item.dataset.index);
                if (typeof playMusic === 'function') {
                    await playMusic(index);
                }
                this.updatePlaylistHighlight();
                await this.updateInfo();
            });
        });

        // 滚动到当前歌曲
        this.scrollToCurrentInPlaylist();
    },

    /**
     * 滚动播放列表到正在播放的歌曲
     */
    scrollToCurrentInPlaylist() {
        const playlistContent = document.getElementById('playlist-content');
        if (!playlistContent) return;

        const currentItem = playlistContent.querySelector('.playlist-item.playing');
        if (currentItem) {
            currentItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    },

    /**
     * 更新播放列表高亮
     */
    updatePlaylistHighlight() {
        const playlistContent = document.getElementById('playlist-content');
        if (!playlistContent) return;

        const items = playlistContent.querySelectorAll('.playlist-item');
        items.forEach((item, index) => {
            const isPlaying = index === window.currentIndex;
            item.classList.toggle('playing', isPlaying);

            const indexEl = item.querySelector('.playlist-item-index');
            if (indexEl) {
                indexEl.textContent = isPlaying ? '▶' : (index + 1);
            }
        });
    },

    /**
     * 从播放列表移除歌单
     */
    async removeFromPlaylist(index) {
        if (!window.currentPlaylist || index < 0 || index >= window.currentPlaylist.length) return;

        // 获取要删除的歌曲信息（用于后端同步）
        const removedSong = window.currentPlaylist[index];

        window.currentPlaylist.splice(index, 1);

        // 如果删除的是当前播放的歌曲或之前的歌曲，调整索引
        if (index < window.currentIndex) {
            window.currentIndex--;
        } else if (index === window.currentIndex) {
            // 删除的是当前播放的歌曲，停止播放
            const player = document.getElementById('audio-player');
            if (player) {
                player.pause();
            }
            window.isPlaying = false;

            if (typeof PlayerModule !== 'undefined') {
                PlayerModule.updateExternalPlayButton(false);
            }

            // 播放下一首（如果还有）
            if (window.currentPlaylist.length > 0) {
                if (window.currentIndex >= window.currentPlaylist.length) {
                    window.currentIndex = 0;
                }
                if (typeof playMusic === 'function') {
                    playMusic(window.currentIndex);
                }
            } else {
                window.currentMusic = null;
                await this.updateInfo();
            }
        }

        this.renderPlaylist();

        // 同步到后端（异步，不阻塞UI）
        if (typeof PlayQueueAPI !== 'undefined' && removedSong) {
            PlayQueueAPI.remove(removedSong.id, removedSong.plugin || removedSong.platform).catch(err => {
                console.error('[removeFromPlaylist] 同步到后端失败:', err);
            });
        }

        Notification.toast('已从播放列表移除', 'info');
    },

    /**
     * 清空播放列表
     */
    async clearPlaylist() {
        const confirmed = await Notification.confirm('确定要清空播放列表吗？');
        if (!confirmed) return;

        window.currentPlaylist = [];
        window.currentIndex = 0;
        window.currentMusic = null;

        // 重置播放模式为关闭
        window.playMode = 'off';
        window.repeatMode = 'off';

        // 更新循环按钮图标
        if (typeof updateRepeatButtonIcon === 'function') {
            updateRepeatButtonIcon();
        }

        const player = document.getElementById('audio-player');
        if (player) {
            player.pause();
            player.src = '';
        }
        window.isPlaying = false;

        if (typeof PlayerModule !== 'undefined') {
            PlayerModule.updateExternalPlayButton(false);
            PlayerModule.updateExternalPlayerInfo();
            // 刷新内容区播放列表面板
            PlayerModule.renderContentPlaylist();
        }

        this.renderPlaylist();
        await this.updateInfo();

        // 同步到后端（异步，不阻塞UI）
        if (typeof PlayQueueAPI !== 'undefined') {
            PlayQueueAPI.clear().catch(err => {
                console.error('[clearPlaylist] 同步到后端失败:', err);
            });
        }

        Notification.toast('播放列表已清空', 'info');
    },

    /**
     * 更新时间显示
     */
    updateTime(currentTime, duration) {
        // 更新进度条
        const progressFill = document.getElementById('detail-progress-fill');
        if (progressFill && duration) {
            const percent = (currentTime / duration) * 100;
            progressFill.style.width = percent + '%';
        }

        // 更新当前时间和总时长显示
        const currentTimeEl = document.getElementById('detail-current-time');
        const durationEl = document.getElementById('detail-duration');
        if (currentTimeEl) currentTimeEl.textContent = formatDuration(currentTime);
        if (durationEl && duration) durationEl.textContent = formatDuration(duration);

        // 更新歌词高亮
        this.updateLyricHighlight(currentTime);

        // 更新播放列表高亮
        this.updatePlaylistHighlight();
    }
};

// 导出到全局
window.PlayerDetail = PlayerDetail;
window.openPlayerDetail = (e) => {
    if (e) e.stopPropagation();
    PlayerDetail.open();
};
window.closePlayerDetail = () => PlayerDetail.close();
window.updatePlayerDetailInfo = () => PlayerDetail.updateInfo();
window.stopAndCloseDetail = () => PlayerDetail.stopAndClose();

// 初始化 PlayerDetail.init();
