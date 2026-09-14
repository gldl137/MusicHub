/**
 * 通知管理模块
 * 统一管理所有通知、提示和弹窗
 */

const Notification = {
    // 通知容器
    container: null,

    // 通知历史
    history: [],

    // 最大历史记录数
    maxHistory: 50,

    // 通知权限状态

    permission: 'default',

    // 是否正在请求权限（防止递归调用用户回调

    _isRequestingPermission: false,

    /**
     * 初始化通知模块
     */
    init() {
        // 创建通知容器
        this.createContainer();

        // 请求桌面通知权限
        this.requestPermission();

        // 加载历史记录
        this.loadHistory();

        console.log('[INFO] [] Module initialized');
    },

    /**
     * 创建通知容器
     */
    createContainer() {
        if (document.getElementById('notification-container')) {
            this.container = document.getElementById('notification-container');
            return;
        }

        this.container = document.createElement('div');
        this.container.id = 'notification-container';
        this.container.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: 10px;
            pointer-events: none;
        `;
        document.body.appendChild(this.container);
    },

    /**
     * 请求桌面通知权限
     */
    async requestPermission() {
        if (!('Notification' in window)) {
            console.warn('[WARN] [] [] 浏览器不支持桌面通知');
            return;
        }

        // 防止递归调用
        if (this._isRequestingPermission) {
            return;
        }

        this.permission = Notification.permission;

        if (this.permission === 'default') {
            this._isRequestingPermission = true;
            try {
                const result = await Notification.requestPermission();
                this.permission = result;
            } catch (error) {
                console.warn('[WARN] [] [] 请求权限失败:', error);
            } finally {
                this._isRequestingPermission = false;
            }
        }
    },

    // ==================== Toast 提示 ====================

    /**
     * 显示 Toast 提示
     * @param {string} message - 提示消息
     * @param {string} type - 类型: success, error, warning, info
     * @param {number} duration - 显示时长（毫秒）
     */
    toast(message, type = 'info', duration = 2000) {
        const toastEl = document.createElement('div');

        const icons = {
            success: '✓',
            error: '✗',
            warning: '!',
            info: 'i'
        };

        // 使用主题色
        const themeColor = 'var(--primary-color, #1db954)';

        toastEl.className = `toast-notification toast-${type}`;
        toastEl.style.cssText = `
            background: var(--surface-color, #181818);
            color: var(--text-color, #ffffff);
            border-left: 4px solid ${themeColor};
            padding: 12px 20px;
            border-radius: 8px;
            box-shadow: var(--shadow-md, 0 4px 20px rgba(0,0,0,0.4));
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 14px;
            min-width: 200px;
            max-width: 400px;
            pointer-events: auto;
            animation: slideIn 0.3s ease;
            backdrop-filter: blur(10px);
        `;

        toastEl.innerHTML = `
            <span style="font-size: 18px; font-weight: bold; color: ${themeColor};">${icons[type]}</span>
            <span style="flex: 1; color: var(--text-color, #ffffff);">${this.escapeHtml(message)}</span>
        `;

        // 添加动画样式
        if (!document.getElementById('notification-styles')) {
            const style = document.createElement('style');
            style.id = 'notification-styles';
            style.textContent = `
                @keyframes slideIn {
                    from { transform: translateY(-100%); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
                @keyframes slideOut {
                    from { transform: translateY(0); opacity: 1; }
                    to { transform: translateY(-100%); opacity: 0; }
                }
            `;
            document.head.appendChild(style);
        }

        this.container.appendChild(toastEl);

        // 添加到历？
        this.addToHistory({
            type: 'toast',
            message,
            level: type,
            time: new Date()
        });

        // 自动移除
        setTimeout(() => {
            toastEl.style.animation = 'slideOut 0.3s ease forwards';
            setTimeout(() => {
                toastEl.remove();
            }, 300);
        }, duration);
    },

    success(message, duration) {
        this.toast(message, 'success', duration);
    },

    error(message, duration) {
        this.toast(message, 'error', duration);
    },

    warning(message, duration) {
        this.toast(message, 'warning', duration);
    },

    info(message, duration) {
        this.toast(message, 'info', duration);
    },

    // ==================== 桌面通知 ====================

    /**
     * 显示桌面通知
     * @param {string} title - 通知标题
     * @param {Object} options - 通知选项
     * @returns {Promise}
     */
    async desktop(title, options = {}) {
        if (!('Notification' in window)) {
            console.warn('[WARN] [] [] 浏览器不支持桌面通知');
            return;
        }

        if (this.permission !== 'granted') {
            console.warn('[WARN] [] [] 没有桌面通知权限');
            return;
        }

        // 检查用户是否启用了通知
        const notificationEnabled = localStorage.getItem('notification_enabled') === 'true';
        if (!notificationEnabled) {
            return;
        }

        const defaultOptions = {
            icon: '/favicon.ico',
            badge: '/favicon.ico',
            tag: 'musichub',
            requireInteraction: false,
            ...options
        };

        try {
            const notification = new Notification(title, defaultOptions);

            notification.onclick = () => {
                window.focus();
                notification.close();
                if (options.onClick) {
                    options.onClick();
                }
            };

            // 添加到历？
            this.addToHistory({
                type: 'desktop',
                title,
                body: options.body,
                time: new Date()
            });

            return notification;
        } catch (error) {
            console.error('[ERROR] [] [] 显示桌面通知失败:', error);
        }
    },

    /**
     * 显示音乐播放通知
     * @param {Object} music - 音乐信息
     */
    async musicPlaying(music) {
        if (!music) return;

        const playingAlbum = music.album ? ` - ${music.album}` : '';
        return this.desktop(`正在播放: ${music.title}`, {
            body: `${music.artist || '未知艺术家'}${playingAlbum}`,
            tag: 'music-playing',
            requireInteraction: false
        });
    },

    /**
     * 显示下载完成通知
     * @param {Object} music - 音乐信息
     */
    async downloadComplete(music) {
        if (!music) return;

        const doneAlbum = music.album ? ` - ${music.album}` : '';
        return this.desktop(`下载完成: ${music.title}`, {
            body: `${music.artist || '未知艺术家'}${doneAlbum}`,
            tag: 'download-complete',
            requireInteraction: false
        });
    },

    // ==================== 确认对话？====================

    /**
     * 显示确认对话？
     * @param {string} message - 确认消息
     * @param {Object} options - 选项
     * @returns {Promise<boolean>}
     */
    async confirm(message, options = {}) {
        const {
            title = '确认',
            confirmText = '确定',
            cancelText = '取消',
            type = 'warning'
        } = options;

        return new Promise((resolve) => {
            // 创建遮罩？
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0,0,0,0.5);
                z-index: 100000;
                display: flex;
                align-items: center;
                justify-content: center;
                backdrop-filter: blur(4px);
            `;

            // 创建对话？
            const dialog = document.createElement('div');
            dialog.style.cssText = `
                background: var(--surface-color, white);
                border-radius: 12px;
                padding: 24px;
                min-width: 320px;
                max-width: 480px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                animation: dialogShow 0.2s ease;
            `;

            const colors = {
                warning: '#f59e0b',
                error: '#ef4444',
                info: '#3b82f6'
            };

            dialog.innerHTML = `
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
                    <div style="
                        width: 40px;
                        height: 40px;
                        border-radius: 50%;
                        background: ${colors[type]}20;
                        color: ${colors[type]};
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-size: 20px;
                        font-weight: bold;
                    ">${type === 'warning' ? '!' : type === 'error' ? '✗' : 'i'}</div>
                    <div style="font-size: 18px; font-weight: 600;">${title}</div>
                </div>
                <div style="margin-bottom: 24px; color: var(--text-secondary, #666); line-height: 1.5;">
                    ${this.escapeHtml(message)}
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 12px;">
                    <button id="dialog-cancel" style="
                        padding: 8px 16px;
                        border: 1px solid var(--border-color, #ddd);
                        background: transparent;
                        color: var(--text-color, white);
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 14px;
                    ">${cancelText}</button>
                    <button id="dialog-confirm" style="
                        padding: 8px 16px;
                        border: none;
                        background: ${colors[type]};
                        color: white;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: 500;
                    ">${confirmText}</button>
                </div>
            `;

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            // 添加动画样式
            if (!document.getElementById('dialog-styles')) {
                const style = document.createElement('style');
                style.id = 'dialog-styles';
                style.textContent = `
                    @keyframes dialogShow {
                        from { transform: scale(0.9); opacity: 0; }
                        to { transform: scale(1); opacity: 1; }
                    }
                `;
                document.head.appendChild(style);
            }

            // 绑定事件
            dialog.querySelector('#dialog-cancel').onclick = () => {
                overlay.remove();
                resolve(false);
            };

            dialog.querySelector('#dialog-confirm').onclick = () => {
                overlay.remove();
                resolve(true);
            };

            // 点击遮罩关闭
            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    overlay.remove();
                    resolve(false);
                }
            };

            // ESC 关闭
            const handleKeydown = (e) => {
                if (e.key === 'Escape') {
                    overlay.remove();
                    resolve(false);
                    document.removeEventListener('keydown', handleKeydown);
                }
            };
            document.addEventListener('keydown', handleKeydown);
        });
    },

    // ==================== 提示对话框 ====================

    /**
     * 显示提示对话框（alert替代）
     * @param {string} message - 提示消息
     * @param {Object} options - 选项
     * @returns {Promise<void>}
     */
    async alert(message, options = {}) {
        const {
            title = '提示',
            confirmText = '确定',
            type = 'info'
        } = options;

        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0,0,0,0.5);
                z-index: 100000;
                display: flex;
                align-items: center;
                justify-content: center;
                backdrop-filter: blur(4px);
            `;

            const dialog = document.createElement('div');
            dialog.style.cssText = `
                background: var(--surface-color, white);
                border-radius: 12px;
                padding: 24px;
                min-width: 320px;
                max-width: 480px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                animation: dialogShow 0.2s ease;
            `;

            const colors = {
                warning: '#f59e0b',
                error: '#ef4444',
                info: '#3b82f6',
                success: '#22c55e'
            };

            dialog.innerHTML = `
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
                    <div style="
                        width: 40px;
                        height: 40px;
                        border-radius: 50%;
                        background: ${colors[type]}20;
                        color: ${colors[type]};
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-size: 20px;
                        font-weight: bold;
                    ">${type === 'warning' ? '!' : type === 'error' ? '✗' : type === 'success' ? '✓' : 'i'}</div>
                    <div style="font-size: 18px; font-weight: 600;">${title}</div>
                </div>
                <div style="margin-bottom: 24px; color: var(--text-secondary, #666); line-height: 1.5;">
                    ${this.escapeHtml(message)}
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 12px;">
                    <button id="dialog-confirm" style="
                        padding: 8px 16px;
                        border: none;
                        background: ${colors[type]};
                        color: white;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: 500;
                    ">${confirmText}</button>
                </div>
            `;

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            if (!document.getElementById('dialog-styles')) {
                const style = document.createElement('style');
                style.id = 'dialog-styles';
                style.textContent = `
                    @keyframes dialogShow {
                        from { transform: scale(0.9); opacity: 0; }
                        to { transform: scale(1); opacity: 1; }
                    }
                `;
                document.head.appendChild(style);
            }

            dialog.querySelector('#dialog-confirm').onclick = () => {
                overlay.remove();
                resolve();
            };

            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    overlay.remove();
                    resolve();
                }
            };

            const handleKeydown = (e) => {
                if (e.key === 'Escape' || e.key === 'Enter') {
                    overlay.remove();
                    resolve();
                    document.removeEventListener('keydown', handleKeydown);
                }
            };
            document.addEventListener('keydown', handleKeydown);
        });
    },

    /**
     * 显示输入对话框（prompt替代）
     * @param {string} message - 提示消息
     * @param {string} defaultValue - 默认值
     * @param {Object} options - 选项
     * @returns {Promise<string|null>} - 返回输入值或null（取消）
     */
    async prompt(message, defaultValue = '', options = {}) {
        const {
            title = '输入',
            confirmText = '确定',
            cancelText = '取消',
            type = 'info'
        } = options;

        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0,0,0,0.5);
                z-index: 100000;
                display: flex;
                align-items: center;
                justify-content: center;
                backdrop-filter: blur(4px);
            `;

            const dialog = document.createElement('div');
            dialog.style.cssText = `
                background: var(--surface-color, white);
                border-radius: 12px;
                padding: 24px;
                min-width: 320px;
                max-width: 480px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                animation: dialogShow 0.2s ease;
            `;

            const colors = {
                warning: '#f59e0b',
                error: '#ef4444',
                info: '#3b82f6',
                success: '#22c55e'
            };

            dialog.innerHTML = `
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
                    <div style="
                        width: 40px;
                        height: 40px;
                        border-radius: 50%;
                        background: ${colors[type]}20;
                        color: ${colors[type]};
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-size: 20px;
                        font-weight: bold;
                    ">${type === 'warning' ? '!' : type === 'error' ? '✗' : type === 'success' ? '✓' : 'i'}</div>
                    <div style="font-size: 18px; font-weight: 600;">${title}</div>
                </div>
                <div style="margin-bottom: 12px; color: var(--text-secondary, #666); line-height: 1.5;">
                    ${this.escapeHtml(message)}
                </div>
                <div style="margin-bottom: 24px;">
                    <input type="text" id="dialog-input" value="${this.escapeHtml(defaultValue)}" style="
                        width: 100%;
                        padding: 10px 12px;
                        border: 1px solid var(--border-color, #ddd);
                        border-radius: 6px;
                        background: var(--bg-tertiary, #f0f0f0);
                        color: var(--text-color, #333);
                        font-size: 14px;
                        outline: none;
                        box-sizing: border-box;
                    ">
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 12px;">
                    <button id="dialog-cancel" style="
                        padding: 8px 16px;
                        border: 1px solid var(--border-color, #ddd);
                        background: transparent;
                        color: var(--text-color, white);
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 14px;
                    ">${cancelText}</button>
                    <button id="dialog-confirm" style="
                        padding: 8px 16px;
                        border: none;
                        background: ${colors[type]};
                        color: white;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: 500;
                    ">${confirmText}</button>
                </div>
            `;

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            const input = dialog.querySelector('#dialog-input');
            input.focus();
            input.select();

            if (!document.getElementById('dialog-styles')) {
                const style = document.createElement('style');
                style.id = 'dialog-styles';
                style.textContent = `
                    @keyframes dialogShow {
                        from { transform: scale(0.9); opacity: 0; }
                        to { transform: scale(1); opacity: 1; }
                    }
                `;
                document.head.appendChild(style);
            }

            dialog.querySelector('#dialog-cancel').onclick = () => {
                overlay.remove();
                resolve(null);
            };

            dialog.querySelector('#dialog-confirm').onclick = () => {
                const value = input.value;
                overlay.remove();
                resolve(value);
            };

            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    overlay.remove();
                    resolve(null);
                }
            };

            const handleKeydown = (e) => {
                if (e.key === 'Escape') {
                    overlay.remove();
                    resolve(null);
                    document.removeEventListener('keydown', handleKeydown);
                } else if (e.key === 'Enter') {
                    const value = input.value;
                    overlay.remove();
                    resolve(value);
                    document.removeEventListener('keydown', handleKeydown);
                }
            };
            document.addEventListener('keydown', handleKeydown);
        });
    },

    // ==================== 提示？====================

    /**
     * 显示提示框（自动消失败

     * @param {string} message - 提示内容
     * @param {number} duration - 显示时长
     */
    show(message, duration = 2000) {
        const el = document.createElement('div');
        el.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0,0,0,0.8);
            color: white;
            padding: 16px 32px;
            border-radius: 8px;
            font-size: 14px;
            z-index: 10002;
            animation: fadeIn 0.2s ease;
            pointer-events: none;
        `;
        el.textContent = message;

        if (!document.getElementById('fade-styles')) {
            const style = document.createElement('style');
            style.id = 'fade-styles';
            style.textContent = `
                @keyframes fadeIn {
                    from { opacity: 0; transform: translate(-50%, -40%); }
                    to { opacity: 1; transform: translate(-50%, -50%); }
                }
                @keyframes fadeOut {
                    from { opacity: 1; }
                    to { opacity: 0; }
                }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(el);

        setTimeout(() => {
            el.style.animation = 'fadeOut 0.2s ease forwards';
            setTimeout(() => el.remove(), 200);
        }, duration);
    },

    // ==================== 历史记录 ====================

    /**
     * 添加到历史记？
     * @param {Object} record - 记录对象
     */
    addToHistory(record) {
        this.history.unshift(record);
        if (this.history.length > this.maxHistory) {
            this.history = this.history.slice(0, this.maxHistory);
        }
        this.saveHistory();
    },

    /**
     * 加载历史记录
     */
    loadHistory() {
        try {
            const saved = localStorage.getItem('notification_history');
            if (saved) {
                this.history = JSON.parse(saved);
            }
        } catch (e) {
            console.warn('[WARN] [] [] 加载历史记录失败');
        }
    },

    /**
     * 保存历史记录
     */
    saveHistory() {
        try {
            localStorage.setItem('notification_history', JSON.stringify(this.history));
        } catch (e) {
            console.warn('[WARN] [] [] 保存历史记录失败');
        }
    },

    /**
     * 获取历史记录
     * @param {number} limit - 限制数量
     * @returns {Array}
     */
    getHistory(limit = 20) {
        return this.history.slice(0, limit);
    },

    /**
     * 清空历史记录
     */
    clearHistory() {
        this.history = [];
        localStorage.removeItem('notification_history');
    },

    // ==================== 工具函数 ====================

    /**
     * HTML 转义
     * @param {string} text
     * @returns {string}
     */
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', () => {
    Notification.init();
});

// 导出到全局
window.Notification = Notification;

// 兼容旧版 showToast
window.showToast = (message, type = 'info', duration) => {
    Notification.toast(message, type, duration);
};
