/**
 * 洛雪（LX）专区前端模块
 * ================================================================
 * 一期：浏览 LX 排行榜 / LX 热门歌单（数据来自后端移植的落雪内置音源 SDK +
 *       各平台官方榜单分类）。
 *
 * 详情页（榜单 / 歌单）与 MF 侧**同款**：全局页头返回 + Hero + 同款列/按钮/收藏/行菜单。
 * 播放解析在二期接入（需先在「系统设置 → LX 音源」导入音源），故播放/下载暂给提示；
 * 收藏、加入歌单已可用（仅涉及数据存储）。
 *
 * 歌曲统一带 plugin = `lx:<平台>` 标记，与 MF 插件区分。
 */

const LxModule = {
    platforms: [],
    toplist: {
        platform: '', boards: [], groups: [], currentId: '', songs: [], total: 0, detail: null,
        searchQuery: '', searchSongs: null, searchPage: 1,
    },
    recommend: {
        platform: '', tags: [], hotTag: [], sortList: [],
        currentTagId: '', sheets: [],
        detail: null, songs: [],
        searchQuery: '', page: 1, isEnd: false, loading: false, mode: 'tag',
    }
};

const LX_PLATFORM_KEY = 'mh_lx_platform';

function lxSavedPlatform() {
    try { return localStorage.getItem(LX_PLATFORM_KEY) || ''; } catch { return ''; }
}
function lxSetPlatform(p) {
    try { localStorage.setItem(LX_PLATFORM_KEY, p); } catch { /* ignore */ }
    LxModule.toplist.platform = p;
    LxModule.recommend.platform = p;
}

async function lxEnsurePlatforms() {
    if (LxModule.platforms.length) return LxModule.platforms;
    try {
        const r = await API.lx.getPlatforms();
        LxModule.platforms = (r && r.data) || [];
    } catch { LxModule.platforms = []; }
    return LxModule.platforms;
}

function lxLoadingHtml() {
    return '<div class="loading" style="padding:40px;text-align:center;"><div class="spinner"></div></div>';
}
function lxErrorHtml(msg) {
    return `<div class="empty-state" style="padding:40px;text-align:center;color:var(--text-secondary);">加载失败：${escapeHtml(String(msg || '未知错误'))}</div>`;
}

/** 页面标题 */
function lxPageTitle(pageKey) {
    return (typeof pageTitles !== 'undefined' && pageTitles[pageKey]) || 'LX';
}

/** 详情页：全局页头渲染「返回 + 标题」（与 MF 详情一致） */
function lxSetDetailHeader(title, onBack) {
    if (typeof PluginTabs === 'undefined' || typeof PluginTabs.renderWithBack !== 'function') return;
    PluginTabs.renderWithBack({ title, onBack });
    // 标题居中：把返回按钮移出标题容器（与 MF 一致）
    const hl = document.getElementById('header-left');
    const titleEl = hl && hl.querySelector('.header-title');
    const backBtn = hl && hl.querySelector('#back-btn');
    if (hl && titleEl && backBtn) {
        hl.insertBefore(backBtn, titleEl);
        titleEl.classList.add('playlist-detail-title');
    }
}

/** 返回列表时恢复默认页头（菜单按钮 + 页面标题 + 搜索框，与 MF 排行榜/热门歌单同款） */
function lxRestoreHeader(pageKey) {
    const hl = document.getElementById('header-left');
    if (!hl) return;
    const isToplist = pageKey === 'lx-toplist';
    const searchIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
    const searchWrap = isToplist
        ? `<div class="toplist-header-search" style="display: flex; gap: 8px; align-items: center; margin-left: 16px; flex: 1; max-width: 500px;">
                <div style="position: relative; flex: 1; min-width: 100px;">
                    <input type="text" id="lx-toplist-search-input" class="search-input" placeholder="搜索歌曲..." value="${escapeHtml(LxModule.toplist.searchQuery || '')}" style="padding-left: 12px; width: 100%; height: 32px; border-radius: var(--radius-lg); border: 1px solid var(--border-color); background: var(--surface-color); color: var(--text-color); font-size: 12px; outline: none;" onkeypress="if(event.key==='Enter')lxToplistSearch()">
                </div>
                <button class="header-icon-btn" onclick="handleHeaderSearchClick('lx-toplist-search-input','lx-toplist')" title="搜索">${searchIcon}</button>
            </div>`
        : `<div class="recommend-header-search" style="display: flex; gap: 8px; align-items: center; margin-left: 16px; flex: 1; max-width: 500px;">
                <div style="position: relative; flex: 1; min-width: 100px;">
                    <input type="text" id="lx-recommend-sheet-search-input" class="search-input" placeholder="搜索歌单..." value="${escapeHtml(LxModule.recommend.searchQuery || '')}" style="padding-left: 12px; width: 100%; height: 32px; border-radius: var(--radius-lg); border: 1px solid var(--border-color); background: var(--surface-color); color: var(--text-color); font-size: 12px; outline: none;" onkeypress="if(event.key==='Enter')lxRecommendSearchSheets()">
                </div>
                <button class="header-icon-btn" onclick="handleHeaderSearchClick('lx-recommend-sheet-search-input','lx-recommend')" title="搜索">${searchIcon}</button>
            </div>`;
    hl.innerHTML = `
        <button class="mobile-menu-btn" onclick="toggleMobileSidebar()" aria-label="打开菜单">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
        </button>
        <div class="header-title" id="page-title">${escapeHtml(lxPageTitle(pageKey))}</div>
        ${searchWrap}`;
}

/** 平台选择标签（与 MF 排行榜插件标签同款 class：移动端横向滚动、隐藏滚动条） */
function lxPlatformTabsHtml(active, handlerName) {
    if (!LxModule.platforms.length) return '';
    return `<div class="plugin-tabs-wrapper">
        <div class="plugin-tabs">
            ${LxModule.platforms.map((p) => `
                <button type="button" class="plugin-tab ${p.id === active ? 'active' : ''}"
                        onclick="${handlerName}('${p.id}')">${escapeHtml(p.name)}</button>`).join('')}
        </div>
    </div>`;
}

