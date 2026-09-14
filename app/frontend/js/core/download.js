/**
 * 核心下载器 - 所有下载功能的唯一入口
 */

// 最近完成的任务缓存（用于"刚完成"分组显示）
const RECENT_COMPLETED_MAX = 20;
const RECENT_COMPLETED_TTL = 30000; // 30秒
window.recentCompletedDownloads = [];

// 添加任务到最近完成列表
function addToRecentCompleted(task) {
    const now = Date.now();
    // 清理过期任务
    window.recentCompletedDownloads = window.recentCompletedDownloads.filter(
        item => now - item.completedAt < RECENT_COMPLETED_TTL
    );
    // 添加新任务
    window.recentCompletedDownloads.unshift({
        ...task,
        completedAt: now
    });
    // 限制数量
    if (window.recentCompletedDownloads.length > RECENT_COMPLETED_MAX) {
        window.recentCompletedDownloads = window.recentCompletedDownloads.slice(0, RECENT_COMPLETED_MAX);
    }
}

// 广播下载列表更新事件
function broadcastDownloadListUpdate() {
    window.dispatchEvent(new CustomEvent('download:listUpdated', {
        detail: { timestamp: Date.now() }
    }));
}

const DownloadCore = {
    queue: [],
    isProcessing: false,
    downloadedCache: new Set(),
    downloadingCache: new Set(),

    async download(params, onProgress, source = 'download-core') {
        const { id, title, artist, plugin, quality = 'standard', ...extra } = params;
        
        if (!id || !plugin) {
            return { success: false, error: '缺少必要参数' };
        }

        const key = `${id}_${plugin}`;
        
        if (await this.isDownloaded(id, plugin)) {
            onProgress?.('already_downloaded', { title, artist });
            return { success: true, status: 'already_downloaded' };
        }

        if (this.isDownloading(id, plugin)) {
            onProgress?.('downloading', { title, artist });
            return { success: true, status: 'downloading' };
        }

        this.downloadingCache.add(key);
        this.updateUI(id, plugin, 'downloading');
        onProgress?.('pending', { title, artist });

        // 乐观更新：立即广播下载中状态
        broadcastDownloadListUpdate();

        try {
            await this.saveToDB({ id, title, artist, plugin, quality, ...extra });
            const result = await this.startBackendDownload({ id, title, artist, plugin, quality, ...extra }, source);

            if (result.success) {
                this.downloadingCache.delete(key);
                this.downloadedCache.add(key);
                this.updateUI(id, plugin, 'downloaded');
                onProgress?.('completed', { title, artist, filePath: result.filePath });
                
                // 添加到最近完成任务列表
                addToRecentCompleted({ id, title, artist, plugin, quality });
                
                // 广播下载完成
                broadcastDownloadListUpdate();
                
                return { success: true, filePath: result.filePath };
            }
            throw new Error(result.error);
        } catch (error) {
            this.downloadingCache.delete(key);
            this.updateUI(id, plugin, 'failed');
            onProgress?.('failed', { title, artist, error: error.message });
            
            // 广播下载失败
            broadcastDownloadListUpdate();
            
            return { success: false, error: error.message };
        }
    },

    async downloadBatch(songs, options = {}, source = 'download-batch') {
        const { delay = 500, onItemProgress, onBatchProgress } = options;
        const results = { success: 0, failed: 0, skipped: 0, total: songs.length };

        for (let i = 0; i < songs.length; i++) {
            const song = songs[i];
            onBatchProgress?.({ current: i + 1, total: songs.length, title: song.title, ...results });

            const result = await this.download(song, onItemProgress, source);
            
            if (result.status === 'already_downloaded') results.skipped++;
            else if (result.success) results.success++;
            else results.failed++;

            if (delay > 0 && i < songs.length - 1) {
                await new Promise(r => setTimeout(r, delay));
            }
        }

        onBatchProgress?.({ current: songs.length, total: songs.length, completed: true, ...results });
        return results;
    },

    async isDownloaded(id, plugin) {
        const key = `${id}_${plugin}`;
        if (this.downloadedCache.has(key)) return true;
        if (window.StateManager?.isDownloaded) {
            return await window.StateManager.isDownloaded(id, plugin);
        }
        return false;
    },

    isDownloading(id, plugin) {
        return this.downloadingCache.has(`${id}_${plugin}`);
    },

    async saveToDB(music) {
        const res = await fetch(`${API_BASE}/api/downloads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ music, plugin: music.plugin, quality: music.quality })
        });
        return res.json();
    },

    async startBackendDownload(music, source = 'download-btn') {
        const { id, plugin } = music;
        
        // 立即更新 UI 为下载中状态
        this.downloadingCache.add(`${id}_${plugin}`);
        this.updateUI(id, plugin, 'downloading');
        
        const res = await fetch(`${API_BASE}/api/downloads/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                musicId: music.id,
                plugin: music.plugin,
                quality: music.quality,
                music: music,
                source: source
            })
        });
        const result = await res.json();
        
        // 启动状态轮询
        if (result.success) {
            this.pollDownloadStatus(id, plugin);
        } else {
            // 启动失败，更新 UI 为失败
            this.downloadingCache.delete(`${id}_${plugin}`);
            this.updateUI(id, plugin, 'failed');
        }
        
        return result;
    },

    async pollDownloadStatus(id, plugin, maxAttempts = 60) {
        let attempts = 0;
        const poll = async () => {
            if (attempts >= maxAttempts) {
                this.downloadingCache.delete(`${id}_${plugin}`);
                this.updateUI(id, plugin, 'failed');
                return;
            }
            attempts++;
            
            try {
                const res = await fetch(`${API_BASE}/api/downloads/status?musicId=${id}&plugin=${plugin}`);
                const data = await res.json();
                
                if (data.success) {
                    const status = data.data?.status;
                    if (status === 'completed' || status === 'downloaded') {
                        this.downloadingCache.delete(`${id}_${plugin}`);
                        this.downloadedCache.add(`${id}_${plugin}`);
                        this.updateUI(id, plugin, 'downloaded');
                        return;
                    } else if (status === 'failed') {
                        this.downloadingCache.delete(`${id}_${plugin}`);
                        this.updateUI(id, plugin, 'failed');
                        return;
                    }
                }
                
                // 继续轮询
                setTimeout(poll, 2000);
            } catch (error) {
                console.error('[DownloadCore] 轮询下载状态失败:', error);
                setTimeout(poll, 2000);
            }
        };
        
        // 延迟开始轮询，给后端启动时间
        setTimeout(poll, 1000);
    },

    updateUI(id, plugin, status) {
        window.dispatchEvent(new CustomEvent('download:statusChanged', {
            detail: { musicId: id, plugin, status }
        }));
    }
};

window.DownloadCore = DownloadCore;
