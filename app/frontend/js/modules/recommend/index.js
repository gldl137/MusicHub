/**
 * 热门歌单模块
 * 功能：加载热门歌单插件、标签、歌单列表、歌单详情
 */

const RecommendModule = {
    storageKey: 'recommendPluginOrder',
    currentPluginKey: 'currentRecommendPlugin',
    // 返回回调函数（用于从订阅页面进入时）
    onBackCallback: null,

    /**
     * 加载支持热门歌单的插件列表
     */
    async loadPlugins() {
        try {
            const result = await API.recommend.getPlugins();

            if (result.success) {
                recommendPlugins = result.data || [];
                if (recommendPlugins.length > 0) {
                    const savedPlugin = this.loadCurrentPlugin();
                    if (savedPlugin && recommendPlugins.find(p => p.name === savedPlugin)) {
                        currentRecommendPlugin = savedPlugin;
                    } else {
                        currentRecommendPlugin = recommendPlugins[0].name;
                        this.saveCurrentPlugin(currentRecommendPlugin);
                    }
                    // 重置为默认标签
                    currentRecommendTag = { id: '', title: '默认' };
                }
                this.updateNavVisibility();
                if (currentPage === 'recommend') {
                    this.renderTabs();
                    this.loadSheets();
                }
            }
        } catch (error) {
            console.error('Failed to load recommend plugins:', error);
        }
    },

    /**
     * 更新导航项显示状态
     */
    updateNavVisibility() {
        const recommendNav = document.querySelector('[data-page="recommend"]');
        if (recommendNav) {
            recommendNav.style.display = recommendPlugins.length === 0 ? 'none' : 'flex';
        }
    },

    /**
     * 加载保存的当前选中插件
     */
    loadCurrentPlugin() {
        return localStorage.getItem(this.currentPluginKey);
    },

    /**
     * 保存当前选中插件
     */
    saveCurrentPlugin(pluginName) {
        localStorage.setItem(this.currentPluginKey, pluginName);
    },

    /**
     * 渲染热门歌单插件标签
     */
    renderTabs() {
        const headerLeft = document.getElementById('header-left');

        // 主菜单显示普通标题，详情页显示返回箭头+歌单名
        if (currentSheetTitle) {
            // 详情页：显示返回箭头+歌单名（标题居中，同我的歌单详情）
            // 如果有自定义返回回调则使用，否则使用默认的返回歌单列表
            const backCallback = this.onBackCallback || (() => this.backToSheets());
            PluginTabs.renderWithBack({
                title: currentSheetTitle,
                onBack: backCallback
            });
            // 标题文字居中：把返回按钮移出标题容器（返回按钮保持左侧，标题整体居中）
            const hl = document.getElementById('header-left');
            const titleEl = hl && hl.querySelector('.header-title');
            const backBtn = hl && hl.querySelector('#back-btn');
            if (hl && titleEl && backBtn) {
                hl.insertBefore(backBtn, titleEl);
                titleEl.classList.add('playlist-detail-title');
            }
        } else {
            // 主菜单：显示菜单按钮+"热门歌单"标题+搜索框
            if (headerLeft) {
                headerLeft.innerHTML = `
                    <button class="mobile-menu-btn" onclick="toggleMobileSidebar()" aria-label="打开菜单">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="3" y1="12" x2="21" y2="12"></line>
                            <line x1="3" y1="6" x2="21" y2="6"></line>
                            <line x1="3" y1="18" x2="21" y2="18"></line>
                        </svg>
                    </button>
                    <div class="header-title" id="page-title">MF 热门歌单</div>
                    <div class="recommend-header-search" style="display: flex; gap: 8px; align-items: center; margin-left: 16px; flex: 1; max-width: 500px;">
                        <div style="position: relative; flex: 1; min-width: 100px;">
                            <input type="text" id="recommend-sheet-search-input" class="search-input" placeholder="搜索歌单..." value="${escapeHtml(currentRecommendSearchQuery || '')}" style="padding-left: 12px; width: 100%; height: 32px; border-radius: var(--radius-lg); border: 1px solid var(--border-color); background: var(--surface-color); color: var(--text-color); font-size: 12px; outline: none;" onkeypress="if(event.key==='Enter')RecommendModule.searchSheets()">
                        </div>
                        <button class="header-icon-btn" onclick="handleHeaderSearchClick('recommend-sheet-search-input','recommend')" title="搜索">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                        </button>
                    </div>
                `;
            }

            // 在头部区域渲染插件标签
            PluginTabs.render({
                plugins: recommendPlugins,
                currentPlugin: currentRecommendPlugin,
                containerId: 'recommend-tabs-container',
                onSwitch: (pluginName) => this.switchPlugin(pluginName),
                storageKey: this.storageKey,
                page: 'recommend',
                contentContainerId: 'recommend-header'
            });
        }
    },

    /**
     * 切换热门歌单插件
     */
    switchPlugin(pluginName) {
        if (pluginName === currentRecommendPlugin) return;

        currentRecommendPlugin = pluginName;
        this.saveCurrentPlugin(pluginName);
        currentRecommendTag = { id: '', title: '默认' };
        currentRecommendSearchQuery = '';
        recommendSheetsPage = 1;
        recommendSheetsData = [];
        isRecommendSheetsEnd = false;

        this.loadTags();
        this.renderTabs();
        this.loadSheetsByTag();
    },

    /**
     * 加载热门歌单标签
     */
    async loadTags() {
        if (!currentRecommendPlugin) return;

        try {
            const result = await API.recommend.getTags(currentRecommendPlugin);

            if (result.success && result.data) {
                recommendTagsPinned = result.data.pinned || [];
                recommendTags = result.data.data || result.data || [];

                const isCurrentTagValid = currentRecommendTag && (
                    currentRecommendTag.id === '' ||
                    recommendTagsPinned.some(t => String(t.id) === String(currentRecommendTag.id)) ||
                    recommendTags.some(t => String(t.id) === String(currentRecommendTag.id))
                );
                if (!isCurrentTagValid) {
                    currentRecommendTag = { id: '', title: '默认' };
                }

                this.renderTagButtons();
            }
        } catch (error) {
            console.error('加载热门歌单标签失败:', error);
            recommendTags = [];
            recommendTagsPinned = [];
            currentRecommendTag = { id: '', title: '默认' };
        }
    },

    /**
     * 渲染标签按钮
     */
    renderTagButtons() {
        const header = document.getElementById('recommend-header');
        if (!header) return;

        let tagBar = header.querySelector('.recommend-tags-bar');
        if (!tagBar) {
            tagBar = document.createElement('div');
            tagBar.className = 'recommend-tags-bar';
            tagBar.style.cssText = 'padding: 12px 0; border-bottom: 1px solid var(--divider-color); display: flex; gap: 8px; overflow-x: auto; align-items: center; scrollbar-width: none; -ms-overflow-style: none;';
            header.appendChild(tagBar);
        }

        // 构建标签栏 HTML：默认按钮 + pinned 标签 + 更多按钮
        // 注意：部分插件（如 QQ音乐）的 tag.id 是数字，而 onclick 传入的是字符串，
        // 必须统一按字符串比较，否则选中标签没有高亮背景
        let html = `
            <button class="tag-btn tag-default ${currentRecommendTag.id === '' ? 'active' : ''}"
                    onclick="RecommendModule.switchTag('', '默认')"
                    style="padding: 6px 14px; border-radius: 16px; border: 1px solid var(--border-color); background: ${currentRecommendTag.id === '' ? 'var(--primary-color)' : 'transparent'}; color: ${currentRecommendTag.id === '' ? 'white' : 'var(--text-secondary)'}; font-size: 13px; cursor: pointer; white-space: nowrap; transition: all 0.2s;">
                默认
            </button>
        `;

        // 添加 pinned 标签
        recommendTagsPinned.forEach(tag => {
            const isActive = String(currentRecommendTag.id) === String(tag.id);
            html += `
                <button class="tag-btn ${isActive ? 'active' : ''}"
                        onclick="RecommendModule.switchTag('${String(tag.id)}', '${escapeHtml(tag.title)}')"
                        style="padding: 6px 14px; border-radius: 16px; border: 1px solid var(--border-color); background: ${isActive ? 'var(--primary-color)' : 'transparent'}; color: ${isActive ? 'white' : 'var(--text-secondary)'}; font-size: 13px; cursor: pointer; white-space: nowrap; transition: all 0.2s;">
                    ${escapeHtml(tag.title)}
                </button>
            `;
        });

        // 添加更多按钮
        html += `
            <button class="tag-btn tag-more"
                    onclick="RecommendModule.toggleTagPanel()"
                    style="padding: 6px 14px; border-radius: 16px; border: 1px solid var(--border-color); background: transparent; color: var(--text-secondary); font-size: 13px; cursor: pointer; white-space: nowrap; transition: all 0.2s; display: flex; align-items: center; gap: 4px;">
                更多
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transition: transform 0.2s;"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
        `;

        tagBar.innerHTML = html;

        // 渲染标签面板（下拉菜单）
        this.renderTagPanel();
    },

    /**
     * 渲染搜索区域（在插件标签和标签栏之间）
     */
    renderSearchArea() {
        const header = document.getElementById('recommend-header');
        if (!header) return;

        // 如果已经有搜索区域，更新它
        let searchArea = header.querySelector('.recommend-search-area');
        if (!searchArea) {
            searchArea = document.createElement('div');
            searchArea.className = 'recommend-search-area';
            searchArea.style.cssText = 'padding: 12px 16px; border-bottom: 1px solid var(--divider-color); display: flex; gap: 8px; align-items: center; justify-content: flex-start;';

            // 找到标签栏并插入到它之前
            const tagBar = header.querySelector('.recommend-tags-bar');
            const tabsWrapper = header.querySelector('.plugin-tabs-wrapper');
            if (tagBar) {
                header.insertBefore(searchArea, tagBar);
            } else if (tabsWrapper) {
                // 如果没有标签栏，插入到插件标签之后
                tabsWrapper.insertAdjacentElement('afterend', searchArea);
            } else {
                // 如果都没有，插入到容器开头
                header.insertBefore(searchArea, header.firstChild);
            }
        }

        searchArea.innerHTML = `
            <div style="position: relative; flex: 1; max-width: 400px;">
                <svg style="position: absolute; left: 14px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; color: var(--text-tertiary);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                <input type="text" id="recommend-sheet-search-input" class="search-input" placeholder="搜索歌单..." value="${escapeHtml(currentRecommendSearchQuery || '')}" style="width: 100%; padding: 10px 16px 10px 42px; border-radius: var(--radius-lg); border: 1px solid var(--border-color); background: var(--surface-color); color: var(--text-color); font-size: 14px; outline: none; transition: all 0.2s;" onkeypress="if(event.key==='Enter')RecommendModule.searchSheets()">
            </div>
            <button class="btn btn-primary" onclick="RecommendModule.searchSheets()" style="padding: 10px 20px; border-radius: var(--radius-lg); font-size: 14px; height: auto;">搜索</button>
        `;
    },

    /**
     * 渲染标签面板（下拉菜单）
     */
    renderTagPanel() {
        const header = document.getElementById('recommend-header');
        if (!header) return;

        // 找到标签栏作为定位参考
        const tagBar = header.querySelector('.recommend-tags-bar');
        if (!tagBar) return;

        let panel = document.getElementById('recommend-tag-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'recommend-tag-panel';
            panel.className = 'tag-panel';
            panel.style.cssText = 'position: fixed; background: var(--surface-color); border: 1px solid var(--divider-color); border-radius: var(--radius-lg); padding: 16px; min-width: 400px; max-height: 400px; overflow-y: auto; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 1000; display: none;';
            document.body.appendChild(panel);
        }

        let html = `
            <div class="tag-group" style="margin-bottom: 16px;">
                <button class="tag-btn ${currentRecommendTag.id === '' ? 'active' : ''}"
                        onclick="RecommendModule.switchTag('', '默认'); RecommendModule.hideTagPanel();"
                        style="padding: 6px 14px; border-radius: 16px; border: 1px solid var(--border-color); background: ${currentRecommendTag.id === '' ? 'var(--primary-color)' : 'transparent'}; color: ${currentRecommendTag.id === '' ? 'white' : 'var(--text-secondary)'}; font-size: 13px; cursor: pointer; white-space: nowrap; transition: all 0.2s;">
                    默认
                </button>
            </div>
        `;

        // 渲染分组标签（id 统一按字符串比较，兼容数字 id 的插件如 QQ音乐）
        recommendTags.forEach(group => {
            if (group.title) {
                html += `<div class="tag-group-title" style="font-size: 12px; color: var(--text-tertiary); margin: 12px 0 8px; font-weight: 500;">${escapeHtml(group.title)}</div>`;
            }
            if (group.data && Array.isArray(group.data)) {
                html += `<div class="tag-group" style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">`;
                group.data.forEach(tag => {
                    const isActive = String(currentRecommendTag.id) === String(tag.id);
                    html += `
                        <button class="tag-btn ${isActive ? 'active' : ''}"
                                onclick="RecommendModule.switchTag('${String(tag.id)}', '${escapeHtml(tag.title)}'); RecommendModule.hideTagPanel();"
                                style="padding: 6px 14px; border-radius: 16px; border: 1px solid var(--border-color); background: ${isActive ? 'var(--primary-color)' : 'transparent'}; color: ${isActive ? 'white' : 'var(--text-secondary)'}; font-size: 13px; cursor: pointer; white-space: nowrap; transition: all 0.2s;">
                            ${escapeHtml(tag.title)}
                        </button>
                    `;
                });
                html += `</div>`;
            }
        });

        panel.innerHTML = html;
    },

    /**
     * 切换标签面板显示
     */
    toggleTagPanel() {
        const header = document.getElementById('recommend-header');
        if (!header) return;

        const tagBar = header.querySelector('.recommend-tags-bar');
        const moreBtn = tagBar?.querySelector('.tag-more');
        const panel = document.getElementById('recommend-tag-panel');
        if (!panel || !tagBar) return;

        const isVisible = panel.style.display !== 'none';
        if (isVisible) {
            this.hideTagPanel();
        } else {
            // 手机端：底部弹层样式（全宽贴底），避免 min-width:400px 的下拉面板溢出屏幕
            const isMobile = window.innerWidth <= 768;
            if (isMobile) {
                requestAnimationFrame(() => {
                    panel.style.left = '0';
                    panel.style.right = '0';
                    panel.style.top = 'auto';
                    panel.style.bottom = '0';
                    panel.style.minWidth = '0';
                    panel.style.width = 'auto';
                    panel.style.maxHeight = '50vh';
                    panel.style.borderRadius = '16px 16px 0 0';
                    panel.style.padding = '16px 16px calc(16px + env(safe-area-inset-bottom, 0px))';
                    panel.style.boxShadow = '0 -4px 24px rgba(0,0,0,0.25)';
                    panel.style.display = 'block';
                });

                // 添加点击外部关闭的事件监听器
                setTimeout(() => {
                    document.addEventListener('click', this.handleClickOutside);
                }, 0);
                return;
            }

            // 桌面端：计算面板位置（基于"更多"按钮）
            const rect = moreBtn ? moreBtn.getBoundingClientRect() : tagBar.getBoundingClientRect();
            const left = rect.left;
            const top = rect.bottom + 8;

            // 使用 requestAnimationFrame 批量更新样式避免强制重排
            requestAnimationFrame(() => {
                panel.style.left = left + 'px';
                panel.style.top = top + 'px';
                panel.style.bottom = 'auto';
                panel.style.minWidth = '400px';
                panel.style.width = 'auto';
                panel.style.maxHeight = '400px';
                panel.style.borderRadius = 'var(--radius-lg)';
                panel.style.padding = '16px';
                panel.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
                panel.style.display = 'block';
            });

            // 添加点击外部关闭的事件监听器
            setTimeout(() => {
                document.addEventListener('click', this.handleClickOutside);
            }, 0);
        }
    },

    /**
     * 处理点击外部关闭面板
     */
    handleClickOutside(event) {
        const panel = document.getElementById('recommend-tag-panel');
        const header = document.getElementById('recommend-header');
        if (!panel || !header) return;

        const tagBar = header.querySelector('.recommend-tags-bar');
        if (panel.style.display === 'none') return;

        // 检查点击是否在面板或标签栏之外
        if (!panel.contains(event.target) && !tagBar.contains(event.target)) {
            RecommendModule.hideTagPanel();
        }
    },

    /**
     * 隐藏标签面板
     */
    hideTagPanel() {
        const panel = document.getElementById('recommend-tag-panel');
        if (panel) {
            panel.style.display = 'none';
        }
        // 移除点击外部关闭的事件监听器
        document.removeEventListener('click', this.handleClickOutside);
    },

    /**
     * 切换标签
     */
    switchTag(tagId, tagTitle) {
        // id 统一按字符串比较（兼容数字 id 的插件），避免同一标签重复触发加载
        if (String(currentRecommendTag.id) === String(tagId ?? '')) return;

        currentRecommendTag = { id: tagId, title: tagTitle };
        recommendSheetsPage = 1;
        recommendSheetsData = [];
        isRecommendSheetsEnd = false;

        this.renderTagButtons();
        this.loadSheetsByTag();
    },

    /**
     * 加载热门歌单数据
     */
    async loadSheets() {
        currentRecommendTag = { id: '', title: '默认' };
        await this.loadTags();
        await this.loadSheetsByTag();
    },

    /**
     * 根据标签加载热门歌单
     */
    async loadSheetsByTag() {
        const content = document.getElementById('recommend-content');

        console.log('[INFO] [] loadSheetsByTag called, plugin:', currentRecommendPlugin, 'tag:', currentRecommendTag);

        // 如果元素不存在，直接返回
        if (!content) {
            console.warn('[WARN] recommend-content element not found');
            return;
        }

        if (!currentRecommendPlugin) {
            content.innerHTML = `
                <div class="empty-state" style="min-height: 100%;">
                    <div class="empty-icon">🔥</div>
                    <div class="empty-text">没有支持热门歌单功能的插件</div>
                </div>
            `;
            return;
        }

        recommendSheetsPage = 1;
        recommendSheetsData = [];
        isRecommendSheetsEnd = false;
        isRecommendSheetsLoading = true;

        if (recommendSheetsObserver) {
            recommendSheetsObserver.disconnect();
            recommendSheetsObserver = null;
        }
        hasTriggeredFirst = false;

        // 清空内容区域，保留头部
        content.innerHTML = '';

        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'loading';
        loadingDiv.innerHTML = `
            <div class="spinner"></div>
            <div style="margin-top: 16px; color: var(--text-secondary); font-size: 14px;">
                正在加载歌单数据，请稍候...
            </div>
        `;
        loadingDiv.style.padding = '60px 40px';
        loadingDiv.style.textAlign = 'center';
        content.appendChild(loadingDiv);

        try {
            const result = await API.recommend.getSheets(currentRecommendPlugin, currentRecommendTag, recommendSheetsPage);

            loadingDiv.remove();

            if (!result.success) {
                content.innerHTML += `
                    <div class="empty-state" style="min-height: 100%;">
                        <div class="empty-icon">🔥</div>
                        <div class="empty-text">加载热门歌单失败</div>
                    </div>
                `;
                this.renderTabs();
                return;
            }

            let sheets = result.data?.data || result.data || [];
            isRecommendSheetsEnd = result.data?.isEnd === true;

            sheets = sheets.filter(item => item && item.id !== undefined && item.id !== null);

            if (sheets.length === 0) {
                content.innerHTML += `
                    <div class="empty-state" style="min-height: 100%;">
                        <div class="empty-icon">📭</div>
                        <div class="empty-text">该标签暂无歌单数据</div>
                    </div>
                `;
                this.renderTabs();
                return;
            }

            recommendSheetsData = sheets;
            isRecommendSheetsLoading = false;
            this.renderSheetsList(content, false);
            this.renderTabs();

        } catch (error) {
            console.error('加载热门歌单失败:', error);
            isRecommendSheetsLoading = false;
            content.innerHTML += `
                <div class="empty-state" style="min-height: 100%;">
                    <div class="empty-icon">❌</div>
                    <div class="empty-text">加载失败: ${escapeHtml(error.message)}</div>
                </div>
            `;
            this.renderTabs();
        }
    },

    /**
     * 渲染热门歌单列表
     */
    renderSheetsList(content, append = false) {
        let grid = content.querySelector('.recommend-sheets-grid');

        if (!grid || !append) {
            // 清空内容区域，只保留歌单网格
            content.innerHTML = '';

            grid = document.createElement('div');
            grid.className = 'recommend-sheets-grid';
            grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 18px; padding: 20px 0 0 0;';
            content.appendChild(grid);
        }

        if (!append) {
            grid.innerHTML = '';
        }

        // 计算要渲染的数据范围
        const endIndex = recommendSheetsPage * ITEMS_PER_PAGE;
        const startIndex = append ? (recommendSheetsPage - 1) * ITEMS_PER_PAGE : 0;
        const pageData = recommendSheetsData.slice(startIndex, endIndex);

        pageData.forEach(item => {
            const card = document.createElement('div');
            card.className = 'recommend-sheet-card';
            // Apple 风格：平时无容器感，hover 浮现卡片底
            card.style.cssText = 'cursor: pointer; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 10px 10px 12px; transition: transform 0.25s ease, background 0.25s ease, box-shadow 0.25s ease;';
            card.onmouseover = () => {
                card.style.transform = 'translateY(-3px)';
                card.style.background = 'var(--bg-tertiary)';
                card.style.boxShadow = 'var(--shadow-md)';
            };
            card.onmouseout = () => {
                card.style.transform = '';
                card.style.background = 'var(--bg-secondary)';
                card.style.boxShadow = '';
            };

            const coverUrl = item.artwork || item.coverImg || item.cover || item.pic || '';
            const title = item.title || '未知歌单';

            card.onclick = () => {
                // 保存封面到全局变量，供订阅使用
                window.currentSheetCoverFromList = coverUrl;
                // 如果有搜索关键词，返回时回到搜索结果
                const onBack = currentRecommendSearchQuery ? () => this.backToSearchResults() : null;
                this.loadDetail(item.id, encodeURIComponent(title), null, onBack);
            };

            card.innerHTML = `
                <div class="toplist-cover" style="width: 100%; aspect-ratio: 1; background: linear-gradient(135deg, var(--bg-tertiary) 0%, var(--surface-color) 100%); border-radius: var(--radius-md); display: flex; align-items: center; justify-content: center; font-size: 48px; margin-bottom: 18px; overflow: hidden;">
                    ${coverUrl ? createImageWithFallback(coverUrl, 'cover', '') + "<div style='display:none'>🎵</div>" : '🎵'}
                    <button class="media-card-play" title="播放歌单" onclick="event.stopPropagation(); RecommendModule.playSheetDirect('${String(item.id)}', '${escapeHtml(encodeURIComponent(title))}')"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
                </div>
                <div class="toplist-name" style="font-size: var(--media-card-title-size, 14px); font-weight: 600; line-height: 1.4; color: var(--text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(title)}</div>
                <div class="toplist-desc" style="font-size: var(--media-card-sub-size, 12px); line-height: 1.5; margin-top: 6px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(item.description || '')}</div>
            `;
            grid.appendChild(card);
        });

        this.renderLoadMoreButton(content);
        this.setupObserver();
    },

    /**
     * 渲染加载更多按钮
     */
    renderLoadMoreButton(container) {
        const oldLoadMoreDiv = container.querySelector('.load-more-container');
        if (oldLoadMoreDiv) oldLoadMoreDiv.remove();

        const loadMoreDiv = document.createElement('div');
        loadMoreDiv.className = 'load-more-container';
        loadMoreDiv.style.cssText = 'text-align: center; padding: 20px; margin-top: 20px;';

        const currentDisplayedCount = recommendSheetsPage * ITEMS_PER_PAGE;
        const hasMoreDataToShow = recommendSheetsData.length > currentDisplayedCount;
        const canLoadMore = hasMoreDataToShow || !isRecommendSheetsEnd;

        if (isRecommendSheetsEnd && !hasMoreDataToShow) {
            loadMoreDiv.innerHTML = '<span style="color: var(--text-tertiary); font-size: 13px;">已经到底了</span>';
        } else if (isRecommendSheetsLoading) {
            loadMoreDiv.innerHTML = `
                <div class="loading" style="padding: 10px; display: flex; align-items: center; justify-content: center; gap: 10px;">
                    <div class="spinner" style="width: 20px; height: 20px;"></div>
                    <span style="color: var(--text-secondary); font-size: 13px;">加载中...</span>
                </div>
            `;
        } else if (canLoadMore) {
            loadMoreDiv.innerHTML = `
                <button onclick="RecommendModule.loadMore()" style="padding: 8px 24px; border-radius: 16px; border: 1px solid #d0d0d0 !important; background-color: #eeeeee !important; color: #333333 !important; cursor: pointer; font-size: 13px;">
                    加载更多
                </button>
            `;
        }
        container.appendChild(loadMoreDiv);
    },

    /**
     * 设置滚动加载观察器
     */
    setupObserver() {
        const content = document.getElementById('recommend-content');
        const loadMoreBtn = content?.querySelector('.load-more-container');

        const currentDisplayedCount = recommendSheetsPage * ITEMS_PER_PAGE;
        const hasMoreDataToShow = recommendSheetsData.length > currentDisplayedCount;
        const canLoadMore = hasMoreDataToShow || !isRecommendSheetsEnd;

        if (!loadMoreBtn || !canLoadMore || isRecommendSheetsLoading) {
            if (recommendSheetsObserver) {
                recommendSheetsObserver.disconnect();
                recommendSheetsObserver = null;
            }
            return;
        }

        // 如果已存在观察器，先断开再重新设置（确保观察新的加载按钮）
        if (recommendSheetsObserver) {
            recommendSheetsObserver.disconnect();
        }

        recommendSheetsObserver = new IntersectionObserver((entries) => {
            // 只有在用户点击过"加载更多"后才启用自动加载（hasTriggeredFirst 为 true 表示已点击过）
            if (!hasTriggeredFirst) {
                return;
            }

            const currentCount = recommendSheetsPage * ITEMS_PER_PAGE;
            const hasMore = recommendSheetsData.length > currentCount;
            const canLoad = hasMore || !isRecommendSheetsEnd;

            if (entries[0].isIntersecting && !isRecommendSheetsLoading && canLoad) {
                this.loadMore();
            }
        }, { rootMargin: '100px' });

        recommendSheetsObserver.observe(loadMoreBtn);
    },

    /**
     * 加载更多歌单
     */
    async loadMore() {
        if (isRecommendSheetsLoading || isRecommendSheetsEnd) return;

        isRecommendSheetsLoading = true;

        const currentDisplayedCount = recommendSheetsPage * ITEMS_PER_PAGE;
        const hasMoreDataToShow = recommendSheetsData.length > currentDisplayedCount;

        // 如果本地已有更多数据，直接显示
        if (hasMoreDataToShow) {
            recommendSheetsPage++;
            isRecommendSheetsLoading = false;
            const content = document.getElementById('recommend-content');
            if (content) {
                this.renderSheetsList(content, true);
            }
            // 设置首次触发标志为 true，启用自动加载
            hasTriggeredFirst = true;
            this.setupObserver();
            return;
        }

        // 需要从服务器加载更多数据
        const nextPage = recommendSheetsPage + 1;

        try {
            let result;

            // 判断是搜索模式还是普通浏览模式
            if (currentRecommendSearchQuery) {
                // 搜索模式：调用搜索 API，传递页码
                result = await API.music.search(currentRecommendSearchQuery, 'sheet', currentRecommendPlugin, nextPage);
                if (result.success && result.data) {
                    let newSheets = [];
                    if (Array.isArray(result.data)) {
                        newSheets = result.data;
                    } else if (result.data.data && Array.isArray(result.data.data)) {
                        newSheets = result.data.data;
                    }

                    // 过滤已存在的数据
                    const existingIds = new Set(recommendSheetsData.map(s => s.id));
                    newSheets = newSheets.filter(item => item && item.id && !existingIds.has(item.id));

                    if (newSheets.length === 0) {
                        isRecommendSheetsEnd = true;
                    } else {
                        recommendSheetsData = [...recommendSheetsData, ...newSheets];
                        recommendSheetsPage = nextPage;
                    }
                } else {
                    isRecommendSheetsEnd = true;
                }
            } else {
                // 普通浏览模式：调用 getSheets API
                result = await API.recommend.getSheets(currentRecommendPlugin, currentRecommendTag, nextPage);

                if (result.success && result.data) {
                    let newSheets = result.data?.data || result.data || [];
                    isRecommendSheetsEnd = result.data?.isEnd === true;

                    newSheets = newSheets.filter(item => item && item.id !== undefined && item.id !== null);

                    if (isRecommendSheetsEnd || newSheets.length === 0) {
                        isRecommendSheetsEnd = true;
                    }

                    recommendSheetsData = [...recommendSheetsData, ...newSheets];
                    recommendSheetsPage = nextPage;
                } else {
                    isRecommendSheetsEnd = true;
                }
            }
        } catch (error) {
            console.error('加载更多歌单失败:', error);
        } finally {
            isRecommendSheetsLoading = false;
            const content = document.getElementById('recommend-content');
            if (content) {
                this.renderSheetsList(content, true);
            }
            // 设置首次触发标志为 true ，启用自动加载
            hasTriggeredFirst = true;
            this.setupObserver();
        }
    },

    /**
     * 搜索歌单
     */
    async searchSheets() {
        const searchInput = document.getElementById('recommend-sheet-search-input');
        const query = searchInput ? searchInput.value.trim() : '';

        if (!query) {
            showToast('请输入搜索关键词', 'error');
            return;
        }

        currentRecommendSearchQuery = query;
        showToast('搜索中...');

        try {
            const result = await API.music.search(query, 'sheet', currentRecommendPlugin);

            if (result.success && result.data) {
                let sheets = [];
                if (Array.isArray(result.data)) {
                    sheets = result.data;
                } else if (result.data.data && Array.isArray(result.data.data)) {
                    sheets = result.data.data;
                }

                if (sheets.length === 0) {
                    showToast('未找到相关歌单', 'warning');
                    return;
                }

                // 保存原始数据，用于返回
                this.originalSheetsData = [...recommendSheetsData];
                this.originalSheetsPage = recommendSheetsPage;
                this.originalIsEnd = isRecommendSheetsEnd;

                // 设置为搜索结果
                recommendSheetsData = sheets;
                recommendSheetsPage = 1;
                // 如果返回结果少于每页数量，则认为到底了
                isRecommendSheetsEnd = sheets.length < ITEMS_PER_PAGE;

                const content = document.getElementById('recommend-content');
                if (content) {
                    this.renderSheetsList(content, false);
                }

                showToast(`找到 ${sheets.length} 个歌单`);
            } else {
                showToast('搜索失败', 'error');
            }
        } catch (error) {
            console.error('搜索歌单失败:', error);
            showToast('搜索失败: ' + error.message, 'error');
        }
    },

    /**
     * 清除搜索，返回标签列表
     */
    clearSearch() {
        currentRecommendSearchQuery = '';
        const searchInput = document.getElementById('recommend-sheet-search-input');
        if (searchInput) searchInput.value = '';

        // 恢复原始数据
        if (this.originalSheetsData) {
            recommendSheetsData = this.originalSheetsData;
            recommendSheetsPage = this.originalSheetsPage;
            isRecommendSheetsEnd = this.originalIsEnd;
            this.originalSheetsData = null;
        }

        const content = document.getElementById('recommend-content');
        if (content) {
            this.renderSheetsList(content, false);
        }
    },

    /**
     * 返回搜索结果
     */
    backToSearchResults() {
        // 从详情页返回到搜索结果列表
        currentSheetTitle = null;
        this.onBackCallback = null;
        this.renderTabs();

        const content = document.getElementById('recommend-content');
        if (content) {
            this.renderSheetsList(content, false);
        }
    },

    /**
     * 直接播放热门歌单全部歌曲（卡片悬浮播放按钮）
     */
    async playSheetDirect(id, encodedTitle) {
        const targetPlugin = currentRecommendPlugin;
        if (!targetPlugin || !id) {
            showToast('无法获取插件信息', 'error');
            return;
        }
        try {
            showToast('加载歌单...');
            const result = await API.recommend.getSheetDetail(id, targetPlugin);
            if (result.success && result.data) {
                const musicList = result.data.musicList || result.data.songs || result.data.tracks || [];
                if (!musicList.length) {
                    showToast('歌单暂无歌曲', 'warning');
                    return;
                }
                const list = musicList.map(song => ({ ...song, plugin: song.plugin || song.platform || targetPlugin }));
                window.currentPageMusicList = list;
                playMusic(0);
            } else {
                showToast('加载失败: ' + (result.error || '未知错误'), 'error');
            }
        } catch (e) {
            showToast('播放失败: ' + e.message, 'error');
        }
    },

    /**
     * 加载歌单详情
     * @param {string} id - 歌单ID
     * @param {string} encodedTitle - 编码后的歌单标题
     * @param {string} pluginName - 插件名称（可选）
     * @param {Function} onBack - 返回回调函数（可选）
     */
    async loadDetail(id, encodedTitle, pluginName, onBack) {
        if (!id || id === 'undefined' || id === 'null') {
            showToast('歌单ID无效，无法加载详情', 'error');
            return;
        }

        if (typeof MusicList === 'undefined') {
            console.error('[ERROR] [] MusicList component not loaded');
            return;
        }

        // 保存返回回调函数
        this.onBackCallback = onBack;

        const sheetTitle = encodedTitle ? decodeURIComponent(encodedTitle) : '歌单详情';

        // 先设置标题，确保切换页面时能正确渲染返回按钮
        currentSheetTitle = sheetTitle;

        // 先切换到推荐页面，确保容器元素存在
        // 注意：传入 true 跳过默认的 loadRecommendSheets，避免覆盖详情页
        if (typeof switchPage === 'function' && window.currentPage !== 'recommend') {
            await switchPage('recommend', true);
        }

        showToast(`加载歌单: ${sheetTitle}...`);

        // 使用传入的 pluginName 或当前选中的插件
        const targetPlugin = pluginName || currentRecommendPlugin;
        if (!targetPlugin) {
            showToast('无法获取插件信息', 'error');
            return;
        }

        try {
            const result = await API.recommend.getSheetDetail(id, targetPlugin);

            if (result.success && result.data) {
                const musicList = result.data.musicList || result.data.songs || result.data.tracks || [];

                if (musicList.length === 0) {
                    showToast('歌单暂无歌曲', 'warning');
                    return;
                }

                // 设置当前插件为传入的 pluginName，供后续操作使用
                currentRecommendPlugin = targetPlugin;
                this.renderTabs();
                setRecommendHeaderVisible(false); // 详情页隐藏标签页/分类菜单/搜索区
                setupRecommendDetailMenu(); // 页头「⋯」管理菜单（同排行榜详情）
                const container = document.getElementById('recommend-content') || document.getElementById('page-recommend');

                // 为每首歌曲添加 plugin 字段
                const musicListWithPlugin = musicList.map(song => ({
                    ...song,
                    plugin: song.plugin || song.platform || targetPlugin
                }));

                // 保存到全局变量
                window.currentRecommendMusicList = musicListWithPlugin;
                window.currentPageMusicList = musicListWithPlugin;

                // 使用 SongTable 组件渲染
                const hasSongs = musicListWithPlugin && musicListWithPlugin.length > 0;

                // 保存当前歌单ID和封面
                window.currentSheetId = id;
                // 优先使用详情中的封面，如果没有则使用列表中的封面
                window.currentSheetCover = result.data.cover || result.data.artwork || result.data.coverImg || result.data.pic || window.currentSheetCoverFromList || '';
                // 清除临时变量
                window.currentSheetCoverFromList = null;

                // 检查是否已订阅
                let isSubscribed = false;
                try {
                    const token = Auth.getToken();
                    const subResponse = await fetch(`${API_BASE}/api/subscribed-toplists`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    const subResult = await subResponse.json();
                    if (subResult.success && subResult.data) {
                        isSubscribed = subResult.data.some(sub =>
                            sub.toplistId === id && sub.platform === targetPlugin
                        );
                    }
                } catch (e) {
                    console.warn('[Recommend] 检查订阅状态失败:', e);
                }

                // 分页渲染：全量列表存模块态，翻页只重渲染表格不重新请求（进入新歌单重置到第 1 页）
                this._sheetSongs = musicListWithPlugin;
                this._sheetSubscribed = isSubscribed;
                this.sheetPage = 1;
                this.renderSheetTable();
                showToast(`加载完成，共 ${musicList.length} 首歌曲`);
            } else {
                showToast('加载歌单详情失败', 'error');
            }
        } catch (error) {
            console.error('加载歌单详情失败:', error);
            showToast('加载歌单详情失败: ' + error.message, 'error');
        }
    },

    /**
     * 渲染热门歌单详情歌曲表格（分页：默认 50/页可自定义，翻页只重渲染不重新请求）。
     * 全量列表存于 this._sheetSongs；行点击回调 index = 页偏移 + 页内索引。
     * 按钮（播放/添加/下载）仍传全量列表：未勾选时操作全部歌曲。
     */
    renderSheetTable() {
        const container = document.getElementById('recommend-content') || document.getElementById('page-recommend');
        if (!container || !this._sheetSongs) return;
        const allSongs = this._sheetSongs;
        const hasSongs = allSongs.length > 0;
        // 管理模式：勾选列 + 批量下载（页头「⋯」→「管理」进入）
        const manage = sheetManageMode;
        if (container.classList) container.classList.toggle('playlist-detail-manage', manage);
        const selCount = (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs)
            ? (SongTable.getSelectedSongs('recommend') || []).length : 0;

        // 与「我的歌单」详情同款：Hero（随机/播放/歌单）+ 单曲同款表格（封面两行/行尾⋯/无表头/无分页）
        const render = (slice) => {
        SongTable.render({
            container: container,
            pageId: 'recommend',
            title: '',
            showHeader: false,
            songs: slice,
            hero: {
                cover: window.currentSheetCover || '',
                title: currentSheetTitle || '歌单详情',
                meta: `${allSongs.length} 首歌曲`,
                onRandom: manage ? null : 'playSheetRandom()'
            },
            columns: manage
                ? ['checkbox', 'index', 'title', 'artist', 'album', 'duration', 'source', 'favorite', 'more']
                : ['index', 'title', 'artist', 'album', 'duration', 'source', 'favorite', 'more'],
            titleCover: (song) => {
                // 优先插件返回的封面直链；后端列表歌曲外链已剥离，需用虚拟封面 ID（coverArt）走 /api/cover 实时解析
                const coverId = song.coverArt || song.virtualId
                    || (typeof song.id === 'string' && song.id.startsWith('remote__') ? song.id : null);
                return song.artwork || song.cover || song.coverImg || song.pic || song.coverUrl || song.albumPic
                    || (coverId ? `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(coverId)}` : '');
            },
            // 收藏已移出行菜单：作为独立心形按钮显示在「⋯」前（favorite 列，点击走 events.onFavorite）
            rowMenu: [
                { label: '下载', onClick: (index) => RecommendModule.downloadByIndex(index) }
            ],
            actions: manage ? [
                {
                    id: 'manage-download',
                    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
                    text: `下载${selCount ? ` (${selCount})` : ''}`,
                    primary: false,
                    disabled: !hasSongs,
                    onClick: downloadSheetSelected
                },
                { id: 'manage-done', icon: '', text: '完成', primary: true, onClick: () => toggleSheetManageMode() }
            ] : [
                {
                    id: 'play',
                    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
                    text: '播放',
                    primary: true,
                    disabled: !hasSongs,
                    onClick: () => RecommendModule.playByIndex(0)
                },
                {
                    id: 'save-playlist',
                    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
                    text: '歌单',
                    primary: false,
                    disabled: !hasSongs,
                    onClick: () => RecommendModule.saveSheetAsLivePlaylist()
                }
            ],
            events: {
                onPlay: (song, index) => RecommendModule.playByIndex(index),
                onFavorite: (song, index) => RecommendModule.toggleFavorite(index)
            }
        });
        };
        // 懒加载：只渲染当前可见歌曲，滚动到底追加下一批
        SongListLazy.register('recommend', allSongs, container, render, { batch: 50, initial: 60 });
    },

    /** 保存歌单为实时歌单（只存歌单地址，可重命名，不保存歌曲快照） */
    async saveSheetAsLivePlaylist() {
        const allSongs = this._sheetSongs || [];
        if (!allSongs.length) {
            showToast('歌单为空', 'warning');
            return;
        }
        // 默认名称带上音源（插件别名）前缀，如「酷我-热歌榜」
        const defaultName = (typeof window.getEffectivePlaylistName === 'function')
            ? await window.getEffectivePlaylistName(currentSheetTitle || '热门歌单', allSongs, typeof currentRecommendPlugin !== 'undefined' ? currentRecommendPlugin : undefined)
            : (currentSheetTitle || '热门歌单');
        ButtonActions.showLivePlaylistSaveModal(defaultName, { type: 'playlist', platform: currentRecommendPlugin, toplistId: window.currentSheetId }, window.currentSheetCover);
    },

    /**
     * 返回热门歌单列表
     */
    backToSheets() {
        currentSheetTitle = null;
        currentRecommendSearchQuery = '';
        this.onBackCallback = null; // 清除返回回调
        sheetManageMode = false; // 退出管理模式
        removeRecommendDetailMenu(); // 清理详情页头「⋯」菜单
        setRecommendHeaderVisible(true); // 恢复标签页/分类菜单/搜索区
        if (currentPage === 'recommend') {
            this.renderTabs();
        }
        this.loadSheetsByTag();
        this.renderTagButtons();
    },

    // ============== SongTable 事件处理函数 ==============

    /**
     * 播放全部歌曲
     */
    playAll() {
        const songs = window.currentRecommendMusicList || [];
        if (songs.length === 0) return;

        // 设置当前页面歌曲列表并播放第一首
        window.currentPageMusicList = songs;

        if (typeof playMusic === 'function') {
            playMusic(0);
        }
    },

    /**
     * 添加全部到播放列表
     */
    addAllToPlaylist() {
        const songs = window.currentRecommendMusicList || [];
        if (songs.length === 0) return;

        songs.forEach(song => {
            if (typeof addToPlaylist === 'function') {
                addToPlaylist([song]);
            }
        });
        showToast(`已添加 ${songs.length} 首歌曲到播放列表`, 'success');
    },

    /**
     * 下载全部歌曲
     */
    downloadAll() {
        const songs = window.currentRecommendMusicList || [];
        if (songs.length === 0) return;

        songs.forEach((song, index) => {
            setTimeout(() => {
                if (typeof downloadSong === 'function') {
                    downloadSong(song);
                }
            }, index * 500);
        });
        showToast(`已开始下载 ${songs.length} 首歌曲`, 'success');
    },

    /**
     * 订阅当前歌单
     */
    async subscribeCurrent() {
        if (!currentRecommendPlugin || !window.currentSheetId) {
            showToast('无法获取歌单信息', 'error');
            return;
        }

        // 订阅前弹窗确认：订阅后该歌单会进入「下载订阅」，可手动或定时下载
        const confirmed = await Notification.confirm(
            `确定订阅歌单「${currentSheetTitle || window.currentSheetId}」吗？订阅后可在「下载订阅」页面手动或定时下载。`,
            { title: '确认订阅', confirmText: '订阅', type: 'info' }
        );
        if (!confirmed) return;

        try {
            // 获取当前歌单的歌曲数量
            const songs = window.currentRecommendMusicList || [];
            const totalSongs = songs.length;

            const subscribed = await subscribeToplist(
                window.currentSheetId,
                currentRecommendPlugin,
                {
                    title: currentSheetTitle || window.currentSheetId,
                    cover: window.currentSheetCover || '',
                    sourceType: 'playlist',
                    isEnabled: 1 // 默认启动状态
                },
                totalSongs
            );
            // 失败（如已订阅）时 subscribeToplist 内部已提示，保持原按钮状态
            if (!subscribed) return;
            this._sheetSubscribed = true;
            showToast('已添加到订阅列表（启动）', 'success');
            this._refreshSubscribeUI();
        } catch (error) {
            console.error('订阅失败:', error);
            showToast('订阅失败', 'error');
        }
    },

    /**
     * 订阅 / 取消订阅当前歌单（按当前订阅状态自动切换，供详情页「订阅」按钮调用）
     */
    async toggleSubscribeCurrent() {
        if (!currentRecommendPlugin || !window.currentSheetId) {
            showToast('无法获取歌单信息', 'error');
            return;
        }
        if (!this._sheetSubscribed) {
            await this.subscribeCurrent();
            return;
        }
        const unsubscribed = await unsubscribeToplist(window.currentSheetId, null, currentRecommendPlugin);
        if (!unsubscribed) return; // 用户取消确认或取消订阅失败
        this._sheetSubscribed = false;
        this._refreshSubscribeUI();
    },

    /**
     * 订阅状态变化后刷新页头「⋯」菜单（订阅 ↔ 取消订阅）。不重渲染列表，避免列表回到顶部。
     */
    _refreshSubscribeUI() {
        if (typeof setupRecommendDetailMenu === 'function') setupRecommendDetailMenu();
    },

    /**
     * 播放指定索引的歌曲
     * @param {number} index - 歌曲索引
     */
    playByIndex(index) {
        const songs = window.currentRecommendMusicList || [];
        if (!songs[index]) return;

        // 设置当前页面歌曲列表供 playMusic 使用
        window.currentPageMusicList = songs;

        if (typeof playMusic === 'function') {
            playMusic(index);
        }
    },

    /**
     * 切换指定索引歌曲的收藏状态
     * @param {number} index - 歌曲索引
     */
    async toggleFavorite(index) {
        const songs = window.currentRecommendMusicList || [];
        const song = songs[index];
        if (!song) return;

        try {
            const plugin = song.plugin || song.platform;
            const isFavorited = isSongFavoritedSync(song.id, plugin);

            if (isFavorited) {
                await API.myFavorites.remove(song.id, plugin);
                showToast('已取消收藏', 'success');
            } else {
                await API.myFavorites.add(song);
                showToast('已添加到收藏', 'success');
            }

            if (typeof loadMyFavorites === 'function') {
                loadMyFavorites();
            }

            // 同步更新播放器收藏按钮状态（如果当前播放的是这首歌）
            if (window.currentMusic && window.currentMusic.id == song.id) {
                const currentPlugin = window.currentMusic.platform || window.currentMusic.plugin;
                if (currentPlugin === plugin) {
                    // 使用 ButtonManager 更新播放器按钮
                    if (window.ButtonManager) {
                        ButtonManager.updateFavoriteButton(song.id, plugin, !isFavorited);
                    }
                    // 同时更新 StateManager 中的状态
                    if (window.StateManager) {
                        StateManager.setFavoriteStatus(song.id, plugin, !isFavorited);
                    }
                    // 更新内存中的状态
                    window.isCurrentMusicLiked = !isFavorited;
                    window.currentMusic._isLiked = !isFavorited;
                }
            }
        } catch (error) {
            console.error('收藏操作失败:', error);
            showToast('操作失败: ' + error.message, 'error');
        }
    },

    /**
     * 下载指定索引的歌曲
     * @param {number} index - 歌曲索引
     */
    async downloadByIndex(index) {
        const songs = window.currentRecommendMusicList || [];
        const song = songs[index];
        if (!song) return;

        // 入库 plugin 优先（platform 可能是显示用平台名）
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
                    this.showReDownloadConfirm(song);
                    return;
                }
            }
        } catch (e) {
            console.error('检查下载状态失败:', e);
        }

        if (window.DownloadCore) {
            await DownloadCore.startBackendDownload(song, '热门歌单-下载');
        }
    },

    /**
     * 显示重新下载确认弹窗
     * @param {Object} song - 歌曲对象
     */
    showReDownloadConfirm(song) {
        if (typeof showConfirmModal === 'function') {
            showConfirmModal({
                title: '重新下载',
                message: `「${song.title}」已下载，需要重新下载吗？`,
                confirmText: '重新下载',
                cancelText: '取消',
                onConfirm: () => {
                    this.reDownloadSong(song);
                }
            });
        } else if (confirm(`「${song.title}」已下载，需要重新下载吗？`)) {
            this.reDownloadSong(song);
        }
    },

    /**
     * 强制重新下载歌曲
     * @param {Object} song - 歌曲对象
     */
    async reDownloadSong(song) {
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
                    source: 'recommend-retry',
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
};