/** 榜单/歌单封面 HTML：优先官方封面，失败/缺失回退音符 */
function lxCoverHtml(pic) {
    if (!pic) return '🎵';
    return (typeof createImageWithFallback === 'function')
        ? createImageWithFallback(pic, 'cover', '')
        : `<img src="${escapeHtml(pic)}" alt="cover" onerror="this.style.display='none'">`;
}

/** 单曲封面（与 MF 同款解析逻辑） */
function lxSongCover(song) {
    const coverId = song.coverArt || song.virtualId
        || (typeof song.id === 'string' && song.id.startsWith('remote__') ? song.id : null);
    return song.artwork || song.cover || song.coverImg || song.pic || song.coverUrl || song.albumPic
        || (coverId ? `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(coverId)}` : '');
}

// ==================== 详情表格（榜单/歌单共用，与 MF 同款） ====================

/** 详情渲染上下文（管理模式下重渲染用） */
let lxDetailCtx = null;
/** 管理模式：勾选列 + 批量下载（页头「⋯」→「管理」进入，与 MF 一致） */
let lxManageMode = false;

/**
 * 渲染详情歌曲表格：Hero + 同款列/按钮/收藏/行菜单 + 懒加载
 * @param {Object} o
 * @param {string} o.pageId        SongTable 实例 id（'lx-toplist' / 'lx-recommend'）
 * @param {string} o.containerId   容器元素 id
 * @param {Array}  o.songs         全量歌曲
 * @param {string} o.cover         封面
 * @param {string} o.title         标题
 * @param {string} o.onRandom      随机播放函数调用字符串
 * @param {Function} o.onPlay      播放回调 (index)
 * @param {Function} o.onSave      保存到歌单回调
 */
function lxRenderDetailTable(o) {
    lxDetailCtx = o;
    const container = document.getElementById(o.containerId);
    if (!container) return;
    const allSongs = o.songs || [];
    if (!allSongs.length) {
        container.innerHTML = `<div class="empty-state" style="padding:40px;text-align:center;color:var(--text-secondary);">暂无歌曲</div>`;
        return;
    }
    const manage = lxManageMode;
    if (container.classList) container.classList.toggle('playlist-detail-manage', manage);
    const selCount = (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs)
        ? (SongTable.getSelectedSongs(o.pageId) || []).length : 0;
    container.innerHTML = '';
    const hasSongs = allSongs.length > 0;

    const render = (slice) => {
        SongTable.render({
            container,
            pageId: o.pageId,
            title: '',
            showHeader: false,
            songs: slice,
            hero: {
                cover: o.cover || '',
                title: o.title || '详情',
                meta: `${allSongs.length} 首歌曲`,
                onRandom: manage ? null : o.onRandom,
            },
            columns: manage
                ? ['checkbox', 'index', 'title', 'artist', 'album', 'duration', 'source', 'favorite', 'more']
                : ['index', 'title', 'artist', 'album', 'duration', 'source', 'favorite', 'more'],
            titleCover: (song) => lxSongCover(song),
            rowMenu: [
                { label: '下载', onClick: () => lxDownloadNotReady() },
            ],
            actions: manage ? [
                {
                    id: 'manage-download',
                    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
                    text: `下载${selCount ? ` (${selCount})` : ''}`,
                    primary: false,
                    disabled: !hasSongs,
                    onClick: () => lxDownloadNotReady(),
                },
                { id: 'manage-done', icon: '', text: '完成', primary: true, onClick: () => lxToggleManageMode() },
            ] : [
                {
                    id: 'play',
                    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
                    text: '播放',
                    primary: true,
                    disabled: !hasSongs,
                    onClick: () => (o.onPlay ? o.onPlay(0) : lxPlayByIndex(0)),
                },
                {
                    id: 'save-playlist',
                    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
                    text: '歌单',
                    primary: false,
                    disabled: !hasSongs,
                    onClick: () => (o.onSave ? o.onSave() : null),
                },
            ],
            events: {
                onPlay: (song, index) => (o.onPlay ? o.onPlay(index) : lxPlayByIndex(index)),
                onFavorite: (song) => lxToggleFavorite(song),
            },
        });
    };

    if (typeof SongListLazy !== 'undefined') {
        SongListLazy.register(o.pageId, allSongs, container, render, { batch: 50, initial: 60 });
    } else {
        render(allSongs);
    }
}

/** 用当前详情上下文重渲染（管理模式切换时用） */
function lxRefreshDetail() {
    if (!lxDetailCtx) return;
    lxRenderDetailTable(lxDetailCtx);
}

/** 切换管理模式：出现勾选列，Hero 显示「下载(N)/完成」（页头「⋯」→「下载」进入，Hero「完成」退出） */
function lxToggleManageMode() {
    lxManageMode = !lxManageMode;
    lxRefreshDetail();
}

// ==================== 详情页头「⋯」菜单（与 MF 同款） ====================

function lxToggleDetailMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('lx-detail-menu');
    if (!menu) return;
    const willOpen = menu.style.display !== 'block';
    menu.style.display = willOpen ? 'block' : 'none';
    if (willOpen) {
        setTimeout(() => document.addEventListener('click', lxCloseDetailMenu), 0);
    } else {
        document.removeEventListener('click', lxCloseDetailMenu);
    }
}

function lxCloseDetailMenu() {
    const menu = document.getElementById('lx-detail-menu');
    if (menu) menu.style.display = 'none';
    document.removeEventListener('click', lxCloseDetailMenu);
}

/** 页头右侧「⋯」按钮 + 下拉管理菜单（与 MF 详情页同款） */
function lxSetupDetailMenu() {
    const actions = document.getElementById('header-actions');
    if (!actions) return;
    actions.querySelectorAll('.lx-detail-more').forEach((el) => el.remove());
    const wrap = document.createElement('div');
    wrap.className = 'lx-detail-more';
    wrap.style.cssText = 'position: relative; display: flex; align-items: center;';
    wrap.innerHTML = `
        <button type="button" title="更多" onclick="event.stopPropagation(); lxToggleDetailMenu(event)"
            class="header-icon-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
        <div id="lx-detail-menu"
            style="display: none; position: absolute; right: 0; top: calc(100% + 6px); min-width: 150px; background: var(--surface-color); border: 1px solid var(--divider-color); border-radius: 10px; box-shadow: var(--shadow-lg); z-index: 1002; padding: 6px 0; overflow: hidden;">
            <button type="button" onclick="event.stopPropagation(); lxCloseDetailMenu(); lxToggleManageMode();"
                style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">下载</button>
        </div>`;
    actions.appendChild(wrap);
}

