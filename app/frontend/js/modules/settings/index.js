/**
 * 系统设置模块
 * 功能：本地存储设置、界面设置等
 */

// ==================== 系统设置 ====================

/**
 * 加载设置
 */
function loadSettings() {
    // 加载其他设置
    loadOtherSettings();

    // 如果是管理员，显示用户管理并加载用户列表
    if (window.Auth && window.Auth.isAdmin()) {
        const userManagementSection = document.getElementById('user-management-section');
        if (userManagementSection) {
            userManagementSection.style.display = 'block';
        }
        loadUserList();
    }
}

/**
 * 保存设置
 */
async function saveSettings() {
    showToast('配置保存成功', 'success');
}

/**
 * 加载其他设置
 */
async function loadOtherSettings() {
    // 从后端加载设置
    let serverSettings = {};
    try {
        const response = await fetch(`${API_BASE}/api/settings`);
        const result = await response.json();
        if (result.success && result.data) {
            serverSettings = result.data;
            // 同步到本地存储（只有当本地没有设置时才同步，保护用户本地选择）
            if (serverSettings.theme && !localStorage.getItem('theme')) localStorage.setItem('theme', serverSettings.theme);
            if (serverSettings.primaryColor && !localStorage.getItem('primary_color')) localStorage.setItem('primary_color', serverSettings.primaryColor);
            if (serverSettings.audioQuality && !localStorage.getItem('audio_quality')) localStorage.setItem('audio_quality', serverSettings.audioQuality);
            if (serverSettings.downloadPath !== undefined && localStorage.getItem('download_path') === null) localStorage.setItem('download_path', serverSettings.downloadPath);
            if (serverSettings.wecomUrl !== undefined && localStorage.getItem('wecom_url') === null) localStorage.setItem('wecom_url', serverSettings.wecomUrl);
            if (serverSettings.notificationEnabled !== undefined && localStorage.getItem('notification_enabled') === null) localStorage.setItem('notification_enabled', serverSettings.notificationEnabled);
        }
    } catch (error) {
        // 忽略错误
    }

    // 主题设置（优先使用本地存储的设置，保持用户选择）
    const theme = localStorage.getItem('theme') || serverSettings.theme || 'dark';
    const themeSelect = document.getElementById('setting-theme');
    if (themeSelect) {
        themeSelect.value = theme;
    }
    // 确保主题被应用
    applyTheme(theme);

    // 主题色设置（优先使用本地存储的设置，保持用户选择）
    const primaryColor = localStorage.getItem('primary_color') || serverSettings.primaryColor || 'green';
    const primaryColorSelect = document.getElementById('setting-primary-color');
    if (primaryColorSelect) {
        primaryColorSelect.value = primaryColor;
    }
    applyPrimaryColor(primaryColor);

    // 音质设置
    const quality = serverSettings.audioQuality || localStorage.getItem('audio_quality') || 'standard';
    const qualitySelect = document.getElementById('setting-quality');
    if (qualitySelect) {
        qualitySelect.value = quality;
    }

    // 下载路径
    const downloadPath = serverSettings.downloadPath !== undefined ? serverSettings.downloadPath : (localStorage.getItem('download_path') || '');
    const downloadPathInput = document.getElementById('setting-download-path');
    if (downloadPathInput) {
        downloadPathInput.value = downloadPath;
    }

    // 企业微信通知地址
    const wecomUrl = serverSettings.wecomUrl !== undefined ? serverSettings.wecomUrl : (localStorage.getItem('wecom_url') || '');
    const wecomUrlInput = document.getElementById('setting-wecom-url');
    if (wecomUrlInput) {
        wecomUrlInput.value = wecomUrl;
    }

    // OpenSubsonic API 秘钥
    const apiKeyInput = document.getElementById('setting-api-key');
    if (apiKeyInput) {
        apiKeyInput.value = serverSettings.apiKey || '';
    }

    // 通知跳转链接
    const notificationUrl = serverSettings.notificationUrl !== undefined ? serverSettings.notificationUrl : (localStorage.getItem('notification_url') || '');
    const notificationUrlInput = document.getElementById('setting-notification-url');
    if (notificationUrlInput) {
        notificationUrlInput.value = notificationUrl;
    }

    // 通知启用状态
    const notificationEnabled = serverSettings.notificationEnabled !== undefined ? serverSettings.notificationEnabled : (localStorage.getItem('notification_enabled') === 'true');
    const notificationEnabledInput = document.getElementById('setting-notification-enabled');
    if (notificationEnabledInput) {
        notificationEnabledInput.checked = notificationEnabled;
        // 绑定事件监听器
        notificationEnabledInput.onchange = function() {
            toggleNotificationEnabled(this.checked);
        };
    }
    const statusText = document.getElementById('notification-status-text');
    if (statusText) {
        statusText.textContent = notificationEnabled ? '已启用' : '已禁用';
    }

    // 调试日志开关（默认开启，保持与后端默认日志级别一致）
    const debugLogEnabled = serverSettings.debugLogEnabled !== undefined ? serverSettings.debugLogEnabled : true;
    const debugLogInput = document.getElementById('setting-debug-log');
    if (debugLogInput) {
        debugLogInput.checked = !!debugLogEnabled;
    }

    // OpenSubsonic 直连开关（307）：打开=307 直链；关闭=服务器代理
    const streamRedirect = serverSettings.streamRedirect !== undefined ? serverSettings.streamRedirect : false;
    const streamRedirectInput = document.getElementById('setting-stream-redirect');
    if (streamRedirectInput) streamRedirectInput.checked = !!streamRedirect;

    const coverRedirect = serverSettings.coverRedirect !== undefined ? serverSettings.coverRedirect : false;
    const coverRedirectInput = document.getElementById('setting-cover-redirect');
    if (coverRedirectInput) coverRedirectInput.checked = !!coverRedirect;

    // 本地曲库优先播放（默认关闭）
    const localLibraryPriority = serverSettings.localLibraryPriority !== undefined ? serverSettings.localLibraryPriority : false;
    const localLibraryPriorityInput = document.getElementById('setting-local-library-priority');
    if (localLibraryPriorityInput) localLibraryPriorityInput.checked = !!localLibraryPriority;

    // 歌词/封面/头像搜索插件（设置→常规）：多选 + 排序选择器
    await initPluginPickers(
        serverSettings.lyricPlugins || (serverSettings.lyricPlugin ? [serverSettings.lyricPlugin] : []),
        serverSettings.coverPlugins || [],
        serverSettings.artistImagePlugins || []
    );

    // 加载下载设置
    loadDownloadSettings();

    // 【新增】加载 OpenList（strm 播放）配置
    loadOpenlistConfigSetting();

    // 【新增】加载缓存设置
    loadCacheSettings();

    // 【新增】网络歌曲数据库缓存上限（songs 表 remote__*，默认 1000 首）
    const netCacheMax = serverSettings.maxNetSongCache !== undefined ? serverSettings.maxNetSongCache : 3000;
    const netCacheInput = document.getElementById('setting-net-cache-max');
    if (netCacheInput) netCacheInput.value = netCacheMax;

    // 最近播放数据库上限（默认 100 首）
    const recentPlayMax = serverSettings.maxRecentPlay !== undefined ? serverSettings.maxRecentPlay : 100;
    const recentPlayInput = document.getElementById('setting-recent-play-max');
    if (recentPlayInput) recentPlayInput.value = recentPlayMax;
}

/**
 * 歌词/封面搜索插件选择器（多选最多3个 + 排序）
 * 歌词候选项来自「歌词」分组；封面候选项来自其它音乐源分组
 */
const pluginPickerState = { lyric: [], cover: [], artist: [] };
const pluginPickerCandidates = { lyric: [], cover: [], artist: [] };
const PLUGIN_PICKER_MAX = 3;
const PLUGIN_PICKER_KEY = { lyric: 'lyricPlugins', cover: 'coverPlugins', artist: 'artistImagePlugins' };

/** 初始化歌词/封面/头像三组选择器（含回显） */
async function initPluginPickers(savedLyric, savedCover, savedArtist) {
    let plugins = [];
    try {
        // 走共享缓存（TTL + 并发合并），不再每次进设置页都单独打一次 /api/plugins
        plugins = await window.fetchInstalledPluginsCached();
    } catch (e) {
        // 忽略：列表为空时仅提示
    }
    pluginPickerCandidates.lyric = [];
    pluginPickerCandidates.cover = [];
    pluginPickerCandidates.artist = [];
    for (const p of plugins) {
        if (!p || !p.name) continue;
        const label = p.displayName ? `${p.displayName}（${p.name}）` : p.name;
        // 歌词候选项：全部插件（普通音乐源也允许作为歌词搜索源，取词失败是插件能力问题）
        pluginPickerCandidates.lyric.push({ name: p.name, label });
        const g = String(p.groupName || p.displayName || p.platform || '').trim();
        // 封面/头像候选项：歌词分组外的音乐源插件（歌手头像与封面同源，复用同一候选集）
        if (!(g === '歌词' || g.indexOf('歌词') >= 0)) {
            pluginPickerCandidates.cover.push({ name: p.name, label });
            pluginPickerCandidates.artist.push({ name: p.name, label });
        }
    }
    const keepValid = (candidates, savedArr) => {
        const valid = [];
        const names = new Set(candidates.map((c) => c.name));
        for (const n of Array.isArray(savedArr) ? savedArr : []) {
            if (names.has(n) && valid.length < PLUGIN_PICKER_MAX) valid.push(n);
        }
        return valid;
    };
    pluginPickerState.lyric = keepValid(pluginPickerCandidates.lyric, savedLyric);
    pluginPickerState.cover = keepValid(pluginPickerCandidates.cover, savedCover);
    pluginPickerState.artist = keepValid(pluginPickerCandidates.artist, savedArtist);
    renderPluginPicker('lyric');
    renderPluginPicker('cover');
    renderPluginPicker('artist');
    populateTestPluginOptions();
}

/** 填充“插件连通性测试”的单独插件下拉 */
function populateTestPluginOptions() {
    const sel = document.getElementById('test-enrich-plugin');
    if (!sel) return;
    const seen = new Set();
    const items = [];
    for (const kind of ['lyric', 'cover', 'artist']) {
        for (const c of (pluginPickerCandidates[kind] || [])) {
            if (!c.name || seen.has(c.name)) continue;
            seen.add(c.name);
            items.push(c);
        }
    }
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '（按当前配置 / 自动）';
    sel.appendChild(auto);
    for (const it of items) {
        const o = document.createElement('option');
        o.value = it.name;
        o.textContent = it.label;
        sel.appendChild(o);
    }
}

/** 渲染某组选择器（已选队列 + 候选 chips） */
function renderPluginPicker(kind) {
    const box = document.getElementById(`plugin-picker-${kind}`);
    if (!box) return;
    const sel = pluginPickerState[kind] || [];
    const candidates = (pluginPickerCandidates[kind] || []).filter((c) => !sel.includes(c.name));
    let html = '';
    if (sel.length) {
        html += '<div class="pp-queue">';
        sel.forEach((name, i) => {
            const label = (pluginPickerCandidates[kind].find((c) => c.name === name) || {}).label || name;
            html += `
                <div class="pp-queue-row">
                    <span class="pp-order">${i + 1}</span>
                    <span class="pp-name" title="${name}">${label}</span>
                    <button type="button" class="pp-act" onclick="movePluginPicker('${kind}', ${i}, -1)" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
                    <button type="button" class="pp-act" onclick="movePluginPicker('${kind}', ${i}, 1)" ${i === sel.length - 1 ? 'disabled' : ''} title="下移">↓</button>
                    <button type="button" class="pp-act" onclick="removePluginPicker('${kind}', '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')" title="移除">✕</button>
                </div>`;
        });
        html += '</div>';
    } else {
        html += '<div class="pp-empty">未配置：不进行在线搜索（请选择要使用的插件）</div>';
    }
    html += '<div class="pp-candidates">';
    candidates.forEach((c) => {
        html += `<button type="button" class="pp-chip" onclick="addPluginPicker('${kind}', '${c.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">＋ ${c.label}</button>`;
    });
    if (!candidates.length) html += '<span class="pp-empty">（无更多可选插件）</span>';
    html += '</div>';
    box.innerHTML = html;
}

