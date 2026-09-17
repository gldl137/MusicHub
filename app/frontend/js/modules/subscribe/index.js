/**
 * 订阅管理模块
 * 用于管理榜单和歌单的订阅
 */

/**
 * 确保订阅页样式表（带版本号）已加载，避免应用内切换标签时停留在旧的缓存 CSS
 */
function ensureSubscribeCss() {
    const href = 'css/modules/subscribe/index.css?v=2';
    let link = document.querySelector('link[href="' + href + '"]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.appendChild(link);
    }
}

/**
 * 加载订阅的榜单列表
 */
async function loadSubscribedToplists() {
    ensureSubscribeCss();
    try {
        const token = Auth.getToken();
        const [toplistsResponse, pluginsResponse] = await Promise.all([
            fetch(`${API_BASE}/api/subscribed-toplists`, {
                headers: { 'Authorization': `Bearer ${token}` }
            }),
            fetch(`${API_BASE}/api/plugins`)
        ]);

        const toplistsResult = await toplistsResponse.json();
        const pluginsResult = await pluginsResponse.json();

        // 构建插件别名映射表（同时用 platform 和 name 作为键）
        const pluginDisplayNameMap = {};
        if (pluginsResult.success && pluginsResult.data) {
            pluginsResult.data.forEach(plugin => {
                const displayName = plugin.displayName || plugin.platform || plugin.name;
                // 用 platform 作为键
                if (plugin.platform) {
                    pluginDisplayNameMap[plugin.platform] = displayName;
                }
                // 用 name（文件名）作为键
                if (plugin.name) {
                    pluginDisplayNameMap[plugin.name] = displayName;
                }
            });
        }

        if (toplistsResult.success) {
            const toplists = toplistsResult.data || [];

            renderSubscribedToplists(toplists, pluginDisplayNameMap);
        } else {
            const container = document.getElementById('subscribed-toplist-container');
            if (container) {
                container.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-icon">⚠️</div>
                        <div class="empty-text">加载失败</div>
                        <div class="empty-subtext">${escapeHtml(toplistsResult.error || '未知错误')}</div>
                    </div>
                `;
            }
        }
    } catch (error) {
        console.error('加载订阅列表失败:', error);
        const container = document.getElementById('subscribed-toplist-container');
        if (container) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">⚠️</div>
                    <div class="empty-text">加载失败</div>
                    <div class="empty-subtext">${escapeHtml(error.message)}</div>
                </div>
            `;
        }
    }
}

/**
 * 当前筛选状态
 */
let currentFilter = 'all';
let allSubscriptionItems = [];
let currentPluginDisplayNameMap = {};

/**
 * 筛选订阅列表
 * @param {Array} items - 所有订阅项
 * @param {string} filter - 筛选条件
 * @returns {Array} 筛选后的列表
 */
function filterSubscriptions(items, filter) {
    if (filter === 'all') return items;

    return items.filter(item => {
        const isEnabled = item.is_enabled !== 0;
        const downloaded = item.downloaded_count || 0;
        const total = item.total_songs ?? 0;

        switch (filter) {
            case 'subscribing':
                // 订阅中：已启用且未完成
                return isEnabled && !(total > 0 && downloaded === total);
            case 'completed':
                // 已完成：已启用且完成
                return isEnabled && total > 0 && downloaded === total;
            case 'toplist':
                // 排行榜类型
                return item.source_type === 'toplist';
            case 'playlist':
                // 热门歌单类型
                return item.source_type === 'playlist';
            default:
                return true;
        }
    });
}

/**
 * 更新筛选标签状态
 * @param {string} filter - 当前选中的筛选条件
 */
function updateFilterTabs(filter) {
    const tabs = document.querySelectorAll('.filter-tab');
    tabs.forEach(tab => {
        if (tab.dataset.filter === filter) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
}

/**
 * 绑定筛选标签事件
 */
function bindFilterEvents() {
    const filterContainer = document.getElementById('subscription-filter-tabs');
    if (!filterContainer) return;

    filterContainer.addEventListener('click', (e) => {
        const tab = e.target.closest('.filter-tab');
        if (!tab) return;

        const filter = tab.dataset.filter;
        if (filter && filter !== currentFilter) {
            currentFilter = filter;
            updateFilterTabs(filter);
            applyCurrentFilter();
        }
    });
}

/**
 * 绑定查看详情按钮事件
 */
function bindViewDetailButtons() {
    const container = document.getElementById('subscribed-toplist-container');
    if (!container) {
        return;
    }

    // 绑定封面点击事件 - 点击查看详情
    const covers = container.querySelectorAll('.view-detail-cover');

    covers.forEach(cover => {
        cover.addEventListener('click', (_e) => {
            const platform = cover.dataset.platform;
            const id = cover.dataset.id;
            const title = decodeURIComponent(cover.dataset.title || '');
            const type = cover.dataset.type;
            viewSubscriptionDetail(platform, id, title, type);
        });
    });

}

/**
 * 应用当前筛选并重新渲染
 */
function applyCurrentFilter() {
    const filteredItems = filterSubscriptions(allSubscriptionItems, currentFilter);
    renderFilteredToplists(filteredItems, currentPluginDisplayNameMap);
}

/**
 * 渲染筛选后的列表
 * @param {Array} items
 * @param {Object} pluginDisplayNameMap
 */
function renderFilteredToplists(items, pluginDisplayNameMap = {}) {
    const container = document.getElementById('subscribed-toplist-container');
    if (!container) return;

    // 更新订阅数量（显示筛选后的数量）
    const countEl = document.getElementById('subscription-count');
    if (countEl) {
        const totalCount = allSubscriptionItems.length;
        const filteredCount = items.length;
        if (currentFilter === 'all') {
            countEl.textContent = filteredCount;
        } else {
            countEl.textContent = `${filteredCount}/${totalCount}`;
        }
    }

    if (items.length === 0) {
        const emptyMessages = {
            'all': '暂无订阅',
            'subscribing': '暂无订阅中的榜单',
            'completed': '暂无已完成的榜单',
            'toplist': '暂无排行榜订阅',
            'playlist': '暂无热门歌单订阅'
        };
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📋</div>
                <div class="empty-text">${emptyMessages[currentFilter] || '暂无数据'}</div>
                <div class="empty-subtext">在排行榜或热门歌单页面点击"订阅"按钮添加</div>
            </div>
        `;
        return;
    }

    // 按创建时间倒序排列
    const sortedItems = items.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    container.innerHTML = `
        <div class="subscription-list">
            ${sortedItems.map(item => renderSubscriptionCard(item, pluginDisplayNameMap)).join('')}
        </div>
    `;

    // 绑定查看详情按钮事件
    bindViewDetailButtons();
}

/**
 * 渲染订阅列表
 * @param {Array} items
 * @param {Object} pluginDisplayNameMap - 插件别名映射表
 */
function renderSubscribedToplists(items, pluginDisplayNameMap = {}) {
    // 保存数据供筛选使用
    allSubscriptionItems = items;
    currentPluginDisplayNameMap = pluginDisplayNameMap;

    // 绑定筛选事件（只绑定一次）
    bindFilterEvents();

    // 应用当前筛选
    applyCurrentFilter();
}

/**
 * 渲染单个订阅卡片（横向布局，参考追剧卡片样式）
 * @param {Object} item
 * @param {Object} pluginDisplayNameMap - 插件别名映射表
 * @returns {string}
 */
function renderSubscriptionCard(item, pluginDisplayNameMap = {}) {
    // 尝试多种可能的封面字段名
    const coverUrl = item.cover || item.artwork || item.coverImg || item.pic || '';
    const isEnabled = item.is_enabled !== 0;
    // 注意：数据库返回的是 snake_case 字段名
    const isExcludeEnabled = item.exclude_enabled !== 0; // 该订阅是否启用下载排除/语言过滤
    const total = item.total_songs ?? 0;
    const downloadedCount = item.downloaded_count || 0;

    // 封面进度层显示下载进度（已下载/总数），下载后会变化
    const isCompleted = total > 0 && downloadedCount >= total;
    const progressText = total > 0 ? `下载 ${downloadedCount}/${total}` : '-/-';

    // 时间格式化
    const lastRunText = item.last_run_at ? formatDateTime(item.last_run_at) : '从未运行';

    // 检查封面 URL 是否有效
    const hasValidCover = coverUrl && coverUrl.trim() !== '' && coverUrl !== 'null' && coverUrl !== 'undefined';

    return `
        <div class="subscription-card-h ${!isEnabled ? 'disabled' : ''}" data-id="${item.id}">
            <!-- 卡片上部：封面+内容 -->
            <div class="card-main">
                <!-- 顶部：开关 -->
                <div class="content-header-row">
                    <label class="action-toggle ${isEnabled ? 'enabled' : 'disabled'}" onclick="event.stopPropagation()" title="${isEnabled ? '点击禁止订阅' : '点击启动订阅'}">
                        <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="toggleSubscription('${item.platform}', '${item.toplist_id}', this.checked)">
                        <span class="action-toggle-slider"></span>
                        <span class="action-toggle-text">${isEnabled ? '订阅已启用' : '订阅已禁用'}</span>
                    </label>
                    <label class="action-toggle ${isExcludeEnabled ? 'enabled' : 'disabled'}" onclick="event.stopPropagation()" title="${isExcludeEnabled ? '点击关闭下载过滤（排除歌手/语言）' : '点击开启下载过滤（排除歌手/语言）'}">
                        <input type="checkbox" ${isExcludeEnabled ? 'checked' : ''} onchange="toggleSubscriptionExclude('${item.platform}', '${item.toplist_id}', this.checked)">
                        <span class="action-toggle-slider"></span>
                        <span class="action-toggle-text">${isExcludeEnabled ? '过滤已开启' : '过滤已关闭'}</span>
                    </label>
                </div>

                <!-- 中间：封面 + 信息 -->
                <div class="content-body-row">
                    <!-- 左侧封面 - 点击可查看详情 -->
                    <div class="subscription-cover-h view-detail-cover" data-platform="${item.platform}" data-id="${item.toplist_id}" data-title="${encodeURIComponent(item.title || '')}" data-type="${item.source_type}" style="cursor: pointer;" title="点击查看详情">
                        ${hasValidCover
                            ? `<img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" data-raw="${escapeHtml(coverUrl)}" onerror="window.__coverImgOnError(this)">`
                            : ''
                        }
                        <div class="cover-placeholder" style="${hasValidCover ? 'display:none;' : 'display:flex;'}">
                            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M9 18V5l12-2v13"></path>
                                <circle cx="6" cy="18" r="3"></circle>
                                <circle cx="18" cy="16" r="3"></circle>
                            </svg>
                        </div>
                        <!-- 进度覆盖层 显示 总共/剩余 -->
                        <div class="cover-progress">
                            <span class="progress-count">${progressText}</span>
                        </div>
                    </div>

                    <!-- 右侧信息区域 -->
                    <div class="content-info-area">
                        <!-- 名字 -->
                        <h3 class="content-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h3>

                        <!-- 信息列表 -->
                        <div class="content-info-list">
                            <div class="info-item">
                                <span class="info-label">类型：</span>
                                <span class="info-value">${item.source_type === 'playlist' ? '热门歌单' : '排行榜'}</span>
                            </div>
                            <div class="info-item">
                                <span class="info-label">音源：</span>
                                <span class="info-value">${escapeHtml(pluginDisplayNameMap[item.platform] || item.platform)}</span>
                            </div>
                            <div class="info-item">
                                <span class="info-label">更新：</span>
                                <span class="info-value">${lastRunText}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 底部：操作区 -->
                <div class="content-actions-row">
                    ${isCompleted ? '<span class="status-completed-btn">已完成</span>' : ''}
                    <div class="action-buttons-group">
                        <button class="action-btn btn-secondary" onclick="runSubscriptionSync('${item.platform || ''}', '${item.toplist_id || ''}', '${encodeURIComponent(item.title || '')}')">
                            <span>同步</span>
                        </button>
                        <button class="action-btn btn-secondary" data-platform="${item.platform || ''}" data-toplist-id="${item.toplist_id || ''}" onclick="runSubscriptionDownloadWithBtn(this, '${item.platform || ''}', '${item.toplist_id || ''}', '${encodeURIComponent(item.title || '')}')">
                            <span>下载</span>
                        </button>
                        <button class="action-btn btn-danger" onclick="unsubscribeToplist('${item.toplist_id || ''}', event, '${item.platform || ''}')">
                            <span>删除</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

/**
 * 格式化日期时间
 * @param {number} timestamp
 * @returns {string}
 */
function formatDateTime(timestamp) {
    if (!timestamp) return '未知';
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}`;
}

/**
 * 切换订阅启用状态
 * @param {string} platform
 * @param {string} toplistId
 * @param {boolean} enabled
 */
async function toggleSubscription(platform, toplistId, enabled) {
    try {
        const token = Auth.getToken();
        const response = await fetch(`${API_BASE}/api/subscribed-toplists`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                platform,
                toplistId,
                isEnabled: enabled
            })
        });

        const result = await response.json();

        if (result.success) {
            showToast(enabled ? '订阅已启用' : '订阅已禁用', 'success');
            loadSubscribedToplists();
        } else {
            showToast('操作失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('切换订阅状态失败:', error);
        showToast('操作失败: ' + error.message, 'error');
    }
}

/**
 * 切换订阅的下载过滤（排除歌手/语言）开关
 * @param {string} platform
 * @param {string} toplistId
 * @param {boolean} enabled
 */
async function toggleSubscriptionExclude(platform, toplistId, enabled) {
    try {
        const token = Auth.getToken();
        const response = await fetch(`${API_BASE}/api/subscribed-toplists`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                platform,
                toplistId,
                isExcludeEnabled: enabled
            })
        });

        const result = await response.json();

        if (result.success) {
            showToast(enabled ? '已开启下载过滤' : '已关闭下载过滤', 'success');
            loadSubscribedToplists();
        } else {
            showToast('操作失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('切换下载过滤状态失败:', error);
        showToast('操作失败: ' + error.message, 'error');
    }
}

/**
 * 查看订阅详情
 * @param {string} platform
 * @param {string} toplistId
 * @param {string} title
 * @param {string} sourceType - 来源类型：toplist 或 playlist
 */
function viewSubscriptionDetail(platform, toplistId, title, sourceType) {
    if (sourceType === 'playlist') {
        // 推荐歌单使用推荐模块的详情页，传递 platform 作为插件名
        // 返回时回到订阅页面
        const onBack = () => {
            switchPage('subscribed-toplist');
            loadSubscribedToplists();
        };
        loadSheetDetail(toplistId, encodeURIComponent(title), platform, onBack);
    } else {
        // 排行榜使用榜单模块的详情页
        // 返回时回到订阅页面
        const onBack = () => {
            switchPage('subscribed-toplist');
            loadSubscribedToplists();
        };
        loadTopListDetail(toplistId, title, platform, onBack);
    }
}

/**
 * 订阅榜单
 * @param {string} toplistId
 * @param {string} pluginName
 * @param {Object} extraData - 额外数据如标题、封面等
 * @param {number} totalSongs - 歌曲总数
 * @returns {Promise<boolean>} 是否订阅成功（失败/已订阅时为 false，函数内部已提示）
 */
async function subscribeToplist(toplistId, pluginName, extraData = {}, totalSongs = 0) {
    try {
        const token = Auth.getToken();
        const response = await fetch(`${API_BASE}/api/subscribed-toplists`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                platform: pluginName,
                toplistId: toplistId,
                title: extraData.title || toplistId,
                description: extraData.description || '',
                cover: extraData.cover || '',
                sourceType: extraData.sourceType || 'toplist',
                downloadQuality: extraData.downloadQuality || 'standard',
                isEnabled: extraData.isEnabled !== undefined ? extraData.isEnabled : 0,
                totalSongs: totalSongs
            })
        });

        const result = await response.json();

        if (result.success) {
            showToast('订阅成功！', 'success');
            // 刷新列表显示
            loadSubscribedToplists();
            // 如果是启动状态，后台静默执行同步（仅更新歌曲列表，不下载）
            const isEnabled = extraData.isEnabled !== undefined ? extraData.isEnabled : 0;
            if (isEnabled === 1 || isEnabled === true) {
                setTimeout(() => {
                    runSubscriptionSync(pluginName, toplistId, encodeURIComponent(extraData.title || ''));
                }, 500);
            }
            return true;
        } else {
            showToast('订阅失败: ' + (result.error || '未知错误'), 'error');
            return false;
        }
    } catch (error) {
        console.error('订阅榜单失败:', error);
        showToast('订阅失败: ' + error.message, 'error');
        return false;
    }
}

/**
 * 取消订阅榜单
 * @param {string} toplistId
 * @param {Event} event
 * @param {string} pluginName
 * @returns {Promise<boolean>} 是否已取消订阅（用户取消确认 / 失败时为 false）
 */
async function unsubscribeToplist(toplistId, event, pluginName) {
    const reqId = Math.random().toString(36).substring(2, 10);
    const platform = pluginName || window.currentTopListPlugin || 'unknown';
    
    if (event) {
        event.stopPropagation();
    }

    console.log(`[INFO ][UNSUBSCRIBE][${reqId}] START | 取消订阅 | platform=${platform}, toplistId=${toplistId}`);

    const confirmed = await Notification.confirm('确定要取消订阅这个榜单吗？', { type: 'warning' });
    if (!confirmed) {
        console.log(`[INFO ][UNSUBSCRIBE][${reqId}] CANCEL | 用户取消操作`);
        return false;
    }

    try {
        const token = Auth.getToken();
        console.log(`[INFO ][UNSUBSCRIBE][${reqId}] API | DELETE /api/subscribed-toplists | platform=${platform}, toplistId=${toplistId}`);
        const response = await fetch(`${API_BASE}/api/subscribed-toplists?platform=${encodeURIComponent(platform)}&toplistId=${encodeURIComponent(toplistId)}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        const result = await response.json();

        if (result.success) {
            console.log(`[INFO ][UNSUBSCRIBE][${reqId}] SUCCESS | 取消订阅成功 | platform=${platform}, toplistId=${toplistId}`);
            showToast('已取消订阅', 'success');
            loadSubscribedToplists();
            return true;
        } else {
            console.error(`[ERROR][UNSUBSCRIBE][${reqId}] FAILED | 取消订阅失败 | ${result.error || '未知错误'}`);
            showToast('取消订阅失败: ' + (result.error || '未知错误'), 'error');
            return false;
        }
    } catch (error) {
        console.error(`[ERROR][UNSUBSCRIBE][${reqId}] ERROR | 取消订阅异常 | ${error.message}`);
        showToast('取消订阅失败: ' + error.message, 'error');
        return false;
    }
}

// 导出函数到全局作用域
window.loadSubscribedToplists = loadSubscribedToplists;
window.subscribeToplist = subscribeToplist;
window.unsubscribeToplist = unsubscribeToplist;
window.toggleSubscription = toggleSubscription;
window.viewSubscriptionDetail = viewSubscriptionDetail;

// 以下函数定义在单独的文件中：
// - download.js: runSubscriptionDownload, showTaskProgressModal
// - sync.js: runSubscriptionSync, batchSyncSubscriptions
