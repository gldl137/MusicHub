/**
 * MusicHub 主应用文件（精简版）
 *
 * 模块说明：
 * - js/core/: 核心模块（配置、状态、工具函数、API、事件总线）
 * - js/components/: 通用组件（歌曲表格、插件标签）
 * - js/modules/: 功能模块（播放器、搜索、排行榜、热门歌单等）
 * - js/app.js: 主应用入口（页面切换、初始化、播放控制）
 */

// ==================== 日志工具 ====================
// 日志级别配置：默认显示 INFO / WARN / ERROR 关键节点（播放开始/成功、下载完成、异常等），
// DEBUG 细节默认静默，避免刷屏；排查时可临时改为 'DEBUG'。
const LOG_LEVEL = 'INFO';
const LOG_LEVELS = {
    'ERROR': 0,
    'WARN': 1,
    'INFO': 2,
    'DEBUG': 3
};

/**
 * 格式化日志时间戳
 * @returns {string} HH:MM:SS.mmm
 */
function formatLogTime() {
    const now = new Date();
    return now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
}

/**
 * 输出标准格式日志
 * @param {string} level - 日志级别 (INFO, DEBUG, WARN, ERROR)
 * @param {string} module - 模块名
 * @param {string} message - 消息内容
 * @param {Object} meta - 元数据（token 等）
 */
/* exported log */
function log(level, module, message, meta = {}) {
    // 检查日志级别，只输出配置的级别及以上的日志
    const currentLevel = LOG_LEVELS[LOG_LEVEL] ?? 2;
    const messageLevel = LOG_LEVELS[level] ?? 2;
    if (messageLevel > currentLevel) {
        return;
    }

    const time = formatLogTime();
    const tokenStr = meta.token ? `[token=${meta.token}]` : meta.preload ? '[preload]' : '';
    const formatted = `${time} [${level.padEnd(5)}] [${module}]${tokenStr} ${message}`;

    switch (level) {
        case 'ERROR':
            console.error(formatted);
            break;
        case 'WARN':
            console.warn(formatted);
            break;
        case 'DEBUG':
            console.debug(formatted);
            break;
        default:
            console.log(formatted);
    }
}

// ==================== 页面初始化 ====================

/**
 * 初始化应用（在登录后调用）
 */
async function initApp() {
    // 加载插件
    if (typeof loadPlugins === 'function') {
        loadPlugins();
    }

    // 加载设置
    if (typeof loadSettings === 'function') {
        loadSettings();
    }

    // 加载热门歌单插件
    if (typeof loadRecommendPlugins === 'function') {
        loadRecommendPlugins();
    }

    // 初始化收藏缓存
    if (typeof initFavoritesCache === 'function') {
        await initFavoritesCache();
    }

    // 更新管理员菜单可见性
    updateAdminMenuVisibility();

    // 使用 FavoriteManager 订阅收藏状态变更
    if (window.FavoriteManager) {
        FavoriteManager.subscribe('player', ({ musicId, platform, isFavorited }) => {
            // 如果当前播放的歌曲收藏状态发生变化，更新播放器收藏按钮
            if (window.currentMusic && window.currentMusic.id === musicId) {
                const currentPlatform = window.currentMusic.platform || window.currentMusic.plugin || '';
                const eventPlatform = platform || '';

                if (currentPlatform === eventPlatform) {
                    window.isCurrentMusicLiked = isFavorited;
                    window.currentMusic._isLiked = isFavorited;
                    FavoriteManager.updatePlayerButton(isFavorited);
                }
            }
        });
    }

    // 监听用户登出事件，停止播放并清空状态
    window.addEventListener('auth:logout', () => {
        // 1. 停止播放
        const player = document.getElementById('audio-player');
        if (player) {
            player.pause();
            player.src = '';
        }

        // 2. 重置播放状态
        window.isPlaying = false;
        window.currentMusic = null;
        window.currentIndex = -1;
        window.currentPlaylist = [];
        window.currentTime = 0;

        // 3. 更新播放器UI
        if (typeof PlayerModule !== 'undefined') {
            PlayerModule.updateExternalPlayButton(false);
            PlayerModule.updateExternalPlayerInfo();
        }

        // 4. 更新播放列表UI
        if (typeof renderPlaylist === 'function') {
            renderPlaylist();
        }

        // 5. 清除播放器标题和艺术家显示
        const titleEl = document.getElementById('player-title');
        const artistEl = document.getElementById('player-artist');
        const coverEl = document.getElementById('player-cover');
        if (titleEl) titleEl.textContent = '未在播放';
        if (artistEl) artistEl.textContent = '-';
        if (coverEl) {
            coverEl.innerHTML = '<div style="font-size: 24px; color: var(--text-tertiary);">🎵</div>';
        }
    });

    // 监听用户登录事件，加载该用户的播放状态
    window.addEventListener('auth:login', async (_event) => {
        // 等待一小段时间确保认证状态已更新
        setTimeout(async () => {
            // 1. 加载用户的播放队列
            await loadPlayQueueFromServer();

            // 2. 加载用户的播放器状态
            await loadPlayerStateFromServer();

            // 3. 更新管理员菜单可见性
            updateAdminMenuVisibility();
        }, 100);
    });

    // 监听下载状态变化事件，更新播放器下载按钮
    window.addEventListener('download:statusChanged', (event) => {
        const { musicId, plugin, status } = event.detail;
        if (!window.currentMusic) return;

        const currentId = String(window.currentMusic.id);
        const currentPlugin = window.currentMusic.platform || window.currentMusic.plugin;

        // 检查是否是当前播放的歌曲
        if (musicId === currentId && plugin === currentPlugin) {
            updatePlayerDownloadButton(status);
        }
    });

    // 加载侧边栏歌单列表
    if (typeof loadSidebarPlaylists === 'function') {
        loadSidebarPlaylists();
    }

    // 从 localStorage 读取上次访问的页面：在哪个页面刷新就回到哪个页面。
    // 动态读取 DOM 校验页面模板是否还存在，失效时回退到侧边栏第一个菜单项。
    const firstNavItem = document.querySelector('.nav-menu .nav-item');
    const fallbackPage = (firstNavItem && firstNavItem.dataset.page) || 'recent';
    let savedPage = localStorage.getItem('currentPage') || '';
    // 「我的电台」只是电台页的一个视图，统一映射到 radio 页面
    if (savedPage === 'my-radio') savedPage = 'radio';
    // 页面不存在（改名 / 移除）或没记录过 → 回退到落地页。
    // 注意：页面模板是动态加载的，启动时 DOM 里还没有 page-xxx 容器，
    // 要用模板映射表 pageTemplates 校验，不能查 DOM。
    if (!savedPage || !(pageTemplates[savedPage] || document.getElementById(`page-${savedPage}`))) {
        savedPage = fallbackPage;
    }
    // 受限页面（设置 / 下载订阅）仅管理员可进
    if ((savedPage === 'settings' || savedPage === 'subscribed-toplist') &&
        (!window.Auth || !window.Auth.isAdmin())) {
        savedPage = fallbackPage;
    }

    // 先切换到保存的页面（加载模板）
    await switchPage(savedPage, true); // 跳过数据加载，只加载模板

    // 如果上次访问的是排行榜页面，先加载插件再加载数据
    if (savedPage === 'toplist') {
        // 刷新页面时清除详情状态，进入排行榜主页
        saveTopListDetailState(null, null);
        currentTopListTitle = null;
        await loadTopListPlugins();
    } else {
        // 其他页面，触发数据加载
        const pageLoaders = {
            'recommend': () => { if (typeof loadRecommendSheets === 'function') loadRecommendSheets(); },
            'recent': () => { if (typeof loadRecentPlays === 'function') loadRecentPlays(); },
            'my-playlists': () => { if (typeof loadMyPlaylists === 'function') loadMyPlaylists(); },
            'download': () => { if (typeof loadDownloads === 'function') loadDownloads(); },
            'subscribed-toplist': () => { if (typeof loadSubscribedToplists === 'function') loadSubscribedToplists(); },
            'favorites': () => { if (typeof loadFavorites === 'function') loadFavorites(); },
            'settings': () => { if (typeof loadSettings === 'function') loadSettings(); },
            'plugins': () => { if (typeof loadPlugins === 'function') loadPlugins(); },
            'local': () => { if (typeof loadLocalMusic === 'function') loadLocalMusic(); },
            'radio': () => {
                if (typeof RadioModule !== 'undefined') RadioModule.load();
                if (localStorage.getItem('radioView') === 'my-radio') {
                    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
                    const el = document.querySelector('[data-page="my-radio"]');
                    if (el) el.classList.add('active');
                }
            },
            'lx-toplist': () => { if (typeof lxInitToplist === 'function') lxInitToplist(); },
            'lx-recommend': () => { if (typeof lxInitRecommend === 'function') lxInitRecommend(); }
        };
        if (pageLoaders[savedPage]) {
            pageLoaders[savedPage]();
        }
    }

    // 初始化 Player Watcher（状态驱动播放的核心）
    initPlayerWatcher();

    // 从后端加载播放队列
    await loadPlayQueueFromServer();

    // 设置默认播放模式（关闭循环）
    window.playMode = 'off';
    window.repeatMode = 'off';

    // 从后端加载播放器状态（恢复上次播放的歌曲）
    await loadPlayerStateFromServer();

    // 初始化播放器（在恢复状态后初始化，确保显示正确的歌曲）
    if (typeof PlayerModule !== 'undefined') {
        PlayerModule.init();
    }
}