// ==================== 热门歌单详情管理模式与页头「⋯」菜单 ====================

// 管理模式（页头「⋯」→「管理」）：勾选歌曲批量下载
let sheetManageMode = false;

/** 顶部「⋯」菜单：展开/收起（同排行榜详情） */
function toggleRecommendDetailMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('recommend-detail-menu');
    if (!menu) return;
    const willOpen = menu.style.display !== 'block';
    menu.style.display = willOpen ? 'block' : 'none';
    if (willOpen) {
        setTimeout(() => document.addEventListener('click', closeRecommendDetailMenu), 0);
    } else {
        document.removeEventListener('click', closeRecommendDetailMenu);
    }
}

function closeRecommendDetailMenu() {
    const menu = document.getElementById('recommend-detail-menu');
    if (menu) menu.style.display = 'none';
    document.removeEventListener('click', closeRecommendDetailMenu);
}

/** 页头右侧「⋯」按钮 + 下拉管理菜单（管理/订阅） */
function setupRecommendDetailMenu() {
    const actions = document.getElementById('header-actions');
    if (!actions) return;
    actions.querySelectorAll('.recommend-detail-more').forEach((el) => el.remove());
    const wrap = document.createElement('div');
    wrap.className = 'recommend-detail-more';
    wrap.style.cssText = 'position: relative; display: flex; align-items: center;';
    wrap.innerHTML = `
        <button type="button" title="更多" onclick="event.stopPropagation(); toggleRecommendDetailMenu(event)"
            class="header-icon-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
        <div id="recommend-detail-menu"
            style="display: none; position: absolute; right: 0; top: calc(100% + 6px); min-width: 150px; background: var(--surface-color); border: 1px solid var(--divider-color); border-radius: 10px; box-shadow: var(--shadow-lg); z-index: 1002; padding: 6px 0; overflow: hidden;">

            <button type="button" onclick="event.stopPropagation(); closeRecommendDetailMenu(); RecommendModule.toggleSubscribeCurrent();"
                style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">${RecommendModule._sheetSubscribed ? '取消订阅' : '订阅'}</button>
            <button type="button" onclick="event.stopPropagation(); closeRecommendDetailMenu(); toggleSheetManageMode();"
                style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; text-align: left;">下载</button>
        </div>`;
    actions.appendChild(wrap);
}

