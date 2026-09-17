/**
 * 最近播放模块
 * 功能：加载最近播放记录、渲染列表、清空记录
 */

// ==================== 最近播放管理 ====================

// 分页状态：当前页（1 起）；每页条数用全局偏好（song-table.js 的 getSongTablePageSize）
let recentPage = 1;
let recentContainer = null; // 渲染容器缓存，翻页重渲染时复用

/**
 * 加载最近播放记录
 */
async function loadRecentPlays() {
    const container = document.getElementById('page-recent');
    if (!container) return;

    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    recentPage = 1; // 重新加载数据时重置到第一页

    try {
        // 同时加载最近播放和收藏列表 - 使用用户隔离的API
        const [historyResult, favoritesResult] = await Promise.all([
            API.myRecent.getAll(),
            API.myFavorites.getAll()
        ]);

        // 保存收藏列表到全局
        if (favoritesResult.success && favoritesResult.data) {
            window.currentFavoritesList = favoritesResult.data;
            // 同步到缓存
            // 注意：必须使用与 isFavoritedSync 相同的 key 格式 (platform || plugin)
            if (typeof addToFavoritesCache === 'function') {
                favoritesResult.data.forEach(song => {
                    const platform = song.platform || song.plugin;
                    addToFavoritesCache(song.id, platform);
                });
            }
        }

        if (historyResult.success && historyResult.data && historyResult.data.length > 0) {
            // 保存到全局供其他函数使用
            window.currentRecentList = historyResult.data;
            renderRecentPlays(historyResult.data, container);
        } else {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">🕐</div>
                    <div class="empty-text">暂无播放记录</div>
                    <div class="empty-subtext">您播放的歌曲将显示在这里</div>
                </div>
            `;
        }
    } catch (error) {
        console.error('加载最近播放失败', error);
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">❌</div>
                <div class="empty-text">加载失败</div>
                <div class="empty-subtext">${escapeHtml(error.message)}</div>
            </div>
        `;
    }
}

// 卡片视图的管理模式与勾选集合（交互与「我的收藏」一致：key = id|plugin）
let recentManageMode = false;
let recentSelected = new Set();

/** 歌曲唯一 key（同一首歌可能来自不同插件） */
function recentSongKey(song) {
    return `${song.id}|${song.plugin || song.platform || ''}`;
}

/** 管理模式：当前勾选的歌曲对象列表 */
function getSelectedRecentSongs() {
    const songs = window.currentRecentList || [];
    return songs.filter((s) => recentSelected.has(recentSongKey(s)));
}

/**
 * 渲染最近播放列表（卡片网格 + 顶部工具条，参考「我的收藏」界面）
 * @param {Array} plays
 * @param {HTMLElement} container
 */
function renderRecentPlays(plays, container) {
    // 存储到全局
    window.currentRecentList = plays;
    recentContainer = container;

    if (!plays || plays.length === 0) {
        recentManageMode = false;
        recentSelected.clear();
        container.innerHTML = `
            <div class="empty-state" style="flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center;">
                <div class="empty-icon">🕐</div>
                <div class="empty-text">暂无播放记录</div>
                <div class="empty-subtext">您播放的歌曲将显示在这里</div>
            </div>`;
        return;
    }

    // 与「我的歌单」一致：不分页，全量渲染（data-index 用全列表索引）
    const pageSongs = plays;

    const n = recentSelected.size;
    // 与「我的歌单」一致：普通模式无工具条（播放/管理在页头「⋯」菜单），管理模式才出现操作条
    const manageBtns = recentManageMode ? `
                <button class="btn btn-secondary btn-sm" id="recent-selectall-btn" onclick="toggleSelectAllRecentCards()">${n && n === plays.length ? '取消全选' : '全选'}</button>
                <button class="btn btn-secondary btn-sm" id="recent-add-btn" onclick="addSelectedRecentToPlaylist()">歌单${n ? ` (${n})` : ''}</button>
                <button class="btn btn-secondary btn-sm" id="recent-download-btn" onclick="downloadSelectedRecent()">下载${n ? ` (${n})` : ''}</button>
                <button class="btn btn-danger btn-sm" id="recent-delete-btn" onclick="deleteSelectedRecentPlays()"
                    ${n ? '' : 'disabled'} style="${n ? '' : 'opacity:.5; cursor:not-allowed;'}">删除${n ? ` (${n})` : ''}</button>
                <button class="btn btn-secondary btn-sm" onclick="toggleRecentManageMode()">完成</button>` : '';
    const hint = recentManageMode ? `
            <span style="font-size: 13px; color: var(--text-secondary);"><span style="margin-right: 8px;">💡</span>点击卡片可多选</span>` : '';

    container.innerHTML = `
        ${recentManageMode ? `
        <div class="media-card-toolbar">
            <div style="display: flex; gap: 8px; align-items: center; min-width: 0;">
                ${hint}
            </div>
            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
                ${manageBtns}
                <div id="recent-count-text" style="font-size: 13px; color: var(--text-secondary);">
                    ${plays.length} 首${n ? ` · 已选 ${n}` : ''}
                </div>
            </div>
        </div>` : ''}
        <div id="recent-card-grid" class="media-card-grid" style="flex: 1; overflow-y: auto;"></div>`;

    // 卡片网格懒加载：只渲染当前可见卡片，滚动到底追加（data-index 仍为全列表索引，不影响播放/收藏索引）
    CardListLazy.register({
        key: 'recent',
        songs: plays,
        getGrid: () => document.getElementById('recent-card-grid'),
        cardHtml: (s, i) => recentCardHtml(s, i),
        batch: 36,
        initial: 60,
        scroller: document.getElementById('recent-card-grid')
    });

    // 页头「⋯」菜单（与我的歌单一致）：普通模式下播放/管理入口收进页头；标题带计数
    setupRecentHeader(plays.length);
}

/**
 * 页头「⋯」菜单（与「我的歌单」一致）：播放全部 / 添加到歌单 / 下载 / 删除
 * （后三者都进入同一个多选模式——一个功能一个入口，模式内提供 全选/添加/下载/删除/完成）
 */
function setupRecentHeader(count) {
    const headerLeft = document.getElementById('header-left');
    if (!headerLeft) return;
    const title = headerLeft.querySelector('.header-title');
    const pageTitle = (title ? title.textContent : '我的播放').replace(/（.*?）$/, '');
    headerLeft.style.position = 'relative';
    headerLeft.innerHTML = `
        <button class="mobile-menu-btn" onclick="toggleMobileSidebar()" aria-label="打开菜单">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
        </button>
        <div class="header-title" id="page-title" style="position: absolute; left: 50%; transform: translateX(-50%); margin: 0;">${pageTitle}（${count || 0}首）</div>
        <div style="margin-left: auto; position: relative; display: flex; align-items: center;">
            <button type="button" title="更多" aria-label="更多"
                onclick="event.stopPropagation(); toggleRecentMenu()"
                class="header-icon-btn">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
            </button>
            <div id="recent-menu"
                style="display: none; position: absolute; right: 0; top: calc(100% + 6px); min-width: 150px; background: var(--surface-color); border: 1px solid var(--divider-color); border-radius: 10px; box-shadow: var(--shadow-lg); z-index: 1001; padding: 6px 0; overflow: hidden;">
                <button type="button" onclick="event.stopPropagation(); playAllRecent(); closeRecentMenu();"
                    style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">播放全部</button>
                <button type="button" onclick="event.stopPropagation(); openRecentManageMode(); closeRecentMenu();"
                    style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">歌单</button>
                <button type="button" onclick="event.stopPropagation(); openRecentManageMode(); closeRecentMenu();"
                    style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">下载</button>
                <button type="button" onclick="event.stopPropagation(); openRecentManageMode(); closeRecentMenu();"
                    style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--danger-color, #ff4d4f); font-size: 14px; cursor: pointer; text-align: left;">删除</button>
            </div>
        </div>
    `;
}

/**
 * 页头「⋯」菜单开关
 */
function toggleRecentMenu() {
    const menu = document.getElementById('recent-menu');
    if (!menu) return;
    menu.style.display = menu.style.display !== 'block' ? 'block' : 'none';
    if (menu.style.display === 'block') {
        setTimeout(() => document.addEventListener('click', closeRecentMenu), 0);
    }
}

function closeRecentMenu() {
    const menu = document.getElementById('recent-menu');
    if (menu) menu.style.display = 'none';
    document.removeEventListener('click', closeRecentMenu);
}

/**
 * 单张歌曲卡片（普通模式：点击播放 / 红心收藏；管理模式：点击勾选）
 * @param {Object} song - 歌曲对象
 * @param {number} index - 全列表索引（含分页偏移，播放/收藏/下载直接定位）
 */
function recentCardHtml(song, index) {
    const manage = recentManageMode;
    const selected = manage && recentSelected.has(recentSongKey(song));
    const title = song.title || '未知歌曲';
    const artist = song.artist || '未知歌手';
    // 网络歌曲封面不入库：无 artwork/cover 时用虚拟封面 ID 经 /api/cover 实时向插件获取
    // （与播放器 getCoverUrl 一致），避免酷我等 getMusicInfo 不返回封面的插件在列表里空白。
    const coverId = song.coverArt || song.virtualId
        || (typeof song.id === 'string' && song.id.startsWith('remote__') ? song.id : null);
    const cover = song.artwork || song.cover || song.coverImg || song.pic
        || (coverId ? `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(coverId)}` : null);
    // 年代 + 来源（合并为一行小字，如「2026 · 来源：本地」）
    const yearMatch = song.year ? String(song.year).match(/\d{4}/) : null;
    const year = yearMatch ? yearMatch[0] : '';
    // 歌曲插件标识（用于判定 STRM/本地 与下方来源文案）
    const itemPlugin = song.plugin || song.platform || '';
    const isStrm = typeof isStrmSong === 'function'
        ? isStrmSong(song)
        : (song.isStrm || (song.realMediaUri && itemPlugin === 'local'));
    // 来源文案 = 音源别名-插件名（如「QQ音乐-咪音QQ」）；本地/电台/STRM/落雪各自专属
    let sourceText = '';
    if (isStrm) sourceText = 'STRM';
    else if (typeof getMusicSourceLabel === 'function') sourceText = getMusicSourceLabel(song);
    else if (itemPlugin) sourceText = String(itemPlugin).replace(/\.js$/i, '');
    // 收藏状态：已收藏红心（点击取消），未收藏空心（点击收藏）
    const fav = typeof isSongFavoritedSync === 'function' && isSongFavoritedSync(song.id, song.plugin || song.platform);
    // 普通模式：左上角红心（点击切换收藏）
    const heartHtml = manage ? '' : `<div onclick="event.stopPropagation(); toggleFavoriteRecent(${index})" title="${fav ? '取消收藏' : '收藏'}"
            style="position: absolute; top: 6px; left: 6px; font-size: 20px; line-height: 1; cursor: pointer;
                   color: ${fav ? '#ff4d4f' : 'rgba(255,255,255,.85)'}; text-shadow: 0 1px 3px rgba(0,0,0,.55); z-index: 3; user-select: none;">${fav ? '♥' : '♡'}</div>`;
    // 管理模式：左上角勾选框
    const checkHtml = manage ? `<div class="favorite-check"
            style="position: absolute; top: 6px; left: 6px; width: 22px; height: 22px; border-radius: 50%; box-sizing: border-box;
                   border: 1.5px solid ${selected ? 'var(--primary-color)' : 'rgba(255,255,255,.75)'};
                   background: ${selected ? 'var(--primary-color)' : 'rgba(0,0,0,.35)'};
                   color: #fff; font-size: 13px; line-height: 19px; text-align: center; z-index: 3; user-select: none;">${selected ? '✓' : ''}</div>` : '';
    const playBtnHtml = manage ? '' : `<button class="media-card-play" title="播放" onclick="event.stopPropagation(); playRecentByIndex(${index})"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>`;
    const clickAttr = manage
        ? `onclick="toggleRecentCardSelect(${index})"`
        : `onclick="playRecentByIndex(${index})"`;
    return `
        <div class="favorite-card media-card" data-index="${index}" ${clickAttr}
            style="transition: transform .2s;
                   box-shadow: ${selected ? '0 0 0 2px var(--primary-color)' : 'none'};"
            onmouseover="this.style.transform='scale(1.02)'" onmouseout="this.style.transform='scale(1)'">
            <div class="media-card-cover"
                 style="display: flex; align-items: center; justify-content: center; font-size: 38px;
                        background: linear-gradient(135deg, var(--bg-tertiary) 0%, var(--surface-color) 100%);">
                <span style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;">🎵</span>
                ${cover ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy" decoding="async" style="position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;" data-raw="${escapeHtml(cover)}" onerror="window.__coverImgOnError(this)">` : ''}
                ${heartHtml}
                ${checkHtml}
                ${typeof getSourceBadgeHtml === 'function' ? getSourceBadgeHtml(song) : ''}
                ${playBtnHtml}
            </div>
            <div class="media-card-title">${escapeHtml(title)}</div>
            <div class="media-card-sub">${escapeHtml(artist)}</div>
            ${(() => {
                const meta = [year, sourceText ? `来源：${sourceText}` : ''].filter(Boolean).join(' · ');
                return meta ? `<div class="media-card-sub" style="font-size: 11px; color: var(--text-tertiary);">${escapeHtml(meta)}</div>` : '';
            })()}
        </div>`;
}

/** 卡片分页条（复用 st-pagination 样式，常显） */
function recentPaginationHtml(total, pageSize) {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = recentPage;
    const pages = [];
    const push = (p) => { if (!pages.includes(p)) pages.push(p); };
    push(1);
    // 手机端只显示首页和尾页页码，中间用省略号
    if (window.innerWidth <= 768) {
        if (totalPages > 1) push(totalPages);
    } else {
        for (let p = page - 2; p <= page + 2; p++) {
            if (p > 1 && p < totalPages) push(p);
        }
        if (totalPages > 1) push(totalPages);
    }
    pages.sort((a, b) => a - b);
    let btns = '';
    pages.forEach((p, i) => {
        if (i > 0 && p - pages[i - 1] > 1) btns += '<span class="st-page-ellipsis">…</span>';
        btns += `<button type="button" class="st-page-btn ${p === page ? 'active' : ''}" onclick="recentGotoPage(${p})">${p}</button>`;
    });
    const sizes = SONGTABLE_PAGE_SIZES.map((s) => `<option value="${s}" ${s === pageSize ? 'selected' : ''}>${s} 条/页</option>`).join('');
    return `
        <div class="st-pagination" style="flex-shrink: 0;">
            <span class="st-page-total">共 ${total} 条</span>
            <select class="st-page-size" onchange="recentChangePageSize(parseInt(this.value, 10))">${sizes}</select>
            <div class="st-page-btns">
                <button type="button" class="st-page-btn nav" ${page <= 1 ? 'disabled' : ''} onclick="recentGotoPage(1)" title="首页">«</button>
                <button type="button" class="st-page-btn nav" ${page <= 1 ? 'disabled' : ''} onclick="recentGotoPage(${page - 1})" title="上一页">‹</button>
                ${btns}
                <button type="button" class="st-page-btn nav" ${page >= totalPages ? 'disabled' : ''} onclick="recentGotoPage(${page + 1})" title="下一页">›</button>
                <button type="button" class="st-page-btn nav" ${page >= totalPages ? 'disabled' : ''} onclick="recentGotoPage(${totalPages})" title="尾页">»</button>
            </div>
        </div>`;
}

/** 翻页 / 改每页条数（卡片视图重渲染，保持管理模式与勾选状态） */
function recentGotoPage(p) {
    recentPage = p;
    if (recentContainer && window.currentRecentList) {
        renderRecentPlays(window.currentRecentList, recentContainer);
    }
}
function recentChangePageSize(n) {
    setSongTablePageSize(n);
    recentPage = 1;
    if (recentContainer && window.currentRecentList) {
        renderRecentPlays(window.currentRecentList, recentContainer);
    }
}

// ==================== 卡片管理模式（与「我的收藏」交互一致） ====================

/** 切换管理模式 */
function toggleRecentManageMode() {
    recentManageMode = !recentManageMode;
    recentSelected.clear();
    if (recentContainer && window.currentRecentList) {
        renderRecentPlays(window.currentRecentList, recentContainer);
    }
}

/**
 * 进入管理模式（页头「⋯」菜单的 添加到歌单 / 下载 / 删除 共用入口）。
 * 模式内提供 全选 / 添加(N) / 下载(N) / 删除(N) / 完成；已在模式中则不重复切换。
 */
function openRecentManageMode() {
    if (!recentManageMode) toggleRecentManageMode();
}

/** 点击卡片切换勾选（管理模式） */
function toggleRecentCardSelect(index) {
    const song = (window.currentRecentList || [])[index];
    if (!song) return;
    const key = recentSongKey(song);
    if (recentSelected.has(key)) recentSelected.delete(key);
    else recentSelected.add(key);
    syncRecentSelectionUI();
}

/** 全选 / 取消全选（管理模式，作用于全部列表） */
function toggleSelectAllRecentCards() {
    const songs = window.currentRecentList || [];
    const allSelected = songs.length > 0 && songs.every((s) => recentSelected.has(recentSongKey(s)));
    if (allSelected) songs.forEach((s) => recentSelected.delete(recentSongKey(s)));
    else songs.forEach((s) => recentSelected.add(recentSongKey(s)));
    syncRecentSelectionUI();
}

/** 局部刷新勾选态：卡片勾选框 / 高亮 + 顶部按钮文案（不重建 DOM，保住滚动位置） */
function syncRecentSelectionUI() {
    const songs = window.currentRecentList || [];
    const grid = document.getElementById('recent-card-grid');
    if (grid) {
        grid.querySelectorAll('.favorite-card').forEach((card) => {
            const song = songs[parseInt(card.dataset.index, 10)];
            const on = song ? recentSelected.has(recentSongKey(song)) : false;
            card.style.boxShadow = on ? '0 0 0 2px var(--primary-color)' : 'none';
            const box = card.querySelector('.favorite-check');
            if (box) {
                box.textContent = on ? '✓' : '';
                box.style.background = on ? 'var(--primary-color)' : 'rgba(0,0,0,.35)';
                box.style.borderColor = on ? 'var(--primary-color)' : 'rgba(255,255,255,.75)';
            }
        });
    }
    const n = recentSelected.size;
    const addBtn = document.getElementById('recent-add-btn');
    if (addBtn) addBtn.textContent = n ? `歌单 (${n})` : '歌单';
    const dlBtn = document.getElementById('recent-download-btn');
    if (dlBtn) dlBtn.textContent = n ? `下载 (${n})` : '下载';
    const delBtn = document.getElementById('recent-delete-btn');
    if (delBtn) {
        delBtn.textContent = n ? `删除 (${n})` : '删除';
        if (n) {
            delBtn.disabled = false;
            delBtn.style.opacity = '1';
            delBtn.style.cursor = 'pointer';
        } else {
            delBtn.disabled = true;
            delBtn.style.opacity = '.5';
            delBtn.style.cursor = 'not-allowed';
        }
    }
    const allBtn = document.getElementById('recent-selectall-btn');
    if (allBtn) {
        const pageSize = getSongTablePageSize();
        const totalPages = Math.max(1, Math.ceil(songs.length / pageSize));
        const page = Math.min(Math.max(1, recentPage || 1), totalPages);
        const pageCount = songs.slice((page - 1) * pageSize, page * pageSize).length;
        allBtn.textContent = (n && n === pageCount) ? '取消全选' : '全选';
    }
    const countEl = document.getElementById('recent-count-text');
    if (countEl) {
        countEl.textContent = `${songs.length} 首${recentManageMode && n ? ` · 已选 ${n}` : ''}`;
    }
}

/** 把选中的最近播放歌曲添加到歌单（管理模式「添加」按钮） */
function addSelectedRecentToPlaylist() {
    const songs = getSelectedRecentSongs();
    if (!songs.length) {
        showToast('请先选择要添加的歌曲', 'warning');
        return;
    }
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal(songs, '最近播放');
    } else {
        showToast('歌单功能未加载', 'error');
    }
}

/** 下载选中的最近播放歌曲（管理模式「下载」按钮） */
async function downloadSelectedRecent() {
    const songs = getSelectedRecentSongs();
    if (!songs.length) {
        showToast('请先选择要下载的歌曲', 'warning');
        return;
    }
    showToast(`开始下载 ${songs.length} 首歌曲...`, 'info');
    if (window.DownloadCore && typeof window.DownloadCore.downloadBatch === 'function') {
        const params = songs.map((s) => ({
            id: s.id, title: s.title, artist: s.artist,
            plugin: s.plugin || s.platform, quality: 'standard', ...s
        }));
        try {
            await window.DownloadCore.downloadBatch(params, { delay: 500 }, '最近播放-批量下载');
        } catch (e) {
            showToast('下载失败: ' + (e && e.message ? e.message : ''), 'error');
        }
        return;
    }
    if (window.DownloadCore) {
        for (const s of songs) {
            try { await window.DownloadCore.startBackendDownload(s, '最近播放-下载'); } catch (e) { /* 单个失败继续 */ }
        }
        return;
    }
    showToast('下载管理器未加载', 'error');
}

/**
 * 同步最近播放列表的下载状态
 * @param {Array} plays - 歌曲列表
 */
async function syncRecentDownloadStatus(_plays) {
    // 下载状态不再在渲染时批量同步，改为点击时实时查询
    return;

    /*
    if (!plays || plays.length === 0) return;

    // 等待 DownloadManager 加载完成
    if (typeof DownloadManager === 'undefined') {
        setTimeout(() => syncRecentDownloadStatus(plays), 1000);
        return;
    }

    // 确保已下载缓存已加载
    if (!DownloadManager.downloadedCache || DownloadManager.downloadedCache.size === 0) {
        await DownloadManager.loadDownloadedSongs();
    }

    // 检查每首歌曲的下载状态
    plays.forEach((song, index) => {
        const musicId = song.id || song.songId;
        // 入库 plugin 优先（platform 可能是显示用平台名）
        const plugin = song.plugin || song.platform;
        
        if (!musicId || !plugin) return;

        const key = `${musicId}_${plugin}`;
        const isDownloaded = DownloadManager.downloadedCache.has(key);

        if (isDownloaded) {
            // 更新 StateManager
            if (window.StateManager) {
                StateManager.setDownloadStatus(musicId, plugin, 'downloaded', false);
            }

            // 更新按钮显示
            if (window.ButtonManager) {
                ButtonManager.updateDownloadButton(musicId, plugin, 'downloaded');
            }
        }
    });
    */
}

/**
 * 清空最近播放记录
 */
async function clearRecentPlays() {
    const confirmed = await Notification.confirm('确定要清空所有播放记录吗？', { type: 'warning' });
    if (!confirmed) {
        return;
    }

    try {
        const result = await API.myRecent.clear();

        if (result.success) {
            showToast('播放记录已清空', 'success');
            loadRecentPlays();
        } else {
            showToast('清空失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('清空播放记录失败:', error);
        showToast('清空失败: ' + error.message, 'error');
    }
}

/**
 * 获取最近播放页当前勾选的歌曲（卡片管理模式勾选集）
 * @returns {Array} 选中的歌曲列表
 */
function getRecentCheckedSongs() {
    return getSelectedRecentSongs();
}

/**
 * 删除勾选的最近播放记录（带确认弹窗）
 */
async function clearSelectedRecentPlays() {
    const selected = getSelectedRecentSongs();
    if (!selected || selected.length === 0) {
        showToast('请先选择要清空的歌曲', 'warning');
        return;
    }

    const count = selected.length;
    const doRemove = async () => {
        let ok = 0, fail = 0;
        for (const song of selected) {
            // 优先用入库时的 plugin（platform 可能是显示用平台名，如「网易专辑」≠ 入库的「网易」）
            const plugin = song.plugin || song.platform;
            try {
                const r = await API.myRecent.remove(song.id, plugin);
                if (r && r.success) ok++; else fail++;
            } catch (e) {
                fail++;
            }
        }
        if (ok > 0) {
            showToast(`已清除 ${ok} 首播放记录${fail ? `，${fail} 首失败` : ''}`, 'success');
        } else {
            showToast('清除失败', 'error');
        }
        recentSelected.clear();
        loadRecentPlays();
    };

    if (typeof showConfirmModal === 'function') {
        showConfirmModal({
            title: '清除所选',
            message: `确定要清除选中的 ${count} 首播放记录吗？此操作不可恢复。`,
            confirmText: '清除',
            cancelText: '取消',
            onConfirm: doRemove
        });
    } else {
        const confirmed = confirm(`确定要清除选中的 ${count} 首播放记录吗？`);
        if (confirmed) await doRemove();
    }
}

/**
 * 保存播放历史 - 注意：此函数已被 app.js 中的版本替代，保留是为了兼容器
 * @param {Object} music
 */
async function savePlayHistory(music) {
    if (!music || !music.id) return;

    try {
        await API.myRecent.add(music, music.plugin || music.platform);
    } catch (error) {
        console.error('保存播放历史失败:', error);
    }
}

// ==================== 播放控制函数 ====================

/**
 * 播放指定索引的最近播放歌单
 * @param {number} index - 歌曲索引
 */
function playRecentByIndex(index) {
    const songs = window.currentRecentList || [];
    const song = songs[index];
    if (!song) return;

    // 确保歌曲有 plugin 字段
    if (!song.plugin && song.platform) {
        song.plugin = song.platform;
    }

    // 检查歌曲是否有播放所需信息
    // 必须有 url 或 id 才能播放
    const canPlay = song.url || song.id;
    
    if (!canPlay) {
        showToast('歌曲信息不完整，无法播放', 'error');
        return;
    }

    // 设置当前页面列表为最近播放列表
    setCurrentPageMusicList(songs);
    
    // 播放歌曲
    playMusic(index);
}

/**
 * 播放所有选中的最近播放歌单（无选中则播放全部）
 */
function playAllRecent() {
    const allSongs = window.currentRecentList || [];

    // 管理模式勾选优先；未勾选播放全部
    const selectedSongs = getSelectedRecentSongs();

    // 有选中歌曲时播放选中的，否则播放全部
    const songsToPlay = selectedSongs.length > 0 ? selectedSongs : allSongs;

    if (songsToPlay.length === 0) {
        showToast('没有可播放的歌曲', 'warning');
        return;
    }

    // 获取第一首要播放的歌曲
    const firstSong = songsToPlay[0];

    // 确保歌曲有 plugin 字段
    if (!firstSong.plugin && firstSong.platform) {
        firstSong.plugin = firstSong.platform;
    }

    // 检查歌曲是否有播放所需信息
    const canPlay = firstSong.url || firstSong.id;
    if (!canPlay) {
        showToast('歌曲信息不完整，无法播放', 'error');
        return;
    }

    // 设置当前页面列表
    window.currentPageMusicList = songsToPlay;

    // 播放第一首（传入整个列表）
    playMusic(0);

    // 将其余歌曲添加到播放列表
    if (songsToPlay.length > 1 && typeof addToPlaylist === 'function') {
        for (let i = 1; i < songsToPlay.length; i++) {
            const song = songsToPlay[i];
            if (!song.plugin && song.platform) {
                song.plugin = song.platform;
            }
            addToPlaylist(song);
        }
    }

    const msg = selectedSongs.length > 0
        ? `开始播放选中的 ${songsToPlay.length} 首歌曲`
        : `开始播放 ${songsToPlay.length} 首歌曲`;
    showToast(msg, 'success');
}

/**
 * 获取选中的歌曲
 * @returns {Array} 选中的歌曲列表
 */
function getRecentSelectedSongs() {
    // 优先使用 MusicList 组件的获取选中歌曲方法
    if (typeof MusicList !== 'undefined' && MusicList.getSelectedSongs) {
        return MusicList.getSelectedSongs('recent');
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
function getRecentCurrentSongs() {
    return window.currentRecentList || [];
}

/**
 * 添加选中的歌曲到歌单
 * 无论是否选中歌曲，都弹出歌单选择弹窗
 */
async function addAllRecentToPlaylist() {
    const selectedSongs = getRecentSelectedSongs();
    const currentSongs = getRecentCurrentSongs();

    // 检查是否有歌曲
    if (!currentSongs || currentSongs.length === 0) {
        showToast('当前列表没有歌曲', 'warning');
        return;
    }

    // 有选中歌曲时用选中的，否则用全部歌曲
    const songsToAdd = selectedSongs.length > 0 ? selectedSongs : currentSongs;

    // 显示添加到歌单弹窗
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal(songsToAdd, '最近播放');
    } else {
        showToast('添加歌单功能未加载', 'error');
    }
}

/**
 * 下载指定索引的最近播放歌单
 * @param {number} index - 歌曲索引
 */
async function downloadRecentByIndex(index) {
    const songs = window.currentRecentList || [];
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
                showReDownloadConfirm(song);
                return;
            }
        }
    } catch (e) {
        console.error('检查下载状态失败:', e);
    }

    if (window.DownloadCore) {
        await DownloadCore.startBackendDownload(song, '最近播放-下载');
    } else {
        showToast('下载核心未加载', 'error');
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
                source: 'recent-retry',
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
}

/**
 * 下载所有选中的最近播放歌单
 */
async function downloadAllRecent() {
    const selectedSongs = getSelectedRecentSongs();
    if (selectedSongs.length === 0) {
        showToast('请先选择歌曲', 'warning');
        return;
    }

    if (window.DownloadCore && typeof window.DownloadCore.downloadBatch === 'function') {
        const downloadParams = selectedSongs.map(song => ({
            id: song.id,
            title: song.title,
            artist: song.artist,
            plugin: song.plugin || song.platform || 'default',
            quality: 'standard',
            ...song
        }));
        await window.DownloadCore.downloadBatch(downloadParams, { delay: 500 }, '最近播放-批量下载');
    } else if (window.DownloadCore) {
        selectedSongs.forEach((song, index) => {
            setTimeout(() => {
                window.DownloadCore.startBackendDownload(song, '最近播放-下载');
            }, index * 500);
        });
    }

    showToast(`已添加 ${selectedSongs.length} 首歌曲到下载队列`, 'success');
}

/**
 * 切换最近播放歌曲的收藏状态
 * @param {number} index - 歌曲索引
 */
async function toggleFavoriteRecent(index) {
    const songs = window.currentRecentList || [];
    const song = songs[index];
    if (!song) return;

    // 检查当前收藏状态
    const isFavorited = isSongFavoritedSync(song.id, song.plugin || song.platform);

    try {
        const plugin = song.plugin || song.platform;
        if (isFavorited) {
            // 取消收藏 - 使用用户隔离的API
            const result = await API.myFavorites.remove(song.id, plugin);

            if (result.success) {
                showToast('已取消收藏', 'success');
                if (window.currentFavoritesList) {
                    window.currentFavoritesList = window.currentFavoritesList.filter(f => f.id !== song.id);
                }
                // 从缓存中移除
                if (typeof removeFromFavoritesCache === 'function') {
                    removeFromFavoritesCache(song.id, plugin);
                }
                // 触发收藏变更事件，通知其他页面刷新
                if (typeof emitFavoriteChange === 'function') {
                    emitFavoriteChange(song.id, plugin, false, song);
                }
            }
        } else {
            // 添加收藏 - 使用用户隔离的API
            const result = await API.myFavorites.add(song, plugin);
            if (result.success) {
                showToast('已添加到收藏', 'success');
                if (window.currentFavoritesList) {
                    window.currentFavoritesList.push(song);
                }
                // 添加到缓存
                if (typeof addToFavoritesCache === 'function') {
                    addToFavoritesCache(song.id, plugin);
                }
                // 触发收藏变更事件
                if (typeof emitFavoriteChange === 'function') {
                    emitFavoriteChange(song.id, plugin, true, song);
                }
            }
        }
        // 重新渲染以更新图标（保持当前页码，不整页重载、不重置分页）
        if (recentContainer && window.currentRecentList) {
            renderRecentPlays(window.currentRecentList, recentContainer);
        }
    } catch (error) {
        console.error('切换收藏状态失败', error);
        showToast('操作失败: ' + error.message, 'error');
    }
}

// 导出函数到全局作用域
window.loadRecentPlays = loadRecentPlays;
window.renderRecentPlays = renderRecentPlays;
window.clearRecentPlays = clearRecentPlays;
window.savePlayHistory = savePlayHistory;
window.downloadRecentByIndex = downloadRecentByIndex;
window.syncRecentDownloadStatus = syncRecentDownloadStatus;
window.playRecentByIndex = playRecentByIndex;
window.playAllRecent = playAllRecent;
window.addAllRecentToPlaylist = addAllRecentToPlaylist;
window.downloadAllRecent = downloadAllRecent;
window.toggleFavoriteRecent = toggleFavoriteRecent;
window.toggleRecentManageMode = toggleRecentManageMode;
window.toggleRecentMenu = toggleRecentMenu;
window.closeRecentMenu = closeRecentMenu;
window.toggleRecentCardSelect = toggleRecentCardSelect;
window.toggleSelectAllRecentCards = toggleSelectAllRecentCards;
window.addSelectedRecentToPlaylist = addSelectedRecentToPlaylist;
window.downloadSelectedRecent = downloadSelectedRecent;
window.deleteSelectedRecentPlays = clearSelectedRecentPlays;
window.recentGotoPage = recentGotoPage;
window.recentChangePageSize = recentChangePageSize;