/** 添加插件到队列（最多3个） */
function addPluginPicker(kind, name) {
    const list = pluginPickerState[kind];
    if (list.length >= PLUGIN_PICKER_MAX) {
        showToast(`最多选择 ${PLUGIN_PICKER_MAX} 个插件`, 'error');
        return;
    }
    if (!list.includes(name)) {
        list.push(name);
        renderPluginPicker(kind);
        savePluginPickerSetting(kind);
    }
}

/** 移除队列中的插件 */
function removePluginPicker(kind, name) {
    pluginPickerState[kind] = pluginPickerState[kind].filter((n) => n !== name);
    renderPluginPicker(kind);
    savePluginPickerSetting(kind);
}

/** 调整队列顺序（dir=-1 上移，1 下移） */
function movePluginPicker(kind, index, dir) {
    const list = pluginPickerState[kind];
    const target = index + dir;
    if (index < 0 || target < 0 || target >= list.length) return;
    const tmp = list[index];
    list[index] = list[target];
    list[target] = tmp;
    renderPluginPicker(kind);
    savePluginPickerSetting(kind);
}

/** 保存当前队列到后端（歌词存 lyricPlugins，封面存 coverPlugins） */
async function savePluginPickerSetting(kind) {
    const body = {};
    body[PLUGIN_PICKER_KEY[kind]] = pluginPickerState[kind].slice();
    try {
        const res = await Auth.authenticatedFetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const json = await res.json();
        if (json.success) {
            const desc = kind === 'lyric' ? '歌词' : (kind === 'cover' ? '封面' : '歌手头像');
            const n = pluginPickerState[kind].length;
            showToast(n ? `${desc}搜索插件已保存（${n} 个，按所选顺序）` : `${desc}搜索已设为自动`, 'success');
        } else {
            showToast('保存失败: ' + (json.error || '未知错误'), 'error');
        }
    } catch (e) {
        showToast('保存失败: ' + (e.message || '网络错误'), 'error');
    }
}

/**
 * 插件连通性测试（设置→歌词封面）
 * @param {string} kind - 'lyric' 或 'cover'
 */
async function testEnrichPlugin(kind) {
    const title = (document.getElementById('test-enrich-title') || {}).value || '';
    const artist = (document.getElementById('test-enrich-artist') || {}).value || '';
    const pluginSel = document.getElementById('test-enrich-plugin');
    const plugin = pluginSel ? String(pluginSel.value || '').trim() : '';
    const t = String(title).trim();
    // 测试歌手封面：只需填歌手（歌名可为空）；其余测试仍需歌名
    if (kind === 'artist') {
        if (!String(artist).trim()) {
            showToast('请输入歌手', 'error');
            return;
        }
    } else if (!t) {
        showToast('请输入歌名', 'error');
        return;
    }
    const box = document.getElementById('test-enrich-result');
    if (!box) return;
    box.style.display = 'block';
    // 测试封面取「封面 / 专辑图」；测试歌手封面只取「歌手头像」
    const loadingTarget = kind === 'lyric' ? '歌词' : (kind === 'artist' ? '歌手头像' : '封面 / 专辑图');
    box.innerHTML = '<div style="color: var(--text-secondary);">正在用' + (plugin || '当前配置的插件') + '检索' + loadingTarget + '（' + t + (artist ? ' - ' + String(artist).trim() : '') + '，需一点时间）…</div>';

    try {
        const res = await Auth.authenticatedFetch(`${API_BASE}/api/music/test-enrich`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: t, artist: String(artist).trim(), kind, plugin })
        });
        const json = await res.json();
        if (!json.success) {
            box.innerHTML = `<div style="color: #ef4444;">测试失败：${String(json.error || '未知错误').replace(/</g, '&lt;')}</div>`;
            return;
        }
        // 用 DOM 节点组装，避免注入
        box.textContent = '';
        const wrap = document.createElement('div');
        const m = json.matched;
        const query = json.query || {};
        const statusLine = document.createElement('div');
        statusLine.style.cssText = 'font-size:13px; margin-bottom:6px;';
        const target = kind === 'lyric' ? '歌词' : (kind === 'artist' ? '歌手头像' : '封面 / 专辑图');
        const usedPlugin = json.pluginUsed || plugin || '（按当前配置/自动）';
        statusLine.textContent = `测试${target}（${query.title || ''}${query.artist ? ' - ' + query.artist : ''}）｜ 插件：${usedPlugin}`;
        wrap.appendChild(statusLine);

        const matchedLine = document.createElement('div');
        matchedLine.style.cssText = 'font-size:13px; margin-bottom:6px; color: var(--text-secondary);';
        matchedLine.textContent = m
            ? `匹配到：${m.title || ''}${m.artist ? ' / ' + m.artist : ''}${m.album ? '（' + m.album + '）' : ''}`
            : '未匹配到对应歌曲';
        wrap.appendChild(matchedLine);

        // 渲染一张图片块（返回容器，便于并排布局）：有则显示，无则显示「无」
        function buildImageBlock(label, coverUrl) {
            const col = document.createElement('div');
            col.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:4px; min-width:140px;';
            const line = document.createElement('div');
            line.style.cssText = 'font-size:13px; font-weight:600;';
            line.textContent = label;
            col.appendChild(line);
            if (coverUrl) {
                const img = document.createElement('img');
                img.src = coverUrl;
                img.style.cssText = 'width:140px;height:140px;object-fit:cover;border-radius:8px;border:1px solid var(--divider-color);';
                img.onerror = () => { img.style.display = 'none'; const no = document.createElement('div'); no.style.cssText = 'font-size:12px;color:#f59e0b;'; no.textContent = '（图片加载失败）'; col.appendChild(no); };
                col.appendChild(img);
            } else {
                const none = document.createElement('div');
                none.style.cssText = 'font-size:12px; color:#f59e0b; margin-top:60px;';
                none.textContent = '无';
                col.appendChild(none);
            }
            return col;
        }

        if (kind === 'cover') {
            // 专辑名作为独立信息行显示在上方，不参与图片并排布局
            if (json.album) {
                const albumName = document.createElement('div');
                albumName.style.cssText = 'width:100%; font-size:12px; margin-bottom:6px; color: var(--text-secondary);';
                albumName.textContent = '专辑：' + json.album;
                wrap.appendChild(albumName);
            }
            // 封面、专辑图并排显示（用 grid 保证两图必定同一行）
            const row = document.createElement('div');
            row.style.cssText = 'display:grid; grid-template-columns: repeat(2, max-content); gap:24px; margin-top:6px; justify-content: start;';
            // 封面：按 歌名+歌手 搜索的结果
            row.appendChild(buildImageBlock('封面', json.cover || null));
            // 专辑图：自动算出专辑名后按 专辑名+歌手 搜索的结果（无专辑或搜不到显示「无」）
            row.appendChild(buildImageBlock('专辑图', json.albumArt || null));
            wrap.appendChild(row);
        } else if (kind === 'artist') {
            // 歌手头像单独展示（用 grid 居中，仅一列）
            const row = document.createElement('div');
            row.style.cssText = 'display:grid; grid-template-columns: max-content; gap:24px; margin-top:6px; justify-content: start;';
            row.appendChild(buildImageBlock('歌手头像', json.artistArt || null));
            wrap.appendChild(row);
        } else {
            const lyricLine = document.createElement('div');
            lyricLine.style.cssText = 'font-size:13px; margin-bottom:6px;';
            if (json.hasLyrics && json.rawLrc) {
                lyricLine.textContent = '歌词获取成功，共 ' + json.rawLrc.length + ' 字符';
                wrap.appendChild(lyricLine);
                const pre = document.createElement('pre');
                pre.textContent = json.rawLrc;
                pre.style.cssText = 'max-height:260px;overflow:auto;background:var(--bg-tertiary);padding:10px 12px;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;';
                wrap.appendChild(pre);
            } else {
                lyricLine.style.color = '#f59e0b';
                lyricLine.textContent = '未取到歌词（所选插件均无该歌词收录，或取词接口无返回）';
                wrap.appendChild(lyricLine);
            }
        }
        box.appendChild(wrap);
    } catch (e) {
        box.innerHTML = `<div style="color:#ef4444;">测试出错：${String(e.message || e).replace(/</g, '&lt;')}</div>`;
    }
}

/** 清空测试结果 */
function clearTestEnrich() {
    const box = document.getElementById('test-enrich-result');
    if (box) { box.style.display = 'none'; box.textContent = ''; }
    ['test-enrich-title', 'test-enrich-artist'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

/**
 * 手动触发曲库缺图补全（设置→歌词封面→缺失图片一键补全）
 * @param {string} type - 'cover' 歌曲封面 | 'artist' 歌手头像 | 'album' 专辑封面
 */
async function fillMissingImages(type) {
    const labelMap = { cover: '歌曲封面', artist: '歌手头像', album: '专辑封面' };
    const label = labelMap[type];
    if (!label) return;
    const tip = document.getElementById('fill-images-tip');
    if (tip) tip.textContent = '';
    try {
        const res = await Auth.authenticatedFetch(`${API_BASE}/api/music/fill-images`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type })
        });
        const json = await res.json();
        if (json && json.success) {
            if (json.busy) {
                showToast(`${label}补全未启动：${json.message || '已有扫描/补全任务进行中'}`, 'warning');
                if (tip) tip.textContent = '已有任务在跑，进度见顶栏右上角圆圈，可点击圆圈停止后再试';
            } else {
                showToast(`${label}补全已启动，后台执行中`, 'success');
                if (tip) {
                    tip.textContent = json.enqueued != null
                        ? `已将 ${json.enqueued} 位缺头像的歌手加入后台队列，逐个下载中`
                        : '后台进行中，进度见顶栏右上角圆圈（点击圆圈可查看详情 / 停止）';
                }
            }
        } else {
            showToast('启动失败: ' + ((json && json.error) || '未知错误'), 'error');
        }
    } catch (e) {
        showToast(`${label}补全启动失败: ` + (e.message || '网络错误'), 'error');
    }
}

/**
 * 手动触发元数据补全（设置→歌词封面→手动元数据补全）
 * 自动扫描阶段「核心字段完整就跳过插件」，个别异常歌曲由用户在这里手动修正。
 * @param {boolean} overwrite - false=只补缺失字段；true=允许插件覆盖已有元数据
 * @param {string[]} [ids] - 指定歌曲 id 列表（不传则处理全库中符合条件的歌曲）
 */