// 监听应用就绪事件（登录后触发）
window.addEventListener('app:ready', () => {
    initApp();
});

/**
 * 从后端加载播放队列
 */
async function loadPlayQueueFromServer() {
    if (typeof PlayQueueAPI === 'undefined') {
        return;
    }

    try {
        const songs = await PlayQueueAPI.getQueue();
        if (songs && songs.length > 0) {
            window.currentPlaylist = songs;
        }
    } catch (err) {
        // 忽略错误
    }
}

/**
 * 从后端加载播放器状态
 */
async function loadPlayerStateFromServer() {
    if (typeof PlayerStateAPI === 'undefined') {
        return;
    }

    try {
        const state = await PlayerStateAPI.getState();
        if (state) {
            // 恢复播放器状态
            if (state.currentIndex >= 0 && window.currentPlaylist && state.currentIndex < window.currentPlaylist.length) {
                window.currentIndex = state.currentIndex;
                window.currentMusic = window.currentPlaylist[state.currentIndex];

                // 恢复播放器UI显示
                if (typeof PlayerModule !== 'undefined') {
                    // 更新播放器信息（不自动播放）
                    PlayerModule.updateExternalPlayerInfo();
                    PlayerModule.updateExternalPlayButton(false);

                    // 如果有歌曲，预加载歌曲信息
                    if (window.currentMusic) {
                        // 更新播放器标题、艺术家等信息
                        const titleEl = document.getElementById('player-title');
                        const artistEl = document.getElementById('player-artist');
                        const coverEl = document.getElementById('player-cover');

                        if (titleEl) titleEl.textContent = window.currentMusic.title || '未知歌曲';
                        if (artistEl) artistEl.textContent = window.currentMusic.artist || '未知歌手';
                        if (coverEl) {
                            const coverUrl = window.currentMusic.artwork || window.currentMusic.cover
                                || ((window.currentMusic.plugin === 'local' || window.currentMusic.platform === 'local' || window.currentMusic.filePath) && window.currentMusic.filePath
                                    ? `${window.API_BASE || ''}/api/music/cover?path=${encodeURIComponent(String(window.currentMusic.filePath).replace(/\\/g, '/'))}`
                                    : null);
                            if (coverUrl) {
                                coverEl.innerHTML = createImageWithFallback(coverUrl, 'cover', '') + "<div style='font-size:24px;color:var(--text-tertiary);display:none'>🎵</div>";
                            } else {
                                coverEl.innerHTML = '<div style="font-size: 24px; color: var(--text-tertiary);">🎵</div>';
                            }
                        }

                        // 加载歌曲但不播放，并恢复播放进度
                        await PlayerModule.load(window.currentMusic, false);

                        // 恢复播放进度（需要等待音频元数据加载完成）
                        if (state.currentTime > 0) {
                            const player = document.getElementById('audio-player');
                            if (player) {
                                // 监听 loadedmetadata 事件，确保音频元数据已加载
                                const setTime = () => {
                                    player.currentTime = state.currentTime;
                                    window.currentTime = state.currentTime;
                                    player.removeEventListener('loadedmetadata', setTime);
                                };
                                
                                if (player.readyState >= 1) {
                                    // 元数据已加载，直接设置
                                    player.currentTime = state.currentTime;
                                    window.currentTime = state.currentTime;
                                } else {
                                    // 等待元数据加载
                                    player.addEventListener('loadedmetadata', setTime);
                                }
                            }
                        }
                    }
                }
            }
            if (state.playMode) {
                window.playMode = state.playMode;
                window.repeatMode = state.playMode;
                // 更新循环按钮视觉状态和图标
                updateRepeatButtonIcon();
            }
            if (typeof state.isShuffle === 'boolean') {
                window.isShuffleMode = state.isShuffle;
                // 更新随机播放按钮视觉状态
                const shuffleBtn = document.getElementById('player-shuffle-btn');
                if (shuffleBtn) {
                    shuffleBtn.classList.toggle('active', window.isShuffleMode);
                }
            }
            if (typeof state.volume === 'number') {
                const player = document.getElementById('audio-player');
                if (player) {
                    player.volume = state.volume;
                }
            }
            // 刷新后音频肯定未播放，isPlaying 设为 false
            // 保留 state.isPlaying 信息用于判断是否需要自动播放（后续扩展）
            window.isPlaying = false;
        }
    } catch (err) {
        // 忽略错误
    }
}

// ==================== 页面切换 ====================

// 页面模板映射
const pageTemplates = {
    'toplist': 'toplist',
    'recommend': 'recommend',
    'download': 'download',
    'recent': 'recent',
    'plugins': 'plugins',
    'settings': 'settings',
    'subscribed-toplist': 'subscribed-toplist',
    'my-playlists': 'my-playlists',
    'favorites': 'favorites',
    'local': 'local',
    'radio': 'radio',
    'lx-toplist': 'lx-toplist',
    'lx-recommend': 'lx-recommend'
};

// 脚本一加载就点亮正确的侧边栏项：不等 app:ready（期间要等登录校验、模板加载），
// 否则刷新时会先显示第一项高亮、再跳到实际页面，看起来像闪一下。
(function preHighlightNav() {
    try {
        let page = localStorage.getItem('currentPage') || '';
        if (page === 'my-radio') page = 'radio';
        if (page === 'radio' && localStorage.getItem('radioView') === 'my-radio') page = 'my-radio';
        if (!pageTemplates[page]) return;
        const items = document.querySelectorAll('.nav-menu .nav-item');
        if (!items.length) return;
        items.forEach((i) => i.classList.remove('active'));
        const target = document.querySelector(`.nav-menu .nav-item[data-page="${page}"]`);
        if (target) target.classList.add('active');
    } catch (e) { /* ignore */ }
})();

// 页面标题映射（使用 config.js 中定义的 window.pageTitles）

/**
 * 手机端页头搜索（排行榜/热门歌单）：页头只显示最右侧搜索按钮，
 * 点击时若输入框未弹出则先弹出并聚焦，已弹出则执行搜索；桌面端直接搜索。
 * @param {string} inputId 搜索输入框 id
 * @param {'toplist'|'recommend'} moduleName 模块名（决定执行的搜索函数）
 */
function handleHeaderSearchClick(inputId, moduleName) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const wrap = input.closest('.toplist-header-search, .recommend-header-search');
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (isMobile && wrap && !wrap.classList.contains('expanded')) {
        wrap.classList.add('expanded');
        input.focus();
        return;
    }
    if (moduleName === 'toplist') {
        TopListModule.search();
    } else if (moduleName === 'recommend') {
        RecommendModule.searchSheets();
    } else if (moduleName === 'lx-toplist' && typeof lxToplistSearch === 'function') {
        lxToplistSearch();
    } else if (moduleName === 'lx-recommend' && typeof lxRecommendSearchSheets === 'function') {
        lxRecommendSearchSheets();
    }
}
window.handleHeaderSearchClick = handleHeaderSearchClick;

// 手机端搜索框失焦且为空时自动收起
document.addEventListener('focusout', (e) => {
    if (!e.target.matches || !e.target.matches('.toplist-header-search input, .recommend-header-search input')) return;
    const wrap = e.target.closest('.toplist-header-search, .recommend-header-search');
    if (!wrap || !wrap.classList.contains('expanded')) return;
    setTimeout(() => {
        if (!e.target.value.trim() && document.activeElement !== e.target) {
            wrap.classList.remove('expanded');
        }
    }, 120);
});

// 已加载的页面
const loadedPages = new Set();

/**
 * 页面导航历史（供移动端左右滑动「后退 / 前进」使用）
 * - 记录每次 switchPage 的页面，形成可前后回溯的栈
 * - back()/forward() 在执行 switchPage 时通过 _suppress 避免重复入栈
 */
const PageHistory = {
    stack: [],
    index: -1,
    _suppress: false,
    record(page) {
        if (this._suppress) return;
        if (this.index >= 0 && this.stack[this.index] === page) return;
        // 截断当前位置之后的「前进」分支
        this.stack = this.stack.slice(0, this.index + 1);
        this.stack.push(page);
        this.index = this.stack.length - 1;
        if (this.stack.length > 50) {
            this.stack.shift();
            this.index--;
        }
    },
    back() {
        if (this.index <= 0) return null;
        this.index--;
        return this.stack[this.index];
    },
    forward() {
        if (this.index >= this.stack.length - 1) return null;
        this.index++;
        return this.stack[this.index];
    }
};
window.PageHistory = PageHistory;

// 兜底：若启动流程未经过 switchPage，也把首屏页面写入历史栈
window.addEventListener('load', () => {
    if (window.currentPage && PageHistory.stack.length === 0) {
        PageHistory.record(window.currentPage);
    }
});

// 全局滑动手势（右滑后退/左滑前进）已按需求移除：移动端不再响应左右滑动返回。

