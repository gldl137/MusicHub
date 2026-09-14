/**
 * 按钮操作模块 (ButtonActions)
 * 统一封装播放、添加、下载、清空、订阅按钮的样式和功能
 * 便于在各页面直接调用
 */

const ButtonActions = {
    // ==================== 图标配置 ====================
    icons: {
        play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
        add: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
        download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
        clear: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
        subscribe: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
        unsubscribe: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z"/></svg>'
    },

    // ==================== 按钮样式配置 ====================
    styles: {
        primary: {
            background: 'var(--primary-color)',
            color: 'white',
            border: 'none'
        },
        secondary: {
            background: 'var(--surface-color)',
            color: 'var(--text-color)',
            border: '1px solid var(--border-color)'
        }
    },

    // ==================== 按钮配置生成器 ====================

    /**
     * 创建播放按钮配置
     * @param {Object} options - 配置选项
     * @param {Function} options.onClick - 点击回调
     * @param {boolean} options.disabled - 是否禁用
     * @param {string} options.text - 按钮文字，默认'播放'
     * @param {boolean} options.primary - 是否主按钮样式，默认false
     * @returns {Object} 按钮配置对象
     */
    createPlayButton(options = {}) {
        const { onClick, disabled = false, text = '播放', primary = false } = options;
        return {
            id: 'play',
            icon: this.icons.play,
            text,
            primary,
            disabled,
            onClick: onClick || (() => console.warn('播放按钮未设置点击事件'))
        };
    },

    /**
     * 创建添加按钮配置
     * @param {Object} options - 配置选项
     * @param {Function} options.onClick - 点击回调
     * @param {boolean} options.disabled - 是否禁用
     * @param {string} options.text - 按钮文字，默认'添加'
     * @param {boolean} options.primary - 是否主按钮样式，默认false
     * @returns {Object} 按钮配置对象
     */
    createAddButton(options = {}) {
        const { onClick, disabled = false, text = '添加', primary = false } = options;
        return {
            id: 'add',
            icon: this.icons.add,
            text,
            primary,
            disabled,
            onClick: onClick || (() => console.warn('添加按钮未设置点击事件'))
        };
    },

    /**
     * 创建下载按钮配置
     * @param {Object} options - 配置选项
     * @param {Function} options.onClick - 点击回调
     * @param {boolean} options.disabled - 是否禁用
     * @param {string} options.text - 按钮文字，默认'下载'
     * @param {boolean} options.primary - 是否主按钮样式，默认false
     * @returns {Object} 按钮配置对象
     */
    createDownloadButton(options = {}) {
        const { onClick, disabled = false, text = '下载', primary = false } = options;
        return {
            id: 'download',
            icon: this.icons.download,
            text,
            primary,
            disabled,
            onClick: onClick || (() => console.warn('下载按钮未设置点击事件'))
        };
    },

    /**
     * 创建清空按钮配置
     * @param {Object} options - 配置选项
     * @param {Function} options.onClick - 点击回调
     * @param {boolean} options.disabled - 是否禁用
     * @param {string} options.text - 按钮文字，默认'清空'
     * @param {boolean} options.danger - 是否危险按钮样式，默认false
     * @returns {Object} 按钮配置对象
     */
    createClearButton(options = {}) {
        const { onClick, disabled = false, text = '清空', danger = false } = options;
        return {
            id: 'clear',
            icon: this.icons.clear,
            text,
            primary: danger,
            disabled,
            onClick: onClick || (() => console.warn('清空按钮未设置点击事件'))
        };
    },

    /**
     * 创建订阅按钮配置
     * @param {Object} options - 配置选项
     * @param {Function} options.onClick - 点击回调
     * @param {boolean} options.disabled - 是否禁用
     * @param {string} options.text - 按钮文字，默认'订阅'
     * @param {boolean} options.isSubscribed - 是否已订阅，影响图标和文字
     * @param {boolean} options.primary - 是否主按钮样式，默认true
     * @returns {Object} 按钮配置对象
     */
    createSubscribeButton(options = {}) {
        const { onClick, disabled = false, text = '订阅', isSubscribed = false, primary = true } = options;
        return {
            id: isSubscribed ? 'unsubscribe' : 'subscribe',
            icon: isSubscribed ? this.icons.unsubscribe : this.icons.subscribe,
            text: isSubscribed ? '取消订阅' : text,
            primary,
            disabled,
            onClick: onClick || (() => console.warn('订阅按钮未设置点击事件'))
        };
    },

    // ==================== 统一播放控制（写死，不可修改） ====================

    /**
     * 统一的播放逻辑：选中播放选中，没选播放全部
     * 此函数写死在 ButtonActions 中，各页面只能调用，不能修改逻辑
     * @param {string} pageId - 页面ID，用于获取选中的歌曲
     * @param {Array} allSongs - 当前页面的全部歌曲列表
     */
    handlePlay(pageId, allSongs) {
        // 1. 尝试获取选中的歌曲
        let songsToPlay = [];
        if (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs) {
            const selectedSongs = SongTable.getSelectedSongs(pageId);
            songsToPlay = selectedSongs.length > 0 ? selectedSongs : (allSongs || []);
        } else {
            songsToPlay = allSongs || [];
        }

        if (!songsToPlay || songsToPlay.length === 0) {
            console.warn('[ButtonActions] 没有可播放的歌曲');
            return;
        }

        // 2. 设置当前页面歌曲列表
        window.currentPageMusicList = songsToPlay;

        // 3. 播放第一首
        if (typeof playMusic === 'function') {
            playMusic(0);
        } else {
            console.error('[ButtonActions] playMusic 函数不可用');
        }
    },

    /**
     * 创建播放按钮配置（使用统一播放逻辑）
     * @param {Object} options - 配置选项
     * @param {string} options.pageId - 页面ID，用于获取选中歌曲
     * @param {Array} options.songs - 当前页面的全部歌曲列表
     * @param {boolean} options.disabled - 是否禁用
     * @param {string} options.text - 按钮文字，默认'播放'
     * @param {boolean} options.primary - 是否主按钮样式，默认false
     * @returns {Object} 按钮配置对象
     */
    createPlayButtonWithUnifiedLogic(options = {}) {
        const { pageId, songs, disabled = false, text = '播放', primary = false } = options;
        return {
            id: 'play',
            icon: this.icons.play,
            text,
            primary,
            disabled,
            onClick: () => this.handlePlay(pageId, songs)
        };
    },

    // ==================== 统一添加控制（写死，不可修改） ====================

    /**
     * 统一的添加逻辑：选中添加选中，没选添加全部
     * 此函数写死在 ButtonActions 中，各页面只能调用，不能修改逻辑
     * @param {string} pageId - 页面ID，用于获取选中的歌曲
     * @param {Array} allSongs - 当前页面的全部歌曲列表
     * @param {string} sourceName - 来源名称，用于弹窗显示
     */
    handleAdd(pageId, allSongs, sourceName, cover) {
        // 1. 尝试获取选中的歌曲
        let songsToAdd = [];
        if (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs) {
            const selectedSongs = SongTable.getSelectedSongs(pageId);
            songsToAdd = selectedSongs.length > 0 ? selectedSongs : (allSongs || []);
        } else {
            songsToAdd = allSongs || [];
        }

        if (!songsToAdd || songsToAdd.length === 0) {
            console.warn('[ButtonActions] 没有可添加的歌曲');
            return;
        }

        // 2. 显示添加到歌单弹窗
        if (typeof showAddToPlaylistModal === 'function') {
            showAddToPlaylistModal(songsToAdd, sourceName || pageId, cover);
        } else {
            console.error('[ButtonActions] showAddToPlaylistModal 函数不可用');
        }
    },

    /**
     * 创建添加按钮配置（使用统一添加逻辑）
     * @param {Object} options - 配置选项
     * @param {string} options.pageId - 页面ID，用于获取选中歌曲
     * @param {Array} options.songs - 当前页面的全部歌曲列表
     * @param {string} options.sourceName - 来源名称，用于弹窗显示
     * @param {boolean} options.disabled - 是否禁用
     * @param {string} options.text - 按钮文字，默认'添加'
     * @param {boolean} options.primary - 是否主按钮样式，默认false
     * @returns {Object} 按钮配置对象
     */
    createAddButtonWithUnifiedLogic(options = {}) {
        const { pageId, songs, sourceName, cover, disabled = false, text = '添加', primary = false } = options;
        return {
            id: 'add',
            icon: this.icons.add,
            text,
            primary,
            disabled,
            onClick: () => this.handleAdd(pageId, songs, sourceName, cover)
        };
    },

    /**
     * 动态歌单保存弹窗（排行榜/热门歌单详情页「添加」按钮专用）：
     * 与「订阅」同款语义——只保存来源地址（插件 + 榜单/歌单ID），可重命名，
     * 不保存任何歌曲；进入歌单时实时向插件拉取最新内容（排名/封面与来源页面一致）。
     * @param {string} defaultName - 歌单默认名称（可修改）
     * @param {Object} source - 来源 { type:'toplist'|'playlist', platform, toplistId }
     * @param {string} cover - 封面地址
     */
    showLivePlaylistSaveModal(defaultName, source, cover) {
        const esc = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const safeName = esc(defaultName || '实时歌单');
        const coverHtml = cover ? `<img src="${esc(cover)}" style="width:120px;height:120px;object-fit:cover;border-radius:10px;" onerror="this.style.display='none'">` : '';
        const modal = document.createElement('div');
        modal.id = 'live-playlist-save-modal';
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = `
            <div style="background:var(--surface-color);border-radius:12px;width:360px;max-width:90%;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3);">
                <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--divider-color);">
                    <span style="font-size:16px;font-weight:600;color:var(--text-color);">保存为实时歌单</span>
                    <span id="live-pl-close" style="cursor:pointer;font-size:18px;color:var(--text-secondary);">×</span>
                </div>
                <div style="padding:20px;display:flex;flex-direction:column;gap:14px;align-items:center;">
                    ${coverHtml}
                    <div style="width:100%;">
                        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:6px;">歌单名称（可修改）</div>
                        <input id="live-pl-name" value="${safeName}" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--divider-color);border-radius:8px;background:var(--bg-secondary);color:var(--text-color);font-size:14px;outline:none;">
                    </div>
                    <div style="width:100%;font-size:12px;color:var(--text-tertiary);line-height:1.6;">
                        歌单只记住「用哪个插件 + 哪个榜单」，不保存任何歌曲；每次打开都会向插件重新获取，排名和封面永远与排行榜保持一致。
                    </div>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid var(--divider-color);">
                    <button id="live-pl-cancel" style="padding:8px 18px;border-radius:8px;border:1px solid var(--divider-color);background:transparent;color:var(--text-color);cursor:pointer;">取消</button>
                    <button id="live-pl-save" style="padding:8px 18px;border-radius:8px;border:none;background:var(--primary-color);color:#fff;cursor:pointer;">保存</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        const close = () => modal.remove();
        modal.querySelector('#live-pl-close').onclick = close;
        modal.querySelector('#live-pl-cancel').onclick = close;
        const nameInput = modal.querySelector('#live-pl-name');
        nameInput.focus();
        nameInput.select();
        const save = async () => {
            const name = (nameInput.value || '').trim();
            if (!name) {
                if (typeof showToast === 'function') showToast('请输入歌单名称', 'warning');
                return;
            }
            close();
            try {
                const resp = await fetch(`${(window.API_BASE) || ''}/api/my/playlists`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, description: '', cover: cover || '', source })
                });
                const r = await resp.json();
                if (r.success) {
                    if (typeof showToast === 'function') showToast('已保存为实时歌单，进入时自动获取最新内容', 'success');
                    if (typeof window.loadSidebarPlaylists === 'function') window.loadSidebarPlaylists();
                } else {
                    if (typeof showToast === 'function') showToast('保存失败: ' + (r.error || '未知错误'), 'error');
                }
            } catch (e) {
                if (typeof showToast === 'function') showToast('保存失败: ' + e.message, 'error');
            }
        };
        modal.querySelector('#live-pl-save').onclick = save;
        nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    },

    // ==================== 统一下载控制（写死，不可修改） ====================

    /**
     * 统一的下载逻辑：选中下载选中，没选下载全部
     * 此函数写死在 ButtonActions 中，各页面只能调用，不能修改逻辑
     * @param {string} pageId - 页面ID，用于获取选中的歌曲
     * @param {Array} allSongs - 当前页面的全部歌曲列表
     * @param {string} source - 下载来源标识，用于日志区分
     */
    handleDownload(pageId, allSongs, source = 'download-btn') {
        // 1. 尝试获取选中的歌曲
        let songsToDownload = [];
        if (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs) {
            const selectedSongs = SongTable.getSelectedSongs(pageId);
            songsToDownload = selectedSongs.length > 0 ? selectedSongs : (allSongs || []);
        } else {
            songsToDownload = allSongs || [];
        }

        if (!songsToDownload || songsToDownload.length === 0) {
            console.warn('[ButtonActions] 没有可下载的歌曲');
            return;
        }

        // 2. 显示下载确认弹窗
        const modalHtml = `
            <div class="modal-overlay" id="download-confirm-modal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 1000; display: flex; align-items: center; justify-content: center;">
                <div class="modal-content" style="background: var(--surface-color); border-radius: 12px; width: 400px; max-width: 90%; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
                    <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--divider-color);">
                        <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--text-color);">确认下载</h3>
                    </div>
                    <div class="modal-body" style="padding: 20px;">
                        <p style="margin: 0; color: var(--text-secondary); font-size: 15px;">确定要下载 <strong style="color: var(--text-color);">${songsToDownload.length}</strong> 首歌曲吗？</p>
                    </div>
                    <div class="modal-footer" style="display: flex; gap: 12px; justify-content: flex-end; padding: 16px 20px; border-top: 1px solid var(--divider-color);">
                        <button id="download-cancel-btn" style="padding: 10px 20px; border: none; background: transparent; color: var(--text-secondary); border-radius: 6px; cursor: pointer; font-size: 14px;">取消</button>
                        <button id="download-confirm-btn" style="padding: 10px 20px; border: none; background: var(--primary-color); color: #fff; border-radius: 6px; cursor: pointer; font-size: 14px;">确定</button>
                    </div>
                </div>
            </div>
        `;

        // 插入弹窗
        document.body.insertAdjacentHTML('beforeend', modalHtml);

        // 绑定按钮事件
        document.getElementById('download-cancel-btn').onclick = () => {
            document.getElementById('download-confirm-modal').remove();
        };

        document.getElementById('download-confirm-btn').onclick = () => {
            document.getElementById('download-confirm-modal').remove();
            
            // 开始批量下载 - 使用 DownloadCore.downloadBatch
            if (window.DownloadCore && typeof window.DownloadCore.downloadBatch === 'function') {
                const downloadParams = songsToDownload.map(song => ({
                    id: song.id,
                    title: song.title,
                    artist: song.artist,
                    plugin: song.plugin,
                    quality: song.quality || 'standard',
                    ...song
                }));
                
                window.DownloadCore.downloadBatch(downloadParams, { delay: 500 }, source);
            } else {
                // 降级方案：逐个调用 startBackendDownload
                songsToDownload.forEach((song, index) => {
                    setTimeout(() => {
                        if (window.DownloadCore && typeof window.DownloadCore.startBackendDownload === 'function') {
                            window.DownloadCore.startBackendDownload(song, source);
                        } else {
                            console.error('[ButtonActions] DownloadCore 不可用');
                        }
                    }, index * 500);
                });
            }

            showToast(`已添加 ${songsToDownload.length} 首歌曲到下载队列`, 'success');
        };
    },

    /**
     * 创建下载按钮配置（使用统一下载逻辑）
     * @param {Object} options - 配置选项
     * @param {string} options.pageId - 页面ID，用于获取选中歌曲
     * @param {Array} options.songs - 当前页面的全部歌曲列表
     * @param {boolean} options.disabled - 是否禁用
     * @param {string} options.text - 按钮文字，默认'下载'
     * @param {boolean} options.primary - 是否主按钮样式，默认false
     * @param {string} options.source - 下载来源标识，用于日志区分
     * @returns {Object} 按钮配置对象
     */
    createDownloadButtonWithUnifiedLogic(options = {}) {
        const { pageId, songs, disabled = false, text = '下载', primary = false, source = 'download-btn' } = options;
        return {
            id: 'download',
            icon: this.icons.download,
            text,
            primary,
            disabled,
            onClick: () => this.handleDownload(pageId, songs, source)
        };
    },

    // ==================== 统一清空控制（写死，不可修改） ====================

    /**
     * 统一的清空逻辑：弹出确认框后清空
     * 此函数写死在 ButtonActions 中，各页面只能调用，不能修改逻辑
     * @param {string} pageId - 页面ID
     * @param {string} listName - 列表名称，用于确认框提示
     * @param {Function} clearCallback - 清空执行后的回调函数
     */
    handleClear(pageId, listName, clearCallback) {
        // 必须先勾选至少一项才能清空：未选择时直接拦截，避免误清空整列。
        // 语义统一（与 recent 页一致）：勾选了什么就只清空什么——选中歌曲传给回调，
        // 回调内部只处理这批歌曲，绝不再扩大为「清空全部」。
        let selectedSongs = [];
        let canCheck = false;
        if (typeof SongTable !== 'undefined' && typeof SongTable.getSelectedSongs === 'function') {
            try { selectedSongs = SongTable.getSelectedSongs(pageId) || []; canCheck = true; } catch (e) { canCheck = true; selectedSongs = []; }
        }
        if (canCheck && selectedSongs.length === 0) {
            showToast('请先选择要清空的歌曲', 'warning');
            return;
        }

        // 1. 弹出确认框
        if (typeof showConfirmModal === 'function') {
            showConfirmModal({
                title: `清空${listName || '列表'}`,
                message: selectedSongs.length
                    ? `确定要清空选中的 ${selectedSongs.length} 首歌曲吗？此操作不可恢复。`
                    : `确定要清空${listName || '列表'}吗？此操作不可恢复。`,
                confirmText: '清空',
                cancelText: '取消',
                onConfirm: () => {
                    // 2. 执行清空回调（传入选中歌曲，回调只删这批）
                    if (typeof clearCallback === 'function') {
                        clearCallback(selectedSongs);
                    }
                    showToast(`已清空 ${selectedSongs.length} 首歌曲`, 'success');
                }
            });
        } else {
            // 降级方案：使用原生 confirm
            const confirmed = confirm(selectedSongs.length
                ? `确定要清空选中的 ${selectedSongs.length} 首歌曲吗？此操作不可恢复。`
                : `确定要清空${listName || '列表'}吗？此操作不可恢复。`);
            if (confirmed) {
                if (typeof clearCallback === 'function') {
                    clearCallback(selectedSongs);
                }
                showToast(`已清空 ${selectedSongs.length} 首歌曲`, 'success');
            }
        }
    },

    /**
     * 创建清空按钮配置（使用统一清空逻辑）
     * @param {Object} options - 配置选项
     * @param {string} options.pageId - 页面ID
     * @param {string} options.listName - 列表名称，用于确认框提示
     * @param {Function} options.onClear - 清空执行回调
     * @param {boolean} options.disabled - 是否禁用
     * @param {string} options.text - 按钮文字，默认'清空'
     * @param {boolean} options.primary - 是否主按钮样式，默认false
     * @returns {Object} 按钮配置对象
     */
    createClearButtonWithUnifiedLogic(options = {}) {
        const { pageId, listName, onClear, disabled = false, text = '清空', primary = false } = options;
        return {
            id: 'clear',
            icon: this.icons.clear,
            text,
            primary,
            disabled,
            onClick: () => this.handleClear(pageId, listName, onClear)
        };
    },

    // ==================== 统一订阅控制（写死，不可修改） ====================

    /**
     * 统一的订阅逻辑：切换订阅状态
     * 此函数写死在 ButtonActions 中，各页面只能调用，不能修改逻辑
     * @param {Object} playlist - 歌单信息
     * @param {boolean} isSubscribed - 当前订阅状态
     * @param {Function} callback - 订阅状态变更后的回调
     */
    handleSubscribe(playlist, isSubscribed, callback) {
        if (!playlist || !playlist.id) {
            console.warn('[ButtonActions] 无效的歌单信息');
            return;
        }

        const actionText = isSubscribed ? '取消订阅' : '订阅';
        const confirmText = isSubscribed ? '取消' : '订阅';

        // 显示确认弹窗
        const modalHtml = `
            <div class="modal-overlay" id="subscribe-confirm-modal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 1000; display: flex; align-items: center; justify-content: center;">
                <div class="modal-content" style="background: var(--surface-color); border-radius: 12px; width: 400px; max-width: 90%; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
                    <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--divider-color);">
                        <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--text-color);">确认${actionText}</h3>
                    </div>
                    <div class="modal-body" style="padding: 20px;">
                        <p style="margin: 0; color: var(--text-secondary); font-size: 15px;">确定要${actionText}歌单「<strong style="color: var(--text-color);">${this._escapeHtml(playlist.title || '未命名歌单')}</strong>」吗？</p>
                    </div>
                    <div class="modal-footer" style="display: flex; gap: 12px; justify-content: flex-end; padding: 16px 20px; border-top: 1px solid var(--divider-color);">
                        <button id="subscribe-cancel-btn" style="padding: 10px 20px; border: none; background: transparent; color: var(--text-secondary); border-radius: 6px; cursor: pointer; font-size: 14px;">取消</button>
                        <button id="subscribe-confirm-btn" style="padding: 10px 20px; border: none; background: var(--primary-color); color: #fff; border-radius: 6px; cursor: pointer; font-size: 14px;">${confirmText}</button>
                    </div>
                </div>
            </div>
        `;

        // 插入弹窗
        document.body.insertAdjacentHTML('beforeend', modalHtml);

        // 绑定按钮事件
        document.getElementById('subscribe-cancel-btn').onclick = () => {
            document.getElementById('subscribe-confirm-modal').remove();
        };

        document.getElementById('subscribe-confirm-btn').onclick = () => {
            document.getElementById('subscribe-confirm-modal').remove();
            
            // 执行订阅/取消订阅操作
            if (isSubscribed) {
                // 取消订阅
                if (typeof unsubscribePlaylist === 'function') {
                    unsubscribePlaylist(playlist.id);
                    showToast('已取消订阅', 'success');
                    if (typeof callback === 'function') callback(false);
                } else {
                    console.error('[ButtonActions] unsubscribePlaylist 函数不可用');
                }
            } else {
                // 订阅 - 支持两种订阅方式：subscribeToplist（推荐页/排行榜）或 subscribePlaylist（普通歌单）
                if ((playlist.sourceType === 'playlist' || playlist.sourceType === 'toplist') && playlist.plugin && typeof subscribeToplist === 'function') {
                    // 使用 subscribeToplist（支持热门歌单和排行榜）
                    const totalSongs = playlist.totalSongs || 0;
                    subscribeToplist(
                        playlist.id,
                        playlist.plugin,
                        {
                            title: playlist.title || playlist.id,
                            cover: playlist.cover || '',
                            sourceType: playlist.sourceType,
                            isEnabled: 1
                        },
                        totalSongs
                    ).then(() => {
                        showToast('订阅成功', 'success');
                        if (typeof callback === 'function') callback(true);
                    }).catch(error => {
                        console.error('订阅失败:', error);
                        showToast('订阅失败', 'error');
                    });
                } else if (typeof subscribePlaylist === 'function') {
                    // 使用普通歌单订阅
                    subscribePlaylist(playlist.id).then(() => {
                        showToast('订阅成功', 'success');
                        if (typeof callback === 'function') callback(true);
                    }).catch(error => {
                        console.error('订阅失败:', error);
                        showToast('订阅失败', 'error');
                    });
                } else {
                    console.error('[ButtonActions] 订阅函数不可用');
                }
            }
        };
    },

    /**
     * 创建订阅按钮配置（使用统一订阅逻辑）
     * @param {Object} options - 配置选项
     * @param {Object} options.playlist - 歌单信息对象
     * @param {boolean} options.isSubscribed - 当前是否已订阅
     * @param {Function} options.onSubscribeChange - 订阅状态变更回调
     * @param {boolean} options.disabled - 是否禁用
     * @param {string} options.text - 按钮文字，默认根据状态显示'订阅'或'已订阅'
     * @param {boolean} options.primary - 是否主按钮样式，默认false
     * @returns {Object} 按钮配置对象
     */
    createSubscribeButtonWithUnifiedLogic(options = {}) {
        const { playlist, isSubscribed, onSubscribeChange, disabled = false, primary = false } = options;
        const text = isSubscribed ? '已订阅' : '订阅';
        return {
            id: 'subscribe',
            icon: this.icons.subscribe,
            text,
            primary,
            disabled,
            onClick: () => this.handleSubscribe(playlist, isSubscribed, onSubscribeChange)
        };
    },

    // ==================== 按钮组生成器 ====================

    /**
     * 创建标准歌曲列表按钮组（播放、添加、下载、清空）
     * @param {Object} options - 配置选项
     * @param {Function} options.onPlay - 播放回调
     * @param {Function} options.onAdd - 添加回调
     * @param {Function} options.onDownload - 下载回调
     * @param {Function} options.onClear - 清空回调
     * @param {boolean} options.hasSongs - 是否有歌曲（控制禁用状态）
     * @param {boolean} options.showClear - 是否显示清空按钮，默认true
     * @returns {Array} 按钮配置数组
     */
    createStandardButtons(options = {}) {
        const { onPlay, onAdd, onDownload, onClear, hasSongs = false, showClear = true } = options;
        
        const buttons = [
            this.createPlayButton({ onClick: onPlay, disabled: !hasSongs }),
            this.createAddButton({ onClick: onAdd, disabled: !hasSongs }),
            this.createDownloadButton({ onClick: onDownload, disabled: !hasSongs })
        ];

        if (showClear) {
            buttons.push(this.createClearButton({ onClick: onClear, disabled: !hasSongs }));
        }

        return buttons;
    },

    /**
     * 创建收藏页面按钮组（播放、添加、下载、清空）- 全部使用统一逻辑
     * @param {Object} options - 配置选项
     * @param {string} options.pageId - 页面ID，默认'favorites'
     * @param {Array} options.songs - 全部歌曲列表
     * @param {Function} options.onClear - 清空执行回调（实际清空的逻辑）
     * @param {boolean} options.hasSongs - 是否有歌曲
     * @returns {Array} 按钮配置数组
     */
    createFavoritesButtons(options = {}) {
        const { pageId = 'favorites', songs, onClear, hasSongs = false } = options;
        return [
            this.createPlayButtonWithUnifiedLogic({ pageId, songs, disabled: !hasSongs }),
            this.createAddButtonWithUnifiedLogic({ pageId, songs, sourceName: '我的收藏', disabled: !hasSongs }),
            this.createDownloadButtonWithUnifiedLogic({ pageId, songs, disabled: !hasSongs }),
            this.createClearButtonWithUnifiedLogic({ pageId, listName: '我的收藏', onClear, disabled: !hasSongs })
        ];
    },

    /**
     * 创建最近播放按钮组（播放、添加、下载、清空）- 全部使用统一逻辑
     * @param {Object} options - 配置选项
     * @param {string} options.pageId - 页面ID，默认'recent'
     * @param {Array} options.songs - 全部歌曲列表
     * @param {Function} options.onClear - 清空执行回调（实际清空的逻辑）
     * @param {boolean} options.hasSongs - 是否有歌曲
     * @returns {Array} 按钮配置数组
     */
    createRecentButtons(options = {}) {
        const { pageId = 'recent', songs, onClear, hasSongs = false } = options;
        return [
            this.createPlayButtonWithUnifiedLogic({ pageId, songs, disabled: !hasSongs }),
            this.createAddButtonWithUnifiedLogic({ pageId, songs, sourceName: '最近播放', disabled: !hasSongs }),
            this.createDownloadButtonWithUnifiedLogic({ pageId, songs, disabled: !hasSongs }),
            this.createClearButtonWithUnifiedLogic({ pageId, listName: '最近播放', onClear, disabled: !hasSongs })
        ];
    },

    /**
     * 创建歌单详情按钮组（播放、添加、下载）- 不含清空
     * @param {Object} options - 配置选项
     * @param {Function} options.onPlay - 播放回调
     * @param {Function} options.onAdd - 添加回调
     * @param {Function} options.onDownload - 下载回调
     * @param {boolean} options.hasSongs - 是否有歌曲
     * @returns {Array} 按钮配置数组
     */
    createPlaylistButtons(options = {}) {
        return this.createStandardButtons({ ...options, showClear: false });
    },

    /**
     * 创建榜单/歌单订阅按钮组（订阅、播放、下载）
     * @param {Object} options - 配置选项
     * @param {Function} options.onSubscribe - 订阅回调
     * @param {Function} options.onPlay - 播放回调
     * @param {Function} options.onDownload - 下载回调
     * @param {boolean} options.isSubscribed - 是否已订阅
     * @param {boolean} options.hasSongs - 是否有歌曲
     * @returns {Array} 按钮配置数组
     */
    createToplistButtons(options = {}) {
        const { onSubscribe, onPlay, onDownload, isSubscribed = false, hasSongs = false } = options;
        
        return [
            this.createSubscribeButton({ onClick: onSubscribe, isSubscribed, primary: true }),
            this.createPlayButton({ onClick: onPlay, disabled: !hasSongs, primary: false }),
            this.createDownloadButton({ onClick: onDownload, disabled: !hasSongs })
        ];
    },

    // ==================== 辅助方法 ====================

    /**
     * HTML 转义，防止 XSS 攻击
     * @param {string} text - 要转义的文本
     * @returns {string} 转义后的文本
     */
    _escapeHtml(text) {
        if (typeof text !== 'string') return text;
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};

// 导出到全局
window.ButtonActions = ButtonActions;