async function fillMissingMetadata(overwrite, ids) {
    const label = overwrite ? '覆盖修正元数据' : '补全缺失元数据';
    const tip = document.getElementById('fill-metadata-tip');
    if (tip) tip.textContent = '';
    if (overwrite && !Array.isArray(ids)) {
        const ok = window.confirm
            ? window.confirm('「覆盖修正」会用插件搜索结果重写全库歌曲的艺术家 / 专辑 / 标题（用户手动编辑过的字段除外）。确定继续？')
            : true;
        if (!ok) return;
    }
    try {
        const res = await Auth.authenticatedFetch(`${API_BASE}/api/music/fill-metadata`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ overwrite: !!overwrite, ids: Array.isArray(ids) ? ids : undefined })
        });
        const json = await res.json();
        if (json && json.success) {
            if (json.busy) {
                showToast(`${label}未启动：${json.message || '已有扫描/补全任务进行中'}`, 'warning');
                if (tip) tip.textContent = '已有任务在跑，进度见顶栏右上角圆圈，可点击圆圈停止后再试';
            } else {
                showToast(`${label}已启动，后台执行中`, 'success');
                if (tip) tip.textContent = json.message || '后台进行中，进度见顶栏右上角圆圈（点击圆圈可查看详情 / 停止）';
            }
        } else {
            showToast('启动失败: ' + ((json && json.error) || '未知错误'), 'error');
        }
    } catch (e) {
        showToast(`${label}启动失败: ` + (e.message || '网络错误'), 'error');
    }
}
/**
 * 保存主题设置
 * @param {string} theme
 */
async function saveThemeSetting(theme) {
    localStorage.setItem('theme', theme);
    applyTheme(theme);

    // 同步到后端
    try {
        await fetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ theme })
        });
    } catch (error) {
        // 忽略错误
    }

    showToast('主题设置已保存', 'success');
}

/**
 * 应用主题
 * @param {string} theme
 */
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
}

/**
 * 保存主题色设置
 * @param {string} color
 */
async function savePrimaryColorSetting(color) {
    localStorage.setItem('primary_color', color);
    applyPrimaryColor(color);

    // 同步到后端
    try {
        await fetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ primaryColor: color })
        });
    } catch (error) {
        // 忽略错误
    }

    showToast('主题色设置已保存', 'success');
}

/**
 * 应用主题色
 * @param {string} color
 */
function applyPrimaryColor(color) {
    const colorMap = {
        green: { primary: '#1db954', light: '#1ed760', dark: '#1aa34a', glow: 'rgba(29, 185, 84, 0.3)' },
        red: { primary: '#e74c3c', light: '#ff6b6b', dark: '#c0392b', glow: 'rgba(231, 76, 60, 0.3)' },
        orange: { primary: '#e67e22', light: '#ff9f43', dark: '#d35400', glow: 'rgba(230, 126, 34, 0.3)' },
        yellow: { primary: '#f1c40f', light: '#feca57', dark: '#f39c12', glow: 'rgba(241, 196, 15, 0.3)' },
        blue: { primary: '#3498db', light: '#54a0ff', dark: '#2980b9', glow: 'rgba(52, 152, 219, 0.3)' },
        purple: { primary: '#9b59b6', light: '#c56cf0', dark: '#8e44ad', glow: 'rgba(155, 89, 182, 0.3)' },
        pink: { primary: '#fd79a8', light: '#ff9ff3', dark: '#e84393', glow: 'rgba(253, 121, 168, 0.3)' },
        cyan: { primary: '#00cec9', light: '#81ecec', dark: '#00b894', glow: 'rgba(0, 206, 201, 0.3)' }
    };

    const colors = colorMap[color] || colorMap.green;
    const root = document.documentElement;

    root.style.setProperty('--primary-color', colors.primary);
    root.style.setProperty('--primary-light', colors.light);
    root.style.setProperty('--primary-dark', colors.dark);
    root.style.setProperty('--primary-glow', colors.glow);
}

/**
 * 保存音质设置
 * @param {string} quality
 */
async function saveQualitySetting(quality) {
    localStorage.setItem('audio_quality', quality);

    // 同步到后端
    try {
        await fetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioQuality: quality })
        });
    } catch (error) {
        console.error('同步音质设置失败:', error);
    }

    showToast('音质设置已保存', 'success');
}

/**
 * 生成随机 API 秘钥（48 位十六进制）
 */
function generateApiKey() {
    const bytes = new Uint8Array(24);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    const key = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const input = document.getElementById('setting-api-key');
    if (input) input.value = key;
}

/**
 * 保存 OpenSubsonic API 秘钥
 */
async function saveApiKeySetting() {
    const input = document.getElementById('setting-api-key');
    const apiKey = (input ? input.value : '').trim();
    try {
        await fetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey })
        });

        showToast('API 秘钥已保存', 'success');
    } catch (error) {
        console.error('保存 API 秘钥失败:', error);
        showToast('保存失败: ' + (error.message || '未知错误'), 'error');
    }
}

/**
 * 加载 OpenList（strm 播放）配置：内网/外网基地址
 * GET /api/openlist-config（data: { localBaseUrl, publicBaseUrl }）
 */
async function loadOpenlistConfigSetting() {
    try {
        const response = await fetch(`${API_BASE}/api/openlist-config`, { method: 'GET' });
        const result = await response.json();
        if (result.success && result.data) {
            const localInput = document.getElementById('setting-openlist-local');
            const publicInput = document.getElementById('setting-openlist-public');
            if (localInput) localInput.value = result.data.localBaseUrl || result.data.openlistLocalBaseUrl || '';
            if (publicInput) publicInput.value = result.data.publicBaseUrl || result.data.openlistPublicBaseUrl || '';
        }
    } catch (error) {
        console.error('获取 OpenList 配置失败:', error);
    }
}

/**
 * 保存 OpenList（strm 播放）配置
 * POST /api/openlist-config（body: openlistLocalBaseUrl / openlistPublicBaseUrl；后端兼容旧字段 alistLocalBaseUrl / alistPublicBaseUrl）
 */
