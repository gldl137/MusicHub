/**
 * 收藏管理模块
 * 功能：管理收藏的歌曲
 */

// ==================== 收藏管理 ====================

// 卡片视图的管理模式（点「管理」后进入，顶部出现下载 / 清空）
let favoritesManageMode = false;
// 管理模式：已勾选歌曲的 key 集合（key = id|plugin）
let favoritesSelected = new Set();
// 分页状态：当前页（1 起）；每页条数用全局偏好（song-table.js 的 getSongTablePageSize）
let favPage = 1;
let favContainer = null; // 渲染容器缓存，翻页重渲染时复用

/**
 * 歌曲唯一 key（同一首歌可能来自不同插件）
 * @param {Object} song
 * @returns {string}
 */
function favoriteSongKey(song) {
    return `${song.id}|${song.plugin || song.platform || ''}`;
}

/**
 * 管理模式：当前勾选的歌曲对象列表
 * @returns {Array}
 */
function getSelectedFavoriteSongs() {
    const songs = window.currentFavoritesList || [];
    return songs.filter((s) => favoritesSelected.has(favoriteSongKey(s)));
}

// 订阅收藏状态变化
if (window.FavoriteManager) {
    let isRefreshing = false;
    FavoriteManager.subscribe('favorites', ({ musicId: _musicId, platform: _platform, isFavorited: _isFavorited }) => {
        // 如果当前在收藏页面，刷新列表（无论是添加还是取消收藏）
        // 添加收藏：显示新添加的歌单
        // 取消收藏：移除已取消收藏的歌单
        if (window.currentPage === 'favorites') {
            if (isRefreshing) return;
            isRefreshing = true;
            loadFavorites().then(() => {
                isRefreshing = false;
            });
        }
    });
}

/**
 * 加载收藏列表
 */