/** 清理详情页头「⋯」控件（返回歌单列表时调用） */
function removeRecommendDetailMenu() {
    closeRecommendDetailMenu();
    document.querySelectorAll('.recommend-detail-more').forEach((el) => el.remove());
}

/** 内容区顶部（插件标签页/分类菜单/搜索区）显隐：详情页隐藏，列表页恢复 */
function setRecommendHeaderVisible(visible) {
    const header = document.getElementById('recommend-header');
    if (header) header.style.display = visible ? '' : 'none';
}

/** 切换管理模式：出现勾选列，Hero 显示「下载(N) / 完成」（页头「⋯」→「下载」进入，Hero「完成」退出） */
function toggleSheetManageMode() {
    sheetManageMode = !sheetManageMode;
    RecommendModule.renderSheetTable();
}

/** 管理模式：批量下载勾选歌曲（未勾选时提示） */
function downloadSheetSelected() {
    const sel = (typeof SongTable !== 'undefined' && SongTable.getSelectedSongs)
        ? (SongTable.getSelectedSongs('recommend') || []) : [];
    if (!sel.length) {
        showToast('请先勾选要下载的歌曲', 'warning');
        return;
    }
    if (typeof ButtonActions !== 'undefined') {
        ButtonActions.handleDownload('recommend', sel);
    } else {
        showToast('下载功能未加载', 'error');
    }
}

