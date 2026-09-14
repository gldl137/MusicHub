/**
 * 排行榜模块
 * 功能：加载榜单插件、显示所有插件榜单、查看榜单详情、搜索
 */

// 榜单更新时间缓存：插件本次未返回时间字段时，固定沿用最近一次成功返回的时间（不做默认推断）
const toplistUpdateCache = new Map();

const TopListModule = {
    storageKey: 'topListPluginOrder',
    currentPluginKey: 'currentTopListPlugin',
    // 存储每个插件的榜单数据
    pluginTopLists: {},
    // 返回回调函数（用于从订阅页面进入时）
    onBackCallback: null,

    /**
     * 加载支持榜单的插件列表
     * @param {boolean} autoLoadLists - 是否自动加载榜单列表（默认true）
     */
    async loadPlugins(autoLoadLists = true) {
        try {
            const result = await API.toplist.getPlugins();

            if (result.success) {
                topListPlugins = result.data || [];
                if (topListPlugins.length > 0) {
                    const savedPlugin = this.loadCurrentPlugin();
                    if (savedPlugin && topListPlugins.find(p => p.name === savedPlugin)) {
                        currentTopListPlugin = savedPlugin;
                    } else {
                        currentTopListPlugin = topListPlugins[0].name;
                        this.saveCurrentPlugin(currentTopListPlugin);
                    }
                    if (autoLoadLists) {
                        this.loadAllTopLists();
                    }
                }
                if (currentPage === 'toplist') {
                    this.renderTabs();
                }
            }
        } catch (error) {
            console.error('Failed to load top list plugins:', error);
        }
    },

    /**
     * 加载保存的当前选中插件
     */
    loadCurrentPlugin() {
        return localStorage.getItem(this.currentPluginKey);
    },

    /**
     * 保存当前选中插件
     */
    saveCurrentPlugin(pluginName) {
        localStorage.setItem(this.currentPluginKey, pluginName);
    },

    /**
     * 渲染榜单插件标签
     */
    renderTabs() {
        const headerLeft = document.getElementById('header-left');

        // 主菜单显示普通标题，详情页显示返回箭头+榜单名
        if (currentTopListTitle) {
            // 详情页：显示返回箭头+榜单名（标题居中，同我的歌单详情）
            // 如果有自定义返回回调则使用，否则使用默认的返回榜单列表
            const backCallback = this.onBackCallback || (() => this.backToTopList());
            PluginTabs.renderWithBack({
                title: currentTopListTitle,
                onBack: backCallback
            });
            // 标题文字居中：把返回按钮移出标题容器（返回按钮保持左侧，标题整体居中）
            const hl = document.getElementById('header-left');
            const titleEl = hl && hl.querySelector('.header-title');
            const backBtn = hl && hl.querySelector('#back-btn');
            if (hl && titleEl && backBtn) {
                hl.insertBefore(backBtn, titleEl);
                titleEl.classList.add('playlist-detail-title');
            }
        } else {
            // 主菜单：显示菜单按钮+"排行榜"标题+搜索框
            if (headerLeft) {
                headerLeft.innerHTML = `
                    <button class="mobile-menu-btn" onclick="toggleMobileSidebar()" aria-label="打开菜单">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="3" y1="12" x2="21" y2="12"></line>
                            <line x1="3" y1="6" x2="21" y2="6"></line>
                            <line x1="3" y1="18" x2="21" y2="18"></line>
                        </svg>
                    </button>
                    <div class="header-title" id="page-title">MF 排行榜</div>
                    <div class="toplist-header-search" style="display: flex; gap: 8px; align-items: center; margin-left: 16px; flex: 1; max-width: 500px;">
                        <div style="position: relative; flex: 1; min-width: 100px;">
                            <input type="text" id="toplist-search-input" class="search-input" placeholder="搜索歌曲..." value="${escapeHtml(currentSearchQuery)}" style="padding-left: 12px; width: 100%; height: 32px; border-radius: var(--radius-lg); border: 1px solid var(--border-color); background: var(--surface-color); color: var(--text-color); font-size: 12px; outline: none;" onkeypress="if(event.key==='Enter')TopListModule.search()">
                        </div>
                        <button class="header-icon-btn" onclick="handleHeaderSearchClick('toplist-search-input','toplist')" title="搜索">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                        </button>
                    </div>
                `;
            }

            // 在内容区域渲染插件标签
            PluginTabs.render({
                plugins: topListPlugins,
                currentPlugin: currentTopListPlugin,
                containerId: 'toplist-tabs-container',
                onSwitch: (pluginName) => this.switchPlugin(pluginName),
                storageKey: this.storageKey,
                page: 'toplist',
                contentContainerId: 'toplist-content'
            });
        }
    },

    /**
     * 切换榜单插件
     */
    switchPlugin(pluginName) {
        if (currentTopListPlugin === pluginName && !currentTopListTitle) {
            return;
        }
        currentTopListPlugin = pluginName;
        this.saveCurrentPlugin(pluginName);
        currentTopListTitle = null;
        if (currentPage === 'toplist') {
            this.renderTabs();
            this.renderAllTopLists();
        }
    },

    /**
     * 加载所有插件的榜单数据
     */
    async loadAllTopLists() {
        const container = document.getElementById('toplist-content');
        currentTopListTitle = null;

        // 检查容器是否存在（页面模板可能尚未加载）
        if (!container) {
            console.log('[INFO] [] Container not found, page template may not be loaded yet');
            return;
        }

        if (!topListPlugins || topListPlugins.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📋</div>
                    <div class="empty-text">没有支持榜单功能的插件</div>
                </div>
            `;
            return;
        }

        if (currentPage === 'toplist') {
            this.renderTabs();
        }

        // 检查是否有已加载的数据，避免不必要的闪烁
        const hasLoadedData = topListPlugins.some(plugin => 
            this.pluginTopLists[plugin.name]?.state === 'loaded'
        );

        // 初始化每个插件的榜单数据（只初始化未加载过的）
        // 优先用 localStorage 缓存做首屏预填充，避免每次进入都从头 loading（慢源会卡顿）
        topListPlugins.forEach(plugin => {
            if (!this.pluginTopLists[plugin.name]) {
                const cached = this._readTopListCache(plugin.name);
                if (cached && cached.data && cached.data.length) {
                    this.pluginTopLists[plugin.name] = {
                        state: 'loaded',
                        data: cached.data,
                        cached: true
                    };
                } else {
                    this.pluginTopLists[plugin.name] = {
                        state: 'loading',
                        data: []
                    };
                }
            }
        });

        // 如果有已加载的数据，先渲染已有数据，不显示 loading
        if (hasLoadedData) {
            this.renderAllTopLists();
        }

        // 并行加载所有插件的榜单（未加载的，或来自缓存预填充的，都需后台刷新）
        const pluginsToLoad = topListPlugins.filter(plugin => {
            const d = this.pluginTopLists[plugin.name];
            return !d || d.state !== 'loaded' || d.cached === true;
        });
        
        if (pluginsToLoad.length > 0) {
            // 如果没有已加载的数据，显示 loading
            if (!hasLoadedData) {
                this.renderAllTopLists();
            }
            
            await Promise.all(pluginsToLoad.map(plugin => this.loadPluginTopList(plugin.name)));
            this.renderAllTopLists();
        }
    },

    /**
     * 加载单个插件的榜单数据
     */
    async loadPluginTopList(pluginName) {
        const existing = this.pluginTopLists[pluginName];
        // 已有数据（来自缓存预填充）则保留并静默刷新，避免闪烁回 loading
        if (!existing || existing.state !== 'loaded') {
            this.pluginTopLists[pluginName] = {
                state: 'loading',
                data: []
            };
        }

        try {
            const result = await API.toplist.getList(pluginName);

            if (result.success && result.data) {
                this.pluginTopLists[pluginName] = {
                    state: 'loaded',
                    data: result.data,
                    cached: false
                };
                this._writeTopListCache(pluginName, result.data);
            } else if (!existing || existing.state !== 'loaded') {
                this.pluginTopLists[pluginName] = {
                    state: 'error',
                    data: [],
                    error: result.error || '加载失败'
                };
            }
        } catch (error) {
            console.error(`[ERROR] [ERROR] [TopListModule] Failed to load top list for ${pluginName}:`, error);
            if (!existing || existing.state !== 'loaded') {
                this.pluginTopLists[pluginName] = {
                    state: 'error',
                    data: [],
                    error: error.message
                };
            }
        }
    },

    /**
     * 读取榜单的 localStorage 缓存（10 分钟有效期）
     */
    _readTopListCache(pluginName) {
        try {
            const raw = localStorage.getItem('toplist_cache_' + pluginName);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (Date.now() - (obj.time || 0) > 10 * 60 * 1000) return null;
            return obj;
        } catch (e) {
            return null;
        }
    },

    /**
     * 写入榜单的 localStorage 缓存
     */
    _writeTopListCache(pluginName, data) {
        try {
            localStorage.setItem('toplist_cache_' + pluginName, JSON.stringify({ time: Date.now(), data }));
        } catch (e) {
            // 忽略 localStorage 配额/隐私模式错误
        }
    },

    /**
     * 渲染所有插件的榜单
     */
    renderAllTopLists() {
        const container = document.getElementById('toplist-content');
        if (!container) return;

        // 保存现有的插件标签
        const existingTabs = container.querySelector('.plugin-tabs-wrapper');
        // 标签栏的横向滚动位置：下方 innerHTML 重写会把标签栏一起销毁重建，
        // 必须先记住，稍后在 renderTabs 重建后恢复，否则滑动菜单会弹回最左
        const keepTabsScrollLeft = existingTabs ? existingTabs.scrollLeft : 0;

        // 插件标签会在 renderTabs 中插入到最前面
        let html = '';

        // 渲染每个插件的榜单
        topListPlugins.forEach(plugin => {
            const pluginData = this.pluginTopLists[plugin.name];
            if (!pluginData) return;

            html += `<div class="plugin-toplist-section" data-plugin="${plugin.name}" style="${plugin.name === currentTopListPlugin ? '' : 'display: none;'}">`;

            if (pluginData.state === 'loading') {
                html += '<div class="loading"><div class="spinner"></div></div>';
            } else if (pluginData.state === 'error') {
                html += `
                    <div class="empty-state">
                        <div class="empty-icon">❌</div>
                        <div class="empty-text">加载失败: ${escapeHtml(pluginData.error || '未知错误')}</div>
                    </div>
                `;
            } else if (pluginData.data.length === 0) {
                html += `
                    <div class="empty-state">
                        <div class="empty-icon">📋</div>
                        <div class="empty-text">暂无榜单数据</div>
                    </div>
                `;
            } else {
                html += this.renderTopListsForPlugin(pluginData.data);
            }

            html += '</div>';
        });

        container.innerHTML = html;

        // 如果有标签，重新渲染
        if (existingTabs && topListPlugins.length > 0 && !currentTopListTitle) {
            this.renderTabs();

            // 恢复标签栏横向滚动位置（上面的 innerHTML 已把带滚动位置的旧标签栏销毁，
            // renderTabs 重建的新标签栏滚动位置为 0，这里手动恢复）
            if (keepTabsScrollLeft > 0) {
                const tabsWrapper = container.querySelector('.plugin-tabs-wrapper');
                if (tabsWrapper) {
                    tabsWrapper.scrollLeft = keepTabsScrollLeft;
                    // iOS（-webkit-overflow-scrolling:touch）下布局稳定后可能被重置，下一帧再设一次兜底
                    requestAnimationFrame(() => { tabsWrapper.scrollLeft = keepTabsScrollLeft; });
                }
            }
        }

        // 绑定榜单点击事件
        container.querySelectorAll('.toplist-item').forEach(item => {
            item.addEventListener('click', () => {
                const id = item.dataset.toplistId;
                const title = item.dataset.toplistTitle;
                const cover = item.dataset.toplistCover || '';
                // 保存封面到全局变量，供订阅使用
                window.currentTopListCoverFromList = cover;
                this.loadDetail(id, title);
            });
        });
    },

    /**
     * 渲染单个插件的榜单列表
     */
    renderTopListsForPlugin(topLists) {
        let html = '';
        let hasData = false;

        topLists.forEach(group => {
            if (group && Array.isArray(group.data) && group.data.length > 0) {
                const validItems = group.data.filter(item => item && item.id != null);
                if (validItems.length > 0) {
                    hasData = true;
                    html += `<h3 style="margin: 20px 0 15px; color: var(--text-color); font-size: 16px; font-weight: 600;">${escapeHtml(group.title || '未分组')}</h3>`;
                    html += `<div class="toplist-grid">`;
                    validItems.forEach(item => {
                        const itemId = encodeURIComponent(item.id);
                        const itemTitle = escapeHtml(item.title || '未命名');
                        const rawCoverUrl = item.artwork || item.coverImg || item.cover || item.pic || '';
                        // 过滤无效封面（接口对无图条目常返回占位坏值，如 http://y.gtimg.cn/music/common，
                        // 直接请求会 404 并在控制台刷屏）；无效时显示占位音符，不发起请求。
                        let coverUrl = (typeof window.isPlausibleImageUrl === 'function' && !window.isPlausibleImageUrl(rawCoverUrl)) ? '' : rawCoverUrl;
                        // 网页抓取的封面多为缩略图（如网易云 ?param=40y40），放大模糊，统一提升到大尺寸
                        if (coverUrl && typeof window.upgradeCoverQuality === 'function') {
                            coverUrl = window.upgradeCoverQuality(coverUrl);
                        }
                        const pad2 = (n) => String(n).padStart(2, '0');
                        const toYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
                        // 更新时间：优先用插件返回的时间；插件未返回时固定沿用最近一次成功返回的时间；
                        // 从未有过则整行不渲染
                        const cacheKey = `${group.title || ''}|${item.id != null ? item.id : itemTitle}`;
                        let updateText = null;
                        const rawTime = item.updateTime ?? item.updateDate ?? item.updatedAt ?? item.time ?? item.date ?? item.pubDate;
                        if (rawTime != null && rawTime !== '') {
                            if (typeof rawTime === 'number') {
                                const d = new Date(rawTime > 1e12 ? rawTime : rawTime * 1000);
                                if (!isNaN(d.getTime())) updateText = toYmd(d);
                            } else {
                                const m = String(rawTime).trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
                                if (m) updateText = `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
                            }
                        }
                        if (updateText) {
                            toplistUpdateCache.set(cacheKey, updateText);
                        } else {
                            updateText = toplistUpdateCache.get(cacheKey) || null;
                        }
                        html += `
                            <div class="toplist-item" data-toplist-id="${itemId}" data-toplist-title="${itemTitle}" data-toplist-cover="${escapeHtml(coverUrl)}">
                                <div class="toplist-cover">
                                    ${coverUrl ? createImageWithFallback(coverUrl, 'cover', '') + "<div style='display:none'>🎵</div>" : '🎵'}
                                    <button class="media-card-play" title="播放榜单" onclick="event.stopPropagation(); TopListModule.playTopListDirect('${itemId}', '${itemTitle}')"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
                                </div>
                                <div class="toplist-name">${itemTitle}</div>
                                ${updateText ? `<div class="toplist-update">${updateText}</div>` : ''}
                                <div class="toplist-desc">${escapeHtml(item.description || '')}</div>
                            </div>
                        `;
                    });
                    html += `</div>`;
                }
            }
        });

        if (!hasData) {
            return `
                <div class="empty-state">
                    <div class="empty-icon">📋</div>
                    <div class="empty-text">该插件暂无有效榜单数据</div>
                </div>
            `;
        }

        return html;
    },



    /**
     * 直接播放榜单全部歌曲（卡片悬浮播放按钮）
     */
    async playTopListDirect(id, title) {
        const targetPlatform = currentTopListPlugin;
        if (!targetPlatform || !id) {
            showToast('无法获取插件信息', 'error');
            return;
        }
        try {
            showToast('加载榜单...');
            const result = await API.toplist.getDetail(id, targetPlatform);
            if (result.success && result.data?.musicList?.length) {
                const list = result.data.musicList.map(song => ({
                    ...song,
                    plugin: song.plugin || song.platform || targetPlatform
                }));
                window.currentPageMusicList = list;
                playMusic(0);
            } else {
                showToast('榜单暂无歌曲', 'warning');
            }
        } catch (e) {
            showToast('播放失败: ' + e.message, 'error');
        }
    },

    /**
     * 加载榜单详情
     * @param {string} id - 榜单ID
     * @param {string} title - 榜单标题
     * @param {string} platform - 平台名称（可选，用于从订阅页面查看）
     * @param {Function} onBack - 返回回调函数（可选）
     */
    async loadDetail(id, title, platform, onBack) {
        if (!id || id === 'undefined' || id === 'null') {
            showToast('榜单ID无效，无法加载详情', 'error');
            return;
        }

        if (typeof SongTable === 'undefined') {
            console.error('[ERROR] SongTable component not loaded');
            return;
        }

        // 保存返回回调函数
        this.onBackCallback = onBack;

        // 如果传入了 platform，则使用它，否则使用当前的 plugin
        const targetPlatform = platform || currentTopListPlugin;
        if (!targetPlatform) {
            showToast('无法获取插件信息', 'error');
            return;
        }

        showToast('加载榜单详情...');

        try {
            const result = await API.toplist.getDetail(id, targetPlatform);

            if (result.success && result.data?.musicList) {
                currentTopListTitle = title || result.data.title || '榜单详情';
                window.currentTopListDetailId = id; // 保存当前榜单ID
                // 优先使用详情中的封面，如果没有则使用列表中的封面
                let detailCover = result.data.cover || result.data.artwork || result.data.coverImg || result.data.pic || window.currentTopListCoverFromList || '';
                // 缩略图（如 ?param=40y40）放大模糊，统一提升到大尺寸
                if (detailCover && typeof window.upgradeCoverQuality === 'function') {
                    detailCover = window.upgradeCoverQuality(detailCover);
                }
                window.currentTopListCover = detailCover; // 保存封面
                // 清除临时变量
                window.currentTopListCoverFromList = null;
                // 设置当前 plugin 为传入的 platform，供后续操作使用
                currentTopListPlugin = targetPlatform;
                await switchPage('toplist', true);
                this.renderTabs(); // 渲染返回按钮
                setupTopListDetailMenu(); // 页头「⋯」管理菜单（同我的歌单详情页）

                const container = document.getElementById('toplist-content');
                if (!container) {
                    console.error('[ERROR] Container not found after switching page');
                    return;
                }

                // 为每首歌曲添加 plugin 字段
                const musicListWithPlugin = result.data.musicList.map(song => ({
                    ...song,
                    plugin: song.plugin || song.platform || targetPlatform
                }));

                // 保存到全局变量
                window.currentTopListMusicList = musicListWithPlugin;
                window.currentPageMusicList = musicListWithPlugin;

                // 检查是否已订阅
                let isSubscribed = false;
                try {
                    const token = Auth.getToken();
                    const subResponse = await fetch(`${API_BASE}/api/subscribed-toplists`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    const subResult = await subResponse.json();
                    if (subResult.success && subResult.data) {
                        isSubscribed = subResult.data.some(sub => 
                            sub.toplistId === id && sub.platform === targetPlatform
                        );
                    }
                } catch (e) {
                    console.warn('[TopList] 检查订阅状态失败:', e);
                }

                // 分页渲染：全量列表存模块态，翻页只重渲染表格不重新请求（进入新榜单重置到第 1 页）
                this._detailSongs = musicListWithPlugin;
                this._detailSubscribed = isSubscribed;
                this.detailPage = 1;
                this.renderDetailTable();

            } else {
                showToast('加载榜单详情失败: ' + (result.error || '无数据'), 'error');
            }
        } catch (error) {
            showToast('加载榜单详情失败: ' + error.message, 'error');
        }
    },

    /**
     * 渲染榜单详情歌曲表格（分页：默认 50/页可自定义，翻页只重渲染不重新请求）。
     * 全量列表存于 this._detailSongs；行点击回调 index = 页偏移 + 页内索引。
     * 按钮（播放/添加/下载）仍传全量列表：未勾选时操作全部歌曲。
     */
    renderDetailTable() {
        const container = document.getElementById('toplist-content');
        if (!container || !this._detailSongs) return;
        const allSongs = this._detailSongs;
        const isSubscribed = this._detailSubscribed || false;
        const hasSongs = allSongs.length > 0;
        // 管理模式：勾选列 + 批量下载（页头「⋯」→「管理」进入）
        const manage = toplistManageMode;
        if (container.classList) container.classList.toggle('playlist-detail-manage', manage);
        // 管理模式下已勾选数量（按钮文字实时显示）
        const selCount = (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs)
            ? (SongTable.getSelectedSongs('toplist') || []).length : 0;

        // 与「我的歌单」详情同款：Hero（随机/播放/管理）+ 单曲同款表格（封面两行/行尾⋯/无表头/无分页）
        const render = (slice) => {
        SongTable.render({
            container: container,
            pageId: 'toplist',
            title: '',
            showHeader: false,
            songs: slice,
            hero: {
                cover: window.currentTopListCover || '',
                title: currentTopListTitle || '榜单详情',
                meta: `${allSongs.length} 首歌曲`,
                onRandom: manage ? null : 'playTopListRandom()'
            },
            columns: manage
                ? ['checkbox', 'index', 'title', 'artist', 'album', 'duration', 'source', 'favorite', 'more']
                : ['index', 'title', 'artist', 'album', 'duration', 'source', 'favorite', 'more'],
            titleCover: (song) => {
                // 优先插件返回的封面直链；后端列表歌曲外链已剥离，需用虚拟封面 ID（coverArt）走 /api/cover 实时解析
                const coverId = song.coverArt || song.virtualId
                    || (typeof song.id === 'string' && song.id.startsWith('remote__') ? song.id : null);
                return song.artwork || song.cover || song.coverImg || song.pic || song.coverUrl || song.albumPic
                    || (coverId ? `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(coverId)}` : '');
            },
            // 收藏已移出行菜单：作为独立心形按钮显示在「⋯」前（favorite 列，点击走 events.onFavorite）
            rowMenu: [
                { label: '下载', onClick: (index) => TopListModule.downloadByIndex(index) }
            ],
            actions: manage ? [
                {
                    id: 'manage-download',
                    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
                    text: `下载${selCount ? ` (${selCount})` : ''}`,
                    primary: false,
                    disabled: !hasSongs,
                    onClick: downloadTopListSelected
                },
                { id: 'manage-done', icon: '', text: '完成', primary: true, onClick: () => toggleTopListManageMode() }
            ] : [
                {
                    id: 'play',
                    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
                    text: '播放',
                    primary: true,
                    disabled: !hasSongs,
                    onClick: () => TopListModule.playByIndex(0)
                },
                {
                    id: 'save-playlist',
                    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
                    text: '歌单',
                    primary: false,
                    disabled: !hasSongs,
                    onClick: () => TopListModule.saveTopListAsLivePlaylist()
                }
            ],
            events: {
                onPlay: (song, index) => TopListModule.playByIndex(index),
                onFavorite: (song, index) => TopListModule.toggleFavorite(index),
                onSelectChange: (selectedIndices) => {
                    const el = document.querySelector('[data-page-id="toplist"]');
                    if (el) {
                        el.querySelectorAll('tbody tr').forEach((row, idx) => {
                            row.classList.toggle('selected', selectedIndices.includes(idx));
                        });
                    }
                }
            }
        });
        };
        // 懒加载：只渲染当前可见歌曲，滚动到底追加下一批（index 仍为全列表索引，播放/收藏不受影响）
        SongListLazy.register('toplist', allSongs, container, render, { batch: 50, initial: 60 });
    },

    /** 保存榜单为实时歌单（只存榜单地址，可重命名，不保存歌曲快照） */
    async saveTopListAsLivePlaylist() {
        const allSongs = this._detailSongs || [];
        if (!allSongs.length) {
            showToast('榜单为空', 'warning');
            return;
        }
        // 默认名称带上音源（插件别名）前缀，如「QQ音乐-新歌榜」
        const defaultName = (typeof window.getEffectivePlaylistName === 'function')
            ? await window.getEffectivePlaylistName(currentTopListTitle || '排行榜', allSongs, currentTopListPlugin)
            : (currentTopListTitle || '排行榜');
        ButtonActions.showLivePlaylistSaveModal(defaultName, { type: 'toplist', platform: currentTopListPlugin, toplistId: window.currentTopListDetailId }, window.currentTopListCover);
    },

    /**
     * 渲染榜单搜索结果表格（分页：默认 50/页可自定义，翻页只重渲染不重新请求）。
     * 全量结果存于 this._searchSongs；按钮仍传全量列表。
     */
    async renderSearchResults() {
        const container = document.getElementById('toplist-content');
        if (!container || !this._searchSongs) return;
        const allSongs = this._searchSongs;
        const query = this._searchQuery || '';
        const pageSize = getSongTablePageSize();
        const totalPages = Math.max(1, Math.ceil(allSongs.length / pageSize));
        this.searchPage = Math.min(Math.max(1, this.searchPage || 1), totalPages);
        const start = (this.searchPage - 1) * pageSize;
        const pageSongs = allSongs.slice(start, start + pageSize);
        const hasSearchSongs = allSongs.length > 0;

        await SongTable.render({
            container: container,
            pageId: 'toplist-search',
            title: `"${escapeHtml(query)}" 的搜索结果`,
            subtitle: `${allSongs.length} 首歌曲`,
            songs: pageSongs,
            indexOffset: start,
            pagination: {
                page: this.searchPage,
                pageSize: pageSize,
                total: allSongs.length,
                pageSizes: SONGTABLE_PAGE_SIZES,
                onPageChange: (p) => { this.searchPage = p; this.renderSearchResults(); },
                onPageSizeChange: (n) => { setSongTablePageSize(n); this.searchPage = 1; this.renderSearchResults(); }
            },
            showHeader: true,
            onBack: 'TopListModule.backToTopList()',
            columns: ['checkbox', 'favorite', 'download', 'index', 'title', 'artist', 'album', 'duration', 'source'],
            actions: typeof ButtonActions !== 'undefined'
                ? [
                    ButtonActions.createPlayButtonWithUnifiedLogic({ pageId: 'toplist-search', songs: allSongs, disabled: !hasSearchSongs }),
                    ButtonActions.createAddButtonWithUnifiedLogic({ pageId: 'toplist-search', songs: allSongs, sourceName: '搜索结果', disabled: !hasSearchSongs }),
                    ButtonActions.createDownloadButtonWithUnifiedLogic({ pageId: 'toplist-search', songs: allSongs, disabled: !hasSearchSongs, source: '排行榜搜索-下载' })
                  ]
                : [
                    { id: 'play', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>', text: '播放', primary: false, disabled: !hasSearchSongs, onClick: () => ButtonActions.handlePlay('toplist-search', allSongs) },
                    { id: 'add', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>', text: '添加', disabled: !hasSearchSongs, onClick: () => ButtonActions.handleAdd('toplist-search', allSongs, '搜索结果') },
                    { id: 'download', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>', text: '下载', disabled: !hasSearchSongs, onClick: () => ButtonActions.handleDownload('toplist-search', allSongs) }
                ],
            events: {
                onPlay: (song, index) => TopListModule.playSearchResultByIndex(start + index),
                onFavorite: (song, index) => TopListModule.toggleSearchResultFavorite(start + index),
                onDownload: (song, index) => TopListModule.downloadSearchResultByIndex(start + index)
            }
        });
    },

    /**
     * 返回榜单列表
     */
    backToTopList() {
        currentTopListTitle = null;
        currentSearchQuery = '';
        currentSearchType = 'music';
        this.onBackCallback = null; // 清除返回回调
        toplistManageMode = false; // 退出管理模式
        removeTopListDetailMenu(); // 清理详情页头「⋯」菜单
        this.loadTopLists();
        if (currentPage === 'toplist') {
            this.renderTabs();
        }
    },

    /**
     * 在榜单页面内搜索（仅搜索歌曲）
     */
    async search() {
        const searchInput = document.getElementById('toplist-search-input');
        const query = searchInput ? searchInput.value.trim() : '';
        const type = 'music'; // 固定搜索类型为歌曲

        if (!query) {
            showToast('请输入搜索关键词', 'error');
            return;
        }

        currentSearchQuery = query;
        currentSearchType = type;
        showToast('搜索中...');

        try {
            const result = await API.music.search(query, type, currentTopListPlugin);

            if (result.success && result.data) {
                let musicList = [];
                if (Array.isArray(result.data)) {
                    musicList = result.data;
                } else if (result.data.data && Array.isArray(result.data.data)) {
                    musicList = result.data.data;
                }

                if (musicList.length === 0) {
                    showToast('未找到相关结果', 'warning');
                    return;
                }

                const container = document.getElementById('toplist-content');
                if (!container) {
                    console.error('[ERROR] [] [] Container not found for search results');
                    return;
                }
                container.innerHTML = '';

                // 为每首歌曲添加 plugin 和 platform 字段
                const searchPlugin = currentTopListPlugin;
                musicList = musicList.map(song => {
                    if (!song.plugin) {
                        song.plugin = song.platform || searchPlugin;
                    }
                    if (!song.platform) {
                        song.platform = song.plugin || searchPlugin;
                    }
                    return song;
                });

                // 保存到全局变量
                window.currentTopListMusicList = musicList;

                // 分页渲染搜索结果（翻页只重渲染表格不重新请求；新搜索重置到第 1 页）
                this._searchSongs = musicList;
                this._searchQuery = query;
                this.searchPage = 1;
                await this.renderSearchResults();
                showToast(`找到 ${musicList.length} 条结果`, 'success');
            } else {
                showToast('搜索失败: ' + (result.error || '未知错误'), 'error');
            }
        } catch (error) {
            console.error('搜索失败:', error);
            showToast('搜索失败: ' + error.message, 'error');
        }
    },

    /**
     * 加载榜单列表（兼容旧接口）
     */
    loadTopLists() {
        return this.loadAllTopLists();
    },

    // ============== SongTable 事件处理函数 ==============

    /**
     * 播放指定索引的歌曲（榜单页面）
     * @param {number} index - 歌曲索引
     */
    playByIndex(index) {
        const songs = window.currentTopListMusicList || [];
        if (!songs[index]) {
            return;
        }

        // 设置当前页面歌曲列表供 playMusic 使用
        window.currentPageMusicList = songs;

        if (typeof playMusic === 'function') {
            playMusic(index);
        } else {
            console.error('[TopListModule.playByIndex] playMusic is not a function');
        }
    },

    /**
     * 播放搜索结果指定索引的歌曲
     * @param {number} index - 歌曲索引
     */
    playSearchResultByIndex(index) {
        const songs = window.currentTopListMusicList || [];
        if (!songs[index]) {
            showToast('歌曲不存在', 'error');
            return;
        }

        const song = songs[index];

        // 确保歌曲有 plugin 字段
        if (!song.plugin) {
            song.plugin = song.platform || currentTopListPlugin;
        }
        if (!song.platform) {
            song.platform = song.plugin || currentTopListPlugin;
        }

        // 检查歌曲是否有 plugin
        if (!song.plugin) {
            showToast('无法确定歌曲来源插件', 'error');
            return;
        }

        // 更新数组
        songs[index] = song;
        window.currentTopListMusicList = songs;

        // 设置当前页面歌曲列表供 playMusic 使用
        window.currentPageMusicList = songs;

        if (typeof playMusic === 'function') {
            playMusic(index);
        } else {
            console.error('[TopListModule.playSearchResultByIndex] playMusic is not a function');
        }
    },

    /**
     * 切换搜索结果指定索引歌曲的收藏状态
     * @param {number} index - 歌曲索引
     */
    async toggleSearchResultFavorite(index) {
        const songs = window.currentTopListMusicList || [];
        const song = songs[index];
        if (!song) return;

        // 确保歌曲有 plugin 字段
        if (!song.plugin) {
            song.plugin = song.platform || currentTopListPlugin;
        }
        if (!song.platform) {
            song.platform = song.plugin || currentTopListPlugin;
        }

        if (!song.plugin) {
            showToast('无法确定歌曲来源', 'error');
            return;
        }

        songs[index] = song;
        window.currentTopListMusicList = songs;

        // 调用 toggleFavorite 处理
        await this.toggleFavorite(index);
    },

    /**
     * 下载搜索结果指定索引的歌曲
     * @param {number} index - 歌曲索引
     */
    async downloadSearchResultByIndex(index) {
        const songs = window.currentTopListMusicList || [];
        const song = songs[index];
        if (!song) return;

        // 确保歌曲有 plugin 字段
        if (!song.plugin) {
            song.plugin = song.platform || currentTopListPlugin;
        }
        if (!song.platform) {
            song.platform = song.plugin || currentTopListPlugin;
        }

        if (!song.plugin) {
            showToast('无法确定歌曲来源', 'error');
            return;
        }

        songs[index] = song;
        window.currentTopListMusicList = songs;

        // 调用 downloadByIndex 处理
        await this.downloadByIndex(index);
    },

    /**
     * 切换指定索引歌曲的收藏状态
     * @param {number} index - 歌曲索引
     */
    async toggleFavorite(index) {
        const songs = window.currentTopListMusicList || [];
        const song = songs[index];
        if (!song) return;

        try {
            const plugin = song.plugin || song.platform;
            const isFavorited = isSongFavoritedSync(song.id, plugin);

            if (isFavorited) {
                await API.myFavorites.remove(song.id, plugin);
                showToast('已取消收藏', 'success');
            } else {
                await API.myFavorites.add(song);
                showToast('已添加到收藏', 'success');
            }

            // 刷新收藏列表
            if (typeof loadMyFavorites === 'function') {
                loadMyFavorites();
            }

            // 同步更新播放器收藏按钮状态（如果当前播放的是这首歌）
            if (window.currentMusic && window.currentMusic.id == song.id) {
                const currentPlugin = window.currentMusic.platform || window.currentMusic.plugin;
                if (currentPlugin === plugin) {
                    // 使用 ButtonManager 更新播放器按钮
                    if (window.ButtonManager) {
                        ButtonManager.updateFavoriteButton(song.id, plugin, !isFavorited);
                    }
                    // 同时更新 StateManager 中的状态
                    if (window.StateManager) {
                        StateManager.setFavoriteStatus(song.id, plugin, !isFavorited);
                    }
                    // 更新内存中的状态
                    window.isCurrentMusicLiked = !isFavorited;
                    window.currentMusic._isLiked = !isFavorited;
                }
            }
        } catch (error) {
            console.error('收藏操作失败:', error);
            showToast('操作失败: ' + error.message, 'error');
        }
    },

    /**
     * 下载指定索引的歌曲
     * @param {number} index - 歌曲索引
     */
    async downloadByIndex(index) {
        const songs = window.currentTopListMusicList || [];
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
            await DownloadCore.startBackendDownload(song, '排行榜-下载');
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
                    source: 'toplist-retry',
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
     * 订阅当前榜单
     */
    async subscribeCurrent() {
        if (!currentTopListPlugin || !window.currentTopListDetailId) {
            showToast('无法获取榜单信息', 'error');
            return;
        }

        try {
            // 获取当前榜单的歌曲数量
            const songs = window.currentTopListMusicList || [];
            const totalSongs = songs.length;

            await subscribeToplist(
                window.currentTopListDetailId,
                currentTopListPlugin,
                {
                    title: currentTopListTitle || window.currentTopListDetailId,
                    cover: window.currentTopListCover || '',
                    sourceType: 'toplist',
                    isEnabled: 1 // 默认启动状态
                },
                totalSongs
            );
            showToast('已添加到订阅列表（启动）', 'success');
        } catch (error) {
            console.error('订阅失败:', error);
            showToast('订阅失败', 'error');
        }
    }
};

// ==================== 添加到歌单功能 ====================

/**
 * 获取当前页面选中的歌曲
 * @returns {Array} 选中的歌曲列表
 */
function getSelectedSongs() {
    return MusicTable.getSelectedSongs ? MusicTable.getSelectedSongs() : [];
}

/**
 * 获取当前页面显示的所有歌曲
 * @returns {Array} 所有歌曲列表
 */
function getCurrentSongs() {
    return MusicTable.getCurrentSongs ? MusicTable.getCurrentSongs() : [];
}

/**
 * 添加选中的歌曲到歌单
 * 场景1：未选中歌曲 -> 将当前列表所有歌曲添加到新榜单
 * 场景2：已选中歌曲 -> 弹出选择框，可选择新建或添加到已有榜单
 */
async function addSelectedToMyPlaylist() {
    const selectedSongs = getSelectedSongs();
    const currentSongs = getCurrentSongs();

    // 场景1：未选中歌曲
    if (!selectedSongs || selectedSongs.length === 0) {
        if (!currentSongs || currentSongs.length === 0) {
            showToast('当前列表没有歌曲', 'warning');
            return;
        }

        // 使用当前列表名称作为新榜单名称，并加上插件别名前缀（如“酷我-热歌榜”）
        const playlistName = (typeof window.getEffectivePlaylistName === 'function')
            ? await window.getEffectivePlaylistName(currentTopListTitle || '新建歌单', currentSongs, currentTopListPlugin)
            : (currentTopListTitle || '新建歌单');

        // 显示确认弹窗：与「订阅」同款语义——只保存榜单地址（插件 + 榜单ID），
        // 不逐首入库；进入歌单时实时向插件拉取最新榜单（排名/封面与排行榜一致）
        showConfirmModal({
            title: '保存为实时榜单歌单',
            message: `将当前榜单「${playlistName}」保存为实时歌单吗？\n歌单里只保存榜单地址，每次打开都会自动拉取最新榜单（不保存任何歌曲快照）。`,
            confirmText: '确认保存',
            confirmClass: 'btn-primary',
            onConfirm: async () => {
                await addSongsToNewPlaylist(currentSongs, playlistName);
            }
        });
        return;
    }

    // 场景2：已选中歌曲，显示选择弹窗（携带榜单封面）
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal(selectedSongs, currentTopListTitle, window.currentTopListCover);
    } else {
        showToast('歌单功能未加载，请稍后再试', 'error');
    }
}

/**
 * 保存为动态歌单（场景1）：只保存来源地址（插件 + 榜单/歌单ID），不逐首入库快照
 * @param {Array} songs - 当前页面歌曲（仅用于统计，不写入歌单）
 * @param {string} playlistName - 歌单名称
 * @param {string} cover - 封面地址（缺省时使用榜单/歌单封面）
 * @param {Object} [sourceOverride] - 来源覆盖（热门歌单页传 {type:'playlist', platform, toplistId}）
 */
async function addSongsToNewPlaylist(songs, playlistName, cover, sourceOverride) {
    try {
        // 与「订阅」同款语义：只保存来源地址，进入歌单时实时向插件拉取最新内容
        const source = sourceOverride || {
            type: 'toplist',
            platform: currentTopListPlugin,
            toplistId: window.currentTopListDetailId
        };
        if (!source.platform || !source.toplistId) {
            showToast('无法获取榜单信息，保存失败', 'error');
            return;
        }

        showToast('正在保存实时歌单...');
        const response = await fetch(`${API_BASE}/api/my/playlists`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: playlistName,
                description: '',
                cover: cover || window.currentTopListCover || '',
                source
            })
        });

        const result = await response.json();

        if (result.success && result.data) {
            showToast('已保存为实时榜单歌单，进入时自动获取最新榜单', 'success');
        } else {
            showToast('保存失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('保存榜单歌单失败:', error);
        showToast('保存失败: ' + error.message, 'error');
    }
}

/**
 * 批量添加歌曲到歌单
 */
async function batchAddSongsToPlaylist(playlistId, songs, _playlistName) {
    showToast(`正在添加 ${songs.length} 首歌曲...`);

    let successCount = 0;
    let duplicateCount = 0;
    let failCount = 0;

    for (const song of songs) {
        try {
            const result = await addToPlaylist(playlistId, song, { silent: true });
            if (result.success) {
                successCount++;
            } else if (result.error === 'duplicate') {
                duplicateCount++;
            } else {
                failCount++;
            }
        } catch (error) {
            failCount++;
        }
    }

    // 显示结果
    let message = '';
    if (successCount > 0) {
        message += `成功添加 ${successCount} 首`;
    }
    if (duplicateCount > 0) {
        message += (message ? '，' : '') + `${duplicateCount} 首已存在`;
    }
    if (failCount > 0) {
        message += (message ? '，' : '') + `${failCount} 首失败`;
    }

    showToast(message, successCount > 0 ? 'success' : 'warning');

    // 刷新侧边栏歌单列表
    loadSidebarPlaylists();
}

/**
 * 显示确认弹窗
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
                <button class="btn btn-secondary" onclick="closeConfirmModal()">取消</button>
                <button class="btn ${options.confirmClass || 'btn-primary'}" onclick="handleConfirm()">${escapeHtml(options.confirmText)}</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    window.handleConfirm = () => {
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

function closeConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    if (modal) {
        modal.remove();
    }
}

// 导出到全局作用域
// ==================== 榜单详情管理模式与页头「⋯」菜单 ====================

// 管理模式（页头「⋯」→「管理」）：勾选歌曲批量下载
let toplistManageMode = false;

/** 顶部「⋯」菜单：展开/收起（同我的歌单详情页） */
function toggleTopListDetailMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('toplist-detail-menu');
    if (!menu) return;
    const willOpen = menu.style.display !== 'block';
    menu.style.display = willOpen ? 'block' : 'none';
    if (willOpen) {
        setTimeout(() => document.addEventListener('click', closeTopListDetailMenu), 0);
    } else {
        document.removeEventListener('click', closeTopListDetailMenu);
    }
}

function closeTopListDetailMenu() {
    const menu = document.getElementById('toplist-detail-menu');
    if (menu) menu.style.display = 'none';
    document.removeEventListener('click', closeTopListDetailMenu);
}

/** 页头右侧「⋯」按钮 + 下拉管理菜单（同我的歌单详情页顶部） */
function setupTopListDetailMenu() {
    const actions = document.getElementById('header-actions');
    if (!actions) return;
    actions.querySelectorAll('.toplist-detail-more').forEach((el) => el.remove());
    const wrap = document.createElement('div');
    wrap.className = 'toplist-detail-more';
    wrap.style.cssText = 'position: relative; display: flex; align-items: center;';
    wrap.innerHTML = `
        <button type="button" title="更多" onclick="event.stopPropagation(); toggleTopListDetailMenu(event)"
            class="header-icon-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
        <div id="toplist-detail-menu"
            style="display: none; position: absolute; right: 0; top: calc(100% + 6px); min-width: 150px; background: var(--surface-color); border: 1px solid var(--divider-color); border-radius: 10px; box-shadow: var(--shadow-lg); z-index: 1002; padding: 6px 0; overflow: hidden;">
            <button type="button" id="toplist-menu-manage" onclick="event.stopPropagation(); closeTopListDetailMenu(); toggleTopListManageMode();"
                style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">${toplistManageMode ? '完成管理' : '管理'}</button>
            <button type="button" onclick="event.stopPropagation(); closeTopListDetailMenu(); TopListModule.subscribeCurrent();"
                style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">${TopListModule._detailSubscribed ? '取消订阅' : '订阅'}</button>
        </div>`;
    actions.appendChild(wrap);
}

/** 清理详情页头「⋯」控件（返回榜单列表时调用） */
function removeTopListDetailMenu() {
    closeTopListDetailMenu();
    document.querySelectorAll('.toplist-detail-more').forEach((el) => el.remove());
}

/** 切换管理模式：出现勾选列，Hero 显示批量下载/完成 */
function toggleTopListManageMode() {
    toplistManageMode = !toplistManageMode;
    // 同步页头菜单文字
    const menu = document.getElementById('toplist-detail-menu');
    if (menu) {
        const btns = menu.querySelectorAll('button');
        const manageBtn = btns[btns.length - 1];
        if (manageBtn) manageBtn.textContent = toplistManageMode ? '完成管理' : '管理';
    }
    TopListModule.renderDetailTable();
}

/** 管理模式：批量下载勾选歌曲（未勾选时提示） */
function downloadTopListSelected() {
    const sel = (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs)
        ? (SongTable.getSelectedSongs('toplist') || []) : [];
    if (!sel.length) {
        showToast('请先勾选要下载的歌曲', 'warning');
        return;
    }
    if (typeof ButtonActions !== 'undefined') {
        ButtonActions.handleDownload('toplist', sel);
    } else {
        showToast('下载功能未加载', 'error');
    }
}

window.toggleTopListDetailMenu = toggleTopListDetailMenu;
window.closeTopListDetailMenu = closeTopListDetailMenu;
window.toggleTopListManageMode = toggleTopListManageMode;
window.downloadTopListSelected = downloadTopListSelected;

window.TopListModule = TopListModule;

/** 随机播放当前榜单的一首歌（Hero 随机按钮） */
window.playTopListRandom = () => {
    const songs = window.currentTopListMusicList || [];
    if (!songs.length) {
        showToast('榜单为空', 'warning');
        return;
    }
    // 播放器随机按钮自动打开
    if (typeof enableShuffleMode === 'function') enableShuffleMode();
    TopListModule.playByIndex(Math.floor(Math.random() * songs.length));
};
window.loadTopListPlugins = () => TopListModule.loadPlugins();
window.loadTopLists = () => TopListModule.loadTopLists();
window.loadTopListDetail = (id, title, platform, onBack) => TopListModule.loadDetail(id, title, platform, onBack);
window.backToTopList = () => TopListModule.backToTopList();
window.searchInTopList = () => TopListModule.search();
window.renderTopListTabs = () => TopListModule.renderTabs();
window.switchTopListPlugin = (name) => TopListModule.switchPlugin(name);
window.getCurrentSongs = getCurrentSongs;
window.getSelectedSongs = getSelectedSongs;
window.addSelectedToMyPlaylist = addSelectedToMyPlaylist;
window.addSongsToNewPlaylist = addSongsToNewPlaylist;
window.batchAddSongsToPlaylist = batchAddSongsToPlaylist;
window.showConfirmModal = showConfirmModal;
window.closeConfirmModal = closeConfirmModal;