async function loadFavorites() {
    const container = document.getElementById('page-favorites');
    if (!container) return;

    // 避免重复加载
    if (container.dataset.loading === 'true') return;
    container.dataset.loading = 'true';

    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    try {
        // 使用用户隔离的API
        const result = await API.myFavorites.getAll();

        if (result.success && result.data) {
            const songs = result.data;
            
            if (songs.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-icon">❤️</div>
                        <div class="empty-text">暂无收藏</div>
                        <div class="empty-subtext">您收藏的歌曲将显示在这里</div>
                    </div>
                `;
                return;
            }
            
            // 保存当前收藏列表到全局，供播放使用
            window.currentFavoritesList = songs;

            // 同步到缓存，确保 MusicTable 能正确显示收藏状态
            // 注意：必须使用与 isFavoritedSync 相同的 key 格式 (platform || plugin)
            // 使用 plugin 字段（插件文件名）作为标识，与后端数据库一致
            if (typeof addToFavoritesCache === 'function') {
                songs.forEach(song => {
                    const platform = song.plugin || song.platform;
                    addToFavoritesCache(song.id, platform);
                });
            }

            // 渲染收藏列表
            renderFavorites(songs, container);
        } else {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">❤️</div>
                    <div class="empty-text">暂无收藏</div>
                    <div class="empty-subtext">您收藏的歌曲将显示在这里</div>
                </div>
            `;
        }
    } catch (error) {
        console.error('加载收藏失败:', error);
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">❌</div>
                <div class="empty-text">加载失败</div>
                <div class="empty-subtext">${escapeHtml(error.message)}</div>
            </div>
        `;
    } finally {
        container.dataset.loading = 'false';
    }
}

/**
 * 渲染收藏列表（卡片网格 + 顶部工具条）
 * @param {Array} songs - 收藏的歌曲列表
 * @param {HTMLElement} container
 */
function renderFavorites(songs, container) {
    // 存储到全局
    window.currentFavoritesList = songs;
    favContainer = container;

    if (!songs || songs.length === 0) {
        favoritesManageMode = false;
        favoritesSelected.clear();
        container.innerHTML = `
            <div class="empty-state" style="flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center;">
                <div class="empty-icon">❤️</div>
                <div class="empty-text">暂无收藏</div>
                <div class="empty-subtext">您收藏的歌曲将显示在这里</div>
            </div>`;
        return;
    }

    // 与「我的歌单」一致：不分页，全量渲染（data-index 用全列表索引）
    const pageSongs = songs;

    const n = favoritesSelected.size;
    // 与「我的歌单」一致：普通模式无工具条（播放/管理在页头「⋯」菜单），管理模式才出现操作条
    const manageBtns = favoritesManageMode ? `
                <button class="btn btn-secondary btn-sm" id="favorites-selectall-btn" onclick="toggleSelectAllFavoriteCards()">${n && n === pageSongs.length ? '取消全选' : '全选'}</button>
                <button class="btn btn-secondary btn-sm" id="favorites-add-btn" onclick="addSelectedFavoritesToPlaylist()">歌单${n ? ` (${n})` : ''}</button>
                <button class="btn btn-secondary btn-sm" id="favorites-download-btn" onclick="downloadSelectedFavorites()">下载${n ? ` (${n})` : ''}</button>
                <button class="btn btn-danger btn-sm" id="favorites-clear-btn" onclick="clearSelectedFavorites()"
                    ${n ? '' : 'disabled'} style="${n ? '' : 'opacity:.5; cursor:not-allowed;'}">删除${n ? ` (${n})` : ''}</button>
                <button class="btn btn-secondary btn-sm" onclick="toggleFavoritesManageMode()">完成</button>` : '';
    const hint = favoritesManageMode ? `
            <span style="font-size: 13px; color: var(--text-secondary);"><span style="margin-right: 8px;">💡</span>点击卡片可多选</span>` : '';

    container.innerHTML = `
        ${favoritesManageMode ? `
        <div class="media-card-toolbar">
            <div style="display: flex; gap: 8px; align-items: center; min-width: 0;">
                ${hint}
            </div>
            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
                ${manageBtns}
                <div id="favorites-count-text" style="font-size: 13px; color: var(--text-secondary);">
                    ${songs.length} 首${n ? ` · 已选 ${n}` : ''}
                </div>
            </div>
        </div>` : ''}
        <div id="favorites-card-grid" class="media-card-grid" style="flex: 1; overflow-y: auto;"></div>`;

    // 卡片网格懒加载：只渲染当前可见卡片，滚动到底追加（data-index 仍为全列表索引，不影响播放/收藏索引）
    CardListLazy.register({
        key: 'favorites',
        songs: songs,
        getGrid: () => document.getElementById('favorites-card-grid'),
        cardHtml: (s, i) => favoriteCardHtml(s, i),
        batch: 36,
        initial: 60,
        scroller: document.getElementById('favorites-card-grid')
    });

    // 页头「⋯」菜单（与我的歌单一致）：普通模式下播放/管理入口收进页头；标题带计数
    setupFavoritesHeader(songs.length);
}

/**
 * 页头「⋯」菜单（与「我的歌单」一致）：播放全部 / 添加到歌单 / 下载 / 删除
 * （后三者都进入同一个多选模式——一个功能一个入口，模式内提供 全选/添加/下载/删除/完成）
 */
function setupFavoritesHeader(count) {
    const headerLeft = document.getElementById('header-left');
    if (!headerLeft) return;
    const title = headerLeft.querySelector('.header-title');
    const pageTitle = (title ? title.textContent : '我的收藏').replace(/（.*?）$/, '');
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
                onclick="event.stopPropagation(); toggleFavoritesMenu()"
                class="header-icon-btn">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
            </button>
            <div id="favorites-menu"
                style="display: none; position: absolute; right: 0; top: calc(100% + 6px); min-width: 150px; background: var(--surface-color); border: 1px solid var(--divider-color); border-radius: 10px; box-shadow: var(--shadow-lg); z-index: 1001; padding: 6px 0; overflow: hidden;">
                <button type="button" onclick="event.stopPropagation(); playAllFavorites(); closeFavoritesMenu();"
                    style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">播放全部</button>
                <button type="button" onclick="event.stopPropagation(); openFavoritesManageMode(); closeFavoritesMenu();"
                    style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">歌单</button>
                <button type="button" onclick="event.stopPropagation(); openFavoritesManageMode(); closeFavoritesMenu();"
                    style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">下载</button>
                <button type="button" onclick="event.stopPropagation(); openFavoritesManageMode(); closeFavoritesMenu();"
                    style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--danger-color, #ff4d4f); font-size: 14px; cursor: pointer; text-align: left;">删除</button>
            </div>
        </div>
    `;
}

/**
 * 页头「⋯」菜单开关
 */
function toggleFavoritesMenu() {
    const menu = document.getElementById('favorites-menu');
    if (!menu) return;
    menu.style.display = menu.style.display !== 'block' ? 'block' : 'none';
    if (menu.style.display === 'block') {
        setTimeout(() => document.addEventListener('click', closeFavoritesMenu), 0);
    }
}

function closeFavoritesMenu() {
    const menu = document.getElementById('favorites-menu');
    if (menu) menu.style.display = 'none';
    document.removeEventListener('click', closeFavoritesMenu);
}

/**
 * 卡片分页条（复用 st-pagination 样式，与“我的播放”一致）
 */
function favoritesPaginationHtml(total, pageSize) {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = favPage;
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
        btns += `<button type="button" class="st-page-btn ${p === page ? 'active' : ''}" onclick="favGotoPage(${p})">${p}</button>`;
    });
    const sizes = SONGTABLE_PAGE_SIZES.map((s) => `<option value="${s}" ${s === pageSize ? 'selected' : ''}>${s} 条/页</option>`).join('');
    return `
        <div class="st-pagination" style="flex-shrink: 0;">
            <span class="st-page-total">共 ${total} 条</span>
            <select class="st-page-size" onchange="favChangePageSize(parseInt(this.value, 10))">${sizes}</select>
            <div class="st-page-btns">
                <button type="button" class="st-page-btn nav" ${page <= 1 ? 'disabled' : ''} onclick="favGotoPage(1)" title="首页">«</button>
                <button type="button" class="st-page-btn nav" ${page <= 1 ? 'disabled' : ''} onclick="favGotoPage(${page - 1})" title="上一页">‹</button>
                ${btns}
                <button type="button" class="st-page-btn nav" ${page >= totalPages ? 'disabled' : ''} onclick="favGotoPage(${page + 1})" title="下一页">›</button>
                <button type="button" class="st-page-btn nav" ${page >= totalPages ? 'disabled' : ''} onclick="favGotoPage(${totalPages})" title="尾页">»</button>
            </div>
        </div>`;
}

