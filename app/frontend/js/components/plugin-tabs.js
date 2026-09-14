/**
 * 插件标签组件
 * 用于排行榜和热门歌单的插件切换标签
 */

const PluginTabs = {
    /**
     * 渲染插件标签
     * @param {Object} options - 配置选项
     * @param {Array} options.plugins - 插件列表
     * @param {string} options.currentPlugin - 当前选中的插件名
     * @param {string} options.containerId - 容器ID
     * @param {Function} options.onSwitch - 切换回调
     * @param {string} options.storageKey - localStorage存储键
     * @param {string} options.page - 页面标识
     * @param {string} options.contentContainerId - 页面内容容器ID（用于渲染到内容区域）
     */
    render(options) {
        const {
            plugins = [],
            currentPlugin = null,
            containerId = 'plugin-tabs-container',
            onSwitch = null,
            storageKey = 'pluginOrder',
            page = 'toplist',
            contentContainerId = null
        } = options;

        const headerLeft = document.getElementById('header-left');
        const pageTitle = document.getElementById('page-title');

        if (currentPage !== page) {
            if (headerLeft) {
                headerLeft.innerHTML = `<div class="header-title" id="page-title">${pageTitles[currentPage] || 'MusicHub'}</div>`;
            }
            return;
        }

        // 如果传入了内容容器ID，渲染到内容区域
        if (contentContainerId) {
            const contentContainer = document.getElementById(contentContainerId);
            if (!contentContainer) return;

            // 清空之前的标签容器（如果存在），并保留横向滚动位置，
            // 避免切换音源重渲染后菜单跳回最左（用户滑到最右的标签“跑回”原位）
            const existingTabs = contentContainer.querySelector('.plugin-tabs-wrapper');
            let savedScrollLeft = 0;
            if (existingTabs) {
                savedScrollLeft = existingTabs.scrollLeft;
                existingTabs.remove();
            }

            // 如果没有插件，不渲染标签
            if (!plugins || plugins.length === 0) return;

            let sortedPlugins = this.sortPluginsByInstalledOrder(plugins);

            // 同音源组只保留一个代表标签（聚合展示）：若当前选中的源属于该组则优先展示它，
            // 否则取组内第一个；无分组名（平铺在根目录）的插件各自保留
            const seenGroups = new Set();
            const uniquePlugins = [];
            for (const p of sortedPlugins) {
                const g = (p.groupName || p.platform || '').toString().trim().normalize('NFC');
                if (!g) { uniquePlugins.push(p); continue; }
                if (seenGroups.has(g)) continue;
                seenGroups.add(g);
                const rep = (currentPlugin && sortedPlugins.find(x => x.name === currentPlugin && (x.groupName || x.platform || '').toString().trim().normalize('NFC') === g)) || p;
                uniquePlugins.push(rep);
            }

            const tabsWrapper = document.createElement('div');
            tabsWrapper.className = 'plugin-tabs-wrapper';
            tabsWrapper.innerHTML = `
                <div class="plugin-tabs" id="${containerId}">
                    ${uniquePlugins.map((plugin) => `
                        <button class="plugin-tab ${plugin.name === currentPlugin ? 'active' : ''}"
                                data-plugin-name="${plugin.name}"
                                data-group-key="${escapeHtml(this.groupKey(plugin))}"
                                title="${escapeHtml(plugin.platform)}">
                            ${escapeHtml(plugin.displayName || plugin.platform)}
                        </button>
                    `).join('')}
                </div>
            `;

            // 插入到内容容器的最前面
            contentContainer.insertBefore(tabsWrapper, contentContainer.firstChild);

            // 恢复滚动位置：会话内重渲染（切换音源）优先用之前的位置；
            // 首次进入页面则定位到当前选中的音源标签
            if (savedScrollLeft > 0) {
                tabsWrapper.scrollLeft = savedScrollLeft;
            } else {
                this.scrollActiveTabIntoView(tabsWrapper);
            }

            this.bindEvents(containerId, onSwitch);

            // 同时更新 header 标题
            if (headerLeft && pageTitle) {
                pageTitle.style.display = 'block';
                pageTitle.textContent = pageTitles[page] || '';
            }
            return;
        }

        if (!plugins || plugins.length === 0) {
            if (headerLeft) {
                headerLeft.innerHTML = `<div class="header-title" id="page-title">${pageTitles[page] || ''}</div>`;
            }
            return;
        }

        let sortedPlugins = this.sortPluginsByInstalledOrder(plugins);

        if (pageTitle) {
            pageTitle.style.display = 'none';
        }

        // 同音源组只保留一个代表标签（聚合展示）：若当前选中的源属于该组则优先展示它，
        // 否则取组内第一个；无分组名（平铺在根目录）的插件各自保留
        const seenGroups = new Set();
        const uniquePlugins = [];
        for (const p of sortedPlugins) {
            const g = (p.groupName || p.platform || '').toString().trim().normalize('NFC');
            if (!g) { uniquePlugins.push(p); continue; }
            if (seenGroups.has(g)) continue;
            seenGroups.add(g);
            const rep = (currentPlugin && sortedPlugins.find(x => x.name === currentPlugin && (x.groupName || x.platform || '').toString().trim().normalize('NFC') === g)) || p;
            uniquePlugins.push(rep);
        }

        if (headerLeft) {
            headerLeft.innerHTML = `
                <div class="plugin-tabs" id="${containerId}">
                    ${uniquePlugins.map((plugin) => `
                        <button class="plugin-tab ${plugin.name === currentPlugin ? 'active' : ''}"
                                data-plugin-name="${plugin.name}"
                                data-group-key="${escapeHtml(this.groupKey(plugin))}"
                                title="${escapeHtml(plugin.platform)}">
                            ${escapeHtml(plugin.displayName || plugin.platform)}
                        </button>
                    `).join('')}
                </div>
            `;

            this.bindEvents(containerId, onSwitch);
        }
    },

    /**
     * 渲染带返回按钮的标题（用于详情页）
     * @param {Object} options - 配置选项
     * @param {string} options.title - 标题
     * @param {Function} options.onBack - 返回回调
     */
    renderWithBack(options) {
        const { title, onBack } = options;
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
                <div class="header-title" style="display: flex; align-items: center; gap: 10px;">
                    <button class="btn-back" id="back-btn" title="返回">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
                    </button>
                    <span>${escapeHtml(title)}</span>
                </div>
            `;

            const backBtn = document.getElementById('back-btn');
            if (backBtn && onBack) {
                backBtn.addEventListener('click', () => {
                    console.log('[DEBUG] Back button clicked!');
                    onBack();
                });
            }
        }
    },

    bindEvents(containerId, onSwitch) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.querySelectorAll('.plugin-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const pluginName = tab.dataset.pluginName;
                if (onSwitch) {
                    onSwitch(pluginName);
                }
            });
        });
    },

    /**
     * 按插件管理页的音源卡片顺序排序标签。
     * 顺序来源：后端持久化的插件全局顺序（window.installedPlugins）中，各音源组首次出现的位置。
     * 管理页调整音源卡片顺序后，排行榜/热门歌单的标签顺序同步变化（跨设备一致）。
     */
    sortPluginsByInstalledOrder(plugins) {
        const installed = (typeof window !== 'undefined' && window.installedPlugins) || [];
        if (!installed.length || !Array.isArray(plugins)) return [...(plugins || [])];

        const orderIndex = new Map();
        installed.forEach((p) => {
            const k = (p.groupName || p.platform || '').toString().trim().normalize('NFC');
            if (!orderIndex.has(k)) orderIndex.set(k, orderIndex.size);
        });

        const rank = (p) => {
            const k = ((p && (p.groupName || p.platform)) || '').toString().trim().normalize('NFC');
            const i = orderIndex.get(k);
            return i === undefined ? Number.MAX_SAFE_INTEGER : i;
        };

        return [...plugins].sort((a, b) => rank(a) - rank(b));
    },

    /**
     * 将当前选中的标签横向滚动到滚动容器可视区域中央。
     * 用于首次进入页面时定位到已保存选中的音源标签（不重置到最左）。
     * 仅横向滚动，不影响页面纵向位置。
     */
    scrollActiveTabIntoView(tabsWrapper) {
        if (!tabsWrapper) return;
        const activeTab = tabsWrapper.querySelector('.plugin-tab.active');
        if (!activeTab) return;

        const setScroll = () => {
            // 用 getBoundingClientRect 差值计算，避免 offsetLeft 受 offsetParent 影响
            const wRect = tabsWrapper.getBoundingClientRect();
            const aRect = activeTab.getBoundingClientRect();
            if (wRect.width <= 0) return;
            const delta = (aRect.left + aRect.width / 2) - (wRect.left + wRect.width / 2);
            if (Math.abs(delta) > 1) {
                tabsWrapper.scrollLeft = Math.max(0, tabsWrapper.scrollLeft + delta);
            }
        };

        setScroll();
        // iOS（-webkit-overflow-scrolling:touch）下首帧布局可能未稳定，下一帧再设一次兜底
        requestAnimationFrame(setScroll);
    },

    /**
     * 计算插件的「分组 key」：标签页按音源分组聚合显示，排序与持久化应以分组为单位，
     * 而非单个插件名——否则组内切换激活插件时代表标签名变化，会导致保存的顺序失效。
     * 有分组名用分组名；无分组名（平铺根目录）则用插件名本身，保证唯一。
     */
    groupKey(p) {
        const g = (p && (p.groupName || p.platform) || '').toString().trim().normalize('NFC');
        return g || (p && p.name) || '';
    }
};

window.PluginTabs = PluginTabs;
