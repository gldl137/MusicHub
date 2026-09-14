/**
 * 歌单管理模块
 * 功能：创建歌单、加载歌单列表、渲染歌单、打开歌单详情、编辑、删除、拖拽排序
 */


// ==================== 全局状态 ====================
let currentPlaylists = [];
window.currentPlaylistDetail = null;
let isEditMode = false;
// 「调整顺序」模式：仅该模式下卡片可拖拽排序（与删除模式互斥）
let isReorderMode = false;
// 管理模式：已勾选的歌单 id（批量删除用）
let selectedPlaylists = new Set();
let draggedItem = null;
let isEventDelegated = false; // 标记事件委托是否已绑定

// ==================== 插件别名前缀 ====================

/**
 * 从插件标识(id)在当前已装插件中解析别名(displayName)，如“酷我”
 * @param {string} id 插件文件名或平台名
 * @returns {string} 插件别名，无则返回空串
 */
function aliasFromInstalled(id) {
    if (!id) return '';
    // 落雪（LX）音源不在 MusicFree 插件列表里：命名用途只取平台显示名（如「QQ音乐」）。
    // 不用 getMusicSourceText——那是「来源」列展示专用（平台名-音源脚本文件名），
    // 做歌单名前缀会出现「QQ音乐-HYWmusic_公益版_v1.0.3.js-xxx」这种长名
    if (/^lx:/i.test(String(id))) {
        if (typeof window.getLxPlatformName === 'function') {
            const n = window.getLxPlatformName(String(id).slice(3));
            if (n) return n;
        }
        return '';
    }
    const list = window.installedPlugins || [];
    const p = list.find(x => x.name === id || x.platform === id);
    return (p && typeof p.displayName === 'string' && p.displayName.trim()) ? p.displayName.trim() : '';
}

/**
 * 生成带插件别名前缀的歌单名（如“酷我-热歌榜”）。
 * 优先用传入的 pluginName；缺省时从歌曲数组取插件标识；已带前缀则不重复。
 * 若本地 installedPlugins 缺少匹配，会拉取一次 /api/plugins 再解析，保证可靠。
 * @param {string} name 歌单名
 * @param {Array} songs 歌曲数组
 * @param {string} pluginName 插件标识
 * @returns {Promise<string>} 加好前缀的歌单名
 */
window.getEffectivePlaylistName = async function (name, songs, pluginName) {
    const id = pluginName || (Array.isArray(songs) && songs.length ? (songs[0].plugin || songs[0].platform || '') : '');
    let alias = aliasFromInstalled(id);
    if (!alias && id) {
        try {
            // 走共享缓存（TTL + 并发合并 + 带鉴权头），替代此前的裸 fetch 直连
            const list = await window.fetchInstalledPluginsCached();
            if (Array.isArray(list)) window.installedPlugins = list;
        } catch (_) { /* 拉取失败则按原名单 */ }
        alias = aliasFromInstalled(id);
    }
    if (alias && name && !name.startsWith(`${alias}-`)) {
        return `${alias}-${name}`;
    }
    return name;
};

// ==================== 歌单管理 ====================

/**
 * 显示创建歌单弹窗
 */
function showCreatePlaylistModal() {
    const existingModal = document.getElementById('playlist-modal');
    if (existingModal) {
        existingModal.remove();
    }

    const modal = document.createElement('div');
    modal.id = 'playlist-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content" style="width: 400px; max-width: 90%;">
            <div class="modal-header">
                <h3 class="modal-title">创建新歌单</h3>
                <button class="modal-close" onclick="closePlaylistModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label class="form-label">歌单名称 *</label>
                    <input type="text" id="playlist-name-input" class="form-input" placeholder="请输入歌单名称">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closePlaylistModal()">取消</button>
                <button class="btn btn-primary" onclick="submitCreatePlaylist()">创建</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closePlaylistModal();
        }
    });

    setTimeout(() => {
        document.getElementById('playlist-name-input')?.focus();
    }, 100);

    document.getElementById('playlist-name-input')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            submitCreatePlaylist();
        }
    });
}

/**
 * 显示编辑歌单弹窗
 */
function showEditPlaylistModal(playlist) {
    const playlistId = playlist.id;
    const currentName = playlist.name;
    const isPublic = !!playlist.isPublic;
    const existingModal = document.getElementById('playlist-modal');
    if (existingModal) {
        existingModal.remove();
    }

    const modal = document.createElement('div');
    modal.id = 'playlist-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content" style="width: 400px; max-width: 90%;">
            <div class="modal-header">
                <h3 class="modal-title">编辑歌单</h3>
                <button class="modal-close" onclick="closePlaylistModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label class="form-label">歌单名称 *</label>
                    <input type="text" id="playlist-name-input" class="form-input" placeholder="请输入歌单名称" value="${escapeHtml(currentName)}">
                </div>
                <div class="form-group">
                    <label class="form-label">公开</label>
                    <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; color:var(--text-secondary);">
                        <input type="checkbox" id="playlist-public-input" ${isPublic ? 'checked' : ''}>
                        <span>开启后该歌单对所有用户可见</span>
                    </label>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closePlaylistModal()">取消</button>
                <button class="btn btn-primary" onclick="submitEditPlaylist(${playlistId})">保存</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closePlaylistModal();
        }
    });

    setTimeout(() => {
        document.getElementById('playlist-name-input')?.focus();
    }, 100);

    document.getElementById('playlist-name-input')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            submitEditPlaylist(playlistId);
        }
    });
}

/**
 * 关闭弹窗
 */
function closePlaylistModal() {
    const modal = document.getElementById('playlist-modal');
    if (modal) {
        modal.remove();
    }
}

/**
 * 提交创建歌单
 */