/** 清理详情页头「⋯」控件（返回列表时调用） */
function lxRemoveDetailMenu() {
    lxCloseDetailMenu();
    document.querySelectorAll('.lx-detail-more').forEach((el) => el.remove());
}

// ==================== 播放（落雪音源解析）+ 下载 + 收藏 + 保存歌单 ====================

/** 当前 LX 详情页正在展示的歌曲列表 */
function lxCurrentDetailSongs() {
    if (typeof currentPage !== 'undefined' && currentPage === 'lx-recommend') return LxModule.recommend.songs || [];
    if (typeof currentPage !== 'undefined' && currentPage === 'lx-toplist') return LxModule.toplist.songs || [];
    return (LxModule.toplist.songs && LxModule.toplist.songs.length)
        ? LxModule.toplist.songs
        : (LxModule.recommend.songs || []);
}

/**
 * 统一播放入口：补齐 plugin 标记（lx:<平台>）后交给播放器。
 * 后端 ResolverCore 识别 lx: 前缀后会走「设置 → LX 音源」导入的落雪音源解析。
 */
function lxPlayList(songs, index = 0) {
    if (!songs || !songs.length) {
        showToast('没有可播放的歌曲', 'warning');
        return;
    }
    const list = songs.map((s) => {
        const plugin = s.plugin || ('lx:' + (s.lxSource || ''));
        return { ...s, plugin, platform: s.platform || plugin };
    });
    window.currentPageMusicList = list;
    if (typeof playMusic === 'function') {
        playMusic(index);
    } else {
        showToast('播放器未就绪', 'error');
    }
}

/** 详情页：按索引播放 */
function lxPlayByIndex(index) {
    lxPlayList(lxCurrentDetailSongs(), index);
}

/** 详情页：随机播放（Hero 随机按钮） */
function lxPlayRandom() {
    const songs = lxCurrentDetailSongs();
    if (!songs.length) {
        showToast('歌单为空', 'warning');
        return;
    }
    if (typeof enableShuffleMode === 'function') enableShuffleMode();
    lxPlayList(songs, Math.floor(Math.random() * songs.length));
}

/** 搜索结果：按索引播放 */
function lxPlaySearchByIndex(index) {
    lxPlayList(LxModule.toplist.searchSongs || [], index);
}

/** 榜单卡片悬浮播放按钮：拉取榜单歌曲后直接播放 */
async function lxPlayBoardDirect(id) {
    const t = LxModule.toplist;
    const board = t.boards.find((b) => String(b.id) === String(id)) || { id, name: '榜单' };
    try {
        showToast('加载榜单…', 'info');
        const r = await API.lx.getBoardSongs(t.platform, board.bangid || id, 1);
        const list = (r.data && r.data.list) || [];
        if (!list.length) {
            showToast('榜单暂无歌曲', 'warning');
            return;
        }
        lxPlayList(list, 0);
    } catch (e) {
        showToast('播放失败: ' + (e && e.message), 'error');
    }
}

/** 歌单卡片悬浮播放按钮：拉取歌单歌曲后直接播放 */
async function lxPlaySheetDirect(id) {
    const rec = LxModule.recommend;
    try {
        showToast('加载歌单…', 'info');
        const r = await API.lx.getSheetDetail(rec.platform, id, 1);
        const list = (r.data && r.data.list) || [];
        if (!list.length) {
            showToast('歌单暂无歌曲', 'warning');
            return;
        }
        lxPlayList(list, 0);
    } catch (e) {
        showToast('播放失败: ' + (e && e.message), 'error');
    }
}
function lxDownloadNotReady() {
    showToast('LX 音源下载将在二期支持', 'info');
}

/** 收藏/取消收藏（与 MF 同款行为） */
async function lxToggleFavorite(song) {
    if (!song) return;
    const plugin = song.plugin || song.platform;
    try {
        const fav = (typeof isSongFavoritedSync === 'function') ? isSongFavoritedSync(song.id, plugin) : false;
        if (fav) {
            await API.myFavorites.remove(song.id, plugin);
            showToast('已取消收藏', 'success');
        } else {
            await API.myFavorites.add(song);
            showToast('已添加到收藏', 'success');
        }
    } catch (e) {
        showToast('操作失败: ' + (e && e.message), 'error');
    }
}

/** 把当前详情歌曲保存为普通歌单（快照） */
async function lxSaveSongsAsPlaylist(defaultName, songs, cover) {
    if (!songs || !songs.length) { showToast('歌单为空', 'warning'); return; }
    let name = defaultName || 'LX 歌单';
    if (typeof Notification !== 'undefined' && Notification.prompt) {
        const input = await Notification.prompt('请输入歌单名称', name);
        if (!input) return;
        name = input;
    }
    try {
        showToast('正在保存歌单...', 'info');
        const res = await API.playlists.create(name, '', cover || '');
        const pid = res && res.data && (res.data.id || res.data.playlistId);
        if (!pid) throw new Error((res && res.error) || '创建歌单失败');
        let added = 0;
        for (const s of songs) {
            try {
                await API.playlists.addSong(pid, s, s.plugin || ('lx:' + (s.lxSource || '')));
                added++;
            } catch { /* 跳过单首失败 */ }
        }
        showToast(`已保存到歌单「${name}」（${added} 首）`, 'success');
    } catch (e) {
        showToast('保存失败: ' + (e && e.message), 'error');
    }
}