async function saveOpenlistConfigSetting() {
    const localInput = document.getElementById('setting-openlist-local');
    const publicInput = document.getElementById('setting-openlist-public');
    const localBaseUrl = (localInput ? localInput.value : '').trim();
    const publicBaseUrl = (publicInput ? publicInput.value : '').trim();
    try {
        const response = await fetch(`${API_BASE}/api/openlist-config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ openlistLocalBaseUrl: localBaseUrl, openlistPublicBaseUrl: publicBaseUrl })
        });
        const result = await response.json();
        if (result.success) {
            showToast('OpenList 配置已保存', 'success');
        } else {
            showToast('保存失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('保存 OpenList 配置失败:', error);
        showToast('保存失败: ' + (error.message || '未知错误'), 'error');
    }
}

/**
 * 保存下载路径
 * @param {string} path
 */
async function saveDownloadPath(path) {
    localStorage.setItem('download_path', path);

    try {
        const response = await fetch(`${API_BASE}/api/settings/download-path`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });

        const result = await response.json();

        if (result.success) {
            showToast('下载路径已保存', 'success');
        } else {
            showToast('保存失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('保存下载路径失败:', error);
        showToast('保存失败: ' + error.message, 'error');
    }
}

/**
 * 导出数据
 */
async function exportData() {
    try {
        const response = await fetch(`${API_BASE}/api/export`);
        const result = await response.json();

        if (result.success && result.data) {
            // 创建下载链接
            const dataStr = JSON.stringify(result.data, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = `musichub_backup_${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showToast('数据导出成功', 'success');
        } else {
            showToast('导出失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('导出数据失败:', error);
        showToast('导出失败: ' + error.message, 'error');
    }
}

/**
 * 导入数据
 * @param {Event} event
 */
async function importData(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        const data = JSON.parse(text);

        const response = await fetch(`${API_BASE}/api/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data })
        });

        const result = await response.json();

        if (result.success) {
            showToast('数据导入成功', 'success');
            // 刷新相关页面
            loadMyPlaylists();
            loadFavorites();
            loadSubscribedToplists();
        } else {
            showToast('导入失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('导入数据失败:', error);
        showToast('导入失败: ' + error.message, 'error');
    }

    // 清空文件输入
    event.target.value = '';
}

/**
 * 重置所有设置
 */
async function resetAllSettings() {
    const confirmed = await Notification.confirm('确定要重置所有设置吗？这将清除所有配置和数据。', { type: 'warning' });
    if (!confirmed) {
        return;
    }

    try {
        // 清除本地存储
        localStorage.clear();

        // 调用后端重置API
        const response = await fetch(`${API_BASE}/api/reset`, {
            method: 'POST'
        });

        const result = await response.json();

        if (result.success) {
            showToast('已重置所有设置', 'success');
            // 重新加载页面
            setTimeout(() => {
                window.location.reload();
            }, 1000);
        } else {
            showToast('重置失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('重置设置失败:', error);
        showToast('重置失败: ' + error.message, 'error');
    }
}

/**
 * 保存调试日志开关
 * @param {boolean} enabled
 */
async function saveDebugLogSetting(enabled) {
    try {
        await fetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ debugLogEnabled: !!enabled })
        });
        showToast(enabled ? '调试日志已开启' : '调试日志已关闭', 'success');
    } catch (error) {
        console.error('保存调试日志设置失败:', error);
        showToast('保存失败: ' + (error.message || '未知错误'), 'error');
    }
}

/**
 * 保存 OpenSubsonic 直连开关（播放/封面 307）
 * @param {string} kind - 'stream' 播放 或 'cover' 封面
 * @param {boolean} enabled - true=307 直链；false=服务器代理
 */
async function saveRedirectModeSetting(kind, enabled) {
    const isCover = kind === 'cover';
    const field = isCover ? 'coverRedirect' : 'streamRedirect';
    const label = isCover ? '封面直连' : '播放直连';
    const elId = isCover ? 'setting-cover-redirect' : 'setting-stream-redirect';
    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: !!enabled })
        });
        const result = await response.json();
        if (result && result.success) {
            showToast(`${label}（307）已${enabled ? '开启，使用 307 直连' : '关闭，使用服务器代理'}`, 'success');
        } else {
            showToast('保存失败: ' + ((result && result.error) || '未知错误'), 'error');
            const el = document.getElementById(elId);
            if (el) el.checked = !enabled;
        }
    } catch (e) {
        showToast('保存失败: ' + (e.message || '网络错误'), 'error');
        const el = document.getElementById(elId);
        if (el) el.checked = !enabled;
    }
}

/**
 * 保存「本地曲库优先播放」开关
 * @param {boolean} enabled - true=播放插件歌曲时优先匹配 NAS 本地曲库并改播本地文件
 */
async function saveLocalLibraryPrioritySetting(enabled) {
    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ localLibraryPriority: !!enabled })
        });
        const result = await response.json();
        if (result && result.success) {
            showToast(enabled ? '已开启本地曲库优先播放' : '已关闭本地曲库优先播放', 'success');
        } else {
            showToast('保存失败: ' + ((result && result.error) || '未知错误'), 'error');
            const el = document.getElementById('setting-local-library-priority');
            if (el) el.checked = !enabled;
        }
    } catch (e) {
        showToast('保存失败: ' + (e.message || '网络错误'), 'error');
        const el = document.getElementById('setting-local-library-priority');
        if (el) el.checked = !enabled;
    }
}

// 导出函数到全局作用域
window.loadSettings = loadSettings;
window.saveRedirectModeSetting = saveRedirectModeSetting;
window.saveLocalLibraryPrioritySetting = saveLocalLibraryPrioritySetting;
/**
 * 切换设置下拉菜单显示/隐藏
 */
function toggleSettingsMenu() {
    const dropdown = document.getElementById('settings-dropdown');
    if (dropdown) {
        const isVisible = dropdown.style.display === 'block';
        dropdown.style.display = isVisible ? 'none' : 'block';

        // 点击其他地方关闭菜单
        if (!isVisible) {
            setTimeout(() => {
                document.addEventListener('click', closeSettingsMenuOnClickOutside, { once: true });
            }, 0);
        }
    }
}

/**
 * 点击外部关闭设置菜单
 * @param {Event} event
 */
function closeSettingsMenuOnClickOutside(event) {
    const dropdown = document.getElementById('settings-dropdown');
    const settingsBtn = document.querySelector('.settings-btn');

    if (dropdown && !dropdown.contains(event.target) && !settingsBtn.contains(event.target)) {
        dropdown.style.display = 'none';
    }
}

/**
 * 打开设置页面并切换到指定标签页
 * @param {string} tab - 标签页名称
 */
function openSettingsTab(_tab) {
    // 关闭下拉菜单
    const dropdown = document.getElementById('settings-dropdown');
    if (dropdown) {
        dropdown.style.display = 'none';
    }

    // 切换到设置页面
    switchPage('settings');
}

/**
 * 切换设置标签页
 * @param {string} tab - 标签页名称
 */
function switchSettingsTab(tab) {
    // 更新标签按钮状态
    document.querySelectorAll('.settings-tab').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.tab === tab) {
            btn.classList.add('active');
        }
    });

    // 更新内容区域显示
    document.querySelectorAll('.settings-section').forEach(section => {
        section.classList.remove('active');
        section.style.display = 'none';
    });

    const targetSection = document.getElementById(`settings-${tab}`);
    if (targetSection) {
        targetSection.classList.add('active');
        targetSection.style.display = 'block';
    }

    // 如果切换到插件标签，加载插件列表
    if (tab === 'plugins') {
        loadPlugins('settings-plugin-table-container');
    }

    // 如果切换到 LX 音源标签，加载音源列表
    if (tab === 'lx') {
        if (typeof loadLxSources === 'function') loadLxSources();
    }

    // 如果切换到缓存管理标签，刷新缓存状态 / 本地库统计 / 网络歌曲缓存上限
    if (tab === 'cache') {
        if (typeof loadCacheManagement === 'function') loadCacheManagement();
    }

    // 如果切换到定时任务标签，加载定时任务配置
    if (tab === 'scheduled') {
        loadScheduledTasks();
    }

    // 如果切换到通知标签，加载企业微信应用配置
    if (tab === 'notification') {
        if (typeof loadNotificationSettings === 'function') loadNotificationSettings();
    }

    // 如果切换到用户与API标签，加载用户列表
    if (tab === 'users') {
        loadUserList();
    }

}

/**
 * 保存常规设置
 * @param {string} key
 * @param {any} value
 */
function saveGeneralSetting(key, value) {
    const settings = JSON.parse(localStorage.getItem('general_settings') || '{}');
    settings[key] = value;
    localStorage.setItem('general_settings', JSON.stringify(settings));
    showToast('设置已保存', 'success');
}

/**
 * 保存播放设置
 * @param {string} key
 * @param {any} value
 */
function savePlaybackSetting(key, value) {
    const settings = JSON.parse(localStorage.getItem('playback_settings') || '{}');
    settings[key] = value;
    localStorage.setItem('playback_settings', JSON.stringify(settings));
    showToast('设置已保存', 'success');
}

// ==================== 下载设置 ====================

/**
 * 加载下载设置
 */
async function loadDownloadSettings() {
    const settings = JSON.parse(localStorage.getItem('download_settings') || '{}');

    // 从后端获取下载配置
    try {
        const response = await fetch(`${API_BASE}/api/downloads/config`);
        const result = await response.json();
        if (result.success && result.data) {
            // 同时下载数量
            if (result.data.maxConcurrent) {
                settings.concurrency = String(result.data.maxConcurrent);
            }
            // 同时下载歌词
            if (result.data.downloadLyrics !== undefined) {
                settings.downloadLyrics = result.data.downloadLyrics;
            }
            // 优先音质（空字符串也视为未设置，使用默认值）
            if (result.data.quality) {
                settings.quality = result.data.quality;
            }
            // 音质缺失处理（空字符串也视为未设置，使用默认值）
            if (result.data.qualityFallback) {
                settings.qualityFallback = result.data.qualityFallback;
            }
            // 排除歌手
            if (Array.isArray(result.data.excludeArtists)) {
                settings.excludeArtists = result.data.excludeArtists;
            }
            // 排除语言
            if (Array.isArray(result.data.excludeLanguages)) {
                settings.excludeLanguages = result.data.excludeLanguages;
            }
            localStorage.setItem('download_settings', JSON.stringify(settings));
        }
    } catch (error) {
        console.error('获取下载配置失败:', error);
    }

    // 同时下载数量
    const concurrencySelect = document.getElementById('setting-download-concurrency');
    if (concurrencySelect) {
        concurrencySelect.value = settings.concurrency || '1';
    }

    // 同时下载歌词
    const lyricsCheckbox = document.getElementById('setting-download-lyrics');
    if (lyricsCheckbox) {
        lyricsCheckbox.checked = settings.downloadLyrics === true;
    }

    // 下载音质（确保值在合法选项范围内，否则回退到默认值）
    const VALID_QUALITY_VALUES = ['low', 'standard', 'high', 'super'];
    const quality = (settings.quality && VALID_QUALITY_VALUES.includes(settings.quality)) ? settings.quality : 'standard';
    const qualitySelect = document.getElementById('setting-download-quality');
    if (qualitySelect) {
        qualitySelect.value = quality;
    }

    // 音质缺失处理（确保值在合法选项范围内，否则回退到默认值）
    const VALID_FALLBACK_VALUES = ['lower', 'higher'];
    const qualityFallback = (settings.qualityFallback && VALID_FALLBACK_VALUES.includes(settings.qualityFallback)) ? settings.qualityFallback : 'lower';
    const fallbackSelect = document.getElementById('setting-quality-fallback');
    if (fallbackSelect) {
        fallbackSelect.value = qualityFallback;
    }

    // 排除歌手
    const excludeArtistsEl = document.getElementById('setting-exclude-artists');
    if (excludeArtistsEl) {
        excludeArtistsEl.value = (settings.excludeArtists || []).join(', ');
    }
    // 排除语言（复选框）
    const excludeLangs = (settings.excludeLanguages || []).map(l => String(l || '').trim());
    document.querySelectorAll('.exclude-lang-checkbox').forEach(cb => {
        cb.checked = excludeLangs.includes(cb.value);
    });
}

/**
 * 保存下载设置
 * @param {string} key - 设置项键名
 * @param {string|boolean} value - 设置值
 */
async function saveDownloadSetting(key, value) {
    const settings = JSON.parse(localStorage.getItem('download_settings') || '{}');
    settings[key] = value;
    localStorage.setItem('download_settings', JSON.stringify(settings));

    // 如果修改了并发数，同步到后端
    if (key === 'concurrency') {
        try {
            await fetch(`${API_BASE}/api/downloads/concurrency`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ maxConcurrent: parseInt(value, 10) })
            });
        } catch (error) {
            console.error('同步并发数设置失败:', error);
        }
    }

    // 如果修改了同时下载歌词，同步到后端
    if (key === 'downloadLyrics') {
        try {
            await fetch(`${API_BASE}/api/downloads/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ downloadLyrics: value })
            });
        } catch (error) {
            console.error('同步下载歌词设置失败:', error);
        }
    }

    // 如果修改了优先音质，同步到后端
    if (key === 'quality') {
        try {
            await fetch(`${API_BASE}/api/downloads/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quality: value })
            });
        } catch (error) {
            console.error('同步优先音质设置失败:', error);
        }
    }

    // 如果修改了音质缺失处理，同步到后端
    if (key === 'qualityFallback') {
        try {
            await fetch(`${API_BASE}/api/downloads/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ qualityFallback: value })
            });
        } catch (error) {
            console.error('同步音质缺失处理设置失败:', error);
        }
    }

    showToast('下载设置已保存', 'success');
}

/**
 * 将文本解析为排除项数组（支持逗号、中文逗号、分号、换行分隔）
 * @param {string} text
 * @returns {string[]}
 */
function parseExcludeInput(text) {
    if (!text) return [];
    return String(text)
        .split(/[,，;\n\r]+/)
        .map(s => s.trim())
        .filter(Boolean);
}

/**
 * 保存下载排除规则（排除歌手 / 排除语言）
 */
