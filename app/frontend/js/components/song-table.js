/**
 * 歌曲表格组件
 * 统一渲染歌曲列表表格和顶部操作按钮
 * 基于 playlist-detail-table 样式
 */

// ===== 表格分页全局偏好（各页面 SongTable 分页共用：每页条数统一记忆） =====
const SONGTABLE_PAGE_SIZE_KEY = 'mh_table_page_size';
const SONGTABLE_PAGE_SIZES = [20, 50, 100, 200, 500];

/** 读取全局每页条数（非法值回退 50） */
function getSongTablePageSize() {
    const v = parseInt(localStorage.getItem(SONGTABLE_PAGE_SIZE_KEY), 10);
    return SONGTABLE_PAGE_SIZES.includes(v) ? v : 50;
}

/** 保存全局每页条数 */
function setSongTablePageSize(n) {
    const v = parseInt(n, 10);
    if (SONGTABLE_PAGE_SIZES.includes(v)) {
        try { localStorage.setItem(SONGTABLE_PAGE_SIZE_KEY, String(v)); } catch { /* 忽略存储异常 */ }
    }
}

const SongTable = {
    // Hero 封面加载失败时的默认图（内嵌 SVG：深灰渐变 + 音符，不依赖外网）
    DEFAULT_HERO_COVER: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">'
        + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
        + '<stop offset="0" stop-color="#2e2e30"/><stop offset="1" stop-color="#18181a"/>'
        + '</linearGradient></defs>'
        + '<rect width="400" height="400" fill="url(#g)"/>'
        + '<text x="200" y="235" font-size="110" text-anchor="middle">🎵</text>'
        + '</svg>'
    ),

    /**
     * 渲染歌曲表格（带顶部操作按钮）
     * @param {Object} config - 配置对象
     * @param {Array} config.songs - 歌曲数组
     * @param {HTMLElement} config.container - 容器元素
     * @param {string} config.pageId - 页面ID，用于区分不同实例
     * @param {string} config.title - 标题（可选）
     * @param {string} config.subtitle - 副标题，如"10 首歌曲"（可选）
     * @param {Array} config.actions - 顶部操作按钮配置
     *   - icon: SVG字符串
     *   - text: 按钮文字
     *   - primary: 是否主按钮（绿色）
     *   - onClick: 点击回调函数
     *   - disabled: 是否禁用
     *   - align: 'left'|'right' 对齐方式，默认left
     * @param {Array} config.columns - 要显示的列，默认全部
     *   可选: ['checkbox', 'favorite', 'download', 'add', 'index', 'title', 'artist', 'album', 'year', 'duration', 'source']
     * @param {Object} config.events - 事件回调
     *   - onPlay: 点击行播放 (song, index) => {}   // index 为传入 songs 数组内的索引
     *   - onFavorite: 点击收藏 (song, index) => {}
     *   - onDownload: 点击下载 (song, index) => {}
     *   - onSelectChange: 选择框变化 (selectedIndices) => {}
     * @param {boolean} config.showHeader - 是否显示标题头部，默认true
     * @param {Function} config.onBack - 返回按钮回调，有则显示返回按钮
     * @param {number} config.indexOffset - 行号偏移（分页时显示全局序号，如第3页50条从101开始）
     * @param {Object} config.pagination - 分页配置（可选，不传则不分页）
     *   - page: 当前页（1起）
     *   - pageSize: 每页条数
     *   - total: 总条数（同时用于「共 N 首」统计）
     *   - pageSizes: 每页条数可选项，默认 [20, 50, 100, 200, 500]
     *   - onPageChange: (page) => {}
     *   - onPageSizeChange: (size) => {}
     */
        async render(config) {
            const {
                songs = [],
                container,
                pageId = 'song-table',
                title = '',
                subtitle = '',
                actions = [],
                columns = ['checkbox', 'favorite', 'download', 'index', 'title', 'artist', 'album', 'duration', 'source'],
                events = {},
                showHeader = true,
                onBack = null,
                indexOffset = 0,
                pagination = null,
                hero = null,
                rowMenu = null,
                titleCover = null,
                showLocalBadge = true
            } = config;

        if (!container) {
            console.error('SongTable: container is required');
            return;
        }

        // 存储配置供后续使用
        // hero.manageMenu：收进「管理」弹出菜单的按钮（不在按钮行显示），合并进 actions 供回调查找
        const manageMenuActions = (hero && hero.manageMenu) || [];
        const mergedActions = manageMenuActions.length ? [...actions, ...manageMenuActions] : actions;
        this._configs = this._configs || {};
        this._configs[pageId] = { songs, events, columns, actions: mergedActions };
        // 行尾「⋯」菜单项：[{ label, onClick(index) }]
        this._rowMenuItems = rowMenu || [];
        // 行尾「⋯」菜单项：[{ label, onClick(index) }]
        this._rowMenuItems = rowMenu || [];
        // 启用行菜单时自动补 more 列
        if (this._rowMenuItems.length && !columns.includes('more')) {
            columns = columns.concat(['more']);
        }
        // 分页回调（pageId 隔离，供翻页/改每页条数时调用）
        this._pagination = this._pagination || {};
        this._pagination[pageId] = pagination || null;

        // 监听下载状态变化事件（实时更新下载按钮）
        this._initDownloadStatusListener(pageId);

        const hasSongs = songs && songs.length > 0;

        // 构建操作按钮HTML
        // Hero 模式下「播放」「下载」按钮单独提取（渲染为信息区内的大胶囊按钮），不进入常规按钮行
        const isHero = !!hero;
        const leftActions = actions.filter(a => a.align !== 'right' && !(isHero && /^(播放|下载)/.test((a.text || '').trim())));
        const rightActions = actions.filter(a => a.align === 'right');

        const buildActionBtn = (btn) => {
            // 「播放」按钮不使用绿色主按钮样式（去掉绿底），其余 primary 主按钮不受影响
            const isPlay = /^播放/.test((btn.text || '').trim());
            const usePrimary = !!btn.primary && !isPlay;
            const useDanger = !!btn.danger;
            const bgStyle = useDanger
                ? 'background: transparent; color: var(--danger-color, #ff4757); border: 1px solid var(--danger-color, #ff4757);'
                : (usePrimary
                    ? 'background: var(--primary-color); color: white; border: none;'
                    : 'background: var(--surface-color); color: var(--text-color); border: 1px solid var(--border-color);');
            const disabledAttr = btn.disabled ? 'disabled' : '';
            const onclick = btn.onClick ? `SongTable._handleAction('${pageId}', '${btn.id}')` : '';
            return `
                <button class="btn ${usePrimary ? 'btn-primary' : 'btn-secondary'}" 
                        ${onclick ? `onclick="${onclick}"` : ''} 
                        ${disabledAttr}
                        style="display: flex; align-items: center; gap: 4px; padding: 3px 14px; border-radius: 16px; font-size: 12px; ${bgStyle} cursor: pointer; opacity: ${btn.disabled ? '0.5' : '1'};">
                    <span style="display: flex; align-items: center;">${btn.icon}</span> ${btn.text}
                </button>
            `;
        };

        const leftActionsHtml = leftActions.map(buildActionBtn).join('');
        const rightActionsHtml = rightActions.map(buildActionBtn).join('');

        // 手机端操作栏收纳：按钮宽度不够时，仅保留前两个按钮（播放/添加），
        // 其余按钮（下载/订阅/清空/删除等）收进「更多」下拉菜单
        const isMobileView = window.innerWidth <= 768;
        let visibleLeftActions = leftActions;
        let moreActions = [];
        if (isMobileView && (leftActions.length + rightActions.length) > 2) {
            visibleLeftActions = leftActions.slice(0, 2);
            moreActions = [...leftActions.slice(2), ...rightActions];
        }
        const visibleLeftHtml = visibleLeftActions.map(buildActionBtn).join('');
        const moreBtnHtml = moreActions.length ? `
            <button class="btn btn-secondary" id="st-more-btn" title="更多操作"
                    onclick="event.stopPropagation(); SongTable.toggleMoreMenu('${pageId}')"
                    style="display: flex; align-items: center; gap: 4px; padding: 3px 14px; border-radius: 16px; font-size: 12px; background: var(--surface-color); color: var(--text-color); border: 1px solid var(--border-color); cursor: pointer;">
                更多
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
            </button>
        ` : '';
        const moreMenuHtml = moreActions.length ? `
            <div class="st-more-menu" id="st-more-menu-${pageId}"
                 style="display: none; position: absolute; right: 0; top: calc(100% + 6px); min-width: 160px; max-height: 60vh; overflow-y: auto; background: var(--surface-color); border: 1px solid var(--divider-color); border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.25); z-index: 1001; padding: 6px 0;">
                ${moreActions.map(btn => `
                    <button ${btn.disabled ? 'disabled' : ''}
                            onclick="event.stopPropagation(); ${btn.onClick ? `SongTable._handleAction('${pageId}', '${btn.id}');` : ''} SongTable.hideMoreMenu('${pageId}')"
                            style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: ${btn.danger ? 'var(--danger-color, #ff4757)' : 'var(--text-color)'}; font-size: 13px; cursor: pointer; text-align: left; opacity: ${btn.disabled ? '0.5' : '1'};">
                        <span style="display: flex; align-items: center; width: 16px; flex-shrink: 0;">${btn.icon}</span>
                        ${this._escapeHtml(btn.text || '')}
                    </button>
                `).join('')}
            </div>
        ` : '';

        // 构建头部
        let headerHtml = '';
        if (showHeader) {
            headerHtml = `
                <div class="playlist-detail-header" style="padding: 16px 20px; border-bottom: 1px solid var(--divider-color); flex-shrink: 0;">
                    <div style="display: flex; gap: 16px; align-items: center;">
                        ${onBack ? `
                        <button onclick="${onBack}" class="btn-icon" style="width: 32px; height: 32px; border-radius: 50%; border: none; background: var(--surface-color); color: var(--text-color); cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                        </button>
                        ` : ''}
                        <div style="flex: 1; min-width: 0;">
                            ${title ? `<h2 style="margin: 0 0 4px 0; font-size: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${title}</h2>` : ''}
                            ${subtitle ? `<p style="margin: 0; color: var(--text-tertiary); font-size: 12px;">${subtitle}</p>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }

        // 构建操作栏（分页时统计显示过滤后的总数而非当前页条数）
        const totalCount = (pagination && typeof pagination.total === 'number') ? pagination.total : songs.length;
        const songCountHtml = hasSongs ? `<span style="color: var(--text-tertiary); font-size: 13px; display: flex; align-items: center;">共 ${totalCount} 首</span>` : '';

        // Hero 头部（Apple Music 风格：左侧大封面 + 右侧标签/标题/信息，操作按钮放在封面旁边）
        let heroHtml = '';
        if (hero) {
            const coverInner = hero.cover
                ? `<img src="${this._escapeHtml(hero.cover)}" alt="" style="width: 100%; height: 100%; object-fit: cover; display: block;" onerror="this.onerror=null; this.src=SongTable.DEFAULT_HERO_COVER;">`
                : '';
            // 播放 + 下载大胶囊按钮（参考 Apple Music「试听」按钮：白底黑字，位于信息区底部并排）
            const playAction = actions.find(a => /^播放/.test((a.text || '').trim()));
            const downloadAction = actions.find(a => /^下载/.test((a.text || '').trim()));
            const m = isMobileView;
            // 管理模式（存在「完成」按钮时）：「下载(N)/删除(N)/完成」按钮渲染进 Hero 按钮行
            const heroManageMode = actions.some(a => (a.id || '') === 'manage-done');
            const heroCtaBtn = (act, primary) => act ? `
                <button ${act.disabled ? 'disabled' : ''} title="${this._escapeHtml(act.text || '')}"
                        onclick="SongTable._handleAction('${pageId}', '${act.id}')"
                        style="display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: ${m ? '11px 28px' : '6px 18px'}; min-width: ${m && primary ? '150px' : 'auto'}; border-radius: 999px; ${primary ? 'background: var(--text-color); color: var(--background-color); border: none;' : 'background: transparent; color: var(--text-color); border: 1px solid var(--border-color);'} font-size: ${m ? '15px' : '13px'}; font-weight: 600; cursor: pointer; opacity: ${act.disabled ? '0.5' : '1'}; box-shadow: ${primary && m ? '0 6px 18px rgba(0,0,0,0.3)' : 'none'};">
                    <span style="display: flex; align-items: center;">${act.icon}</span>${this._escapeHtml(act.text || '')}
                </button>
            ` : '';
            // 随机按钮：描边胶囊（带「随机」文字）；手机端稍小（与「歌单」按钮同级，播放为主按钮）
            const randomBtnHtml = !heroManageMode && hero.onRandom ? `
                <button type="button" title="随机播放" onclick="${hero.onRandom}"
                        style="display: inline-flex; align-items: center; justify-content: center; gap: 6px; ${m ? 'padding: 9px 16px; font-size: 13px;' : 'padding: 6px 18px; font-size: 13px;'} border-radius: 999px; ${m ? 'background: rgba(0,0,0,0.25); color: #fff; border: 1px solid rgba(255,255,255,0.6);' : 'background: var(--bg-secondary); color: var(--text-color); border: 1px solid var(--border-color);'} font-weight: 600; cursor: pointer; flex-shrink: 0;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>随机
                </button>
            ` : '';
            // Hero 按钮行：渲染除「播放」（单独大胶囊）外的全部操作按钮（添加/下载/删除/完成等）；
            // hero.manageMenu 配置的按钮收进「管理」弹出菜单（如本地详情的添加到歌单/删除）
            const manageMenuItems = hero.manageMenu || [];
            const manageMenuIds = new Set(manageMenuItems.map(a => a.id || ''));
            const heroManageHtml = actions
                .filter(a => !manageMenuIds.has(a.id || '') && !/^播放/.test((a.text || '').trim()))
                .map(a => heroCtaBtn(a, false)).join('')
                + (manageMenuItems.length ? `
                    <div class="hero-manage-pop" style="position: relative; display: inline-flex;">
                        <button type="button"
                            onclick="event.stopPropagation(); const p = this.parentElement.querySelector('.hero-manage-menu'); if (p) p.style.display = p.style.display === 'block' ? 'none' : 'block';"
                            style="display: inline-flex; align-items: center; gap: 6px; padding: ${m ? '9px 16px' : '6px 18px'}; border-radius: 999px; background: transparent; color: var(--text-color); border: 1px solid var(--border-color); font-size: 13px; font-weight: 600; cursor: pointer;">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                            管理
                        </button>
                        <div class="hero-manage-menu"
                            style="display: none; position: absolute; right: 0; bottom: calc(100% + 8px); min-width: 160px; background: var(--surface-color); border: 1px solid var(--divider-color); border-radius: 10px; box-shadow: var(--shadow-lg); z-index: 1003; padding: 6px 0; overflow: hidden;">
                            ${manageMenuItems.map(a => `
                                <button type="button"
                                    onclick="event.stopPropagation(); SongTable._handleAction('${pageId}', '${a.id}'); const p = this.closest('.hero-manage-pop'); if (p) p.querySelector('.hero-manage-menu').style.display = 'none';"
                                    style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: ${a.danger ? 'var(--danger-color, #ff4d4f)' : 'var(--text-color)'}; font-size: 14px; cursor: pointer; text-align: left; white-space: nowrap;">${this._escapeHtml(a.text || '')}</button>
                            `).join('')}
                        </div>
                    </div>
                ` : '');
            // 返回按钮：全项目统一样式（.btn-back，见 layout.css：半透明圆底 + 灰色图标）
            const backBtnHtml = hero.onBack ? `
                <button class="btn-back" onclick="${hero.onBack}" title="返回">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
                </button>
            ` : '';
            // 手机端：返回 + 播放 + 随机 同一行（位于封面下方）
            const mobileActionsHtml = m ? `
                <div style="margin-top: 12px; display: flex; gap: 10px; align-items: center;">
                    ${backBtnHtml}
                    ${heroCtaBtn(playAction, true)}
                    ${hero.onRandom ? `
                    <button type="button" title="随机播放" onclick="${hero.onRandom}"
                        style="display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 50%; background: transparent; color: var(--text-color); border: 1px solid var(--border-color); cursor: pointer;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
                    </button>` : ''}
                </div>
            ` : '';
            // 手机端 Hero 按钮行：随机 / 播放 / 歌单（+其它操作）等宽等高、随屏宽自适应。
            // 全部使用独立内联样式（不复用桌面端按钮构造、不依赖外部 CSS），保证三键严格等分
            const mRandomSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>';
            const mBtnStyle = (primary) => `flex: 1 1 0; min-width: 0; width: 100%; box-sizing: border-box; height: 44px; padding: 0 10px; border-radius: 999px; display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 15px; font-weight: 600; white-space: nowrap; cursor: pointer; ${primary
                ? 'background: var(--text-color); color: var(--background-color); border: none; box-shadow: 0 6px 18px rgba(0,0,0,0.3);'
                : 'background: rgba(0,0,0,0.25); color: #fff; border: 1px solid rgba(255,255,255,0.6);'}`;
            const mColStyle = 'flex: 1 1 0; min-width: 0; display: flex;';
            const mobileRowHtml = m ? `
                <div style="width: 100%; margin-top: 14px; display: flex; align-items: stretch; gap: 10px; flex-wrap: nowrap;">
                    ${hero.onRandom ? `
                    <div style="${mColStyle}">
                        <button type="button" title="随机播放" onclick="${hero.onRandom}" style="${mBtnStyle(false)}">${mRandomSvg}随机</button>
                    </div>` : ''}
                    ${playAction ? `
                    <div style="${mColStyle}">
                        <button ${playAction.disabled ? 'disabled' : ''} title="${this._escapeHtml(playAction.text || '')}" onclick="SongTable._handleAction('${pageId}', '${playAction.id}')" style="${mBtnStyle(true)}${playAction.disabled ? ' opacity: 0.5;' : ''}"><span style="display: flex; align-items: center;">${playAction.icon}</span>${this._escapeHtml(playAction.text || '')}</button>
                    </div>` : ''}
                    ${actions.filter(a => !manageMenuIds.has(a.id || '') && !/^播放/.test((a.text || '').trim())).map(a => `
                    <div style="${mColStyle}">
                        <button ${a.disabled ? 'disabled' : ''} title="${this._escapeHtml(a.text || '')}" onclick="SongTable._handleAction('${pageId}', '${a.id}')" style="${mBtnStyle(false)}${a.disabled ? ' opacity: 0.5;' : ''}"><span style="display: flex; align-items: center;">${a.icon || ''}</span>${this._escapeHtml(a.text || '')}</button>
                    </div>`).join('')}
                    ${manageMenuItems.length ? `
                    <div style="${mColStyle}">${heroManageHtml}</div>` : ''}
                </div>
            ` : '';
            // 桌面端：按钮排在封面侧（右列底部）：返回、播放、随机、歌单（带文字，靠左小间隔）
            // 条件含 heroManageHtml：管理模式无播放按钮时（添加到歌单/删除/完成）也要渲染按钮行
            const heroCtaHtml = !m && (playAction || hero.onBack || hero.onRandom || heroManageHtml) ? `
                <div style="margin-top: auto; padding-top: 14px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                    ${backBtnHtml}
                    ${heroCtaBtn(playAction, true)}
                    ${randomBtnHtml}
                    ${heroManageHtml}
                </div>
            ` : '';
            heroHtml = m ? `
                <div class="playlist-hero" style="padding: 0; flex-shrink: 0; position: relative; overflow: hidden;">
                    <div style="position: absolute; inset: 0; background: var(--bg-tertiary); -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 55%, rgba(0,0,0,0.55) 78%, transparent 97%); mask-image: linear-gradient(180deg, #000 0%, #000 55%, rgba(0,0,0,0.55) 78%, transparent 97%);">
                        ${hero.cover ? `<img src="${this._escapeHtml(hero.cover)}" alt="" style="width: 100%; height: 100%; object-fit: cover; display: block;" onerror="this.onerror=null; this.src=SongTable.DEFAULT_HERO_COVER;">` : ''}
                        <div class="hero-fade-overlay" style="position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0.12) 0%, rgba(0,0,0,0.2) 42%, rgba(0,0,0,0.35) 100%);"></div>
                    </div>
                    <div style="position: relative; padding: 160px 16px 18px; display: flex; flex-direction: column; gap: 6px; align-items: center; text-align: center;">
                        ${hero.title ? `<div style="font-size: 20px; font-weight: 700; line-height: 1.3; color: #fff; text-shadow: 0 1px 4px rgba(0,0,0,.4); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">${this._escapeHtml(hero.title)}</div>` : ''}
                        ${hero.meta ? `<div style="font-size: 11px; color: rgba(255,255,255,0.75);">${hero.meta}</div>` : ''}
                        ${mobileRowHtml}
                    </div>
                    <div style="position: relative;">
                        ${moreMenuHtml}
                    </div>
                </div>
            ` : `
                <div class="playlist-hero" style="padding: 12px 32px 12px; flex-shrink: 0;">
                    <div style="display: flex; gap: 20px; align-items: stretch;">
                        <div style="width: 220px; height: 220px; flex-shrink: 0; border-radius: 8px; overflow: hidden; background: var(--bg-tertiary); box-shadow: var(--shadow-lg); display: flex; align-items: center; justify-content: center; font-size: 44px; color: var(--text-tertiary);">
                            ${coverInner}${hero.cover ? '' : '🎵'}
                        </div>
                        <div style="flex: 1; min-width: 0; display: flex; flex-direction: column;">
                            <div style="flex: 1; display: flex; flex-direction: column; gap: 6px; justify-content: center;">
                                ${hero.tag ? `<div style="font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: var(--primary-color);">${this._escapeHtml(hero.tag)}</div>` : ''}
                                ${hero.title ? `<div style="font-size: 18px; font-weight: 700; line-height: 1.3; color: var(--text-color); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">${this._escapeHtml(hero.title)}</div>` : ''}
                                ${hero.meta ? `<div style="font-size: 12px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${hero.meta}</div>` : ''}
                            </div>
                            ${heroCtaHtml}
                        </div>
                    </div>
                    <div style="position: relative;">
                        ${moreMenuHtml}
                    </div>
                </div>
            `;
            // 手机端：用封面主色给整页染色（跨域封面走后端代理取色，异步不阻塞渲染）
            if (m && hero.cover) {
                this._extractHeroAccent(hero.cover, pageId);
            }
        }

        const actionsHtml = (leftActionsHtml || rightActionsHtml) ? `
            <div class="playlist-detail-actions" style="padding: 12px 0; border-bottom: 1px solid var(--divider-color); display: flex; gap: 8px; flex-shrink: 0; justify-content: space-between; position: relative;">
                <div style="display: flex; gap: 8px; align-items: center;">${visibleLeftHtml}${moreBtnHtml}</div>
                <div style="display: flex; gap: 8px; align-items: center;">${isMobileView ? '' : rightActionsHtml}${songCountHtml}</div>
                ${moreMenuHtml}
            </div>
        ` : '';

        // 构建表格头部
        const thMap = {
            checkbox: '<th class="col-checkbox"><input type="checkbox" id="select-all"></th>',
            favorite: '<th class="col-favorite"></th>',
            download: '<th class="col-download"></th>',
            index: '<th class="col-index">#</th>',
            title: '<th class="col-title">歌曲</th>',
            artist: '<th class="col-artist">艺人</th>',
            album: '<th class="col-album">专辑</th>',
            year: '<th class="col-year">年份</th>',
            duration: '<th class="col-duration">时长</th>',
            source: '<th class="col-source">来源</th>',
            more: '<th class="col-more"></th>'
        };
        const theadHtml = `<thead><tr>${columns.map(col => thMap[col] || '').join('')}</tr></thead>`;

        // 构建表格内容
        let tbodyHtml = '<tbody>';
        if (hasSongs) {
            songs.forEach((song, index) => {
                const itemPlugin = song.plugin || song.platform || '';
                // 比较ID和平台，确保是同一首歌曲
                const currentId = window.currentMusic?.id;
                const currentPlugin = window.currentMusic?.plugin || window.currentMusic?.platform || '';
                const isPlaying = currentId === song.id && currentPlugin === itemPlugin;
                

                
                const rowClass = isPlaying ? 'playing' : '';

                // 收藏状态
                const isFavorited = window.FavoriteManager?.isFavoritedSync(song) || false;
                const favIcon = isFavorited
                    ? '<svg viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
                    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

                // 下载状态
                // 下载状态不再在渲染时获取，改为点击时实时查询数据库
                let downloadClass = '';
                let downloadIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
                // 下载页面的歌曲保持下载图标但变色
                const isDownloadPage = pageId === 'download';
                if (isDownloadPage) {
                    downloadClass = 'downloaded'; // 只变色，不换图标
                }
                // 其他页面的下载状态在点击时实时查询，不在渲染时判断

                // 来源
                let sourceText;
                const isStrm = typeof isStrmSong === 'function'
                    ? isStrmSong(song)
                    : (song.isStrm || (song.realMediaUri && (song.plugin === 'local' || song.platform === 'local')));
                if (isStrm) {
                    sourceText = 'STRM';
                } else if (itemPlugin === 'local') {
                    sourceText = '本地';
                } else if (itemPlugin === 'radio') {
                    sourceText = song.sourcePlugin || '电台';
                } else if (typeof getMusicSourceText === 'function') {
                    // 统一走取名逻辑（传歌曲对象）：音源别名-插件名；落雪也能带上实际音源脚本名
                    sourceText = getMusicSourceText(song) || '-';
                } else {
                    const plugin = window.installedPlugins?.find(p => p.name === itemPlugin);
                    sourceText = plugin?.platform || itemPlugin.slice(0, 4) || '-';
                }

                // 构建每一列
                const tdMap = {
                    checkbox: `<td class="col-checkbox">
                        <input type="checkbox" class="row-checkbox" data-index="${index}">
                    </td>`,
                    favorite: `<td class="col-favorite" onclick="event.stopPropagation();">
                        <button class="action-btn ${isFavorited ? 'favorited' : ''}"
                                onclick="event.stopPropagation(); SongTable._handleFavorite('${pageId}', ${index})"
                                title="${isFavorited ? '取消收藏' : '收藏'}">
                            ${favIcon}
                        </button>
                    </td>`,
                    download: `<td class="col-download" onclick="event.stopPropagation();">
                        <button class="action-btn download-btn ${downloadClass}"
                                data-music-id="${this._escapeHtml(song.id)}"
                                data-plugin="${this._escapeHtml(itemPlugin)}"
                                onclick="event.stopPropagation(); SongTable._handleDownload('${pageId}', ${index})"
                                title="${downloadClass === 'downloaded' ? '已下载' : (downloadClass === 'downloading' ? '下载中...' : '下载')}">
                            ${downloadIcon}
                        </button>
                    </td>`,
                    index: `<td class="col-index">${indexOffset + index + 1}</td>`,
                    title: (() => {
                        const titleText = this._escapeHtml(song.title || '未知歌曲');
                        const artistText = this._escapeHtml(song.artist || '');
                        // 未配置 titleCover（如下载管理纯展示列表）：不渲染封面，直接歌名
                        if (!titleCover) {
                            return `<td class="col-title" title="${titleText}"><div class="title-cell"><div class="title-lines"><span class="title-text">${titleText}</span></div></div></td>`;
                        }
                        let coverUrl = titleCover(song) || '';
                        // 本地歌曲 tr- 与网络歌曲 coverArt 的封面统一走 /api/cover?id=...（后端实时解析 / 磁盘 webp），
                        // 不在渲染时立即请求，改为 data-cover 交给 CoverLazy 在进入视口时懒加载，并发受控。
                        const coverImg = `<img class="row-cover lazy-cover" data-song-idx="${index}" data-cover="${this._escapeHtml(coverUrl || '')}" data-default="${this.DEFAULT_HERO_COVER}" alt="" decoding="async">`;
                        const artistRow = artistText ? `<span class="title-artist">${artistText}</span>` : '';
                        return `<td class="col-title" title="${titleText}"><div class="title-cell">${coverImg}<div class="title-lines"><span class="title-text">${titleText}</span>${artistRow}</div></div></td>`;
                    })(),
                    artist: `<td class="col-artist" title="${this._escapeHtml(song.artist || '未知歌手')}">${this._escapeHtml(song.artist || '未知歌手')}</td>`,
                    album: `<td class="col-album" title="${this._escapeHtml(song.album || '未知专辑')}">${this._escapeHtml(song.album || '未知专辑')}</td>`,
                    year: `<td class="col-year" title="${this._escapeHtml(song.year ? String(song.year) : '')}">${song.year ? this._escapeHtml(String(song.year)) : '-'}</td>`,
                    duration: `<td class="col-duration">${this._formatDuration(song.duration)}</td>`,
                    source: `<td class="col-source"><span class="source-tag" title="${this._escapeHtml(sourceText)}">${this._escapeHtml(sourceText)}</span></td>`,
                    more: `<td class="col-more" onclick="event.stopPropagation(); SongTable.toggleRowMenu('${pageId}', ${index}, event)">
                        <button type="button" class="row-more-btn" title="更多操作">⋯</button>
                    </td>`
                };

                // 如果有播放事件，添加可点击样式
                const rowStyle = events.onPlay ? 'cursor: pointer;' : '';
                tbodyHtml += `<tr class="${rowClass}" data-index="${index}" data-id="${this._escapeHtml(song.id)}" style="${rowStyle}">
                    ${columns.map(col => tdMap[col] || '').join('')}
                </tr>`;
            });
        }
        tbodyHtml += '</tbody>';

        // 空状态
        const emptyHtml = !hasSongs ? `
            <div class="empty-state" style="padding: 60px 20px; text-align: center;">
                <div class="empty-icon" style="font-size: 48px; margin-bottom: 16px;">🎵</div>
                <div class="empty-text" style="font-size: 16px; color: var(--text-secondary); margin-bottom: 8px;">暂无歌曲</div>
            </div>
        ` : '';

        // 构建分页条（配置了 pagination 即常显，无论是否只有一页）
        let paginationHtml = '';
        if (pagination && typeof pagination.total === 'number') {
            paginationHtml = this._buildPaginationHtml(pageId, pagination);
        }

        // 组装HTML（歌单详情整页滚动模式下由 CSS 覆盖 height，此处保留 flex 结构）
        const html = `
            <div class="playlist-detail" style="height: 100%; display: flex; flex-direction: column;" data-page-id="${pageId}">
                ${headerHtml}
                ${heroHtml}
                ${hero ? '' : actionsHtml}
                <div class="playlist-songs" style="flex: 1; overflow: hidden; padding: 0;">
                    ${hasSongs ? `
                    <div class="playlist-detail-table-wrapper" style="height: 100%; overflow: auto;">
                        <table class="playlist-detail-table">
                            ${theadHtml}
                            ${tbodyHtml}
                        </table>
                    </div>
                    ` : emptyHtml}
                </div>
                ${paginationHtml}
            </div>
        `;

        container.innerHTML = html;

        // 「本地 ✓」徽标：批量匹配本地曲库并标注来源列（SongTable 所有列表页通用；showLocalBadge: false 关闭）
        if (hasSongs && showLocalBadge) LocalBadge.apply(container, songs).catch(() => {});

        // 行内封面懒加载：只有进入视口的封面才请求 /api/cover，并发受控（CoverLazy）
        // 替代原先「渲染即请求 + 失败走插件补全」逻辑，彻底消除长列表封面请求风暴
        if (hasSongs && titleCover && window.CoverLazy) {
            window.CoverLazy.scan(container);
        }

        // 异步更新下载按钮状态（根据实际下载情况）
        if (hasSongs && window.DownloadManager?.checkIsDownloaded) {
            setTimeout(async () => {
                songs.forEach(async (song) => {
                    const itemPlugin = song.plugin || song.platform || '';
                    if (!itemPlugin) return;

                    const isDownloaded = await window.DownloadManager.checkIsDownloaded(song, itemPlugin);
                    if (isDownloaded) {
                        const btn = container.querySelector(`button[data-music-id="${song.id}"][data-plugin="${itemPlugin}"].download-btn`);
                        if (btn) {
                            btn.classList.add('downloaded');
                            btn.title = '已下载';
                        }
                    }
                });
            }, 100);
        }

        // 绑定行点击事件（播放）
        if (events.onPlay) {
            const rows = container.querySelectorAll('tbody tr');
            rows.forEach((row) => {
                row.addEventListener('click', (e) => {
                    // 如果点击的是按钮或复选框，不触发播放
                    if (e.target.closest('button') || e.target.closest('input[type="checkbox"]')) {
                        return;
                    }
                    const index = parseInt(row.dataset.index);
                    if (!isNaN(index)) {
                        this._handlePlay(pageId, index);
                    }
                });
            });
        }

        // 绑定复选框事件
        const checkboxes = container.querySelectorAll('.row-checkbox');
        checkboxes.forEach((cb) => {
            cb.addEventListener('change', (e) => {
                e.stopPropagation();
                const index = parseInt(cb.dataset.index);
                this._toggleRowSelect(pageId, index);
                
                // 直接更新行样式
                const row = cb.closest('tr');
                if (row) {
                    row.classList.toggle('selected', cb.checked);
                }
            });
        });

        // 绑定全选复选框事件
        const selectAll = container.querySelector('#select-all');
        if (selectAll) {
            selectAll.addEventListener('change', (_e) => {
                const allCheckboxes = container.querySelectorAll('.row-checkbox');
                allCheckboxes.forEach((cb) => {
                    cb.checked = selectAll.checked;
                    const row = cb.closest('tr');
                    if (row) {
                        row.classList.toggle('selected', selectAll.checked);
                    }
                });
                
                const config = this._configs?.[pageId];
                if (config?.events?.onSelectChange) {
                    const selectedIndices = selectAll.checked 
                        ? Array.from({length: allCheckboxes.length}, (_, i) => i)
                        : [];
                    config.events.onSelectChange(selectedIndices);
                }
            });
        }

        // 延迟刷新下载按钮状态（等待 DownloadManager 初始化完成）
        if (pageId !== 'download') {
            setTimeout(async () => {
                await this.updateDownloadButtons(pageId);
                this.updateFavoriteButtons(pageId);
            }, 500);
        }

    },

    /**
     * 更新指定页面所有收藏按钮的状态
     * @param {string} pageId - 页面ID
     */
    updateFavoriteButtons(pageId) {
        const container = document.querySelector(`[data-page-id="${pageId}"]`);
        if (!container) return;

        const config = this._configs?.[pageId];
        if (!config || !config.songs) return;

        config.songs.forEach((song, index) => {
            const isFavorited = window.FavoriteManager?.isFavoritedSync(song);
            
            const row = container.querySelector(`tr[data-index="${index}"]`);
            if (!row) return;
            
            const favBtn = row.querySelector('.col-favorite .action-btn');
            if (!favBtn) return;

            if (isFavorited) {
                favBtn.classList.add('favorited');
                favBtn.title = '取消收藏';
                // 更新图标为填充红色
                favBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
            } else {
                favBtn.classList.remove('favorited');
                favBtn.title = '收藏';
                // 更新图标为空心
                favBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
            }
        });
    },

    /**
     * 行尾「⋯」菜单：弹出收藏 / 下载等操作项
     */
    toggleRowMenu(pageId, index, event) {
        const items = this._rowMenuItems || [];
        // 已打开则收起（重新弹出）
        const old = document.getElementById('st-row-menu');
        if (old) old.remove();
        if (!items.length) return;

        const menu = document.createElement('div');
        menu.id = 'st-row-menu';
        menu.style.cssText = 'position: fixed; z-index: 1002; min-width: 130px; background: var(--surface-color); border: 1px solid var(--divider-color); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.25); padding: 5px 0;';
        items.forEach((it) => {
            const b = document.createElement('button');
            b.type = 'button';
            // 动态标签：label 支持函数（传入歌曲对象），显示「已收藏」等状态
            const rowSong = this._configs?.[pageId]?.songs?.[index];
            b.textContent = typeof it.label === 'function' ? (it.label(rowSong, index) || '') : (it.label || '');
            b.style.cssText = 'display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 14px; border: none; background: transparent; color: var(--text-color); font-size: 13px; cursor: pointer; text-align: left;';
            // 下载项：打开菜单时实时查询下载状态，已下载则显示「已下载」
            if (it.dynamicDownload && rowSong && typeof window.DownloadManager?.checkIsDownloaded === 'function') {
                b.textContent = '下载';
                window.DownloadManager.checkIsDownloaded(rowSong, rowSong.plugin || rowSong.platform)
                    .then((downloaded) => { if (downloaded) b.textContent = '已下载'; })
                    .catch(() => {});
            }
            b.onmouseenter = () => { b.style.background = 'var(--bg-tertiary);'; };
            b.onmouseleave = () => { b.style.background = 'transparent;'; };
            b.onclick = (ev) => {
                ev.stopPropagation();
                menu.remove();
                if (it.onClick) it.onClick(index);
            };
            menu.appendChild(b);
        });
        document.body.appendChild(menu);

        const r = event.currentTarget.getBoundingClientRect();
        menu.style.top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8) + 'px';
        menu.style.left = Math.max(8, Math.min(r.left - menu.offsetWidth + r.width, window.innerWidth - menu.offsetWidth - 8)) + 'px';
        setTimeout(() => {
            document.addEventListener('click', () => menu.remove(), { once: true });
            document.addEventListener('scroll', () => menu.remove(), { once: true, capture: true });
        }, 0);
    },

    /**
     * 更新指定页面所有下载按钮的状态
     * @param {string} pageId - 页面ID
     */
    async updateDownloadButtons(pageId) {
        const container = document.querySelector(`[data-page-id="${pageId}"]`);
        if (!container) return;

        const config = this._configs?.[pageId];
        if (!config || !config.songs) return;

        // 下载状态不再在渲染时同步，改为点击时实时查询
        // 如需显示下载状态，需要在渲染后异步获取
    },

    /**
     * 从服务器同步下载状态到 StateManager（已弃用）
     * @param {Array} songs - 歌曲列表
     */
    async syncDownloadStatusFromServer(_songs) {
        // 下载状态只在点击时实时查询，不再批量同步
        // 如需恢复批量同步，请参考 git 历史
    },

    /**
     * 获取选中的歌曲
     * @param {string} pageId - 页面ID
     * @returns {Array} 选中的歌曲数组
     */
    getSelectedSongs(pageId) {
        const config = this._configs?.[pageId];
        if (!config) return [];

        const container = document.querySelector(`[data-page-id="${pageId}"]`);
        if (!container) return [];

        const checkboxes = container.querySelectorAll('.row-checkbox:checked');
        const indices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.index));

        return indices.map(index => config.songs[index]).filter(Boolean);
    },

    /**
     * 获取选中的索引
     * @param {string} pageId - 页面ID
     * @returns {Array} 选中的索引数组
     */
    getSelectedIndices(pageId) {
        const container = document.querySelector(`[data-page-id="${pageId}"]`);
        if (!container) return [];

        const checkboxes = container.querySelectorAll('.row-checkbox:checked');
        return Array.from(checkboxes).map(cb => parseInt(cb.dataset.index));
    },

    /**
     * 更新指定行的收藏状态
     * @param {string} pageId - 页面ID
     * @param {number} index - 行索引
     * @param {boolean} isFavorited - 是否已收藏
     */
    updateFavoriteStatus(pageId, index, isFavorited) {
        const container = document.querySelector(`[data-page-id="${pageId}"]`);
        if (!container) return;

        const row = container.querySelector(`tr[data-index="${index}"]`);
        if (!row) return;

        const favBtn = row.querySelector('.col-favorite .action-btn');
        if (!favBtn) return;

        const favIcon = isFavorited
            ? '<svg viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

        favBtn.innerHTML = favIcon;
        favBtn.classList.toggle('favorited', isFavorited);
        favBtn.title = isFavorited ? '取消收藏' : '收藏';
    },

    /**
     * 更新指定行的下载状态
     * @param {string} pageId - 页面ID
     * @param {number} index - 行索引
     * @param {boolean} isDownloaded - 是否已下载
     */
    updateDownloadStatus(pageId, index, isDownloaded) {
        const container = document.querySelector(`[data-page-id="${pageId}"]`);
        if (!container) return;

        const row = container.querySelector(`tr[data-index="${index}"]`);
        if (!row) return;

        const dlBtn = row.querySelector('.col-download .action-btn');
        if (!dlBtn) return;

        const dlIcon = isDownloaded
            ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';

        dlBtn.innerHTML = dlIcon;
        dlBtn.classList.toggle('downloaded', isDownloaded);
        dlBtn.title = isDownloaded ? '已下载' : '下载';
    },

    /**
     * 更新所有表格的播放状态
     * 当歌曲播放变化时调用此方法
     */
    updateAllPlayingState() {
        const currentId = window.currentMusic?.id;
        const currentPlugin = window.currentMusic?.plugin || window.currentMusic?.platform || '';
        
        // 如果没有表格配置，直接返回
        if (!this._configs) {
            return;
        }
        
        // 遍历所有已渲染的表格
        Object.keys(this._configs).forEach(pageId => {
            const container = document.querySelector(`[data-page-id="${pageId}"]`);
            if (!container) return;
            
            const config = this._configs[pageId];
            if (!config || !config.songs) return;
            
            // 移除所有行的 playing 状态
            const rows = container.querySelectorAll('tbody tr');
            rows.forEach(row => {
                row.classList.remove('playing');
            });
            
            // 找到当前播放的歌曲并添加 playing 状态
            config.songs.forEach((song, index) => {
                const itemPlugin = song.plugin || song.platform || '';
                if (currentId === song.id && currentPlugin === itemPlugin) {
                    const row = container.querySelector(`tr[data-index="${index}"]`);
                    if (row) {
                        row.classList.add('playing');
                    }
                }
            });
        });
    },

    // ========== 内部方法 ==========

    /**
     * 构建分页条 HTML：每页条数选择 + 页码（含省略号）+ 上一页/下一页
     * 翻页/改条数通过 SongTable._gotoPage / _changePageSize 中转调用回调
     */
    _buildPaginationHtml(pageId, pagination) {
        const total = pagination.total;
        const pageSizes = Array.isArray(pagination.pageSizes) && pagination.pageSizes.length
            ? pagination.pageSizes : [20, 50, 100, 200, 500];
        const pageSize = pagination.pageSize || 50;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(Math.max(1, pagination.page || 1), totalPages);

        // 页码序列：首尾保留 + 当前页 ±2 窗口 + 省略号
        const pages = [];
        const pushPage = (p) => { if (!pages.includes(p)) pages.push(p); };
        pushPage(1);
        // 手机端只显示首页和尾页页码，中间用省略号（如 1 … 8）
        if (window.innerWidth <= 768) {
            if (totalPages > 1) pushPage(totalPages);
        } else {
            for (let p = page - 2; p <= page + 2; p++) {
                if (p > 1 && p < totalPages) pushPage(p);
            }
            if (totalPages > 1) pushPage(totalPages);
        }
        pages.sort((a, b) => a - b);
        let pageBtns = '';
        pages.forEach((p, i) => {
            if (i > 0 && p - pages[i - 1] > 1) pageBtns += '<span class="st-page-ellipsis">…</span>';
            pageBtns += `<button type="button" class="st-page-btn ${p === page ? 'active' : ''}"
                onclick="SongTable._gotoPage('${pageId}', ${p})">${p}</button>`;
        });

        const sizeOptions = pageSizes.map((s) =>
            `<option value="${s}" ${s === pageSize ? 'selected' : ''}>${s} 条/页</option>`
        ).join('');

        return `
            <div class="st-pagination">
                <span class="st-page-total">共 ${total} 条</span>
                <select class="st-page-size" onchange="SongTable._changePageSize('${pageId}', parseInt(this.value, 10))">${sizeOptions}</select>
                <div class="st-page-btns">
                    <button type="button" class="st-page-btn nav" ${page <= 1 ? 'disabled' : ''}
                        onclick="SongTable._gotoPage('${pageId}', 1)" title="首页">«</button>
                    <button type="button" class="st-page-btn nav" ${page <= 1 ? 'disabled' : ''}
                        onclick="SongTable._gotoPage('${pageId}', ${page - 1})" title="上一页">‹</button>
                    ${pageBtns}
                    <button type="button" class="st-page-btn nav" ${page >= totalPages ? 'disabled' : ''}
                        onclick="SongTable._gotoPage('${pageId}', ${page + 1})" title="下一页">›</button>
                    <button type="button" class="st-page-btn nav" ${page >= totalPages ? 'disabled' : ''}
                        onclick="SongTable._gotoPage('${pageId}', ${totalPages})" title="尾页">»</button>
                </div>
            </div>
        `;
    },

    _gotoPage(pageId, page) {
        const pagination = this._pagination?.[pageId];
        if (!pagination || typeof pagination.onPageChange !== 'function') return;
        pagination.onPageChange(page);
    },

    _changePageSize(pageId, size) {
        const pagination = this._pagination?.[pageId];
        if (!pagination || typeof pagination.onPageSizeChange !== 'function' || !size) return;
        pagination.onPageSizeChange(size);
    },

    _handleAction(pageId, actionId) {
        const config = this._configs?.[pageId];
        if (!config) return;

        const action = config.actions?.find(a => a.id === actionId);
        if (action && action.onClick) {
            // 详情页「播放」= 顺序播放：先关闭随机（与「随机」按钮的 enableShuffleMode 对称），
            // 播放器上的随机按钮同步熄灭；「随机」按钮走 hero.onRandom，由各自模块负责开启随机。
            if (actionId === 'play' && typeof window.disableShuffleMode === 'function') {
                window.disableShuffleMode();
            }
            action.onClick();
        }
    },

    // 从 Hero 封面吸取主色，把整个页面背景染成「封面色 → 页面底色」渐变（仅手机端 Hero 调用）
    // 跨域封面无法直接读像素，走后端 /api/proxy/image 图片代理同源化后再取色
    _extractHeroAccent(coverUrl, pageId) {
        if (!coverUrl) return;
        const apply = (r, g, b) => {
            const page = document.querySelector(`.playlist-detail[data-page-id="${pageId}"]`);
            if (!page) return;
            // 手机端：向上/向两侧扩展抵消滚动容器留白——染色铺满全屏，页头毛玻璃透出封面色调。
            // 通用：取页面顶部与最近滚动容器可视顶的间距（各详情页容器结构不同，统一按实测偏移）。
            const area = page.closest('.content-area');
            if (area && window.innerWidth <= 768) {
                const cs = getComputedStyle(area);
                const px = parseFloat(cs.paddingLeft) || 0;
                // 最近滚动祖先（toplist-content / recommend-content / content-area 等）
                let scroller = null;
                for (let n = page.parentElement; n && n !== document.body; n = n.parentElement) {
                    const s = getComputedStyle(n);
                    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) { scroller = n; break; }
                }
                let topGap = parseFloat(cs.paddingTop) || 0;
                if (scroller) {
                    topGap = Math.max(0, Math.round(page.getBoundingClientRect().top - scroller.getBoundingClientRect().top));
                }
                page.style.marginLeft = -px + 'px';
                page.style.marginRight = -px + 'px';
                page.style.paddingLeft = px + 'px';
                page.style.paddingRight = px + 'px';
                page.style.marginTop = -topGap + 'px';
                page.style.paddingTop = topGap + 'px';
                // 供 Hero 反向扩展：封面背景图铺满全宽并顶到页头底部（抵消容器的补偿内边距）
                page.style.setProperty('--page-pad-x', px + 'px');
                page.style.setProperty('--page-pad-y', topGap + 'px');
            }
            // 整页染色：封面色缓慢衰减，滑动多屏后才融入底色
            page.style.background = `linear-gradient(180deg, rgb(${r}, ${g}, ${b}) 0%, rgba(${r}, ${g}, ${b}, 0.8) 500px, rgba(${r}, ${g}, ${b}, 0.55) 1300px, rgba(${r}, ${g}, ${b}, 0.3) 2400px, rgba(${r}, ${g}, ${b}, 0.12) 3400px, var(--background-color) 4200px)`;
            // 页头跟随染色（半透明毛玻璃透出封面色调）；离开详情/切换页面时由 switchPage 清除
            document.documentElement.style.setProperty('--header-bg', `rgba(${r}, ${g}, ${b}, 0.32)`);
            // Hero 底部渐隐层：直接写入具体颜色（部分内核不支持渐变内用变量），末端透明与页面染色无缝衔接
            const fade = page.querySelector('.hero-fade-overlay');
            if (fade) {
                fade.style.background = `linear-gradient(180deg, rgba(0, 0, 0, 0.12) 0%, rgba(0, 0, 0, 0.2) 42%, rgba(${r}, ${g}, ${b}, 0.6) 74%, rgba(${r}, ${g}, ${b}, 0) 100%)`;
            }
        };
        (async () => {
            try {
                let img;
                if (coverUrl.startsWith('/') || coverUrl.startsWith(window.location.origin + '/')) {
                    img = await this._loadImage(coverUrl);
                } else {
                    // 走带缓存的统一签名入口：与封面加载共享 token，滚动长列表时同一封面只签一次
                    const proxyUrl = await signProxyUrl(coverUrl, 'image');
                    img = await this._loadImage(proxyUrl);
                }
                const rgb = this._sampleImageColor(img);
                if (rgb) apply(rgb[0], rgb[1], rgb[2]);
            } catch (e) {
                // 取色失败（签名被拒/网络错误/图片损坏）静默降级为默认背景
            }
        })();
    },

    _loadImage(src) {
        return new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = reject;
            im.src = src;
        });
    },

    _sampleImageColor(img) {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 24;
            canvas.height = 24;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, 24, 24);
            const d = ctx.getImageData(0, 0, 24, 24).data;
            let r = 0, g = 0, b = 0, n = 0;
            for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
            r /= n; g /= n; b /= n;
            // 压暗到适合深色界面的亮度（最大分量上限 115），保留封面色相
            const max = Math.max(r, g, b);
            const scale = max > 115 ? 115 / max : 1;
            return [Math.round(r * scale), Math.round(g * scale), Math.round(b * scale)];
        } catch (e) {
            return null;
        }
    },

    // ==================== 行内封面插件补全 ====================
    // 行内 /api/cover 失败或无 URL 时，复用播放器已验证的链路：
    // 插件 getMusicInfo → 插件 search（标题+歌手）→ 把封面 URL 直接写回 <img>
    _coverEnrichCache: new Map(),   // key: plugin|id -> url（空串表示已确认取不到，不重试）
    _coverEnrichInflight: new Set(),// 正在获取中的 key（防止滚动重复渲染导致重复请求）
    _coverEnrichQueue: [],
    _coverEnrichActive: 0,
    _COVER_ENRICH_CONCURRENCY: 4,

    _enrichRowCover(pageId, index) {
        const config = this._configs?.[pageId];
        const song = config?.songs?.[index];
        if (!song) return;
        const plugin = song.plugin || song.platform || '';
        // 本地歌曲（tr- id 或 local 插件）无插件封面链路：封面失败直接用默认占位，
        // 不发 music-info / search 请求（本地插件不支持，且会产生大量无效请求拖垮内存）
        if ((song.id && String(song.id).startsWith('tr-')) || plugin === 'local') return;
        // 落雪（LX）歌曲同理：走自定义音源，封面由 /api/cover?id=lx_xx 提供，
        // 调 MusicFree 插件接口只会得到「Plugin file not found: lx:xx」
        if (typeof isLxPlugin === 'function' && isLxPlugin(plugin)) return;
        // plugin 为空的插件歌曲也允许补全：直接走「封面获取」辅助插件（key 用 @aux 前缀区分）
        const key = `${plugin || '@aux'}|${song.id}`;
        if (this._coverEnrichCache.has(key)) {
            const cached = this._coverEnrichCache.get(key);
            if (cached) this._setRowCover(pageId, index, cached);
            return;
        }
        if (this._coverEnrichInflight.has(key) || this._coverEnrichQueue.some(j => j.key === key)) return;
        this._coverEnrichInflight.add(key);
        // 快照歌曲 id：补全期间列表可能翻页/重绘，回填前需校验该行仍是同一首歌（防封面张冠李戴）
        this._coverEnrichQueue.push({ pageId, index, key, songId: song.id });
        this._drainCoverQueue();
    },

    async _drainCoverQueue() {
        if (this._coverEnrichActive >= this._COVER_ENRICH_CONCURRENCY) return;
        const job = this._coverEnrichQueue.shift();
        if (!job) return;
        this._coverEnrichActive++;
        try {
            const config = this._configs?.[job.pageId];
            const song = config?.songs?.[job.index];
            if (song) {
                const plugin = song.plugin || song.platform;
                let url = null;
                // 1) 本插件 getMusicInfo 实时取歌曲信息（内含封面）
                if (plugin) {
                    try {
                        const info = await API.music.getMusicInfo(song, plugin);
                        const d = (info && info.success && info.data) ? info.data : (info && info.data === undefined ? info : null);
                        url = d ? (d.artwork || d.pic || d.cover || d.image || d.img || d.coverUrl || null) : null;
                    } catch (e) { url = null; }
                }
                // 2) 优先用「封面获取」辅助插件：独立接口、专用于封面，稳定且不给音源插件
                //    自身搜索接口造成请求压力（此前酷我插件搜索接口被批量补全压出 403 风控）
                if (!url) url = await this._coverFromAuxPlugin(song);
                // 3) 辅助插件不可用/没补到：回退本插件 search 按「标题+歌手」搜索取封面
                if (!url && plugin) {
                    try {
                        const query = `${song.title || ''} ${song.artist || ''}`.trim();
                        const sres = await API.music.search(query, 'music', plugin, 1);
                        // /api/search 返回 {success, data: 插件原始对象}，歌曲数组在 data.data（也可能直接是数组）
                        const raw = (sres && sres.success) ? sres.data : sres;
                        const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []);
                        for (const item of list) {
                            const c = item && (item.artwork || item.cover || item.pic || item.image || item.img || item.coverUrl);
                            if (c) { url = c; break; }
                        }
                    } catch (e) { url = null; }
                }
                this._coverEnrichCache.set(job.key, url || '');
                if (this._coverEnrichCache.size > 2000) {
                    // 简易 FIFO 上限：避免长会话下缓存无界增长
                    this._coverEnrichCache.delete(this._coverEnrichCache.keys().next().value);
                }
                // 回填前校验该行仍是同一首歌（补全期间可能已翻页/重绘，防封面张冠李戴）
                const cur = config && config.songs ? config.songs[job.index] : null;
                if (url && cur && String(cur.id) === String(job.songId)) {
                    this._setRowCover(job.pageId, job.index, url);
                }
            }
        } catch (e) { /* 单个失败不影响队列 */ }
        finally {
            this._coverEnrichInflight.delete(job.key);
            this._coverEnrichActive--;
            this._drainCoverQueue();
        }
    },

    /**
     * 3) 辅助补全：用「封面获取」插件（酷我封面专用，platform 固定名）按「标题+歌手」搜索，
     *    取搜索结果里的封面直链。本插件没返回封面时兜底。
     * @returns {Promise<string|null>} 封面 URL（取不到返回 null）
     */
    async _coverFromAuxPlugin(song) {
        try {
            const aux = (window.installedPlugins || []).find((p) => p && p.platform === '酷我封面获取' && p.enabled !== false);
            if (!aux) return null;
            const query = `${song.title || ''} ${song.artist || ''}`.trim();
            if (!query) return null;
            const sres = await API.music.search(query, 'music', aux.name, 1);
            const raw = (sres && sres.success) ? sres.data : sres;
            const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []);
            for (const item of list) {
                const c = item && (item.artwork || item.cover || item.pic || item.image || item.img || item.coverUrl);
                if (c) return c;
            }
        } catch (e) { /* 辅助插件失败不影响主链路 */ }
        return null;
    },

    _setRowCover(pageId, index, url) {
        const page = document.querySelector(`[data-page-id="${pageId}"]`);
        if (!page) return;
        const img = page.querySelector(`img.row-cover[data-song-idx="${index}"]`);
        if (!img) return;
        // 防盗链图床（kuwo/kugou/qq/163 等）的直链必须走服务器代理，否则浏览器直连常被
        // Referer 校验拦截成破图（与 CoverLazy 的 hotlink 规则一致）；代理失败回退直连再占位
        const hotlink = /^https?:\/\//i.test(url)
            && /(kuwo|kugou|\.kg|\.qq\.com|y\.qq|yqq|163\.com|netease|migu|douyin|douban|bilibili|bili)/i.test(url);
        if (hotlink && typeof signProxyUrl === 'function') {
            img.onerror = () => { if (img.isConnected) img.src = img.dataset.default || ''; };
            signProxyUrl(url, 'image').then((proxyUrl) => {
                if (!img.isConnected) return;
                img.dataset.raw = url;
                img.onerror = () => { if (img.isConnected) img.src = img.dataset.default || ''; };
                img.src = proxyUrl;
            }).catch(() => {
                if (img.isConnected) img.src = url; // 代理不可用：退回直连（onerror 已挂占位兜底）
            });
            return;
        }
        img.onerror = null;
        img.src = url;
    },

    /**
     * 切换「更多」操作菜单显示（手机端收纳的下载/订阅等按钮）
     */
    toggleMoreMenu(pageId) {
        const menu = document.getElementById(`st-more-menu-${pageId}`);
        if (!menu) return;
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    },

    /**
     * 隐藏「更多」操作菜单
     */
    hideMoreMenu(pageId) {
        const menu = document.getElementById(`st-more-menu-${pageId}`);
        if (menu) menu.style.display = 'none';
    },

    _handlePlay(pageId, index) {
        const config = this._configs?.[pageId];
        if (config?.events?.onPlay) {
            config.events.onPlay(config.songs[index], index);
        } else {
            console.error('[SongTable._handlePlay] onPlay callback not found for pageId:', pageId);
        }
    },

    _handleFavorite(pageId, index) {
        const config = this._configs?.[pageId];
        if (!config?.songs?.[index]) return;

        const song = config.songs[index];
        const container = document.querySelector(`[data-page-id="${pageId}"]`);
        if (!container) return;

        const row = container.querySelector(`tr[data-index="${index}"]`);
        if (!row) return;

        const favBtn = row.querySelector('.col-favorite .action-btn');
        if (!favBtn) return;

        // 获取当前状态并切换
        const isFavorited = favBtn.classList.contains('favorited');

        // 立即更新按钮状态（不等待回调）
        if (isFavorited) {
            favBtn.classList.remove('favorited');
            favBtn.title = '收藏';
            favBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
        } else {
            favBtn.classList.add('favorited');
            favBtn.title = '取消收藏';
            favBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
        }

        // 调用外部事件
        if (config.events?.onFavorite) {
            config.events.onFavorite(song, index);
        }
    },

    async _handleDownload(pageId, index) {
        const config = this._configs?.[pageId];
        if (!config?.songs?.[index]) return;

        const song = config.songs[index];
        const itemPlugin = song.plugin || song.platform || '';

        // 实时查询数据库检查下载状态
        let downloadStatus = 'pending';
        try {
            if (window.StateManager?.getDownloadStatus) {
                downloadStatus = await window.StateManager.getDownloadStatus(song.id, itemPlugin);
            }
        } catch (e) {
            console.error('获取下载状态失败:', e);
        }

        // 如果已经下载
        if (downloadStatus === 'downloaded') {
            // 如果页面有自定义的 onDownload 事件，调用它（例如显示重新下载确认框）
            if (config.events?.onDownload) {
                config.events.onDownload(song, index);
            } else {
                showToast('该歌曲已下载', 'info');
            }
            return;
        }

        // 如果正在下载，显示提示
        if (downloadStatus === 'downloading') {
            showToast('正在下载中...', 'info');
            return;
        }

        // 立即显示下载中状态
        const container = document.querySelector(`[data-page-id="${pageId}"]`);
        if (container) {
            const row = container.querySelector(`tr[data-index="${index}"]`);
            if (row) {
                const dlBtn = row.querySelector('.col-download .action-btn');
                if (dlBtn) {
                    dlBtn.classList.add('downloading');
                    dlBtn.title = '下载中...';
                    dlBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>';
                }
            }
        }

        // 使用 DownloadCore 下载
        if (window.DownloadCore) {
            // 如果有 onDownload 事件，使用它（让页面控制下载来源）
            if (config.events?.onDownload) {
                config.events.onDownload(song, index);
            } else {
                // 根据 pageId 推断来源名称
                const sourceMap = {
                    'search': '搜索-下载',
                    'toplist': '排行榜-下载',
                    'toplist-search': '排行榜搜索-下载',
                    'recommend': '热门歌单-下载',
                    'playlist-detail': '歌单-下载',
                    'recent': '最近播放-下载',
                    'favorites': '收藏-下载'
                };
                const source = sourceMap[pageId] || '行内下载';
                
                // 否则使用默认下载
                await DownloadCore.download({
                    id: song.id,
                    title: song.title,
                    artist: song.artist,
                    plugin: itemPlugin,
                    quality: 'standard',
                    artwork: song.artwork,
                    album: song.album
                }, (status, data) => {
                    if (status === 'completed') {
                        showToast(`"${data.title}" 下载完成`, 'success');
                    } else if (status === 'failed') {
                        showToast(`"${data.title}" 下载失败: ${data.error}`, 'error');
                    }
                }, source);
            }
        } else if (config.events?.onDownload) {
            // 兼容旧逻辑
            config.events.onDownload(song, index);
        }
    },

    _toggleSelectAll(pageId) {
        const container = document.querySelector(`[data-page-id="${pageId}"]`);
        if (!container) return;

        const selectAll = container.querySelector('#select-all');
        const checkboxes = container.querySelectorAll('.row-checkbox');

        checkboxes.forEach(cb => {
            cb.checked = selectAll.checked;
        });

        const config = this._configs?.[pageId];
        if (config?.events?.onSelectChange) {
            const selectedIndices = selectAll.checked
                ? Array.from({length: checkboxes.length}, (_, i) => i)
                : [];
            config.events.onSelectChange(selectedIndices);
        }
    },

    _toggleRowSelect(pageId, _index) {
        const config = this._configs?.[pageId];
        if (config?.events?.onSelectChange) {
            const selectedIndices = this.getSelectedIndices(pageId);
            config.events.onSelectChange(selectedIndices);
        }

        // 更新全选框状态
        const container = document.querySelector(`[data-page-id="${pageId}"]`);
        if (container) {
            const selectAll = container.querySelector('#select-all');
            const allCheckboxes = container.querySelectorAll('.row-checkbox');
            const checkedBoxes = container.querySelectorAll('.row-checkbox:checked');

            if (selectAll) {
                selectAll.checked = allCheckboxes.length > 0 && allCheckboxes.length === checkedBoxes.length;
            }
        }
    },

    _initDownloadStatusListener(_pageId) {
        // 避免重复监听
        if (this._downloadListenerInstalled) return;
        this._downloadListenerInstalled = true;

        // 监听下载状态变化
        window.addEventListener('download:statusChanged', (event) => {
            const { musicId, plugin, status } = event.detail;
            if (!musicId || !plugin) return;

            // 遍历所有已渲染的表格实例
            Object.keys(this._configs || {}).forEach(pid => {
                const config = this._configs[pid];
                if (!config || !config.songs) return;

                // 查找匹配的歌曲
                config.songs.forEach((song, index) => {
                    const songPlugin = song.plugin || song.platform || '';
                    if (song.id === musicId && songPlugin === plugin) {
                        // 更新按钮状态
                        const container = document.querySelector(`[data-page-id="${pid}"]`);
                        if (!container) return;

                        const row = container.querySelector(`tr[data-index="${index}"]`);
                        if (!row) return;

                        const dlBtn = row.querySelector('.col-download .action-btn');
                        if (!dlBtn) return;

                        // 移除旧状态
                        dlBtn.classList.remove('downloaded', 'downloading');

                        // 根据状态更新按钮
                        if (status === 'downloaded') {
                            dlBtn.classList.add('downloaded');
                            dlBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
                            dlBtn.title = '已下载';
                        } else if (status === 'downloading') {
                            dlBtn.classList.add('downloading');
                            dlBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>';
                            dlBtn.title = '下载中...';
                        } else if (status === 'failed') {
                            // 下载失败，恢复默认状态
                            dlBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
                            dlBtn.title = '下载失败，点击重试';
                        } else {
                            // 默认状态
                            dlBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
                            dlBtn.title = '下载';
                        }
                    }
                });
            });
        });

        // 监听收藏状态变化
        window.addEventListener('favoriteChanged', (event) => {
            const { musicId, platform, isFavorited } = event.detail;
            if (!musicId || !platform) return;

            // 遍历所有已渲染的表格实例
            Object.keys(this._configs || {}).forEach(pid => {
                const config = this._configs[pid];
                if (!config || !config.songs) return;

                // 查找匹配的歌曲
                config.songs.forEach((song, index) => {
                    const songPlatform = song.platform || song.plugin || '';
                    if (song.id === musicId && songPlatform === platform) {
                        // 更新收藏按钮状态
                        const container = document.querySelector(`[data-page-id="${pid}"]`);
                        if (!container) return;

                        const row = container.querySelector(`tr[data-index="${index}"]`);
                        if (!row) return;

                        const favBtn = row.querySelector('.col-favorite .action-btn');
                        if (!favBtn) return;

                        if (isFavorited) {
                            favBtn.classList.add('favorited');
                            favBtn.title = '取消收藏';
                            favBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="#ff4757"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
                        } else {
                            favBtn.classList.remove('favorited');
                            favBtn.title = '收藏';
                            favBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
                        }
                    }
                });
            });
        });
    },

    _escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    _formatDuration(seconds) {
        if (!seconds) return '-';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
};

// 暴露到全局
window.SongTable = SongTable;

// ==================== 「本地 ✓」徽标（所有歌曲列表通用）====================
// 批量按「歌名+歌手」匹配 NAS 本地曲库，命中的行在来源列追加「本地 ✓」徽标。
// 会话内缓存（title|artist -> bool），翻页/重进不重复查询；查询失败静默不标注，不影响列表。
const LocalBadge = {
    cache: new Map(),
    keyOf(song) { return String((song && song.title) || '') + '|' + String((song && song.artist) || ''); },
    async apply(rootEl, songs) {
        if (!rootEl || !Array.isArray(songs) || !songs.length) return;
        const pending = [];
        songs.forEach((s) => {
            if (!s || !s.title || !s.artist) return;
            if (s.plugin === 'local' || s.platform === 'local' || s.filePath) return; // 本地歌本身即本地，无需匹配
            const k = this.keyOf(s);
            if (!this.cache.has(k)) pending.push({ title: s.title, artist: s.artist, duration: s.duration, key: k });
        });
        if (pending.length) {
            try {
                const r = await API.music.localMatchBatch(pending);
                if (r && r.success && Array.isArray(r.data)) {
                    pending.forEach((p, i) => this.cache.set(p.key, !!r.data[i]));
                }
            } catch { return; }
        }
        const rows = rootEl.querySelectorAll('tbody tr');
        rows.forEach((row, idx) => {
            const s = songs[idx];
            if (!s || !s.title || !s.artist) return;
            if (s.plugin === 'local' || s.platform === 'local' || s.filePath) return; // 本地歌来源列已是「本地」
            const cell = row.querySelector('.col-source');
            if (!cell) return;
            const exist = cell.querySelector('.local-match-tag');
            if (this.cache.get(this.keyOf(s))) {
                if (!exist) {
                    const tag = document.createElement('span');
                    tag.className = 'source-tag local-match-tag';
                    tag.title = '本地曲库已存在同名歌曲';
                    tag.style.marginLeft = '4px';
                    tag.textContent = '本地';
                    cell.appendChild(tag);
                }
            } else if (exist) {
                exist.remove();
            }
        });
    }
};
window.LocalBadge = LocalBadge;

// 点击「更多」菜单外部时关闭所有已打开的菜单（一次性绑定，随重渲染自动生效）
document.addEventListener('click', (e) => {
    document.querySelectorAll('.st-more-menu').forEach(menu => {
        if (!menu.style.display || menu.style.display === 'none') return;
        if (menu.contains(e.target)) return;
        if (e.target.closest && e.target.closest('#st-more-btn')) return;
        menu.style.display = 'none';
    });
});