async function switchPage(page, skipLoad = false) {
    // 切换页面时关闭移动端侧边栏
    closeMobileSidebar();

    // 离开歌单详情时自动退出其多选模式
    if (typeof window.resetPlaylistDetailManageMode === 'function') {
        window.resetPlaylistDetailManageMode();
    }

    // 清除歌单详情染色（页头跟随染色用的变量，避免污染其他页面）
    document.documentElement.style.removeProperty('--header-bg');

    // 关闭内容区播放列表
    const playlistPanel = document.getElementById('content-playlist-panel');
    if (playlistPanel && playlistPanel.classList.contains('open')) {
        playlistPanel.classList.remove('open');
        if (typeof PlayerModule !== 'undefined') {
            PlayerModule.isContentPlaylistOpen = false;
            PlayerModule.updateContentPlaylistButton();
        }
    }

    // 设置页面和下载订阅页面仅限管理员访问
    if (page === 'settings' || page === 'subscribed-toplist') {
        if (!window.Auth || !window.Auth.isAdmin()) {
            showToast('只有管理员可以访问此页面', 'error');
            return;
        }
    }

    const previousPage = window.currentPage;
    window.currentPage = page;
    if (window.PageHistory) PageHistory.record(page);

    // 保存当前页面到 localStorage
    localStorage.setItem('currentPage', page);

    // 隐藏推荐页面的标签面板
    if (previousPage === 'recommend' && typeof hideRecommendTagPanel === 'function') {
        hideRecommendTagPanel();
    }

    // 离开下载页面时停止定时刷新
    if (previousPage === 'download' && typeof stopDownloadRefreshInterval === 'function') {
        stopDownloadRefreshInterval();
    }

    // 更新导航状态
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });
    const navItem = document.querySelector(`[data-page="${page}"]`);
    if (navItem) navItem.classList.add('active');

    // 处理页面标题和插件标签
    const headerLeft = document.getElementById('header-left');

    if (page === 'toplist') {
        renderTopListTabs();
    } else if (page === 'recommend') {
        renderRecommendTabs();
    } else if (page === 'lx-toplist' && typeof lxRestoreHeader === 'function') {
        // LX 排行榜：页头与 MF 排行榜同款（菜单 + 标题 + 搜索框）
        lxRestoreHeader('lx-toplist');
    } else if (page === 'lx-recommend' && typeof lxRestoreHeader === 'function') {
        // LX 热门歌单：页头与 MF 热门歌单同款（菜单 + 标题 + 搜索框）
        lxRestoreHeader('lx-recommend');
    } else {
        // 其他页面显示菜单按钮+标题
        if (headerLeft) {
            headerLeft.innerHTML = `
                <button class="mobile-menu-btn" onclick="toggleMobileSidebar()" aria-label="打开菜单">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="3" y1="12" x2="21" y2="12"></line>
                        <line x1="3" y1="6" x2="21" y2="6"></line>
                        <line x1="3" y1="18" x2="21" y2="18"></line>
                    </svg>
                </button>
                <div class="header-title" id="page-title">${pageTitles[page] || 'MusicHub'}</div>
            `;
        }
    }

    // 切换页面显示
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

    // 处理设置页面的特殊显示逻辑
    const pageContainer = document.getElementById('page-container');
    const settingsPage = document.getElementById('page-settings');

    if (page === 'settings') {
        // 切换到设置页面：隐藏 page-container，显示设置页面
        if (pageContainer) pageContainer.style.display = 'none';
        if (settingsPage) settingsPage.style.display = 'flex';
    } else {
        // 切换到其他页面：显示 page-container，隐藏设置页面
        if (pageContainer) pageContainer.style.display = 'flex';
        if (settingsPage) settingsPage.style.display = 'none';
    }

    // 检查页面是否已加载
    let pageEl = document.getElementById(`page-${page}`);

    // 如果页面未加载或需要重新加载，清空 page-container
    if (!pageEl && pageTemplates[page]) {
        // 清空 page-container 中的动态内容（如歌单详情）
        const container = document.getElementById('page-container');
        if (container) {
            container.innerHTML = '';
            // 非设置页面时才显示 page-container
            if (page !== 'settings') {
                container.style.display = 'flex';
            }
        }

        // 重置歌单详情状态
        if (typeof window.currentPlaylistDetail !== 'undefined') {
            window.currentPlaylistDetail = null;
        }

        // 使用模板加载器加载页面
        if (container && window.TemplateLoader) {
            await TemplateLoader.loadInto(pageTemplates[page], container, true);
            pageEl = document.getElementById(`page-${page}`);
            loadedPages.add(page);
        }
    } else if (pageEl && page !== 'settings') {
        // 页面已存在且不是设置页面，显示 page-container
        const container = document.getElementById('page-container');
        if (container) {
            container.style.display = 'flex';
        }
    }

    if (pageEl) {
        pageEl.classList.add('active');
    }

    // 加载页面数据
    if (skipLoad) return;

    const pageLoaders = {
        'toplist': () => {
            if (previousPage === 'toplist' && currentTopListTitle) {
                backToTopList();
            } else {
                // 刷新排行榜数据（包括从其他页面切换和在当前页面刷新）
                loadTopLists();
            }
            if (topListPlugins && topListPlugins.length > 0) {
                renderTopListTabs();
            } else {
                loadTopListPlugins();
            }
        },
        'recommend': () => loadRecommendSheets(),
        'recent': () => loadRecentPlays(),
        'my-playlists': () => loadMyPlaylists(),
        'download': () => loadDownloads(),
        'subscribed-toplist': () => loadSubscribedToplists(),
        'favorites': () => loadFavorites(),
        'settings': () => loadSettings(),
        'plugins': () => loadPlugins(),
        'local': () => loadLocalMusic(),
        'radio': () => {
            if (typeof RadioModule !== 'undefined') RadioModule.load();
            // 「我的电台」视图时高亮对应导航项
            if (localStorage.getItem('radioView') === 'my-radio') {
                document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
                const el = document.querySelector('[data-page="my-radio"]');
                if (el) el.classList.add('active');
            }
        },
        'lx-toplist': () => { if (typeof lxInitToplist === 'function') lxInitToplist(); },
        'lx-recommend': () => { if (typeof lxInitRecommend === 'function') lxInitRecommend(); }
    };

    if (pageLoaders[page]) {
        pageLoaders[page]();
    }
}

/**
 * 侧边栏「我的电台」入口：复用电台页，进入收藏（喜欢）视图
 * 通过 localStorage 标记，刷新后可恢复到「我的电台」
 */
async function openMyRadio() {
    localStorage.setItem('radioView', 'my-radio');
    await switchPage('radio');
}
window.openMyRadio = openMyRadio;

/**
 * 普通「电台」导航：清除「我的电台」标记，回到常规电台页
 */
function goRadio() {
    localStorage.removeItem('radioView');
    switchPage('radio');
}
window.goRadio = goRadio;

// ==================== 播放控制 ====================

/**
 * 是否为落雪（LX）专区音源：plugin 形如 `lx:kg`。
 * LX 歌曲由落雪自定义音源解析，不属于 MusicFree 插件体系，
 * 因此不能走 /api/music-info、/api/search、/api/lyrics 这些插件接口
 * （否则只会得到「Plugin file not found: lx:xx」并报出与真实原因无关的错误）。
 * @param {string} pluginName
 * @returns {boolean}
 */
function isLxPlugin(pluginName) {
    return /^lx:/i.test(String(pluginName || ''));
}
window.isLxPlugin = isLxPlugin;

/**
 * 获取用于播放的插件名称
 * @param {Object} music - 歌曲对象
 * @param {string} caller - 调用者标识
 * @param {boolean} strict - 是否严格模式（只使用歌曲自带的plugin，不回退到默认插件）
 */
function getPluginForMusic(music, _caller = '', strict = false) {
    // 落雪（LX）专区歌曲：plugin 形如 `lx:kg`，其解析走落雪自定义音源，
    // 不属于 MusicFree 插件体系。必须原样返回、绝不回退到 music.platform
    // （LX 歌曲的 platform 可能是裸平台 key，如 kg/tx，若与某个 MF 插件名相撞，
    // 回退后会把 LX 歌曲路由到 MF 插件去播放，即「LX/MF 串台」，严格禁止）。
    if (music?.plugin && isLxPlugin(music.plugin)) {
        return music.plugin;
    }

    // 优先使用 plugin 字段（插件文件名）
    let pluginName = music?.plugin;

    // 本地音乐特殊处理：'local' 不是真实插件文件
    if (pluginName === 'local') {
        return 'local';
    }

    // 电台（直播流）统一标记为 'radio'，不回退到音乐插件
    if (pluginName === 'radio' || music?.platform === 'radio' || music?.isLive) {
        return 'radio';
    }

    const isValidPluginFile = installedPlugins.some(p => p.name === pluginName);

    if (!pluginName || !isValidPluginFile) {
        // 尝试使用 platform 字段
        pluginName = music?.platform;
        // 再次检查是否为本地音乐
        if (pluginName === 'local') {
            return 'local';
        }
        if (!installedPlugins.some(p => p.name === pluginName)) {
            pluginName = null;
        }
    }

    // 严格模式：只使用歌曲自带的plugin，不回退
    if (strict) {
        return pluginName || null;
    }

    // 非严格模式：回退到当前页面的默认插件
    if (!pluginName) {
        if (window.currentPage === 'toplist') {
            pluginName = currentTopListPlugin;
        } else if (window.currentPage === 'recommend') {
            pluginName = currentRecommendPlugin;
        } else {
            pluginName = currentTopListPlugin || currentRecommendPlugin;
        }
    }

    if (!pluginName && installedPlugins.length > 0) {
        // 工具插件（utility，如封面获取）无播放能力，不作为播放回退候选
        const playable = installedPlugins.find(p => !(p.config && p.config.utility === true));
        pluginName = playable ? playable.name : installedPlugins[0].name;
    }

    return pluginName;
}

/**
 * 播放音乐（纯状态 setter）
 * 只更新当前播放索引，实际播放由 Player Watcher 触发
 * @param {number} index - 歌曲索引
 */