/** 随机播放当前歌单的一首歌（Hero 随机按钮） */
window.playSheetRandom = () => {
    const songs = window.currentRecommendMusicList || [];
    if (!songs.length) {
        showToast('歌单为空', 'warning');
        return;
    }
    // 播放器随机按钮自动打开
    if (typeof enableShuffleMode === 'function') enableShuffleMode();
    RecommendModule.playByIndex(Math.floor(Math.random() * songs.length));
};

window.toggleRecommendDetailMenu = toggleRecommendDetailMenu;
window.closeRecommendDetailMenu = closeRecommendDetailMenu;
window.toggleSheetManageMode = toggleSheetManageMode;
window.downloadSheetSelected = downloadSheetSelected;

// 导出到全局作用户
window.RecommendModule = RecommendModule;
window.loadRecommendPlugins = () => RecommendModule.loadPlugins();
window.updateRecommendNavVisibility = () => RecommendModule.updateNavVisibility();
window.renderRecommendTabs = () => RecommendModule.renderTabs();
window.switchRecommendPlugin = (name) => RecommendModule.switchPlugin(name);
window.loadRecommendTags = () => RecommendModule.loadTags();
window.renderRecommendTagButtons = () => RecommendModule.renderTagButtons();
window.switchRecommendTag = (id, title) => RecommendModule.switchTag(id, title);
window.loadRecommendSheets = () => RecommendModule.loadSheets();
window.loadRecommendSheetsByTag = () => RecommendModule.loadSheetsByTag();
window.renderRecommendSheetsList = (container, append) => RecommendModule.renderSheetsList(container, append);
window.setupRecommendSheetsObserver = () => RecommendModule.setupObserver();
window.loadMoreRecommendSheets = () => RecommendModule.loadMore();
window.loadSheetDetail = (id, title, pluginName, onBack) => RecommendModule.loadDetail(id, title, pluginName, onBack);
window.backToRecommendSheets = () => RecommendModule.backToSheets();
window.toggleRecommendTagPanel = () => RecommendModule.toggleTagPanel();
window.hideRecommendTagPanel = () => RecommendModule.hideTagPanel();
window.searchRecommendSheets = () => RecommendModule.searchSheets();
window.clearRecommendSheetsSearch = () => RecommendModule.clearSearch();

