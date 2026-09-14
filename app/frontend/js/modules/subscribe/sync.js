/**
 * 订阅同步模块
 * 用于更新榜单排行
 * 只更新歌曲列表，不执行下载
 */

/**
 * 生成请求ID
 * @returns {string}
 */
function generateReqId() {
    return Math.random().toString(36).substring(2, 10);
}

/**
 * 同步订阅榜单（仅更新歌曲列表，不下载）
 * 更新榜单排行
 * @param {string} platform
 * @param {string} toplistId
 * @param {string} encodedTitle - 可选，用于显示提示
 */
async function runSubscriptionSync(platform, toplistId, encodedTitle) {
    const reqId = generateReqId();
    const title = encodedTitle ? decodeURIComponent(encodedTitle) : '';
    
    console.log(`[INFO ][SYNC][${reqId}] START | 榜单同步 | ${title || '未知榜单'} | {"platform":"${platform}","toplistId":"${toplistId}"}`);
    
    try {
        // 参数检查
        if (!platform || !toplistId) {
            console.error(`[ERROR][SYNC][${reqId}] 同步参数错误:`, { platform, toplistId });
            showToast('同步失败: 缺少必要的参数', 'error');
            return null;
        }
        
        showToast(title ? `正在同步: ${title}...` : '正在同步榜单数据...', 'info');
        
        const token = Auth.getToken();
        console.log(`[INFO ][SYNC][${reqId}] API | POST /api/subscribed-toplists/run | ${title || '未知榜单'}`);
        
        const response = await fetch(`${API_BASE}/api/subscribed-toplists/run`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ 
                platform, 
                toplistId, 
                trackProgress: false, 
                skipDownload: true 
            })
        });

        const result = await response.json();

        if (result.success) {
            console.log(`[INFO ][SYNC][${reqId}] SUCCESS | 榜单同步完成 | ${title || '未知榜单'}`);
            showToast('同步成功！', 'success');
            
            if (typeof loadSubscribedToplists === 'function') {
                loadSubscribedToplists();
            }
            return result.data;
        } else {
            console.error(`[ERROR][SYNC][${reqId}] FAILED | 榜单同步失败 | ${title || '未知榜单'} | ${result.error || '未知错误'}`);
            showToast('同步失败: ' + (result.error || '未知错误'), 'error');
            return null;
        }
    } catch (error) {
        console.error(`[ERROR][SYNC][${reqId}] ERROR | 榜单同步异常 | ${title || '未知榜单'} | ${error.message}`);
        showToast('同步失败: ' + error.message, 'error');
        return null;
    }
}

/**
 * 批量同步多个订阅
 * @param {Array} subscriptions - 订阅列表
 * @param {boolean} showProgress - 是否显示进度
 */
async function batchSyncSubscriptions(subscriptions, showProgress = true) {
    if (!subscriptions || subscriptions.length === 0) {
        showToast('没有需要同步的订阅', 'info');
        return;
    }

    const total = subscriptions.length;
    let completed = 0;
    let failed = 0;

    if (showProgress) {
        showToast(`开始批量同步 ${total} 个订阅...`, 'info');
    }

    for (const sub of subscriptions) {
        try {
            await runSubscriptionSync(sub.platform, sub.toplist_id || sub.toplistId, encodeURIComponent(sub.title));
            completed++;
        } catch (error) {
            console.error(`同步失败: ${sub.title}`, error);
            failed++;
        }
    }

    if (showProgress) {
        if (failed > 0) {
            showToast(`批量同步完成: ${completed} 成功, ${failed} 失败`, 'warning');
        } else {
            showToast(`批量同步完成: ${completed} 个订阅`, 'success');
        }
    }

    if (typeof loadSubscribedToplists === 'function') {
        loadSubscribedToplists();
    }

    return { completed, failed, total };
}

/**
 * 静默执行订阅任务（不显示进度弹窗）
 * 用于订阅后自动执行
 * @param {string} platform
 * @param {string} toplistId
 */
async function runSubscriptionSilent(platform, toplistId) {
    try {
        const token = Auth.getToken();
        
        // 先执行同步
        await fetch(`${API_BASE}/api/subscribed-toplists/run`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ 
                platform, 
                toplistId, 
                trackProgress: false, 
                skipDownload: true 
            })
        });
        
        // 等待10秒
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // 执行下载
        await fetch(`${API_BASE}/api/subscribed-toplists/run`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ 
                platform, 
                toplistId, 
                trackProgress: false 
            })
        });
        
        // 刷新列表
        if (typeof loadSubscribedToplists === 'function') {
            loadSubscribedToplists();
        }
    } catch (error) {
        console.error('静默执行任务失败:', error);
    }
}

// 导出到全局
window.runSubscriptionSync = runSubscriptionSync;
window.batchSyncSubscriptions = batchSyncSubscriptions;
window.runSubscriptionSilent = runSubscriptionSilent;
