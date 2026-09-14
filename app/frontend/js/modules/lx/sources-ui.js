/**
 * 洛雪（LX）自定义音源 —— 设置页管理界面
 * ================================================================
 * 对应「系统设置 → LX 音源」标签页：
 *   导入（本地文件 / 网络地址 / 粘贴脚本）、启用停用、测试解析、重新加载、删除
 * 音源用于给 LX 专区的歌曲提供播放解析（musicUrl）。
 */

const LX_PLATFORM_NAMES = { kw: '酷我', kg: '酷狗', tx: 'QQ', wy: '网易云', mg: '咪咕', local: '本地' };

let lxSourceList = [];
let lxSourceMeta = null;

/** 平台 key 数组 → 中文名 */
function lxPlatformsText(platforms) {
    if (!Array.isArray(platforms) || !platforms.length) return '<span style="color: var(--text-tertiary);">未声明</span>';
    return platforms.map((p) => LX_PLATFORM_NAMES[p] || p).join('、');
}

function lxSourceStateHtml(s) {
    const map = {
        idle: ['未加载', 'var(--text-tertiary)'],
        loading: ['初始化中…', 'var(--text-secondary)'],
        ready: ['就绪', 'var(--primary-color)'],
        error: ['失败', 'var(--error-color, #e74c3c)'],
    };
    const [text, color] = map[s.state] || ['未知', 'var(--text-tertiary)'];
    const title = s.error ? ` title="${escapeHtml(s.error)}"` : '';
    return `<span style="color: ${color}; font-size: 13px;"${title}>${text}${s.error ? ' ⓘ' : ''}</span>`;
}

/** 加载并渲染音源列表 */
async function loadLxSources() {
    const tbody = document.getElementById('lx-source-table-body');
    // 容器缺失必须显式暴露：否则渲染静默失败，界面表现为「导入成功但列表一直是空的」
    if (!tbody) {
        console.warn('[LX 音源] 未找到列表容器 #lx-source-table-body');
        showToast('音源列表容器未找到，请强制刷新页面（Ctrl+F5）', 'error');
        try { API.logs.add('error', 'CLIENT', '[LX 音源] 未找到列表容器 #lx-source-table-body，可能是页面/样式缓存过期'); } catch { /* 日志失败不影响业务 */ }
        return;
    }
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-secondary);">加载中…</td></tr>';
    let r = null;
    try {
        r = await API.lx.getSources();
    } catch (e) {
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--error-color, #e74c3c);">请求失败：${escapeHtml(e && e.message)}</td></tr>`;
        }
        console.warn('[LX 音源] 列表请求失败', e);
        return;
    }
    // 业务失败（success:false）必须显式提示，避免"静默空列表"让人以为是没装成功
    if (r && r.success === false) {
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--error-color, #e74c3c);">加载失败：${escapeHtml(r.error || '未知错误')}</td></tr>`;
        }
        return;
    }
    lxSourceList = (r && r.data) || [];
    lxSourceMeta = (r && r.meta) || null;
    renderLxSources();
}

function renderLxSources() {
    const tbody = document.getElementById('lx-source-table-body');
    const empty = document.getElementById('lx-source-empty-state');
    if (!tbody) return;
    if (!lxSourceList.length) {
        tbody.innerHTML = '';
        if (empty) {
            empty.style.display = '';
            const tip = empty.querySelector('.empty-text');
            if (tip && lxSourceMeta && lxSourceMeta.dir) {
                tip.innerHTML = `暂无 LX 音源，点击上方按钮导入<br><span style="font-size:12px;color:var(--text-tertiary);">音源目录：${escapeHtml(lxSourceMeta.dir)}（磁盘上 ${(lxSourceMeta.diskFiles || []).length} 个 .js）</span>`;
            }
        }
        return;
    }
    if (empty) empty.style.display = 'none';
    tbody.innerHTML = lxSourceList.map((s) => {
        const meta = s.meta || {};
        const disabled = s.state === 'error' || !s.enabled;
        return `
        <tr>
            <td style="text-align:center;">
                <label class="plugin-toggle-switch" title="${s.enabled ? '点击停用' : '点击启用'}">
                    <input type="checkbox" ${s.enabled ? 'checked' : ''} onchange="lxToggleSource('${escapeHtml(s.file)}', this.checked)">
                    <span class="plugin-toggle-slider"></span>
                </label>
            </td>
            <td title="${escapeHtml(meta.description || '')}">${escapeHtml(meta.name || s.file)}</td>
            <td>${escapeHtml(meta.version || '-')}</td>
            <td>${escapeHtml(meta.author || '-')}</td>
            <td>${lxPlatformsText(s.platforms)}</td>
            <td>${lxSourceStateHtml(s)}${s.state === 'error' && s.error ? `<div title="${escapeHtml(String(s.error))}" style="margin-top:4px;font-size:11px;color:var(--text-tertiary);line-height:1.4;word-break:break-all;">${escapeHtml(String(s.error).slice(0, 220))}</div>` : ''}</td>
            <td>
                <button class="plugin-row-btn" onclick="lxTestSource('${escapeHtml(s.file)}')">测试解析</button>
                <button class="plugin-row-btn" onclick="lxReloadSource('${escapeHtml(s.file)}')">重新加载</button>
                <button class="plugin-row-btn" onclick="lxRemoveSource('${escapeHtml(s.file)}')">删除</button>
            </td>
        </tr>`;
    }).join('');
}