async function saveExcludeSettings() {
    const artistsEl = document.getElementById('setting-exclude-artists');
    const excludeArtists = parseExcludeInput(artistsEl ? artistsEl.value : '');
    const excludeLanguages = Array.from(document.querySelectorAll('.exclude-lang-checkbox'))
        .filter(cb => cb.checked)
        .map(cb => cb.value);

    const settings = JSON.parse(localStorage.getItem('download_settings') || '{}');
    settings.excludeArtists = excludeArtists;
    settings.excludeLanguages = excludeLanguages;
    localStorage.setItem('download_settings', JSON.stringify(settings));

    try {
        await fetch(`${API_BASE}/api/downloads/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ excludeArtists, excludeLanguages })
        });
        showToast('排除规则已保存', 'success');
    } catch (error) {
        console.error('保存排除规则失败:', error);
        showToast('保存失败', 'error');
    }
}

/**
 * 选择下载路径
 * 点击浏览按钮时，直接聚焦到输入框并选中文本，方便用户手动输入
 */
function selectDownloadPath() {
    const input = document.getElementById('setting-download-path');
    if (input) {
        input.focus();
        input.select();
    }
}

/**
 * 保存企业微信通知地址
 * @param {string} url
 */
async function saveWecomUrlSetting(url) {
    localStorage.setItem('wecom_url', url);

    // 同步到后端
    try {
        await fetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wecomUrl: url })
        });
    } catch (error) {
        console.error('同步企业微信地址失败:', error);
    }

    showToast('企业微信通知地址已保存', 'success');
}

/**
 * 切换通知启用状态
 * @param {boolean} enabled
 */
async function toggleNotificationEnabled(enabled) {
    const statusText = document.getElementById('notification-status-text');
    if (statusText) {
        statusText.textContent = enabled ? '已启用' : '已禁用';
    }

    // 保存到本地存储
    localStorage.setItem('notification_enabled', enabled);

    // 同步到后端
    try {
        const response = await fetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notificationEnabled: enabled })
        });
        const result = await response.json();
        if (!result.success) {
            console.error('保存通知设置失败:', result.error);
        }
    } catch (error) {
        console.error('同步通知启用状态失败:', error);
    }
}

/**
 * 保存通知设置
 */
async function saveNotificationSettings() {
    const enabled = document.getElementById('setting-notification-enabled')?.checked || false;
    const url = document.getElementById('setting-wecom-url')?.value?.trim() || '';
    const notificationUrl = document.getElementById('setting-notification-url')?.value?.trim() || '';

    // 验证URL格式
    if (enabled && url && !url.startsWith('https://qyapi.weixin.qq.com/')) {
        showToast('请输入有效的企业微信Webhook地址', 'error');
        return;
    }

    // 验证通知跳转链接格式（如果填写了）
    if (notificationUrl && !notificationUrl.startsWith('http://') && !notificationUrl.startsWith('https://')) {
        showToast('通知跳转链接格式不正确，需要以 http:// 或 https:// 开头', 'error');
        return;
    }

    // 保存到本地存储
    localStorage.setItem('notification_enabled', enabled);
    localStorage.setItem('wecom_url', url);
    localStorage.setItem('notification_url', notificationUrl);

    // 发送到后端保存
    try {
        const response = await fetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notificationEnabled: enabled, wecomUrl: url, notificationUrl })
        });

        const result = await response.json();

        if (result.success) {
            showToast('通知配置保存成功', 'success');
        } else {
            showToast('保存失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('保存通知设置失败:', error);
        // 即使后端保存失败，本地存储已成功
        showToast('配置已保存到本地', 'success');
    }
}

/**
 * 测试通知
 */
async function testNotification() {
    const url = document.getElementById('setting-wecom-url')?.value?.trim();

    if (!url) {
        showToast('请先输入Webhook地址', 'error');
        return;
    }

    if (!url.startsWith('https://qyapi.weixin.qq.com/')) {
        showToast('请输入有效的企业微信Webhook地址', 'error');
        return;
    }

    showToast('正在发送测试通知...', 'info');

    try {
        const token = window.Auth ? window.Auth.getToken() : localStorage.getItem('token');
        const response = await fetch(`${API_BASE}/api/settings/notification/test`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ url })
        });

        const result = await response.json();

        if (result.success) {
            showToast('测试通知发送成功，请查看企业微信', 'success');
        } else {
            showToast('发送失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('测试通知失败:', error);
        showToast('发送失败: ' + error.message, 'error');
    }
}

// ==================== 用户管理功能 ====================

// 用户列表数据
let userList = [];

/**
 * 显示添加用户弹窗
 */
function showAddUserModal() {
    const modal = document.getElementById('add-user-modal');
    if (modal) {
        modal.style.display = 'flex';
        // 清空输入框
        document.getElementById('new-username').value = '';
        document.getElementById('new-password').value = '';
        document.getElementById('new-user-remark').value = '';
        document.getElementById('new-username').focus();
    }
}

/**
 * 关闭添加用户弹窗
 */
function closeAddUserModal() {
    const modal = document.getElementById('add-user-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * 添加用户
 */
async function addUser() {
    const username = document.getElementById('new-username').value.trim();
    const password = document.getElementById('new-password').value;
    const remark = document.getElementById('new-user-remark').value.trim();

    if (!username) {
        showToast('请输入用户名', 'error');
        return;
    }

    if (!password) {
        showToast('请输入密码', 'error');
        return;
    }

    if (password.length < 4) {
        showToast('密码长度至少4位', 'error');
        return;
    }

    // 检查用户名是否已存在
    if (userList.find(u => u.username === username)) {
        showToast('用户名已存在', 'error');
        return;
    }

    try {
        // 使用 Auth API 添加用户
        const result = await window.Auth.users.create({
            username,
            password,
            remark,
            role: 'user'
        });

        if (result.success) {
            await loadUserList();
            closeAddUserModal();
            showToast('用户添加成功', 'success');
        } else {
            showToast('添加失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('添加用户失败:', error);
        showToast('添加失败: ' + error.message, 'error');
    }
}

/**
 * 显示编辑用户弹窗（用户名 + 密码）
 */
function showEditUserModal(userId) {
    const user = (userList || []).find(u => u.id === userId);
    if (!user) return;
    const modal = document.getElementById('edit-user-modal');
    modal.dataset.userId = userId;
    document.getElementById('edit-user-username').value = user.username;
    document.getElementById('edit-user-new').value = '';
    document.getElementById('edit-user-confirm').value = '';
    modal.style.display = 'flex';
    document.getElementById('edit-user-username').focus();
}

function closeEditUserModal() {
    const modal = document.getElementById('edit-user-modal');
    if (modal) modal.style.display = 'none';
}

/**
 * 保存编辑用户（用户名 + 可选密码）
 */
async function saveEditUser() {
    const modal = document.getElementById('edit-user-modal');
    const userId = parseInt(modal.dataset.userId, 10);
    const newUsername = document.getElementById('edit-user-username').value.trim();
    const newPassword = document.getElementById('edit-user-new').value;
    const confirmPassword = document.getElementById('edit-user-confirm').value;

    if (!newUsername) {
        showToast('用户名不能为空', 'error');
        return;
    }
    if (newUsername.length < 3) {
        showToast('用户名至少3位', 'error');
        return;
    }

    // 校验密码一致性（仅在填写时校验）
    if (newPassword || confirmPassword) {
        if (newPassword.length < 4) {
            showToast('密码长度至少4位', 'error');
            return;
        }
        if (newPassword !== confirmPassword) {
            showToast('两次输入的密码不一致', 'error');
            return;
        }
    }

    try {
        // 更新用户名
        const updateResult = await window.Auth.users.update(userId, { username: newUsername });
        if (!updateResult.success) {
            showToast('用户名修改失败: ' + (updateResult.error || '未知错误'), 'error');
            return;
        }

        // 可选更新密码
        if (newPassword) {
            const pwResult = await window.Auth.users.changePassword(userId, newPassword);
            if (!pwResult.success) {
                showToast('密码修改失败: ' + (pwResult.error || '未知错误'), 'error');
                return;
            }
        }

        modal.style.display = 'none';
        showToast('保存成功', 'success');
        await loadUserList();
    } catch (e) {
        showToast('保存失败: ' + ((e && e.message) || '未知错误'), 'error');
    }
}

/**
 * 删除用户
 * @param {string} username
 */
async function deleteUser(username) {
    if (username === 'admin') {
        showToast('不能删除管理员账户', 'error');
        return;
    }

    const user = userList.find(u => u.username === username);
    if (!user) {
        showToast('用户不存在', 'error');
        return;
    }

    const confirmed = await Notification.confirm(`确定要删除用户 "${username}" 吗？`, { type: 'warning' });
    if (!confirmed) {
        return;
    }

    try {
        const result = await window.Auth.users.delete(user.id);

        if (result.success) {
            await loadUserList();
            showToast('用户删除成功', 'success');
        } else {
            showToast('删除失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('删除用户失败:', error);
        showToast('删除失败: ' + error.message, 'error');
    }
}

/**
 * 渲染用户表格
 */
function renderUserTable() {
    const tbody = document.getElementById('user-table-body');
    if (!tbody) return;

    if (userList.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="3">
                    <div class="user-table-empty">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                            <circle cx="9" cy="7" r="4"/>
                            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                        </svg>
                        <div>暂无用户数据</div>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = userList.map(user => `
        <tr>
            <td>${user.username}</td>
            <td>${user.remark || '-'}</td>
            <td>
                <div class="user-table-actions">
                    <button class="user-table-btn" onclick="showEditUserModal(${user.id})" title="编辑">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button class="user-table-btn user-table-btn-danger" onclick="deleteUser('${user.username}')" title="删除" ${user.username === 'admin' ? 'disabled' : ''}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

/**
 * 加载用户列表
 */
async function loadUserList() {
    // 检查是否有管理员权限
    if (!window.Auth || !window.Auth.isAdmin()) {
        console.log('[loadUserList] 需要管理员权限');
        return;
    }

    try {
        const result = await window.Auth.users.getAll();

        if (result.success && result.data) {
            userList = result.data;
        }
    } catch (error) {
        console.error('加载用户列表失败:', error);
        userList = [];
    }
    renderUserTable();
}

// ==================== 缓存设置功能 ====================

/**
 * 加载缓存设置
 */
async function loadCacheSettings() {
    // 缓存上限
    const cacheLimit = localStorage.getItem('cache_limit_mb') || '1000';
    const cacheLimitSelect = document.getElementById('setting-cache-limit');
    if (cacheLimitSelect) {
        cacheLimitSelect.value = cacheLimit;
    }

    // 更新缓存状态显示
    await updateCacheStatus();
    // 更新本地音乐库数据库统计
    await updateLocalDataStatus();
}

/**
 * 更新缓存状态显示
 */
async function updateCacheStatus() {
    const usedEl = document.getElementById('cache-used');
    const barFillEl = document.getElementById('cache-bar-fill');
    const countEl = document.getElementById('cache-item-count');

    // 优先用后端磁盘统计（准确反映实际缓存文件，不依赖浏览器本地索引）
    let stats = null;
    try {
        let res;
        if (typeof Auth !== 'undefined' && Auth.authenticatedFetch) {
            res = await Auth.authenticatedFetch(`${API_BASE}/api/cache/stats`);
        } else {
            res = await fetch(`${API_BASE}/api/cache/stats`);
        }
        const json = await res.json();
        if (json && json.success && json.data) stats = json.data;
    } catch (e) { /* 忽略，回退到本地索引 */ }

    let totalSize = 0, itemCount = 0, artworkCount = 0, artistCount = 0, radioCount = 0;
    if (stats) {
        totalSize = stats.totalSize || 0;
        itemCount = stats.itemCount || 0;
        artworkCount = (stats.artwork && stats.artwork.count) || 0;
        artistCount = (stats.artist && stats.artist.count) || 0;
        radioCount = (stats.radio && stats.radio.count) || 0;
    } else if (typeof CacheManager !== 'undefined') {
        const status = CacheManager.getStatus();
        totalSize = status.totalSize;
        itemCount = status.itemCount;
        artworkCount = status.artworkCount;
        artistCount = 0;
        radioCount = 0;
    } else {
        return;
    }

    const fmt = (typeof CacheManager !== 'undefined' && CacheManager.formatSize)
        ? CacheManager.formatSize
        : (b) => (b / 1024 / 1024).toFixed(2) + ' MB';

    if (usedEl) usedEl.textContent = fmt(totalSize);

    if (barFillEl) {
        const maxSize = (typeof CacheManager !== 'undefined') ? CacheManager.config.maxSize : 0;
        if (maxSize > 0) {
            const percent = Math.min((totalSize / maxSize) * 100, 100);
            barFillEl.style.width = percent + '%';
            // 根据使用率设置颜色
            if (percent > 90) {
                barFillEl.style.background = 'var(--error-color, #e74c3c)';
            } else if (percent > 70) {
                barFillEl.style.background = 'var(--warning-color, #f1c40f)';
            } else {
                barFillEl.style.background = 'var(--primary-color, #1db954)';
            }
        }
    }

    if (countEl) {
        countEl.textContent = `${itemCount} 个文件 (封面: ${artworkCount}, 歌手头像: ${artistCount}, 电台封面: ${radioCount})`;
    }
}

/**
 * 保存缓存上限设置
 * @param {string} mb - 缓存上限(MB)
 */
async function saveCacheLimit(mb) {
    localStorage.setItem('cache_limit_mb', mb);

    // 更新 CacheManager 配置
    if (typeof CacheManager !== 'undefined') {
        CacheManager.setMaxSize(parseInt(mb, 10));
    }

    // 刷新状态显示
    await updateCacheStatus();

    showToast('缓存上限已设置为 ' + mb + ' MB', 'success');
}

/**
 * 保存网络歌曲数据库缓存上限（songs 表 remote__*，默认 3000 首；本地歌曲不受限制）
 * @param {string} value - 上限条数
 */
async function saveNetCacheMax(value) {
    const v = Math.max(100, Math.min(20000, parseInt(value, 10) || 1000));
    const el = document.getElementById('setting-net-cache-max');
    if (el) el.value = v;
    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ maxNetSongCache: v })
        });
        const json = await response.json();
        if (json && json.success) {
            showToast('网络歌曲数据库缓存上限已设置为 ' + v + ' 首', 'success');
        } else {
            showToast((json && json.error) || '保存失败', 'error');
        }
    } catch (e) {
        showToast('保存失败', 'error');
    }
}

/**
 * 保存最近播放数据库上限（play_history，默认 100 首；每个用户超出自动删除最老记录）
 * @param {string} value - 上限条数
 */