/** 把当前 LX 榜单/歌单保存为实时歌单（与 MF 详情页「歌单」按钮同款：只存来源地址，进入时实时拉取） */
async function lxSaveAsLivePlaylist(src) {
    if (!src || !src.toplistId) return;
    const allSongs = src.songs || [];
    if (!allSongs.length) { showToast(src.type === 'toplist' ? '榜单为空' : '歌单为空', 'warning'); return; }
    // 默认名称带上音源（落雪音源别名）前缀，如「落雪·酷狗-飙升榜」
    const defaultName = (typeof window.getEffectivePlaylistName === 'function')
        ? await window.getEffectivePlaylistName(src.defaultName || 'LX 歌单', allSongs, src.platform)
        : (src.defaultName || 'LX 歌单');
    ButtonActions.showLivePlaylistSaveModal(defaultName, { type: src.type, platform: src.platform, toplistId: src.toplistId }, src.cover);
}

// ==================== LX 排行榜 ====================

async function lxInitToplist() {
    lxManageMode = false;
    lxDetailCtx = null;
    lxRemoveDetailMenu();
    await lxEnsurePlatforms();
    LxModule.toplist.platform = lxSavedPlatform() || 'kg';
    if (!LxModule.platforms.some((p) => p.id === LxModule.toplist.platform)) {
        LxModule.toplist.platform = (LxModule.platforms[0] && LxModule.platforms[0].id) || 'kg';
    }
    LxModule.toplist.detail = null;
    LxModule.toplist.searchSongs = null;
    LxModule.toplist.searchQuery = '';
    LxModule.toplist.searchPage = 1;
    await lxLoadBoards(LxModule.toplist.platform);
}

async function lxSwitchToplistPlatform(p) {
    lxSetPlatform(p);
    LxModule.toplist.detail = null;
    LxModule.toplist.searchSongs = null;
    LxModule.toplist.searchQuery = '';
    LxModule.toplist.searchPage = 1;
    lxRestoreHeader('lx-toplist');
    await lxLoadBoards(p);
}

async function lxLoadBoards(platform) {
    const c = document.getElementById('lx-toplist-content');
    if (!c) return;
    c.innerHTML = lxPlatformTabsHtml(platform, 'lxSwitchToplistPlatform') + lxLoadingHtml();
    try {
        const r = await API.lx.getBoards(platform);
        LxModule.toplist.boards = (r.data && r.data.list) || [];
        LxModule.toplist.groups = (r.data && r.data.groups) || [];
        LxModule.toplist.detail = null;
        lxRenderToplist();
    } catch (e) {
        c.innerHTML = lxPlatformTabsHtml(platform, 'lxSwitchToplistPlatform') + lxErrorHtml(e.message);
    }
}

/** 单个榜单卡片（与 MF 排行榜卡片结构完全一致：封面 + 播放按钮 + 名称 + 描述） */
function lxBoardCardHtml(b) {
    const id = escapeHtml(String(b.id));
    const name = escapeHtml(b.name || '未命名');
    const desc = escapeHtml(b.desc || b.description || '');
    const update = escapeHtml(b.update || b.pub || '');
    const rawCover = b.pic || b.artwork || b.cover || '';
    const coverUrl = (typeof window.isPlausibleImageUrl === 'function' && !window.isPlausibleImageUrl(rawCover)) ? '' : rawCover;
    return `<div class="toplist-item" data-toplist-id="${encodeURIComponent(String(b.id))}" data-toplist-title="${name}" data-toplist-cover="${escapeHtml(coverUrl)}" onclick="lxOpenBoard('${id}')">
        <div class="toplist-cover">
            ${coverUrl ? createImageWithFallback(coverUrl, 'cover', '') + "<div style='display:none'>🎵</div>" : '🎵'}
            <button class="media-card-play" title="播放榜单" onclick="event.stopPropagation(); lxPlayBoardDirect('${id}')"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
        </div>
        <div class="toplist-name">${name}</div>
        ${update ? `<div class="toplist-update">${update}</div>` : ''}
        <div class="toplist-desc">${desc}</div>
    </div>`;
}

/** 按分组渲染榜单卡片（与 MF 排行榜同款：分组标题 + .toplist-grid 卡片网格） */
function lxBoardsHtml(groups) {
    if (!groups || !groups.length) {
        return `<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">该平台暂无榜单</div></div>`;
    }
    return groups.map((g) => `
        ${g.title ? `<h3 style="margin: 20px 0 15px; color: var(--text-color); font-size: 16px; font-weight: 600;">${escapeHtml(g.title)}</h3>` : ''}
        <div class="toplist-grid">
            ${(g.data || []).map(lxBoardCardHtml).join('')}
        </div>`).join('');
}

function lxRenderToplist() {
    const c = document.getElementById('lx-toplist-content');
    if (!c) return;
    const t = LxModule.toplist;
    c.innerHTML = lxPlatformTabsHtml(t.platform, 'lxSwitchToplistPlatform') + lxBoardsHtml(t.groups);
}

/** 榜单页搜索（与 MF 排行榜页头搜索同款交互） */
async function lxToplistSearch() {
    const input = document.getElementById('lx-toplist-search-input');
    const query = input ? input.value.trim() : '';
    if (!query) {
        showToast('请输入搜索关键词', 'error');
        return;
    }
    const t = LxModule.toplist;
    t.searchQuery = query;
    showToast('搜索中...');
    try {
        const r = await API.lx.search(t.platform, query, 1);
        if (r && r.success === false) {
            showToast('搜索失败: ' + (r.error || '未知错误'), 'error');
            return;
        }
        const list = (r.data && r.data.list) || [];
        if (!list.length) {
            showToast('未找到相关结果', 'warning');
            return;
        }
        t.searchSongs = list;
        t.searchPage = 1;
        await lxRenderSearchResults();
        showToast(`找到 ${list.length} 条结果`, 'success');
    } catch (e) {
        showToast('搜索失败: ' + (e && e.message), 'error');
    }
}