async function playMusic(index) {
    // 明确使用 window.currentPageMusicList 确保获取最新值
    const pageMusicList = window.currentPageMusicList || [];

    // 使用 pageMusicList 中的歌曲（如果可用），否则使用 currentPlaylist
    const playlist = pageMusicList.length > 0 ? pageMusicList : window.currentPlaylist;

    if (!playlist || !playlist[index]) {
        showToast('无法播放：歌曲不存在', 'error');
        return;
    }

    // 记录前台日志 - 播放歌曲
    const music = playlist[index];
    if (music && typeof API !== 'undefined' && API.logs && API.logs.add) {
        API.logs.add('info', 'PLAYBACK', 'Playback started', {
            title: music.title,
            artist: music.artist,
            album: music.album,
            plugin: music.plugin || music.platform || '未知插件'
        }).catch(() => {}); // 忽略日志发送错误
    }

    // 检查播放列表是否需要更新（内容是否相同）
    let needUpdate = false;
    if (pageMusicList.length > 0) {
        // 检查两个列表是否完全相同（长度和每个位置的歌曲ID）
        const isSameList = window.currentPlaylist.length === pageMusicList.length &&
            window.currentPlaylist.every((song, i) => song.id === pageMusicList[i]?.id && song.plugin === pageMusicList[i]?.plugin);
        
        needUpdate = !isSameList;
        
        // 总是使用当前页面的歌曲列表播放
        window.currentPlaylist = [...pageMusicList];
    }

    // 更新状态
    window.currentIndex = index;
    window.currentMusic = playlist[index];

    // 重置播放模式为关闭（每次重新播放时）
    window.playMode = 'off';
    window.repeatMode = 'off';
    if (typeof updateRepeatButtonIcon === 'function') {
        updateRepeatButtonIcon();
    }

    // 触发 watcher（通过自定义事件）
    window.dispatchEvent(new CustomEvent('player:indexChanged', {
        detail: { index, song: window.currentMusic }
    }));

    // 如果播放列表更新了，异步保存到数据库（不阻塞播放）
    if (needUpdate && typeof PlayQueueAPI !== 'undefined') {
        PlayQueueAPI.saveQueue(window.currentPlaylist).catch(() => {});
    }

    // 更新歌曲列表中的播放状态
    updatePlayingRow();

    // 更新播放器下载按钮状态
    updatePlayerDownloadButtonState();

    // 异步保存播放器状态（不阻塞播放）
    savePlayerState();
}

/**
 * 保存播放器状态到后端（节流：1 秒窗口内多次触发合并，窗口末尾补发一次保留最新状态）
 * 播放一首歌会同时触发 indexChanged / play 事件 / UI 更新等多个调用点，
 * 不节流会同一秒内重复 POST /api/my/player-state 数次。
 */
let _saveStateLastAt = 0;
let _saveStateTimer = null;
const SAVE_STATE_MIN_INTERVAL = 1000;

function savePlayerState() {
    if (typeof PlayerStateAPI === 'undefined') return;

    const run = () => {
        _saveStateLastAt = Date.now();
        const state = {
            currentIndex: window.currentIndex || 0,
            currentTime: window.currentTime || 0,
            isPlaying: window.isPlaying || false,
            playMode: window.playMode || 'off',
            isShuffle: window.isShuffleMode || false,
            volume: document.getElementById('audio-player')?.volume || 1.0
        };
        // 静默保存，错误已在 API 层处理
        PlayerStateAPI.saveState(state).catch(() => {
            // 静默处理，不打印错误日志
        });
    };

    const now = Date.now();
    if (now - _saveStateLastAt >= SAVE_STATE_MIN_INTERVAL) {
        run();
        return;
    }
    // 节流窗口内：只挂一次尾随定时器，用最新状态在窗口末尾补发
    if (_saveStateTimer) return;
    _saveStateTimer = setTimeout(() => {
        _saveStateTimer = null;
        run();
    }, SAVE_STATE_MIN_INTERVAL - (now - _saveStateLastAt));
}

/**
 * Player Watcher - 监听索引变化，触发实际播放
 * 这是状态驱动播放的核心桥梁
 */
function initPlayerWatcher() {
    window.addEventListener('player:indexChanged', async (event) => {
        const { song } = event.detail;

        if (!song) return;

        // 使用 PlayerModule 加载并播放
        if (typeof PlayerModule !== 'undefined' && PlayerModule.load) {
            await PlayerModule.load(song);

            // 如果有保存的播放进度，恢复播放进度
            if (window.savedCurrentTime && window.savedCurrentTime > 0) {
                const player = document.getElementById('audio-player');
                if (player) {
                    player.currentTime = window.savedCurrentTime;
                    // 清除保存的进度，避免重复应用
                    window.savedCurrentTime = 0;
                }
            }
        } else {
            showToast('播放器未初始化', 'error');
        }
    });

    log('DEBUG', 'PlayerWatcher', 'Initialized');
}

/**
 * 更新正在播放的行样式
 */
function updatePlayingRow() {
    document.querySelectorAll('.music-row').forEach(row => {
        row.classList.remove('playing');
        if (window.currentMusic && row.dataset.musicId === window.currentMusic.id) {
            row.classList.add('playing');
        }
    });
    
    // 更新 SongTable 组件的播放状态
    if (window.SongTable && typeof window.SongTable.updateAllPlayingState === 'function') {
        window.SongTable.updateAllPlayingState();
    }
}

/**
 * 获取当前页面歌曲列表
 */
function getCurrentPageMusicList() {
    return window.currentPageMusicList || [];
}

/**
 * 规范化歌曲列表，确保所有歌曲的 id 为字符串类型
 * @param {Array} list - 歌曲列表
 * @returns {Array} 规范化后的歌曲列表
 */
function normalizeMusicList(list) {
    if (!list || !Array.isArray(list)) return [];
    return list.map(song => ({
        ...song,
        id: String(song.id)
    }));
}

/**
 * 设置当前页面歌曲列表
 */
function setCurrentPageMusicList(list) {
    window.currentPageMusicList = normalizeMusicList(list);
}

// ==================== 工具函数 ====================

/** 落雪（LX）平台 key → 中文显示名（本地兜底，不依赖其它模块的常量） */
const LX_PLATFORM_LABELS = { kw: '酷我', kg: '酷狗', tx: 'QQ音乐', wy: '网易云', mg: '咪咕', local: '本地' };
/** 落雪（LX）平台 key → 完整中文名（「音源别名-插件名」的别名部分，与后端 PLATFORMS 一致） */
const LX_PLATFORM_FULL_NAMES = { kw: '酷我音乐', kg: '酷狗音乐', tx: 'QQ音乐', wy: '网易云音乐', mg: '咪咕音乐' };
/** 取 LX 平台显示名（命名用途：歌单名前缀等只要平台名，不带音源脚本文件名） */
window.getLxPlatformName = function (key) {
    const k = String(key || '').toLowerCase();
    return LX_PLATFORM_FULL_NAMES[k] || LX_PLATFORM_LABELS[k] || '';
};

/**
 * 获取歌曲来源显示文本（统一为「音源别名-插件名」，详见 getMusicSourceLabel）
 */
function getMusicSourceText(pluginFileName) {
    if (!pluginFileName) return '-';
    return getMusicSourceLabel(pluginFileName) || '-';
}

/**
 * 全局统一的「来源」文案：音源别名-插件名（如「酷我音乐-酷我_念心.js」）。
 *   - MusicFree 插件：别名 = 音源组别名 groupName（回退 platform）；插件名 = 文件名（含 .js）
 *   - 落雪（LX）：别名 = 平台完整名（如「酷我音乐」）；插件名 = 生效音源脚本文件名（含 .js）
 *   - 本地 → 本地；STRM 由调用方判为 STRM；电台 → 电台插件名
 * 项目内所有来源显示（播放器、卡片、歌曲表格、下载等）统一走此函数。
 * @param {Object|string} input 歌曲对象（可带 lxSourceFile/lxResolvedFile）或插件标识（文件名 / lx:xx）
 * @returns {string}
 */
function getMusicSourceLabel(input) {
    const isObj = !!(input && typeof input === 'object');
    const rawId = String((isObj ? (input.plugin || input.platform) : input) || '').trim();
    if (!rawId) return '';

    // 落雪（LX）：别名 = 平台完整名；插件名 = 生效音源脚本文件名
    const lxMatch = /^lx:([a-z0-9]+)$/i.exec(rawId);
    if (lxMatch) {
        const key = lxMatch[1].toLowerCase();
        const plat = (typeof LX_PLATFORM_FULL_NAMES !== 'undefined' && LX_PLATFORM_FULL_NAMES[key])
            || (typeof LX_PLATFORM_LABELS !== 'undefined' && LX_PLATFORM_LABELS[key])
            || key.toUpperCase();
        let file = isObj ? String(input.lxResolvedFile || input.lxSourceFile || '').trim() : '';
        if (!file && typeof window.getLxSourcePref === 'function') {
            try { file = String(window.getLxSourcePref(key) || '').trim(); } catch { /* 忽略 */ }
        }
        if (!file && typeof window.getLxSourcesCached === 'function') {
            try {
                const list = window.getLxSourcesCached() || [];
                const hit = list.find((s) => s && s.enabled && s.state === 'ready'
                    && Array.isArray(s.platforms) && s.platforms.includes(key));
                if (hit && hit.file) file = String(hit.file);
            } catch { /* 忽略 */ }
        }
        file = file ? file.replace(/^.*[\\/]/, '') : '';
        return file ? `${plat}-${file}` : plat;
    }

    // 本地
    if (rawId === 'local') return '本地';

    // 电台：显示电台插件本身的名字（同样按「别名-插件名」）
    if (rawId === 'radio') {
        const name = String((isObj && input.sourcePlugin) || '').trim();
        if (!name || name === 'radio') return '电台';
        return getMusicSourceLabel(name);
    }

    // MusicFree 插件（或未知标识）
    const info = (window.installedPlugins || []).find((x) => x.name === rawId);
    const alias = info ? String(info.groupName || info.platform || '').trim() : '';
    const file = String((info && info.name) || rawId);
    if (alias && alias !== file && alias !== file.replace(/\.js$/i, '')) return `${alias}-${file}`;
    return file || alias;
}

