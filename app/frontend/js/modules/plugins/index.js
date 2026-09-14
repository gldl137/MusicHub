/**
 * 插件管理模块
 * 功能：加载插件列表、安装、卸载、更新插件
 */

// ==================== 插件管理 ====================

/**
 * 加载已安装插件列表
 * @param {string} targetContainer - 可选，指定渲染目标容器ID
 */
async function loadPlugins(targetContainer = null) {
    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins`);
        const result = await response.json();

        if (result.success) {
            installedPlugins = result.data || [];

            // 管理操作走这里直连最新；顺带把共享缓存刷成最新（别名解析/设置页等共用）
            _installedPluginsCache.data = installedPlugins;
            _installedPluginsCache.ts = Date.now();

            // 如果指定了目标容器，渲染到指定容器，否则渲染到默认容器
            if (targetContainer) {
                renderPlugins(targetContainer);
            } else {
                renderPlugins();
                // 同时渲染到设置页面容器（如果存在）
                const settingsContainer = document.getElementById('settings-plugin-table-container');
                if (settingsContainer) {
                    renderPlugins('settings-plugin-table-container');
                }
            }
        }
    } catch (error) {
        console.error('Failed to load plugins:', error);
        showToast('加载插件列表失败', 'error');
    }
}

// ==================== 插件列表共享缓存 ====================
// /api/plugins 被多个入口独立拉取（启动、设置页选择器、歌单别名解析等）：
// 这里提供带 5 分钟 TTL + 并发合并（inflight 去重）的共享读取。
// 插件管理操作仍走 loadPlugins() 直连最新，并顺带刷新本缓存。
let _installedPluginsCache = { data: null, ts: 0, inflight: null };
const INSTALLED_PLUGINS_CACHE_TTL = 5 * 60 * 1000;

/**
 * 读取已安装插件列表（共享缓存版）
 * @param {{force?: boolean}} opts force=true 跳过 TTL 直连拉取
 * @returns {Promise<Array>}
 */
async function fetchInstalledPluginsCached(opts = {}) {
    const force = !!(opts && opts.force);
    const now = Date.now();
    if (!force && _installedPluginsCache.data && now - _installedPluginsCache.ts < INSTALLED_PLUGINS_CACHE_TTL) {
        return _installedPluginsCache.data;
    }
    if (_installedPluginsCache.inflight) return _installedPluginsCache.inflight;
    _installedPluginsCache.inflight = (async () => {
        try {
            const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins`);
            const result = await response.json();
            if (!result.success) throw new Error(result.error || '加载插件列表失败');
            _installedPluginsCache.data = result.data || [];
            _installedPluginsCache.ts = Date.now();
            window.installedPlugins = _installedPluginsCache.data;
            return _installedPluginsCache.data;
        } finally {
            _installedPluginsCache.inflight = null;
        }
    })();
    return _installedPluginsCache.inflight;
}
window.fetchInstalledPluginsCached = fetchInstalledPluginsCached;

/**
 * 渲染插件列表
 * @param {string} containerId - 容器ID，默认为 'plugin-table-container'
 */
