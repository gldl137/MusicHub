// 下载队列管理器（从 server.js 抽离）
// 控制同时下载的任务数量，支持队列和并发限制
const logger = require('../core/logger');
const frontendLogger = require('../core/frontend-logger');

const DownloadManager = {
  // 最大并发下载数（默认1）
  maxConcurrent: 1,
  // 当前活跃的下载任务
  activeDownloads: new Map(),
  // 等待队列
  queue: [],
  // 下载ID计数器
  downloadIdCounter: 0,

  /**
   * 设置最大并发数
   * @param {number} count - 并发数
   */
  setMaxConcurrent(count) {
    const num = parseInt(count, 10);
    if (num > 0 && num <= 10) {
      this.maxConcurrent = num;
      logger.info('DOWNLOAD', 'manager', `Max concurrent downloads set to ${num}`);
      // 设置改变后，尝试处理队列
      this.processQueue();
    }
  },

  /**
   * 获取最大并发数
   * @returns {number}
   */
  getMaxConcurrent() {
    return this.maxConcurrent;
  },

  /**
   * 添加下载任务到队列
   * @param {Object} music - 歌曲信息
   * @param {string} plugin - 插件名
   * @param {string} quality - 音质
   * @param {Function} downloadFn - 实际执行下载的函数
   * @returns {Promise<Object>} 下载结果
   */
  async addDownload(music, plugin, quality, downloadFn) {
    const downloadId = ++this.downloadIdCounter;
    const downloadInfo = {
      id: downloadId,
      music,
      plugin,
      quality,
      downloadFn,
      status: 'queued',
      promise: null,
      resolve: null,
      reject: null
    };

    // 创建 Promise，让用户可以等待下载完成
    downloadInfo.promise = new Promise((resolve, reject) => {
      downloadInfo.resolve = resolve;
      downloadInfo.reject = reject;
    });

    // 添加到队列
    this.queue.push(downloadInfo);

    // 尝试处理队列
    this.processQueue();

    return downloadInfo.promise;
  },

  /**
   * 处理下载队列
   */
  async processQueue() {
    // 检查是否还有空闲槽位
    while (this.activeDownloads.size < this.maxConcurrent && this.queue.length > 0) {
      // 从队列中取出第一个等待中的任务
      const downloadInfo = this.queue.shift();
      if (!downloadInfo) continue;

      // 开始下载
      this.startDownload(downloadInfo);
    }
  },

  /**
   * 开始执行下载
   * @param {Object} downloadInfo - 下载任务信息
   */
  async startDownload(downloadInfo) {
    const { id, music, plugin, quality, downloadFn, resolve, reject } = downloadInfo;

    // 标记为活跃下载
    downloadInfo.status = 'downloading';
    this.activeDownloads.set(id, downloadInfo);

    try {
      // 执行实际下载
      const result = await downloadFn(music, plugin, quality);
      downloadInfo.status = 'completed';

      // 记录前台日志 - 下载完成
      frontendLogger.info('DOWNLOAD', 'Download completed', { title: music?.title, artist: music?.artist, plugin, quality });

      resolve({ success: true, data: result });
    } catch (error) {
      downloadInfo.status = 'failed';

      // 记录前台日志 - 下载失败
      frontendLogger.error('DOWNLOAD', 'Download failed', { title: music?.title, artist: music?.artist, plugin, quality, error: error?.message });

      reject(error);
    } finally {
      // 从活跃下载中移除
      this.activeDownloads.delete(id);
      // 继续处理队列
      this.processQueue();
    }
  },

  /**
   * 获取当前下载状态
   * @returns {Object}
   */
  getStatus() {
    return {
      maxConcurrent: this.maxConcurrent,
      activeCount: this.activeDownloads.size,
      queueLength: this.queue.length,
      activeDownloads: Array.from(this.activeDownloads.values()).map(d => ({
        id: d.id,
        title: d.music.title,
        status: d.status
      }))
    };
  }
};

module.exports = DownloadManager;