// ==================== 封面音源类型角标（MF / LX）====================

/**
 * 单个角标：MF（MusicFree 插件）/ LX（落雪自定义音源）
 * @param {'MF'|'LX'} code
 */
function sourceBadgeHtml(code) {
    if (!code) return '';
    const isLx = code === 'LX';
    const title = isLx ? '落雪（LX）自定义音源' : 'MusicFree（MF）插件音源';
    return `<span class="cover-source-badge ${isLx ? 'lx' : 'mf'}" title="${title}">${code}</span>`;
}

/**
 * 歌曲卡片角标：按歌曲来源给 MF / LX（本地 / 电台 / STRM 不显示角标）
 * @param {Object|string} input 歌曲对象或插件标识
 */
function getSourceBadgeHtml(input) {
    const p = (input && typeof input === 'object') ? (input.plugin || input.platform) : input;
    if (!p) return '';
    const s = String(p);
    if (s === 'local' || s === 'radio') return '';
    if (/^lx:/i.test(s)) return sourceBadgeHtml('LX');
    return sourceBadgeHtml('MF');
}

/**
 * 歌单卡片角标：按歌单内容来源显示（可能有 MF + LX 两个角标）
 * 优先用曲目构成统计（自建歌单）；动态歌单（实时榜单/实时歌单）不逐首入库、
 * 统计恒为 0，此时按歌单记录的来源平台（sourcePlatform）判断。
 * @param {Object} playlist 含 mfCount / lxCount / sourcePlatform
 */
function getPlaylistSourceBadgeHtml(playlist) {
    const mf = Number((playlist && playlist.mfCount) || 0);
    const lx = Number((playlist && playlist.lxCount) || 0);
    if (mf || lx) {
        const inner = (mf ? sourceBadgeHtml('MF') : '') + (lx ? sourceBadgeHtml('LX') : '');
        return `<span class="cover-source-badges">${inner}</span>`;
    }
    // 动态歌单：来源平台即插件文件名（如 QQ_猫.js），落雪音源则为 lx:xx
    const sp = playlist && (playlist.sourcePlatform || playlist.source_plugin);
    if (!sp) return '';
    const s = String(sp);
    if (s === 'local' || s === 'radio') return '';
    return sourceBadgeHtml(/^lx:/i.test(s) ? 'LX' : 'MF');
}

/**
 * 歌曲来源显示文本：统一为「音源别名-插件名」（与项目其它来源显示一致）
 */
function getDisplaySource(music, opts) {
    if (!music) return '';
    if (isStrmSong(music)) return 'STRM';
    if (music.plugin === 'local' || music.platform === 'local' || !!music.filePath || music.isLocalMatch) return '本地';
    if (music.isLive || music.plugin === 'radio' || music.platform === 'radio') {
        return getMusicSourceLabel({ plugin: 'radio', sourcePlugin: music.sourcePlugin });
    }
    // 落雪（LX）：必须用歌曲自己的标识，不能借 getPluginForMusic 回退到某个 MF 插件
    if (typeof isLxPlugin === 'function' && isLxPlugin(music.plugin || music.platform)) {
        return getMusicSourceLabel(music);
    }
    const pf = (typeof getPluginForMusic === 'function')
        ? getPluginForMusic(music, 'play')
        : '';
    return getMusicSourceLabel({ ...music, plugin: pf || music.plugin || music.platform });
}

/**
 * 播放器来源「第一行」：来源类型，只分 4 种。
 *   网络.LX / 网络.MF / 本地 / 电台
 * 落雪（LX）与 MusicFree（MF）分别带自己的前缀，便于一眼区分是否串台。
 * STRM 本质是本地文件，归到「本地」一类（第二行再标 STRM）。
 */
function getSourceTypeLine(music) {
    if (!music) return '';
    if (isStrmSong(music)) return '本地';
    if (music.platform === 'local' || music.plugin === 'local' || !!music.filePath || music.isLocalMatch) return '本地';
    if (music.isLive || music.plugin === 'radio' || music.platform === 'radio') return '电台';
    if (typeof isLxPlugin === 'function' && isLxPlugin(music.plugin || music.platform)) {
        return '网络-LX';
    }
    return '网络-MF';
}

/**
 * 播放器来源「第二行」：实际来源名，统一为「音源别名-插件名」。
 *   本地 / STRM → STRM；电台 → 留空（第一行已标「电台」）
 */
function getSourceNameLine(music) {
    if (!music) return '';
    if (isStrmSong(music)) return 'STRM';
    if (music.platform === 'local' || music.plugin === 'local' || !!music.filePath || music.isLocalMatch) return 'STRM';
    if (music.isLive || music.plugin === 'radio' || music.platform === 'radio') return ''; // 电台第二行留空
    if (typeof isLxPlugin === 'function' && isLxPlugin(music.plugin || music.platform)) {
        return getMusicSourceLabel(music);
    }
    const pf = (typeof getPluginForMusic === 'function') ? getPluginForMusic(music, 'play') : '';
    return getMusicSourceLabel({ ...music, plugin: pf || music.plugin || music.platform });
}

/**
 * 播放器单行来源文本：统一为「音源别名-插件名」；本地 / STRM / 电台保留各自文案。
 */
function getSourceLineText(music) {
    if (!music) return '';
    if (isStrmSong(music)) return 'STRM';
    if (music.platform === 'local' || music.plugin === 'local' || !!music.filePath || music.isLocalMatch) return '本地';
    if (music.isLive || music.plugin === 'radio' || music.platform === 'radio') return '电台';
    return getMusicSourceLabel(music);
}

/**
 * 判断是否为 strm 歌曲（本地文本直链）：优先用 isStrm 标志，
 * 部分来源（如 OpenSubsonic getSong）不带该标志但带 realMediaUri，同样视为 strm。
 */
function isStrmSong(music) {
    if (!music) return false;
    if (music.isStrm) return true;
    return !!(music.realMediaUri && (music.plugin === 'local' || music.platform === 'local'));
}

/**
 * 根据歌曲信息获取来源类型：STRM / 本地 / 电台 / 网络
 */
function getSourceType(music) {
    if (!music) return '';
    // strm 本质是本地文件：来源类型按「本地」展示（顶部），播放方式由下方插件名（STRM）标识
    if (isStrmSong(music)) return '本地';
    if (music.platform === 'local' || music.plugin === 'local' || !!music.filePath || music.isLocalMatch) return '本地';
    if (music.isLive || music.plugin === 'radio' || music.platform === 'radio') return '电台';
    return '网络';
}

/**
 * 加载榜单详情状态
 */
function loadTopListDetailState() {
    const saved = localStorage.getItem('currentTopListDetail');
    if (saved) {
        try {
            return JSON.parse(saved);
        } catch (e) {
            return null;
        }
    }
    return null;
}

/**
 * 保存榜单详情状态
 */
function saveTopListDetailState(id, title) {
    if (id && title) {
        localStorage.setItem('currentTopListDetail', JSON.stringify({ id, title }));
    } else {
        localStorage.removeItem('currentTopListDetail');
    }
}

// ==================== 进度控制 ====================

function updateProgress() {
    const player = document.getElementById('audio-player');
    if (!player || !player.duration) return;

    const percent = (player.currentTime / player.duration) * 100;
    const progressFill = document.getElementById('progress-fill');
    if (progressFill) {
        progressFill.style.width = percent + '%';
    }

    const timeCurrent = document.getElementById('time-current');
    const timeTotal = document.getElementById('time-total');
    if (timeCurrent) timeCurrent.textContent = formatDuration(player.currentTime);
    if (timeTotal) timeTotal.textContent = formatDuration(player.duration);
}

function seekMusic(event) {
    const player = document.getElementById('audio-player');
    if (!player || !player.duration) return;

    const progressBar = document.getElementById('player-progress-bar');
    // 使用 requestAnimationFrame 避免强制重排
    requestAnimationFrame(() => {
        const rect = progressBar.getBoundingClientRect();
        const percent = (event.clientX - rect.left) / rect.width;
        player.currentTime = percent * player.duration;
    });
}

// ==================== 播放列表操作 ====================

/**
 * 添加歌曲到播放列表（当前播放队列）
 * @param {Array} songs - 要添加的歌曲数组
 */
