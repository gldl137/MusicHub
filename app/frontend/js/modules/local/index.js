/**
 * 本地音乐模块
 * 功能：扫描 /app/music 目录，展示单曲/歌手/专辑/文件夹四种视图并支持播放
 */

// ==================== 本地音乐状态 ====================

window.currentLocalSongs = [];     // 已加载的本地歌曲（分页累积，非全量）
let localSongsTotal = 0;            // 单曲总数（来自分页响应 total，非全量数组长度）
let localSongsEpoch = 0;            // 删除后自增，强制 SongListLazy 重置分页缓存
const _localSongFetchers = new Map();
// 单曲列表分页数据源：滚动到底按需拉取；搜索态带 q 走后端过滤。相同 kw 复用同一函数引用
// （配合 fetchKey 中的 epoch 区分「切页保留进度 / 搜索或删除后重置」）。
function makeLocalSongsFetcher(kw) {
    const key = kw || '';
    let fn = _localSongFetchers.get(key);
    if (!fn) {
        fn = async function (fk, offset, limit) {
            let url = `/api/music/songs?limit=${limit}&offset=${offset}`;
            if (key) url += `&q=${encodeURIComponent(key)}`;
            const r = await API.get(url);
            const data = (r && r.data) || [];
            const total = (r && typeof r.total === 'number') ? r.total : (offset + data.length);
            window.localSongsTotal = total;
            // 拉到首屏后回填页头计数（详情页/歌手专辑详情页不覆盖）
            if (currentLocalTab === 'songs' && !localArtistDetail && !localAlbumDetail) {
                setupLocalHeader(window.localSongsTotal);
                if (typeof updateLocalStats === 'function') updateLocalStats();
            }
            return { songs: data, total: total, hasMore: offset + data.length < total };
        };
        _localSongFetchers.set(key, fn);
    }
    return fn;
}

// 详情/目录视图的歌曲数据源（按需从后端过滤拉取，不再依赖全量 currentLocalSongs）
let localFolderEpoch = 0;
let localFolderTotal = 0;
window.localFolderSongsLoaded = [];
window.localDetailSongs = [];
const _localFolderFetchers = new Map();
async function fetchLocalSongs(params) {
    const qs = [];
    if (params.artist) qs.push('artist=' + encodeURIComponent(params.artist));
    if (params.album) qs.push('album=' + encodeURIComponent(params.album));
    if (params.folder) qs.push('folder=' + encodeURIComponent(params.folder));
    if (params.q) qs.push('q=' + encodeURIComponent(params.q));
    qs.push('limit=5000');
    const r = await API.get('/api/music/songs?' + qs.join('&'));
    return (r && r.data) || [];
}
function fetchLocalSongsByArtist(name) { return fetchLocalSongs({ artist: name }); }
function fetchLocalSongsByAlbum(artist, album) { return fetchLocalSongs({ artist, album }); }
function makeLocalFolderFetcher(folderPath) {
    const key = folderPath || '';
    let fn = _localFolderFetchers.get(key);
    if (!fn) {
        fn = async function (fk, offset, limit) {
            let url = `/api/music/songs?limit=${limit}&offset=${offset}`;
            if (key) url += `&folder=${encodeURIComponent(key)}`;
            const r = await API.get(url);
            const data = (r && r.data) || [];
            const total = (r && typeof r.total === 'number') ? r.total : (offset + data.length);
            window.localFolderTotal = total;
            const node = findLocalFolderNode(key);
            const hasSub = !!(node && node.children && node.children.length);
            const cnt = document.querySelector('.local-folder-current-count');
            if (cnt) cnt.textContent = `${total} 首歌曲${hasSub ? '（含子目录）' : ''}`;
            return { songs: data, total: total, hasMore: offset + data.length < total };
        };
        _localFolderFetchers.set(key, fn);
    }
    return fn;
}

window.currentLocalArtists = [];   // 歌手聚合
window.currentLocalAlbums = [];    // 专辑聚合
window.currentLocalDirs = [];      // 全部子目录（含空目录）
window.localFolderTree = null;     // 文件夹树（左树右列表模式）

let localSearchKeyword = '';     // 顶部搜索关键字（按 歌曲/歌手/专辑 过滤当前视图）
let currentLocalTab = 'songs';   // 当前激活的 tab

// 表格分页状态（单曲视图 / 目录视图独立翻页；每页条数全局统一记忆，helpers 在 song-table.js）
let localSongsPage = 1;          // 单曲视图当前页（1 起）
let localFolderPage = 1;         // 目录视图当前页（1 起）
let localArtistsPage = 1;        // 歌手视图当前页（1 起）
let localAlbumsPage = 1;         // 专辑视图当前页（1 起）

/** 分页页码收敛：限制在 [1, 总页数] 内 */
function localClampPage(total, page) {
    const totalPages = Math.max(1, Math.ceil(total / getSongTablePageSize()));
    return Math.min(Math.max(1, page), totalPages);
}

// 歌手/专辑卡片视图分页：复用 SongTable 的分页样式（.st-pagination 等），
// 生成「共 N 个 + 每页条数 + 页码（含省略号）+ 上下页」分页条。
// gotoFn / sizeFn 为全局函数名（字符串），供 onclick 调用。
function localBuildCardPagination(total, page, pageSize, gotoFn, sizeFn) {
    const pageSizes = SONGTABLE_PAGE_SIZES;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const p = Math.min(Math.max(1, page), totalPages);
    const pages = [];
    const push = (x) => { if (!pages.length || pages[pages.length - 1] !== x) pages.push(x); };
    push(1);
    // 手机端只显示首页和尾页页码，中间用省略号
    if (window.innerWidth <= 768) {
        if (totalPages > 1) push(totalPages);
    } else {
        for (let i = p - 2; i <= p + 2; i++) if (i > 1 && i < totalPages) push(i);
        if (totalPages > 1) push(totalPages);
    }
    let btns = '';
    pages.forEach((pp, i) => {
        if (i > 0 && pp - pages[i - 1] > 1) btns += '<span class="st-page-ellipsis">…</span>';
        btns += `<button type="button" class="st-page-btn ${pp === p ? 'active' : ''}" onclick="${gotoFn}(${pp})">${pp}</button>`;
    });
    const sizeOptions = pageSizes.map((s) => `<option value="${s}" ${s === pageSize ? 'selected' : ''}>${s} 条/页</option>`).join('');
    return `
        <div class="st-pagination">
            <span class="st-page-total">共 ${total} 个</span>
            <select class="st-page-size" onchange="${sizeFn}(parseInt(this.value, 10))">${sizeOptions}</select>
            <div class="st-page-btns">
                <button type="button" class="st-page-btn nav" ${p <= 1 ? 'disabled' : ''} onclick="${gotoFn}(1)" title="首页">«</button>
                <button type="button" class="st-page-btn nav" ${p <= 1 ? 'disabled' : ''} onclick="${gotoFn}(${p - 1})" title="上一页">‹</button>
                ${btns}
                <button type="button" class="st-page-btn nav" ${p >= totalPages ? 'disabled' : ''} onclick="${gotoFn}(${p + 1})" title="下一页">›</button>
                <button type="button" class="st-page-btn nav" ${p >= totalPages ? 'disabled' : ''} onclick="${gotoFn}(${totalPages})" title="尾页">»</button>
            </div>
        </div>`;
}

function localArtistsGotoPage(p) { localArtistsPage = p; renderLocalArtists(); }
function localArtistsChangePageSize(n) { setSongTablePageSize(n); localArtistsPage = 1; renderLocalArtists(); }
function localAlbumsGotoPage(p) { localAlbumsPage = p; renderLocalAlbums(); }
function localAlbumsChangePageSize(n) { setSongTablePageSize(n); localAlbumsPage = 1; renderLocalAlbums(); }

// 默认占位封面（数据行/无封面时使用）
const LOCAL_PLACEHOLDER_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#888"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
);

function localCoverUrl(artwork) {
    return artwork ? `${window.API_BASE}${artwork}` : LOCAL_PLACEHOLDER_SVG;
}

// 生成可嵌入 onclick 属性 JS 字符串字面量的安全值。
// 顺序：先转义 &（防目录名含「&#39;」等实体样文本在 HTML 解码后变回引号）、
// 再转义反斜杠/单引号（JS 字符串）、双引号转 &quot;（HTML 属性边界）、换行转 \n。
function localJsString(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '&quot;')
        .replace(/\r?\n/g, '\\n');
}

// ==================== 页面加载 ====================

/**
 * 加载本地音乐页面（切换页面时由 app.js 调用）
 */
async function loadLocalMusic() {
    const container = document.getElementById('page-local');
    if (!container) return;

    try {
        // 歌曲列表改为「可视化分页请求」：不再一次性全量拉取，由 renderLocalSongs 内的
        // SongListLazy.fetchPage 滚动到底按需拉取（window.currentLocalSongs 仅累积已加载部分）。
        // 这里只并行拉取轻量的聚合数据（歌手/专辑/目录），降低首屏内存与网络压力。
        const [artistsRes, albumsRes, treeRes] = await Promise.allSettled([
            API.get('/api/music/artists'),
            API.get('/api/music/albums'),
            API.get('/api/music/tree')
        ]);
        const getData = (r) => (r && r.status === 'fulfilled' && r.value && r.value.data) ? r.value.data : [];

        // 不再一次性全量赋值：currentLocalSongs 由 fetchPage 累积；total 由首屏分页响应回填
        if (!window.currentLocalSongs) window.currentLocalSongs = [];
        window.localSongsTotal = window.localSongsTotal || 0;
        window.currentLocalArtists = getData(artistsRes);
        window.currentLocalAlbums = getData(albumsRes);
        window.currentLocalDirs = getData(treeRes);

        renderLocalSongs();
        renderLocalArtists();
        renderLocalAlbums();
        // 页头「⋯」菜单 + 居中标题带计数（与我的歌单一致）
        setupLocalHeader(window.localSongsTotal || 0);
        // 右上角统计：单曲 / 歌手 / 专辑 总数（三项一致样式）
        updateLocalStats();
        // 构建目录树（包含所有真实目录，含空目录）并重渲染目录视图（数据可能已变化）
        window.localFolderTree = buildLocalFolderTree(window.currentLocalSongs, window.currentLocalDirs);
        if (currentLocalTab === 'folders' || document.getElementById('local-folders-tab').hasChildNodes()) {
            renderLocalFolderTree();
        }
    } catch (error) {
        console.error('加载本地音乐失败:', error);
        const msg = escapeHtml(error.message || '未知错误');
        document.getElementById('local-songs-tab').innerHTML = `
            <div class="empty-state" style="padding: 60px 20px; text-align: center;">
                <div class="empty-icon" style="font-size: 48px;">❌</div>
                <div class="empty-text" style="color: var(--text-secondary); margin-bottom: 8px;">加载失败</div>
                <div class="empty-subtext" style="color: var(--text-tertiary);">${msg}</div>
            </div>`;
    }
}

// ==================== 右上角统计 ====================

