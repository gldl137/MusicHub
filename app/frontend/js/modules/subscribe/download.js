/**
 * 订阅下载模块 - 重写版
 * 参考歌曲界面下载实现，支持选中多个下载
 */

/**
 * 开始批量下载（手动下载）
 * 使用 DownloadCore.downloadBatch
 * 注意：手动下载同样应用「下载排除」规则（见下方 applyExcludeFilter 与 runSubscriptionDownloadWithBtn）。
 */
// ============ 前端排除过滤（与后端 subscription-download.js 保持一致）============
const LANG_ALIASES_FE = {
    english: ['english', '英文', '英语', 'eng', 'en'],
    japanese: ['japanese', '日文', '日语', 'jp', 'ja'],
    korean: ['korean', '韩文', '韩语', 'kr', 'ko'],
    chinese: ['chinese', '中文', '华语', '国语', '普通话', 'cmn', 'zh'],
    cantonese: ['cantonese', '粤语', '粤文', 'yue', 'ct']
};
const ALIAS_TO_TAG_FE = {};
for (const [tag, aliases] of Object.entries(LANG_ALIASES_FE))
    for (const a of aliases) ALIAS_TO_TAG_FE[a] = tag;
function normalizeLangTagFE(raw) {
    return ALIAS_TO_TAG_FE[String(raw || '').trim().toLowerCase()] || null;
}
function detectSongLangTagsFE(language, title) {
    const tags = new Set();
    const lang = String(language || '').toLowerCase();
    const titleStr = String(title || '');
    for (const aliases of Object.values(LANG_ALIASES_FE))
        for (const a of aliases)
            if (lang.includes(a)) { const t = normalizeLangTagFE(a); if (t) tags.add(t); }
    const hasHangul = /[가-힣]/u.test(titleStr);
    const hasKana = /[ぁ-ゖァ-ヺ]/u.test(titleStr);
    const hasHan = /[一-鿿]/u.test(titleStr);
    const cjkCount = (titleStr.match(/[一-鿿ぁ-ゖァ-ヺ가-힣]/gu) || []).length;
    const latinCount = (titleStr.match(/[A-Za-z]/gu) || []).length;
    if (hasHangul) tags.add('korean');
    if (hasKana) tags.add('japanese');
    if (hasHan && !hasKana && !hasHangul) tags.add('chinese');
    if (latinCount > 0 && cjkCount === 0) tags.add('english');
    return tags;
}
// 对该订阅应用排除过滤（仅当订阅开启过滤）
function applyExcludeFilter(songs, subscription) {
    if (subscription.exclude_enabled === 0) return songs;
    let settings = {};
    try { settings = JSON.parse(localStorage.getItem('download_settings') || '{}'); } catch (e) { settings = {}; }
    const excludeArtists = (settings.excludeArtists || []).map(a => String(a).trim().toLowerCase()).filter(Boolean);
    const excludeLanguages = (settings.excludeLanguages || []).map(l => String(l).trim().toLowerCase()).filter(Boolean);
    if (excludeArtists.length === 0 && excludeLanguages.length === 0) return songs;
    const excludeLangTags = new Set(excludeLanguages.map(normalizeLangTagFE).filter(Boolean));
    return songs.filter(s => {
        const artist = String(s.artist || '').toLowerCase();
        if (excludeArtists.some(n => artist.includes(n))) return false;
        const tags = detectSongLangTagsFE(s.language, s.title);
        if ([...tags].some(t => excludeLangTags.has(t))) return false;
        return true;
    });
}

function startBatchDownload(songs, _subscription) {
    if (!window.DownloadCore) {
        showToast('下载组件未初始化', 'error');
        return;
    }

    const songsToDownload = (songs || []);

    if (songsToDownload.length === 0) {
        showToast('没有可下载的歌曲', 'info');
        return;
    }

    // 构建下载参数
    const downloadParams = songsToDownload.map(song => ({
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        plugin: song.plugin || song.platform,
        quality: song.quality || 'standard'
    }));

    const source = _subscription?.title || '订阅下载';

    // 使用批量下载
    if (window.DownloadCore.downloadBatch) {
        window.DownloadCore.downloadBatch(downloadParams, { delay: 500 }, source);
    } else {
        // 降级方案：逐个调用 startBackendDownload
        songsToDownload.forEach((song, index) => {
            setTimeout(() => {
                if (window.DownloadCore && typeof window.DownloadCore.startBackendDownload === 'function') {
                    window.DownloadCore.startBackendDownload(song, source);
                } else {
                    console.error('[ButtonActions] DownloadCore 不可用');
                }
            }, index * 500);
        });
    }
}

/**
 * 显示任务进度弹窗
 * @param {Array} tasks - 任务数组
 * @param {string} title - 弹窗标题
 */
