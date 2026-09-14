/**
 * 电台模块（省市台 / 分类 / 网络台 三态菜单）
 * 数据来源：后端 /api/radio/stations，插件以平铺数组提供 province / categories / network 维度。
 * 一个电台可同时出现在多个维度/子菜单下；全局播放列表按 id 去重。
 */

const RadioModule = {
    // 后端原始数据
    data: [],
    // 按维度聚合后的结构：{ '省市台': [{ subTitle, emoji, stations }], ... }
    dimensions: {},
    // 维度顺序（前端固定）
    dimensionOrder: ['省市台', '分类', '网络台', '未分类'],
    // 当前选中的维度与子项
    currentDimension: '',
    currentSubTitle: '',
    // 「更多」子菜单下拉是否展开
    moreOpen: false,
    // 拖拽排序时的起点下标（子菜单「更多」面板）
    dragIndex: null,
    // 「我的电台」管理模式：拖拽排序的起点下标
    favDragIndex: null,
    // 「我的电台」管理模式：已勾选的电台 id（多选删除用）
    favSelected: new Set(),
    // 「普通电台列表」管理模式：已勾选的电台 id（多选删除用）
    stationSelected: new Set(),
    // 「更多」面板里标记「·已在外」的外侧子项集合（renderSubMenu 按实际宽度计算）
    _outsideSet: new Set(),
    _rsBound: false,
    // 排序同步到服务端的防抖定时器
    _ordersTimer: null,
    // 子菜单单行最多显示几个（已废弃：改为按容器实际宽度自适应，见 renderSubMenu）
    subMenuLimit: 7,
    // 各维度子菜单的自定义排序（localStorage 持久化）：{ 维度: [subTitle, ...] }
    customOrder: {},
    // 各分组（维度+子项）内电台的自定义排序（localStorage 持久化）：
    // { "维度::子项": [stationId, ...] }。插件来源电台不在数据库，无法走后端 sort_order，
    // 故直接用本地顺序保证拖拽排序刷新后仍保留。
    stationOrder: {},
    // 「电台 id → 所属分组名」反查缓存（懒构建；维度结构变化时置 null）
    _groupIndex: null,
    // 去重后的全部电台，作为跨维度切换的播放列表
    stationsFlat: [],
    // 收藏电台（与后端 radio-favorites.json 同步）
    favorites: [],
    favSet: new Set(),
    // 当前正在展示的电台列表（普通子菜单 or 喜欢），供播放与收藏使用
    currentList: [],
    // 「喜欢」虚拟维度名
    FAV_DIM: '喜欢',
    // 是否处于「我的电台」模式（仅展示收藏，隐藏顶部维度 Tab 与新增按钮）
    myRadioMode: false,
    // 「我的电台」管理（编辑）模式：卡片显示「取消收藏」按钮
    manageMode: false,

    /**
     * 由文本生成稳定渐变色（无封面时作为缩略图背景）
     */
    colorFromText(text) {
        let h = 0;
        const s = String(text || '');
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
        return `linear-gradient(135deg, hsl(${h}, 55%, 45%) 0%, hsl(${(h + 40) % 360}, 55%, 28%) 100%)`;
    },

    /**
     * 加载电台数据
     */
    async load(defaultDim) {
        this.currentDimension = '';
        this.currentSubTitle = '';
        // 初始化指针（鼠标 / 触摸）拖动排序（一次绑定）
        this.initPointerDragSort();
        // 窗口尺寸变化时按新宽度重算子菜单外侧 / 「更多」的分配（一次绑定）
        this.bindSubMenuResize();
        // 读取本地保存的子菜单自定义排序
        try {
            this.customOrder = JSON.parse(localStorage.getItem('radio-sub-order') || '{}') || {};
        } catch (e) {
            this.customOrder = {};
        }
        // 读取本地保存的分组（维度+子项）内电台自定义排序
        try {
            this.stationOrder = JSON.parse(localStorage.getItem('radio-station-order') || '{}') || {};
        } catch (e) {
            this.stationOrder = {};
        }
        this.renderTabs();
        this.renderSubMenu();

        const content = document.getElementById('radio-content');
        if (content) {
            content.innerHTML = `
                <div class="empty-state" style="min-height: 100%; display:flex; flex-direction:column; justify-content:center; align-items:center;">
                    <div class="spinner"></div>
                    <div style="margin-top:16px; color:var(--text-secondary); font-size:14px;">正在加载电台...</div>
                </div>
            `;
        }

        try {
            const result = await API.radio.getStations();
            if (result.success && Array.isArray(result.data)) {
                this.data = result.data.filter(
                    (p) => p && Array.isArray(p.groups) && p.groups.some((g) => g.stations && g.stations.length)
                );
                // 拉取服务端保存的排序（跨设备同步）：分类顺序 + 分组内电台顺序，
                // 服务端有数据时以其为准；服务端为空但本地有（老版本数据）时上传迁移；
                // 请求失败（离线）时沿用本地缓存
                try {
                    const or = await API.radio.getOrders();
                    const subRemote = or && or.success && or.data && or.data.subOrder && Object.keys(or.data.subOrder).length ? or.data.subOrder : null;
                    const stationRemote = or && or.success && or.data && or.data.stationOrder && Object.keys(or.data.stationOrder).length ? or.data.stationOrder : null;
                    if (subRemote || stationRemote) {
                        if (subRemote) this.customOrder = subRemote;
                        if (stationRemote) this.stationOrder = stationRemote;
                    } else if (Object.keys(this.customOrder).length || Object.keys(this.stationOrder).length) {
                        this.syncOrdersToServer(); // 首次迁移：把本地已有排序上传
                    }
                    try {
                        localStorage.setItem('radio-sub-order', JSON.stringify(this.customOrder));
                        localStorage.setItem('radio-station-order', JSON.stringify(this.stationOrder));
                    } catch (e) { /* ignore */ }
                } catch (e) { /* 沿用本地缓存 */ }
                this.buildDimensions();
                this.buildFlatStations();

                // 加载收藏电台
                try {
                    const fr = await API.radio.getFavorites();
                    if (fr && fr.success && Array.isArray(fr.data)) {
                        this.favorites = fr.data;
                        this.favSet = new Set(this.favorites.map((x) => String(x.id)));
                    }
                } catch (e) { /* ignore */ }

                if (Object.keys(this.dimensions).length === 0) {
                    if (content) {
                        content.innerHTML = this.emptyHtml('暂无电台');
                    }
                    return;
                }

                // 默认进入第一个有内容的维度；「我的电台」标记存在时进入收藏（喜欢）视图
                const stored = localStorage.getItem('radioView');
                const def = defaultDim || (stored === 'my-radio' ? this.FAV_DIM : this.firstDimension());
                if (def) this.switchDimension(def);
            } else {
                if (content) content.innerHTML = this.emptyHtml('加载电台失败');
            }
        } catch (error) {
            console.error('加载电台失败:', error);
            if (content) content.innerHTML = this.emptyHtml('加载失败: ' + escapeHtml(error.message || ''));
        }
    },

    /**
     * 由后端 groups 构建维度聚合结构
     */
    buildDimensions() {
        const map = {};
        for (const plugin of this.data) {
            for (const g of plugin.groups || []) {
                const dim = g.dimension || '其他分组';
                const subTitle = g.subTitle || g.title || '未命名';
                if (!map[dim]) map[dim] = {};
                if (!map[dim][subTitle]) {
                    map[dim][subTitle] = { subTitle, emoji: g.emoji || '📻', stations: [] };
                }
                for (const s of g.stations || []) {
                    map[dim][subTitle].stations.push(s);
                }
            }
        }
        // 转换成数组， stations 去重（同一电台可能来自多个插件）
        this.dimensions = {};
        for (const [dim, subs] of Object.entries(map)) {
            this.dimensions[dim] = Object.values(subs).map((sub) => ({
                subTitle: sub.subTitle,
                emoji: sub.emoji,
                stations: this.applyStationOrder(dim, sub.subTitle, this.dedupStations(sub.stations))
            })).filter((sub) => sub.stations.length > 0);
        }
        // 维度结构已重建，电台→分组的反查缓存失效
        this._groupIndex = null;
    },

    /**
     * 构建「电台 id → 所属分组名（子项）」反查表（懒构建 + 缓存）
     */
    buildGroupIndex() {
        const idx = {};
        for (const dim of Object.keys(this.dimensions || {})) {
            for (const sub of this.dimensions[dim] || []) {
                for (const s of sub.stations || []) {
                    const k = String(s.id);
                    if (!idx[k]) idx[k] = [];
                    if (!idx[k].includes(sub.subTitle)) idx[k].push(sub.subTitle);
                }
            }
        }
        this._groupIndex = idx;
        return idx;
    },

    /**
     * 某电台所属的分组分类（如「江苏」「音乐台」），最多取前 2 个，用 / 连接。
     * 用于电台没有歌手信息时，代替「未知艺术家」显示在播放器上。
     */
    stationGroupLabel(id) {
        if (!this._groupIndex) this.buildGroupIndex();
        const arr = (this._groupIndex && this._groupIndex[String(id)]) || [];
        return arr.slice(0, 2).join(' / ');
    },

    /**
     * 全局播放列表：所有维度子项里的电台按 id 去重
     */
    buildFlatStations() {
        const all = [];
        for (const plugin of this.data) {
            for (const g of plugin.groups || []) {
                for (const s of g.stations || []) all.push(s);
            }
        }
        this.stationsFlat = this.dedupStations(all);
    },

    dedupStations(list) {
        const seen = new Set();
        const out = [];
        for (const s of list) {
            if (!s || !s.id) continue;
            const key = String(s.id);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(s);
        }
        return out;
    },

    emptyHtml(text) {
        return `
            <div class="empty-state" style="min-height:100%; display:flex; flex-direction:column; justify-content:center; align-items:center;">
                <div class="empty-icon">📻</div>
                <div class="empty-text">${escapeHtml(text)}</div>
            </div>
        `;
    },

    /**
     * 某 Tab 的展示数量：喜欢=收藏数；维度=该维度下全部电台数（各组 stations 之和）
     */
    tabCount(d) {
        if (d === this.FAV_DIM) return (this.favorites || []).length;
        const groups = this.dimensions[d] || [];
        let n = 0;
        for (const g of groups) n += (g.stations ? g.stations.length : 0);
        return n;
    },

    /**
     * 渲染顶部维度 Tab
     */
    renderTabs() {
        const tabs = document.getElementById('radio-tabs');
        if (!tabs) return;
        // 重渲染时收起管理菜单，避免浮层残留
        this.closeRadioManageMenu();
        if (this.myRadioMode) {
            // 「我的电台」模式：隐藏顶部维度 Tab 与「＋新增」按钮
            tabs.style.display = 'none';
            tabs.innerHTML = '';
            return;
        }
        tabs.style.display = 'flex';
        const available = this.dimensionOrder.filter((d) => this.dimensions[d] && this.dimensions[d].length && this.tabCount(d) > 0);
        const extra = Object.keys(this.dimensions).filter((d) => !this.dimensionOrder.includes(d) && this.dimensions[d] && this.dimensions[d].length && this.tabCount(d) > 0);
        const all = available.concat(extra);
        // 右侧仅保留「⚙ 管理」按钮，点击展开菜单：新增 / 导出 / 导入 / 管理（管理=切换当前列表管理模式）
        const managing = this.manageMode && !this.myRadioMode;
        const addBtn = `
            <div style="margin-left:auto; display:flex; gap:8px; align-items:center;">
                <button class="radio-tab" type="button" onclick="RadioModule.toggleRadioManageMenu(event)" title="管理电台"
                    style="padding:8px 14px; border-radius:50%; border:1px solid ${managing ? 'var(--primary-color)' : 'var(--divider-color)'}; background:${managing ? 'var(--primary-color)' : 'transparent'}; color:${managing ? '#fff' : 'var(--text-secondary)'}; font-size:16px; cursor:pointer; font-weight:500; display:inline-flex; align-items:center; justify-content:center;">
                    ⚙
                </button>
            </div>`;
        if (!all.length) {
            tabs.innerHTML = addBtn;
            return;
        }
        tabs.innerHTML = all.map((d) => {
            const active = d === this.currentDimension ? 'active' : '';
            const cnt = this.tabCount(d);
            return `
                <button class="radio-tab ${active}" data-dim="${escapeHtml(d)}" onclick="RadioModule.switchDimension('${escapeHtml(d)}')"
                    style="padding:8px 16px; border-radius:18px; border:none; background:${active ? 'var(--primary-color)' : 'transparent'};
                           color:${active ? '#fff' : 'var(--text-secondary)'}; font-size:14px; cursor:pointer; font-weight:500;">
                    ${escapeHtml(d)}（${cnt}）
                </button>
            `;
        }).join('') + addBtn;
    },

    /**
     * 当前是否处于「普通电台列表」管理模式（区别于「我的电台」收藏管理模式）
     */
    isStationManage() {
        return this.manageMode && !this.myRadioMode;
    },

    /**
     * 顶部「⚙ 管理」按钮：展开电台管理菜单（含 新增 / 导出 / 导入 / 管理）。
     */
    toggleRadioManageMenu(event) {
        if (event) { event.stopPropagation(); event.preventDefault(); }
        // 懒创建浮层与样式
        if (!document.getElementById('radio-manage-style')) {
            const st = document.createElement('style');
            st.id = 'radio-manage-style';
            st.textContent = '.radio-manage-item:hover{background:var(--bg-secondary);}';
            document.head.appendChild(st);
        }
        let menu = document.getElementById('radio-manage-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'radio-manage-menu';
            menu.style.cssText = 'display:none; position:fixed; z-index:1200; min-width:180px; padding:6px;' +
                'background:var(--surface-color); border:1px solid var(--divider-color);' +
                'border-radius:10px; box-shadow:0 6px 20px rgba(0,0,0,.25); font-size:14px;';
            document.body.appendChild(menu);
            const items = [
                { label: '新增', fn: () => this.showAddStationModal() },
                { label: '导出', fn: () => this.exportStations() },
                { label: '导入', fn: () => this.importStations() },
                { label: '管理', fn: () => this.toggleStationManageMode(), active: () => this.isStationManage() }
            ];
            this._manageMenuItems = items;
            menu.addEventListener('click', (e) => {
                const item = e.target.closest('.radio-manage-item');
                if (!item) return;
                const i = parseInt(item.getAttribute('data-i'), 10);
                const it = this._manageMenuItems[i];
                this.closeRadioManageMenu();
                if (it && it.fn) it.fn();
            });
        }
        // 每次打开都重建内容，使「管理」的 ✓ 状态实时反映当前管理模式
        menu.innerHTML = this._manageMenuItems.map((it, i) =>
            `<div class="radio-manage-item" data-i="${i}" style="padding:10px 12px; border-radius:8px; cursor:pointer; color:var(--text-color); display:flex; justify-content:space-between; align-items:center;">` +
            `<span>${escapeHtml(it.label)}</span>${it.active && it.active() ? '<span style="color:var(--primary-color);">✓</span>' : ''}</div>`
        ).join('');
        const wasOpen = menu.style.display !== 'none';
        this.closeRadioManageMenu();
        if (wasOpen) return;
        const btn = event && event.currentTarget;
        if (btn) {
            const rect = btn.getBoundingClientRect();
            menu.style.left = Math.min(rect.left, window.innerWidth - 190) + 'px';
            menu.style.top = (rect.bottom + 8) + 'px';
        }
        menu.style.display = 'block';
        this._manageOutside = (e) => {
            if (menu.contains(e.target)) return;
            this.closeRadioManageMenu();
        };
        setTimeout(() => document.addEventListener('click', this._manageOutside), 0);
    },

    /**
     * 收起管理菜单并清理外部点击监听
     */
    closeRadioManageMenu() {
        const menu = document.getElementById('radio-manage-menu');
        if (menu) menu.style.display = 'none';
        if (this._manageOutside) {
            document.removeEventListener('click', this._manageOutside);
            this._manageOutside = null;
        }
    },

    /**
     * 顶部「⚙ 管理」按钮：切换【当前界面电台列表】的管理模式（参考「我的电台」的管理按钮）。
     * 开启后卡片显示勾选框，顶部出现 全选 / 删除(N) / 完成，可对当前列表多选删除。
     */
    toggleStationManageMode() {
        this.manageMode = !this.manageMode;
        this.favSelected.clear();
        this.stationSelected.clear();
        if (this.categorySelected) this.categorySelected.clear();
        this.renderTabs();
        this.renderSubMenu();
        if (this.myRadioMode) {
            this.renderFavorites();
        } else if (this.currentSubTitle) {
            this.openSubItem(this.currentSubTitle);
        } else {
            this.renderCategoryCards();
        }
    },

    /**
     * 从本地所有结构中移除某电台（删除后即时反映到界面，无需整页重新加载）
     */
    removeStationLocally(id) {
        const sid = String(id);
        for (const plugin of this.data || []) {
            for (const g of plugin.groups || []) {
                if (g.stations) g.stations = g.stations.filter((s) => String(s.id) !== sid);
            }
        }
        // this.dimensions[维度] 是数组，直接遍历，避免用键名/下标取值带来的隐患
        for (const dim of Object.keys(this.dimensions)) {
            for (const sub of this.dimensions[dim] || []) {
                if (!sub || !sub.stations) continue;
                sub.stations = sub.stations.filter((s) => String(s.id) !== sid);
            }
        }
        if (this.stationsFlat) this.stationsFlat = this.stationsFlat.filter((s) => String(s.id) !== sid);
        if (this.currentList) this.currentList = this.currentList.filter((s) => String(s.id) !== sid);
        // 维度内容已变，电台→分组反查缓存失效
        this._groupIndex = null;
    },

    /**
     * 删除「当前列表」中已勾选的电台（多选），并清理对应收藏
     */
    async deleteSelectedStations() {
        const ids = Array.from(this.stationSelected).map(String);
        if (!ids.length) return;
        const ok = typeof confirm === 'function' ? window.confirm(`确定删除选中的 ${ids.length} 个电台吗？`) : true;
        if (!ok) return;
        let done = 0, skipped = 0;
        showToast('正在删除...', 'info');
        for (const id of ids) {
            try {
                const r = await API.radio.deleteStation(id);
                if (r && r.success) {
                    done++;
                    this.removeStationLocally(id);
                    try { await API.radio.removeFavorite(id); } catch (e) { /* 可能没有收藏 */ }
                    this.favSet.delete(id);
                    this.favorites = (this.favorites || []).filter((x) => String(x.id) !== id);
                } else {
                    skipped++;
                }
            } catch (e) {
                skipped++;
            }
        }
        this.stationSelected.clear();
        // 重新渲染当前子菜单（保留管理模式）
        if (this.currentSubTitle) this.openSubItem(this.currentSubTitle);
        const label = skipped
            ? `已删除 ${done} 个，${skipped} 个不可删除（来自插件）`
            : `已删除 ${done} 个电台`;
        showToast(label, done ? 'success' : 'error');
    },

    /**
     * 切换维度：渲染子菜单，并默认打开第一个子菜单
     */
    switchDimension(dim) {
        this.myRadioMode = (dim === this.FAV_DIM);
        this.manageMode = false;
        this.favDragIndex = null;
        this.favSelected.clear();
        if (dim === this.FAV_DIM) {
            this.currentDimension = this.FAV_DIM;
            this.currentSubTitle = '';
            this.moreOpen = false;
            this.renderTabs();
            this.renderSubMenu();
            this.renderFavorites();
            return;
        }
        if (!this.dimensions[dim] || !this.dimensions[dim].length) return;
        this.currentDimension = dim;
        this.currentSubTitle = '';
        this.moreOpen = false;
        this.renderTabs();
        // 渲染分类卡片网格（不再自动打开第一个分类）
        this.renderSubMenu();
    },

    /**
     * 第一个有内容的维度（用于电台页默认进入）
     */
    firstDimension() {
        for (const d of this.dimensionOrder) {
            if (this.dimensions[d] && this.dimensions[d].length && this.tabCount(d) > 0) return d;
        }
        for (const d of Object.keys(this.dimensions)) {
            if (this.dimensions[d] && this.dimensions[d].length && this.tabCount(d) > 0) return d;
        }
        return null;
    },

    /**
     * 侧边栏「我的电台」入口：进入收藏（喜欢）视图
     */
    async showMyRadio() {
        if (!this.data || !this.data.length) {
            await this.load(this.FAV_DIM);
        } else {
            this.switchDimension(this.FAV_DIM);
        }
    },

    /**
     * 切换「我的电台」管理（编辑）模式
     */
    toggleManageMode() {
        this.manageMode = !this.manageMode;
        this.favDragIndex = null;
        this.favSelected.clear();
        this.renderFavorites();
    },

    /**
     * 某维度的默认排序（按电台数降序，数量相同按拼音），仅在无自定义排序时使用
     */
    defaultOrder(dim) {
        return (this.dimensions[dim] || []).slice().sort((a, b) => {
            if (b.stations.length !== a.stations.length) return b.stations.length - a.stations.length;
            return String(a.subTitle).localeCompare(String(b.subTitle), 'zh-CN');
        }).map((s) => s.subTitle);
    },

    /**
     * 当前维度子菜单的顺序数组：优先用本地自定义排序，缺项/新增项自动补齐到末尾
     */
    getOrderArray(dim) {
        const titles = (this.dimensions[dim] || []).map((s) => s.subTitle);
        const set = new Set(titles);
        let order;
        if (this.customOrder[dim] && Array.isArray(this.customOrder[dim])) {
            order = this.customOrder[dim].filter((t) => set.has(t));
            for (const t of titles) if (!order.includes(t)) order.push(t);
        } else {
            order = this.defaultOrder(dim);
        }
        return order;
    },

    saveOrder(dim, order) {
        this.customOrder[dim] = order;
        try {
            localStorage.setItem('radio-sub-order', JSON.stringify(this.customOrder));
        } catch (e) { /* ignore */ }
        // 同步到服务端，电脑 / 手机保持一致
        this.syncOrdersToServer();
    },

    /**
     * 把当前排序（分类顺序 + 分组内电台顺序）同步到服务端，跨设备保持一致。
     * 防抖合并连续拖动；失败静默（本地已保存，下次操作会再同步），不打断操作。
     */
    syncOrdersToServer() {
        if (this._ordersTimer) clearTimeout(this._ordersTimer);
        this._ordersTimer = setTimeout(async () => {
            this._ordersTimer = null;
            try {
                await API.radio.saveOrders(this.customOrder, this.stationOrder);
            } catch (e) { /* 静默 */ }
        }, 400);
    },

    /**
     * 当前维度下的子菜单项，按（自定义或默认的）顺序返回；
     * 排序后前 subMenuLimit 个显示在外侧，其余在「更多」面板中可拖拽重排。
     */
    sortedSubs() {
        const order = this.getOrderArray(this.currentDimension);
        const map = {};
        (this.dimensions[this.currentDimension] || []).forEach((s) => { map[s.subTitle] = s; });
        return order.map((t) => map[t]).filter(Boolean);
    },

    /**
     * 拖拽排序：记录起点
     */
    dragStart(event, i) {
        this.dragIndex = i;
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            try { event.dataTransfer.setData('text/plain', String(i)); } catch (e) { /* ignore */ }
        }
        const el = event.currentTarget;
        if (el) el.style.opacity = '.6';
    },

    /**
     * 拖拽结束（无论是否成功落位）：清理起点与视觉态。
     * 注意：drop 里绝不能同步重建 DOM —— 被拖动元素被移除后浏览器不再派发 dragend，
     * 拖拽状态机会一直停在“拖拽中”，表现为鼠标保持拖拽光标、页面点不动（卡死）。
     */
    dragEnd() {
        this.dragIndex = null;
        this.clearSubDragHints();
    },

    /** 清理子菜单拖拽的半透明/高亮等视觉态 */
    clearSubDragHints() {
        const items = document.querySelectorAll('.radio-sub-item');
        for (const el of items) {
            el.style.opacity = '';
            el.style.outline = '';
            el.style.outlineOffset = '';
        }
    },

    // ==================== 统一指针（鼠标 / 触摸）拖动排序 ====================
    // 不再依赖 HTML5 拖放，原因有两个：
    // 1) 拖放过程中一旦重建 DOM（落位后必须重排子菜单），浏览器收不到 dragend，
    //    拖放状态机会一直停在“拖拽中”：光标变不回来、页面点不动 —— 就是所谓的“卡死”；
    // 2) 原实现在 _isTouch 为真（手机、触屏笔记本）时直接去掉 draggable，
    //    导致触屏设备上用鼠标完全拖不动。
    // 这里用 pointer 事件自绘一套：鼠标按下移动即进入拖动，触摸长按 400ms 进入拖动，
    // 落位仍复用既有的 drop() / favDrop() 落库逻辑。

    _isTouch: (('ontouchstart' in window) || (navigator.maxTouchPoints > 0)),
    _pdSupported: (typeof window !== 'undefined' && typeof window.PointerEvent === 'function'),
    _pdState: null,
    _pdBound: false,
    _pdScrollRaf: null,
    _pdScrollDir: 0,
    _pdPrevUserSelect: null,
    // 最近一次拖拽落位的时间戳（用于吞掉落位后浏览器补发的 click，避免误触）
    _lastDropAt: 0,

    /** 一次性绑定全局指针拖动事件（委托，列表重渲染无需重绑） */
    initPointerDragSort() {
        if (this._pdBound || !this._pdSupported) return;
        this._pdBound = true;
        const self = this;

        const clearVisuals = () => {
            document.querySelectorAll('[data-td-index]').forEach((el) => {
                el.style.outline = '';
                el.style.outlineOffset = '';
                el.style.opacity = '';
            });
            if (self._pdPrevUserSelect != null) {
                document.body.style.userSelect = self._pdPrevUserSelect;
                self._pdPrevUserSelect = null;
            }
        };

        /** 收尾：commit=true 表示松手落位，false 表示取消 */
        const finish = (commit) => {
            const st = self._pdState;
            self._pdStopAutoScroll();
            self._pdState = null;
            window.__radioTdDragging = false;
            clearVisuals();
            if (!st) return;
            clearTimeout(st.timer);
            try {
                if (st.item.hasPointerCapture && st.item.hasPointerCapture(st.pointerId)) {
                    st.item.releasePointerCapture(st.pointerId);
                }
            } catch (e) { /* ignore */ }
            if (!st.started || !commit) return;

            let to = st.target && st.target !== st.item ? parseInt(st.target.dataset.tdIndex, 10) : null;
            // 卡片：落在网格空白处（没压在任何卡片上）→ 移到末尾，与原 HTML5 行为一致
            if (to == null && st.moved && st.kind === 'card') {
                const grid = document.getElementById('radio-fav-grid');
                if (grid) {
                    const r = grid.getBoundingClientRect();
                    if (st.lastX >= r.left && st.lastX <= r.right && st.lastY >= r.top && st.lastY <= r.bottom) {
                        to = grid.querySelectorAll('.radio-card').length - 1;
                    }
                }
            }
            // 真正拖动过才吞掉随后的 click，避免拖完误打开分类 / 误勾选卡片
            if (st.moved) {
                self._lastDropAt = Date.now();
                const kill = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
                document.addEventListener('click', kill, { capture: true, once: true });
                setTimeout(() => document.removeEventListener('click', kill, { capture: true }), 300);
            }
            if (to == null || to === st.fromIndex) return;

            // 落位与 DOM 重建放到事件序列结束后执行，避免在事件处理中重建页面导致状态异常
            setTimeout(() => {
                const fake = { preventDefault() {}, stopPropagation() {} };
                if (st.kind === 'card') {
                    self.favDragIndex = st.fromIndex;
                    self.favDrop(fake, to);
                } else {
                    self.dragIndex = st.fromIndex;
                    self.drop(fake, to);
                }
            }, 0);
        };

        document.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            const item = e.target.closest && e.target.closest('[data-td-index]');
            if (!item) return;
            // 上一次手势异常遗留（没收到 up/cancel）：先复位，否则状态互相覆盖，
            // 之后每次 pointermove 都被 preventDefault，页面再也滚不动
            if (self._pdState) {
                clearTimeout(self._pdState.timer);
                self._pdState = null;
                self._pdStopAutoScroll();
            }
            const st = {
                item,
                kind: item.classList.contains('radio-card') ? 'card' : 'sub',
                fromIndex: parseInt(item.dataset.tdIndex, 10),
                startX: e.clientX,
                startY: e.clientY,
                lastX: e.clientX,
                lastY: e.clientY,
                pointerId: e.pointerId,
                isTouch: e.pointerType !== 'mouse',
                started: false,
                moved: false,
                target: item,
                timer: null
            };
            self._pdState = st;
            // 触摸：长按进入拖动（避免和滚动冲突）；鼠标：移动即进入拖动
            if (st.isTouch) st.timer = setTimeout(() => self._pdStartDrag(st), 400);
        }, { passive: true });

        document.addEventListener('pointermove', (e) => {
            const st = self._pdState;
            if (!st || e.pointerId !== st.pointerId) return;
            st.lastX = e.clientX;
            st.lastY = e.clientY;
            if (!st.started) {
                const dx = Math.abs(e.clientX - st.startX);
                const dy = Math.abs(e.clientY - st.startY);
                if (st.isTouch) {
                    // 长按尚未成立就移动 → 视为滚动，放弃本次拖动
                    if (dx > 10 || dy > 10) {
                        clearTimeout(st.timer);
                        self._pdState = null;
                    }
                    return;
                }
                if (dx > 4 || dy > 4) self._pdStartDrag(st);
                return;
            }
            if (e.cancelable) e.preventDefault(); // 拖动中：阻止选中/原生拖拽等默认行为
            st.moved = true;
            self._pdUpdateTarget(st, e.clientX, e.clientY);
            // 靠近可滚动容器（如「更多」面板）上下边缘时自动滚动，否则远处的位置拖不过去
            self._pdAutoScroll(e.clientY);
        }, { passive: false });

        // 触摸设备上 pointermove 无法阻止页面滚动，需要额外拦一下 touchmove
        document.addEventListener('touchmove', (e) => {
            const st = self._pdState;
            if (st && st.started && e.cancelable) e.preventDefault();
        }, { passive: false });

        // 拖动中屏蔽长按菜单（否则系统会弹菜单并 pointercancel，拖到一半就断了）
        document.addEventListener('contextmenu', (e) => {
            const st = self._pdState;
            if (st && st.started) e.preventDefault();
        });

        document.addEventListener('pointerup', (e) => {
            const st = self._pdState;
            if (!st || e.pointerId !== st.pointerId) return;
            finish(true);
        });

        document.addEventListener('pointercancel', () => {
            if (!self._pdState) return;
            finish(false);
        });

        // 兜底：窗口失焦时收尾，避免拖动状态残留导致页面“卡死”
        window.addEventListener('blur', () => { if (self._pdState) finish(false); });
    },

    /** 进入拖动态（触摸长按成立 / 鼠标移动超过阈值） */
    _pdStartDrag(st) {
        if (!st || st.started) return;
        st.started = true;
        // 通知其它手势系统（如下拉刷新）让位，避免两套手势抢事件
        window.__radioTdDragging = true;
        if (this._pdPrevUserSelect == null) {
            this._pdPrevUserSelect = document.body.style.userSelect || '';
        }
        document.body.style.userSelect = 'none'; // 拖动中禁止选中文本
        try { st.item.setPointerCapture(st.pointerId); } catch (e) { /* 部分浏览器不支持 */ }
        st.scroller = this._pdFindScroller(st.item); // 只算一次，避免每次移动都 getComputedStyle
        st.item.style.outline = '3px solid var(--primary-color)';
        st.item.style.outlineOffset = '-3px';
        st.item.style.opacity = '.6';
        if (navigator.vibrate) navigator.vibrate(50);
    },

    /** 找到拖动项所在的可滚动容器（如「更多」面板），没有则 null */
    _pdFindScroller(el) {
        let scroller = el && el.parentElement;
        while (scroller && scroller !== document.body) {
            const cs = window.getComputedStyle(scroller);
            if (/(auto|scroll)/.test(cs.overflowY) && scroller.scrollHeight > scroller.clientHeight + 1) return scroller;
            scroller = scroller.parentElement;
        }
        return null;
    },

    /**
     * 拖动中：更新当前落点高亮（指针下的可排序项）
     */
    _pdUpdateTarget(st, x, y) {
        const el = document.elementFromPoint(x, y);
        const target = el && el.closest && el.closest('[data-td-index]');
        if (target && target !== st.target) {
            if (st.target && st.target !== st.item) {
                st.target.style.outline = '';
                st.target.style.outlineOffset = '';
            }
            st.target = target;
            target.style.outline = '3px dashed var(--primary-color)';
            target.style.outlineOffset = '-3px';
        }
    },

    /**
     * 拖动中：贴近可滚动容器（如「更多」面板）上下边缘时自动滚动
     */
    _pdAutoScroll(clientY) {
        this._pdStopAutoScroll();
        const st = this._pdState;
        if (!st || !st.item) return;
        const scroller = st.scroller || (st.scroller = this._pdFindScroller(st.item));
        if (!scroller) return;
        const rect = scroller.getBoundingClientRect();
        const EDGE = 48;
        let dir = 0;
        if (clientY < rect.top + EDGE) dir = -1;
        else if (clientY > rect.bottom - EDGE) dir = 1;
        // 方向没变且已在滚动：保持不变，避免每次移动都重建动画帧（那样只会滚一格）
        if (dir === this._pdScrollDir && this._pdScrollRaf) return;
        this._pdStopAutoScroll();
        this._pdScrollDir = dir;
        if (!dir) return;
        const step = () => {
            scroller.scrollTop += dir * 14;
            this._pdUpdateTarget(st, st.lastX, st.lastY);
            this._pdScrollRaf = requestAnimationFrame(step);
        };
        this._pdScrollRaf = requestAnimationFrame(step);
    },

    _pdStopAutoScroll() {
        if (this._pdScrollRaf) {
            cancelAnimationFrame(this._pdScrollRaf);
            this._pdScrollRaf = null;
        }
        this._pdScrollDir = 0;
    },


    dragOver(event) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    },

    /** 拖到某个子菜单项上方：给出落点提示 */
    dragEnter(event, i) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        if (this.dragIndex == null || this.dragIndex === i) return;
        const el = event.currentTarget;
        if (el) {
            el.style.outline = '3px dashed var(--primary-color)';
            el.style.outlineOffset = '-3px';
        }
    },

    dragLeave(event) {
        const el = event.currentTarget;
        const to = event.relatedTarget;
        // 移到自身内部子元素时也会触发 dragleave，忽略，避免高亮闪烁
        if (to && el && el.contains(to)) return;
        if (el) {
            el.style.outline = '';
            el.style.outlineOffset = '';
        }
    },

    /**
     * 拖拽落点：重排当前维度顺序并持久化；排序后前 subMenuLimit 个自动显示在外侧
     */
    drop(event, i) {
        event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        const from = this.dragIndex;
        this.dragIndex = null;
        if (from == null || from === i) { this.clearSubDragHints(); return; }
        const dim = this.currentDimension;
        const order = this.getOrderArray(dim).slice();
        if (from < 0 || from >= order.length) { this.clearSubDragHints(); return; }
        const [moved] = order.splice(from, 1);
        order.splice(Math.max(0, Math.min(i, order.length)), 0, moved);
        this.saveOrder(dim, order);
        // 落位后浏览器可能补发一次 click，短暂屏蔽子菜单点击，
        // 避免误切换分类后瞬间渲染上百张电台卡片造成的假死
        this._lastDropAt = Date.now();
        // 必须等本次 drop 事件派发结束后再重建 DOM：同步重建会把被拖动的元素从文档里移除，
        // 浏览器收不到 dragend、拖拽状态机卡住，界面就像卡死一样点不动。
        setTimeout(() => this.renderSubMenu(), 0);
    },

    toggleMore() {
        this.moreOpen = !this.moreOpen;
        this.renderSubMenu();
        if (this.moreOpen) {
            requestAnimationFrame(() => this.positionMorePanel());
            setTimeout(() => {
                this._onClickOutside = (e) => this.handleClickOutside(e);
                document.addEventListener('click', this._onClickOutside);
            }, 0);
        } else if (this._onClickOutside) {
            document.removeEventListener('click', this._onClickOutside);
            this._onClickOutside = null;
        }
    },

    /**
     * 渲染「更多」浮层面板（fixed 定位；展示该维度全部子项，可拖拽排序）
     */
    renderMorePanel(all) {
        let panel = document.getElementById('radio-more-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'radio-more-panel';
            // 挂载到电台页容器内，fixed 定位不影响溢出；页面隐藏时面板自动收起
            const page = document.getElementById('page-radio');
            (page || document.body).appendChild(panel);
        }
        const manage = this.isStationManage();
        const itemHtml = (sub, i) => {
            const active = sub.subTitle === this.currentSubTitle ? 'active' : '';
            const isOutside = this._outsideSet && this._outsideSet.has(sub.subTitle);
            return `
                <div class="radio-sub-item ${active}" ${manage ? `data-td-index="${i}"` : ''}
                    ${manage && !(this._isTouch || this._pdSupported) ? `draggable="true" ondragstart="RadioModule.dragStart(event, ${i})" ondragend="RadioModule.dragEnd(event)" ondragover="RadioModule.dragOver(event)" ondragenter="RadioModule.dragEnter(event, ${i})" ondragleave="RadioModule.dragLeave(event)" ondrop="RadioModule.drop(event, ${i})"` : ''}
                    onclick="RadioModule.openSubItemFromMenu('${escapeHtml(sub.subTitle)}')"
                    style="padding:6px 14px; border-radius:16px; border:1px solid var(--border-color);
                           background:${active ? 'var(--primary-color)' : 'var(--surface-color)'};
                           color:${active ? '#fff' : 'var(--text-color)'}; font-size:13px; cursor:pointer; white-space:nowrap;
                           display:inline-flex; align-items:center; gap:6px; user-select:none; -webkit-touch-callout:none;">
                    ${manage ? '<span style="cursor:grab; opacity:.5; user-select:none;" title="拖动排序">⠿</span>' : ''}
                    <span style="margin-right:2px;">${escapeHtml(sub.emoji || '📻')}</span>${escapeHtml(sub.subTitle)}
                    ${isOutside ? '<span style="opacity:.5; font-size:11px;">·已在外</span>' : ''}
                </div>
            `;
        };
        panel.style.cssText = `display:${this.moreOpen && all.length ? 'flex' : 'none'}; position:fixed; left:0; top:0;
            flex-wrap:wrap; gap:10px; min-width:400px; max-width:min(900px, 92vw); max-height:60vh; overflow-y:auto;
            padding:16px; background:var(--surface-color); border:1px solid var(--divider-color);
            border-radius:var(--radius-lg); box-shadow:0 4px 12px rgba(0,0,0,.15); z-index:1000;`;
        const prevScroll = panel.scrollTop;
        panel.innerHTML = all.map((s, i) => itemHtml(s, i)).join('');
        // 排序后会整块重建：保留滚动位置，避免拖完一次面板就跳回顶部
        if (prevScroll) panel.scrollTop = prevScroll;
    },

    positionMorePanel() {
        const btn = document.querySelector('.radio-more-btn');
        const panel = document.getElementById('radio-more-panel');
        if (!btn || !panel) return;
        const rect = btn.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const MARGIN = 12;
        // 先隐藏测量面板自身尺寸，避免定位时闪跳
        panel.style.visibility = 'hidden';
        panel.style.display = 'flex';
        panel.style.maxHeight = '';
        const w = panel.offsetWidth;
        const h = panel.offsetHeight;

        // 水平：优先与按钮左对齐，超出右边界则收回到屏内
        let left = Math.min(rect.left, vw - w - MARGIN);
        left = Math.max(MARGIN, left);

        // 垂直：默认在按钮下方；下方空间不足且上方空间更大时改为向上弹
        let top = rect.bottom + 8;
        let maxH = Math.min(vh * 0.6, vh - top - MARGIN);
        if (maxH < 180) {
            const spaceBelow = vh - top - MARGIN;
            const spaceAbove = rect.top - 8 - MARGIN;
            if (spaceAbove > spaceBelow) {
                top = Math.max(MARGIN, rect.top - h - 8);
                maxH = Math.min(vh * 0.6, spaceAbove);
            } else {
                maxH = Math.max(160, spaceBelow);
            }
        }
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.maxHeight = Math.max(160, maxH) + 'px';
        panel.style.visibility = '';
    },

    handleClickOutside(event) {
        const panel = document.getElementById('radio-more-panel');
        const btn = document.querySelector('.radio-more-btn');
        if (!panel || !btn) return;
        if (panel.style.display === 'none') return;
        if (!panel.contains(event.target) && !btn.contains(event.target)) {
            this.moreOpen = false;
            this.renderSubMenu();
            if (this._onClickOutside) {
                document.removeEventListener('click', this._onClickOutside);
                this._onClickOutside = null;
            }
        }
    },

    /**
     * 渲染当前维度下的分类：已改为分类卡片网格（取消二级菜单栏）。
     * - 每个分类渲染为一张卡片（封面 + 分类名 + 电台数），点击进入该分类的电台列表；
     * - 卡片上的悬浮播放按钮：直接播放该分类的电台。
     */
    renderSubMenu() {
        const menu = document.getElementById('radio-submenu');
        if (menu) {
            menu.style.display = 'none';
            menu.innerHTML = '';
        }
        this._outsideSet = new Set();
        this.renderMorePanel([]);
        // 「我的电台」模式或已进入某分类列表时不渲染分类网格
        if (this.myRadioMode || this.currentSubTitle) return;
        this.renderCategoryCards();
    },

    /**
     * 渲染分类卡片网格（参考「我的歌单」卡片样式）
     */
    renderCategoryCards() {
        const content = document.getElementById('radio-content');
        if (!content) return;
        const subs = this.sortedSubs();
        if (!subs.length) {
            content.innerHTML = `
                <div class="empty-state" style="min-height:100%; display:flex; flex-direction:column; justify-content:center; align-items:center;">
                    <div class="empty-icon">📻</div>
                    <div class="empty-text">该维度暂无电台分类</div>
                </div>
            `;
            return;
        }
        // 鲜艳调色板（参考 Apple Music 电台分类）：按分类名哈希取色，相邻卡片颜色不同
        const palettes = [
            ['#ff6b6b', '#d6336c'],
            ['#f06595', '#be4bdb'],
            ['#cc5de8', '#7048e8'],
            ['#5c7cfa', '#1c7ed6'],
            ['#339af0', '#0c8599'],
            ['#22b8cf', '#087f5b'],
            ['#38d9a9', '#0ca678'],
            ['#94d82d', '#5c940d'],
            ['#fcc419', '#e8590c'],
            ['#ff922b', '#e8590c'],
            ['#ff6b6b', '#c92a2a'],
            ['#e599f7', '#9c36b5']
        ];
        const pick = (name) => {
            let h = 0;
            for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
            return palettes[h % palettes.length];
        };
        // 管理模式：顶部工具条（全选 / 删除(N) / 完成）
        this.categorySelected = this.categorySelected || new Set();
        const manage = this.isStationManage();
        const toolbar = manage ? `
            <div class="media-card-toolbar">
                <div style="display:flex; gap:8px; align-items:center;">
                    <button class="btn btn-secondary btn-sm" onclick="RadioModule.toggleSelectAllCategories()">${this.categorySelected.size && this.categorySelected.size === subs.length ? '取消全选' : '全选'}</button>
                    <button class="btn btn-secondary btn-sm" onclick="RadioModule.deleteSelectedCategories()"
                        ${this.categorySelected.size ? '' : 'disabled style="opacity:.5; cursor:not-allowed;"'}>删除${this.categorySelected.size ? ` (${this.categorySelected.size})` : ''}</button>
                    <button class="btn btn-secondary btn-sm" onclick="RadioModule.toggleStationManageMode()">完成</button>
                </div>
                <div style="font-size:13px; color:var(--text-secondary);">勾选删除分类，拖拽卡片排序</div>
            </div>` : '';
        let html = toolbar + `<div class="media-card-grid">`;
        subs.forEach((sub, i) => {
            const name = sub.subTitle || '未命名分类';
            const count = (sub.stations || []).length;
            const [c1, c2] = pick(name);
            const nameAttr = escapeHtml(name);
            const selected = manage && this.categorySelected.has(name);
            const checkHtml = manage ? `<div onclick="event.stopPropagation(); RadioModule.toggleCategorySelect('${nameAttr}')"
                    style="position:absolute; top:6px; left:6px; width:22px; height:22px; border-radius:50%; box-sizing:border-box; cursor:pointer;
                           border:1.5px solid ${selected ? 'var(--primary-color)' : 'rgba(255,255,255,.75)'};
                           background:${selected ? 'var(--primary-color)' : 'rgba(0,0,0,.35)'};
                           color:#fff; font-size:13px; line-height:19px; text-align:center; z-index:4; user-select:none;">${selected ? '✓' : ''}</div>` : '';
            const clickAttr = manage
                ? `onclick="RadioModule.toggleCategorySelect('${nameAttr}')"`
                : `onclick="RadioModule.openSubItem('${nameAttr}')"`;
            const playBtn = manage ? '' : `<button class="media-card-play" title="播放该分类" onclick="event.stopPropagation(); RadioModule.playCategory('${nameAttr}')"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>`;
            // 管理模式：卡片可拖拽排序（复用子菜单排序的指针/HTML5 两套逻辑）
            const dragAttr = manage
                ? (this._pdSupported
                    ? `data-td-index="${i}"`
                    : `draggable="true" ondragstart="RadioModule.dragStart(event, ${i})" ondragend="RadioModule.dragEnd(event)" ondragover="RadioModule.dragOver(event)" ondragenter="RadioModule.dragEnter(event, ${i})" ondragleave="RadioModule.dragLeave(event)" ondrop="RadioModule.drop(event, ${i})"`)
                : '';
            const selectedStyle = selected ? 'box-shadow: 0 0 0 2px var(--primary-color);' : '';
            // Apple Music 风格：鲜艳渐变封面，分类名大字居中
            html += `
                <div class="media-card radio-category-card radio-sub-item" ${clickAttr} ${dragAttr} style="position: relative; ${selectedStyle}">
                    <div class="media-card-cover" style="background: linear-gradient(160deg, ${c1} 0%, ${c2} 100%); display: flex; align-items: center; justify-content: center;">
                        <div style="padding: 10px; font-size: 40px; font-weight: 700; color: #fff; line-height: 1.25; text-align: center; text-shadow: 0 1px 4px rgba(0,0,0,.25); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-all;">${escapeHtml(name)}</div>
                        ${playBtn}
                    </div>
                    <div class="media-card-title">${escapeHtml(name)}</div>
                    <div class="media-card-sub">${count} 个电台</div>
                    ${checkHtml}
                </div>
            `;
        });
        html += `</div>`;
        content.innerHTML = html;
    },

    /**
     * 新增分类：创建后以卡片形式出现在网格中
     */
    addCategory() {
        const dim = this.currentDimension;
        if (!dim) return;
        const name = (window.prompt('请输入新分类名称：') || '').trim();
        if (!name) return;
        const exists = (this.dimensions[dim] || []).some((s) => s.subTitle === name);
        if (exists) {
            showToast('分类名称已存在', 'warning');
            return;
        }
        // 追加到维度结构
        this.dimensions[dim] = this.dimensions[dim] || [];
        this.dimensions[dim].push({ subTitle: name, stations: [] });
        // 同步到第一个插件源数据的分组（保持结构一致）
        const firstPlugin = (this.data || [])[0];
        if (firstPlugin) {
            firstPlugin.groups = firstPlugin.groups || [];
            if (!firstPlugin.groups.some((g) => g.subTitle === name)) {
                firstPlugin.groups.push({ subTitle: name, stations: [] });
            }
        }
        // 排到末尾并持久化
        const order = this.getOrderArray(dim).filter((t) => t !== name);
        order.push(name);
        this.saveOrder(dim, order);
        showToast(`已创建分类「${name}」`, 'success');
        this.renderTabs();
        this.renderCategoryCards();
    },

    /**
     * 管理模式：切换分类卡片勾选
     */
    toggleCategorySelect(name) {
        this.categorySelected = this.categorySelected || new Set();
        if (this.categorySelected.has(name)) this.categorySelected.delete(name);
        else this.categorySelected.add(name);
        this.renderCategoryCards();
    },

    /**
     * 管理模式：全选 / 取消全选分类
     */
    toggleSelectAllCategories() {
        this.categorySelected = this.categorySelected || new Set();
        const subs = this.sortedSubs();
        if (this.categorySelected.size === subs.length) this.categorySelected.clear();
        else subs.forEach((s) => this.categorySelected.add(s.subTitle));
        this.renderCategoryCards();
    },

    /**
     * 管理模式：删除勾选的分类（仅移除分类分组结构，不删除电台数据）
     */
    deleteSelectedCategories() {
        const names = Array.from(this.categorySelected || []);
        if (!names.length) return;
        const ok = typeof window.confirm === 'function'
            ? window.confirm(`确定删除选中的 ${names.length} 个分类吗？\n（仅移除分类分组，电台数据不会删除，重新加载插件后可能恢复）`)
            : true;
        if (!ok) return;
        const set = new Set(names);
        const dim = this.currentDimension;
        // 从维度结构移除
        this.dimensions[dim] = (this.dimensions[dim] || []).filter((s) => !set.has(s.subTitle));
        // 同步清理插件源数据中的分组（组内电台置空，保留分组结构以防插件重载逻辑异常）
        for (const plugin of this.data || []) {
            for (const g of plugin.groups || []) {
                if (set.has(g.subTitle)) g.stations = [];
            }
        }
        // 清理当前列表缓存与分类→分组反查缓存
        if (this.currentList) this.currentList = this.currentList.filter((s) => !set.has(s.group));
        this._groupIndex = null;
        this.categorySelected.clear();
        // 清理自定义顺序中的残留并持久化
        this.saveOrder(dim, this.getOrderArray(dim).filter((t) => !set.has(t)));
        showToast(`已删除 ${names.length} 个分类`, 'success');
        this.renderTabs();
        this.renderCategoryCards();
    },

    /**
     * 返回分类卡片网格（并恢复默认顶部菜单）
     */
    backToCategories() {
        this.currentSubTitle = '';
        this.manageMode = false;
        this.stationSelected.clear();
        // 恢复默认顶部菜单：菜单按钮 + 「电台」标题
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
                <div class="header-title" id="page-title">电台</div>
            `;
        }
        this.renderTabs();
        this.renderCategoryCards();
    },

    /**
     * 直接播放某分类的第一首电台（分类卡片悬浮播放按钮）
     */
    playCategory(subTitle) {
        this.openSubItem(subTitle);
        this.playFromSubItem(0);
    },

    /**
     * 窗口尺寸变化时按新宽度重算子菜单外侧 / 「更多」的分配（防抖）
     */
    bindSubMenuResize() {
        if (this._rsBound) return;
        this._rsBound = true;
        let timer = null;
        window.addEventListener('resize', () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const page = document.getElementById('page-radio');
                if (!page || !page.classList.contains('active') || this.myRadioMode) return;
                this.moreOpen = false; // 宽度变了，面板位置失效，先收起
                this.renderSubMenu();
            }, 150);
        });
    },

    /**
     * 打开某个子菜单下的电台列表
     */
    /**
     * 点击子菜单项入口：拖拽落位后浏览器/触摸手势可能补发一次 click，
     * 短时间内忽略，避免拖完顺手一下就切换分类、瞬间渲染大量电台卡片而卡顿
     */
    openSubItemFromMenu(subTitle) {
        if (this._lastDropAt && Date.now() - this._lastDropAt < 300) {
            this._lastDropAt = 0;
            this.moreOpen = false;
            this.renderSubMenu();
            return;
        }
        this.openSubItem(subTitle);
    },

    openSubItem(subTitle) {
        const subs = this.dimensions[this.currentDimension] || [];
        const sub = subs.find((s) => s.subTitle === subTitle);
        if (!sub) return;
        this.currentSubTitle = subTitle;
        this.moreOpen = false;

        const content = document.getElementById('radio-content');
        if (!content) return;

        // 进入管理模式时，清空上一次勾选；避免跨子菜单残留勾选
        if (this.isStationManage()) this.stationSelected.clear();

        // 记录当前展示列表（带维度/分组信息，供播放与收藏使用）
        this.currentList = sub.stations.map((s) => Object.assign({}, s, {
            dimension: this.currentDimension,
            group: sub.subTitle
        }));

        // 顶部菜单：显示「返回按钮 + 分类名」（返回分类卡片网格）
        if (typeof PluginTabs !== 'undefined' && PluginTabs.renderWithBack) {
            PluginTabs.renderWithBack({
                title: subTitle,
                onBack: () => this.backToCategories()
            });
        }

        // 「普通电台列表」管理模式：顶部工具条（全选 / 删除(N) / 完成），复用与收藏一致的按钮 id
        const stationManage = this.isStationManage();
        const manageBtns = stationManage ? `
            <div class="media-card-toolbar">
                <div style="display:flex; gap:8px; align-items:center;">
                    <button class="btn btn-secondary btn-sm" id="radio-fav-selectall-btn" onclick="RadioModule.toggleSelectAllFavorites()">全选</button>
                    <button class="btn btn-danger btn-sm" id="radio-fav-delete-btn" onclick="RadioModule.deleteSelectedFavorites()"
                        disabled style="opacity:.5; cursor:not-allowed;">删除</button>
                    <button class="btn btn-secondary btn-sm" onclick="RadioModule.toggleStationManageMode()">完成</button>
                </div>
                <div id="radio-fav-count" style="font-size:14px; color:var(--text-secondary); text-align:right;">
                    ${this.currentList.length} 个
                </div>
            </div>
            <div class="media-card-hint">
                <div style="padding:12px; background:var(--bg-secondary); border-radius:8px; font-size:13px; color:var(--text-secondary);">
                    <span style="margin-right:8px;">💡</span>点击卡片多选可批量删除
                </div>
            </div>` : '';

        // 管理模式：网格复用 radio-fav-grid id，使现有拖拽高亮/排序逻辑可直接复用；
        // 同时挂网格级别的拖拽落点（拖到空白处移到末尾）。
        const gridId = stationManage ? ' id="radio-fav-grid"' : '';
        const gridDragAttr = stationManage
            ? ` ondragover="RadioModule.favGridDragOver(event)" ondragleave="RadioModule.favGridDragLeave(event)" ondrop="RadioModule.favDropToEnd(event)"`
            : '';

        let html = manageBtns + `<div class="radio-station-list media-card-grid"${gridId}${gridDragAttr}>`;
        this.currentList.forEach((s, i) => {
            html += this.stationCardHtml(s, i);
        });
        html += `</div>`;
        content.innerHTML = html;
    },

    /**
     * 电台卡片 HTML（含左上角收藏爱心）
     */
    stationCardHtml(s, i) {
        const faved = this.favSet.has(String(s.id));
        // 封面按电台名自动匹配电台插件 covers 目录下的图片（GET /api/radio/cover?name=<电台名>）
        const cover = `/api/radio/cover?name=${encodeURIComponent(s.name || '')}`;
        const title = s.name || '未知电台';
        const meta = [s.genre].filter(Boolean).join(' · ');
        // 始终以标题色作为底色，封面图加载后覆盖；加载失败则回退到 📻 + 标题色
        const bg = this.colorFromText(title);
        const heart = faved ? '♥' : '♡';
        const idAttr = escapeHtml(s.id);
        const manage = this.manageMode;
        const isStationManage = this.isStationManage();
        // 管理模式右上角：拖拽手柄（编辑/删除改到管理模式时卡片下方显示；删除也可走顶部批量按钮）
        // 非管理模式：右上角不再常显编辑/删除，保持卡片干净
        const topRight = manage
            ? `<div title="拖动排序" style="position:absolute; top:6px; right:6px; font-size:15px; line-height:1; cursor:grab; color:#fff; background:rgba(0,0,0,.45); border-radius:6px; padding:4px 7px; z-index:3; user-select:none;">⠿</div>`
            : '';
        const heartHtml = manage ? '' : `<div class="radio-heart ${faved ? 'faved' : ''}" data-id="${idAttr}" onclick="RadioModule.toggleFavorite(event, '${idAttr}')" title="收藏电台"
            style="position:absolute; top:6px; left:6px; font-size:22px; line-height:1; cursor:pointer; color:${faved ? '#ff4d4f' : 'rgba(255,255,255,.85)'}; text-shadow:0 1px 3px rgba(0,0,0,.55); z-index:3; user-select:none;">${heart}</div>`;
        // 管理模式：左上角为勾选框（爱心位置）；点击卡片切换勾选，不再直接播放
        const selSet = isStationManage ? this.stationSelected : this.favSelected;
        const selected = manage && selSet.has(String(s.id));
        const checkHtml = manage ? `<div class="radio-fav-check" data-id="${idAttr}"
            style="position:absolute; top:6px; left:6px; width:22px; height:22px; border-radius:50%; box-sizing:border-box;
                   border:1.5px solid ${selected ? 'var(--primary-color)' : 'rgba(255,255,255,.75)'};
                   background:${selected ? 'var(--primary-color)' : 'rgba(0,0,0,.35)'};
                   color:#fff; font-size:13px; line-height:19px; text-align:center; z-index:3; user-select:none;">${selected ? '✓' : ''}</div>` : '';
        const clickAttr = manage
            ? `onclick="RadioModule.toggleFavSelect(${i})"`
            : `onclick="RadioModule.playFromSubItem(${i})"`;
        const hoverAttr = manage ? '' : `onmouseover="this.style.transform='scale(1.02)'" onmouseout="this.style.transform='scale(1)'"`;
        // 管理模式：卡片可拖拽排序（普通电台列表与「我的电台」收藏一致）
        // 触屏设备不用 HTML5 拖放（手机不触发且会卡死），改用长按触摸排序（data-td-index）
        const dragAttr = manage
            ? (this._pdSupported
                ? `data-td-index="${i}"`
                : `draggable="true" ondragstart="RadioModule.favDragStart(event, ${i})" ondragend="RadioModule.favDragEnd(event)" ondragover="RadioModule.favDragOver(event, ${i})" ondrop="RadioModule.favDrop(event, ${i})"`)
            : '';
        // 管理模式：卡片下方显示「编辑 / 删除」圆形图标按钮（参照「我的歌单」管理模式）
        const actionsHtml = manage ? `
            <div class="radio-card-actions" style="display:flex; gap:8px; margin-top:8px; justify-content:center; align-items:center;">
                <button type="button" title="编辑电台" onclick="event.stopPropagation(); RadioModule.editStationByIndex(${i})"
                    style="width:30px; height:30px; border-radius:50%; border:none; background:rgba(255,255,255,.08); color:var(--text-color); cursor:pointer; display:inline-flex; align-items:center; justify-content:center;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button type="button" title="删除电台" onclick="event.stopPropagation(); RadioModule.deleteStationByIndex(${i})"
                    style="width:30px; height:30px; border-radius:50%; border:none; background:rgba(255,255,255,.08); color:var(--danger-color, #ff4d4f); cursor:pointer; display:inline-flex; align-items:center; justify-content:center;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
            </div>` : '';
        return `
            <div class="radio-card media-card recommend-sheet-card ${selected ? 'fav-selected' : ''}" data-id="${idAttr}"
                style="transition:transform 0.2s; border-radius:10px;
                       box-shadow:${selected ? '0 0 0 2px var(--primary-color)' : 'none'};"
                data-i="${i}" ${clickAttr} ${hoverAttr} ${dragAttr}>
                <div class="toplist-cover media-card-cover" style="background:${bg}; display:flex; align-items:center; justify-content:center; font-size:38px; overflow:hidden;">
                    <span style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center;">📻</span>
                    <img src="${escapeHtml(cover)}" alt="${escapeHtml(title)}" draggable="false" loading="lazy" decoding="async" style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover;" onerror="this.style.display='none';">
                    ${heartHtml}
                    ${checkHtml}
                    ${topRight}
                </div>
                <div class="toplist-name media-card-title" style="margin-bottom:4px;">${escapeHtml(title)}</div>
                <div class="toplist-desc media-card-sub">${escapeHtml(meta)}</div>
                ${actionsHtml}
            </div>
        `;
    },

    /**
     * 用插件实时数据覆盖收藏快照：地址/封面/分类随插件更新。
     * 若插件中已没有该 id 的电台（被移除），则保留收藏时的快照。
     */
    resolveLive(station) {
        const live = (this.stationsFlat || []).find((x) => String(x.id) === String(station.id));
        return live ? { ...station, ...live } : station;
    },

    /**
     * 渲染「喜欢」收藏列表
     */
    renderFavorites() {
        const content = document.getElementById('radio-content');
        if (!content) return;
        if (!this.favorites.length) {
            // 收藏被删空：退出管理模式，避免顶部「完成」按钮消失后状态残留
            this.manageMode = false;
            this.favSelected.clear();
            content.innerHTML = this.emptyHtml('还没有收藏的电台，点击电台左上角的 ♡ 即可加入');
            return;
        }
        // 用插件实时数据覆盖收藏快照：地址/封面/分类随插件更新；插件已移除则保留快照
        this.currentList = this.favorites.map((f) => this.resolveLive(f));
        const n = this.favSelected.size;
        // 与「我的歌单」一致：普通模式无工具条（播放/管理在页头「⋯」菜单），管理模式才出现操作条
        const manageBtns = this.manageMode ? `
            <button class="btn btn-secondary btn-sm" id="radio-fav-selectall-btn" onclick="RadioModule.toggleSelectAllFavorites()">${n && n === this.currentList.length ? '取消全选' : '全选'}</button>
            <button class="btn btn-danger btn-sm" id="radio-fav-delete-btn" onclick="RadioModule.deleteSelectedFavorites()"
                ${n ? '' : 'disabled'} style="${n ? '' : 'opacity:.5; cursor:not-allowed;'}">删除${n ? ` (${n})` : ''}</button>
            <button class="btn btn-secondary btn-sm" onclick="RadioModule.toggleManageMode()">完成</button>` : '';
        const hint = this.manageMode ? `
            <span style="font-size: 13px; color: var(--text-secondary);"><span style="margin-right: 8px;">💡</span>点击卡片可多选，拖拽卡片可排序</span>` : '';
        const header = this.manageMode ? `
            <div class="media-card-toolbar">
                <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                    ${hint}
                </div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                    ${manageBtns}
                    <div id="radio-fav-count" style="font-size:13px; color:var(--text-secondary);">
                        ${this.currentList.length} 个${n ? ` · 已选 ${n}` : ''}
                    </div>
                </div>
            </div>` : '';
        // 页头「⋯」菜单（与我的歌单一致）：普通模式下播放/管理入口收进页头；标题带计数
        this.setupFavHeader(this.currentList.length);
        // 管理模式下网格自身也接收拖拽：落在卡片间隙时移到末尾
        const gridDragAttr = this.manageMode
            ? `ondragover="RadioModule.favGridDragOver(event)" ondragleave="RadioModule.favGridDragLeave(event)" ondrop="RadioModule.favDropToEnd(event)"`
            : '';
        let html = `<div class="radio-station-list media-card-grid" id="radio-fav-grid" ${gridDragAttr}>`;
        this.currentList.forEach((s, i) => {
            html += this.stationCardHtml(s, i);
        });
        html += `</div>`;
        content.innerHTML = header + hint + html;
    },

    /**
     * 页头「⋯」菜单（与我的歌单一致）：播放全部 / 管理；标题带计数
     */
    setupFavHeader(count) {
        const headerLeft = document.getElementById('header-left');
        if (!headerLeft) return;
        const title = headerLeft.querySelector('.header-title');
        const pageTitle = (title ? title.textContent : '我的电台').replace(/（.*?）$/, '');
        headerLeft.style.position = 'relative';
        headerLeft.innerHTML = `
            <button class="mobile-menu-btn" onclick="toggleMobileSidebar()" aria-label="打开菜单">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="3" y1="12" x2="21" y2="12"></line>
                    <line x1="3" y1="6" x2="21" y2="6"></line>
                    <line x1="3" y1="18" x2="21" y2="18"></line>
                </svg>
            </button>
            <div class="header-title" id="page-title" style="position: absolute; left: 50%; transform: translateX(-50%); margin: 0;">${pageTitle}（${count || 0}个）</div>
            <div style="margin-left: auto; position: relative; display: flex; align-items: center;">
                <button type="button" title="更多" aria-label="更多"
                    onclick="event.stopPropagation(); RadioModule.toggleFavMenu()"
                    class="header-icon-btn">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
                </button>
                <div id="radio-fav-menu"
                    style="display: none; position: absolute; right: 0; top: calc(100% + 6px); min-width: 150px; background: var(--surface-color); border: 1px solid var(--divider-color); border-radius: 10px; box-shadow: var(--shadow-lg); z-index: 1001; padding: 6px 0; overflow: hidden;">
                    <button type="button" onclick="event.stopPropagation(); RadioModule.playAllFavorites(); RadioModule.closeFavMenu();"
                        style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">播放全部</button>
                    <button type="button" onclick="event.stopPropagation(); RadioModule.toggleManageMode(); RadioModule.closeFavMenu();"
                        style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--danger-color, #ff4d4f); font-size: 14px; cursor: pointer; text-align: left;">${this.manageMode ? '完成删除' : '管理'}</button>
                </div>
            </div>
        `;
    },

    /** 页头「⋯」菜单开关 */
    toggleFavMenu() {
        const menu = document.getElementById('radio-fav-menu');
        if (!menu) return;
        menu.style.display = menu.style.display !== 'block' ? 'block' : 'none';
        if (menu.style.display === 'block') {
            setTimeout(() => document.addEventListener('click', RadioModule.closeFavMenu), 0);
        }
    },

    closeFavMenu() {
        const menu = document.getElementById('radio-fav-menu');
        if (menu) menu.style.display = 'none';
        document.removeEventListener('click', RadioModule.closeFavMenu);
    },

    // ==================== 「我的电台」管理：拖拽排序 ====================

    /**
     * 收藏网格里的所有卡片
     */
    favCards() {
        const grid = document.getElementById('radio-fav-grid');
        return grid ? Array.prototype.slice.call(grid.querySelectorAll('.radio-card')) : [];
    },

    /**
     * 清除所有卡片的拖拽高亮与半透明态
     */
    clearFavDropHints() {
        const cards = this.favCards();
        for (let i = 0; i < cards.length; i++) {
            cards[i].style.outline = '';
            cards[i].style.outlineOffset = '';
            // 被拖拽的卡片保持半透明，其余恢复
            cards[i].style.opacity = String(i) === String(this.favDragIndex) ? '.5' : '1';
        }
    },

    favDragStart(event, i) {
        this.favDragIndex = i;
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            try { event.dataTransfer.setData('text/plain', String(i)); } catch (e) { /* ignore */ }
        }
        const el = event.currentTarget;
        if (el) el.style.opacity = '.5';
    },

    favDragEnd() {
        this.favDragIndex = null;
        this.clearFavDropHints();
    },

    /**
     * 悬停在某张卡片上：显示插入位置高亮（起点卡片不高亮）
     */
    favDragOver(event, i) {
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        this.clearFavDropHints();
        const card = this.favCards()[i];
        if (card && String(i) !== String(this.favDragIndex)) {
            card.style.outline = '3px solid var(--primary-color)';
            card.style.outlineOffset = '-3px';
        }
    },

    favGridDragOver(event) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    },

    favGridDragLeave(event) {
        const related = event.relatedTarget;
        if (related && related.closest && related.closest('#radio-fav-grid')) return;
        this.clearFavDropHints();
    },

    /**
     * 落在某张卡片上：把拖拽项插到该位置
     */
    async favDrop(event, i) {
        event.preventDefault();
        event.stopPropagation();
        const from = this.favDragIndex;
        this.favDragIndex = null;
        this.clearFavDropHints();
        if (from == null || from === i) return;
        if (this.isStationManage()) { await this.moveStation(from, i); return; }
        await this.moveFavorite(from, i);
    },

    /**
     * 落在网格空白处：移到末尾
     */
    async favDropToEnd(event) {
        event.preventDefault();
        const from = this.favDragIndex;
        this.favDragIndex = null;
        this.clearFavDropHints();
        if (from == null) return;
        if (this.isStationManage()) { await this.moveStation(from, this.currentList.length - 1); return; }
        await this.moveFavorite(from, this.favorites.length - 1);
    },

    /**
     * 重排收藏数组并重渲染，随后持久化到后端
     */
    async moveFavorite(from, to) {
        const arr = this.favorites.slice();
        if (from < 0 || from >= arr.length) return;
        const [moved] = arr.splice(from, 1);
        arr.splice(Math.max(0, Math.min(to, arr.length)), 0, moved);
        this.favorites = arr;
        // 与子菜单 drop 同理：等事件派发结束再重建 DOM，避免拖放状态机卡住
        setTimeout(() => this.renderFavorites(), 0);
        await this.saveFavOrder();
    },

    /**
     * 重排「普通电台列表」当前子项的电台数组并重新渲染（保留管理模式），随后持久化到后端
     */
    async moveStation(from, to) {
        const arr = this.currentList.slice();
        if (from < 0 || from >= arr.length) return;
        const [moved] = arr.splice(from, 1);
        arr.splice(Math.max(0, Math.min(to, arr.length)), 0, moved);
        this.currentList = arr;
        // 同步到维度结构，使重新进入该子项时顺序一致。
        // 注意：this.dimensions[维度] 是数组，必须按 subTitle 查找，不能用下标/键名直接取值。
        const subs = this.dimensions[this.currentDimension] || [];
        const sub = subs.find((s) => s.subTitle === this.currentSubTitle);
        if (sub) sub.stations = arr.map((s) => Object.assign({}, s));
        // 持久化分组内自定义顺序（插件来源电台也能保存，刷新后仍保留）
        this.stationOrder[this.groupKey(this.currentDimension, this.currentSubTitle)] = arr.map((s) => String(s.id));
        this.saveStationOrderLocal();
        // 等 drop 事件派发结束后再重建列表，避免拖放状态机卡住
        const keepSub = this.currentSubTitle;
        setTimeout(() => {
            this._lastDropAt = 0; // 本次是程序内部重渲染，不能被落位后的防误触拦截挡掉
            this.openSubItem(keepSub);
        }, 0);
        await this.saveStationOrder();
    },

    /**
     * 分组（维度+子项）顺序的存储 key
     */
    groupKey(dim, sub) {
        return String(dim) + '::' + String(sub);
    },

    /**
     * 应用本地保存的分组（维度+子项）内电台顺序；未保存过或新增电台则保持原样（新增的排末尾）
     */
    applyStationOrder(dim, sub, stations) {
        const order = this.stationOrder[this.groupKey(dim, sub)];
        if (!Array.isArray(order) || !order.length) return stations;
        const present = {};
        for (const s of stations) present[String(s.id)] = s;
        const out = [];
        const used = new Set();
        for (const id of order) {
            const s = present[String(id)];
            if (s) { out.push(s); used.add(String(id)); }
        }
        // 追加本地顺序中未记录的电台（如新导入/新增的），排到末尾
        for (const s of stations) if (!used.has(String(s.id))) out.push(s);
        return out;
    },

    /**
     * 保存分组内电台自定义顺序到本地（插件来源电台也能持久化），并同步服务端
     */
    saveStationOrderLocal() {
        try {
            localStorage.setItem('radio-station-order', JSON.stringify(this.stationOrder));
        } catch (e) { /* ignore */ }
        this.syncOrdersToServer();
    },

    /**
     * 保存当前子项的电台排序（后端按 ids 顺序重写该分组的 sort_order）
     */
    async saveStationOrder() {
        const ids = (this.currentList || []).map((s) => String(s.id));
        try {
            const r = await API.radio.reorderStations(this.currentDimension, this.currentSubTitle, ids);
            if (r && r.success) {
                showToast('排序已保存', 'success');
            } else {
                showToast('保存排序失败: ' + ((r && r.error) || '未知错误'), 'error');
            }
        } catch (e) {
            showToast('保存排序失败: ' + (e && e.message ? e.message : ''), 'error');
        }
    },

    /**
     * 保存收藏排序（后端按 ids 顺序重写收藏列表）
     */
    async saveFavOrder() {
        const ids = this.favorites.map((f) => String(f.id));
        try {
            const r = await API.radio.reorderFavorites(ids);
            if (r && r.success) {
                if (Array.isArray(r.data)) {
                    this.favorites = r.data;
                    this.favSet = new Set(this.favorites.map((x) => String(x.id)));
                }
                showToast('排序已保存', 'success');
            } else {
                showToast('保存排序失败: ' + ((r && r.error) || '未知错误'), 'error');
            }
        } catch (e) {
            showToast('保存排序失败: ' + (e && e.message ? e.message : ''), 'error');
        }
    },

    // ==================== 「我的电台」管理：多选删除 ====================

    /**
     * 点击卡片切换勾选状态（管理模式；普通列表与收藏共用同一入口）
     */
    toggleFavSelect(i) {
        // 卡片拖拽落位后可能补发一次 click，短时间内忽略，避免拖完顺手勾选/取消勾选
        if (this._lastDropAt && Date.now() - this._lastDropAt < 300) {
            this._lastDropAt = 0;
            return;
        }
        const s = this.currentList[i];
        if (!s) return;
        const id = String(s.id);
        if (this.isStationManage()) {
            if (this.stationSelected.has(id)) this.stationSelected.delete(id);
            else this.stationSelected.add(id);
        } else {
            if (this.favSelected.has(id)) this.favSelected.delete(id);
            else this.favSelected.add(id);
        }
        this.syncSelectionUI();
    },

    /**
     * 全选 / 取消全选（管理模式；普通列表与收藏共用）
     */
    toggleSelectAllFavorites() {
        const ids = (this.currentList || []).map((s) => String(s.id));
        const set = this.isStationManage() ? this.stationSelected : this.favSelected;
        const allSelected = ids.length > 0 && ids.every((id) => set.has(id));
        const newSet = allSelected ? new Set() : new Set(ids);
        if (this.isStationManage()) this.stationSelected = newSet;
        else this.favSelected = newSet;
        this.syncSelectionUI();
    },

    /**
     * 局部刷新勾选态：卡片勾选框 / 高亮 + 顶部「全选」「删除(N)」按钮
     * 同时适配「我的电台」收藏网格与「普通电台列表」网格（两者复用同一套按钮 id）
     */
    syncSelectionUI() {
        const set = this.isStationManage() ? this.stationSelected : this.favSelected;
        const cards = document.querySelectorAll('#radio-fav-grid .radio-card, .radio-station-list .radio-card');
        for (const card of cards) {
            const on = set.has(String(card.dataset.id));
            card.classList.toggle('fav-selected', on);
            card.style.boxShadow = on ? '0 0 0 2px var(--primary-color)' : 'none';
            const box = card.querySelector('.radio-fav-check');
            if (box) {
                box.textContent = on ? '✓' : '';
                box.style.background = on ? 'var(--primary-color)' : 'rgba(0,0,0,.35)';
                box.style.borderColor = on ? 'var(--primary-color)' : 'rgba(255,255,255,.75)';
            }
        }
        const n = set.size;
        const delBtn = document.getElementById('radio-fav-delete-btn');
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
        const allBtn = document.getElementById('radio-fav-selectall-btn');
        if (allBtn) {
            allBtn.textContent = (n && n === (this.currentList || []).length) ? '取消全选' : '全选';
        }
        // 左侧计数里的「已选 N 个」
        const countEl = document.getElementById('radio-fav-count');
        if (countEl) {
            countEl.textContent = `${(this.currentList || []).length} 个${this.manageMode && n ? ` · 已选 ${n}` : ''}`;
        }
    },

    /**
     * 删除已勾选的收藏电台（二次确认后逐个取消收藏）
     */
    async deleteSelectedFavorites() {
        // 「普通电台列表」管理模式下，走电台删除流程
        if (this.isStationManage()) {
            await this.deleteSelectedStations();
            return;
        }
        const ids = Array.from(this.favSelected);
        if (!ids.length) return;
        const msg = `确定要从「我的电台」移除选中的 ${ids.length} 个电台吗？`;
        let ok = false;
        try {
            if (window.Notification && typeof window.Notification.confirm === 'function') {
                ok = await window.Notification.confirm(msg, { type: 'warning' });
            } else if (typeof showConfirmModal === 'function') {
                showConfirmModal({
                    title: '删除电台',
                    message: msg,
                    confirmText: '删除',
                    confirmClass: 'btn-danger',
                    onConfirm: () => this.doDeleteFavorites(ids)
                });
                return;
            } else {
                ok = window.confirm(msg);
            }
        } catch (e) {
            ok = false;
        }
        if (!ok) return;
        await this.doDeleteFavorites(ids);
    },

    /**
     * 逐个取消收藏并刷新视图
     */
    async doDeleteFavorites(ids) {
        const target = new Set(ids.map((x) => String(x)));
        let done = 0;
        showToast('正在移除...', 'info');
        for (const id of ids) {
            try {
                const r = await API.radio.removeFavorite(id);
                if (r && r.success) {
                    done++;
                    this.favSet.delete(String(id));
                    if (Array.isArray(r.data)) this.favorites = r.data;
                }
            } catch (e) { /* 单个失败继续删其余 */ }
        }
        // 兜底：接口未返回最新列表时，本地按 id 过滤，保证界面与服务端一致
        this.favorites = (this.favorites || []).filter((f) => !target.has(String(f.id)));
        this.favSet = new Set(this.favorites.map((x) => String(x.id)));
        this.favSelected.clear();
        // 顶部「喜欢（N）」数量随收藏变化实时更新
        this.renderTabs();
        this.renderFavorites();
        showToast(done ? `已移除 ${done} 个电台` : '移除失败，请重试', done ? 'success' : 'error');
    },

    backToSubMenu() {
        this.currentSubTitle = '';
        this.renderSubMenu();
        const content = document.getElementById('radio-content');
        if (content) {
            content.innerHTML = `
                <div class="empty-state" style="min-height:100%; display:flex; flex-direction:column; justify-content:center; align-items:center;">
                    <div class="empty-icon">👇</div>
                    <div class="empty-text">请选择上方的${escapeHtml(this.currentDimension)}子菜单</div>
                </div>
            `;
        }
    },

    playFromSubItem(index) {
        const list = this.currentList || [];
        const station = list[index];
        if (!station) return;
        this.play(station);
    },

    /**
     * 播放「我的电台」全部收藏电台（以当前收藏列表为播放队列，从第 0 首开始）
     */
    playAllFavorites() {
        const list = this.currentList || [];
        if (!list.length) {
            showToast('没有可播放的电台', 'error');
            return;
        }
        this.play(list[0]);
    },

    /**
     * 播放单个电台
     */
    play(station) {
        if (!station || !station.url) {
            showToast('电台地址无效，无法播放', 'error');
            return;
        }
        const toSong = (s) => ({
            id: s.id,
            title: s.name || '未知电台',
            // 电台没有歌手，artist 依次回退：分类 → 省份 → 地区 → 流派 →
            // 当前所在分组（如「省市台/江苏」的「江苏」）→ 反查所属分组，避免显示「未知艺术家」
            artist: (Array.isArray(s.categories) && s.categories.length ? s.categories.join(' / ') : '')
                || s.province || s.region || (s.genre || '')
                || s.group || s.dimension || this.stationGroupLabel(s.id) || '',
            name: s.name,
            url: s.url,
            artwork: `/api/radio/cover?name=${encodeURIComponent(s.name || '')}`,
            isLive: true,
            plugin: 'radio',
            platform: 'radio',
            sourcePlugin: s.plugin,
            bitrate: s.bitrate || 0
        });
        // 只把当前子页面的电台加入播放列表
        const list = (this.currentList && this.currentList.length) ? this.currentList : this.stationsFlat;
        window.currentPageMusicList = list.map(toSong);
        const playIndex = list.findIndex((s) => s.id === station.id);
        if (typeof playMusic === 'function') {
            playMusic(playIndex >= 0 ? playIndex : 0);
            showToast(`正在播放: ${station.name}`, 'success');
        }
    },

    isFav(id) {
        return this.favSet.has(String(id));
    },

    /**
     * 切换电台收藏状态（点击左上角爱心）
     */
    async toggleFavorite(event, id) {
        if (event) { event.stopPropagation(); event.preventDefault(); }
        id = String(id);
        const station = (this.currentList || []).find((x) => String(x.id) === id);
        const faved = this.favSet.has(id);
        try {
            if (faved) {
                const r = await API.radio.removeFavorite(id);
                this.favSet.delete(id);
                if (r && r.success && Array.isArray(r.data)) this.favorites = r.data;
                else this.favorites = this.favorites.filter((x) => String(x.id) !== id);
            } else {
                if (!station) { showToast('电台信息缺失，无法收藏', 'error'); return; }
                const r = await API.radio.addFavorite(station);
                this.favSet.add(id);
                if (r && r.success && Array.isArray(r.data)) this.favorites = r.data;
            }
        } catch (e) {
            showToast('操作失败: ' + (e && e.message ? e.message : ''), 'error');
            return;
        }
        // 更新当前视图中所有该电台的爱心图标
        document.querySelectorAll(`.radio-heart[data-id="${id}"]`).forEach((el) => {
            const nowFav = this.favSet.has(id);
            el.classList.toggle('faved', nowFav);
            el.textContent = nowFav ? '♥' : '♡';
            el.style.color = nowFav ? '#ff4d4f' : 'rgba(255,255,255,.85)';
        });
        // 顶部「喜欢（N）」数量随收藏变化实时更新
        this.renderTabs();
        // 在「我的电台」视图取消收藏时，整体重渲染（更新数量并保留管理态）
        if (this.currentDimension === this.FAV_DIM) {
            this.renderFavorites();
        }
    },

    // ==================== 新增 / 编辑 / 删除电台（数据库驱动） ====================
    loadDistinctValues() {
        this._provinceValues = this.distinctValues('province');
        this._categoryValues = this.distinctValues('category');
        this._networkValues = this.distinctValues('network');
    },

    distinctValues(field) {
        const set = new Set();
        for (const s of (this.stationsFlat || [])) {
            const v = s && s[field];
            if (v) set.add(v);
        }
        return Array.from(set).sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
    },

    // 自绘主题下拉：避开浏览器原生 select 在深色主题下的白底弹层；
    // 容器内构建触发按钮 + 选项弹层，外部点击关闭，值存到 this._rsState[field]。
    buildRsDropdown(field, options, currentValue, required) {
        const container = document.getElementById('rs-' + field + '-container');
        if (!container) return;
        this._rsState = this._rsState || {};
        const state = { value: '', custom: '', isCustom: false, required: !!required };
        this._rsState[field] = state;

        // 决定初始值
        if (currentValue) {
            if (options.indexOf(currentValue) >= 0) state.value = currentValue;
            else { state.value = '__custom__'; state.custom = currentValue; state.isCustom = true; }
        }

        const placeholder = required ? '（必选）' : '（不选）';
        const displayLabel = state.isCustom ? (state.custom || placeholder) : (state.value || placeholder);

        const opts = [];
        if (!required) opts.push({ value: '', label: '（不选）' });
        for (const o of options) opts.push({ value: o, label: o });
        opts.push({ value: '__custom__', label: '➕ 自定义…' });

        const optsHtml = opts.map((o) =>
            '<div class="rs-option" data-value="' + escapeHtml(o.value) + '">' + escapeHtml(o.label) + '</div>'
        ).join('');

        container.innerHTML =
            '<button type="button" class="rs-trigger">' +
                '<span class="rs-trigger-label">' + escapeHtml(displayLabel) + '</span>' +
                '<span class="rs-trigger-arrow">▾</span>' +
            '</button>' +
            '<div class="rs-popup" style="display:none;">' + optsHtml + '</div>';

        const customInput = document.getElementById('rs-' + field + '-custom');
        if (customInput) {
            customInput.value = state.custom || '';
            customInput.style.display = state.isCustom ? 'block' : 'none';
        }

        const trigger = container.querySelector('.rs-trigger');
        const popup = container.querySelector('.rs-popup');
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleRsDropdown(field, popup);
        });
        popup.addEventListener('click', (e) => {
            const opt = e.target.closest('.rs-option');
            if (!opt) return;
            const v = opt.getAttribute('data-value');
            this.chooseRsOption(field, v);
        });
        if (customInput) {
            customInput.addEventListener('input', () => {
                const st = this._rsState[field];
                if (!st || !st.isCustom) return;
                st.custom = customInput.value;
                const label = container.querySelector('.rs-trigger-label');
                const ph = st.required ? '（必选）' : '（不选）';
                if (label) label.textContent = customInput.value || ph;
            });
        }
    },

    toggleRsDropdown(field, popup) {
        const wasOpen = popup.style.display !== 'none';
        this.closeAllRsPopups();
        if (wasOpen) return;
        popup.style.display = 'block';
        this._rsOutside = (e) => {
            if (e.target && e.target.closest && e.target.closest('.rs-dropdown-wrap')) return;
            this.closeAllRsPopups();
        };
        setTimeout(() => document.addEventListener('click', this._rsOutside), 0);
    },

    chooseRsOption(field, value) {
        const state = this._rsState && this._rsState[field];
        if (!state) return;
        state.value = value;
        state.isCustom = (value === '__custom__');
        if (!state.isCustom) state.custom = '';
        const container = document.getElementById('rs-' + field + '-container');
        const label = container && container.querySelector('.rs-trigger-label');
        const customInput = document.getElementById('rs-' + field + '-custom');
        const placeholder = state.required ? '（必选）' : '（不选）';
        if (state.isCustom) {
            if (customInput) customInput.style.display = 'block';
            if (label) label.textContent = (customInput && customInput.value) || placeholder;
            if (customInput) setTimeout(() => customInput.focus(), 50);
        } else {
            if (customInput) { customInput.style.display = 'none'; customInput.value = ''; }
            if (label) label.textContent = value || placeholder;
        }
        this.closeAllRsPopups();
    },

    closeAllRsPopups() {
        const popups = document.querySelectorAll('.rs-popup');
        for (const p of popups) p.style.display = 'none';
        if (this._rsOutside) {
            document.removeEventListener('click', this._rsOutside);
            this._rsOutside = null;
        }
    },

    getRsValue(field) {
        const st = this._rsState && this._rsState[field];
        if (!st) return '';
        if (st.value === '__custom__') return (st.custom || '').trim();
        return (st.value || '').trim();
    },

    showAddStationModal() {
        this._editId = null;
        const title = document.getElementById('radio-station-modal-title');
        if (title) title.textContent = '新增电台';
        this.loadDistinctValues();
        this.buildRsDropdown('province', this._provinceValues || [], '', false);
        this.buildRsDropdown('category', this._categoryValues || [], '', false);
        this.buildRsDropdown('network', this._networkValues || [], '', false);
        const name = document.getElementById('rs-name'); if (name) name.value = '';
        const url = document.getElementById('rs-url'); if (url) url.value = '';
        const cover = document.getElementById('rs-cover-url'); if (cover) cover.value = '';
        const preview = document.getElementById('rs-cover-url-preview'); if (preview) { preview.src = ''; preview.style.display = 'none'; }
        const modal = document.getElementById('radio-station-modal');
        if (modal) modal.style.display = 'flex';
    },

    showEditStationModal(station) {
        if (!station) return;
        this._editId = station.id;
        const title = document.getElementById('radio-station-modal-title');
        if (title) title.textContent = '编辑电台';
        this.loadDistinctValues();
        this.buildRsDropdown('province', this._provinceValues || [], station.province || '', false);
        this.buildRsDropdown('category', this._categoryValues || [], station.category || '', false);
        this.buildRsDropdown('network', this._networkValues || [], station.network || '', false);
        const name = document.getElementById('rs-name'); if (name) name.value = station.name || '';
        const url = document.getElementById('rs-url'); if (url) url.value = station.url || '';
        const cover = document.getElementById('rs-cover-url'); if (cover) cover.value = '';
        const preview = document.getElementById('rs-cover-url-preview'); if (preview) { preview.src = ''; preview.style.display = 'none'; }
        const modal = document.getElementById('radio-station-modal');
        if (modal) modal.style.display = 'flex';
    },

    closeStationModal() {
        const modal = document.getElementById('radio-station-modal');
        if (modal) modal.style.display = 'none';
        this.closeAllRsPopups();
        this.hideStationMenu();
    },

    previewCoverUrl(url) {
        const preview = document.getElementById('rs-cover-url-preview');
        if (!preview) return;
        if (!url || !/^https?:\/\//i.test(url)) { preview.src = ''; preview.style.display = 'none'; return; }
        preview.onerror = () => { preview.src = ''; preview.style.display = 'none'; };
        preview.src = url;
        preview.style.display = 'block';
    },

    async submitStation() {
        const nameEl = document.getElementById('rs-name');
        const urlEl = document.getElementById('rs-url');
        const coverUrlEl = document.getElementById('rs-cover-url');
        const name = (nameEl && nameEl.value || '').trim();
        const url = (urlEl && urlEl.value || '').trim();
        const coverUrl = (coverUrlEl && coverUrlEl.value || '').trim();
        if (!name) { showToast('请输入电台名称', 'error'); return; }
        if (!url) { showToast('请输入播放地址', 'error'); return; }
        const data = {
            name: name,
            url: url,
            province: this.getRsValue('province'),
            category: this.getRsValue('category'),
            network: this.getRsValue('network')
        };
        showToast('正在保存...', 'info');
        try {
            if (coverUrl) {
                try { await API.radio.uploadCoverFromUrl(name, coverUrl); }
                catch (e) { /* 封面下载失败不阻塞电台保存 */ }
            }
            let result;
            if (this._editId != null) {
                // 用 stationsFlat 按"原始电台名"重新定位 live id，
                // 避免收藏快照里残留的 ghost id（行已删但收藏未清理）导致 PUT 旧 id 报"电台不存在"。
                // 选原始名（_menuStation.name）而非改后的输入值，否则改名时反而匹配不到自己。
                let liveId = this._editId;
                const originalName = (this._menuStation && this._menuStation.name) || name;
                if (originalName) {
                    const live = (this.stationsFlat || []).find((x) => x.name === originalName);
                    if (live && live.id != null) liveId = live.id;
                }
                result = await API.radio.updateStation(liveId, data);
            } else {
                result = await API.radio.createStation(data);
            }
            if (result && result.success) {
                showToast(this._editId != null ? '已更新电台' : '已添加电台', 'success');
                this.closeStationModal();
                this.load();
            } else {
                showToast('保存失败: ' + ((result && result.error) || '未知错误'), 'error');
            }
        } catch (e) {
            showToast('保存失败: ' + (e && e.message ? e.message : ''), 'error');
        }
    },

    showStationMenu(event) {
        if (event) { event.stopPropagation(); event.preventDefault(); }
        const btn = event && event.currentTarget;
        const card = btn && btn.closest && btn.closest('.radio-card');
        const id = card && card.dataset && card.dataset.id;
        // 按卡片 data-id 解析当前电台对象：
        //   1) 优先 stationsFlat 里的 live 数据（id 是当前 DB 真实 id）
        //   2) 兜底 currentList 里同 id 的项（卡片本来就是从 currentList 渲染的，字段完整）
        //   3) 最后才退回 {id}，避免弹窗出现"三个下拉都是(不选)+名称/地址为空"
        let s = null;
        if (id != null) {
            const live = (this.stationsFlat || []).find((x) => String(x.id) === String(id));
            const cur  = (this.currentList  || []).find((x) => String(x.id) === String(id));
            s = live || cur || { id: id };
        }
        if (!s) return;
        this._menuStation = s;
        const menu = document.getElementById('radio-station-menu');
        if (!menu) return;
        menu.style.display = 'block';
        const rect = btn.getBoundingClientRect();
        menu.style.left = Math.min(rect.left, window.innerWidth - 150) + 'px';
        menu.style.top = (rect.bottom + 6) + 'px';
        setTimeout(() => {
            this._menuOutside = (e) => {
                if (menu.contains(e.target)) return;
                this.hideStationMenu();
            };
            document.addEventListener('click', this._menuOutside);
        }, 0);
    },

    hideStationMenu() {
        const menu = document.getElementById('radio-station-menu');
        if (menu) menu.style.display = 'none';
        if (this._menuOutside) { document.removeEventListener('click', this._menuOutside); this._menuOutside = null; }
    },

    // 管理模式卡片下方「编辑」：按渲染序号取当前列表电台并打开编辑弹窗
    editStationByIndex(i) {
        const s = (this.currentList || [])[i];
        if (!s) return;
        this._menuStation = s;
        this.editStationFromMenu();
    },

    // 管理模式卡片下方「删除」：按渲染序号取当前列表电台并复用菜单删除逻辑
    async deleteStationByIndex(i) {
        const s = (this.currentList || [])[i];
        if (!s) return;
        this._menuStation = s;
        await this.deleteStationFromMenu();
    },

    editStationFromMenu() {
        const s = this._menuStation;
        this.hideStationMenu();
        this.showEditStationModal(s);
    },

    async deleteStationFromMenu() {
        const s = this._menuStation;
        this.hideStationMenu();
        if (!s) return;
        if (typeof confirm === 'function' && !confirm('确定删除电台「' + (s.name || '') + '」？')) return;
        const id = s.id != null ? String(s.id) : null;
        try {
            const r = await API.radio.deleteStation(s.id);
            if (r && r.success) {
                // 同时清理收藏快照里指向该电台的收藏。否则电台行删了、收藏还在，
                // 这张"幽灵卡片"会在 load() 后再次复活，导致怎么删都删不掉。
                if (id) {
                    try { await API.radio.removeFavorite(id); } catch (e) { /* 可能没有收藏，忽略 */ }
                    this.favSet.delete(id);
                    this.favorites = this.favorites.filter((x) => String(x.id) !== id);
                }
                showToast('已删除电台', 'success');
                this.load();
            } else {
                showToast('删除失败: ' + ((r && r.error) || '未知错误'), 'error');
            }
        } catch (e) {
            showToast('删除失败: ' + (e && e.message ? e.message : ''), 'error');
        }
    },

    // ==================== 电台 M3U 导入 / 导出 ====================
    async exportStations() {
        try {
            showToast('正在导出电台...', 'info');
            const resp = await API.radio.exportStations();
            if (!resp.ok) {
                let msg = '导出失败';
                try { const j = await resp.json(); if (j && j.error) msg = '导出失败: ' + j.error; } catch (e) { /* ignore */ }
                showToast(msg, 'error');
                return;
            }
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'radio-export.m3u';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            const saved = resp.headers.get('X-Saved-Path');
            const count = resp.headers.get('X-Station-Count') || '?';
            showToast(`已导出 ${count} 个电台` + (saved ? `（服务器另存：${saved}）` : ''), 'success');
        } catch (e) {
            showToast('导出失败: ' + (e && e.message ? e.message : ''), 'error');
        }
    },

    importStations() {
        let input = document.getElementById('radio-import-file');
        if (!input) {
            input = document.createElement('input');
            input.type = 'file';
            input.id = 'radio-import-file';
            input.accept = '.m3u,.m3u8,.txt,audio/x-mpegurl';
            input.style.display = 'none';
            document.body.appendChild(input);
        }
        input.value = '';
        input.onchange = () => {
            const f = input.files && input.files[0];
            if (!f) return;
            this.doImportStations(f);
        };
        input.click();
    },

    async doImportStations(file) {
        showToast('正在导入电台...', 'info');
        try {
            const resp = await API.radio.importStations(file);
            const r = await resp.json().catch(() => ({}));
            if (resp.ok && r.success) {
                showToast(`导入完成：新增 ${r.created || 0}，更新 ${r.updated || 0}，跳过 ${r.skipped || 0}`, 'success');
                this.load();
            } else {
                showToast('导入失败: ' + ((r && r.error) || '未知错误'), 'error');
            }
        } catch (e) {
            showToast('导入失败: ' + (e && e.message ? e.message : ''), 'error');
        }
    }
};

// 导出到全局作用域
window.RadioModule = RadioModule;
window.loadRadioStations = () => RadioModule.load();
window.renderRadioTree = (container) => RadioModule.renderTabs();
window.renderRadioGroups = (container) => RadioModule.renderTabs();
window.playRadioStation = (station) => RadioModule.play(station);
window.openRadioGroup = (pi, gi) => {};