/** 刷新头部右上角统计：共 N 单曲 / 共 M 歌手 / 共 K 专辑 */
function updateLocalStats() {
    const artists = window.currentLocalArtists || [];
    const albums = window.currentLocalAlbums || [];
    const setNum = (id, n) => {
        const el = document.getElementById(id);
        if (el) el.textContent = n;
    };
    // 单曲数用分页 total（非全量 currentLocalSongs 累积），避免首屏显示 0
    setNum('stat-songs', window.localSongsTotal || 0);
    setNum('stat-artists', artists.length);
    setNum('stat-albums', albums.length);
}

// ==================== Tab 切换 ====================

function switchLocalTab(tab) {
    const tabs = ['songs', 'artists', 'albums', 'folders'];
    tabs.forEach(t => {
        const btn = document.querySelector(`.local-music-tabs .tab-btn[data-tab="${t}"]`);
        if (btn) btn.classList.toggle('active', t === tab);
        const content = document.getElementById(`local-${t}-tab`);
        if (content) content.classList.toggle('active', t === tab);
    });
    currentLocalTab = tab;

    // 切换标签页即退出管理模式：单曲/歌手/专辑的管理各自独立、互不延续
    if (localManageMode) {
        localManageMode = false;
        localCardManageSel.clear();
    }

    // 文件夹 tab 首次进入时渲染树状视图；其余视图重新渲染以应用当前搜索过滤
    if (tab === 'folders') {
        const foldersTab = document.getElementById('local-folders-tab');
        if (!foldersTab.hasChildNodes()) {
            renderLocalFolderTree();
        }
        // 页头菜单文字同步（退出管理模式后恢复「管理」）
        setupLocalHeader(window.localSongsTotal || 0);
    } else {
        renderActiveLocalTab();
    }
}

// ==================== 顶部搜索 ====================

/** 单曲：标题/歌手/专辑 任一包含关键字即命中 */
function localSongMatches(s, kw) {
    if (!kw) return true;
    return [s.title, s.artist, s.album].some(v => (v || '').toLowerCase().includes(kw));
}
/** 通用文本包含匹配（歌手名 / 专辑名+歌手） */
function localTextMatches(text, kw) {
    if (!kw) return true;
    return (text || '').toLowerCase().includes(kw);
}

/** 搜索框输入：更新关键字并重新渲染当前视图（歌曲/歌手/专辑），过滤集变化时回到第 1 页 */
function onLocalSearchInput(value) {
    localSearchKeyword = (value || '').trim().toLowerCase();
    localSongsPage = 1;
    localArtistsPage = 1;
    localAlbumsPage = 1;
    renderActiveLocalTab();
}

/** 渲染当前激活 tab（统一走这里以便应用搜索过滤） */
function renderActiveLocalTab() {
    // 页头「⋯」菜单 + 居中标题带计数（与我的歌单一致）
    setupLocalHeader(window.localSongsTotal || 0);
    if (currentLocalTab === 'songs') renderLocalSongs();
    else if (currentLocalTab === 'artists') renderLocalArtists();
    else if (currentLocalTab === 'albums') renderLocalAlbums();
    else if (currentLocalTab === 'folders') renderLocalFolderTree();
}

// ==================== 页头「⋯」菜单（与我的歌单一致） ====================

/**
 * 页头：居中标题（带计数）+「⋯」菜单（播放全部 / 添加到歌单 / 删除）
 */