// ==================== 添加到歌单功能 ====================

/**
 * 获取选中的歌曲
 * @returns {Array} 选中的歌曲列表
 */
function getSelectedSongs() {
    return MusicTable.getSelectedSongs ? MusicTable.getSelectedSongs() : [];
}

/**
 * 获取当前页面显示的所有歌曲
 * @returns {Array} 所有歌曲列表
 */
function getCurrentSongs() {
    return window.currentRecommendMusicList || [];
}

/**
 * 添加选中的歌曲到歌单
 * 场景1：未选中歌曲 -> 将当前列表所有歌曲添加到新榜单
 * 场景2：已选中歌曲 -> 弹出选择框，可选择新建或添加到已有榜单
 */
async function addSelectedToPlaylistRecommend() {
    const selectedSongs = getSelectedSongs();
    const currentSongs = getCurrentSongs();

    // 场景1：未选中歌曲
    if (!selectedSongs || selectedSongs.length === 0) {
        if (!currentSongs || currentSongs.length === 0) {
            showToast('当前列表没有歌曲', 'warning');
            return;
        }

        // 使用当前歌单名称作为新榜单名称，并加上插件别名前缀（如“酷我-热歌榜”）
        const playlistName = (typeof window.getEffectivePlaylistName === 'function')
            ? await window.getEffectivePlaylistName(currentSheetTitle || '热门歌单', currentSongs, typeof currentRecommendPlugin !== 'undefined' ? currentRecommendPlugin : undefined)
            : (currentSheetTitle || '热门歌单');

        // 显示确认弹窗：与「订阅」同款语义——只保存歌单地址（插件 + 歌单ID），
        // 不逐首入库；进入歌单时实时向插件拉取最新内容
        showConfirmModal({
            title: '保存为实时歌单',
            message: `将当前歌单「${playlistName}」保存为实时歌单吗？\n歌单里只保存来源地址，每次打开都会自动拉取最新内容（不保存任何歌曲快照）。`,
            confirmText: '确认保存',
            confirmClass: 'btn-primary',
            onConfirm: async () => {
                if (typeof addSongsToNewPlaylist === 'function') {
                    await addSongsToNewPlaylist(currentSongs, playlistName, window.currentSheetCover, {
                        type: 'playlist',
                        platform: currentRecommendPlugin,
                        toplistId: window.currentSheetId
                    });
                } else {
                    showToast('添加歌单功能未加载', 'error');
                }
            }
        });
        return;
    }

    // 场景2：已选中歌曲 -> 显示添加到歌单弹窗
    if (typeof showAddToPlaylistModal === 'function') {
        showAddToPlaylistModal(selectedSongs, currentSheetTitle || '热门歌单', window.currentSheetCover);
    } else {
        showToast('添加歌单功能未加载', 'error');
    }
}

window.addSelectedToPlaylistRecommend = addSelectedToPlaylistRecommend;
