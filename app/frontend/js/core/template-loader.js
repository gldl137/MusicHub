/**
 * 模板加载器模块
 * 负责动态加载 HTML 模板文件
 */

const TemplateLoader = {
    // 缓存已加载的模板
    cache: new Map(),

    /**
     * 加载模板文件
     * @param {string} name - 模板名称（对应文件名）
     * @returns {Promise<string>} 模板 HTML 字符串
     */
    async load(name) {
        // 检查缓存
        if (this.cache.has(name)) {
            return this.cache.get(name);
        }

        try {
            const response = await fetch(`templates/pages/${name}.html`);
            if (!response.ok) {
                throw new Error(`Failed to load template: ${name}`);
            }
            const html = await response.text();
            // 缓存模板
            this.cache.set(name, html);
            return html;
        } catch (error) {
            console.error(`[ERROR] [ERROR] [TemplateLoader] Error loading template "${name}":`, error);
            // 返回空状态模板作为后备
            return this.getFallbackTemplate(name);
        }
    },

    /**
     * 加载模板并插入到指定容器
     * @param {string} name - 模板名称
     * @param {HTMLElement} container - 目标容器
     * @param {boolean} append - 是否追加模式（false 则替换内容）
     * @returns {Promise<boolean>} 是否成功
     */
    async loadInto(name, container, append = false) {
        try {
            const html = await this.load(name);
            if (append) {
                container.insertAdjacentHTML('beforeend', html);
            } else {
                container.innerHTML = html;
            }
            return true;
        } catch (error) {
            console.error(`[ERROR] [ERROR] [TemplateLoader] Error inserting template "${name}":`, error);
            return false;
        }
    },

    /**
     * 预加载多个模板
     * @param {string[]} names - 模板名称数组
     * @returns {Promise<void>}
     */
    async preload(names) {
        const promises = names.map(name => this.load(name));
        await Promise.all(promises);
        console.log('[INFO] [] Preloaded templates:', names);
    },

    /**
     * 清空缓存
     */
    clearCache() {
        this.cache.clear();
        console.log('[INFO] [] Cache cleared');
    },

    /**
     * 获取后备模板（当加载失败时）
     * @param {string} name - 模板名称
     * @returns {string} 后备 HTML
     */
    getFallbackTemplate(name) {
        const titles = {
            'toplist': '排行榜',
            'recommend': '热门歌单',
            'download': '下载管理',
            'recent': '最近播放',
            'plugins': '插件管理',
            'settings': '设置',
            'subscribed-toplist': '下载订阅',
            'my-playlists': '我的歌单',
            'favorites': '我的收藏'
        };
        const title = titles[name] || name;
        return `
            <div class="page" id="page-${name}">
                <div class="empty-state">
                    <div class="empty-icon">⚠️</div>
                    <div class="empty-text">加载 ${title} 页面失败</div>
                    <div class="empty-subtext">请刷新页面重试</div>
                </div>
            </div>
        `;
    }
};

// 导出到全局
window.TemplateLoader = TemplateLoader;
console.log('[INFO] [] Module initialized');