/** 搜索结果表格（复用 SongTable：标题/副标题/返回/分页，与 MF 搜索结果视图一致） */
async function lxRenderSearchResults() {
    const container = document.getElementById('lx-toplist-content');
    const t = LxModule.toplist;
    if (!container || !t.searchSongs) return;
    const allSongs = t.searchSongs;
    const query = t.searchQuery || '';
    const pageSize = getSongTablePageSize();
    const totalPages = Math.max(1, Math.ceil(allSongs.length / pageSize));
    t.searchPage = Math.min(Math.max(1, t.searchPage || 1), totalPages);
    const start = (t.searchPage - 1) * pageSize;
    const pageSongs = allSongs.slice(start, start + pageSize);
    const hasSongs = allSongs.length > 0;

    await SongTable.render({
        container,
        pageId: 'lx-toplist-search',
        title: `"${escapeHtml(query)}" 的搜索结果`,
        subtitle: `${allSongs.length} 首歌曲`,
        songs: pageSongs,
        indexOffset: start,
        pagination: {
            page: t.searchPage,
            pageSize,
            total: allSongs.length,
            pageSizes: SONGTABLE_PAGE_SIZES,
            onPageChange: (p) => { t.searchPage = p; lxRenderSearchResults(); },
            onPageSizeChange: (n) => { setSongTablePageSize(n); t.searchPage = 1; lxRenderSearchResults(); },
        },
        showHeader: true,
        onBack: 'lxBackFromSearch()',
        columns: ['index', 'title', 'artist', 'album', 'duration', 'source', 'favorite'],
        actions: [
            {
                id: 'play',
                icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
                text: '播放',
                primary: true,
                disabled: !hasSongs,
                onClick: () => lxPlaySearchByIndex(0),
            },
            {
                id: 'save-playlist',
                icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
                text: '歌单',
                primary: false,
                disabled: !hasSongs,
                onClick: () => lxSaveSongsAsPlaylist(`"${query}" 的搜索结果`, allSongs, ''),
            },
        ],
        events: {
            onPlay: (song, index) => lxPlaySearchByIndex(index),
            onFavorite: (song) => lxToggleFavorite(song),
        },
    });
}

/** 搜索结果返回榜单列表 */
function lxBackFromSearch() {
    LxModule.toplist.searchSongs = null;
    LxModule.toplist.searchQuery = '';
    LxModule.toplist.searchPage = 1;
    lxBackToBoards();
}

async function lxOpenBoard(id) {
    const t = LxModule.toplist;
    const board = t.boards.find((b) => String(b.id) === String(id)) || { id, name: '榜单' };
    t.currentId = id;
    t.detail = { id, name: board.name, pic: board.pic || '' };

    lxManageMode = false;
    lxDetailCtx = null;
    lxSetDetailHeader(board.name || '榜单详情', () => lxBackToBoards());
    lxSetupDetailMenu();

    const c = document.getElementById('lx-toplist-content');
    if (c) c.innerHTML = lxLoadingHtml();
    try {
        // 取歌接口需要 bangid（如 16），不是完整 id（如 kw__16）
        const r = await API.lx.getBoardSongs(t.platform, board.bangid || id, 1);
        t.songs = (r.data && r.data.list) || [];
        t.total = (r.data && r.data.total) || t.songs.length;
        const cover = t.songs[0] ? (t.songs[0].artwork || '') : '';
        lxRenderDetailTable({
            pageId: 'lx-toplist',
            containerId: 'lx-toplist-content',
            songs: t.songs,
            cover: board.pic || cover,
            title: board.name || '榜单详情',
            onRandom: 'lxPlayRandom()',
            onPlay: (i) => lxPlayByIndex(i),
            onSave: () => lxSaveAsLivePlaylist({
                type: 'toplist',
                platform: 'lx:' + t.platform,
                toplistId: board.bangid || id,
                defaultName: board.name || 'LX 榜单',
                cover: board.pic || cover,
                songs: t.songs,
            }),
        });
    } catch (e) {
        if (c) c.innerHTML = lxErrorHtml(e.message);
    }
}

function lxBackToBoards() {
    LxModule.toplist.detail = null;
    LxModule.toplist.searchSongs = null;
    LxModule.toplist.searchQuery = '';
    LxModule.toplist.searchPage = 1;
    lxManageMode = false;
    lxDetailCtx = null;
    lxRemoveDetailMenu();
    lxRestoreHeader('lx-toplist');
    lxRenderToplist();
}

// ==================== LX 热门歌单 ====================

const LX_RECOMMEND_HEADER_ID = 'lx-recommend-header';

/** 分类标签按钮统一样式（与 MF tag-btn 内联样式一致） */
function lxTagBtnStyle(on) {
    return `padding: 6px 14px; border-radius: 16px; border: 1px solid var(--border-color); background: ${on ? 'var(--primary-color)' : 'transparent'}; color: ${on ? 'white' : 'var(--text-secondary)'}; font-size: 13px; cursor: pointer; white-space: nowrap; transition: all 0.2s;`;
}

async function lxInitRecommend() {
    lxManageMode = false;
    lxDetailCtx = null;
    lxRemoveDetailMenu();
    LxModule.recommend.searchQuery = '';
    LxModule.recommend.mode = 'tag';
    await lxEnsurePlatforms();
    LxModule.recommend.platform = lxSavedPlatform() || 'kg';
    if (!LxModule.platforms.some((p) => p.id === LxModule.recommend.platform)) {
        LxModule.recommend.platform = (LxModule.platforms[0] && LxModule.platforms[0].id) || 'kg';
    }
    LxModule.recommend.detail = null;
    await lxLoadTags(LxModule.recommend.platform);
}

async function lxSwitchRecommendPlatform(p) {
    lxSetPlatform(p);
    LxModule.recommend.detail = null;
    LxModule.recommend.searchQuery = '';
    LxModule.recommend.mode = 'tag';
    lxRestoreHeader('lx-recommend');
    await lxLoadTags(p);
}

/** 详情页隐藏/恢复固定头部（插件标签 + 分类栏），与 MF setRecommendHeaderVisible 一致 */
function lxSetRecommendHeaderVisible(visible) {
    const header = document.getElementById(LX_RECOMMEND_HEADER_ID);
    if (header) header.style.display = visible ? '' : 'none';
}