async function saveRecentPlayMax(value) {
    const v = Math.max(10, Math.min(5000, parseInt(value, 10) || 100));
    const el = document.getElementById('setting-recent-play-max');
    if (el) el.value = v;
    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ maxRecentPlay: v })
        });
        const json = await response.json();
        if (json && json.success) {
            showToast('最近播放数据库上限已设置为 ' + v + ' 首', 'success');
        } else {
            showToast((json && json.error) || '保存失败', 'error');
        }
    } catch (e) {
        showToast('保存失败', 'error');
    }
}

/**
 * 清理缓存
 */
async function clearCache() {
    const types = [];
    if (document.getElementById('clear-cache-artwork') && document.getElementById('clear-cache-artwork').checked) types.push('artwork');
    if (document.getElementById('clear-cache-artist') && document.getElementById('clear-cache-artist').checked) types.push('artist');
    if (document.getElementById('clear-cache-radio') && document.getElementById('clear-cache-radio').checked) types.push('radio');

    if (types.length === 0) {
        showToast('请至少选择一种缓存类型', 'warning');
        return;
    }

    const typeNames = { artwork: '封面', artist: '歌手头像', radio: '电台封面' };
    const names = types.map(t => typeNames[t]).join('、');

    const confirmed = await Notification.confirm(`确定要清理选中的缓存吗？将删除已缓存的 ${names} 文件。`, { type: 'warning' });
    if (!confirmed) return;

    if (typeof CacheManager !== 'undefined') {
        const result = await CacheManager.clearTypes(types);
        if (result.success) {
            await updateCacheStatus();
            showToast('已清理：' + names, 'success');
        } else {
            showToast('清理失败: ' + (result.error || '未知错误'), 'error');
        }
    } else {
        showToast('缓存管理器未初始化', 'error');
    }
}

/**
 * 更新本地音乐库数据库统计显示（歌曲数 / 封面数）
 */
async function updateLocalDataStatus() {
    try {
        const response = await fetch(`${API_BASE}/api/music/local-stats`);
        const res = await response.json();
        if (res && res.success && res.data) {
            const songsEl = document.getElementById('local-db-songs');
            if (songsEl) songsEl.textContent = res.data.songs;
        }
    } catch (e) {
        // 忽略统计获取失败
    }
    // 网络歌曲缓存条数
    try {
        const netRes = await fetch(`${API_BASE}/api/music/network-song-count`);
        const netJson = await netRes.json();
        if (netJson && netJson.success && netJson.data) {
            const el = document.getElementById('network-song-count');
            if (el) el.textContent = netJson.data.count;
        }
    } catch (e) {
        // 忽略
    }
    // 电台数据条数
    try {
        const radioRes = await fetch(`${API_BASE}/api/radio/stations`);
        const radioJson = await radioRes.json();
        const el = document.getElementById('radio-station-count');
        if (el && radioJson && radioJson.success && Array.isArray(radioJson.data)) {
            let total = 0;
            for (const plugin of radioJson.data) {
                const groups = plugin && plugin.groups;
                if (Array.isArray(groups)) {
                    for (const g of groups) {
                        if (Array.isArray(g.stations)) total += g.stations.length;
                    }
                }
            }
            el.textContent = total;
        }
    } catch (e) {
        // 忽略
    }
}

/**
 * 清理本地音乐库数据库数据（歌曲 / 封面缓存），并按磁盘重新扫描重建
 */
async function clearLocalData() {
    const confirmed = await Notification.confirm('确定清理本地音乐库数据库数据吗？将删除本地歌曲与封面的数据库缓存，并按磁盘重新扫描重建（音频文件不会被删除）。', { type: 'warning' });
    if (!confirmed) return;
    try {
        const response = await fetch(`${API_BASE}/api/music/clear-local-data`, { method: 'POST' });
        const res = await response.json();
        if (res && res.success) {
            await updateLocalDataStatus();
            showToast('本地音乐库数据已清理，正在按磁盘重新扫描', 'success');
            // 若本地音乐页已加载，刷新它
            if (typeof loadLocalMusic === 'function') {
                window.localFolderTree = null;
                loadLocalMusic();
            }
        } else {
            showToast('清理失败: ' + ((res && res.error) || '未知错误'), 'error');
        }
    } catch (e) {
        showToast('清理失败: ' + (e && e.message), 'error');
    }
}

/**
 * 清空全部电台数据（保留收藏，可重新导入恢复）
 */
async function clearRadioData() {
    const confirmed = await Notification.confirm('确定清空所有电台数据吗？将删除全部已导入/自建电台（收藏不受影响，可重新导入恢复）。', { type: 'warning' });
    if (!confirmed) return;
    try {
        const response = await fetch(`${API_BASE}/api/radio/stations/clear`, { method: 'POST' });
        const res = await response.json();
        if (res && res.success) {
            showToast('电台数据已清空', 'success');
        } else {
            showToast('清空失败: ' + ((res && res.error) || '未知错误'), 'error');
        }
    } catch (e) {
        showToast('清空失败: ' + (e && e.message), 'error');
    }
}

/**
 * 批量清理选中数据（本地音乐库 / 网络歌曲 / 电台），由开关勾选控制，清理前二次确认
 */
async function clearSelectedData() {
    const localChecked = document.getElementById('clear-data-local') && document.getElementById('clear-data-local').checked;
    const networkChecked = document.getElementById('clear-data-network') && document.getElementById('clear-data-network').checked;
    const radioChecked = document.getElementById('clear-data-radio') && document.getElementById('clear-data-radio').checked;
    const playHistoryChecked = document.getElementById('clear-data-playhistory') && document.getElementById('clear-data-playhistory').checked;

    const selected = [];
    if (localChecked) selected.push('本地音乐库数据');
    if (networkChecked) selected.push('网络歌曲数据');
    if (radioChecked) selected.push('电台数据');
    if (playHistoryChecked) selected.push('播放数据（所有用户）');
    if (selected.length === 0) {
        showToast('请至少勾选一种数据类型', 'warning');
        return;
    }

    const confirmed = await Notification.confirm('确定清理选中的数据吗？将删除：' + selected.join('、') + '。此操作不可恢复。', { type: 'warning' });
    if (!confirmed) return;

    let okCount = 0;
    let errMsg = '';

    if (localChecked) {
        try {
            const r = await fetch(`${API_BASE}/api/music/clear-local-data`, { method: 'POST' });
            const res = await r.json();
            if (res && res.success) okCount++;
            else errMsg += '本地音乐库数据清理失败；';
        } catch (e) { errMsg += '本地音乐库数据清理失败；'; }
    }
    if (networkChecked) {
        try {
            const r = await fetch(`${API_BASE}/api/music/clear-network-songs`, { method: 'POST' });
            const res = await r.json();
            if (res && res.success) okCount++;
            else errMsg += '网络歌曲数据清理失败；';
        } catch (e) { errMsg += '网络歌曲数据清理失败；'; }
    }
    if (radioChecked) {
        try {
            const r = await fetch(`${API_BASE}/api/radio/stations/clear`, { method: 'POST' });
            const res = await r.json();
            if (res && res.success) okCount++;
            else errMsg += '电台数据清理失败；';
        } catch (e) { errMsg += '电台数据清理失败；'; }
    }
    if (playHistoryChecked) {
        // 播放数据（所有用户）：管理员操作，清空全部用户的播放历史（含播放进度）与播放队列
        try {
            const r = await Auth.authenticatedFetch(`${API_BASE}/api/settings/clear-play-data`, { method: 'POST' });
            const res = await r.json();
            if (res && res.success) okCount++;
            else errMsg += '播放数据清理失败；';
        } catch (e) { errMsg += '播放数据清理失败；'; }
    }

    // 刷新统计显示
    await updateLocalDataStatus();
    // 若本地音乐页已加载，刷新它
    if (localChecked && typeof loadLocalMusic === 'function') {
        window.localFolderTree = null;
        loadLocalMusic();
    }

    if (okCount === selected.length) {
        showToast('已清理：' + selected.join('、'), 'success');
    } else {
        showToast(errMsg || '部分清理失败', 'error');
    }
}

/**
 * 缓存管理页加载入口（独立菜单）：
 * 回显浏览器缓存上限（localStorage）、服务端网络歌曲缓存上限，并刷新当前缓存 / 本地库统计。
 */
