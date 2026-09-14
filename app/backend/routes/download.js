'use strict';

// ==================== 下载管理 API ====================
// 路由归属：/api/downloads/*
// 忠实搬运自 server.js（3507-3963），共享依赖统一从 ctx 获取。

const ctx = require('../lib/context');
const { logger, frontendLogger } = ctx;
const { authMiddleware } = require('../lib/middleware');
const { toDockerPath, generateDownloadFilePath, startDownloadWithRetry, DOWNLOAD_DIR } = ctx;
const fs = ctx.fs;
const path = ctx.path;
const database = ctx.database;
const {
  getDownloads, getDownload, addDownload, updateDownloadStatus,
  deleteDownload, removeDownload, getSongByMusicId, saveSetting
} = database;
const DownloadManager = ctx.DownloadManager;
const downloadSettings = ctx.downloadSettings;

module.exports = function (app) {
  // 安全：下载接口涉及用户下载记录与服务端落盘，全部要求登录
  app.use('/api/downloads', authMiddleware);

  // 获取下载列表
  app.get('/api/downloads', async (req, res) => {
    const { status = 'all', limit = 100, offset = 0 } = req.query;

    try {
      const downloads = await getDownloads(status, parseInt(limit), parseInt(offset));
      const formattedDownloads = downloads.map(item => ({
        ...item,
        filePath: item.filePath ? toDockerPath(item.filePath) : item.filePath
      }));
      res.json({ success: true, data: formattedDownloads });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 检查歌曲是否已下载
  app.get('/api/downloads/check', async (req, res) => {
    const { musicId, plugin } = req.query;

    if (!musicId || !plugin) {
      return res.json({ success: false, error: 'Missing musicId or plugin' });
    }

    try {
      const downloadInfo = await getDownload(musicId, plugin);

      let downloaded = downloadInfo && downloadInfo.status === 'completed';

      res.json({ success: true, data: { downloaded, info: downloaded ? downloadInfo : null } });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 添加下载任务
  app.post('/api/downloads', async (req, res) => {
    const { music, plugin, quality = 'standard' } = req.body;

    if (!music || !music.id || !plugin) {
      return res.json({ success: false, error: 'Missing music or plugin' });
    }

    music.id = String(music.id);

    try {
      const existingDownload = await getDownload(music.id, plugin);
      if (existingDownload && existingDownload.status === 'completed') {
        if (existingDownload.filePath) {
          const fileExists = fs.existsSync(existingDownload.filePath);

          if (!fileExists) {
            logger.info('API', req.reqId, 'Download file not found during add, removing record', {
              musicId: music.id,
              plugin,
              filePath: existingDownload.filePath
            });
            await deleteDownload(music.id, plugin);
          } else {
            return res.json({ success: false, error: 'Already downloaded', code: 'ALREADY_DOWNLOADED' });
          }
        } else {
          return res.json({ success: false, error: 'Already downloaded', code: 'ALREADY_DOWNLOADED' });
        }
      }

      const result = await addDownload(music, plugin, quality);

      frontendLogger.info('DOWNLOAD', 'Download started', { title: music?.title, artist: music?.artist, plugin, quality });

      res.json({ success: true, data: result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 更新下载状态
  app.put('/api/downloads/:musicId', async (req, res) => {
    const { musicId } = req.params;
    const { plugin, status, progress, filePath, fileSize, errorMsg } = req.body;

    if (!plugin) {
      return res.json({ success: false, error: 'Missing plugin' });
    }

    try {
      const updates = {};
      if (status !== undefined) updates.status = status;
      if (progress !== undefined) updates.progress = progress;
      if (filePath !== undefined) updates.filePath = filePath;
      if (fileSize !== undefined) updates.fileSize = fileSize;
      if (errorMsg !== undefined) updates.errorMsg = errorMsg;

      const result = await updateDownloadStatus(musicId, plugin, updates);
      res.json({ success: true, data: result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 删除下载记录
  app.delete('/api/downloads/:musicId', async (req, res) => {
    const { musicId } = req.params;
    const { plugin } = req.query;

    if (!plugin) {
      return res.json({ success: false, error: 'Missing plugin' });
    }

    try {
      const downloadInfo = await getDownload(musicId, plugin);
      if (downloadInfo && downloadInfo.filePath) {
        try {
          if (fs.existsSync(downloadInfo.filePath)) {
            fs.unlinkSync(downloadInfo.filePath);
          }
        } catch { /* Ignore file error */ }
      }

      const result = await deleteDownload(musicId, plugin);
      res.json({ success: true, data: result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 清空下载记录
  app.delete('/api/downloads', async (_req, res) => {
    try {
      const downloads = await getDownloads();
      let deleted = 0;
      for (const download of downloads) {
        await deleteDownload(download.downloadId, download.plugin);
        deleted++;
      }
      res.json({ success: true, data: { deleted } });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 清空已完成的下载（仅清除数据库记录，不删除本地文件）
  app.post('/api/downloads/clear-completed', async (_req, res) => {
    try {
      const downloads = await getDownloads('completed');
      let deleted = 0;
      for (const download of downloads) {
        await deleteDownload(download.downloadId, download.plugin);
        deleted++;
      }
      res.json({ success: true, data: { deleted } });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 清空下载中的任务
  app.post('/api/downloads/clear-active', async (_req, res) => {
    try {
      const downloads = await getDownloads('active');
      let deleted = 0;
      for (const download of downloads) {
        await deleteDownload(download.downloadId, download.plugin);
        deleted++;
      }
      res.json({ success: true, data: { deleted } });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 获取下载目录配置
  app.get('/api/downloads/config', (_req, res) => {
    res.json({
      success: true,
      data: {
        downloadDir: '/downloads',
        defaultQuality: process.env.DEFAULT_DOWNLOAD_QUALITY || 'standard',
        maxConcurrent: DownloadManager.getMaxConcurrent(),
        downloadLyrics: downloadSettings.downloadLyrics,
        quality: downloadSettings.quality,
        qualityFallback: downloadSettings.qualityFallback,
        excludeArtists: downloadSettings.excludeArtists,
        excludeLanguages: downloadSettings.excludeLanguages
      }
    });
  });

  // 设置最大并发下载数
  app.post('/api/downloads/concurrency', (req, res) => {
    const { maxConcurrent } = req.body;

    if (maxConcurrent === undefined || maxConcurrent === null) {
      return res.json({ success: false, error: 'Missing maxConcurrent parameter' });
    }

    const num = parseInt(maxConcurrent, 10);
    if (isNaN(num) || num < 1 || num > 10) {
      return res.json({ success: false, error: 'maxConcurrent must be between 1 and 10' });
    }

    DownloadManager.setMaxConcurrent(num);

    res.json({
      success: true,
      data: {
        maxConcurrent: DownloadManager.getMaxConcurrent(),
        message: 'Max concurrent downloads updated'
      }
    });
  });

  // 获取下载队列状态（支持查询单个下载状态）
  app.get('/api/downloads/status', async (req, res) => {
    const { musicId, plugin } = req.query;

    if (musicId && plugin) {
      try {
        const download = await getDownload(musicId, plugin);
        if (download) {
          res.json({
            success: true,
            data: {
              musicId: download.song_id || download.id,
              plugin: download.plugin,
              status: download.status || 'unknown',
              progress: download.progress || 0,
              filePath: download.file_path,
              fileName: download.file_name,
              createdAt: download.created_at,
              completedAt: download.completed_at
            }
          });
        } else {
          res.json({
            success: false,
            error: 'Download not found'
          });
        }
      } catch (error) {
        res.json({
          success: false,
          error: error.message
        });
      }
      return;
    }

    res.json({
      success: true,
      data: DownloadManager.getStatus()
    });
  });

  // 获取下载设置
  app.get('/api/downloads/settings', (_req, res) => {
    res.json({
      success: true,
      data: {
        downloadLyrics: downloadSettings.downloadLyrics,
        quality: downloadSettings.quality,
        qualityFallback: downloadSettings.qualityFallback,
        maxConcurrent: DownloadManager.getMaxConcurrent(),
        excludeArtists: downloadSettings.excludeArtists,
        excludeLanguages: downloadSettings.excludeLanguages
      }
    });
  });

  // 更新下载设置
  app.post('/api/downloads/settings', async (req, res) => {
    const { downloadLyrics, quality, qualityFallback, excludeArtists, excludeLanguages } = req.body;

    if (downloadLyrics !== undefined) {
      downloadSettings.downloadLyrics = Boolean(downloadLyrics);
      logger.info('DOWNLOAD', 'settings', `Download lyrics setting updated: ${downloadSettings.downloadLyrics}`);
      try {
        await saveSetting('downloadLyrics', downloadSettings.downloadLyrics);
        logger.info('DOWNLOAD', 'settings', `Download lyrics setting saved to database`);
      } catch (err) {
        logger.error('DOWNLOAD', 'settings', `Failed to save download lyrics setting: ${err.message}`);
      }
    }

    if (quality !== undefined && ['low', 'standard', 'high', 'super'].includes(quality)) {
      downloadSettings.quality = quality;
      logger.info('DOWNLOAD', 'settings', `Download quality setting updated: ${quality}`);
      try {
        await saveSetting('downloadQuality', quality);
        logger.info('DOWNLOAD', 'settings', `Download quality setting saved to database`);
      } catch (err) {
        logger.error('DOWNLOAD', 'settings', `Failed to save download quality setting: ${err.message}`);
      }
    }

    if (qualityFallback !== undefined && ['lower', 'higher'].includes(qualityFallback)) {
      downloadSettings.qualityFallback = qualityFallback;
      logger.info('DOWNLOAD', 'settings', `Quality fallback setting updated: ${qualityFallback}`);
      try {
        await saveSetting('qualityFallback', qualityFallback);
        logger.info('DOWNLOAD', 'settings', `Quality fallback setting saved to database`);
      } catch (err) {
        logger.error('DOWNLOAD', 'settings', `Failed to save quality fallback setting: ${err.message}`);
      }
    }

    if (Array.isArray(excludeArtists)) {
      downloadSettings.excludeArtists = excludeArtists.map(a => String(a).trim()).filter(Boolean);
      logger.info('DOWNLOAD', 'settings', `Exclude artists setting updated: ${downloadSettings.excludeArtists.length} items`);
      try {
        await saveSetting('excludeArtists', downloadSettings.excludeArtists);
      } catch (err) {
        logger.error('DOWNLOAD', 'settings', `Failed to save exclude artists setting: ${err.message}`);
      }
    }

    if (Array.isArray(excludeLanguages)) {
      downloadSettings.excludeLanguages = excludeLanguages.map(l => String(l).trim()).filter(Boolean);
      logger.info('DOWNLOAD', 'settings', `Exclude languages setting updated: ${downloadSettings.excludeLanguages.length} items`);
      try {
        await saveSetting('excludeLanguages', downloadSettings.excludeLanguages);
      } catch (err) {
        logger.error('DOWNLOAD', 'settings', `Failed to save exclude languages setting: ${err.message}`);
      }
    }

    res.json({
      success: true,
      data: {
        downloadLyrics: downloadSettings.downloadLyrics,
        quality: downloadSettings.quality,
        qualityFallback: downloadSettings.qualityFallback,
        excludeArtists: downloadSettings.excludeArtists,
        excludeLanguages: downloadSettings.excludeLanguages,
        message: 'Download settings updated'
      }
    });
  });

  // 开始下载文件（后端下载到指定目录）
  app.post('/api/downloads/start', async (req, res) => {
    const effectiveQuality = req.body.quality || downloadSettings.quality || 'standard';
    const { musicId, plugin, music: musicFromBody, source = 'download-btn' } = req.body;

    if (!musicId || !plugin) {
      return res.json({ success: false, error: 'Missing required parameters' });
    }

    const musicIdStr = String(musicId);

    try {
      let music = musicFromBody;
      if (!music) {
        music = await getSongByMusicId(musicIdStr, plugin);
      }
      if (!music) {
        return res.json({ success: false, error: 'Music not found' });
      }
      music = { ...music, id: String(music.id) };

      await addDownload(music, plugin, effectiveQuality);

      const relativePath = generateDownloadFilePath(music);
      const filePath = path.join(DOWNLOAD_DIR, relativePath);

      if (fs.existsSync(filePath)) {
        await updateDownloadStatus(musicIdStr, plugin, {
          status: 'completed',
          progress: 100,
          filePath: filePath,
          fileSize: fs.statSync(filePath).size
        });
        return res.json({ success: true, data: { message: 'File already exists', filePath: toDockerPath(filePath), skipped: true } });
      }

      const executeDownload = async (music, plugin, _quality) => {
        await updateDownloadStatus(musicIdStr, plugin, {
          status: 'downloading',
          progress: 0
        });

        const result = await startDownloadWithRetry(music, plugin, effectiveQuality, filePath, musicIdStr, req.reqId, 3, source);
        const finalFilePath = result.filePath || filePath;
        return { filePath: toDockerPath(finalFilePath), fileName: path.basename(finalFilePath) };
      };

      DownloadManager.addDownload(music, plugin, effectiveQuality, executeDownload);

      const status = DownloadManager.getStatus();
      res.json({
        success: true,
        data: {
          message: 'Download queued',
          fileName: path.basename(filePath),
          queuePosition: status.queueLength,
          activeDownloads: status.activeCount,
          maxConcurrent: status.maxConcurrent
        }
      });
    } catch (err) {
      logger.error('API', req.reqId, 'Failed to start download', { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });
};