async function lxLoadTags(platform) {
    const header = document.getElementById(LX_RECOMMEND_HEADER_ID);
    const content = document.getElementById('lx-recommend-content');
    if (header) header.innerHTML = lxPlatformTabsHtml(platform, 'lxSwitchRecommendPlatform') + lxLoadingHtml();
    if (content) content.innerHTML = '';
    try {
        const r = await API.lx.getTags(platform);
        const rec = LxModule.recommend;
        rec.tags = (r.data && r.data.tags) || [];
        rec.hotTag = (r.data && r.data.hotTag) || [];
        rec.sortList = (r.data && r.data.sortList) || [];
        rec.currentTagId = ''; // 默认分类（与 MF 一致）
        rec.sheets = [];
        rec.page = 1;
        rec.isEnd = false;
        rec.mode = 'tag';
        rec.detail = null;
        lxRenderRecommendHeader();
        await lxLoadSheets();
    } catch (e) {
        if (header) header.innerHTML = lxPlatformTabsHtml(platform, 'lxSwitchRecommendPlatform');
        if (content) content.innerHTML = lxErrorHtml(e.message);
    }
}

/** 固定头部：插件标签 + 分类标签栏（搜索统一走页头搜索框，避免同页出现两个搜索框） */
function lxRenderRecommendHeader() {
    const header = document.getElementById(LX_RECOMMEND_HEADER_ID);
    if (!header) return;
    header.style.display = ''; // 保证从详情返回后可见
    header.innerHTML = lxPlatformTabsHtml(LxModule.recommend.platform, 'lxSwitchRecommendPlatform')
        + lxTagBarHtml();
    lxRenderTagPanel();
}

/** 分类标签栏：默认 + 热门标签 + 更多（与 MF .recommend-tags-bar 同款） */
function lxTagBarHtml() {
    const rec = LxModule.recommend;
    const isDefault = String(rec.currentTagId || '') === '';
    let html = `<button type="button" class="tag-btn tag-default ${isDefault ? 'active' : ''}" onclick="lxSelectTag('')" style="${lxTagBtnStyle(isDefault)}">默认</button>`;
    (rec.hotTag || []).forEach((t) => {
        const on = String(rec.currentTagId) === String(t.id);
        html += `<button type="button" class="tag-btn ${on ? 'active' : ''}" onclick="lxSelectTag('${escapeHtml(String(t.id))}')" style="${lxTagBtnStyle(on)}">${escapeHtml(t.name || t.title || '')}</button>`;
    });
    html += `<button type="button" class="tag-btn tag-more" onclick="lxToggleTagPanel()" style="${lxTagBtnStyle(false)} display: flex; align-items: center; gap: 4px;">更多<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transition: transform 0.2s;"><polyline points="6 9 12 15 18 9"></polyline></svg></button>`;
    return `<div class="recommend-tags-bar" style="padding: 12px 0; border-bottom: 1px solid var(--divider-color); display: flex; gap: 8px; overflow-x: auto; align-items: center; scrollbar-width: none; -ms-overflow-style: none;">${html}</div>`;
}

/** 分类标签面板（下拉/底部弹层，与 MF tag-panel 同款） */
function lxRenderTagPanel() {
    const rec = LxModule.recommend;
    let panel = document.getElementById('lx-tag-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'lx-tag-panel';
        panel.className = 'tag-panel';
        panel.style.cssText = 'position: fixed; background: var(--surface-color); border: 1px solid var(--divider-color); border-radius: var(--radius-lg); padding: 16px; min-width: 400px; max-height: 400px; overflow-y: auto; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 1000; display: none;';
        document.body.appendChild(panel);
    }
    const isDefault = String(rec.currentTagId || '') === '';
    let html = `<div class="tag-group" style="margin-bottom: 16px;">
        <button type="button" class="tag-btn ${isDefault ? 'active' : ''}" onclick="lxSelectTag(''); lxHideTagPanel();" style="${lxTagBtnStyle(isDefault)}">默认</button>
    </div>`;
    (rec.tags || []).forEach((group) => {
        // LX SDK 标签组结构：{ name: '组名', list: [{ id, name }] }（兼容 { title, data } 旧形态）
        const title = group.title || group.name;
        const items = Array.isArray(group.data) ? group.data : (Array.isArray(group.list) ? group.list : []);
        if (title) {
            html += `<div class="tag-group-title" style="font-size: 12px; color: var(--text-tertiary); margin: 12px 0 8px; font-weight: 500;">${escapeHtml(title)}</div>`;
        }
        if (items.length) {
            html += `<div class="tag-group" style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">`;
            items.forEach((tag) => {
                const on = String(rec.currentTagId) === String(tag.id);
                html += `<button type="button" class="tag-btn ${on ? 'active' : ''}" onclick="lxSelectTag('${escapeHtml(String(tag.id))}'); lxHideTagPanel();" style="${lxTagBtnStyle(on)}">${escapeHtml(tag.name || tag.title || '')}</button>`;
            });
            html += `</div>`;
        }
    });
    panel.innerHTML = html;
}

function lxHideTagPanel() {
    const panel = document.getElementById('lx-tag-panel');
    if (panel) panel.style.display = 'none';
    document.removeEventListener('click', lxHandleTagPanelOutside);
}

function lxHandleTagPanelOutside(event) {
    const panel = document.getElementById('lx-tag-panel');
    const bar = document.querySelector('#lx-recommend-header .recommend-tags-bar');
    if (panel && (panel.contains(event.target) || (bar && bar.contains(event.target)))) return;
    lxHideTagPanel();
}