async function loadCacheManagement() {
    const cacheLimit = localStorage.getItem('cache_limit_mb') || '1000';
    const cacheLimitSelect = document.getElementById('setting-cache-limit');
    if (cacheLimitSelect) cacheLimitSelect.value = cacheLimit;

    // 服务端网络歌曲数据库缓存上限（默认 1000）+ 最近播放上限（默认 100）
    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/settings`);
        const json = await response.json();
        const netCacheInput = document.getElementById('setting-net-cache-max');
        const recentPlayInput = document.getElementById('setting-recent-play-max');
        if (json && json.success && json.data) {
            if (netCacheInput) netCacheInput.value = json.data.maxNetSongCache !== undefined ? json.data.maxNetSongCache : 1000;
            if (recentPlayInput) recentPlayInput.value = json.data.maxRecentPlay !== undefined ? json.data.maxRecentPlay : 100;
        }
    } catch (e) { /* 忽略 */ }

    await updateCacheStatus();
    await updateLocalDataStatus();
}

// 导出函数到全局作用域
window.loadSettings = loadSettings;
window.saveSettings = saveSettings;
window.loadCacheManagement = loadCacheManagement;
window.loadOtherSettings = loadOtherSettings;
window.saveThemeSetting = saveThemeSetting;
window.applyTheme = applyTheme;
window.updateLocalDataStatus = updateLocalDataStatus;
window.clearLocalData = clearLocalData;
window.saveQualitySetting = saveQualitySetting;
window.addPluginPicker = addPluginPicker;
window.removePluginPicker = removePluginPicker;
window.movePluginPicker = movePluginPicker;
window.testEnrichPlugin = testEnrichPlugin;
window.clearTestEnrich = clearTestEnrich;
window.fillMissingImages = fillMissingImages;
window.generateApiKey = generateApiKey;
window.saveApiKeySetting = saveApiKeySetting;
window.saveDownloadPath = saveDownloadPath;

window.exportData = exportData;
window.importData = importData;
window.resetAllSettings = resetAllSettings;
window.saveDebugLogSetting = saveDebugLogSetting;
window.toggleSettingsMenu = toggleSettingsMenu;
window.openSettingsTab = openSettingsTab;
window.switchSettingsTab = switchSettingsTab;
window.saveGeneralSetting = saveGeneralSetting;
window.savePlaybackSetting = savePlaybackSetting;
window.saveOpenlistConfigSetting = saveOpenlistConfigSetting;
window.loadOpenlistConfigSetting = loadOpenlistConfigSetting;
window.selectDownloadPath = selectDownloadPath;
window.loadDownloadSettings = loadDownloadSettings;
window.saveDownloadSetting = saveDownloadSetting;
window.saveWecomUrlSetting = saveWecomUrlSetting;
window.saveExcludeSettings = saveExcludeSettings;
window.toggleNotificationEnabled = toggleNotificationEnabled;
window.saveNotificationSettings = saveNotificationSettings;
window.testNotification = testNotification;
window.showAddUserModal = showAddUserModal;
window.closeAddUserModal = closeAddUserModal;
window.addUser = addUser;
window.deleteUser = deleteUser;
window.showEditUserModal = showEditUserModal;
window.closeEditUserModal = closeEditUserModal;
window.saveEditUser = saveEditUser;
window.renderUserTable = renderUserTable;
window.loadUserList = loadUserList;

// 【新增】缓存设置导出
window.loadCacheSettings = loadCacheSettings;
window.updateCacheStatus = updateCacheStatus;
window.saveCacheLimit = saveCacheLimit;
window.saveNetCacheMax = saveNetCacheMax;
window.saveRecentPlayMax = saveRecentPlayMax;
window.clearCache = clearCache;
window.clearRadioData = clearRadioData;
window.clearSelectedData = clearSelectedData;
// 【新增】手动元数据补全（艺术家 / 专辑 / 标题）
window.fillMissingMetadata = fillMissingMetadata;


// ==================== 定时任务管理 ====================

/**
 * 通用 Cron 表达式解析：根据 5 段标准 cron 表达式计算下一次执行时间，
 * 返回人类可读的中文描述（如 "每天 02:00"、"每周一 09:30"、"2026-09-05 03:15"）。
 * 注：通用 cron 解析实现，替换原先带特定前缀的命名。
 */
function parseCronExpression(cron) {
    if (!cron || typeof cron !== 'string') return '';
    const parts = cron.trim().split(/\s+/);
    if (parts.length < 5) return cron;
    const [minF, hourF, domF, monF, dowF] = parts;

    function fieldValues(spec, min, max) {
        const set = new Set();
        for (const tok of spec.split(',')) {
            let step = 1;
            let t = tok;
            if (t.includes('/')) {
                const [base, stepStr] = t.split('/');
                step = parseInt(stepStr, 10) || 1;
                t = base === '*' ? '*' : base;
            }
            if (t === '*') {
                for (let v = min; v <= max; v += step) set.add(v);
            } else if (t.includes('-')) {
                let [a, b] = t.split('-').map(Number);
                if (b < a) b += (max - min + 1);
                for (let v = a; v <= b; v += step) {
                    set.add(((v - min) % (max - min + 1)) + min);
                }
            } else {
                const v = parseInt(t, 10);
                if (!isNaN(v)) set.add(v);
            }
        }
        return set;
    }

    const mins = fieldValues(minF, 0, 59);
    const hours = fieldValues(hourF, 0, 23);
    const doms = fieldValues(domF, 1, 31);
    const mons = fieldValues(monF, 1, 12);
    const dows = new Set();
    fieldValues(dowF, 0, 7).forEach(v => dows.add(((v % 7) + 7) % 7));

    const domStar = domF.trim() === '*';
    const dowStar = dowF.trim() === '*';
    const monStar = monF.trim() === '*';

    function match(date) {
        const m = date.getMonth() + 1;
        const d = date.getDate();
        const h = date.getHours();
        const mi = date.getMinutes();
        const dw = date.getDay();
        const dateOk = domStar && dowStar ? true
            : domStar ? dows.has(dw)
            : dowStar ? doms.has(d)
            : doms.has(d) || dows.has(dw);
        return mons.has(m) && dateOk && hours.has(h) && mins.has(mi);
    }

    const now = new Date();
    const limit = new Date(now.getFullYear() + 4, now.getMonth(), now.getDate());
    const cur = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() + 1, 0, 0);

    let guard = 0;
    while (cur <= limit && guard < 3000000) {
        guard++;
        if (match(cur)) {
            const hh = String(cur.getHours()).padStart(2, '0');
            const mm = String(cur.getMinutes()).padStart(2, '0');
            const minFixed = mins.size === 1 && !minF.includes('*') && !minF.includes(',');
            const hourFixed = hours.size === 1 && !hourF.includes('*') && !hourF.includes(',');
            if (domStar && dowStar && monStar && minFixed && hourFixed) {
                return `每天 ${hh}:${mm}`;
            }
            if (!dowStar && domStar && monStar && minFixed && hourFixed) {
                const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
                const arr = [...dows].sort((a, b) => a - b).map(x => names[x]);
                return `每周${arr.join('、')} ${hh}:${mm}`;
            }
            const y = cur.getFullYear();
            const mo = String(m).padStart(2, '0');
            const da = String(d).padStart(2, '0');
            return `${y}-${mo}-${da} ${hh}:${mm}`;
        }
        cur.setMinutes(cur.getMinutes() + 1);
    }
    return cron;
}

/**
 * 加载定时任务配置
 */
async function loadScheduledTasks() {

    // 加载插件自动更新配置
    await loadScheduledPluginConfig();

    // 加载下载订阅配置
    await loadScheduledSubscribeConfig();


    // 加载通知按钮状态
    loadScheduledNotifyStates();
}

/**
 * 加载插件自动更新配置
 */
async function loadScheduledPluginConfig() {
    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/auto-update/config`);
        const result = await response.json();

        const enabledCheckbox = document.getElementById('scheduled-plugin-enabled');
        const cronDisplay = document.getElementById('scheduled-plugin-cron-display');
        const nextEl = document.getElementById('scheduled-plugin-next');
        const lastEl = document.getElementById('scheduled-plugin-last');

        if (result.success && result.data) {
            const config = result.data;

            if (enabledCheckbox) {
                enabledCheckbox.checked = config.enabled === 1 || config.enabled === true;
            }
            if (cronDisplay) {
                cronDisplay.textContent = config.cronExpression || '0 0 * * *';
            }
            if (nextEl) {
                nextEl.textContent = parseCronExpression(config.cronExpression || '0 0 * * *');
            }
            if (lastEl) {
                lastEl.textContent = config.lastUpdateTime
                    ? new Date(config.lastUpdateTime).toLocaleString('zh-CN')
                    : '从未执行';
            }
        } else {
            if (enabledCheckbox) enabledCheckbox.checked = false;
            if (cronDisplay) cronDisplay.textContent = '0 0 * * *';
            if (nextEl) nextEl.textContent = '每天 00:00';
            if (lastEl) lastEl.textContent = '从未执行';
        }
    } catch (error) {
        console.error('加载插件自动更新配置失败:', error);
    }
}

/**
 * 切换插件自动更新开关
 */
async function toggleScheduledPlugin(enabled) {
    try {
        const cronDisplay = document.getElementById('scheduled-plugin-cron-display');
        const cronExpression = cronDisplay ? cronDisplay.textContent.trim() : '0 0 * * *';

        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/auto-update/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, cronExpression })
        });

        const result = await response.json();

        if (result.success) {
            showToast(enabled ? '已启用插件自动更新' : '已禁用插件自动更新', 'success');
        } else {
            showToast('更新失败: ' + (result.error || '未知错误'), 'error');
            const checkbox = document.getElementById('scheduled-plugin-enabled');
            if (checkbox) checkbox.checked = !enabled;
        }
    } catch (error) {
        console.error('切换插件自动更新失败:', error);
        showToast('更新失败: ' + error.message, 'error');
        const checkbox = document.getElementById('scheduled-plugin-enabled');
        if (checkbox) checkbox.checked = !enabled;
    }
}

/**
 * 编辑插件自动更新规则
 */
function editScheduledPluginCron() {
    const cronDisplay = document.getElementById('scheduled-plugin-cron-display');
    const currentCron = cronDisplay ? cronDisplay.textContent.trim() : '0 0 * * *';
    const isEnabled = document.getElementById('scheduled-plugin-enabled')?.checked || false;

    const presets = [
        { label: '每小时', value: '0 * * * *' },
        { label: '每天0点', value: '0 0 * * *' },
        { label: '每天9点', value: '0 9 * * *' },
        { label: '每天10点', value: '0 10 * * *' },
        { label: '每天18点', value: '0 18 * * *' },
        { label: '每天22点', value: '0 22 * * *' },
        { label: '每周一', value: '0 0 * * 1' },
        { label: '每月1号', value: '0 0 1 * *' }
    ];

    const presetButtons = presets.map(p =>
        `<button class="cron-preset-btn" data-value="${p.value}" style="
            padding: 6px 12px;
            border: 1px solid var(--divider-color);
            background: var(--surface-color);
            color: var(--text-color);
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        ">${p.label}</button>`
    ).join('');

    const modalHtml = `
        <div style="
            background: var(--surface-color, #fff);
            border-radius: 12px;
            padding: 24px;
            max-width: 400px;
            width: 90%;
        ">
            <h3 style="margin: 0 0 20px 0; font-size: 18px;">编辑插件自动更新规则</h3>
            <div style="margin-bottom: 16px; display: flex; flex-wrap: wrap; gap: 8px;">
                ${presetButtons}
            </div>
            <div style="margin-bottom: 20px;">
                <label style="display: block; margin-bottom: 8px; font-size: 14px; font-weight: 600;">Cron 表达式</label>
                <input type="text" id="scheduled-cron-input" class="form-input" value="${escapeHtml(currentCron)}" placeholder="0 0 * * *" style="width: 100%;">
                <div style="margin-top: 8px; font-size: 12px; color: var(--text-secondary);">
                    格式: 分 时 日 月 周
                </div>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 12px;">
                <button class="btn btn-secondary" onclick="closeScheduledModal(this)">取消</button>
                <button class="btn btn-primary" onclick="saveScheduledPluginCron('${isEnabled}')">确定</button>
            </div>
        </div>
    `;

    const overlay = document.createElement('div');
    overlay.id = 'scheduled-modal-overlay';
    overlay.style.cssText = `
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
    `;
    overlay.innerHTML = modalHtml;
    document.body.appendChild(overlay);

    overlay.querySelectorAll('.cron-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            overlay.querySelector('#scheduled-cron-input').value = btn.dataset.value;
        });
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeScheduledModal();
    });
}

/**
 * 保存插件自动更新规则
 */
async function saveScheduledPluginCron(isEnabled) {
    const input = document.getElementById('scheduled-cron-input');
    const newCron = input ? input.value.trim() : '0 0 * * *';

    try {
        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/auto-update/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: isEnabled === 'true', cronExpression: newCron })
        });

        const result = await response.json();

        if (result.success) {
            showToast('定时规则已更新', 'success');
            const cronDisplay = document.getElementById('scheduled-plugin-cron-display');
            const nextEl = document.getElementById('scheduled-plugin-next');
            if (cronDisplay) cronDisplay.textContent = newCron;
            if (nextEl) nextEl.textContent = parseCronExpression(newCron);
            closeScheduledModal();
        } else {
            showToast('更新失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('更新 Cron 表达式失败:', error);
        showToast('更新失败: ' + error.message, 'error');
    }
}

/**
 * 立即执行插件更新
 */
async function runScheduledPluginNow() {
    showToast('正在检查插件更新...', 'info');
    try {
        // 获取通知设置
        const sendNotification = localStorage.getItem(NOTIFY_STORAGE_KEYS.plugin) === 'true';

        const response = await Auth.authenticatedFetch(`${API_BASE}/api/plugins/auto-update/trigger`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sendNotification })
        });
        const result = await response.json();

        if (result.success) {
            showToast(`插件更新完成: 成功 ${result.data.success.length} 个, 失败 ${result.data.failed.length} 个`, 'success');
            await loadScheduledPluginConfig();
        } else {
            showToast('更新失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('立即执行插件更新失败:', error);
        showToast('更新失败: ' + error.message, 'error');
    }
}

/**
 * 加载下载订阅配置
 */