/** 翻页 / 改每页条数（卡片视图重渲染，保持管理模式与勾选状态） */
function favGotoPage(p) {
    favPage = p;
    if (favContainer && window.currentFavoritesList) {
        renderFavorites(window.currentFavoritesList, favContainer);
    }
}
function favChangePageSize(n) {
    setSongTablePageSize(n);
    favPage = 1;
    if (favContainer && window.currentFavoritesList) {
        renderFavorites(window.currentFavoritesList, favContainer);
    }
}

/**
 * 单张歌曲卡片（普通模式：点击播放 / 取消收藏；管理模式：点击勾选）
 */
function favoriteCardHtml(song, index) {
    const manage = favoritesManageMode;
    const selected = manage && favoritesSelected.has(favoriteSongKey(song));
    const title = song.title || '未知歌曲';
    const artist = song.artist || '未知歌手';
    // 网络歌曲封面不入库：无 artwork/cover 时用虚拟封面 ID 经 /api/cover 实时向插件获取
    // （与播放器 getCoverUrl 一致），避免酷我等 getMusicInfo 不返回封面的插件在列表里空白。
    const coverId = song.coverArt || song.virtualId
        || (typeof song.id === 'string' && song.id.startsWith('remote__') ? song.id : null);
    const cover = song.artwork || song.cover || song.coverImg || song.pic
        || (coverId ? `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(coverId)}` : null);
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
    // 年代（取 4 位年份，兼容 2026 / 2026-01-01 等格式）
    const yearMatch = song.year ? String(song.year).match(/\d{4}/) : null;
    const year = yearMatch ? yearMatch[0] : '';
    // 普通模式：左上角红心（点击取消收藏）
    const heartHtml = manage ? '' : `<div onclick="event.stopPropagation(); toggleFavoriteByIndex(${index})" title="取消收藏"
            style="position: absolute; top: 6px; left: 6px; font-size: 20px; line-height: 1; cursor: pointer;
                   color: #ff4d4f; text-shadow: 0 1px 3px rgba(0,0,0,.55); z-index: 3; user-select: none;">♥</div>`;
    // 管理模式：左上角勾选框
    const checkHtml = manage ? `<div class="favorite-check"
            style="position: absolute; top: 6px; left: 6px; width: 22px; height: 22px; border-radius: 50%; box-sizing: border-box;
                   border: 1.5px solid ${selected ? 'var(--primary-color)' : 'rgba(255,255,255,.75)'};
                   background: ${selected ? 'var(--primary-color)' : 'rgba(0,0,0,.35)'};
                   color: #fff; font-size: 13px; line-height: 19px; text-align: center; z-index: 3; user-select: none;">${selected ? '✓' : ''}</div>` : '';
    const clickAttr = manage
        ? `onclick="toggleFavoriteCardSelect(${index})"`
        : `onclick="playFavoriteByIndex(${index})"`;
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
                ${manage ? '' : `<button class="media-card-play" title="播放" onclick="event.stopPropagation(); playFavoriteByIndex(${index})"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>`}
            </div>
            <div class="media-card-title">${escapeHtml(title)}</div>
            <div class="media-card-sub">${escapeHtml(artist)}</div>
            ${(() => {
                const meta = [year, sourceText ? `来源：${sourceText}` : ''].filter(Boolean).join(' · ');
                return meta ? `<div class="media-card-sub" style="font-size: 11px; color: var(--text-tertiary);">${escapeHtml(meta)}</div>` : '';
            })()}
        </div>`;
}

// ==================== 管理模式：多选 / 下载 / 清空 ====================

/**
 * 切换管理模式
 */
function toggleFavoritesManageMode() {
    favoritesManageMode = !favoritesManageMode;
    favoritesSelected.clear();
    const container = document.getElementById('page-favorites');
    if (container) renderFavorites(window.currentFavoritesList || [], container);
}

/**
 * 进入管理模式（页头「⋯」菜单的 添加到歌单 / 下载 / 删除 共用入口）。
 * 模式内提供 全选 / 添加(N) / 下载(N) / 删除(N) / 完成；已在模式中则不重复切换。
 */
function openFavoritesManageMode() {
    if (!favoritesManageMode) toggleFavoritesManageMode();
}

/**
 * 点击卡片切换勾选（管理模式）
 */
function toggleFavoriteCardSelect(index) {
    const song = (window.currentFavoritesList || [])[index];
    if (!song) return;
    const key = favoriteSongKey(song);
    if (favoritesSelected.has(key)) favoritesSelected.delete(key);
    else favoritesSelected.add(key);
    syncFavoritesSelectionUI();
}

/**
 * 全选 / 取消全选（管理模式）
 */
function toggleSelectAllFavoriteCards() {
    const songs = window.currentFavoritesList || [];
    const allSelected = songs.length > 0 && songs.every((s) => favoritesSelected.has(favoriteSongKey(s)));
    if (allSelected) songs.forEach((s) => favoritesSelected.delete(favoriteSongKey(s)));
    else songs.forEach((s) => favoritesSelected.add(favoriteSongKey(s)));
    syncFavoritesSelectionUI();
}

/**
 * 局部刷新勾选态：卡片勾选框 / 高亮 + 顶部按钮文案
 */
function syncFavoritesSelectionUI() {
    const songs = window.currentFavoritesList || [];
    const grid = document.getElementById('favorites-card-grid');
    if (grid) {
        grid.querySelectorAll('.favorite-card').forEach((card) => {
            const song = songs[parseInt(card.dataset.index, 10)];
            const on = song ? favoritesSelected.has(favoriteSongKey(song)) : false;
            card.style.boxShadow = on ? '0 0 0 2px var(--primary-color)' : 'none';
            const box = card.querySelector('.favorite-check');
            if (box) {
                box.textContent = on ? '✓' : '';
                box.style.background = on ? 'var(--primary-color)' : 'rgba(0,0,0,.35)';
                box.style.borderColor = on ? 'var(--primary-color)' : 'rgba(255,255,255,.75)';
            }
        });
    }
    const n = favoritesSelected.size;
    const addBtn = document.getElementById('favorites-add-btn');
    if (addBtn) addBtn.textContent = n ? `歌单 (${n})` : '歌单';
    const dlBtn = document.getElementById('favorites-download-btn');
    if (dlBtn) dlBtn.textContent = n ? `下载 (${n})` : '下载';
    const clrBtn = document.getElementById('favorites-clear-btn');
    if (clrBtn) {
        clrBtn.textContent = n ? `删除 (${n})` : '删除';
        if (n) {
            clrBtn.disabled = false;
            clrBtn.style.opacity = '1';
            clrBtn.style.cursor = 'pointer';
        } else {
            clrBtn.disabled = true;
            clrBtn.style.opacity = '.5';
            clrBtn.style.cursor = 'not-allowed';
        }
    }
    const allBtn = document.getElementById('favorites-selectall-btn');
    if (allBtn) {
        const pageSize = getSongTablePageSize();
        const totalPages = Math.max(1, Math.ceil((window.currentFavoritesList || []).length / pageSize));
        const page = Math.min(Math.max(1, favPage || 1), totalPages);
        const pageCount = (window.currentFavoritesList || []).slice((page - 1) * pageSize, page * pageSize).length;
        allBtn.textContent = (n && n === pageCount) ? '取消全选' : '全选';
    }
    const countEl = document.getElementById('favorites-count-text');
    if (countEl) {
        countEl.textContent = `${songs.length} 首${favoritesManageMode && n ? ` · 已选 ${n}` : ''}`;
    }
}

/**
 * 下载已勾选的收藏歌曲
 */
async function downloadSelectedFavorites() {
    const songs = getSelectedFavoriteSongs();
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
            await window.DownloadCore.downloadBatch(params, { delay: 500 }, '收藏-下载');
        } catch (e) {
            showToast('下载失败: ' + (e && e.message ? e.message : ''), 'error');
        }
        return;
    }
    if (window.DownloadCore) {
        for (const s of songs) {
            try { await window.DownloadCore.startBackendDownload(s, '收藏-下载'); } catch (e) { /* 单个失败继续 */ }
        }
        return;
    }
    showToast('下载管理器未加载', 'error');
}

/**
 * 把选中的收藏歌曲添加到歌单（管理模式「添加」按钮）
 */
function addSelectedFavoritesToPlaylist() {
    const songs = getSelectedFavoriteSongs();
    if (!songs.length) {
        showToast('请先选择要添加的歌曲', 'warning');
        return;
    }
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal(songs, '我的收藏');
    } else {
        showToast('歌单功能未加载', 'error');
    }
}

/**
 * 把收藏歌曲全部添加到歌单（普通模式「添加」按钮，保留以兼容旧调用）
 */
function addAllFavoritesToPlaylist() {
    const songs = window.currentFavoritesList || [];
    if (!songs.length) {
        showToast('没有可添加的歌曲', 'warning');
        return;
    }
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal(songs, '我的收藏');
    } else {
        showToast('歌单功能未加载', 'error');
    }
}

/**
 * 播放指定索引的收藏歌单
 * @param {number} index - 歌曲索引
 */
async function playFavoriteByIndex(index) {
    const songs = window.currentFavoritesList || [];
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

    // 设置当前页面列表为收藏列表
    setCurrentPageMusicList(songs);
    
    // 播放歌曲
    playMusic(index);
}

/**
 * 播放所有收藏歌单（无选中则播放全部）
 */
function playAllFavorites() {
    const allSongs = window.currentFavoritesList || [];
    
    if (allSongs.length === 0) {
        showToast('没有可播放的歌曲', 'warning');
        return;
    }

    // 使用 MusicList.getSelectedSongs 获取选中的歌曲（如果可用）
    let songs = [];
    if (typeof MusicList !== 'undefined' && MusicList.getSelectedSongs) {
        songs = MusicList.getSelectedSongs('favorites');
    }
    
    // 没有选中时播放全部
    if (songs.length === 0) {
        songs = allSongs;
    }
    
    if (songs.length === 0) {
        showToast('没有可播放的歌曲', 'warning');
        return;
    }
    
    // 设置播放列表
    window.currentPageMusicList = songs;
    
    // 播放第一首
    playMusic(0);
    
    const msg = (typeof MusicList !== 'undefined' && MusicList.getSelectedSongs && MusicList.getSelectedSongs('favorites').length > 0)
        ? `开始播放选中的 ${songs.length} 首歌曲`
        : `开始播放 ${songs.length} 首歌曲`;
    showToast(msg, 'success');
}

/**
 * 获取选中的歌曲
 * @returns {Array} 选中的歌曲列表
 */
function getSelectedSongs() {
    // 优先使用 MusicList 组件的获取选中歌曲方法
    if (typeof MusicList !== 'undefined' && MusicList.getSelectedSongs) {
        return MusicList.getSelectedSongs('favorites');
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
function getCurrentSongs() {
    return window.currentFavoritesList || [];
}

/**
 * 显示确认弹窗
 * @param {Object} options - 配置选项
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

/**
 * 关闭确认弹窗
 */
function closeConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    if (modal) {
        modal.remove();
    }
}

/**
 * 添加选中的歌曲到歌单
 * 无论是否选中歌曲，都弹出歌单选择弹窗
 */
async function addAllToPlaylist() {
    const selectedSongs = getSelectedSongs();
    const currentSongs = getCurrentSongs();

    // 检查是否有歌曲
    if (!currentSongs || currentSongs.length === 0) {
        showToast('当前列表没有歌曲', 'warning');
        return;
    }

    // 有选中歌曲时用选中的，否则用全部歌曲
    const songsToAdd = selectedSongs.length > 0 ? selectedSongs : currentSongs;

    // 显示添加到歌单弹窗
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal(songsToAdd, '我的收藏');
    } else {
        showToast('添加歌单功能未加载，请先访问"我的歌单"页面', 'warning');
    }
}

/**
 * 添加歌曲到新歌单
 * @param {Array} songs - 歌曲列表
 * @param {string} playlistName - 歌单名称
 */
async function addSongsToNewPlaylist(songs, playlistName) {
    try {
        showToast('正在创建歌单...');

        // 创建歌单 - 使用用户隔离的API
        const result = await API.playlists.create(playlistName, '', '');

        if (result.success && result.data) {
            const playlistId = result.data.id;

            // 添加歌曲到歌单
            let successCount = 0;

            for (const song of songs) {
                try {
                    const formattedSong = {
                        id: song.id,
                        title: song.title || song.name || '未知歌曲',
                        artist: song.artist || song.singer || '未知歌手',
                        album: song.album || '',
                        duration: song.duration || 0,
                        cover: song.cover || song.artwork || '',
                        plugin: song.plugin || song.platform || 'unknown',
                        url: song.url || ''
                    };

                    const addResponse = await fetch(`${API_BASE}/api/my/playlists/${playlistId}/songs`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ music: formattedSong })
                    });

                    const addResult = await addResponse.json();
                    if (addResult.success) {
                        successCount++;
                    }
                } catch (err) {
                    // 添加失败，继续处理下一首
                }
            }

            if (successCount > 0) {
                showToast(`已添加 ${successCount} 首歌曲到 "${playlistName}"`, 'success');
                // 刷新侧边栏歌单列表
                if (typeof loadSidebarPlaylists === 'function') {
                    loadSidebarPlaylists();
                }
            } else {
                showToast('添加歌曲失败', 'error');
            }
        } else {
            showToast('创建歌单失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('创建歌单失败:', error);
        showToast('创建歌单失败: ' + error.message, 'error');
    }
}

/**
 * 下载所有收藏
 */
function downloadAllFavorites() {
    showToast('功能开发中...');
}

/**
 * 切换指定索引歌曲的收藏状态
 * @param {number} index - 歌曲索引
 */
async function toggleFavoriteByIndex(index) {
    const songs = window.currentFavoritesList || [];
    const song = songs[index];
    if (!song) return;

    // 确保使用 plugin 字段（插件文件名）作为标识，与后端数据库一致
    // 后端 removeFavorite 使用 plugin 字段查询歌曲
    if (!song.plugin) {
        song.plugin = song.platform;
    }


    // 调用全局 toggleFavoriteSong
    const isFav = await toggleFavoriteSong(song);

    // 显示提示
    showToast(isFav ? '已添加到收藏' : '已取消收藏', 'success');

    // 刷新收藏列表（取消收藏后刷新）
    if (!isFav) {
        loadFavorites();
    }
}

/**
 * 下载指定索引的收藏歌单
 * @param {number} index - 歌曲索引
 */
async function downloadFavoriteByIndex(index) {
    const songs = window.currentFavoritesList || [];
    const song = songs[index];
    if (!song) return;

    // 使用 plugin 字段（插件文件名），而不是 platform（平台名称）
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
        await DownloadCore.startBackendDownload(song, '收藏-下载');
    } else {
        showToast('下载管理器未加载', 'error');
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
                source: 'favorites-retry',
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
 * 获取收藏页当前勾选的歌曲（基于 DOM 复选框，确保与界面一致）
 * @returns {Array} 选中的歌曲列表
 */
function getFavoritesCheckedSongs() {
    // 卡片管理模式：以勾选集合为准
    if (favoritesManageMode) return getSelectedFavoriteSongs();
    const checkboxes = document.querySelectorAll('#page-favorites .row-checkbox:checked');
    const songs = window.currentFavoritesList || [];
    const selected = [];
    checkboxes.forEach(cb => {
        const index = parseInt(cb.dataset.index);
        if (songs[index]) selected.push(songs[index]);
    });
    return selected;
}

/**
 * 仅删除勾选的收藏（带确认弹窗）
 */
async function clearSelectedFavorites() {
    const selected = getFavoritesCheckedSongs();
    if (!selected || selected.length === 0) {
        showToast('请先选择要删除的歌曲', 'warning');
        return;
    }

    const count = selected.length;
    const doRemove = async () => {
        let ok = 0, fail = 0;
        for (const song of selected) {
            // 入库 plugin 优先（platform 可能是显示用平台名）
            const plugin = song.plugin || song.platform;
            try {
                const r = await API.myFavorites.remove(song.id, plugin);
                if (r && r.success) ok++; else fail++;
            } catch (e) {
                fail++;
            }
        }
        if (ok > 0) {
            showToast(`已清除 ${ok} 首收藏${fail ? `，${fail} 首失败` : ''}`, 'success');
        } else {
            showToast('清除失败', 'error');
        }
        favoritesSelected.clear();
        loadFavorites();
    };

    if (typeof showConfirmModal === 'function') {
        showConfirmModal({
            title: '清除所选',
            message: `确定要清除选中的 ${count} 首收藏吗？此操作不可恢复。`,
            confirmText: '清除',
            cancelText: '取消',
            onConfirm: doRemove
        });
    } else {
        const confirmed = confirm(`确定要清除选中的 ${count} 首收藏吗？`);
        if (confirmed) await doRemove();
    }
}

/**
 * 清空收藏
 */
async function clearFavorites() {
    const confirmed = await Notification.confirm('确定要清空所有收藏吗？', { type: 'warning' });
    if (!confirmed) {
        return;
    }

    try {
        // 使用用户隔离的API - 需要遍历删除所有收藏
        const favoritesResult = await API.myFavorites.getAll();
        if (favoritesResult.success && favoritesResult.data) {
            for (const song of favoritesResult.data) {
                const plugin = song.plugin || song.platform;
                await API.myFavorites.remove(song.id, plugin);
            }
        }
        const result = { success: true };

        if (result.success) {
            showToast('收藏已清空', 'success');
            loadFavorites();
        } else {
            showToast('清空失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('清空收藏失败:', error);
        showToast('清空失败: ' + error.message, 'error');
    }
}

// 导出函数到全局作用用户
window.toggleFavoritesManageMode = toggleFavoritesManageMode;
window.toggleFavoritesMenu = toggleFavoritesMenu;
window.closeFavoritesMenu = closeFavoritesMenu;
window.toggleFavoriteCardSelect = toggleFavoriteCardSelect;
window.toggleSelectAllFavoriteCards = toggleSelectAllFavoriteCards;
window.favGotoPage = favGotoPage;
window.favChangePageSize = favChangePageSize;
window.downloadSelectedFavorites = downloadSelectedFavorites;
window.addAllFavoritesToPlaylist = addAllFavoritesToPlaylist;
window.addSelectedFavoritesToPlaylist = addSelectedFavoritesToPlaylist;
window.clearSelectedFavorites = clearSelectedFavorites;
window.loadFavorites = loadFavorites;
window.clearFavorites = clearFavorites;
window.playFavoriteByIndex = playFavoriteByIndex;
window.toggleFavoriteByIndex = toggleFavoriteByIndex;
window.downloadFavoriteByIndex = downloadFavoriteByIndex;
window.playAllFavorites = playAllFavorites;
window.addAllToPlaylist = addAllToPlaylist;
window.downloadAllFavorites = downloadAllFavorites;
window.addSongsToNewPlaylist = addSongsToNewPlaylist;
window.showConfirmModal = showConfirmModal;
window.closeConfirmModal = closeConfirmModal;