async function addToPlaylist(songs) {
    if (!songs || songs.length === 0) return;

    // 确保 currentPlaylist 存在
    if (!window.currentPlaylist) {
        window.currentPlaylist = [];
    }

    // 添加歌曲到播放列表（去重）
    const newSongs = [];
    songs.forEach(song => {
        // 检查是否已存在
        const exists = window.currentPlaylist.some(s => s.id === song.id && s.plugin === song.plugin);
        if (!exists) {
            window.currentPlaylist.push(song);
            newSongs.push(song);
        }
    });

    // 刷新播放列表UI（如果播放列表面板是打开状态）
    refreshPlaylistUI();

    // 同步到后端（异步，不阻塞UI）
    if (typeof PlayQueueAPI !== 'undefined' && newSongs.length > 0) {
        // 使用 Promise.all 并行添加，不阻塞 UI
        Promise.all(newSongs.map(song => 
            PlayQueueAPI.add(song, song.plugin || song.platform)
        )).catch(() => {});
    }
}

/**
 * 刷新播放列表UI
 */
function refreshPlaylistUI() {
    // 刷新播放器详情页的播放列表
    if (typeof PlayerDetail !== 'undefined' && PlayerDetail.renderPlaylist) {
        PlayerDetail.renderPlaylist();
    }
    // 刷新内容区的播放列表面板
    if (typeof PlayerModule !== 'undefined' && PlayerModule.renderContentPlaylist) {
        PlayerModule.renderContentPlaylist();
    }
}

function playSelectedSongs() {
    const selected = MusicTable.getSelectedSongs();

    // 如果没有选择歌曲，播放所有歌曲
    if (selected.length === 0) {
        const allSongs = getCurrentPageMusicList();
        if (!allSongs || allSongs.length === 0) {
            showToast('没有可播放的歌曲', 'warning');
            return;
        }
        window.currentPlaylist = [...allSongs];
        playMusic(0);
        showToast(`开始播放全部 ${allSongs.length} 首歌曲`);
        return;
    }

    window.currentPlaylist = selected;
    playMusic(0);
}

function addSelectedToPlaylist() {
    const selected = MusicTable.getSelectedSongs();

    // 如果没有选择歌曲，添加所有歌曲到播放列表
    if (selected.length === 0) {
        const allSongs = getCurrentPageMusicList();
        if (!allSongs || allSongs.length === 0) {
            showToast('没有可添加的歌曲', 'warning');
            return;
        }
        addToPlaylist(allSongs);
        showToast(`已添加全部 ${allSongs.length} 首歌曲到播放列表`);
        return;
    }

    addToPlaylist(selected);
    showToast(`已添加 ${selected.length} 首歌曲到播放列表`);
}

async function downloadSelectedSongs() {
    const selected = MusicTable.getSelectedSongs();

    // 如果没有选择歌曲，下载所有歌曲
    if (selected.length === 0) {
        const allSongs = getCurrentPageMusicList();
        if (!allSongs || allSongs.length === 0) {
            showToast('没有可下载的歌曲', 'warning');
            return;
        }
        if (window.DownloadCore && typeof window.DownloadCore.downloadBatch === 'function') {
            const downloadParams = allSongs.map(music => ({
                id: music.id,
                title: music.title,
                artist: music.artist,
                plugin: music.platform || music.plugin || 'default',
                quality: 'standard',
                ...music
            }));
            await window.DownloadCore.downloadBatch(downloadParams, { delay: 500 }, '播放器-批量下载');
        } else if (window.DownloadCore) {
            allSongs.forEach((music, index) => {
                setTimeout(() => {
                    window.DownloadCore.startBackendDownload(music, '播放器-下载');
                }, index * 500);
            });
        }
        showToast(`已开始下载全部 ${allSongs.length} 首歌曲`);
        return;
    }

    if (window.DownloadCore && typeof window.DownloadCore.downloadBatch === 'function') {
        const downloadParams = selected.map(music => ({
            id: music.id,
            title: music.title,
            artist: music.artist,
            plugin: music.platform || music.plugin || 'default',
            quality: 'standard',
            ...music
        }));
        await window.DownloadCore.downloadBatch(downloadParams, { delay: 500 }, '播放器-批量下载');
    } else if (window.DownloadCore) {
        selected.forEach((music, index) => {
            setTimeout(() => {
                window.DownloadCore.startBackendDownload(music, '播放器-下载');
            }, index * 500);
        });
    }
    showToast(`已开始下载 ${selected.length} 首歌曲`);

    showToast(`已添加 ${selected.length} 首歌曲到下载队列`, 'success');
}

// ==================== 播放器控制 ====================

function stopAndCloseDetail() {
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
    if (typeof PlayerModule !== 'undefined') {
        PlayerModule.updateExternalPlayButton(false);
        if (typeof PlayerModule.updateExternalPlayerInfo === 'function') PlayerModule.updateExternalPlayerInfo();
    }
    updatePlayingRow();
}

function toggleShuffleMode() {
    window.isShuffleMode = !window.isShuffleMode;
    const btn = document.getElementById('player-shuffle-btn');
    if (btn) {
        btn.classList.toggle('active', window.isShuffleMode);
    }
    showToast(window.isShuffleMode ? '随机播放已开启' : '随机播放已关闭', 'info');
}

/**
 * 开启随机播放模式（详情页点「随机」时调用）：
 * 同步播放器/播放详情页的随机按钮高亮状态（已开启则静默跳过）
 */
function enableShuffleMode() {
    if (window.isShuffleMode) return;
    window.isShuffleMode = true;
    window.shuffleMode = true;
    const detailBtn = document.getElementById('detail-shuffle-btn');
    if (detailBtn) detailBtn.classList.add('active');
    const playerBtn = document.getElementById('player-shuffle-btn');
    if (playerBtn) playerBtn.classList.add('active');
    const moreShuffle = document.getElementById('more-btn-shuffle');
    if (moreShuffle) moreShuffle.style.color = 'var(--primary-color)';
}
window.enableShuffleMode = enableShuffleMode;

/**
 * 关闭随机播放模式（详情页点「播放」时调用，与 enableShuffleMode 对称）：
 * 关闭随机并同步播放器 / 播放详情页的随机按钮高亮；
 * 关闭后播放器上一首/下一首走列表原顺序（顺序播放），并丢弃随机顺序副本。
 */
function disableShuffleMode() {
    window.isShuffleMode = false;
    window.shuffleMode = false;
    window.shuffledPlaylist = null;
    const detailBtn = document.getElementById('detail-shuffle-btn');
    if (detailBtn) detailBtn.classList.remove('active');
    const playerBtn = document.getElementById('player-shuffle-btn');
    if (playerBtn) playerBtn.classList.remove('active');
    const moreShuffle = document.getElementById('more-btn-shuffle');
    if (moreShuffle) moreShuffle.style.color = 'var(--text-color)';
}
window.disableShuffleMode = disableShuffleMode;

function toggleRepeatMode() {
    const modes = ['off', 'list', 'single'];
    const currentIndex = modes.indexOf(window.repeatMode || 'off');
    const nextIndex = (currentIndex + 1) % modes.length;
    window.repeatMode = modes[nextIndex];

    const modeNames = { off: '关闭循环', list: '列表循环', single: '单曲循环' };
    showToast(modeNames[window.repeatMode], 'info');

    // 更新循环按钮视觉状态和图标
    updateRepeatButtonIcon();
}

/**
 * 更新循环按钮图标
 */
function updateRepeatButtonIcon() {
    // 循环模式图标 SVG
    const repeatIcons = {
        off: '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>',
        list: '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>',
        single: '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="12" y="16" font-size="9" font-weight="bold" text-anchor="middle" fill="currentColor">1</text>'
    };

    const modeNames = { off: '关闭循环', list: '列表循环', single: '单曲循环' };
    const currentMode = window.repeatMode || 'off';

    // 更新底部播放器循环按钮
    const playerBtn = document.getElementById('player-repeat-btn');
    if (playerBtn) {
        playerBtn.classList.toggle('active', currentMode !== 'off');
        playerBtn.title = modeNames[currentMode];
        const svg = playerBtn.querySelector('svg');
        if (svg) {
            svg.innerHTML = repeatIcons[currentMode];
        }
    }

    // 更新播放详情页循环按钮
    const detailBtn = document.getElementById('detail-repeat-btn');
    if (detailBtn) {
        detailBtn.classList.toggle('active', currentMode !== 'off');
        detailBtn.title = modeNames[currentMode];
        const svg = detailBtn.querySelector('svg');
        if (svg) {
            svg.innerHTML = repeatIcons[currentMode];
        }
    }
}

function toggleLike() {
    if (!window.currentMusic) {
        showToast('没有正在播放的歌曲', 'warning');
        return;
    }

    if (typeof toggleFavoriteSong === 'function') {
        toggleFavoriteSong(window.currentMusic).then(isFav => {
            // 更新全局状态
            window.isCurrentMusicLiked = isFav;
            window.currentMusic._isLiked = isFav;

            // 更新播放器按钮状态
            const btn = document.getElementById('player-like-btn');
            if (btn) {
                btn.classList.toggle('active', isFav);
                btn.style.color = isFav ? '#ff4757' : '';
            }

            // toggleFavoriteSong 已经会触发 emitFavoriteChange 事件
            // 其他页面会自动收到通知并更新
            showToast(isFav ? '已添加到收藏' : '已取消收藏', 'success');
        });
    }
}

async function downloadCurrentMusic() {
    if (!window.currentMusic) {
        showToast('没有正在播放的歌曲', 'warning');
        return;
    }

    const plugin = window.currentMusic.platform || window.currentMusic.plugin;
    if (!plugin) {
        showToast('无法确定歌曲来源', 'error');
        return;
    }

    // 实时查询数据库检查是否已下载
    try {
        if (window.StateManager?.isDownloaded) {
            const isDownloaded = await window.StateManager.isDownloaded(window.currentMusic.id, plugin);
            if (isDownloaded) {
                // 已下载，显示确认弹窗
                showReDownloadConfirm(window.currentMusic);
                return;
            }
        }
    } catch (e) {
        console.error('检查下载状态失败:', e);
    }

    if (window.DownloadCore) {
        await window.DownloadCore.startBackendDownload(window.currentMusic, '播放器-下载');
    }
}