async function loadScheduledSubscribeConfig() {
    try {
        const token = Auth.getToken();
        const response = await fetch(`${API_BASE}/api/subscribed-toplists/auto-update/config`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await response.json();

        const enabledCheckbox = document.getElementById('scheduled-subscribe-enabled');
        const cronDisplay = document.getElementById('scheduled-subscribe-cron-display');
        const nextEl = document.getElementById('scheduled-subscribe-next');
        const lastEl = document.getElementById('scheduled-subscribe-last');

        if (result.success && result.data) {
            const config = result.data;

            if (enabledCheckbox) {
                enabledCheckbox.checked = config.enabled === true;
            }
            if (cronDisplay) {
                cronDisplay.textContent = config.cronExpression || '0 0 * * *';
            }
            if (nextEl) {
                nextEl.textContent = parseCronExpression(config.cronExpression || '0 0 * * *');
            }
            if (lastEl) {
                lastEl.textContent = config.lastUpdateTime
                    ? new Date(config.lastUpdateTime).toLocaleString('zh-CN')
                    : '从未执行';
            }
        } else {
            if (enabledCheckbox) enabledCheckbox.checked = false;
            if (cronDisplay) cronDisplay.textContent = '0 0 * * *';
            if (nextEl) nextEl.textContent = '每天 00:00';
            if (lastEl) lastEl.textContent = '从未执行';
        }
    } catch (error) {
        console.error('加载下载订阅配置失败:', error);
    }
}

/**
 * 切换下载订阅开关
 */
async function toggleScheduledSubscribe(enabled) {
    try {
        const token = Auth.getToken();
        const cronDisplay = document.getElementById('scheduled-subscribe-cron-display');
        const cronExpression = cronDisplay ? cronDisplay.textContent.trim() : '0 0 * * *';

        const response = await fetch(`${API_BASE}/api/subscribed-toplists/auto-update/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ enabled, cronExpression })
        });

        const result = await response.json();

        if (result.success) {
            showToast(enabled ? '已启用下载订阅' : '已禁用下载订阅', 'success');
        } else {
            showToast('更新失败: ' + (result.error || '未知错误'), 'error');
            const checkbox = document.getElementById('scheduled-subscribe-enabled');
            if (checkbox) checkbox.checked = !enabled;
        }
    } catch (error) {
        console.error('切换下载订阅失败:', error);
        showToast('更新失败: ' + error.message, 'error');
        const checkbox = document.getElementById('scheduled-subscribe-enabled');
        if (checkbox) checkbox.checked = !enabled;
    }
}

/**
 * 编辑下载订阅规则
 */
function editScheduledSubscribeCron() {
    const cronDisplay = document.getElementById('scheduled-subscribe-cron-display');
    const currentCron = cronDisplay ? cronDisplay.textContent.trim() : '0 0 * * *';
    const isEnabled = document.getElementById('scheduled-subscribe-enabled')?.checked || false;

    const presets = [
        { label: '每小时', value: '0 * * * *' },
        { label: '每天0点', value: '0 0 * * *' },
        { label: '每天9点', value: '0 9 * * *' },
        { label: '每天10点', value: '0 10 * * *' },
        { label: '每天18点', value: '0 18 * * *' },
        { label: '每天22点', value: '0 22 * * *' },
        { label: '每周一', value: '0 0 * * 1' },
        { label: '每月1号', value: '0 0 1 * *' }
    ];

    const presetButtons = presets.map(p =>
        `<button class="cron-preset-btn" data-value="${p.value}" style="
            padding: 6px 12px;
            border: 1px solid var(--divider-color);
            background: var(--surface-color);
            color: var(--text-color);
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        ">${p.label}</button>`
    ).join('');

    const modalHtml = `
        <div style="
            background: var(--surface-color, #fff);
            border-radius: 12px;
            padding: 24px;
            max-width: 400px;
            width: 90%;
        ">
            <h3 style="margin: 0 0 20px 0; font-size: 18px;">编辑下载订阅规则</h3>
            <div style="margin-bottom: 16px; display: flex; flex-wrap: wrap; gap: 8px;">
                ${presetButtons}
            </div>
            <div style="margin-bottom: 20px;">
                <label style="display: block; margin-bottom: 8px; font-size: 14px; font-weight: 600;">Cron 表达式</label>
                <input type="text" id="scheduled-cron-input" class="form-input" value="${escapeHtml(currentCron)}" placeholder="0 0 * * *" style="width: 100%;">
                <div style="margin-top: 8px; font-size: 12px; color: var(--text-secondary);">
                    格式: 分 时 日 月 周
                </div>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 12px;">
                <button class="btn btn-secondary" onclick="closeScheduledModal(this)">取消</button>
                <button class="btn btn-primary" onclick="saveScheduledSubscribeCron('${isEnabled}')">确定</button>
            </div>
        </div>
    `;

    const overlay = document.createElement('div');
    overlay.id = 'scheduled-modal-overlay';
    overlay.style.cssText = `
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
    `;
    overlay.innerHTML = modalHtml;
    document.body.appendChild(overlay);

    overlay.querySelectorAll('.cron-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            overlay.querySelector('#scheduled-cron-input').value = btn.dataset.value;
        });
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeScheduledModal();
    });
}

/**
 * 保存下载订阅规则
 */
async function saveScheduledSubscribeCron(isEnabled) {
    const input = document.getElementById('scheduled-cron-input');
    const newCron = input ? input.value.trim() : '0 0 * * *';

    try {
        const token = Auth.getToken();
        const response = await fetch(`${API_BASE}/api/subscribed-toplists/auto-update/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ enabled: isEnabled === 'true', cronExpression: newCron })
        });

        const result = await response.json();

        if (result.success) {
            showToast('定时规则已更新', 'success');
            const cronDisplay = document.getElementById('scheduled-subscribe-cron-display');
            const nextEl = document.getElementById('scheduled-subscribe-next');
            if (cronDisplay) cronDisplay.textContent = newCron;
            if (nextEl) nextEl.textContent = parseCronExpression(newCron);
            closeScheduledModal();
        } else {
            showToast('更新失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('更新 Cron 表达式失败:', error);
        showToast('更新失败: ' + error.message, 'error');
    }
}

/**
 * 立即执行订阅下载（只下载，不同步）
 */
async function runScheduledSubscribeNow() {
    // 只显示一个开始弹窗
    showToast('开始下载订阅歌曲...', 'info');
    try {
        const token = Auth.getToken();

        // 获取通知设置
        const sendNotification = localStorage.getItem(NOTIFY_STORAGE_KEYS.subscribe) === 'true';

        // 调用统一下载API（下载所有启用的订阅）
        const response = await fetch(`${API_BASE}/api/subscribed-toplists/auto-update/trigger`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ sendNotification })
        });

        const result = await response.json();

        if (!result.success) {
            showToast('下载失败: ' + (result.error || '未知错误'), 'error');
            return;
        }

        const data = result.data;
        const totalSubscriptions = data.total || 0;
        const successCount = data.success || 0;
        const failedCount = data.failed || 0;
        const results = data.results || [];

        // 计算总统计 - 从嵌套的 download 字段读取
        const totalDownloaded = results.reduce((sum, r) => sum + (r.download?.downloaded || 0), 0);
        const totalSkipped = results.reduce((sum, r) => sum + (r.download?.skipped || 0), 0);
        const totalFailed = results.reduce((sum, r) => sum + (r.download?.failed || 0), 0);

        console.log(`[立即下载] 完成: ${totalSubscriptions}个订阅, 下载${totalDownloaded}首/跳过${totalSkipped}首/失败${totalFailed}首`);
        showToast(`下载完成！${successCount}个订阅成功/${failedCount}个失败`, 'success');

        await loadScheduledSubscribeConfig();

        // 更新上次执行时间显示
        const lastEl = document.getElementById('scheduled-subscribe-last');
        if (lastEl) {
            lastEl.textContent = new Date().toLocaleString('zh-CN');
        }
    } catch (error) {
        console.error('立即执行订阅下载失败:', error);
        showToast('下载失败: ' + error.message, 'error');
    }
}

/**
 * 关闭定时任务弹窗
 */
function closeScheduledModal(_btn) {
    const overlay = document.getElementById('scheduled-modal-overlay');
    if (overlay) {
        overlay.remove();
    }
}


// ==================== 定时任务通知功能 ====================

// 通知状态存储键
const NOTIFY_STORAGE_KEYS = {
    plugin: 'scheduled_plugin_notify_enabled',
    subscribe: 'scheduled_subscribe_notify_enabled',
};

/**
 * 加载所有通知按钮状态
 */
function loadScheduledNotifyStates() {
    // 插件通知状态
    const pluginBtn = document.getElementById('scheduled-plugin-notify-btn');
    const pluginEnabled = localStorage.getItem(NOTIFY_STORAGE_KEYS.plugin) === 'true';
    if (pluginBtn) {
        pluginBtn.style.background = pluginEnabled ? 'var(--primary-color)' : 'var(--surface-color)';
        pluginBtn.style.color = pluginEnabled ? '#fff' : 'var(--text-color)';
    }

    // 订阅通知状态
    const subscribeBtn = document.getElementById('scheduled-subscribe-notify-btn');
    const subscribeEnabled = localStorage.getItem(NOTIFY_STORAGE_KEYS.subscribe) === 'true';
    if (subscribeBtn) {
        subscribeBtn.style.background = subscribeEnabled ? 'var(--primary-color)' : 'var(--surface-color)';
        subscribeBtn.style.color = subscribeEnabled ? '#fff' : 'var(--text-color)';
    }

}

/**
 * 通用通知状态切换函数
 * @param {string} type - 通知类型 (plugin|subscribe)
 * @param {string} buttonId - 按钮ID
 * @param {string} messageEnabled - 启用时的提示消息
 * @param {string} messageDisabled - 禁用时的提示消息
 * @param {Function|null} saveToBackend - 保存到后端的函数（可选）
 */
async function toggleScheduledNotify(type, buttonId, messageEnabled, messageDisabled, saveToBackend = null) {
    const key = NOTIFY_STORAGE_KEYS[type];
    const current = localStorage.getItem(key) === 'true';
    const newValue = !current;
    localStorage.setItem(key, newValue.toString());

    // 更新按钮样式
    const btn = document.getElementById(buttonId);
    if (btn) {
        btn.style.background = newValue ? 'var(--primary-color)' : 'var(--surface-color)';
        btn.style.color = newValue ? '#fff' : 'var(--text-color)';
    }

    // 如果需要保存到后端
    if (saveToBackend) {
        try {
            await saveToBackend(newValue);
        } catch (error) {
            console.error(`保存${type}通知设置失败:`, error);
        }
    }

    showToast(newValue ? messageEnabled : messageDisabled, 'success');
}

/**
 * 切换插件更新通知状态
 */
function toggleScheduledPluginNotify() {
    toggleScheduledNotify(
        'plugin',
        'scheduled-plugin-notify-btn',
        '插件更新完成将发送通知',
        '已关闭插件更新通知'
    );
}

/**
 * 切换订阅更新通知状态
 */
function toggleScheduledSubscribeNotify() {
    toggleScheduledNotify(
        'subscribe',
        'scheduled-subscribe-notify-btn',
        '订阅更新完成将发送通知',
        '已关闭订阅更新通知'
    );
}

// 导出定时任务函数
window.loadScheduledTasks = loadScheduledTasks;
window.toggleScheduledPlugin = toggleScheduledPlugin;
window.editScheduledPluginCron = editScheduledPluginCron;
window.saveScheduledPluginCron = saveScheduledPluginCron;
window.runScheduledPluginNow = runScheduledPluginNow;
window.loadScheduledSubscribeConfig = loadScheduledSubscribeConfig;
window.toggleScheduledSubscribe = toggleScheduledSubscribe;
window.editScheduledSubscribeCron = editScheduledSubscribeCron;
window.saveScheduledSubscribeCron = saveScheduledSubscribeCron;
window.runScheduledSubscribeNow = runScheduledSubscribeNow;
window.closeScheduledModal = closeScheduledModal;
window.loadScheduledNotifyStates = loadScheduledNotifyStates;
window.toggleScheduledPluginNotify = toggleScheduledPluginNotify;
window.toggleScheduledSubscribeNotify = toggleScheduledSubscribeNotify;