function renderPlugins(containerId = 'plugin-table-container') {
    const container = document.getElementById(containerId);
    if (!container) return;

    // 判断是否是设置页面的新表格容器
    const isSettingsDataTable = containerId === 'settings-plugin-table-container';

    if (installedPlugins.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🔌</div>
                <div class="empty-text">暂无插件，点击上方按钮安装</div>
            </div>`;
        return;
    }

    // 设置页面与默认页面统一使用「按音源分组、一行 3 个」的新卡片网格
    // 设置页（settings-plugin-table-container）额外展示版本/别名/备注与导入等入口
    if (isSettingsDataTable) {
        container.innerHTML = buildPluginSourceGroups(installedPlugins, { withMeta: true });
        return;
    }

    // 默认容器同样使用「按音源分组、一行 3 个」的新卡片网格（不含设置页专属的版本/别名/备注等信息）
    container.innerHTML = buildPluginSourceGroups(installedPlugins, { withMeta: false });
}

/**
 * 构建「按音源（platform）分组、每音源一个表格卡片、一个插件一横条」的列表 HTML
 * 横条字段（从左到右）：开关 / 插件名字 / 作者 / 地址 / 更新 / 删除；支持组内拖拽排序；每音源最多 5 个源
 * @param {Array} plugins - 已安装插件列表
 * @param {Object} [opts]
 * @param {boolean} [opts.withMeta=false] - true 时额外展示版本/别名/备注，并提供导入单曲/导入歌单/用户变量入口（用于设置页）
 * @returns {string}
 */
function buildPluginSourceGroups(plugins, { withMeta = false } = {}) {
    const groups = new Map();
    plugins.forEach((p) => {
        // 优先按物理目录名（groupName）分组，确保同目录插件一定在同一组；
        // fallback 到 platform 字段（兼容平铺在根目录的旧插件）
        // 归一化分组 key（trim + Unicode NFC 规范化），避免目录名/别名的不可见字符差异导致同音源分裂
        const key = (p.groupName || p.platform || '未知音源').toString().trim().normalize('NFC');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
    });

    let html = '<div class="plugin-source-grid">';
    let groupIndex = 0;
    const totalGroups = groups.size;
    for (const [source, list] of groups) {
        const isFirstGroup = groupIndex === 0;
        const isLastGroup = groupIndex === totalGroups - 1;
        groupIndex++;
        html += `
            <div class="plugin-source-group" draggable="true" data-group-key="${escapeHtml(source)}">
                <div class="plugin-thead">
                    <div class="plugin-group-title">
                        <span>${escapeHtml(source)}</span>
                        <span class="plugin-group-count">（${list.length}）</span>
                        <span class="plugin-group-sort" title="调整音源卡片顺序（同时决定排行榜/热门歌单的标签顺序）">
                            <button class="plugin-move-btn" ${isFirstGroup ? 'disabled' : ''} data-group-action="move" data-group-key="${escapeHtml(source)}" data-dir="up" title="音源上移">
                                <svg viewBox="0 0 16 10" width="11" height="6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 7l6-5 6 5"/></svg>
                            </button>
                            <button class="plugin-move-btn" ${isLastGroup ? 'disabled' : ''} data-group-action="move" data-group-key="${escapeHtml(source)}" data-dir="down" title="音源下移">
                                <svg viewBox="0 0 16 10" width="11" height="6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3L8 8 2 3"/></svg>
                            </button>
                        </span>
                    </div>
                </div>
                <div class="plugin-table">
                    <div class="plugin-head">
                        <div class="plugin-cell-sort">排序</div>
                        <div class="plugin-cell-enabled">开关</div>
                        <div class="plugin-cell-name">名字</div>
                        <div class="plugin-cell-author">作者</div>
                        <div class="plugin-cell-version">版本</div>
                        <div class="plugin-cell-actions">操作</div>
                    </div>
        `;

        list.forEach((plugin, i) => {
            const isEnabled = plugin.enabled !== false;
            const name = escapeHtml(plugin.name);
            const displayName = escapeHtml(plugin.name.replace(/\.[^./\\]+$/, ''));
            const isFirst = i === 0;
            const isLast = i === list.length - 1;
            const urlDisplay = plugin.url
                ? `<span title="${escapeHtml(decodeURIComponent(plugin.url))}">${escapeHtml(decodeURIComponent(plugin.url).length > 40 ? decodeURIComponent(plugin.url).substring(0, 40) + '...' : decodeURIComponent(plugin.url))}</span>`
                : '本地安装';

            const toggleBtn = `
                <label class="plugin-toggle-switch" title="${isEnabled ? '点击禁用插件' : '点击启用插件'}">
                    <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="togglePlugin('${name}', this)">
                    <span class="plugin-toggle-slider"></span>
                </label>
            `;

            let extraActions = '';
            // 工具插件开关：标记后不作为音源出现在排行榜/热门歌单/搜索等列表（仍可用于歌词/封面等辅助用途）
            const isUtility = plugin.config && plugin.config.utility === true;
            extraActions += `<button class="plugin-row-btn ${isUtility ? 'danger' : ''}" title="${isUtility ? '恢复为音源：重新出现在排行榜/热门歌单等列表' : '设为工具插件：仅用于歌词/封面等辅助用途，不作为音源展示'}" onclick="togglePluginUtility('${name}')">${isUtility ? '恢复音源' : '仅工具'}</button>`;
            // 用户变量入口：只要插件声明了 userVariables 就展示（插件管理页与设置页都可用）
            if (Array.isArray(plugin.userVariables) && plugin.userVariables.length > 0) {
                extraActions += `<button class="plugin-row-btn" onclick="showUserVars('${name}')">用户变量</button>`;
            }
            if (withMeta) {
                const sm = plugin.supportedMethods || [];
                if (sm.includes('importMusicItem')) {
                    extraActions += `<button class="plugin-row-btn" onclick="importMusicItemFromPlugin('${name}')">导入单曲</button>`;
                }
                if (sm.includes('importMusicSheet')) {
                    extraActions += `<button class="plugin-row-btn" onclick="importPlaylistFromPlugin('${name}')">导入歌单</button>`;
                }
            }

            html += `
                <div class="plugin-row ${isEnabled ? '' : 'disabled'}"
                     data-plugin-name="${name}" data-platform="${escapeHtml(plugin.groupName || plugin.platform || '')}">
                    <div class="plugin-cell-sort" data-label="排序">
                        <span class="plugin-move-btns">
                            <button class="plugin-move-btn" ${isFirst ? 'disabled' : ''} title="上移" onclick="movePluginStep('${name}', 'up')">
                                <svg viewBox="0 0 16 10" width="11" height="6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 7l6-5 6 5"/></svg>
                            </button>
                            <button class="plugin-move-btn" ${isLast ? 'disabled' : ''} title="下移" onclick="movePluginStep('${name}', 'down')">
                                <svg viewBox="0 0 16 10" width="11" height="6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3L8 8 2 3"/></svg>
                            </button>
                        </span>
                    </div>
                    <div class="plugin-cell-enabled" data-label="开关">${toggleBtn}</div>
                    <div class="plugin-cell-name" data-label="名字">
                        <div class="plugin-row-name" title="${name}${plugin.loadError ? '（加载失败：' + escapeHtml(plugin.loadError) + '）' : ''}">${displayName}${plugin.loadError ? ' <span style="color: #ef4444; font-size: 12px; font-weight: 500;">加载失败</span>' : ''}</div>
                    </div>
                    <div class="plugin-cell-author" data-label="作者">${plugin.loadError ? '—' : escapeHtml(plugin.author || '未知作者')}</div>
                    <div class="plugin-cell-version" data-label="版本" data-version="${plugin.loadError ? '加载失败' : escapeHtml(plugin.version || '—')}"></div>
                    <div class="plugin-cell-actions" data-label="操作">
                        <button class="plugin-row-btn" onclick="updatePlugin('${name}')">更新</button>
                        <button class="plugin-row-btn danger" onclick="uninstallPlugin('${name}')">删除</button>
                        ${extraActions}
                    </div>
                </div>
            `;
        });

        html += `
                </div><!-- /.plugin-table -->
            </div><!-- /.plugin-source-group -->
        `;
    }

    html += '</div>';
    return html;
}

/**
 * 渲染设置页面的插件列表
 */
function renderSettingsPlugins() {
    renderPlugins('settings-plugin-table-container');
}

/**
 * 切换插件启用状态
 * @param {string} pluginName
 * @param {HTMLInputElement} checkbox
 */
async function togglePlugin(pluginName, checkbox) {
    const newState = checkbox.checked;
    console.log('[INFO] [] [Plugin] Toggling plugin:', pluginName, 'to', newState);

    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/${encodeURIComponent(pluginName)}/toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: newState })
        });

        const result = await response.json();

        if (result.success) {
            console.log('[Plugin] Toggling plugin:', pluginName, 'to', newState);
            showToast(`插件${result.enabled ? '启用' : '禁用'}`, 'success');
            // 刷新插件列表以更新UI状态
            loadPlugins();
            // 重新加载插件支持列表（因为禁用后不应再显示）
            loadTopListPlugins();
            loadRecommendPlugins();
        } else {
            showToast('操作失败: ' + (result.error || '未知错误'), 'error');
            // 恢复checkbox状态
            checkbox.checked = !newState;
        }
    } catch (error) {
        console.error('切换插件状态失败', error);
        showToast('操作失败: ' + error.message, 'error');
        // 恢复checkbox状态
        checkbox.checked = !newState;
    }
}

/**
 * 一键更新全部插件
 */
async function updateAllPlugins() {
    const confirmed = await Notification.confirm('确定要一键更新所有插件吗？\n\n注意：只有配置了网络地址的插件才会被更新');
    if (!confirmed) {
        return;
    }

    showToast('正在检查并更新所有插件...', 'info');

    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/update-all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const result = await response.json();

        if (result.success) {
            const { failed } = result.data;
            showToast(result.message, 'success');

            // 刷新插件列表
            loadPlugins();
            // 重新加载插件支持列表
            loadTopListPlugins();
            loadRecommendPlugins();

            // 如果有失败的，显示详细信息
            if (failed.length > 0) {
                console.error('[ERROR] [] Failed plugins:', failed);
            }
        } else {
            showToast('更新失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('一键更新插件失败', error);
        showToast('更新失败: ' + error.message, 'error');
    }
}

// ==================== 安装别名下拉（选择已装音源目录，或新建别名） ====================

/** 收集已安装插件的去重音源别名（分组目录名，groupName 优先，回退 platform） */
function installedAliasList() {
    const set = new Set();
    (window.installedPlugins || []).forEach((p) => {
        const alias = (p.groupName || p.platform || '').toString().trim().normalize('NFC');
        if (alias) set.add(alias);
    });
    return Array.from(set);
}

/** 填充别名下拉：已安装别名 + 「新建音源别名」选项 */
function populateAliasOptions(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    select.innerHTML = '<option value="">选择要归入的音源别名…</option>';
    installedAliasList().forEach((alias) => {
        const opt = document.createElement('option');
        opt.value = alias;
        opt.textContent = alias;
        select.appendChild(opt);
    });
    const optNew = document.createElement('option');
    optNew.value = '__new__';
    optNew.textContent = '＋ 新建音源别名…';
    select.appendChild(optNew);
    select.value = '';
}

/** 别名下拉切换：选中「新建音源别名」时显示输入框，否则隐藏 */
function onAliasSelectChange(selectEl, newInputId) {
    if (!selectEl) return;
    const newInput = document.getElementById(newInputId);
    if (!newInput) return;
    if (selectEl.value === '__new__') {
        newInput.style.display = '';
        newInput.focus();
    } else {
        newInput.style.display = 'none';
    }
}

/** 取最终安装别名：已选中的音源别名，或「新建别名」输入框中的值 */
function resolveInstallAlias(selectId, newInputId) {
    const select = document.getElementById(selectId);
    const chosen = select ? (select.value || '').trim() : '';
    if (chosen === '__new__') {
        const newInput = document.getElementById(newInputId);
        return newInput ? newInput.value.trim() : '';
    }
    return chosen;
}

/**
 * 显示从URL安装模态框（打开时填充已装别名下拉）
 */
function showInstallFromUrlModal() {
    const modal = document.getElementById('install-from-url-modal');
    populateAliasOptions('plugin-name-input');
    const aliasNew = document.getElementById('plugin-name-input-new');
    if (aliasNew) { aliasNew.value = ''; aliasNew.style.display = 'none'; }
    if (modal) {
        modal.style.display = 'flex';
    }
}

/**
 * 关闭模态框
 */
function closeModal() {
    const modals = document.querySelectorAll('.modal-overlay');
    modals.forEach(modal => {
        modal.style.display = 'none';
    });
}

/**
 * 从文件安装插件
 * @param {Event} event
 */
async function installPluginFromFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    // 本地安装同样需要别名：作为安装目录名（选已装别名归入该目录，或新建别名）
    const alias = resolveInstallAlias('plugin-file-alias-input', 'plugin-file-alias-input-new');
    if (!alias) {
        showToast('请选择或输入插件别名（将用作安装目录名）', 'error');
        event.target.value = '';
        return;
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('displayName', alias);

    showToast('正在安装插件...');

    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/install`, {
            method: 'POST',
            body: formData
        });

        const result = await response.json();

        if (result.success) {
            showToast('插件安装成功', 'success');
            loadPlugins();
            // 重新加载插件支持列表
            loadTopListPlugins();
            loadRecommendPlugins();
        } else {
            showToast('安装失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('安装插件失败:', error);
        showToast('安装失败: ' + error.message, 'error');
    }

    // 清空文件输入与别名选择
    event.target.value = '';
    const aliasSelect = document.getElementById('plugin-file-alias-input');
    if (aliasSelect) aliasSelect.value = '';
    closeModal();
}

/**
 * 打开「从本地文件安装」模态框
 */
function showInstallFromFileModal() {
    const modal = document.getElementById('install-from-file-modal');
    populateAliasOptions('plugin-file-alias-input');
    const aliasNew = document.getElementById('plugin-file-alias-input-new');
    if (aliasNew) { aliasNew.value = ''; aliasNew.style.display = 'none'; }
    const fileInput = document.getElementById('plugin-file-input-modal');
    if (fileInput) fileInput.value = '';
    if (modal) modal.style.display = 'flex';
}

/**
 * 选择本地插件文件：先校验必填别名，通过后才弹出文件选择框
 */
function pickPluginFileWithAlias() {
    const alias = resolveInstallAlias('plugin-file-alias-input', 'plugin-file-alias-input-new');
    if (!alias) {
        showToast('请选择或输入插件别名（将用作安装目录名）', 'error');
        const aliasSelect = document.getElementById('plugin-file-alias-input');
        const aliasNew = document.getElementById('plugin-file-alias-input-new');
        if (aliasNew && aliasNew.style.display !== 'none') aliasNew.focus();
        else if (aliasSelect) aliasSelect.focus();
        return;
    }
    const fileInput = document.getElementById('plugin-file-input-modal');
    if (fileInput) fileInput.click();
}

/**
 * 调整插件顺序（上移/下移），持久化到后端后刷新列表
 * @param {string} pluginName
 * @param {number} dir - -1 上移 / 1 下移
 */
async function reorderPlugin(pluginName, dir) {
    const idx = installedPlugins.findIndex((p) => p.name === pluginName);
    const target = idx + dir;
    if (idx === -1 || target < 0 || target >= installedPlugins.length) return;

    // 在内存中交换相邻两项
    const arr = installedPlugins.slice();
    [arr[idx], arr[target]] = [arr[target], arr[idx]];
    const order = arr.map((p) => p.name);

    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/reorder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order })
        });
        const result = await response.json();
        if (result.success) {
            showToast('插件顺序已更新', 'success');
            await loadPlugins();
        } else {
            showToast('操作失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('调整插件顺序失败:', error);
        showToast('调整插件顺序失败', 'error');
    }
}