/**
 * 显示重新下载确认弹窗
 * @param {Object} song - 歌曲对象
 */
function showReDownloadConfirm(song) {
    if (typeof showConfirmModal === 'function') {
        showConfirmModal({
            title: '重新下载',
            message: `「${song.title}」已下载，需要重新下载吗？`,
            confirmText: '重新下载',
            cancelText: '取消',
            onConfirm: () => {
                reDownloadSong(song);
            }
        });
    } else if (confirm(`「${song.title}」已下载，需要重新下载吗？`)) {
        reDownloadSong(song);
    }
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
                source: 'player-retry',
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
        showToast(`重新下载失败: ${error.message}`, 'error');
    }
}

/**
 * 更新播放器下载按钮状态
 * @param {string} status - 'normal' | 'downloading' | 'downloaded'
 */
function updatePlayerDownloadButton(status) {
    // 同时更新桌面版和移动版按钮
    const desktopBtn = document.getElementById('player-download-btn-desktop');
    const mobileBtn = document.getElementById('player-download-btn-mobile');
    const buttons = [desktopBtn, mobileBtn].filter(Boolean);
    
    buttons.forEach(btn => {
        // 移除所有状态类
        btn.classList.remove('downloading', 'downloaded');

        switch (status) {
            case 'downloading':
                btn.classList.add('downloading');
                btn.title = '下载中...';
                break;
            case 'downloaded':
                btn.classList.add('downloaded');
                btn.title = '已下载';
                break;
            default:
                btn.title = '下载';
        }
    });
}

/**
 * 根据当前歌曲更新播放器下载按钮状态
 */
function updatePlayerDownloadButtonState() {
    if (!window.currentMusic || !window.DownloadCore) return;

    const music = window.currentMusic;
    const plugin = music.platform || music.plugin;
    if (!plugin) return;

    // 更新按钮的 data 属性
    const desktopBtn = document.getElementById('player-download-btn-desktop');
    const mobileBtn = document.getElementById('player-download-btn-mobile');
    [desktopBtn, mobileBtn].forEach(btn => {
        if (btn) {
            btn.setAttribute('data-music-id', String(music.id));
            btn.setAttribute('data-platform', plugin);
        }
    });

    const key = `${music.id}_${plugin}`;
    if (window.DownloadCore.downloadedCache && window.DownloadCore.downloadedCache.has(key)) {
        updatePlayerDownloadButton('downloaded');
    } else if (window.DownloadCore.downloadingCache && window.DownloadCore.downloadingCache.has(key)) {
        updatePlayerDownloadButton('downloading');
    } else {
        updatePlayerDownloadButton('normal');
    }
}

function togglePlayerMute() {
    if (typeof PlayerModule !== 'undefined') {
        PlayerModule.toggleMute();
    }
}

function toggleContentPlaylist() {
    // 使用 PlayerModule 的方法
    if (typeof PlayerModule !== 'undefined' && PlayerModule.toggleContentPlaylist) {
        PlayerModule.toggleContentPlaylist();
    } else {
        // 降级方案
        const panel = document.getElementById('content-playlist-panel');
        if (panel) {
            panel.classList.toggle('open');
        }
    }
}

// ==================== 音质选择弹窗 ====================

let qualityDropdownTarget = null;

function openQualityDropdown(targetBtn) {
    const dropdown = document.getElementById('quality-dropdown');
    if (!dropdown || !targetBtn) return;

    // 如果弹窗已显示且是同一个按钮触发的，则关闭弹窗
    if (dropdown.style.display === 'block' && qualityDropdownTarget === targetBtn) {
        closeQualityDropdown();
        return;
    }

    // 先关闭之前的弹窗
    closeQualityDropdown();

    qualityDropdownTarget = targetBtn;

    const rect = targetBtn.getBoundingClientRect();
    const dropdownWidth = 180;
    const dropdownHeight = 192;

    let left = rect.right - dropdownWidth;
    left = Math.max(8, Math.min(left, window.innerWidth - dropdownWidth - 8));

    const gap = 12;
    const top = rect.top - dropdownHeight - gap;

    dropdown.style.top = top + 'px';
    dropdown.style.left = left + 'px';
    dropdown.style.display = 'block';

    updateQualityDropdownUI();

    // 使用 capture 阶段监听点击事件，确保能捕获所有点击
    setTimeout(() => {
        document.addEventListener('click', closeQualityDropdownOnClickOutside, true);
    }, 0);
}

function closeQualityDropdown() {
    const dropdown = document.getElementById('quality-dropdown');
    if (dropdown) {
        dropdown.style.display = 'none';
    }
    document.removeEventListener('click', closeQualityDropdownOnClickOutside, true);
    qualityDropdownTarget = null;
}

function closeQualityDropdownOnClickOutside(e) {
    const dropdown = document.getElementById('quality-dropdown');
    if (!dropdown) return;

    // 如果点击的是弹窗内部，不处理
    if (dropdown.contains(e.target)) return;

    // 如果点击的是触发按钮，不处理（由按钮的 onclick 处理）
    if (qualityDropdownTarget && qualityDropdownTarget.contains(e.target)) return;

    // 其他情况关闭弹窗
    closeQualityDropdown();
}

function updateQualityDropdownUI() {
    const dropdown = document.getElementById('quality-dropdown');
    if (!dropdown) return;

    const currentQuality = window.currentQuality || 'standard';
    const items = dropdown.querySelectorAll('.quality-item');

    items.forEach(item => {
        const quality = item.dataset.quality;
        if (quality === currentQuality) {
            item.classList.add('selected');
        } else {
            item.classList.remove('selected');
        }
    });
}

async function selectQuality(quality) {
    const config = window.QUALITY_CONFIG || {};
    if (!config[quality]) return;

    const prevQuality = window.currentQuality || 'standard';
    if (prevQuality === quality) {
        closeQualityDropdown();
        return;
    }

    window.currentQuality = quality;
    localStorage.setItem('playerQuality', quality);

    if (window.currentMusic && typeof PlayerModule !== 'undefined' && PlayerModule.saveSongQuality) {
        window.currentMusic.quality = quality;
        PlayerModule.saveSongQuality(window.currentMusic, quality);
    }

    if (typeof PlayerModule !== 'undefined' && PlayerModule.updateQualityButton) {
        PlayerModule.updateQualityButton(quality);
    }

    if (window.showToast) {
        showToast(`音质: ${config[quality].name}，正在重新加载...`, 'info');
    }

    closeQualityDropdown();

    if (window.currentMusic && typeof PlayerModule !== 'undefined') {
        const player = document.getElementById('audio-player');
        const currentTime = player ? player.currentTime : 0;
        const wasPlaying = window.isPlaying;

        if (typeof Resolver !== 'undefined' && Resolver.clearCache) {
            const pluginName = window.currentMusic.plugin || window.currentMusic.platform;
            const cacheKey = Resolver.getCacheKey?.(String(window.currentMusic.id), pluginName, prevQuality);
            if (cacheKey) Resolver.clearCache(cacheKey);
        }

        try {
            await PlayerModule.load(window.currentMusic, wasPlaying);

            if (player && currentTime > 0) {
                player.currentTime = currentTime;
            }

            if (window.showToast) {
                showToast(`已切换至${config[quality].name}`, 'success');
            }
        } catch (err) {
            if (window.showToast) {
                showToast('音质切换失败，请重试', 'error');
            }
        }
    }
}

function initQualityDropdown() {
    const dropdown = document.getElementById('quality-dropdown');
    if (!dropdown) return;

    dropdown.querySelectorAll('.quality-item').forEach(item => {
        item.addEventListener('click', function() {
            const quality = this.dataset.quality;
            selectQuality(quality);
        });
    });
}

/**
 * 更新管理员菜单可见性
 * 根据用户角色显示/隐藏管理员专属菜单
 */
function updateAdminMenuVisibility() {
    const isAdmin = window.Auth && window.Auth.isAdmin();
    const adminOnlyElements = document.querySelectorAll('.admin-only');

    adminOnlyElements.forEach(el => {
        el.style.display = isAdmin ? '' : 'none';
    });
}

// 初始化
document.addEventListener('DOMContentLoaded', initQualityDropdown);

// ==================== 导出全局函数 ====================