async function submitCreatePlaylist() {
    const nameInput = document.getElementById('playlist-name-input');
    const name = nameInput?.value?.trim();

    if (!name) {
        showToast('请输入歌单名称', 'warning');
        nameInput?.focus();
        return;
    }

    try {
        const result = await API.playlists.create(name);

        if (result.success) {
            showToast('歌单创建成功', 'success');
            closePlaylistModal();
            loadSidebarPlaylists();
            loadMyPlaylists();
        } else {
            showToast('创建失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('创建歌单失败:', error);
        showToast('创建失败: ' + error.message, 'error');
    }
}

/**
 * 提交编辑歌单
 */
async function submitEditPlaylist(playlistId) {
    const nameInput = document.getElementById('playlist-name-input');
    const name = nameInput?.value?.trim();
    const publicInput = document.getElementById('playlist-public-input');
    const isPublic = publicInput ? publicInput.checked : false;

    if (!name) {
        showToast('请输入歌单名称', 'warning');
        nameInput?.focus();
        return;
    }

    try {
        const result = await API.playlists.update(playlistId, { name, public: isPublic });

        if (result.success) {
            showToast('歌单更新成功', 'success');
            closePlaylistModal();
            loadSidebarPlaylists();
            loadMyPlaylists();
        } else {
            showToast('更新失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('更新歌单失败:', error);
        showToast('更新失败: ' + error.message, 'error');
    }
}

/**
 * 创建新歌单
 */
function createPlaylist() {
    showCreatePlaylistModal();
}

/**
 * 加载侧边栏歌单列表
 */
async function loadSidebarPlaylists() {
    const container = document.getElementById('sidebar-playlist-container');
    if (!container) return;

    try {
        const result = await API.playlists.getAll();

        if (result.success && result.data && result.data.length > 0) {
            renderSidebarPlaylists(result.data, container);
        } else {
            container.innerHTML = '';
        }
    } catch (error) {
        console.error('加载侧边栏歌单失败:', error);
        container.innerHTML = '';
    }
}

/**
 * 渲染侧边栏歌单列表
 */
function renderSidebarPlaylists(playlists, container) {
    // 更新当前歌单列表
    currentPlaylists = playlists;

    let html = '';
    playlists.forEach(playlist => {
        html += `
            <div class="nav-item sidebar-playlist-item" data-playlist-id="${playlist.id}" style="padding-left: 20px; display: flex; align-items: center; justify-content: space-between; position: relative; cursor: pointer;">
                <div style="display: flex; align-items: center; flex: 1; min-width: 0; gap: 8px;">
                    <div class="nav-item-icon" style="font-size: 14px; flex-shrink: 0; position: relative;">
                        ${playlist.cover ? createImageWithFallback(playlist.cover, playlist.name, 'sidebar-cover') : ''}
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
                    </div>
                    <div class="nav-item-text" style="font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(playlist.name)}</div>
                </div>
                <div class="sidebar-playlist-actions" style="display: none; gap: 4px; flex-shrink: 0; padding-left: 8px;">
                    <button class="btn-icon btn-edit-sidebar" data-playlist-id="${playlist.id}" title="编辑" style="width: 24px; height: 24px; border-radius: 50%; border: none; background: transparent; color: var(--text-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button class="btn-icon btn-delete-sidebar" data-playlist-id="${playlist.id}" title="删除" style="width: 24px; height: 24px; border-radius: 50%; border: none; background: transparent; color: var(--text-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;

    // 绑定侧边栏按钮事件
    bindSidebarPlaylistEvents();
}

/**
 * 绑定侧边栏歌单按钮事件
 */
function bindSidebarPlaylistEvents() {
    const container = document.getElementById('sidebar-playlist-container');
    if (!container) return;

    const items = container.querySelectorAll('.sidebar-playlist-item');

    items.forEach(item => {
        const actions = item.querySelector('.sidebar-playlist-actions');
        const playlistId = parseInt(item.dataset.playlistId);

        // 点击歌单打开详情
        item.addEventListener('click', (e) => {
            // 如果点击的是编辑或删除按钮，不触发打开详情
            if (e.target.closest('.btn-edit-sidebar') || e.target.closest('.btn-delete-sidebar')) {
                return;
            }
            openPlaylist(playlistId);
        });

        // 鼠标悬停显示按钮
        item.addEventListener('mouseenter', () => {
            if (actions) actions.style.display = 'flex';
        });

        // 鼠标离开隐藏按钮
        item.addEventListener('mouseleave', () => {
            if (actions) actions.style.display = 'none';
        });

        // 编辑按钮
        const editBtn = item.querySelector('.btn-edit-sidebar');
        if (editBtn) {
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const playlistId = parseInt(editBtn.dataset.playlistId);
                const playlist = currentPlaylists.find(p => p.id === playlistId);
                if (playlist) {
                    showEditPlaylistModal(playlist);
                }
            });
        }

        // 删除按钮
        const deleteBtn = item.querySelector('.btn-delete-sidebar');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const playlistId = parseInt(deleteBtn.dataset.playlistId);
                const playlist = currentPlaylists.find(p => p.id === playlistId);
                if (playlist) {
                    confirmDeletePlaylist(playlist.id, playlist.name);
                }
            });
        }
    });
}

/**
 * 加载我的歌单列表
 */
async function loadMyPlaylists() {
    const container = document.getElementById('page-my-playlists');
    if (!container) return;

    // 返回歌单列表时自动退出详情页的多选模式
    playlistDetailManageMode = false;

    // 如果有当前歌单详情，直接显示详情
    if (window.currentPlaylistDetail) {
        document.body.classList.add('playlist-detail-open');
        // 顶部 header 不再显示歌单名标题（Hero 区已有歌单名）
        renderPlaylistDetail(window.currentPlaylistDetail);
        return;
    }

    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    try {
        const result = await API.playlists.getAll();

        loadSidebarPlaylists();

        if (result.success) {
            currentPlaylists = result.data || [];
            // 清理指向已删除歌单的勾选，避免计数与卡片勾选态不一致
            const alive = new Set(currentPlaylists.map((p) => String(p.id)));
            selectedPlaylists = new Set(Array.from(selectedPlaylists).filter((id) => alive.has(String(id))));
            // 动态榜单歌单：并行预取实时状态（卡片「更新中 → 正常/失败」），完成后自动刷新卡片
            prefetchToplistStatus();
            // 从详情返回列表时，恢复标准头部（菜单按钮 + “我的歌单”标题）
            document.body.classList.remove('playlist-detail-open');
            const headerLeft = document.getElementById('header-left');
            if (headerLeft) {
                headerLeft.innerHTML = `
                    <button class="mobile-menu-btn" onclick="toggleMobileSidebar()" aria-label="打开菜单">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="3" y1="12" x2="21" y2="12"></line>
                            <line x1="3" y1="6" x2="21" y2="6"></line>
                            <line x1="3" y1="18" x2="21" y2="18"></line>
                        </svg>
                    </button>
                    <div class="header-title my-playlists-title" id="page-title">我的歌单（${currentPlaylists.length}个）</div>
                    <div style="margin-left: auto; position: relative; display: flex; align-items: center;">
                        <button type="button" title="更多" aria-label="更多"
                            onclick="event.stopPropagation(); togglePlaylistMenu()"
                            class="header-icon-btn">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
                        </button>
                        <div id="playlist-menu"
                            style="display: none; position: absolute; right: 0; top: calc(100% + 6px); min-width: 150px; background: var(--surface-color); border: 1px solid var(--divider-color); border-radius: 10px; box-shadow: var(--shadow-lg); z-index: 1001; padding: 6px 0; overflow: hidden;">
                            <button type="button" onclick="event.stopPropagation(); createPlaylist(); closePlaylistMenu();"
                                style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">创建歌单</button>
                            <button type="button" id="playlist-menu-manage" onclick="event.stopPropagation(); toggleEditMode(); closePlaylistMenu();"
                                style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--danger-color, #ff4d4f); font-size: 14px; cursor: pointer; text-align: left;">管理</button>
                        </div>
                    </div>
                `;
            }
            // 清理详情页顶部右侧的「⋯」按钮
            document.querySelectorAll('.playlist-detail-more').forEach(el => el.remove());
            // 始终渲染列表网格（歌单>0时），不再自动打开详情，保证返回按钮能回到列表主页
            if (currentPlaylists.length > 0) {
                renderMyPlaylists(currentPlaylists, container);
            } else {
                renderEmptyState(container);
            }
        } else {
            showToast('加载失败: ' + (result.error || '未知错误'), 'error');
            renderEmptyState(container);
        }
    } catch (error) {
        console.error('加载歌单失败:', error);
        showToast('加载失败: ' + error.message, 'error');
        renderErrorState(container, error.message);
    }
}

/**
 * 渲染空状态
 */
function renderEmptyState(container) {
    container.innerHTML = `
        <div class="empty-state">
            <div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>
            <div class="empty-text">暂无歌单</div>
            <div class="empty-subtext">点击左侧"创建歌单"按钮创建您的第一个歌单</div>
        </div>
    `;
}

/**
 * 渲染错误状态
 */
function renderErrorState(container, message) {
    container.innerHTML = `
        <div class="empty-state">
            <div class="empty-icon">❌</div>
            <div class="empty-text">加载失败</div>
            <div class="empty-subtext">${escapeHtml(message)}</div>
        </div>
    `;
}

/**
 * 渲染歌单列表
 */
function renderMyPlaylists(playlists, container) {
    window._playlistListContainer = container; // 记录列表容器，动态榜单预取完成后刷新卡片状态用
    const selectedCount = selectedPlaylists.size;
    // 普通模式：[管理]（「更新」按钮已随网络歌单定时刷新功能移除：动态歌单实时拉取，无需刷新）
    const normalBtns = '';
    // 创建歌单入口统一在顶部「⋯」菜单：内容区工具条不再显示该按钮
    const createBtn = '';
    const manageBtns = isEditMode ? `
                <button class="btn btn-secondary btn-sm" id="playlist-selectall-btn" onclick="toggleSelectAllPlaylists()">${selectedCount && selectedCount === playlists.length ? '取消全选' : '全选'}</button>
                <button class="btn btn-secondary btn-sm" id="playlist-delete-btn" onclick="deleteSelectedPlaylists()"
                    ${selectedCount ? '' : 'disabled'} style="${selectedCount ? '' : 'opacity:.5; cursor:not-allowed;'}">删除${selectedCount ? ` (${selectedCount})` : ''}</button>` : '';
    // 普通模式下工具条为空：不渲染，避免顶部空占位拉大与顶部菜单的间距
    const toolbarHtml = (createBtn || manageBtns) ? `
        <div class="playlist-toolbar media-card-toolbar">
            <div style="display: flex; gap: 8px; align-items: center; min-width: 0;">
                <span style="font-size: 13px; color: var(--text-secondary);"><span style="margin-right: 8px;">💡</span>勾选卡片可删除，按住卡片拖动可调整顺序</span>
            </div>
            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
                ${normalBtns}
                ${createBtn}
                ${manageBtns}
                <button class="btn btn-secondary btn-sm" onclick="toggleEditMode()">完成</button>
            </div>
        </div>` : '';
    let html = `
        ${toolbarHtml}
        <div class="playlist-list" id="playlist-list-container">
    `;

    html += `<div class="playlist-grid media-card-grid ${isEditMode ? 'playlist-grid-edit' : ''}" 
        id="playlist-grid" 
    >`;

    playlists.forEach((playlist, index) => {
        html += renderPlaylistCard(playlist, index);
    });

    html += '</div></div>';
    container.innerHTML = html;

    if (isEditMode) {
        setupDragAndDrop();
    }
}

/**
 * 渲染单个歌单卡片
 */
function renderPlaylistCard(playlist, index) {
    const isEdit = isEditMode;
    // 动态歌单（实时榜单/实时热门歌单）：实时状态（更新中/正常/失败），封面用来源实时封面
    const isLiveToplist = !!playlist.sourceType;
    const live = isLiveToplist ? (toplistLiveStatus.get(String(playlist.id)) || { status: 'loading' }) : null;
    const cardCover = (live && live.status === 'ok' && live.cover) ? live.cover : playlist.cover;
    // 封面左下角音源角标（MF / LX）：按歌单内曲目构成显示（本地/空歌单不显示）
    const srcBadgeHtml = (typeof getPlaylistSourceBadgeHtml === 'function')
        ? getPlaylistSourceBadgeHtml(playlist)
        : '';
    // 管理模式：左上角勾选框（多选删除用）
    const selected = isEdit && selectedPlaylists.has(String(playlist.id));
    const checkHtml = isEdit ? `
                        <div class="playlist-check" data-id="${playlist.id}"
                            style="position: absolute; top: 8px; left: 8px; width: 22px; height: 22px; border-radius: 50%; box-sizing: border-box;
                                   border: 1.5px solid ${selected ? 'var(--primary-color)' : 'rgba(255,255,255,.75)'};
                                   background: ${selected ? 'var(--primary-color)' : 'rgba(0,0,0,.35)'};
                                   color: #fff; font-size: 13px; line-height: 19px; text-align: center; z-index: 3; user-select: none;">${selected ? '✓' : ''}</div>` : '';

    // 「调整顺序」模式：卡片右上角显示 ↑↓ 按钮（不使用拖拽，兼容性最稳）
    const isReorder = typeof isReorderMode !== 'undefined' && isReorderMode;
    // 拖拽事件统一由 document 委托处理（见文件末尾 setupReorderDragDelegation），
    // 这里只控制元素是否可拖拽，避免内联绑定与委托重复触发。

    return `
        <div class="playlist-card-wrapper media-card ${selected ? 'playlist-selected' : ''}"
            data-index="${index}" 
            data-id="${playlist.id}"
            ${isReorder ? 'draggable="true"' : ''}
            style="position: relative; border-radius: 10px; box-shadow: ${selected ? '0 0 0 2px var(--primary-color)' : 'none'};"
        >
            <div class="playlist-card" 
                onclick="${isEdit ? `togglePlaylistSelect(event, ${index})` : (isReorder ? '' : `openPlaylist(${playlist.id})`)}"
                style="cursor: pointer; transition: all 0.2s;"
                onmouseover="this.style.transform='scale(1.02)'"
                onmouseout="this.style.transform='scale(1)'"
            >
                <div class="playlist-cover media-card-cover" style="background: linear-gradient(135deg, var(--bg-tertiary) 0%, var(--surface-color) 100%); display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden;">
                    ${cardCover ? createImageWithFallback(cardCover, playlist.name, 'playlist-cover-img') : ''}
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity: 0.5;"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
                    ${checkHtml}
                    ${srcBadgeHtml}
                    ${live && live.status !== 'ok' ? `<div style="position: absolute; bottom: ${srcBadgeHtml ? 34 : 8}px; left: 8px; font-size: 11px; font-weight: 500; padding: 3px 8px; border-radius: 4px; z-index: 2; ${live.status === 'failed' ? 'color:#fff;background:rgba(255,77,79,.9);' : 'color:#fff;background:rgba(0,0,0,.6);'}">${live.status === 'failed' ? '更新失败' : '更新中…'}</div>` : ''}
                    ${playlist.isPublic ? `<div class="playlist-public-badge" title="公开歌单，所有用户可见"></div>` : ''}
                    ${isReorder ? `
                        <div class="drag-handle" style="position: absolute; top: 8px; right: 8px; width: 24px; height: 24px; background: rgba(0,0,0,0.5); border-radius: 4px; display: flex; align-items: center; justify-content: center; color: white; font-size: 12px; z-index: 3;">
                            ⋮⋮
                        </div>
                    ` : `
                        ${!(live && live.status === 'failed') ? `<button class="media-card-play" title="播放歌单" onclick="event.stopPropagation(); playPlaylistById(${playlist.id})"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>` : ''}
                    `}
                </div>
                <div class="playlist-name media-card-title" style="margin-bottom: 4px;">${escapeHtml(playlist.name)}</div>
                <div class="playlist-count media-card-sub" style="display: flex; align-items: center; gap: 6px;">
                    <span class="playlist-type-tag" style="display: inline-block; font-size: 11px; font-weight: 500; line-height: 1; padding: 3px 6px; border-radius: 4px; color: ${isLiveToplist ? 'var(--info-color)' : (playlist.type === 'network' ? 'var(--info-color)' : 'var(--success-color)')}; background: ${isLiveToplist ? 'color-mix(in srgb, var(--info-color) 15%, transparent)' : (playlist.type === 'network' ? 'color-mix(in srgb, var(--info-color) 15%, transparent)' : 'color-mix(in srgb, var(--success-color) 15%, transparent)')};">${isLiveToplist ? '实时榜单' : (playlist.type === 'network' ? '网络' : '自建歌单')}</span>
                    <span style="${live && live.status === 'failed' ? 'color: var(--danger-color, #ff4d4f);' : ''}">${isLiveToplist ? (live.status === 'loading' ? '更新中…' : (live.status === 'failed' ? '榜单更新失败' : (live.songCount != null ? `${live.songCount} 首歌曲` : ''))) : `${playlist.songCount || 0} 首歌曲`}</span>
                </div>
                ${''}
            </div>
            ${isEdit ? `
                <div class="playlist-actions" style="display: flex; gap: 8px; margin-top: 8px; justify-content: center;">
                    <button class="btn-icon btn-edit-playlist" data-playlist-id="${playlist.id}" title="编辑" style="width: 32px; height: 32px; border-radius: 50%; border: none; background: var(--surface-color); color: var(--text-color); cursor: pointer; display: flex; align-items: center; justify-content: center;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button class="btn-icon btn-delete-playlist btn-danger" data-playlist-id="${playlist.id}" title="删除" style="width: 32px; height: 32px; border-radius: 50%; border: none; background: var(--surface-color); color: var(--danger-color, #ff4d4f); cursor: pointer; display: flex; align-items: center; justify-content: center;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                </div>
            ` : ''}
        </div>
    `;
}

/**
 * 切换编辑模式
 */
function toggleEditMode() {
    isEditMode = !isEditMode;
    // 管理模式 = 勾选删除 + 拖拽排序（二合一）；退出时结束排序态
    isReorderMode = isEditMode;
    selectedPlaylists.clear();
    loadMyPlaylists();
}

// ==================== 管理模式：多选删除 ====================

/**
 * 点击卡片切换勾选状态（管理模式）
 */
function togglePlaylistSelect(event, index) {
    // 点到底部单个「编辑 / 删除」按钮时不改变勾选状态
    if (event && event.target && event.target.closest &&
        event.target.closest('.btn-edit-playlist, .btn-delete-playlist')) return;
    const playlist = currentPlaylists[index];
    if (!playlist) return;
    const id = String(playlist.id);
    if (selectedPlaylists.has(id)) selectedPlaylists.delete(id);
    else selectedPlaylists.add(id);
    syncPlaylistSelectionUI();
}

/**
 * 全选 / 取消全选（管理模式）
 */
function toggleSelectAllPlaylists() {
    const ids = (currentPlaylists || []).map((p) => String(p.id));
    const allSelected = ids.length > 0 && ids.every((id) => selectedPlaylists.has(id));
    selectedPlaylists = new Set(allSelected ? [] : ids);
    syncPlaylistSelectionUI();
}

/**
 * 局部刷新勾选态：卡片勾选框 / 高亮 + 顶部「全选」「删除(N)」按钮 + 右侧计数
 */
function syncPlaylistSelectionUI() {
    const grid = document.getElementById('playlist-grid');
    if (grid) {
        grid.querySelectorAll('.playlist-card-wrapper').forEach((w) => {
            const on = selectedPlaylists.has(String(w.dataset.id));
            w.classList.toggle('playlist-selected', on);
            w.style.boxShadow = on ? '0 0 0 2px var(--primary-color)' : 'none';
            const box = w.querySelector('.playlist-check');
            if (box) {
                box.textContent = on ? '✓' : '';
                box.style.background = on ? 'var(--primary-color)' : 'rgba(0,0,0,.35)';
                box.style.borderColor = on ? 'var(--primary-color)' : 'rgba(255,255,255,.75)';
            }
        });
    }
    const n = selectedPlaylists.size;
    const delBtn = document.getElementById('playlist-delete-btn');
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
    const allBtn = document.getElementById('playlist-selectall-btn');
    if (allBtn) {
        allBtn.textContent = (n && n === (currentPlaylists || []).length) ? '取消全选' : '全选';
    }
    // 统计只在顶部菜单标题显示（下方工具条统计已移除）
    const title = document.getElementById('page-title');
    if (title && title.classList.contains('my-playlists-title')) {
        title.textContent = `我的歌单（${(currentPlaylists || []).length}个）`;
    }
}

/**
 * 删除已勾选的歌单（二次确认后逐个删除）
 */
async function deleteSelectedPlaylists() {
    const ids = Array.from(selectedPlaylists);
    if (!ids.length) return;
    const msg = `确定要删除选中的 ${ids.length} 个歌单吗？此操作不可恢复。`;
    let ok = false;
    try {
        if (window.Notification && typeof window.Notification.confirm === 'function') {
            ok = await window.Notification.confirm(msg, { type: 'warning' });
        } else {
            showConfirmModal({
                title: '删除歌单',
                message: msg,
                confirmText: '删除',
                confirmClass: 'btn-danger',
                onConfirm: () => doDeletePlaylists(ids)
            });
            return;
        }
    } catch (e) {
        ok = false;
    }
    if (!ok) return;
    await doDeletePlaylists(ids);
}

/**
 * 逐个删除歌单并刷新列表
 */
async function doDeletePlaylists(ids) {
    let done = 0;
    showToast('正在删除...', 'info');
    for (const id of ids) {
        try {
            const r = await API.playlists.delete(id);
            if (r && r.success) done++;
        } catch (e) { /* 单个失败继续删其余 */ }
    }
    selectedPlaylists.clear();
    loadSidebarPlaylists();
    loadMyPlaylists();
    showToast(done ? `已删除 ${done} 个歌单` : '删除失败，请重试', done ? 'success' : 'error');
}

/**
 * 设置拖拽功能和按钮事件（使用事件委托）
 */
function setupDragAndDrop() {
    const grid = document.getElementById('playlist-grid');
    if (!grid) return;

    // 只绑定一次事件委托
    if (!isEventDelegated) {
        // 使用事件委托处理按钮点击
        document.addEventListener('click', (e) => {
            const editBtn = e.target.closest('.btn-edit-playlist');
            if (editBtn) {
                e.stopPropagation();
                const playlistId = parseInt(editBtn.dataset.playlistId);
                const playlist = currentPlaylists.find(p => p.id === playlistId);
                if (playlist) {
                    showEditPlaylistModal(playlist);
                }
                return;
            }

            const deleteBtn = e.target.closest('.btn-delete-playlist');
            if (deleteBtn) {
                e.stopPropagation();
                const playlistId = parseInt(deleteBtn.dataset.playlistId);
                const playlist = currentPlaylists.find(p => p.id === playlistId);
                if (playlist) {
                    confirmDeletePlaylist(playlist.id, playlist.name);
                }
                return;
            }
        });
        isEventDelegated = true;
    }

    // 拖拽事件由卡片内联属性绑定（仅「调整顺序」模式下渲染），此处不再重复绑定，
    // 避免 drop 被触发两次导致顺序错乱。
}

function handleDragStart(e) {
    draggedItem = this;
    this.style.opacity = '0.5';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', this.innerHTML);
}

function handleDragEnd(_e) {
    this.style.opacity = '1';
    draggedItem = null;

    const grid = document.getElementById('playlist-grid');
    if (grid) {
        const items = grid.querySelectorAll('.playlist-card-wrapper');
        items.forEach(item => {
            item.style.transform = '';
            item.style.borderTop = '';
        });
    }
}

function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    return false;
}

function handleDragEnter(_e) {
    if (this !== draggedItem) {
        this.style.borderTop = '3px solid var(--primary-color)';
    }
}

function handleDragLeave(_e) {
    this.style.borderTop = '';
}

function handleDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }

    if (draggedItem !== this) {
        const grid = document.getElementById('playlist-grid');
        const allItems = [...grid.querySelectorAll('.playlist-card-wrapper')];
        const draggedIndex = allItems.indexOf(draggedItem);
        const droppedIndex = allItems.indexOf(this);

        if (draggedIndex !== -1 && droppedIndex !== -1) {
            const newPlaylists = [...currentPlaylists];
            const [removed] = newPlaylists.splice(draggedIndex, 1);
            newPlaylists.splice(droppedIndex, 0, removed);

            currentPlaylists = newPlaylists;
            renderMyPlaylists(currentPlaylists, document.getElementById('page-my-playlists'));
            savePlaylistOrder();
        }
    }

    return false;
}

/**
 * 保存歌单排序
 */
async function savePlaylistOrder() {
    try {
        // 使用用户隔离的API - 逐个更新歌单排序
        // 列表按 sort_order DESC 展示，因此排在第 0 位的歌单取最大的 sortOrder
        const total = currentPlaylists.length;
        for (let i = 0; i < total; i++) {
            const playlist = currentPlaylists[i];
            await API.playlists.update(playlist.id, { sortOrder: total - i });
        }
        const result = { success: true };

        if (result.success) {
            showToast('排序已保存', 'success');
            loadSidebarPlaylists();
        } else {
            showToast('保存排序失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('保存排序失败:', error);
        showToast('保存排序失败: ' + error.message, 'error');
    }
}

/**
 * 确认删除歌单
 */
function confirmDeletePlaylist(playlistId, playlistName) {
    showConfirmModal({
        title: '删除歌单',
        message: `确定要删除歌单 "${playlistName}" 吗？此操作不可恢复。`,
        confirmText: '删除',
        confirmClass: 'btn-danger',
        onConfirm: () => deletePlaylist(playlistId)
    });
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

/**
 * 删除歌单
 */
async function deletePlaylist(playlistId) {
    try {
        const result = await API.playlists.delete(playlistId);

        if (result.success) {
            showToast('歌单已删除', 'success');
            loadSidebarPlaylists();
            loadMyPlaylists();
        } else {
            showToast('删除失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('删除歌单失败:', error);
        showToast('删除失败: ' + error.message, 'error');
    }
}

/**
 * 设置侧边栏歌单选中状态
 */
function setSidebarPlaylistActive(playlistId) {
    // 移除所有导航项的 active 状态
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });

    // 给当前歌单添加 active 状态
    const playlistItem = document.querySelector(`.sidebar-playlist-item[data-playlist-id="${playlistId}"]`);
    if (playlistItem) {
        playlistItem.classList.add('active');
    }
}

// ==================== 动态榜单歌单实时状态 ====================
// 打开「我的歌单」时对动态榜单歌单并行预取：卡片「更新中 → 正常/失败」；
// 失败的榜单卡片不可进入（点击提示报错，与排行榜一致）
const toplistLiveStatus = new Map(); // id -> { status: 'loading'|'ok'|'failed', songCount, cover }

async function prefetchToplistStatus() {
    const live = (currentPlaylists || []).filter(p => !!p.sourceType);
    if (!live.length) return;
    live.forEach(p => {
        if (!toplistLiveStatus.has(String(p.id))) toplistLiveStatus.set(String(p.id), { status: 'loading' });
    });
    try {
        const result = await API.playlists.toplistStatus(live.map(p => p.id));
        if (result && result.success && result.data) {
            Object.entries(result.data).forEach(([id, st]) => {
                toplistLiveStatus.set(String(id), st);
            });
        } else {
            console.error('[MyPlaylists] 动态榜单预取失败:', result);
            const err = (result && result.error) || '预取接口返回失败';
            live.forEach(p => toplistLiveStatus.set(String(p.id), { status: 'failed', error: err }));
        }
    } catch (e) {
        console.error('[MyPlaylists] 动态榜单预取请求异常:', e);
        live.forEach(p => toplistLiveStatus.set(String(p.id), { status: 'failed', error: e.message }));
    }
    // 预取完成：重渲染列表刷新卡片状态
    console.log('[MyPlaylists] 动态榜单预取完成:', JSON.stringify(Object.fromEntries(toplistLiveStatus)));
    if (window._playlistListContainer && window._playlistListContainer.isConnected) {
        renderMyPlaylists(currentPlaylists, window._playlistListContainer);
    }
}

/**
 * 打开歌单详情
 */
async function openPlaylist(playlistId) {
    // 动态榜单歌单：预取失败的榜单不可进入（与排行榜报错一致），提示里带具体原因
    const liveStatus = toplistLiveStatus.get(String(playlistId));
    if (liveStatus && liveStatus.status === 'failed') {
        showToast('榜单更新失败' + (liveStatus.error ? `：${liveStatus.error}` : '，请稍后重试'), 'error');
        return;
    }

    showToast('加载歌单详情...');

    try {
        // 获取歌单基本信息
        const result = await API.playlists.get(playlistId);

        if (result.success && result.data) {
            const playlist = result.data;

            // 获取歌单歌曲列表；动态榜单歌单为实时拉取（无快照回退），失败即打不开
            const songsResult = await API.playlists.getSongs(playlistId);
            if (!songsResult.success) {
                toplistLiveStatus.set(String(playlistId), { status: 'failed' });
                showToast('榜单加载失败: ' + (songsResult.error || '未知错误'), 'error');
                return;
            }
            playlist.songs = songsResult.data || [];

            // 动态歌单：把本次实时拉取到的数量/封面同步回卡片状态（返回列表立即可见）
            if (playlist.sourceType) {
                const prev = toplistLiveStatus.get(String(playlistId)) || {};
                toplistLiveStatus.set(String(playlistId), {
                    status: 'ok',
                    songCount: playlist.songs.length,
                    cover: playlist.cover || prev.cover
                });
            }

            // 普通歌单：进入时自动补全老快照歌曲的缺失元数据
            // （老版本入库的歌曲缺插件专有字段，如弥音QQ 需要 songmid，播放会被第三方解析 API 兜底歌顶替）
            if (!playlist.sourceType) {
                try {
                    const refreshResult = await API.playlists.refreshSongs(playlistId);
                    if (refreshResult && refreshResult.success && refreshResult.data && refreshResult.data.enriched > 0) {
                        const again = await API.playlists.getSongs(playlistId);
                        if (again.success) {
                            playlist.songs = again.data || [];
                            showToast(`已补全 ${refreshResult.data.enriched} 首歌曲的元数据`, 'success');
                        }
                    }
                } catch (e) { /* 补全失败不影响展示 */ }
            }

            // 后端返回的歌单 updatedAt（更新时间）
            if (songsResult.updatedAt) {
                playlist.updatedAt = songsResult.updatedAt;
            }

            // 无封面歌单：动态榜单主动向插件要榜单封面（从侧边栏直接打开时未经过列表页预取）；
            // 仍无封面则由渲染层用歌内歌曲封面/默认图兜底
            if (!playlist.cover) {
                let live = toplistLiveStatus.get(String(playlistId));
                if (playlist.sourceType && (!live || !live.cover)) {
                    try {
                        const st = await API.playlists.toplistStatus([playlistId]);
                        if (st && st.success && st.data && st.data[String(playlistId)]) {
                            live = st.data[String(playlistId)];
                            toplistLiveStatus.set(String(playlistId), live);
                        }
                    } catch (e) { /* 预取失败不影响展示 */ }
                }
                if (live && live.cover) playlist.cover = live.cover;
            }

            window.currentPlaylistDetail = playlist;

            // 设置侧边栏选中状态
            setSidebarPlaylistActive(playlistId);

            // 顶部菜单：左侧返回箭头 + 歌单名，右侧「⋯」按钮（内含下载）
            setupPlaylistDetailHeader(playlist);

            // 在主内容区直接渲染详情，不切换页面
            renderPlaylistDetailInContainer(playlist);
        } else {
            showToast('加载失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('加载失败: ' + error.message, 'error');
    }
}

/**
 * 格式化歌单“更新时间”（毫秒时间戳 -> 本地时间字符串）
 */
function formatPlaylistUpdatedTime(ts) {
    if (!ts) return '未知';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '未知';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ==================== 歌单详情：多选模式（下载/移除） ====================

// 多选模式状态：点 Hero 行「下载/删除」进入，出现勾选列
let playlistDetailManageMode = false;

function togglePlaylistDetailManageMode() {
    playlistDetailManageMode = !playlistDetailManageMode;
    const playlist = window.currentPlaylistDetail;
    if (playlist) renderPlaylistDetailInContainer(playlist);
}

/** 多选模式：下载勾选的网络歌曲（未勾选 = 全部网络歌曲；本地歌曲跳过） */
async function downloadPlaylistDetailSelected() {
    if (typeof SongTable === 'undefined') return;
    const isLocalSong = (s) => !!s && (!!s.filePath || s.plugin === 'local' || s.platform === 'local'
        || (typeof s.id === 'string' && s.id.startsWith('tr-')));
    const sel = SongTable.getSelectedSongs('playlist-detail') || [];
    const playlist = window.currentPlaylistDetail;
    const songs = playlist ? (playlist.songs || []) : [];
    // 未勾选 = 全部；勾选 = 仅勾选的歌；本地歌曲下载无效（已在本地），一律跳过
    const targets = (sel.length ? sel : songs).filter((s) => !isLocalSong(s));
    if (!targets.length) {
        showToast(sel.length ? '勾选的都是本地歌曲，无需下载' : '没有可下载的网络歌曲', 'warning');
        return;
    }
    const indices = targets
        .map((s) => songs.findIndex((x) => x.id === s.id && (x.plugin || x.platform) === (s.plugin || s.platform)))
        .filter((i) => i >= 0);
    playlistDetailManageMode = false;
    for (const i of indices) {
        try { await downloadPlaylistSong(i); } catch (e) { /* 单条失败继续 */ }
    }
    showToast(`已开始下载 ${indices.length} 首歌曲`, 'success');
    if (playlist) renderPlaylistDetailInContainer(playlist);
}

/** 多选模式：把勾选的歌曲从歌单中移除（不是删除文件）；未勾选则提示 */
async function deletePlaylistDetailSelected() {
    if (typeof SongTable === 'undefined' || !SongTable.getSelectedSongs) return;
    const sel = SongTable.getSelectedSongs('playlist-detail') || [];
    if (!sel.length) {
        showToast('请先勾选要移除的歌曲', 'warning');
        return;
    }
    const playlist = window.currentPlaylistDetail;
    if (!playlist) return;
    if (!window.confirm(`确定从歌单「${playlist.name || ''}」中移除选中的 ${sel.length} 首歌曲吗？`)) {
        return;
    }
    let ok = 0;
    for (const s of sel) {
        try {
            const res = await API.playlists.removeSong(playlist.id, s.id, s.plugin || s.platform);
            if (res && res.success) ok++;
        } catch (e) { /* 单条失败继续 */ }
    }
    showToast(`已从歌单移除 ${ok} 首歌曲`, ok ? 'success' : 'error');
    playlistDetailManageMode = false;
    await openPlaylist(playlist.id);
}

// ==================== 歌单详情：行内删除单首 ====================

/**
 * 行内「⋯」菜单：把单首歌从歌单中移除（仅本地/自建歌单）
 * @param {number} index 行索引（对应歌单全列表）
 */
async function removePlaylistSongByIndex(index) {
    const playlist = window.currentPlaylistDetail;
    const songs = playlist ? (playlist.songs || []) : [];
    const song = songs[index];
    if (!song) return;
    if (!window.confirm(`确定从歌单「${playlist.name || ''}」中移除「${song.title || ''}」吗？`)) {
        return;
    }
    try {
        const res = await API.playlists.removeSong(playlist.id, song.id, song.plugin || song.platform);
        if (!res || res.success === false) throw new Error((res && res.error) || '移除失败');
        showToast('已从歌单移除', 'success');
        await openPlaylist(playlist.id);
    } catch (e) {
        showToast('移除失败: ' + (e && e.message), 'error');
    }
}

// ==================== 歌单 Hero 封面解析 ====================
// 默认封面：内嵌 SVG（深灰渐变 + 音符），不依赖外网
const PLAYLIST_DEFAULT_COVER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">'
    + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#2e2e30"/><stop offset="1" stop-color="#18181a"/>'
    + '</linearGradient></defs>'
    + '<rect width="400" height="400" fill="url(#g)"/>'
    + '<text x="200" y="235" font-size="110" text-anchor="middle">🎵</text>'
    + '</svg>'
);

/**
 * 解析歌单 Hero 封面：
 * 1. 歌单自带封面
 * 2. 动态榜单歌单：预取状态里插件返回的封面
 * 3. 调用插件获取：取歌单内第一首能拿到封面的歌（歌曲直链或 /api/cover 虚拟ID）
 * 4. 兜底：默认图片
 */
function resolvePlaylistHeroCover(playlist, songs) {
    if (playlist.cover) return playlist.cover;
    const live = typeof toplistLiveStatus !== 'undefined' && toplistLiveStatus.get(String(playlist.id));
    if (live && live.cover) return live.cover;
    const withCover = (songs || []).find(s => s && (s.artwork || s.cover || s.coverImg || s.pic || s.coverArt || s.virtualId));
    if (withCover) {
        const s = withCover;
        return s.artwork || s.cover || s.coverImg || s.pic
            || `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(s.coverArt || s.virtualId)}`;
    }
    return PLAYLIST_DEFAULT_COVER;
}

/**
 * 渲染歌单详情 - 新版全比例自适应表格
 */
function renderPlaylistDetail(playlist) {
    const container = document.getElementById('page-my-playlists');
    if (!container) return;

    // 给 body 添加类名，用于强制桌面端布局
    document.body.classList.add('playlist-detail-open');

    const hasSongs = playlist.songs && playlist.songs.length > 0;

    // 操作按钮
    const buttonsHtml = `
        <div class="action-buttons" style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="btn" onclick="playAllSongs()" ${!hasSongs ? 'disabled' : ''} style="display: flex; align-items: center; gap: 4px; padding: 3px 14px; border-radius: 16px; font-size: 12px; background: var(--surface-color); color: var(--text-color); border: 1px solid var(--border-color); cursor: pointer; opacity: ${!hasSongs ? '0.5' : '1'};">
                <span style="display: flex; align-items: center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span> 播放
            </button>
            <button class="btn" onclick="addAllSongsToPlaylist()" ${!hasSongs ? 'disabled' : ''} style="display: flex; align-items: center; gap: 4px; padding: 3px 14px; border-radius: 16px; font-size: 12px; background: var(--surface-color); color: var(--text-color); border: 1px solid var(--border-color); cursor: pointer; opacity: ${!hasSongs ? '0.5' : '1'};">
                <span style="display: flex; align-items: center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg></span> 添加
            </button>
            <button class="btn" onclick="downloadAllSongs()" ${!hasSongs ? 'disabled' : ''} style="display: flex; align-items: center; gap: 4px; padding: 3px 14px; border-radius: 16px; font-size: 12px; background: var(--surface-color); color: var(--text-color); border: 1px solid var(--border-color); cursor: pointer; opacity: ${!hasSongs ? '0.5' : '1'};">
                <span style="display: flex; align-items: center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></span> 下载
            </button>
            <button class="btn" onclick="clearPlaylistSongs(${playlist.id})" ${!hasSongs ? 'disabled' : ''} style="display: flex; align-items: center; gap: 4px; padding: 3px 14px; border-radius: 16px; font-size: 12px; background: var(--surface-color); color: var(--text-color); border: 1px solid var(--border-color); cursor: pointer; opacity: ${!hasSongs ? '0.5' : '1'};">
                <span style="display: flex; align-items: center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></span> 清空
            </button>
        </div>
    `;

    let html = `
        <div class="playlist-detail" style="height: 100%; display: flex; flex-direction: column;">
            <div class="playlist-detail-actions" style="padding: 16px 20px; border-bottom: 1px solid var(--divider-color); display: flex; gap: 8px; flex-shrink: 0;">
                ${buttonsHtml}
            </div>
            <div class="playlist-songs" style="padding: 0;">
    `;

    if (hasSongs) {
        html += `<div class="playlist-detail-table-wrapper">
            <table class="playlist-detail-table">
                <thead>
                    <tr>
                        <th class="col-checkbox">
                            <input type="checkbox" id="select-all" onchange="togglePlaylistSelectAll(this)" title="全选">
                        </th>
                        <th class="col-favorite"></th>
                        <th class="col-download"></th>
                        <th class="col-index">#</th>
                        <th class="col-title">歌曲</th>
                        <th class="col-artist">艺人</th>
                        <th class="col-album">专辑</th>
                        <th class="col-duration">时长</th>
                        <th class="col-source">来源</th>
                    </tr>
                </thead>
                <tbody>`;
        
        playlist.songs.forEach((song, index) => {
            const itemPlugin = song.plugin || song.platform || '';
            const isPlaying = window.currentMusic && window.currentMusic.id === song.id;
            const rowClass = isPlaying ? 'playing' : '';
            
            // 收藏状态
            const isFavorited = window.FavoriteManager?.isFavoritedSync(song) || false;
            const favIcon = isFavorited
                ? '<svg viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
                : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

            // 下载状态（不在渲染时查询，点击时实时检查）
            let downloadClass = '';
            let downloadIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
            
            // 来源
            const sourceText = (typeof getMusicSourceText === 'function')
                ? (getMusicSourceText(song) || '-')
                : (itemPlugin || '-');
            
            html += `<tr class="${rowClass}" data-index="${index}" data-id="${escapeHtml(song.id)}" onclick="playMusicFromPlaylist(${index})">
                <td class="col-checkbox" onclick="event.stopPropagation();">
                    <input type="checkbox" class="row-checkbox" data-index="${index}" onclick="event.stopPropagation(); togglePlaylistRowSelect(this)">
                </td>
                <td class="col-favorite" onclick="event.stopPropagation();">
                    <button class="action-btn ${isFavorited ? 'favorited' : ''}"
                            onclick="event.stopPropagation(); toggleFavoritePlaylistSong(${index})"
                            title="${isFavorited ? '取消收藏' : '收藏'}">
                        ${favIcon}
                    </button>
                </td>
                <td class="col-download" onclick="event.stopPropagation();">
                    <button class="action-btn ${downloadClass}"
                            onclick="event.stopPropagation(); downloadPlaylistSong(${index})"
                            title="${downloadClass === 'downloaded' ? '已下载' : '下载'}">
                        ${downloadIcon}
                    </button>
                </td>
                <td class="col-index">${index + 1}</td>
                <td class="col-title">${escapeHtml(song.title || '未知歌曲')}</td>
                <td class="col-artist">${escapeHtml(song.artist || '未知歌手')}</td>
                <td class="col-album">${escapeHtml(song.album || '未知专辑')}</td>
                <td class="col-duration">${formatDuration(song.duration)}</td>
                <td class="col-source"><span class="source-tag" title="${escapeHtml(sourceText)}">${escapeHtml(sourceText)}</span></td>
            </tr>`;
        });
        
        html += `</tbody></table></div>`;
    } else {
        html += `
            <div class="empty-state" style="padding: 60px 20px;">
                <div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>
                <div class="empty-text">歌单为空</div>
                <div class="empty-subtext">点击"添加歌曲"按钮添加歌曲到歌单</div>
            </div>
        `;
    }

    html += '</div></div>';
    container.innerHTML = html;

    // 「本地 ✓」徽标（旧表格渲染路径，走通用 LocalBadge）
    if (window.LocalBadge) window.LocalBadge.apply(container, playlist.songs || []).catch(() => {});
}

// 全选/取消全选
function togglePlaylistSelectAll(checkbox) {
    const rowCheckboxes = document.querySelectorAll('.playlist-detail-table .row-checkbox');
    rowCheckboxes.forEach(cb => {
        cb.checked = checkbox.checked;
        const row = cb.closest('tr');
        if (row) {
            row.classList.toggle('selected', checkbox.checked);
        }
    });
}

// 单行选择
function togglePlaylistRowSelect(checkbox) {
    const row = checkbox.closest('tr');
    if (row) {
        row.classList.toggle('selected', checkbox.checked);
    }
    // 更新全选框状态
    const allChecked = document.querySelectorAll('.playlist-detail-table .row-checkbox:checked').length;
    const total = document.querySelectorAll('.playlist-detail-table .row-checkbox').length;
    const selectAll = document.getElementById('select-all');
    if (selectAll) {
        selectAll.checked = allChecked === total && total > 0;
        selectAll.indeterminate = allChecked > 0 && allChecked < total;
    }
}

/**
 * 在主内容区渲染歌单详情（和收藏界面保持一致）
 */
function renderPlaylistDetailInContainer(playlist) {
    const container = document.getElementById('page-container');
    if (!container) return;

    // 给 body 添加类名，用于强制桌面端布局
    document.body.classList.add('playlist-detail-open');

    const hasSongs = playlist.songs && playlist.songs.length > 0;

    if (!hasSongs) {
        // 空状态，和收藏界面一致
        container.innerHTML = `
            <div class="playlist-detail" style="height: 100%; display: flex; flex-direction: column;">
                <div style="flex: 1; min-height: 0; overflow: auto;">
                    <div class="empty-state">
                        <div class="empty-icon">🎵</div>
                        <div class="empty-text">歌单为空</div>
                        <div class="empty-subtext">点击"添加歌曲"按钮添加歌曲到歌单</div>
                    </div>
                </div>
            </div>
        `;
        // 隐藏所有页面
        document.querySelectorAll('.page').forEach(page => {
            page.style.display = 'none';
        });
        container.style.display = 'block';
        return;
    }

    // 隐藏所有页面
    document.querySelectorAll('.page').forEach(page => {
        page.style.display = 'none';
    });
    container.style.display = 'block';

    // 渲染头部（歌单封面 + 更新时间）与内容区域
    container.innerHTML = `
        <div class="playlist-detail" style="height: 100%; display: flex; flex-direction: column;">
            <div id="playlist-detail-body" style="flex: 1; min-height: 0; display: flex; flex-direction: column;"></div>
        </div>
    `;

    // 异步检查收藏状态并渲染
    (async () => {
        // 为每首歌曲添加 plugin 字段
        const songsWithPlugin = playlist.songs.map(song => ({
            ...song,
            plugin: song.plugin || song.platform || 'local'
        }));

        // 先清空与当前歌单歌曲相关的缓存，避免残留数据
        for (const song of songsWithPlugin) {
            const platform = song.plugin || song.platform;
            if (typeof removeFromFavoritesCache === 'function') {
                removeFromFavoritesCache(song.id, platform);
            }
        }

        // 保存到全局变量
        window.currentPlaylistDetail = playlist;
        window.currentPlaylistDetailSongs = songsWithPlugin;
        window.currentPageMusicList = songsWithPlugin;

        // 先渲染表格（不再阻塞等待全部收藏状态查询——大歌单串行 await 会造成明显白屏）
        const bodyEl = document.getElementById('playlist-detail-body');
        await renderNewPlaylistTable(bodyEl || container, playlist, songsWithPlugin);

        // 收藏状态后台批量查询（一次请求返回全部，避免逐首打 N 条 GET 抢占连接）
        if (typeof checkBatchFavorites === 'function') {
            checkBatchFavorites(songsWithPlugin).then(() => {
                if (typeof SongTable !== 'undefined' && SongTable.updateFavoriteButtons) {
                    SongTable.updateFavoriteButtons('playlist-detail');
                }
            });
        }
    })();
}

/**
 * 渲染新版歌单表格（使用 SongTable 组件）
 */
function renderNewPlaylistTable(container, playlist, songs) {
    const hasSongs = songs && songs.length > 0;

    // 多选模式标记：手机端据此显示勾选列（mobile.css）
    if (container && container.classList) {
        container.classList.toggle('playlist-detail-manage', !!playlistDetailManageMode);
    }

    // 存储当前歌单到全局，供回调函数使用
    window.currentPlaylistDetail = playlist;
    window.currentPlaylistDetailSongs = songs;

    // 滚动增量加载：无分页栏；打开新歌单重置为首批 50 首，滚动接近底部时自动渲染下一批
    if (window.__playlistDetailKey !== playlist.id) {
        window.__playlistDetailKey = playlist.id;
        window.__playlistDetailRenderCount = 0;
    }
    if (!window.__playlistDetailRenderCount) window.__playlistDetailRenderCount = 50;
    const renderCount = Math.min(songs.length, window.__playlistDetailRenderCount);
    const visibleSongs = songs.slice(0, renderCount);
    // 记录渲染上下文（整页滚动加载用）
    window.__playlistDetailRenderCtx = { container, playlist, songs };

    SongTable.render({
        container: container,
        pageId: 'playlist-detail',
        songs: visibleSongs,
        indexOffset: 0,
        // 勾选列仅在多选模式（点「下载/删除」后）出现；收藏为独立心形按钮（「⋯」前）
        columns: playlistDetailManageMode
            ? ['checkbox', 'index', 'title', 'artist', 'album', 'duration', 'source', 'favorite', 'more']
            : ['index', 'title', 'artist', 'album', 'duration', 'source', 'favorite', 'more'],
        // Apple Music 风格 Hero 头部：左侧大封面 + 右侧标题/信息，操作按钮放在封面旁边
        hero: {
            cover: resolvePlaylistHeroCover(playlist, songs),
            tag: '歌单',
            title: playlist.name || '歌单',
            meta: `更新于 ${formatPlaylistUpdatedTime(playlist.updatedAt)} · 共 ${songs.length} 首`,
            onRandom: 'playPlaylistRandom()'
        },
        pagination: null,
        // 行尾「⋯」菜单：下载 / 删除（删除仅本地/自建歌单显示，网络动态歌单不允许增删）
        // 收藏已移出行菜单：独立心形按钮显示在「⋯」前（favorite 列，点击走 events.onFavorite）
        rowMenu: [
            { label: '下载', dynamicDownload: true, onClick: (index) => downloadPlaylistSong(index) },
            ...(!playlist.sourceType ? [
                { label: '删除', onClick: (index) => removePlaylistSongByIndex(index) }
            ] : [])
        ],
        // 标题列前显示歌曲封面小图标：优先插件返回的封面直链（覆盖常见字段名），
        // 其次用虚拟封面 ID 走 /api/cover 由插件实时获取；都拿不到由行内 onerror 显示默认图
        titleCover: (song) => {
            const coverId = song.coverArt || song.virtualId
                || (typeof song.id === 'string' && song.id.startsWith('remote__') ? song.id : null);
            return song.artwork || song.cover || song.coverImg || song.pic || song.albumPic || song.albumpic || song.img
                || (coverId ? `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(coverId)}` : '');
        },
        showHeader: false,
        actions: (() => {
            // 规则：
            // - 网络动态歌单（sourceType）：只有「下载」按钮
            // - 自建歌单：「下载」+「删除」
            // - 点「下载/删除」进入多选模式（出现勾选列）；下载跳过本地歌曲；删除 = 从歌单移除（不删文件）
            const manage = playlistDetailManageMode;
            const isDynamic = !!playlist.sourceType;
            const selCount = (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs)
                ? (SongTable.getSelectedSongs('playlist-detail') || []).length : 0;
            const downloadIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
            const trashIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';

            if (manage) {
                return [
                    { id: 'manage-download', icon: downloadIcon, text: `下载${selCount ? ` (${selCount})` : ''}`, primary: false, disabled: !hasSongs, onClick: downloadPlaylistDetailSelected },
                    ...(!isDynamic ? [
                        { id: 'manage-delete', icon: trashIcon, text: `删除${selCount ? ` (${selCount})` : ''}`, primary: false, disabled: !hasSongs, onClick: deletePlaylistDetailSelected }
                    ] : []),
                    { id: 'manage-done', icon: '', text: '完成', primary: true, onClick: () => togglePlaylistDetailManageMode() }
                ];
            }
            return [
                ButtonActions.createPlayButtonWithUnifiedLogic({ pageId: 'playlist-detail', songs, disabled: !hasSongs }),
                ...(!isDynamic ? [
                    ButtonActions.createAddButtonWithUnifiedLogic({ pageId: 'playlist-detail', songs, sourceName: playlist.name, disabled: !hasSongs })
                ] : []),
                // 「删除」：点击进入多选模式（出现勾选列，勾选后批量执行；管理模式内仍有批量下载）
                ...(!isDynamic ? [
                    { id: 'delete-entry', icon: trashIcon, text: '删除', primary: false, disabled: !hasSongs, onClick: () => togglePlaylistDetailManageMode() }
                ] : [])
            ];
        })(),
        events: {
            onPlay: (song, index) => playMusicFromPlaylist(index),
            onFavorite: (song, index) => toggleFavoritePlaylistSong(index),
            onDownload: (song, index) => downloadPlaylistSong(index),
            onSelectChange: (selectedIndices) => {
                // 更新行选中样式
                const container = document.querySelector('[data-page-id="playlist-detail"]');
                if (container) {
                    const rows = container.querySelectorAll('tbody tr');
                    rows.forEach((row, idx) => {
                        row.classList.toggle('selected', selectedIndices.includes(idx));
                    });
                }
            }
        }
    });

    // 整页滚动加载：滚动监听只绑一次（挂在页面容器上），渲染跟随当前歌单上下文
    if (!window.__pageScrollLoadBound) {
        window.__pageScrollLoadBound = true;
        const scroller = document.getElementById('page-container');
        if (scroller) {
            scroller.addEventListener('scroll', () => {
                // 仅歌单详情页响应
                if (!window.currentPlaylistDetail) return;
                const ctx = window.__playlistDetailRenderCtx;
                if (!ctx || !ctx.songs) return;
                const count = window.__playlistDetailRenderCount || 0;
                if (count >= ctx.songs.length) return;
                if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 150) {
                    window.__playlistDetailRenderCount = Math.min(ctx.songs.length, count + 50);
                    renderNewPlaylistTable(ctx.container, ctx.playlist, ctx.songs);
                }
            }, { passive: true });
        }
    }
    // 初始内容不足一屏且仍有剩余：补一批到超过一屏，剩余靠滚动触发
    if (renderCount < songs.length) {
        requestAnimationFrame(() => {
            const wrap = container.querySelector('.playlist-detail-table-wrapper');
            if (wrap && wrap.scrollHeight <= wrap.clientHeight + 200) {
                window.__playlistDetailRenderCount = Math.min(songs.length, window.__playlistDetailRenderCount + 50);
                renderNewPlaylistTable(container, playlist, songs);
            }
        });
    } else {
        window.__playlistDetailRenderCount = songs.length;
    }
}

/**
 * 播放歌单中的歌曲
 */
function playMusicFromPlaylist(index) {
    // 使用添加了 plugin 字段的歌曲列表
    const songs = window.currentPlaylistDetailSongs || window.currentPlaylistDetail?.songs;
    if (songs?.[index]) {
        // 设置当前播放列表为歌单歌曲
        window.currentPageMusicList = songs;
        window.currentPlaylist = songs;
        // 播放指定索引的歌曲
        playMusic(index);
    }
}

/**
 * 切换指定索引歌单歌曲的收藏状态
 * @param {number} index - 歌曲索引
 */
async function toggleFavoritePlaylistSong(index) {
    if (!window.currentPlaylistDetail?.songs?.[index]) return;

    const song = window.currentPlaylistDetail.songs[index];

    // 确保使用 plugin 字段（插件文件名）作为标识，与后端数据库一致
    if (!song.plugin) {
        song.plugin = song.platform;
    }

    // 从我的收藏记录判断：已收藏则不重复添加
    if (window.FavoriteManager?.isFavoritedSync?.(song)) {
        showToast('已在收藏中', 'warning');
        return;
    }

    // 调用全局 toggleFavoriteSong
    const isFav = await toggleFavoriteSong(song);

    // 显示提示
    showToast(isFav ? '已添加到收藏' : '已取消收藏', 'success');
}

/**
 * 下载指定索引的歌单歌曲
 * @param {number} index - 歌曲索引
 */
async function downloadPlaylistSong(index) {
    if (!window.currentPlaylistDetail?.songs?.[index]) return;

    const song = window.currentPlaylistDetail.songs[index];
    // 入库 plugin 优先（platform 可能是显示用平台名）
    const plugin = song.plugin || song.platform;

    if (!plugin) {
        showToast('无法确定歌曲来源', 'error');
        return;
    }

    // 实时查询下载记录：已下载则不重复下载
    try {
        if (window.StateManager?.isDownloaded) {
            const isDownloaded = await window.StateManager.isDownloaded(song.id, plugin);
            if (isDownloaded) {
                showToast('已下载', 'warning');
                return;
            }
        }
    } catch (e) {
        console.error('检查下载状态失败:', e);
    }

    if (window.DownloadCore) {
        await DownloadCore.startBackendDownload(song, '歌单-下载');
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
                source: 'playlist-retry',
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
 * 清空歌单歌曲
 */
async function clearPlaylistSongs(playlistId, selectedSongs) {
    // 勾选语义（与 recent 页一致）：传入了选中歌曲 → 只清空这批；未传（旧调用路径）→ 清空全部
    const onlySelected = Array.isArray(selectedSongs) && selectedSongs.length > 0;
    const confirmed = await Notification.confirm(
        onlySelected ? `确定要清空选中的 ${selectedSongs.length} 首歌曲吗？` : '确定要清空歌单中的所有歌曲吗？',
        { type: 'warning' }
    );
    if (!confirmed) return;

    try {
        if (onlySelected) {
            // 只删除勾选的歌曲
            for (const song of selectedSongs) {
                const plugin = song.plugin || song.platform;
                await API.playlists.removeSong(playlistId, song.id, plugin);
            }
            showToast(`已清空 ${selectedSongs.length} 首歌曲`, 'success');
            // 刷新当前歌单（重新拉取歌曲列表）
            if (window.currentPlaylistDetail && window.currentPlaylistDetail.id === playlistId) {
                renderPlaylistDetailInContainer(window.currentPlaylistDetail);
            }
            return;
        }

        // 获取歌单歌曲并逐个删除
        const songsResult = await API.playlists.getSongs(playlistId);
        if (songsResult.success && songsResult.data) {
            for (const song of songsResult.data) {
                const plugin = song.plugin || song.platform;
                await API.playlists.removeSong(playlistId, song.id, plugin);
            }
        }
        const result = { success: true };

        if (result.success) {
            showToast('歌单已清空', 'success');
            // 刷新当前歌单
            if (window.currentPlaylistDetail && window.currentPlaylistDetail.id === playlistId) {
                window.currentPlaylistDetail.songs = [];
                renderPlaylistDetailInContainer(window.currentPlaylistDetail);
            }
        } else {
            showToast('清空失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('清空歌单失败:', error);
        showToast('清空失败: ' + error.message, 'error');
    }
}

/**
 * 返回歌单列表主页。详情视图会把 page-container 整体替换（连带销毁 page-my-playlists），
 * 因此必须通过 switchPage('my-playlists') 重新加载模板与列表，才能回到列表网格。
 */
function backToPlaylistList() {
    window.currentPlaylistDetail = null;
    document.body.classList.remove('playlist-detail-open');
    if (typeof switchPage === 'function' && window.currentPage === 'my-playlists') {
        switchPage('my-playlists');
    } else {
        loadMyPlaylists();
    }
}

/**
 * 播放全部歌曲（无选中则播放全部）
 */
function playAllSongs() {
    if (!window.currentPlaylistDetail?.songs?.length) {
        showToast('歌单为空', 'warning');
        return;
    }
    
    const allSongs = window.currentPlaylistDetail.songs;
    
    // 使用 MusicList.getSelectedSongs 获取选中的歌曲（如果可用）
    let songsToPlay = [];
    if (typeof MusicList !== 'undefined' && MusicList.getSelectedSongs) {
        songsToPlay = MusicList.getSelectedSongs('playlist');
    }
    
    // 没有选中时播放全部
    if (songsToPlay.length === 0) {
        songsToPlay = allSongs;
    }
    
    if (songsToPlay.length === 0) {
        showToast('没有可播放的歌曲', 'warning');
        return;
    }

    // 「播放」= 顺序播放：先关闭随机（与 Hero 随机按钮的 enableShuffleMode 对称），
    // 播放器上的随机按钮同步熄灭
    if (typeof disableShuffleMode === 'function') disableShuffleMode();

    // 设置当前播放列表并播放第一首
    window.currentPageMusicList = songsToPlay;
    playMusic(0);

    const msg = (typeof MusicList !== 'undefined' && MusicList.getSelectedSongs && MusicList.getSelectedSongs('playlist').length > 0)
        ? `开始播放选中的 ${songsToPlay.length} 首歌曲`
        : `开始播放 ${songsToPlay.length} 首歌曲`;
    showToast(msg, 'success');
}

/**
 * 添加全部歌曲到歌单
 */
function addAllSongsToPlaylist() {
    if (!window.currentPlaylistDetail?.songs?.length) {
        showToast('歌单为空', 'warning');
        return;
    }

    const allSongs = window.currentPlaylistDetail.songs;
    showAddToPlaylistModal(allSongs, window.currentPlaylistDetail.name);
}

/**
 * 显示添加歌曲到歌单弹窗
 * @param {Array} songs - 要添加的歌曲列表（如果不传，则获取当前选中或全部歌曲）
 * @param {string} sourceName - 来源名称（用于新建歌单时的默认名称）
 * @param {string} cover - 封面地址（用于新建歌单时自动填入）
 */
async function showAddToPlaylistModal(songs, sourceName, cover) {
    // 如果没有传入歌曲，尝试获取当前页面的选中歌曲或全部歌曲
    if (!songs || songs.length === 0) {
        // 尝试从 MusicTable 获取选中歌曲
        if (typeof MusicTable !== 'undefined' && MusicTable.getSelectedSongs) {
            const selectedSongs = MusicTable.getSelectedSongs();
            if (selectedSongs && selectedSongs.length > 0) {
                songs = selectedSongs;
            }
        }

        // 如果没有选中歌曲，尝试获取当前页面的全部歌曲
        if (!songs || songs.length === 0) {
            let currentList = [];
            // 优先使用 getCurrentPageMusicList
            if (typeof getCurrentPageMusicList === 'function') {
                currentList = getCurrentPageMusicList();
            }
            // 否则尝试 getCurrentSongs（排行榜页面使用）
            else if (typeof getCurrentSongs === 'function') {
                currentList = getCurrentSongs();
            }
            // 否则尝试 MusicTable.getCurrentSongs
            else if (typeof MusicTable !== 'undefined' && MusicTable.getCurrentSongs) {
                currentList = MusicTable.getCurrentSongs();
            }
            if (currentList && currentList.length > 0) {
                songs = currentList;
            }
        }
    }

    // 如果没有歌曲可添加，提示用户
    if (!songs || songs.length === 0) {
        showToast('没有可添加的歌曲', 'warning');
        return;
    }

    // 获取歌单列表
    let playlists = [];
    try {
        const result = await API.playlists.getAll();
        if (result.success) {
            playlists = result.data || [];
        }
    } catch (error) {
        console.error('获取歌单列表失败:', error);
    }

    // 创建弹窗
    const modal = document.createElement('div');
    modal.id = 'add-to-playlist-modal';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 1000; display: flex; align-items: center; justify-content: center;';

    const playlistItemsHtml = playlists.map(p => `
        <div class="playlist-select-item" data-playlist-id="${p.id}" style="display: flex; align-items: center; gap: 12px; padding: 12px; cursor: pointer; border-radius: 8px; transition: background 0.2s;">
            <div class="playlist-icon" style="width: 48px; height: 48px; background: linear-gradient(135deg, var(--primary-color), var(--primary-light)); border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
            </div>
            <div class="playlist-name" style="flex: 1; font-size: 15px; color: var(--text-color);">${escapeHtml(p.name)}</div>
            <div class="playlist-check" style="width: 22px; height: 22px; border-radius: 50%; box-sizing: border-box; border: 1.5px solid var(--border-color); color: #fff; font-size: 13px; line-height: 19px; text-align: center; flex-shrink: 0;"></div>
        </div>
    `).join('');

    modal.innerHTML = `
        <div class="modal-content" style="width: 400px; max-width: 90%; max-height: 80vh; background: var(--surface-color); border-radius: 12px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
            <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--divider-color);">
                <h3 class="modal-title" style="margin: 0; font-size: 16px; font-weight: 600;">添加到歌单 <span style="color: var(--text-tertiary); font-weight: 400;">(共 ${songs.length} 首)</span></h3>
                <button class="modal-close" onclick="closeAddToPlaylistModal()" style="width: 32px; height: 32px; border: none; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">&times;</button>
            </div>
            <div class="modal-body" style="padding: 0; max-height: 50vh; overflow-y: auto;">
                <!-- 添加到播放列表选项 -->
                <div class="add-to-current-playlist-option" style="display: flex; align-items: center; gap: 12px; padding: 16px 20px; cursor: pointer; border-bottom: 1px solid var(--divider-color); transition: background 0.2s;" onmouseover="this.style.background='var(--hover-bg)'" onmouseout="this.style.background=''">
                    <div class="playlist-icon" style="width: 48px; height: 48px; background: linear-gradient(135deg, #ff6b6b, #ee5a6f); border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/></svg>
                    </div>
                    <div style="flex: 1;">
                        <div style="font-size: 15px; color: var(--text-color);">播放列表</div>
                        <div style="font-size: 12px; color: var(--text-tertiary);">添加到当前播放列表（续加）</div>
                    </div>
                </div>
                <!-- 新建歌单选项 -->
                <div class="create-playlist-option" style="display: flex; align-items: center; gap: 12px; padding: 16px 20px; cursor: pointer; border-bottom: 1px solid var(--divider-color); transition: background 0.2s;" onmouseover="this.style.background='var(--hover-bg)'" onmouseout="this.style.background=''">
                    <div class="create-icon" style="width: 48px; height: 48px; background: var(--divider-color); border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                    </div>
                    <div class="create-text" style="font-size: 15px; color: var(--text-color);">新建歌单</div>
                </div>
                <!-- 现有歌单列表（多选） -->
                <div class="playlist-list" style="padding: 8px;">
                    ${playlistItemsHtml || '<div style="padding: 20px; text-align: center; color: var(--text-tertiary);">暂无歌单</div>'}
                </div>
            </div>
            <!-- 底部确认按钮：多选歌单后一次添加 -->
            <div class="modal-footer" style="padding: 12px 20px; border-top: 1px solid var(--divider-color); display: flex; justify-content: flex-end;">
                <button id="add-to-playlist-confirm" disabled
                    style="padding: 9px 22px; border: none; border-radius: 999px; background: var(--border-color); color: var(--text-tertiary); font-size: 14px; font-weight: 600; cursor: not-allowed;">
                    添加到歌单
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // 绑定添加到播放列表点击事件
    const addToPlaylistOption = modal.querySelector('.add-to-current-playlist-option');
    addToPlaylistOption.addEventListener('click', () => {
        closeAddToPlaylistModal();
        // 添加到当前播放列表（续加）
        if (typeof addToPlaylist === 'function') {
            addToPlaylist(songs);
            showToast(`已添加 ${songs.length} 首歌曲到播放列表`, 'success');
        } else {
            showToast('播放列表功能未加载', 'error');
        }
    });
    // 添加hover效果
    addToPlaylistOption.addEventListener('mouseenter', () => {
        addToPlaylistOption.style.background = 'var(--hover-bg)';
    });
    addToPlaylistOption.addEventListener('mouseleave', () => {
        addToPlaylistOption.style.background = '';
    });

    // 绑定新建歌单点击事件
    const createOption = modal.querySelector('.create-playlist-option');
    createOption.addEventListener('click', async () => {
        closeAddToPlaylistModal();
        // 默认名加上插件别名前缀（如“酷我-热歌榜”）
        const effective = (typeof window.getEffectivePlaylistName === 'function')
            ? await window.getEffectivePlaylistName(sourceName || '', songs)
            : (sourceName || '');
        showCreateNewPlaylistForSongs(songs, effective, cover);
    });

    // 绑定现有歌单点击事件：多选切换（不关闭弹窗），由底部确认按钮统一添加
    const confirmBtn = modal.querySelector('#add-to-playlist-confirm');
    const syncConfirmBtn = () => {
        const picked = modal.querySelectorAll('.playlist-select-item.selected').length;
        confirmBtn.textContent = picked ? `添加到 ${picked} 个歌单` : '添加到歌单';
        confirmBtn.disabled = !picked;
        confirmBtn.style.background = picked ? 'var(--primary-color)' : 'var(--border-color)';
        confirmBtn.style.color = picked ? '#fff' : 'var(--text-tertiary)';
        confirmBtn.style.cursor = picked ? 'pointer' : 'not-allowed';
    };
    modal.querySelectorAll('.playlist-select-item').forEach(item => {
        item.addEventListener('click', () => {
            const selected = item.classList.toggle('selected');
            const check = item.querySelector('.playlist-check');
            if (check) {
                check.style.background = selected ? 'var(--primary-color)' : 'transparent';
                check.style.border = selected ? '1.5px solid var(--primary-color)' : '1.5px solid var(--border-color)';
                check.textContent = selected ? '✓' : '';
            }
            item.style.background = selected ? 'var(--list-active-color, rgba(0,0,0,0.04))' : '';
            syncConfirmBtn();
        });
    });

    // 确认按钮：依次添加到所有选中的歌单
    confirmBtn.addEventListener('click', () => {
        const pickedItems = Array.from(modal.querySelectorAll('.playlist-select-item.selected'));
        if (!pickedItems.length) return;
        closeAddToPlaylistModal();
        pickedItems.forEach((item, i) => {
            const playlistId = parseInt(item.dataset.playlistId);
            const playlistName = item.querySelector('.playlist-name').textContent;
            // 依次异步添加；最后一个完成后提示
            setTimeout(() => {
                addSongsToPlaylist(playlistId, playlistName, songs);
                if (i === pickedItems.length - 1 && typeof showToast === 'function') {
                    showToast(`已添加到 ${pickedItems.length} 个歌单`, 'success');
                }
            }, 100 * (i + 1));
        });
    });

    // 点击遮罩关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeAddToPlaylistModal();
        }
    });
}

/**
 * 关闭添加到歌单弹窗
 */
function closeAddToPlaylistModal() {
    const modal = document.getElementById('add-to-playlist-modal');
    if (modal) {
        modal.remove();
    }
}

/**
 * 为歌曲新建歌单
 */
function showCreateNewPlaylistForSongs(songs, defaultName, cover) {
    const modal = document.createElement('div');
    modal.id = 'create-playlist-for-songs-modal';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 1000; display: flex; align-items: center; justify-content: center;';

    modal.innerHTML = `
        <div class="modal-content" style="width: 360px; max-width: 90%; background: var(--surface-color); border-radius: 12px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
            <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--divider-color);">
                <h3 class="modal-title" style="margin: 0; font-size: 16px; font-weight: 600;">新建歌单</h3>
                <button class="modal-close" onclick="closeCreatePlaylistForSongsModal()" style="width: 32px; height: 32px; border: none; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">&times;</button>
            </div>
            <div class="modal-body" style="padding: 20px;">
                ${cover ? `
                <div class="form-group" style="margin-bottom: 16px; text-align: center;">
                    <img src="${escapeHtml(cover)}" alt="歌单封面" loading="lazy" decoding="async" data-raw="${escapeHtml(cover)}" onerror="window.__coverImgOnError(this)" style="width: 120px; height: 120px; border-radius: 10px; object-fit: cover; box-shadow: 0 4px 16px rgba(0,0,0,0.2);">
                </div>
                ` : ''}
                <div class="form-group" style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; font-size: 14px; color: var(--text-secondary);">歌单名称</label>
                    <input type="text" id="new-playlist-name-for-songs" class="form-input" placeholder="请输入歌单名称" value="${escapeHtml(defaultName || '')}" style="width: 100%; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-color); color: var(--text-color); font-size: 14px; box-sizing: border-box;">
                </div>
                <div class="songs-count" style="font-size: 13px; color: var(--text-tertiary);">将添加 ${songs.length} 首歌曲</div>
            </div>
            <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 12px; padding: 16px 20px; border-top: 1px solid var(--divider-color);">
                <button class="btn btn-secondary" onclick="closeCreatePlaylistForSongsModal()" style="padding: 8px 16px; border-radius: 6px; border: 1px solid var(--border-color); background: transparent; color: var(--text-color); cursor: pointer;">取消</button>
                <button class="btn btn-primary" onclick="submitCreatePlaylistForSongs()" style="padding: 8px 16px; border-radius: 6px; border: none; background: var(--primary-color); color: white; cursor: pointer;">创建</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // 存储歌曲数据和封面供提交时使用
    modal.dataset.songs = JSON.stringify(songs);
    modal.dataset.cover = cover || '';

    // 自动聚焦输入框
    setTimeout(() => {
        const input = document.getElementById('new-playlist-name-for-songs');
        if (input) {
            input.focus();
            input.select();
        }
    }, 100);

    // 点击遮罩关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeCreatePlaylistForSongsModal();
        }
    });

    // 回车提交
    const input = document.getElementById('new-playlist-name-for-songs');
    if (input) {
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                submitCreatePlaylistForSongs();
            }
        });
    }
}

/**
 * 关闭新建歌单弹窗
 */
function closeCreatePlaylistForSongsModal() {
    const modal = document.getElementById('create-playlist-for-songs-modal');
    if (modal) {
        modal.remove();
    }
}

/**
 * 提交新建歌单并添加歌曲
 */
async function submitCreatePlaylistForSongs() {
    const nameInput = document.getElementById('new-playlist-name-for-songs');
    const name = nameInput ? nameInput.value.trim() : '';

    if (!name) {
        showToast('请输入歌单名称', 'warning');
        return;
    }

    const modal = document.getElementById('create-playlist-for-songs-modal');
    const songs = modal && modal.dataset.songs ? JSON.parse(modal.dataset.songs) : [];
    const cover = modal ? modal.dataset.cover || '' : '';

    try {
        // 创建歌单（携带封面）
        const result = await API.playlists.create(name, '', cover);

        if (result.success && result.data) {
            const playlistId = result.data.id;

            showToast(`歌单 "${name}" 创建成功`, 'success');
            closeCreatePlaylistForSongsModal();

            // 添加歌曲到新歌单（异步执行，不阻塞UI）
            if (songs.length > 0) {
                setTimeout(() => {
                    addSongsToPlaylist(playlistId, name, songs, false);
                }, 100);
            }

            // 刷新歌单列表
            loadSidebarPlaylists();
        } else {
            showToast('创建失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('创建歌单失败:', error);
        showToast('创建失败: ' + error.message, 'error');
    }
}

/**
 * 添加歌曲到歌单
 * @param {number} playlistId - 歌单ID
 * @param {string} playlistName - 歌单名称
 * @param {Array} songs - 歌曲列表
 * @param {boolean} silent - 是否静默（不显示提示）
 */
async function addSongsToPlaylist(playlistId, playlistName, songs, silent = false) {
    if (!songs || songs.length === 0) {
        if (!silent) showToast('没有可添加的歌曲', 'warning');
        return;
    }

    try {
        // 将歌曲转换为统一的格式
        const formattedSongs = songs.map(song => {
            const formatted = {
                id: song.id,
                title: song.title || song.name || '未知歌曲',
                artist: song.artist || song.singer || '未知歌手',
                album: song.album || '',
                duration: song.duration || 0,
                cover: song.cover || song.artwork || '',
                plugin: song.plugin || song.platform || 'unknown',
                url: song.url || ''
            };
            return formatted;
        });

        // 逐个添加到歌单（后端不支持批量添加）
        let successCount = 0;
        let failCount = 0;

        for (const song of formattedSongs) {
            try {
                const result = await API.playlists.addSong(playlistId, song, song.plugin);
                if (result.success) {
                    successCount++;
                } else {
                    failCount++;
                    console.warn('添加歌曲失败:', result.error, song);
                }
            } catch (err) {
                failCount++;
                console.error('添加歌曲出错:', err, song);
            }
        }

        if (successCount > 0) {
            if (!silent) {
                if (failCount > 0) {
                    showToast(`已添加 ${successCount} 首歌曲到 "${playlistName}"，${failCount} 首失败`, 'success');
                } else {
                    showToast(`已添加 ${successCount} 首歌曲到 "${playlistName}"`, 'success');
                }
            }

            // 如果当前正在查看这个歌单，刷新详情
            if (window.currentPlaylistDetail && window.currentPlaylistDetail.id === playlistId) {
                // 重新加载歌单详情
                const detailResponse = await Auth.authenticatedFetch(`${API_BASE}/api/my/playlists/${playlistId}`);
                const detailResult = await detailResponse.json();
                if (detailResult.success) {
                    window.currentPlaylistDetail = detailResult.data;
                    renderPlaylistDetailInContainer(window.currentPlaylistDetail);
                }
            }
        } else {
            if (!silent) {
                showToast('添加失败，请重试', 'error');
            }
        }
    } catch (error) {
        console.error('添加歌曲到歌单失败:', error);
        if (!silent) {
            showToast('添加失败: ' + error.message, 'error');
        }
    }
}

/**
 * 显示添加歌曲弹窗（兼容旧接口，实际调用新的）
 * @param {number} playlistId - 歌单ID（如果传入，则直接添加当前选中/全部歌曲到该歌单）
 */
function showAddSongsModal(playlistId) {
    if (playlistId) {
        // 如果传入了歌单ID，获取当前歌曲并添加到指定歌单
        let songs = [];

        // 尝试从 MusicTable 获取选中歌曲
        if (typeof MusicTable !== 'undefined' && MusicTable.getSelectedSongs) {
            const selectedSongs = MusicTable.getSelectedSongs();
            if (selectedSongs && selectedSongs.length > 0) {
                songs = selectedSongs;
            }
        }

        // 如果没有选中歌曲，尝试获取当前页面的全部歌曲
        if (songs.length === 0) {
            const currentList = getCurrentPageMusicList ? getCurrentPageMusicList() : [];
            if (currentList && currentList.length > 0) {
                songs = currentList;
            }
        }

        if (songs.length === 0) {
            showToast('没有可添加的歌曲', 'warning');
            return;
        }

        // 获取歌单名称
        const playlist = currentPlaylists.find(p => p.id === playlistId);
        const playlistName = playlist ? playlist.name : '歌单';

        // 直接添加
        addSongsToPlaylist(playlistId, playlistName, songs);
    } else {
        // 显示弹窗让用户选择
        showAddToPlaylistModal();
    }
}

/**
 * 下载歌单全部歌曲
 */
async function downloadAllSongs() {
    if (!window.currentPlaylistDetail?.songs?.length) {
        showToast('歌单为空', 'warning');
        return;
    }

    const songs = window.currentPlaylistDetail.songs;
    showToast(`开始下载 ${songs.length} 首歌曲...`, 'info');

    if (window.DownloadCore && typeof window.DownloadCore.downloadBatch === 'function') {
        const downloadParams = songs.map(song => ({
            id: song.id,
            title: song.title,
            artist: song.artist,
            plugin: song.plugin || song.platform,
            quality: 'standard',
            ...song
        }));
        await window.DownloadCore.downloadBatch(downloadParams, { delay: 500 }, '歌单-下载');
    } else {
        for (const song of songs) {
            try {
                const plugin = song.plugin || song.platform;
                if (!plugin) continue;
                await window.DownloadCore.startBackendDownload(song, '歌单-下载');
            } catch (error) {
                console.error('下载歌曲失败:', error);
            }
        }
    }
}

/**
 * 从歌单移除歌曲
 */
async function removeSongFromPlaylist(playlistId, music) {
    if (!music || !music.id) {
        showToast('无效的歌曲信息', 'error');
        return;
    }

    try {
        const plugin = music.plugin || music.platform;
        const result = await API.playlists.removeSong(playlistId, music.id, plugin);

        if (result.success) {
            showToast('已从歌单移除', 'success');
            openPlaylist(playlistId);
        } else {
            showToast('移除失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('从歌单移除失败:', error);
        showToast('移除失败: ' + error.message, 'error');
    }
}

/**
 * 添加歌曲到歌单（带重复检查）
 */
async function addSongToMyPlaylist(playlistId, music, options = {}) {
    if (!music || !music.id) {
        showToast('无效的歌曲信息', 'error');
        return { success: false, error: '无效的歌曲信息' };
    }

    try {
        const plugin = music.plugin || music.platform;
        const result = await API.playlists.addSong(playlistId, music, plugin);

        if (result.success) {
            if (!options.silent) {
                showToast('已添加到歌单', 'success');
            }
            return { success: true };
        } else if (result.error && result.error.includes('UNIQUE constraint failed')) {
            if (!options.silent) {
                showToast('歌曲已在歌单中', 'warning');
            }
            return { success: false, error: 'duplicate' };
        } else {
            if (!options.silent) {
                showToast('添加失败: ' + (result.error || '未知错误'), 'error');
            }
            return { success: false, error: result.error };
        }
    } catch (error) {
        console.error('添加到歌单失败:', error);
        if (!options.silent) {
            showToast('添加失败: ' + error.message, 'error');
        }
        return { success: false, error: error.message };
    }
}

// 导出函数到全局作用域
window.createPlaylist = createPlaylist;
window.showCreatePlaylistModal = showCreatePlaylistModal;
window.showEditPlaylistModal = showEditPlaylistModal;
window.closePlaylistModal = closePlaylistModal;
window.submitCreatePlaylist = submitCreatePlaylist;
window.submitEditPlaylist = submitEditPlaylist;
window.loadSidebarPlaylists = loadSidebarPlaylists;
window.renderSidebarPlaylists = renderSidebarPlaylists;
window.bindSidebarPlaylistEvents = bindSidebarPlaylistEvents;
window.loadMyPlaylists = loadMyPlaylists;
window.renderMyPlaylists = renderMyPlaylists;
window.renderPlaylistDetailInContainer = renderPlaylistDetailInContainer;
window.setSidebarPlaylistActive = setSidebarPlaylistActive;
window.toggleEditMode = toggleEditMode;
window.togglePlaylistSelect = togglePlaylistSelect;
window.toggleSelectAllPlaylists = toggleSelectAllPlaylists;
window.syncPlaylistSelectionUI = syncPlaylistSelectionUI;
window.deleteSelectedPlaylists = deleteSelectedPlaylists;
window.doDeletePlaylists = doDeletePlaylists;
/**
 * 歌单排序拖拽：统一在 document 上委托绑定（只绑一次，网格重渲染后依然有效）。
 * 仅「调整顺序」模式（isReorderMode）下生效，删除模式下完全不响应拖拽。
 */
function setupReorderDragDelegation() {
    if (window.__playlistReorderBound) return;
    window.__playlistReorderBound = true;

    document.addEventListener('dragstart', (e) => {
        const el = e.target && e.target.closest ? e.target.closest('.playlist-card-wrapper') : null;
        if (!el || !isReorderMode) return;
        handleDragStart.call(el, e);
    });
    document.addEventListener('dragend', (e) => {
        const el = e.target && e.target.closest ? e.target.closest('.playlist-card-wrapper') : null;
        if (!el) return;
        handleDragEnd.call(el, e);
    });
    document.addEventListener('dragover', (e) => {
        if (!isReorderMode) return;
        const el = e.target && e.target.closest ? e.target.closest('.playlist-card-wrapper, #playlist-grid') : null;
        if (!el) return;
        handleDragOver.call(el, e);
    });
    document.addEventListener('dragenter', (e) => {
        if (!isReorderMode) return;
        const el = e.target && e.target.closest ? e.target.closest('.playlist-card-wrapper') : null;
        if (!el) return;
        handleDragEnter.call(el, e);
    });
    document.addEventListener('dragleave', (e) => {
        if (!isReorderMode) return;
        const el = e.target && e.target.closest ? e.target.closest('.playlist-card-wrapper') : null;
        if (!el) return;
        handleDragLeave.call(el, e);
    });
    document.addEventListener('drop', (e) => {
        if (!isReorderMode) return;
        const el = e.target && e.target.closest ? e.target.closest('.playlist-card-wrapper') : null;
        if (!el) return;
        handleDrop.call(el, e);
    });
}

/**
 * 切换「调整顺序」模式（与删除模式互斥：删除模式下不允许拖拽排序）
 */
function toggleReorderMode() {
    isReorderMode = !isReorderMode;
    if (isReorderMode) {
        // 退出删除模式，清空勾选
        isEditMode = false;
        selectedPlaylists.clear();
    }
    // 走完整加载流程：重渲染顶部菜单（菜单文字同步）与列表
    loadMyPlaylists();
}
window.toggleReorderMode = toggleReorderMode;

/**
 * 顶部菜单「⋯」按钮：展开/收起歌单管理菜单
 */
function togglePlaylistMenu() {
    const menu = document.getElementById('playlist-menu');
    if (!menu) return;
    const willOpen = menu.style.display !== 'block';
    // 菜单项文字随管理模式切换
    const manageBtn = document.getElementById('playlist-menu-manage');
    if (manageBtn) {
        manageBtn.textContent = (typeof isEditMode !== 'undefined' && isEditMode) ? '完成管理' : '管理';
    }
    // 排序模式的「完成」按钮在页面顶部提示条中，菜单里不再显示
    const reorderBtn = document.getElementById('playlist-menu-reorder');
    if (reorderBtn) {
        reorderBtn.style.display = (typeof isReorderMode !== 'undefined' && isReorderMode) ? 'none' : 'flex';
    }
    menu.style.display = willOpen ? 'block' : 'none';
    if (willOpen) {
        setTimeout(() => document.addEventListener('click', closePlaylistMenu), 0);
    } else {
        document.removeEventListener('click', closePlaylistMenu);
    }
}

/**
 * 收起歌单管理菜单
 */
function closePlaylistMenu() {
    const menu = document.getElementById('playlist-menu');
    if (menu) menu.style.display = 'none';
    document.removeEventListener('click', closePlaylistMenu);
}

window.togglePlaylistMenu = togglePlaylistMenu;
window.closePlaylistMenu = closePlaylistMenu;

// 绑定歌单排序拖拽（document 委托，只绑一次）
setupReorderDragDelegation();

window.openPlaylist = openPlaylist;
window.backToPlaylistList = backToPlaylistList;

/**
 * 歌单详情页顶部菜单：左侧返回箭头 + 歌单名，右侧「⋯」按钮（内含下载）
 */
function setupPlaylistDetailHeader(playlist) {
    if (typeof PluginTabs !== 'undefined' && PluginTabs.renderWithBack) {
        PluginTabs.renderWithBack({
            title: '我的歌单',
            onBack: () => backToPlaylistList()
        });
        // 标题文字居中：把返回按钮移出标题容器（返回按钮保持左侧，标题整体居中）
        const hl = document.getElementById('header-left');
        const titleEl = hl && hl.querySelector('.header-title');
        const backBtn = hl && hl.querySelector('#back-btn');
        if (hl && titleEl && backBtn) {
            hl.insertBefore(backBtn, titleEl);
            titleEl.classList.add('playlist-detail-title');
        }
    }
    const actions = document.getElementById('header-actions');
    if (!actions) return;
    actions.querySelectorAll('.playlist-detail-more').forEach(el => el.remove());
    const wrap = document.createElement('div');
    wrap.className = 'playlist-detail-more';
    wrap.style.cssText = 'position: relative; display: flex; align-items: center;';
    wrap.innerHTML = `
        <button type="button" title="更多" onclick="event.stopPropagation(); togglePlaylistDetailMenu(event)"
            class="header-icon-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
        <div id="playlist-detail-menu"
            style="display: none; position: absolute; right: 0; top: calc(100% + 6px); min-width: 150px; background: var(--surface-color); border: 1px solid var(--divider-color); border-radius: 10px; box-shadow: var(--shadow-lg); z-index: 1002; padding: 6px 0; overflow: hidden;">
            <button type="button" onclick="event.stopPropagation(); closePlaylistDetailMenu(); togglePlaylistDetailManageMode();"
                style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">管理</button>
        </div>`;
    actions.appendChild(wrap);
}

function togglePlaylistDetailMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('playlist-detail-menu');
    if (!menu) return;
    const willOpen = menu.style.display !== 'block';
    menu.style.display = willOpen ? 'block' : 'none';
    if (willOpen) {
        setTimeout(() => document.addEventListener('click', closePlaylistDetailMenu), 0);
    } else {
        document.removeEventListener('click', closePlaylistDetailMenu);
    }
}

function closePlaylistDetailMenu() {
    const menu = document.getElementById('playlist-detail-menu');
    if (menu) menu.style.display = 'none';
    document.removeEventListener('click', closePlaylistDetailMenu);
}
window.togglePlaylistDetailMenu = togglePlaylistDetailMenu;
window.closePlaylistDetailMenu = closePlaylistDetailMenu;
// 供 app.js 切换页面时调用：离开歌单详情自动退出多选模式
window.resetPlaylistDetailManageMode = () => { playlistDetailManageMode = false; };

/**
 * 随机播放当前歌单的一首歌（Hero 随机按钮）
 */
function playPlaylistRandom() {
    const songs = window.currentPlaylistDetailSongs || [];
    if (!songs.length) {
        showToast('歌单为空', 'warning');
        return;
    }
    // 播放器随机按钮自动打开
    if (typeof enableShuffleMode === 'function') enableShuffleMode();
    playMusicFromPlaylist(Math.floor(Math.random() * songs.length));
}
window.playPlaylistRandom = playPlaylistRandom;

/**
 * 播放指定歌单的全部歌曲（卡片悬浮播放按钮）
 */
async function playPlaylistById(playlistId) {
    try {
        showToast('加载歌单...');
        const res = await API.playlists.getSongs(playlistId);
        if (!res.success) {
            showToast('播放失败: ' + (res.error || '未知错误'), 'error');
            return;
        }
        const songs = (res.data || []).map(s => ({ ...s, plugin: s.plugin || s.platform || 'local' }));
        if (!songs.length) {
            showToast('歌单为空', 'warning');
            return;
        }
        setCurrentPageMusicList(songs);
        playMusic(0);
    } catch (e) {
        showToast('播放失败: ' + e.message, 'error');
    }
}
window.playPlaylistById = playPlaylistById;
window.addSongToMyPlaylist = addSongToMyPlaylist;
window.removeSongFromPlaylist = removeSongFromPlaylist;
window.deletePlaylist = deletePlaylist;
window.confirmDeletePlaylist = confirmDeletePlaylist;
window.showConfirmModal = showConfirmModal;
window.closeConfirmModal = closeConfirmModal;
window.savePlaylistOrder = savePlaylistOrder;
window.playAllSongs = playAllSongs;
window.addAllSongsToPlaylist = addAllSongsToPlaylist;
window.showAddSongsModal = showAddSongsModal;
window.showAddToPlaylistModal = showAddToPlaylistModal;
window.closeAddToPlaylistModal = closeAddToPlaylistModal;
window.showCreateNewPlaylistForSongs = showCreateNewPlaylistForSongs;
window.closeCreatePlaylistForSongsModal = closeCreatePlaylistForSongsModal;
window.submitCreatePlaylistForSongs = submitCreatePlaylistForSongs;
window.addSongsToPlaylist = addSongsToPlaylist;
window.downloadAllSongs = downloadAllSongs;
window.playMusicFromPlaylist = playMusicFromPlaylist;
window.toggleFavoritePlaylistSong = toggleFavoritePlaylistSong;
window.downloadPlaylistSong = downloadPlaylistSong;
window.clearPlaylistSongs = clearPlaylistSongs;
window.togglePlaylistSelectAll = togglePlaylistSelectAll;
window.togglePlaylistRowSelect = togglePlaylistRowSelect;

/**
 * 导入歌单（从插件）
 * 打开插件页面让用户选择要导入的歌单
 */
function importPlaylist() {
    // 切换到插件页面
    if (typeof switchPage === 'function') {
        switchPage('plugins');
        showToast('请在插件页面选择歌单导入', 'info');
    } else {
        showToast('页面切换功能不可用', 'error');
    }
}
window.importPlaylist = importPlaylist;
