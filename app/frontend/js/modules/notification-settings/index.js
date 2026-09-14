/**
 * 通知设置模块（企业微信应用 + 回调）
 * 对应后端：backend/wecom-app.js
 *   GET  /api/wecom-app/config
 *   POST /api/wecom-app/config
 *   POST /api/wecom-app/test
 *   POST /api/wecom-app/menu
 *   GET/POST /api/wecom-app/callback  (公网回调，无需登录)
 */

function loadNotificationSettings() {
    loadWecomAppConfig();
}

async function loadWecomAppConfig() {
    try {
        const res = await API.get('/api/wecom-app/config');
        if (!res || !res.success || !res.data) return;
        const c = res.data;
        setInput('wecom-app-corpid', c.corpid || '');
        setInput('wecom-app-corpsecret', c.corpsecret || '');
        setInput('wecom-app-agentid', c.agentid || '');
        setInput('wecom-app-touser', c.touser || '');
        setInput('wecom-app-token', c.token || '');
        setInput('wecom-app-encodingaeskey', c.encodingAESKey || '');
        const cb = document.getElementById('wecom-app-enabled');
        if (cb) {
            cb.checked = !!c.enabled;
            cb.onchange = () => updateWecomEnabledStatus();
        }
        updateWecomEnabledStatus();
        const urlInput = document.getElementById('wecom-app-callback-url');
        // 回显已保存的回调 URL；未保存则给出当前站点地址作为默认（不强制）
        if (urlInput) urlInput.value = c.callbackUrl || defaultCallbackUrl();
    } catch (e) {
        showWecomStatus('加载配置失败：' + e.message, 'error');
    }
}

function updateWecomEnabledStatus() {
    const cb = document.getElementById('wecom-app-enabled');
    const status = document.getElementById('wecom-app-enabled-status');
    if (cb && status) status.textContent = cb.checked ? '已启用' : '已禁用';
}

function setInput(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}

function getInput(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
}

async function saveWecomApp() {
    const cb = document.getElementById('wecom-app-enabled');
    const cfg = {
        enabled: cb ? cb.checked : false,
        corpid: getInput('wecom-app-corpid'),
        corpsecret: getInput('wecom-app-corpsecret'),
        agentid: getInput('wecom-app-agentid'),
        touser: getInput('wecom-app-touser'),
        token: getInput('wecom-app-token'),
        encodingAESKey: getInput('wecom-app-encodingaeskey'),
        callbackUrl: getInput('wecom-app-callback-url')
    };
    showWecomStatus('保存中...', 'info');
    try {
        const res = await API.post('/api/wecom-app/config', cfg);
        if (res && res.success) showWecomStatus('✅ 配置已保存', 'success');
        else showWecomStatus('保存失败：' + ((res && res.error) || '未知错误'), 'error');
    } catch (e) {
        showWecomStatus('保存失败：' + e.message, 'error');
    }
}

async function testWecomApp() {
    const cfg = {
        corpid: getInput('wecom-app-corpid'),
        corpsecret: getInput('wecom-app-corpsecret'),
        agentid: getInput('wecom-app-agentid'),
        touser: getInput('wecom-app-touser')
    };
    showWecomStatus('发送测试消息中...', 'info');
    try {
        const res = await API.post('/api/wecom-app/test', cfg);
        if (res && res.success) showWecomStatus('✅ 测试消息已发送，请查看企业微信', 'success');
        else showWecomStatus('测试失败：' + ((res && res.error) || '未知错误'), 'error');
    } catch (e) {
        showWecomStatus('测试失败：' + e.message, 'error');
    }
}

async function createWecomMenu() {
    showWecomStatus('创建菜单中...', 'info');
    try {
        const res = await API.post('/api/wecom-app/menu', {});
        if (res && res.success) {
            const d = res.data || {};
            let msg = '✅ 菜单已创建，企业微信会话底部可见';
            if (d.preservedCustom) msg += `（已保留 ${d.preservedCustom} 个自定义菜单）`;
            if (d.truncatedStandard) msg += '（自定义菜单已满 3 个，部分标准菜单未追加）';
            showWecomStatus(msg, 'success');
        } else {
            showWecomStatus('创建失败：' + ((res && res.error) || '未知错误'), 'error');
        }
    } catch (e) {
        showWecomStatus('创建失败：' + e.message, 'error');
    }
}

// 生成默认回调 URL：企业微信仅接受 80/443 标准端口，剥离非标准端口避免误填
function defaultCallbackUrl() {
    try {
        const u = new URL(location.origin);
        if (u.port && u.port !== '80' && u.port !== '443') u.port = '';
        return u.toString().replace(/\/$/, '') + '/api/wecom-app/callback';
    } catch (e) {
        return location.origin + '/api/wecom-app/callback';
    }
}

function showWecomStatus(msg, type) {
    const el = document.getElementById('wecom-app-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = type === 'error' ? 'var(--danger-color, #e74c3c)'
        : type === 'success' ? 'var(--primary-color, #1db954)'
        : 'var(--text-secondary, #888)';
}

// 暴露到全局，供页面 onclick 与 app.js 调用
window.loadNotificationSettings = loadNotificationSettings;
window.saveWecomApp = saveWecomApp;
window.testWecomApp = testWecomApp;
window.createWecomMenu = createWecomMenu;