function lxToggleTagPanel() {
    const bar = document.querySelector('#lx-recommend-header .recommend-tags-bar');
    const moreBtn = bar && bar.querySelector('.tag-more');
    const panel = document.getElementById('lx-tag-panel');
    if (!panel || !bar) return;
    if (panel.style.display !== 'none') {
        lxHideTagPanel();
        return;
    }
    if (window.innerWidth <= 768) {
        // 手机端：底部弹层（全宽贴底），避免 400px 下拉面板溢出屏幕
        requestAnimationFrame(() => {
            panel.style.left = '0';
            panel.style.right = '0';
            panel.style.top = 'auto';
            panel.style.bottom = '0';
            panel.style.minWidth = '0';
            panel.style.width = 'auto';
            panel.style.maxHeight = '50vh';
            panel.style.borderRadius = '16px 16px 0 0';
            panel.style.padding = '16px 16px calc(16px + env(safe-area-inset-bottom, 0px))';
            panel.style.boxShadow = '0 -4px 24px rgba(0,0,0,0.25)';
            panel.style.display = 'block';
        });
    } else {
        const rect = moreBtn ? moreBtn.getBoundingClientRect() : bar.getBoundingClientRect();
        requestAnimationFrame(() => {
            panel.style.left = rect.left + 'px';
            panel.style.top = (rect.bottom + 8) + 'px';
            panel.style.bottom = 'auto';
            panel.style.minWidth = '400px';
            panel.style.width = 'auto';
            panel.style.maxHeight = '400px';
            panel.style.borderRadius = 'var(--radius-lg)';
            panel.style.padding = '16px';
            panel.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
            panel.style.display = 'block';
        });
    }
    setTimeout(() => document.addEventListener('click', lxHandleTagPanelOutside), 0);
}

/** 歌单网格卡片（与 MF .recommend-sheet-card 结构一致：封面 + 播放按钮 + 名称 + 描述） */
function lxSheetGridHtml(sheets) {
    if (!sheets || !sheets.length) {
        return `<div class="empty-state" style="min-height: 100%;"><div class="empty-icon">📭</div><div class="empty-text">该标签暂无歌单数据</div></div>`;
    }
    return `<div class="recommend-sheets-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 18px; padding: 20px 0 0 0;">
        ${sheets.map((s) => {
            const rawCover = s.img || s.cover || s.pic || s.coverImg || '';
            const coverUrl = (typeof window.isPlausibleImageUrl === 'function' && !window.isPlausibleImageUrl(rawCover)) ? '' : rawCover;
            const count = s.play_count || s.playCount || s.total || '';
            const sub = s.author ? (count ? `${s.author} · ${count}` : s.author) : (count || '');
            return `<div class="recommend-sheet-card" onclick="lxOpenSheet('${escapeHtml(String(s.id))}')"
                style="cursor: pointer; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 10px 10px 12px; transition: transform 0.25s ease, background 0.25s ease, box-shadow 0.25s ease;"
                onmouseover="this.style.transform='translateY(-3px)';this.style.background='var(--bg-tertiary)';this.style.boxShadow='var(--shadow-md)';"
                onmouseout="this.style.transform='';this.style.background='var(--bg-secondary)';this.style.boxShadow='';">
                <div class="toplist-cover" style="width: 100%; aspect-ratio: 1; background: linear-gradient(135deg, var(--bg-tertiary) 0%, var(--surface-color) 100%); border-radius: var(--radius-md); display: flex; align-items: center; justify-content: center; font-size: 48px; margin-bottom: 18px; overflow: hidden;">
                    ${coverUrl ? createImageWithFallback(coverUrl, 'cover', '') + "<div style='display:none'>🎵</div>" : '🎵'}
                    <button class="media-card-play" title="播放歌单" onclick="event.stopPropagation(); lxPlaySheetDirect('${escapeHtml(String(s.id))}')"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
                </div>
                <div class="toplist-name" style="font-size: 14px; font-weight: 600; line-height: 1.4; color: var(--text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(s.name || '')}</div>
                <div class="toplist-desc" style="font-size: 12px; line-height: 1.5; margin-top: 6px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(sub)}</div>
            </div>`;
        }).join('')}
    </div>`;
}

/** 加载更多（与 MF .load-more-container 同款） */
function lxLoadMoreHtml() {
    const rec = LxModule.recommend;
    let inner;
    if (rec.isEnd) {
        inner = '<span style="color: var(--text-tertiary); font-size: 13px;">已经到底了</span>';
    } else if (rec.loading) {
        inner = `<div class="loading" style="padding: 10px; display: flex; align-items: center; justify-content: center; gap: 10px;"><div class="spinner" style="width: 20px; height: 20px;"></div><span style="color: var(--text-secondary); font-size: 13px;">加载中...</span></div>`;
    } else {
        inner = '<button onclick="lxLoadMoreSheets()" style="padding: 8px 24px; border-radius: 16px; border: 1px solid #d0d0d0 !important; background-color: #eeeeee !important; color: #333333 !important; cursor: pointer; font-size: 13px;">加载更多</button>';
    }
    return `<div class="load-more-container" style="text-align: center; padding: 20px; margin-top: 20px;">${inner}</div>`;
}

/** 渲染歌单列表（网格 + 加载更多） */
function lxRenderSheetGrid() {
    const content = document.getElementById('lx-recommend-content');
    if (!content) return;
    const rec = LxModule.recommend;
    if (!rec.sheets.length) {
        content.innerHTML = `<div class="empty-state" style="min-height: 100%;"><div class="empty-icon">📭</div><div class="empty-text">${rec.mode === 'search' ? '未找到相关歌单' : '该标签暂无歌单数据'}</div></div>`;
        return;
    }
    content.innerHTML = lxSheetGridHtml(rec.sheets) + lxLoadMoreHtml();
}

async function lxLoadSheets() {
    const rec = LxModule.recommend;
    const content = document.getElementById('lx-recommend-content');
    if (!content) return;
    rec.mode = 'tag';
    rec.page = 1;
    rec.isEnd = false;
    rec.loading = false;
    content.innerHTML = lxLoadingHtml();
    try {
        const sortId = rec.sortList[0] && rec.sortList[0].id;
        const r = await API.lx.getSheets(rec.platform, sortId, rec.currentTagId, 1);
        const list = (r.data && r.data.list) || [];
        rec.sheets = list;
        rec.isEnd = list.length === 0;
        lxRenderSheetGrid();
    } catch (e) {
        content.innerHTML = lxErrorHtml(e.message);
    }
}