/** 启用 / 停用 */
async function lxToggleSource(file, enabled) {
    try {
        await API.lx.setSourceEnabled(file, !!enabled);
        showToast(enabled ? '已启用' : '已停用', 'success');
        await loadLxSources();
    } catch (e) {
        showToast('操作失败：' + (e && e.message), 'error');
        await loadLxSources();
    }
}

/** 重新加载（失败后重试初始化） */
async function lxReloadSource(file) {
    try {
        showToast('正在重新初始化音源…', 'info');
        await API.lx.reloadSource(file);
        setTimeout(loadLxSources, 800);
    } catch (e) {
        showToast('重新加载失败：' + (e && e.message), 'error');
    }
}

/** 删除 */
async function lxRemoveSource(file) {
    const ok = await Notification.confirm(`确定要删除音源「${file}」吗？`);
    if (!ok) return;
    try {
        await API.lx.removeSource(file);
        showToast('已删除', 'success');
        await loadLxSources();
    } catch (e) {
        showToast('删除失败：' + (e && e.message), 'error');
    }
}

/**
 * 测试解析：后端会先用该平台搜索一首歌作为样本，再试解析出播放地址
 */
async function lxTestSource(file) {
    const src = lxSourceList.find((s) => s.file === file);
    const platforms = (src && src.platforms) || [];
    if (!platforms.length) {
        showToast('该音源未声明任何可用平台，无法测试', 'warning');
        return;
    }
    const platform = platforms[0];
    showToast(`正在测试解析（${LX_PLATFORM_NAMES[platform] || platform}）…`, 'info');
    try {
        const r = await API.lx.testSource(file, platform, 'standard');
        if (r && r.success) {
            showToast(`解析成功：${r.data.sample || ''}`, 'success');
            console.log('[LX 音源测试] 播放地址：', r.data.url);
        } else {
            // 失败原因可能较长（含上游返回片段），完整版打到控制台便于排查
            const msg = (r && r.error) || '未知错误';
            console.warn('[LX 音源测试] 失败：', msg, r && r.data);
            showToast('解析失败：' + msg, 'error');
        }
    } catch (e) {
        showToast('测试失败：' + (e && e.message), 'error');
    }
}

// ==================== 导入 ====================

/** 粘贴脚本导入 */
function showLxSourcePaste() {
    const modal = document.getElementById('lx-source-import-modal');
    const field = document.getElementById('lx-source-import-field');
    const title = document.getElementById('lx-source-import-title');
    if (!modal || !field) return;
    if (title) title.textContent = '粘贴 LX 音源脚本';
    field.value = '';
    field.placeholder = '把落雪音乐的「自定义音源」脚本内容粘贴到这里…';
    modal.style.display = 'flex';
    window._lxImportMode = 'paste';
    setTimeout(() => field.focus(), 50);
}

/** 从网络地址导入 */
async function showLxSourceFromUrl() {
    const url = await Notification.prompt('请输入音源脚本地址（.js 直链）', '');
    if (!url) return;
    await lxImportSource({ url });
}

/** 从本地文件导入 */
function showLxSourceFromFile() {
    const input = document.getElementById('lx-source-file-input');
    if (input) input.click();
}

async function onLxSourceFilePicked(input) {
    const f = input && input.files && input.files[0];
    if (!f) return;
    try {
        const text = await f.text();
        await lxImportSource({ content: text, fileName: f.name });
    } catch (e) {
        showToast('读取文件失败：' + (e && e.message), 'error');
    } finally {
        input.value = '';
    }
}

/** 提交粘贴的脚本 */
async function submitLxSourcePaste() {
    const field = document.getElementById('lx-source-import-field');
    const content = field ? field.value : '';
    if (!content.trim()) {
        showToast('请先粘贴音源脚本内容', 'warning');
        return;
    }
    await lxImportSource({ content });
}

function closeLxSourceImportModal() {
    const modal = document.getElementById('lx-source-import-modal');
    if (modal) modal.style.display = 'none';
}

/** 统一导入入口 */
async function lxImportSource(payload) {
    try {
        showToast('正在导入音源…', 'info');
        const r = await API.lx.addSource(payload);
        if (r && r.success) {
            closeLxSourceImportModal();
            const d = (r && r.data) || {};
            if (d.renamed) {
                // 同名文件不覆盖：自动另存为新音源，多个音源在列表中并排共存
                showToast(`导入成功，同名文件已另存为「${d.renamed}」`, 'success');
            } else {
                showToast('导入成功，正在初始化…', 'success');
            }
            await loadLxSources();
            // 初始化是异步的，稍后再刷新一次状态
            setTimeout(loadLxSources, 1500);
        } else {
            showToast('导入失败：' + ((r && r.error) || '未知错误'), 'error');
        }
    } catch (e) {
        showToast('导入失败：' + (e && e.message), 'error');
    }
}

// ==================== 导出到全局 ====================
window.loadLxSources = loadLxSources;
window.renderLxSources = renderLxSources;
window.lxToggleSource = lxToggleSource;
window.lxReloadSource = lxReloadSource;
window.lxRemoveSource = lxRemoveSource;
window.lxTestSource = lxTestSource;
window.showLxSourcePaste = showLxSourcePaste;
window.showLxSourceFromUrl = showLxSourceFromUrl;
window.showLxSourceFromFile = showLxSourceFromFile;
window.submitLxSourcePaste = submitLxSourcePaste;
window.closeLxSourceImportModal = closeLxSourceImportModal;
window.onLxSourceFilePicked = onLxSourceFilePicked;