function setupLocalHeader(count) {
    const headerLeft = document.getElementById('header-left');
    if (!headerLeft) return;
    // 歌手/专辑详情页打开时：页头由详情页自行渲染（返回箭头 + 歌手/专辑名 + 「⋯」），
    // 这里直接跳过，避免标签页计数覆盖详情页头
    if (localArtistDetail || localAlbumDetail) return;
    // 顶部菜单中间：只显示当前标签页的计数（单曲/歌手/专辑 各自管自己）
    const tabLabel = currentLocalTab === 'artists' ? '歌手' : currentLocalTab === 'albums' ? '专辑' : '单曲';
    const tabCount = currentLocalTab === 'artists'
        ? (window.currentLocalArtists || []).length
        : currentLocalTab === 'albums'
            ? (window.currentLocalAlbums || []).length
            : (window.localSongsTotal || 0);
    headerLeft.style.position = 'relative';
    headerLeft.innerHTML = `
        <button class="mobile-menu-btn" onclick="toggleMobileSidebar()" aria-label="打开菜单">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
        </button>
        <div class="header-title" id="page-title" style="position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); margin: 0;">${tabLabel}（${tabCount}）</div>
        <div style="margin-left: auto; position: relative; display: flex; align-items: center;">
            <button type="button" title="更多" aria-label="更多"
                onclick="event.stopPropagation(); toggleLocalHeaderMenu()"
                class="header-icon-btn">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
            </button>
            <div id="local-header-menu"
                style="display: none; position: absolute; right: 0; top: calc(100% + 6px); min-width: 150px; background: var(--surface-color); border: 1px solid var(--divider-color); border-radius: 10px; box-shadow: var(--shadow-lg); z-index: 1001; padding: 6px 0; overflow: hidden;">
                ${currentLocalTab === 'songs' ? `<button type="button" onclick="event.stopPropagation(); playAllLocal(); closeLocalHeaderMenu();"
                    style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">播放全部</button>` : ''}
                <button type="button" onclick="event.stopPropagation(); toggleLocalManageMode(); closeLocalHeaderMenu();"
                    style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--danger-color, #ff4d4f); font-size: 14px; cursor: pointer; text-align: left;">${localManageMode ? '完成管理' : '管理'}</button>
            </div>
        </div>
    `;
}

function toggleLocalHeaderMenu() {
    const menu = document.getElementById('local-header-menu');
    if (!menu) return;
    menu.style.display = menu.style.display !== 'block' ? 'block' : 'none';
    if (menu.style.display === 'block') {
        setTimeout(() => document.addEventListener('click', closeLocalHeaderMenu), 0);
    }
}

function closeLocalHeaderMenu() {
    const menu = document.getElementById('local-header-menu');
    if (menu) menu.style.display = 'none';
    document.removeEventListener('click', closeLocalHeaderMenu);
}

// ==================== 单曲视图 ====================

// 管理模式：从页头菜单「添加到歌单 / 删除」进入，显示勾选列与顶部操作条
let localManageMode = false;

/** 当前搜索过滤后的歌曲列表（播放/收藏按此列表索引，与表格展示一致） */
function localFilteredSongs() {
    return (window.currentLocalSongs || []).filter(s => localSongMatches(s, localSearchKeyword));
}

function renderLocalSongs() {
    const container = document.getElementById('local-songs-tab');
    if (!container) return;
    if (typeof SongTable === 'undefined') {
        container.innerHTML = '<div class="empty-state">歌曲表格组件未加载</div>';
        return;
    }

    // 与「我的歌单」一致：无分页栏、无按钮条（播放/添加/删除收进页头「⋯」菜单）
    const manage = localManageMode;

    // 管理模式：顶部一行式操作条（提示左、按钮右），勾选列出现在行首
    container.innerHTML = `
        ${manage ? `
        <div class="media-card-toolbar">
            <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                <span style="font-size: 13px; color: var(--text-secondary);"><span style="margin-right: 8px;">💡</span>勾选歌曲后点右侧按钮</span>
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                <button class="btn btn-secondary btn-sm" onclick="localManageAdd()">添加到歌单${localSelectedCount() ? ` (${localSelectedCount()})` : ''}</button>
                <button class="btn btn-danger btn-sm" onclick="deleteLocalSongs('local')">删除${localSelectedCount() ? ` (${localSelectedCount()})` : ''}</button>
                <button class="btn btn-secondary btn-sm" onclick="toggleLocalManageMode()">完成</button>
            </div>
        </div>` : ''}
        <div id="local-songs-table" class="${manage ? 'playlist-detail-manage' : ''}" style="${manage ? '' : 'height: 100%;'}"></div>
    `;

    const kw = localSearchKeyword;
    const render = (slice) => {
        window.currentLocalSongs = slice;
    SongTable.render({
        container: container.querySelector('#local-songs-table'),
        pageId: 'local',
        title: '',
        subtitle: '',
        showHeader: false,
        songs: slice,
        // 与「我的歌单」详情表格同款：标题列（封面+歌名/艺人两行）、行尾「⋯」菜单（收藏）；
        // 管理模式在行首出现勾选列（支持批量添加/删除）
        columns: manage
            ? ['checkbox', 'index', 'title', 'artist', 'album', 'duration', 'source', 'more']
            : ['index', 'title', 'artist', 'album', 'duration', 'source', 'more'],
        titleCover: (song) => {
            // 内嵌封面优先：本地歌曲（tr- id）经 /api/cover 读取扫描期从音频内嵌提取并落盘的 WebP；
            // 无内嵌封面时后端再回退插件搜索；其余情况直接用插件返回的封面直链
            if (song.id && String(song.id).startsWith('tr-')) {
                return `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(song.id)}`;
            }
            return song.artwork || song.cover || song.coverImg || song.pic || song.coverUrl || '';
        },
        rowMenu: [
            { label: '收藏', onClick: (index) => toggleFavoriteLocal(index) },
            { label: '添加到歌单', onClick: (index) => addLocalToPlaylistByIndex(index) },
            { label: '删除', onClick: (index) => deleteLocalByIndex(index) }
        ],
        indexOffset: 0,
        pagination: null,
        actions: [],
        events: {
            onPlay: (song, index) => playLocalByIndex(index),
            onFavorite: (song, index) => toggleFavoriteLocal(index)
        }
    });
    };
    // 可视化分页请求：只拉当前需要的部分，滚动到底才拉下一页（与第三方客户端分页传输一致）；
    // 搜索态带 q 走后端过滤分页，避免前端一次性持有全量 JSON 撑爆内存。
    SongListLazy.register('local', null, container.querySelector('#local-songs-table'), render, {
        batch: 50, initial: 60,
        fetchPage: makeLocalSongsFetcher(kw),
        fetchKey: 'songs:' + (kw || '') + ':' + localSongsEpoch
    });
}

/** 管理模式：当前勾选的歌曲数（顶部按钮文字用） */
function localSelectedCount() {
    if (typeof SongTable === 'undefined' || !SongTable.getSelectedSongs) return 0;
    return (SongTable.getSelectedSongs('local') || []).length;
}

/** 切换管理模式（页头菜单「管理」/ 工具条「完成」）：按当前标签页重渲染对应视图 */
function toggleLocalManageMode() {
    localManageMode = !localManageMode;
    localCardManageSel.clear();
    if (currentLocalTab === 'artists') {
        renderLocalArtists();
        setupLocalHeader((window.currentLocalArtists || []).length);
    } else if (currentLocalTab === 'albums') {
        renderLocalAlbums();
        setupLocalHeader((window.currentLocalAlbums || []).length);
    } else if (currentLocalTab === 'folders') {
        renderLocalFolderTree();
        setupLocalHeader(window.localSongsTotal || 0);
    } else {
        renderLocalSongs();
    }
}

// ==================== 歌手/专辑卡片管理模式 ====================

// 勾选状态：key = 'artist:<歌手名>' / 'album:<歌手>||<专辑名>'
const localCardManageSel = new Set();
// 当前页可见卡片 key（全选/取消全选用），渲染时更新
let localCardKeys = [];
let localCardKind = 'artist';

function localCardKeyOf(kind, item) {
    return kind === 'artist' ? `artist:${item.name}` : `album:${item.artist}||${item.name}`;
}

function renderLocalCardsCurrent() {
    if (localCardKind === 'artist') renderLocalArtists();
    else renderLocalAlbums();
}

/** 勾选/取消一张卡片 */
function toggleLocalCardSel(key) {
    if (localCardManageSel.has(key)) localCardManageSel.delete(key);
    else localCardManageSel.add(key);
    renderLocalCardsCurrent();
}

/** 全选/取消全选当前页卡片 */
function toggleLocalCardSelectAll() {
    const allSel = localCardKeys.length && localCardKeys.every((k) => localCardManageSel.has(k));
    if (allSel) localCardKeys.forEach((k) => localCardManageSel.delete(k));
    else localCardKeys.forEach((k) => localCardManageSel.add(k));
    renderLocalCardsCurrent();
}

/** 收集勾选的歌手/专辑下的全部歌曲 */
function localCardSelectedSongs() {
    const all = window.currentLocalSongs || [];
    const songs = [];
    for (const k of localCardManageSel) {
        if (k.startsWith('artist:')) {
            const name = k.slice(7);
            songs.push(...all.filter((s) => s.artist === name));
        } else if (k.startsWith('album:')) {
            const sep = k.indexOf('||', 6);
            const artist = k.slice(6, sep);
            const album = k.slice(sep + 2);
            songs.push(...all.filter((s) => s.artist === artist && s.album === album));
        }
    }
    return songs;
}

/** 卡片管理模式：勾选的歌手/专辑歌曲加入歌单 */
function localCardManageAdd() {
    const songs = localCardSelectedSongs();
    if (!songs.length) {
        showToast('请先勾选歌手/专辑', 'warning');
        return;
    }
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal(songs, '本地音乐');
    } else {
        showToast('添加歌单功能未加载', 'error');
    }
}

/** 卡片管理模式：删除勾选的歌手/专辑下全部歌曲文件 */
async function localCardManageDelete() {
    const songs = localCardSelectedSongs();
    if (!songs.length) {
        showToast('请先勾选歌手/专辑', 'warning');
        return;
    }
    if (!window.confirm(`确定删除选中歌手/专辑下的 ${songs.length} 首本地歌曲文件吗？\n文件将从磁盘彻底删除且不可恢复。`)) {
        return;
    }
    try {
        const res = await API.post('/api/music/delete', { ids: songs.map((s) => s.id) });
        if (!res || !res.success) throw new Error((res && res.error) || '删除失败');
        showToast(`已删除 ${res.deleted || songs.length} 首本地歌曲`, 'success');
        localCardManageSel.clear();
        if (typeof loadLocalMusic === 'function') {
            window.localFolderTree = null;
            if (pageId === 'local-folder') localFolderEpoch++;
            localSongsEpoch++;
            loadLocalMusic();
        }
    } catch (e) {
        console.error('删除本地歌曲失败:', e);
        showToast('删除失败: ' + (e && e.message), 'error');
    }
}

/** 卡片管理模式操作条（歌手/专辑主页共用） */
function localCardToolbarHtml() {
    const n = localCardManageSel.size;
    const allSel = localCardKeys.length > 0 && localCardKeys.every((k) => localCardManageSel.has(k));
    return `
        <div class="media-card-toolbar">
            <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                <button class="btn btn-secondary btn-sm" onclick="toggleLocalCardSelectAll()">${allSel ? '取消全选' : '全选'}</button>
                <span style="font-size: 13px; color: var(--text-secondary);"><span style="margin-right: 8px;">💡</span>勾选歌手/专辑后点右侧按钮</span>
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                <button class="btn btn-secondary btn-sm" onclick="localCardManageAdd()">添加到歌单${n ? ` (${n})` : ''}</button>
                <button class="btn btn-danger btn-sm" onclick="localCardManageDelete()">删除${n ? ` (${n})` : ''}</button>
                <button class="btn btn-secondary btn-sm" onclick="toggleLocalManageMode()">完成</button>
            </div>
        </div>`;
}

/** 管理模式：把勾选的歌曲添加到歌单（未勾选则提示） */
function localManageAdd() {
    const sel = (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs)
        ? (SongTable.getSelectedSongs('local') || []) : [];
    if (!sel.length) {
        showToast('请先勾选要添加的歌曲', 'warning');
        return;
    }
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal(sel, '本地音乐');
    } else {
        showToast('添加歌单功能未加载', 'error');
    }
}

// ==================== 歌手/专辑卡片视图 ====================

// 统计用总时长格式化（区别于播放器的 分:秒）：输出「1 小时 23 分 / 45 分 / 30 秒」
function formatTotalDuration(sec) {
    const s = Number(sec) || 0;
    if (s <= 0) return '0 分';
    const totalMin = Math.floor(s / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return `${h} 小时 ${m} 分`;
    if (m > 0) return `${m} 分`;
    return `${Math.floor(s)} 秒`;
}

// 歌手/专辑卡片 html（供 CardListLazy 懒加载渲染，i 为全列表索引）
function localArtistCardHtml(a, i, manage) {
    const key = localCardKeys[i];
    const sel = manage && localCardManageSel.has(key);
    return `
        <div class="local-card"${sel ? ' style="outline: 2px solid var(--primary-color); outline-offset: -2px;"' : ''}
            onclick="${manage ? `toggleLocalCardSel('${localJsString(key)}')` : `openLocalArtist('${localJsString(a.name)}')`}"
            title="${manage ? '勾选 ' + escapeHtml(a.name) : '查看 ' + escapeHtml(a.name) + ' 的歌曲'}">
            ${manage ? `<div style="position: absolute; top: 8px; left: 8px; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; z-index: 2; ${sel ? 'background: var(--primary-color); color: #fff;' : 'background: rgba(0,0,0,0.45); color: transparent; border: 1.5px solid rgba(255,255,255,0.7);'}">✓</div>` : ''}
            <div class="local-card-cover">
                <img id="local-artist-img-${i}" src="${a.artwork ? localCoverUrl(a.artwork) : LOCAL_PLACEHOLDER_SVG}" alt="" loading="lazy" onerror="this.src='${LOCAL_PLACEHOLDER_SVG}'">
                ${manage ? '' : `<button class="media-card-play" title="播放歌手歌曲" onclick="event.stopPropagation(); playLocalArtist('${localJsString(a.name)}')"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>`}
            </div>
            <div class="local-card-name">${escapeHtml(a.name)}</div>
            <div class="local-card-sub">${a.count} 首 · ${a.albumCount || 0} 张专辑 · ${formatTotalDuration(a.duration)}</div>
        </div>`;
}
function localAlbumCardHtml(al, i, manage) {
    const key = localCardKeys[i];
    const sel = manage && localCardManageSel.has(key);
    return `
        <div class="local-card"${sel ? ' style="outline: 2px solid var(--primary-color); outline-offset: -2px;"' : ''}
            onclick="${manage ? `toggleLocalCardSel('${localJsString(key)}')` : `openLocalAlbum('${localJsString(al.artist)}','${localJsString(al.name)}')`}"
            title="${manage ? '勾选专辑「' + escapeHtml(al.name) + '」' : '查看专辑「' + escapeHtml(al.name) + '」'}">
            ${manage ? `<div style="position: absolute; top: 8px; left: 8px; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; z-index: 2; ${sel ? 'background: var(--primary-color); color: #fff;' : 'background: rgba(0,0,0,0.45); color: transparent; border: 1.5px solid rgba(255,255,255,0.7);'}">✓</div>` : ''}
            <div class="local-card-cover">
                <img id="local-album-img-${i}" src="${al.artwork ? localCoverUrl(al.artwork) : LOCAL_PLACEHOLDER_SVG}" alt="" loading="lazy" onerror="this.src='${LOCAL_PLACEHOLDER_SVG}'">
                ${manage ? '' : `<button class="media-card-play" title="播放专辑" onclick="event.stopPropagation(); playLocalAlbum('${localJsString(al.artist)}','${localJsString(al.name)}')"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>`}
            </div>
            <div class="local-card-name">${escapeHtml(al.name)}</div>
            <div class="local-card-sub">${escapeHtml(al.artist)} · ${al.count} 首 · ${formatTotalDuration(al.duration)}</div>
        </div>`;
}

// 歌手/专辑详情视图状态：null=网格列表视图；非 null=进入详情页
let localArtistDetail = null;   // 当前查看的歌手名
let localAlbumDetail = null;    // 当前查看的专辑 { artist, name }

async function renderLocalArtistDetail(container, name) {
    container.innerHTML = '<div class="empty-state" style="padding:40px 20px;text-align:center;color:var(--text-tertiary);">加载中…</div>';
    const songs = await fetchLocalSongsByArtist(name);
    window.localDetailSongs = songs;
    renderLocalDetail(container, 'artist', name, '', songs);
}
async function renderLocalAlbumDetail(container, artist, name) {
    container.innerHTML = '<div class="empty-state" style="padding:40px 20px;text-align:center;color:var(--text-tertiary);">加载中…</div>';
    const songs = await fetchLocalSongsByAlbum(artist, name);
    window.localDetailSongs = songs;
    renderLocalDetail(container, 'album', name, artist, songs);
}

function renderLocalArtists() {
    const container = document.getElementById('local-artists-tab');
    if (!container) return;
    const artists = (window.currentLocalArtists || []).filter(a => localTextMatches(a.name, localSearchKeyword));

    // 详情视图：点击歌手进入后异步拉取该歌手全部歌曲（后端 ?artist= 过滤，非全量依赖）
    if (localArtistDetail) {
        renderLocalArtistDetail(container, localArtistDetail);
        return;
    }

    if (!artists.length) {
        container.innerHTML = emptyLocalHtml(localSearchKeyword ? '未找到匹配的歌手' : '暂无歌手');
        return;
    }
    // 管理模式：勾选卡片批量操作（分页栏已移除，全量渲染）
    const manage = localManageMode;
    localCardKind = 'artist';
    localCardKeys = artists.map((a) => localCardKeyOf('artist', a));
    container.innerHTML = `
        ${manage ? localCardToolbarHtml() : ''}
        <div style="height: 100%; display: flex; flex-direction: column;">
            <div id="local-artists-grid" class="local-card-grid" style="flex: 1; overflow-y: auto; min-height: 0;"></div>
        </div>`;
    // 卡片网格懒加载：只渲染当前可见卡片，滚动到底追加（i 仍为全列表索引，不影响收藏/播放索引）
    CardListLazy.register({
        key: 'local-artists',
        songs: artists,
        getGrid: () => document.getElementById('local-artists-grid'),
        cardHtml: (a, i) => localArtistCardHtml(a, i, manage),
        batch: 36,
        initial: 60,
        scroller: document.getElementById('local-artists-grid')
    });

    // 封面补图由后端单并发队列后台渐进完成，此处不逐卡联网回源（避免数百并发打崩服务器）。
    // 已落库头像由 /api/music/artists 的 artwork（art/ 本地静态）直接显示，无则占位。
}

function renderLocalAlbums() {
    const container = document.getElementById('local-albums-tab');
    if (!container) return;
    const albums = (window.currentLocalAlbums || []).filter(al => localTextMatches(`${al.name} ${al.artist || ''}`, localSearchKeyword));

    // 详情视图：点击专辑进入后异步拉取该专辑全部歌曲（后端 ?album=&artist= 过滤）
    if (localAlbumDetail) {
        renderLocalAlbumDetail(container, localAlbumDetail.artist, localAlbumDetail.name);
        return;
    }

    if (!albums.length) {
        container.innerHTML = emptyLocalHtml(localSearchKeyword ? '未找到匹配的专辑' : '暂无专辑');
        return;
    }
    // 管理模式：勾选卡片批量操作（分页栏已移除，全量渲染）
    const manage = localManageMode;
    localCardKind = 'album';
    localCardKeys = albums.map((al) => localCardKeyOf('album', al));
    container.innerHTML = `
        ${manage ? localCardToolbarHtml() : ''}
        <div style="height: 100%; display: flex; flex-direction: column;">
            <div id="local-albums-grid" class="local-card-grid" style="flex: 1; overflow-y: auto; min-height: 0;"></div>
        </div>`;
    // 卡片网格懒加载：只渲染当前可见卡片，滚动到底追加（i 仍为全列表索引，不影响收藏/播放索引）
    CardListLazy.register({
        key: 'local-albums',
        songs: albums,
        getGrid: () => document.getElementById('local-albums-grid'),
        cardHtml: (al, i) => localAlbumCardHtml(al, i, manage),
        batch: 36,
        initial: 60,
        scroller: document.getElementById('local-albums-grid')
    });

    // 封面补图由后端单并发队列后台渐进完成，此处不逐卡联网回源（避免数百并发打崩服务器）。
    // artwork 由 /api/music/albums 提供（album-real 本地静态），无则占位，后台补好后刷新即有。
}

// ==================== 歌手/专辑详情页 ====================

// 详情页管理模式（勾选歌曲批量添加到歌单/删除，参考歌单详情）
let localDetailManageMode = false;

/**
 * 切换详情页管理模式：出现勾选列，Hero 显示批量操作按钮（添加到歌单/删除/完成）
 * @param {'artist'|'album'} type
 */
function toggleLocalDetailManageMode(type) {
    localDetailManageMode = !localDetailManageMode;
    if (type === 'artist') {
        renderLocalArtists();
    } else {
        renderLocalAlbums();
    }
}
window.toggleLocalDetailManageMode = toggleLocalDetailManageMode;

/** 顶部「⋯」管理菜单：展开/收起（同我的歌单详情页） */
function toggleLocalDetailMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('local-detail-menu');
    if (!menu) return;
    const willOpen = menu.style.display !== 'block';
    menu.style.display = willOpen ? 'block' : 'none';
    if (willOpen) {
        setTimeout(() => document.addEventListener('click', closeLocalDetailMenu), 0);
    } else {
        document.removeEventListener('click', closeLocalDetailMenu);
    }
}

function closeLocalDetailMenu() {
    const menu = document.getElementById('local-detail-menu');
    if (menu) menu.style.display = 'none';
    document.removeEventListener('click', closeLocalDetailMenu);
}
window.toggleLocalDetailMenu = toggleLocalDetailMenu;
window.closeLocalDetailMenu = closeLocalDetailMenu;

/** 渲染歌手/专辑详情页（歌单详情同款：页头返回 + Hero(随机/播放) + 歌曲表格） */
async function renderLocalDetail(container, type, title, subtitle, songs) {
    const pageId = type === 'artist' ? 'local-artist-detail' : 'local-album-detail';
    const typeLabel = type === 'artist' ? '歌手' : '专辑';
    // 详情页头部统计：歌曲数、总时长（歌手额外显示专辑去重数）
    const totalDur = songs.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
    const albumCnt = type === 'artist' ? new Set(songs.map((s) => s.album).filter(Boolean)).size : 0;
    const statText = type === 'artist'
        ? `${songs.length} 首歌曲 · ${albumCnt} 张专辑 · ${formatTotalDuration(totalDur)}`
        : `${songs.length} 首歌曲 · ${formatTotalDuration(totalDur)}`;

    // 页头：返回箭头最左 + 菜单按钮 + 标题居中 + 右侧「⋯」管理菜单（参考我的歌单详情页）
    const headerLeft = document.getElementById('header-left');
    if (headerLeft) {
        headerLeft.style.position = 'relative';
        headerLeft.innerHTML = `
            <button class="mobile-menu-btn" onclick="toggleMobileSidebar()" aria-label="打开菜单">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="3" y1="12" x2="21" y2="12"></line>
                    <line x1="3" y1="6" x2="21" y2="6"></line>
                    <line x1="3" y1="18" x2="21" y2="18"></line>
                </svg>
            </button>
            <button type="button" class="btn-back" title="返回" onclick="closeLocalDetail('${type}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
            </button>
            <span class="header-title" id="page-title" style="position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); margin: 0;">${type === 'artist' ? `歌手（${(window.currentLocalArtists || []).length}）` : `专辑（${(window.currentLocalAlbums || []).length}）`}</span>
        `;
    }
    // 右侧「⋯」按钮 + 下拉管理菜单（同我的歌单详情页顶部）
    const headerActions = document.getElementById('header-actions');
    if (headerActions) {
        headerActions.querySelectorAll('.local-detail-more').forEach((el) => el.remove());
        const wrap = document.createElement('div');
        wrap.className = 'local-detail-more';
        wrap.style.cssText = 'position: relative; display: flex; align-items: center;';
        wrap.innerHTML = `
            <button type="button" title="更多" onclick="event.stopPropagation(); toggleLocalDetailMenu(event)"
                class="header-icon-btn">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
            </button>
            <div id="local-detail-menu"
                style="display: none; position: absolute; right: 0; top: calc(100% + 6px); min-width: 150px; background: var(--surface-color); border: 1px solid var(--divider-color); border-radius: 10px; box-shadow: var(--shadow-lg); z-index: 1002; padding: 6px 0; overflow: hidden;">
                <button type="button" onclick="event.stopPropagation(); closeLocalDetailMenu(); toggleLocalDetailManageMode('${type}');"
                    style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">${localDetailManageMode ? '完成管理' : '管理'}</button>
            </div>`;
        headerActions.appendChild(wrap);
    }

    // 详情模式：隐藏标签栏和搜索框（返回列表时在 closeLocalDetail 恢复）
    const localHeaderBar = document.querySelector('#page-local .local-music-header');
    if (localHeaderBar) localHeaderBar.style.display = 'none';

    container.innerHTML = `
        <div class="local-detail" style="height: 100%; display: flex; flex-direction: column;">
            <div id="${pageId}-songs" class="local-detail-songs" style="height: 100%;"></div>
        </div>`;

    const songsContainer = document.getElementById(`${pageId}-songs`);
    if (!songs.length) {
        songsContainer.innerHTML = `<div class="empty-state" style="padding: 40px 20px; text-align: center; color: var(--text-tertiary);">该${typeLabel}下没有歌曲</div>`;
        return;
    }
    if (typeof SongTable === 'undefined') {
        songsContainer.innerHTML = '<div class="empty-state">歌曲表格组件未加载</div>';
        return;
    }
    // 多选模式标记：手机端据此显示勾选列（复用歌单详情 mobile.css 样式）
    songsContainer.classList.toggle('playlist-detail-manage', localDetailManageMode);

    // 封面：内嵌封面优先（tr- id 走 /api/cover），否则用扫描期补全的歌手/专辑封面
    const firstCover = songs.find((s) => s.artwork || s.cover || s.coverImg || s.pic || s.coverUrl) || {};
    const heroCover = firstCover.artwork || firstCover.cover || firstCover.coverImg || firstCover.pic || firstCover.coverUrl
        || (songs[0] && songs[0].id ? `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(songs[0].id)}` : '');

    // 管理模式下已勾选数量（按钮文字实时显示）
    const selCount = (typeof SongTable.getSelectedSongs === 'function') ? (SongTable.getSelectedSongs(pageId) || []).length : 0;
    // 管理模式批量添加到歌单：用勾选歌曲弹窗
    const manageAddSelected = () => {
        const sel = (SongTable.getSelectedSongs && SongTable.getSelectedSongs(pageId)) || [];
        const sourceName = type === 'artist' ? (localArtistDetail || '歌手') : (localAlbumDetail ? localAlbumDetail.name : '专辑');
        if (sel.length && typeof showAddToPlaylistModal === 'function') {
            showAddToPlaylistModal(sel, sourceName);
        } else {
            addLocalDetailToPlaylist(type);
        }
    };

    const render = (slice) => {
    SongTable.render({
        container: songsContainer,
        pageId,
        title: '',
        showHeader: false,
        songs: slice,
        // 与「我的歌单」详情同款：Hero 头部 + 歌单式列结构（封面+歌名/艺人两行、行尾「⋯」菜单）
        // 普通模式按钮行只有随机+播放；管理模式出现勾选列 + 添加到歌单/删除/完成
        hero: {
            cover: heroCover,
            title,
            meta: subtitle ? `${subtitle} · ${statText}` : statText,
            ...(localDetailManageMode ? {} : { onRandom: `playLocalDetailRandom('${type}')` })
        },
        columns: localDetailManageMode
            ? ['checkbox', 'index', 'title', 'artist', 'album', 'duration', 'source', 'favorite', 'more']
            : ['index', 'title', 'artist', 'album', 'duration', 'source', 'favorite', 'more'],
        titleCover: (song) => {
            // 内嵌封面优先：本地歌曲（tr- id）经 /api/cover 读取内嵌 WebP
            if (song.id && String(song.id).startsWith('tr-')) {
                return `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(song.id)}`;
            }
            // 网络歌曲后端已剥离外链，仅剩虚拟封面 ID（coverArt），走 /api/cover 实时解析
            const coverId = song.coverArt || song.virtualId
                || (typeof song.id === 'string' && song.id.startsWith('remote__') ? song.id : null);
            return song.artwork || song.cover || song.coverImg || song.pic || song.coverUrl
                || (coverId ? `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(coverId)}` : '');
        },
        // 收藏已移出行菜单：作为独立心形按钮显示在「⋯」前（favorite 列，点击走 events.onFavorite）
        rowMenu: [
            { label: '添加到歌单', onClick: (index) => addLocalDetailToPlaylist(type, index) },
            { label: '删除', onClick: (index) => deleteLocalSongs(pageId, index) }
        ],
        actions: localDetailManageMode ? [
            {
                id: 'manage-add', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
                text: `添加到歌单${selCount ? ` (${selCount})` : ''}`, primary: false, disabled: !songs.length, onClick: manageAddSelected
            },
            {
                id: 'manage-delete', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
                text: `删除${selCount ? ` (${selCount})` : ''}`, primary: false, disabled: !songs.length, onClick: () => deleteLocalSongs(pageId)
            },
            { id: 'manage-done', icon: '', text: '完成', primary: true, onClick: () => toggleLocalDetailManageMode(type) }
        ] : [
            { id: 'play', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>', text: '播放', primary: true, disabled: !songs.length, onClick: () => playLocalDetail(type, 0) }
        ],
        events: {
            onPlay: (song, index) => playLocalDetail(type, index),
            onFavorite: (song, index) => toggleLocalDetailFavorite(type, index),
            onSelectChange: (selectedIndices) => {
                const el = document.querySelector(`[data-page-id="${pageId}"]`);
                if (el) {
                    el.querySelectorAll('tbody tr').forEach((row, idx) => {
                        row.classList.toggle('selected', selectedIndices.includes(idx));
                    });
                }
            }
        }
    });
    };
    // 懒加载：只渲染当前可见歌曲，滚动到底追加下一批
    SongListLazy.register(pageId, songs, songsContainer, render, { batch: 50, initial: 60 });

    // 手机端通栏兜底：渲染完成后直接内联设置扩展样式（不依赖 mobile.css 的加载/缓存时机）
    // 与「我的歌单」详情完全一致：染色铺到页头后 + 左右通栏 + 图片距页头 1px
    if (window.innerWidth <= 768) {
        const detailPage = songsContainer.querySelector('.playlist-detail');
        const area = detailPage && detailPage.closest('.content-area');
        if (detailPage && area) {
            // 1) 解除 detail 与 content-area 之间所有祖先的裁剪（overflow 会让负 margin 扩展被裁掉）
            for (let n = detailPage.parentElement; n && n !== area; n = n.parentElement) {
                n.style.overflow = 'visible';
            }
            // 2) 通栏 + 顶部扩展（数值实时测量，自动适配各断点边距）
            const px = parseFloat(getComputedStyle(area).paddingLeft) || 0;
            const topGap = Math.max(0, Math.round(detailPage.getBoundingClientRect().top - area.getBoundingClientRect().top));
            detailPage.style.marginLeft = -px + 'px';
            detailPage.style.marginRight = -px + 'px';
            detailPage.style.paddingLeft = px + 'px';
            detailPage.style.paddingRight = px + 'px';
            detailPage.style.marginTop = -topGap + 'px';
            detailPage.style.paddingTop = topGap + 'px';
            // 撑满整屏：歌曲少时染色渐变也铺到底部播放条（不露出纯底色）
            detailPage.style.minHeight = '100dvh';
            // 3) Hero 左右通栏 + 顶部距页头 1px
            const heroEl = detailPage.querySelector('.playlist-hero');
            if (heroEl) {
                heroEl.style.marginLeft = -px + 'px';
                heroEl.style.marginRight = -px + 'px';
                heroEl.style.marginTop = (-topGap + 1) + 'px';
            }
        }
    }
}

/** 随机播放当前歌手/专辑详情的一首歌（Hero 随机按钮） */
function playLocalDetailRandom(type) {
    const songs = getLocalDetailSongs(type);
    if (!songs.length) {
        showToast('列表为空', 'warning');
        return;
    }
    // 播放器随机按钮自动打开
    if (typeof enableShuffleMode === 'function') enableShuffleMode();
    ensureLocalPlugin(songs[0]);
    const idx = Math.floor(Math.random() * songs.length);
    setCurrentPageMusicList(songs);
    playMusic(idx);
}
window.playLocalDetailRandom = playLocalDetailRandom;

/** 获取当前详情页的歌曲列表 */
function getLocalDetailSongs(type) {
    return window.localDetailSongs || [];
}

/** 进入歌手详情 */
function openLocalArtist(name) {
    localArtistDetail = name;
    renderLocalArtists();
}

/** 进入专辑详情 */
function openLocalAlbum(artist, name) {
    localAlbumDetail = { artist, name };
    renderLocalAlbums();
}

/** 返回歌手/专辑列表 */
function closeLocalDetail(type) {
    // 退出多选管理模式
    localDetailManageMode = false;
    if (type === 'artist') {
        localArtistDetail = null;
        renderLocalArtists();
    } else {
        localAlbumDetail = null;
        renderLocalAlbums();
    }
    // 恢复本地音乐标准页头（退出详情页页头样式，并清理详情页顶部「⋯」菜单）
    closeLocalDetailMenu();
    document.querySelectorAll('.local-detail-more').forEach((el) => el.remove());
    // 恢复标签栏和搜索框（详情模式曾隐藏）
    const localHeaderBar = document.querySelector('#page-local .local-music-header');
    if (localHeaderBar) localHeaderBar.style.display = '';
    setupLocalHeader((window.currentLocalSongs || []).length);
}

/** 播放详情页歌曲（以详情歌曲列表为播放列表） */
function playLocalDetail(type, index) {
    const songs = getLocalDetailSongs(type);
    const song = songs[index];
    if (!song) return;
    ensureLocalPlugin(song);
    if (!song.filePath) {
        showToast('本地歌曲缺少文件路径，无法播放', 'error');
        return;
    }
    setCurrentPageMusicList(songs);
    playMusic(index);
}

/** 收藏详情页歌曲 */
async function toggleLocalDetailFavorite(type, index) {
    const songs = getLocalDetailSongs(type);
    const song = songs[index];
    if (!song) return;
    ensureLocalPlugin(song);
    await toggleLocalFavorite(song);
}

/** 将详情页歌曲添加到歌单（支持单首：传入行索引） */
function addLocalDetailToPlaylist(type, index) {
    let songs = getLocalDetailSongs(type);
    if (typeof index === 'number') {
        const one = songs[index];
        if (!one) return;
        songs = [one];
    }
    if (!songs.length) {
        showToast('当前列表没有歌曲', 'warning');
        return;
    }
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal(songs, type === 'artist' ? (localArtistDetail || '歌手') : (localAlbumDetail ? localAlbumDetail.name : '专辑'));
    } else {
        showToast('添加歌单功能未加载', 'error');
    }
}

// ==================== 文件夹视图（左目录树 + 右文件列表）====================

// 当前选中目录（相对路径，'' 表示根目录）
let localSelectedFolder = '';

/**
 * 从歌曲列表 + 完整目录列表构建目录树
 * 先按真实目录（含空目录）创建所有节点，再把歌曲归入所属目录
 * @param {Array} songs - 全部本地歌曲（含 folder 相对路径）
 * @param {Array} dirs - 全部子目录相对路径（含空目录）
 * @returns {Object} 根节点 { path, name, children, songs, _expanded }
 */
function buildLocalFolderTree(songs, dirs) {
    const root = { path: '', name: '', children: [], songs: [], _expanded: true };
    const nodeMap = new Map([['', root]]);

    // 确保某目录路径上的所有层级节点存在，返回该目录节点路径
    const ensureNode = (rel) => {
        const parts = rel ? rel.split('/') : [];
        let cur = '';
        parts.forEach(seg => {
            const childPath = cur ? `${cur}/${seg}` : seg;
            let node = nodeMap.get(childPath);
            if (!node) {
                node = { path: childPath, name: seg, children: [], songs: [], _expanded: false };
                nodeMap.set(childPath, node);
                nodeMap.get(cur).children.push(node);
            }
            cur = childPath;
        });
        return cur;
    };

    // 1. 先创建所有真实目录节点（含空目录，字母顺序来自后端排序）
    (dirs || []).forEach(rel => ensureNode(rel));

    // 2. 归入歌曲：当前单曲列表为分页累积（非全量），目录树不再把歌曲对象挂到节点，
    //    歌曲数据由各目录视图经后端 ?folder= 按需拉取（见 renderLocalFolderMain），
    //    这里仅保留目录层级结构即可（node.songs 恒为空，树计数不再依赖全量歌曲）。

    // 排序：文件夹、歌曲均按名称（拼音）排序
    const sortNode = (node) => {
        node.children.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        node.songs.sort((a, b) => (a.fileName || '').localeCompare(b.fileName || '', 'zh'));
        node.children.forEach(sortNode);
    };
    sortNode(root);
    return root;
}

/** 按相对路径查找树节点 */
function findLocalFolderNode(path) {
    const walk = (node) => {
        if (node.path === path) return node;
        for (const c of node.children) {
            const hit = walk(c);
            if (hit) return hit;
        }
        return null;
    };
    return window.localFolderTree ? walk(window.localFolderTree) : null;
}

/** 渲染目录视图整体布局（左侧资源管理器式目录树 + 右侧文件列表） */
function renderLocalFolderTree() {
    const container = document.getElementById('local-folders-tab');
    if (!container) return;

    if (!window.localFolderTree) {
        window.localFolderTree = buildLocalFolderTree(window.currentLocalSongs || [], window.currentLocalDirs || []);
    }

    container.innerHTML = `
        <div class="local-folder-layout">
            <div class="local-folder-sidebar" id="local-folder-sidebar"></div>
            <div class="local-folder-main" id="local-folder-main"></div>
        </div>`;

    renderLocalFolderSidebar();
    renderLocalFolderMain();
}

/** 渲染左侧目录树（Windows 资源管理器风格：展开箭头 + 文件夹图标 + 名称 + 歌曲数） */
function renderLocalFolderSidebar() {
    const side = document.getElementById('local-folder-sidebar');
    if (!side || !window.localFolderTree) return;
    side.innerHTML = `<div class="local-tree">${folderTreeNodeHtml(window.localFolderTree, 0, true)}</div>`;
}

/** 递归生成目录树节点 HTML（展开状态存于节点 _expanded，重渲染不丢失） */
function folderTreeNodeHtml(node, depth, isRoot) {
    const hasChildren = node.children && node.children.length > 0;
    const expanded = isRoot ? true : !!node._expanded;
    const selected = localSelectedFolder === node.path;
    const caretIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
    const folderIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    const safePath = localJsString(node.path);

    let html = `
        <div class="local-tree-node${selected ? ' selected' : ''}" data-path="${escapeHtml(node.path)}">
            <div class="local-tree-row" style="padding-left:${6 + depth * 14}px" onclick="selectLocalFolder('${safePath}')" title="${escapeHtml(isRoot ? '音乐库（根目录）' : node.name)}">
                ${hasChildren
                    ? `<span class="local-tree-caret${expanded ? ' expanded' : ''}" onclick="event.stopPropagation(); toggleLocalFolderExpand('${safePath}')">${caretIcon}</span>`
                    : '<span class="local-tree-caret placeholder"></span>'}
                <span class="local-tree-folder-icon">${folderIcon}</span>
                <span class="local-tree-name">${escapeHtml(isRoot ? '音乐库' : node.name)}</span>
                ${node.songs.length ? `<span class="local-tree-count">${node.songs.length}</span>` : ''}
            </div>
            ${expanded && hasChildren
                ? `<div class="local-tree-children">${node.children.map(c => folderTreeNodeHtml(c, depth + 1, false)).join('')}</div>`
                : ''}
        </div>`;
    return html;
}

/** 展开/收起目录树节点（只重渲染左树，不影响右侧列表滚动） */
function toggleLocalFolderExpand(path) {
    const node = findLocalFolderNode(path);
    if (!node) return;
    node._expanded = !node._expanded;
    renderLocalFolderSidebar();
}

/** 选中目录时展开其所有祖先节点，保证树路径可见 */
function expandLocalFolderAncestors(path) {
    if (!path || !window.localFolderTree) return;
    let cur = '';
    path.split('/').forEach(seg => {
        cur = cur ? `${cur}/${seg}` : seg;
        const node = findLocalFolderNode(cur);
        if (node) node._expanded = true;
    });
}

/** 当前选中目录在目录树中的节点（未选择时为根） */
function currentFolderNode() {
    if (!window.localFolderTree) return null;
    if (!localSelectedFolder) return window.localFolderTree;
    return findLocalFolderNode(localSelectedFolder);
}

/** 选中目录：展开祖先链、重置到第一页，刷新左树高亮与右侧列表 */
function selectLocalFolder(path) {
    localSelectedFolder = path || '';
    localFolderPage = 1;
    expandLocalFolderAncestors(localSelectedFolder);
    renderLocalFolderSidebar();
    renderLocalFolderMain();
}

/** 递归收集目录节点及其所有子目录下的歌曲（按文件名排序，保证展示与播放列表一致） */
function collectLocalFolderSongs(node) {
    if (!node) return [];
    const songs = [...node.songs];
    (node.children || []).forEach(c => songs.push(...collectLocalFolderSongs(c)));
    songs.sort((a, b) => (a.fileName || '').localeCompare(b.fileName || '', 'zh'));
    return songs;
}

/** 当前目录视图已加载的歌曲列表（含子目录，由后端 ?folder= 分页累积，与右侧表格/播放列表一致） */
function localFolderSongs() {
    return window.localFolderSongsLoaded || [];
}

/** 渲染右侧文件列表（当前选中目录及其子目录的全部歌曲，与单曲视图同款表格 + 管理模式） */
function renderLocalFolderMain() {
    const main = document.getElementById('local-folder-main');
    if (!main) return;

    const node = findLocalFolderNode(localSelectedFolder);
    const hasSubFolders = !!(node && node.children && node.children.length);
    const pathText = localSelectedFolder || '音乐库（根目录）';
    const manage = localManageMode;
    const folder = localSelectedFolder || '';
    const start = 0;

    main.innerHTML = `
        ${manage ? `
        <div class="media-card-toolbar">
            <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                <span style="font-size: 13px; color: var(--text-secondary);"><span style="margin-right: 8px;">💡</span>勾选歌曲后点右侧按钮</span>
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                <button class="btn btn-secondary btn-sm" onclick="localFolderManageAdd()">添加到歌单${localFolderSelectedCount() ? ` (${localFolderSelectedCount()})` : ''}</button>
                <button class="btn btn-danger btn-sm" onclick="deleteLocalSongs('local-folder')">删除${localFolderSelectedCount() ? ` (${localFolderSelectedCount()})` : ''}</button>
                <button class="btn btn-secondary btn-sm" onclick="toggleLocalManageMode()">完成</button>
            </div>
        </div>` : ''}
        <div class="local-folder-current">
            <span class="local-folder-current-path">${escapeHtml(pathText)}</span>
            <span class="local-folder-current-count">加载中…</span>
        </div>
        <div id="local-folder-songs" class="${manage ? 'playlist-detail-manage' : ''}"></div>`;

    const songsContainer = document.getElementById('local-folder-songs');
    if (typeof SongTable === 'undefined') {
        songsContainer.innerHTML = '<div class="empty-state">歌曲表格组件未加载</div>';
        return;
    }
    const render = (slice) => {
        window.localFolderSongsLoaded = slice;
    SongTable.render({
        container: songsContainer,
        pageId: 'local-folder',
        title: '',
        showHeader: false,
        songs: slice,
        // 与单曲视图同款：标题列（封面+歌名/艺人两行）、行尾「⋯」菜单；管理模式在行首出现勾选列
        columns: manage
            ? ['checkbox', 'index', 'title', 'artist', 'album', 'duration', 'source', 'more']
            : ['index', 'title', 'artist', 'album', 'duration', 'source', 'more'],
        titleCover: (song) => {
            // 内嵌封面优先：本地歌曲（tr- id）经 /api/cover 读取内嵌 WebP
            if (song.id && String(song.id).startsWith('tr-')) {
                return `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(song.id)}`;
            }
            // 网络歌曲后端已剥离外链，仅剩虚拟封面 ID（coverArt），走 /api/cover 实时解析
            const coverId = song.coverArt || song.virtualId
                || (typeof song.id === 'string' && song.id.startsWith('remote__') ? song.id : null);
            return song.artwork || song.cover || song.coverImg || song.pic || song.coverUrl
                || (coverId ? `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(coverId)}` : '');
        },
        rowMenu: [
            { label: '收藏', onClick: (index) => toggleLocalFolderFavorite(start + index) },
            { label: '添加到歌单', onClick: (index) => addLocalFolderToPlaylistByIndex(start + index) },
            { label: '删除', onClick: (index) => deleteLocalSongs('local-folder', start + index) }
        ],
        indexOffset: start,
        actions: [],
        events: {
            // 表格拿到的是当前页切片，索引换算回目录全量歌曲列表
            onPlay: (song, index) => playLocalFolderByIndex(start + index),
            onFavorite: (song, index) => toggleLocalFolderFavorite(start + index),
            onSelectChange: (selectedIndices) => {
                const el = document.querySelector('[data-page-id="local-folder"]');
                if (el) {
                    el.querySelectorAll('tbody tr').forEach((row, idx) => {
                        row.classList.toggle('selected', selectedIndices.includes(idx));
                    });
                }
            }
        }
    });
    };
    // 可视化分页请求：只拉当前目录及子目录的歌曲，滚动到底才拉下一页（与第三方分页传输一致）
    SongListLazy.register('local-folder', null, songsContainer, render, {
        batch: 50, initial: 60,
        fetchPage: makeLocalFolderFetcher(folder),
        fetchKey: 'folder:' + folder + ':' + localFolderEpoch
    });
}

/** 管理模式：当前勾选的歌曲数（目录视图操作条按钮文字用） */
function localFolderSelectedCount() {
    if (typeof SongTable === 'undefined' || !SongTable.getSelectedSongs) return 0;
    return (SongTable.getSelectedSongs('local-folder') || []).length;
}

/** 管理模式：目录视图勾选歌曲加入歌单 */
function localFolderManageAdd() {
    const sel = (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs)
        ? (SongTable.getSelectedSongs('local-folder') || []) : [];
    if (!sel.length) {
        showToast('请先勾选要添加的歌曲', 'warning');
        return;
    }
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal(sel, localSelectedFolder || '音乐库');
    } else {
        showToast('添加歌单功能未加载', 'error');
    }
}

/** 单首添加到歌单（目录视图行内「⋯」菜单） */
function addLocalFolderToPlaylistByIndex(index) {
    const song = localFolderSongs()[index];
    if (!song) return;
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal([song], localSelectedFolder || '音乐库');
    } else {
        showToast('添加歌单功能未加载', 'error');
    }
}

/** 播放当前目录的歌曲（优先播放勾选歌曲，否则播放全部） */
function playLocalFolderAll() {
    const songs = localFolderSongs(); // 含子目录的全部歌曲，与表格展示一致
    let selectedSongs = [];
    if (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs) {
        selectedSongs = SongTable.getSelectedSongs('local-folder');
    }
    const songsToPlay = selectedSongs.length > 0 ? selectedSongs : songs;
    playLocalList(songsToPlay);
}

/** 将当前目录歌曲添加到歌单（优先勾选歌曲，否则含子目录全部） */
function addLocalFolderToPlaylist() {
    const songs = localFolderSongs(); // 含子目录的全部歌曲，与表格展示一致
    let selectedSongs = [];
    if (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs) {
        selectedSongs = SongTable.getSelectedSongs('local-folder');
    }
    const songsToAdd = selectedSongs.length > 0 ? selectedSongs : songs;
    if (!songsToAdd.length) {
        showToast('当前列表没有歌曲', 'warning');
        return;
    }
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal(songsToAdd, localSelectedFolder || '音乐库');
    } else {
        showToast('添加歌单功能未加载', 'error');
    }
}

/** 播放右侧列表中的歌曲（以当前目录歌曲为播放列表） */
function playLocalFolderByIndex(index) {
    const songs = localFolderSongs(); // 含子目录的全部歌曲，与表格展示一致
    const song = songs[index];
    if (!song) return;
    ensureLocalPlugin(song);
    if (!song.filePath) {
        showToast('本地歌曲缺少文件路径，无法播放', 'error');
        return;
    }
    setCurrentPageMusicList(songs);
    playMusic(index);
}

/** 收藏右侧列表中的歌曲 */
async function toggleLocalFolderFavorite(index) {
    const songs = localFolderSongs(); // 含子目录的全部歌曲，与表格展示一致
    const song = songs[index];
    if (!song) return;
    ensureLocalPlugin(song);
    await toggleLocalFavorite(song);
}

// ==================== 播放控制 ====================

function ensureLocalPlugin(song) {
    if (!song.plugin) song.plugin = 'local';
    return song;
}

function playLocalByIndex(index) {
    const songs = localFilteredSongs();
    const song = songs[index];
    if (!song) return;
    ensureLocalPlugin(song);
    if (!song.filePath) {
        showToast('本地歌曲缺少文件路径，无法播放', 'error');
        return;
    }
    setCurrentPageMusicList(songs);
    playMusic(index);
}

function playAllLocal() {
    const allSongs = localFilteredSongs();
    let selectedSongs = [];
    if (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs) {
        selectedSongs = SongTable.getSelectedSongs('local');
    }
    const songsToPlay = selectedSongs.length > 0 ? selectedSongs : allSongs;
    playLocalList(songsToPlay);
}

function playLocalList(songsToPlay) {
    if (!songsToPlay || !songsToPlay.length) {
        showToast('没有可播放的歌曲', 'warning');
        return;
    }
    songsToPlay.forEach(ensureLocalPlugin);
    const first = songsToPlay[0];
    if (!first.filePath) {
        showToast('本地歌曲缺少文件路径，无法播放', 'error');
        return;
    }
    window.currentPageMusicList = songsToPlay;
    playMusic(0);
    if (songsToPlay.length > 1 && typeof addToPlaylist === 'function') {
        addToPlaylist(songsToPlay.slice(1));
    }
    showToast(`开始播放 ${songsToPlay.length} 首歌曲`, 'success');
}

/** 播放指定歌手的全部歌曲 */
async function playLocalArtist(name) {
    const songs = await fetchLocalSongsByArtist(name);
    playLocalList(songs);
}

/** 播放指定专辑的全部歌曲 */
async function playLocalAlbum(artist, name) {
    const songs = await fetchLocalSongsByAlbum(artist, name);
    playLocalList(songs);
}

// ==================== 收藏 ====================

async function toggleFavoriteLocal(index) {
    const songs = localFilteredSongs();
    const song = songs[index];
    if (!song) return;
    ensureLocalPlugin(song);
    await toggleLocalFavorite(song);
}

async function toggleLocalFavorite(song) {
    const plugin = 'local';
    const isFavorited = typeof isSongFavoritedSync === 'function' && isSongFavoritedSync(song.id, plugin);
    try {
        if (isFavorited) {
            const result = await API.myFavorites.remove(song.id, plugin);
            if (result.success) {
                showToast('已取消收藏', 'success');
                if (typeof removeFromFavoritesCache === 'function') removeFromFavoritesCache(song.id, plugin);
                if (typeof emitFavoriteChange === 'function') emitFavoriteChange(song.id, plugin, false, song);
            }
        } else {
            const result = await API.myFavorites.add(song, plugin);
            if (result.success) {
                showToast('已添加到收藏', 'success');
                if (typeof addToFavoritesCache === 'function') addToFavoritesCache(song.id, plugin);
                if (typeof emitFavoriteChange === 'function') emitFavoriteChange(song.id, plugin, true, song);
            }
        }
        if (typeof SongTable !== 'undefined' && SongTable.updateAllPlayingState) {
            SongTable.updateAllPlayingState();
        }
        // 局部刷新收藏图标，不整体重载（保留文件夹树展开状态与详情页状态）
        renderLocalSongs();
        renderLocalArtists();
        renderLocalAlbums();
        renderLocalFolderTree();
    } catch (error) {
        console.error('切换收藏状态失败:', error);
        showToast('操作失败: ' + error.message, 'error');
    }
}

// ==================== 添加到歌单 ====================

function addAllLocalToPlaylist() {
    const allSongs = localFilteredSongs();
    let selectedSongs = [];
    if (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs) {
        selectedSongs = SongTable.getSelectedSongs('local');
    }
    const songsToAdd = selectedSongs.length > 0 ? selectedSongs : allSongs;
    if (!songsToAdd.length) {
        showToast('当前列表没有歌曲', 'warning');
        return;
    }
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal(songsToAdd, '本地音乐');
    } else {
        showToast('添加歌单功能未加载', 'error');
    }
}

// ==================== 扫描 / 补全进度圆圈（常驻轮询 + 可停止） ====================

const SCAN_RING_CIRC = 97.4; // 2π * 15.5
let localScanDetailOpen = false;
let localScanPollTimer = null;
let localScanPolling = false;
let localScanHideTimer = null;

function localScanUI() {
    return {
        circle: document.getElementById('local-scan-circle'),
        ring: document.getElementById('scan-ring-val'),
        pct: document.getElementById('scan-circle-pct'),
        detail: document.getElementById('local-scan-detail'),
        dLine: document.getElementById('scan-detail-line'),
        dTitle: document.getElementById('scan-detail-title-text'),
        dFill: document.getElementById('scan-detail-fill'),
        stop: document.getElementById('scan-detail-stop')
    };
}

/** 是否处于任务运行中（扫描阶段 / 补全阶段都算）。
 * 同时认 scanProgress.scanning 与阶段化流水线的 scanGlobalState，
 * 避免「首次扫描只跑元数据采集、scanning 已被 endJob 置否」时圆圈不显示。 */
function localScanIsRunning(st) {
    if (st && st.scanning) return true;
    // 阶段化流水线（Step1-8）运行中同样算任务在跑，避免「扫描已结束但补全仍在进行」时圆圈不显示
    const pl = st && st.pipeline;
    if (pl && pl.state === 'RUNNING') return true;
    return false;
}

/** 根据后端 scan-status 渲染圆圈 + 详情浮层；running=true 时无条件显示圆圈 */
function renderLocalScan(st, running) {
    const ui = localScanUI();
    if (!ui.circle || !ui.ring || !ui.pct) return;
    const total = (st && st.total) || 0;
    const scanned = (st && st.scanned) || 0;
    // 流水线状态（Step1-8）：触发来源 / 当前歌曲 / 当前步骤 / 已完成·总数·排队数
    const pl = (st && st.pipeline) || null;
    const inPipeline = !!(pl && pl.state === 'RUNNING');
    const gp = (pl && typeof pl.percent === 'number') ? pl.percent : 0;
    // 扫描阶段用 已扫描/总数；流水线（补全）阶段用流水线自身百分比
    const pct = inPipeline
        ? Math.round(gp)
        : (total ? Math.min(100, Math.round((scanned / total) * 100)) : 0);
    const phase = (st && st.phase) || 'scan';
    const failed = !!(st && st.error);
    const cancelled = phase === 'cancelled';
    const indeterminate = !!running && !total && gp <= 0;

    // 只要任务在跑（首次后台扫描 / 目录变更 / 定时 / 手动 / 设置页补图）就必须显示
    if (running) {
        if (localScanHideTimer) {
            clearTimeout(localScanHideTimer);
            localScanHideTimer = null;
        }
        ui.circle.style.display = 'inline-flex';
    }

    ui.circle.classList.toggle('indeterminate', indeterminate);
    if (!running) {
        ui.ring.style.strokeDashoffset = '0';
        ui.pct.textContent = cancelled ? '停' : (failed ? '!' : '✓');
    } else if (indeterminate) {
        ui.pct.textContent = '…';
    } else {
        ui.pct.textContent = pct + '%';
        ui.ring.style.strokeDashoffset = (SCAN_RING_CIRC * (1 - pct / 100)).toFixed(1);
    }

    let line;
    if (!running) {
        line = cancelled ? '已停止' : (failed ? ('失败：' + st.error) : '已完成');
    } else if (inPipeline) {
        // Step1-8 流水线运行中：触发来源 + 当前歌曲 + 当前步骤 + 已完成/总数 + 排队数
        const src = (pl && pl.triggerLabel) || '任务';
        const song = (pl && pl.currentSong) || '未知歌曲';
        const step = (pl && pl.currentStep) || '处理中';
        const stat = `${(pl && pl.done) || 0}/${(pl && pl.total) || 0}`;
        const q = (pl && pl.queued) ? `｜排队 ${pl.queued}` : '';
        line = `${src} 正在处理：${song}｜${step}（${stat}）${q}`;
    } else if (phase === 'backfill') {
        line = total ? `正在补全缺失封面/专辑/时长 ${scanned}/${total} 首…` : '正在补全缺失数据…';
    } else if (phase === 'album') {
        line = total ? `正在补全专辑封面 ${scanned}/${total} 张…` : '正在补全专辑封面…';
    } else {
        line = total ? `正在扫描 ${scanned}/${total} 个文件…` : '正在扫描…';
    }
    const bad = !running && (failed || cancelled);
    ui.circle.classList.toggle('error', bad);
    if (ui.detail) ui.detail.classList.toggle('error', bad);
    if (ui.dLine) ui.dLine.textContent = line;
    if (ui.dTitle) {
        ui.dTitle.textContent = !running
            ? (cancelled ? '已停止' : (failed ? '任务失败' : '已完成'))
            : ((pl && pl.triggerLabel) || (st && st.label) || '本地音乐扫描');
    }
    if (ui.dFill) ui.dFill.style.width = (running ? pct : (bad ? 0 : 100)) + '%';
    ui.circle.title = line;
    // 停止按钮：仅在任务运行中可用
    if (ui.stop) {
        ui.stop.style.display = running ? 'inline-flex' : 'none';
        const stopping = !!(st && st.cancelRequested);
        ui.stop.disabled = stopping;
        ui.stop.classList.toggle('stopping', stopping);
        const txt = ui.stop.querySelector('span');
        if (txt) txt.textContent = stopping ? '停止中…' : '停止';
    }
}

function showLocalScanCircle(st, running) {
    const ui = localScanUI();
    if (!ui.circle) return;
    ui.circle.style.display = 'inline-flex';
    if (ui.ring) ui.ring.style.strokeDashoffset = SCAN_RING_CIRC;
    if (ui.pct) ui.pct.textContent = '';
    renderLocalScan(st, running);
}

function hideLocalScanCircle() {
    const ui = localScanUI();
    if (ui.circle) ui.circle.style.display = 'none';
}

function hideLocalScanDetail() {
    const ui = localScanUI();
    if (ui.detail) ui.detail.style.display = 'none';
    localScanDetailOpen = false;
}

/** 点击顶栏圆圈：展开/收起扫描详情（内含停止按钮） */
window.toggleLocalScanDetail = function () {
    const ui = localScanUI();
    if (!ui.detail) return;
    localScanDetailOpen = !localScanDetailOpen;
    ui.detail.style.display = localScanDetailOpen ? 'block' : 'none';
    if (localScanDetailOpen) {
        renderLocalScan(window.__localScanStatus, window.__localScanRunning);
    }
};

/** 停止当前正在进行的扫描 / 补全（顶栏圆圈 → 停止） */
window.stopLocalScan = async function () {
    const ui = localScanUI();
    if (ui.stop) ui.stop.disabled = true;
    try {
        const res = await API.post('/api/music/cancel-scan', {});
        if (!res || !res.success) throw new Error((res && res.error) || '停止失败');
        if (!res.cancelled && typeof showToast === 'function') {
            showToast('当前没有正在运行的扫描/补全任务', 'warning');
        } else if (typeof showToast === 'function') {
            showToast('已请求停止，正在中断…', 'info');
        }
        if (ui.dLine) ui.dLine.textContent = '正在停止…';
    } catch (error) {
        console.error('停止扫描失败:', error);
        if (ui.stop) ui.stop.disabled = false;
        if (typeof showToast === 'function') showToast('停止失败：' + error.message, 'error');
    }
};

// 点击圆圈/详情以外位置收起详情浮层
document.addEventListener('click', (e) => {
    if (localScanDetailOpen && e.target && !e.target.closest('.local-scan-detail') && !e.target.closest('.local-scan-circle')) {
        hideLocalScanDetail();
    }
});

/**
 * 常驻轮询后端任务状态：任何来源的扫描 / 补全（首次后台扫描、目录变更、定时、
 * 手动扫描、设置页补图）只要在跑，顶栏圆圈就显示进度；结束后自动收起并刷新列表。
 */
async function localScanPollOnce() {
    if (localScanPolling) return;
    localScanPolling = true;
    try {
        let st = null;
        try {
            st = await API.get('/api/music/scan-status');
        } catch {
            return; // 网络/鉴权异常：保留当前显示，下一轮再试
        }
        if (!st || !st.success) return;
        const running = localScanIsRunning(st);
        const wasRunning = !!window.__localScanRunning;
        window.__localScanStatus = st;
        window.__localScanRunning = running;

        if (running) {
            if (wasRunning) renderLocalScan(st, true);
            else showLocalScanCircle(st, true);
            return;
        }
        if (wasRunning) {
            // 任务刚结束（完成 / 失败 / 被停止）：短暂展示终态后收起
            renderLocalScan(st, false);
            refreshLocalMusicAfterScan();
            if (localScanHideTimer) clearTimeout(localScanHideTimer);
            localScanHideTimer = setTimeout(() => {
                localScanHideTimer = null;
                if (!window.__localScanRunning) {
                    hideLocalScanCircle();
                    hideLocalScanDetail();
                }
            }, 1500);
        } else {
            hideLocalScanCircle();
        }
    } finally {
        localScanPolling = false;
    }
}

/** 自适应轮询间隔：扫描/补全运行期间 1.5s 高频（后端负载已高，需尽快收口）；空闲 30s 低频 */
const LOCAL_SCAN_ACTIVE_INTERVAL = 1500;
const LOCAL_SCAN_IDLE_INTERVAL = 30 * 1000;

/** 自调度轮询：空闲时 30s 一拍、任务运行时 1.5s 一拍；页面在后台时跳过请求（不再常驻高频空打） */
function scheduleLocalScanPoll() {
    if (localScanPollTimer) clearTimeout(localScanPollTimer);
    const delay = window.__localScanRunning ? LOCAL_SCAN_ACTIVE_INTERVAL : LOCAL_SCAN_IDLE_INTERVAL;
    localScanPollTimer = setTimeout(async () => {
        if (document.hidden) {
            scheduleLocalScanPoll(); // 后台标签页不发请求，仅维持节拍
            return;
        }
        await localScanPollOnce();
        scheduleLocalScanPoll();
    }, delay);
}

/** 启动轮询（登录成功后调用一次即可，内部幂等） */
function startLocalScanStatusPoller() {
    if (localScanPollTimer) return;
    localScanPollOnce();
    scheduleLocalScanPoll();
}

// 回到前台立即刷一次状态（下一拍由自调度接管），避免后台期间错过的任务迟迟不显示
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && localScanPollTimer) localScanPollOnce();
});

/** 扫描/补全结束后刷新本地音乐列表（仅在本地音乐页时刷新，避免无谓请求） */
function refreshLocalMusicAfterScan() {
    if (typeof loadLocalMusic !== 'function') return;
    if (window.currentPage !== 'local') return;
    window.localFolderTree = null;
    loadLocalMusic();
}

// 登录成功（app:ready）后启动：保证后台自动触发的扫描/补全也能在顶栏显示
window.addEventListener('app:ready', startLocalScanStatusPoller);

/** 启动本地音乐重新扫描（右上角菜单调用）：进度显示为顶栏圆圈，点击圆圈查看详情/停止 */
async function startLocalRescan() {
    try {
        const res = await API.post('/api/music/rescan', {});
        if (!res || !res.success) {
            throw new Error((res && res.error) || '启动扫描失败');
        }
        if (res.busy && typeof showToast === 'function') {
            showToast('已有扫描/补全任务进行中，已显示其进度', 'warning');
        }
        // 立即显示圆圈（不等下一次轮询）；后端已在跑或刚启动
        window.__localScanRunning = true;
        window.__localScanStatus = Object.assign({}, window.__localScanStatus, {
            scanning: true, phase: 'scan', total: 0, scanned: 0, error: null, label: '扫描音乐'
        });
        showLocalScanCircle(window.__localScanStatus, true);
    } catch (error) {
        console.error('重新扫描失败:', error);
        if (typeof showToast === 'function') showToast('启动扫描失败：' + error.message, 'error');
    }
}

/**
 * 删除本地歌曲文件（应用内删除）：调用后端同时删除磁盘文件与数据库记录。
 * 支持两种模式：批量（勾选，无 index）与单首（传入详情页行索引 index）。
 * @param {string} pageId 当前 SongTable 页面 id（local / local-album-detail / local-artist-detail / local-folder）
 * @param {number} [index] 单首删除时的行索引（详情页行内菜单）
 */
async function deleteLocalSongs(pageId, index) {
    let sel = [];
    if (typeof index === 'number') {
        // 单首删除：按 pageId 定位对应歌曲列表
        let one = null;
        if (pageId === 'local-artist-detail') {
            one = getLocalDetailSongs('artist')[index];
        } else if (pageId === 'local-album-detail') {
            one = getLocalDetailSongs('album')[index];
        } else {
            one = localFolderSongs()[index];
        }
        if (!one) return;
        sel = [one];
    } else {
        if (typeof SongTable === 'undefined') return;
        sel = SongTable.getSelectedSongs(pageId) || [];
    }
    if (!sel || !sel.length) {
        showToast('请先勾选要删除的歌曲', 'warning');
        return;
    }
    if (!window.confirm(`确定删除选中的 ${sel.length} 首本地歌曲文件吗？\n文件将从磁盘彻底删除且不可恢复。`)) {
        return;
    }
    try {
        const res = await API.post('/api/music/delete', { ids: sel.map((s) => s.id) });
        if (!res || !res.success) throw new Error((res && res.error) || '删除失败');
        showToast(`已删除 ${res.deleted || sel.length} 首本地歌曲`, 'success');
        // 重新加载本地音乐（清空文件夹树缓存），列表自动刷新为删除后的最新数据
        if (typeof loadLocalMusic === 'function') {
            window.localFolderTree = null;
            if (pageId === 'local-folder') localFolderEpoch++;
            localSongsEpoch++;
            loadLocalMusic();
        }
    } catch (e) {
        console.error('删除本地歌曲失败:', e);
        showToast('删除失败: ' + (e && e.message), 'error');
    }
}

/**
 * 单首歌添加到歌单（行内「⋯」菜单）：弹出歌单选择框
 * @param {number} index 过滤后列表索引
 */
function addLocalToPlaylistByIndex(index) {
    const song = localFilteredSongs()[index];
    if (!song) return;
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal([song], '本地音乐');
    } else {
        showToast('添加歌单功能未加载', 'error');
    }
}
window.addLocalToPlaylistByIndex = addLocalToPlaylistByIndex;

/**
 * 删除单首本地歌曲（行内「⋯」菜单）：确认后从磁盘与数据库删除
 * @param {number} index 过滤后列表索引
 */
async function deleteLocalByIndex(index) {
    const song = localFilteredSongs()[index];
    if (!song || !song.id) return;
    if (!window.confirm(`确定删除本地歌曲「${song.title || ''}」吗？\n文件将从磁盘彻底删除且不可恢复。`)) {
        return;
    }
    try {
        const res = await API.post('/api/music/delete', { ids: [song.id] });
        if (!res || !res.success) throw new Error((res && res.error) || '删除失败');
        showToast(`已删除本地歌曲`, 'success');
        if (typeof loadLocalMusic === 'function') {
            window.localFolderTree = null;
            if (pageId === 'local-folder') localFolderEpoch++;
            localSongsEpoch++;
            loadLocalMusic();
        }
    } catch (e) {
        console.error('删除本地歌曲失败:', e);
        showToast('删除失败: ' + (e && e.message), 'error');
    }
}
window.deleteLocalByIndex = deleteLocalByIndex;

// ==================== 插件补全（封面 / 歌手图 / 专辑图） ====================

// 补全结果前端缓存（避免同一歌曲重复请求）
const localEnrichCoverCache = new Map();
// 歌手/专辑图片前端缓存
const localArtistImageCache = new Map();
const localAlbumImageCache = new Map();

/** 为本地歌曲通过插件搜索补封面（无内嵌封面时播放器调用） */
async function fetchLocalEnrichCover(music) {
    const title = (music && music.title) || '';
    const artist = (music && music.artist) || '';
    const key = (title + '|' + artist).toLowerCase();
    if (localEnrichCoverCache.has(key)) {
        return localEnrichCoverCache.get(key);
    }
    try {
        const res = await API.post('/api/music/enrich', {
            music: { title, artist, filePath: (music && music.filePath) || null }
        });
        const cover = (res && res.success && res.cover) ? res.cover : null;
        localEnrichCoverCache.set(key, cover);
        return cover;
    } catch (err) {
        console.warn('本地音乐封面补全失败:', err);
        localEnrichCoverCache.set(key, null);
        return null;
    }
}

/** 获取歌手图片（插件搜索，带缓存） */
async function fetchLocalArtistImage(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    if (localArtistImageCache.has(key)) return localArtistImageCache.get(key);
    try {
        const res = await API.get(`/api/music/artist-image?name=${encodeURIComponent(name)}`);
        const img = (res && res.success && res.image) ? res.image : null;
        localArtistImageCache.set(key, img);
        return img;
    } catch (err) {
        console.warn('歌手图片获取失败:', err);
        localArtistImageCache.set(key, null);
        return null;
    }
}

/** 获取专辑图片（插件搜索，带缓存） */
async function fetchLocalAlbumImage(name, artist) {
    const key = String(name || '').trim().toLowerCase() + '|' + String(artist || '').trim().toLowerCase();
    if (!key) return null;
    if (localAlbumImageCache.has(key)) return localAlbumImageCache.get(key);
    try {
        const res = await API.get(`/api/music/album-image?name=${encodeURIComponent(name)}&artist=${encodeURIComponent(artist || '')}`);
        const img = (res && res.success && res.image) ? res.image : null;
        localAlbumImageCache.set(key, img);
        return img;
    } catch (err) {
        console.warn('专辑图片获取失败:', err);
        localAlbumImageCache.set(key, null);
        return null;
    }
}

// ==================== 工具 ====================

function emptyLocalHtml(text) {
    return `
        <div class="empty-state" style="padding: 60px 20px; text-align: center;">
            <div class="empty-icon" style="font-size: 48px; margin-bottom: 16px;">🎵</div>
            <div class="empty-text" style="font-size: 16px; color: var(--text-secondary); margin-bottom: 8px;">${text}</div>
        </div>`;
}

// ==================== 导出函数到全局作用域 ====================

window.loadLocalMusic = loadLocalMusic;
window.switchLocalTab = switchLocalTab;
window.renderLocalSongs = renderLocalSongs;
window.renderLocalArtists = renderLocalArtists;
window.renderLocalAlbums = renderLocalAlbums;
window.renderLocalFolderTree = renderLocalFolderTree;
window.selectLocalFolder = selectLocalFolder;
window.toggleLocalFolderExpand = toggleLocalFolderExpand;
window.playLocalFolderByIndex = playLocalFolderByIndex;
window.toggleLocalFolderFavorite = toggleLocalFolderFavorite;
window.playLocalFolderAll = playLocalFolderAll;
window.addLocalFolderToPlaylist = addLocalFolderToPlaylist;
window.playLocalByIndex = playLocalByIndex;
window.playAllLocal = playAllLocal;
window.playLocalArtist = playLocalArtist;
window.playLocalAlbum = playLocalAlbum;
window.openLocalArtist = openLocalArtist;
window.openLocalAlbum = openLocalAlbum;
window.closeLocalDetail = closeLocalDetail;
window.playLocalDetail = playLocalDetail;
window.toggleLocalDetailFavorite = toggleLocalDetailFavorite;
window.addLocalDetailToPlaylist = addLocalDetailToPlaylist;
window.toggleFavoriteLocal = toggleFavoriteLocal;
window.addAllLocalToPlaylist = addAllLocalToPlaylist;
window.toggleLocalHeaderMenu = toggleLocalHeaderMenu;
window.closeLocalHeaderMenu = closeLocalHeaderMenu;
window.toggleLocalManageMode = toggleLocalManageMode;
window.localManageAdd = localManageAdd;
window.startLocalRescan = startLocalRescan;
window.fetchLocalEnrichCover = fetchLocalEnrichCover;
window.fetchLocalArtistImage = fetchLocalArtistImage;
window.fetchLocalAlbumImage = fetchLocalAlbumImage;
window.localArtistsGotoPage = localArtistsGotoPage;
window.localArtistsChangePageSize = localArtistsChangePageSize;
window.localAlbumsGotoPage = localAlbumsGotoPage;
window.localAlbumsChangePageSize = localAlbumsChangePageSize;