/**
 * 从URL安装插件
 */
async function installPluginFromUrl() {
    const urlInput = document.getElementById('plugin-url-input');
    let url = urlInput ? urlInput.value.trim() : '';
    const displayName = resolveInstallAlias('plugin-name-input', 'plugin-name-input-new');

    // 清理URL中的特殊字符（如反引号）
    url = url.replace(/[`'"]/g, '');

    console.log('[INFO] [] [Plugin] Install from URL:', { url, displayName });

    if (!url) {
        showToast('请输入插件URL', 'error');
        return;
    }

    if (!displayName) {
        showToast('请选择或输入插件别名（将用作安装目录名）', 'error');
        return;
    }
    
    if (!url.endsWith('.js')) {
        showToast('URL必须以 .js 结尾', 'error');
        return;
    }

    showToast('正在安装插件...');

    try {
        console.log('[Plugin] Install from URL:', { url, displayName });
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/install-from-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, displayName })
        });

        const result = await response.json();

        if (result.success) {
            showToast('插件安装成功', 'success');
            loadPlugins('settings-plugin-table-container');
            // 重新加载插件支持列表
            loadTopListPlugins();
            loadRecommendPlugins();
        } else {
            showToast('安装失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('安装插件失败:', error);
        showToast('安装失败: ' + error.message, 'error');
    }

    // 清空输入
    if (urlInput) urlInput.value = '';
    const aliasSelect = document.getElementById('plugin-name-input');
    if (aliasSelect) aliasSelect.value = '';
    closeModal();
}

/**
 * 卸载插件
 * @param {string} pluginName
 */
async function uninstallPlugin(pluginName) {
    const confirmed = await Notification.confirm(`确定要卸载插件 "${pluginName}" 吗？`);
    if (!confirmed) {
        return;
    }

    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/${encodeURIComponent(pluginName)}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (result.success) {
            showToast('插件已卸载', 'success');
            loadPlugins();
            // 重新加载插件支持列表
            loadTopListPlugins();
            loadRecommendPlugins();
        } else {
            showToast('卸载失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('卸载插件失败:', error);
        showToast('卸载失败: ' + error.message, 'error');
    }
}

/**
 * 更新插件
 * @param {string} pluginName
 */
async function updatePlugin(pluginName) {
    showToast('正在检查更新...');
    
    const updateUrl = `${API_BASE}/api/plugins/${encodeURIComponent(pluginName)}/update`;
    console.log('[Update Plugin] URL:', updateUrl);

    try {
        const response = await fetch(updateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        console.log('[Update Plugin] Response status:', response.status);
        
        const text = await response.text();
        console.log('[Update Plugin] Response text:', text.substring(0, 200));
        
        let result;
        try {
            result = JSON.parse(text);
        } catch (e) {
            console.error('[ERROR] [] Failed to parse JSON:', e);
            throw new Error('服务器返回格式错误');
        }

        if (result.success) {
            showToast('插件更新成功', 'success');
            loadPlugins();
        } else {
            showToast('更新失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('更新插件失败:', error);
        showToast('更新失败: ' + error.message, 'error');
    }
}

/**
 * 打开订阅设置
 */
function openSubscribeSettings() {
    // 切换到订阅设置标签页
    switchSettingsTab('subscribe');
}


/**
 * 从插件导入单曲
 * @param {string} pluginName
 */
async function importMusicItemFromPlugin(pluginName) {
    const url = await Notification.prompt(`请输入要导入的单曲URL（${pluginName}）：`);
    if (!url) return;

    showToast(`正在从 ${pluginName} 导入单曲...`, 'info');

    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/${encodeURIComponent(pluginName)}/import-music-item`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        const result = await response.json();

        if (result.success) {
            showToast('单曲导入成功', 'success');
            console.log('[Import Music Item]', result.data);
        } else {
            showToast('导入失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('导入单曲失败:', error);
        showToast('导入失败: ' + error.message, 'error');
    }
}

async function importPlaylistFromPlugin(pluginName) {
    const url = await Notification.prompt(`请输入要导入的歌单URL（${pluginName}）：`);
    if (!url) return;

    showToast(`正在从 ${pluginName} 导入歌单...`, 'info');

    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/${encodeURIComponent(pluginName)}/import-music-sheet`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        const result = await response.json();

        if (result.success) {
            const { title, added, total } = result.data || {};
            showToast(`歌单「${title || '未知'}」导入成功，已加入「我的歌单」（${added || 0}/${total || 0} 首）`, 'success');
            console.log('[Import Music Sheet]', result.data);
            // 立即刷新「我的歌单」，让新导入的歌单可见
            if (typeof window.loadMyPlaylists === 'function') {
                try { await window.loadMyPlaylists(); } catch (e) { /* 忽略刷新失败 */ }
            }
        } else {
            showToast('导入失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('导入歌单失败:', error);
        showToast('导入失败: ' + error.message, 'error');
    }
}

/**
 * 显示输入弹窗
 * @param {string} title - 弹窗标题
 * @param {string} value - 默认值
 * @returns {Promise<string|null>} - 返回输入值或null（取消）
 */
function showInputModal(title, value = '') {
    return new Promise((resolve) => {
        const modal = document.getElementById('input-modal');
        const titleEl = document.getElementById('input-modal-title');
        const inputEl = document.getElementById('input-modal-field');

        if (!modal || !titleEl || !inputEl) {
            resolve(null);
            return;
        }

        titleEl.textContent = title;
        inputEl.value = value || '';

        // 保存回调函数
        window.inputModalResolve = resolve;

        modal.style.display = 'flex';
        inputEl.focus();
        inputEl.select();
    });
}

/**
 * 关闭输入弹窗
 */
function closeInputModal() {
    const modal = document.getElementById('input-modal');
    if (modal) {
        modal.style.display = 'none';
    }
    if (window.inputModalResolve) {
        window.inputModalResolve(null);
        window.inputModalResolve = null;
    }
}

/**
 * 确认输入弹窗
 */
function confirmInputModal() {
    const inputEl = document.getElementById('input-modal-field');
    const value = inputEl ? inputEl.value : '';

    const modal = document.getElementById('input-modal');
    if (modal) {
        modal.style.display = 'none';
    }

    if (window.inputModalResolve) {
        window.inputModalResolve(value);
        window.inputModalResolve = null;
    }
}

/**
 * 编辑插件配置
 * @param {string} pluginName
 * @param {string} field - 'displayName'(别名), 'url'(地址), 或 'remark'(备注)
 * @param {string} currentVal - 当前值
 */
async function editPluginConfig(pluginName, field, currentVal) {
    const fieldLabels = {
        'displayName': '别名',
        'url': '地址'
    };
    const fieldLabel = fieldLabels[field] || field;

    // 使用自定义弹窗
    const currentValue = await showInputModal(`请输入${fieldLabel}（${pluginName}）：`, currentVal || '');

    // 用户取消
    if (currentValue === null) return;

    showToast(`正在保存${fieldLabel}...`, 'info');

    try {
        const body = {};
        body[field] = currentValue.trim();

        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/${encodeURIComponent(pluginName)}/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const result = await response.json();

        if (result.success) {
            showToast(`${fieldLabel}保存成功`, 'success');
            loadPlugins(); // 刷新列表
        } else {
            showToast('保存失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('保存配置失败:', error);
        showToast('保存失败: ' + error.message, 'error');
    }
}

/**
 * 显示插件用户变量设置弹窗
 * @param {string} pluginName
 */
function showUserVars(pluginName) {
    const plugin = installedPlugins.find((p) => p.name === pluginName);
    if (!plugin) {
        showToast('插件不存在', 'error');
        return;
    }
    const variables = plugin.userVariables;
    if (!Array.isArray(variables) || variables.length === 0) {
        showToast('该插件没有可配置的用户变量', 'info');
        return;
    }

    const saved = (plugin.config && plugin.config.userVars) || {};
    const titleEl = document.getElementById('plugin-user-vars-title');
    const bodyEl = document.getElementById('plugin-user-vars-body');
    const modal = document.getElementById('plugin-user-vars-modal');

    if (!modal || !titleEl || !bodyEl) {
        showToast('用户变量弹窗未找到', 'error');
        return;
    }

    titleEl.textContent = `用户变量 · ${plugin.platform || plugin.groupName || plugin.name}`;
    window._currentUserVarsPlugin = pluginName;

    let html = '';
    variables.forEach((v, idx) => {
        const key = v.key || `var_${idx}`;
        // 兼容两种定义：name（MusicFree 规范）与 title（部分插件使用）
        const label = escapeHtml(v.name || v.title || key);
        const hint = escapeHtml(v.hint || v.description || '');
        const value = escapeHtml(saved[key] || '');
        const inputId = `plugin-user-var-${idx}`;
        html += `
            <div class="form-group" style="margin-bottom: 18px;">
                <label class="form-label" for="${inputId}" style="display: block; margin-bottom: 6px; color: var(--text-primary); font-size: 14px; font-weight: 500;">${label}</label>
                ${hint ? `<div style="margin-bottom: 8px; color: var(--text-secondary); font-size: 12px; line-height: 1.5;">${hint}</div>` : ''}
                <textarea class="form-input plugin-user-var-field" data-key="${key}" id="${inputId}" placeholder="可选，留空使用默认值" style="width: 100%; min-height: 60px; padding: 10px 12px; background: var(--bg-primary); border: 1px solid var(--divider-color); border-radius: 8px; color: var(--text-primary); font-size: 14px; outline: none; resize: vertical;">${value}</textarea>
            </div>
        `;
    });
    bodyEl.innerHTML = html;
    modal.style.display = 'flex';
}

/**
 * 保存插件用户变量
 */
async function saveUserVars() {
    const pluginName = window._currentUserVarsPlugin;
    if (!pluginName) return;

    const modal = document.getElementById('plugin-user-vars-modal');
    if (!modal) return;
    const fields = modal.querySelectorAll('.plugin-user-var-field');
    const userVars = {};
    fields.forEach((field) => {
        const key = field.dataset.key;
        if (key) {
            userVars[key] = field.value;
        }
    });

    showToast('正在保存用户变量...', 'info');
    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/${encodeURIComponent(pluginName)}/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: { userVars } })
        });
        const result = await response.json();
        if (result.success) {
            showToast('用户变量已保存', 'success');
            closeUserVarsModal();
            loadPlugins();
        } else {
            showToast('保存失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('保存用户变量失败:', error);
        showToast('保存失败: ' + error.message, 'error');
    }
}

/**
 * 关闭用户变量弹窗
 */
function closeUserVarsModal() {
    const modal = document.getElementById('plugin-user-vars-modal');
    if (modal) modal.style.display = 'none';
    window._currentUserVarsPlugin = null;
}

/**
 * 切换插件「工具插件」标记（config.utility）：
 * 标记后后端 getSupportedPlugins 会跳过该插件，不再作为音源出现在排行榜/热门歌单等列表；
 * 插件本身保持启用，歌词/封面选择器等辅助用途不受影响。
 */
async function togglePluginUtility(pluginName) {
    const plugin = installedPlugins.find((p) => p.name === pluginName);
    if (!plugin) {
        showToast('插件不存在', 'error');
        return;
    }
    const next = !(plugin.config && plugin.config.utility === true);
    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/${encodeURIComponent(pluginName)}/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: { utility: next } })
        });
        const result = await response.json();
        if (result.success) {
            showToast(next ? '已设为工具插件，不再作为音源展示' : '已恢复为音源', 'success');
            loadPlugins();
        } else {
            showToast('保存失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('保存失败: ' + error.message, 'error');
    }
}
window.togglePluginUtility = togglePluginUtility;

// ==================== 插件定时更新功能 ====================

/**
 * 加载定时更新配置
 */
async function loadPluginAutoUpdateConfig() {
    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/auto-update/config`);
        const result = await response.json();

        if (result.success) {
            const config = result.data;
            console.log('[INFO] [] Config loaded:', config);

            const enabledCheckbox = document.getElementById('plugin-auto-update-enabled');
            const cronInput = document.getElementById('plugin-auto-update-cron');
            const infoSpan = document.getElementById('plugin-auto-update-info');

            if (enabledCheckbox) {
                enabledCheckbox.checked = config.enabled === 1 || config.enabled === true;
            }
            if (cronInput) {
                cronInput.value = config.cronExpression || '0 0 * * *';
            }

            // 在开关前显示状态信息
            if (infoSpan) {
                let infoText = '';

                // 上次更新时间
                if (config.lastUpdateTime) {
                    const lastDate = new Date(config.lastUpdateTime);
                    const dateStr = lastDate.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                    infoText += `上次: ${dateStr}`;

                    // 更新统计
                    const total = config.lastUpdateTotal || 0;
                    const success = config.lastUpdateSuccess || 0;
                    const failed = config.lastUpdateFailed || 0;

                    if (total > 0) {
                        infoText += ` (${success}成功`;
                        if (failed > 0) {
                            infoText += ` ${failed}失败`;
                        }
                        infoText += `)`;
                    }
                } else {
                    infoText += '上次: --';
                }

                // 下次更新时间
                if (config.enabled && config.nextUpdateTime) {
                    const nextDate = new Date(config.nextUpdateTime);
                    const dateStr = nextDate.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                    infoText += `                    下次: ${dateStr}`;
                } else {
                    infoText += '                    下次: --';
                }

                infoSpan.textContent = infoText;
                console.log('[INFO] [] Info text:', infoText);
            } else {
                console.warn('[WARN] [] [] Info span not found');
            }
        }
    } catch (error) {
        console.error('加载定时更新配置失败:', error);
    }
}

/**
 * 切换定时更新开关
 */
function togglePluginAutoUpdate() {
    const enabledCheckbox = document.getElementById('plugin-auto-update-enabled');
    const cronInput = document.getElementById('plugin-auto-update-cron');

    if (enabledCheckbox && enabledCheckbox.checked) {
        // 启用时，如果 cron 为空，设置默认值
        if (cronInput && !cronInput.value.trim()) {
            cronInput.value = '0 0 * * *';
        }
    }
}

/**
 * 保存定时更新配置
 */
async function savePluginAutoUpdateConfig() {
    const enabledCheckbox = document.getElementById('plugin-auto-update-enabled');
    const cronInput = document.getElementById('plugin-auto-update-cron');

    const enabled = enabledCheckbox ? enabledCheckbox.checked : false;
    const cronExpression = cronInput ? cronInput.value.trim() : '0 0 * * *';

    // 验证 cron 表达式格式（简单验证）
    if (enabled && cronExpression) {
        const cronParts = cronExpression.split(' ');
        if (cronParts.length !== 5) {
            showToast('Cron 表达式格式错误，需要5个字段（分/时/日/月/周）', 'error');
            return;
        }
    }

    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/auto-update/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, cronExpression })
        });

        const result = await response.json();

        if (result.success) {
            showToast(`定时更新${enabled ? '启用' : '禁用'}`, 'success');
            loadPluginAutoUpdateConfig(); // 刷新状态
        } else {
            showToast('保存失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('保存定时更新配置失败:', error);
        showToast('保存失败: ' + error.message, 'error');
    }
}