/** 加载更多（分类浏览 / 搜索结果 均支持翻页） */
async function lxLoadMoreSheets() {
    const rec = LxModule.recommend;
    if (rec.loading || rec.isEnd) return;
    rec.loading = true;
    lxRenderSheetGrid();
    try {
        const next = rec.page + 1;
        let list = [];
        if (rec.mode === 'search') {
            const r = await API.lx.searchSheets(rec.platform, rec.searchQuery, next);
            list = (r.data && r.data.list) || [];
        } else {
            const sortId = rec.sortList[0] && rec.sortList[0].id;
            const r = await API.lx.getSheets(rec.platform, sortId, rec.currentTagId, next);
            list = (r.data && r.data.list) || [];
        }
        if (!list.length) {
            rec.isEnd = true;
        } else {
            rec.page = next;
            rec.sheets = rec.sheets.concat(list);
        }
    } catch (e) { /* 保持可重试 */ }
    rec.loading = false;
    lxRenderSheetGrid();
}

/** 歌单搜索（走页头搜索框 lx-recommend-sheet-search-input） */
async function lxRecommendSearchSheets() {
    const headInput = document.getElementById('lx-recommend-sheet-search-input');
    const query = String((headInput && headInput.value) || '').trim();
    if (!query) {
        showToast('请输入搜索关键词', 'error');
        return;
    }
    const rec = LxModule.recommend;
    const content = document.getElementById('lx-recommend-content');
    rec.searchQuery = query;
    rec.mode = 'search';
    rec.page = 1;
    rec.isEnd = false;
    if (content) content.innerHTML = lxLoadingHtml();
    showToast('搜索中...');
    try {
        const r = await API.lx.searchSheets(rec.platform, query, 1);
        if (r && r.success === false) {
            showToast('搜索失败: ' + (r.error || '未知错误'), 'error');
            if (content) content.innerHTML = lxErrorHtml(r.error || '搜索失败');
            return;
        }
        const list = (r.data && r.data.list) || [];
        rec.sheets = list;
        rec.isEnd = list.length === 0;
        if (!list.length) {
            showToast('未找到相关歌单', 'warning');
            lxRenderSheetGrid();
            return;
        }
        lxRenderSheetGrid();
        showToast(`找到 ${list.length} 个歌单`, 'success');
    } catch (e) {
        showToast('搜索失败: ' + (e && e.message), 'error');
    }
}

async function lxSelectTag(tagId) {
    const rec = LxModule.recommend;
    rec.currentTagId = tagId == null ? '' : String(tagId);
    rec.mode = 'tag';
    rec.searchQuery = '';
    // 只重渲染标签栏（保留页头搜索框输入），再重新加载列表
    const bar = document.querySelector('#lx-recommend-header .recommend-tags-bar');
    if (bar) {
        bar.outerHTML = lxTagBarHtml();
        lxRenderTagPanel();
    } else {
        lxRenderRecommendHeader();
    }
    await lxLoadSheets();
}

async function lxOpenSheet(id) {
    const rec = LxModule.recommend;
    const c = document.getElementById('lx-recommend-content');
    if (c) c.innerHTML = lxLoadingHtml();
    try {
        const r = await API.lx.getSheetDetail(rec.platform, id, 1);
        const info = (r.data && r.data.info) || {};
        const songs = (r.data && r.data.list) || [];
        rec.detail = { id, info };
        rec.songs = songs;
        const sheet = rec.sheets.find((s) => String(s.id) === String(id));
        const cover = info.img || info.cover || info.pic
            || (sheet && (sheet.img || sheet.cover || sheet.pic || sheet.coverImg)) || '';

        lxManageMode = false;
        lxDetailCtx = null;
        lxSetDetailHeader(info.name || '歌单详情', () => lxBackToSheets());
        lxSetRecommendHeaderVisible(false); // 详情页隐藏固定头部（同 MF）
        lxSetupDetailMenu();

        lxRenderDetailTable({
            pageId: 'lx-recommend',
            containerId: 'lx-recommend-content',
            songs,
            cover,
            title: info.name || '歌单详情',
            onRandom: 'lxPlayRandom()',
            onPlay: (i) => lxPlayByIndex(i),
            onSave: () => lxSaveAsLivePlaylist({
                type: 'playlist',
                platform: 'lx:' + rec.platform,
                toplistId: id,
                defaultName: info.name || 'LX 歌单',
                cover,
                songs,
            }),
        });
    } catch (e) {
        if (c) c.innerHTML = lxErrorHtml(e.message);
    }
}

function lxBackToSheets() {
    LxModule.recommend.detail = null;
    lxManageMode = false;
    lxDetailCtx = null;
    lxRemoveDetailMenu();
    lxRestoreHeader('lx-recommend');
    lxSetRecommendHeaderVisible(true); // 恢复固定头部
    if (LxModule.recommend.sheets.length) {
        lxRenderSheetGrid();
    } else {
        lxLoadSheets();
    }
}

// ==================== 导出 ====================
window.LxModule = LxModule;
window.lxInitToplist = lxInitToplist;
window.lxInitRecommend = lxInitRecommend;
window.lxSwitchToplistPlatform = lxSwitchToplistPlatform;
window.lxSwitchRecommendPlatform = lxSwitchRecommendPlatform;
window.lxOpenBoard = lxOpenBoard;
window.lxBackToBoards = lxBackToBoards;
window.lxSelectTag = lxSelectTag;
window.lxOpenSheet = lxOpenSheet;
window.lxBackToSheets = lxBackToSheets;
window.lxPlayList = lxPlayList;
window.lxPlayByIndex = lxPlayByIndex;
window.lxPlayRandom = lxPlayRandom;
window.lxPlaySearchByIndex = lxPlaySearchByIndex;
window.lxPlayBoardDirect = lxPlayBoardDirect;
window.lxPlaySheetDirect = lxPlaySheetDirect;
window.lxToplistSearch = lxToplistSearch;
window.lxBackFromSearch = lxBackFromSearch;
window.lxRecommendSearchSheets = lxRecommendSearchSheets;
window.lxLoadMoreSheets = lxLoadMoreSheets;
window.lxToggleTagPanel = lxToggleTagPanel;
window.lxHideTagPanel = lxHideTagPanel;
window.lxToggleDetailMenu = lxToggleDetailMenu;
window.lxCloseDetailMenu = lxCloseDetailMenu;
window.lxToggleManageMode = lxToggleManageMode;