window.switchPage = switchPage;
window.playMusic = playMusic;
window.getPluginForMusic = getPluginForMusic;
window.getMusicSourceText = getMusicSourceText;
window.getMusicSourceLabel = getMusicSourceLabel;
window.getSourceLineText = getSourceLineText;
window.getSourceTypeLine = getSourceTypeLine;
window.getSourceNameLine = getSourceNameLine;
window.getDisplaySource = getDisplaySource;
window.getSourceType = getSourceType;
window.updateProgress = updateProgress;
window.seekMusic = seekMusic;
window.handlePlaybackEnded = () => {
    if (typeof PlayerModule !== 'undefined') {
        PlayerModule.handlePlaybackEnded();
    }
};
window.playSelectedSongs = playSelectedSongs;
window.addSelectedToPlaylist = addSelectedToPlaylist;
window.downloadSelectedSongs = downloadSelectedSongs;
window.stopAndCloseDetail = stopAndCloseDetail;
window.toggleShuffleMode = toggleShuffleMode;
window.toggleRepeatMode = toggleRepeatMode;
window.updateRepeatButtonIcon = updateRepeatButtonIcon;
window.toggleLike = toggleLike;
window.downloadCurrentMusic = downloadCurrentMusic;
window.togglePlayerMute = togglePlayerMute;
window.toggleContentPlaylist = toggleContentPlaylist;
window.openQualityDropdown = openQualityDropdown;
window.closeQualityDropdown = closeQualityDropdown;
window.selectQuality = selectQuality;
window.getCurrentPageMusicList = getCurrentPageMusicList;
window.setCurrentPageMusicList = setCurrentPageMusicList;
window.loadTopListDetailState = loadTopListDetailState;
window.saveTopListDetailState = saveTopListDetailState;
window.updatePlayerDownloadButton = updatePlayerDownloadButton;
window.updatePlayerDownloadButtonState = updatePlayerDownloadButtonState;
window.refreshPlaylistUI = refreshPlaylistUI;

// ==================== 移动端侧边栏控制 ====================

/**
 * 切换移动端侧边栏显示状态
 */
function toggleMobileSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    if (sidebar && overlay) {
        const isOpen = sidebar.classList.contains('mobile-open');
        if (isOpen) {
            closeMobileSidebar();
        } else {
            openMobileSidebar();
        }
    }
}

/**
 * 打开移动端侧边栏
 */
function openMobileSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    if (sidebar && overlay) {
        sidebar.classList.add('mobile-open');
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

/**
 * 关闭移动端侧边栏
 */
function closeMobileSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    if (sidebar && overlay) {
        sidebar.classList.remove('mobile-open');
        overlay.classList.remove('active');
        document.body.style.overflow = '';
    }
}

// 导出移动端侧边栏控制函数到全局
window.toggleMobileSidebar = toggleMobileSidebar;
window.openMobileSidebar = openMobileSidebar;
window.closeMobileSidebar = closeMobileSidebar;

// ==================== 移动端手势支持 ====================

(function initMobileGestures() {
    // 检测是否为触摸设备
    const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
    if (!isTouchDevice) return;

    // 左右滑动（开关侧边栏 / 关闭播放列表）已按需求移除：移动端不再响应左右滑动手势。
    // 侧边栏仍可通过汉堡按钮打开、点击遮罩关闭；播放列表用其自身关闭按钮。



    // 双击顶部返回顶部
    let lastTapTime = 0;
    const header = document.querySelector('.header');
    if (header) {
        header.addEventListener('touchend', (e) => {
            const currentTime = new Date().getTime();
            const tapLength = currentTime - lastTapTime;

            if (tapLength < 300 && tapLength > 0) {
                // 双击标题栏返回顶部
                const contentArea = document.querySelector('.content-area');
                if (contentArea) {
                    contentArea.scrollTo({ top: 0, behavior: 'smooth' });
                }
                e.preventDefault();
            }

            lastTapTime = currentTime;
        });
    }

    // 长按显示操作菜单（可以扩展）
    let longPressTimer;

    document.addEventListener('touchstart', (e) => {
        const target = e.target.closest('.music-row, .playlist-item, .content-playlist-item');
        if (target) {
            longPressTimer = setTimeout(() => {
                // 触发震动反馈（如果支持）
                if (navigator.vibrate) {
                    navigator.vibrate(50);
                }
                // 可以在这里添加长按菜单逻辑
                target.classList.add('long-press');
                setTimeout(() => target.classList.remove('long-press'), 300);
            }, 500);
        }
    }, { passive: true });

    document.addEventListener('touchend', () => {
        clearTimeout(longPressTimer);
    }, { passive: true });

    document.addEventListener('touchmove', () => {
        clearTimeout(longPressTimer);
    }, { passive: true });

    // ==================== 移动端播放器进度条拖动功能 ====================
    (function initMobileProgressDrag() {
        const progressBar = document.getElementById('player-progress-bar');
        if (!progressBar) return;

        let isDragging = false;
        let progressRect = null;
        const player = document.getElementById('audio-player');

        function seekToPosition(clientX) {
            if (!player || !player.duration) return;
            // 缓存 rect 避免拖拽过程中重复计算
            if (!progressRect) {
                progressRect = progressBar.getBoundingClientRect();
            }
            const percent = Math.max(0, Math.min(1, (clientX - progressRect.left) / progressRect.width));
            player.currentTime = percent * player.duration;
        }

        // 鼠标事件
        progressBar.addEventListener('mousedown', (e) => {
            isDragging = true;
            progressRect = progressBar.getBoundingClientRect(); // 开始拖拽时缓存位置
            seekToPosition(e.clientX);
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                seekToPosition(e.clientX);
            }
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
            progressRect = null; // 清除缓存
        });

        // 触摸事件
        progressBar.addEventListener('touchstart', (e) => {
            isDragging = true;
            progressRect = progressBar.getBoundingClientRect(); // 开始拖拽时缓存位置
            seekToPosition(e.touches[0].clientX);
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (isDragging) {
                seekToPosition(e.touches[0].clientX);
            }
        }, { passive: true });

        document.addEventListener('touchend', () => {
            isDragging = false;
            progressRect = null; // 清除缓存
        }, { passive: true });
    })();

    // ==================== 移动端下拉刷新 ====================
    (function initPullToRefresh() {
        const container = document.getElementById('page-container');
        if (!container) return;

        // 刷新指示器（固定定位在内容区顶部，跟随下拉距离显示）
        const indicator = document.createElement('div');
        indicator.className = 'ptr-indicator';
        indicator.innerHTML = '<div class="ptr-spinner"></div><span class="ptr-text">下拉刷新</span>';
        document.body.appendChild(indicator);
        indicator.style.display = 'none';

        const THRESHOLD = 60;   // 触发刷新所需下拉距离(px)
        const MAX_PULL = 90;     // 视觉最大下拉距离(px)
        const DEAD_ZONE = 10;    // 方向判定死区(px)，小于此位移不锁定方向
        let startX = 0;
        let startY = 0;
        let pulling = false;
        let axisLocked = null;   // 主导方向锁定：'v'(竖直) / 'h'(水平) / null(未定)
        let refreshing = false;

        function isExcluded(target) {
            return !!(target.closest &&
                target.closest('input, textarea, [contenteditable="true"], .detail-progress-bar, .player-progress-bar, [data-td-index]'));
        }

        // 找到触摸点所在的可滚动容器；只有在其顶部(scrollTop<=0)才允许下拉刷新
        function getScrollEl(target) {
            let el = target;
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                const scrollable = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
                if (scrollable) return el;
                el = el.parentElement;
            }
            return container;
        }

        container.addEventListener('touchstart', (e) => {
            if (refreshing || isExcluded(e.target)) return;
            const scEl = getScrollEl(e.target);
            if (scEl.scrollTop > 0) { pulling = false; return; }
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            pulling = true;
            axisLocked = null;
        }, { passive: true });

        container.addEventListener('touchmove', (e) => {
            // 电台等页面正在进行触摸长按拖动排序：立即放弃下拉刷新，避免两套手势抢事件导致界面卡死
            if (window.__radioTdDragging) { pulling = false; indicator.style.display = 'none'; return; }
            if (!pulling || refreshing) return;
            const deltaX = e.touches[0].clientX - startX;
            const deltaY = e.touches[0].clientY - startY;

            // 先判定主导方向，避免左右滑动误触发下拉刷新
            if (!axisLocked) {
                if (Math.abs(deltaX) < DEAD_ZONE && Math.abs(deltaY) < DEAD_ZONE) return; // 死区内，等待明确方向
                axisLocked = Math.abs(deltaY) > Math.abs(deltaX) ? 'v' : 'h';
            }
            // 水平方向占主导：放弃下拉刷新，交还浏览器默认行为（如横向滚动）
            if (axisLocked === 'h') {
                pulling = false;
                indicator.style.display = 'none';
                return;
            }
            // 仅竖直向下才继续
            if (deltaY <= 0) {
                indicator.style.display = 'none';
                return;
            }
            // 非 passive：在顶部下拉时阻止原生 overscroll，使下拉更顺滑
            if (e.cancelable) e.preventDefault();
            const pull = Math.min(deltaY * 0.5, MAX_PULL);
            indicator.style.display = 'flex';
            indicator.style.transform = `translate(-50%, ${pull - 40}px)`;
            const ready = pull >= THRESHOLD;
            indicator.classList.toggle('ready', ready);
            indicator.querySelector('.ptr-text').textContent = ready ? '释放刷新' : '下拉刷新';
        }, { passive: false });

        container.addEventListener('touchend', () => {
            if (!pulling || refreshing) { pulling = false; return; }
            pulling = false;
            if (indicator.classList.contains('ready')) {
                refreshing = true;
                indicator.classList.add('refreshing');
                indicator.querySelector('.ptr-text').textContent = '刷新中…';
                indicator.style.transform = 'translate(-50%, 10px)';
                const page = window.currentPage;
                Promise.resolve(page ? switchPage(page) : null)
                    .catch(() => {})
                    .finally(() => {
                        // 留出动画时间后复位
                        setTimeout(() => {
                            refreshing = false;
                            indicator.classList.remove('refreshing', 'ready');
                            indicator.style.display = 'none';
                        }, 400);
                    });
            } else {
                indicator.style.display = 'none';
            }
        }, { passive: true });
    })();

})();