/**
 * 手动触发定时更新
 */
async function triggerPluginAutoUpdate() {
    const confirmed = await Notification.confirm('确定要立即执行插件更新吗？');
    if (!confirmed) {
        return;
    }

    showToast('正在执行插件更新...', 'info');

    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/auto-update/trigger`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const result = await response.json();

        if (result.success) {
            const { success, failed, skipped } = result.data;
            showToast(`更新完成：${success.length}个成功，${failed.length}个失败，${skipped.length}个跳过`, 'success');
            loadPluginAutoUpdateConfig(); // 刷新最后更新时间
            loadPlugins(); // 刷新插件列表
        } else {
            showToast('更新失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('触发定时更新失败:', error);
        showToast('更新失败: ' + error.message, 'error');
    }
}



// ============ 同类型「+」入口已于插件安装改造时移除，相关函数一并清理 ============

// ==================== 卡片拖拽排序（同音源内） ====================

let _dragPluginName = null;
let _dragPlatform = null;

function onPluginCardDragStart(e) {
    const card = e.currentTarget;
    _dragPluginName = card.dataset.pluginName;
    _dragPlatform = card.dataset.platform;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', _dragPluginName); } catch { /* 部分浏览器限制 */ }
    card.style.opacity = '0.4';
}

function onPluginCardDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

function onPluginCardDragEnd(e) {
    e.currentTarget.style.opacity = '';
}

async function onPluginCardDrop(e) {
    e.preventDefault();
    const card = e.currentTarget;
    card.style.opacity = '';
    const targetName = card.dataset.pluginName;
    const draggingName = _dragPluginName;
    const draggingPlatform = _dragPlatform;
    _dragPluginName = null;
    _dragPlatform = null;
    if (!draggingName || !targetName || draggingName === targetName) return;
    // 仅允许同音源内排序
    if (draggingPlatform && card.dataset.platform && draggingPlatform !== card.dataset.platform) {
        showToast('只能在同音源内拖动排序', 'error');
        return;
    }
    await movePluginInOrder(draggingName, targetName);
}

/**
 * 在全局插件顺序中把 draggingName 移动到 targetName 之前/之后（仅限同音源），并持久化
 * @param {string} draggingName
 * @param {string} targetName
 */
async function movePluginInOrder(draggingName, targetName) {
    const arr = installedPlugins.slice();
    const from = arr.findIndex((p) => p.name === draggingName);
    const to = arr.findIndex((p) => p.name === targetName);
    if (from === -1 || to === -1) return;
    if ((arr[from].groupName || arr[from].platform) !== (arr[to].groupName || arr[to].platform)) {
        showToast('只能在同音源内拖动排序', 'error');
        return;
    }
    const [item] = arr.splice(from, 1);
    arr.splice(to, 0, item);
    const order = arr.map((p) => p.name);

    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/reorder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order })
        });
        const result = await response.json();
        if (result.success) {
            showToast('顺序已更新', 'success');
            await loadPlugins();
        } else {
            showToast('操作失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('拖动排序失败:', error);
        showToast('拖动排序失败', 'error');
    }
}

/**
 * 点击 ↑/↓ 箭头，在当前音源组内将插件上移/下移一格，并持久化
 * @param {string} name 插件名（文件名）
 * @param {'up'|'down'} dir 方向
 */
async function movePluginStep(name, dir) {
    const arr = installedPlugins.slice();
    const idx = arr.findIndex((p) => p.name === name);
    if (idx === -1) return;
    const group = arr[idx].groupName || arr[idx].platform;
    // 在当前音源组内寻找相邻（上/下）的插件
    let neighbor = -1;
    if (dir === 'up') {
        for (let i = idx - 1; i >= 0; i--) {
            if ((arr[i].groupName || arr[i].platform) === group) { neighbor = i; break; }
        }
    } else {
        for (let i = idx + 1; i < arr.length; i++) {
            if ((arr[i].groupName || arr[i].platform) === group) { neighbor = i; break; }
        }
    }
    if (neighbor === -1) return; // 已在组内最顶/最底
    const [item] = arr.splice(idx, 1);
    arr.splice(neighbor, 0, item);
    const order = arr.map((p) => p.name);

    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/reorder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order })
        });
        const result = await response.json();
        if (result.success) {
            await loadPlugins();
        } else {
            showToast('操作失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('移动排序失败:', error);
        showToast('移动排序失败', 'error');
    }
}

// ==================== 音源卡片（组）排序：同时决定排行榜/热门歌单标签顺序 ====================

/** 与渲染一致的音源分组 key（groupName 优先，回退 platform，trim + NFC 规范化） */
function pluginGroupKeyOf(p) {
    return (p.groupName || p.platform || '未知音源').toString().trim().normalize('NFC');
}

/** 按全局插件顺序构建组块列表：[{ key, items }]，组顺序 = 各组在全局顺序中首次出现的位置 */
function buildGroupBlocks() {
    const blocks = [];
    const index = new Map();
    installedPlugins.forEach((p) => {
        const k = pluginGroupKeyOf(p);
        if (!index.has(k)) {
            index.set(k, blocks.length);
            blocks.push({ key: k, items: [] });
        }
        blocks[index.get(k)].items.push(p);
    });
    return blocks;
}

/** 持久化插件顺序到后端（组排序 = 整组插件在后端全局顺序中整体移动） */
async function persistPluginOrder(arr, tip) {
    const order = arr.map((p) => p.name);
    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/reorder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order })
        });
        const result = await response.json();
        if (result.success) {
            if (tip) showToast(tip, 'success');
            await loadPlugins();
            return true;
        }
        showToast('操作失败: ' + (result.error || '未知错误'), 'error');
    } catch (error) {
        console.error('保存音源排序失败:', error);
        showToast('保存音源排序失败', 'error');
    }
    return false;
}

/**
 * 音源卡片上移/下移一格（与相邻组整块交换位置），并持久化到后端
 * @param {string} groupKey 音源分组 key
 * @param {'up'|'down'} dir 方向
 */
async function movePluginGroupStep(groupKey, dir) {
    const blocks = buildGroupBlocks();
    const bi = blocks.findIndex((b) => b.key === groupKey);
    const bj = dir === 'up' ? bi - 1 : bi + 1;
    if (bi === -1 || bj < 0 || bj >= blocks.length) return;
    [blocks[bi], blocks[bj]] = [blocks[bj], blocks[bi]];
    await persistPluginOrder(blocks.flatMap((b) => b.items));
}

/**
 * 拖拽音源卡片到目标卡片位置（整组移动），并持久化到后端
 * @param {string} dragGroupKey 拖拽的组 key
 * @param {string} targetGroupKey 放置目标组 key
 */
async function movePluginGroupTo(dragGroupKey, targetGroupKey) {
    if (!dragGroupKey || !targetGroupKey || dragGroupKey === targetGroupKey) return;
    const blocks = buildGroupBlocks();
    const from = blocks.findIndex((b) => b.key === dragGroupKey);
    let to = blocks.findIndex((b) => b.key === targetGroupKey);
    if (from === -1 || to === -1) return;
    const [block] = blocks.splice(from, 1);
    // 移除自身后重新定位插入点
    to = blocks.findIndex((b) => b.key === targetGroupKey);
    blocks.splice(to, 0, block);
    await persistPluginOrder(blocks.flatMap((b) => b.items), '音源顺序已更新');
}

// 事件委托：组排序按钮（避免组名内联传参的引号问题）
document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-group-action="move"]');
    if (!btn || btn.disabled) return;
    movePluginGroupStep(btn.dataset.groupKey, btn.dataset.dir);
});

// 事件委托：音源卡片拖拽排序（桌面端；移动端用上移/下移按钮）
let _dragGroupKey = null;

document.addEventListener('dragstart', (e) => {
    const group = e.target.closest && e.target.closest('.plugin-source-group');
    if (!group) return;
    _dragGroupKey = group.dataset.groupKey;
    group.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', _dragGroupKey); } catch { /* 部分浏览器限制 */ }
});

document.addEventListener('dragover', (e) => {
    if (!_dragGroupKey) return;
    const group = e.target.closest && e.target.closest('.plugin-source-group');
    if (group) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    }
});

document.addEventListener('drop', (e) => {
    if (!_dragGroupKey) return;
    const group = e.target.closest && e.target.closest('.plugin-source-group');
    if (!group) return;
    e.preventDefault();
    const dragKey = _dragGroupKey;
    _dragGroupKey = null;
    movePluginGroupTo(dragKey, group.dataset.groupKey);
});

document.addEventListener('dragend', (e) => {
    const group = e.target.closest && e.target.closest('.plugin-source-group');
    if (group) group.classList.remove('dragging');
    _dragGroupKey = null;
});

// 导出函数到全局作用域
window.loadPlugins = loadPlugins;
window.renderPlugins = renderPlugins;
window.renderSettingsPlugins = renderSettingsPlugins;
window.showInstallFromUrlModal = showInstallFromUrlModal;
window.showInstallFromFileModal = showInstallFromFileModal;
window.pickPluginFileWithAlias = pickPluginFileWithAlias;
window.reorderPlugin = reorderPlugin;
window.closeModal = closeModal;
window.showInputModal = showInputModal;
window.closeInputModal = closeInputModal;
window.confirmInputModal = confirmInputModal;
window.installPluginFromFile = installPluginFromFile;
window.installPluginFromUrl = installPluginFromUrl;
window.uninstallPlugin = uninstallPlugin;
window.updatePlugin = updatePlugin;
window.togglePlugin = togglePlugin;
window.updateAllPlugins = updateAllPlugins;
window.openSubscribeSettings = openSubscribeSettings;
window.importMusicItemFromPlugin = importMusicItemFromPlugin;
window.importPlaylistFromPlugin = importPlaylistFromPlugin;
window.editPluginConfig = editPluginConfig;
window.showUserVars = showUserVars;
window.saveUserVars = saveUserVars;
window.closeUserVarsModal = closeUserVarsModal;
// 插件定时更新函数
window.loadPluginAutoUpdateConfig = loadPluginAutoUpdateConfig;
window.togglePluginAutoUpdate = togglePluginAutoUpdate;
window.savePluginAutoUpdateConfig = savePluginAutoUpdateConfig;
window.triggerPluginAutoUpdate = triggerPluginAutoUpdate;
window.onPluginCardDragStart = onPluginCardDragStart;
window.onPluginCardDragOver = onPluginCardDragOver;
window.onPluginCardDrop = onPluginCardDrop;
window.onPluginCardDragEnd = onPluginCardDragEnd;
window.movePluginInOrder = movePluginInOrder;
window.movePluginStep = movePluginStep;
window.movePluginGroupStep = movePluginGroupStep;
window.movePluginGroupTo = movePluginGroupTo;