function showTaskProgressModal(tasks, title = '下载进度') {
    // 检查是否已存在弹窗
    let modal = document.getElementById('task-progress-modal');
    if (modal) {
        modal.remove();
    }

    modal = document.createElement('div');
    modal.id = 'task-progress-modal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
    `;

    const total = tasks.length;
    
    modal.innerHTML = `
        <div style="
            background: var(--surface-color);
            border-radius: 12px;
            width: 90%;
            max-width: 500px;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        ">
            <div style="
                padding: 16px 20px;
                border-bottom: 1px solid var(--divider-color);
                display: flex;
                justify-content: space-between;
                align-items: center;
            ">
                <h3 style="margin: 0; font-size: 16px;">${title}</h3>
                <span id="task-progress-count" style="font-size: 13px; color: var(--text-secondary);">0/${total}</span>
            </div>
            <div id="task-progress-list" style="
                flex: 1;
                overflow-y: auto;
                padding: 12px;
                max-height: 400px;
            ">
                ${tasks.map((task, i) => `
                    <div id="task-item-${i}" style="
                        padding: 10px;
                        margin-bottom: 8px;
                        background: var(--bg-secondary);
                        border-radius: 6px;
                        display: flex;
                        align-items: center;
                        gap: 10px;
                    ">
                        <span id="task-status-${i}" style="font-size: 16px;">⏳</span>
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                ${escapeHtml(task.title || task.id)}
                            </div>
                            <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
                                ${escapeHtml(task.artist || '-')}
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
            <div style="
                padding: 12px 20px;
                border-top: 1px solid var(--divider-color);
                display: flex;
                justify-content: flex-end;
            ">
                <button onclick="closeTaskProgressModal()" style="
                    padding: 8px 16px;
                    border: 1px solid var(--border-color);
                    background: var(--surface-color);
                    color: var(--text-color);
                    border-radius: 4px;
                    cursor: pointer;
                ">关闭</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // 点击遮罩关闭
    modal.onclick = (e) => {
        if (e.target === modal) closeTaskProgressModal();
    };
}

/**
 * 关闭任务进度弹窗
 */
function closeTaskProgressModal() {
    const modal = document.getElementById('task-progress-modal');
    if (modal) modal.remove();
}

/**
 * 更新任务进度
 * @param {number} index - 任务索引
 * @param {string} status - 状态: 'pending' | 'success' | 'error'
 * @param {string} message - 状态消息
 */
function updateTaskProgress(index, status, message = '') {
    const statusEl = document.getElementById(`task-status-${index}`);
    if (!statusEl) return;

    const icons = {
        pending: '⏳',
        success: '✅',
        error: '❌'
    };

    statusEl.textContent = icons[status] || '⏳';
    if (message) {
        statusEl.title = message;
    }

    // 更新计数
    const total = document.querySelectorAll('[id^="task-item-"]').length;
    const completed = document.querySelectorAll('[id^="task-status-"]').filter(el => 
        el.textContent === '✅' || el.textContent === '❌'
    ).length;
    
    const countEl = document.getElementById('task-progress-count');
    if (countEl) {
        countEl.textContent = `${completed}/${total}`;
    }
}

/**
 * 带按钮的订阅下载（用于榜单卡片）
 * @param {HTMLElement} btn - 按钮元素
 * @param {string} platform - 平台
 * @param {string} toplistId - 榜单ID
 * @param {string} encodedTitle - 标题（已编码）
 */
async function runSubscriptionDownloadWithBtn(btn, platform, toplistId, _encodedTitle) {
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span>准备中...</span>';
    }

    try {
        const token = Auth.getToken();

        // 1. 获取订阅信息
        const subResponse = await fetch(`${API_BASE}/api/subscribed-toplists`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const subResult = await subResponse.json();

        if (!subResult.success) {
            throw new Error('获取订阅列表失败');
        }

        const subscription = subResult.data.find(s =>
            s.platform === platform && s.toplist_id === toplistId
        );

        if (!subscription) {
            throw new Error('未找到订阅信息');
        }

        // 2. 调用后端订阅下载接口（内部会回写 downloaded_count / total_songs 统计）
        //    不传 force：已下载的歌曲会被识别为 alreadyDownloaded，秒级返回且不重复下载。
        if (btn) {
            btn.innerHTML = '<span>下载中...</span>';
        }
        showToast('正在下载订阅歌曲（后端执行）...', 'info');

        const dlResponse = await fetch(`${API_BASE}/api/subscribed-toplists/${subscription.id}/download`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ force: false })
        });
        const dlResult = await dlResponse.json();
        if (!dlResult.success) {
            throw new Error(dlResult.error || '下载失败');
        }

        const data = dlResult.data || {};
        showToast(
            `下载完成：成功 ${data.downloaded || 0}，已存在 ${data.alreadyDownloaded || 0}，失败 ${data.failed || 0}`,
            data.failed > 0 ? 'error' : 'success'
        );

        // 3. 刷新订阅列表卡片，使 downloaded_count 等统计立即反映
        if (window.loadSubscribedToplists && typeof window.loadSubscribedToplists === 'function') {
            window.loadSubscribedToplists();
        }

    } catch (error) {
        console.error('[subscribe/download] 下载失败:', error);
        showToast(`下载失败: ${error.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                </svg>
                <span>下载</span>
            `;
        }
    }
}

// 导出到全局
window.runSubscriptionDownloadWithBtn = runSubscriptionDownloadWithBtn;
window.showTaskProgressModal = showTaskProgressModal;
window.closeTaskProgressModal = closeTaskProgressModal;
window.updateTaskProgress = updateTaskProgress;
